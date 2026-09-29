# The Byte Protocol site

A single static page. No build step, no framework, no dependencies, and — deliberately — no
outbound requests at all.

## Why nothing is fetched

`connect-src 'none'` is set in `vercel.json`, so the page cannot make a network request even
if something later tried to. A site explaining a privacy protocol has no business loading
analytics, fonts or scripts from third parties who would then see every person who reads it.

The memo demo is not a mock. It runs HMAC-SHA256 through the Web Crypto API, in the reader's
browser, over the same null-separated preimage as `packages/core/src/memo.ts` and
`crates/byte-walletd/src/memo.rs`. Nothing is sent anywhere, and nothing needs to be.

## What this is not

It is **not** the Byte console. The console reports invoice amounts, transaction identifiers
and balances — exactly what Byte keeps off the chain — and is owner-only, local, and served
by `pnpm console`. It must never be deployed publicly.

This page contains only what is already public: the protocol's design, its limits, and two
testnet transaction hashes anyone can look up.

## A note on opening it locally

`crypto.subtle` is only exposed in a secure context, so opening `index.html` straight off
disk with `file://` leaves the memo demo inert. The page detects that and says so rather
than sitting on a dash looking broken. Use `pnpm site`, which serves it on
`http://127.0.0.1:4321`, or just deploy it.

The binding the page computes was checked against `packages/core` and matches exactly:

```
protocol : cf8918f31c231522fdaebe6b28b6a36f
page     : cf8918f31c231522fdaebe6b28b6a36f
```

## Deploying

There is a `vercel.json` at the **repository root** pointing `outputDirectory` at `apps/site`,
so the default Root Directory works — leave Root Directory empty or `.`.

A second `vercel.json` lives here, so it also works if Root Directory is set to `apps/site`.
Either is fine; both skip install and build.

Both set `installCommand: ""` and override `buildCommand`. Without that, Vercel would find the
root `package.json`, run its `build` script, and try to build all twenty-eight workspace
targets to publish one HTML file.

**If you see a 404**, the Root Directory is almost certainly still pointing somewhere else
from an earlier import. Check Project Settings → Build and Deployment → Root Directory. The
tell is that the custom response headers below are missing: if `curl -I` shows no
`Content-Security-Policy`, Vercel never read a `vercel.json` at all, which means it was
looking in the wrong directory.
