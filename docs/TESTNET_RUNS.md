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
