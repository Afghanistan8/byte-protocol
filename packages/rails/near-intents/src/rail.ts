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
  CashOutRail,
  RailCashOutRequest,
  RailFees,
  RailQuote,
  RailQuoteRequest,
  RailStatus,
  RailStatusKind,
  TransparentLeg,
} from "@byte-protocol/rails";
import type { ShieldingWallet } from "@byte-protocol/wallet";
import { verifyQuoteSignature } from "./quote-signature.js";

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
   * A **transparent** Zcash address to deliver to, used when no wallet is supplied.
   *
   * Must be `t1` or `t3`. A shielded or unified address is rejected here rather than by the
   * API, so the failure names the real reason.
   *
   * Prefer `wallet`: a fixed address means every funding this rail performs lands on the
   * same public address, and an observer reads that as one party's whole funding history.
   * This stays for callers with no wallet to hand, such as tests.
   */
  recipientTransparentAddress?: string;
  /**
   * A wallet that can mint a fresh transparent address per quote, and shield afterwards.
   *
   * With one, each funding lands on its own address, and `settle()` sweeps the proceeds
   * into Ironwood once the swap succeeds.
   */
  wallet?: ShieldingWallet;
  /**
   * How much the Intents side should hide about the link between deposit and withdrawal.
   *
   * ## The default depends on whether you have a JWT, and here is why
   *
   * The API's own default is `public`, the most revealing setting, so Byte always sends a
   * value rather than letting silence choose.
   *
   * But **every confidential setting requires authentication**. Sending `basic` without a
   * JWT is refused outright:
   *
   * ```
   * 401 "User authentication is required for confidential intent quotes"
   * ```
   *
   * That is not documented alongside the enum; it was found by running the live test. So
   * the default is `basic` when a JWT is configured and `public` when one is not, because
   * a rail that refuses every quote is worse than one that is honest about being public.
   *
   * When it falls back, the quote's fee note says so. Silently getting `public` while
   * believing otherwise is the outcome worth preventing.
   *
   * None of this hides anything on Zcash. The transparent leg is public whatever this says.
   */
  confidentiality?: "public" | "basic" | "advanced";
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

export class NearIntentsRail implements CashOutRail {
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

  readonly #recipient: string | undefined;
  readonly #wallet: ShieldingWallet | undefined;
  readonly #confidentiality: "public" | "basic" | "advanced";
  readonly #confidentialityWasDowngraded: boolean;
  readonly #refundTo: string | undefined;
  readonly #jwt: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #deadlineSeconds: number;
  readonly #slippageBps: number;

  constructor(options: NearIntentsOptions) {
    if (options.recipientTransparentAddress === undefined && options.wallet === undefined) {
      throw new ByteProtocolError(
        "this rail needs either a wallet, which mints a fresh transparent address per " +
          "funding, or a fixed recipientTransparentAddress",
      );
    }
    if (
      options.recipientTransparentAddress !== undefined &&
      !isTransparentAddress(options.recipientTransparentAddress)
    ) {
      throw new ByteProtocolError(
        `NEAR Intents delivers ZEC to transparent addresses only (t1 or t3); ` +
          `${options.recipientTransparentAddress} is not one. A shielded or unified address ` +
          `cannot be used here: that is the rail's limitation, and the reason this leg is public.`,
      );
    }

    this.network = options.network;
    this.#recipient = options.recipientTransparentAddress;
    this.#wallet = options.wallet;
    // `basic` and `advanced` both need a JWT; without one the service answers 401. Asking
    // for the confidential setting anyway would make every quote fail.
    this.#confidentiality =
      options.confidentiality ?? (options.jwt !== undefined ? "basic" : "public");
    this.#confidentialityWasDowngraded =
      options.confidentiality === undefined && options.jwt === undefined;
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
   * Quote a funding: some other asset in, ZEC out at a transparent Zcash address.
   *
   * `dry` defaults to true. A live quote reserves a deposit address and commits to moving
   * real value through a public address, which should be a deliberate act rather than the
   * consequence of a default.
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

    // A fresh transparent address per funding when a wallet can mint one. Reusing a single
    // address hands an observer every funding this rail has ever done, tied together.
    const recipient = await this.#recipientAddress();

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
      recipient,
      recipientType: "DESTINATION_CHAIN",
      confidentiality: this.#confidentiality,
      deadline: new Date(Date.now() + this.#deadlineSeconds * 1000).toISOString(),
    };

    return this.#quote(body, dry, request.amountOutZat);
  }

  /**
   * Quote a cash-out: shielded ZEC in, some other asset out.
   *
   * **This publishes the amount.** The wallet has to send ZEC from Ironwood to 1Click's
   * deposit address, which is transparent, so the amount leaving the shielded pool is on
   * the public chain (ZIP 318). No arrangement of this avoids that. Cashing out is how
   * value leaves Byte's guarantee.
   *
   * `refundTo` is a fresh transparent address of this wallet, so a refunded swap returns
   * somewhere the auto-shielder is watching rather than somewhere nobody is.
   */
  async cashOutQuote(request: RailCashOutRequest): Promise<RailQuote> {
    if (!isZat(request.amountInZat)) {
      throw new ByteProtocolError(
        `amountInZat must be a base-10 integer string of zatoshis, got ${JSON.stringify(request.amountInZat)}`,
      );
    }
    if (request.recipient.length === 0) {
      throw new ByteProtocolError("a cash-out needs a recipient on the destination chain");
    }

    const dry = request.dry ?? true;
    const originAsset = await this.zecAssetId();
    const refundTo = await this.#recipientAddress();

    const body = {
      dry,
      // EXACT_INPUT, not EXACT_OUTPUT: a cash-out spends a known amount of ZEC and takes
      // what that buys. Asking for an exact output would let the ZEC spent vary, and the
      // wallet has to commit to a specific amount leaving the shielded pool.
      swapType: "EXACT_INPUT",
      slippageTolerance: this.#slippageBps,
      originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: request.to,
      amount: request.amountInZat,
      refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: request.recipient,
      recipientType: "DESTINATION_CHAIN",
      confidentiality: this.#confidentiality,
      deadline: new Date(Date.now() + this.#deadlineSeconds * 1000).toISOString(),
    };

    return this.#quote(body, dry, request.amountInZat);
  }

  /**
   * Send ZEC out of Ironwood to fulfil a cash-out quote.
   *
   * Separate from `cashOutQuote` on purpose: quoting is free and reversible, and this moves
   * money. Everything checkable is checked before anything is built, because a mistake here
   * is irreversible rather than merely failed.
   */
  async payCashOut(quote: RailQuote): Promise<{ txid: string; feeZat: string }> {
    const wallet = this.#wallet;
    if (wallet === undefined) {
      throw new ByteProtocolError("paying a cash-out needs a wallet that can spend");
    }
    if (quote.dry) {
      throw new ByteProtocolError(
        "this is a dry quote: it reserved no deposit address, so there is nowhere to send to",
      );
    }
    if (quote.depositAddress === undefined) {
      throw new ByteProtocolError("this quote carries no deposit address");
    }
    if (!quote.signatureVerified) {
      // The deposit address is exactly the field worth forging, and an unverified quote is
      // one nobody has proved 1Click issued.
      throw new ByteProtocolError(
        "refusing to send to an unverified quote: its signature did not check out, and the " +
          "deposit address is the field an attacker would swap",
      );
    }
    // A transparent output cannot carry a memo. If 1Click wants one, this route cannot
    // satisfy it, and saying so beats broadcasting value the service cannot attribute.
    if (quote.depositMemo !== undefined) {
      throw new ByteProtocolError(
        "this quote requires a deposit memo, and a transparent Zcash output cannot carry one",
      );
    }
    // For a cash-out the deposit address is on the origin chain, which is Zcash. Anything
    // else means the response is not what this code thinks it is.
    if (!isTransparentAddress(quote.depositAddress)) {
      throw new ByteProtocolError(
        `1Click returned ${quote.depositAddress} as the deposit address, which is not a ` +
          "transparent Zcash address; refusing to send",
      );
    }

    const result = await wallet.unshield({
      toTransparent: quote.depositAddress,
      amountZat: quote.amountIn,
    });
    return { txid: result.txid, feeZat: result.feeZat };
  }

  /**
   * Tell 1Click about a deposit rather than waiting for it to notice.
   *
   * Optional in their flow, and worth doing: it shortens the gap between paying and the
   * swap starting.
   */
  async submitDeposit(options: {
    txHash: string;
    depositAddress: string;
    depositMemo?: string;
  }): Promise<RailStatus> {
    const response = (await this.#post("/deposit/submit", {
      txHash: options.txHash,
      depositAddress: options.depositAddress,
      ...(options.depositMemo !== undefined ? { memo: options.depositMemo } : {}),
    })) as Record<string, unknown>;

    return this.#toStatus(response);
  }

  /**
   * Finish a funding: once the swap has delivered, shield what arrived.
   *
   * The rail delivers to a transparent address, so the funds sit in public until something
   * moves them, and Byte cannot spend them at all until they are in Ironwood. Shielding
   * ends that exposure. It does not undo the public delivery that already happened.
   *
   * Returns no `shieldedZat` while the swap is still running, which is the ordinary case
   * during polling rather than a failure.
   */
  async settle(depositAddress: string): Promise<{ status: RailStatus; shieldedZat?: string }> {
    const status = await this.status(depositAddress);
    if (status.kind !== "delivered") return { status };

    const wallet = this.#wallet;
    if (wallet === undefined) {
      throw new ByteProtocolError(
        "the swap delivered, but this rail has no wallet to shield the proceeds with",
      );
    }

    const shielded = await wallet.shield();
    return { status, shieldedZat: shielded.shieldedZat };
  }

  /** A fresh transparent address when a wallet can mint one, else the fixed one. */
  async #recipientAddress(): Promise<string> {
    if (this.#wallet !== undefined) {
      const address = await this.#wallet.newTransparentAddress();
      if (!isTransparentAddress(address)) {
        throw new ByteProtocolError(
          `the wallet minted ${address}, which is not a transparent address; NEAR Intents ` +
            "delivers ZEC to t1 or t3 only",
        );
      }
      return address;
    }
    // The constructor guarantees one of the two is present.
    return this.#recipient as string;
  }

  /** Post a quote body, check the signature, and normalize the response. */
  async #quote(
    body: Record<string, unknown>,
    dry: boolean,
    fallbackAmount: string,
  ): Promise<RailQuote> {
    const response = (await this.#post("/quote", body)) as {
      quote?: {
        depositAddress?: string;
        depositMemo?: string;
        amountIn?: string;
        amountOut?: string;
        deadline?: string;
        refundFee?: string;
        withdrawFee?: string;
      };
      quoteRequest?: { appFees?: Array<{ recipient?: string; fee?: number }> };
      signature?: string;
      [key: string]: unknown;
    };

    const quote = response.quote;

    // A dry response has no deposit address, by design: 1Click reserves one only when value
    // is actually expected. Demanding one here made the rail's own default throw against
    // the live API, while every mock supplied one and hid it.
    if (!dry && quote?.depositAddress === undefined) {
      throw new ByteProtocolError(
        "1Click returned no deposit address for a live quote; nothing can be funded without one",
      );
    }

    return {
      railId: this.railId,
      ...(quote?.depositAddress !== undefined ? { depositAddress: quote.depositAddress } : {}),
      ...(quote?.depositMemo !== undefined ? { depositMemo: quote.depositMemo } : {}),
      amountIn: quote?.amountIn ?? "0",
      amountOutZat: quote?.amountOut ?? fallbackAmount,
      // A dry response omits `deadline` too, so fall back to the one we asked for.
      deadline: quote?.deadline ?? (body.deadline as string),
      dry,
      transparentLeg: this.transparentLeg,
      signatureVerified: verifyQuoteSignature(response),
      fees: this.#feesFrom(response),
      raw: response,
    };
  }

  /**
   * NEAR's fees, itemised, and never mixed with Byte's.
   *
   * `appFees` is listed apart because 1Click attaches its own and Byte never asks for one.
   * A charge the caller did not request is the one they most need to see.
   */
  #feesFrom(response: {
    quote?: { refundFee?: string; withdrawFee?: string };
    quoteRequest?: { appFees?: Array<{ recipient?: string; fee?: number }> };
  }): RailFees {
    const items: RailFees["items"] = [];
    if (response.quote?.withdrawFee !== undefined) {
      items.push({ label: "withdraw", amount: response.quote.withdrawFee });
    }
    if (response.quote?.refundFee !== undefined) {
      items.push({ label: "refund", amount: response.quote.refundFee });
    }

    const unrequested: RailFees["unrequested"] = (response.quoteRequest?.appFees ?? []).map(
      (fee) => ({
        label: `appFee${fee.recipient !== undefined ? ` to ${fee.recipient}` : ""}`,
        amount: String(fee.fee ?? 0),
        asset: "bps",
      }),
    );

    const notes: string[] = [];
    if (this.#jwt === undefined) {
      notes.push(
        "No JWT is configured, so NEAR Intents adds 0.25%. That fee is theirs, not Byte's.",
      );
    }
    if (this.#confidentialityWasDowngraded) {
      // Said out loud, because believing a quote is confidential when it is not is worse
      // than knowing it is public.
      notes.push(
        "confidentiality is 'public': the confidential settings need a 1Click JWT, and " +
          "without one the service refuses the quote outright.",
      );
    }

    return {
      items,
      unrequested,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
  }

  async status(depositAddress: string): Promise<RailStatus> {
    const response = (await this.#get(
      `/status?depositAddress=${encodeURIComponent(depositAddress)}`,
    )) as Record<string, unknown>;

    return this.#toStatus(response);
  }

  /**
   * Map a 1Click status payload onto Byte's.
   *
   * Shared by `status` and `submitDeposit`, which return the same shape: one mapping means
   * the two cannot drift into disagreeing about what a status means.
   */
  #toStatus(response: Record<string, unknown>): RailStatus {
    const body = response as {
      status?: string;
      updatedAt?: string;
      swapDetails?: { amountOut?: string; destinationChainTxHashes?: Array<{ hash?: string }> };
    };

    const raw = body.status ?? "UNKNOWN";
    const kind = STATUS_MAP[raw as OneClickStatus];
    if (kind === undefined) {
      // An unrecognised status is reported as failed rather than guessed at. Treating an
      // unknown state as success would be the one mistake that costs money.
      return { kind: "failed", raw };
    }

    const amountOut = body.swapDetails?.amountOut;
    const txHash = body.swapDetails?.destinationChainTxHashes?.[0]?.hash;

    return {
      kind,
      raw,
      ...(amountOut !== undefined ? { amountOutZat: amountOut } : {}),
      ...(txHash !== undefined ? { destinationTxHash: txHash } : {}),
      ...(body.updatedAt !== undefined ? { updatedAt: body.updatedAt } : {}),
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
