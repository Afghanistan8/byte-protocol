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

## NEAR Intents — implemented, dry-run

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

**No live funding has been performed through this rail.** It is implemented and tested
against mocked HTTP shaped from the [1Click OpenAPI
document](https://1click.chaindefuser.com/docs/v0/openapi.yaml), covering all seven documented
statuses, signature of the quote request, and the failure paths.

### Fees

NEAR Intents charges an extra **0.25%** when no JWT is supplied. That fee is **theirs, not
Byte's** — Byte charges nothing, on any path — and it is passed through unchanged.

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
