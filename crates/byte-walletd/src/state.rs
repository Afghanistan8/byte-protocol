//! Wallet state.
//!
//! Owns the key material, the diversifier cursor, and the chain-backed data the sidecar
//! reports. Address derivation and viewing-key export work offline; anything that reports
//! on-chain facts requires a synced wallet database and says so explicitly rather than
//! returning a plausible-looking zero.
//!
//! That distinction matters more than it looks. A balance endpoint that returns `0`
//! because it has not synced is indistinguishable, to a caller, from one that returns `0`
//! because the wallet is empty — and a verifier that reads "no notes received" from an
//! unsynced wallet would reject payments that were made correctly.

use std::sync::Mutex;

use serde::Serialize;

use crate::keys::{DiversifierCursor, KeyError, Network, SpendingKeys, ViewingKeys};

#[derive(Debug, thiserror::Error)]
pub enum WalletStateError {
    #[error("this wallet is view-only and holds no spending key")]
    ViewOnly,
    #[error("wallet is not synced: scanned to {synced_height}, chain tip {chain_tip:?}")]
    NotSynced {
        synced_height: u32,
        chain_tip: Option<u32>,
    },
    #[error(transparent)]
    Key(#[from] KeyError),
    #[error("could not reach the chain data source: {0}")]
    ChainAccess(String),
}

/// A note as reported to the TypeScript side.
///
/// Field names match `ReceivedNote` in `packages/wallet/src/types.ts`. `pool` is the one
/// the verifier actually depends on: it says where the value landed, which the address
/// alone cannot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub txid: String,
    /// One of `transparent`, `sapling`, `orchard`, `ironwood`.
    pub pool: String,
    pub value_zat: String,
    pub pay_to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
    pub confirmations: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

/// Balances, split by what can actually be spent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceRecord {
    pub spendable_zat: String,
    pub pending_zat: String,
    /// Value outside Ironwood — transparent, Sapling, or the sealed Orchard pool. Byte
    /// will not spend it. Reported so an operator can see it rather than wondering why a
    /// balance is unusable.
    pub unusable_zat: String,
}

#[derive(Debug, Clone, Copy)]
pub struct SyncStatus {
    pub synced_height: u32,
    pub chain_tip: Option<u32>,
    pub synced: bool,
}

/// What the sidecar knows about the chain.
///
/// Implemented by the lightwalletd-backed store. Kept as a trait so the HTTP layer and its
/// tests do not need a network or a database.
pub trait ChainData: Send + Sync {
    fn status(&self) -> Result<SyncStatus, WalletStateError>;
    fn notes_for(&self, pay_to: &str) -> Result<Vec<NoteRecord>, WalletStateError>;
    fn balance(&self) -> Result<BalanceRecord, WalletStateError>;
}

/// Chain data that has not been wired to a chain yet.
///
/// Every method fails with `NotSynced`. This is the honest answer for a sidecar started
/// without a synced wallet database: it is not "zero notes", it is "I do not know".
#[derive(Debug, Default)]
pub struct Unsynced;

impl ChainData for Unsynced {
    fn status(&self) -> Result<SyncStatus, WalletStateError> {
        Ok(SyncStatus {
            synced_height: 0,
            chain_tip: None,
            synced: false,
        })
    }

    fn notes_for(&self, _pay_to: &str) -> Result<Vec<NoteRecord>, WalletStateError> {
        Err(WalletStateError::NotSynced {
            synced_height: 0,
            chain_tip: None,
        })
    }

    fn balance(&self) -> Result<BalanceRecord, WalletStateError> {
        Err(WalletStateError::NotSynced {
            synced_height: 0,
            chain_tip: None,
        })
    }
}

pub struct WalletState {
    network: Network,
    spending: Option<SpendingKeys>,
    viewing: ViewingKeys,
    cursor: Mutex<DiversifierCursor>,
    chain: Box<dyn ChainData>,
}

impl WalletState {
    /// A wallet that can spend, derived from a seed.
    pub fn from_seed(
        network: Network,
        seed: Vec<u8>,
        account: u32,
        chain: Box<dyn ChainData>,
    ) -> Result<Self, WalletStateError> {
        let spending = SpendingKeys::from_seed(network, seed, account)?;
        let viewing = ViewingKeys::from_ufvk(network, spending.ufvk()?);
        Ok(Self {
            network,
            spending: Some(spending),
            viewing,
            cursor: Mutex::new(DiversifierCursor::default()),
            chain,
        })
    }

    /// A wallet that can verify but not spend, derived from a viewing key.
    ///
    /// This is what a facilitator runs. There is no seed anywhere in the process, so a
    /// full compromise of it cannot move funds.
    pub fn from_ufvk(
        network: Network,
        ufvk: &str,
        chain: Box<dyn ChainData>,
    ) -> Result<Self, WalletStateError> {
        Ok(Self {
            network,
            spending: None,
            viewing: ViewingKeys::decode(network, ufvk)?,
            cursor: Mutex::new(DiversifierCursor::default()),
            chain,
        })
    }

    pub fn network(&self) -> Network {
        self.network
    }

    pub fn can_spend(&self) -> bool {
        self.spending.is_some()
    }

    /// Mint a fresh invoice address.
    ///
    /// Works from a viewing key alone: minting addresses never needs spend capability,
    /// which is what lets a facilitator issue invoices for a merchant without being able
    /// to take the proceeds.
    pub fn new_invoice_address(&self) -> Result<(String, u32), WalletStateError> {
        let mut cursor = self
            .cursor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let index = cursor.position();
        let address = cursor.next_address(&self.viewing)?;
        Ok((address, index))
    }

    pub fn export_ufvk(&self) -> Result<String, WalletStateError> {
        match &self.spending {
            Some(keys) => Ok(keys.export_ufvk()?),
            None => Ok(self.viewing.ufvk().encode(&self.network.params())),
        }
    }

    pub fn status(&self) -> Result<SyncStatus, WalletStateError> {
        self.chain.status()
    }

    pub fn notes_for(&self, pay_to: &str) -> Result<Vec<NoteRecord>, WalletStateError> {
        self.chain.notes_for(pay_to)
    }

    pub fn balance(&self) -> Result<BalanceRecord, WalletStateError> {
        self.chain.balance()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: [u8; 32] = [42u8; 32];

    fn spender() -> WalletState {
        WalletState::from_seed(Network::Test, SEED.to_vec(), 0, Box::new(Unsynced)).unwrap()
    }

    #[test]
    fn a_seeded_wallet_can_spend_and_a_viewing_one_cannot() {
        let spending = spender();
        assert!(spending.can_spend());

        let ufvk = spending.export_ufvk().unwrap();
        let viewer = WalletState::from_ufvk(Network::Test, &ufvk, Box::new(Unsynced)).unwrap();
        assert!(!viewer.can_spend());
    }

    #[test]
    fn a_viewing_wallet_can_still_mint_invoice_addresses() {
        // This is what lets a facilitator issue invoices for a merchant without being
        // able to take the proceeds.
        let ufvk = spender().export_ufvk().unwrap();
        let viewer = WalletState::from_ufvk(Network::Test, &ufvk, Box::new(Unsynced)).unwrap();
        let (address, _) = viewer.new_invoice_address().unwrap();
        assert!(address.starts_with("utest1"));
    }

    #[test]
    fn a_viewing_wallet_derives_the_same_addresses_as_its_spender() {
        let spending = spender();
        let ufvk = spending.export_ufvk().unwrap();
        let viewer = WalletState::from_ufvk(Network::Test, &ufvk, Box::new(Unsynced)).unwrap();
        assert_eq!(
            spending.new_invoice_address().unwrap(),
            viewer.new_invoice_address().unwrap()
        );
    }

    #[test]
    fn successive_invoices_never_share_an_address() {
        let wallet = spender();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..100 {
            let (address, _) = wallet.new_invoice_address().unwrap();
            assert!(seen.insert(address), "an address was reused");
        }
    }

    #[test]
    fn an_unsynced_wallet_refuses_to_report_chain_facts() {
        // A balance of zero from an unsynced wallet is indistinguishable from an empty
        // one, and "no notes received" would reject payments that were made correctly.
        let wallet = spender();
        assert!(matches!(
            wallet.balance(),
            Err(WalletStateError::NotSynced { .. })
        ));
        assert!(matches!(
            wallet.notes_for("utest1anything"),
            Err(WalletStateError::NotSynced { .. })
        ));
    }

    #[test]
    fn an_unsynced_wallet_still_reports_its_status() {
        // Status must work while unsynced: it is how a caller learns that it is unsynced.
        let status = spender().status().unwrap();
        assert!(!status.synced);
        assert_eq!(status.chain_tip, None);
    }

    #[test]
    fn rejects_a_malformed_viewing_key() {
        assert!(WalletState::from_ufvk(Network::Test, "nonsense", Box::new(Unsynced)).is_err());
    }
}
