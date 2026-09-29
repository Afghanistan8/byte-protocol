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
  assertValidFee,
  type ByteNetwork,
  type FacilitatorFee,
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
  /**
   * Charge a fee, as a second output on every invoice this facilitator issues.
   *
   * Off by default. **Enforced by this facilitator's verification, not by the chain**: a
   * payer who pays the payee directly and skips the facilitator skips the fee. Zcash has
   * no contracts, and Byte does not pretend otherwise. See `core/src/fee.ts`.
   */
  fee?: FacilitatorFee;
  /**
   * A view-only wallet that can see the fee address. **Required whenever `fee` is set.**
   *
   * Separate from `wallet` because they are different keys: `wallet` is the payee's
   * viewing key, and the fee is paid to the facilitator's own address. A facilitator that
   * charged a fee it could not see arriving would refuse nothing and collect nothing, and
   * would find out only when its revenue was zero.
   */
  feeWallet?: ViewOnlyWallet;
  now?: () => number;
}

export interface FacilitatorInfo {
  scheme: typeof BYTE_SCHEME;
  network: ByteNetwork;
  /** Always false. Stated explicitly so a caller can assert it. */
  canSpend: false;
  minConfirmations: number;
  /**
   * The fee this facilitator charges, or `null` when it charges none.
   *
   * Published so a merchant can see the terms before delegating to it, rather than
   * discovering a second output on their first invoice.
   */
  fee: FacilitatorFee | null;
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
  readonly #fee: FacilitatorFee | null;

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

    if (options.fee !== undefined) {
      assertValidFee(options.fee);
      if (options.feeWallet === undefined) {
        throw new Error(
          "a facilitator that charges a fee needs a feeWallet: a view-only wallet that can " +
            "see the fee address. Without one it could not tell whether the fee was paid.",
        );
      }
    }
    if (options.feeWallet !== undefined && canSpend(options.feeWallet)) {
      // The same argument as for `wallet`. The feeWallet exists to *see* fee payments, and
      // giving the one component that verifies for strangers a spending key would void the
      // guarantee that compromising it cannot move funds.
      throw new Error("feeWallet must be view-only; this one can spend");
    }

    this.#wallet = options.wallet;
    this.#apiKey = options.apiKey;
    this.#minConfirmations = options.minConfirmations ?? 1;
    this.#fee = options.fee ?? null;

    this.#issuer = new InvoiceIssuer({
      wallet: options.wallet,
      store: options.store,
      secret: options.secret,
      minConfirmations: this.#minConfirmations,
      ...(options.fee !== undefined ? { facilitatorFee: options.fee } : {}),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.#verifier = new PaymentVerifier({
      wallet: options.wallet,
      store: options.store,
      secret: options.secret,
      ...(options.feeWallet !== undefined ? { feeWallet: options.feeWallet } : {}),
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
      fee: this.#fee,
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
