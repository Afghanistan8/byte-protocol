# Architecture

How Byte is put together, and why the seams are where they are.

---

## The shape

```
  ┌─────────────────────────────────────────────────────────────┐
  │  Adapters      x402 · MCP · A2A/AP2 · LangChain             │
  │                translate a framework's payment step into    │
  │                Byte's invoice → pay → verify loop           │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌───────────────┬───────────┴───────────┬─────────────────────┐
  │   client      │        server         │    facilitator      │
  │  BytePayer    │      byteGate()       │   view-only verify  │
  │  SpendGuard   │   issue + verify      │   on a payee's      │
  │               │                       │   behalf            │
  └───────┬───────┴───────────┬───────────┴──────────┬──────────┘
          │                   │                      │
          │            ┌──────┴──────┐               │
          │            │   stores    │               │
          │            │memory·sqlite│               │
          │            └─────────────┘               │
          │                                          │
  ┌───────┴──────────────────────────────────────────┴──────────┐
  │                          core                               │
  │  scheme types · memo codec · ZIP-321 · receipts · amounts   │
  │  pools · errors · store interfaces                          │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌───────────────────────────┴─────────────────────────────────┐
  │                        wallet                               │
  │   ViewOnlyWallet  ──extends──▶  SpendingWallet              │
  │   backends: byte-walletd (real) · mock (deterministic)      │
  └───────────────────────────┬─────────────────────────────────┘
                              │ localhost JSON
  ┌───────────────────────────┴─────────────────────────────────┐
  │                 byte-walletd  (Rust)                        │
  │  librustzcash: diversified addresses · Ironwood send        │
  │  view-only verify · sync over lightwalletd                  │
  └───────────────────────────┬─────────────────────────────────┘
                              │ lightwalletd protocol
                     ╌╌╌╌╌╌╌╌╌┴╌╌╌╌╌╌╌╌╌
                        Zcash (Ironwood)
```

---

## Why there is a Rust sidecar

Everything Byte does that touches the chain — deriving diversified addresses, decrypting
notes, building and proving a shielded transaction — lives in librustzcash. There is no
equivalent in TypeScript, and reimplementing note decryption or proof construction would be
both enormous and a bad idea.

So `byte-walletd` is a thin process that exposes exactly the operations Byte needs over a
localhost JSON API, and the TypeScript side calls it. It is not a general-purpose wallet
and does not try to be: mint an address, read outputs by transaction, send with a memo,
report balance and sync state.

The alternative considered and rejected was Zallet's JSON-RPC
([DECISIONS.md](DECISIONS.md) #1). It would have been less code, but
[zallet#695](https://github.com/zcash/zallet/issues/695) breaks memo lookup on unspent
Ironwood notes — which is precisely Byte's verification path.

---

## The seams that matter

### View-only is a type, not a promise

```
ViewOnlyWallet          mint addresses, read outputs, report balance
   └── SpendingWallet   ...and send
```

A facilitator is handed a `ViewOnlyWallet`. There is no `send` on it, so a compromised
facilitator cannot move funds — and that is checked by the compiler rather than asserted in
a README. The same split exists in the sidecar: a process configured with
`BYTE_WALLETD_UFVK` holds no seed at all, and the configuration refuses to accept both a
seed and a UFVK so spend capability cannot be granted by setting one variable too many.

### The pool check lives on the note, not the address

There is no Ironwood receiver type. The ZIP 316 registry ends at Orchard `0x03`, and
Ironwood reuses Orchard receivers and viewing keys. An address therefore *cannot* express
which pool a payment will land in.

So invoices mint an address with an Orchard-typecode receiver and no transparent receiver,
and the verifier reads `ShieldedPool::Ironwood` off the **received note**. This is the one
structural consequence of the Ironwood migration that shapes the whole design, and it is
why `Pool` lives in `core` rather than in the wallet package: it is protocol vocabulary,
not a wallet detail.

### The memo binds what the note cannot

`get_received_outputs` is keyed by transaction and reports pool and value, but not the
address an output arrived at. Byte binds the destination through the memo instead: an HMAC
over `invoiceId ‖ amount ‖ payTo` under a secret only the payee holds.

That gives the payee a check it can make from its own secret, with no database lookup, and
it stops a third party minting memos a payee's verifier would accept. The trade-off is
recorded in [SECURITY.md](SECURITY.md) §5.6.

### Atomic consume is the replay defence

`InvoiceStore::consume` is contractually a single atomic test-and-set, and it must happen
*before* the resource is served. Check-then-serve leaves a window in which two concurrent
requests both observe an unconsumed invoice and both get served for one payment. The
interface exists to make that step impossible to skip by accident.

### One wallet contract, two backends

`WalletdWallet` talks to the sidecar over its localhost JSON API; `MockWallet` is
deterministic and in-process. Nothing above the wallet package knows which it has — the
issuer, the verifier, the payer and every adapter are written once and run against either.

That is not an abstraction for its own sake. It is what lets the whole protocol be tested
exhaustively against a mock that models reorgs and wrong-pool payments, and then run
unchanged against a chain that does those things for real.

The view-only split survives the HTTP boundary too: `connectWalletd` asks the sidecar whether
it holds a spending key and returns a wallet with no `send` when it does not, stripping the
method rather than merely typing it away.

### The memo codec exists twice, on purpose

TypeScript builds memos; Rust reads them back off the chain. Two implementations of one
format is a liability unless something holds them together, so both pin the same vector:

```
BYTE1|0123456789abcdef0123456789abcdef|83277bce2698d03296873534c777da14
```

Drift fails a test suite immediately, rather than surfacing later as every payment
mysteriously failing verification.

---

## Packages

| Package | Responsibility |
|---------|----------------|
| `core` | Scheme constants, memo codec, ZIP-321, receipts, amounts, pools, errors, store interfaces. No network, no wallet. |
| `wallet` | The wallet contract, the `byte-walletd` backend, and a deterministic mock. |
| `client` | `createByteFetch`, `BytePayer`, the spend guard. |
| `server` | `byteGate()`, invoice issuance, verification. |
| `facilitator` | View-only verification as a service. |
| `registry` | Agent Cards: schema, signing, resolution. |
| `stores` | The store interfaces implemented twice: in-memory, and durable on SQLite. One contract suite covers both. |
| `adapters/*` | One per framework. Each proves a full pay → verify → serve loop against the mock. |
| `rails/*` | Funding paths. Funds always end up shielded in Ironwood. |
| `crates/byte-walletd` | The Rust sidecar. |

---

## Testing strategy

Everything downstream of `wallet` tests against the **mock**, which is deterministic —
transaction identifiers derive from a counter and the payment fields, so a failing test
reproduces exactly.

The mock deliberately models the failure modes, not just the happy path: payments in the
wrong pool, short payments, missing memos, notes that are seen but unmined, and
transactions dropped by a reorg. A mock that only does the happy path lets every downstream
package ship a verifier that has never once said no.

Tests resolve workspace packages to **source**, not built output, so a change in `core` is
immediately visible to `wallet`. The build is verified separately.

The testnet end-to-end path is gated behind `BYTE_TESTNET=1` and a funded wallet. It spends
real TAZ, so it never runs unattended.
