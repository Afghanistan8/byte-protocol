/**
 * Merkle-root anchoring.
 *
 * An agent can commit to a set of receipts or cards by publishing one 32-byte root. Later it
 * can reveal any single item plus a short proof, and a verifier checks the item belongs to
 * the committed set without seeing the rest.
 *
 * ## Private by default, and what that means
 *
 * The intended anchor is a **shielded self-send** with the root in its memo. Nothing about
 * it is visible on-chain. It proves *existence at a time* only to a party who is shown the
 * transaction and a viewing key (or, when it exists, a payment disclosure).
 *
 * So an anchor is a private timestamp, not a public one. If you want a commitment anyone
 * can check without your cooperation, a shielded self-send is the wrong tool.
 *
 * A **public** anchor (a transparent output carrying the root) is Planned: whether Zcash
 * relays a data-carrier output as standard today has not been verified, and Byte does not
 * offer what it has not checked.
 *
 * This file is the committing and proving. It does not send the transaction.
 */

import { bytesToHex, sha256, utf8ToBytes, ByteProtocolError } from "@byte-protocol/core";

export const ANCHOR_MEMO_PREFIX = "BYTEANCHOR1|";

/** Domain-separated hashes: a leaf can never be mistaken for an interior node. */
const LEAF = 0x00;
const NODE = 0x01;

function hashLeaf(item: Uint8Array): Uint8Array {
  return sha256(Uint8Array.from([LEAF, ...item]));
}

function hashNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(Uint8Array.from([NODE, ...left, ...right]));
}

/**
 * Leaves are hashed with a different prefix from nodes. Without that, a two-item tree's
 * root is a valid "leaf" of a larger tree, which lets an attacker present an interior node
 * as an item (a second-preimage attack on Merkle trees).
 */
export interface MerkleTree {
  root: string;
  leaves: string[];
  /** Layers from the leaves up to the root, as hex. */
  layers: string[][];
}

export function buildTree(items: readonly string[]): MerkleTree {
  if (items.length === 0) throw new ByteProtocolError("cannot anchor an empty set");

  let layer = items.map((item) => hashLeaf(utf8ToBytes(item)));
  const layers: string[][] = [layer.map(bytesToHex)];

  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i] as Uint8Array;
      // An odd node is paired with itself rather than promoted, so every level hashes and
      // the tree shape is a function of the count alone.
      const right = (layer[i + 1] ?? left) as Uint8Array;
      next.push(hashNode(left, right));
    }
    layer = next;
    layers.push(layer.map(bytesToHex));
  }

  return {
    root: bytesToHex(layer[0] as Uint8Array),
    leaves: layers[0] as string[],
    layers,
  };
}

export interface MerkleProof {
  index: number;
  /** Sibling hashes from the leaf level up, each with the side it sits on. */
  path: Array<{ hash: string; side: "left" | "right" }>;
}

export function proveInclusion(tree: MerkleTree, index: number): MerkleProof {
  if (!Number.isInteger(index) || index < 0 || index >= tree.leaves.length) {
    throw new ByteProtocolError(`no leaf at index ${index}`);
  }

  const path: MerkleProof["path"] = [];
  let position = index;
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level] as string[];
    const siblingIndex = position % 2 === 0 ? position + 1 : position - 1;
    const sibling = layer[siblingIndex] ?? layer[position];
    path.push({ hash: sibling as string, side: position % 2 === 0 ? "right" : "left" });
    position = Math.floor(position / 2);
  }
  return { index, path };
}

/** True only if `item` is committed to by `root`. Never throws. */
export function verifyInclusion(root: string, item: string, proof: MerkleProof): boolean {
  try {
    let current = hashLeaf(utf8ToBytes(item));
    for (const step of proof.path) {
      const sibling = Uint8Array.from(Buffer.from(step.hash, "hex"));
      current = step.side === "left" ? hashNode(sibling, current) : hashNode(current, sibling);
    }
    return bytesToHex(current) === root;
  } catch {
    return false;
  }
}

/** The memo for a shielded self-send committing to `root`. */
export function anchorMemo(root: string): string {
  if (!/^[0-9a-f]{64}$/.test(root)) throw new ByteProtocolError("root must be 64 lowercase hex");
  return `${ANCHOR_MEMO_PREFIX}${root}`;
}

/** Read a root back out of a memo, or `undefined` if it is not an anchor. */
export function parseAnchorMemo(memo: string): string | undefined {
  if (!memo.startsWith(ANCHOR_MEMO_PREFIX)) return undefined;
  const root = memo.slice(ANCHOR_MEMO_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(root) ? root : undefined;
}
