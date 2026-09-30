# Funding rails

How value gets into a Byte wallet from somewhere else, and what each route exposes.

Byte settles in shielded Zcash. Funding it is a separate question, and the honest answer is
that **most ways of getting ZEC are public**. This document says which, and how loudly.

---

## The rule

Byte will only spend from **Ironwood**. Whatever a rail does, funds must end up shielded
before Byte will touch them, and Byte will not cross pools to make up a shortfall — ZIP 318
makes the net amount crossing pools public, which is the disclosure Byte exists to prevent.

So the `Rail` interface requires every rail to declare a `transparentLeg`:

```ts
interface TransparentLeg {
  public: boolean;
  reason: string;
}
```

It is **required, not optional**. A rail implementer has to state whether their rail leaks,
and a caller can refuse one that does.

---

## The most private way to fund a Byte wallet

**Receive shielded ZEC directly.** Ask whoever is paying you to send to your unified address.
No rail, no transparent leg, nothing published beyond the fact that a shielded transaction
occurred.

Everything below is a compromise against that.

---

## NEAR Intents: implemented, both directions, dry-run

`@byte-protocol/rail-near-intents`

Swaps an asset on another chain into ZEC, so an agent holding USDC on Base can fund a Byte
wallet without first acquiring ZEC by hand.

### This rail is public

NEAR Intents supports ZEC at **transparent addresses only**. Their documentation is explicit:
*"Partially supported - Transparent addresses only"* — `t1` or `t3`. A shielded or unified
address is rejected.

Consequences, stated plainly:

- The **deposit** is a public transaction on the origin chain.
- The **delivery** is a public Zcash transaction to a transparent address. Amount, address
  and timing are all on chain.
- The **shielding transaction** that moves those funds into Ironwood afterwards reveals the
  shielding amount.

An observer watching that transparent address sees every funding event, its size and its
timing. Shielding afterwards limits what happens *next*; it does not retroactively hide what
already happened.

Byte does not present this as private. The rail declares `transparentLeg.public: true` on
itself and on every quote, and a shielded recipient address is rejected at construction with
a message naming the real reason.

### Dry-run by default

`quote()` sends `dry: true` unless a caller explicitly asks otherwise. A live quote commits
to moving real value through a public address; that should be a deliberate act, not the
consequence of a default.

**No live funding has been performed through this rail, and no value has moved through
it.** It is implemented and tested against mocked HTTP shaped from the [1Click OpenAPI
document](https://1click.chaindefuser.com/docs/v0/openapi.yaml), covering all seven documented
statuses, the shape of both quote request bodies, and the failure paths.

There is also a **live test** against the real service, gated behind `BYTE_RAILS_LIVE=1` and
dry-only, so it reserves no deposit address and commits to nothing:

```bash
BYTE_RAILS_LIVE=1 pnpm vitest run packages/rails/near-intents/src/live.test.ts
```

It passes: ZEC resolves, both a funding quote and a cash-out quote come back, and both
signatures verify.

### Both directions

**Funding** brings some other asset in and delivers ZEC to a transparent address. Byte mints
a **fresh** transparent address per funding when it has a wallet: one fixed address would
hand an observer every funding this rail ever performed, tied together as one party's
history. Once the swap reports `SUCCESS`, `settle()` shields the proceeds into Ironwood,
which is what makes them spendable by Byte at all.

**Cashing out** sends shielded ZEC to 1Click's deposit address and takes another asset out.
It asks for `EXACT_INPUT`, not `EXACT_OUTPUT`: the wallet has to commit to a specific amount
leaving the shielded pool, and an exact output would let that amount vary. Refunds go to a
fresh transparent address of the same wallet, so a failed swap returns somewhere the
auto-shielder is watching rather than somewhere nobody is.

**Cashing out publishes the amount.** ZIP 318 makes the net amount crossing between pools
public, and cashing out is that crossing, deliberately. There is no arrangement of it that
does not leak. It is how value leaves Byte's guarantee.

### Quote signatures are verified

A quote hands back a deposit address and the caller sends real value to it, so the address is
exactly the field worth forging. Every quote carries an Ed25519 signature from 1Click, and
Byte checks it:

- **What is signed:** a deterministic JSON object built from a fixed subset of the request
  and the quote, plus the timestamp, serialized with sorted keys, SHA-256'd, then
  **Base58-encoded**. The message verified is the UTF-8 bytes of that Base58 string, not the
  raw digest.
- **The key:** 1Click's manager key, `ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc`,
  overridable in case it rotates.
- **Validated against a real signature**, not one Byte produced: a captured live response is
  checked into `fixtures/`, and the tests tamper with the amount, the recipient, the refund
  address and the deposit address and confirm each is refused.

`payCashOut` refuses to send to a quote whose signature did not verify.

### Confidentiality: a correction the docs do not make

The API's `confidentiality` enum is `public | basic | advanced`, and **its own default is
`public`**, the most revealing setting. So Byte always sends a value rather than letting
silence choose.

But **every confidential setting requires 1Click authentication.** Sending `basic` without a
JWT is refused outright:

```
401 "User authentication is required for confidential intent quotes"
```

That is not stated next to the enum. The live test found it. So Byte sends `basic` when a JWT
is configured and `public` when one is not, and the quote's fee note says which. A rail that
asked for confidentiality regardless would fail every quote; one that silently settled for
`public` while the caller believed otherwise would be worse.

None of it hides anything on Zcash. `confidentiality` affects the link between deposit and
withdrawal **on the Intents side only**. The transparent Zcash leg is public whatever it
says.

### Fees

NEAR Intents charges an extra **0.25%** when no JWT is supplied. That fee is **theirs, not
Byte's**, and it is passed through unchanged rather than folded into anything.

Every quote carries an itemised `fees` breakdown: the rail's own charges (`withdraw`,
`refund`) in one list, and in a **separate** list anything the service attached that Byte
never asked for. 1Click adds its own `appFees` entry to quotes; a charge the caller did not
request is the one they most need to see, so it is never merged into a total.

Byte's own protocol fee is zero on every path. The one Byte-side fee that can exist is
the optional facilitator fee — off by default, a second ZIP-321 output, enforced by the
facilitator's verification rather than by the chain. It has nothing to do with rails: no
rail charges it and no rail collects it.

### Statuses

1Click's states are mapped onto Byte's, with the raw string preserved so nothing is lost:

| 1Click | Byte |
|--------|------|
| `PENDING_DEPOSIT` | `awaiting_deposit` |
| `KNOWN_DEPOSIT_TX` | `deposit_seen` |
| `INCOMPLETE_DEPOSIT` | `incomplete` |
| `PROCESSING` | `processing` |
| `SUCCESS` | `delivered` |
| `REFUNDED` | `refunded` |
| `FAILED` | `failed` |

`INCOMPLETE_DEPOSIT` maps to `incomplete` rather than `failed` because it means the funder
sent too little, which is recoverable by topping up.

An **unrecognised** status maps to `failed`. Guessing that an unknown state means success is
the one mistake here that costs money.

---

## Planned, and not implemented

None of the following has code, a test, or a claim of support. They are listed so that the
absence is explicit rather than an oversight, each with the reason it is not done.

| Provider | Why not |
|----------|---------|
| Binance | Requires an account, API keys and KYC. The withdrawal leg is transparent, so it carries the same exposure as NEAR Intents with more operational surface. |
| Coinbase | As above. |
| Gemini (the exchange) | As above. Note that "Gemini" in this repository otherwise means Google's agents, which the A2A/AP2 adapter covers. |
| CoinDCX, Airtm, BitcoinVN | Regional exchanges. Public API coverage for ZEC withdrawals not verified. |
| Changelly, ChangeNOW, Houdini Swap, flyp.me | Swap services. Each would need its ZEC withdrawal address support checked before any claim of shielded delivery. |
| BitGo, Anchorage Digital | Custodians. Institutional onboarding, out of scope for a hackathon-stage protocol. |

A provider moves out of this table only when it has an implemented rail, a test suite against
mocked HTTP, and a stated `transparentLeg`. **Byte does not claim to "work with" anything it
has not built and tested.**

---

## What a rail cannot fix

Auto-shielding after a transparent deposit — splitting amounts, adding delay — reduces how
easily a shielding transaction is correlated with the deposit that funded it. It does **not**
hide the deposit, which already happened in public.

If your threat model cannot tolerate a public funding leg, do not use a transparent rail.
Fund the wallet with shielded ZEC.
