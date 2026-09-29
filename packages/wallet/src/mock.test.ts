import { beforeEach, describe, expect, it } from "vitest";
import { BytePayerError, NETWORK_TESTNET, isAcceptedPool } from "@byte-protocol/core";
import { MOCK_FEE_ZAT, MockChain, createMockPair, viewOnly } from "./mock.js";
import { canSpend } from "./wallet.js";
import type { MockPair } from "./mock.js";

describe("newInvoiceAddress", () => {
  it("never returns the same address twice", async () => {
    // Address reuse is what makes two invoices linkable on-chain. It is the one thing
    // this method must not do.
    const { payee } = createMockPair(NETWORK_TESTNET);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(await payee.newInvoiceAddress());
    expect(seen.size).toBe(500);
  });

  it("does not hand out the wallet's own funding address", async () => {
    const { payee } = createMockPair(NETWORK_TESTNET);
    const address = await payee.newInvoiceAddress();
    expect(address).not.toBe(payee.fundingAddress);
  });

  it("records every address it minted", async () => {
    const { payee } = createMockPair(NETWORK_TESTNET);
    const a = await payee.newInvoiceAddress();
    const b = await payee.newInvoiceAddress();
    expect(payee.addresses).toEqual([a, b]);
  });
});

describe("send", () => {
  let pair: MockPair;
  beforeEach(() => {
    pair = createMockPair(NETWORK_TESTNET);
  });

  it("delivers value, memo and pool to the payee's address", async () => {
    pair.fundPayer("1000000");
    const payTo = await pair.payee.newInvoiceAddress();
    const { txid, feeZat } = await pair.payer.send({
      to: payTo,
      amountZat: "250000",
      memo: "BYTE1|test|binding",
    });

    const notes = await pair.payee.findReceived(payTo);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      txid,
      valueZat: "250000",
      memo: "BYTE1|test|binding",
      pool: "ironwood",
    });
    expect(feeZat).toBe(MOCK_FEE_ZAT.toString());
  });

  it("debits the fee as well as the amount", async () => {
    pair.fundPayer("1000000");
    await pair.payer.send({ to: "utest1x", amountZat: "250000", memo: "m" });
    pair.chain.mine(1);
    const balance = await pair.payer.balance();
    expect(BigInt(balance.spendableZat)).toBe(1_000_000n - 250_000n - MOCK_FEE_ZAT);
  });

  it("refuses when the balance cannot cover amount plus fee", async () => {
    // Exactly the amount, with nothing left for the fee.
    pair.fundPayer("250000");
    await expect(
      pair.payer.send({ to: "utest1x", amountZat: "250000", memo: "m" }),
    ).rejects.toThrow(BytePayerError);
  });

  it("reports wrong_pool_source when the funds exist but sit outside Ironwood", async () => {
    // The distinction matters: an operator whose money is unshielded needs to be told
    // that, not handed a generic shortfall.
    pair.fundPayer("1000000", { pool: "transparent" });
    const error = await pair.payer
      .send({ to: "utest1x", amountZat: "100", memo: "m" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BytePayerError);
    expect((error as BytePayerError).reason).toBe("wrong_pool_source");
  });

  it("reports insufficient_funds when there is simply not enough anywhere", async () => {
    pair.fundPayer("100");
    const error = await pair.payer
      .send({ to: "utest1x", amountZat: "999999", memo: "m" })
      .catch((e: unknown) => e);
    expect((error as BytePayerError).reason).toBe("insufficient_funds");
  });

  it("broadcasts nothing when it refuses", async () => {
    pair.fundPayer("1000000", { pool: "transparent" });
    const payTo = await pair.payee.newInvoiceAddress();
    await pair.payer.send({ to: payTo, amountZat: "100", memo: "m" }).catch(() => undefined);
    expect(await pair.payee.findReceived(payTo)).toEqual([]);
  });

  it("will not spend Ironwood notes that are not yet confirmed", async () => {
    pair.fundPayer("1000000", { confirm: false });
    await expect(
      pair.payer.send({ to: "utest1x", amountZat: "100", memo: "m" }),
    ).rejects.toThrow(BytePayerError);
    pair.chain.mine(1);
    await expect(
      pair.payer.send({ to: "utest1x", amountZat: "100", memo: "m" }),
    ).resolves.toMatchObject({ txid: expect.any(String) });
  });

  it("produces deterministic txids", async () => {
    const run = async () => {
      const p = createMockPair(NETWORK_TESTNET);
      p.fundPayer("1000000");
      return (await p.payer.send({ to: "utest1x", amountZat: "1", memo: "m" })).txid;
    };
    expect(await run()).toBe(await run());
  });
});

describe("confirmations", () => {
  it("starts at zero while unmined and rises with the chain", async () => {
    const pair = createMockPair(NETWORK_TESTNET);
    pair.fundPayer("1000000");
    const payTo = await pair.payee.newInvoiceAddress();
    await pair.payer.send({ to: payTo, amountZat: "1", memo: "m" });

    const note = async () => (await pair.payee.findReceived(payTo))[0];

    // Broadcast but unmined: visible, with zero confirmations and no height. This is the
    // state a `minConfirmations: 0` payee would serve on.
    expect((await note())?.confirmations).toBe(0);
    expect((await note())?.height).toBeUndefined();

    pair.chain.mine(1);
    expect((await note())?.confirmations).toBe(1);
    expect((await note())?.height).toBe(pair.chain.height);

    pair.chain.mine(10);
    expect((await note())?.confirmations).toBe(11);
  });
});

describe("reorg", () => {
  it("makes a dropped transaction disappear from the payee's view", async () => {
    // A payee serving at zero confirmations can be reorged out from under after it has
    // already delivered. The spec says so; this is the case that proves it is modelled.
    const pair = createMockPair(NETWORK_TESTNET);
    pair.fundPayer("1000000");
    const payTo = await pair.payee.newInvoiceAddress();
    const { txid } = await pair.payer.send({ to: payTo, amountZat: "1", memo: "m" });

    expect(await pair.payee.findByTxid(txid, payTo)).toBeDefined();
    expect(pair.chain.drop(txid)).toBe(true);
    expect(await pair.payee.findByTxid(txid, payTo)).toBeUndefined();
    expect(await pair.payee.findReceived(payTo)).toEqual([]);
  });

  it("reports false when asked to drop an unknown transaction", () => {
    expect(new MockChain().drop("f".repeat(64))).toBe(false);
  });
});

describe("payInto", () => {
  let pair: MockPair;
  beforeEach(() => {
    pair = createMockPair(NETWORK_TESTNET);
  });

  it("can deliver a payment in a pool Byte does not accept", async () => {
    const payTo = await pair.payee.newInvoiceAddress();
    pair.chain.payInto({ payTo, amountZat: "250000", memo: "m", pool: "orchard" });
    const note = (await pair.payee.findReceived(payTo))[0];
    expect(note?.pool).toBe("orchard");
    expect(isAcceptedPool(note!.pool)).toBe(false);
  });

  it("can deliver a payment carrying no memo at all", async () => {
    const payTo = await pair.payee.newInvoiceAddress();
    pair.chain.payInto({ payTo, amountZat: "250000" });
    expect((await pair.payee.findReceived(payTo))[0]?.memo).toBeUndefined();
  });

  it("can deliver a short payment", async () => {
    const payTo = await pair.payee.newInvoiceAddress();
    pair.chain.payInto({ payTo, amountZat: "1", memo: "m" });
    expect((await pair.payee.findReceived(payTo))[0]?.valueZat).toBe("1");
  });

  it("reports notes it did not create as absent", async () => {
    expect(await pair.payee.findByTxid("f".repeat(64), "utest1nothing")).toBeUndefined();
    expect(await pair.payee.findReceived("utest1nothing")).toEqual([]);
  });
});

describe("balance", () => {
  it("separates spendable, pending and unusable", async () => {
    const pair = createMockPair(NETWORK_TESTNET);
    pair.fundPayer("500000");
    pair.fundPayer("300000", { pool: "transparent" });
    pair.fundPayer("200000", { confirm: false });

    const balance = await pair.payer.balance();
    expect(balance.spendableZat).toBe("500000");
    expect(balance.pendingZat).toBe("200000");
    expect(balance.unusableZat).toBe("300000");
  });
});

describe("view-only wallets", () => {
  it("cannot spend", async () => {
    const pair = createMockPair(NETWORK_TESTNET);
    const view = viewOnly(pair.payer);
    expect(canSpend(view)).toBe(false);
    expect(canSpend(pair.payer)).toBe(true);
  });

  it("can still mint addresses and read payments", async () => {
    const pair = createMockPair(NETWORK_TESTNET);
    const view = viewOnly(pair.payee);
    const payTo = await view.newInvoiceAddress();
    pair.chain.payInto({ payTo, amountZat: "1", memo: "m" });
    expect(await view.findReceived(payTo)).toHaveLength(1);
    expect((await view.status()).synced).toBe(true);
  });
});
