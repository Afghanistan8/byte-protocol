# Security and privacy

What Byte hides, what it does not, and what you are trusting when you use it.

This document is deliberately unflattering. A privacy system described only by its
guarantees is a privacy system that will surprise someone, and the surprise is always
worse than the limitation.

---

## 1. What is hidden

Inside the **Ironwood** shielded pool, an observer of the Zcash chain does not learn:

- **the amount** of a Byte payment
- **the sender's shielded address**
- **the recipient's shielded address**
- **either party's balance**
- **the memo**, which is encrypted to the recipient

Because each invoice is paid to a **fresh diversified unified address**, two payments to
the same merchant are not linkable to each other through the address they were paid to.

This is stronger than a system that hides amounts but publishes addresses. Ironwood hides
the participants as well, so there is no on-chain payment graph to analyse.

---

## 2. What is not hidden

### 2.1 That a shielded transaction happened, and when

The existence and timing of a shielded transaction are public. An observer who knows that
an agent is the only user of some service can still learn *that it transacted* at a given
moment. Traffic analysis against timing is not defeated by Byte.

### 2.2 Anything that crosses pools

ZIP 318 is explicit: *"The net amount crossing between the pools is revealed on-chain."*

Byte therefore refuses to cross pools. A payer whose wallet would have to fund a payment
from a transparent source or from the sealed Orchard pool fails with `wrong_pool_source`
and builds nothing, and change is directed back into Ironwood. This is enforced in code,
not left to configuration:

- `packages/core/src/pool.ts` — `isAcceptedPool`, `isSpendablePool`
- `crates/byte-walletd/src/chain.rs` — `fallback_change_pool: ShieldedPool::Ironwood`

### 2.3 Every transparent funding rail

**This is Byte's largest and least reducible leak.**

NEAR Intents supports ZEC at *"Transparent addresses only"* — `t1` or `t3`. Every deposit
and every withdrawal on that rail is a public, transparent Zcash transaction. The amount,
the address and the timing are all on the public chain, and shielding the proceeds
afterwards makes the *shielding amount* visible too.

Byte does not present this as private, and the rail ships in dry-run only. See
[RAILS.md](RAILS.md). If your threat model cannot tolerate a public funding leg, fund the
wallet with shielded ZEC and do not use a transparent rail at all.

### 2.4 Whatever an agent publishes about itself

A Byte Agent Card is a public document: agent ID, endpoint, a unified address, supported
schemes. That is deliberate — protocols need attributable identity — but it means the
*address* in a card is public and reusable, and payments to the address in a card are
linkable to that identity. Invoice addresses are freshly diversified precisely so that the
settlement layer does not inherit this.

### 2.5 Network metadata

Byte's wallet sidecar talks to a light server over the lightwalletd protocol. That server
sees your IP, and sees which blocks and transactions you ask about. It does not see your
keys and cannot spend, but query patterns are metadata.

Mitigate by running your own Zebra plus Zaino, or by routing through Tor. Byte does
neither for you, and the default configuration points at a third-party public endpoint.

### 2.6 Whatever a viewing key holder can see

A UFVK sees incoming and outgoing activity for its account. Handing one to a facilitator
is a real disclosure — see §4.

---

## 3. Threat model

### 3.1 What Byte defends against

| Adversary | Outcome |
|-----------|---------|
| A chain observer | Learns that shielded transactions occurred. Learns no amount, party or balance. |
| A competitor analysing a merchant's revenue on-chain | Learns nothing. There is no public amount to sum. |
| A party replaying a captured payment claim | Rejected. Invoices are consumed atomically; a second claim gets `409`. |
| A party forging a memo for an invoice it was not issued | Rejected. The memo binding is an HMAC under a secret only the payee holds. |
| A compromised facilitator | Cannot spend. It holds a viewing key only. |

### 3.2 What Byte does not defend against

| Adversary | Outcome |
|-----------|---------|
| An observer correlating timing between a request and a shielded transaction | Not defeated. |
| Anyone watching a transparent funding rail | Sees the whole transparent leg. |
| The light server | Sees query patterns and your IP. |
| A party holding your UFVK | Sees your payment history. |
| An attacker with your seed | Owns the funds. There is no recovery. |
| A malicious payee | Can take payment and not serve. Byte is not an escrow. |

---

## 4. Trust assumptions

**The facilitator is view-only, and that is enforced by type, not by policy.**
`ViewOnlyWallet` has no `send`; `SpendingWallet` extends it. A facilitator handed a
view-only wallet cannot move funds even if fully compromised. In the sidecar, a process
configured with `BYTE_WALLETD_UFVK` holds no seed at all, and the configuration refuses to
accept both a seed and a UFVK so that spend capability cannot be granted by accident.

**But a facilitator still learns payment details** for merchants that delegate verification
to it: invoice amounts, transaction identifiers, and timing. Delegating verification is a
privacy trade, not a free convenience. A payee that verifies for itself discloses nothing
to anyone.

---

## 5. Known limitations

### 5.1 Confirmation latency and zero-confirmation risk

The Zcash block target is 75 seconds today (ZIP 208) and 25 seconds from NU7 onwards
(ZIP 218). `minConfirmations: 1` costs roughly one block either way. Byte reads the
spacing from the network and height rather than assuming one — see
`blockTargetSeconds` in `packages/core/src/network.ts` — because testnet activates NU7
a month before mainnet, so for that month the two chains genuinely differ.

`minConfirmations: 0` is permitted only when explicitly configured. At zero confirmations a
payment can be reorged away *after* the resource has been served. Byte does not prevent
this and does not pretend to; it is the operator's risk to accept. The mock wallet models
reorg drops specifically so that this path is testable rather than theoretical.

### 5.2 Overpayment is not refunded

An overpaid invoice is accepted and the surplus is kept. Refunding would require sending
value back to a payer Byte deliberately cannot identify, and identifying them would create
the linkage Byte exists to avoid.

### 5.3 In-memory stores do not survive a restart

The memory invoice store loses consumed-invoice records on restart, which re-opens the
replay window for any invoice still within its expiry.

Byte does **not** currently ship a durable store, so this is a live limitation rather than
a configuration mistake: run a single process, keep invoice TTLs short, and treat a restart
as re-opening the replay window for every invoice still inside its expiry. A durable store
is Planned — see docs/ROADMAP.md.

### 5.4 Byte's verification is not a consensus judgement

librustzcash states plainly that its APIs do not check consensus validity; only a node can
say that. Byte establishes that a note was received, in which pool, for how much, carrying
which memo. It does not establish that a transaction is valid under consensus. An operator
who needs that guarantee should run their own node.

### 5.5 Ironwood-era tooling is young

[librustzcash#2617](https://github.com/zcash/librustzcash/issues/2617) records that the
shared shielded-pool test suite has **never been run with Ironwood as the active pool**.
Rewind and reorg behaviour, birthday handling, spendability windows, send-to-self and
change handling, and multi-step proposals are all untested for Ironwood *as a source pool*.

**Byte spends from Ironwood.** This is a real risk in a dependency, it is not something
Byte can fix, and it is recorded rather than hidden.

### 5.6 The address is bound by the memo, not read from the note

`WalletRead::get_received_outputs` reports an output's pool and value but not the address
it arrived at. Byte therefore establishes the intended destination through the memo
binding, which commits to `invoiceId ‖ amount ‖ payTo` under the payee's secret, rather
than by comparing the note's diversified address.

The consequence: a payer could pay a *different* address belonging to the same payee while
presenting a memo that binds to the invoice. The funds still arrive at the payee, for the
same amount, and the invoice is still consumed exactly once — so the economic outcome is
unchanged — but the payment is not bound to the specific diversified address in the way
reading the note's address would give. This is documented rather than glossed.

---

## 6. Implemented mitigations

| Mitigation | Where |
|------------|-------|
| Fresh diversified address per invoice, never reused | `keys.rs` `DiversifierCursor`; asserted over 200 and 500 successive addresses |
| Invoice expiry | `core/src/invoice.ts` `isExpired` |
| Atomic consume before serving | `InvoiceStore::consume` — the contract requires a single atomic test-and-set |
| Timing-safe comparison of memo bindings and API tokens | `bytes.ts` `timingSafeEqual`; `subtle::ConstantTimeEq` in Rust |
| Memo secrets required to be at least 32 bytes | `memo.ts`, `memo.rs` — enforced, not documented |
| Domain-separated canonical encodings | Receipts and memo bindings; field separators prevent boundary-shift collisions |
| Key material never printed | `SecretBox` with hand-written `Debug` impls, with a test asserting redaction |
| Secrets from the environment only | Command-line arguments are visible in `ps` and shell history |
| Loopback bind by default, plus a bearer token | Loopback is not an authorisation boundary; any local process can reach `127.0.0.1` |
| Request body size limit | 64 KiB on the sidecar API |
| Refusal to report chain facts while unsynced | An unsynced `0` balance is indistinguishable from an empty wallet |

---

## 7. Reporting a vulnerability

Open a security advisory on the repository rather than a public issue.

This is hackathon-stage software built against alpha- and beta-era Ironwood tooling. It has
not been audited. Do not put mainnet funds behind it.
