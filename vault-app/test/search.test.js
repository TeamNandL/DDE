// Vault FTS / search — tenancy, auth, pipe filter, find denied_visit claim.
// Memory path uses substring fallback (mode=substring). PG path uses FTS.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer, PHASE1_ROUTES } from "../src/server.js";
import * as logger from "../src/logger.js";
import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";

// Fake-family denied-visit claim (same wording as phase1.pg fixture). Inline so
// we do not import the PG test module (which registers Test 9 as a side effect).
const DENIED_VISIT_VENT =
  "Jordan didn't let me pick up Sam and Taylor for my weekend visit today. " +
  "I was at the door at five like the schedule says and she wouldn't let " +
  "them leave with me. This is the second time this month. She is doing " +
  "this on purpose to sabotage my time with the kids.";

async function startMemory() {
  logger.reset();
  const vault = new Vault();
  const bff = makeBff(vault);
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  return {
    vault,
    bff,
    server,
    base: `http://127.0.0.1:${addr.port}`,
    async close() {
      await new Promise((r) => server.close(r));
    },
  };
}

async function jsonReq(base, method, path, body, { token } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function provision(base, dad_id) {
  const prov = await jsonReq(base, "POST", "/vault/provision", { dad_id });
  assert.equal(prov.status, 200, JSON.stringify(prov.data));
  return prov.data;
}

test("PHASE1_ROUTES lists GET /vault/search", () => {
  assert.ok(PHASE1_ROUTES.includes("GET /vault/search"));
});

test("search: missing dad_id → 400", async () => {
  const s = await startMemory();
  try {
    const res = await jsonReq(s.base, "GET", "/vault/search?q=visit");
    assert.equal(res.status, 400);
    assert.match(String(res.data?.error || ""), /dad_id/i);
  } finally {
    await s.close();
  }
});

test("search: auth 401 without token; Bearer works", async () => {
  const s = await startMemory();
  const dad_id = randomUUID();
  try {
    const { token } = await provision(s.base, dad_id);
    const noTok = await jsonReq(s.base, "GET", `/vault/search?dad_id=${dad_id}&q=x`);
    assert.equal(noTok.status, 401);

    const ok = await jsonReq(
      s.base,
      "GET",
      `/vault/search?dad_id=${dad_id}&q=`,
      null,
      { token },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.data.mode, "substring");
    assert.ok(Array.isArray(ok.data.hits));
  } finally {
    await s.close();
  }
});

test("search A≠B: dad A token cannot see dad B hits (403 + empty for own)", async () => {
  const s = await startMemory();
  const dadA = randomUUID();
  const dadB = randomUUID();
  try {
    const a = await provision(s.base, dadA);
    const b = await provision(s.base, dadB);

    await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      {
        dad_id: dadA,
        text:
          "Jordan denied my weekend visit with Sam and Taylor at the door. " +
          "This is the second time this month.",
      },
      { token: a.token },
    );
    await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      {
        dad_id: dadB,
        text:
          "UniqueZephyrMarker: Jordan cancelled the Maple exchange again. " +
          "This is the second time this month.",
      },
      { token: b.token },
    );

    // Cross-tenant: A token + B dad_id → 403 (same gate as state/export)
    const cross = await jsonReq(
      s.base,
      "GET",
      `/vault/search?dad_id=${dadB}&q=UniqueZephyrMarker`,
      null,
      { token: a.token },
    );
    assert.equal(cross.status, 403);

    // A searching own vault for B's unique marker → no hits
    const own = await jsonReq(
      s.base,
      "GET",
      `/vault/search?dad_id=${dadA}&q=UniqueZephyrMarker`,
      null,
      { token: a.token },
    );
    assert.equal(own.status, 200);
    assert.equal(own.data.hits.length, 0);

    // B finds own marker
    const bHit = await jsonReq(
      s.base,
      "GET",
      `/vault/search?dad_id=${dadB}&q=UniqueZephyrMarker`,
      null,
      { token: b.token },
    );
    assert.equal(bHit.status, 200);
    assert.ok(bHit.data.hits.length >= 1);
    assert.ok(bHit.data.hits.every((h) => h.dad_id === dadB));
  } finally {
    await s.close();
  }
});

test("search: finds denied/cancelled visit claim; verified filter excludes claims", async () => {
  const s = await startMemory();
  const dad_id = randomUUID();
  try {
    const { token } = await provision(s.base, dad_id);

    const intake = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: DENIED_VISIT_VENT },
      { token },
    );
    assert.equal(intake.status, 200);
    assert.ok(intake.data.written >= 1);

    await jsonReq(
      s.base,
      "POST",
      "/vault/comms/pull",
      {
        dad_id,
        channel: "ofw",
        source_ref: "ofw:search-test:1",
        body_cold: "OFW verified pull about the cancelled weekend visit.",
        sent_at: "2026-09-14T18:00:00.000Z",
      },
      { token },
    );

    const found = await jsonReq(
      s.base,
      "GET",
      `/vault/search?dad_id=${dad_id}&q=weekend+visit&type=events`,
      null,
      { token },
    );
    assert.equal(found.status, 200);
    assert.ok(found.data.hits.length >= 1, JSON.stringify(found.data));
    assert.ok(found.data.hits.some((h) => h.type === "events" && h.pipe === "claim"));
    for (const h of found.data.hits) {
      assert.ok(h.id && h.type && h.pipe && "snippet" in h);
      assert.equal(h.dad_id, dad_id);
    }

    // also find via "weekend" / visit wording in raw_quote or notes
    const visitQ = await jsonReq(
      s.base,
      "GET",
      `/vault/search?dad_id=${dad_id}&q=weekend`,
      null,
      { token },
    );
    assert.equal(visitQ.status, 200);
    assert.ok(visitQ.data.hits.length >= 1);

    const verifiedOnly = await jsonReq(
      s.base,
      "GET",
      `/vault/search?dad_id=${dad_id}&q=visit&pipe=verified`,
      null,
      { token },
    );
    assert.equal(verifiedOnly.status, 200);
    assert.ok(verifiedOnly.data.hits.length >= 1);
    assert.ok(verifiedOnly.data.hits.every((h) => h.pipe === "verified"));
    assert.ok(!verifiedOnly.data.hits.some((h) => h.pipe === "claim"));

    // Export still verified-only (unchanged)
    const exp = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.equal(exp.status, 200);
    assert.ok(exp.data.every((r) => r.pipe === "verified"));
    assert.ok(!exp.data.some((r) => r.pipe === "claim"));
  } finally {
    await s.close();
  }
});

test("search: log hygiene — no raw_quote / kid names / venom in logs", async () => {
  const s = await startMemory();
  const dad_id = randomUUID();
  try {
    logger.reset();
    const { token } = await provision(s.base, dad_id);
    await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: DENIED_VISIT_VENT },
      { token },
    );
    await jsonReq(
      s.base,
      "GET",
      `/vault/search?dad_id=${dad_id}&q=sabotage`,
      null,
      { token },
    );
    const logs = logger.lines().join("\n");
    assert.doesNotMatch(logs, /raw_quote/i);
    assert.doesNotMatch(logs, /Sam|Taylor|Jordan|hurt|sabotage/i);
    assert.match(logs, /search/);
  } finally {
    await s.close();
  }
});

const url = databaseUrl();

test(
  "search PG FTS: denied_visit claim ranked; dad A≠B; verified filter",
  { skip: url ? false : "BLOCKED: DATABASE_URL not set" },
  async () => {
    logger.reset();
    const store = await openStore({ databaseUrl: url, applySchema: true });
    assert.equal(store.kind, "postgres");
    const bff = makeBff(store.vault);
    const server = createServer(bff);
    const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${addr.port}`;
    const dadA = randomUUID();
    const dadB = randomUUID();

    try {
      const a = await jsonReq(base, "POST", "/vault/provision", { dad_id: dadA });
      const b = await jsonReq(base, "POST", "/vault/provision", { dad_id: dadB });
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);

      await jsonReq(
        base,
        "POST",
        "/vault/intake",
        { dad_id: dadA, text: DENIED_VISIT_VENT },
        { token: a.data.token },
      );
      await jsonReq(
        base,
        "POST",
        "/vault/intake",
        {
          dad_id: dadB,
          text:
            "UniquePgFtsMarkerZephyr: cancelled visit at the blue gate. " +
            "This is the second time this month.",
        },
        { token: b.data.token },
      );
      await jsonReq(
        base,
        "POST",
        "/vault/comms/pull",
        {
          dad_id: dadA,
          channel: "ofw",
          source_ref: "ofw:fts-pg:1",
          body_cold: "Verified OFW note about cancelled weekend visit.",
        },
        { token: a.data.token },
      );

      const fts = await jsonReq(
        base,
        "GET",
        `/vault/search?dad_id=${dadA}&q=weekend+visit&type=events`,
        null,
        { token: a.data.token },
      );
      assert.equal(fts.status, 200, JSON.stringify(fts.data));
      assert.equal(fts.data.mode, "fts");
      assert.ok(fts.data.hits.length >= 1, JSON.stringify(fts.data));
      assert.ok(fts.data.hits.every((h) => h.dad_id === dadA));
      assert.ok(fts.data.hits.some((h) => h.pipe === "claim"));

      const cross = await jsonReq(
        base,
        "GET",
        `/vault/search?dad_id=${dadB}&q=UniquePgFtsMarkerZephyr`,
        null,
        { token: a.data.token },
      );
      assert.equal(cross.status, 403);

      const noLeak = await jsonReq(
        base,
        "GET",
        `/vault/search?dad_id=${dadA}&q=UniquePgFtsMarkerZephyr`,
        null,
        { token: a.data.token },
      );
      assert.equal(noLeak.status, 200);
      assert.equal(noLeak.data.hits.length, 0);

      const ver = await jsonReq(
        base,
        "GET",
        `/vault/search?dad_id=${dadA}&q=cancelled&pipe=verified`,
        null,
        { token: a.data.token },
      );
      assert.equal(ver.status, 200);
      assert.ok(ver.data.hits.every((h) => h.pipe === "verified"));
      assert.ok(!ver.data.hits.some((h) => h.pipe === "claim"));

      // Confirm GIN / generated column present
      const col = await store.query(
        `select count(*)::int as n from information_schema.columns
          where table_name = 'events' and column_name = 'search_tsv'`,
      );
      assert.equal(col.rows[0].n, 1);

      const logs = logger.lines().join("\n");
      assert.doesNotMatch(logs, /Sam|Taylor|hurt|sabotage/i);
    } finally {
      await new Promise((r) => server.close(r));
      await store.close();
    }
  },
);
