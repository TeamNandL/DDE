// POST /vault/missing/seed — kids-facts pack: PII-safe blank labels onto an
// EMPTY checklist only. No overwrite, no counter invention over existing
// values, no event/comms rows. Fake dad only.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff, SEED_PACKS } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";

const KIDS_FACTS = [
  "Kids school name",
  "Teacher name (oldest)",
  "Pediatrician / clinic name",
  "After-school pickup person",
  "Emergency contact relationship",
];

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

async function provisionedDad(base) {
  const dad_id = randomUUID();
  const prov = await jsonReq(base, "POST", "/vault/provision", { dad_id });
  assert.equal(prov.status, 200);
  return { dad_id, token: prov.data.token };
}

test("pack labels are PII-safe blanks: no names, dates, numbers, or case data", () => {
  assert.deepEqual(SEED_PACKS.kids_facts, KIDS_FACTS);
  for (const label of SEED_PACKS.kids_facts) {
    assert.ok(label.length <= 80);
    assert.doesNotMatch(label, /\d/, `digits in label: ${label}`);
    assert.doesNotMatch(label, /Sam|Taylor|Alex|Jordan/i, `name in label: ${label}`);
  }
  assert.ok(SEED_PACKS.kids_facts.length <= 7, "checklist rail: max 7");
});

test("empty missing + null counters → seed 5 blanks, total 5 / done 0, progress line speaks", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    const seed = await jsonReq(
      s.base,
      "POST",
      "/vault/missing/seed",
      { dad_id, pack: "kids_facts" },
      { token },
    );
    assert.equal(seed.status, 200);
    assert.equal(seed.data.written, 1);
    assert.equal(seed.data.missing_one, "Kids school name");
    assert.equal(seed.data.progress_line, "0 of 5 this week; still open: Kids school name");

    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(state.data.missing, KIDS_FACTS);
    assert.equal(state.data.this_week_total, 5);
    assert.equal(state.data.this_week_done, 0);

    // No event/comms rows — claim ≠ verified untouched.
    assert.equal((await s.vault.listEvents(dad_id)).length, 0);
    assert.equal(s.vault.communications.length, 0);
    const verified = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.deepEqual(verified.data, []);

    // Default pack when omitted.
    const other = await provisionedDad(s.base);
    const noPack = await jsonReq(
      s.base,
      "POST",
      "/vault/missing/seed",
      { dad_id: other.dad_id },
      { token: other.token },
    );
    assert.equal(noPack.data.written, 1);
    assert.equal(noPack.data.missing_one, "Kids school name");
  } finally {
    await s.close();
  }
});

test("non-empty missing → written 0, no overwrite; reports current first item", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id, missing: ["pull OFW thread"], this_week_done: 1, this_week_total: 3 },
      { token },
    );
    const seed = await jsonReq(s.base, "POST", "/vault/missing/seed", { dad_id }, { token });
    assert.equal(seed.status, 200);
    assert.equal(seed.data.written, 0);
    assert.equal(seed.data.missing_one, "pull OFW thread");
    assert.equal(seed.data.progress_line, "1 of 3 this week; still open: pull OFW thread");

    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(state.data.missing, ["pull OFW thread"], "existing checklist untouched");
  } finally {
    await s.close();
  }
});

test("existing counters are never invented over — seed fills missing only", async () => {
  const s = await start();
  try {
    // Both counters set, empty missing.
    const a = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id: a.dad_id, this_week_done: 2, this_week_total: 4 },
      { token: a.token },
    );
    const seedA = await jsonReq(s.base, "POST", "/vault/missing/seed", { dad_id: a.dad_id }, { token: a.token });
    assert.equal(seedA.data.written, 1);
    const stateA = await jsonReq(s.base, "GET", `/vault/state?dad_id=${a.dad_id}`, null, { token: a.token });
    assert.equal(stateA.data.this_week_total, 4, "existing total kept");
    assert.equal(stateA.data.this_week_done, 2, "existing done kept");
    assert.deepEqual(stateA.data.missing, KIDS_FACTS);
    assert.equal(seedA.data.progress_line, "2 of 4 this week; still open: Kids school name");

    // Only total set (done null) → "both null" not met → counters untouched.
    const b = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id: b.dad_id, this_week_total: 3 },
      { token: b.token },
    );
    await jsonReq(s.base, "POST", "/vault/missing/seed", { dad_id: b.dad_id }, { token: b.token });
    const stateB = await jsonReq(s.base, "GET", `/vault/state?dad_id=${b.dad_id}`, null, { token: b.token });
    assert.equal(stateB.data.this_week_total, 3);
    assert.equal(stateB.data.this_week_done, null);
  } finally {
    await s.close();
  }
});

test("seed → fill loop: first blank closes, done bumps to 1 of 5", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(s.base, "POST", "/vault/missing/seed", { dad_id }, { token });
    const fill = await jsonReq(
      s.base,
      "POST",
      "/vault/missing/fill",
      { dad_id, answer: "Maple Street Elementary" },
      { token },
    );
    assert.equal(fill.data.written, 1);
    assert.equal(fill.data.missing_one, "Teacher name (oldest)");
    assert.equal(fill.data.progress_line, "1 of 5 this week; still open: Teacher name (oldest)");
  } finally {
    await s.close();
  }
});

test("gates and validation: unknown pack 400; 404/401/403 matrix", async () => {
  const s = await start();
  try {
    const a = await provisionedDad(s.base);
    const b = await provisionedDad(s.base);

    const badPack = await jsonReq(
      s.base,
      "POST",
      "/vault/missing/seed",
      { dad_id: a.dad_id, pack: "war_plan" },
      { token: a.token },
    );
    assert.equal(badPack.status, 400);

    const unknown = await jsonReq(s.base, "POST", "/vault/missing/seed", { dad_id: randomUUID() });
    assert.equal(unknown.status, 404);

    const noTok = await jsonReq(s.base, "POST", "/vault/missing/seed", { dad_id: a.dad_id });
    assert.equal(noTok.status, 401);

    const cross = await jsonReq(
      s.base,
      "POST",
      "/vault/missing/seed",
      { dad_id: a.dad_id },
      { token: b.token },
    );
    assert.equal(cross.status, 403);
    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${a.dad_id}`, null, {
      token: a.token,
    });
    assert.deepEqual(state.data.missing, [], "blocked cross-dad seed wrote nothing");
  } finally {
    await s.close();
  }
});
