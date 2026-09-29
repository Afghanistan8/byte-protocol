import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { BYTE_SCHEME, NETWORK_TESTNET, ByteProtocolError } from "@byte-protocol/core";
import {
  acceptsByte,
  canonicalCardBytes,
  newAgentKey,
  signAgentCard,
  verifyAgentCard,
  WELL_KNOWN_PATH,
  LEGACY_WELL_KNOWN_PATH,
  type AgentCardBody,
} from "./card.js";
import { resolveAgentCard, serializeAgentCard } from "./resolver.js";

function body(overrides: Partial<AgentCardBody> = {}): AgentCardBody {
  return {
    agentId: "agent-alpha",
    endpoint: "https://alpha.example.com",
    network: NETWORK_TESTNET,
    ua: "utest1publicaddressforthiscard",
    schemes: [BYTE_SCHEME],
    issuedAt: "2026-09-29T12:00:00Z",
    ...overrides,
  };
}

describe("signAgentCard / verifyAgentCard", () => {
  it("verifies a card it signed", () => {
    const { secretKey } = newAgentKey();
    expect(verifyAgentCard(signAgentCard(body(), secretKey))).toBe(true);
  });

  it("reports the signing key as issuer", () => {
    const { secretKey, publicKey } = newAgentKey();
    expect(signAgentCard(body(), secretKey).issuer).toBe(publicKey);
  });

  it("honours an expected issuer", () => {
    const a = newAgentKey();
    const b = newAgentKey();
    const card = signAgentCard(body(), a.secretKey);
    expect(verifyAgentCard(card, { expectedIssuer: a.publicKey })).toBe(true);
    expect(verifyAgentCard(card, { expectedIssuer: b.publicKey })).toBe(false);
  });

  it.each(["agentId", "endpoint", "ua", "issuedAt"] as const)(
    "rejects a card whose %s was altered after signing",
    (field) => {
      const { secretKey } = newAgentKey();
      const card = signAgentCard(body(), secretKey);
      const tampered = {
        ...card,
        [field]: field === "endpoint" ? "https://attacker.example" : "tampered",
      };
      expect(verifyAgentCard(tampered)).toBe(false);
    },
  );

  it("rejects a card whose payment address was swapped", () => {
    // The attack that matters: redirect payments while keeping the identity.
    const { secretKey } = newAgentKey();
    const card = signAgentCard(body(), secretKey);
    expect(verifyAgentCard({ ...card, ua: "utest1attackeraddress" })).toBe(false);
  });

  it("rejects a card re-signed by another key but claiming the original issuer", () => {
    const a = newAgentKey();
    const b = newAgentKey();
    const forged = { ...signAgentCard(body(), b.secretKey), issuer: a.publicKey };
    expect(verifyAgentCard(forged)).toBe(false);
  });

  it("rejects an expired card, and honours checkExpiry: false", () => {
    const { secretKey } = newAgentKey();
    const card = signAgentCard(
      body({ expiresAt: "2026-09-29T13:00:00Z" }),
      secretKey,
    );
    const after = () => Date.parse("2026-09-29T14:00:00Z");
    expect(verifyAgentCard(card, { now: after })).toBe(false);
    expect(verifyAgentCard(card, { now: after, checkExpiry: false })).toBe(true);
    expect(verifyAgentCard(card, { now: () => Date.parse("2026-09-29T12:30:00Z") })).toBe(true);
  });

  it("returns false rather than throwing on arbitrary input", () => {
    for (const junk of [undefined, null, 0, "", [], {}, { issuer: "x" }]) {
      expect(verifyAgentCard(junk)).toBe(false);
    }
  });

  it("rejects a card that fails the schema", () => {
    const { secretKey } = newAgentKey();
    const card = signAgentCard(body(), secretKey);
    expect(verifyAgentCard({ ...card, endpoint: "not-a-url" })).toBe(false);
    expect(verifyAgentCard({ ...card, schemes: [] })).toBe(false);
  });
});

describe("canonicalCardBytes", () => {
  it("is stable regardless of key order", () => {
    const reordered: AgentCardBody = {
      issuedAt: body().issuedAt,
      schemes: body().schemes,
      ua: body().ua,
      network: body().network,
      endpoint: body().endpoint,
      agentId: body().agentId,
    };
    expect(canonicalCardBytes(reordered)).toEqual(canonicalCardBytes(body()));
  });

  it("is domain-separated from receipts", () => {
    expect(new TextDecoder().decode(canonicalCardBytes(body()))).toMatch(
      /^byte-agent-card-v1\u0000/,
    );
  });

  it("refuses fields containing the separator", () => {
    expect(() => canonicalCardBytes(body({ agentId: "a\u0000b" }))).toThrow(ByteProtocolError);
  });

  it("refuses a scheme containing a comma", () => {
    // schemes are joined with a comma, so one containing a comma could shift the field
    // boundary and make two different bodies serialize identically.
    expect(() => canonicalCardBytes(body({ schemes: ["a,b"] }))).toThrow(ByteProtocolError);
  });

  it("does not collide when scheme boundaries shift", () => {
    const a = canonicalCardBytes(body({ schemes: ["x", "yz"] }));
    const b = canonicalCardBytes(body({ schemes: ["xy", "z"] }));
    expect(a).not.toEqual(b);
  });
});

describe("acceptsByte", () => {
  it("detects Byte's scheme", () => {
    const { secretKey } = newAgentKey();
    expect(acceptsByte(signAgentCard(body(), secretKey))).toBe(true);
    expect(acceptsByte(signAgentCard(body({ schemes: ["exact"] }), secretKey))).toBe(false);
  });
});

describe("resolveAgentCard", () => {
  async function serve(payload: string, status = 200, path = WELL_KNOWN_PATH) {
    const requested: string[] = [];
    const server = createServer((req, res) => {
      requested.push(req.url ?? "");
      if (req.url !== path) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    return {
      origin: `http://127.0.0.1:${address.port}`,
      requested,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("fetches and returns a valid card", async () => {
    const { secretKey } = newAgentKey();
    const card = signAgentCard(body(), secretKey);
    const s = await serve(serializeAgentCard(card));
    try {
      expect(await resolveAgentCard(s.origin)).toMatchObject({ agentId: "agent-alpha" });
    } finally {
      await s.close();
    }
  });

  it("falls back to the legacy path when the canonical one 404s", async () => {
    // The canonical name moved to byte-agent.json. An agent that published under the old
    // name should not silently become unresolvable, so the resolver tries both.
    const { secretKey } = newAgentKey();
    const card = signAgentCard(body(), secretKey);
    const s = await serve(serializeAgentCard(card), 200, LEGACY_WELL_KNOWN_PATH);
    try {
      expect(await resolveAgentCard(s.origin)).toMatchObject({ agentId: "agent-alpha" });
      // Canonical first, legacy only after it 404s.
      expect(s.requested).toEqual([WELL_KNOWN_PATH, LEGACY_WELL_KNOWN_PATH]);
    } finally {
      await s.close();
    }
  });

  it("does not try the legacy path when the canonical one answers", async () => {
    const { secretKey } = newAgentKey();
    const card = signAgentCard(body(), secretKey);
    const s = await serve(serializeAgentCard(card));
    try {
      await resolveAgentCard(s.origin);
      expect(s.requested).toEqual([WELL_KNOWN_PATH]);
    } finally {
      await s.close();
    }
  });

  it("does not retry elsewhere when a card is present but bad", async () => {
    // A 404 is the only thing that means "look somewhere else". A card that is served and
    // fails verification must be reported, not quietly replaced by whatever the legacy
    // path happens to hold.
    const { secretKey } = newAgentKey();
    const card = signAgentCard(body(), secretKey);
    const s = await serve(
      JSON.stringify({ ...card, agentId: "someone-else" }),
      200,
      WELL_KNOWN_PATH,
    );
    try {
      await expect(resolveAgentCard(s.origin)).rejects.toThrow(/failed verification/);
      expect(s.requested).toEqual([WELL_KNOWN_PATH]);
    } finally {
      await s.close();
    }
  });

  it("refuses a card whose signature does not verify", async () => {
    // There is no "unverified" return value. The only thing a caller does with a card is
    // decide where to send money.
    const { secretKey } = newAgentKey();
    const card = signAgentCard(body(), secretKey);
    const s = await serve(JSON.stringify({ ...card, ua: "utest1attacker" }));
    try {
      await expect(resolveAgentCard(s.origin)).rejects.toThrow(/failed verification/);
    } finally {
      await s.close();
    }
  });

  it("refuses a response that is not a card", async () => {
    const s = await serve(JSON.stringify({ hello: "world" }));
    try {
      await expect(resolveAgentCard(s.origin)).rejects.toThrow(/schema/);
    } finally {
      await s.close();
    }
  });

  it("refuses invalid JSON and non-200 responses", async () => {
    const bad = await serve("not json");
    try {
      await expect(resolveAgentCard(bad.origin)).rejects.toThrow(/not valid JSON/);
    } finally {
      await bad.close();
    }

    const missing = await serve("{}", 500);
    try {
      await expect(resolveAgentCard(missing.origin)).rejects.toThrow(/returned 500/);
    } finally {
      await missing.close();
    }
  });

  it("refuses an oversized response", async () => {
    // Resolving a hostile origin must not be an invitation to stream gigabytes into an
    // agent's memory.
    const s = await serve(JSON.stringify({ padding: "x".repeat(200_000) }));
    try {
      await expect(resolveAgentCard(s.origin, { maxBytes: 1024 })).rejects.toThrow(/over the/);
    } finally {
      await s.close();
    }
  });

  it("refuses a malformed origin", async () => {
    await expect(resolveAgentCard("not an origin")).rejects.toThrow(ByteProtocolError);
  });
});
