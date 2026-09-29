//! Configuration.
//!
//! Every secret comes from the environment, never from a flag. Command-line arguments are
//! visible in `ps` output, shell history and process listings; a seed or an API token
//! passed that way is disclosed to every other user on the machine.

use std::path::PathBuf;

use clap::Parser;

use crate::keys::Network;

/// Byte Protocol wallet sidecar.
#[derive(Debug, Parser)]
#[command(name = "byte-walletd", version, about)]
pub struct Config {
    /// Address to bind the JSON API to.
    ///
    /// Defaults to loopback deliberately. This service holds spend capability, and
    /// binding it to a routable interface would expose that to the network.
    #[arg(long, env = "BYTE_WALLETD_BIND", default_value = "127.0.0.1:8137")]
    pub bind: String,

    /// Which network to operate on.
    #[arg(long, env = "BYTE_WALLETD_NETWORK", default_value = "test")]
    pub network: NetworkArg,

    /// Directory for the wallet database and block cache.
    #[arg(long, env = "BYTE_WALLETD_DATA_DIR", default_value = "./.byte-walletd")]
    pub data_dir: PathBuf,

    /// lightwalletd endpoint to sync from.
    #[arg(
        long,
        env = "BYTE_WALLETD_LIGHTWALLETD",
        default_value = "https://testnet.lightwalletd.com:9067"
    )]
    pub lightwalletd: String,

    /// Blocks to scan per batch while syncing.
    #[arg(long, env = "BYTE_WALLETD_BATCH_SIZE", default_value_t = 1000)]
    pub batch_size: u32,

    /// ZIP 32 account index.
    #[arg(long, env = "BYTE_WALLETD_ACCOUNT", default_value_t = 0)]
    pub account: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkArg {
    Main,
    Test,
}

impl From<NetworkArg> for Network {
    fn from(value: NetworkArg) -> Self {
        match value {
            NetworkArg::Main => Network::Main,
            NetworkArg::Test => Network::Test,
        }
    }
}

impl std::str::FromStr for NetworkArg {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "main" | "mainnet" => Ok(NetworkArg::Main),
            "test" | "testnet" => Ok(NetworkArg::Test),
            other => Err(format!("unknown network {other:?}, expected main or test")),
        }
    }
}

/// Secrets, read from the environment only.
pub struct Secrets {
    /// Hex-encoded wallet seed. Absent for a view-only deployment.
    pub seed: Option<Vec<u8>>,
    /// Encoded unified full viewing key, for a view-only deployment.
    pub ufvk: Option<String>,
    /// Bearer token the JSON API requires.
    pub api_token: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("BYTE_WALLETD_TOKEN must be set, and at least 16 characters")]
    MissingToken,
    #[error("set exactly one of BYTE_WALLETD_SEED or BYTE_WALLETD_UFVK")]
    KeyMaterial,
    #[error("BYTE_WALLETD_SEED must be hex: {0}")]
    SeedNotHex(#[from] hex::FromHexError),
}

impl Secrets {
    /// Read secrets from the process environment.
    ///
    /// Requiring exactly one of seed or UFVK is deliberate. A deployment is either a payer
    /// that can spend or a verifier that cannot, and being explicit about which prevents
    /// a facilitator from being handed spend capability because someone set one variable
    /// too many.
    pub fn from_env() -> Result<Self, ConfigError> {
        let api_token = std::env::var("BYTE_WALLETD_TOKEN").unwrap_or_default();
        if api_token.len() < 16 {
            return Err(ConfigError::MissingToken);
        }

        let seed_hex = std::env::var("BYTE_WALLETD_SEED")
            .ok()
            .filter(|s| !s.is_empty());
        let ufvk = std::env::var("BYTE_WALLETD_UFVK")
            .ok()
            .filter(|s| !s.is_empty());

        let seed = match (&seed_hex, &ufvk) {
            (Some(_), Some(_)) | (None, None) => return Err(ConfigError::KeyMaterial),
            (Some(hex_seed), None) => Some(hex::decode(hex_seed)?),
            (None, Some(_)) => None,
        };

        Ok(Self {
            seed,
            ufvk,
            api_token,
        })
    }

    /// Whether this deployment can spend, as opposed to only verify.
    pub fn can_spend(&self) -> bool {
        self.seed.is_some()
    }
}

impl std::fmt::Debug for Secrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Secrets")
            .field("seed", &self.seed.as_ref().map(|_| "<redacted>"))
            .field("ufvk", &self.ufvk.as_ref().map(|_| "<redacted>"))
            .field("api_token", &"<redacted>")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn parses_network_names() {
        for (input, expected) in [
            ("main", NetworkArg::Main),
            ("MAINNET", NetworkArg::Main),
            ("test", NetworkArg::Test),
            ("Testnet", NetworkArg::Test),
        ] {
            assert_eq!(NetworkArg::from_str(input).unwrap(), expected);
        }
        assert!(NetworkArg::from_str("regtest").is_err());
    }

    #[test]
    fn secrets_are_not_printed_by_debug() {
        let secrets = Secrets {
            seed: Some(vec![1, 2, 3]),
            ufvk: Some("uview1secret".into()),
            api_token: "supersecrettoken".into(),
        };
        let rendered = format!("{secrets:?}");
        assert!(!rendered.contains("uview1secret"));
        assert!(!rendered.contains("supersecrettoken"));
        assert!(rendered.contains("<redacted>"));
    }

    #[test]
    fn can_spend_reflects_the_presence_of_a_seed() {
        let spender = Secrets {
            seed: Some(vec![0; 32]),
            ufvk: None,
            api_token: "0123456789abcdef".into(),
        };
        let viewer = Secrets {
            seed: None,
            ufvk: Some("uview1x".into()),
            api_token: "0123456789abcdef".into(),
        };
        assert!(spender.can_spend());
        assert!(!viewer.can_spend());
    }

    #[test]
    fn the_default_bind_address_is_loopback() {
        // This service holds spend capability. Binding it to a routable interface by
        // default would expose that to the network.
        let config = Config::parse_from(["byte-walletd"]);
        assert!(config.bind.starts_with("127.0.0.1:"));
    }
}
