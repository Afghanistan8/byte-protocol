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
  ByteProtocolError,
  NU6_3_BRANCH_ID_HEX,
  formatZat,
  parseZat,
  sha256Hex,
  type ByteNetwork,
  type Pool,
} from "@byte-protocol/core";
import type {
  ReceivedNote,
  SendOutput,
  SendRequest,
  SendResult,
  ShieldRequest,
  ShieldResult,
  UnshieldRequest,
  UnshieldResult,
  WalletBalance,
  WalletStatus,
} from "./types.js";
import { sendOutputs } from "./types.js";
import type { ShieldingWallet, SpendingWallet, ViewOnlyWallet } from "./wallet.js";

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
  /**
   * Add this output to an existing transaction instead of minting a new one.
   *
   * A real Zcash transaction has several outputs, and Byte depends on that: an invoice's
   * payment and a facilitator's fee are two outputs of *one* transaction, which is what
   * makes them atomic. Without this the mock could only ever model one output per
   * transaction, and every multi-output property would go untested.
   */
  txid?: string;
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
    const txid = options.txid ?? this.#nextTxid(options.payTo, value, options.memo);
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

  /** Every live note in a transaction, in output order. */
  notesForTxid(txid: string): ReceivedNote[] {
    return this.#notes
      .filter((n) => n.txid === txid && !n.dropped)
      .map((n) => this.#toReceived(n));
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

  /**
   * Live transparent notes at an address, smallest first.
   *
   * Smallest first because that is the order shielding wants: sweeping the dust is the
   * point, and leaving it behind is how a wallet accumulates UTXOs it can never
   * economically move.
   */
  transparentNotesAt(payTo: string, minimum = 0n): Array<{ txid: string; valueZat: bigint }> {
    return this.#notes
      .filter((n) => n.payTo === payTo && !n.dropped && n.pool === "transparent")
      .filter((n) => n.valueZat >= minimum)
      .sort((a, b) => (a.valueZat < b.valueZat ? -1 : a.valueZat > b.valueZat ? 1 : 0))
      .map((n) => ({ txid: n.txid, valueZat: n.valueZat }));
  }

  /** Total transparent value at an address. */
  transparentAt(payTo: string): bigint {
    return this.#notes
      .filter((n) => n.payTo === payTo && !n.dropped && n.pool === "transparent")
      .reduce((sum, n) => sum + n.valueZat, 0n);
  }

  /**
   * Spend transparent value, smallest-UTXO first.
   *
   * Returns what it actually consumed, which can be less than asked for. The caller has
   * to look: a shielding transaction that silently moved less than it reported would make
   * the returned `shieldedZat` a lie.
   */
  consumeTransparent(payTo: string, amount: bigint, minimum = 0n): bigint {
    let remaining = amount;
    let taken = 0n;
    for (const note of this.transparentNotesAt(payTo, minimum)) {
      if (remaining <= 0n) break;
      const original = this.#notes.find((n) => n.txid === note.txid && !n.dropped);
      if (original === undefined) continue;

      // Transparent UTXOs are spent whole. Taking part of one is not a thing the chain
      // allows, and modelling it as if it were would hide the fee arithmetic that makes
      // splitting expensive.
      taken += original.valueZat;
      remaining -= original.valueZat;
      original.dropped = true;
    }
    return taken;
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
  /**
   * How the wallet waits, so tests do not.
   *
   * `shield` deliberately delays before broadcasting, and a test suite that actually
   * slept would be unusable. Injecting the wait keeps the *scheduling* under test — the
   * delays are recorded and asserted on — while taking zero real time.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness, so a random delay range is testable. */
  random?: () => number;
  /**
   * The consensus branch this mock chain claims to be on.
   *
   * Defaults to NU6.3, the branch Ironwood activated on. A test wanting post-NU7 timing
   * sets it to `NU7_BRANCH_ID_HEX` rather than moving a height, because heights no longer
   * decide anything.
   */
  consensusBranchId?: string;
}

/**
 * A mock wallet.
 *
 * Minted addresses are sequential and prefixed, which keeps test failures readable —
 * `utest1payee-3` says more than 80 characters of bech32.
 */
export class MockWallet implements ShieldingWallet {
  readonly network: ByteNetwork;
  readonly #chain: MockChain;
  readonly #prefix: string;
  readonly #minSpendConfirmations: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #consensusBranchId: string;
  #addressCounter = 0;
  #transparentCounter = 0;
  #minted: string[] = [];
  #transparentMinted: string[] = [];

  constructor(options: MockWalletOptions) {
    this.network = options.network;
    this.#chain = options.chain;
    this.#prefix = options.addressPrefix ?? "utest1mock";
    this.#minSpendConfirmations = options.minSpendConfirmations ?? 1;
    this.#sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
    this.#consensusBranchId = options.consensusBranchId ?? NU6_3_BRANCH_ID_HEX;
  }

  /**
   * The wallet's transparent address.
   *
   * Real wallets have many; one is enough to model the thing that matters, which is that
   * value sitting here is public and unspendable by Byte until it is shielded.
   */
  get transparentAddress(): string {
    return mockTransparentAddress(`${this.#prefix}base`);
  }

  /** Every transparent address this wallet controls: its base one, then each one minted. */
  get transparentAddresses(): readonly string[] {
    return [this.transparentAddress, ...this.#transparentMinted];
  }

  async newTransparentAddress(): Promise<string> {
    const address = mockTransparentAddress(`${this.#prefix}${this.#transparentCounter++}`);
    this.#transparentMinted.push(address);
    return address;
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

  async findOutputs(txid: string): Promise<ReceivedNote[]> {
    return this.#chain.notesForTxid(txid);
  }

  /**
   * Notes at an address. Mock-only: the real backend cannot answer this, so it is not on
   * the `ViewOnlyWallet` interface. Used by tests to set up and inspect fixtures.
   */
  async notesAt(payTo: string): Promise<ReceivedNote[]> {
    return this.#chain.notesFor(payTo);
  }

  async status(): Promise<WalletStatus> {
    return {
      network: this.network,
      syncedHeight: this.#chain.height,
      chainTip: this.#chain.height,
      synced: true,
      consensusBranchId: this.#consensusBranchId,
    };
  }

  /**
   * Balance across every address this wallet controls.
   *
   * Not just the funding address: invoice addresses are where a payee's money actually
   * arrives, and a wallet that ignored them would report a merchant as empty no matter how
   * much it had been paid. A real wallet reports the whole account, and so does this.
   */
  async balance(): Promise<WalletBalance> {
    // The transparent address is in the list because value sitting there is real, is
    // Byte's, and is the thing auto-shielding exists to notice. Leaving it out made the
    // wallet report a balance of zero while holding a funded transparent UTXO — which is
    // exactly the state an operator most needs to be told about.
    const addresses = [this.fundingAddress, ...this.transparentAddresses, ...this.#minted];
    let spendable = 0n;
    let pending = 0n;
    let unusable = 0n;

    for (const address of addresses) {
      spendable += this.#chain.spendableAt(address, this.#minSpendConfirmations);
      pending += this.#chain.pendingAt(address, this.#minSpendConfirmations);
      unusable += this.#chain.unusableAt(address);
    }

    return {
      spendableZat: formatZat(spendable),
      pendingZat: formatZat(pending),
      unusableZat: formatZat(unusable),
    };
  }

  /**
   * Send one transaction carrying every requested output.
   *
   * **One transaction, not one per output.** That is not a mock convenience: a Byte
   * payment and its facilitator fee are atomic precisely because they are outputs of the
   * same transaction, and a mock that quietly built two would let a verifier pass that
   * depends on atomicity the real chain would not have given it.
   */
  async send(request: SendRequest): Promise<SendResult> {
    const outputs = sendOutputs(request);
    if (outputs.length === 0) {
      throw new ByteProtocolError("a payment needs at least one output");
    }

    const total = outputs.reduce((sum, output) => sum + parseZat(output.amountZat), 0n);
    const address = this.fundingAddress;
    const spendable = this.#chain.spendableAt(address, this.#minSpendConfirmations);
    const required = total + MOCK_FEE_ZAT;

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

    // The first output mints the transaction; the rest join it.
    let txid: string | undefined;
    for (const output of outputs) {
      txid = this.#chain.payInto({
        payTo: output.to,
        amountZat: output.amountZat,
        ...(output.memo !== undefined ? { memo: output.memo } : {}),
        pool: BYTE_POOL,
        ...(txid !== undefined ? { txid } : {}),
      });
    }

    return { txid: txid as string, feeZat: formatZat(MOCK_FEE_ZAT) };
  }

  /**
   * Sweep transparent value into Ironwood.
   *
   * The split is the interesting part. One deposit becoming one shielding transaction of
   * the same size a few minutes later is linkable by inspection — you do not need to
   * break any cryptography, you need to notice that 4.7 ZEC arrived and 4.7 ZEC shielded.
   * Splitting into several transactions at randomised delays breaks that correlation.
   *
   * It is not free: each transaction pays its own fee, so `splitInto: 5` costs five fees
   * rather than one. That trade is the caller's to make, which is why it is a parameter
   * rather than a default.
   */
  async shield(request: ShieldRequest = {}): Promise<ShieldResult> {
    const minimum = request.minimumZat !== undefined ? parseZat(request.minimumZat) : MOCK_FEE_ZAT;
    const splitInto = request.splitInto ?? 1;
    if (!Number.isInteger(splitInto) || splitInto < 1) {
      throw new ByteProtocolError("splitInto must be a positive integer");
    }

    const sources =
      request.fromTransparent !== undefined && request.fromTransparent.length > 0
        ? request.fromTransparent
        : [...this.transparentAddresses];

    const available = sources.reduce(
      (sum: bigint, address: string) => sum + this.#chain.transparentAt(address),
      0n,
    );

    // Every transaction pays its own fee, so a split that cannot cover its fees is not a
    // cheaper split — it is a failure. Say so before broadcasting anything.
    const totalFees = MOCK_FEE_ZAT * BigInt(splitInto);
    if (available <= totalFees) {
      throw new BytePayerError(
        "insufficient_funds",
        `${available} zatoshis of transparent value cannot cover ${splitInto} shielding ` +
          `transaction(s) at ${MOCK_FEE_ZAT} zatoshis each`,
      );
    }

    const transactions: ShieldResult["transactions"] = [];
    let shielded = 0n;
    let fees = 0n;

    // Split by value, giving the remainder to the last transaction rather than dropping it.
    const perTransaction = available / BigInt(splitInto);

    for (let i = 0; i < splitInto; i++) {
      const isLast = i === splitInto - 1;
      const target = isLast ? available - perTransaction * BigInt(splitInto - 1) : perTransaction;

      const delayedSec = this.#delayFor(request.delayRangeSec);
      if (delayedSec > 0) await this.#sleep(delayedSec * 1000);

      let taken = 0n;
      for (const address of sources) {
        if (taken >= target) break;
        taken += this.#chain.consumeTransparent(address, target - taken, minimum);
      }
      if (taken <= MOCK_FEE_ZAT) {
        // Nothing left worth moving. Report what did happen rather than throwing away the
        // transactions already broadcast.
        break;
      }

      const amount = taken - MOCK_FEE_ZAT;
      const txid = this.#chain.payInto({
        payTo: this.fundingAddress,
        amountZat: formatZat(amount),
        pool: BYTE_POOL,
      });

      transactions.push({
        txid,
        amountZat: formatZat(amount),
        feeZat: formatZat(MOCK_FEE_ZAT),
        delayedSec,
      });
      shielded += amount;
      fees += MOCK_FEE_ZAT;
    }

    return {
      transactions,
      shieldedZat: formatZat(shielded),
      feeZat: formatZat(fees),
    };
  }

  /**
   * Move value out of Ironwood to a transparent address.
   *
   * Publishes the amount. ZIP 318 is explicit about it, and `publicAmountZat` in the
   * result exists so that nothing downstream can claim it did not know.
   */
  async unshield(request: UnshieldRequest): Promise<UnshieldResult> {
    if (!isTransparentAddressLike(request.toTransparent)) {
      throw new ByteProtocolError(
        `unshield needs a transparent address (t1 or t3); ${request.toTransparent} is not one. ` +
          "Sending to a shielded address here would leave the value shielded while the " +
          "caller believed it had been unshielded.",
      );
    }

    const amount = parseZat(request.amountZat);
    if (amount === 0n) throw new ByteProtocolError("unshield amount must be greater than zero");

    const required = amount + MOCK_FEE_ZAT;
    const spendable = this.#chain.spendableAt(this.fundingAddress, this.#minSpendConfirmations);
    if (spendable < required) {
      throw new BytePayerError(
        "insufficient_funds",
        `need ${required} zatoshis including fee, have ${spendable} spendable`,
      );
    }

    this.#chain.consumeNotes(this.fundingAddress, required, this.#minSpendConfirmations);
    const txid = this.#chain.payInto({
      payTo: request.toTransparent,
      amountZat: request.amountZat,
      pool: "transparent",
    });

    return {
      txid,
      feeZat: formatZat(MOCK_FEE_ZAT),
      publicAmountZat: request.amountZat,
    };
  }

  /** A delay in seconds, drawn uniformly from the range. Zero when no range is given. */
  #delayFor(range: [number, number] | undefined): number {
    if (range === undefined) return 0;
    const [low, high] = range;
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low) {
      throw new ByteProtocolError(
        `delayRangeSec must be [low, high] with 0 <= low <= high, got ${JSON.stringify(range)}`,
      );
    }
    if (high === low) return low;
    return Math.floor(low + this.#random() * (high - low + 1));
  }
}

/**
 * A transparent address, by shape.
 *
 * `t1` is P2PKH and `t3` is P2SH. Checked by prefix rather than by decoding base58check:
 * the job here is to catch a shielded or unified address passed by mistake, which the
 * prefix settles unambiguously, and the mock has no chain to reject a malformed one.
 */
export function isTransparentAddressLike(address: string): boolean {
  return /^t[13]/.test(address);
}

/**
 * A mock transparent address that is *shaped* like a real one.
 *
 * `t1` plus 33 base58 characters, which is what a real P2PKH address is and what the
 * rails validate against. The readable part survives at the front, so a failure still says
 * `t1utest1railbase…` rather than 35 characters of noise.
 *
 * Shaped correctly on purpose: the mock previously minted `t1utest1rail-transparent`, which
 * no real validator would accept. Tests passed against the mock and the rail rejected every
 * address the moment the two met, which is the kind of gap a mock is supposed to close
 * rather than open.
 */
export function mockTransparentAddress(label: string): string {
  // Base58 excludes 0, O, I and l, so strip anything outside the alphabet.
  const cleaned = label.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "");
  return `t1${(cleaned + "x".repeat(33)).slice(0, 33)}`;
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
    findOutputs: (txid) => wallet.findOutputs(txid),
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
