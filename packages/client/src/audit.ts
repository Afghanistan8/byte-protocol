/**
 * The spend guard's audit log.
 *
 * ## Why this is not just an array
 *
 * The guard decides whether an autonomous agent may spend money. Its log is the only record
 * of what it decided and why, and it was a **bounded in-memory ring**: the oldest thousand
 * entries were dropped silently, and a restart lost all of them.
 *
 * That is precisely backwards for an audit log. The entries you most want are the ones from
 * the incident, which is to say the old ones, on the process that has since restarted.
 *
 * ## Append-only means append-only
 *
 * `FileAuditLog` opens with `flags: "a"`. On POSIX, writes under `PIPE_BUF` to a file opened
 * `O_APPEND` are atomic, so concurrent appends interleave whole lines rather than corrupting
 * each other. There is no update path and no delete path in this file, by construction: the
 * only operation is append.
 *
 * Each line is one JSON object, so the log is greppable, tailable, and readable by anything
 * that can read a line. A truncated final line (a crash mid-write) is skipped on read rather
 * than failing the whole log.
 *
 * ## What it does not claim
 *
 * This is not tamper-*proof*. Anyone who can write the file can rewrite it; append-only here
 * is about the program never destroying its own history, not about defeating an attacker with
 * filesystem access. Tamper-evidence would need a hash chain and somewhere independent to
 * anchor it, which is the anchoring work in F8 and is not built.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { AuditEntry } from "./guard.js";

/** Where the guard writes its decisions. */
export interface AuditLog {
  /** Record a decision. Never throws: a failed write must not fail a payment. */
  record(entry: AuditEntry): void;
  /** Every entry this log can see, oldest first. */
  entries(): readonly AuditEntry[];
}

/**
 * The default: bounded, in memory, lost on restart.
 *
 * Kept because it is the right thing for tests and for a short-lived process, and because
 * making persistence mandatory would mean every test needed a temp directory. It is not the
 * right thing for an agent spending real money, and `FileAuditLog` is the answer there.
 */
export class MemoryAuditLog implements AuditLog {
  readonly #limit: number;
  #entries: AuditEntry[] = [];

  constructor(limit = 1000) {
    this.#limit = limit;
  }

  record(entry: AuditEntry): void {
    this.#entries.push(entry);
    if (this.#entries.length > this.#limit) {
      this.#entries.splice(0, this.#entries.length - this.#limit);
    }
  }

  entries(): readonly AuditEntry[] {
    return this.#entries;
  }
}

export interface FileAuditLogOptions {
  /** Path to the log. Created if absent; never truncated. */
  path: string;
  /**
   * Keep every entry in memory as well, so `entries()` can answer without re-reading.
   *
   * Defaults to true. Turn it off for a long-running process where the log outgrows memory;
   * `entries()` then reads from disk each time, which is slower and always complete.
   */
  cache?: boolean;
  /** Called when a write fails, so a failure is noticed rather than swallowed. */
  onError?: (error: unknown) => void;
}

/**
 * An append-only audit log on disk, one JSON object per line.
 *
 * Survives restarts, which is the point: the entries worth having are the ones from before
 * whatever went wrong.
 */
export class FileAuditLog implements AuditLog {
  readonly #path: string;
  readonly #cache: AuditEntry[] | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;

  constructor(options: FileAuditLogOptions) {
    this.#path = options.path;
    this.#onError = options.onError;
    this.#cache = options.cache === false ? undefined : [];

    // Load what is already there, so a restart continues the log rather than appearing to
    // start a fresh one.
    if (this.#cache !== undefined && existsSync(this.#path)) {
      this.#cache.push(...readAuditFile(this.#path));
    }
  }

  /**
   * Append one entry.
   *
   * Synchronous and unbuffered. An audit log that batches writes loses exactly the entries
   * written just before a crash, which are the ones an investigation wants.
   *
   * Never throws. A guard that failed a payment because its log was unwritable would turn a
   * disk problem into an outage; the failure is reported through `onError` instead, and the
   * in-memory copy still holds the entry.
   */
  record(entry: AuditEntry): void {
    this.#cache?.push(entry);
    try {
      appendFileSync(this.#path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
    } catch (error) {
      this.#onError?.(error);
    }
  }

  entries(): readonly AuditEntry[] {
    return this.#cache ?? readAuditFile(this.#path);
  }
}

/**
 * Read an audit file, skipping anything unparseable.
 *
 * A crash mid-write leaves a truncated final line. Losing that one entry is right; refusing
 * to read the whole log because of it is not, and would make a crash hide the history of
 * everything that preceded it.
 */
export function readAuditFile(path: string): AuditEntry[] {
  if (!existsSync(path)) return [];

  const entries: AuditEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // A partial line. Skip it and keep the rest.
    }
  }
  return entries;
}
