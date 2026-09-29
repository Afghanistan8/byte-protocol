/**
 * Auto-shielding.
 *
 * Value lands transparent for reasons nobody chose: a rail delivered it there because
 * NEAR Intents supports ZEC at `t1`/`t3` only, an exchange withdrawal went to a
 * transparent address, someone paid the wrong address. Wherever it came from, it sits in
 * public until something moves it, and Byte cannot spend it at all.
 *
 * ## What this buys, stated honestly
 *
 * Shielding **ends** the exposure. It does not undo it. The deposit already happened in
 * public, with its amount and its timing, and nothing done afterwards changes that.
 *
 * What the delay and the split buy is a weaker link between the deposit and the shielding
 * transaction. Shield 4.7 ZEC ninety seconds after 4.7 ZEC arrives and the correlation is
 * free to draw. Shield it as three transactions at randomised intervals over an hour and
 * it is work. That is a real improvement and it is not anonymity, and docs/RAILS.md says
 * the same thing in the same words.
 *
 * ## Why this is a poller and not a subscription
 *
 * There is nothing to subscribe to. A light client learns about its own transparent
 * outputs by scanning, so "did money arrive" is a question you ask, repeatedly. The
 * interval is therefore a real cost knob, not an implementation detail.
 */

import { ByteProtocolError, formatZat, parseZat } from "@byte-protocol/core";
import type { ShieldingWallet } from "./wallet.js";
import type { ShieldResult } from "./types.js";

export interface AutoShieldOptions {
  wallet: ShieldingWallet;
  /**
   * Leave the balance alone until it reaches this.
   *
   * Shielding costs a fee per transaction, so sweeping every arriving dust UTXO
   * immediately spends more on fees than it protects. Defaults to 1,000,000 zatoshis
   * (0.01 ZEC).
   */
  thresholdZat?: string;
  /** How often to look. Defaults to 60 seconds. */
  pollIntervalSec?: number;
  /**
   * Random delay range before shielding, in seconds. Defaults to `[30, 600]`.
   *
   * Randomised rather than fixed: a constant delay is itself a signature, and one that
   * says "this wallet is running Byte's auto-shielder with default settings".
   */
  delayRangeSec?: [number, number];
  /** Split each sweep into this many transactions. Defaults to 1. */
  splitInto?: number;
  /** Called after each successful sweep. */
  onShielded?: (result: ShieldResult) => void;
  /**
   * Called when a sweep fails.
   *
   * A failure must not stop the loop: the commonest cause is a transient light-server
   * error, and a shielder that gives up on the first one leaves value sitting in public
   * indefinitely without telling anybody.
   */
  onError?: (error: unknown) => void;
  /** Injectable timers, so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_THRESHOLD_ZAT = "1000000";
const DEFAULT_POLL_SEC = 60;
const DEFAULT_DELAY_RANGE: [number, number] = [30, 600];

export class AutoShielder {
  readonly #wallet: ShieldingWallet;
  readonly #threshold: bigint;
  readonly #pollIntervalMs: number;
  readonly #delayRange: [number, number];
  readonly #splitInto: number;
  readonly #onShielded: ((result: ShieldResult) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #sleep: (ms: number) => Promise<void>;

  #running = false;
  #stopped = false;

  constructor(options: AutoShieldOptions) {
    const pollSec = options.pollIntervalSec ?? DEFAULT_POLL_SEC;
    if (!Number.isFinite(pollSec) || pollSec <= 0) {
      throw new ByteProtocolError("pollIntervalSec must be a positive number of seconds");
    }

    this.#wallet = options.wallet;
    this.#threshold = parseZat(options.thresholdZat ?? DEFAULT_THRESHOLD_ZAT);
    this.#pollIntervalMs = pollSec * 1000;
    this.#delayRange = options.delayRangeSec ?? DEFAULT_DELAY_RANGE;
    this.#splitInto = options.splitInto ?? 1;
    this.#onShielded = options.onShielded;
    this.#onError = options.onError;
    this.#sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get running(): boolean {
    return this.#running;
  }

  /**
   * Shield once, if there is enough to be worth it.
   *
   * Returns `undefined` when the balance is below the threshold — which is the common
   * case and not an error. Exposed separately from `start` so an operator can sweep on
   * demand, and so the policy is testable without a loop.
   */
  async sweepOnce(): Promise<ShieldResult | undefined> {
    const balance = await this.#wallet.balance();

    // `unusableZat` is value Byte will not spend: transparent, Sapling, or the sealed
    // Orchard pool. Only the transparent part can be shielded, and the wallet reports the
    // three together, so this is a lower bound on the decision rather than an exact one.
    // Erring towards "try, and let shield() find nothing" is cheaper than erring towards
    // never sweeping.
    if (parseZat(balance.unusableZat) < this.#threshold) return undefined;

    const result = await this.#wallet.shield({
      splitInto: this.#splitInto,
      delayRangeSec: this.#delayRange,
    });

    this.#onShielded?.(result);
    return result;
  }

  /**
   * Poll until stopped.
   *
   * Errors are reported and swallowed. A transient light-server failure must not end the
   * loop: value left sitting in public because a poller died quietly is the exact outcome
   * this exists to prevent.
   */
  async start(): Promise<void> {
    if (this.#running) throw new ByteProtocolError("this auto-shielder is already running");
    this.#running = true;
    this.#stopped = false;

    try {
      while (!this.#stopped) {
        try {
          await this.sweepOnce();
        } catch (error) {
          this.#onError?.(error);
        }
        if (this.#stopped) break;
        await this.#sleep(this.#pollIntervalMs);
      }
    } finally {
      this.#running = false;
    }
  }

  /** Ask the loop to finish after its current pass. */
  stop(): void {
    this.#stopped = true;
  }

  /** The threshold, for display. */
  get thresholdZat(): string {
    return formatZat(this.#threshold);
  }
}
