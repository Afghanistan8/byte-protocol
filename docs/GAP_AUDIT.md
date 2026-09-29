# Gap audit

What Byte Protocol has, measured against the F1–F12 feature checklist and the defects an
independent review found in `main` at `9f5fc87`. A row says `Done` only when there is code
**and** a passing test behind it, and the test is named. Anything else says what is missing.

Last updated 29 September 2026, after the Part A repairs. Part B rows are still open and say
so.

## How this was measured

Real numbers come from `docs/STATS.json`, written by `pnpm stats` from live runs of both
suites. Nothing in this file is a count somebody typed.

```
pnpm test        →  all TypeScript suites passing (see docs/STATS.json)
tsc --build      →  clean
cargo test --lib →  all byte-walletd tests passing (see docs/STATS.json)
```

`Not feasible yet` rows cite the primary source that closed the question. Where a source
disagreed with a brief, I followed the source and said so.

## Status counts

<!--gap-counts-->
| Status | Count |
|--------|------:|
| `Done` | 74 |
| `Partial` | 12 |
| `Missing` | 55 |
| `Not feasible yet` | 4 |
| **Total sub-items** | **145** |
<!--/gap-counts-->

---

## Part A: defects from the independent review

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| **A1** A fee invoice could not be paid by Byte's own client | `Done` | `wallet/src/types.ts` `SendRequest` (union) and `sendOutputs`; `client/src/payer.ts` pays every output and guards the total; `byte-walletd` `send_to` builds one `zip321::TransactionRequest` via `propose_transfer` with `SpendPolicy::shielded_pools([Ironwood])` | `client/src/fee-loop.test.ts` (7, over real HTTP); `server/src/fee.test.ts` now pays through `BytePayer`; `walletd.test.ts` "sends several outputs as one transaction" | **A real testnet payment carrying a fee has not been run.** Needs Asuzu (funds). Not yet in `TESTNET_RUNS.md` |
| **A1b** `ByteFacilitator` could not charge the fee at all (found during A8) | `Done` | `facilitator/src/facilitator.ts` takes `fee` and `feeWallet`, publishes terms in `info().fee`, refuses a fee without a `feeWallet` and a spendable `feeWallet` | `facilitator.test.ts` "a facilitator that charges a fee" (7) | — |
| **A2** Testnet already computed post-NU7 25 s block times | `Done` | `core/src/network.ts` `blockTargetSeconds(branchId)`; `byte-walletd` `/status` reports `consensusBranchId` from `GetLightdInfo` | `core/src/network.test.ts` (13); `server.test.ts` "Retry-After follows the chain's consensus branch" (3), including testnet height 4,414,380 → 75 s | **NU7 branch `0x77190AD9` (ZIP 259, Draft) is not yet observable on a live chain**, and both activation heights are `TBD` in ZIP 259. Recorded in `TOOLCHAIN.md` |
| **A3** Dashboard claimed a PCZT spend path that does not exist | `Done` | `apps/site/app/index.html`, `apps/site/README.md`: claims removed, snap described as read-only | Removed by review; the site consistency grep finds no `signPczt` | Restore only with B4 and a verified snap method |
| **A4** Wallet list claimed wallets could pay that may not be able to | `Done` | `apps/site/app/index.html` `WALLETS` has an Ironwood column: Verified / Unverified / Not supported / Discontinued, each with a version and date | `docs/TOOLCHAIN.md` cites the source per row. Data, not code: no test drives the table | **The published MetaMask snap is v0.3.0 from 6 Feb 2026, before Ironwood.** Brave, Zucchini, Nighthawk, Zelcore and Ledger stay Unverified |
| **A5** Stale test counts | `Done` | `scripts/stats.ts` writes `docs/STATS.json` and rewrites marked counts in README and the site | `scripts/stats-consistency.test.ts` (10), mutation-tested | Detects surfaces drifting from `STATS.json`, not `STATS.json` drifting from reality. Re-run `pnpm stats` after adding tests |
| **A6** README contradicted itself and lagged the code | `Done` | `README.md` package table, "Not hidden" list, USD price-risk section | `stats-consistency.test.ts` covers the counts; the wording is checked by the consistency audit below | — |
| **A7** Site fee line conflicted with F4 | `Done` | `apps/site/index.html`, `README.md` Fees, `docs/DECISIONS.md` #6/#6b, `core/src/fee.ts` | Consistency audit row "Fee statements agree" | — |
| **A8** Audits out of date | `Done` | This file and `CONSISTENCY_AUDIT.md`; `scripts/gap-counts.ts` computes the counts from the rows | `stats-consistency.test.ts` "states the status counts its own rows add up to" and "claims Done only where a test is named" | Must be re-run after Part B |
| **A9** Nothing issued a receipt at settlement (found during A8) | `Done` | `server/src/verifier.ts` `receipts` option signs and stores a receipt on success and reports `receiptError` rather than stranding a paid payer | `server.test.ts` "receipts are issued at settlement" (5) | **The x402, MCP and A2A gates do not yet hand the receipt back in the response.** That is B7 |

## F1: Shielded payments

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Agent-to-agent payments are shielded Ironwood transfers | `Done` | `core/src/pool.ts`; `server/src/verifier.ts`; `byte-walletd/src/chain.rs` | `server.test.ts` wrong-pool cases; two real testnet payments in `TESTNET_RUNS.md` | — |
| Refuses to pay from transparent or Orchard sources | `Done` | `chain.rs` `SpendPolicy::shielded_pools([Ironwood])` **and** `assert_ironwood_funded`; `mock.ts` throws `wrong_pool_source` | `chain.rs` unit tests (4) on `ironwood_only_refusal`; `mock.test.ts`; `walletd.test.ts` "raises wrong_pool_source" | No real-chain test with a wallet holding mixed-pool notes. The walk over a live `Proposal` is not unit-tested |
| One transaction carries both value and memo | `Done` | `chain.rs` `send_to` | `TESTNET_RUNS.md` run 2 | — |
| Documented: no two-transaction window | `Done` | `docs/SPEC.md` §5.6 | — | — |
| Documented: no "silent failure" trick needed | `Done` | `docs/SPEC.md` §5.6 | — | — |

## F2: USD-priced invoices paid in ZEC

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| `priceUsd` on the invoice | `Done` | `core/src/price.ts`; `server/src/issuer.ts` `issueUsd` | `server.test.ts` "USD-priced invoices" (7) | — |
| `PriceSource` interface | `Done` | `core/src/price.ts` | `pricing.test.ts` | — |
| NEAR Intents price source | `Done` | `pricing/src/sources.ts` `NearIntentsPriceSource` | `pricing.test.ts` (native ZEC entry, not a bridged one) | Verified against the OpenAPI shape and mocks; **not run against the live service** |
| Second independent source | `Done` | `KrakenPriceSource` | `pricing.test.ts` (4) | **`api.kraken.com` was unreachable from the build machine, so this is verified against Kraken's documented response shape only** |
| Mock price source | `Done` | `MockPriceSource` | `pricing.test.ts` | — |
| `maxPriceAgeSec` | `Done` | `pricing/src/guarded.ts` | `pricing.test.ts` stale, future, untimestamped | — |
| `maxDeviationBps` | `Done` | `guarded.ts` | `pricing.test.ts` disagreement, failed secondary | — |
| Quote locked into the invoice | `Done` | `core/src/invoice.ts` `PriceQuote`; `StoredInvoice.price` | `server.test.ts` "stores the quote" | — |
| Payment judged against `amountZat` only | `Done` | `verifier.ts` | `server.test.ts` "verified against the locked amount, never re-priced" | — |
| 402 body and receipts carry both USD and ZEC | `Done` | `BytePaymentRequirements.price`; `ReceiptBody.priceUsd`/`zecUsd` (domain `byte-receipt-v2`) | `receipt.test.ts` priced receipts (4); `server.test.ts` "carries the USD denomination" | — |
| README and SPEC state ZEC settlement and price risk | `Done` | `README.md` "Pricing in dollars"; `SPEC.md` §5.4 | — | — |
| Typed `asset` extension point, ZSAs Planned | `Partial` | `core/src/invoice.ts` `asset: z.literal("ZEC")`, documented in `SPEC.md` §5.4 | `invoice.test.ts` rejects `"USDC"` | A closed literal, not a union. ZSAs are not on mainnet, so this is Planned |

## F3: Shield / unshield

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| `wallet.shield` | `Partial` | `wallet/src/walletd.ts`, `mock.ts`; `byte-walletd` `POST /shield` | `shield.test.ts` (17); `walletd.test.ts` shield (7) | **The sidecar route compiles and is wired but no test drives it, and no real transparent UTXO has been shielded on testnet.** Needs Asuzu (funds) |
| `wallet.unshield` | `Partial` | `walletd.ts`, `mock.ts`; `POST /unshield` | `shield.test.ts`; `walletd.test.ts` unshield (2) | As above |
| ZIP-317 fee shown, computed | `Done` | `chain.rs` reads `proposal.steps().last().balance().fee_required()` | `walletd.test.ts` returns `feeZat` | The mock uses a flat fee |
| Auto-shield with random delay and split | `Done` | `wallet/src/autoshield.ts` `AutoShielder` | `shield.test.ts` (5) | Splitting needs several transparent addresses; the client refuses when it cannot honour `splitInto` |
| Documented: reduces linkability, does not remove it | `Done` | `RAILS.md`, `wallet/src/types.ts` `ShieldRequest` | — | — |

## F4: Fees

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Protocol fee = 0 | `Done` | No output pays Byte anywhere | Consistency audit | — |
| "No protocol fee", never "free" | `Done` | README Fees, site, DECISIONS | Consistency audit grep | `README.md:9` "for free" is about published information, a different sense |
| `facilitatorFee { bps, minZat, payTo }` | `Done` | `core/src/fee.ts`; `InvoiceIssuer`; `ByteFacilitator` | `fee.test.ts` (core 9, server 12); `facilitator.test.ts` (7) | — |
| Fee as a second ZIP-321 output | `Done` | `core/src/zip321.ts` `buildZip321Multi` / `parseZip321Multi` | `zip321.test.ts` (10) | — |
| Facilitator verifies both outputs | `Done` | `verifier.ts` `#checkFee` | `fee.test.ts`, `fee-loop.test.ts` | — |
| Documented as facilitator-enforced, not on-chain | `Done` | README, SPEC §5.5, API.md, DECISIONS #6b, `fee.ts` | Consistency audit | — |
| Escrow service fee, same honesty rule | `Missing` | — | — | Depends on F7 |

## F5: Off-chain verification

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Per-invoice diversified UA | `Done` | `keys.rs`; `issuer.ts` | `keys.rs` cursor tests; `server.test.ts` | — |
| Memo `BYTE1|invoiceId|hmac` | `Done` | `memo.ts`, `memo.rs` | 33 TS + 8 Rust, pinned cross-language vector | — |
| Verified with a view-only key | `Done` | `state.rs` `from_ufvk`; facilitator refuses a spender | `facilitator.test.ts` | — |
| Verifier sees the exact amount | `Done` | `verifier.ts` | `server.test.ts` | — |
| Replay protection via atomic `consume` | `Done` | `core/src/store.ts`; `stores/src/memory.ts` | `memory.test.ts` concurrency case | Memory only: see the next row |
| Durable store | `Missing` | — | — | A restart re-opens the replay window (B2). Needs Asuzu to choose SQLite or Redis |
| Signed Ed25519 receipts, issued at settlement | `Partial` | `core/src/receipt.ts`; `verifier.ts` `receipts` option | `receipt.test.ts` (21); `server.test.ts` receipts (5) | The gates do not hand the receipt back to the payer (B7) |
| Per-transaction disclosure | `Not feasible yet` | — | — | ZIP 311 "Zcash Payment Disclosures" is `Draft`; ZIP 303 is `Withdrawn` |
| Scoped incoming-viewing-key export | `Missing` | `GET /viewing-key` returns the full UFVK | — | B3 |

## F6: Delegation and spend limits

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Per-call cap | `Done` | `client/src/guard.ts` | `guard.test.ts`; `fee-loop.test.ts` (counts the fee) | — |
| Rolling daily cap | `Done` | `guard.ts` | `guard.test.ts` | — |
| Per-host allowlist | `Done` | `guard.ts` | `guard.test.ts` | — |
| Approval hook | `Done` | `guard.ts` | `guard.test.ts` | — |
| Append-only, persistent audit log | `Partial` | `guard.ts` bounded in-memory ring | `guard.test.ts` | Lossy, not append-only, lost on restart (B4) |
| Split build/sign with PCZT | `Missing` | `pczt` is transitive only | — | B4. Feasible: librustzcash #2524 is closed |
| Threshold custody with FROST | `Not feasible yet` | — | — | See F7 Mode A |
| Never described as "on-chain allowances" | `Done` | — | Grep finds none | — |

## F7: Escrow for agent jobs

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Mode A: shielded 2-of-3 FROST | `Not feasible yet` | — | — | `ZcashFoundation/frost` workspace has no Pallas or re-randomized Orchard ciphersuite (`frost-core`, `ed25519`, `ed448`, `p256`, `ristretto255`, `secp256k1`, `secp256k1-tr`, `rerandomized`); `reddsa` 0.6.1 has no FROST module |
| Mode B: transparent 2-of-3 P2SH | `Missing` | — | — | B5, labelled non-private |
| Job state machine | `Missing` | — | — | B5 |
| Timeouts | `Missing` | — | — | B5 |
| `JobStore` | `Missing` | — | — | B5 |
| Funding and release are real Zcash transactions | `Missing` | — | — | B5 |
| Arbiter fee via co-signing policy | `Missing` | — | — | B5 |
| Buyer plus seller can bypass the arbiter: documented | `Missing` | — | — | B5 |
| Signed job receipts | `Missing` | — | — | B5 |

## F8: Agent identity and reputation

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Signed Agent Card | `Done` | `registry/src/card.ts` | `card.test.ts` (27) | — |
| Served at `/.well-known/byte-agent.json` | `Done` | `WELL_KNOWN_PATH`; legacy path still resolves on a 404 | `card.test.ts` fallback (3) | — |
| Card fields | `Partial` | `AgentCardBodySchema` | `card.test.ts` | `endpoint` is singular, not a list |
| A2A agent-card extension | `Missing` | — | — | B6 |
| Reputation from signed receipts | `Missing` | — | — | B6. Receipts are now issued (A9) |
| Signed feedback type | `Missing` | — | — | B6 |
| Merkle-root anchoring in a shielded self-send | `Missing` | — | — | B6 |
| Documented: anchor private by default | `Missing` | — | — | B6 |
| Public OP_RETURN-style anchor | `Missing` | — | — | B6. Verify it is standard on Zcash before offering |

## F9: NEAR Intents, in and out

### Funding

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| `GET /tokens` → ZEC asset | `Done` | `rails/near-intents/src/rail.ts` | `rail.test.ts` | — |
| `POST /quote` EXACT_OUTPUT | `Done` | `rail.ts` `quote` | `rail.test.ts` (10) | — |
| `confidentiality: "basic"` sent explicitly | `Missing` | — | — | B1. The API default is `public` |
| `dry: true` works against the real shape | `Done` | `rail.ts`, `rails/interface` `depositAddress?` | `rail.test.ts` "survives a dry response that omits the deposit address" | Not run live |
| `POST /deposit/submit` | `Missing` | — | — | B1 |
| Poll `GET /status` | `Done` | `rail.ts` `status` | `rail.test.ts` all seven statuses | — |
| Auto-shield on `SUCCESS` | `Missing` | — | — | B1. The auto-shielder exists (F3) |
| Fresh transparent recipient per quote | `Missing` | — | — | B1. Currently one fixed address |

### Cash out

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Quote with ZEC as `originAsset` | `Missing` | — | — | B1 |
| Wallet sends from Ironwood to the deposit address | `Missing` | — | — | B1 |
| Deposit address validated before sending | `Missing` | — | — | B1 |
| Fresh `refundTo`, refunds auto-shielded | `Missing` | — | — | B1 |
| Status tracking | `Partial` | `status()` is direction-agnostic | `rail.test.ts` | Reusable as-is |

### Both directions

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Quote and status signature verification | `Missing` | — | — | B1. The quote response carries a `signature`; nothing verifies it |
| JWT support, 0.25% documented | `Done` | `rail.ts`; `RAILS.md` | `rail.test.ts` | Asuzu has no JWT |
| NEAR fees shown separately from Byte's | `Partial` | Raw response on the quote | — | No typed breakdown (B1) |
| Fixtures: statuses, signature pass and fail, refunds | `Partial` | `rail.test.ts` | 26 tests | Signature fixtures missing |
| Live test gated by `BYTE_RAILS_LIVE=1` | `Missing` | — | — | B1 |
| `SECURITY.md` on `confidentiality` | `Partial` | Transparent leg covered | — | `confidentiality` caveat absent |
| Other rails Implemented or Planned with reasons | `Done` | `RAILS.md` | — | — |

## F10: Framework adapters

Existing: **x402, MCP, A2A/AP2, LangChain.** MPP, AgentKit, ElizaOS, Virtuals GAME and
OpenClaw do not exist in this repo, and nothing claims they do.

| Tool | x402 | MCP | A2A/AP2 | LangChain |
|------|------|-----|---------|-----------|
| `byte_pay` | `Done` | `Done` | `Done` | `Partial` (`byte_fetch_paid`) |
| `byte_invoice` | `Done` | `Done` | `Done` | `Missing` |
| `byte_balance` | `Missing` | `Missing` | `Missing` | `Done` |
| `byte_receipt` | `Missing` | `Missing` | `Missing` | `Missing` |
| `byte_shield` / `byte_unshield` | `Missing` | `Missing` | `Missing` | `Missing` |
| `byte_fund` / `byte_cashout` | `Missing` | `Missing` | `Missing` | `Missing` |
| `byte_escrow_*` | `Missing` | `Missing` | `Missing` | `Missing` |
| `byte_agent_card` | `Missing` | `Missing` | `Missing` | `Missing` |
| Full loop through the mock wallet | `Done` | `Done` | `Done` | `Done` |

Tools are only exposed for features that are `Done`. New adapters need Asuzu's choice.

## F11: NU7 readiness

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Never hardcode block time | `Done` | `core/src/network.ts` | `network.test.ts` (13) | — |
| Read spacing from the chain | `Done` | `/status` `consensusBranchId` → `blockTargetSeconds` | `network.test.ts`; `server.test.ts` (3) | — |
| Derive `Retry-After` and waits from it | `Done` | `verifier.ts`; `scripts/testnet-e2e.ts` | `server.test.ts` | — |
| Build v5+ transactions only | `Partial` | `propose_transfer(..., proposed_version: None)` | — | The built version is asserted nowhere (B9). Ironwood needs v6, ZIP 229 is `Draft` |
| Test matrix for 75 s vs 25 s | `Done` | `network.test.ts` | 13 | — |
| NU7 activation heights | `Not feasible yet` | Deliberately `undefined` | `network.test.ts` "is not decided by height" | ZIP 259: testnet "TBD (To be set on OCT 5)", mainnet "TBD (To be set on OCT 20)" |

## F12: Owner and UI JSON API

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Invoices with USD fields | `Done` | `console/src/api.ts` | `console.test.ts` | — |
| Receipts | `Done` | `GET /receipts` | `console.test.ts` | Now populated by A9 |
| Spend-guard log | `Done` | `GET /guard` | `console.test.ts` | — |
| Balances (spendable, pending, unusable) | `Done` | `GET /balance` | `console.test.ts` | — |
| Price-source health | `Done` | `GET /price` | `console.test.ts` (5) | — |
| Rail jobs, both directions | `Missing` | — | — | B8 |
| Escrow jobs | `Missing` | — | — | B8 |
| Agent card | `Missing` | — | — | B8 |
| Every route authenticated | `Done` | `api.ts` | `console.test.ts` "no route is exempt" | — |

---

## Contradictions: status

The eight from the first audit are closed (Redis claims, hardcoded 75 s, Ironwood-only
funding in the sidecar, the dry-quote crash, the false signature claim, the card path, the
`confidentiality` default, the adapter list). Found since:

| Contradiction | Status |
|---------------|--------|
| README said the NEAR rail "is not in this release" while the table listed it | Closed (A6) |
| README, site, DECISIONS and `fee.ts` said "No fee output" after the facilitator fee existed | Closed (A7) |
| Site claimed a PCZT flow that does not exist | Closed (A3) |
| Site claimed every listed wallet could pay | Closed (A4) |
| `price.ts` cited `SPEC.md §5.6`, which did not exist | Closed: SPEC §5.4–5.6 written |
| Receipts described as a feature; nothing issued one | Closed (A9) |
| `ByteFacilitator` could not charge the fee it was documented as charging | Closed (A1b) |
| SPEC diagram shows "200 + resource (+ signed receipt)" but no gate returns one | **Open** (B7) |

## Sources checked

| Fact | Source |
|------|--------|
| 1Click endpoints, `/tokens` price fields, `confidentiality` enum, dry omissions, quote `signature` | [1Click OpenAPI v0](https://1click.chaindefuser.com/docs/v0/openapi.yaml) |
| FROST ciphersuites (no Pallas) | [ZcashFoundation/frost Cargo.toml](https://github.com/ZcashFoundation/frost/blob/main/Cargo.toml) |
| `reddsa` has no FROST module | [docs.rs/reddsa 0.6.1](https://docs.rs/reddsa/latest/reddsa/) |
| ZIP 311 `Draft`, ZIP 303 `Withdrawn` | [zips.z.cash](https://zips.z.cash/) |
| Unwitnessed Ironwood PCZT spends | [librustzcash#2524](https://github.com/zcash/librustzcash/issues/2524) |
| NU7 branch ID `0x77190AD9`, heights TBD | [ZIP 259](https://zips.z.cash/zip-0259) |
| `zcash_protocol` 0.10.6 still has a NU7 placeholder | [librustzcash#3047](https://github.com/zcash/librustzcash/pull/3047) |
| ZIP 321 indexed form grammar | [ZIP 321](https://zips.z.cash/zip-0321) |
| `SpendPolicy`, `propose_transfer` | `zcash_client_backend` 0.24.0 source |
| Wallet Ironwood status | [Zcash forum wallet list](https://forum.zcashcommunity.com/t/ironwood-is-here-updated-wallets-libraries-aug-1/56557) and [npm](https://www.npmjs.com/package/@chainsafe/webzjs-zcash-snap) |
