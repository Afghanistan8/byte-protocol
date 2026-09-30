import { describe, expect, it } from "vitest";
import {
  BYTE_SCHEME,
  NETWORK_TESTNET,
  bytesToHex,
  newSigningKey,
  signReceipt,
  type ByteReceipt,
} from "@byte-protocol/core";
import {
  buildTree,
  proveInclusion,
  verifyInclusion,
  anchorMemo,
  parseAnchorMemo,
} from "./anchor.js";
import { newAgentKey, signAgentCard, type AgentCardBody } from "./card.js";
import { BYTE_A2A_EXTENSION_URI, fromA2AExtensions, toA2AExtension } from "./a2a.js";
import { computeReputation, signFeedback, verifyFeedback } from "./reputation.js";

function receipt(payee: ReturnType<typeof newSigningKey>, n: number, amount = "100000"): ByteReceipt {
  return signReceipt(payee.secretKey, {
    invoiceId: String(n).padStart(32, "0"),
    txid: String(n).padStart(64, "b"),
    amount,
    payTo: "utest1x",
    network: NETWORK_TESTNET,
    timestamp: "2026-09-30T00:00:00.000Z",
  });
}

const body = (over: Partial<AgentCardBody> = {}): AgentCardBody => ({
  agentId: "alpha",
  endpoint: "https://alpha.example",
  network: NETWORK_TESTNET,
  ua: "utest1abc",
  schemes: [BYTE_SCHEME],
  issuedAt: "2026-09-30T00:00:00.000Z",
  ...over,
});

describe("feedback", () => {
  const payer = newSigningKey();
  const payee = newSigningKey();
  const base = { invoiceId: "1".padStart(32, "0"), payee: payee.publicKey, rating: 5, timestamp: "2026-09-30T00:00:00.000Z" };

  it("signs and verifies", () => {
    expect(verifyFeedback(signFeedback(payer.secretKey, base))).toBe(true);
  });

  it("refuses tampering", () => {
    const f = signFeedback(payer.secretKey, base);
    expect(verifyFeedback({ ...f, rating: 1 })).toBe(false);
    expect(verifyFeedback({ ...f, payee: newSigningKey().publicKey })).toBe(false);
  });

  it("refuses an out-of-range rating at signing and at verification", () => {
    expect(() => signFeedback(payer.secretKey, { ...base, rating: 6 })).toThrow();
    expect(verifyFeedback({ ...signFeedback(payer.secretKey, base), rating: 9 })).toBe(false);
  });

  it("never throws on junk", () => {
    for (const junk of [null, "x", {}, { author: 1 }]) expect(verifyFeedback(junk)).toBe(false);
  });
});

describe("reputation", () => {
  const payee = newSigningKey();
  const alice = newSigningKey();
  const bob = newSigningKey();
  const fb = (who: typeof alice, n: number, rating: number) =>
    signFeedback(who.secretKey, {
      invoiceId: String(n).padStart(32, "0"),
      payee: payee.publicKey,
      rating,
      timestamp: "2026-09-30T00:00:00.000Z",
    });

  it("sums verified receipts and averages counted ratings", () => {
    const r = computeReputation(
      payee.publicKey,
      [receipt(payee, 1), receipt(payee, 2, "250000")],
      [fb(alice, 1, 5), fb(bob, 2, 3)],
    );
    expect(r).toMatchObject({ verifiedReceipts: 2, settledZat: "350000", distinctRaters: 2, meanRating: 4 });
  });

  it("is null, not zero, with no ratings", () => {
    // Zero would read as a terrible score rather than no evidence.
    expect(computeReputation(payee.publicKey, [receipt(payee, 1)], []).meanRating).toBeNull();
  });

  it("ignores feedback with no receipt behind it", () => {
    // Otherwise anyone could rate an agent they never paid.
    const r = computeReputation(payee.publicKey, [receipt(payee, 1)], [fb(alice, 99, 1)]);
    expect(r.meanRating).toBeNull();
    expect(r.rejected.feedbackWithoutReceipt).toBe(1);
  });

  it("does not let one payer stuff the score by repeating", () => {
    const r = computeReputation(payee.publicKey, [receipt(payee, 1)], [fb(alice, 1, 5), fb(alice, 1, 5), fb(alice, 1, 5)]);
    expect(r.distinctRaters).toBe(1);
    expect(r.rejected.duplicateFeedback).toBe(2);
  });

  it("refuses a valid receipt from a different payee", () => {
    // Otherwise anyone could borrow another agent's history.
    const other = newSigningKey();
    const r = computeReputation(payee.publicKey, [receipt(other, 1)], []);
    expect(r.verifiedReceipts).toBe(0);
    expect(r.rejected.receiptsFromSomeoneElse).toBe(1);
  });

  it("refuses forged receipts and says how many", () => {
    const forged = { ...receipt(payee, 1), amount: "999999999" };
    const r = computeReputation(payee.publicKey, [forged], []);
    expect(r.verifiedReceipts).toBe(0);
    expect(r.rejected.badReceipts).toBe(1);
  });

  it("is independent of input order", () => {
    const rs = [receipt(payee, 1), receipt(payee, 2)];
    const fs = [fb(alice, 1, 5), fb(bob, 2, 2)];
    expect(computeReputation(payee.publicKey, [...rs].reverse(), [...fs].reverse())).toEqual(
      computeReputation(payee.publicKey, rs, fs),
    );
  });
});

describe("merkle anchoring", () => {
  const items = ["a", "b", "c", "d", "e"];

  it("proves every item, including with an odd count", () => {
    const tree = buildTree(items);
    items.forEach((item, i) => {
      expect(verifyInclusion(tree.root, item, proveInclusion(tree, i))).toBe(true);
    });
  });

  it("refuses an item that was not committed", () => {
    const tree = buildTree(items);
    expect(verifyInclusion(tree.root, "z", proveInclusion(tree, 0))).toBe(false);
  });

  it("refuses a proof for a different item", () => {
    const tree = buildTree(items);
    expect(verifyInclusion(tree.root, "b", proveInclusion(tree, 0))).toBe(false);
  });

  it("does not let an interior node pass as a leaf", () => {
    // The classic second-preimage attack on Merkle trees. Leaves and nodes hash with
    // different prefixes precisely so this fails.
    const tree = buildTree(["a", "b"]);
    const interior = tree.root;
    expect(verifyInclusion(buildTree([interior]).root, interior, { index: 0, path: [] })).toBe(true);
    expect(verifyInclusion(tree.root, interior, { index: 0, path: [] })).toBe(false);
  });

  it("changes the root when any item changes", () => {
    expect(buildTree(["a", "b"]).root).not.toBe(buildTree(["a", "c"]).root);
  });

  it("refuses to anchor nothing", () => {
    expect(() => buildTree([])).toThrow(/empty/);
  });

  it("round-trips a root through a memo", () => {
    const { root } = buildTree(items);
    expect(parseAnchorMemo(anchorMemo(root))).toBe(root);
    expect(parseAnchorMemo("BYTE1|abc|def")).toBeUndefined();
    expect(() => anchorMemo("nothex")).toThrow();
  });
});

describe("A2A extension", () => {
  const key = newAgentKey();
  const card = signAgentCard(body(), key.secretKey);
  // A fresh deep copy each call: the tamper test below mutates it, and sharing one object
  // made that mutation poison every test that ran after it.
  const a2a = () => structuredClone({ name: "alpha", extensions: [toA2AExtension(card)] });

  it("embeds the signed card and reads it back", () => {
    expect(fromA2AExtensions(a2a())).toEqual(card);
  });

  it("is not required, so a client unaware of Byte can still talk to the agent", () => {
    expect(toA2AExtension(card).required).toBe(false);
  });

  it("returns nothing when the extension is absent", () => {
    expect(fromA2AExtensions({ extensions: [] })).toBeUndefined();
    expect(fromA2AExtensions({})).toBeUndefined();
    expect(fromA2AExtensions(null)).toBeUndefined();
  });

  it("refuses an embedded card that does not verify, instead of returning it", () => {
    const forged = a2a();
    (forged.extensions[0] as { params: { card: { ua: string } } }).params.card.ua = "utest1attacker";
    expect(fromA2AExtensions(forged)).toBeUndefined();
  });

  it("can pin the expected issuer", () => {
    expect(fromA2AExtensions(a2a(), { expectedIssuer: newAgentKey().publicKey })).toBeUndefined();
    expect(fromA2AExtensions(a2a(), { expectedIssuer: key.publicKey })).toEqual(card);
  });

  it("refuses to advertise a card that does not accept Byte", () => {
    const other = signAgentCard(body({ schemes: ["something-else"] }), key.secretKey);
    expect(() => toA2AExtension(other)).toThrow(/mislead/);
  });

  it("uses a namespaced URI", () => {
    expect(BYTE_A2A_EXTENSION_URI).toContain("byte-protocol");
    expect(bytesToHex(new Uint8Array([1]))).toBe("01");
  });
});
