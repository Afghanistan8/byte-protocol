# API

Three surfaces: the wire protocol between payer and payee, the wallet sidecar's localhost
API, and the owner-only console API.

Every request/response example below is real — taken from the test suite or from a live run.

---

## 1. The payment wire protocol

See [SPEC.md](SPEC.md) for normative detail. Summarised here for a reader integrating.

### 402 — payment required

The payee answers an unpaid request with `402` and Byte payment requirements, base64-encoded
in the `PAYMENT-REQUIRED` header and repeated in the body under `accepts`.

```json
{
  "scheme": "byte-zcash-shielded-v1",
  "network": "zcash:05a60a92d99d85997cce3b87616c089f",
  "amount": "100000",
  "asset": "ZEC",
  "payTo": "utest1nmxcdnkh7e2lq4dqzaj22r4j0zzy37lr3y4vtjw23el3t4wte78plujfgkjda2mjy9we4ay4hk3cfegp0zk29rhx2gs6r0k7f57jzxxx",
  "invoiceId": "a4f23e7556fc9566f78673c8ebc52d3d",
  "expiresAt": "2026-09-29T12:05:00Z",
  "minConfirmations": 1,
  "memo": "BYTE1|a4f23e7556fc9566f78673c8ebc52d3d|e62bbedfa6163d6a036aed7c0be475f2",
  "zip321": "zcash:utest1nmxc…?amount=0.001&memo=QllURTF8YTRmMjNl…"
}
```

`payTo` is minted for this invoice and no other. `amount` is zatoshis as a string, never a
JSON number.

#### Optional fields

**`price`** — present when the merchant priced in USD:

```json
"price": { "priceUsd": "2.00", "zecUsd": 231.5, "priceSource": "near-intents+kraken",
           "quotedAt": "2026-09-29T12:00:00Z" }
```

The quote is locked at issue time and never consulted again; a payment is judged against
`amount` alone. Settlement is in ZEC, and both sides carry price risk between the quote and
cashing out.

**`fee`** — present when the issuing facilitator charges:

```json
"fee": { "amount": "1000", "payTo": "utest1facil…", "bps": 100 }
```

`amount` above stays what the **payee** is owed; the fee is a second output, and `zip321`
encodes both in the indexed multi-payment form. The fee leg carries no memo — it binds to
no invoice, and a memo there would be a second place an invoice identifier could reach a
third party.

**The fee is enforced by the facilitator's verification, not by the chain.** Zcash has no
contracts and nothing on-chain requires that output to exist. The facilitator checks both
outputs arrived before it approves; a payer who bypasses the facilitator bypasses the fee.
A payment that settles the payee but skips the fee is refused as `underpaid` **without
consuming the invoice**, so the payer can still pay correctly.

### The retry

The payer settles, then retries with `PAYMENT-SIGNATURE`: base64 of

```json
{
  "scheme": "byte-zcash-shielded-v1",
  "network": "zcash:05a60a92d99d85997cce3b87616c089f",
  "invoiceId": "a4f23e7556fc9566f78673c8ebc52d3d",
  "txid": "15a1ded9e252cfff784aae08add4a79b52424fc91bd304d96bcf41322e768369"
}
```

### Failure responses

| Condition | Status | `reason` | Extra |
|-----------|--------|----------|-------|
| Paid less than asked | 402 | `underpaid` | `shortfallZat` |
| Invoice expired | 402 | `expired` | a fresh invoice |
| Not seen, or too few confirmations | 402 | `pending` | `retryAfterSeconds` |
| Already paid | 409 | `replay` | — |
| Wrong pool, wrong address, bad memo | 402 | `invalid_payment` | — |

---

## 2. `byte-walletd` — the wallet sidecar

Binds `127.0.0.1:8137` by default. **Loopback is not an authorisation boundary** — any local
process, including a web page fetching `127.0.0.1`, can reach it, and it may hold a spending
key. Every route but `/health` requires `Authorization: Bearer $BYTE_WALLETD_TOKEN`,
compared in constant time.

### `GET /health` — unauthenticated

```json
{ "ok": true, "version": "0.1.0", "network": "zcash:05a60a92d99d85997cce3b87616c089f", "canSpend": true }
```

`canSpend` is false for a view-only deployment. A facilitator's should report false.

### `GET /status`

```json
{
  "network": "zcash:05a60a92d99d85997cce3b87616c089f",
  "syncedHeight": 4413005,
  "chainTip": 4413005,
  "synced": true,
  "nu63ActivationHeight": 4134000
}
```

### `POST /addresses`

Mints a fresh diversified unified address: Orchard-typecode receiver, no transparent
receiver. Never returns the same address twice.

```json
{ "address": "utest1xghzan2ngrekdl2pw3cfnu8cnkucmvezevcvlc59jckjhpra6ykkrvmjq9xelp5t9692kmh63e7uurzqvckvv6xy4g3nrl6c35jxjxcu", "diversifierIndex": 0 }
```

### `GET /viewing-key`

Returns both keys, so a caller can hand over the narrower one:

```json
{ "uivk": "uivktest1…", "ufvk": "uviewtest1…" }
```

**`uivk` is the one to give away.** It sees received notes and their memos, which is
everything needed to verify a Byte invoice was paid. `ufvk` additionally sees what the
account has *spent*, which an auditor asking "was I paid" never needed.

Neither can spend. Both disclose every payment the account receives, for as long as the key
exists, and neither can be scoped to one invoice or revoked. When the question is about one
payment, a signed receipt answers it and discloses nothing else. See docs/SECURITY.md.

```json
{ "ufvk": "uviewtest1qvtryhkavsvn98…" }
```

This is what you hand a facilitator. It can see payments; it cannot spend.

### `POST /memo/encode` · `POST /memo/verify`

```json
{ "secret": "0707…", "invoiceId": "0123456789abcdef0123456789abcdef", "amountZat": "100000", "payTo": "utest1…" }
```
→ `{ "memo": "BYTE1|0123456789abcdef0123456789abcdef|83277bce2698d03296873534c777da14" }`

`/memo/verify` takes the same fields plus `memo` and returns `{ "valid": true | false }`.
It returns `false` rather than erroring on malformed input: a memo that does not verify is an
ordinary outcome.

### `GET /notes?txid=…`

Outputs this wallet received in a transaction. **Keyed by transaction, not address** — the
underlying wallet API is, and the payer reports a txid anyway.

```json
[
  { "txid": "15a1ded9…768369", "pool": "ironwood", "valueZat": "1000000",
    "memo": "BYTE1|a4f23e75…|e62bbedf…", "confirmations": 6, "height": 4413018 },
  { "txid": "15a1ded9…768369", "pool": "ironwood", "valueZat": "8990000",
    "confirmations": 6, "height": 4413018 }
]
```

There is no `payTo`. `get_received_outputs` reports an output's pool and value but not its
destination address, so the field is absent rather than guessed. The destination is
established by the memo binding — see [SECURITY.md](SECURITY.md) §5.6.

**Txids are in display order** (byte-flipped from the internal representation), the same
order block explorers use.

### `GET /balance`

```json
{ "spendableZat": "9990000", "pendingZat": "0", "unusableZat": "0" }
```

`unusableZat` is value outside Ironwood. Byte will not spend it: moving it would cross pools
and reveal the net amount under ZIP 318.

**While unsynced this returns `503 not_synced`, not zeroes.** A zero balance from an unsynced
wallet is indistinguishable from an empty one, and "no notes received" would make a verifier
reject payments that were made correctly.

### `POST /send`

The only route that moves value. A view-only deployment rejects it with `view_only` before a
transaction is built.

```json
{ "to": "utest1…", "amountZat": "1000000", "memo": "BYTE1|…|…" }
```
→ `{ "txid": "15a1ded9…768369", "feeZat": "10000" }`

Change is directed to Ironwood. The first call downloads the Sapling proving parameters
(~50 MB, once) — required by the transaction builder's signature even though Byte builds no
Sapling output.

The built proposal is inspected before it is proved, signed or broadcast: if its inputs
include a transparent UTXO or a Sapling or Orchard note, the request is refused with
`wrong_pool_source` and nothing is sent. `propose_standard_transfer_to_address` takes no
parameter restricting source pools, so without that check the input selector is free to top
a payment up from outside Ironwood and publish the amount crossing the turnstile.

### `POST /shield`

Sweep transparent value into Ironwood. One transaction per call.

```json
{ "fromTransparent": ["t1…"], "minimumZat": "5000" }
```
→ `{ "txid": "aa1ded9…683690", "amountZat": "4990000", "feeZat": "10000" }`

Both fields are optional. Omitting `fromTransparent` sweeps every transparent address the
wallet controls; `minimumZat` defaults to the ZIP 317 marginal fee, because a UTXO worth
less than the fee to move it costs money to shield.

**`{}` — an empty object, with no `txid` — means there was nothing above the threshold
worth moving.** That is the ordinary end of a sweep, not an error.

The delay-and-split policy is **not** here. It lives in `WalletdWallet.shield`, where a
caller can see and configure it, and the daemon holds no timer. Splitting is several calls
over different addresses: `propose_shielding` selects inputs by address and offers no
UTXO-level knob, so a wallet with one transparent address cannot split and the client says
so rather than quietly producing one transaction.

### `POST /unshield`

Send value out of Ironwood to a transparent address. **This publishes the amount** — ZIP 318
makes the net amount crossing between pools public, and that is what unshielding is.

```json
{ "toTransparent": "t1…", "amountZat": "5000000" }
```
→ `{ "txid": "bb1ded9…683691", "feeZat": "10000" }`

The destination is decoded before anything is built, so a shielded or unified address is
refused by name rather than surfacing as an opaque builder error. The *source* must still be
Ironwood: `wrong_pool_source` applies here too, because funding an unshield from a
transparent UTXO would be a transparent-to-transparent transfer wearing the wrong name.

### Error codes

| `code` | Status | Meaning |
|--------|--------|---------|
| `unauthorized` | 401 | Missing or wrong bearer token |
| `view_only` | 403 | This deployment holds no spending key |
| `not_synced` | 503 | The wallet cannot answer yet |
| `no_chain` | 503 | Not connected to a chain |
| `chain_unavailable` | 502 | The light server could not be reached |
| `send_failed` | 502 | The transaction could not be built or broadcast |
| `wrong_pool_source` | 409 | Refused: this would have been funded from outside Ironwood. Not a failure — the wallet holds value and Byte declined to spend the wrong kind |
| `bad_memo`, `bad_secret`, `bad_amount` | 400 | Malformed request |

---

## 3. The console — owner-only

Mounted under `/api` by `startConsole`. Reports exactly what Byte keeps off the chain, so
**no route is unauthenticated**, not even a health check. `Authorization: Bearer <token>`,
constant-time compared, minimum 32 characters.

### `GET /api/overview`

```json
{
  "label": "byte demo node",
  "network": "zcash:05a60a92d99d85997cce3b87616c089f",
  "sync": { "network": "…", "syncedHeight": 104, "synced": true },
  "balance": { "spendableZat": "425000", "pendingZat": "0", "unusableZat": "0" },
  "invoices": { "total": 4, "consumed": 3, "outstanding": 1, "expired": 0 },
  "settledZat": "425000",
  "guard": { "spentTodayZat": "425000", "decisions": 5, "refusals": 2 }
}
```

`balance` is `null`, not zeroes, when the wallet cannot answer. `guard` is `null` when none
is configured.

### `GET /api/invoices`

`?limit=` (clamped to 200) · `?cursor=` · `?status=outstanding|consumed|expired`

```json
{ "invoices": [ { "invoiceId": "…", "amountZat": "100000", "consumedAt": 1790676533112, "txid": "…" } ] }
```

### `GET /api/invoices/:invoiceId` · `GET /api/receipts` · `GET /api/balance`

Single invoice (404 if unknown), signed receipts, and the live balance. `/api/balance`
returns `503 unavailable` rather than zeroes when the wallet cannot answer.

### `GET /api/price`

Whether pricing is healthy. A refusing feed answers **200** with `healthy: false`, not 500:
the console is working, the feed is not.

```json
{ "healthy": true, "price": 1399.8, "source": "near-intents+kraken", "at": 1790718000000,
  "timestamped": true, "ageSeconds": 31 }
```
```json
{ "healthy": false, "sourceId": "near-intents", "error": "last published 600s ago, over the 120s limit" }
```

`ageSeconds` is `null` for an untimestamped source such as Kraken, which reports no
publication time. 404 when no price source is configured.

### `GET /api/agent-card`

The owner's own signed Agent Card, so an owner can check what
`/.well-known/byte-agent.json` says. 404 when none is configured.

### `GET /api/guard`

Newest first, **refusals included with their reason** — an operator needs to know why a
payment was stopped, not merely that it was.

```json
{
  "spentTodayZat": "425000",
  "entries": [
    { "at": 1790676533112, "host": "unknown.example.org", "amountZat": "1000",
      "allowed": false, "reason": "host_not_allowed" },
    { "at": 1790676533000, "host": "data.example.com", "amountZat": "75000", "allowed": true }
  ]
}
```

---

## 4. The facilitator

`GET /health` (unauthenticated) · `GET /info` · `POST /invoices` · `POST /verify`, all
others behind `x-byte-api-key`.

`GET /info` reports `"canSpend": false` so a caller can **assert** the facilitator cannot
spend rather than trust it. `/health` reports unhealthy when unsynced: a facilitator that
cannot verify should say so, not report healthy and then refuse every payment.
