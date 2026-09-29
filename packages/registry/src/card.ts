/**
 * Byte Agent Cards.
 *
 * An Agent Card is how an agent says, in public and on purpose, "this is me and this is
 * where to pay me". It is the *only* place Byte publishes an identity.
 *
 * The split matters. Payment frameworks need attributable participants; privacy needs the
 * chain to link nothing. Byte separates the two: identity is published deliberately here,
 * while settlement uses a fresh diversified address per invoice that appears in no card
 * and links to no other payment.
 *
 * The address in a card is therefore public and reusable, and payments made directly to it
 * — rather than to an invoice address — *are* linkable to this identity. That is the
 * trade-off of having an identity at all, and it is stated rather than hidden.
 */

import { z } from "zod";
import {
  BYTE_SCHEME,
  NETWORKS,
  bytesToHex,
  hexToBytes,
  isHex,
  utf8ToBytes,
  ByteProtocolError,
} from "@byte-protocol/core";
import { ed25519 } from "@noble/curves/ed25519.js";

/**
 * Domain separator.
 *
 * Distinct from the receipt domain, so a signature over one can never be presented as a
 * signature over the other.
 */
export const CARD_DOMAIN = "byte-agent-card-v1";

/**
 * Where a card is published, relative to an agent's origin.
 *
 * `.json` because the response is JSON and a `.well-known` name that says so is easier to
 * serve correctly from a static host, which is where most of these will live.
 */
export const WELL_KNOWN_PATH = "/.well-known/byte-agent.json";

/**
 * The path Byte published before the `.json` name was settled on.
 *
 * A resolver still tries it, so an agent that published under the old name keeps
 * resolving. Publishers should serve the canonical path; serving both costs one alias and
 * means nobody's card silently stops being found.
 */
export const LEGACY_WELL_KNOWN_PATH = "/.well-known/byte-agent-card";

/** Every path a resolver will try, canonical first. */
export const WELL_KNOWN_PATHS = [WELL_KNOWN_PATH, LEGACY_WELL_KNOWN_PATH] as const;

export const AgentCardBodySchema = z.object({
  /** Stable identifier the agent chooses for itself. */
  agentId: z.string().min(1).max(256),
  /** Where the agent can be reached. */
  endpoint: z.url(),
  network: z.enum(NETWORKS),
  /**
   * A unified address that accepts Byte payments.
   *
   * Public and reusable. Invoice addresses are not published here.
   */
  ua: z.string().min(1),
  /** Payment schemes this agent accepts. */
  schemes: z.array(z.string().min(1)).min(1),
  /** Optional human-readable name. Carries no authority. */
  name: z.string().max(256).optional(),
  /** RFC 3339 UTC. */
  issuedAt: z.iso.datetime({ offset: true }),
  /** RFC 3339 UTC. Cards without one never expire, which is rarely what you want. */
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

export type AgentCardBody = z.infer<typeof AgentCardBodySchema>;

export const AgentCardSchema = AgentCardBodySchema.extend({
  /** Ed25519 public key, 32 bytes, lowercase hex. */
  issuer: z.string().refine((v) => isHex(v, 32), "must be 64 lowercase hex characters"),
  /** Ed25519 signature over the canonical body, 64 bytes, lowercase hex. */
  signature: z.string().refine((v) => isHex(v, 64), "must be 128 lowercase hex characters"),
});

export type AgentCard = z.infer<typeof AgentCardSchema>;

/**
 * Canonical serialization.
 *
 * Fields in a fixed order under a domain tag, joined by a null byte, with `schemes` joined
 * by a comma. Not `JSON.stringify`: key order and escaping are engine details, and a
 * signature is only meaningful over bytes both sides reproduce exactly.
 */
export function canonicalCardBytes(body: AgentCardBody): Uint8Array {
  const fields = [
    CARD_DOMAIN,
    body.agentId,
    body.endpoint,
    body.network,
    body.ua,
    body.schemes.join(","),
    body.name ?? "",
    body.issuedAt,
    body.expiresAt ?? "",
  ];
  for (const field of fields) {
    if (field.includes("\u0000")) {
      throw new ByteProtocolError("agent card fields must not contain a null byte");
    }
  }
  // `schemes` is joined with a comma, so a scheme containing one could shift the field
  // boundary and make two different card bodies serialize identically.
  if (body.schemes.some((s) => s.includes(","))) {
    throw new ByteProtocolError("scheme names must not contain a comma");
  }
  return utf8ToBytes(fields.join("\u0000"));
}

export function newAgentKey(): { secretKey: Uint8Array; publicKey: string } {
  const secretKey = ed25519.utils.randomSecretKey();
  return { secretKey, publicKey: bytesToHex(ed25519.getPublicKey(secretKey)) };
}

/** Sign an Agent Card. */
export function signAgentCard(body: AgentCardBody, secretKey: Uint8Array): AgentCard {
  const parsed = AgentCardBodySchema.parse(body);
  return {
    ...parsed,
    issuer: bytesToHex(ed25519.getPublicKey(secretKey)),
    signature: bytesToHex(ed25519.sign(canonicalCardBytes(parsed), secretKey)),
  };
}

export interface VerifyCardOptions {
  /** Require this exact issuer key. */
  expectedIssuer?: string;
  /** Treat the card as invalid once expired. Defaults to true. */
  checkExpiry?: boolean;
  now?: () => number;
}

/**
 * Verify an Agent Card.
 *
 * Returns a boolean, never throws. A card arrives from whoever is serving it, so malformed
 * input is the expected case.
 *
 * A valid signature proves only that the holder of `issuer`'s key made these claims. It
 * does not prove the agent is trustworthy, that the endpoint is under its control, or that
 * the address is one it can spend from. Binding an issuer key to a real-world identity is
 * out of Byte's scope.
 */
export function verifyAgentCard(card: unknown, options: VerifyCardOptions = {}): boolean {
  const parsed = AgentCardSchema.safeParse(card);
  if (!parsed.success) return false;

  const { issuer, signature, ...body } = parsed.data;

  if (options.expectedIssuer !== undefined && issuer !== options.expectedIssuer) return false;

  if (options.checkExpiry !== false && body.expiresAt !== undefined) {
    const now = (options.now ?? Date.now)();
    if (Date.parse(body.expiresAt) <= now) return false;
  }

  try {
    return ed25519.verify(hexToBytes(signature), canonicalCardBytes(body), hexToBytes(issuer));
  } catch {
    return false;
  }
}

/** True when the card advertises Byte's native scheme. */
export function acceptsByte(card: AgentCard): boolean {
  return card.schemes.includes(BYTE_SCHEME);
}
