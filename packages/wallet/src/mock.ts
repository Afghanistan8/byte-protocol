/**
 * A deterministic in-memory wallet, for tests and for running Byte without a chain.
 *
 * This is not a simulation of Zcash. It models exactly the surface Byte depends on —
 * addresses, notes, pools, memos, confirmations — and it deliberately models the ways
 * that surface goes wrong: payments in the wrong pool, short payments, memos that never
 * arrive, transactions that vanish in a reorg. A mock that only does the happy path lets
 * every downstream package ship a verifier that has never once said no.
 *
 * Everything is deterministic. Transaction identifiers derive from a counter and the
 * payment fields, so a failing test reproduces exactly.
 */

import {
  BYTE_POOL,
  BytePayerError,
  formatZat,
  parseZat,
  sha256Hex,
  type ByteNetwork,
  type Pool,
} from "@byte-protocol/core";
import type {
  ReceivedNote,
  SendRequest,
  SendResult,
  WalletBalance,
  WalletStatus,
} from "./types.js";
import type { SpendingWallet, ViewOnlyWallet } from "./wallet.js";

/**
 * Stand-in fee.
 *
 * Real fees follow ZIP 317's proportional mechanism and depend on the action count. The
 * mock charges a flat amount because Byte never quotes or depends on a fee value — it is
 * modelled only so that balances behave, rather than being silently free.
 */
export const MOCK_FEE_ZAT = 10_000n;

interface MockNote {
  txid: string;
  pool: Pool;
  valueZat: bigint;
  payTo: string;
  memo?: string;
  /** Height at which this note was mined; undefined while it is still in the mempool. */
  minedAt?: number;
  dropped: boolean;
}

export interface PayIntoOptions {
  payTo: string;
  amountZat: string;
  memo?: string;
  /**
   * Which pool the value lands in. Defaults to `ironwood`.
   *
   * Set it to anything else to exercise the verifier's pool check without needing a
   * second chain.
   */
  pool?: Pool;
}

/**
 * The shared ledger two mock wallets agree on.
 *
 * Confirmations are derived from height rather than stored, so `mine()` advances every
 * note at once and there is no per-note counter to forget to update.
 */
export class MockChain {
  #height = 100;
  #notes: MockNote[] = [];
  #counter = 0;

  get height(): number {
    return this.#height;
  }

  /**
   * Advance the chain, mining any unmined notes into the next block.
   *
   * A note starts unmined with zero confirmations, exactly as a broadcast transaction
   * does. That matters: `minConfirmations: 0` is a real configuration the spec permits,
   * and its risk is only testable if "seen but unmined" is a state the mock can be in.
   */
  mine(blocks = 1): void {
    if (blocks < 0) throw new RangeError("cannot mine a negative number of blocks");
    for (let i = 0; i < blocks; i++) {
      this.#height += 1;
      for (const note of this.#notes) {
        if (note.minedAt === undefined && !note.dropped) note.minedAt = this.#height;
      }
    }
  }

  /**
   * Make a transaction disappear, as a reorg would.
   *
   * Byte serves resources on the strength of confirmations it has seen. A payee running
   * at zero confirmations can be reorged out from under after it has already delivered,
   * and the spec says so plainly rather than pretending otherwise. This is how that case
   * gets tested.
   */
  drop(txid: string): boolean {
    let dropped = false;
    for (const note of this.#notes) {
      if (note.txid === txid && !note.dropped) {
        note.dropped = true;
        dropped = true;
      }
    }
    return dropped;
  }

  /**
   * Credit an address directly, bypassing any wallet.
   *
   * Used to set up a payer with funds, and to inject the awkward cases: a payment in the
   * wrong pool, one that is short, one whose memo is missing or corrupted.
   */
  payInto(options: PayIntoOptions): string {
    const value = parseZat(options.amountZat);
    const txid = this.#nextTxid(options.payTo, value, options.memo);
    const note: MockNote = {
      txid,
      pool: options.pool ?? BYTE_POOL,
      valueZat: value,
      payTo: options.payTo,
      dropped: false,
    };
    if (options.memo !== undefined) note.memo = options.memo;
    this.#notes.push(note);
    return txid;
  }

  /** Live notes at an address, most recent first. */
  notesFor(payTo: string): ReceivedNote[] {
    return this.#notes
      .filter((n) => n.payTo === payTo && !n.dropped)
      .map((n) => this.#toReceived(n))
      .reverse();
  }

  noteByTxid(txid: string, payTo: string): ReceivedNote | undefined {
    const note = this.#notes.find((n) => n.txid === txid && n.payTo === payTo && !n.dropped);
    return note ? this.#toReceived(note) : undefined;
  }

  /** Spendable Ironwood value at an address, at or above `minConfirmations`. */
  spendableAt(payTo: string, minConfirmations = 1): bigint {
    return this.#notes
      .filter(
        (n) =>
          n.payTo === payTo &&
          !n.dropped &&
          n.pool === BYTE_POOL &&
          this.#confirmations(n) >= minConfirmations,
      )
      .reduce((sum, n) => sum + n.valueZat, 0n);
  }

  /** Value held at an address in pools Byte will not spend from. */
  unusableAt(payTo: string): bigint {
    return this.#notes
      .filter((n) => n.payTo === payTo && !n.dropped && n.pool !== BYTE_POOL)
      .reduce((sum, n) => sum + n.valueZat, 0n);
  }

  /** Ironwood value that exists but has too few confirmations to spend. */
  pendingAt(payTo: string, minConfirmations = 1): bigint {
    return this.#notes
      .filter(
        (n) =>
          n.payTo === payTo &&
          !n.dropped &&
          n.pool === BYTE_POOL &&
          this.#confirmations(n) < minConfirmations,
      )
      .reduce((sum, n) => sum + n.valueZat, 0n);
  }

  /** Mark notes as spent by removing them. Used by the mock's send path. */
  consumeNotes(payTo: string, amount: bigint, minConfirmations = 1): void {
    let remaining = amount;
    for (const note of this.#notes) {
      if (remaining <= 0n) break;
      if (
        note.payTo !== payTo ||
        note.dropped ||
        note.pool !== BYTE_POOL ||
        this.#confirmations(note) < minConfirmations
      ) {
        continue;
      }
      if (note.valueZat <= remaining) {
        remaining -= note.valueZat;
        note.dropped = true;
      } else {
        note.valueZat -= remaining;
        remaining = 0n;
      }
    }
  }

  #confirmations(note: MockNote): number {
    if (note.minedAt === undefined) return 0;
    return Math.max(0, this.#height - note.minedAt + 1);
  }

  #toReceived(note: MockNote): ReceivedNote {
    const received: ReceivedNote = {
      txid: note.txid,
      pool: note.pool,
      valueZat: formatZat(note.valueZat),
      payTo: note.payTo,
      confirmations: this.#confirmations(note),
    };
    if (note.minedAt !== undefined) received.height = note.minedAt;
    if (note.memo !== undefined) received.memo = note.memo;
    return received;
  }

  #nextTxid(payTo: string, value: bigint, memo?: string): string {
    const seed = `${this.#counter++}\u0000${payTo}\u0000${value}\u0000${memo ?? ""}`;
    return sha256Hex(seed);
  }
}

export interface MockWalletOptions {
  network: ByteNetwork;
  chain: MockChain;
  /** Prefix for minted addresses, so payer and payee addresses are distinguishable. */
  addressPrefix?: string;
  /** Confirmations a note needs before this wallet will spend it. */
  minSpendConfirmations?: number;
}

/**
 * A mock wallet.
 *
 * Minted addresses are sequential and prefixed, which keeps test failures readable —
 * `utest1payee-3` says more than 80 characters of bech32.
 */
export class MockWallet implements SpendingWallet {
  readonly network: ByteNetwork;
  readonly #chain: MockChain;
  readonly #prefix: string;
  readonly #minSpendConfirmations: number;
  #addressCounter = 0;
  #minted: string[] = [];

  constructor(options: MockWalletOptions) {
    this.network = options.network;
    this.#chain = options.chain;
    this.#prefix = options.addressPrefix ?? "utest1mock";
    this.#minSpendConfirmations = options.minSpendConfirmations ?? 1;
  }

  /** Every address this wallet has minted, in order. */
  get addresses(): readonly string[] {
    return this.#minted;
  }

  /** The wallet's own funding address. Not handed out for invoices. */
  get fundingAddress(): string {
    return `${this.#prefix}-funding`;
  }

  async newInvoiceAddress(): Promise<string> {
    const address = `${this.#prefix}-${this.#addressCounter++}`;
    this.#minted.push(address);
    return address;
  }

  async findReceived(payTo: string): Promise<ReceivedNote[]> {
    return this.#chain.notesFor(payTo);
  }

  async findByTxid(txid: string, payTo: string): Promise<ReceivedNote | undefined> {
    return this.#chain.noteByTxid(txid, payTo);
  }

  async status(): Promise<WalletStatus> {
    return {
      network: this.network,
      syncedHeight: this.#chain.height,
      chainTip: this.#chain.height,
      synced: true,
    };
  }

  async balance(): Promise<WalletBalance> {
    const address = this.fundingAddress;
    return {
      spendableZat: formatZat(this.#chain.spendableAt(address, this.#minSpendConfirmations)),
      pendingZat: formatZat(this.#chain.pendingAt(address, this.#minSpendConfirmations)),
      unusableZat: formatZat(this.#chain.unusableAt(address)),
    };
  }

  async send(request: SendRequest): Promise<SendResult> {
    const amount = parseZat(request.amountZat);
    const address = this.fundingAddress;
    const spendable = this.#chain.spendableAt(address, this.#minSpendConfirmations);
    const required = amount + MOCK_FEE_ZAT;

    if (spendable < required) {
      // Distinguish "the money is elsewhere" from "there is no money". An operator whose
      // funds sit unshielded needs to be told that, not handed a generic shortfall.
      const unusable = this.#chain.unusableAt(address);
      if (unusable > 0n && unusable + spendable >= required) {
        throw new BytePayerError(
          "wrong_pool_source",
          `only ${spendable} zatoshis are in Ironwood; ${unusable} sit in a pool Byte will not spend from. ` +
            "Byte will not cross pools to make up the difference, because the amount crossing would be public.",
        );
      }
      throw new BytePayerError(
        "insufficient_funds",
        `need ${required} zatoshis including fee, have ${spendable} spendable`,
      );
    }

    this.#chain.consumeNotes(address, required, this.#minSpendConfirmations);
    const txid = this.#chain.payInto({
      payTo: request.to,
      amountZat: request.amountZat,
      memo: request.memo,
      pool: BYTE_POOL,
    });
    return { txid, feeZat: formatZat(MOCK_FEE_ZAT) };
  }
}

/**
 * A view-only facade over a mock wallet.
 *
 * Used to check that code paths meant to be view-only really are. `send` is absent, so
 * `canSpend` reports false and TypeScript refuses the call outright.
 */
export function viewOnly(wallet: SpendingWallet): ViewOnlyWallet {
  return {
    network: wallet.network,
    newInvoiceAddress: () => wallet.newInvoiceAddress(),
    findReceived: (payTo) => wallet.findReceived(payTo),
    findByTxid: (txid, payTo) => wallet.findByTxid(txid, payTo),
    status: () => wallet.status(),
    balance: () => wallet.balance(),
  };
}

export interface MockPair {
  chain: MockChain;
  payer: MockWallet;
  payee: MockWallet;
  /** Credit the payer's funding address and confirm it, so it can spend immediately. */
  fundPayer(amountZat: string, options?: { pool?: Pool; confirm?: boolean }): string;
}

/** A payer and a payee sharing one chain: the standard fixture for an end-to-end test. */
export function createMockPair(network: ByteNetwork): MockPair {
  const chain = new MockChain();
  const payer = new MockWallet({ network, chain, addressPrefix: "utest1payer" });
  const payee = new MockWallet({ network, chain, addressPrefix: "utest1payee" });

  return {
    chain,
    payer,
    payee,
    fundPayer(amountZat, options = {}) {
      const txid = chain.payInto({
        payTo: payer.fundingAddress,
        amountZat,
        ...(options.pool !== undefined ? { pool: options.pool } : {}),
      });
      if (options.confirm !== false) chain.mine(1);
      return txid;
    },
  };
}
