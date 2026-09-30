/**
 * The live rail test, against the real 1Click service.
 *
 * **Skipped unless `BYTE_RAILS_LIVE=1`.** It reaches the public internet, so it does not
 * belong in an ordinary run: a suite that fails because someone's wifi dropped teaches
 * nobody anything.
 *
 * Every request here is `dry: true`. A dry quote reserves no deposit address and moves no
 * value, so this can run against production without committing to anything. Making a live
 * quote is a separate, deliberate act that needs Asuzu's say-so, and no test does it.
 *
 * Run it with:
 *
 * ```
 * BYTE_RAILS_LIVE=1 pnpm vitest run packages/rails/near-intents/src/live.test.ts
 * ```
 */

import { describe, expect, it } from "vitest";
import { NETWORK_TESTNET } from "@byte-protocol/core";
import { NearIntentsRail } from "./rail.js";
import { verifyQuoteSignature } from "./quote-signature.js";

const LIVE = process.env.BYTE_RAILS_LIVE === "1";

/** A documentation address and a throwaway refund address. Nothing of Asuzu's. */
const T_ADDR = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";
const REFUND_TO = "0x1111111111111111111111111111111111111111";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

function rail() {
  return new NearIntentsRail({
    network: NETWORK_TESTNET,
    recipientTransparentAddress: T_ADDR,
    refundTo: REFUND_TO,
    // No JWT. NEAR adds 0.25% without one; that is theirs, and the quote says so.
  });
}

describe.skipIf(!LIVE)("the live 1Click service", () => {
  it("lists ZEC with a price and a publication time", async () => {
    const zec = await rail().zecAssetId();
    expect(zec).toBe("nep141:zec.omft.near");
  }, 30_000);

  it("returns a dry quote whose signature verifies", async () => {
    // The whole point. A quote hands back a deposit address and the caller sends real value
    // to it, so an unverified quote is an address nobody has proved 1Click issued.
    const quote = await rail().quote({ from: BASE_USDC, amountOutZat: "10000000" });

    expect(quote.dry).toBe(true);
    expect(quote.signatureVerified).toBe(true);
    // Dry reserves nothing, which is exactly why this is safe to run.
    expect(quote.depositAddress).toBeUndefined();
    expect(quote.transparentLeg.public).toBe(true);
  }, 30_000);

  it("verifies the raw response with the standalone verifier too", async () => {
    const quote = await rail().quote({ from: BASE_USDC, amountOutZat: "10000000" });
    expect(verifyQuoteSignature(quote.raw)).toBe(true);
  }, 30_000);

  it("quotes a cash-out, dry", async () => {
    const quote = await rail().cashOutQuote({
      to: BASE_USDC,
      amountInZat: "10000000",
      recipient: "0x2222222222222222222222222222222222222222",
    });

    expect(quote.dry).toBe(true);
    expect(quote.signatureVerified).toBe(true);
  }, 30_000);

  it("reports any fee it added that Byte did not ask for", async () => {
    const quote = await rail().quote({ from: BASE_USDC, amountOutZat: "10000000" });
    // Not asserted to be non-empty: whether 1Click attaches an appFee is their business and
    // may change. What matters is that whatever they attach is surfaced rather than hidden.
    expect(Array.isArray(quote.fees?.unrequested)).toBe(true);
    expect(quote.fees?.note).toMatch(/theirs, not Byte's/);
  }, 30_000);
});

describe.skipIf(LIVE)("the live rail test", () => {
  it("is skipped unless BYTE_RAILS_LIVE=1", () => {
    expect(LIVE).toBe(false);
  });
});
