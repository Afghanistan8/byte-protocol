/**
 * Network identifiers.
 *
 * x402 v2 requires networks in the CAIP-2 shape `namespace:reference`. There is no
 * registered CAIP-2 namespace for Zcash — BIP-122 explicitly excluded it. Rather than
 * invent an identifier with no provenance, Byte follows the convention the x402
 * repository already set for Lightning in `scheme_exact_lnbtc.md`: the namespace,
 * then the first 32 lowercase hex characters of the genesis block hash.
 *
 * The references below are the first 32 characters of the genesis block hashes asserted
 * in zcash/zcash `src/chainparams.cpp`. See docs/TOOLCHAIN.md.
 */

/** Byte's native payment scheme identifier, used outside x402. */
export const BYTE_SCHEME = "byte-zcash-shielded-v1" as const;

/** The x402 scheme Byte maps onto. See docs/SPEC.md §11. */
export const X402_SCHEME = "exact" as const;

/** The x402 protocol version Byte speaks. */
export const X402_VERSION = 2 as const;

export const NETWORK_MAINNET = "zcash:00040fe8ec8471911baa1db1266ea15d" as const;
export const NETWORK_TESTNET = "zcash:05a60a92d99d85997cce3b87616c089f" as const;

export type ByteNetwork = typeof NETWORK_MAINNET | typeof NETWORK_TESTNET;

export const NETWORKS = [NETWORK_MAINNET, NETWORK_TESTNET] as const;

/** Full genesis hashes, for cross-checking against a node or light server. */
export const GENESIS_HASH = {
  [NETWORK_MAINNET]: "00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08",
  [NETWORK_TESTNET]: "05a60a92d99d85997cce3b87616c089f6124d7342af37106edc76126334a2c38",
} as const satisfies Record<ByteNetwork, string>;

/**
 * NU6.3 ("Ironwood") activation heights, from ZIP 258.
 *
 * Below these heights the Ironwood pool does not exist, so a Byte payment is not
 * possible. A wallet backend can use this to refuse to operate against a chain that has
 * not yet activated rather than failing obscurely later.
 */
export const NU6_3_ACTIVATION_HEIGHT = {
  [NETWORK_MAINNET]: 3_428_143,
  [NETWORK_TESTNET]: 4_134_000,
} as const satisfies Record<ByteNetwork, number>;

/** NU6.3 consensus branch ID, from ZIP 258. */
export const NU6_3_BRANCH_ID = 0x37a5165b;

/**
 * Target seconds between blocks, by consensus epoch.
 *
 * **Do not hardcode either of these, and do not pick between them by height.** Block
 * spacing is a consensus parameter: ZIP 208 set 75 seconds at Blossom, and ZIP 218 takes
 * it to 25 under NU7. Anything deriving a wait, a timeout or a `Retry-After` from a
 * literal 75 becomes three times too slow the moment NU7 activates.
 *
 * Read it through {@link blockTargetSeconds}, which takes the **consensus branch** the
 * chain is actually on.
 */
export const BLOCK_TARGET_SECONDS_PRE_NU7 = 75;
export const BLOCK_TARGET_SECONDS_NU7 = 25;

/**
 * NU6.3 "Ironwood" consensus branch ID, from ZIP 258. Settled and activated.
 */
export const NU6_3_BRANCH_ID_HEX = "37a5165b";

/**
 * NU7 consensus branch ID, from ZIP 259: `0x77190AD9`.
 *
 * Two traps here, both of which Byte fell into before checking primary sources:
 *
 * 1. **It is `…AD9`, not `…AD8`.** The first published value was `0x77190AD8` and it was
 *    corrected. ZIP 259 states `CONSENSUS_BRANCH_ID: 0x77190AD9`.
 * 2. **`zcash_protocol` 0.10.6 — the version this repo pins — still carries a
 *    `0xffff_ffff` placeholder for `BranchId::Nu7`**, so the crate cannot be used as the
 *    source of this constant either.
 */
export const NU7_BRANCH_ID_HEX = "77190ad9";

/**
 * NU7 activation heights.
 *
 * **Both are deliberately `undefined`, and will stay that way until a primary source
 * publishes them.** ZIP 259 itself records them as "TBD (To be set on OCT 5)" for testnet
 * and "TBD (To be set on OCT 20)" for mainnet, and `zcash_protocol` 0.10.6 returns `None`
 * for `NetworkUpgrade::Nu7` on both networks.
 *
 * This table used to hold a published *estimate* of 4,386,000 for testnet, and that was a
 * live bug: Byte's own testnet run was mined at 4,413,018, above the estimate, so every
 * `Retry-After` and confirmation wait on testnet was already being computed at 25 seconds
 * for a chain still producing blocks every 75. Guessing an activation height means
 * computing real waits from fiction.
 *
 * Spacing is decided by {@link blockTargetSeconds} from the consensus branch the light
 * server reports, which is a fact rather than a forecast.
 */
export const NU7_ACTIVATION_HEIGHT: Record<ByteNetwork, number | undefined> = {
  [NETWORK_MAINNET]: undefined,
  [NETWORK_TESTNET]: undefined,
};

/** Normalize a branch ID written as hex, with or without `0x`, in any case. */
export function normalizeBranchId(branchId: string): string {
  return branchId.trim().toLowerCase().replace(/^0x/, "");
}

/**
 * Target seconds between blocks on the consensus branch a chain reports.
 *
 * An unrecognised or absent branch falls back to the **pre-NU7** spacing, and that is the
 * safe direction: a client waits longer than it needs to rather than hammering a light
 * server three times faster than blocks arrive.
 */
export function blockTargetSeconds(branchId?: string): number {
  if (branchId === undefined) return BLOCK_TARGET_SECONDS_PRE_NU7;
  return normalizeBranchId(branchId) === NU7_BRANCH_ID_HEX
    ? BLOCK_TARGET_SECONDS_NU7
    : BLOCK_TARGET_SECONDS_PRE_NU7;
}

/**
 * How long to wait before asking again about an unconfirmed payment.
 *
 * One block, floored at ten seconds. The floor matters more after NU7 than before it: at
 * 25-second spacing a client retrying on the nose mostly re-reads the same unconfirmed
 * state, and hammering a light server is neither polite nor faster.
 */
export function retryAfterSeconds(
  options: { branchId?: string; blocks?: number } = {},
): number {
  const blocks = options.blocks ?? 1;
  return Math.max(10, blockTargetSeconds(options.branchId) * blocks);
}

export function isByteNetwork(value: unknown): value is ByteNetwork {
  return typeof value === "string" && (NETWORKS as readonly string[]).includes(value);
}

/** Human-readable name, for logs and UI. Never used as a protocol value. */
export function networkLabel(network: ByteNetwork): string {
  return network === NETWORK_MAINNET ? "Zcash mainnet" : "Zcash testnet";
}
