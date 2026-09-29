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
}

impl From<ChainError> for WalletStateError {
    fn from(error: ChainError) -> Self {
        WalletStateError::ChainAccess(error.to_string())
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
        })
    }

    /// Scan until caught up with the tip. Returns the height scanned to.
    pub async fn sync_once(&self) -> Result<u32, ChainError> {
        let mut client = connect(&self.endpoint).await?;
        let tip = chain_tip(&mut client).await?;
        self.chain_tip.store(tip, Ordering::Relaxed);

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
        Ok(SyncStatus {
            synced_height,
            chain_tip: (tip > 0).then_some(tip),
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

fn parse_txid(hex_txid: &str) -> Result<zcash_protocol::TxId, WalletStateError> {
    let bytes = hex::decode(hex_txid)
        .map_err(|e| WalletStateError::ChainAccess(format!("txid must be hex: {e}")))?;
    let array: [u8; 32] = bytes
        .try_into()
        .map_err(|_| WalletStateError::ChainAccess("txid must be 32 bytes".into()))?;
    Ok(zcash_protocol::TxId::from_bytes(array))
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
    fn rejects_malformed_txids() {
        for bad in ["", "abc", &"z".repeat(64), &"a".repeat(62), &"a".repeat(66)] {
            assert!(parse_txid(bad).is_err(), "should have rejected {bad:?}");
        }
    }
}

// --------------------------------------------------------------------------------- send

/// The outcome of a successful send.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    pub txid: String,
    pub fee_zat: String,
}

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
        use zcash_client_backend::data_api::wallet::{
            create_proposed_transactions, propose_standard_transfer_to_address, SpendingKeys,
        };
        use zcash_client_backend::fees::StandardFeeRule;
        use zcash_client_backend::wallet::OvkPolicy;
        use zcash_keys::address::Address;
        use zcash_protocol::memo::MemoBytes;

        let params = self.network.params();
        let mut db = self.open_db()?;

        let account_id = *db
            .get_account_ids()
            .map_err(|e| ChainError::Db(e.to_string()))?
            .first()
            .ok_or_else(|| ChainError::Db("no account registered".into()))?;

        let recipient = Address::decode(&params, to)
            .ok_or_else(|| ChainError::Send(format!("could not parse address {to}")))?;

        let amount = Zatoshis::from_u64(amount_zat)
            .map_err(|e| ChainError::Send(format!("invalid amount: {e:?}")))?;

        let memo_bytes = MemoBytes::from_bytes(memo.as_bytes())
            .map_err(|e| ChainError::Send(format!("invalid memo: {e:?}")))?;

        // The commitment-tree error type cannot be inferred from the arguments, so it is
        // named explicitly: it is what zcash_client_sqlite's WalletCommitmentTrees uses.
        let proposal = propose_standard_transfer_to_address::<
            _,
            _,
            zcash_client_sqlite::wallet::commitment_tree::Error,
        >(
            &mut db,
            &params,
            StandardFeeRule::Zip317,
            account_id,
            ConfirmationsPolicy::MIN,
            &recipient,
            amount,
            Some(memo_bytes),
            None,
            // Change stays in Ironwood. See the note on this method.
            ShieldedPool::Ironwood,
            None,
            None,
        )
        .map_err(|e| ChainError::Send(format!("building proposal: {e}")))?;

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
        let raw = db
            .get_transaction(txid)
            .map_err(|e| ChainError::Db(e.to_string()))?
            .ok_or_else(|| {
                ChainError::Send("built transaction is missing from the wallet".into())
            })?;

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

        tracing::info!(txid = %txid, fee_zat, "broadcast");

        Ok(SendOutcome {
            txid: txid.to_string(),
            fee_zat: fee_zat.to_string(),
        })
    }
}
