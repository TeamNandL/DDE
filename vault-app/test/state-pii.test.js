// Chip-safety gap: PUT /vault/state free-text fields (this_week,
// next_action, missing[]) are spoken back by Chip — the One Next and
// progress missing_one — so PII must be stripped at that write path too,
// same rule as intake. Fake values only.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import { clampProgressPatch } from "../src/progress.js";

const PII = {
  phone: "904-555-1212",
  email: "jordan.lee@example.com",
  address: "482 Maple Street Apt 3",
  account: "021000021",
};

function assertNoPii(text, label) {
  const squashed = String(text).replace(/\s+/g, "");
  for (const [key, value] of Object.entries(PII)) {
    assert.ok(
      !String(text).includes(value) && !squashed.includes(value.replace(/\s+/g, "")),
      `${label} leaks ${key}: ${value}`,
    );
  }
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

test("clampProgressPatch strips PII from this_week / next_action / missing items", () => {
  const out = clampProgressPatch({
    this_week: `pull the thread and email ${PII.email}`,
    next_action: `text her at ${PII.phone} about Friday`,
    missing: [`drop the form at ${PII.address}`, `routing ${PII.account} to the sitter`],
  });
  assertNoPii(JSON.stringify(out), "clamped patch");
  assert.match(out.this_week, /\[email\]/);
  assert.match(out.next_action, /\[phone\]/);
  assert.match(out.missing[0], /\[address\]/);
  // Non-string / absent fields stay untouched.
  assert.equal(clampProgressPatch({}).this_week, undefined);
  assert.equal(clampProgressPatch({ next_action: null }).next_action, null);
});

test("PUT state with PII → state read, One Next, progress missing_one, return line all clean", async () => {
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
        this_week: `email ${PII.email} the school form`,
        next_action: `text her at ${PII.phone} about Friday pickup`,
        missing: [`drop paperwork at ${PII.address}`],
        this_week_done: 1,
        this_week_total: 3,
      },
      { token },
    );
    assert.equal(put.status, 200);
    assertNoPii(JSON.stringify(put.data), "PUT response");

    // Stored row itself is clean — not just the responses.
    assertNoPii(JSON.stringify(s.vault.getState(dad_id)), "stored state row");

    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assertNoPii(JSON.stringify(state.data), "GET state");
    assert.match(state.data.next_action, /\[phone\]/);

    const prog = await jsonReq(s.base, "GET", `/vault/progress?dad_id=${dad_id}`, null, { token });
    assert.equal(prog.status, 200);
    assert.equal(prog.data.line, "1 of 3 this week");
    assertNoPii(prog.data.missing_one, "missing_one");
    assert.match(prog.data.missing_one, /\[address\]/);

    // The return-loop greeting built from this Next is clean too.
    const ret = await jsonReq(s.base, "POST", "/vault/return", { dad_id }, { token });
    assert.equal(ret.status, 200);
    assertNoPii(ret.data.line, "return line");
    assert.match(ret.data.line, /^Last time: /);
  } finally {
    await s.close();
  }
});

test("legacy rows: progress missing_one is stripped at read even if stored dirty", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const prov = await jsonReq(s.base, "POST", "/vault/provision", { dad_id });
    const token = prov.data.token;
    // Simulate a pre-rail row written before the write-path strip existed.
    s.vault.getState(dad_id).missing = [`call ${PII.phone} back`];

    const prog = await jsonReq(s.base, "GET", `/vault/progress?dad_id=${dad_id}`, null, { token });
    assert.equal(prog.status, 200);
    assertNoPii(prog.data.missing_one, "legacy missing_one");
    assert.match(prog.data.missing_one, /\[phone\]/);
  } finally {
    await s.close();
  }
});
