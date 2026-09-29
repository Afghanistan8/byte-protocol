//! byte-walletd — Byte Protocol's wallet sidecar.
//!
//! Builds on librustzcash to do the things Byte cannot do from TypeScript: derive fresh
//! diversified unified addresses, send shielded Ironwood payments carrying a memo, and
//! verify received notes from a view-only key.
//!
//! It exposes a small JSON API on localhost that `@byte-protocol/wallet` calls. It is not
//! a general-purpose wallet and does not try to be.
//!
//! **What this does not do:** decide consensus validity. librustzcash states plainly that
//! its APIs do not check whether a transaction is valid under consensus; only a node can
//! say that. Verification here establishes that a note was received, in which pool, for
//! how much, carrying which memo — nothing stronger.

pub mod keys;
pub mod memo;
