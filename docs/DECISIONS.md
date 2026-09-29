# Decisions

Choices that shape Byte Protocol, with the reasoning behind each one and the date it
was settled. Entries are append-only: if a decision is reversed later, the original
stays and a new entry supersedes it.

## Round 1 — 2026-09-29 (Phase 0)

Asuzu (`@Afghanistan8`) answered these after the Phase 0 recon.

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| 1 | Wallet backend | **B — `byte-walletd`, a Rust sidecar on librustzcash** | Syncs over the lightwalletd protocol against a public endpoint, so no full node is required. Gives direct control over per-invoice diversified addresses, memo encode/decode and view-only verification — the three mechanisms Byte depends on. Backend A (Zallet JSON-RPC) was rejected because [zallet#695](https://github.com/zcash/zallet/issues/695) breaks memo lookup on unspent Ironwood notes, which is exactly Byte's verification path. |
| 2 | Scope for v1 | **Defensible core** | `core`, `wallet`, `client`, `server`, `stores`, `facilitator`, `registry`, four adapters (x402, MCP, A2A/AP2, LangChain), the NEAR Intents rail in dry-run, examples, and a real testnet e2e. Everything listed as supported has code *and* a passing test. Remaining adapters and rails are documented as Planned. |
| 3 | Networks | **Testnet only** | One network, fully exercised. Nothing in the repo claims mainnet readiness that has not been proven against a real chain. |
| 4 | Package manager | **pnpm** | Installed 12.6.0 on 2026-09-29. Better workspace ergonomics for a repo with this many packages. |
| 5 | License | **MIT** | Shortest and most permissive, and the least friction for anyone reading or reusing the repository. |
| 6 | Protocol fee in v1 | **Zero** | No fee output, no treasury address, nothing to reconcile across README, SPEC, code and CLI help. Third-party rail fees (e.g. NEAR Intents) are pass-through and are never described as Byte's. |
| 7 | NEAR Intents rail | **Dry-run, with the transparent leg labelled everywhere** | Implemented against mocked HTTP fixtures with `dry: true`. The `t1`/`t3` leg is public and is described as public in README, `SECURITY.md` and `RAILS.md`. No live value moves during judging. |
| 8 | Testnet ZEC | **Asuzu funds on request** | Build proceeds against the mock wallet; the testnet e2e stays gated behind `BYTE_TESTNET=1` plus wallet env vars until a wallet is funded. |
| 9 | "Gemini" | **A2A/AP2 adapter covers Google/Gemini agents; the Gemini exchange is Planned** | Decided by Claude, not asked, as the low-stakes default. No exchange rail is implemented, so none is claimed. |

## Round 2 — 2026-09-29

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| 10 | User interface | **In scope, built here** | The Phase 0 brief said "No UI — Asuzu plugs his own in later". Asuzu clarified that this *is* the UI he meant to plug in, and supplied a visual reference. It is therefore built in this repository against the owner-only JSON API, not left as an integration point. This supersedes the "No UI" instruction. |
| 11 | Visual language | **Dark technical instrumentation**, adapted from Asuzu's reference | Near-black ground, hairline measurement grid, corner-bracket framing, wide-tracked uppercase micro-labels, numbered `01.`–`04.` index markers, a single wireframe focal object. Departure from the reference, at Asuzu's instruction: **type is set bolder and at higher contrast**, because the reference's thin low-contrast grey is attractive but hard to read. Readability wins over fidelity. |

The UI is built after the JSON API it consumes exists, so its screens reflect real
endpoints rather than mock shapes. Ordering: `core` → `server`/`client` → owner-only JSON
API → UI.

## Hackathon constraints these were made under

Recorded from <https://thezecathon.com/> on 2026-09-29.

- Submissions due **2026-10-28 23:59 UTC**. Judging 29 Oct – 22 Nov, winners 23 Nov.
- Entered in **exactly one track**: **Shielded Payments** ($15,000). Grand Prize ($20,000)
  is awarded on top of a track prize.
- Cross-Chain was deliberately *not* chosen. That track asks for routes that reach other
  chains "without unshielding on the way through", and Byte's NEAR Intents rail
  unavoidably unshields on the transparent leg. Entering it would have put our one real
  leak at the centre of the judging.
- Judging criteria, verbatim: privacy ("Leaks are disqualifying, not deductions"),
  usefulness ("Would someone use this on Monday"), execution ("Does it run. Working beats
  ambitious"), originality ("Built for this hackathon, not repackaged").
- Rule 02: all code written inside the build window. This repository was initialised
  empty on 2026-09-29.
- Rule 03: the repository is private now and becomes public on 2026-10-28.
