//! An in-memory compact-block cache.
//!
//! `zcash_client_backend::sync::run` needs a `BlockCache`, and no crate in the librustzcash
//! workspace ships an implementation — `zcash_client_sqlite::FsBlockDb` implements
//! `BlockSource` but not `BlockCache`, and the trait's own documentation offers only a
//! sketch. So Byte provides one.
//!
//! In memory rather than on disk, deliberately. A Byte wallet is registered with a birthday
//! a hundred blocks behind the tip (it has no history worth recovering), so the working set
//! is a hundred compact blocks, not a chain. Keeping them in memory avoids a second
//! on-disk format to migrate and keep consistent, and means an interrupted sync leaves
//! nothing behind to repair — it just starts again.
//!
//! The trade-off is that cached blocks do not survive a restart and must be re-downloaded.
//! For a wallet scanning ~100 blocks that costs a second or two.

use std::collections::BTreeMap;
use std::sync::RwLock;

use zcash_client_backend::data_api::chain::{error::Error as ChainError, BlockCache, BlockSource};
use zcash_client_backend::data_api::scanning::ScanRange;
use zcash_client_backend::proto::compact_formats::CompactBlock;
use zcash_protocol::consensus::BlockHeight;

#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    /// The cache does not hold a contiguous run of blocks starting at the requested height.
    ///
    /// Reported rather than papered over: a caller handed a short read starting from the
    /// wrong place would scan the wrong blocks and reach a wrong conclusion about what the
    /// wallet received.
    #[error("cache is missing blocks from height {0}")]
    Discontiguous(u32),
}

#[derive(Debug, Default)]
pub struct MemoryBlockCache {
    blocks: RwLock<BTreeMap<u32, CompactBlock>>,
}

impl MemoryBlockCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of blocks currently held. Used for reporting and tests.
    pub fn len(&self) -> usize {
        self.read_lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Drop everything at or below `height`.
    ///
    /// Called once a range has been scanned into the wallet database, so a long sync does
    /// not accumulate the whole chain in memory.
    pub fn prune_through(&self, height: BlockHeight) {
        let mut blocks = self.write_lock();
        let cutoff = u32::from(height);
        blocks.retain(|&h, _| h > cutoff);
    }

    /// Lock helpers.
    ///
    /// A poisoned lock means another thread panicked while holding it. The cache holds no
    /// invariant that a panic could corrupt — it is a map of blocks — so recovering is
    /// strictly better than propagating the panic into the sync loop.
    fn read_lock(&self) -> std::sync::RwLockReadGuard<'_, BTreeMap<u32, CompactBlock>> {
        self.blocks.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write_lock(&self) -> std::sync::RwLockWriteGuard<'_, BTreeMap<u32, CompactBlock>> {
        self.blocks.write().unwrap_or_else(|e| e.into_inner())
    }
}

impl BlockSource for MemoryBlockCache {
    type Error = CacheError;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), ChainError<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<WalletErrT, Self::Error>>,
    {
        let blocks = self.read_lock();
        let start = from_height.map(u32::from).unwrap_or(0);

        let mut expected = start;
        for (taken, (&height, block)) in blocks.range(start..).enumerate() {
            if let Some(limit) = limit {
                if taken >= limit {
                    break;
                }
            }
            // Stop at the first gap rather than skipping it. A caller asked for a
            // contiguous run; handing back blocks either side of a hole would let the
            // scanner treat an incomplete view of the chain as complete.
            if height != expected {
                break;
            }
            with_block(block.clone())?;
            expected = expected.saturating_add(1);
        }

        Ok(())
    }
}

#[async_trait::async_trait]
impl BlockCache for MemoryBlockCache {
    fn get_tip_height(
        &self,
        range: Option<&ScanRange>,
    ) -> Result<Option<BlockHeight>, Self::Error> {
        let blocks = self.read_lock();
        let tip = match range {
            None => blocks.keys().next_back().copied(),
            Some(range) => {
                let start = u32::from(range.block_range().start);
                let end = u32::from(range.block_range().end);
                blocks.range(start..end).map(|(&h, _)| h).next_back()
            }
        };
        Ok(tip.map(BlockHeight::from))
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let blocks = self.read_lock();
        let start = u32::from(range.block_range().start);
        let end = u32::from(range.block_range().end);

        let mut out = Vec::new();
        let mut expected = start;
        for (&height, block) in blocks.range(start..end) {
            if height != expected {
                break;
            }
            out.push(block.clone());
            expected = expected.saturating_add(1);
        }

        // A short read is permitted by the trait, but a read that could not start where it
        // was asked to is a missing-blocks condition, not a short read.
        if out.is_empty() && start < end && !blocks.is_empty() {
            return Err(CacheError::Discontiguous(start));
        }

        Ok(out)
    }

    async fn insert(&self, compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        let mut blocks = self.write_lock();
        for block in compact_blocks {
            let height = u32::try_from(block.height).unwrap_or(u32::MAX);
            blocks.insert(height, block);
        }
        Ok(())
    }

    async fn truncate(&self, block_height: BlockHeight) -> Result<(), Self::Error> {
        let mut blocks = self.write_lock();
        let cutoff = u32::from(block_height);
        blocks.retain(|&h, _| h <= cutoff);
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        let mut blocks = self.write_lock();
        let start = u32::from(range.block_range().start);
        let end = u32::from(range.block_range().end);
        blocks.retain(|&h, _| h < start || h >= end);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_client_backend::data_api::scanning::{ScanPriority, ScanRange};

    fn block(height: u64) -> CompactBlock {
        CompactBlock {
            height,
            ..Default::default()
        }
    }

    fn range(start: u32, end: u32) -> ScanRange {
        ScanRange::from_parts(
            BlockHeight::from(start)..BlockHeight::from(end),
            ScanPriority::Historic,
        )
    }

    #[tokio::test]
    async fn inserts_and_reads_back_a_contiguous_run() {
        let cache = MemoryBlockCache::new();
        cache.insert((10..15).map(block).collect()).await.unwrap();
        assert_eq!(cache.len(), 5);

        let read = cache.read(&range(10, 15)).await.unwrap();
        assert_eq!(read.len(), 5);
        assert_eq!(read.first().map(|b| b.height), Some(10));
        assert_eq!(read.last().map(|b| b.height), Some(14));
    }

    #[tokio::test]
    async fn stops_at_a_gap_rather_than_skipping_it() {
        // Returning blocks from either side of a hole would let the scanner treat an
        // incomplete view of the chain as complete.
        let cache = MemoryBlockCache::new();
        cache
            .insert(vec![block(10), block(11), block(13)])
            .await
            .unwrap();
        let read = cache.read(&range(10, 14)).await.unwrap();
        assert_eq!(read.len(), 2);
        assert_eq!(read.last().map(|b| b.height), Some(11));
    }

    #[tokio::test]
    async fn reports_missing_blocks_when_the_run_cannot_start() {
        let cache = MemoryBlockCache::new();
        cache.insert(vec![block(20)]).await.unwrap();
        assert!(matches!(
            cache.read(&range(10, 15)).await,
            Err(CacheError::Discontiguous(10))
        ));
    }

    #[tokio::test]
    async fn an_empty_cache_reads_empty_rather_than_erroring() {
        let cache = MemoryBlockCache::new();
        assert!(cache.read(&range(10, 15)).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn reports_its_tip_overall_and_within_a_range() {
        let cache = MemoryBlockCache::new();
        cache.insert((10..20).map(block).collect()).await.unwrap();
        assert_eq!(
            cache.get_tip_height(None).unwrap(),
            Some(BlockHeight::from(19))
        );
        assert_eq!(
            cache.get_tip_height(Some(&range(10, 15))).unwrap(),
            Some(BlockHeight::from(14))
        );
        assert_eq!(cache.get_tip_height(Some(&range(30, 40))).unwrap(), None);
    }

    #[tokio::test]
    async fn truncate_drops_everything_above_a_height() {
        let cache = MemoryBlockCache::new();
        cache.insert((10..20).map(block).collect()).await.unwrap();
        cache.truncate(BlockHeight::from(14)).await.unwrap();
        assert_eq!(cache.len(), 5);
        assert_eq!(
            cache.get_tip_height(None).unwrap(),
            Some(BlockHeight::from(14))
        );
    }

    #[tokio::test]
    async fn delete_removes_exactly_the_given_range() {
        let cache = MemoryBlockCache::new();
        cache.insert((10..20).map(block).collect()).await.unwrap();
        cache.delete(range(12, 15)).await.unwrap();
        assert_eq!(cache.len(), 7);
        assert!(cache.read(&range(12, 15)).await.is_err());
    }

    #[tokio::test]
    async fn prune_through_bounds_memory_as_scanning_advances() {
        let cache = MemoryBlockCache::new();
        cache.insert((10..20).map(block).collect()).await.unwrap();
        cache.prune_through(BlockHeight::from(15));
        assert_eq!(cache.len(), 4);
        assert_eq!(
            cache.get_tip_height(None).unwrap(),
            Some(BlockHeight::from(19))
        );
    }

    #[test]
    fn with_blocks_honours_its_limit() {
        let cache = MemoryBlockCache::new();
        futures_executor::block_on(cache.insert((10..20).map(block).collect())).unwrap();

        let mut seen = Vec::new();
        cache
            .with_blocks::<_, ()>(Some(BlockHeight::from(10)), Some(3), |b| {
                seen.push(b.height);
                Ok(())
            })
            .unwrap();
        assert_eq!(seen, vec![10, 11, 12]);
    }
}
