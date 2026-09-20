// Soft progress + short checklist: clamps, plain-speech lines, soft grade,
// tenancy gates. Fake family only.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import { clampProgressPatch, progressLine, softGrade } from "../src/progress.js";
import * as logger from "../src/logger.js";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SHAME_RE = /shame|fail|behind|lazy|only|disappoint|bad dad|slack/i;

function assertChipSafe(text) {
  assert.equal(typeof text, "string");
  assert.doesNotMatch(text, /dde-stub/i);
  assert.doesNotMatch(text, /https?:\/\//i);
  assert.doesNotMatch(text, /bearer|authorization|x-dde-token/i);
  assert.doesNotMatch(text, UUID_RE);
}

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

async function provision(base, dad_id) {
  const prov = await jsonReq(base, "POST", "/vault/provision", { dad_id });
  assert.equal(prov.status, 200);
  return prov.data;
}

// ---------------------------------------------------------------------------
// Unit: clamps and lines.

test("clampProgressPatch: total clamps 3..7, done clamps 0..total, missing ≤ 7 short strings", () => {
  assert.equal(clampProgressPatch({ this_week_total: 1 }).this_week_total, 3);
  assert.equal(clampProgressPatch({ this_week_total: 99 }).this_week_total, 7);
  assert.equal(clampProgressPatch({ this_week_total: 5 }).this_week_total, 5);
  assert.equal(clampProgressPatch({ this_week_total: "4" }).this_week_total, 4);
  assert.equal(clampProgressPatch({ this_week_total: "nope" }).this_week_total, undefined);

  assert.equal(clampProgressPatch({ this_week_done: -2 }).this_week_done, 0);
  assert.equal(clampProgressPatch({ this_week_done: 9, this_week_total: 5 }).this_week_done, 5);
  assert.equal(clampProgressPatch({ this_week_done: 9 }).this_week_done, 7);

  const long = "x".repeat(200);
  const clamped = clampProgressPatch({
    missing: [" a ", "", long, "b", "c", "d", "e", "f", "g", "h"],
  });
  assert.equal(clamped.missing.length, 7);
  assert.equal(clamped.missing[0], "a");
  assert.equal(clamped.missing[1].length, 80);

  // Empty missing is a valid state — nothing to chase.
  assert.deepEqual(clampProgressPatch({ missing: [] }).missing, []);
  // Untouched fields pass through.
  assert.equal(clampProgressPatch({ this_week: "keep" }).this_week, "keep");
});

test("progressLine + softGrade: plain, null when nothing to say, never shame", () => {
  assert.equal(progressLine({ this_week_done: 3, this_week_total: 5 }), "3 of 5 this week");
  assert.equal(progressLine({ this_week_done: 3 }), null);
  assert.equal(progressLine({ this_week_total: 5 }), null);
  assert.equal(progressLine({}), null);

  assert.equal(softGrade({}), null);
  const graded = [
    softGrade({ this_week_done: 5, this_week_total: 5 }),
    softGrade({ last_next: "verify count in OFW record" }),
    softGrade({ this_week_done: 2 }),
    softGrade({ this_week_total: 5, this_week_done: 0 }),
  ];
  for (const g of graded) {
    assertChipSafe(g);
    assert.doesNotMatch(g, SHAME_RE, `shaming grade: ${g}`);
  }
});

// ---------------------------------------------------------------------------
// HTTP: PUT accepts + clamps, GET state returns, GET progress speaks.

test("PUT /vault/state clamps progress fields; GET state and GET /vault/progress return them", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const { token } = await provision(s.base, dad_id);

    // Out-of-range totals clamp, done caps at total, missing trims to 7.
    const put = await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      {
        dad_id,
        this_week_done: 12,
        this_week_total: 99,
        missing: ["pull OFW thread", "file the copy", "call school office",
                  "one", "two", "three", "four", "five extra beyond the cap"],
      },
      { token },
    );
    assert.equal(put.status, 200);
    assert.equal(put.data.this_week_total, 7);
    assert.equal(put.data.this_week_done, 7);
    assert.equal(put.data.missing.length, 7);

    // Reasonable week: 3 of 5.
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id, this_week_done: 3, this_week_total: 5 },
      { token },
    );
    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.equal(state.data.this_week_done, 3);
    assert.equal(state.data.this_week_total, 5);

    const prog = await jsonReq(s.base, "GET", `/vault/progress?dad_id=${dad_id}`, null, { token });
    assert.equal(prog.status, 200);
    assert.equal(prog.data.line, "3 of 5 this week");
    assert.equal(prog.data.missing_one, "pull OFW thread");
    assertChipSafe(prog.data.line);
    assertChipSafe(prog.data.grade);
    assert.doesNotMatch(prog.data.grade, SHAME_RE);

    // Low-ball total clamps up to 3.
    const low = await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id, this_week_total: 1 },
      { token },
    );
    assert.equal(low.data.this_week_total, 3);

    // Log hygiene: flags only, no line/grade text.
    assert.doesNotMatch(logger.lines().join("\n"), /this week|OFW thread|counts/i);
  } finally {
    await s.close();
  }
});

test("empty missing ok; fresh dad speaks the provision seed; legacy empty dad → nulls", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const { token } = await provision(s.base, dad_id);

    // Provision auto-seeds kids_facts: fresh dad already has 0-of-5.
    const fresh = await jsonReq(s.base, "GET", `/vault/progress?dad_id=${dad_id}`, null, { token });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.data.line, "0 of 5 this week");
    assert.equal(fresh.data.missing_one, "Kids school name");

    // Empty missing is still a valid state (counters remain).
    const put = await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id, missing: [] },
      { token },
    );
    assert.equal(put.status, 200);
    assert.deepEqual(put.data.missing, []);
    const cleared = await jsonReq(s.base, "GET", `/vault/progress?dad_id=${dad_id}`, null, { token });
    assert.equal(cleared.data.missing_one, null);
    assert.equal(cleared.data.line, "0 of 5 this week");

    // Truly empty (pre-auto-seed legacy) state → all nulls, nothing invented.
    const st = s.vault.getState(dad_id);
    st.this_week_done = null;
    st.this_week_total = null;
    const legacy = await jsonReq(s.base, "GET", `/vault/progress?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(legacy.data, {
      line: null,
      missing_one: null,
      grade: null,
      progress_line: null,
    });
  } finally {
    await s.close();
  }
});

test("BLOCKER gates on /vault/progress: 404 unknown dad, 401 no token, 403 cross-dad", async () => {
  const s = await start();
  const dadA = randomUUID();
  const dadB = randomUUID();
  try {
    const a = await provision(s.base, dadA);
    const b = await provision(s.base, dadB);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id: dadA, this_week_done: 2, this_week_total: 4, missing: ["private item"] },
      { token: a.token },
    );

    const unknown = await jsonReq(s.base, "GET", `/vault/progress?dad_id=${randomUUID()}`);
    assert.equal(unknown.status, 404);

    const noTok = await jsonReq(s.base, "GET", `/vault/progress?dad_id=${dadA}`);
    assert.equal(noTok.status, 401);

    const cross = await jsonReq(
      s.base,
      "GET",
      `/vault/progress?dad_id=${dadA}`,
      null,
      { token: b.token },
    );
    assert.equal(cross.status, 403);
    assert.deepEqual(cross.data, { error: "forbidden" });

    // B's own progress shows B's data, never A's checklist item.
    const own = await jsonReq(s.base, "GET", `/vault/progress?dad_id=${dadB}`, null, { token: b.token });
    assert.equal(own.status, 200);
    assert.notEqual(own.data.missing_one, "private item");
  } finally {
    await s.close();
  }
});
