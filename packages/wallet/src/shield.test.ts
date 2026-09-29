import { describe, expect, it } from "vitest";
import { NETWORK_TESTNET, BytePayerError, ByteProtocolError } from "@byte-protocol/core";
import { AutoShielder, MockChain, MockWallet } from "./index.js";
import type { ShieldingWallet } from "./index.js";

/** A wallet whose waits are instant and whose randomness can be pinned. */
function wallet(options: { random?: () => number } = {}) {
  const chain = new MockChain();
  const slept: number[] = [];
  const w = new MockWallet({
    network: NETWORK_TESTNET,
    chain,
    addressPrefix: "utest1sweep",
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...(options.random !== undefined ? { random: options.random } : {}),
  });
  return { chain, wallet: w, slept };
}

function fundTransparent(chain: MockChain, address: string, amounts: string[]) {
  for (const amountZat of amounts) {
    chain.payInto({ payTo: address, amountZat, pool: "transparent" });
  }
  chain.mine(1);
}

const T_ADDR = "t1" + "a".repeat(33);

describe("shield", () => {
  it("moves transparent value into Ironwood, net of the fee", async () => {
    const { chain, wallet: w } = wallet();
    fundTransparent(chain, w.transparentAddress, ["10000000"]);

    expect((await w.balance()).unusableZat).toBe("10000000");

    const result = await w.shield();

    expect(result.transactions).toHaveLength(1);
    expect(result.shieldedZat).toBe("9990000");
    expect(result.feeZat).toBe("10000");

    chain.mine(1);
    const balance = await w.balance();
    expect(balance.spendableZat).toBe("9990000");
    // The transparent side is gone. That is the whole point.
    expect(balance.unusableZat).toBe("0");
  });

  it("splits into several transactions, paying a fee for each", async () => {
    // Three transactions cost three fees. Splitting is not free, and a caller who assumes
    // it is will be surprised by the arithmetic rather than by the privacy.
    const { chain, wallet: w } = wallet();
    fundTransparent(chain, w.transparentAddress, ["3000000", "3000000", "3000000"]);

    const result = await w.shield({ splitInto: 3 });

    expect(result.transactions).toHaveLength(3);
    expect(result.feeZat).toBe("30000");
    expect(result.shieldedZat).toBe("8970000");
  });

  it("does not shield a UTXO worth less than the fee to move it", async () => {
    // Moving dust costs more than the dust. Sweeping it anyway is a wallet losing money
    // in the name of tidiness.
    const { chain, wallet: w } = wallet();
    fundTransparent(chain, w.transparentAddress, ["5000", "10000000"]);

    const result = await w.shield({ minimumZat: "20000" });

    expect(result.transactions).toHaveLength(1);
    expect(chain.transparentAt(w.transparentAddress)).toBe(5000n);
  });

  it("refuses a split it cannot pay the fees for, before broadcasting anything", async () => {
    const { chain, wallet: w } = wallet();
    fundTransparent(chain, w.transparentAddress, ["15000"]);

    await expect(w.shield({ splitInto: 5 })).rejects.toThrow(BytePayerError);
    expect(chain.transparentAt(w.transparentAddress)).toBe(15000n);
  });

  it("waits a random interval inside the requested range", async () => {
    // A fixed delay is itself a fingerprint: it says "this is Byte's auto-shielder on
    // defaults". The delay is drawn, and reported so a caller can see what happened.
    const { chain, wallet: w, slept } = wallet({ random: () => 0.5 });
    fundTransparent(chain, w.transparentAddress, ["10000000"]);

    const result = await w.shield({ delayRangeSec: [10, 20] });

    expect(result.transactions[0]?.delayedSec).toBe(15);
    expect(slept).toEqual([15_000]);
  });

  it("shields immediately when the range is zero", async () => {
    const { chain, wallet: w, slept } = wallet();
    fundTransparent(chain, w.transparentAddress, ["10000000"]);

    const result = await w.shield({ delayRangeSec: [0, 0] });

    expect(result.transactions[0]?.delayedSec).toBe(0);
    expect(slept).toEqual([]);
  });

  it("refuses a nonsense delay range", async () => {
    const { chain, wallet: w } = wallet();
    fundTransparent(chain, w.transparentAddress, ["10000000"]);

    await expect(w.shield({ delayRangeSec: [20, 10] })).rejects.toThrow(ByteProtocolError);
    await expect(w.shield({ delayRangeSec: [-5, 10] })).rejects.toThrow(ByteProtocolError);
  });

  it("refuses a nonsense split count", async () => {
    const { wallet: w } = wallet();
    await expect(w.shield({ splitInto: 0 })).rejects.toThrow(/positive integer/);
    await expect(w.shield({ splitInto: 1.5 })).rejects.toThrow(/positive integer/);
  });
});

describe("unshield", () => {
  function funded() {
    const { chain, wallet: w } = wallet();
    chain.payInto({ payTo: w.fundingAddress, amountZat: "10000000" });
    chain.mine(1);
    return { chain, wallet: w };
  }

  it("moves value out and reports that the amount is now public", async () => {
    const { chain, wallet: w } = funded();

    const result = await w.unshield({ toTransparent: T_ADDR, amountZat: "5000000" });

    expect(result.publicAmountZat).toBe("5000000");
    expect(result.feeZat).toBe("10000");

    chain.mine(1);
    expect(chain.transparentAt(T_ADDR)).toBe(5000000n);
  });

  it("refuses a shielded or unified destination", async () => {
    // Accepting one would leave the value shielded while the caller believed it had been
    // unshielded: nothing looks wrong until it matters.
    const { wallet: w } = funded();

    for (const bad of ["utest1payee", "ztestsapling1abc", "u1abcdef"]) {
      await expect(
        w.unshield({ toTransparent: bad, amountZat: "5000000" }),
        bad,
      ).rejects.toThrow(/transparent address/);
    }
  });

  it("refuses to unshield more than it holds", async () => {
    const { wallet: w } = funded();
    await expect(
      w.unshield({ toTransparent: T_ADDR, amountZat: "99000000" }),
    ).rejects.toThrow(BytePayerError);
  });

  it("refuses a zero amount", async () => {
    const { wallet: w } = funded();
    await expect(w.unshield({ toTransparent: T_ADDR, amountZat: "0" })).rejects.toThrow(
      /greater than zero/,
    );
  });
});

describe("the auto-shielder", () => {
  it("sweeps once the transparent balance crosses the threshold", async () => {
    const { chain, wallet: w } = wallet();
    const shielder = new AutoShielder({
      wallet: w,
      thresholdZat: "1000000",
      delayRangeSec: [0, 0],
      sleep: async () => {},
    });

    // Below the threshold nothing happens, and that is not an error.
    fundTransparent(chain, w.transparentAddress, ["500000"]);
    expect(await shielder.sweepOnce()).toBeUndefined();

    fundTransparent(chain, w.transparentAddress, ["2000000"]);
    const result = await shielder.sweepOnce();
    expect(result?.shieldedZat).toBe("2490000");
  });

  it("keeps polling after a failure instead of dying quietly", async () => {
    // A poller that stops on the first transient light-server error leaves value sitting
    // in public indefinitely, and nobody finds out until they look.
    const { chain, wallet: w } = wallet();
    fundTransparent(chain, w.transparentAddress, ["10000000"]);

    const errors: unknown[] = [];
    let calls = 0;

    // Delegate explicitly rather than with Object.create: MockWallet keeps its chain in a
    // private field, and a prototype-chained clone has no such field, so every inherited
    // method throws on `this`.
    const flaky: ShieldingWallet = {
      network: w.network,
      newInvoiceAddress: () => w.newInvoiceAddress(),
      findOutputs: (txid) => w.findOutputs(txid),
      status: () => w.status(),
      balance: () => w.balance(),
      send: (request) => w.send(request),
      unshield: (request) => w.unshield(request),
      shield: async (request) => {
        calls += 1;
        if (calls === 1) throw new Error("light server unavailable");
        return w.shield(request);
      },
    };

    // A hard iteration cap, so a bug here fails the test rather than exhausting memory.
    let passes = 0;
    const shielder: AutoShielder = new AutoShielder({
      wallet: flaky,
      thresholdZat: "1000000",
      delayRangeSec: [0, 0],
      onError: (e) => errors.push(e),
      sleep: async () => {
        passes += 1;
        if (calls >= 2 || passes > 10) shielder.stop();
      },
    });

    await shielder.start();

    expect(errors).toHaveLength(1);
    expect(calls).toBe(2);
    expect(passes).toBeLessThanOrEqual(10);
    expect(shielder.running).toBe(false);
  });

  it("reports each sweep through the callback", async () => {
    const { chain, wallet: w } = wallet();
    fundTransparent(chain, w.transparentAddress, ["10000000"]);

    const seen: string[] = [];
    const shielder = new AutoShielder({
      wallet: w,
      thresholdZat: "1000000",
      delayRangeSec: [0, 0],
      onShielded: (r) => seen.push(r.shieldedZat),
      sleep: async () => {},
    });

    await shielder.sweepOnce();
    expect(seen).toEqual(["9990000"]);
  });

  it("refuses to run twice at once", async () => {
    const { wallet: w } = wallet();
    const shielder: AutoShielder = new AutoShielder({
      wallet: w,
      sleep: async () => shielder.stop(),
    });

    const first = shielder.start();
    await expect(shielder.start()).rejects.toThrow(/already running/);
    shielder.stop();
    await first;
  });

  it("refuses a nonsense poll interval", () => {
    const { wallet: w } = wallet();
    expect(() => new AutoShielder({ wallet: w, pollIntervalSec: 0 })).toThrow(/positive/);
  });
});
