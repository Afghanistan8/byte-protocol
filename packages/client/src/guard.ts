/**
 * The spend guard.
 *
 * An autonomous agent with a spending key and a bug is a wallet-draining machine. The
 * guard is the thing standing between "the agent decided to pay" and "money left". It is
 * evaluated *before* a transaction is constructed, so a denial costs nothing and leaks
 * nothing on-chain.
 *
 * Two design rules:
 *
 * 1. **Deny by default.** A configured control that cannot be satisfied denies. A guard
 *    that fails open is not a guard.
 * 2. **Charge the daily budget at authorization, not at settlement.** If a payment is
 *    authorized and then fails, the amount stays charged until it is explicitly refunded.
 *    Counting only settled payments would let a crash between authorizing and settling
 *    lose the record, and a loop of crashing payments would spend without limit.
 */

import { ByteProtocolError, BytePayerError, parseZat } from "@byte-protocol/core";

export interface SpendRequest {
  /** Zatoshis, canonical integer string. */
  amountZat: string;
  /** The resource being paid for. Used for the host allowlist and the audit log. */
  url: string;
  invoiceId?: string;
}

export type GuardDenialReason =
  | "host_not_allowed"
  | "over_per_call_cap"
  | "over_daily_cap"
  | "approval_denied"
  | "approval_failed";

export interface GuardDecision {
  allowed: boolean;
  reason?: GuardDenialReason;
  message?: string;
}

export interface AuditEntry {
  /** Epoch milliseconds. */
  at: number;
  url: string;
  host: string;
  amountZat: string;
  invoiceId?: string;
  allowed: boolean;
  reason?: GuardDenialReason;
  message?: string;
}

export interface SpendGuardOptions {
  /** Deny any single payment above this. */
  maxPerCallZat?: string;
  /** Deny once the rolling 24-hour total would exceed this. */
  maxDailyZat?: string;
  /**
   * Hosts that may be paid.
   *
   * Compared against the URL's hostname exactly, case-insensitively. Subdomains are not
   * implied: allowing `example.com` does not allow `api.example.com`. Wildcards are not
   * supported, because a guard whose rules are hard to read is a guard nobody audits.
   */
  allow?: string[];
  /** Must resolve true before any payment is authorized. */
  approve?: (request: SpendRequest) => boolean | Promise<boolean>;
  /** How many audit entries to retain. Defaults to 1000. */
  auditLimit?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AUDIT_LIMIT = 1000;

interface Charge {
  at: number;
  amount: bigint;
}

export class SpendGuard {
  readonly #maxPerCall: bigint | undefined;
  readonly #maxDaily: bigint | undefined;
  readonly #allow: Set<string> | undefined;
  readonly #approve: SpendGuardOptions["approve"];
  readonly #auditLimit: number;
  readonly #now: () => number;

  #charges: Charge[] = [];
  #audit: AuditEntry[] = [];

  constructor(options: SpendGuardOptions = {}) {
    this.#maxPerCall =
      options.maxPerCallZat !== undefined ? parseZat(options.maxPerCallZat) : undefined;
    this.#maxDaily =
      options.maxDailyZat !== undefined ? parseZat(options.maxDailyZat) : undefined;
    this.#allow =
      options.allow !== undefined
        ? new Set(options.allow.map((h) => h.trim().toLowerCase()))
        : undefined;
    this.#approve = options.approve;
    this.#auditLimit = options.auditLimit ?? DEFAULT_AUDIT_LIMIT;
    this.#now = options.now ?? Date.now;

    if (this.#allow?.size === 0) {
      // An empty allowlist denies everything. That is almost certainly a misconfiguration
      // — someone built the list from an empty config — so it fails loudly at construction
      // rather than silently blocking every payment at runtime.
      throw new ByteProtocolError(
        "allow list is empty, which would deny every payment; omit it to allow any host",
      );
    }
  }

  /**
   * Decide whether a payment may proceed, charging the daily budget if it may.
   *
   * Call `refund` if the payment subsequently fails.
   */
  async authorize(request: SpendRequest): Promise<GuardDecision> {
    const at = this.#now();
    const host = hostOf(request.url);
    const amount = parseZat(request.amountZat);

    const deny = (reason: GuardDenialReason, message: string): GuardDecision => {
      this.#record({
        at,
        url: request.url,
        host,
        amountZat: request.amountZat,
        ...(request.invoiceId !== undefined ? { invoiceId: request.invoiceId } : {}),
        allowed: false,
        reason,
        message,
      });
      return { allowed: false, reason, message };
    };

    if (this.#allow !== undefined && !this.#allow.has(host)) {
      return deny("host_not_allowed", `${host} is not in the allow list`);
    }

    if (this.#maxPerCall !== undefined && amount > this.#maxPerCall) {
      return deny(
        "over_per_call_cap",
        `${amount} exceeds the per-call cap of ${this.#maxPerCall} zatoshis`,
      );
    }

    if (this.#maxDaily !== undefined) {
      const spent = this.#spentSince(at - DAY_MS);
      if (spent + amount > this.#maxDaily) {
        return deny(
          "over_daily_cap",
          `${amount} would take the rolling 24-hour total to ${spent + amount}, over the cap of ${this.#maxDaily} zatoshis`,
        );
      }
    }

    if (this.#approve !== undefined) {
      let approved: boolean;
      try {
        approved = await this.#approve(request);
      } catch (error) {
        // A hook that throws denies. Treating an error as approval would turn a bug in
        // the approval path into unlimited spending.
        return deny(
          "approval_failed",
          `approval hook threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!approved) {
        return deny("approval_denied", "the approval hook declined this payment");
      }
    }

    this.#charges.push({ at, amount });
    this.#record({
      at,
      url: request.url,
      host,
      amountZat: request.amountZat,
      ...(request.invoiceId !== undefined ? { invoiceId: request.invoiceId } : {}),
      allowed: true,
    });
    return { allowed: true };
  }

  /**
   * Return an authorized amount to the daily budget.
   *
   * Call this when an authorized payment did not happen. Until it is called the amount
   * stays charged, which is the safe direction to be wrong in.
   */
  refund(amountZat: string): void {
    const amount = parseZat(amountZat);
    const index = this.#charges.findIndex((c) => c.amount === amount);
    if (index !== -1) this.#charges.splice(index, 1);
  }

  /** Zatoshis charged in the rolling 24-hour window. */
  spentTodayZat(): string {
    return this.#spentSince(this.#now() - DAY_MS).toString(10);
  }

  /** Every decision, newest last. Denials included — that is the point. */
  auditLog(): readonly AuditEntry[] {
    return this.#audit;
  }

  /** Throw the payer-side error for a denial, for callers that prefer exceptions. */
  static assertAllowed(decision: GuardDecision): void {
    if (!decision.allowed) {
      throw new BytePayerError("guard_denied", decision.message ?? "the spend guard denied");
    }
  }

  #spentSince(since: number): bigint {
    // Drop charges that have aged out, so the list cannot grow without bound.
    this.#charges = this.#charges.filter((c) => c.at > since);
    return this.#charges.reduce((sum, c) => sum + c.amount, 0n);
  }

  #record(entry: AuditEntry): void {
    this.#audit.push(entry);
    if (this.#audit.length > this.#auditLimit) {
      this.#audit.splice(0, this.#audit.length - this.#auditLimit);
    }
  }
}

/**
 * Hostname of a URL, lowercased.
 *
 * An unparseable URL yields a hostname that can never match an allowlist entry, so a
 * malformed URL is denied by any guard with an allowlist rather than slipping past the
 * check.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "\u0000invalid";
  }
}
