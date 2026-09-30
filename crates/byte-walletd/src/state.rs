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

use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::chain::{LightwalletdChain, SendOutcome, SendOutput};
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
    #[error("this wallet is not connected to a chain, so it cannot send")]
    NoChain,
    #[error("{0}")]
    Send(String),
    /// Refused: the payment would have been funded from a pool Byte will not spend from.
    #[error("{0}")]
    WrongPoolSource(String),
}

/// An output received by this wallet, as reported to the TypeScript side.
///
/// `pool` is the field the verifier actually depends on: it says where the value landed,
/// which the address alone cannot.
///
/// There is deliberately no `payTo`. `WalletRead::get_received_outputs` reports an
/// output's pool and value but not the address it arrived at, and inventing one here
/// would be a guess presented as a fact. The destination is bound by the memo instead:
/// a Byte memo commits to `invoiceId` and `amount` and `payTo` under the payee's secret,
/// so a memo that verifies proves which invoice — and therefore which address — the
/// payment was for. See `crates/byte-walletd/src/chain.rs`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub txid: String,
    /// One of `transparent`, `sapling`, `orchard`, `ironwood`.
    pub pool: String,
    pub value_zat: String,
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

#[derive(Debug, Clone)]
pub struct SyncStatus {
    pub synced_height: u32,
    pub chain_tip: Option<u32>,
    pub synced: bool,
    /// Consensus branch the light server reports, lowercase hex, when it has said.
    ///
    /// This is what decides block spacing on the TypeScript side. Deriving it from a
    /// height instead would mean guessing an activation height that ZIP 259 records as
    /// TBD, and getting it wrong makes every confirmation wait three times too short.
    pub consensus_branch_id: Option<String>,
}

/// What the sidecar knows about the chain.
///
/// Implemented by the lightwalletd-backed store. Kept as a trait so the HTTP layer and its
/// tests do not need a network or a database.
pub trait ChainData: Send + Sync {
    fn status(&self) -> Result<SyncStatus, WalletStateError>;
    /// Outputs this wallet received in the given transaction.
    ///
    /// Keyed by transaction because the payer reports a txid in its payment payload
    /// (docs/SPEC.md section 5.3), and because that is what the underlying wallet API
    /// offers.
    fn outputs_for_txid(&self, txid: &str) -> Result<Vec<NoteRecord>, WalletStateError>;
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
            // An unsynced wallet has never spoken to a light server, so it has nothing to
            // report here. Absent, rather than a guess.
            consensus_branch_id: None,
        })
    }

    fn outputs_for_txid(&self, _txid: &str) -> Result<Vec<NoteRecord>, WalletStateError> {
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
    /// Separate from `cursor`: see `new_transparent_address`.
    transparent_cursor: Mutex<DiversifierCursor>,
    chain: Arc<dyn ChainData>,
    /// Present only when this process both holds a spending key and is connected to a
    /// chain. Sending requires both, and the type says so.
    sender: Option<Arc<LightwalletdChain>>,
}

impl WalletState {
    /// A wallet that can spend, derived from a seed.
    pub fn from_seed(
        network: Network,
        seed: Vec<u8>,
        account: u32,
        chain: Arc<dyn ChainData>,
    ) -> Result<Self, WalletStateError> {
        let spending = SpendingKeys::from_seed(network, seed, account)?;
        let viewing = ViewingKeys::from_ufvk(network, spending.ufvk()?);
        Ok(Self {
            network,
            spending: Some(spending),
            viewing,
            cursor: Mutex::new(DiversifierCursor::default()),
            transparent_cursor: Mutex::new(DiversifierCursor::default()),
            chain,
            sender: None,
        })
    }

    /// A wallet that can verify but not spend, derived from a viewing key.
    ///
    /// This is what a facilitator runs. There is no seed anywhere in the process, so a
    /// full compromise of it cannot move funds.
    pub fn from_ufvk(
        network: Network,
        ufvk: &str,
        chain: Arc<dyn ChainData>,
    ) -> Result<Self, WalletStateError> {
        Ok(Self {
            network,
            spending: None,
            viewing: ViewingKeys::decode(network, ufvk)?,
            cursor: Mutex::new(DiversifierCursor::default()),
            transparent_cursor: Mutex::new(DiversifierCursor::default()),
            chain,
            sender: None,
        })
    }

    /// Attach the chain this wallet sends through.
    pub fn with_sender(mut self, sender: Arc<LightwalletdChain>) -> Self {
        self.sender = Some(sender);
        self
    }

    /// Build, prove and broadcast a shielded Ironwood payment.
    ///
    /// Requires both a spending key and a chain connection. A view-only deployment fails
    /// with `ViewOnly` and never reaches the builder.
    pub async fn send(
        &self,
        to: &str,
        amount_zat: u64,
        memo: &str,
    ) -> Result<SendOutcome, WalletStateError> {
        let keys = self.spending.as_ref().ok_or(WalletStateError::ViewOnly)?;
        let sender = self.sender.as_ref().ok_or(WalletStateError::NoChain)?;
        let usk = keys.usk()?;
        sender
            .send(&usk, to, amount_zat, memo)
            .await
            .map_err(|e| WalletStateError::Send(e.to_string()))
    }

    /// Send one transaction carrying several outputs.
    pub async fn send_many(&self, outputs: &[SendOutput]) -> Result<SendOutcome, WalletStateError> {
        let keys = self.spending.as_ref().ok_or(WalletStateError::ViewOnly)?;
        let sender = self.sender.as_ref().ok_or(WalletStateError::NoChain)?;
        let usk = keys.usk()?;
        sender
            .send_many(&usk, outputs)
            .await
            .map_err(WalletStateError::from)
    }

    /// Sweep transparent value into Ironwood.
    ///
    /// One transaction per call. The delay-and-split policy lives in the client, where a
    /// caller can see it; the daemon holds no timer.
    pub async fn shield(
        &self,
        from: Option<&[String]>,
        minimum_zat: Option<u64>,
    ) -> Result<Option<crate::chain::ShieldOutcome>, WalletStateError> {
        let keys = self.spending.as_ref().ok_or(WalletStateError::ViewOnly)?;
        let sender = self.sender.as_ref().ok_or(WalletStateError::NoChain)?;
        let usk = keys.usk()?;
        sender
            .shield(&usk, from, minimum_zat)
            .await
            .map_err(WalletStateError::from)
    }

    /// Send value out of Ironwood to a transparent address, publishing the amount.
    pub async fn unshield(
        &self,
        to_transparent: &str,
        amount_zat: u64,
    ) -> Result<SendOutcome, WalletStateError> {
        let keys = self.spending.as_ref().ok_or(WalletStateError::ViewOnly)?;
        let sender = self.sender.as_ref().ok_or(WalletStateError::NoChain)?;
        let usk = keys.usk()?;
        sender
            .unshield(&usk, to_transparent, amount_zat)
            .await
            .map_err(WalletStateError::from)
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
    /// Mint a fresh transparent address, for a rail to deliver to.
    ///
    /// A separate cursor from invoice addresses. Sharing one would make a transparent
    /// address and an invoice address derive from the same diversifier index, and anyone
    /// holding the account's viewing key could then tie a public funding address to a
    /// shielded invoice address. Two cursors cost nothing and remove the question.
    pub fn new_transparent_address(&self) -> Result<(String, u32), WalletStateError> {
        let mut cursor = self
            .transparent_cursor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let index = cursor.position();
        let address = cursor.next_transparent_address(&self.viewing)?;
        Ok((address, index))
    }

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

    pub fn outputs_for_txid(&self, txid: &str) -> Result<Vec<NoteRecord>, WalletStateError> {
        self.chain.outputs_for_txid(txid)
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
        WalletState::from_seed(Network::Test, SEED.to_vec(), 0, Arc::new(Unsynced)).unwrap()
    }

    #[test]
    fn a_seeded_wallet_can_spend_and_a_viewing_one_cannot() {
        let spending = spender();
        assert!(spending.can_spend());

        let ufvk = spending.export_ufvk().unwrap();
        let viewer = WalletState::from_ufvk(Network::Test, &ufvk, Arc::new(Unsynced)).unwrap();
        assert!(!viewer.can_spend());
    }

    #[test]
    fn a_viewing_wallet_can_still_mint_invoice_addresses() {
        // This is what lets a facilitator issue invoices for a merchant without being
        // able to take the proceeds.
        let ufvk = spender().export_ufvk().unwrap();
        let viewer = WalletState::from_ufvk(Network::Test, &ufvk, Arc::new(Unsynced)).unwrap();
        let (address, _) = viewer.new_invoice_address().unwrap();
        assert!(address.starts_with("utest1"));
    }

    #[test]
    fn a_viewing_wallet_derives_the_same_addresses_as_its_spender() {
        let spending = spender();
        let ufvk = spending.export_ufvk().unwrap();
        let viewer = WalletState::from_ufvk(Network::Test, &ufvk, Arc::new(Unsynced)).unwrap();
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
            wallet.outputs_for_txid(&"a".repeat(64)),
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
        assert!(WalletState::from_ufvk(Network::Test, "nonsense", Arc::new(Unsynced)).is_err());
    }
}
