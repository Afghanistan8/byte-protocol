//! Chain access over the lightwalletd protocol.
//!
//! Syncs a `zcash_client_sqlite` wallet against a light server and answers the two
//! questions Byte's verifier asks: *did this transaction pay me, in which pool and for how
//! much*, and *what can I spend*.
//!
//! ## Why lookups are keyed by transaction, not by address
//!
//! `WalletRead::get_received_outputs` is keyed by `TxId`, and a received output carries its
//! pool and value but not the address it arrived at. That is not a limitation for Byte: the
//! payer reports the txid in its payment payload (`docs/SPEC.md` §5.3), so the verifier
//! always has one.
//!
//! The address is still bound, by the memo rather than by the note. A Byte memo commits to
//! `invoiceId ‖ amount ‖ payTo` under the payee's secret, so a note whose memo verifies
//! against a given invoice proves that invoice's `payTo` was the intended destination. The
//! wallet only returns outputs *it* received, so the funds are ours either way; the memo is
//! what ties them to a specific invoice.
//!
//! ## Concurrency
//!
//! The sync loop owns its own `WalletDb` on a dedicated blocking thread, and reads open
//! short-lived connections to the same SQLite file. Holding a lock on the database across
//! an `await` would otherwise infect the whole service with it, and SQLite handles
//! concurrent readers perfectly well.

use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use rand::rngs::OsRng;
use zcash_client_backend::data_api::{
    wallet::ConfirmationsPolicy, AccountBirthday, AccountPurpose, WalletRead, WalletWrite,
};
use zcash_client_backend::proto::service::{
    compact_tx_streamer_client::CompactTxStreamerClient, BlockId,
};
use zcash_client_backend::wallet::NoteId;
use zcash_client_sqlite::util::SystemClock;
use zcash_client_sqlite::{wallet::init::init_wallet_db, WalletDb};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::consensus;
use zcash_protocol::value::Zatoshis;
use zcash_protocol::ShieldedPool;

use crate::blockcache::MemoryBlockCache;
use crate::keys::Network;
use crate::state::{BalanceRecord, ChainData, NoteRecord, SyncStatus, WalletStateError};

/// Blocks to rewind behind the tip when choosing a birthday for a brand-new wallet.
///
/// A new Byte wallet has no history worth recovering, so it starts near the tip rather
/// than scanning from NU6.3 activation, which would take hours. The margin covers a reorg
/// deeper than a handful of blocks.
const BIRTHDAY_REWIND: u32 = 100;

type ByteWalletDb = WalletDb<rusqlite::Connection, consensus::Network, SystemClock, OsRng>;

#[derive(Debug, thiserror::Error)]
pub enum ChainError {
    #[error("wallet database: {0}")]
    Db(String),
    #[error("block cache: {0}")]
    Cache(String),
    #[error("lightwalletd: {0}")]
    Lightwalletd(String),
    #[error("filesystem: {0}")]
    Io(#[from] std::io::Error),
    #[error("proving parameters: {0}")]
    Prover(String),
    #[error("send failed: {0}")]
    Send(String),
    /// The proposal would have drawn on a pool Byte will not spend from.
    ///
    /// Distinct from `Send` because it is a *refusal*, not a failure: nothing went wrong,
    /// and the caller's spend guard needs to tell the two apart to refund correctly.
    #[error("{0}")]
    WrongPoolSource(String),
}

impl From<ChainError> for WalletStateError {
    fn from(error: ChainError) -> Self {
        match error {
            // Preserve the refusal across the boundary. Flattening it into `ChainAccess`
            // would report a deliberate policy decision as a chain outage.
            ChainError::WrongPoolSource(message) => WalletStateError::WrongPoolSource(message),
            other => WalletStateError::ChainAccess(other.to_string()),
        }
    }
}

/// A lightwalletd-backed chain data source.
pub struct LightwalletdChain {
    network: Network,
    endpoint: String,
    batch_size: u32,
    wallet_db_path: PathBuf,
    /// Height the wallet has scanned to. Zero until the first sync completes.
    synced_height: AtomicU32,
    /// Chain tip as last reported by the light server. Zero when never reached.
    chain_tip: AtomicU32,
    /// Unix seconds of the last successful sync, for liveness reporting.
    last_sync: AtomicU64,
    /// Consensus branch the light server reports itself to be on, as lowercase hex.
    ///
    /// **Read from the chain, never inferred from a height.** Activation heights for NU7
    /// are TBD in ZIP 259 itself (testnet to be set 5 October 2026, mainnet 20 October), so
    /// a wallet guessing one is a wallet computing block spacing from fiction. The branch
    /// ID is a fact the server states.
    consensus_branch_id: std::sync::Mutex<Option<String>>,
}

impl LightwalletdChain {
    /// Open, migrating the database and registering the account if it is new.
    ///
    /// Requires network access: a brand-new wallet needs a birthday, and a birthday needs
    /// a tree state from the light server.
    pub async fn open(
        network: Network,
        data_dir: &Path,
        endpoint: String,
        batch_size: u32,
        ufvk: &UnifiedFullViewingKey,
        spending_key_available: bool,
    ) -> Result<Self, ChainError> {
        std::fs::create_dir_all(data_dir)?;
        let wallet_db_path = data_dir.join("wallet.sqlite");

        let mut db = open_wallet_db(network, &wallet_db_path)?;
        // No seed is passed: byte-walletd registers accounts by viewing key, so migrations
        // that need a seed do not apply. A spending deployment still derives its UFVK from
        // the seed in-process; the database never holds one.
        init_wallet_db(&mut db, None).map_err(|e| ChainError::Db(e.to_string()))?;

        let mut client = connect(&endpoint).await?;

        let has_account = !db
            .get_account_ids()
            .map_err(|e| ChainError::Db(e.to_string()))?
            .is_empty();

        if !has_account {
            let tip = chain_tip(&mut client).await?;
            let birthday_height = tip.saturating_sub(BIRTHDAY_REWIND);
            let birthday = birthday_at(&mut client, birthday_height).await?;

            let purpose = if spending_key_available {
                AccountPurpose::Spending { derivation: None }
            } else {
                AccountPurpose::ViewOnly
            };

            db.import_account_ufvk("byte", ufvk, &birthday, purpose, Some("byte-walletd"))
                .map_err(|e| ChainError::Db(e.to_string()))?;

            tracing::info!(
                birthday = birthday_height,
                tip,
                view_only = !spending_key_available,
                "registered a new account"
            );
        }

        Ok(Self {
            network,
            endpoint,
            batch_size,
            wallet_db_path,
            synced_height: AtomicU32::new(0),
            chain_tip: AtomicU32::new(0),
            last_sync: AtomicU64::new(0),
            consensus_branch_id: std::sync::Mutex::new(None),
        })
    }

    /// Scan until caught up with the tip. Returns the height scanned to.
    pub async fn sync_once(&self) -> Result<u32, ChainError> {
        let mut client = connect(&self.endpoint).await?;
        let tip = chain_tip(&mut client).await?;
        self.chain_tip.store(tip, Ordering::Relaxed);

        // Ask the server which consensus branch it is on. A failure here is not fatal:
        // scanning still works, and the TypeScript side falls back to the slower, safer
        // block spacing when the branch is unknown.
        if let Ok(info) = lightd_info(&mut client).await {
            let branch = info.consensus_branch_id.trim().to_lowercase();
            if !branch.is_empty() {
                *self
                    .consensus_branch_id
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(branch);
            }
        }

        let cache = MemoryBlockCache::new();
        let mut db = open_wallet_db(self.network, &self.wallet_db_path)?;

        zcash_client_backend::sync::run(
            &mut client,
            &self.network.params(),
            &cache,
            &mut db,
            self.batch_size,
        )
        .await
        .map_err(|e| ChainError::Lightwalletd(e.to_string()))?;

        let scanned = db
            .block_max_scanned()
            .map_err(|e| ChainError::Db(e.to_string()))?
            .map(|meta| u32::from(meta.block_height()))
            .unwrap_or(0);

        self.synced_height.store(scanned, Ordering::Relaxed);
        self.last_sync.store(now_secs(), Ordering::Relaxed);
        Ok(scanned)
    }

    /// Unix seconds of the last successful sync, or `None` if there has not been one.
    pub fn last_sync(&self) -> Option<u64> {
        match self.last_sync.load(Ordering::Relaxed) {
            0 => None,
            secs => Some(secs),
        }
    }

    fn open_db(&self) -> Result<ByteWalletDb, ChainError> {
        open_wallet_db(self.network, &self.wallet_db_path)
    }
}

impl ChainData for LightwalletdChain {
    fn status(&self) -> Result<SyncStatus, WalletStateError> {
        let synced_height = self.synced_height.load(Ordering::Relaxed);
        let tip = self.chain_tip.load(Ordering::Relaxed);
        let consensus_branch_id = self
            .consensus_branch_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        Ok(SyncStatus {
            synced_height,
            chain_tip: (tip > 0).then_some(tip),
            consensus_branch_id,
            // Treat "within one block of the tip" as synced. Demanding exact equality
            // would flap to false every time a block is found mid-request.
            synced: synced_height > 0 && tip > 0 && synced_height + 1 >= tip,
        })
    }

    fn outputs_for_txid(&self, txid_hex: &str) -> Result<Vec<NoteRecord>, WalletStateError> {
        let txid = parse_txid(txid_hex)?;
        let db = self.open_db().map_err(WalletStateError::from)?;

        let tip = self.chain_tip.load(Ordering::Relaxed);
        let synced = self.synced_height.load(Ordering::Relaxed);
        if synced == 0 {
            return Err(WalletStateError::NotSynced {
                synced_height: synced,
                chain_tip: (tip > 0).then_some(tip),
            });
        }

        // MIN, not the ZIP 315 default. The sidecar reports raw confirmations and lets the
        // caller apply the invoice's own `minConfirmations`; baking a 10-confirmation
        // policy in here would silently override what the payee asked for.
        let Some((target_height, _anchor)) = db
            .get_target_and_anchor_heights(NonZeroU32::MIN)
            .map_err(|e| WalletStateError::ChainAccess(e.to_string()))?
        else {
            return Err(WalletStateError::NotSynced {
                synced_height: synced,
                chain_tip: (tip > 0).then_some(tip),
            });
        };

        let outputs = db
            .get_received_outputs(txid, target_height, ConfirmationsPolicy::MIN)
            .map_err(|e| WalletStateError::ChainAccess(e.to_string()))?;

        // Actual confirmations, derived from where the transaction was mined. A
        // transaction the wallet knows about but has not seen mined has zero.
        let mined_height = db
            .get_tx_height(txid)
            .map_err(|e| WalletStateError::ChainAccess(e.to_string()))?;
        let confirmations = mined_height
            .map(|h| synced.saturating_sub(u32::from(h)).saturating_add(1))
            .unwrap_or(0);

        let mut records = Vec::with_capacity(outputs.len());
        for output in outputs {
            let pool = pool_name(output.pool_type());
            let output_index = u16::try_from(output.output_index()).unwrap_or(u16::MAX);

            // Memos exist only for shielded outputs, and only Ironwood ones matter to Byte.
            let memo = shielded_pool(output.pool_type()).and_then(|protocol| {
                db.get_memo(NoteId::new(txid, protocol, output_index))
                    .ok()
                    .flatten()
                    .and_then(|memo| match memo {
                        zcash_protocol::memo::Memo::Text(text) => Some(text.to_string()),
                        _ => None,
                    })
            });

            records.push(NoteRecord {
                txid: txid_hex.to_ascii_lowercase(),
                pool: pool.to_string(),
                value_zat: zatoshis_string(output.value()),
                memo,
                confirmations,
                height: mined_height.map(u32::from),
            });
        }

        Ok(records)
    }

    fn balance(&self) -> Result<BalanceRecord, WalletStateError> {
        let db = self.open_db().map_err(WalletStateError::from)?;
        let synced = self.synced_height.load(Ordering::Relaxed);
        let tip = self.chain_tip.load(Ordering::Relaxed);

        let summary = db
            .get_wallet_summary(ConfirmationsPolicy::MIN)
            .map_err(|e| WalletStateError::ChainAccess(e.to_string()))?
            .ok_or(WalletStateError::NotSynced {
                synced_height: synced,
                chain_tip: (tip > 0).then_some(tip),
            })?;

        let mut spendable = 0u64;
        let mut pending = 0u64;
        let mut unusable = 0u64;

        for balance in summary.account_balances().values() {
            // Ironwood is the only pool Byte will spend from. Sapling and Orchard value is
            // real and is reported, but moving it would cross pools, and ZIP 318 makes the
            // net amount crossing public — the exact disclosure Byte exists to avoid.
            spendable += u64::from(balance.ironwood_balance().spendable_value());
            pending += u64::from(balance.ironwood_balance().value_pending_spendability())
                + u64::from(balance.ironwood_balance().change_pending_confirmation());
            unusable += u64::from(balance.sapling_balance().total())
                + u64::from(balance.orchard_balance().total())
                + u64::from(balance.unshielded_regular_balance().total())
                + u64::from(balance.unshielded_coinbase_balance().total());
        }

        Ok(BalanceRecord {
            spendable_zat: spendable.to_string(),
            pending_zat: pending.to_string(),
            unusable_zat: unusable.to_string(),
        })
    }
}

// ------------------------------------------------------------------------------- helpers

fn open_wallet_db(network: Network, path: &Path) -> Result<ByteWalletDb, ChainError> {
    WalletDb::for_path(path, network.params(), SystemClock, OsRng)
        .map_err(|e| ChainError::Db(e.to_string()))
}

async fn connect(
    endpoint: &str,
) -> Result<CompactTxStreamerClient<tonic::transport::Channel>, ChainError> {
    CompactTxStreamerClient::connect(endpoint.to_string())
        .await
        .map_err(|e| ChainError::Lightwalletd(format!("connecting to {endpoint}: {e}")))
}

async fn chain_tip(
    client: &mut CompactTxStreamerClient<tonic::transport::Channel>,
) -> Result<u32, ChainError> {
    let block = client
        .get_latest_block(zcash_client_backend::proto::service::ChainSpec::default())
        .await
        .map_err(|e| ChainError::Lightwalletd(e.to_string()))?
        .into_inner();
    u32::try_from(block.height)
        .map_err(|_| ChainError::Lightwalletd("chain tip height out of range".into()))
}

/// What the light server says about itself, including its consensus branch.
async fn lightd_info(
    client: &mut CompactTxStreamerClient<tonic::transport::Channel>,
) -> Result<zcash_client_backend::proto::service::LightdInfo, ChainError> {
    Ok(client
        .get_lightd_info(zcash_client_backend::proto::service::Empty {})
        .await
        .map_err(|e| ChainError::Lightwalletd(e.to_string()))?
        .into_inner())
}

async fn birthday_at(
    client: &mut CompactTxStreamerClient<tonic::transport::Channel>,
    height: u32,
) -> Result<AccountBirthday, ChainError> {
    let treestate = client
        .get_tree_state(BlockId {
            height: u64::from(height),
            hash: vec![],
        })
        .await
        .map_err(|e| ChainError::Lightwalletd(e.to_string()))?
        .into_inner();

    AccountBirthday::from_treestate(treestate, None)
        .map_err(|e| ChainError::Lightwalletd(format!("building birthday: {e:?}")))
}

/// Parse a transaction identifier written the way everything displays it.
///
/// Zcash displays a txid **byte-flipped** relative to its internal representation:
/// `TxId`'s own `Debug` impl notes that the flipped string "is more useful than the raw
/// bytes, because we can look that up in RPC methods and block explorers". So every txid a
/// payer quotes, an explorer shows, or `TxId::to_string` produces is in display order,
/// while `TxId::from_bytes` expects internal order.
///
/// Missing this reversal makes every lookup silently return nothing: the transaction is
/// there, mined, with the right memo, and the verifier asks for it under a name that does
/// not exist. `round_trips_a_displayed_txid` is the test that pins it.
fn parse_txid(hex_txid: &str) -> Result<zcash_protocol::TxId, WalletStateError> {
    let mut bytes = hex::decode(hex_txid)
        .map_err(|e| WalletStateError::ChainAccess(format!("txid must be hex: {e}")))?;
    if bytes.len() != 32 {
        return Err(WalletStateError::ChainAccess(
            "txid must be 32 bytes".into(),
        ));
    }
    bytes.reverse();
    let array: [u8; 32] = bytes
        .try_into()
        .map_err(|_| WalletStateError::ChainAccess("txid must be 32 bytes".into()))?;
    Ok(zcash_protocol::TxId::from_bytes(array))
}

/// Only v5 and v6 transactions may be broadcast.
///
/// v6 is the Ironwood format (ZIP 229, still `Draft`); v5 is the NU5 format. Anything older
/// is refused: v4 is disabled from NU7, and pre-v5 formats cannot express the pools Byte
/// uses. The check is on the *built* transaction so it holds whatever the builder defaults to.
fn assert_modern_version(version: zcash_primitives::transaction::TxVersion) -> Result<(), ChainError> {
    use zcash_primitives::transaction::TxVersion;
    match version {
        TxVersion::V5 | TxVersion::V6 => Ok(()),
        other => Err(ChainError::Send(format!(
            "refusing to broadcast a {other:?} transaction; Byte builds v5 or v6 only"
        ))),
    }
}

/// Decode a transparent address, refusing anything else by name.
///
/// A shielded or unified address passed here is a caller mistake worth naming: shielding
/// *from* a shielded address is not a thing, and silently ignoring it would make the sweep
/// report success having done nothing.
fn decode_transparent(
    params: &consensus::Network,
    encoded: &str,
) -> Result<transparent::address::TransparentAddress, ChainError> {
    use zcash_keys::address::Address;

    match Address::decode(params, encoded) {
        Some(Address::Transparent(address)) => Ok(address),
        Some(_) => Err(ChainError::Send(format!(
            "{encoded} is not a transparent address; shielding sweeps transparent UTXOs and              a shielded or unified address has none"
        ))),
        None => Err(ChainError::Send(format!("could not parse address {encoded}"))),
    }
}

/// Map a pool to the name the TypeScript side uses.
fn pool_name(pool: zcash_protocol::PoolType) -> &'static str {
    use zcash_protocol::PoolType;
    match pool {
        PoolType::Transparent => "transparent",
        PoolType::Shielded(ShieldedPool::Sapling) => "sapling",
        PoolType::Shielded(ShieldedPool::Orchard) => "orchard",
        PoolType::Shielded(ShieldedPool::Ironwood) => "ironwood",
    }
}

/// Refuse a proposal that would be funded from anywhere but Ironwood.
///
/// Walks every step of the proposal and rejects on the first non-Ironwood input. Runs
/// before proving, signing or broadcasting, so a refusal costs nothing and puts nothing
/// on the chain — the same property the spend guard has on the TypeScript side.
///
/// Reported as `wrong_pool_source`, which `WalletdWallet` already maps to a
/// `BytePayerError` the spend guard can refund against.
/// The walk. Two documented accessors per step, and the decision itself lives in
/// [`ironwood_only_refusal`] so it can be tested exhaustively without synthesising a
/// `Proposal` — which would need a real Orchard note, an anchor and a balance, and would
/// test the test harness more than the policy.
fn assert_ironwood_funded<FeeRuleT, NoteRefT>(
    proposal: &zcash_client_backend::proposal::Proposal<FeeRuleT, NoteRefT>,
) -> Result<(), ChainError> {
    for step in proposal.steps() {
        let pools = step
            .shielded_inputs()
            .into_iter()
            .flat_map(|inputs| inputs.notes().iter())
            .map(|note| note.note().pool());

        if let Some(message) = ironwood_only_refusal(step.transparent_inputs().len(), pools) {
            return Err(ChainError::WrongPoolSource(message));
        }
    }
    Ok(())
}

/// The policy: Ironwood in, or nothing.
///
/// Returns the refusal message, or `None` when every input is Ironwood. Transparent is
/// reported before shielded because it is both the likelier mistake and the worse one:
/// it publishes an amount that was never shielded to begin with.
fn ironwood_only_refusal(
    transparent_inputs: usize,
    shielded_pools: impl Iterator<Item = ShieldedPool>,
) -> Option<String> {
    if transparent_inputs > 0 {
        return Some(format!(
            "this payment would be funded from {transparent_inputs} transparent input(s). \
             Byte will not spend transparent value: the amount crossing into the shielded \
             pool would be public. Shield the funds first, then pay."
        ));
    }

    for pool in shielded_pools {
        if pool != ShieldedPool::Ironwood {
            return Some(format!(
                "this payment would be funded from a {} note. Byte spends Ironwood notes \
                 only: ZIP 318 makes the net amount crossing between pools public, which \
                 is the disclosure Byte exists to prevent.",
                pool_name(zcash_protocol::PoolType::Shielded(pool))
            ));
        }
    }

    None
}

fn shielded_pool(pool: zcash_protocol::PoolType) -> Option<ShieldedPool> {
    match pool {
        zcash_protocol::PoolType::Shielded(p) => Some(p),
        zcash_protocol::PoolType::Transparent => None,
    }
}

fn zatoshis_string(value: Zatoshis) -> String {
    u64::from(value).to_string()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What these cover, and what they do not.
    ///
    /// `ironwood_only_refusal` is the decision, and it is covered exhaustively below —
    /// every variant of `ShieldedPool`, plus the transparent case and the precedence
    /// between them. `assert_ironwood_funded` is the walk over a real `Proposal`, and it
    /// is not unit-tested: synthesising a `Proposal` needs a constructed Orchard note, an
    /// anchor, a transaction request and a balance, and a test built on that scaffolding
    /// mostly proves the scaffolding. The walk is two accessors the compiler checks, and
    /// `docs/TESTNET_RUNS.md` covers it against a real chain.
    #[test]
    fn ironwood_notes_are_the_only_acceptable_source() {
        assert_eq!(
            ironwood_only_refusal(0, [ShieldedPool::Ironwood].into_iter()),
            None
        );
        assert_eq!(
            ironwood_only_refusal(0, [ShieldedPool::Ironwood; 4].into_iter()),
            None
        );
        // No inputs at all is not this function's problem to diagnose; the builder will
        // already have failed with an insufficient-funds error before reaching here.
        assert_eq!(ironwood_only_refusal(0, std::iter::empty()), None);
    }

    #[test]
    fn every_other_pool_is_refused_by_name() {
        for pool in [ShieldedPool::Sapling, ShieldedPool::Orchard] {
            let refusal = ironwood_only_refusal(0, [pool].into_iter())
                .unwrap_or_else(|| panic!("{pool:?} should have been refused"));
            // The operator has to be able to tell *which* pool their money is stuck in.
            assert!(
                refusal.contains(pool_name(zcash_protocol::PoolType::Shielded(pool))),
                "refusal should name the pool: {refusal}"
            );
            assert!(refusal.contains("ZIP 318"), "refusal should cite why: {refusal}");
        }
    }

    #[test]
    fn a_single_bad_note_among_good_ones_still_refuses() {
        // The dangerous case: the selector tops an Ironwood spend up from elsewhere, and
        // the shortfall crossing the turnstile is what becomes public.
        let pools = [
            ShieldedPool::Ironwood,
            ShieldedPool::Ironwood,
            ShieldedPool::Orchard,
        ];
        assert!(ironwood_only_refusal(0, pools.into_iter()).is_some());
    }

    #[test]
    fn transparent_inputs_are_refused_and_reported_first() {
        let refusal = ironwood_only_refusal(1, [ShieldedPool::Ironwood].into_iter())
            .expect("a transparent input must be refused");
        assert!(refusal.contains("transparent"), "{refusal}");

        // Transparent wins the report even when a shielded input is also wrong: it is the
        // likelier mistake, and it publishes value that was never shielded at all.
        let both = ironwood_only_refusal(2, [ShieldedPool::Sapling].into_iter())
            .expect("must be refused");
        assert!(both.contains("2 transparent input(s)"), "{both}");
    }

    #[test]
    fn only_v5_and_v6_transactions_may_be_broadcast() {
        use zcash_primitives::transaction::TxVersion;
        assert!(assert_modern_version(TxVersion::V5).is_ok());
        assert!(assert_modern_version(TxVersion::V6).is_ok());
        for old in [TxVersion::V3, TxVersion::V4, TxVersion::Sprout(1)] {
            assert!(assert_modern_version(old).is_err(), "{old:?} must be refused");
        }
    }

    #[test]
    fn pool_names_match_the_typescript_union() {
        // These strings are the Pool union in packages/core/src/pool.ts. A mismatch would
        // make the verifier's pool check silently fail to recognise an Ironwood note.
        use zcash_protocol::PoolType;
        assert_eq!(pool_name(PoolType::Transparent), "transparent");
        assert_eq!(
            pool_name(PoolType::Shielded(ShieldedPool::Sapling)),
            "sapling"
        );
        assert_eq!(
            pool_name(PoolType::Shielded(ShieldedPool::Orchard)),
            "orchard"
        );
        assert_eq!(
            pool_name(PoolType::Shielded(ShieldedPool::Ironwood)),
            "ironwood"
        );
    }

    #[test]
    fn parses_a_well_formed_txid() {
        let hex_txid = "a".repeat(64);
        assert!(parse_txid(&hex_txid).is_ok());
    }

    #[test]
    fn round_trips_a_displayed_txid() {
        // The test that would have caught the byte-order bug. A txid quoted by a payer,
        // an explorer or TxId::to_string is in display order; from_bytes wants internal
        // order. Without the reversal this asserts unequal, and in production every
        // lookup silently finds nothing.
        let txid = zcash_protocol::TxId::from_bytes([
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20,
        ]);
        assert_eq!(parse_txid(&txid.to_string()).unwrap(), txid);
    }

    #[test]
    fn a_displayed_txid_is_not_its_own_internal_bytes() {
        // Guards against the reversal being quietly dropped: if display order and internal
        // order were the same, the round-trip test above would pass either way.
        let txid = zcash_protocol::TxId::from_bytes([
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20,
        ]);
        assert_ne!(txid.to_string(), hex::encode(txid.as_ref()));
    }

    #[test]
    fn rejects_malformed_txids() {
        for bad in ["", "abc", &"z".repeat(64), &"a".repeat(62), &"a".repeat(66)] {
            assert!(parse_txid(bad).is_err(), "should have rejected {bad:?}");
        }
    }
}

// --------------------------------------------------------------------------------- send

/// One output of a payment.
#[derive(Debug, Clone)]
pub struct SendOutput {
    pub to: String,
    pub amount_zat: u64,
    /// Absent for a transparent output, which cannot carry one.
    pub memo: Option<String>,
}

/// The outcome of a successful send.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    pub txid: String,
    pub fee_zat: String,
}

/// One shielding transaction.
///
/// Amounts are serialized as strings, like every other amount crossing to TypeScript: the
/// maximum supply fits in an f64 today, and a JSON number is one careless multiplication
/// away from not fitting.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShieldOutcome {
    pub txid: String,
    /// Value that arrived in Ironwood, net of the fee.
    #[serde(serialize_with = "serialize_u64_as_string")]
    pub amount_zat: u64,
    /// The ZIP 317 fee, read from the built proposal rather than assumed.
    #[serde(serialize_with = "serialize_u64_as_string")]
    pub fee_zat: u64,
}

fn serialize_u64_as_string<S: serde::Serializer>(
    value: &u64,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_string())
}

/// Default floor for shielding a transparent UTXO.
///
/// The ZIP 317 marginal fee. A UTXO worth less than the fee to move it costs money to
/// shield, so sweeping it is a wallet losing value in the name of tidiness. A caller who
/// wants the dust anyway can pass a lower minimum.
pub const DEFAULT_SHIELD_THRESHOLD_ZAT: u64 = 5_000;

/// Locate the Sapling proving parameters, downloading them once if absent.
///
/// `create_proposed_transactions` requires a Sapling `SpendProver` and `OutputProver` in
/// its signature even when the transaction Byte builds contains no Sapling component at
/// all — every output and the change are Ironwood. A real prover therefore has to exist
/// even though it does no work here.
///
/// The parameters are about 50 MB and are fetched once into the platform's standard Zcash
/// parameter directory, where every other Zcash wallet on the machine will also find them.
pub fn ensure_sapling_prover() -> Result<zcash_proofs::prover::LocalTxProver, ChainError> {
    if let Some(prover) = zcash_proofs::prover::LocalTxProver::with_default_location() {
        return Ok(prover);
    }

    tracing::info!(
        "Sapling proving parameters not found; downloading about 50 MB once. \
         Byte builds Ironwood-only transactions, but the transaction builder's signature \
         requires a Sapling prover regardless."
    );
    zcash_proofs::download_sapling_parameters(Some(600))
        .map_err(|e| ChainError::Prover(format!("downloading Sapling parameters: {e}")))?;

    zcash_proofs::prover::LocalTxProver::with_default_location()
        .ok_or_else(|| ChainError::Prover("Sapling parameters still missing after download".into()))
}

impl LightwalletdChain {
    /// Send value out of Ironwood to a transparent address.
    ///
    /// **This publishes the amount.** ZIP 318 is explicit that the net amount crossing
    /// between pools is revealed on-chain, and unshielding is that crossing, deliberately.
    ///
    /// It reuses the ordinary transfer path, which means `assert_ironwood_funded` still
    /// runs: the *source* must be Ironwood even though the destination is public. Funding
    /// an unshield from a transparent UTXO would be a transparent-to-transparent transfer
    /// wearing the wrong name.
    pub async fn unshield(
        &self,
        usk: &zcash_keys::keys::UnifiedSpendingKey,
        to_transparent: &str,
        amount_zat: u64,
    ) -> Result<SendOutcome, ChainError> {
        let params = self.network.params();

        // Decoded here, before anything is built, so the refusal names the real reason
        // rather than surfacing as an opaque builder error.
        decode_transparent(&params, to_transparent)?;

        // No memo: a transparent output cannot carry one. zip321::Payment refuses the
        // combination outright, which is better than silently dropping it and leaving a
        // caller believing their memo went out.
        self.send_to(
            usk,
            &[SendOutput {
                to: to_transparent.to_string(),
                amount_zat,
                memo: None,
            }],
        )
        .await
    }

    /// Serialize a built transaction and hand it to the light server.
    ///
    /// Until this succeeds nothing has left the machine, so a failure here means the
    /// payment did not happen — not that it happened and was lost. Shared by every path
    /// that broadcasts, so there is one place where that property is true.
    async fn broadcast(
        &self,
        db: &mut ByteWalletDb,
        txid: zcash_protocol::TxId,
    ) -> Result<(), ChainError> {
        use zcash_client_backend::data_api::WalletRead;

        let raw = db
            .get_transaction(txid)
            .map_err(|e| ChainError::Db(e.to_string()))?
            .ok_or_else(|| {
                ChainError::Send("built transaction is missing from the wallet".into())
            })?;

        // Refuse to broadcast an old transaction format. v4 is disabled by NU7, and a v4
        // transaction cannot carry an Ironwood bundle at all, so one arriving here means
        // something upstream built the wrong thing. Checked on the built transaction rather
        // than assumed from the builder's default, because that default is what could change.
        assert_modern_version(raw.version())?;

        let mut bytes = Vec::new();
        raw.write(&mut bytes)
            .map_err(|e| ChainError::Send(format!("serializing transaction: {e}")))?;

        let mut client = connect(&self.endpoint).await?;
        let response = client
            .send_transaction(zcash_client_backend::proto::service::RawTransaction {
                data: bytes,
                height: 0,
            })
            .await
            .map_err(|e| ChainError::Lightwalletd(e.to_string()))?
            .into_inner();

        if response.error_code != 0 {
            return Err(ChainError::Send(format!(
                "light server rejected the transaction: code {} {}",
                response.error_code, response.error_message
            )));
        }
        Ok(())
    }

    /// Sweep transparent value into Ironwood.
    ///
    /// One transaction per call. The *policy* — how many transactions, how long to wait
    /// between them, how much to take each time — lives in the TypeScript client, where a
    /// caller can see and configure it. The sidecar has no timer and no schedule, which
    /// means it has no schedule to get wrong.
    ///
    /// ## Why there is no "shield a fraction" parameter
    ///
    /// `propose_shielding` selects inputs by *address*: you hand it transparent addresses
    /// and it sweeps what they hold above a threshold. There is no UTXO-level knob, and
    /// there is no honest way to synthesise one — taking some inputs back out of a built
    /// proposal invalidates the fee it was built with.
    ///
    /// So splitting a sweep means calling this several times with different addresses, and
    /// that is what the client does. A wallet with one transparent address cannot split,
    /// and `WalletdWallet.shield` says so rather than accepting `splitInto` and quietly
    /// doing one transaction.
    ///
    /// Returns `None` when there is nothing above the threshold worth moving. That is the
    /// ordinary end of a sweep, not a failure.
    pub async fn shield(
        &self,
        usk: &zcash_keys::keys::UnifiedSpendingKey,
        from: Option<&[String]>,
        minimum_zat: Option<u64>,
    ) -> Result<Option<ShieldOutcome>, ChainError> {
        use zcash_client_backend::data_api::wallet::input_selection::GreedyInputSelector;
        use zcash_client_backend::data_api::wallet::{
            create_proposed_transactions, propose_shielding, SpendingKeys,
        };
        use zcash_client_backend::data_api::{CoinbaseFilter, WalletRead};
        use zcash_client_backend::fees::standard::SingleOutputChangeStrategy;
        use zcash_client_backend::fees::{DustOutputPolicy, StandardFeeRule};
        use zcash_client_backend::wallet::OvkPolicy;
        use ::transparent::address::TransparentAddress;

        let params = self.network.params();
        let mut db = self.open_db()?;

        let account_id = *db
            .get_account_ids()
            .map_err(|e| ChainError::Db(e.to_string()))?
            .first()
            .ok_or_else(|| ChainError::Db("no account registered".into()))?;

        // Which transparent addresses to sweep. Every one the account knows about, unless
        // the caller named some.
        let owned = db
            .get_transparent_receivers(account_id, true, true)
            .map_err(|e| ChainError::Db(e.to_string()))?;

        let addresses: Vec<TransparentAddress> = match from {
            Some(requested) => {
                let mut selected = Vec::with_capacity(requested.len());
                for encoded in requested {
                    let decoded = decode_transparent(&params, encoded)?;
                    // Refuse an address the wallet does not control rather than sweeping
                    // nothing and reporting success: "I shielded zero" and "that is not
                    // your address" are different answers.
                    if !owned.contains_key(&decoded) {
                        return Err(ChainError::Send(format!(
                            "{encoded} is not a transparent address this wallet controls"
                        )));
                    }
                    selected.push(decoded);
                }
                selected
            }
            None => owned.keys().copied().collect(),
        };

        if addresses.is_empty() {
            return Ok(None);
        }

        // The shielding threshold. A UTXO worth less than the fee to move it costs money
        // to shield, so the default is the ZIP 317 marginal fee rather than zero.
        let threshold = Zatoshis::from_u64(minimum_zat.unwrap_or(DEFAULT_SHIELD_THRESHOLD_ZAT))
            .map_err(|e| ChainError::Send(format!("invalid minimum: {e:?}")))?;

        let input_selector = GreedyInputSelector::new();
        // Change stays in Ironwood, for the same reason it does on a payment: change
        // landing in another pool would be a pool-crossing transfer, and ZIP 318 makes the
        // net amount crossing public.
        let change_strategy = SingleOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            ShieldedPool::Ironwood,
            DustOutputPolicy::default(),
        );

        let proposal = match propose_shielding::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(
            &mut db,
            &params,
            &input_selector,
            &change_strategy,
            threshold,
            &addresses,
            account_id,
            ConfirmationsPolicy::MIN,
            CoinbaseFilter::AllTransparentOutputs,
            None,
        ) {
            Ok(proposal) => proposal,
            Err(error) => {
                // "Nothing to shield" is the common case and must not look like a failure.
                let message = error.to_string();
                if message.contains("Insufficient") || message.contains("insufficient") {
                    return Ok(None);
                }
                return Err(ChainError::Send(format!("building shielding proposal: {message}")));
            }
        };

        let step = proposal.steps().last();
        let fee_zat = u64::from(step.balance().fee_required());
        // The value being shielded, taken from the proposal rather than assumed: this is
        // the ZIP 317 fee the transaction will actually pay, not a conventional guess.
        let total_in: u64 = step
            .transparent_inputs()
            .iter()
            .map(|utxo| u64::from(utxo.value()))
            .sum();
        let amount_zat = total_in.saturating_sub(fee_zat);

        let prover = ensure_sapling_prover()?;
        let spending_keys = SpendingKeys::from_unified_spending_key(usk.clone());

        let txids = create_proposed_transactions::<
            _,
            _,
            std::convert::Infallible,
            _,
            std::convert::Infallible,
            _,
        >(
            &mut db,
            &params,
            &prover,
            &prover,
            &spending_keys,
            OvkPolicy::Sender,
            &proposal,
            None,
        )
        .map_err(|e| ChainError::Send(format!("building shielding transaction: {e}")))?;

        let txid = *txids.first();
        self.broadcast(&mut db, txid).await?;

        tracing::info!(txid = %txid, amount_zat, fee_zat, "shielded");
        Ok(Some(ShieldOutcome {
            txid: txid.to_string(),
            amount_zat,
            fee_zat,
        }))
    }

    /// Build, prove and broadcast a shielded Ironwood payment carrying `memo`.
    ///
    /// Change is directed to Ironwood via `fallback_change_pool`. That is not a detail:
    /// change landing in another pool would be a pool-crossing transfer, and ZIP 318 makes
    /// the net amount crossing public.
    pub async fn send(
        &self,
        usk: &zcash_keys::keys::UnifiedSpendingKey,
        to: &str,
        amount_zat: u64,
        memo: &str,
    ) -> Result<SendOutcome, ChainError> {
        self.send_to(
            usk,
            &[SendOutput {
                to: to.to_string(),
                amount_zat,
                memo: Some(memo.to_string()),
            }],
        )
        .await
    }

    /// Send one transaction carrying several outputs.
    ///
    /// This is how a facilitator fee is paid: the payee's leg and the fee leg in one
    /// transaction, so the verifier's "both arrived" check means something.
    pub async fn send_many(
        &self,
        usk: &zcash_keys::keys::UnifiedSpendingKey,
        outputs: &[SendOutput],
    ) -> Result<SendOutcome, ChainError> {
        self.send_to(usk, outputs).await
    }

    /// The shared transfer path.
    ///
    /// `memo` is optional only because a transparent output cannot carry one. Every Byte
    /// *payment* has a memo — it is what binds a note to an invoice — so the public
    /// `send` above requires it, and only `unshield` passes `None`.
    async fn send_to(&self, usk: &zcash_keys::keys::UnifiedSpendingKey, outputs: &[SendOutput]) -> Result<SendOutcome, ChainError> {
        use zcash_client_backend::data_api::wallet::input_selection::{
            GreedyInputSelector, SpendPolicy,
        };
        use zcash_client_backend::data_api::wallet::{
            create_proposed_transactions, propose_transfer, SpendingKeys,
        };
        use zcash_client_backend::fees::standard::SingleOutputChangeStrategy;
        use zcash_client_backend::fees::{DustOutputPolicy, StandardFeeRule};
        use zcash_client_backend::wallet::OvkPolicy;
        use zcash_protocol::memo::MemoBytes;

        if outputs.is_empty() {
            return Err(ChainError::Send("a payment needs at least one output".into()));
        }

        let params = self.network.params();
        let mut db = self.open_db()?;

        let account_id = *db
            .get_account_ids()
            .map_err(|e| ChainError::Db(e.to_string()))?
            .first()
            .ok_or_else(|| ChainError::Db("no account registered".into()))?;

        // One transaction request carrying every output.
        //
        // **One transaction, not one per output.** A Byte payment and its facilitator fee
        // are atomic precisely because they share a transaction: the verifier checks both
        // arrived, and "both or neither" is a property the chain gives for free here and
        // could not give across two broadcasts.
        let mut payments = Vec::with_capacity(outputs.len());
        for output in outputs {
            let recipient = zcash_address::ZcashAddress::try_from_encoded(&output.to)
                .map_err(|e| ChainError::Send(format!("could not parse address {}: {e}", output.to)))?;

            let amount = Zatoshis::from_u64(output.amount_zat)
                .map_err(|e| ChainError::Send(format!("invalid amount: {e:?}")))?;

            let memo = match output.memo.as_deref() {
                Some(text) => Some(
                    MemoBytes::from_bytes(text.as_bytes())
                        .map_err(|e| ChainError::Send(format!("invalid memo: {e:?}")))?,
                ),
                None => None,
            };

            payments.push(
                zip321::Payment::new(recipient, Some(amount), memo, None, None, vec![])
                    .map_err(|e| ChainError::Send(format!("invalid payment: {e:?}")))?,
            );
        }

        let request = zip321::TransactionRequest::new(payments)
            .map_err(|e| ChainError::Send(format!("invalid transaction request: {e:?}")))?;

        let input_selector = GreedyInputSelector::new();
        // Change stays in Ironwood: change landing elsewhere would be a pool-crossing
        // transfer, and ZIP 318 makes the net amount crossing public.
        let change_strategy = SingleOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            ShieldedPool::Ironwood,
            DustOutputPolicy::default(),
        );

        // Ironwood in, and nothing else. `SpendPolicy` restricts the selector to the named
        // pools and permits no transparent spending, so it returns InsufficientFunds rather
        // than reaching into a pool the caller did not permit. That is the real fix: the
        // check below now confirms a guarantee the selector was already given, instead of
        // being the only thing standing between a shortfall and a public turnstile crossing.
        let spend_policy = SpendPolicy::shielded_pools([ShieldedPool::Ironwood]);

        // The commitment-tree error type cannot be inferred from the arguments, so it is
        // named explicitly: it is what zcash_client_sqlite's WalletCommitmentTrees uses.
        let proposal = propose_transfer::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(
            &mut db,
            &params,
            account_id,
            &input_selector,
            &change_strategy,
            request,
            ConfirmationsPolicy::MIN,
            &spend_policy,
            None,
            None,
        )
        .map_err(|e| ChainError::Send(format!("building proposal: {e}")))?;

        // Belt and braces, and cheap. The selector was told Ironwood only; this confirms
        // the proposal it produced honours that, before anything is proved, signed or
        // broadcast. Two independent checks on the one property the whole protocol rests on
        // is the right number.
        assert_ironwood_funded(&proposal)?;

        let fee_zat = u64::from(proposal.steps().last().balance().fee_required());

        let prover = ensure_sapling_prover()?;
        let spending_keys = SpendingKeys::from_unified_spending_key(usk.clone());

        // The input-selector and change-strategy error types appear only in the error
        // variant here — the proposal was already built — so they are pinned to
        // Infallible rather than threaded through.
        let txids = create_proposed_transactions::<
            _,
            _,
            std::convert::Infallible,
            _,
            std::convert::Infallible,
            _,
        >(
            &mut db,
            &params,
            &prover,
            &prover,
            &spending_keys,
            OvkPolicy::Sender,
            &proposal,
            None,
        )
        .map_err(|e| ChainError::Send(format!("building transaction: {e}")))?;

        let txid = *txids.first();

        // Broadcast. Until this succeeds nothing has left the machine, so a failure here
        // means the payment did not happen — not that it happened and was lost.
        self.broadcast(&mut db, txid).await?;

        tracing::info!(txid = %txid, fee_zat, "broadcast");

        Ok(SendOutcome {
            txid: txid.to_string(),
            fee_zat: fee_zat.to_string(),
        })
    }
}
