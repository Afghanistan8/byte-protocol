/**
 * Resolving an agent's card from its origin.
 *
 * Fetches `/.well-known/byte-agent-card` and verifies the signature before returning
 * anything. An unverified card is never handed to a caller, because the only thing a
 * caller is going to do with it is decide where to send money.
 */

import { ByteProtocolError } from "@byte-protocol/core";
import {
  AgentCardSchema,
  WELL_KNOWN_PATH,
  verifyAgentCard,
  type AgentCard,
} from "./card.js";

export interface ResolveOptions {
  fetch?: typeof globalThis.fetch;
  expectedIssuer?: string;
  /** Milliseconds before the request is abandoned. Defaults to 10 seconds. */
  timeoutMs?: number;
  /**
   * Maximum response size to read, in bytes. Defaults to 64 KiB.
   *
   * A card is under a kilobyte. Without a cap, resolving a hostile origin is an invitation
   * to stream gigabytes into an agent's memory.
   */
  maxBytes?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

/**
 * Fetch and verify the card published at `origin`.
 *
 * Throws if the card is missing, malformed, oversized, or fails verification. There is no
 * "unverified" return value by design.
 */
export async function resolveAgentCard(
  origin: string,
  options: ResolveOptions = {},
): Promise<AgentCard> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let url: string;
  try {
    url = new URL(WELL_KNOWN_PATH, origin).toString();
  } catch (cause) {
    throw new ByteProtocolError(`not a valid origin: ${origin}`, { cause });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await doFetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    throw new ByteProtocolError(`could not fetch ${url}`, { cause });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new ByteProtocolError(`${url} returned ${response.status}`);
  }

  const text = await response.text();
  if (text.length > maxBytes) {
    throw new ByteProtocolError(
      `agent card at ${url} is ${text.length} bytes, over the ${maxBytes} limit`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new ByteProtocolError(`agent card at ${url} is not valid JSON`, { cause });
  }

  const parsed = AgentCardSchema.safeParse(json);
  if (!parsed.success) {
    throw new ByteProtocolError(`agent card at ${url} does not match the schema`);
  }

  const verifyOptions = {
    ...(options.expectedIssuer !== undefined ? { expectedIssuer: options.expectedIssuer } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
  if (!verifyAgentCard(parsed.data, verifyOptions)) {
    throw new ByteProtocolError(`agent card at ${url} failed verification`);
  }

  return parsed.data;
}

/** Serve a card as a JSON response body. Convenience for card publishers. */
export function serializeAgentCard(card: AgentCard): string {
  return JSON.stringify(card, null, 2);
}
