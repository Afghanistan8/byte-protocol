import { describe, expect, it } from "vitest";
import {
  BLOCK_TARGET_SECONDS_NU7,
  BLOCK_TARGET_SECONDS_PRE_NU7,
  NETWORK_MAINNET,
  NETWORK_TESTNET,
  NU6_3_ACTIVATION_HEIGHT,
  NU6_3_BRANCH_ID,
  NU6_3_BRANCH_ID_HEX,
  NU7_ACTIVATION_HEIGHT,
  NU7_BRANCH_ID_HEX,
  blockTargetSeconds,
  normalizeBranchId,
  retryAfterSeconds,
} from "./network.js";

/**
 * The 75-vs-25 matrix, decided by consensus branch.
 *
 * This used to be decided by height, against a *published estimate* of 4,386,000 for NU7
 * on testnet. That was a live bug, not a rounding issue: Byte's own testnet run was mined
 * at 4,413,018, above the estimate, so every confirmation wait and `Retry-After` on
 * testnet was already being computed at 25 seconds for a chain still producing blocks
 * every 75 — three times too short, weeks before NU7 activates.
 *
 * ZIP 259 records both activation heights as TBD. A height Byte held would be a forecast,
 * and these waits are real. The branch ID is a fact the chain states about itself.
 */
describe("block spacing", () => {
  it("is 75 seconds on the Ironwood branch", () => {
    expect(blockTargetSeconds(NU6_3_BRANCH_ID_HEX)).toBe(BLOCK_TARGET_SECONDS_PRE_NU7);
  });

  it("is 25 seconds on the NU7 branch", () => {
    expect(blockTargetSeconds(NU7_BRANCH_ID_HEX)).toBe(BLOCK_TARGET_SECONDS_NU7);
  });

  it("falls back to the slower spacing when the branch is unknown", () => {
    // Being wrong towards "wait longer" costs a little latency. Being wrong the other way
    // means retrying three times faster than blocks arrive.
    expect(blockTargetSeconds()).toBe(BLOCK_TARGET_SECONDS_PRE_NU7);
    expect(blockTargetSeconds("deadbeef")).toBe(BLOCK_TARGET_SECONDS_PRE_NU7);
    expect(blockTargetSeconds("")).toBe(BLOCK_TARGET_SECONDS_PRE_NU7);
  });

  it("accepts a branch written any of the ways a server might write it", () => {
    for (const written of ["77190ad9", "0x77190ad9", "77190AD9", "0X77190AD9", " 77190ad9 "]) {
      expect(blockTargetSeconds(written), written).toBe(BLOCK_TARGET_SECONDS_NU7);
    }
  });

  it("does not mistake the superseded NU7 branch value for the real one", () => {
    // The first published NU7 branch ID was 0x77190AD8 and it was corrected to ...AD9.
    // A stale server reporting the old value must not silently get post-NU7 timing.
    expect(blockTargetSeconds("77190ad8")).toBe(BLOCK_TARGET_SECONDS_PRE_NU7);
  });

  it("is not decided by height at all", () => {
    // The height a payment was mined at says nothing about spacing here, by design.
    expect(NU7_ACTIVATION_HEIGHT[NETWORK_MAINNET]).toBeUndefined();
    expect(NU7_ACTIVATION_HEIGHT[NETWORK_TESTNET]).toBeUndefined();
  });

  it("keeps the NU6.3 branch constant and its hex spelling in agreement", () => {
    // Two spellings of one fact: the numeric form is used for transaction building, the
    // hex string for comparing against what a light server reports.
    expect(NU6_3_BRANCH_ID.toString(16)).toBe(NU6_3_BRANCH_ID_HEX);
  });

  it("still knows where Ironwood activated, which is settled", () => {
    // NU6.3 heights are real, published and in the past, unlike NU7's.
    expect(NU6_3_ACTIVATION_HEIGHT[NETWORK_MAINNET]).toBe(3_428_143);
    expect(NU6_3_ACTIVATION_HEIGHT[NETWORK_TESTNET]).toBe(4_134_000);
  });
});

describe("normalizeBranchId", () => {
  it("strips the prefix, the case and the whitespace", () => {
    expect(normalizeBranchId(" 0X37A5165B ")).toBe("37a5165b");
  });
});

describe("retryAfterSeconds", () => {
  it("is one block by default", () => {
    expect(retryAfterSeconds()).toBe(BLOCK_TARGET_SECONDS_PRE_NU7);
  });

  it("follows the branch it is given", () => {
    expect(retryAfterSeconds({ branchId: NU7_BRANCH_ID_HEX })).toBe(BLOCK_TARGET_SECONDS_NU7);
  });

  it("scales with the number of blocks asked for", () => {
    expect(retryAfterSeconds({ blocks: 3 })).toBe(BLOCK_TARGET_SECONDS_PRE_NU7 * 3);
  });

  it("never suggests retrying sooner than ten seconds", () => {
    // At 25-second spacing a client retrying on the nose mostly re-reads the same
    // unconfirmed state. The floor stops a fractional-block request becoming a busy-loop.
    expect(retryAfterSeconds({ branchId: NU7_BRANCH_ID_HEX, blocks: 0 })).toBe(10);
  });
});
