/**
 * The `byte-walletd` backend.
 *
 * Implements the wallet contract over the sidecar's localhost JSON API, so everything above
 * it — issuer, verifier, payer, adapters — runs unchanged against a real chain instead of
 * the mock. That is the whole point of the interface: the protocol code does not know which
 * one it is talking to.
 *
 * ## Why this is a separate class from the mock rather than a flag
 *
 * A wallet that can spend real money and a wallet that cannot should not be the same object
 * with a boolean. `WalletdWallet` requires a token and a reachable sidecar; there is no
 * configuration of it that silently becomes a no-op.
 *
 * ## The view-only split is preserved across HTTP
 *
 * `connectWalletd` asks the sidecar whether it holds a spending key and returns the narrower
 * type when it does not. A facilitator pointed at a view-only sidecar gets a `ViewOnlyWallet`
 * with no `send` — the same guarantee the mock gives, established over the wire.
 */

import {
  ByteProtocolError,
  BytePayerError,
  formatZat,
  isByteNetwork,
} from "@byte-protocol/core";
import type { ByteNetwork, Pool } from "@byte-protocol/core";
import type {
  ReceivedNote,
  SendRequest,
  SendResult,
  ShieldRequest,
  ShieldResult,
  UnshieldRequest,
  UnshieldResult,
  WalletBalance,
  WalletStatus,
} from "./types.js";
import { isTransparentAddressLike } from "./mock.js";
import type { ShieldingWallet, SpendingWallet, ViewOnlyWallet } from "./wallet.js";

/**
 * A delay in seconds, drawn uniformly from the range. Zero when no range is given.
 *
 * Shared with the mock so the two backends schedule identically: a policy that behaves
 * differently in tests than in production is not a tested policy.
 */
function delayFor(range: [number, number] | undefined, random: () => number): number {
  if (range === undefined) return 0;
  const [low, high] = range;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low) {
    throw new ByteProtocolError(
      `delayRangeSec must be [low, high] with 0 <= low <= high, got ${JSON.stringify(range)}`,
    );
  }
  if (high === low) return low;
  return Math.floor(low + random() * (high - low + 1));
}

export interface WalletdOptions {
  /** Base URL of the sidecar, e.g. `http://127.0.0.1:8137`. */
  url: string;
  /** Bearer token: the sidecar's `BYTE_WALLETD_TOKEN`. */
  token: string;
  /** Milliseconds before a request is abandoned. Defaults to 30 seconds. */
  timeoutMs?: number;
  /**
   * Milliseconds before a `send` is abandoned. Defaults to 15 minutes.
   *
   * Separate from `timeoutMs` because the first send downloads the Sapling proving
   * parameters — about 50 MB — and then builds a proof. A 30-second timeout would abandon a
   * payment that is proceeding perfectly well, and the caller would not know whether it had
   * been broadcast.
   */
  sendTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** Injectable waiting, so a shielding delay does not make a test suite sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness, so a random shielding delay is testable. */
  random?: () => number;
}

interface WalletdError {
  code?: string;
  message?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SEND_TIMEOUT_MS = 15 * 60 * 1000;

/** Sidecar error codes that mean the payer refused, not that something broke. */
const PAYER_REFUSALS: Record<string, "wrong_pool_source" | "insufficient_funds"> = {
  wrong_pool_source: "wrong_pool_source",
  insufficient_funds: "insufficient_funds",
};

export class WalletdWallet implements ShieldingWallet {
  readonly network: ByteNetwork;
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #sendTimeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  private constructor(network: ByteNetwork, options: WalletdOptions) {
    this.network = network;
    this.#url = options.url.replace(/\/+$/, "");
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
  }

  /**
   * Connect to a running sidecar.
   *
   * Reads the network from the sidecar rather than taking it as configuration. A wallet
   * configured for one network and pointed at a sidecar on another would send real value
   * somewhere unrecoverable, and there is no reason to allow the two to disagree.
   */
  static async connect(options: WalletdOptions): Promise<WalletdWallet> {
    const probe = new WalletdWallet(
      // Placeholder: replaced below once the sidecar has told us what it is.
      "zcash:05a60a92d99d85997cce3b87616c089f",
      options,
    );

    const health = (await probe.#request("GET", "/health", { authenticated: false })) as {
      network?: unknown;
      canSpend?: unknown;
      version?: unknown;
    };

    if (!isByteNetwork(health.network)) {
      throw new ByteProtocolError(
        `byte-walletd reported network ${JSON.stringify(health.network)}, which Byte does not recognise`,
      );
    }

    return new WalletdWallet(health.network, options);
  }

  /** Whether the sidecar holds a spending key. */
  async canSpend(): Promise<boolean> {
    const health = (await this.#request("GET", "/health", { authenticated: false })) as {
      canSpend?: boolean;
    };
    return health.canSpend === true;
  }

  async newInvoiceAddress(): Promise<string> {
    const response = (await this.#request("POST", "/addresses")) as { address?: unknown };
    if (typeof response.address !== "string") {
      throw new ByteProtocolError("byte-walletd returned no address");
    }
    return response.address;
  }

  async findOutputs(txid: string): Promise<ReceivedNote[]> {
    const response = (await this.#request(
      "GET",
      `/notes?txid=${encodeURIComponent(txid)}`,
    )) as unknown;

    if (!Array.isArray(response)) {
      throw new ByteProtocolError("byte-walletd returned a malformed note list");
    }

    return response.map((raw) => {
      const note = raw as Record<string, unknown>;
      if (
        typeof note.txid !== "string" ||
        typeof note.pool !== "string" ||
        typeof note.valueZat !== "string" ||
        typeof note.confirmations !== "number"
      ) {
        throw new ByteProtocolError("byte-walletd returned a malformed note");
      }

      // `payTo` is deliberately absent: the sidecar cannot report an output's destination
      // address, and the verifier establishes it through the memo binding instead.
      return {
        txid: note.txid,
        pool: note.pool as Pool,
        valueZat: note.valueZat,
        confirmations: note.confirmations,
        ...(typeof note.memo === "string" ? { memo: note.memo } : {}),
        ...(typeof note.height === "number" ? { height: note.height } : {}),
      };
    });
  }

  async status(): Promise<WalletStatus> {
    const response = (await this.#request("GET", "/status")) as {
      syncedHeight?: unknown;
      chainTip?: unknown;
      synced?: unknown;
    };
    return {
      network: this.network,
      syncedHeight: typeof response.syncedHeight === "number" ? response.syncedHeight : 0,
      synced: response.synced === true,
      ...(typeof response.chainTip === "number" ? { chainTip: response.chainTip } : {}),
    };
  }

  async balance(): Promise<WalletBalance> {
    const response = (await this.#request("GET", "/balance")) as Record<string, unknown>;
    for (const field of ["spendableZat", "pendingZat", "unusableZat"] as const) {
      if (typeof response[field] !== "string") {
        throw new ByteProtocolError(`byte-walletd returned no ${field}`);
      }
    }
    return {
      spendableZat: response.spendableZat as string,
      pendingZat: response.pendingZat as string,
      unusableZat: response.unusableZat as string,
    };
  }

  async send(request: SendRequest): Promise<SendResult> {
    const response = (await this.#request("POST", "/send", {
      body: { to: request.to, amountZat: request.amountZat, memo: request.memo },
      timeoutMs: this.#sendTimeoutMs,
    })) as { txid?: unknown; feeZat?: unknown };

    if (typeof response.txid !== "string" || typeof response.feeZat !== "string") {
      throw new ByteProtocolError("byte-walletd returned no txid");
    }
    return { txid: response.txid, feeZat: response.feeZat };
  }

  /**
   * Sweep transparent value into Ironwood.
   *
   * The delay and split policy is enforced **here**, in the client, not in the sidecar.
   * The sidecar builds one transaction at a time and knows nothing about correlation
   * resistance; the timing decision belongs where the caller can see and configure it,
   * and keeping it out of the daemon means the daemon has no timer to get wrong.
   */
  async shield(request: ShieldRequest = {}): Promise<ShieldResult> {
    const splitInto = request.splitInto ?? 1;
    if (!Number.isInteger(splitInto) || splitInto < 1) {
      throw new ByteProtocolError("splitInto must be a positive integer");
    }

    const transactions: ShieldResult["transactions"] = [];
    let shielded = 0n;
    let fees = 0n;

    for (let i = 0; i < splitInto; i++) {
      const delayedSec = delayFor(request.delayRangeSec, this.#random);
      if (delayedSec > 0) await this.#sleep(delayedSec * 1000);

      let response: { txid?: unknown; amountZat?: unknown; feeZat?: unknown };
      try {
        response = (await this.#request("POST", "/shield", {
          body: {
            ...(request.fromTransparent !== undefined
              ? { fromTransparent: request.fromTransparent }
              : {}),
            ...(request.minimumZat !== undefined ? { minimumZat: request.minimumZat } : {}),
            // Ask for a fraction of what is available, so the sidecar does not sweep
            // everything on the first pass and leave the rest of the split with nothing.
            fraction: 1 / (splitInto - i),
          },
          timeoutMs: this.#sendTimeoutMs,
        })) as { txid?: unknown; amountZat?: unknown; feeZat?: unknown };
      } catch (error) {
        // Report what already went out. A caller told "it failed" while three of five
        // transactions are on the chain has been told something false, and will make its
        // next decision on that falsehood.
        if (transactions.length > 0) {
          throw new ByteProtocolError(
            `shielding failed after ${transactions.length} of ${splitInto} transaction(s); ` +
              `${formatZat(shielded)} zatoshis are already shielded ` +
              `(${transactions.map((t) => t.txid).join(", ")})`,
            { cause: error },
          );
        }
        throw error;
      }

      if (typeof response.txid !== "string") {
        // Nothing left worth shielding. Not an error: the sidecar found no UTXO above the
        // minimum, which is the normal end of a sweep.
        break;
      }
      const amountZat = String(response.amountZat ?? "0");
      const feeZat = String(response.feeZat ?? "0");

      transactions.push({ txid: response.txid, amountZat, feeZat, delayedSec });
      shielded += BigInt(amountZat);
      fees += BigInt(feeZat);
    }

    return {
      transactions,
      shieldedZat: formatZat(shielded),
      feeZat: formatZat(fees),
    };
  }

  /**
   * Send value out of Ironwood to a transparent address.
   *
   * Publishes the amount, and the destination is checked here before the request is made
   * so the refusal names the real reason rather than surfacing whatever the sidecar says
   * about an address it could not parse.
   */
  async unshield(request: UnshieldRequest): Promise<UnshieldResult> {
    if (!isTransparentAddressLike(request.toTransparent)) {
      throw new ByteProtocolError(
        `unshield needs a transparent address (t1 or t3); ${request.toTransparent} is not one`,
      );
    }

    const response = (await this.#request("POST", "/unshield", {
      body: { toTransparent: request.toTransparent, amountZat: request.amountZat },
      timeoutMs: this.#sendTimeoutMs,
    })) as { txid?: unknown; feeZat?: unknown };

    if (typeof response.txid !== "string" || typeof response.feeZat !== "string") {
      throw new ByteProtocolError("byte-walletd returned no txid");
    }
    return {
      txid: response.txid,
      feeZat: response.feeZat,
      publicAmountZat: request.amountZat,
    };
  }

  /** Export the viewing key, to hand a facilitator. */
  async viewingKey(): Promise<string> {
    const response = (await this.#request("GET", "/viewing-key")) as { ufvk?: unknown };
    if (typeof response.ufvk !== "string") {
      throw new ByteProtocolError("byte-walletd returned no viewing key");
    }
    return response.ufvk;
  }

  async #request(
    method: string,
    path: string,
    options: { body?: unknown; authenticated?: boolean; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(options.authenticated === false
            ? {}
            : { authorization: `Bearer ${this.#token}` }),
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (cause) {
      throw new ByteProtocolError(
        `could not reach byte-walletd at ${this.#url}${path}. Is it running?`,
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch (cause) {
      throw new ByteProtocolError(`byte-walletd ${path} did not return JSON`, { cause });
    }

    if (!response.ok) {
      const error = parsed as WalletdError;
      const code = error.code ?? "";

      // A refusal to spend is a payer decision, not a transport failure. Surfacing it as
      // BytePayerError lets the spend guard refund and the caller branch on `reason`,
      // exactly as it would with the mock.
      const refusal = PAYER_REFUSALS[code];
      if (refusal !== undefined) {
        throw new BytePayerError(refusal, error.message ?? code);
      }

      throw new ByteProtocolError(
        `byte-walletd ${path} returned ${response.status}${code ? ` (${code})` : ""}: ${
          error.message ?? text.slice(0, 300)
        }`,
      );
    }

    return parsed;
  }
}

/**
 * Connect, returning the narrower type when the sidecar cannot spend.
 *
 * This is how the view-only guarantee survives the HTTP boundary. A facilitator pointed at a
 * sidecar configured with `BYTE_WALLETD_UFVK` gets a `ViewOnlyWallet`, and `ByteFacilitator`
 * will accept it; point it at one holding a seed and the facilitator refuses, as it should.
 */
export async function connectWalletd(
  options: WalletdOptions,
): Promise<ShieldingWallet | ViewOnlyWallet> {
  const wallet = await WalletdWallet.connect(options);
  if (await wallet.canSpend()) return wallet;

  // Build a fresh object rather than returning the same one typed loosely. `shield` and
  // `unshield` are stripped alongside `send`: both move value, and a view-only sidecar
  // will refuse them anyway, so the type should say so before the HTTP call does.
  return {
    network: wallet.network,
    newInvoiceAddress: () => wallet.newInvoiceAddress(),
    findOutputs: (txid) => wallet.findOutputs(txid),
    status: () => wallet.status(),
    balance: () => wallet.balance(),
  };
}
