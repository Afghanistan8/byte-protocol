# Toolchain

Every version and protocol fact Byte depends on, with the source it came from and the
date it was checked. Nothing here is from memory. Where a source contradicted an
assumption this project started with, the contradiction is recorded rather than quietly
fixed.

All entries verified **2026-09-29** unless stated otherwise.

## Consensus facts

| Fact | Value | Source |
|------|-------|--------|
| Active shielded pool | **Ironwood** (NU6.3) | [ZIP 258](https://zips.z.cash/zip-0258) |
| Mainnet activation | block **3,428,143**, 28 July 2026 | [ZIP 258](https://zips.z.cash/zip-0258) |
| Testnet activation | block **4,134,000** | [ZIP 258](https://zips.z.cash/zip-0258) |
| Consensus branch ID | `0x37A5165B` | [ZIP 258](https://zips.z.cash/zip-0258) |
| Transaction format | v6 | [ZIP 229](https://zips.z.cash/zip-0229) via ZIP 258 |
| Orchard status | Sealed. No new Orchard outputs; withdraw-only through the ZIP 318 turnstile | [ZIP 258](https://zips.z.cash/zip-0258), [ZIP 2006](https://zips.z.cash/zip-2006) |
| Pool-crossing visibility | "The net amount crossing between the pools is revealed on-chain." | [ZIP 318](https://zips.z.cash/zip-0318) |
| Memo size | Fixed **512 bytes**, null-padded, ZIP 302 serialization | [zcash_protocol::memo::MemoBytes](https://docs.rs/zcash_protocol/0.10.6/zcash_protocol/memo/struct.MemoBytes.html) |
| Block target, pre-NU7 | **75 seconds**, unchanged since Blossom (ZIP 208, block 653,600) | [ZIP 208](https://zips.z.cash/zip-0208) |
| Block target, NU7 onwards | **25 seconds** | [ZIP 218](https://zips.z.cash/zip-0218) |
| NU6.3 consensus branch ID | `0x37a5165b` | [ZIP 258](https://zips.z.cash/zip-0258); matches `BranchId::Nu6_3` in `zcash_protocol` 0.10.6 |
| NU7 consensus branch ID | **`0x77190AD9`** | [ZIP 259](https://zips.z.cash/zip-0259) (Draft): `CONSENSUS_BRANCH_ID: 0x77190AD9` |
| NU7 activation heights | **Unset, on purpose.** ZIP 259 says "Testnet: TBD (To be set on OCT 5)" and "Mainnet: TBD (To be set on OCT 20)". `zcash_protocol` 0.10.6 returns `None` for `NetworkUpgrade::Nu7` on both networks | [ZIP 259](https://zips.z.cash/zip-0259) |

### Two traps in the NU7 branch ID, both of which Byte fell into

**It is `…AD9`, not `…AD8`.** The first published value was `0x77190AD8`; it was corrected,
and there is a "Fix NU7 consensus branch ID" change in the wild to prove it. ZIP 259 states
`0x77190AD9`. Byte treats `77190ad8` as *unrecognised*, so a stale server reporting the old
value gets the safe pre-NU7 spacing rather than silently getting post-NU7 timing.

**`zcash_protocol` 0.10.6 cannot be used as the source.** The version this repo pins still
carries a `0xffff_ffff` placeholder for `BranchId::Nu7`, so reading the constant out of the
crate would be reading a placeholder.

### Why spacing is decided by branch and not by height

Byte briefly held a *published estimate* of 4,386,000 for NU7 on testnet and picked spacing
by comparing against it. That was a live bug: Byte's own testnet run was mined at 4,413,018,
above the estimate, so every `Retry-After` and confirmation wait on testnet was already
being computed at 25 seconds for a chain still producing a block every 75 — three times too
short, weeks before NU7 activates.

`byte-walletd` now reports the `consensusBranchId` the light server states in
`GetLightdInfo`, and `blockTargetSeconds` reads that. An unrecognised or absent branch falls
back to 75 seconds, which is the forgiving direction: a client waits longer than it needs to
rather than hammering a light server three times faster than blocks arrive.

| Mainnet genesis hash | `00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08` | [chainparams.cpp:338](https://github.com/zcash/zcash/blob/master/src/chainparams.cpp) |
| Testnet genesis hash | `05a60a92d99d85997cce3b87616c089f6124d7342af37106edc76126334a2c38` | [chainparams.cpp:745](https://github.com/zcash/zcash/blob/master/src/chainparams.cpp) |

## Correction: there is no Ironwood receiver type

Byte was originally specified to mint "a unified address with an Ironwood receiver only".
**No such receiver exists.** Three independent sources agree:

- [ZIP 316](https://zips.z.cash/zip-0316)'s typecode registry ends at `0x03` (Orchard).
  `0x04` through `0xBF` are unassigned.
- The `DataTypecode` enum in `zcash_address` on `main` has exactly `P2pkh` (0x00),
  `P2sh` (0x01), `Sapling` (0x02), `Orchard` (0x03) and `Unknown(u32)`.
- [librustzcash#2617](https://github.com/zcash/librustzcash/issues/2617) states it
  directly: *"an Orchard -> Ironwood send is what an ordinary Orchard-source payment to an
  Orchard receiver becomes once NU6.3 activates"*.

Ironwood is modelled as a distinct **pool** that reuses Orchard receivers and viewing
keys, not as a new address type. `zcash_protocol` 0.10.6 exposes it as
[ShieldedPool::Ironwood](https://docs.rs/zcash_protocol/0.10.6/zcash_protocol/enum.ShieldedPool.html)
alongside `Sapling` and `Orchard`.

**What Byte does instead:** every invoice mints a fresh diversified unified address
carrying an **Orchard-typecode receiver and no transparent receiver**. After NU6.3, funds
paid to it land in the Ironwood pool. Byte then verifies that the pool of the *received
note* is `Ironwood`, which is the check that actually matters — an address cannot express
it.

## Rust crates

Latest stable on crates.io as of 2026-09-29, read from the crates.io API.

| Crate | Version | Published | Role in Byte |
|-------|---------|-----------|--------------|
| `zcash_client_backend` | **0.24.0** | 2026-08-19 | Wallet framework, scanning, light-client protocol, proposals and tx construction |
| `zcash_client_sqlite` | **0.22.0** | 2026-08-19 | Wallet storage |
| `zcash_keys` | **0.16.1** | 2026-07-29 | USK/UFVK/UIVK, unified addresses, ZIP 32 diversification |
| `zcash_protocol` | **0.10.6** | 2026-09-08 | `Zatoshis`, `ShieldedPool`, memo types, consensus params |
| `zcash_address` | **0.13.0** | 2026-07-09 | Address parsing and encoding |
| `zcash_primitives` | **0.30.1** | 2026-08-19 | Transaction primitives |
| `orchard` | **0.15.5** | 2026-08-03 | Orchard/Ironwood note and circuit types |
| `zip321` | **0.9.0** | 2026-08-19 | Payment request URIs |
| `pczt` | **0.9.3** | 2026-08-07 | Partially constructed transactions |

librustzcash carries its own warning that its APIs do not check consensus validity; final
validity comes from a node. Byte repeats that warning in [SECURITY.md](SECURITY.md)
rather than implying its verification is consensus-grade.

### Known maturity gaps

- [librustzcash#2617](https://github.com/zcash/librustzcash/issues/2617): the shared
  `ShieldedPoolTester` suite has never been run with Ironwood as the active pool. Rewind
  and reorg behaviour, birthday handling, spendability windows, send-to-self and change
  handling, and multi-step proposals are all untested for Ironwood **as a source pool**.
  Byte spends from Ironwood. This is a real risk, and it is documented rather than hidden.
- [zallet#695](https://github.com/zcash/zallet/issues/695): `z_listunspent` fails on
  unspent Ironwood notes when memo lookup errors. That is precisely Byte's verification
  path, and it is why Zallet's RPC is not the wallet backend — see
  [DECISIONS.md](DECISIONS.md) entry 1.

## Node and wallet software

| Project | State | Note |
|---------|-------|------|
| [Zebra](https://github.com/ZcashFoundation/zebra) | 6.0.0-rc.0 | Full node, no wallet. Not required by Byte's chosen backend. |
| [Zallet](https://github.com/zcash/zallet) | `0.1.0-beta.6` era | Beta, not production-grade. Not used as a backend; see above. |
| [ZODL](https://github.com/zodl-inc) | — | Reference mobile wallet, ex-ECC/Zashi. |

Byte's `byte-walletd` syncs over the **lightwalletd protocol** against a public endpoint,
so no full node is required to run or demo it.

### Testnet infrastructure

| Resource | Detail |
|----------|--------|
| lightwalletd | `https://testnet.zec.rocks:443` — **verified working 2026-09-29**, synced testnet to height 4,412,980 |
| ~~lightwalletd~~ | ~~`testnet.lightwalletd.com:9067`~~ — **does not resolve.** Recorded here from a secondary source on 2026-09-29 and found dead the same day when first used. Kept as a correction: a host that appears in search results is not evidence that it exists. |
| Faucet | <https://zcashfaucet.jinolabs.xyz/> — 0.1 TAZ, browser proof-of-work gated, pays shielded z2z |
| Faucet | [Valar Group](https://github.com/valargroup/valar-testnet-faucet) — 0.125 TAZ per IP per day |

## x402 v2

Read from [specs/x402-specification-v2.md](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)
(spec v2.0, dated 2025-12-09). The project now lives under `x402-foundation`, not
`coinbase`.

| Item | Value |
|------|-------|
| `x402Version` | `2` |
| Response header | `PAYMENT-REQUIRED` — base64-encoded `PaymentRequired` JSON |
| Request header | `PAYMENT-SIGNATURE` — carries the client's `PaymentPayload` |
| Extension sidechannel | `EXTENSION-RESPONSES` |
| `PaymentRequirements` | `scheme`, `network`, `amount`, `asset`, `payTo`, `maxTimeoutSeconds` required; `extra` optional |
| `PaymentPayload` | `x402Version`, `accepted`, `payload` required; `resource`, `extensions` optional |
| `SettlementResponse` | `success`, `transaction`, `network` required; `errorReason`, `payer`, `amount`, `extensions` optional |
| `network` format | CAIP-2 `namespace:reference` |

The v1 header names (`X-PAYMENT`, `X-PAYMENT-RESPONSE`) are **not** used by Byte.

### Zcash has no registered CAIP-2 namespace

CAIP-2 requires `namespace:reference`, and BIP-122 explicitly excluded Zcash. There is no
registered `zcash` namespace. Rather than invent one silently, Byte follows the precedent
already set inside the x402 repository by
[scheme_exact_lnbtc.md](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_lnbtc.md),
which identifies Lightning networks as `lnbtc:` followed by the first 32 lowercase hex
characters of the genesis block hash.

Byte therefore uses:

| Network | Identifier |
|---------|-----------|
| Zcash mainnet | `zcash:00040fe8ec8471911baa1db1266ea15d` |
| Zcash testnet | `zcash:05a60a92d99d85997cce3b87616c089f` |

[SPEC.md](SPEC.md) states plainly that `zcash` is not a registered CAIP-2 namespace and
that these identifiers follow the lnbtc convention.

## NEAR Intents

| Item | Finding |
|------|---------|
| ZEC support | *"Partially supported - Transparent addresses only"* — `t1` or `t3` prefix |
| Consequence | Every deposit and withdrawal on this rail is **public**. Shielded and unified addresses are rejected. |

Source: [NEAR Intents chain and address support](https://docs.near-intents.org/near-intents/chain-address-support).

## Prior art

Byte is not first. These are named so the differentiation stays checkable.

| Project | What it is |
|---------|-----------|
| [ZCG #445 / #446](https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/445) | "Shielded x402" — a $42K grant application for a spec plus reference implementation, milestones Oct 2026 to Feb 2027 |
| [z402.cash](https://z402.cash/) | Zcash plus x402 with a facilitator service |
| Rill | Already lets agents pay over HTTP 402 via MPP/x402 |

There is **no Zcash scheme spec in the x402 repository**. The `specs/schemes/exact/`
directory covers EVM, SVM, Aptos, Cardano, Stellar, Sui, TON, XRPL, Lightning and others,
but not Zcash. That gap is the space Byte's x402 adapter occupies.

## Local environment

Recorded 2026-09-29 on the build machine (Windows 11).

| Tool | Version |
|------|---------|
| Node | 24.15.0 |
| npm | 11.12.1 |
| pnpm | 12.6.0 (installed 2026-09-29) |
| git | 2.54.0.windows.1 |
| Rust | **not installed** — required for `crates/byte-walletd` |

## Build verification

Run on the build machine 2026-09-29, after installing Rust 1.98.1 (cargo 1.98.1) and
Visual Studio BuildTools 2026 18.10.2 with the VC++ x86/x64 workload.

A throwaway crate pinning `zcash_client_backend` 0.24.0, `zcash_client_sqlite` 0.22.0,
`zcash_keys` 0.16.1, `zcash_protocol` 0.10.6, `zcash_address` 0.13.0 and `zip321` 0.9.0
compiled and ran cleanly in 1m13s, exit code 0, no warnings. It printed `Ironwood`,
confirming `zcash_protocol::ShieldedPool::Ironwood` exists at the pinned version rather
than only in documentation.

`libsqlite3-sys` 0.35.0, `rusqlite` 0.37.0, `orchard` 0.15.5 and `sapling-crypto` 0.7.0
all built, so the C toolchain is wired up correctly and the sidecar has no known
Windows-specific blocker.


---

## Wallet Ironwood support, as listed on the dashboard

After NU6.3 only a wallet updated for Ironwood can create a shielded output at all, so
"supports shielded ZEC" stopped being the useful question on 28 July 2026. The dashboard's
table therefore reports **Ironwood** status, and this is where each claim comes from.

**Verified** means a release note names Ironwood with a version and a date. Everything else
is **Unverified**, which does not mean broken: it means no statement was found that could be
checked, and Byte will not let a reader send money on its optimism.

| Wallet | Status | Evidence |
|--------|--------|----------|
| Noir | Verified | v1.0.26, 23 Jul 2026: "retaining support for Ironwood balance data after activation"; v1.0.27, 28 Jul 2026 expanded Ironwood privacy guidance. The repository publishes no v0.1.x release; an earlier version of this table said v0.1.26, 27 Jul 2026, and that was wrong. **Use v1.0.37 or newer**: before it, Noir refuses to spend a freshly received note with `WALLET_SPENDABILITY_INCONSISTENT`, fixed on 23 Sep 2026 |
| Zodl | Verified | v3.8.0 Ironwood-compatible; "Move to Ironwood" shipped in v3.9.0 on 8 Aug 2026; latest v3.9.5, 18 Aug |
| Zingo | Verified | v2.0.22 (313), 31 Jul 2026 |
| Zkool | Verified | v6.25.0, 27 Jul 2026; v6.27.0, 15 Aug |
| Keystone | Verified | Firmware 3.0.2 added Ironwood and batch PCZT signing; latest 3.0.4, 12 Aug 2026 |
| MetaMask + ChainSafe snap | **Unverified** | The published snap `@chainsafe/webzjs-zcash-snap` is **0.3.0, 6 February 2026** — nearly six months *before* Ironwood activated — and neither its description nor its readme mentions Ironwood or NU6.3. The WebZjs library may support it upstream; the shipped snap carries no such claim. Byte asks this snap for a viewing key only, which is unaffected. |
| Ledger | **Unverified** | PCZT v2 signing was merged into `app-zcash` on 27 Jul 2026 and, as of the 1 Aug community list, had "still not [gone] through Ledger's own review". Merged is not shipped. |
| Brave, Zucchini, Nighthawk, Zelcore | **Unverified** | No release note found stating NU6.3 support |
| YWallet | **Not supported** | The developer stated directly that YWallet will not be updated for Ironwood. Zkool is the successor, from the same developer. |
| Zecwallet Lite | **Discontinued** | Sunset and unmaintained. Sovright's Argos exists specifically to recover ZEC stranded in old Zecwallet Lite clients, which is the clearest possible statement that it is not a wallet to send new money to. |

Primary source for most of the above: the Zcash community forum thread
["Ironwood is Here! Updated Wallets, Libraries"](https://forum.zcashcommunity.com/t/ironwood-is-here-updated-wallets-libraries-aug-1/56557),
1 August 2026. Snap version and date from
[the npm registry](https://www.npmjs.com/package/@chainsafe/webzjs-zcash-snap).
