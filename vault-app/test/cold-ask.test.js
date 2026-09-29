// Cold-ask state hook for the return loop. Fake family only (Alex Rivera
// demo dad); no real case names anywhere in fixtures.
//
// PUT/GET /vault/state round-trips last_next_kind + last_ask_summary with
// PII strip; the return loop prefers "Last time: cold ask — <summary>."
// Draft≠send rails untouched — nothing here writes communications.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff, coldAskLine, returnLine } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import { clampProgressPatch } from "../src/progress.js";

const PHONE = "904-555-1212";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function assertChipSafe(text) {
  assert.equal(typeof text, "string");
  assert.doesNotMatch(text, /dde-stub/i);
  assert.doesNotMatch(text, /https?:\/\//i);
  assert.doesNotMatch(text, /bearer|authorization|x-dde-token/i);
  assert.doesNotMatch(text, UUID_RE);
  assert.ok(!text.includes(PHONE));
}

async function start() {
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

// ---------------------------------------------------------------------------
// Units.

test("coldAskLine: summary → greeting; empty/blank → null", () => {
  assert.equal(
    coldAskLine("Sat window both kids 10–6"),
    "Last time: cold ask — Sat window both kids 10–6. How'd it go?",
  );
  assert.equal(coldAskLine(""), null);
  assert.equal(coldAskLine("   "), null);
  assert.equal(coldAskLine(null), null);
  // PII in a summary is stripped even at compose time.
  assert.match(coldAskLine(`reach me at ${PHONE}`), /\[phone\]/);
});

test("clampProgressPatch: cold-ask fields PII-stripped, trimmed, capped; empty → null", () => {
  const out = clampProgressPatch({
    last_next_kind: "  cold_ask  ",
    last_ask_summary: `  Sat window both kids 10–6, confirm at ${PHONE}  `,
  });
  assert.equal(out.last_next_kind, "cold_ask");
  assert.match(out.last_ask_summary, /^Sat window both kids 10–6, confirm at \[phone\]$/);

  assert.equal(clampProgressPatch({ last_ask_summary: "   " }).last_ask_summary, null);
  assert.equal(clampProgressPatch({ last_ask_summary: "x".repeat(300) }).last_ask_summary.length, 120);
  assert.equal(clampProgressPatch({}).last_next_kind, undefined);
});

// ---------------------------------------------------------------------------
// HTTP: round-trip + return-loop preference. Fake dad only.

test("cold-ask return loop: PUT round-trip with PII strip; return prefers the ask summary", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const prov = await jsonReq(s.base, "POST", "/vault/provision", { dad_id });
    const token = prov.data.token;

    const put = await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      {
        dad_id,
        next_action: "send the Saturday cold ask",
        last_next_kind: "cold_ask",
        last_ask_summary: `Sat window both kids 10–6, confirm at ${PHONE}`,
      },
      { token },
    );
    assert.equal(put.status, 200);
    assert.equal(put.data.last_next_kind, "cold_ask");
    assert.match(put.data.last_ask_summary, /\[phone\]/);
    assert.ok(!JSON.stringify(put.data).includes(PHONE));

    // GET round-trip.
    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.equal(state.data.last_next_kind, "cold_ask");
    assert.match(state.data.last_ask_summary, /^Sat window both kids 10–6/);

    // Return loop prefers the cold-ask line.
    const ret = await jsonReq(s.base, "POST", "/vault/return", { dad_id }, { token });
    assert.equal(ret.status, 200);
    assert.match(ret.data.line, /^Last time: cold ask — Sat window both kids 10–6/);
    assert.match(ret.data.line, /How'd it go\?$/);
    assertChipSafe(ret.data.line);
    // last_next still stamps from next_action as before.
    assert.equal(ret.data.last_next, "send the Saturday cold ask");
  } finally {
    await s.close();
  }
});

test("fallbacks: kind without summary, or no kind → existing return behavior", async () => {
  const s = await start();
  const dadA = randomUUID();
  const dadB = randomUUID();
  try {
    const a = await jsonReq(s.base, "POST", "/vault/provision", { dad_id: dadA });
    const b = await jsonReq(s.base, "POST", "/vault/provision", { dad_id: dadB });

    // kind=cold_ask but no summary → generic line from next_action.
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id: dadA, next_action: "pull the OFW thread", last_next_kind: "cold_ask" },
      { token: a.data.token },
    );
    const retA = await jsonReq(s.base, "POST", "/vault/return", { dad_id: dadA }, { token: a.data.token });
    assert.equal(retA.data.line, "Last time: pull the OFW thread. How'd it go?");

    // No kind, summary present → generic line too (kind gates the variant).
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id: dadB, next_action: "confirm the sitter", last_ask_summary: "Sat window" },
      { token: b.data.token },
    );
    const retB = await jsonReq(s.base, "POST", "/vault/return", { dad_id: dadB }, { token: b.data.token });
    assert.equal(retB.data.line, "Last time: confirm the sitter. How'd it go?");

    // Empty everything stays null (nothing invented) — fresh dad.
    const dadC = randomUUID();
    const c = await jsonReq(s.base, "POST", "/vault/provision", { dad_id: dadC });
    const retC = await jsonReq(s.base, "POST", "/vault/return", { dad_id: dadC }, { token: c.data.token });
    assert.equal(retC.data.line, null);
    assert.equal(retC.data.last_next, null);
  } finally {
    await s.close();
  }
});

test("draft≠send rails untouched: cold-ask state hook writes no communications", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const prov = await jsonReq(s.base, "POST", "/vault/provision", { dad_id });
    const token = prov.data.token;
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id, last_next_kind: "cold_ask", last_ask_summary: "Sat window both kids 10–6" },
      { token },
    );
    await jsonReq(s.base, "POST", "/vault/return", { dad_id }, { token });
    assert.equal(s.vault.communications.length, 0, "state hook must not create comms rows");
    const verified = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.deepEqual(verified.data, []);
  } finally {
    await s.close();
  }
});
