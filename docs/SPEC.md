# Byte Protocol — `byte-zcash-shielded-v1`

Normative specification. The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to
be interpreted as in RFC 2119.

Every fact this specification depends on is sourced in [TOOLCHAIN.md](TOOLCHAIN.md).
Where behaviour is described here, it is implemented and tested; anything not implemented
is marked **Planned** and is not described as though it works.

Status: **draft**, tracking implementation. Version `0.1.0-draft`.

---

## 1. What this is

Byte settles payments between software agents in **shielded Zcash**, in the **Ironwood**
pool, so that the amount, the balance and the payment graph stay off the public ledger.
An observer of the chain learns that a shielded transaction occurred. They do not learn
the amount, either party's shielded address, or any balance.

Byte is not a chain, a contract or a token. Zcash has no smart contracts, and Byte invents
none. Its guarantees come from two places only:

1. **Shielded Ironwood transactions**, which hide value and participants.
2. **Viewing keys and encrypted memos**, which let a recipient — or a view-only
   facilitator acting for them — prove to themselves that a specific invoice was paid,
   without anything being published.

Identity, where a protocol needs it, is published deliberately in a signed Agent Card
(§9). It is never leaked by the settlement layer.

---

## 2. Networks

Byte identifies networks in the CAIP-2 shape `namespace:reference` required by x402 v2.

| Network | Identifier |
|---------|-----------|
| Zcash mainnet | `zcash:00040fe8ec8471911baa1db1266ea15d` |
| Zcash testnet | `zcash:05a60a92d99d85997cce3b87616c089f` |

**`zcash` is not a registered CAIP-2 namespace.** BIP-122 explicitly excluded Zcash and no
namespace has been registered since. Rather than invent an identifier with no provenance,
Byte follows the convention already established inside the x402 repository by
`scheme_exact_lnbtc.md`, which identifies Lightning networks as `lnbtc:` followed by the
first 32 lowercase hexadecimal characters of the genesis block hash. The references above
are the first 32 characters of the Zcash mainnet and testnet genesis block hashes as
asserted in `chainparams.cpp`.

Implementations MUST treat the network identifier as an opaque string and MUST reject a
payment whose network does not exactly match the invoice's.

v1 implements **testnet only**. Mainnet identifiers are specified so the constant is not
invented later, but no mainnet path is tested and none is claimed.

---

## 3. The pool

Byte MUST create and accept **Ironwood** outputs only.

There is no Ironwood receiver type in unified addresses. The ZIP 316 typecode registry
ends at Orchard (`0x03`); Ironwood reuses Orchard receivers and viewing keys, and is
modelled as a distinct *pool* (`zcash_protocol::ShieldedPool::Ironwood`). Consequently:

- `payTo` MUST be a unified address containing an **Orchard-typecode receiver**, and MUST
  NOT contain a transparent receiver. After NU6.3 activation, value sent to such a
  receiver lands in the Ironwood pool.
- A verifier MUST NOT infer the pool from the address. It MUST check the pool of the
  **received note** and MUST require it to be `Ironwood`.
- A payer MUST NOT fund a Byte payment from a transparent source or from the sealed
  Orchard pool. If its wallet would have to, it MUST fail with `wrong_pool_source` and
  MUST NOT silently fall back. Crossing pools reveals the net amount on-chain (ZIP 318),
  which would defeat the guarantee Byte exists to provide.

---

## 4. Roles

| Role | Holds | Can |
|------|-------|-----|
| **Payer** | A spending key | Send Ironwood payments, enforce its own spend guard |
| **Payee** | A UFVK or UIVK | Mint invoices, verify payments, serve the resource |
| **Facilitator** | A UIVK or UFVK, delegated | Verify on a payee's behalf. **View-only: cannot spend.** |

A facilitator is a convenience, not a dependency. A payee that verifies for itself needs
no facilitator and discloses nothing to anyone.

---

## 5. Flow

```
  Payer                                             Payee
    │                                                 │
    │  1. GET /resource                               │
    │────────────────────────────────────────────────▶│
    │                                                 │ mint invoice:
    │                                                 │  fresh diversified UA
    │  2. 402 + PAYMENT-REQUIRED                      │  + memo binding
    │◀────────────────────────────────────────────────│
    │                                                 │
    │  3. spend guard, then shielded Ironwood tx      │
    │     to payTo, carrying the memo                 │
    │             ╌╌╌╌╌╌ Zcash ╌╌╌╌╌╌▶                │
    │                                                 │
    │  4. GET /resource + PAYMENT-SIGNATURE           │
    │────────────────────────────────────────────────▶│
    │                                                 │ 5. verify with
    │                                                 │    view-only key
    │  6. 200 + resource (+ signed receipt)           │
    │◀────────────────────────────────────────────────│
```

### 5.1 Invoice

On an unpaid request the payee MUST respond `402` carrying payment requirements. Each
invoice MUST bind to exactly one freshly derived address.

| Field | Type | Notes |
|-------|------|-------|
| `scheme` | string | `"byte-zcash-shielded-v1"` |
| `network` | string | §2 |
| `amount` | string | Zatoshis, integer, base 10. A string, because zatoshi amounts exceed the safe integer range of some JSON parsers. |
| `asset` | string | `"ZEC"` |
| `payTo` | string | A **fresh diversified unified address**, Orchard receiver only, minted for this invoice and no other |
| `invoiceId` | string | 128 bits of cryptographic randomness, 32 lowercase hex characters |
| `expiresAt` | string | RFC 3339 UTC |
| `minConfirmations` | number | Integer ≥ 0. See §7. |
| `memo` | string | The exact memo the payer MUST attach (§6) |
| `zip321` | string | A ZIP-321 URI encoding the same payment |
| `facilitator` | string? | Optional URL |

`payTo` MUST be derived from a fresh ZIP 32 diversifier per invoice. Two invoices MUST NOT
share an address. This is what makes invoices unlinkable to each other on-chain, and it is
why Byte mints rather than reuses.

### 5.2 Payment

The payer MUST evaluate its spend guard (§10) before constructing anything. If the guard
denies, no transaction is built.

The payer then sends a shielded Ironwood transaction paying at least `amount` to `payTo`,
carrying exactly the memo from §6.

### 5.3 Claim

The payer retries the original request with a payload carrying
`{ scheme, network, invoiceId, txid }`, serialized as JSON and encoded base64.

### 5.4 Invoices priced in USD

A payee MAY denominate an invoice in USD and settle it in ZEC. There is no shielded
stablecoin on Zcash and ZSAs are not on mainnet, so **settlement is always in ZEC**.

The payee converts once, at issue time, and locks the result into the invoice:

```
price: { priceUsd, zecUsd, priceSource, quotedAt }
```

- `priceUsd` is a decimal string with at most two places. Never a float.
- The conversion MUST round **up**. Rounding down would leave the payee short on every
  invoice, always in the payer's favour.
- A payee MUST refuse to issue if its price is stale (`maxPriceAgeSec`) or if two configured
  sources disagree by more than `maxDeviationBps`. It MUST NOT average them or pick the
  cheaper: two independent sources disagreeing means something is wrong, and quoting from
  the middle of a contradiction is worse than not quoting.
- The `price` block is informational to a verifier. **A payment is judged against `amount`
  alone and is never re-priced.** Re-pricing at verification would let the market move
  between a payer committing to an amount and the payee deciding it was insufficient, for a
  transaction that can no longer be changed.

The consequence is stated, not hidden: **the payer and the payee both carry price risk
between the moment the quote is locked and the moment the ZEC is cashed out.** Byte does not
hedge it. A short invoice lifetime is the lever.

The `asset` field is `ZEC` and only `ZEC`. A future ZSA asset identifier is **Planned** and
depends on ZSAs reaching mainnet; nothing accepts one today.

### 5.5 Outputs, and the facilitator fee

Byte's protocol fee is **zero**: no output pays Byte and there is no treasury address. The
Zcash network fee still applies and goes to miners.

A facilitator MAY charge its own fee. If it does, the invoice carries a second output:

```
fee: { amount, payTo, bps }
```

encoded in the same ZIP-321 request using the indexed multi-payment form (`address.1`,
`amount.1`; index 0 carries no suffix and `.0` is invalid). Then:

- The payer MUST pay every output in **one transaction**, and its spend guard MUST authorize
  the **total**, fee included.
- The fee leg carries no memo. It binds to no invoice, and a memo there would be a second
  place an invoice identifier could reach a third party.
- The facilitator MUST verify the fee output arrived, in the same transaction, before
  approving. A payment that settled the payee but skipped the fee is refused as
  `underpaid` and MUST NOT consume the invoice.
- The fee MUST be rounded up, and an amount of zero means no second output.

**The fee is enforced by the facilitator's verification, not by the chain.** Nothing on-chain
requires the second output to exist. A payer that pays the payee directly and asks the payee
to verify skips the fee. That is a consequence of Zcash having no contracts, not a gap.

### 5.6 One transaction

Value and memo travel in a single shielded transaction. There is therefore no window in
which value has moved but the payee cannot tell which invoice it settles, or the reverse;
a design that carries the identifying data in a second transaction has that window, and a
failure between the two strands the payment.

No "silent failure" mechanism is needed to hide an insufficient balance. A Zcash transaction
that cannot be funded cannot be built, so nothing is broadcast and nothing about the balance
appears on-chain. The payer learns it locally, as `insufficient_funds`.

---

## 6. Memo

Memos are fixed at **512 bytes**, null-padded, serialized per ZIP 302. Byte uses a UTF-8
text memo:

```
BYTE1|<invoiceId>|<binding>
```

| Part | Value |
|------|-------|
| `BYTE1` | Literal version tag |
| `invoiceId` | 32 lowercase hex characters |
| `binding` | `HMAC-SHA256(serverSecret, invoiceId ‖ amount ‖ payTo)`, truncated to 16 bytes, as 32 lowercase hex characters |

The encoded memo is 71 bytes, comfortably inside the 512-byte limit.

The binding exists so that a payee can confirm an invoice is one **it** issued, using only
its own secret, without a lookup. `serverSecret` MUST be at least 32 bytes, MUST come from
the environment, and MUST NOT be logged. Comparison of `binding` MUST be timing-safe.

A verifier MUST reject a memo that does not parse, whose version tag is not `BYTE1`, or
whose binding does not match. Malformed memos MUST NOT crash a verifier; the codec is
round-trip tested against malformed, truncated, over-long and non-UTF-8 input.

---

## 7. Verification

A payee or facilitator MUST establish **all** of the following before serving. Failing any
one produces the matching failure in §8.

1. The transaction decrypts to the payee's viewing key.
2. It contains an output to `payTo` **in the Ironwood pool**.
3. That output's value is **≥ `amount`**.
4. The memo parses and its binding matches the invoice (§6).
5. Confirmations **≥ `minConfirmations`**.
6. The invoice has not expired.
7. The invoice has not already been consumed.

Then, atomically, the verifier MUST mark the invoice consumed **before** serving the
resource. Check-then-serve without an atomic consume is a replay hole; the invoice store
interface exists to make the atomic step explicit.

`minConfirmations: 0` is permitted only when explicitly configured. At zero confirmations
a payment can be reorged away after the resource has been served. Byte does not prevent
this and does not pretend to; it is the operator's risk to take. `minConfirmations: 1`
costs roughly one block in latency: 75 seconds before NU7, 25 after.

A payee MUST derive the `Retry-After` it reports from the network and height it is
actually on, not from a fixed number. Block spacing is a consensus parameter and
ZIP 218 changes it.

A verifier's acceptance is **not** a consensus judgement. librustzcash states plainly that
its APIs do not check consensus validity; final validity comes from a node. Byte repeats
that rather than implying otherwise.

---

## 8. Failure behaviour

Implemented exactly as described here, and described identically everywhere else.

| Condition | Response | `reason` | Also |
|-----------|----------|----------|------|
| Paid less than `amount` | `402` | `underpaid` | Remaining amount in zatoshis |
| Paid more than `amount` | `200` | — | Accepted. Surplus is **not** refunded, automatically or otherwise. |
| Invoice expired | `402` | `expired` | A fresh invoice |
| Transaction not yet seen or too few confirmations | `402` | `pending` | `Retry-After` |
| Invoice already consumed | `409` | `replay` | — |
| Wrong pool, wrong address, or bad memo binding | `402` | `invalid_payment` | — |
| Payer's wallet would have to spend from transparent or Orchard | *client-side error* | `wrong_pool_source` | No transaction is built |

Overpayment being unrefunded is a deliberate choice, not an oversight: refunding would
require the payee to send value back to a payer it cannot identify without asking, and
asking would create exactly the identity linkage Byte avoids.

---

## 9. Receipts and Agent Cards

A payee MAY return a **receipt**: an Ed25519 signature over the canonical serialization of
`{ invoiceId, txid, amount, payTo, network, timestamp }`.

Receipts are the unit of **selective disclosure**. Nothing is disclosed by default. A
payee that must satisfy an auditor can hand over specific receipts, or an incoming-viewing
key scoped to what the auditor is entitled to see — rather than opening its whole payment
history.

An **Agent Card** is a signed document declaring an agent's ID, endpoint, a
Byte-accepting unified address and its supported schemes. Identity is public here because
the agent chose to publish it, and the chain links no payment to it.

---

## 10. Spend guard

Payer-side, enforced before a transaction is constructed:

| Control | Behaviour |
|---------|-----------|
| Per-call cap | Deny if `amount` exceeds it |
| Daily cap | Deny if the rolling 24-hour total would exceed it |
| Host allowlist | Deny if the resource host is not listed |
| Approval hook | Optional callback that must approve before spending |
| Audit log | Every decision recorded, allowed and denied alike |

The guard denies by default when a control is configured and unsatisfiable. A denied
payment MUST NOT produce a transaction.

---

## 11. x402 v2 mapping

x402 v2 separates `scheme` from `network`, and its existing non-EVM schemes carry
chain-specific data in `extra`. Byte's x402 adapter follows that structure rather than
inventing a parallel one:

| x402 field | Byte value |
|------------|-----------|
| `scheme` | `"exact"` |
| `network` | §2 |
| `amount` | Zatoshis as a decimal string |
| `asset` | `"ZEC"` |
| `payTo` | The invoice's diversified unified address |
| `maxTimeoutSeconds` | Derived from `expiresAt` |
| `extra` | `{ byteScheme, invoiceId, memo, zip321, minConfirmations }` |

Headers are x402 v2's: `PAYMENT-REQUIRED` on the 402 response, `PAYMENT-SIGNATURE` on the
retry, both base64-encoded JSON, with `x402Version: 2`. The v1 names `X-PAYMENT` and
`X-PAYMENT-RESPONSE` are not used.

`SettlementResponse.payer` is **omitted**. Byte payments have no payer identity to report,
by design — the same position the Lightning scheme takes for the same reason.

`byte-zcash-shielded-v1` remains Byte's native scheme identifier outside x402, where
Agent Cards, MCP and A2A refer to the payment method by name.

There is currently no Zcash scheme specification in the x402 repository.

---

## 12. What is not hidden

Stated here as well as in [SECURITY.md](SECURITY.md), because a specification that
describes only its guarantees and not their edges is misleading.

- That a shielded transaction occurred, and when.
- Any transparent leg. Funding rails that use transparent addresses — including **every
  NEAR Intents deposit and withdrawal**, which is `t1`/`t3` only — are public until
  shielded, and the shielding amount is visible.
- Net value crossing between pools (ZIP 318).
- Whatever an agent publishes about itself in its Agent Card.
- Network metadata: the link between an IP and a lightwalletd or Zaino endpoint, unless
  the operator runs their own node or uses Tor.
- Everything a viewing-key holder can see. Delegating verification to a facilitator
  discloses that payee's payment details to it.
