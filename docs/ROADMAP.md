# Roadmap

What exists, what is next, and what is deliberately not being built.

Nothing in the "done" column is listed without code and a passing test. Everything else is
marked **Planned**, which here means *not implemented and not claimed*.

---

## Done

| | |
|---|---|
| The `byte-zcash-shielded-v1` scheme | Normative spec, memo codec, ZIP-321, receipts |
| Shielded Ironwood settlement | Proven on testnet — [TESTNET_RUNS.md](TESTNET_RUNS.md) |
| `byte-walletd` | Diversified addresses, chain sync, send, view-only verification |
| Invoice issuance and verification | Every failure in SPEC §8 tested |
| The spend guard | Per-call cap, daily cap, allowlist, approval hook, audit log |
| View-only facilitator | Cannot spend, enforced by type |
| Agent Cards | Signing, verification, well-known resolution |
| Adapters | x402 v2, MCP, A2A/AP2, LangChain |
| NEAR Intents rail | Dry-run, with the transparent leg documented everywhere |
| Owner-only API and console | Invoices, balances, guard decisions |

---

## Escrow: deliberately not built

The brief asks for arbiter-based escrow for agent jobs. It is documented rather than built,
and this records why so it reads as a decision and not an omission.

**Mode A, shielded 2-of-3 with FROST.** Not feasible today. `ZcashFoundation/frost` has
`frost-core` and ciphersuites for ed25519, ed448, p256, ristretto255, secp256k1 and
secp256k1-tr, plus `frost-rerandomized`, but no Pallas or Orchard ciphersuite. `reddsa`
0.6.1 has `batch`, `orchard` and `sapling` modules and no FROST module; its docs say the
support "will be provided by the frost repository", which does not provide it. A ZCG grant
application for a shielded multisig SDK exists, which is to say this is future work by
someone else.

**Mode B, transparent 2-of-3 P2SH.** Works today. It publishes the amount and all three
addresses. Byte's entire claim is that agent payments do not do that, and shipping an escrow
feature that does would put a public ledger of every job next to a privacy pitch. Choosing
not to build it was a decision made with the trade-off in view.

**What is buildable, and not built:** the off-chain job state machine
(`created → funded → delivered → released | refunded | disputed → resolved`) with a
`JobStore`, timeouts and signed transitions, funded by ordinary shielded payments and
released by an arbiter's policy. It gives up on-chain enforcement, which Zcash cannot offer
anyway, and keeps everything private. It is the next thing to build if escrow matters to a
user.

## Next

### A Redis store, for several processes sharing one payee

**Done, differently: durability now ships on SQLite.** The memory store lost consumed-invoice
records on restart, which re-opened the replay window for anything still inside its expiry.
`createSqliteStores` keeps them on disk, and `consume` there is a single conditional
`UPDATE ... WHERE consumed_at IS NULL`, so the test and the write cannot come apart.

SQLite was chosen over Redis because it needs no dependency and no server: a payment library
that requires infrastructure before it can refuse a replay will be deployed without it.

What is still open is the case SQLite does not serve: **several processes sharing one payee**.
That wants Redis, behind the same interface and the same contract suite, with `SET … NX`
doing the work the conditional `UPDATE` does now.

### Submit the Zcash scheme to x402

There is no Zcash scheme in the x402 repository — `specs/schemes/exact/` covers EVM, SVM,
Aptos, Cardano, Stellar, Sui, TON, XRPL and Lightning, but not Zcash. Byte's adapter is
already written in that repository's shape, which was the point. The remaining work is a
`scheme_exact_zcash.md` written to their template.

### Mainnet

Not until the Ironwood-era tooling is less young, and not without an audit. The network
identifier is specified so the constant is not invented later, but no mainnet path is tested
and none is claimed.

### A real end-to-end run through every adapter

Each adapter proves its loop against the mock. Only the core loop has been proven against a
real chain. Running each adapter against testnet would close that gap.

---

## Deliberately not being built

### A wallet browser extension

The hard part of Byte — spending from and verifying against the Ironwood pool — cannot happen
in a browser. An extension would have to call the sidecar anyway, making it a UI skin over the
console that already exists. It is a reasonable v2; it is not protocol work.

### Most funding rails

Each unimplemented provider is named in [RAILS.md](RAILS.md) with the reason. The short
version: almost all of them deliver to a transparent address, so they carry the same exposure
as the NEAR Intents rail with more operational surface and, in most cases, KYC.

A provider moves out of that table only when it has an implemented rail, a test suite against
mocked HTTP, and a stated `transparentLeg`.

### Anything that would make the privacy story worse

Not a schedule item so much as a standing constraint, but worth writing down: Byte will not
add a feature that quietly crosses pools, reuses an address across invoices, or reports a
balance it does not actually know. Several of those would be easy and would make demos
smoother.

---

## Known risks carried

These are not roadmap items because Byte cannot fix them. They are carried, and written down
so they are not carried silently.

- **librustzcash has never run its shielded-pool test suite with Ironwood as the active
  pool** ([#2617](https://github.com/zcash/librustzcash/issues/2617)). Rewind and reorg
  behaviour, spendability windows and change handling are untested for Ironwood as a source
  pool. Byte spends from Ironwood.
- **Verification here is not a consensus judgement.** librustzcash says plainly that its APIs
  do not check consensus validity. Byte establishes that a note was received, in which pool,
  for how much, carrying which memo — nothing stronger.
- **The transparent funding leg is public and unfixable** at the rail layer. See
  [SECURITY.md](SECURITY.md) §2.3.
- **Timing is not hidden.** That a shielded transaction happened, and when, is public.
