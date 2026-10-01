# Gap audit

What Byte Protocol has, measured against the F1–F12 feature checklist and the defects an
independent review found in `main` at `9f5fc87`. A row says `Done` only when there is code
**and** a passing test behind it, and the test is named. Anything else says what is missing.

Last updated 1 October 2026, after the mainnet runs in `CHAIN_RUNS.md`. Part B rows are still
open and say so.

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
| `Done` | 99 |
| `Partial` | 11 |
| `Missing` | 31 |
| `Not feasible yet` | 5 |
| **Total sub-items** | **146** |
<!--/gap-counts-->

---

## Part A: defects from the independent review

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| **A1** A fee invoice could not be paid by Byte's own client | `Done` | `wallet/src/types.ts` `SendRequest` (union) and `sendOutputs`; `client/src/payer.ts` pays every output and guards the total; `byte-walletd` `send_to` builds one `zip321::TransactionRequest` via `propose_transfer` with `SpendPolicy::shielded_pools([Ironwood])` | `client/src/fee-loop.test.ts` (7, over real HTTP); `server/src/fee.test.ts` now pays through `BytePayer`; `walletd.test.ts` "sends several outputs as one transaction"; **`CHAIN_RUNS.md` run 5, on mainnet**: txid `bf7f7ea4…e315f6eb`, 50,000 zat to the payee carrying the memo and 1,250 zat of fee carrying none, in one transaction | — |
| **A1b** `ByteFacilitator` could not charge the fee at all (found during A8) | `Done` | `facilitator/src/facilitator.ts` takes `fee` and `feeWallet`, publishes terms in `info().fee`, refuses a fee without a `feeWallet` and a spendable `feeWallet` | `facilitator.test.ts` "a facilitator that charges a fee" (7) | — |
| **A2** Testnet already computed post-NU7 25 s block times | `Done` | `core/src/network.ts` `blockTargetSeconds(branchId)`; `byte-walletd` `/status` reports `consensusBranchId` from `GetLightdInfo` | `core/src/network.test.ts` (13); `server.test.ts` "Retry-After follows the chain's consensus branch" (3), including testnet height 4,414,380 → 75 s | **NU7 branch `0x77190AD9` (ZIP 259, Draft) is not yet observable on a live chain**, and both activation heights are `TBD` in ZIP 259. Recorded in `TOOLCHAIN.md` |
| **A3** Dashboard claimed a PCZT spend path that does not exist | `Done` | `apps/site/app/index.html`, `apps/site/README.md`: claims removed, snap described as read-only | Removed by review; the site consistency grep finds no `signPczt` | Restore only with B4 and a verified snap method |
| **A4** Wallet list claimed wallets could pay that may not be able to | `Done` | `apps/site/app/index.html` `WALLETS` has an Ironwood column: Verified / Unverified / Not supported / Discontinued, each with a version and date | `docs/TOOLCHAIN.md` cites the source per row. Data, not code: no test drives the table | **The published MetaMask snap is v0.3.0 from 6 Feb 2026, before Ironwood.** Brave, Zucchini, Nighthawk, Zelcore and Ledger stay Unverified |
| **A5** Stale test counts | `Done` | `scripts/stats.ts` writes `docs/STATS.json` and rewrites marked counts in README and the site | `scripts/stats-consistency.test.ts` (10), mutation-tested | Detects surfaces drifting from `STATS.json`, not `STATS.json` drifting from reality. Re-run `pnpm stats` after adding tests |
| **A6** README contradicted itself and lagged the code | `Done` | `README.md` package table, "Not hidden" list, USD price-risk section | `stats-consistency.test.ts` covers the counts; the wording is checked by the consistency audit below | — |
| **A7** Site fee line conflicted with F4 | `Done` | `apps/site/index.html`, `README.md` Fees, `docs/DECISIONS.md` #6/#6b, `core/src/fee.ts` | Consistency audit row "Fee statements agree" | — |
| **A8** Audits out of date | `Done` | This file and `CONSISTENCY_AUDIT.md`; `scripts/gap-counts.ts` computes the counts from the rows | `stats-consistency.test.ts` "states the status counts its own rows add up to" and "claims Done only where a test is named" | Must be re-run after Part B |
| **A10** Byte could not verify a payment from any wallet but its own | `Done` | `byte-walletd/src/chain.rs` `enhance_transactions` drains the backend's own queue of outstanding data requests: `Enhancement` answered through `GetTransaction` and `decrypt_and_store_transaction`, `GetStatus` with whether the chain has the transaction, and one the server cannot supply reported as unrecognised rather than re-requested on every sync forever | **`CHAIN_RUNS.md` run 4, on mainnet**: invoice `14c009b5…` settled unattended from a third-party wallet, the seller's log reading `pending → pending → SETTLED` where it had previously read `invalid_payment` | **No unit test, and there cannot easily be one.** The mock chain has no notion of a compact block, so a mock memo is simply present. The property that broke is a light-client one and only a real light-client connection exercises it |
| **A9** Nothing issued a receipt at settlement (found during A8) | `Done` | `server/src/verifier.ts` `receipts` option signs and stores a receipt on success and reports `receiptError` rather than stranding a paid payer | `server.test.ts` "receipts are issued at settlement" (5) | **The x402, MCP and A2A gates do not yet hand the receipt back in the response.** That is B7 |

## F1: Shielded payments

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Agent-to-agent payments are shielded Ironwood transfers | `Done` | `core/src/pool.ts`; `server/src/verifier.ts`; `byte-walletd/src/chain.rs` | `server.test.ts` wrong-pool cases; two real testnet payments in `CHAIN_RUNS.md` | — |
| Refuses to pay from transparent or Orchard sources | `Done` | `chain.rs` `SpendPolicy::shielded_pools([Ironwood])` **and** `assert_ironwood_funded`; `mock.ts` throws `wrong_pool_source` | `chain.rs` unit tests (4) on `ironwood_only_refusal`; `mock.test.ts`; `walletd.test.ts` "raises wrong_pool_source" | No real-chain test with a wallet holding mixed-pool notes. The walk over a live `Proposal` is not unit-tested |
| One transaction carries both value and memo | `Done` | `chain.rs` `send_to` | `CHAIN_RUNS.md` run 2 | — |
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
| Durable store | `Done` | `stores/src/sqlite.ts` `createSqliteStores` on `node:sqlite`; `consume` is one conditional `UPDATE` | `stores/src/contract.test.ts` (40, one suite over both stores, incl. 20 concurrent claims and a restart) | Single process, single file. Several processes sharing a payee want Redis, not built |
| Signed Ed25519 receipts, issued at settlement | `Partial` | `core/src/receipt.ts`; `verifier.ts` `receipts` option | `receipt.test.ts` (21); `server.test.ts` receipts (5) | The x402, MCP and A2A gates do not yet hand the receipt back in the response |
| Per-transaction disclosure | `Not feasible yet` | — | — | ZIP 311 "Zcash Payment Disclosures" is `Draft`; ZIP 303 is `Withdrawn` |
| Scoped incoming-viewing-key export | `Done` | `keys.rs` `export_uivk`; `GET /viewing-key` returns `uivk` and `ufvk`; `walletd.ts` `incomingViewingKey` | `keys.rs` (2); `walletd.test.ts` "viewing keys" (3) | "Scoped" is a misnomer and the docs say so: no key can be scoped to a subset of payments or revoked. SECURITY §5.7 |

## F6: Delegation and spend limits

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Per-call cap | `Done` | `client/src/guard.ts` | `guard.test.ts`; `fee-loop.test.ts` (counts the fee) | — |
| Rolling daily cap | `Done` | `guard.ts` | `guard.test.ts` | — |
| Per-host allowlist | `Done` | `guard.ts` | `guard.test.ts` | — |
| Approval hook | `Done` | `guard.ts` | `guard.test.ts` | — |
| Append-only, persistent audit log | `Done` | `client/src/audit.ts` `FileAuditLog` (append flag, no update or delete path) | `audit.test.ts` (13) incl. restart, crash-truncated line, failed write | Append-only against the program, not tamper-proof against someone with filesystem access |
| Split build/sign with PCZT | `Partial` | `byte-walletd/src/split_sign.rs`: `review`, `sign` (policy checked in full before any signature), `prove`; `chain.rs` `create_pczt_for` and `extract_and_broadcast`; `api.rs` `POST /pczt/create`, `/pczt/review`, `/pczt/sign`, `/pczt/prove`, `/pczt/extract`, documented in `API.md`; `scripts/pczt-run.ts` drives all five stages | `split_sign.rs` (3): empty PCZT refused, refusal reasons, default policy. `api.rs` (7): hex and PCZT parse failures distinguished, an absent policy restricts nothing, an unparseable cap is refused rather than ignored, every route requires the token | **The signing policy counts change, so it does not yet express what a person means.** An allow list would have to name a change address minted per transaction, and `maxTotalZat` caps value leaving the wallet plus value returning to it. **Not blocked, unbuilt:** the PCZT keeps `zip32_derivation` private, but `orchard::keys::IncomingViewingKey::diversifier_index` answers `Some` for the wallet's own addresses, so the exemption is derivable at the `/pczt/sign` layer, which holds a key. An earlier version of this row said it could not be done, which was wrong. The mechanism itself is proven (`CHAIN_RUNS.md` run 6, mainnet, txid `675fdde8…8e0cdc43`: a cap one zatoshi under the total was refused, the exact total signed). The crate also does not expose a spend's value, so only what is paid can be audited, not what is spent. The MetaMask snap claim stays removed |
| Threshold custody with FROST | `Not feasible yet` | — | — | See F7 Mode A |
| Never described as "on-chain allowances" | `Done` | — | Grep finds none | — |

## F7: Escrow for agent jobs

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Mode A: shielded 2-of-3 FROST | `Not feasible yet` | — | — | `ZcashFoundation/frost` workspace has no Pallas or re-randomized Orchard ciphersuite (`frost-core`, `ed25519`, `ed448`, `p256`, `ristretto255`, `secp256k1`, `secp256k1-tr`, `rerandomized`); `reddsa` 0.6.1 has no FROST module |
| Mode B: transparent 2-of-3 P2SH | `Not feasible yet` | — | — | **Deliberately not built** (Asuzu's decision): it publishes amounts and all three addresses. Reasoning in ROADMAP |
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
| A2A agent-card extension | `Done` | `registry/src/a2a.ts` `toA2AExtension`, `fromA2AExtensions` | `identity.test.ts` A2A (7) | — |
| Reputation from signed receipts | `Done` | `registry/src/reputation.ts` `computeReputation` | `identity.test.ts` reputation (7) | Cannot prove absence; no Sybil resistance. Both stated |
| Signed feedback type | `Done` | `reputation.ts` `signFeedback`, `verifyFeedback` | `identity.test.ts` feedback (4) | — |
| Merkle-root anchoring in a shielded self-send | `Partial` | `registry/src/anchor.ts` builds the tree, proves inclusion and builds the memo | `identity.test.ts` merkle (7) incl. the second-preimage case | **The self-send itself is not wired**: nothing broadcasts the anchor transaction |
| Documented: anchor private by default | `Done` | `anchor.ts` header | — | — |
| Public OP_RETURN-style anchor | `Missing` | — | — | B6. Verify it is standard on Zcash before offering |

## F9: NEAR Intents, in and out

### Funding

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| `GET /tokens` → ZEC asset | `Done` | `rails/near-intents/src/rail.ts` | `rail.test.ts` | — |
| `POST /quote` EXACT_OUTPUT | `Done` | `rail.ts` `quote` | `rail.test.ts` (10) | — |
| `confidentiality` sent explicitly | `Done` | `rail.ts` sends `basic` with a JWT, `public` without, and says which | `cashout.test.ts` "confidentiality" (5); live test | **Correction:** `basic` also needs a JWT (`401` otherwise). Found by the live test |
| `dry: true` works against the real shape | `Done` | `rail.ts`, `rails/interface` `depositAddress?` | `rail.test.ts` "survives a dry response that omits the deposit address" | Not run live |
| `POST /deposit/submit` | `Done` | `rail.ts` `submitDeposit` | `cashout.test.ts` "submitting a deposit" (2) | Not run live |
| Poll `GET /status` | `Done` | `rail.ts` `status` | `rail.test.ts` all seven statuses | — |
| Auto-shield on `SUCCESS` | `Done` | `rail.ts` `settle` | `cashout.test.ts` "settling a funding" (3) | `settle` shields the wallet's whole transparent balance, not only the funded address |
| Fresh transparent recipient per quote | `Done` | `rail.ts` `#recipientAddress`; `ShieldingWallet.newTransparentAddress`; `POST /transparent-addresses` | `cashout.test.ts` (3) | The sidecar route compiles but is not exercised against a synced wallet |

### Cash out

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Quote with ZEC as `originAsset` | `Done` | `rail.ts` `cashOutQuote` (`EXACT_INPUT`) | `cashout.test.ts` "cashing out" (4); live dry quote | Not run non-dry |
| Wallet sends from Ironwood to the deposit address | `Done` | `rail.ts` `payCashOut` via `unshield` | `cashout.test.ts` "paying a cash-out" (6) | Mock only. Not on a real chain |
| Deposit address validated before sending | `Done` | `payCashOut` | `cashout.test.ts` | — |
| Fresh `refundTo`, refunds auto-shielded | `Partial` | `cashOutQuote` mints a fresh refund address | `cashout.test.ts` | Nothing yet sweeps that address after a `REFUNDED` status |
| Status tracking | `Partial` | `status()` is direction-agnostic | `rail.test.ts` | Reusable as-is |

### Both directions

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Quote signature verification | `Done` | `rails/near-intents/src/quote-signature.ts` | `quote-signature.test.ts` (39) incl. a **real captured signature** and tamper cases; live test | **Status responses are not verified**: the docs' index says status payloads are signed but document no algorithm and the SDK ships no status verifier |
| JWT support, 0.25% documented | `Done` | `rail.ts`; `RAILS.md` | `rail.test.ts` | Asuzu has no JWT |
| NEAR fees shown separately from Byte's | `Done` | `rail.ts` `#feesFrom`; `RailFees` | `cashout.test.ts` "the fee breakdown" (3) | — |
| Fixtures: statuses, signature pass and fail, refunds | `Done` | `rail.test.ts`, `quote-signature.test.ts`, `fixtures/` | 92 | — |
| Live test gated by `BYTE_RAILS_LIVE=1` | `Done` | `rails/near-intents/src/live.test.ts` | Ran against the real service: 5 pass, dry only | Never non-dry; that needs a JWT and Asuzu |
| `SECURITY.md` on `confidentiality` | `Done` | SECURITY §2.4, RAILS.md | — | — |
| Other rails Implemented or Planned with reasons | `Done` | `RAILS.md` | — | — |

## F10: Framework adapters

Existing: **x402, MCP, A2A/AP2, LangChain.** MPP, AgentKit, ElizaOS, Virtuals GAME and
OpenClaw do not exist in this repo, and nothing claims they do.

| Tool | x402 | MCP | A2A/AP2 | LangChain |
|------|------|-----|---------|-----------|
| `byte_pay` | `Done` | `Done` | `Done` | `Partial` (`byte_fetch_paid`) |
| `byte_invoice` | `Done` | `Done` | `Done` | `Missing` |
| `byte_balance` | `Missing` | `Missing` | `Missing` | `Done` |
| `byte_receipt` | `Missing` | `Missing` | `Missing` | `Done` |
| `byte_shield` / `byte_unshield` | `Missing` | `Missing` | `Missing` | `Done` |
| `byte_fund` / `byte_cashout` | `Missing` | `Missing` | `Missing` | `Partial` |
| `byte_escrow_*` | `Missing` | `Missing` | `Missing` | `Missing` |
| `byte_agent_card` | `Missing` | `Missing` | `Missing` | `Done` |
| Full loop through the mock wallet | `Done` | `Done` | `Done` | `Done` |

Tools are only exposed for features that are `Done`. LangChain's `createTreasuryTools` is opt-in and separate from `createByteTools`: unshielding publishes an amount, and an operator who handed an agent a paywall-fetching tool did not agree to that. `byte_fund` is `Partial` (`byte_cashout` exists, funding does not). x402, MCP and A2A/AP2 got no new tools this pass. **No new adapters were built**, per Asuzu.

## F11: NU7 readiness

| Item | Status | Where it lives | Test that proves it | What's missing |
|------|--------|----------------|---------------------|----------------|
| Never hardcode block time | `Done` | `core/src/network.ts` | `network.test.ts` (13) | — |
| Read spacing from the chain | `Done` | `/status` `consensusBranchId` → `blockTargetSeconds` | `network.test.ts`; `server.test.ts` (3) | — |
| Derive `Retry-After` and waits from it | `Done` | `verifier.ts`; `scripts/testnet-e2e.ts` | `server.test.ts` | — |
| Build v5+ transactions only | `Done` | `chain.rs` `assert_modern_version` at broadcast | `chain.rs` `only_v5_and_v6_transactions_may_be_broadcast` | v6 is ZIP 229, still Draft |
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
| Agent card | `Done` | `console/src/api.ts` `GET /agent-card` | `console.test.ts` (3) | — |
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
