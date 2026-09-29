/**
 * Value pools.
 *
 * Mirrors `zcash_protocol::ShieldedPool`, plus `transparent` for value that is not in a
 * shielded pool at all.
 *
 * This is the vocabulary Byte's central safety check is written in. A unified address
 * cannot express which pool a payment will land in — there is no Ironwood receiver type,
 * and Ironwood reuses Orchard receivers — so a verifier must read the pool from the
 * *received note* and can never infer it from the address it published.
 *
 * See docs/TOOLCHAIN.md, "Correction: there is no Ironwood receiver type".
 */

export const POOLS = ["transparent", "sapling", "orchard", "ironwood"] as const;

export type Pool = (typeof POOLS)[number];

/** The only pool Byte accepts or creates. */
export const BYTE_POOL = "ironwood" as const satisfies Pool;

/**
 * Pools that are shielded, in the sense that value and participants are hidden.
 *
 * Orchard is included because notes already in it remain shielded. It is nonetheless
 * unusable for new Byte payments — see `isSpendablePool`.
 */
export function isShieldedPool(pool: Pool): boolean {
  return pool !== "transparent";
}

/**
 * Whether Byte will accept a received note in this pool as settling an invoice.
 *
 * Ironwood only. Accepting a Sapling or Orchard note would mean accepting value that
 * arrived through a pool-crossing transfer, and ZIP 318 is explicit that the net amount
 * crossing between pools is revealed on-chain — which is the exact disclosure Byte
 * exists to prevent.
 */
export function isAcceptedPool(pool: Pool): pool is typeof BYTE_POOL {
  return pool === BYTE_POOL;
}

/**
 * Whether Byte will fund a payment from this pool.
 *
 * Identical to `isAcceptedPool` today, and kept separate because the reasons differ.
 * Spending from transparent would publish the amount. Spending from Orchard is barred by
 * consensus after NU6.3: no new Orchard outputs may be created, so change alone makes it
 * impossible, and the withdrawal would have to cross the ZIP 318 turnstile in public.
 */
export function isSpendablePool(pool: Pool): pool is typeof BYTE_POOL {
  return pool === BYTE_POOL;
}

export function isPool(value: unknown): value is Pool {
  return typeof value === "string" && (POOLS as readonly string[]).includes(value);
}
