# Byte Protocol

**A privacy layer for AI agent payments, settling in shielded Zcash.**

I built Byte because agent payments today are transparent by default. When two agents settle
on a public chain, the amount, both balances and the whole counterparty graph are readable by
anyone — including a competitor who wants to know what your agent spends on inference, what
you charge, and who your customers are. That information is not incidental. It is your
business, published continuously, for free.

Byte settles agent payments in the **Ironwood** shielded pool. An observer of the chain sees
that a shielded transaction happened. They do not see the amount, either party's shielded
address, or any balance.

---

## Status

Hackathon-stage, built for the [ZECATHON](https://thezecathon.com/) in the Shielded Payments
track. It has not been audited, and I would not put money behind it that I minded losing.

**It works on mainnet.** Not only on testnet, and not only between two halves of my own code.
[docs/CHAIN_RUNS.md](docs/CHAIN_RUNS.md) logs five runs; these are the two that carry the most
weight, both on **Zcash mainnet** and verifiable on any explorer:

```
txid   a6eb7a4e2845d16ffeaae78a672334c66754e8e809bc2d2861e453826ca35a94
       Paid from a wallet I did not write, to a seller that verified it.
       Two separate wallets. Repeated unattended by 488751f9…ec319324.

txid   bf7f7ea4955f3dc8e22c23aca874a05906e85e5bc01c0a6342dc048ae315f6eb
       A fee-carrying invoice: 50,000 zat to the payee with the binding memo,
       1,250 zat of facilitator fee with none, one transaction.
```

Every output in both reports `"pool": "ironwood"`, so nothing crossed a pool and ZIP 318
revealed no net amount, and the memo read back off the chain is byte-identical to the one the
payer's wallet displayed.

The earlier testnet runs are still in the log, and still worth reading: run 1 found that a
Zcash txid is byte-flipped when displayed, and run 2 found a payment loop that would have
paid twice given more funds.

**The mainnet run found something the other four could not.** Byte could not verify a payment
from anyone else's wallet at all. A light wallet scans compact blocks, which omit memos by
design; the memo arrives only if the wallet then downloads the whole transaction, and
`byte-walletd` never did. Every payment it had ever verified was one it had also *sent*, so
the memo was already in its own records. The defect was invisible for exactly as long as Byte
was talking to itself. Nothing in <!--stats:total-->876<!--/stats--> tests could have caught
it: the mock chain has no compact blocks, so its memos are simply present.

That is the argument for real runs over a green suite, and it is why the limitations in this
README are written as plainly as the claims.

**<!--stats:total-->876<!--/stats--> tests pass**: <!--stats:ts-->800<!--/stats--> TypeScript, <!--stats:rust-->76<!--/stats--> Rust. They run on
every push, on a clean checkout of a machine that is not mine, along with the build, a check
that every package actually loads as published, the end-to-end demo, clippy, rustfmt, and a
check that the counts in this file still match the suite. No CI job can spend money: the
chain runs are gated behind flags nothing here sets.

---

## How it works

```
  Payer                                             Payee
    │  1. GET /resource                               │
    │────────────────────────────────────────────────▶│
    │                                                 │ mint invoice:
    │  2. 402 + payment requirements                  │  fresh diversified address
    │◀────────────────────────────────────────────────│  + memo binding
    │                                                 │
    │  3. spend guard, then a shielded Ironwood tx    │
    │             ╌╌╌╌╌╌ Zcash ╌╌╌╌╌╌▶                │
    │                                                 │
    │  4. retry, carrying { invoiceId, txid }         │
    │────────────────────────────────────────────────▶│
    │                                                 │ 5. verify with a
    │  6. 200 + the resource                          │    view-only key
    │◀────────────────────────────────────────────────│
```

Two mechanisms do the work, and there are no others. Zcash has no smart contracts and Byte
invents none.

**Shielded Ironwood transactions** hide value and participants. **Viewing keys and encrypted
memos** let a payee — or a view-only facilitator acting for it — prove to itself that a
specific invoice was paid, with nothing published.

Every invoice is paid to a **freshly diversified unified address**, so two payments to the
same merchant are not linkable through the address they arrived at. Each carries a memo
binding `invoiceId ‖ amount ‖ payTo` under an HMAC only the payee holds, which is what lets
the payee recognise its own invoice from the note alone.

---

## A note on Ironwood, and a correction

Byte creates and accepts **Ironwood** outputs only. Orchard was sealed by NU6.3 in July 2026
and is withdraw-only through the ZIP 318 turnstile.

I originally specified this project around "a unified address with an Ironwood receiver". **No
such receiver exists.** The ZIP 316 typecode registry ends at Orchard `0x03`, and Ironwood
reuses Orchard receivers and viewing keys — librustzcash puts it plainly: *"an Orchard ->
Ironwood send is what an ordinary Orchard-source payment to an Orchard receiver becomes once
NU6.3 activates"*.

So an address **cannot** express which pool a payment will land in. Byte mints addresses with
an Orchard-typecode receiver and no transparent receiver, and the verifier reads the pool off
the **received note**. That single fact shapes the whole design; it is documented in
[docs/TOOLCHAIN.md](docs/TOOLCHAIN.md) with its sources.

---

## What is hidden, and what is not

Hidden inside Ironwood: **amounts, balances, both parties' shielded addresses, and memo
contents.**

Not hidden, stated plainly here because a privacy system described only by its guarantees will
surprise someone:

- **That a shielded transaction happened, and when.** Timing correlation is not defeated.
- **Any transparent funding rail.** ZEC on NEAR Intents is *"Partially supported - Transparent
  addresses only"*. Every deposit and withdrawal there is public. This is Byte's largest and
  least reducible leak. The rail is **implemented, dry-run only, and no live funding has been
  performed through it**; if your threat model cannot tolerate a public funding leg, fund the
  wallet with shielded ZEC and do not use it.
- **Anything crossing pools.** ZIP 318: *"The net amount crossing between the pools is revealed
  on-chain."* Byte refuses to cross pools rather than manage this — change stays in Ironwood,
  and a payer whose wallet would have to spend from transparent or Orchard fails with
  `wrong_pool_source` and builds nothing.
- **Whatever an agent publishes about itself** in its Agent Card.
- **Network metadata.** The light server sees your IP and your queries.

[docs/SECURITY.md](docs/SECURITY.md) has the full threat model, the trust assumptions, and the
known limitations — including that librustzcash has never run its shielded-pool test suite
with Ironwood as the active pool, while Byte spends from Ironwood.

---

## Packages

Implemented and tested:

| Package | What it does |
|---------|--------------|
| `@byte-protocol/core` | Scheme types, memo codec, ZIP-321, receipts, amounts, pools, store interfaces |
| `@byte-protocol/wallet` | The wallet contract, a `byte-walletd` backend for the real chain, and a deterministic mock that models the failure modes. Includes `shield`, `unshield` and the auto-shielder for transparent receipts |
| `@byte-protocol/stores` | Invoice and receipt stores: in-memory for tests, and **SQLite for anything durable**. Both run one contract suite; only SQLite survives a restart |
| `@byte-protocol/pricing` | ZEC/USD price sources (NEAR Intents, Kraken) behind staleness and cross-source guards, for invoices priced in USD |
| `@byte-protocol/server` | Invoice issuance, USD-priced invoices, the optional facilitator fee, and payment verification |
| `@byte-protocol/client` | `createByteFetch`, the payer (which pays every output an invoice names), and the spend guard |
| `@byte-protocol/facilitator` | View-only verification as a service |
| `@byte-protocol/registry` | Agent Cards: signing, verification, resolution |
| `@byte-protocol/adapter-x402` | Byte as an x402 v2 scheme |
| `@byte-protocol/adapter-mcp` | Gate an MCP tool behind an invoice; settle one from the client |
| `@byte-protocol/adapter-a2a-ap2` | Byte as an AP2 payment method, carried over A2A |
| `@byte-protocol/adapter-langchain` | LangChain tools: fetch paid resources, check balance, review spending |
| `@byte-protocol/rails` | The funding rail interface; every rail must declare whether its Zcash leg is public |
| `@byte-protocol/rail-near-intents` | Fund from another chain via NEAR Intents. **Implemented, dry-run only, no live funding performed. The Zcash leg is transparent and public.** |
| `@byte-protocol/console` | The owner-only JSON API and the Byte console |
| `crates/byte-walletd` | The Rust sidecar on librustzcash: addresses, sync, send, verify |

**Planned, and not claimed to work:** a Redis store for several processes sharing one
payee, and every other funding rail, each named
with its reason in [RAILS.md](docs/RAILS.md). Nothing above is listed as supported without
code and a passing test behind it.

---

## The trust boundary is a type

A facilitator verifies on a payee's behalf and holds a viewing key, never a spending key.
`ViewOnlyWallet` has no `send`; `SpendingWallet` extends it. A facilitator handed a view-only
wallet cannot move funds even if completely compromised — and the compiler enforces that, not
a paragraph in a README. `ByteFacilitator` refuses a spending wallet at construction, and its
`/info` reports `canSpend: false` so a caller can assert it rather than trust it.

The sidecar does the same: a process configured with `BYTE_WALLETD_UFVK` holds no seed at all,
and the configuration refuses to accept both a seed and a viewing key, so spend capability
cannot be granted by setting one variable too many.

---

## The spend guard

An autonomous agent with a spending key and a bug is a wallet-draining machine. The guard is
evaluated before a transaction is built, so a denial costs nothing and leaves nothing on-chain:
per-call cap, rolling 24-hour cap, host allowlist, approval hook, audit log.

Three decisions where the obvious implementation is wrong:

- **The daily budget is charged at authorization, not settlement.** Counting only settled
  payments means a crash between the two loses the record, and a loop of crashing payments
  spends without limit.
- **An approval hook that throws denies.** Treating an error as approval turns a bug in the
  approval path into unlimited spending.
- **An allowlist does not imply subdomains.** Allowing `example.com` must not allow
  `evil.example.com`.
- **The audit log should outlive the process.** It defaulted to a bounded in-memory ring,
  which dropped the oldest entries silently and lost everything on restart. The entries
  worth having are the old ones, from the process that has since restarted. Pass a
  `FileAuditLog` and decisions are appended to disk, one JSON object per line, with no
  limit and no update path.

---

## What Zcash can't do (yet)

I would rather list these than have a reader find them. Each is a thing people expect from
agent-payment systems on other chains, and each is absent here for a reason about Zcash and
not a reason about effort.

- **Shielded stablecoin transfers.** There is no USDC on Zcash, and ZSAs are not on mainnet.
  Invoices can be priced in dollars, but they settle in ZEC.
- **Fees enforced on-chain.** There are no contracts. The optional facilitator fee is
  enforced by the facilitator's verification, and a payer who bypasses the facilitator
  bypasses the fee.
- **Trustless, code-enforced escrow.** Nothing can lock funds under a condition. A shielded
  2-of-3 escrow would need FROST over the Orchard curve, and the Zcash Foundation's FROST
  workspace ships no Pallas or re-randomized Orchard ciphersuite. A transparent 2-of-3
  multisig would work today and would publish the amounts and both addresses, which is the
  opposite of what this project is for, so I have not built it.
- **On-chain identity and reputation registries.** Agent Cards are signed documents and
  reputation is a function over signed receipts. Nothing is published to a chain.
- **On-chain allowances or operators.** Spend limits live in the spend guard, and in a signer
  that reads a transaction before it signs. No contract enforces them.
- **Public event indexing of shielded activity.** By design. That is the point.

## Fees

**Byte's protocol fee is zero.** No output in any transaction pays me, and there is no
treasury address. Not "free": the Zcash network fee still applies, and it goes to miners.
The first testnet run paid 10,000 zatoshis under ZIP 317; the mainnet runs paid 15,000, which is what a transaction with two payment outputs and change costs.

The one other fee that can exist is the optional facilitator fee below. It is separate from
the protocol fee, off by default, and pays the facilitator rather than me.

### The one fee that exists, and what enforces it

A facilitator verifies payments on a payee's behalf, and some will want to be paid for it.
So an invoice **may** carry a second output paying the facilitator, encoded in the same
ZIP-321 request. It is off by default.

I want to be exact about what holds it up, because this is where most projects overclaim:

> **The fee is enforced by the facilitator's verification, not by the chain.**

Zcash has no contracts. Nothing on-chain requires that second output to exist. What
actually happens is that the facilitator issues an invoice with two outputs, the payer
pays both because the request says to, and the facilitator checks both arrived before it
tells the payee to serve. **A payer who skips the facilitator — pays the payee directly and
asks the payee to verify — skips the fee.**

That is not a hole I have left open. It is what having no contracts means. Anyone
advertising an on-chain-enforced fee on Zcash is describing something that does not exist.

### Pricing in dollars, settling in ZEC

A merchant can price an invoice in USD. Byte converts it to zatoshis once, at issue time,
using NEAR Intents and Kraken, and refuses to invoice if the price is stale or if the two
sources disagree by more than a configured margin.

**Settlement is in ZEC.** There is no shielded stablecoin on Zcash and ZSAs are not on
mainnet. The quote is locked into the invoice and never consulted again, so a payment is
judged against the zatoshi amount alone. That means **the payer and the payee both carry
price risk between the moment the quote is locked and the moment the ZEC is cashed out**.
Byte does not hedge it. The lever is the invoice lifetime: a five-minute invoice carries
five minutes of risk.

---

## Quickstart

Requires Node 20+, pnpm, and — for the sidecar — Rust with a C++ linker.

```bash
pnpm install
pnpm test
```

That runs the whole suite against the mock wallet, including the full 402 loop over a real HTTP
server. No chain, no funds, no configuration.

To watch the protocol run instead of reading about it:

```bash
pnpm demo
```

A buyer agent pays a seller agent for a report, then the demo shows the parts that usually go
unshown: the pool the payment landed in, a replay being refused, and a spend guard stopping a
payment before any value moves.

For the console:

```bash
pnpm console
```

It serves an owner-only page reporting invoices, settlements, balances and the spend guard's
decisions — refusals included, with their reasons. It renders nothing before its token is
accepted, and loads nothing from anywhere else: a page reporting on a privacy protocol should
not be fetching scripts from third parties who would then see every operator who opens it.

For the sidecar and a real payment, see
[crates/byte-walletd/.env.example](crates/byte-walletd/.env.example) and
[docs/CHAIN_RUNS.md](docs/CHAIN_RUNS.md). With a funded wallet and the sidecar running:

```bash
BYTE_TESTNET=1 BYTE_WALLETD_TOKEN=... pnpm test:testnet
```

That runs the whole protocol — x402 adapter, issuer, verifier, sidecar — against real Zcash
testnet, and fails if any output lands outside Ironwood.

```bash
BYTE_TESTNET=1 BYTE_WALLETD_TOKEN=... pnpm seller
```

A real seller: it mints invoices, serves the dashboard from its own origin, and verifies
settlements with its own viewing key. Open it and pay from any Zcash wallet. A wallet with a
web API can be driven by the page; every other wallet pays the ZIP 321 request and you paste
the transaction ID back, which the seller checks the same way. The invoice does not care
which wallet paid it.

```bash
BYTE_TESTNET=1 BYTE_WALLETD_TOKEN=... pnpm run:fee
```

A fee-carrying invoice, settled in one transaction, checked against what the chain did.

**Every one of these takes `BYTE_MAINNET=1` instead, and then spends real ZEC.** Mainnet is a
separate opt-in rather than the absence of a testnet check: a guard reading "refuse unless
testnet" becomes "allow anything" the moment someone deletes a line, and the diff looks
harmless. Setting both is refused rather than resolved, since one of the two answers costs
money.

---

## Documentation

| | |
|---|---|
| [SPEC.md](docs/SPEC.md) | The normative scheme: invoices, memos, verification, failures |
| [SECURITY.md](docs/SECURITY.md) | Threat model, trust assumptions, known limitations |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Why the seams are where they are |
| [TOOLCHAIN.md](docs/TOOLCHAIN.md) | Every version and protocol fact, with its source and date |
| [DECISIONS.md](docs/DECISIONS.md) | What was chosen and why |
| [RAILS.md](docs/RAILS.md) | How value gets in, and what each route exposes |
| [CHAIN_RUNS.md](docs/CHAIN_RUNS.md) | Real transactions, logged |
| [API.md](docs/API.md) | All three API surfaces, with real request and response bodies |
| [ROADMAP.md](docs/ROADMAP.md) | What is next, what is deliberately not being built, what risks are carried |
| [CONSISTENCY_AUDIT.md](docs/CONSISTENCY_AUDIT.md) | Every claim traced to its code and its test |

---

## License

MIT. See [LICENSE](LICENSE).
