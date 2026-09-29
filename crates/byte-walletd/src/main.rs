//! byte-walletd entry point.

use std::sync::Arc;

use anyhow::Context;
use clap::Parser;
use tracing_subscriber::{fmt, EnvFilter};

use byte_walletd::{
    api::{self, AppState},
    config::{Config, Secrets},
    keys::Network,
    state::{Unsynced, WalletState},
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    fmt()
        .with_env_filter(
            EnvFilter::try_from_env("BYTE_WALLETD_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::parse();
    let secrets = Secrets::from_env().context(
        "reading secrets from the environment. Set BYTE_WALLETD_TOKEN, and exactly one of \
         BYTE_WALLETD_SEED (to spend) or BYTE_WALLETD_UFVK (to verify only).",
    )?;

    let network: Network = config.network.into();

    let wallet = match (&secrets.seed, &secrets.ufvk) {
        (Some(seed), _) => {
            WalletState::from_seed(network, seed.clone(), config.account, Box::new(Unsynced))
                .context("deriving keys from BYTE_WALLETD_SEED")?
        }
        (None, Some(ufvk)) => WalletState::from_ufvk(network, ufvk, Box::new(Unsynced))
            .context("decoding BYTE_WALLETD_UFVK")?,
        (None, None) => anyhow::bail!("no key material configured"),
    };

    // Say plainly which mode this process is in. An operator who believes they started a
    // view-only facilitator, but actually handed it a seed, should find out here and not
    // after the fact.
    tracing::info!(
        network = network.byte_id(),
        can_spend = wallet.can_spend(),
        data_dir = %config.data_dir.display(),
        "byte-walletd starting"
    );
    if wallet.can_spend() {
        tracing::warn!(
            "this process holds a spending key. Do not expose it beyond loopback, and do \
             not run a facilitator from it."
        );
    }

    tracing::warn!(
        "chain sync is not yet wired up: /notes and /balance will report not_synced. \
         Address derivation, viewing-key export and memo operations work."
    );

    let state = AppState {
        wallet: Arc::new(wallet),
        api_token: Arc::new(secrets.api_token),
    };

    let listener = tokio::net::TcpListener::bind(&config.bind)
        .await
        .with_context(|| format!("binding {}", config.bind))?;

    tracing::info!(bind = %config.bind, "listening");

    axum::serve(listener, api::router(state))
        .with_graceful_shutdown(shutdown())
        .await
        .context("serving")?;

    Ok(())
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
