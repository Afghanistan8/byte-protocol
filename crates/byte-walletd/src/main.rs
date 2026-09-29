//! byte-walletd entry point.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use clap::Parser;
use tracing_subscriber::{fmt, EnvFilter};

use byte_walletd::{
    api::{self, AppState},
    chain::LightwalletdChain,
    config::{Config, Secrets},
    keys::{Network, SpendingKeys, ViewingKeys},
    state::WalletState,
};

/// How long to wait between sync passes once caught up.
///
/// Block spacing is 75 seconds today (ZIP 208) and 25 under NU7 (ZIP 218), so this sits
/// comfortably inside the shorter of the two: at 30 seconds the sidecar finds roughly
/// every block after NU7 and idles harmlessly before it. It is deliberately *not* derived
/// from the spacing — a sync loop only needs to be fast enough, and tying it to a
/// consensus parameter would make a wrong height an outage rather than a small delay.
///
/// The one place spacing genuinely matters is the `Retry-After` a payer is handed, and
/// that is derived per network and height in `packages/core/src/network.ts`.
const SYNC_INTERVAL: Duration = Duration::from_secs(30);

/// How long to wait before retrying after a failed sync.
const SYNC_RETRY_INTERVAL: Duration = Duration::from_secs(10);

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
    let can_spend = secrets.can_spend();

    // Derive the viewing key first: the chain store needs it to register its account, and
    // deriving it here means a bad seed fails before anything touches the network.
    let ufvk = match (&secrets.seed, &secrets.ufvk) {
        (Some(seed), _) => SpendingKeys::from_seed(network, seed.clone(), config.account)
            .context("deriving keys from BYTE_WALLETD_SEED")?
            .ufvk()
            .context("deriving the viewing key")?,
        (None, Some(encoded)) => ViewingKeys::decode(network, encoded)
            .context("decoding BYTE_WALLETD_UFVK")?
            .ufvk()
            .clone(),
        (None, None) => anyhow::bail!("no key material configured"),
    };

    tracing::info!(
        network = network.byte_id(),
        can_spend,
        data_dir = %config.data_dir.display(),
        lightwalletd = %config.lightwalletd,
        "byte-walletd starting"
    );
    if can_spend {
        tracing::warn!(
            "this process holds a spending key. Do not expose it beyond loopback, and do \
             not run a facilitator from it."
        );
    }

    let chain = Arc::new(
        LightwalletdChain::open(
            network,
            &config.data_dir,
            config.lightwalletd.clone(),
            config.batch_size,
            &ufvk,
            can_spend,
        )
        .await
        .context("opening the wallet database and connecting to lightwalletd")?,
    );

    let wallet = match (&secrets.seed, &secrets.ufvk) {
        (Some(seed), _) => {
            WalletState::from_seed(network, seed.clone(), config.account, chain.clone())?
                .with_sender(chain.clone())
        }
        (None, Some(encoded)) => WalletState::from_ufvk(network, encoded, chain.clone())?,
        (None, None) => unreachable!("key material was checked above"),
    };

    // Sync runs in the background so the API answers immediately. Endpoints that depend on
    // chain data report `not_synced` until the first pass completes, rather than returning
    // an empty result that a caller could mistake for "nothing received".
    let sync_chain = chain.clone();
    tokio::spawn(async move {
        loop {
            match sync_chain.sync_once().await {
                Ok(height) => {
                    tracing::info!(height, "synced");
                    tokio::time::sleep(SYNC_INTERVAL).await;
                }
                Err(error) => {
                    tracing::warn!(%error, "sync failed, will retry");
                    tokio::time::sleep(SYNC_RETRY_INTERVAL).await;
                }
            }
        }
    });

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
