# Chain runs

Real transactions, logged as they happen and verifiable on a block explorer.

**Read the network on each run.** They are not all the same chain, and the difference
matters: TAZ has no monetary value, so a testnet run proves a mechanism and nothing about
custody, while a mainnet run moved real ZEC and carries the weight that goes with that.
This file was called `TESTNET_RUNS.md` until the mainnet runs landed, which would have
invited exactly the wrong reading.

| Run | Date | Network | What it showed |
|-----|------|---------|----------------|
| 1 | 2026-09-29 | **testnet** | The sidecar can pay an Ironwood invoice, and a txid is byte-flipped when displayed |
| 2 | 2026-09-29 | **testnet** | The x402 adapter, issuer, verifier and sidecar agree with each other and with consensus |
| 3 | 2026-09-30 | **testnet** | A browser wallet can pay a Byte-format invoice. Wallet leg only |
| 4 | 2026-09-30 | **MAINNET** | Two separate wallets, a real seller verifying, and the defect that made third-party payments impossible |
| 5 | 2026-09-30 | **MAINNET** | A fee-carrying invoice settling in one transaction, both outputs |
| 6 | 2026-09-30 | **MAINNET** | The split-signing round trip: built, reviewed, signed, proved and broadcast as a PCZT |

---

## Run 1 · testnet · 2026-09-29 — first shielded Ironwood payment

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

## Run 2 · testnet · 2026-09-29 — the x402 adapter, end to end

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

## Run 3 · testnet · 2026-09-30 — paid from a browser, through a third-party wallet

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

### One of these was not a limitation

The line in run 2, repeated in this one, that both roles ran against one wallet, reads like
a narrowed claim. It was concealing a defect that made Byte unable to accept a payment from
anybody at all. Found on 2026-09-30 by the mainnet run below, and fixed there.

### Closing these three gaps

All three limits above come from the same cause: a static page has no wallet and no viewing
key, so it can neither issue an invoice nor read a payment back. `pnpm seller` runs
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

---

## Run 4 · MAINNET · 2026-09-30 — two separate wallets, and the defect only this could find

The first Byte payment on **mainnet**, and the first paid by a wallet that is not the
seller. Asuzu's call to move here, over my advice, and it was the right call: the run found
a defect that made Byte unable to verify a payment from anyone else's wallet at all.

| | |
|---|---|
| Network | `zcash:00040fe8ec8471911baa1db1266ea15d` (mainnet) |
| NU6.3 activation | 3,428,143, so Ironwood is live |
| Light server | `https://zec.rocks:443` |
| Payer | Noir, `u1s5v6…dprs79`, funded by Asuzu |
| Seller | a `byte-walletd` whose seed was generated an hour earlier and which held nothing |
| Invoice | `9831c7896fd7cf3e83df3dd828f096ba`, 100,000 zat |
| txid | `a6eb7a4e2845d16ffeaae78a672334c66754e8e809bc2d2861e453826ca35a94` |
| Mined | block 3,501,656, fee 10,000 zat |

Paid to, in full, and minted for this invoice alone:

```
u1cehhzpjevhu6mrmaxs8qkucygrlumsm6myzc4j3fct6m9w202pyqydvfq4tl67ngrckz3jurgx2yxgadaj0gs7mxajpeeqvtkgeqcrjt
```

Read back off the chain with the seller's viewing key:

```json
[{"txid":"a6eb7a4e2845d16ffeaae78a672334c66754e8e809bc2d2861e453826ca35a94",
  "pool":"ironwood","valueZat":"100000",
  "memo":"BYTE1|9831c7896fd7cf3e83df3dd828f096ba|f22e57dcd8840a5105a248417054516a",
  "confirmations":11,"height":3501656}]
```

The memo is byte-identical to the one the payer's wallet displayed. `everyOutputInIronwood`
is true: nothing crossed a pool, so ZIP 318 revealed no net amount. A second settle attempt
was refused as `replay`, which is the invoice behaving correctly.

| Limit recorded by the earlier browser run | Closed by |
|---|---|
| No seller verified it | A real `PaymentVerifier` checked the amount, the memo binding and the confirmations against the invoice it had issued |
| The memo was not read back off the chain | It was, with the seller's viewing key, and it matches |
| The recipient was recorded truncated | Recorded in full, above |

And one no previous run could claim: **two genuinely separate wallets**. Runs 1, 2 and 3 all
had one wallet paying itself.

### It works twice, and the second time nobody touched it

A second payment, an hour later, through the same seller:

| | |
|---|---|
| Invoice | `14c009b5598a6a0826b3b2789cdad538` |
| txid | `488751f9280d8d50b5c0ffa68eb7477fe6b477d88fc1967e5857c1edec319324` |
| Mined | block 3,501,706 |
| Memo read back | `BYTE1\|14c009b5598a6a0826b3b2789cdad538\|719822ce9995482184ac34d640e013b2` |

This one matters more than the first. The first needed the sidecar restarted before the fix
took effect. This one ran the whole path unattended: issue, pay from a separate wallet, scan,
fetch the full transaction, decrypt the memo, verify. The seller's log reads

```
pending → pending → pending → SETTLED
```

`pending` is "seen, waiting for confirmations". Before the fix below it said
`invalid_payment`, and would have said it forever.

### The defect: Byte could not verify a payment from anyone else

The first attempt failed. The payment was mined, confirmed, in Ironwood, for the right
amount, at the right address, and the verifier answered `invalid_payment` every time.

The wallet database said why:

```
ironwood_received_notes: value 100000, memo NULL
transactions:            mined_height 3501656, raw NULL
```

A light wallet scans **compact blocks**, and a compact block deliberately omits memos: it
carries only enough of each output to trial-decrypt it. The memo arrives only if the wallet
afterwards downloads the whole transaction and decrypts it, a step called **enhancement**.
`byte-walletd` never did. `raw NULL` is that, recorded.

So the note arrived, decrypted, and had no memo. A Byte memo is what binds a payment to an
invoice, so with no memo there is nothing to verify, and the payment is indistinguishable
from a stranger sending money for no reason.

**Every payment Byte had ever verified was one it had also sent.** The memo was already in
its own `sent_notes` table, and no enhancement was needed. The defect was invisible for as
long as, and only as long as, Byte was talking to itself.

Fixed in `chain.rs` by `enhance_transactions`, which drains the backend's own queue of
outstanding data requests rather than guessing: `Enhancement` answered with the raw
transaction through `GetTransaction` and `decrypt_and_store_transaction`, `GetStatus` with
whether the chain has it, and a transaction the server cannot supply reported as such rather
than left pending forever. The transaction is parsed against the consensus branch in force
at the height it was mined, not the tip's.

The fix needed no second payment. On the next sync the queue was drained, the memo appeared,
and the seller settled the invoice that had been failing for twenty minutes.

### Why nothing caught it

- **The test suite could not.** The mock chain has no notion of a compact block, so a mock
  memo is simply present. 844 passing tests had nothing to say about this.
- **The earlier runs could not.** Runs 1 and 2 each record that both roles ran against one
  wallet. I wrote that as a narrowed claim. It was hiding a defect.
- **A second `byte-walletd` as payer would not have.** It would have been a different wallet
  and the same code, and the receiving side would still have had the memo in `sent_notes`.

Only a wallet that Byte did not write, paying it over a real light-client connection, could
expose this. That is the argument for this run, and it is worth more than the run's own
result.

---

## Run 5 · MAINNET · 2026-09-30 — a fee-carrying invoice, settled in one transaction

The last claim in this repository that rested on mock tests alone. Byte's facilitator fee is
a **second output on the same transaction**, not a separate payment, and that shape had never
touched a real chain.

It mattered because the same feature had already been broken once in a way the suite could
not see: the issuer produced fee-carrying invoices, the verifier checked them, and Byte's own
client could not pay a two-output invoice at all. Every test passed, because both sides were
mocked and agreed with each other.

| | |
|---|---|
| Network | mainnet |
| txid | `bf7f7ea4955f3dc8e22c23aca874a05906e85e5bc01c0a6342dc048ae315f6eb` |
| Invoice | `aa6e350071be3738aeb280a196294bfd` |
| Payee owed | 50,000 zat |
| Facilitator fee | 1,250 zat at **250 bps (2.5%)** |
| Network fee | 15,000 zat (ZIP 317) |
| Time to verification | 379s |

The ZIP 321 request handed to the payer, in its indexed multi-payment form:

```
zcash:u1ey6xued…?amount=0.0005&memo=QllURTF8…&address.1=u1jhlkz7n…&amount.1=0.0000125
```

Read back off the chain:

```
ironwood     50000 zat  1 conf  BYTE1|aa6e350071be3738aeb280a196294bfd|4aab40727ac2890c1beb08fad8bca14f
ironwood     17500 zat  1 conf  (no memo)
ironwood      1250 zat  1 conf  (no memo)
```

Six claims, each checked against what the chain did rather than what the script hoped:

| Claim | Evidence |
|---|---|
| Settled in one transaction | 3 outputs, all under one txid |
| The payee leg carries the binding memo | 50,000 zat with `BYTE1\|aa6e3500…` |
| The fee leg carries none | 1,250 zat, no memo. A memo there would be a second place an invoice identifier could leak to a third party |
| The fee matches the published rate | 250 bps of 50,000 is 1,250 |
| Every output is in Ironwood | 3 outputs, no pool crossed, nothing revealed under ZIP 318 |
| The verifier accepts it | Checked the amount, the memo **and** that the fee arrived |

**Limitation, as the script prints it:** the fee is enforced by the facilitator's
verification and by nothing else. Zcash has no contracts, so a payer who pays the payee
directly and skips the facilitator skips the fee. This shows the transaction shape, not an
enforcement Byte does not have. Both roles also ran against one wallet, so it shows the
shape and not two parties; the mainnet run above is what shows two parties.

### Two attempts, and what the first one cost

The first attempt paid, then failed to verify:

```
this invoice carries a facilitator fee, but the verifier has no viewing key for the
fee address and therefore cannot confirm the fee was paid
```

The verifier was right. Seeing a payee's invoice outputs and seeing your own fee output are
two viewing keys, not one, and a verifier that cannot check a fee refuses rather than waving
the payment through. The script had simply never passed `feeWallet`. 66,250 zatoshis moved
to establish that.

So the script now asks the verifier whether it could check this invoice **before** any money
moves. The probe uses a txid that cannot exist, where every healthy answer is a refusal —
`pending`, or `invalid_payment` — and the single answer worth stopping for is the verifier
saying it lacks a viewing key, because that is a statement about its own wiring that no
payment will ever change.

The first version of that guard was itself wrong: it treated `pending` as a fault and
aborted a healthy run. That cost nothing, because it aborted before spending, which is the
entire argument for putting the check there.

---

## Run 6 · MAINNET · 2026-09-30 — a PCZT built, signed, proved and broadcast

`docs/GAP_AUDIT.md` said, for as long as this repository has existed, that **no PCZT had been
built, signed, proved and broadcast on a real chain**. It says so no longer.

| | |
|---|---|
| Network | mainnet |
| txid | `675fdde8fc7de2f3651f27bab4665d3e2c1f18acc88de29f38575b398e0cdc43` |
| Command | `pnpm pczt:run` |
| Fee | 10,000 zat |

A PCZT is a transaction built in one place, authorized in another and broadcast from a third.
Each stage can be tested alone; what matters is whether the stages agree, and only a real run
answers that.

```
create   4,900 bytes   a PCZT from the same proposal /send builds      no key
review                 read independently; matched the builder          no key
sign     4,964 bytes   policy checked in full, then signed        ← the only stage with the key
prove   12,230 bytes   the Ironwood proof added                         no key
extract                proof verified, transaction rebuilt, broadcast   no key
```

**Four of the five stages need no spending key.** That is the whole point of the exercise: one
machine can decide what to pay while another holds the key and does nothing but read a
transaction and answer yes or no.

The run checks six claims and all six held. The one worth naming is the cap: the signer was
first offered a cap **one zatoshi under** the transaction's total and refused it, then the
exact total and signed. A policy only ever tested with a passing value has not been tested,
because it would look identical if it were never consulted.

### The policy measures the wrong thing, and here is exactly why

The first attempt at this run **failed, correctly**, and the failure is the more useful half.

The allow list named the payee. The signer refused, because the transaction has two outputs:
the 50,000 zat payment and 40,000 zat of **change** returning to the wallet. The signer saw an
output nobody had authorized and stopped, which is the behaviour anyone would want.

It also makes the allow list unusable. Change goes to an address minted per transaction, so a
caller cannot name it in advance, and almost every real transaction has change. The same
applies to `maxTotalZat`, which sums every output: a cap set to what you intend to *pay* will
refuse, because the total includes what is coming back to you.

The fix is to exempt change, and it is **not built**. An earlier version of this entry said
it could not be built, which was wrong, and the mistake is worth recording because it is the
kind that quietly becomes permanent.

A PCZT output carries `zip32_derivation`, the field that says "the spending key for this
output is at this path" and therefore marks it as the wallet's own. In `orchard` 0.15.5 that
field is `pub(crate)` with no accessor, so a signer cannot read it *out of the PCZT*. I
concluded from that the information was unavailable and stopped looking.

It is not in the PCZT; it is derivable from a key the signer already holds.
`orchard::keys::IncomingViewingKey::diversifier_index(&Address)` returns `Some` for an address
belonging to that key. Feed it each reviewed recipient and the ones that answer `Some` are the
wallet's own. The allow list and the cap then apply to the rest, which is what a person means
by both.

One consequence worth stating: `split_sign::review` is currently pure and needs no key, which
is a property worth keeping. The exemption needs a viewing key, so it belongs at the layer
that has one — the `/pczt/sign` route — rather than in `review`. A signer holding a spending
key holds the viewing key too, so nothing is weakened by putting it there.

So the mechanism works, the run above demonstrates a cap enforced on a real chain, and what it
measures is not yet what a person means by it. Not blocked; unbuilt. The feature stays
`Partial` until it is built and re-run.

### What this still does not prove

Every stage ran against one sidecar, which is what one machine can demonstrate. It shows the
stages agree. It does **not** show the key was ever somewhere the builder could not reach:
splitting the process across two hosts is a deployment question, and nothing here answers it.
