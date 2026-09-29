/**
 * The facilitator.
 *
 * A service that issues invoices and verifies payments **on a payee's behalf, view-only**.
 * It holds a viewing key and no spending key, so a complete compromise of it cannot move
 * a single zatoshi.
 *
 * That is a real guarantee, and it is enforced by the type it accepts: `ViewOnlyWallet`
 * has no `send`. It is not a promise in a README.
 *
 * It is not a free convenience, though. A facilitator learns the payment details of every
 * merchant that delegates to it — amounts, transaction identifiers, timing. Delegating
 * verification is a privacy trade. A payee that verifies for itself discloses nothing to
 * anyone. See docs/SECURITY.md §4.
 */

import {
  BYTE_SCHEME,
  timingSafeEqual,
  type ByteNetwork,
  type InvoiceStore,
} from "@byte-protocol/core";
import { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import { canSpend, type ViewOnlyWallet } from "@byte-protocol/wallet";

export interface FacilitatorOptions {
  /**
   * A view-only wallet.
   *
   * Passing a spending wallet is refused at construction. A facilitator is the one
   * component whose whole security argument is that it cannot spend, and silently
   * accepting spend capability would quietly void it.
   */
  wallet: ViewOnlyWallet;
  store: InvoiceStore;
  secret: Uint8Array;
  /** API key callers must present. At least 32 characters. */
  apiKey: string;
  minConfirmations?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface FacilitatorInfo {
  scheme: typeof BYTE_SCHEME;
  network: ByteNetwork;
  /** Always false. Stated explicitly so a caller can assert it. */
  canSpend: false;
  minConfirmations: number;
  version: string;
}

export interface VerifyRequest {
  invoiceId: string;
  txid: string;
}

export class ByteFacilitator {
  readonly #wallet: ViewOnlyWallet;
  readonly #issuer: InvoiceIssuer;
  readonly #verifier: PaymentVerifier;
  readonly #apiKey: string;
  readonly #minConfirmations: number;

  constructor(options: FacilitatorOptions) {
    if (canSpend(options.wallet)) {
      throw new Error(
        "a facilitator must be given a view-only wallet; this one can spend. " +
          "Wrap it with viewOnly(), or configure byte-walletd with BYTE_WALLETD_UFVK " +
          "instead of BYTE_WALLETD_SEED.",
      );
    }
    if (options.apiKey.length < 32) {
      throw new Error("facilitator apiKey must be at least 32 characters");
    }

    this.#wallet = options.wallet;
    this.#apiKey = options.apiKey;
    this.#minConfirmations = options.minConfirmations ?? 1;

    this.#issuer = new InvoiceIssuer({
      wallet: options.wallet,
      store: options.store,
      secret: options.secret,
      minConfirmations: this.#minConfirmations,
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.#verifier = new PaymentVerifier({
      wallet: options.wallet,
      store: options.store,
      secret: options.secret,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }

  /**
   * Check an API key in constant time.
   *
   * A variable-time comparison leaks, through response timing, how many leading characters
   * were guessed correctly.
   */
  authorize(presented: string | null | undefined): boolean {
    return timingSafeEqual(presented ?? "", this.#apiKey);
  }

  info(): FacilitatorInfo {
    return {
      scheme: BYTE_SCHEME,
      network: this.#wallet.network,
      canSpend: false,
      minConfirmations: this.#minConfirmations,
      version: "0.1.0",
    };
  }

  async issue(amountZat: string) {
    return this.#issuer.issue(amountZat);
  }

  async verify(request: VerifyRequest) {
    return this.#verifier.verify(request.invoiceId, request.txid);
  }

  async health(): Promise<{ ok: boolean; synced: boolean; syncedHeight: number }> {
    const status = await this.#wallet.status();
    return {
      // A facilitator that is not synced cannot verify anything, and says so rather than
      // reporting healthy and then refusing every payment.
      ok: status.synced,
      synced: status.synced,
      syncedHeight: status.syncedHeight,
    };
  }
}
