// GET /vault/chip_entry — read-only speakable bundle for Chip:
// progress_line, missing_one, next_action, return_line. Nulls when there
// is nothing (no invented counters, no invented greeting). Fake dad only.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";

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

async function provisionedDad(base) {
  const dad_id = randomUUID();
  const prov = await jsonReq(base, "POST", "/vault/provision", { dad_id });
  assert.equal(prov.status, 200);
  return { dad_id, token: prov.data.token };
}

test("fresh dad → all nulls; nothing invented", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    const entry = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    assert.equal(entry.status, 200);
    assert.deepEqual(entry.data, {
      progress_line: null,
      missing_one: null,
      next_action: null,
      return_line: null,
    });
  } finally {
    await s.close();
  }
});

test("seeded state → all four speakable, PII-stripped, matching the other routes", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      {
        dad_id,
        next_action: `text her at ${PHONE} about Friday pickup`,
        missing: [`drop paperwork at 482 Maple Street Apt 3`, "file the copy"],
        this_week_done: 2,
        this_week_total: 4,
      },
      { token },
    );

    const entry = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    assert.equal(entry.status, 200);
    assert.equal(
      entry.data.progress_line,
      "2 of 4 this week; still open: drop paperwork at [address]",
    );
    assert.equal(entry.data.missing_one, "drop paperwork at [address]");
    assert.equal(entry.data.next_action, "text her at [phone] about Friday pickup");
    assert.equal(entry.data.return_line, "Last time: text her at [phone] about Friday pickup. How'd it go?");
    for (const v of Object.values(entry.data)) assertChipSafe(v);
    assert.ok(!JSON.stringify(entry.data).includes(PHONE));

    // Same greeting POST /vault/return would give (no divergence).
    const ret = await jsonReq(s.base, "POST", "/vault/return", { dad_id }, { token });
    assert.equal(ret.data.line, entry.data.return_line);
  } finally {
    await s.close();
  }
});

test("cold-ask state → return_line uses the ask summary", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      {
        dad_id,
        next_action: "send the Saturday cold ask",
        last_next_kind: "cold_ask",
        last_ask_summary: "Sat window both kids 10–6",
      },
      { token },
    );
    const entry = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    assert.equal(
      entry.data.return_line,
      "Last time: cold ask — Sat window both kids 10–6. How'd it go?",
    );
  } finally {
    await s.close();
  }
});

test("read-only: chip_entry never stamps last_next or writes anything", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id, next_action: "pull the OFW thread" },
      { token },
    );
    await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.equal(state.data.last_next, null, "GET must not stamp last_next");
    assert.equal((await s.vault.listEvents(dad_id)).length, 0);
  } finally {
    await s.close();
  }
});

test("gates: 404 unknown dad, 401 no token, 403 cross-dad", async () => {
  const s = await start();
  try {
    const a = await provisionedDad(s.base);
    const b = await provisionedDad(s.base);

    const unknown = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${randomUUID()}`);
    assert.equal(unknown.status, 404);

    const noTok = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${a.dad_id}`);
    assert.equal(noTok.status, 401);

    const cross = await jsonReq(
      s.base,
      "GET",
      `/vault/chip_entry?dad_id=${a.dad_id}`,
      null,
      { token: b.token },
    );
    assert.equal(cross.status, 403);
  } finally {
    await s.close();
  }
});
