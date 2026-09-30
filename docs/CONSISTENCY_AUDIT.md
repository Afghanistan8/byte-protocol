# Consistency audit

Every claim Byte makes, traced to the code that implements it and the test that proves it.

The point is not to look thorough. It is that a privacy protocol whose documentation and code
disagree is worse than one that promises less — a reader who trusts a claim that the code does
not honour is worse off than one who was told nothing.

Run **2026-09-29**, against `main` with **<!--stats:total-->706<!--/stats--> tests passing**
(<!--stats:ts-->646<!--/stats--> TypeScript, <!--stats:rust-->60<!--/stats--> Rust). Those
figures are written by `pnpm stats` from real runs of both suites into `docs/STATS.json`, and
`scripts/stats-consistency.test.ts` fails if this file, the README or the site disagrees.

---

## Method

Four checks, run rather than asserted:

1. `grep` every "Orchard" mention in docs, confirming each is migration, receiver-typecode or
   refusal context — never "the pool Byte uses".
2. `grep` every fee claim, confirming they agree.
3. `grep` for leaked references to the conceptual inspiration named in the original brief.
4. Real test counts from `vitest run` and `cargo test`, not remembered ones.

Plus: every package named in the README resolved against a real `package.json`, and every
adapter and rail checked for a test file.

---

## Claims traced

| Claim | Where stated | Implemented in | Proven by |
|-------|--------------|----------------|-----------|
| Settles in the Ironwood pool | README, SPEC §3 | `core/src/pool.ts` `isAcceptedPool`; `chain.rs` `pool_name` | `server.test.ts` "reports invalid_payment for a payment in the wrong pool"; live run in TESTNET_RUNS |
| Fresh diversified address per invoice | README, SPEC §5.1 | `keys.rs` `DiversifierCursor`; `issuer.ts` | `keys.rs` "the cursor never repeats an address" (200); `server.test.ts` "mints a fresh address for every invoice" (50); `mock.test.ts` (500) |
| Address is Orchard-typecode, no transparent receiver | README, SPEC §3, TOOLCHAIN | `keys.rs` `BYTE_ADDRESS_REQUEST = UnifiedAddressRequest::ORCHARD` | `keys.rs` "addresses encode for the right network"; the constant is `(Require, Omit, Omit)` in librustzcash |
| The pool is read off the note, not the address | README, ARCHITECTURE, SPEC §3 | `verifier.ts` `isAcceptedPool(settling.pool)`; `chain.rs` `outputs_for_txid` | `server.test.ts` wrong-pool test; real run shows `"pool": "ironwood"` |
| Byte will not cross pools | README, SECURITY §2.2 | `mock.ts` `wrong_pool_source`; `chain.rs` `fallback_change_pool: ShieldedPool::Ironwood` | `mock.test.ts` "reports wrong_pool_source…"; real run shows the change output in Ironwood |
| Memo binds invoice, amount and address | SPEC §6 | `memo.ts` / `memo.rs` `computeBinding` | The memo test suites in both languages, including field-boundary collision |
| The two memo codecs agree | ARCHITECTURE | `memo.ts`, `memo.rs` | Both pin `BYTE1\|0123…cdef\|83277bce2698d03296873534c777da14` |
| Invoices are consumed atomically | SPEC §7, ARCHITECTURE | `MemoryInvoiceStore.consume` | `memory.test.ts` 200 concurrent claims → 1 winner; `server.test.ts` 50 concurrent → 1 |
| A failed verification never consumes | SPEC §8 | `verifier.ts` (consume is last) | `server.test.ts` "does not consume an invoice that failed verification" |
| Every SPEC §8 failure behaves as documented | SPEC §8 | `verifier.ts` | `server.test.ts` — underpaid, expired, pending (unseen and unconfirmed), replay, wrong pool, no memo, forged memo, cross-invoice memo, reorg |
| Overpayment is accepted and not refunded | README, SPEC §8, SECURITY §5.2 | `verifier.ts` (`paid < owed` only) | `server.test.ts` "accepts an overpayment and keeps the surplus" |
| A facilitator cannot spend | README, ARCHITECTURE, SECURITY §4 | `ViewOnlyWallet` has no `send`; `ByteFacilitator` throws on a spending wallet | `facilitator.test.ts` "refuses a wallet that can spend"; `/info` reports `canSpend: false` |
| Spend guard denies before building | README, SPEC §10 | `guard.ts`, `payer.ts` (guard before `wallet.send`) | `loop.test.ts` "does not pay when the guard denies…"; guard suite (18) |
| Daily budget charged at authorization | README | `guard.ts` `#charges` pushed on allow | `guard.test.ts` "charges at authorization…" |
| An approval hook that throws denies | README | `guard.ts` `approval_failed` | `guard.test.ts` "denies when the hook throws" |
| Allowlist does not imply subdomains | README | `guard.ts` exact hostname match | `guard.test.ts` "does not imply subdomains" |
| Pays at most once per request | — | `fetch.ts` `maxPayments` default 1 | `loop.test.ts` greedy-server test |
| Agent Cards are signed and verified | README | `registry/src/card.ts` | 24 registry tests, including a swapped payment address |
| x402 mapping is `exact` on a Zcash network | README, SPEC §11 | `adapters/x402/src/mapping.ts` | 18 x402 tests, incl. the v2 headers over real HTTP |
| `SettlementResponse.payer` is never populated | SPEC §11 | Typed `payer?: never` | The type makes it unrepresentable |
| MCP payments ride in `_meta` | Adapter docs | `adapters/mcp/src/gate.ts` | `mcp.test.ts` "puts the payment in _meta, not in the tool's arguments" |
| AP2 mapping uses real AP2 field names | Adapter docs | `adapters/a2a-ap2/src/method.ts` | Keys taken from AP2's SDK; asserted in `a2a-ap2.test.ts` |
| The NEAR rail's Zcash leg is public | README, RAILS, SECURITY §2.3 | `rail.ts` `transparentLeg.public = true` | `rail.test.ts` "is declared public on the rail itself" and "is repeated on every quote" |
| The NEAR rail is dry-run by default | README, RAILS | `rail.ts` `request.dry ?? true` | `rail.test.ts` "is dry by default" |
| Byte's protocol fee is zero | README, SPEC §5.5, DECISIONS #6 | No output pays Byte; no treasury address anywhere in the codebase | `grep` finds no treasury address; the only fee output that can exist is the facilitator's, in `core/src/fee.ts` |
| An optional facilitator fee is enforced by verification, not by the chain | README, SPEC §5.5, API.md, DECISIONS #6b, `fee.ts` | `verifier.ts` `#checkFee`; `facilitator.ts` `fee`/`feeWallet` | `server/src/fee.test.ts` "refuses a payment that settled the payee but skipped the fee"; `client/src/fee-loop.test.ts` over real HTTP; `facilitator.test.ts` |
| Unsynced wallets refuse rather than return zero | API, SECURITY | `state.rs` `NotSynced`; `console/src/api.ts` `balance: null` | `state.rs` "an unsynced wallet refuses to report chain facts"; `console.test.ts` "reports a null balance rather than zeroes" |
| The console is owner-only | README, API | `console/src/api.ts` — no exempt route | `console.test.ts` "has no unauthenticated route, not even a health check" |
| The console loads nothing externally | README | `ui.ts` — single self-contained file | `console.test.ts` "loads nothing from anywhere else" |
| Real shielded payment on testnet | README, TESTNET_RUNS | — | txid `15a1ded9…768369`, block 4,413,018 |
| The x402 adapter works against a real chain | README, TESTNET_RUNS | `adapters/x402`, `WalletdWallet` | txid `49ab740b…3aa712`, both outputs Ironwood, memo intact |

| A fee invoice is payable by Byte's own client | SPEC §5.5 | `payer.ts` pays every output and guards the total; `chain.rs` `send_to` builds one multi-recipient proposal | `fee-loop.test.ts` "is paid and served", "settles both outputs in one transaction", "charges the guard the payment plus the fee" |
| Invoices can be priced in USD and settle in ZEC | README, SPEC §5.4 | `core/src/price.ts`; `issuer.ts` `issueUsd` | `server.test.ts` "USD-priced invoices"; `pricing.test.ts` |
| A stale or contradicted price refuses to invoice | README, SPEC §5.4 | `pricing/src/guarded.ts` | `pricing.test.ts` stale, future-dated, disagreement, failed secondary |
| A payment is never re-priced | README, SPEC §5.4 | `verifier.ts` compares `amountZat` only | `server.test.ts` "verified against the locked amount, never re-priced" |
| Payer and payee carry price risk after the quote locks | README "Pricing in dollars", SPEC §5.4 | Stated, not coded: Byte does not hedge | Grep: the sentence is identical in README and SPEC |
| Block spacing follows the chain's consensus branch, not a height | TOOLCHAIN, SECURITY §5.1 | `network.ts` `blockTargetSeconds`; `/status` `consensusBranchId` | `network.test.ts`; `server.test.ts` testnet height 4,414,380 → 75 s |
| NU7 branch is `0x77190AD9`, and its heights are unset | TOOLCHAIN | `network.ts` `NU7_BRANCH_ID_HEX`, `NU7_ACTIVATION_HEIGHT` | `network.test.ts` "does not mistake the superseded NU7 branch value", "is not decided by height at all" |
| A payment is only funded from Ironwood | README, SPEC §3, API.md | `chain.rs` `SpendPolicy` plus `assert_ironwood_funded` | `chain.rs` `ironwood_notes_are_the_only_acceptable_source` and three more; `mock.test.ts` |
| Shield and unshield exist | README, API.md | `walletd.ts`, `mock.ts`, `autoshield.ts`; `POST /shield`, `/unshield` | `shield.test.ts`; `walletd.test.ts`. **Not exercised on a real chain** |
| Splitting needs several transparent addresses | API.md, `walletd.ts` | `walletd.ts` `shield` refuses a split it cannot perform | `walletd.test.ts` "refuses a split it cannot actually perform" |
| A settled payment yields a signed receipt | SPEC §9 | `verifier.ts` `receipts` option | `server.test.ts` "receipts are issued at settlement" |
| Every wallet listed as Ironwood-verified cites a version and date | Site, TOOLCHAIN | `apps/site/app/index.html` `WALLETS` | Sources in `TOOLCHAIN.md`; data, not code |
| The dashboard claims no PCZT flow | Site | Removed | Grep for `signPczt` finds none |
| The NEAR rail is implemented, dry-run only, no live funding | README, RAILS, site | `rail.ts` | `rail.test.ts`; the sentence is identical in all three |
| A dry NEAR quote works against the real response shape | RAILS | `rail.ts` `quote`, `rails/interface` `depositAddress?` | `rail.test.ts` "survives a dry response that omits the deposit address" |
| The Agent Card is served at `/.well-known/byte-agent.json` | API, site | `card.ts` `WELL_KNOWN_PATH` | `card.test.ts` fallback (3) |
| The GAP_AUDIT counts are the counts of its rows | GAP_AUDIT | `scripts/gap-counts.ts` | `stats-consistency.test.ts` |

---

## Findings

### Fixed during the audit

**A reference to the conceptual inspiration named in the original brief** appeared once, in
`DECISIONS.md`, as part of the reasoning for choosing MIT. It was not copied content, but it
named a third-party project for no benefit to a reader. Rewritten without it.

### Checked and clean

- **"Orchard" appears 5 times in docs.** Every one is legitimate: the `wrong_pool_source`
  refusal path (SPEC §8, README), the ZIP 316 typecode registry (TOOLCHAIN ×2), and the
  `orchard` crate's own name. **Nowhere is Orchard described as a pool Byte uses.**
- **Fee statements agree.** README, DECISIONS #6 and #6b, API.md and `core/src/fee.ts`
  all say the same two things in the same words: Byte's protocol fee is zero, and the
  optional facilitator fee is enforced by the facilitator's verification rather than by
  the chain. None of them says "free". RAILS states NEAR's 0.25% is theirs and passed
  through, and that no rail charges or collects the facilitator fee.
- **Test counts are real, and machine-checked.** `pnpm stats` runs `vitest` and `cargo test`
  and writes `docs/STATS.json`; README, the site and this file carry the numbers inside
  markers, and `stats-consistency.test.ts` fails on any disagreement or any hand-typed count.
  This section used to say 352 + 56 = 408 while the real total was past 500.
- **Every package named in the README exists.** All 15 resolve to a real `package.json`.
- **Every adapter and rail has a test file.** The one source file without one is
  `packages/rails/interface`, which is types only and has no behaviour to test.

### Known gaps, stated rather than resolved

These are real and are documented where a reader will meet them, not only here.

| Gap | Where it is disclosed |
|-----|----------------------|
| Only x402 has been proven on a real chain; MCP, A2A/AP2 and LangChain are proven against the mock | ROADMAP "Next", TESTNET_RUNS |
| The memory store loses replay protection on restart | `MemoryInvoiceStore` class doc, SECURITY §5.3, ROADMAP |
| librustzcash has never tested Ironwood as a source pool, and Byte spends from it | TOOLCHAIN, SECURITY §5.5, ROADMAP |
| Verification is not a consensus judgement | SPEC §7, SECURITY §5.4, ROADMAP |
| The destination is bound by the memo, not read from the note | SECURITY §5.6, ARCHITECTURE, API |
| Mainnet is specified but untested and unclaimed | README, SPEC §2, ROADMAP |
| The NEAR rail has never moved live value | RAILS |

---

## The standard applied

A thing is "supported" only if it has code **and** a passing test. Everything else is
**Planned**, which is stated to mean *not implemented and not claimed*.

The planned list is in the README, RAILS.md and ROADMAP.md, and the three agree.
