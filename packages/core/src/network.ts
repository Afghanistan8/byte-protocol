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
 * Target seconds between blocks, unchanged since Blossom (ZIP 208).
 *
 * Used only to derive human-facing latency estimates and `Retry-After` hints. It is a
 * target, not a guarantee: individual block intervals vary widely.
 */
export const BLOCK_TARGET_SECONDS = 75;

export function isByteNetwork(value: unknown): value is ByteNetwork {
  return typeof value === "string" && (NETWORKS as readonly string[]).includes(value);
}

/** Human-readable name, for logs and UI. Never used as a protocol value. */
export function networkLabel(network: ByteNetwork): string {
  return network === NETWORK_MAINNET ? "Zcash mainnet" : "Zcash testnet";
}
