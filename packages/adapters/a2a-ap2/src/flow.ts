/**
 * Settling and verifying a Byte payment inside an AP2 flow.
 *
 * The merchant side publishes an invoice as a payment method and later verifies the claim.
 * The payer side finds the Byte method in a cart, settles it, and returns the claim.
 */

import { ByteProtocolError } from "@byte-protocol/core";
import type { BytePaymentRequirements } from "@byte-protocol/core";
import type { InvoiceIssuer, PaymentVerifier, VerificationResult } from "@byte-protocol/server";
import { BytePayer, SpendGuard, type SpendGuardOptions } from "@byte-protocol/client";
import type { SpendingWallet } from "@byte-protocol/wallet";
import {
  PAYMENT_MANDATE_DATA_KEY,
  byteInvoiceFromCart,
  fromPaymentMandateData,
  readDataPart,
  toPaymentMandateData,
  toPaymentMethodData,
  type Ap2CartMandate,
  type BytePaymentMandateData,
  type PaymentMethodData,
} from "./method.js";

export interface MerchantOptions {
  issuer: InvoiceIssuer;
  verifier: PaymentVerifier;
}

/**
 * The merchant half.
 *
 * `offer` produces the payment method to put in a cart's `PaymentRequest`. `settle` checks
 * the claim that comes back in a Payment Mandate.
 */
export class ByteAp2Merchant {
  readonly #issuer: InvoiceIssuer;
  readonly #verifier: PaymentVerifier;

  constructor(options: MerchantOptions) {
    this.#issuer = options.issuer;
    this.#verifier = options.verifier;
  }

  /** Mint an invoice and express it as an AP2 payment method. */
  async offer(
    amountZat: string,
  ): Promise<{ method: PaymentMethodData; invoice: BytePaymentRequirements }> {
    const invoice = await this.#issuer.issue(amountZat);
    return { method: toPaymentMethodData(invoice), invoice };
  }

  /**
   * Verify the Byte claim inside a Payment Mandate message.
   *
   * Accepts either the mandate's parts or the Byte claim directly, so this works whether a
   * caller has a whole A2A message or has already pulled the DataPart out.
   */
  async settle(mandateOrParts: unknown): Promise<VerificationResult> {
    const fromParts = readDataPart(mandateOrParts, PAYMENT_MANDATE_DATA_KEY);
    const candidate = fromParts ?? mandateOrParts;

    const claim = fromPaymentMandateData(
      // A Payment Mandate may nest the Byte method under its own payment method data;
      // accept both that and the bare claim.
      (candidate as { payment_method_data?: unknown })?.payment_method_data ?? candidate,
    );

    return this.#verifier.verify(claim.invoiceId, claim.txid);
  }
}

export interface PayerOptions {
  wallet: SpendingWallet;
  guard?: SpendGuard | SpendGuardOptions;
  /**
   * Identifies the merchant for the guard's allowlist and audit log.
   *
   * A2A has no URL at the mandate layer, so one is supplied. Without it a guard's host
   * allowlist has nothing to match against.
   */
  merchantUrl: string;
  now?: () => number;
}

/**
 * The payer half.
 *
 * Settles the Byte method offered by a cart and returns the data to put in a Payment
 * Mandate.
 */
export class ByteAp2Payer {
  readonly #payer: BytePayer;
  readonly #merchantUrl: string;

  constructor(options: PayerOptions) {
    const guard =
      options.guard === undefined
        ? undefined
        : options.guard instanceof SpendGuard
          ? options.guard
          : new SpendGuard(options.guard);

    this.#payer = new BytePayer({
      wallet: options.wallet,
      ...(guard !== undefined ? { guard } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.#merchantUrl = options.merchantUrl;
  }

  /**
   * Pay the Byte method offered by a cart.
   *
   * Throws if the cart offers no Byte method. A caller that wants to fall back to another
   * payment method should check `byteInvoiceFromCart` first, which returns undefined rather
   * than throwing.
   */
  async payCart(
    cart: Ap2CartMandate,
  ): Promise<{ mandateData: BytePaymentMandateData; txid: string; feeZat: string }> {
    const invoice = byteInvoiceFromCart(cart);
    if (invoice === undefined) {
      throw new ByteProtocolError("this cart does not accept the Byte payment method");
    }

    const { payload, txid, feeZat } = await this.#payer.pay(invoice, this.#merchantUrl);

    return {
      mandateData: toPaymentMandateData({
        invoiceId: payload.invoiceId,
        txid: payload.txid,
        network: payload.network,
      }),
      txid,
      feeZat,
    };
  }
}
