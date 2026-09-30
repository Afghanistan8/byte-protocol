import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileAuditLog, MemoryAuditLog, readAuditFile } from "./audit.js";
import { SpendGuard } from "./guard.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "byte-audit-"));
  path = join(dir, "guard.log");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("MemoryAuditLog", () => {
  it("keeps entries in order", () => {
    const log = new MemoryAuditLog();
    for (let i = 0; i < 3; i++) {
      log.record({ at: i, url: "https://x.test", host: "x.test", amountZat: "1", allowed: true });
    }
    expect(log.entries().map((e) => e.at)).toEqual([0, 1, 2]);
  });

  it("drops the oldest past its limit, which is why it is not the durable one", () => {
    const log = new MemoryAuditLog(3);
    for (let i = 0; i < 5; i++) {
      log.record({ at: i, url: "https://x.test", host: "x.test", amountZat: "1", allowed: true });
    }
    // The entries an investigation wants are the old ones. This is the behaviour
    // FileAuditLog exists to avoid, asserted so nobody mistakes it for acceptable.
    expect(log.entries().map((e) => e.at)).toEqual([2, 3, 4]);
  });
});

describe("FileAuditLog", () => {
  it("writes one JSON object per line", () => {
    const log = new FileAuditLog({ path });
    log.record({ at: 1, url: "https://a.test/x", host: "a.test", amountZat: "100", allowed: true });
    log.record({
      at: 2,
      url: "https://b.test/y",
      host: "b.test",
      amountZat: "200",
      allowed: false,
      reason: "over_per_call_cap",
      message: "too much",
    });

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ at: 1, allowed: true });
    expect(JSON.parse(lines[1] as string)).toMatchObject({
      allowed: false,
      reason: "over_per_call_cap",
    });
  });

  it("survives a restart, which is the entire point", () => {
    const first = new FileAuditLog({ path });
    first.record({ at: 1, url: "https://a.test", host: "a.test", amountZat: "100", allowed: true });

    // A new process, the same file.
    const second = new FileAuditLog({ path });
    second.record({ at: 2, url: "https://b.test", host: "b.test", amountZat: "200", allowed: true });

    expect(second.entries().map((e) => e.at)).toEqual([1, 2]);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("never truncates what is already there", () => {
    // Opening with anything but append would erase the history on every restart, which is
    // the failure this class exists to prevent.
    writeFileSync(path, JSON.stringify({ at: 0, url: "u", host: "h", amountZat: "1", allowed: true }) + "\n");
    const log = new FileAuditLog({ path });
    log.record({ at: 1, url: "u", host: "h", amountZat: "1", allowed: true });

    expect(readAuditFile(path).map((e) => e.at)).toEqual([0, 1]);
  });

  it("keeps everything, with no limit to drop the oldest", () => {
    const log = new FileAuditLog({ path });
    for (let i = 0; i < 5000; i++) {
      log.record({ at: i, url: "u", host: "h", amountZat: "1", allowed: true });
    }
    expect(log.entries()).toHaveLength(5000);
    expect(log.entries()[0]?.at).toBe(0);
  });

  it("skips a truncated final line rather than losing the whole log", () => {
    // A crash mid-write leaves a partial line. Losing that entry is right; refusing to read
    // the preceding history because of it is not.
    const log = new FileAuditLog({ path });
    log.record({ at: 1, url: "u", host: "h", amountZat: "1", allowed: true });
    log.record({ at: 2, url: "u", host: "h", amountZat: "1", allowed: true });

    const good = readFileSync(path, "utf8");
    writeFileSync(path, `${good}{"at":3,"url":"u","ho`);

    expect(readAuditFile(path).map((e) => e.at)).toEqual([1, 2]);
  });

  it("reads from disk when caching is off", () => {
    const log = new FileAuditLog({ path, cache: false });
    log.record({ at: 1, url: "u", host: "h", amountZat: "1", allowed: true });
    expect(log.entries().map((e) => e.at)).toEqual([1]);
  });

  it("reports a failed write instead of throwing into the payment path", () => {
    // A guard that failed a payment because its log was unwritable would turn a disk
    // problem into an outage.
    const errors: unknown[] = [];
    const log = new FileAuditLog({
      path: join(dir, "no-such-directory", "guard.log"),
      onError: (e) => errors.push(e),
    });

    expect(() =>
      log.record({ at: 1, url: "u", host: "h", amountZat: "1", allowed: true }),
    ).not.toThrow();
    expect(errors).toHaveLength(1);
    // And the entry is still visible in memory, so the decision is not simply lost.
    expect(log.entries()).toHaveLength(1);
  });

  it("returns nothing for a log that does not exist yet", () => {
    expect(readAuditFile(join(dir, "absent.log"))).toEqual([]);
  });
});

describe("the guard writing to a durable log", () => {
  it("records both allowed and denied decisions across a restart", async () => {
    const first = new SpendGuard({
      maxPerCallZat: "1000",
      auditLog: new FileAuditLog({ path }),
    });

    await first.authorize({ amountZat: "500", url: "https://ok.test/a" });
    await first.authorize({ amountZat: "5000", url: "https://nope.test/b" });

    // A new process reading the same file sees what the old one decided.
    const second = new SpendGuard({ auditLog: new FileAuditLog({ path }) });
    const entries = second.auditLog();

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ allowed: true, host: "ok.test" });
    expect(entries[1]).toMatchObject({ allowed: false, reason: "over_per_call_cap" });
  });

  it("still defaults to memory, so a test needs no temp directory", async () => {
    const guard = new SpendGuard({});
    await guard.authorize({ amountZat: "500", url: "https://ok.test/a" });
    expect(guard.auditLog()).toHaveLength(1);
  });

  it("records a denial even when the decision cost nothing", async () => {
    // A denial leaves no trace on the chain by design, so the log is the only place it
    // exists at all.
    const guard = new SpendGuard({ allow: ["allowed.test"], auditLog: new FileAuditLog({ path }) });
    await guard.authorize({ amountZat: "500", url: "https://blocked.test/a" });

    expect(readAuditFile(path)).toEqual([
      expect.objectContaining({ allowed: false, reason: "host_not_allowed" }),
    ]);
  });
});
