//! The Byte memo codec.
//!
//! This is a second implementation of the format specified in `docs/SPEC.md` §6 and
//! implemented in TypeScript in `packages/core/src/memo.ts`. The two must agree byte for
//! byte: the TypeScript client builds a memo, this crate reads it back off the chain, and
//! a disagreement would mean every payment silently failing verification.
//!
//! The cross-implementation test vectors at the bottom of this file are what hold the two
//! honest. They are duplicated verbatim in the TypeScript suite.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// Every Zcash memo field is exactly this many bytes. Not a maximum — a fixed size.
pub const MEMO_SIZE: usize = 512;

/// Version tag. A verifier rejects anything else outright.
pub const MEMO_VERSION: &str = "BYTE1";

/// Bytes of HMAC output kept. 128 bits is ample for an authenticity tag.
pub const BINDING_BYTES: usize = 16;

/// Invoice identifiers are 128 bits, rendered as 32 lowercase hex characters.
pub const INVOICE_ID_BYTES: usize = 16;

/// Minimum length of a memo secret.
///
/// HMAC accepts any key length, but a short one is brute-forceable offline by anyone
/// holding a single memo and the invoice fields it commits to — which the payer always
/// has.
pub const MIN_SECRET_BYTES: usize = 32;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MemoError {
    #[error("memo secret must be at least {MIN_SECRET_BYTES} bytes, got {0}")]
    SecretTooShort(usize),
    #[error("invoiceId must be {} lowercase hex characters", INVOICE_ID_BYTES * 2)]
    BadInvoiceId,
    #[error("memo binding must be {} lowercase hex characters", BINDING_BYTES * 2)]
    BadBinding,
    #[error("memo must have 3 fields, got {0}")]
    FieldCount(usize),
    #[error("unknown memo version {0:?}")]
    UnknownVersion(String),
    #[error("memo is {0} bytes, over the {MEMO_SIZE} limit")]
    TooLong(usize),
    #[error("memo field must be {MEMO_SIZE} bytes, got {0}")]
    WrongFieldSize(usize),
    #[error("memo bytes are not valid UTF-8")]
    NotUtf8,
}

/// The invoice fields a memo commits to.
#[derive(Debug, Clone)]
pub struct MemoBinding<'a> {
    pub invoice_id: &'a str,
    /// Zatoshis, canonical integer string.
    pub amount_zat: &'a str,
    /// The invoice's diversified unified address.
    pub pay_to: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMemo {
    pub invoice_id: String,
    pub binding: String,
}

fn is_lower_hex(value: &str, byte_len: usize) -> bool {
    value.len() == byte_len * 2
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Compute the binding tag.
///
/// Fields are joined with a NUL byte, which cannot occur in any of them. Concatenating
/// without a separator would let different field splits produce the same input — an
/// invoice for 1 zatoshi to address `23` and one for 12 to address `3` would collide —
/// and a binding that collides is a binding that can be replayed onto another invoice.
pub fn compute_binding(secret: &[u8], fields: &MemoBinding<'_>) -> Result<String, MemoError> {
    if secret.len() < MIN_SECRET_BYTES {
        return Err(MemoError::SecretTooShort(secret.len()));
    }
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(secret).expect("HMAC accepts keys of any length");
    mac.update(fields.invoice_id.as_bytes());
    mac.update(&[0]);
    mac.update(fields.amount_zat.as_bytes());
    mac.update(&[0]);
    mac.update(fields.pay_to.as_bytes());

    let tag = mac.finalize().into_bytes();
    Ok(hex::encode(&tag[..BINDING_BYTES]))
}

/// Build the memo text for an invoice.
pub fn encode_memo(secret: &[u8], fields: &MemoBinding<'_>) -> Result<String, MemoError> {
    if !is_lower_hex(fields.invoice_id, INVOICE_ID_BYTES) {
        return Err(MemoError::BadInvoiceId);
    }
    let memo = format!(
        "{MEMO_VERSION}|{}|{}",
        fields.invoice_id,
        compute_binding(secret, fields)?
    );
    // Guard the invariant rather than trusting the arithmetic above.
    if memo.len() > MEMO_SIZE {
        return Err(MemoError::TooLong(memo.len()));
    }
    Ok(memo)
}

/// Parse memo text.
///
/// Deliberately strict. A memo is attacker-controlled input arriving from the chain, and
/// anything that is not exactly the expected shape is rejected rather than salvaged.
pub fn parse_memo(text: &str) -> Result<ParsedMemo, MemoError> {
    let parts: Vec<&str> = text.split('|').collect();
    if parts.len() != 3 {
        return Err(MemoError::FieldCount(parts.len()));
    }
    if parts[0] != MEMO_VERSION {
        return Err(MemoError::UnknownVersion(parts[0].to_string()));
    }
    if !is_lower_hex(parts[1], INVOICE_ID_BYTES) {
        return Err(MemoError::BadInvoiceId);
    }
    if !is_lower_hex(parts[2], BINDING_BYTES) {
        return Err(MemoError::BadBinding);
    }
    Ok(ParsedMemo {
        invoice_id: parts[1].to_string(),
        binding: parts[2].to_string(),
    })
}

/// Check a memo against the invoice it claims to settle.
///
/// Returns a bool rather than a Result, because a failure here is an ordinary
/// verification outcome (`invalid_payment`) and not an exceptional condition. A scanner
/// meets whatever arbitrary bytes a stranger chose to send it and must not be knocked
/// over by them.
pub fn verify_memo(secret: &[u8], text: &str, fields: &MemoBinding<'_>) -> bool {
    let Ok(parsed) = parse_memo(text) else {
        return false;
    };
    let Ok(expected) = compute_binding(secret, fields) else {
        return false;
    };
    // Constant-time: a variable-time compare leaks how many leading characters an
    // attacker got right, which is enough to forge a binding one character at a time.
    let id_ok: bool = parsed
        .invoice_id
        .as_bytes()
        .ct_eq(fields.invoice_id.as_bytes())
        .into();
    let binding_ok: bool = parsed.binding.as_bytes().ct_eq(expected.as_bytes()).into();
    id_ok & binding_ok
}

/// Encode memo text into the fixed 512-byte field, NUL-padded.
pub fn to_memo_bytes(text: &str) -> Result<[u8; MEMO_SIZE], MemoError> {
    let encoded = text.as_bytes();
    if encoded.len() > MEMO_SIZE {
        return Err(MemoError::TooLong(encoded.len()));
    }
    let mut out = [0u8; MEMO_SIZE];
    out[..encoded.len()].copy_from_slice(encoded);
    Ok(out)
}

/// Recover memo text from the 512-byte field.
///
/// Trailing NUL padding is stripped. Invalid UTF-8 is an error rather than being replaced
/// with substitution characters, so a corrupted memo fails verification instead of quietly
/// becoming a string that cannot match anything.
pub fn from_memo_bytes(bytes: &[u8]) -> Result<String, MemoError> {
    if bytes.len() != MEMO_SIZE {
        return Err(MemoError::WrongFieldSize(bytes.len()));
    }
    let end = bytes.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
    std::str::from_utf8(&bytes[..end])
        .map(str::to_string)
        .map_err(|_| MemoError::NotUtf8)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: [u8; 32] = [7u8; 32];
    const OTHER_SECRET: [u8; 32] = [9u8; 32];
    const INVOICE_ID: &str = "0123456789abcdef0123456789abcdef";
    const PAY_TO: &str = "utest1exampleaddressexampleaddress";

    fn fields() -> MemoBinding<'static> {
        MemoBinding {
            invoice_id: INVOICE_ID,
            amount_zat: "100000",
            pay_to: PAY_TO,
        }
    }

    /// The vector that keeps the Rust and TypeScript codecs in agreement.
    ///
    /// This exact value is asserted in `packages/core/src/memo.test.ts`. If either
    /// implementation drifts, one of the two suites fails immediately rather than the
    /// mismatch surfacing as an unexplained verification failure on a real payment.
    #[test]
    fn cross_implementation_vector() {
        let memo = encode_memo(&SECRET, &fields()).unwrap();
        assert_eq!(
            memo,
            "BYTE1|0123456789abcdef0123456789abcdef|83277bce2698d03296873534c777da14"
        );
    }

    #[test]
    fn encodes_the_documented_shape() {
        let memo = encode_memo(&SECRET, &fields()).unwrap();
        assert!(memo.starts_with("BYTE1|0123456789abcdef0123456789abcdef|"));
        assert_eq!(memo.split('|').count(), 3);
        assert_eq!(memo.len(), 71);
        assert!(memo.len() < MEMO_SIZE);
    }

    #[test]
    fn is_deterministic() {
        assert_eq!(
            encode_memo(&SECRET, &fields()).unwrap(),
            encode_memo(&SECRET, &fields()).unwrap()
        );
    }

    #[test]
    fn rejects_a_malformed_invoice_id() {
        for id in ["", "abc", "0123456789ABCDEF0123456789ABCDEF", "zz"] {
            let f = MemoBinding {
                invoice_id: id,
                ..fields()
            };
            assert_eq!(encode_memo(&SECRET, &f), Err(MemoError::BadInvoiceId));
        }
    }

    #[test]
    fn rejects_a_short_secret() {
        assert_eq!(
            encode_memo(&[0u8; 31], &fields()),
            Err(MemoError::SecretTooShort(31))
        );
    }

    #[test]
    fn binding_changes_with_every_bound_field() {
        let base = compute_binding(&SECRET, &fields()).unwrap();
        let amount = compute_binding(
            &SECRET,
            &MemoBinding {
                amount_zat: "100001",
                ..fields()
            },
        )
        .unwrap();
        let pay_to = compute_binding(
            &SECRET,
            &MemoBinding {
                pay_to: "utest1other",
                ..fields()
            },
        )
        .unwrap();
        let secret = compute_binding(&OTHER_SECRET, &fields()).unwrap();

        assert_ne!(base, amount);
        assert_ne!(base, pay_to);
        assert_ne!(base, secret);
    }

    #[test]
    fn binding_does_not_collide_when_field_boundaries_shift() {
        let a = compute_binding(
            &SECRET,
            &MemoBinding {
                amount_zat: "1",
                pay_to: "23",
                ..fields()
            },
        )
        .unwrap();
        let b = compute_binding(
            &SECRET,
            &MemoBinding {
                amount_zat: "12",
                pay_to: "3",
                ..fields()
            },
        )
        .unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn parses_what_it_encodes() {
        let memo = encode_memo(&SECRET, &fields()).unwrap();
        let parsed = parse_memo(&memo).unwrap();
        assert_eq!(parsed.invoice_id, INVOICE_ID);
        assert_eq!(parsed.binding, compute_binding(&SECRET, &fields()).unwrap());
    }

    #[test]
    fn rejects_malformed_memos() {
        let zeros = "0".repeat(32);
        for bad in [
            String::new(),
            format!("BYTE1|{INVOICE_ID}"),
            "BYTE1|a|b|c".to_string(),
            format!("BYTE0|{INVOICE_ID}|{zeros}"),
            format!("BYTE1|abc|{zeros}"),
            format!("BYTE1|{INVOICE_ID}|00"),
            format!("BYTE1|{INVOICE_ID}|{}", "z".repeat(32)),
        ] {
            assert!(parse_memo(&bad).is_err(), "should have rejected {bad:?}");
        }
    }

    #[test]
    fn verifies_its_own_memo_and_rejects_others() {
        let memo = encode_memo(&SECRET, &fields()).unwrap();
        assert!(verify_memo(&SECRET, &memo, &fields()));

        // A different secret.
        assert!(!verify_memo(&OTHER_SECRET, &memo, &fields()));
        // Replayed onto a different amount.
        assert!(!verify_memo(
            &SECRET,
            &memo,
            &MemoBinding {
                amount_zat: "999999",
                ..fields()
            }
        ));
        // Replayed onto a different address.
        assert!(!verify_memo(
            &SECRET,
            &memo,
            &MemoBinding {
                pay_to: "utest1other",
                ..fields()
            }
        ));
    }

    #[test]
    fn verification_never_panics_on_arbitrary_input() {
        for junk in ["", "\0", "BYTE1||", &"a".repeat(5000), "💥", "BYTE1|\0|\0"] {
            assert!(!verify_memo(&SECRET, junk, &fields()));
        }
        assert!(!verify_memo(&[0u8; 4], "BYTE1|x|y", &fields()));
    }

    #[test]
    fn memo_bytes_round_trip() {
        let memo = encode_memo(&SECRET, &fields()).unwrap();
        let bytes = to_memo_bytes(&memo).unwrap();
        assert_eq!(bytes.len(), MEMO_SIZE);
        assert!(bytes[71..].iter().all(|&b| b == 0));
        assert_eq!(from_memo_bytes(&bytes).unwrap(), memo);
    }

    #[test]
    fn memo_bytes_round_trip_multibyte_utf8() {
        let text = "BYTE1 ≈ ünïcodé ✓";
        assert_eq!(
            from_memo_bytes(&to_memo_bytes(text).unwrap()).unwrap(),
            text
        );
    }

    #[test]
    fn memo_bytes_reject_oversized_and_wrong_sized_input() {
        assert!(to_memo_bytes(&"x".repeat(MEMO_SIZE + 1)).is_err());
        assert!(to_memo_bytes(&"x".repeat(MEMO_SIZE)).is_ok());
        assert_eq!(
            from_memo_bytes(&[0u8; 100]),
            Err(MemoError::WrongFieldSize(100))
        );
    }

    #[test]
    fn memo_bytes_reject_invalid_utf8() {
        let mut bytes = [0u8; MEMO_SIZE];
        bytes[..3].copy_from_slice(&[0xff, 0xfe, 0xfd]);
        assert_eq!(from_memo_bytes(&bytes), Err(MemoError::NotUtf8));
    }

    #[test]
    fn an_all_zero_field_decodes_as_empty() {
        assert_eq!(from_memo_bytes(&[0u8; MEMO_SIZE]).unwrap(), "");
    }
}
