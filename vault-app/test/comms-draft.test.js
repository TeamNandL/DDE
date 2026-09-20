// Cold draft store (draft ≠ send): POST /vault/comms/draft stores a
// never-sent, never-verified draft after harm → PII → venom; GET
// /vault/comms/drafts lists drafts ONLY. No send endpoint exists for
// drafts. Fake dad only.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer, PHASE1_ROUTES } from "../src/server.js";
import * as logger from "../src/logger.js";

const PHONE = "904-555-1212";

async function start() {
  logger.reset();
  const vault = new Vault();
  const bff = makeBff(vault);
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    vault,
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
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
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function provisionedDad(base) {
  const dad_id = randomUUID();
  const prov = await jsonReq(base, "POST", "/vault/provision", { dad_id });
  assert.equal(prov.status, 200);
  return { dad_id, token: prov.data.token };
}

test("draft stored after PII+venom strip; never sent, never verified; round-trips in the list", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    const draft = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/draft",
      {
        dad_id,
        kind: "cold_ask",
        body: `Requesting the Saturday window for both kids, 10 to 6. She is doing this on purpose. Reach me at ${PHONE}.`,
      },
      { token },
    );
    assert.equal(draft.status, 200);
    assert.equal(draft.data.written, 1);
    assert.ok(draft.data.draft_id);
    assert.match(draft.data.body, /Saturday window for both kids/);
    assert.match(draft.data.body, /\[phone\]/);
    assert.doesNotMatch(draft.data.body, /on purpose/, "venom stripped");
    assert.ok(!draft.data.body.includes(PHONE));
    assert.equal(draft.data.soft_grade, "tighten", "venom was stripped → tighten");

    // Stored row: draft direction, claim pipe, never sent, kind carried.
    const row = s.vault.communications.find((c) => c.id === draft.data.draft_id);
    assert.equal(row.direction, "draft");
    assert.equal(row.pipe, "claim");
    assert.equal(row.sent_at, null);
    assert.equal(row.draft_kind, "cold_ask");
    assert.ok(!row.body_cold.includes(PHONE));

    // Never verified: export stays empty.
    const verified = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.deepEqual(verified.data, []);

    // List returns the draft, stripped, with its kind.
    const list = await jsonReq(s.base, "GET", `/vault/comms/drafts?dad_id=${dad_id}`, null, { token });
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].draft_id, draft.data.draft_id);
    assert.equal(list.data[0].kind, "cold_ask");
    assert.equal(list.data[0].body, draft.data.body);

    // Kind is optional.
    const plain = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/draft",
      { dad_id, body: "Confirming Thursday pickup time." },
      { token },
    );
    assert.equal(plain.data.written, 1);
    assert.equal(plain.data.soft_grade, "ready", "clean and short → ready");

    // Log hygiene: never the draft text or PII.
    assert.doesNotMatch(logger.lines().join("\n"), /Saturday window|904-555|Thursday pickup/i);
  } finally {
    await s.close();
  }
});

test("harm body → written:0, ZERO rows; pure-venom body → written:0 too", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);

    const harm = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/draft",
      { dad_id, body: "Draft this: I could kill that woman." },
      { token },
    );
    assert.equal(harm.status, 200);
    assert.deepEqual(harm.data, { written: 0 });
    assert.equal(s.vault.communications.length, 0);
    assert.doesNotMatch(logger.lines().join("\n"), /kill|that woman/i);

    const venomOnly = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/draft",
      { dad_id, body: "She is spiteful and toxic." },
      { token },
    );
    assert.deepEqual(venomOnly.data, { written: 0 });
    assert.equal(s.vault.communications.length, 0);
  } finally {
    await s.close();
  }
});

test("soft grade: length rule at the 280 boundary; harm response has NO soft_grade key", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);

    // Clean but long (> 280 stripped chars) → tighten, still stored.
    const longBody = "Requesting a calm written plan for the fall schedule. ".repeat(7).trim();
    assert.ok(longBody.length > 280);
    const long = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/draft",
      { dad_id, body: longBody },
      { token },
    );
    assert.equal(long.data.written, 1);
    assert.equal(long.data.soft_grade, "tighten");
    assert.ok(long.data.draft_id, "long draft is still stored");

    // Exactly at the boundary (<= 280) and clean → ready.
    const at280 = "a".repeat(280);
    const edge = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/draft",
      { dad_id, body: at280 },
      { token },
    );
    assert.equal(edge.data.soft_grade, "ready");

    // Harm → written:0 with no soft_grade key at all.
    const harm = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/draft",
      { dad_id, body: "I could kill that woman." },
      { token },
    );
    assert.deepEqual(harm.data, { written: 0 });
    assert.ok(!("soft_grade" in harm.data));
  } finally {
    await s.close();
  }
});

test("drafts list excludes sent/pulled comms; no send endpoint for drafts exists", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "POST",
      "/vault/comms/cold",
      { dad_id, channel: "ofw", body_cold: "I arrived at the scheduled time." },
      { token },
    );
    await jsonReq(
      s.base,
      "POST",
      "/vault/comms/pull",
      { dad_id, channel: "ofw", source_ref: "ofw:test:pull", body_cold: "Pulled thread." },
      { token },
    );
    await jsonReq(
      s.base,
      "POST",
      "/vault/comms/draft",
      { dad_id, body: "Draft only." },
      { token },
    );

    const list = await jsonReq(s.base, "GET", `/vault/comms/drafts?dad_id=${dad_id}`, null, { token });
    assert.equal(list.data.length, 1, "sent/pulled comms must not appear in drafts");
    assert.equal(list.data[0].body, "Draft only.");

    // This slice ships no draft-send route.
    assert.ok(!PHASE1_ROUTES.some((r) => /draft.*send|send.*draft/i.test(r)));
  } finally {
    await s.close();
  }
});

test("validation + gates: empty body 400, unknown kind 400, 404/401/403 on both routes", async () => {
  const s = await start();
  try {
    const a = await provisionedDad(s.base);
    const b = await provisionedDad(s.base);

    for (const bad of ["", "   ", 7]) {
      const res = await jsonReq(
        s.base,
        "POST",
        "/vault/comms/draft",
        { dad_id: a.dad_id, body: bad },
        { token: a.token },
      );
      assert.equal(res.status, 400, `expected 400 for body=${JSON.stringify(bad)}`);
    }

    const badKind = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/draft",
      { dad_id: a.dad_id, body: "ok", kind: "war_letter" },
      { token: a.token },
    );
    assert.equal(badKind.status, 400);

    const unknown = await jsonReq(s.base, "POST", "/vault/comms/draft", {
      dad_id: randomUUID(),
      body: "x",
    });
    assert.equal(unknown.status, 404);

    const noTok = await jsonReq(s.base, "GET", `/vault/comms/drafts?dad_id=${a.dad_id}`);
    assert.equal(noTok.status, 401);

    const crossPost = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/draft",
      { dad_id: a.dad_id, body: "leak" },
      { token: b.token },
    );
    assert.equal(crossPost.status, 403);
    const crossGet = await jsonReq(
      s.base,
      "GET",
      `/vault/comms/drafts?dad_id=${a.dad_id}`,
      null,
      { token: b.token },
    );
    assert.equal(crossGet.status, 403);
    assert.equal(s.vault.communications.length, 0, "blocked calls wrote nothing");
  } finally {
    await s.close();
  }
});
