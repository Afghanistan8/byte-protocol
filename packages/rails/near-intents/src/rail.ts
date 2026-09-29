/**
 * The NEAR Intents funding rail.
 *
 * Swaps an asset on another chain into ZEC and delivers it to a Zcash address, so an agent
 * holding USDC on Base can fund a Byte wallet.
 *
 * ## This rail is public, and that is not fixable here
 *
 * NEAR Intents supports ZEC at **transparent addresses only** — `t1` or `t3`. Their own
 * documentation says "Partially supported - Transparent addresses only". A shielded or
 * unified address is rejected.
 *
 * So every deposit and withdrawal on this rail is an ordinary, public Zcash transaction. The
 * amount, the address and the timing are all on chain, and the transaction that later
 * shields those funds reveals the shielding amount too.
 *
 * Byte does not present this as private. `transparentLeg.public` is `true`, it is stated on
 * every quote, and `docs/RAILS.md` and `docs/SECURITY.md` say so as plainly as this comment
 * does. An operator whose threat model cannot tolerate a public funding leg should fund
 * their wallet with shielded ZEC and not use this rail at all.
 *
 * ## Dry-run by default
 *
 * `dry: true` unless a caller explicitly asks otherwise. A quote that is not dry is a
 * commitment to move real value through a public address, and that should be a deliberate
 * act rather than the consequence of a default.
 *
 * Field names below are from the 1Click OpenAPI document at
 * https://1click.chaindefuser.com/docs/v0/openapi.yaml.
 */

import { ByteProtocolError, isZat } from "@byte-protocol/core";
import type { ByteNetwork } from "@byte-protocol/core";
import type {
  Rail,
  RailQuote,
  RailQuoteRequest,
  RailStatus,
  RailStatusKind,
  TransparentLeg,
} from "@byte-protocol/rails";

export const ONE_CLICK_BASE_URL = "https://1click.chaindefuser.com/v0";

/** 1Click's own status values, from the OpenAPI document. */
export const ONE_CLICK_STATUSES = [
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;

export type OneClickStatus = (typeof ONE_CLICK_STATUSES)[number];

/**
 * Map 1Click's statuses onto Byte's.
 *
 * `INCOMPLETE_DEPOSIT` is mapped to `incomplete` rather than folded into `failed`: it means
 * the funder sent less than the quote required, which is recoverable by topping up, whereas
 * `failed` is not.
 */
const STATUS_MAP: Record<OneClickStatus, RailStatusKind> = {
  PENDING_DEPOSIT: "awaiting_deposit",
  KNOWN_DEPOSIT_TX: "deposit_seen",
  INCOMPLETE_DEPOSIT: "incomplete",
  PROCESSING: "processing",
  SUCCESS: "delivered",
  REFUNDED: "refunded",
  FAILED: "failed",
};

export interface NearIntentsOptions {
  network: ByteNetwork;
  /**
   * The **transparent** Zcash address value is delivered to.
   *
   * Must be `t1` or `t3`. A shielded or unified address is rejected here rather than by the
   * API, so the failure names the real reason.
   */
  recipientTransparentAddress: string;
  /** Where refunds go if the swap fails. An address on the origin chain. */
  refundTo?: string;
  /**
   * JWT for the 1Click API.
   *
   * Without one the service charges an extra 0.25%. That fee is theirs, not Byte's — Byte
   * charges nothing — and it is passed through unchanged.
   */
  jwt?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Seconds a quote stays valid. Defaults to 600. */
  deadlineSeconds?: number;
  /** Slippage tolerance in basis points. Defaults to 100 (1%). */
  slippageToleranceBps?: number;
}

/**
 * Transparent Zcash addresses.
 *
 * `t1` is P2PKH and `t3` is P2SH. Checked by prefix and length rather than by decoding
 * base58check: the point is to catch a shielded or unified address being passed by mistake,
 * which prefix alone does unambiguously, and a genuinely malformed transparent address will
 * be rejected by the API.
 */
export function isTransparentAddress(address: string): boolean {
  return /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
}

export class NearIntentsRail implements Rail {
  readonly railId = "near-intents";
  readonly network: ByteNetwork;

  /** Stated once, on the rail itself, not only per quote. */
  readonly transparentLeg: TransparentLeg = {
    public: true,
    reason:
      "NEAR Intents supports ZEC at transparent addresses only (t1 or t3). The deposit, " +
      "the delivery and their amounts are public Zcash transactions, and the later " +
      "shielding transaction reveals the shielded amount.",
  };

  readonly #recipient: string;
  readonly #refundTo: string | undefined;
  readonly #jwt: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #deadlineSeconds: number;
  readonly #slippageBps: number;

  constructor(options: NearIntentsOptions) {
    if (!isTransparentAddress(options.recipientTransparentAddress)) {
      throw new ByteProtocolError(
        `NEAR Intents delivers ZEC to transparent addresses only (t1 or t3); ` +
          `${options.recipientTransparentAddress} is not one. A shielded or unified address ` +
          `cannot be used here — that is the rail's limitation, and the reason this leg is public.`,
      );
    }

    this.network = options.network;
    this.#recipient = options.recipientTransparentAddress;
    this.#refundTo = options.refundTo;
    this.#jwt = options.jwt;
    this.#baseUrl = options.baseUrl ?? ONE_CLICK_BASE_URL;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#deadlineSeconds = options.deadlineSeconds ?? 600;
    this.#slippageBps = options.slippageToleranceBps ?? 100;
  }

  /** The ZEC asset identifier, resolved from `GET /tokens`. */
  async zecAssetId(): Promise<string> {
    const tokens = (await this.#get("/tokens")) as Array<{
      assetId?: string;
      symbol?: string;
      blockchain?: string;
    }>;
    if (!Array.isArray(tokens)) {
      throw new ByteProtocolError("GET /tokens did not return a list");
    }

    const zec = tokens.find(
      (t) => t.symbol?.toUpperCase() === "ZEC" && t.blockchain?.toLowerCase() === "zec",
    );
    if (zec?.assetId === undefined) {
      throw new ByteProtocolError("NEAR Intents does not list a ZEC asset");
    }
    return zec.assetId;
  }

  /**
   * Request a quote.
   *
   * `dry` defaults to true. A non-dry quote commits to moving real value through a public
   * address, which should be deliberate.
   */
  async quote(request: RailQuoteRequest): Promise<RailQuote> {
    if (!isZat(request.amountOutZat)) {
      throw new ByteProtocolError(
        `amountOutZat must be a base-10 integer string of zatoshis, got ${JSON.stringify(request.amountOutZat)}`,
      );
    }

    const dry = request.dry ?? true;
    const destinationAsset = await this.zecAssetId();
    const refundTo = request.refundTo ?? this.#refundTo;
    if (refundTo === undefined) {
      throw new ByteProtocolError(
        "a refund address is required: without one, a failed swap has nowhere to return value to",
      );
    }

    const body = {
      dry,
      // EXACT_OUTPUT, because Byte funds a known invoice amount: we care what arrives, not
      // what is spent.
      swapType: "EXACT_OUTPUT",
      slippageTolerance: this.#slippageBps,
      originAsset: request.from,
      depositType: "ORIGIN_CHAIN",
      destinationAsset,
      amount: request.amountOutZat,
      refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: this.#recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + this.#deadlineSeconds * 1000).toISOString(),
    };

    const response = (await this.#post("/quote", body)) as {
      quote?: {
        depositAddress?: string;
        depositMemo?: string;
        amountIn?: string;
        amountOut?: string;
        deadline?: string;
      };
      [key: string]: unknown;
    };

    const quote = response.quote;

    // A dry response has no deposit address, by design: 1Click reserves one only when
    // value is actually expected. Demanding one here made the rail's own default — dry —
    // throw against the live API, while every mock supplied one and hid it.
    if (!dry && quote?.depositAddress === undefined) {
      throw new ByteProtocolError(
        "1Click returned no deposit address for a live quote; nothing can be funded without one",
      );
    }

    return {
      railId: this.railId,
      ...(quote?.depositAddress !== undefined
        ? { depositAddress: quote.depositAddress }
        : {}),
      ...(quote?.depositMemo !== undefined ? { depositMemo: quote.depositMemo } : {}),
      amountIn: quote?.amountIn ?? "0",
      amountOutZat: quote?.amountOut ?? request.amountOutZat,
      // A dry response omits `deadline` too, so fall back to the one we asked for.
      deadline: quote?.deadline ?? body.deadline,
      dry,
      transparentLeg: this.transparentLeg,
      raw: response,
    };
  }

  async status(depositAddress: string): Promise<RailStatus> {
    const response = (await this.#get(
      `/status?depositAddress=${encodeURIComponent(depositAddress)}`,
    )) as {
      status?: string;
      updatedAt?: string;
      swapDetails?: { amountOut?: string; destinationChainTxHashes?: Array<{ hash?: string }> };
    };

    const raw = response.status ?? "UNKNOWN";
    const kind = STATUS_MAP[raw as OneClickStatus];
    if (kind === undefined) {
      // An unrecognised status is reported as failed rather than guessed at. Treating an
      // unknown state as success would be the one mistake that costs money.
      return { kind: "failed", raw };
    }

    const amountOut = response.swapDetails?.amountOut;
    const txHash = response.swapDetails?.destinationChainTxHashes?.[0]?.hash;

    return {
      kind,
      raw,
      ...(amountOut !== undefined ? { amountOutZat: amountOut } : {}),
      ...(txHash !== undefined ? { destinationTxHash: txHash } : {}),
      ...(response.updatedAt !== undefined ? { updatedAt: response.updatedAt } : {}),
    };
  }

  #headers(): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      ...(this.#jwt !== undefined ? { authorization: `Bearer ${this.#jwt}` } : {}),
    };
  }

  async #get(path: string): Promise<unknown> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "GET",
      headers: this.#headers(),
    });
    return this.#body(response, path);
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
    });
    return this.#body(response, path);
  }

  async #body(response: Response, path: string): Promise<unknown> {
    const text = await response.text();
    if (!response.ok) {
      throw new ByteProtocolError(
        `1Click ${path} returned ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new ByteProtocolError(`1Click ${path} did not return JSON`, { cause });
    }
  }
}
