//! Split build and sign, over PCZTs.
//!
//! ## What this separates, and why it is worth separating
//!
//! An agent that holds a spending key and has a bug is a wallet-draining machine. The spend
//! guard on the TypeScript side is one answer, but it lives in the same process as the key:
//! compromise the process and the guard goes with it.
//!
//! A PCZT splits the job in two. A **builder** holding only a viewing key assembles the
//! transaction and proves it. A **signer** holding the spending key reads what it has been
//! handed, checks it against a policy, and signs only if it agrees. The builder never has
//! the key; the signer never builds. Neither half alone can move money to the wrong place.
//!
//! This is what makes "the key never leaves the wallet" a mechanism rather than a slogan,
//! and it is the flow the MetaMask snap's `signPczt` exists for.
//!
//! ## The signer actually reads what it signs
//!
//! The load-bearing part. A signer that signs whatever it is handed adds a round trip and no
//! safety at all. Byte's signer walks the Ironwood actions, reads the `value` and
//! `recipient` the builder filled in, and refuses on:
//!
//! - any output paying an address outside the policy's allow list;
//! - a total above the policy's cap;
//! - **any spend whose note is not Ironwood** — the same rule the direct send path enforces,
//!   applied again on the side that holds the key;
//! - a PCZT whose outputs it cannot read at all, because a policy cannot be enforced against
//!   fields that are absent.
//!
//! Refusing an unreadable PCZT is deliberate. "I could not check" must not read as "I
//! checked and it was fine".
//!
//! ## What a PCZT does not protect against
//!
//! The builder chooses the recipient. A compromised builder proposes a payment to an address
//! of its choosing, and the signer's policy is what stops it — so the policy is the security
//! boundary, not the PCZT. A policy allowing any address gets you a round trip and nothing
//! else.

use orchard::keys::SpendAuthorizingKey;
// `::pczt`, leading-colon, because this module used to be called `pczt` and shadowed the
// crate. Named for what it does instead.
use ::pczt::roles::{prover::Prover, signer::Signer};
use ::pczt::Pczt;
use orchard::circuit::OrchardCircuitVersion;
use zcash_protocol::{PoolType, ShieldedPool};

use crate::chain::ChainError;

/// What a signer will agree to sign.
///
/// Empty by default in the sense that matters: a policy with no allow list and no cap
/// permits anything, which is a choice a caller has to make explicitly rather than inherit.
#[derive(Debug, Clone, Default)]
pub struct SignPolicy {
    /// Encoded unified addresses this signer will pay. Any recipient when empty.
    pub allow_recipients: Vec<String>,
    /// Refuse if the total value paid to others exceeds this.
    pub max_total_zat: Option<u64>,
}

/// Why a signer refused.
#[derive(Debug, thiserror::Error)]
pub enum SignRefusal {
    #[error("this PCZT has {pool} components; Byte signs Ironwood-only transactions")]
    WrongPool { pool: &'static str },
    #[error(
        "this PCZT has an output whose value or recipient is not readable, so the signing \
         policy cannot be checked against it"
    )]
    Unreadable,
    #[error("this PCZT pays {recipient}, which is not in the signer's allow list")]
    RecipientNotAllowed { recipient: String },
    #[error("this PCZT pays {total} zatoshis, over the signer's cap of {cap}")]
    OverCap { total: u64, cap: u64 },
    #[error("this PCZT has no Ironwood actions to sign")]
    NothingToSign,
}

/// What the signer found, so a caller can log or display it before it signs.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignReview {
    /// Every output this transaction creates that the signer could read.
    pub outputs: Vec<ReviewedOutput>,
    /// Total value paid, in zatoshis, as a string like every other amount.
    pub total_zat: String,
    /// How many Ironwood actions the transaction contains.
    ///
    /// Not a spend count: the crate does not expose a spend's value, so which actions carry
    /// a real spend and which are padding is not something a signer can tell from outside.
    pub action_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedOutput {
    pub recipient: String,
    pub amount_zat: String,
}

/// Read what a PCZT would do, without signing it.
///
/// Exposed on its own so a caller can show a human what they are about to authorize. The
/// signer calls it too: a review a caller can see and a policy the signer enforces should be
/// computed by the same code, or they drift and the display reassures about something the
/// signer did not check.
///
/// ## What is and is not readable
///
/// A PCZT carries **Orchard and Ironwood as separate bundles** (`pczt.orchard()` and
/// `pczt.ironwood()`), so which pool a spend is in is structural rather than something to
/// infer from a note version. That makes the pool rule easy to state: anything in the Orchard
/// bundle, or the transparent or Sapling ones, is refused outright.
///
/// The crate exposes each output's `recipient` and `value` but **not** a spend's, so the
/// review reports what is being *paid* and not what is being *spent*. That is the half a
/// payment policy needs. It also means the spend side cannot be audited from here, and this
/// says so rather than pretending to a completeness the API does not allow.
pub fn review(pczt: &Pczt, network: crate::keys::Network) -> Result<SignReview, SignRefusal> {
    // The pool rule, applied on the side that holds the key. The direct send path enforces
    // it too; enforcing it here is what makes it survive a compromised builder.
    if !pczt.transparent().inputs().is_empty() || !pczt.transparent().outputs().is_empty() {
        return Err(SignRefusal::WrongPool {
            pool: "transparent",
        });
    }
    if !pczt.sapling().spends().is_empty() || !pczt.sapling().outputs().is_empty() {
        return Err(SignRefusal::WrongPool { pool: "sapling" });
    }
    if !pczt.orchard().actions().is_empty() {
        return Err(SignRefusal::WrongPool { pool: "orchard" });
    }

    let actions = pczt.ironwood().actions();
    if actions.is_empty() {
        return Err(SignRefusal::NothingToSign);
    }

    let mut outputs = Vec::new();
    let mut total: u64 = 0;

    for action in actions {
        let output = action.output();

        match (output.recipient(), output.value()) {
            (Some(recipient), Some(value)) => {
                // Zero-valued outputs are padding, not payments.
                if *value == 0 {
                    continue;
                }
                total = total.saturating_add(*value);
                outputs.push(ReviewedOutput {
                    recipient: encode_recipient(recipient, network)
                        .ok_or(SignRefusal::Unreadable)?,
                    amount_zat: value.to_string(),
                });
            }
            // Both absent is a note this signer is not meant to see, which a change output
            // back to the sender normally is.
            (None, None) => {}
            // One without the other means the fields were stripped or corrupted. A policy
            // cannot be enforced against an output it can only half read.
            _ => return Err(SignRefusal::Unreadable),
        }
    }

    Ok(SignReview {
        outputs,
        total_zat: total.to_string(),
        action_count: actions.len(),
    })
}

/// A recipient, encoded as a unified address carrying only that Orchard-shaped receiver.
///
/// `None` when the bytes are not a valid address. Returned as an error upstream instead of a
/// placeholder string: a placeholder can match an allow-list entry or a display by accident,
/// and a recipient the signer cannot decode is one it must not sign for.
fn encode_recipient(raw: &[u8; 43], network: crate::keys::Network) -> Option<String> {
    use zcash_keys::address::UnifiedAddress;

    let address = Option::from(orchard::Address::from_raw_address_bytes(raw))?;
    UnifiedAddress::from_receivers(Some(address), None, None).map(|ua| ua.encode(&network.params()))
}

/// Check a PCZT against a policy, then sign every Ironwood spend in it.
///
/// The policy is checked **in full, first**, before a single signature is produced. A signer
/// that checked as it went could leave a partially signed PCZT behind after refusing, and a
/// partially signed transaction is a worse thing to have lying around than an unsigned one.
pub fn sign(
    pczt: Pczt,
    ask: &SpendAuthorizingKey,
    policy: &SignPolicy,
    network: crate::keys::Network,
) -> Result<(Pczt, SignReview), ChainError> {
    let found = review(&pczt, network).map_err(|e| ChainError::WrongPoolSource(e.to_string()))?;

    if !policy.allow_recipients.is_empty() {
        for output in &found.outputs {
            if !policy.allow_recipients.contains(&output.recipient) {
                return Err(ChainError::WrongPoolSource(
                    SignRefusal::RecipientNotAllowed {
                        recipient: output.recipient.clone(),
                    }
                    .to_string(),
                ));
            }
        }
    }

    if let Some(cap) = policy.max_total_zat {
        // `total_zat` is this module's own output, so a parse failure is a bug rather than
        // untrusted input; failing closed at u64::MAX means a bug denies rather than allows.
        let total: u64 = found.total_zat.parse().unwrap_or(u64::MAX);
        if total > cap {
            return Err(ChainError::WrongPoolSource(
                SignRefusal::OverCap { total, cap }.to_string(),
            ));
        }
    }

    let action_count = pczt.ironwood().actions().len();

    let mut signer = Signer::new(pczt).map_err(|e| ChainError::Send(format!("signer: {e:?}")))?;
    let mut signed = 0usize;
    for index in 0..action_count {
        match signer.sign_ironwood(index, ask) {
            Ok(()) => signed += 1,
            // `ask` does not own this action's spent note. That is what a padding action
            // looks like, and a spend under some other key would look the same. Neither is
            // ours to sign, and neither is an error: leave it for whoever holds that key.
            Err(::pczt::roles::signer::Error::IronwoodSign(
                orchard::pczt::SignerError::WrongSpendAuthorizingKey,
            )) => {}
            Err(e) => {
                return Err(ChainError::Send(format!("signing action {index}: {e:?}")));
            }
        }
    }

    // Signing nothing is not success. A PCZT whose every action belongs to someone else
    // would otherwise come back unchanged and look signed.
    if signed == 0 {
        return Err(ChainError::WrongPoolSource(
            "none of this PCZT's Ironwood actions spend a note this key owns".to_string(),
        ));
    }

    Ok((signer.finish(), found))
}

/// Add the Ironwood proof.
///
/// Needs no secret, only the proving key, so it belongs on the builder: the signer should do
/// as little as possible beyond holding the key and deciding.
///
/// The proving key is built once and reused. Building it is expensive, and doing it per
/// transaction would make every payment pay for it.
pub fn prove(pczt: Pczt) -> Result<Pczt, ChainError> {
    use std::sync::OnceLock;
    static PROVING_KEY: OnceLock<orchard::circuit::ProvingKey> = OnceLock::new();

    let prover = Prover::new(pczt);
    if !prover.requires_ironwood_proof() {
        return Ok(prover.finish());
    }

    // PostNu6_3 is the Ironwood circuit. FixedPostNu6_2 would prove against the wrong one
    // and the network would reject it.
    let pk = PROVING_KEY
        .get_or_init(|| orchard::circuit::ProvingKey::build(OrchardCircuitVersion::PostNu6_3));

    Ok(prover
        .create_ironwood_proof(pk)
        .map_err(|e| ChainError::Send(format!("proving: {e:?}")))?
        .finish())
}

/// True when this PCZT carries data only in Ironwood.
///
/// Checked on the signing side as well as the building side. A PCZT reaching a signer with a
/// transparent or Sapling component means something upstream built a transaction Byte's own
/// rules forbid, and the side holding the key is the last place to catch it.
pub fn touches_only_ironwood(pczt: &Pczt) -> bool {
    !pczt.has_data_in_pool(PoolType::Transparent)
        && !pczt.has_data_in_pool(PoolType::Shielded(ShieldedPool::Sapling))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::pczt::roles::creator::Creator;

    /// An empty PCZT: no bundle in any pool. What a signer must refuse rather than "sign".
    fn empty() -> Pczt {
        Creator::new(0x37a5_165b, 4_500_000, 0, Some([0u8; 32]), Some([0u8; 32]))
            .expect("creator")
            .build()
            .expect("an empty PCZT builds")
    }

    #[test]
    fn an_empty_pczt_is_refused_not_signed() {
        // Signing nothing must not come back looking like success.
        let err = review(&empty(), crate::keys::Network::Test).unwrap_err();
        assert!(matches!(err, SignRefusal::NothingToSign), "got {err:?}");
    }

    #[test]
    fn the_default_policy_permits_any_recipient_and_any_amount() {
        // Stated as a test because it is the dangerous default: a caller who wants limits
        // has to ask for them, and this is the line that keeps that visible.
        let policy = SignPolicy::default();
        assert!(policy.allow_recipients.is_empty());
        assert!(policy.max_total_zat.is_none());
    }

    #[test]
    fn refusals_name_the_reason() {
        let msg = SignRefusal::OverCap { total: 10, cap: 5 }.to_string();
        assert!(msg.contains("10") && msg.contains("5"), "{msg}");

        let msg = SignRefusal::RecipientNotAllowed {
            recipient: "u1x".into(),
        }
        .to_string();
        assert!(msg.contains("u1x") && msg.contains("allow list"), "{msg}");

        let msg = SignRefusal::WrongPool { pool: "sapling" }.to_string();
        assert!(msg.contains("sapling"), "{msg}");
    }
}
