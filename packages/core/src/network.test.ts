import { describe, expect, it } from "vitest";
import {
  BLOCK_TARGET_SECONDS_NU7,
  BLOCK_TARGET_SECONDS_PRE_NU7,
  NETWORK_MAINNET,
  NETWORK_TESTNET,
  NU7_ACTIVATION_HEIGHT,
  NU6_3_ACTIVATION_HEIGHT,
  blockTargetSeconds,
  retryAfterSeconds,
} from "./network.js";

/**
 * The 75-vs-25 matrix.
 *
 * Block spacing is the one consensus parameter Byte reads at runtime, and until NU7 it was
 * a literal 75 in four places. ZIP 218 makes that wrong by a factor of three, and wrong in
 * the direction that turns a retry hint into a busy-loop against a light server. These
 * tests exist so the next person who reaches for a constant finds a failing test instead.
 */
describe("block spacing across NU7", () => {
  it("is 75 seconds before NU7 on testnet", () => {
    const nu7 = NU7_ACTIVATION_HEIGHT[NETWORK_TESTNET];
    if (nu7 === undefined) throw new Error("testnet NU7 height should be known");

    expect(blockTargetSeconds(NETWORK_TESTNET, nu7 - 1)).toBe(BLOCK_TARGET_SECONDS_PRE_NU7);
    expect(blockTargetSeconds(NETWORK_TESTNET, NU6_3_ACTIVATION_HEIGHT[NETWORK_TESTNET])).toBe(
      BLOCK_TARGET_SECONDS_PRE_NU7,
    );
  });

  it("is 25 seconds from the activation height onwards", () => {
    const nu7 = NU7_ACTIVATION_HEIGHT[NETWORK_TESTNET];
    if (nu7 === undefined) throw new Error("testnet NU7 height should be known");

    // The activation height itself is already NU7: activation is inclusive.
    expect(blockTargetSeconds(NETWORK_TESTNET, nu7)).toBe(BLOCK_TARGET_SECONDS_NU7);
    expect(blockTargetSeconds(NETWORK_TESTNET, nu7 + 100_000)).toBe(BLOCK_TARGET_SECONDS_NU7);
  });

  it("falls back to the slower spacing when the height is unknown", () => {
    // Being wrong towards "wait longer" costs a little latency. Being wrong the other way
    // means a client retries three times faster than blocks arrive.
    expect(blockTargetSeconds(NETWORK_TESTNET)).toBe(BLOCK_TARGET_SECONDS_PRE_NU7);
  });

  it("treats mainnet as pre-NU7 at every height, because the height is not final", () => {
    // Mainnet's activation height is not set until the 20 October 2026 go/no-go. Byte
    // holds no number for it, so no height can flip it early.
    expect(NU7_ACTIVATION_HEIGHT[NETWORK_MAINNET]).toBeUndefined();
    expect(blockTargetSeconds(NETWORK_MAINNET, 999_999_999)).toBe(
      BLOCK_TARGET_SECONDS_PRE_NU7,
    );
  });

  it("does not let the two networks share an answer", () => {
    // Testnet activates a month before mainnet, so for that month the same height means
    // different spacing on each chain. A single global constant cannot express that.
    const nu7 = NU7_ACTIVATION_HEIGHT[NETWORK_TESTNET];
    if (nu7 === undefined) throw new Error("testnet NU7 height should be known");

    expect(blockTargetSeconds(NETWORK_TESTNET, nu7)).not.toBe(
      blockTargetSeconds(NETWORK_MAINNET, nu7),
    );
  });
});

describe("retryAfterSeconds", () => {
  it("is one block by default", () => {
    expect(retryAfterSeconds(NETWORK_MAINNET)).toBe(BLOCK_TARGET_SECONDS_PRE_NU7);
  });

  it("scales with the number of blocks asked for", () => {
    expect(retryAfterSeconds(NETWORK_MAINNET, { blocks: 3 })).toBe(
      BLOCK_TARGET_SECONDS_PRE_NU7 * 3,
    );
  });

  it("never suggests retrying sooner than ten seconds", () => {
    // At 25-second spacing a client retrying on the nose mostly re-reads the same
    // unconfirmed state. The floor stops a fractional-block request becoming a busy-loop.
    const nu7 = NU7_ACTIVATION_HEIGHT[NETWORK_TESTNET];
    if (nu7 === undefined) throw new Error("testnet NU7 height should be known");

    expect(retryAfterSeconds(NETWORK_TESTNET, { height: nu7, blocks: 1 })).toBe(
      BLOCK_TARGET_SECONDS_NU7,
    );
    expect(retryAfterSeconds(NETWORK_TESTNET, { height: nu7, blocks: 0 })).toBe(10);
  });
});
