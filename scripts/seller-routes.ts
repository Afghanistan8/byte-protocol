/**
 * The seller's HTTP surface, separated from the process that runs it.
 *
 * `seller.ts` reads the environment, connects to the sidecar and listens on a
 * port. None of that can be exercised without a funded wallet and a real chain, so the
 * part that decides what the seller *says* lives here instead, where a test can drive it
 * against the mock wallet.
 *
 * Without this split the routes would be in the same position the multi-output payer was
 * in before the fee run: written, plausible, and never once executed.
 */

import type { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import type { ViewOnlyWallet } from "@byte-protocol/wallet";

export interface SellerRoutesOptions {
  issuer: InvoiceIssuer;
  verifier: PaymentVerifier;
  /** Used only to read payments back; the seller never spends. */
  wallet: ViewOnlyWallet;
  priceZat: string;
  /** Called for each notable event, so the process can log and a test need not. */
  onEvent?: (event: SellerEvent) => void;
}

export type SellerEvent =
  | { kind: "issued"; invoiceId: string; amountZat: string; payTo: string }
  | { kind: "settled"; invoiceId: string; txid: string }
  | { kind: "rejected"; invoiceId: string; txid: string; reason: string };

export interface SellerResponse {
  status: number;
  body: unknown;
}

export interface IssuedRecord {
  payTo: string;
  amountZat: string;
  settledBy?: string;
}

export interface SellerRoutes {
  /** Returns null when no route matches, so the caller decides what a 404 looks like. */
  handle(method: string, path: string, body: string): Promise<SellerResponse | null>;
  /** Every invoice this seller has issued, for the summary it prints on the way out. */
  readonly issued: ReadonlyMap<string, IssuedRecord>;
}

export function createSellerRoutes(options: SellerRoutesOptions): SellerRoutes {
  const issued = new Map<string, IssuedRecord>();
  const emit = options.onEvent ?? ((): void => {});

  return {
    issued,

    async handle(method, path, body): Promise<SellerResponse | null> {
      // A marker the page can ask for, so "is a seller here?" is a positive answer rather
      // than the absence of a 404. The dashboard used to probe OPTIONS /invoice and treat
      // any 2xx as a seller, which means any static file server that answers 200 to
      // everything made the page offer a seller that was not there. Nothing here has a
      // side effect, so the page may ask as often as it likes.
      if (method === "GET" && path === "/seller") {
        return {
          status: 200,
          body: { byteSeller: true, network: options.wallet.network, priceZat: options.priceZat },
        };
      }

      if (method === "POST" && path === "/invoice") {
        const invoice = await options.issuer.issue(options.priceZat);
        issued.set(invoice.invoiceId, { payTo: invoice.payTo, amountZat: invoice.amount });
        emit({
          kind: "issued",
          invoiceId: invoice.invoiceId,
          amountZat: invoice.amount,
          payTo: invoice.payTo,
        });
        return { status: 200, body: invoice };
      }

      if (method === "POST" && path === "/settle") {
        let request: { invoiceId?: unknown; txid?: unknown };
        try {
          request = JSON.parse(body) as typeof request;
        } catch {
          return { status: 400, body: { error: "body must be JSON" } };
        }
        if (typeof request.invoiceId !== "string" || typeof request.txid !== "string") {
          return { status: 400, body: { error: "invoiceId and txid are required" } };
        }

        const result = await options.verifier.verify(request.invoiceId, request.txid);

        // Read the payment back off the chain with the seller's viewing key, and return
        // what was actually found. This is the part a browser cannot do for itself, and
        // the reason the first browser run's evidence stopped at a broadcast txid.
        const outputs = (await options.wallet.findOutputs(request.txid)).map((note) => ({
          pool: note.pool,
          valueZat: note.valueZat,
          confirmations: note.confirmations,
          memo: note.memo ?? null,
        }));

        if (result.ok) {
          const record = issued.get(request.invoiceId);
          if (record !== undefined) record.settledBy = request.txid;
          emit({ kind: "settled", invoiceId: request.invoiceId, txid: request.txid });
        } else {
          emit({
            kind: "rejected",
            invoiceId: request.invoiceId,
            txid: request.txid,
            reason: result.reason,
          });
        }

        // Built field by field rather than spread from the verification result. A
        // success carries the whole StoredInvoice, and this body goes to a browser: the
        // seller should decide what it discloses, not inherit it from an internal type.
        return {
          status: 200,
          body: {
            ok: result.ok,
            ...(result.ok
              ? {}
              : {
                  reason: result.reason,
                  message: result.message,
                  ...(result.retryAfterSeconds === undefined
                    ? {}
                    : { retryAfterSeconds: result.retryAfterSeconds }),
                  ...(result.shortfallZat === undefined
                    ? {}
                    : { shortfallZat: result.shortfallZat }),
                }),
            outputs,
            // In full, because the first browser run could not say who had been paid.
            payTo: issued.get(request.invoiceId)?.payTo ?? null,
            everyOutputInIronwood:
              outputs.length > 0 && outputs.every((output) => output.pool === "ironwood"),
          },
        };
      }

      return null;
    },
  };
}
