/**
 * A2A agent-card extension.
 *
 * A2A agents publish a card at `/.well-known/agent-card.json`. It has an `extensions` list
 * for capabilities beyond the base protocol, and Byte's payment identity belongs there:
 * "this agent accepts Byte payments, here is where to pay, and here is a signed card that
 * proves it."
 *
 * The extension **carries the signed Byte card verbatim**. It does not restate its fields
 * for a reader to trust, because a restatement can drift from the signed original; a
 * consumer verifies the embedded card's signature and reads its fields from there.
 */

import { ByteProtocolError, BYTE_SCHEME } from "@byte-protocol/core";
import { AgentCardSchema, acceptsByte, verifyAgentCard, type AgentCard } from "./card.js";

/** The extension URI. Namespaced under the repository so it cannot collide with another's. */
export const BYTE_A2A_EXTENSION_URI = "https://github.com/Afghanistan8/byte-protocol/a2a/v1";

export interface A2AExtension {
  uri: string;
  description: string;
  /** Whether a client must understand this to interact. False: Byte is opt-in. */
  required: false;
  params: {
    /** The signed Byte Agent Card, exactly as published. */
    card: AgentCard;
  };
}

/** Build the extension entry to add to an A2A card's `extensions`. */
export function toA2AExtension(card: AgentCard): A2AExtension {
  if (!acceptsByte(card)) {
    throw new ByteProtocolError(
      `this card does not list ${BYTE_SCHEME}, so advertising it as a Byte payment endpoint would mislead`,
    );
  }
  return {
    uri: BYTE_A2A_EXTENSION_URI,
    description:
      "Accepts private, verifiable payments settled in shielded Zcash. The embedded card is " +
      "signed; verify it before paying.",
    // Not required: a client that has never heard of Byte can still talk to this agent.
    required: false,
    params: { card },
  };
}

/**
 * Find and verify the Byte card in an A2A agent card.
 *
 * Returns `undefined` when the extension is absent **or the embedded card does not verify**.
 * There is no "unverified card" return value: the only thing a caller does with one is
 * decide where to send money.
 */
export function fromA2AExtensions(
  a2aCard: unknown,
  options: { expectedIssuer?: string; now?: () => number } = {},
): AgentCard | undefined {
  const extensions = (a2aCard as { extensions?: unknown } | null)?.extensions;
  if (!Array.isArray(extensions)) return undefined;

  const entry = extensions.find(
    (e): e is { uri: string; params?: { card?: unknown } } =>
      typeof e === "object" && e !== null && (e as { uri?: unknown }).uri === BYTE_A2A_EXTENSION_URI,
  );
  const embedded = entry?.params?.card;

  const parsed = AgentCardSchema.safeParse(embedded);
  if (!parsed.success) return undefined;

  const verifyOptions = {
    ...(options.expectedIssuer !== undefined ? { expectedIssuer: options.expectedIssuer } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
  return verifyAgentCard(parsed.data, verifyOptions) ? parsed.data : undefined;
}
