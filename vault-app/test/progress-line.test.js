// Soft-progress Chip line: ONE ADHD-short formatter — "N of M this week"
// (+ "; still open: <one item>") or null, never invented, never shame.
// Surfaced as progress_line on GET /vault/progress and POST /vault/return.
// Fake dad only.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import { progressChipLine } from "../src/progress.js";

const PHONE = "904-555-1212";

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
// Formatter units: null / N of M / N of M + one open item.

test("progressChipLine: counters → 'N of M'; + first open item; empty → null", () => {
  assert.equal(progressChipLine({}), null);
  assert.equal(progressChipLine({ this_week_done: 3 }), null);
  assert.equal(progressChipLine({ this_week_total: 5 }), null);
  // Missing alone is not a counter line — never invent counters.
  assert.equal(progressChipLine({ missing: ["pull OFW thread"] }), null);

  assert.equal(
    progressChipLine({ this_week_done: 3, this_week_total: 5 }),
    "3 of 5 this week",
  );
  assert.equal(
    progressChipLine({ this_week_done: 3, this_week_total: 5, missing: [] }),
    "3 of 5 this week",
  );
  // Exactly ONE open item is spoken, the first.
  assert.equal(
    progressChipLine({
      this_week_done: 3,
      this_week_total: 5,
      missing: ["pull OFW thread", "file the copy"],
    }),
    "3 of 5 this week; still open: pull OFW thread",
  );
  // Legacy dirty row: PII stripped at compose too.
  assert.equal(
    progressChipLine({
      this_week_done: 1,
      this_week_total: 3,
      missing: [`call ${PHONE} back`],
    }),
    "1 of 3 this week; still open: call [phone] back",
  );
});

// ---------------------------------------------------------------------------
// HTTP: PUT counters → GET progress + return payload carry the line.

test("PUT counters → GET /vault/progress progress_line; PII in missing stripped", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const prov = await jsonReq(s.base, "POST", "/vault/provision", { dad_id });
    const token = prov.data.token;

    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      {
        dad_id,
        this_week_done: 2,
        this_week_total: 4,
        missing: [`text her at ${PHONE} about Friday`, "file the copy"],
      },
      { token },
    );

    const prog = await jsonReq(s.base, "GET", `/vault/progress?dad_id=${dad_id}`, null, { token });
    assert.equal(prog.status, 200);
    assert.equal(
      prog.data.progress_line,
      "2 of 4 this week; still open: text her at [phone] about Friday",
    );
    assert.ok(!JSON.stringify(prog.data).includes(PHONE));

    // Return payload carries it alongside the greeting line.
    const ret = await jsonReq(s.base, "POST", "/vault/return", { dad_id }, { token });
    assert.equal(ret.status, 200);
    assert.equal(ret.data.progress_line, prog.data.progress_line);

    // Claim ≠ verified untouched: nothing here feeds the export.
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

test("fresh dad speaks the seed; truly empty progress → null; bare counters → N of M", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const prov = await jsonReq(s.base, "POST", "/vault/provision", { dad_id });
    const token = prov.data.token;

    // Provision auto-seeds kids_facts → the line speaks immediately.
    const seeded = "0 of 5 this week; still open: Kids school name";
    const fresh = await jsonReq(s.base, "GET", `/vault/progress?dad_id=${dad_id}`, null, { token });
    assert.equal(fresh.data.progress_line, seeded);
    const freshRet = await jsonReq(s.base, "POST", "/vault/return", { dad_id }, { token });
    assert.equal(freshRet.data.progress_line, seeded);

    // Truly empty (pre-auto-seed legacy) state → null everywhere.
    const st = s.vault.getState(dad_id);
    st.missing = [];
    st.this_week_done = null;
    st.this_week_total = null;
    const legacy = await jsonReq(s.base, "GET", `/vault/progress?dad_id=${dad_id}`, null, { token });
    assert.equal(legacy.data.progress_line, null);
    const legacyRet = await jsonReq(s.base, "POST", "/vault/return", { dad_id }, { token });
    assert.equal(legacyRet.data.progress_line, null);

    // Counters without missing → bare N of M.
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id, missing: [], this_week_done: 0, this_week_total: 3 },
      { token },
    );
    const prog = await jsonReq(s.base, "GET", `/vault/progress?dad_id=${dad_id}`, null, { token });
    assert.equal(prog.data.progress_line, "0 of 3 this week");
  } finally {
    await s.close();
  }
});
