# The Byte Protocol site

Two static pages: a marketing page at `/`, and a dashboard at `/app`. No build step, no
framework, no dependencies.

## Why the marketing page fetches nothing

`connect-src 'none'` is set for `/` in the root `vercel.json`, so it cannot make a network
request even if something later tried to. A page explaining a privacy protocol has no
business loading analytics, fonts or scripts from third parties who would then see every
person who reads it.

The memo demo on it is not a mock. It runs HMAC-SHA256 through Web Crypto over the same
null-separated preimage as `packages/core/src/memo.ts` and `crates/byte-walletd/src/memo.rs`.
Checked against the real implementation:

```
protocol : cf8918f31c231522fdaebe6b28b6a36f
page     : cf8918f31c231522fdaebe6b28b6a36f
```

## The dashboard

`/app` is what Launch App opens: a wallet view, an agent view, and three ways to connect. Its
CSP differs from the marketing page because it has to reach a local `byte-walletd` —
`connect-src` allows `127.0.0.1` and `localhost` there and nowhere else. It is `noindex`.

### Connecting

**Noir** is the one Zcash extension with a full dapp API. It injects a provider at
`window.noirwallet`, and the method names used here come from
[NoirWallet/noir-wallet-sdk](https://github.com/NoirWallet/noir-wallet-sdk) rather than from
guesswork:

```
zcash_requestAccounts · zcash_getBalance · zcash_getAddresses
zcash_sendTransaction · zcash_signMessage · zcash_shieldFunds
```

`zcash_sendTransaction` takes `{ to, amount, memo, fundingSource }`, which is exactly the
shape of a Byte payment — so the dashboard can settle a real invoice from a pasted ZIP-321
URI. `fundingSource` is pinned to `shielded`: funding from transparent would publish the
amount, so it refuses rather than falling back, the same way the protocol does. Noir's v1.0.26 release notes name Ironwood
balance data, and v1.0.27 shipped on activation day with Ironwood privacy guidance.

Noir versions **before v1.0.37** refuse to spend a note they have just received, with
`WALLET_SPENDABILITY_INCONSISTENT`. That is their bug, fixed in v1.0.37 on 23 September 2026,
and the dashboard says so on connect rather than letting a send fail for an unexplained
reason.

**MetaMask**, through ChainSafe's `@chainsafe/webzjs-zcash-snap`. The dashboard asks for
`getViewingKey`, which is precisely Byte's model — able to read payments and verify invoices,
unable to spend. That is all the dashboard asks it for.

The snap also exposes a PCZT signing method, and `pczt` is already in the sidecar's
dependency tree. But **nothing in Byte builds a PCZT today**, so neither this file nor the
dashboard claims a split-signing flow. When one exists and has a test, it can be described
here.

**byte-walletd**, your own daemon, for full spend capability.

Byte never asks for a seed phrase. If a page claiming to be Byte does, it is not Byte.

### Why most wallets say “No”

There is no wallet-connect standard for Zcash. `window.zconnect` is a proposal whose author
calls it "a rough/draft API… not a final design", and no wallet implements it. WalletConnect
namespaces must be CAIP-2, and Zcash has no registered CAIP-2 namespace; the ZCG grant to
build that support was approved on 31 August 2026 with milestones running into late 2027.

The wallets marked **No** are not deficient — there is simply no interface for a website to
speak to them. Every one of them can still pay a Byte invoice through **ZIP-321**; they just
cannot report back.

## What these pages do not claim

Byte settles in shielded Zcash and nowhere else. Neither page says "payments across any
chain" — the NEAR Intents rail brings value *in* from another chain and its Zcash leg is
public — and neither says "wrap", because Byte wraps nothing and has no contracts.

## What this is not

It is **not** the Byte console. The console reports invoice amounts, transaction identifiers
and balances — exactly what Byte keeps off the chain — and is owner-only, local, and served by
`pnpm console`. It must never be deployed publicly. The dashboard here holds no data of its
own: it reads from whatever wallet the visitor connects, in their browser.

## A note on opening it locally

`crypto.subtle` and `navigator.clipboard` are only exposed in a secure context, so opening
`index.html` straight off disk with `file://` leaves the demos inert. The pages detect that and
say so rather than sitting on a dash looking broken. Use `pnpm site`, which serves on
`http://127.0.0.1:4321`.

## Deploying

Configured entirely by the `vercel.json` at the **repository root**. Leave Root Directory
empty (the repo root); there is nothing else to set.

```json
"installCommand": "",
"buildCommand": "rm -rf public && mkdir -p public/app && cp apps/site/index.html public/index.html && cp apps/site/app/index.html public/app/index.html",
"outputDirectory": "public"
```

### Why it copies into `public/` rather than pointing at `apps/site`

`outputDirectory` is a directory **name**, not a path. Setting it to `apps/site` produced:

```
Error: No Output Directory named "site" found after the Build completed.
```

Vercel took the last segment and looked for a top-level `site/`. So the build copies the pages
into `public/`, a real top-level directory and Vercel's own default. `public/` is gitignored;
it only exists during a build.

`installCommand` is empty and `buildCommand` is overridden because otherwise Vercel finds the
root `package.json`, runs its `build` script, and builds every workspace target to publish two
HTML files.

### If it 404s

Check **Project Settings → Build and Deployment → Root Directory** is empty. The giveaway is
the response headers: if `curl -I` shows no `Content-Security-Policy`, Vercel never read a
`vercel.json`, which means it was looking in the wrong directory. A 404 alone could be
anything; a missing header is specific.
