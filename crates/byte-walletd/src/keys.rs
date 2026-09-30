//! Key handling and address derivation.
//!
//! Byte's address rule, from `docs/SPEC.md` §3: every invoice gets a fresh diversified
//! unified address carrying an **Orchard-typecode receiver and no transparent receiver**.
//!
//! There is no Ironwood receiver type to ask for. The ZIP 316 typecode registry ends at
//! Orchard, and Ironwood reuses Orchard receivers and viewing keys. After NU6.3, value
//! sent to such a receiver lands in the Ironwood pool. That is why this module asks
//! librustzcash for `UnifiedAddressRequest::ORCHARD` — which is defined as
//! `(Require, Omit, Omit)`: Orchard required, Sapling omitted, transparent omitted —
//! and why the pool check lives on the *received note* rather than on the address.

use secrecy::{ExposeSecret, SecretBox};
use zcash_keys::keys::{
    DerivationError, UnifiedAddressRequest, UnifiedFullViewingKey, UnifiedSpendingKey,
};
use zcash_protocol::consensus::{self, NetworkType};
use zip32::{AccountId, DiversifierIndex};

/// The address shape every Byte invoice uses.
///
/// `ORCHARD` requires an Orchard receiver and omits every other type, which is exactly
/// what the spec demands. Naming it once means no call site can quietly ask for
/// something laxer — an address that also carried a transparent receiver would let a
/// payer settle in public without either side noticing.
pub const BYTE_ADDRESS_REQUEST: UnifiedAddressRequest = UnifiedAddressRequest::ORCHARD;

#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    #[error("seed must be between 32 and 252 bytes, got {0}")]
    SeedLength(usize),
    #[error("key derivation failed: {0}")]
    Derivation(#[from] DerivationError),
    #[error("address generation failed: {0}")]
    AddressGeneration(String),
    #[error("could not decode unified full viewing key: {0}")]
    DecodeUfvk(String),
    #[error("diversifier index space exhausted")]
    DiversifierExhausted,
}

/// Which network this wallet operates on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Main,
    Test,
}

impl Network {
    pub fn params(self) -> consensus::Network {
        match self {
            Network::Main => consensus::Network::MainNetwork,
            Network::Test => consensus::Network::TestNetwork,
        }
    }

    pub fn network_type(self) -> NetworkType {
        match self {
            Network::Main => NetworkType::Main,
            Network::Test => NetworkType::Test,
        }
    }

    /// The Byte network identifier, as used on the wire. See `docs/SPEC.md` §2.
    pub fn byte_id(self) -> &'static str {
        match self {
            Network::Main => "zcash:00040fe8ec8471911baa1db1266ea15d",
            Network::Test => "zcash:05a60a92d99d85997cce3b87616c089f",
        }
    }

    /// Height at which NU6.3 activated, from ZIP 258.
    ///
    /// Below this the Ironwood pool does not exist, so no Byte payment is possible.
    pub fn nu6_3_activation_height(self) -> u32 {
        match self {
            Network::Main => 3_428_143,
            Network::Test => 4_134_000,
        }
    }
}

/// A wallet's spend capability.
///
/// The seed is held in a `SecretBox` so it is zeroed on drop and cannot be printed by
/// accident. `Debug` is implemented by hand for the same reason: a derived `Debug` on a
/// struct holding key material is one `tracing::debug!` away from writing a seed to a log
/// file.
pub struct SpendingKeys {
    seed: SecretBox<Vec<u8>>,
    account: AccountId,
    network: Network,
}

impl std::fmt::Debug for SpendingKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpendingKeys")
            .field("seed", &"<redacted>")
            .field("network", &self.network)
            .finish()
    }
}

impl SpendingKeys {
    /// Load from a seed.
    ///
    /// ZIP 32 requires a seed of at least 32 bytes; librustzcash caps it at 252. Checked
    /// here so a too-short seed is a clear error at startup rather than an opaque
    /// derivation failure on the first payment.
    pub fn from_seed(network: Network, seed: Vec<u8>, account: u32) -> Result<Self, KeyError> {
        if seed.len() < 32 || seed.len() > 252 {
            return Err(KeyError::SeedLength(seed.len()));
        }
        let account = AccountId::try_from(account).map_err(|_| {
            KeyError::AddressGeneration(format!("account index {account} is out of range"))
        })?;
        // Derive once here so an invalid seed fails at startup, not mid-payment.
        UnifiedSpendingKey::from_seed(&network.params(), &seed, account)?;
        Ok(Self {
            seed: SecretBox::new(Box::new(seed)),
            account,
            network,
        })
    }

    pub fn network(&self) -> Network {
        self.network
    }

    pub fn usk(&self) -> Result<UnifiedSpendingKey, KeyError> {
        Ok(UnifiedSpendingKey::from_seed(
            &self.network.params(),
            self.seed.expose_secret(),
            self.account,
        )?)
    }

    pub fn ufvk(&self) -> Result<UnifiedFullViewingKey, KeyError> {
        Ok(self.usk()?.to_unified_full_viewing_key())
    }

    /// The view-only capability to hand a facilitator.
    ///
    /// This is the whole point of the split: what comes out of here can verify payments
    /// and cannot move a single zatoshi.
    pub fn export_ufvk(&self) -> Result<String, KeyError> {
        Ok(self.ufvk()?.encode(&self.network.params()))
    }
}

/// A wallet's view-only capability.
pub struct ViewingKeys {
    ufvk: UnifiedFullViewingKey,
    network: Network,
}

impl std::fmt::Debug for ViewingKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ViewingKeys")
            .field("ufvk", &"<redacted>")
            .field("network", &self.network)
            .finish()
    }
}

impl ViewingKeys {
    pub fn decode(network: Network, encoded: &str) -> Result<Self, KeyError> {
        let ufvk = UnifiedFullViewingKey::decode(&network.params(), encoded)
            .map_err(KeyError::DecodeUfvk)?;
        Ok(Self { ufvk, network })
    }

    pub fn from_ufvk(network: Network, ufvk: UnifiedFullViewingKey) -> Self {
        Self { ufvk, network }
    }

    pub fn network(&self) -> Network {
        self.network
    }

    pub fn ufvk(&self) -> &UnifiedFullViewingKey {
        &self.ufvk
    }

    /// Derive the invoice address at a specific diversifier index.
    ///
    /// Returns the encoded address and the index actually used, which may be higher than
    /// the one requested: not every index yields a valid diversifier, so librustzcash
    /// searches forward. The caller must persist the returned index and resume from the
    /// next one, or two invoices will share an address — the exact linkage Byte exists to
    /// prevent.
    /// Derive a transparent receiving address at a diversifier index.
    ///
    /// ## Why this goes via a unified address
    ///
    /// A unified address with no shielded receiver cannot be constructed:
    /// `ReceiverRequirements::new` returns `NoShieldedReceiver` when both Orchard and
    /// Sapling are omitted. So this asks for an address that *requires* a p2pkh receiver
    /// and takes that receiver out of it, rather than trying to build a transparent-only UA.
    ///
    /// ## What it is for, and what it is not for
    ///
    /// Rails. NEAR Intents delivers ZEC to `t1`/`t3` only, so funding needs a transparent
    /// address to receive at, and a **fresh one per funding** so that an observer cannot
    /// read one address as the party's whole funding history.
    ///
    /// It is never an invoice address. A Byte payment is settled in Ironwood, and
    /// `invoice_address_at` above deliberately carries no transparent receiver at all.
    pub fn transparent_address_at(&self, index: u32) -> Result<(String, u32), KeyError> {
        use zcash_keys::keys::{ReceiverRequirement, UnifiedAddressRequest};

        let j = DiversifierIndex::try_from(u128::from(index))
            .map_err(|_| KeyError::DiversifierExhausted)?;

        // Orchard is Allow rather than Omit because Omit on both shielded receivers is
        // rejected outright; only the transparent receiver is used from the result.
        let request = UnifiedAddressRequest::unsafe_custom(
            ReceiverRequirement::Allow,
            ReceiverRequirement::Omit,
            ReceiverRequirement::Require,
        );

        let (address, found) = self
            .ufvk
            .find_address(j, request)
            .map_err(|e| KeyError::AddressGeneration(e.to_string()))?;

        let transparent = address.transparent().ok_or_else(|| {
            // Require was asked for, so this cannot happen without the library changing
            // under us. Reported rather than unwrapped: an address silently missing its
            // transparent receiver would send rail funds nowhere recoverable.
            KeyError::AddressGeneration(
                "a p2pkh receiver was required but the derived address has none".into(),
            )
        })?;

        Ok((
            transparent
                .to_zcash_address(self.network.network_type())
                .to_string(),
            diversifier_index_to_u32(&found)?,
        ))
    }

    pub fn invoice_address_at(&self, index: u32) -> Result<(String, u32), KeyError> {
        let j = DiversifierIndex::try_from(u128::from(index))
            .map_err(|_| KeyError::DiversifierExhausted)?;

        let (address, found) = self
            .ufvk
            .find_address(j, BYTE_ADDRESS_REQUEST)
            .map_err(|e| KeyError::AddressGeneration(e.to_string()))?;

        debug_assert!(
            address.has_orchard(),
            "BYTE_ADDRESS_REQUEST requires an Orchard receiver"
        );

        Ok((
            address.encode(&self.network.params()),
            diversifier_index_to_u32(&found)?,
        ))
    }
}

/// Narrow a diversifier index back to a `u32`.
///
/// ZIP 32 diversifier indices are 88 bits. Byte issues them sequentially from zero and
/// will never reach 2^32 invoices on one account, so a `u32` is the honest working range;
/// exceeding it is an explicit error rather than a silent truncation that would start
/// reusing addresses.
fn diversifier_index_to_u32(index: &DiversifierIndex) -> Result<u32, KeyError> {
    let bytes = index.as_bytes();
    if bytes[4..].iter().any(|&b| b != 0) {
        return Err(KeyError::DiversifierExhausted);
    }
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

/// A diversifier index cursor, so successive invoices never reuse an address.
#[derive(Debug, Default)]
pub struct DiversifierCursor {
    next: u32,
}

impl DiversifierCursor {
    pub fn new(start: u32) -> Self {
        Self { next: start }
    }

    /// Mint the next invoice address, advancing past whatever index was actually used.
    pub fn next_address(&mut self, keys: &ViewingKeys) -> Result<String, KeyError> {
        let (address, used) = keys.invoice_address_at(self.next)?;
        self.next = used.checked_add(1).ok_or(KeyError::DiversifierExhausted)?;
        Ok(address)
    }

    /// The next transparent address, advancing past any index the derivation skipped.
    pub fn next_transparent_address(&mut self, keys: &ViewingKeys) -> Result<String, KeyError> {
        let (address, used) = keys.transparent_address_at(self.next)?;
        self.next = used.checked_add(1).ok_or(KeyError::DiversifierExhausted)?;
        Ok(address)
    }

    pub fn position(&self) -> u32 {
        self.next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: [u8; 32] = [42u8; 32];

    fn keys() -> SpendingKeys {
        SpendingKeys::from_seed(Network::Test, SEED.to_vec(), 0).unwrap()
    }

    fn viewing() -> ViewingKeys {
        ViewingKeys::from_ufvk(Network::Test, keys().ufvk().unwrap())
    }

    #[test]
    fn rejects_a_seed_that_is_too_short_or_too_long() {
        assert!(matches!(
            SpendingKeys::from_seed(Network::Test, vec![0; 31], 0),
            Err(KeyError::SeedLength(31))
        ));
        assert!(matches!(
            SpendingKeys::from_seed(Network::Test, vec![0; 253], 0),
            Err(KeyError::SeedLength(253))
        ));
        assert!(SpendingKeys::from_seed(Network::Test, vec![0; 32], 0).is_ok());
    }

    #[test]
    fn derivation_is_deterministic() {
        let a = viewing().invoice_address_at(0).unwrap();
        let b = viewing().invoice_address_at(0).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn a_different_seed_gives_a_different_address() {
        let other = SpendingKeys::from_seed(Network::Test, vec![1u8; 32], 0).unwrap();
        let other_view = ViewingKeys::from_ufvk(Network::Test, other.ufvk().unwrap());
        assert_ne!(
            viewing().invoice_address_at(0).unwrap().0,
            other_view.invoice_address_at(0).unwrap().0
        );
    }

    #[test]
    fn addresses_encode_for_the_right_network() {
        // A testnet wallet handing out a mainnet-encoded address would send real funds
        // somewhere unrecoverable.
        let (address, _) = viewing().invoice_address_at(0).unwrap();
        assert!(address.starts_with("utest1"), "got {address}");
    }

    #[test]
    fn the_cursor_never_repeats_an_address() {
        // Address reuse across invoices is what makes two payments linkable on-chain.
        let view = viewing();
        let mut cursor = DiversifierCursor::default();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..200 {
            assert!(
                seen.insert(cursor.next_address(&view).unwrap()),
                "cursor produced a duplicate address"
            );
        }
        assert_eq!(seen.len(), 200);
    }

    #[test]
    fn the_cursor_advances_past_skipped_indices() {
        let view = viewing();
        let mut cursor = DiversifierCursor::default();
        cursor.next_address(&view).unwrap();
        assert!(cursor.position() >= 1);
    }

    #[test]
    fn a_ufvk_round_trips_through_its_encoding() {
        let encoded = keys().export_ufvk().unwrap();
        let decoded = ViewingKeys::decode(Network::Test, &encoded).unwrap();
        assert_eq!(
            decoded.invoice_address_at(0).unwrap(),
            viewing().invoice_address_at(0).unwrap()
        );
    }

    #[test]
    fn a_ufvk_does_not_decode_on_the_wrong_network() {
        let encoded = keys().export_ufvk().unwrap();
        assert!(ViewingKeys::decode(Network::Main, &encoded).is_err());
    }

    #[test]
    fn rejects_a_malformed_ufvk() {
        for bad in ["", "not-a-key", "uview1garbage"] {
            assert!(ViewingKeys::decode(Network::Test, bad).is_err());
        }
    }

    #[test]
    fn key_material_is_not_printed_by_debug() {
        // A derived Debug is one tracing::debug! away from writing a seed to a log file.
        let rendered = format!("{:?}", keys());
        assert!(rendered.contains("<redacted>"));
        assert!(!rendered.contains("42"));
    }

    #[test]
    fn network_identifiers_match_the_spec() {
        assert_eq!(
            Network::Test.byte_id(),
            "zcash:05a60a92d99d85997cce3b87616c089f"
        );
        assert_eq!(
            Network::Main.byte_id(),
            "zcash:00040fe8ec8471911baa1db1266ea15d"
        );
    }
}
