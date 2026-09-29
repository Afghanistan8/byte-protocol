/**
 * Invoice issuance.
 *
 * Every invoice gets a freshly diversified address and a memo that binds to it. Those two
 * facts together are what make a Byte payment identifiable to its payee and unlinkable to
 * everyone else.
 *
 * See docs/SPEC.md §5.1.
 */

import {
  BYTE_SCHEME,
  buildZip321,
  encodeMemo,
  isZat,
  newInvoiceId,
  parseZat,
  ByteProtocolError,
  type BytePaymentRequirements,
  type ByteNetwork,
  type InvoiceStore,
  type StoredInvoice,
} from "@byte-protocol/core";
import type { ViewOnlyWallet } from "@byte-protocol/wallet";

export interface IssuerOptions {
  wallet: ViewOnlyWallet;
  store: InvoiceStore;
  /**
   * HMAC key for memo bindings. At least 32 bytes.
   *
   * Must come from the environment and must be stable across restarts: a secret that
   * changes invalidates every outstanding invoice, because their memos no longer bind.
   */
  secret: Uint8Array;
  /** How long an invoice stays payable. Defaults to five minutes. */
  ttlMs?: number;
  /**
   * Confirmations required before a payment is accepted.
   *
   * Defaults to 1. Zero is permitted but means a payment can be reorged away after the
   * resource has been served — see docs/SECURITY.md §5.1.
   */
  minConfirmations?: number;
  /** Optional facilitator URL to advertise. */
  facilitator?: string;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class InvoiceIssuer {
  readonly #wallet: ViewOnlyWallet;
  readonly #store: InvoiceStore;
  readonly #secret: Uint8Array;
  readonly #ttlMs: number;
  readonly #minConfirmations: number;
  readonly #facilitator: string | undefined;
  readonly #now: () => number;

  constructor(options: IssuerOptions) {
    if (options.secret.length < 32) {
      throw new ByteProtocolError("memo secret must be at least 32 bytes");
    }
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new ByteProtocolError("ttlMs must be a positive integer");
    }
    const minConfirmations = options.minConfirmations ?? 1;
    if (!Number.isInteger(minConfirmations) || minConfirmations < 0) {
      throw new ByteProtocolError("minConfirmations must be a non-negative integer");
    }

    this.#wallet = options.wallet;
    this.#store = options.store;
    this.#secret = options.secret;
    this.#ttlMs = ttlMs;
    this.#minConfirmations = minConfirmations;
    this.#facilitator = options.facilitator;
    this.#now = options.now ?? Date.now;
  }

  get network(): ByteNetwork {
    return this.#wallet.network;
  }

  /**
   * Mint an invoice for `amountZat`.
   *
   * The address is minted first and the store record written before the requirements are
   * returned, so there is no window in which a payer could hold an invoice the payee has
   * no record of.
   */
  async issue(
    amountZat: string,
    options: { metadata?: Record<string, unknown> } = {},
  ): Promise<BytePaymentRequirements> {
    if (!isZat(amountZat)) {
      throw new ByteProtocolError(
        `amount must be a base-10 integer string of zatoshis, got ${JSON.stringify(amountZat)}`,
      );
    }
    if (parseZat(amountZat) === 0n) {
      throw new ByteProtocolError("amount must be greater than zero");
    }

    const invoiceId = newInvoiceId();
    const payTo = await this.#wallet.newInvoiceAddress();
    const memo = encodeMemo(this.#secret, { invoiceId, amountZat, payTo });

    const createdAt = this.#now();
    const expiresAt = createdAt + this.#ttlMs;

    const stored: StoredInvoice = {
      invoiceId,
      network: this.network,
      amountZat,
      payTo,
      memo,
      minConfirmations: this.#minConfirmations,
      expiresAt,
      createdAt,
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    };

    await this.#store.put(stored);

    return {
      scheme: BYTE_SCHEME,
      network: this.network,
      amount: amountZat,
      asset: "ZEC",
      payTo,
      invoiceId,
      expiresAt: new Date(expiresAt).toISOString(),
      minConfirmations: this.#minConfirmations,
      memo,
      zip321: buildZip321({ address: payTo, amountZat, memo }),
      ...(this.#facilitator !== undefined ? { facilitator: this.#facilitator } : {}),
    };
  }
}
