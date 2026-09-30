# Testnet runs

Real transactions on Zcash testnet, logged as they happen. Everything here is verifiable
on a testnet explorer.

TAZ has no monetary value. These runs prove the mechanism, not custody of anything.

---

## 2026-09-29 — first shielded Ironwood payment

**Environment**

| | |
|---|---|
| Network | `zcash:05a60a92d99d85997cce3b87616c089f` (testnet) |
| Light server | `https://testnet.zec.rocks:443` |
| Chain height at start | 4,413,005 |
| NU6.3 activation (testnet) | 4,134,000 — so Ironwood is live on this chain |

**Funding**

0.1 TAZ (10,000,000 zatoshis) received from the Jino Labs faucet into

```
utest1xghzan2ngrekdl2pw3cfnu8cnkucmvezevcvlc59jckjhpra6ykkrvmjq9xelp5t9692kmh63e7uurzqvckvv6xy4g3nrl6c35jxjxcu
```

Reported by `GET /balance` as:

```json
{"spendableZat":"10000000","pendingZat":"0","unusableZat":"0"}
```

`unusableZat: 0` is the meaningful part — the funds arrived **shielded, directly into
Ironwood**, not transparent. Nothing had to cross a pool to become spendable.

**Invoice**

| Field | Value |
|-------|-------|
| `invoiceId` | `a4f23e7556fc9566f78673c8ebc52d3d` |
| `payTo` | `utest1nmxcdnkh7e2lq4dqzaj22r4j0zzy37lr3y4vtjw23el3t4wte78plujfgkjda2mjy9we4ay4hk3cfegp0zk29rhx2gs6r0k7f57jzxxx` |
| `amountZat` | `1000000` |
| `memo` | `BYTE1\|a4f23e7556fc9566f78673c8ebc52d3d\|e62bbedfa6163d6a036aed7c0be475f2` |

`payTo` is a freshly diversified unified address, minted for this invoice alone, with an
Orchard-typecode receiver and no transparent receiver.

**Payment**

```
POST /send
  → txid 15a1ded9e252cfff784aae08add4a79b52424fc91bd304d96bcf41322e768369
    fee  10000 zatoshis (ZIP 317)
```

The Sapling proving parameters were downloaded on this first send, as expected: about
50 MB, once, into the standard Zcash parameter directory. Byte builds Ironwood-only
transactions, but `create_proposed_transactions` requires a Sapling prover in its
signature regardless.

Balance immediately after broadcast:

```json
{"spendableZat":"9990000","pendingZat":"0","unusableZat":"0"}
```

10,000,000 − 10,000 = 9,990,000. The fee, and nothing else, left the wallet — this run was
a send to the wallet's own invoice address, so the payment value returned as a note.

**Verification**

Mined in block **4,413,018**. Read back through `GET /notes?txid=…`:

```json
[
  {
    "txid": "15a1ded9e252cfff784aae08add4a79b52424fc91bd304d96bcf41322e768369",
    "pool": "ironwood",
    "valueZat": "1000000",
    "memo": "BYTE1|a4f23e7556fc9566f78673c8ebc52d3d|e62bbedfa6163d6a036aed7c0be475f2",
    "confirmations": 6,
    "height": 4413018
  },
  {
    "txid": "15a1ded9e252cfff784aae08add4a79b52424fc91bd304d96bcf41322e768369",
    "pool": "ironwood",
    "valueZat": "8990000",
    "confirmations": 6,
    "height": 4413018
  }
]
```

Every claim Byte makes about a payment, demonstrated on a real chain:

| Claim | Evidence |
|-------|----------|
| Settles in Ironwood | Both outputs report `"pool": "ironwood"` |
| The memo survives encryption and decryption | The memo read off-chain is byte-identical to the one issued |
| Change does not cross pools | The 8,990,000 change output is also Ironwood, so no net value crossed and nothing was revealed under ZIP 318 |
| Confirmations are reported honestly | 6, derived from the mined height |
| The memo binds the invoice | `POST /memo/verify` returns `{"valid":true}` for the issued invoice and `{"valid":false}` when the amount is changed to 999999 |

The change output carries no memo, which is correct: it is a payment to self, not an
invoice settlement.

**A bug this run caught**

The first read of the mined transaction returned `[]`, even though the transaction existed,
was mined, and carried the right memo.

Zcash displays a txid **byte-flipped** relative to its internal representation — `TxId`'s
own `Debug` impl notes the flipped string "is more useful than the raw bytes, because we
can look that up in RPC methods and block explorers". Byte's `parse_txid` hex-decoded the
displayed txid and passed the bytes straight to `TxId::from_bytes`, which expects internal
order. Every lookup therefore asked for a transaction under a name that does not exist, and
got silence rather than an error.

Fixed in `crates/byte-walletd/src/chain.rs`, with two regression tests:
`round_trips_a_displayed_txid`, and `a_displayed_txid_is_not_its_own_internal_bytes` so the
reversal cannot be quietly dropped without a test noticing.

Unit tests did not catch this because both the writer and the reader of a txid were Byte's
own code, agreeing with each other and disagreeing with the chain. Only a real transaction
could expose it.

---

## 2026-09-29 — the x402 adapter, end to end

The second run exercises the **whole stack against a real chain**: the x402 adapter, the
invoice issuer, the payment verifier, the spend guard, the `WalletdWallet` backend and the
`byte-walletd` sidecar. The first run proved the sidecar could pay; this one proves the parts
above it agree with each other and with consensus.

Run with `BYTE_TESTNET=1 pnpm test:testnet`.

```
01. Connect to byte-walletd
    network zcash:05a60a92d99d85997cce3b87616c089f
    synced true at block 4414380
    spendable 9990000 zat

02. Start a seller gated by the x402 adapter
    listening on http://127.0.0.1:51681, price 50000 zat

03. Buy the resource with a real shielded payment
    first retry answered 402 (pending) — as expected
    the payment is broadcast; waiting for it to be mined
    still 402 (pending)…
    settled by 49ab740ba55117946e7af7097cdb4c0d86bbf0cbd3e33a6489f74565113aa712 in 65s

04. Read the payment back off the chain
    ironwood       8870000 zat  2 conf  (no memo)
    ironwood         50000 zat  2 conf  BYTE1|0ba01200d1ee48741531cd80c627bd6c|0ece36d2088bbeac0541d92d98c83df8

05. Result
    resource served: 1 time(s)
    every output in the Ironwood pool: yes (2 output(s))
    memo survived the chain: yes
    guard decisions: 1, spent 50000 zat
```

**txid `49ab740ba55117946e7af7097cdb4c0d86bbf0cbd3e33a6489f74565113aa712`**, 65 seconds from
request to settlement.

Both outputs — the 50,000 payment and the 8,870,000 change — are in Ironwood. Nothing crossed
pools, so no net amount was revealed under ZIP 318. The change output carries no memo, which
is correct: it is a payment to self, not an invoice settlement.

### `402 pending` is not a failure

The seller answered `402 pending` twice before serving. That is the documented behaviour of
`minConfirmations: 1` meeting a 75-second block target, and seeing it happen on a real chain
is worth more than the mock's version of it: the client paid **once** and then waited,
re-presenting the same proof until the payment confirmed.

### A bug the mock could never have caught

The first attempt at this run failed:

```
byte-walletd /send returned 502 (send_failed):
  building proposal: Insufficient balance (have 0, need 60000 including fee)
```

The error is correct — the first send had consumed the only confirmed note and the change was
still in flight — but it was hiding something worse. The script polled for confirmation by
calling the *paying* fetch again, which builds a **new payment** every time. With more
confirmed funds it would simply have paid twice.

A client waiting for confirmation must re-send its claim, never its money. Fixed by capturing
the `PAYMENT-SIGNATURE` header from the first attempt and re-presenting that same proof.

On a deterministic mock chain, blocks appear on demand and a second payment always succeeds.
Only real confirmation latency exposes this. It is the clearest argument in this repository
for running against a real chain rather than trusting a green test suite.

The protocol itself behaved correctly throughout: the payer paid once, the seller answered
`402 pending`, and the wallet refused to overspend rather than doing something unsafe.

### Limitation

Both roles ran against one wallet — the seller minted invoice addresses from the same sidecar
the buyer spent from. This does **not** prove two separate wallets can transact. It proves the
adapter, the issuer, the verifier and the sidecar agree with each other and with the chain.

---

## 2026-09-30 — paid from a browser, through a third-party wallet

The first two runs both went through `byte-walletd`, the sidecar I wrote. This one does not.
A person opened <https://byte-lime.vercel.app/app/>, connected the **Noir** browser
extension, built a Byte invoice in the page and paid it. No sidecar, no terminal, no key
held by anything of mine.

That is the part worth recording: a wallet I did not write, driven by a person who is not
me, settled a Byte-format invoice from a web page.

| | |
|---|---|
| Wallet | Noir extension, testnet build |
| Amount | 0.001 ZEC (100,000 zatoshis) |
| Recipient | a `utest1…` shielded address, ending `vcj0qg` |
| Broadcast | 2026-09-30, 11:57 local |
| txid | `711d4d7ce97c757a3a036cfc7d1d0597a59ef02361d0c1f6fbf381cc9fd8f1bf` |

An earlier payment the same day, to the wallet's own address, is
`0dad3c53f7da679193379c45b6075cb5f34a034d866bde903950e6bd342e29bc`.

The page built a ZIP 321 URI carrying a `BYTE1|…` memo, handed it to Noir through
`zcash_sendTransaction` with `fundingSource` pinned to `shielded`, and Noir signed and
broadcast it. Nothing in the browser ever saw a spending key.

### What this run does not prove

Being specific, because it would be easy to read more into this than it carries.

- **No seller verified the payment.** The page builds a *practice* invoice with a fixed demo
  key, so the memo is well-formed but no Byte server issued it and nothing marked it paid.
  This proves the wallet leg, not the settlement leg. Runs 1 and 2 prove the settlement leg.
- **The memo was not read back off the chain.** Runs 1 and 2 did that with a viewing key.
  Here the browser holds no viewing key, so the evidence stops at a broadcast txid.
- **The recipient address is recorded only as the wallet displayed it**, truncated. I did not
  keep the full address, so this entry cannot assert who was paid.

### Closing these three gaps

All three limits above come from the same cause: a static page has no wallet and no viewing
key, so it can neither issue an invoice nor read a payment back. `pnpm seller:testnet` runs
one that can — a real `InvoiceIssuer` and `PaymentVerifier` against the sidecar — and serves
the dashboard from its own origin, which is also what keeps a browser from refusing an HTTPS
page's calls to an HTTP seller as mixed content.

With it running, the page fetches a real invoice, the wallet pays it, and the seller verifies
it and reads the payment back off the chain with its own viewing key, reporting the pool, the
value, the confirmations, the memo and the full recipient address.

The routes are tested against the mock chain in `scripts/seller-routes.test.ts` (16), so the
seller is not a thing whose only trial is a live run with real money. **A run through it is
not yet logged here**; when one happens it belongs below, with its txid.

### Four defects this run caught

None of these could have been found by the test suite. Every one of them needed a person,
a browser and a wallet that behaves like a real wallet.

| Symptom | Cause | Fix |
|---|---|---|
| The pay box was invisible until a balance loaded, and inputs were unreadable | dark-theme styles left on a light page, and a panel ordered below a long table | pay box first, light inputs, revealed as soon as the wallet connects |
| "Reading your balance" forever | a second `zecToZat` later in the file silently replaced the first, so the balance reader called a strict converter that throws on 0, and the error was swallowed | renamed to `practiceZecToZat`; the balance path now never swallows an error |
| Spendable shown as `0` beside a wallet plainly holding 1 ZEC | the reader looked only at the top level of the reply; this wallet nests its figures | walks the whole reply, skips other assets, matches names by normalized form. 24 tests, extracted from the page itself |
| Four different raw wallet errors shown verbatim | no translation layer | wrong network, expired transaction, unfinished scan and insufficient funds each explained, with what to do |

The third one is the one I would flag to anyone building something similar. Reporting `0`
when the honest answer is *I could not read it* is worse than reporting nothing: it is a
confident false statement about someone's money. The page now prints the wallet's raw reply
and says it could not read it.

### A wallet bug, not a Byte bug

Several attempts failed with:

```
WALLET_SPENDABILITY_INCONSISTENT: account 1 has 1 confirmed note(s)
with incomplete spendability metadata totaling 9865000 zatoshis
```

Noir's own v1.0.37 release notes (23 September 2026) read: *"Fixed transient spendability
metadata errors triggering unnecessary full wallet rescans during active sync."* So this is a
known wallet defect with a shipped fix, and no amount of rescanning helps on an older build.

The dashboard now reads `window.noirwallet.version` and warns **before** a send when it is
older than 1.0.37, rather than letting the payment fail for an unexplained reason.

Checking that release history also corrected a claim of mine. The wallet table said Noir
added Ironwood support in "v0.1.26, 27 Jul 2026". The repository publishes no `v0.1.x`
release at all — its tags start at `v1.0.3`. Ironwood is named in **v1.0.26 (23 Jul 2026)**
and **v1.0.27 (28 Jul 2026)**. Corrected in `docs/TOOLCHAIN.md`, which also records what the
old row claimed and that it was wrong.
