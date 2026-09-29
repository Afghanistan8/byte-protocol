import { describe, expect, it, vi } from "vitest";
import { ByteProtocolError, BytePayerError } from "@byte-protocol/core";
import { SpendGuard } from "./guard.js";

const URL_A = "https://api.example.com/data";
const URL_B = "https://other.example.net/data";

describe("per-call cap", () => {
  it("allows at the cap and denies above it", async () => {
    const guard = new SpendGuard({ maxPerCallZat: "100000" });
    expect((await guard.authorize({ amountZat: "100000", url: URL_A })).allowed).toBe(true);
    const denied = await guard.authorize({ amountZat: "100001", url: URL_A });
    expect(denied).toMatchObject({ allowed: false, reason: "over_per_call_cap" });
  });
});

describe("daily cap", () => {
  it("accumulates across calls and denies when the total would exceed", async () => {
    const guard = new SpendGuard({ maxDailyZat: "100000" });
    expect((await guard.authorize({ amountZat: "60000", url: URL_A })).allowed).toBe(true);
    expect((await guard.authorize({ amountZat: "30000", url: URL_A })).allowed).toBe(true);
    expect(await guard.authorize({ amountZat: "20000", url: URL_A })).toMatchObject({
      allowed: false,
      reason: "over_daily_cap",
    });
    expect(guard.spentTodayZat()).toBe("90000");
  });

  it("rolls off after 24 hours", async () => {
    let clock = 1_000_000_000;
    const guard = new SpendGuard({ maxDailyZat: "100000", now: () => clock });
    await guard.authorize({ amountZat: "100000", url: URL_A });
    expect((await guard.authorize({ amountZat: "1", url: URL_A })).allowed).toBe(false);

    clock += 24 * 60 * 60 * 1000 + 1;
    expect(guard.spentTodayZat()).toBe("0");
    expect((await guard.authorize({ amountZat: "100000", url: URL_A })).allowed).toBe(true);
  });

  it("charges at authorization, so a failed payment still counts until refunded", async () => {
    // Counting only settled payments would let a crash between authorizing and settling
    // lose the record, and a loop of crashing payments would spend without limit.
    const guard = new SpendGuard({ maxDailyZat: "100000" });
    await guard.authorize({ amountZat: "100000", url: URL_A });
    expect(guard.spentTodayZat()).toBe("100000");

    guard.refund("100000");
    expect(guard.spentTodayZat()).toBe("0");
    expect((await guard.authorize({ amountZat: "100000", url: URL_A })).allowed).toBe(true);
  });

  it("ignores a refund for an amount that was never charged", async () => {
    const guard = new SpendGuard({ maxDailyZat: "100000" });
    await guard.authorize({ amountZat: "50000", url: URL_A });
    guard.refund("99999");
    expect(guard.spentTodayZat()).toBe("50000");
  });
});

describe("host allowlist", () => {
  it("allows listed hosts and denies everything else", async () => {
    const guard = new SpendGuard({ allow: ["api.example.com"] });
    expect((await guard.authorize({ amountZat: "1", url: URL_A })).allowed).toBe(true);
    expect(await guard.authorize({ amountZat: "1", url: URL_B })).toMatchObject({
      allowed: false,
      reason: "host_not_allowed",
    });
  });

  it("matches case-insensitively", async () => {
    const guard = new SpendGuard({ allow: ["API.Example.COM"] });
    expect((await guard.authorize({ amountZat: "1", url: URL_A })).allowed).toBe(true);
  });

  it("does not imply subdomains", async () => {
    // Allowing example.com must not allow evil.example.com.
    const guard = new SpendGuard({ allow: ["example.com"] });
    expect(
      (await guard.authorize({ amountZat: "1", url: "https://evil.example.com/x" })).allowed,
    ).toBe(false);
    expect(
      (await guard.authorize({ amountZat: "1", url: "https://example.com/x" })).allowed,
    ).toBe(true);
  });

  it("denies a malformed URL rather than letting it slip past", async () => {
    const guard = new SpendGuard({ allow: ["api.example.com"] });
    expect((await guard.authorize({ amountZat: "1", url: "not a url" })).allowed).toBe(false);
  });

  it("refuses an empty allowlist at construction", () => {
    // Almost certainly a list built from empty config. Failing loudly beats silently
    // blocking every payment at runtime.
    expect(() => new SpendGuard({ allow: [] })).toThrow(ByteProtocolError);
  });
});

describe("approval hook", () => {
  it("allows when it approves and denies when it declines", async () => {
    const approve = vi.fn().mockResolvedValue(true);
    const guard = new SpendGuard({ approve });
    expect((await guard.authorize({ amountZat: "1", url: URL_A })).allowed).toBe(true);
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ amountZat: "1", url: URL_A }),
    );

    const denying = new SpendGuard({ approve: () => false });
    expect(await denying.authorize({ amountZat: "1", url: URL_A })).toMatchObject({
      allowed: false,
      reason: "approval_denied",
    });
  });

  it("denies when the hook throws", async () => {
    // Treating an error as approval would turn a bug in the approval path into unlimited
    // spending.
    const guard = new SpendGuard({
      approve: () => {
        throw new Error("approval service down");
      },
    });
    const decision = await guard.authorize({ amountZat: "1", url: URL_A });
    expect(decision).toMatchObject({ allowed: false, reason: "approval_failed" });
    expect(decision.message).toContain("approval service down");
  });

  it("does not charge the daily budget for a denied payment", async () => {
    const guard = new SpendGuard({ maxDailyZat: "100000", approve: () => false });
    await guard.authorize({ amountZat: "50000", url: URL_A });
    expect(guard.spentTodayZat()).toBe("0");
  });

  it("is not consulted when a cheaper check already denied", async () => {
    const approve = vi.fn().mockResolvedValue(true);
    const guard = new SpendGuard({ allow: ["api.example.com"], approve });
    await guard.authorize({ amountZat: "1", url: URL_B });
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("audit log", () => {
  it("records allowed and denied decisions alike", async () => {
    const guard = new SpendGuard({ maxPerCallZat: "1000", allow: ["api.example.com"] });
    await guard.authorize({ amountZat: "500", url: URL_A, invoiceId: "abc" });
    await guard.authorize({ amountZat: "5000", url: URL_A });
    await guard.authorize({ amountZat: "1", url: URL_B });

    const log = guard.auditLog();
    expect(log).toHaveLength(3);
    expect(log[0]).toMatchObject({ allowed: true, host: "api.example.com", invoiceId: "abc" });
    expect(log[1]).toMatchObject({ allowed: false, reason: "over_per_call_cap" });
    expect(log[2]).toMatchObject({ allowed: false, reason: "host_not_allowed" });
  });

  it("is bounded so a long-running agent cannot exhaust memory", async () => {
    const guard = new SpendGuard({ auditLimit: 10 });
    for (let n = 0; n < 50; n++) await guard.authorize({ amountZat: "1", url: URL_A });
    expect(guard.auditLog()).toHaveLength(10);
  });
});

describe("no controls configured", () => {
  it("allows everything, which is why a guard should be configured", async () => {
    const guard = new SpendGuard();
    expect((await guard.authorize({ amountZat: "999999999", url: URL_B })).allowed).toBe(true);
  });
});

describe("assertAllowed", () => {
  it("throws a payer error on denial and nothing on approval", () => {
    expect(() => SpendGuard.assertAllowed({ allowed: true })).not.toThrow();
    expect(() =>
      SpendGuard.assertAllowed({ allowed: false, reason: "over_daily_cap", message: "nope" }),
    ).toThrow(BytePayerError);
  });
});
