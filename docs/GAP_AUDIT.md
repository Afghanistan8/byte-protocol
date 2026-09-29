# Gap audit

What Byte Protocol actually has, measured against the F1–F12 feature checklist, on
**29 September 2026**. Nothing below is aspirational: a row says `Done` only when there is
code *and* a passing test behind it, and the test is named.

## How this was measured

```
pnpm vitest run     →  19 files, 368 tests, 368 passed
tsc --build --force →  exit 0, no errors
cargo test          →  56 passed, 0 failed (lib), 0 doc-tests
```

Every `Not feasible yet` row cites the primary source that closed the question. Where a
source disagrees with the brief I followed the source and said so.

---

## Status counts

| Status | Count |
|--------|------:|
| `Done` | 31 |
| `Partial` | 14 |
| `Missing` | 55 |
| `Not feasible yet` | 3 |

---

## F1 — Shielded payments

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Agent-to-agent payments are shielded Ironwood transfers | `Done` | `core/src/pool.ts` `isAcceptedPool`; `server/src/verifier.ts`; `byte-walletd/src/chain.rs` `send` | `server.test.ts` "rejects a payment in the wrong pool"; two real testnet payments in `TESTNET_RUNS.md` | — |
| Refuses to **pay from** transparent or Orchard sources | `Partial` | `wallet/src/mock.ts` `send` throws `wrong_pool_source`; `core/src/errors.ts` defines the reason | `mock.test.ts` | **The real backend does not enforce it.** `propose_standard_transfer_to_address` (signature confirmed on docs.rs for `zcash_client_backend` 0.24.0) has no parameter restricting *source* pools — only `fallback_change_pool`, which governs change. `SpendingWallet.send` documents this as a MUST. |
| One transaction carries both value and memo | `Done` | `chain.rs` `send` passes `Some(memo_bytes)` into a single proposal | `TESTNET_RUNS.md` run 2 | — |
| Document that this removes the two-transaction non-atomicity problem | `Missing` | — | — | Not stated in `SPEC.md` or `SECURITY.md` |
| Document that no "silent failure" trick is needed | `Missing` | — | — | An under-funded Zcash tx cannot be built and leaks no balance; nowhere written down |

## F2 — USD-priced invoices paid in ZEC

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| `priceUsd` on the merchant's invoice | `Missing` | — | — | Everything |
| `PriceSource { getZecUsd(): {price, source, at} }` | `Missing` | — | — | Interface does not exist |
| NEAR Intents price implementation | `Missing` | — | — | **Endpoint verified**: `GET /v0/tokens` returns `price` (number, USD) and `priceUpdatedAt` (date-time) per token |
| A second independent source | `Missing` | — | — | Needs a decision — see the questions below |
| Mock price source for tests | `Missing` | — | — | — |
| `maxPriceAgeSec` guardrail | `Missing` | — | — | — |
| `maxDeviationBps` guardrail between two sources | `Missing` | — | — | — |
| Quote locked into the invoice until `expiresAt` | `Missing` | — | — | `StoredInvoice` has no price fields |
| Payment judged only against `amountZat`, never re-priced | `Done` | `server/src/verifier.ts` compares `settling.valueZat` to `invoice.amountZat` only | `server.test.ts` underpayment cases | — |
| 402 body and receipts carry both USD and ZEC | `Missing` | — | — | `BytePaymentRequirements` and `ReceiptBody` carry zatoshis only |
| README/SPEC state that settlement is in ZEC and who carries price risk | `Missing` | — | — | — |
| Typed `asset` extension point for future ZSAs, marked Planned | `Partial` | `core/src/invoice.ts` `asset: z.literal("ZEC")` | `invoice.test.ts` rejects `"USDC"` | It is a closed literal, not an extension point, and nothing marks ZSAs Planned |

## F3 — Shield / unshield

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| `wallet.shield({ fromTransparent, splitInto?, delayRangeSec? })` | `Missing` | — | — | No method on `SpendingWallet`, no `/shield` route on the sidecar |
| `wallet.unshield({ toTransparent, amountZat })` | `Missing` | — | — | Same |
| ZIP-317 network fee shown in the response, computed not hardcoded | `Partial` | `chain.rs` reads `proposal.steps().last().balance().fee_required()` for `send` | `walletd.test.ts` asserts `feeZat` is returned | No shield/unshield operation exists to report it on |
| Auto-shield transparent receipts, random delay, optional split | `Missing` | — | — | Named in `RAILS.md` as what a rail cannot fix, but never implemented |
| Document that this reduces linkability rather than removing it | `Done` | `RAILS.md` "What a rail cannot fix" | — | — |

## F4 — Fees

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Byte protocol fee = 0 by default | `Done` | No fee output anywhere; `DECISIONS.md` #6 | `grep` finds no treasury address or fee output | — |
| Says "no protocol fee", never "free" | `Done` | `README.md` §Fees | Grep sweep across `*.ts`, `*.rs`, `*.md`, `*.html` | The one remaining "for free" (`README.md:9`) is about information being published at no cost — a different sense, left alone |
| Optional `facilitatorFee: { bps, minZat, payTo }` | `Missing` | — | — | No config, no plumbing |
| Fee added as a second ZIP-321 output | `Missing` | `core/src/zip321.ts` builds single-output URIs **and `parseZip321` rejects the indexed multi-payment form outright** | `zip321.test.ts` | Both the builder and the parser must learn the two-output form |
| Facilitator verifies both outputs before approving | `Missing` | — | — | — |
| Documented as facilitator-enforced, not on-chain | `Missing` | — | — | — |
| Escrow service fee under the same honesty rule | `Missing` | — | — | See F7 |
| Fee statements identical across README, SPEC, API.md, CLI, 402 bodies, code | `Done` | `CONSISTENCY_AUDIT.md` | Grep sweep | — |

## F5 — Off-chain verification

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Per-invoice diversified unified address | `Done` | `byte-walletd/src/keys.rs` cursor; `server/src/issuer.ts` | `keys.rs` "the cursor never repeats an address"; `server.test.ts` two invoices never share an address | — |
| Memo `BYTE1｜invoiceId｜hmac` | `Done` | `core/src/memo.ts`, `byte-walletd/src/memo.rs` | 33 TS + 8 Rust memo tests, pinned cross-language vector | — |
| Verified with a view-only key (UFVK/UIVK) | `Done` | `state.rs` `from_ufvk`; `facilitator.ts` refuses a spending wallet | `state.rs` "a viewing wallet can still mint invoice addresses"; `facilitator.test.ts` | — |
| The verifier sees the exact amount, not a committed minimum | `Done` | `verifier.ts` compares `valueZat` | `server.test.ts` | — |
| Replay protection via atomic `consume` | `Done` | `core/src/store.ts` contract; `stores/src/memory.ts` | `memory.test.ts` concurrency case | — |
| Redis store | `Missing` | — | — | **And four places claim it already ships** — see contradictions |
| Signed Ed25519 receipts | `Done` | `core/src/receipt.ts` | `receipt.test.ts` (15 tests) | — |
| Optional per-transaction disclosure | `Not feasible yet` | — | — | **ZIP 311 "Zcash Payment Disclosures" is `Draft`**; ZIP 303 (Sprout Payment Disclosure) is `Withdrawn`. No finalised standard and no Ironwood implementation to build against. Ship receipts + viewing-key disclosure; mark this Planned with this reason. |
| Incoming-viewing-key disclosure path | `Missing` | `byte-walletd` exposes `GET /viewing-key` returning the **full UFVK** | `walletd.test.ts` | A UFVK is more capability than a disclosure needs; a scoped IVK export is missing |

## F6 — Delegation and spend limits

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Spend guard: per-call cap | `Done` | `client/src/guard.ts` | `guard.test.ts` | — |
| Spend guard: rolling daily cap | `Done` | `guard.ts` `#spentSince` | `guard.test.ts` | — |
| Spend guard: per-host allowlist | `Done` | `guard.ts` `hostOf` | `guard.test.ts` "an allowlist does not imply subdomains" | — |
| Spend guard: approval hook | `Done` | `guard.ts` | `guard.test.ts` "a hook that throws denies" | — |
| **Append-only** audit log | `Partial` | `guard.ts` `#audit`, bounded ring of 1000 | `guard.test.ts` | It is a lossy ring buffer, not append-only, and it does not survive a restart |
| Split build/sign with PCZT | `Missing` | `pczt` is present **transitively only** — no Byte code uses it | — | Feasible: `pczt` 0.9.3 (2026-08-07); librustzcash issue #2524 (unwitnessed Orchard/Ironwood PCZT spends) is **closed**, and records that *"the Signer needs only `alpha`, `rk`, and the sighash"* |
| Threshold custody with FROST | `Not feasible yet` | — | — | See F7 Mode A |
| Never described as "on-chain allowances" | `Done` | — | Grep finds no occurrence of "allowance" anywhere | — |

## F7 — Escrow for agent jobs

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Mode A: shielded 2-of-3 FROST | `Not feasible yet` | — | — | **`ZcashFoundation/frost` ships no Pallas ciphersuite.** Its workspace is `frost-core`, `ed25519`, `ed448`, `p256`, `ristretto255`, `secp256k1`, `secp256k1-tr`, `rerandomized`. `reddsa` 0.6.1 exposes only `batch`, `orchard`, `sapling` and states that *"ZIP-312 re-randomized FROST support will be provided by the frost repository"* — which does not provide it. A "FROST Shielded Multi-Sig SDK" ZCG **grant application** exists, i.e. this is future work. |
| Mode B: transparent 2-of-3 P2SH multisig, labelled non-private | `Missing` | — | — | Everything |
| Job lifecycle state machine | `Missing` | — | — | `created → funded → delivered → released/refunded/disputed → resolved` |
| Timeouts on each state | `Missing` | — | — | — |
| `JobStore` | `Missing` | — | — | — |
| Funding and release are real Zcash transactions | `Missing` | — | — | — |
| Optional escrow fee enforced by the arbiter's co-signing policy | `Missing` | — | — | — |
| Document that buyer + seller can bypass the arbiter and its fee | `Missing` | — | — | — |
| Signed job receipts at each transition | `Missing` | — | — | `receipt.ts` signs payments only |

## F8 — Agent identity and reputation

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Signed Agent Card JSON | `Done` | `registry/src/card.ts` | `card.test.ts` (24 tests) | — |
| Served at `/.well-known/byte-agent.json` | `Partial` | `WELL_KNOWN_PATH = "/.well-known/byte-agent-card"` | `card.test.ts` | Path differs from the brief. Needs a decision, not a guess — see questions |
| Card carries agentId, endpoints, payment UA, schemes, public signing key | `Partial` | `AgentCardBodySchema` | `card.test.ts` | `endpoint` is singular, not a list; the signing key is `issuer` and is present |
| A2A agent-card extension | `Missing` | — | — | The A2A adapter neither publishes nor consumes a card |
| Reputation computed off-chain from signed receipts | `Missing` | — | — | — |
| Signed feedback type | `Missing` | — | — | — |
| Merkle-root anchoring into a self-send memo | `Missing` | — | — | — |
| Document that the anchor is private by default and proves existence-at-time only to disclosees | `Missing` | — | — | — |
| Public OP_RETURN-style anchor | `Missing` | — | — | Needs verification that a transparent public anchor is standard on Zcash today before it is offered at all |

## F9 — NEAR Intents, in and out

### Funding (any asset → shielded ZEC)

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| `GET /tokens` → ZEC assetId | `Done` | `rail-near-intents/src/rail.ts` `zecAssetId` | `rail.test.ts` "resolves the ZEC asset from /tokens rather than hardcoding it" | — |
| `POST /quote` with `EXACT_OUTPUT`, `ORIGIN_CHAIN`, recipient, refundTo, slippage, deadline | `Done` | `rail.ts` `quote` | `rail.test.ts` (10 quoting tests) | — |
| `confidentiality` parameter | `Missing` | — | — | **Correction to the brief**: the OpenAPI enum is `public / basic / advanced` and the default is **`public`**, not `basic`. Byte must send `basic` explicitly or it gets public behaviour. |
| `dry: true` supported | `Partial` | `rail.ts` defaults `dry` to true | `rail.test.ts` "is dry by default" | **Broken against the live API.** The OpenAPI states a dry response *omits* `depositAddress`, `timeWhenInactive` and `deadline` — but `quote()` throws `"1Click returned no deposit address"`. Every mock supplies one, so the tests hide it. |
| `POST /deposit/submit` | `Missing` | — | — | — |
| Poll `GET /status` through every documented state | `Done` | `rail.ts` `status`, `STATUS_MAP` | `rail.test.ts` "covers every status the API documents" | — |
| Auto-shield into Ironwood on `SUCCESS` | `Missing` | — | — | Depends on F3 |
| Recipient is a **fresh** transparent address of the agent's wallet | `Missing` | `recipientTransparentAddress` is a single fixed constructor argument | — | A reused funding address links every funding event to each other |

### Cash out (shielded ZEC → any asset)

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| `POST /quote` with ZEC as `originAsset` | `Missing` | — | — | The entire direction is absent |
| Wallet sends from the shielded pool to `depositAddress` | `Missing` | — | — | — |
| Verify the deposit address format before sending | `Missing` | — | — | — |
| `refundTo` = a fresh transparent ZEC address, refunds auto-shielded | `Missing` | — | — | — |
| Status tracking | `Partial` | `status()` is direction-agnostic | `rail.test.ts` | Reusable as-is |

### Both directions

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Verify quote/status signatures | `Missing` | — | — | **Confirmed real**: the quote response carries a `signature` field, described as the service's signature confirming deposit-address validity. Nothing verifies it. |
| `Authorization: Bearer <JWT>`, 0.25% documented without one | `Done` | `rail.ts` `#headers`; `RAILS.md` §Fees | `rail.test.ts` "sends the JWT when one is configured, and omits it otherwise" | — |
| NEAR Intents fees shown separately from Byte fees | `Partial` | The raw response is carried on the quote | — | No typed breakdown of `refundFee` / `withdrawFee` / `appFees` |
| Mocked fixtures: all statuses, signature pass/fail, refunds | `Partial` | `rail.test.ts` | 24 tests | Signature pass/fail fixtures Missing |
| Live test gated behind `BYTE_RAILS_LIVE=1`, starting dry | `Missing` | — | — | — |
| `SECURITY.md`: transparent leg public; `confidentiality` hides only the Intents-side link | `Partial` | `RAILS.md` and `SECURITY.md` §2.3 cover the transparent leg thoroughly | — | The `confidentiality` caveat is absent because the parameter is |
| Other rails recorded Implemented/Planned with reasons | `Done` | `RAILS.md` | — | — |

## F10 — Framework adapters

Existing adapters: **x402, MCP, A2A/AP2, LangChain**. MPP, AgentKit, ElizaOS, Virtuals GAME
and OpenClaw **do not exist in this repo** — and, to its credit, nothing claims they do. The
brief assumes they are already built.

| Tool | x402 | MCP | A2A/AP2 | LangChain |
|------|------|-----|---------|-----------|
| `byte_pay` | `Done` (`createByteFetch` loop) | `Done` (`createPayingToolCaller`) | `Done` (`flow.ts`) | `Partial` — `byte_fetch_paid`, not a direct pay |
| `byte_invoice` | `Done` (`byteGate`) | `Done` (`gate.ts`) | `Done` (`method.ts`) | `Missing` |
| `byte_balance` | `Missing` | `Missing` | `Missing` | `Done` |
| `byte_receipt` | `Missing` | `Missing` | `Missing` | `Missing` |
| `byte_shield` / `byte_unshield` | `Missing` | `Missing` | `Missing` | `Missing` |
| `byte_fund` / `byte_cashout` | `Missing` | `Missing` | `Missing` | `Missing` |
| `byte_escrow_*` | `Missing` | `Missing` | `Missing` | `Missing` |
| `byte_agent_card` | `Missing` | `Missing` | `Missing` | `Missing` |
| Full-loop test through the mock wallet | `Done` | `Done` | `Done` | `Done` |

## F11 — NU7 readiness

NU7 is scheduled for **testnet 6 October 2026**, final go/no-go **20 October**, mainnet
**5 November 2026**: 25-second blocks (ZIP 218), v4 transactions disabled, NSM.

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Never hardcode block time | `Missing` | `core/src/network.ts:57` `BLOCK_TARGET_SECONDS = 75`; `server/src/verifier.ts:52` `RETRY_AFTER_SECONDS = 75`; `scripts/testnet-e2e.ts:74`; `byte-walletd/src/main.rs:20` | — | **Four hardcoded sites.** The clearest contradiction in the repo. |
| Read block time from consensus params per network and height | `Missing` | — | — | — |
| Derive confirmation timeouts and `Retry-After` from it | `Missing` | `RETRY_AFTER_SECONDS` is a constant | — | — |
| Build v5+ transactions only | `Partial` | `chain.rs` passes `proposed_version: None` | — | The resulting version is asserted nowhere. Ironwood needs v6 (ZIP 229, `Draft`); it needs pinning and a test |
| Test matrix for 75 s vs 25 s spacing | `Missing` | — | — | — |
| NU7 activation heights | `Missing` | `network.ts` carries NU6.3 heights only | — | The mainnet height is not final until the 20 October go/no-go |

## F12 — Owner / UI JSON API

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Invoices | `Partial` | `console/src/api.ts` `GET /invoices`, `GET /invoices/:id` | `console.test.ts` | No USD fields (F2) |
| Receipts | `Done` | `GET /receipts` | `console.test.ts` | — |
| Spend-guard log | `Done` | `GET /guard` | `console.test.ts` | — |
| Balances: shielded spendable / pending / transparent | `Done` | `GET /balance`, `WalletBalance` | `console.test.ts`, `mock.test.ts` | — |
| Rail jobs, both directions | `Missing` | — | — | — |
| Escrow jobs | `Missing` | — | — | — |
| Agent card | `Missing` | — | — | — |
| Price-source health | `Missing` | — | — | — |
| Every route authenticated, constant-time token | `Done` | `api.ts` `authorized` | `console.test.ts` "no route is exempt" | — |

---

## Contradictions found

Eight, ranked by how much damage each does.

### 1. Four places claim a Redis store that does not exist

| File | Claim |
|------|-------|
| `packages/core/src/store.ts:4` | "Byte ships a memory store for tests and development, **and a Redis store** for anything that must survive a restart. **Both** satisfy these interfaces, and **both** are held to the same test suite." |
| `packages/stores/src/memory.ts:5` | "Anything else **should use the Redis store**" |
| `docs/ARCHITECTURE.md:153` | "`stores` — **Memory and Redis** implementations of the store interfaces." |
| `docs/SECURITY.md:146` | "**Use the Redis store** for anything…" |

`README.md:137` and `ROADMAP.md` correctly call it planned. The other four read as shipped.
This is the worst inconsistency in the repo, because the entire positioning is "nothing is
supported until implemented and tested".

### 2. Block time is hardcoded in four places

`BLOCK_TARGET_SECONDS = 75`, `RETRY_AFTER_SECONDS = 75`, and two comments. NU7 makes these
wrong on **6 October** on testnet — a week from now.

### 3. `byte-walletd` does not enforce Ironwood-only funding

`SpendingWallet.send` says implementations **MUST** fund from Ironwood notes only and MUST
throw rather than fall back. The mock obeys. The real backend calls
`propose_standard_transfer_to_address`, whose signature has no source-pool parameter. The
guarantee is documented, tested against the mock, and unenforced where it matters.

### 4. The NEAR rail's default path is broken against the live API

`quote()` defaults to `dry: true`; a dry 1Click response omits `depositAddress`; `quote()`
throws when it is absent. Every test passes because every mock supplies one. The rail has
never been run live, which is precisely why this survived.

### 5. `RAILS.md` implies signature verification that does not exist

> "tested against mocked HTTP … covering all seven documented statuses, **signature of the
> quote request**, and the failure paths"

The test it refers to checks the request *body shape*. No cryptographic signature is
verified anywhere. That sentence would not survive a judge who greps for it.

### 6. Agent card path

`/.well-known/byte-agent-card` in code, `/.well-known/byte-agent.json` in the brief.

### 7. The brief's `confidentiality` default is wrong

The brief says the default is `basic`. The OpenAPI says **`public`**.

### 8. The brief assumes adapters that do not exist

MPP, AgentKit, ElizaOS, Virtuals GAME and OpenClaw are named as existing. Four exist: x402,
MCP, A2A/AP2, LangChain. The repo never claimed otherwise, so this is a brief-vs-repo
mismatch rather than a false claim — but F10's scope is five adapters larger than it reads.

---

## Also worth knowing

- **`@defuse-protocol/one-click-sdk-typescript` is at 0.1.26 (22 September 2026).** Byte
  does not use it; the rail speaks raw HTTP against the OpenAPI document. Worth keeping that
  way — a payment library should not take a dependency it can replace with `fetch`.
- **`pczt` 0.9.3 (7 August 2026)** is already in the dependency tree transitively. No Byte
  code touches it.
- **1Click also exposes `/v0/account/balances` and `/v0/orders`**, which the brief does not
  mention. Neither direction needs them.

---

## Sources checked for this audit

| Fact | Source |
|------|--------|
| 1Click endpoints, `/tokens` price fields, `confidentiality` enum, dry-response omissions, quote `signature` | [1Click OpenAPI v0](https://1click.chaindefuser.com/docs/v0/openapi.yaml) |
| FROST ciphersuites (no Pallas) | [ZcashFoundation/frost Cargo.toml](https://github.com/ZcashFoundation/frost/blob/main/Cargo.toml) |
| `reddsa` has no FROST module | [docs.rs/reddsa 0.6.1](https://docs.rs/reddsa/latest/reddsa/) |
| ZIP 311 Payment Disclosures is `Draft`; ZIP 303 `Withdrawn` | [zips.z.cash index](https://zips.z.cash/) |
| Unwitnessed Ironwood PCZT spends | [librustzcash#2524](https://github.com/zcash/librustzcash/issues/2524) |
| `propose_standard_transfer_to_address` signature | [docs.rs zcash_client_backend 0.24.0](https://docs.rs/zcash_client_backend/0.24.0/zcash_client_backend/data_api/wallet/fn.propose_standard_transfer_to_address.html) |
| `pczt` versions | [crates.io/crates/pczt](https://crates.io/crates/pczt) |
| 1Click TS SDK version | [npm registry](https://www.npmjs.com/package/@defuse-protocol/one-click-sdk-typescript) |
| NU7 dates and ZIP 218 | [crypto.news, September 2026](https://crypto.news/zcash-targets-nov-5-for-nu7-mainnet-upgrade/) |
