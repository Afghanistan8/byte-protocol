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
 * **Do not hardcode either of these.** Block spacing is a consensus parameter and it is
 * about to change: ZIP 208 set 75 seconds at Blossom, and ZIP 218 takes it to 25 under
 * NU7. Anything that derives a wait, a timeout or a `Retry-After` from a literal 75 becomes
 * silently wrong — three times too slow — the moment NU7 activates, and it activates on
 * testnet before it activates on mainnet, so the two networks disagree for a month.
 *
 * Read it through {@link blockTargetSeconds}, which takes the height.
 */
export const BLOCK_TARGET_SECONDS_PRE_NU7 = 75;
export const BLOCK_TARGET_SECONDS_NU7 = 25;

/**
 * NU7 consensus branch ID.
 *
 * `0x77190AD8`, as exposed by `zcash_protocol`. Unlike the heights below, this is settled.
 */
export const NU7_BRANCH_ID = 0x77190ad8;

/**
 * NU7 activation heights.
 *
 * **Neither of these is final, and the mainnet one is deliberately absent.** The schedule
 * is testnet on 6 October 2026, a go/no-go on 20 October, mainnet on 5 November, and the
 * activation height is only fixed at that go/no-go. The testnet figure below is the
 * published *estimate*; the mainnet figure does not exist yet, and inventing one would put
 * a number Byte made up in the path that decides how long a payer waits.
 *
 * `undefined` reads as "not activated as far as Byte knows", which falls back to the
 * pre-NU7 spacing — the slower of the two, and therefore the forgiving direction to be
 * wrong in: a client waits longer than it needs to rather than hammering a light server
 * for a block that has not happened.
 *
 * A deployment that knows better should pass `height` explicitly, or override this once
 * the heights are final. See docs/TOOLCHAIN.md for the dates and sources.
 */
export const NU7_ACTIVATION_HEIGHT: Record<ByteNetwork, number | undefined> = {
  [NETWORK_MAINNET]: undefined,
  /** Estimate, not consensus. Pending the 20 October 2026 go/no-go. */
  [NETWORK_TESTNET]: 4_386_000,
};

/**
 * Target seconds between blocks on `network` at `height`.
 *
 * Without a height this reports the spacing in force *today* on that network, which is
 * what a caller that has no chain connection can honestly say. With one, it reports the
 * spacing that applies at that height.
 */
export function blockTargetSeconds(network: ByteNetwork, height?: number): number {
  const nu7 = NU7_ACTIVATION_HEIGHT[network];
  if (nu7 === undefined) return BLOCK_TARGET_SECONDS_PRE_NU7;
  if (height === undefined) return BLOCK_TARGET_SECONDS_PRE_NU7;
  return height >= nu7 ? BLOCK_TARGET_SECONDS_NU7 : BLOCK_TARGET_SECONDS_PRE_NU7;
}

/**
 * How long to wait before asking again about an unconfirmed payment.
 *
 * One block, floored at ten seconds. The floor matters more after NU7 than before it: at
 * 25-second spacing a client that retries on the nose will mostly catch the same
 * unconfirmed state, and hammering a light server is neither polite nor faster.
 */
export function retryAfterSeconds(
  network: ByteNetwork,
  options: { height?: number; blocks?: number } = {},
): number {
  const blocks = options.blocks ?? 1;
  return Math.max(10, blockTargetSeconds(network, options.height) * blocks);
}

export function isByteNetwork(value: unknown): value is ByteNetwork {
  return typeof value === "string" && (NETWORKS as readonly string[]).includes(value);
}

/** Human-readable name, for logs and UI. Never used as a protocol value. */
export function networkLabel(network: ByteNetwork): string {
  return network === NETWORK_MAINNET ? "Zcash mainnet" : "Zcash testnet";
}
