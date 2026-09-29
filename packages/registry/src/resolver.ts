/**
 * Resolving an agent's card from its origin.
 *
 * Fetches `/.well-known/byte-agent.json` and verifies the signature before returning
 * anything. An unverified card is never handed to a caller, because the only thing a
 * caller is going to do with it is decide where to send money.
 */

import { ByteProtocolError } from "@byte-protocol/core";
import {
  AgentCardSchema,
  WELL_KNOWN_PATHS,
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
 * Tries the canonical `.well-known` path first, then the legacy one, so an agent that
 * published before the name was settled still resolves. A 404 on the first is the only
 * thing that moves on to the second: any other failure — malformed, oversized, bad
 * signature — is reported against the path that produced it rather than silently retried
 * somewhere else.
 *
 * Throws if no path yields a card that verifies. There is no "unverified" return value by
 * design: the only thing a caller does with a card is decide where to send money.
 */
export async function resolveAgentCard(
  origin: string,
  options: ResolveOptions = {},
): Promise<AgentCard> {
  let notFound: ByteProtocolError | undefined;

  for (const path of WELL_KNOWN_PATHS) {
    try {
      return await resolveAt(origin, path, options);
    } catch (error) {
      if (error instanceof CardNotFoundError) {
        notFound ??= new ByteProtocolError(error.message);
        continue;
      }
      throw error;
    }
  }

  throw (
    notFound ??
    new ByteProtocolError(`no agent card found at ${origin}`)
  );
}

/** Thrown internally when a path 404s, so the resolver knows it may try the next one. */
class CardNotFoundError extends ByteProtocolError {}

async function resolveAt(
  origin: string,
  wellKnownPath: string,
  options: ResolveOptions,
): Promise<AgentCard> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let url: string;
  try {
    url = new URL(wellKnownPath, origin).toString();
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

  if (response.status === 404) {
    throw new CardNotFoundError(`${url} returned 404`);
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
