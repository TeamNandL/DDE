// Progress persist on REAL Postgres (live repro of the PUT persist bug).
// Proves PUT /vault/state → GET /vault/state → GET /vault/progress
// "2 of 5 this week" through the full HTTP + SqlVault path — the same
// path Railway runs. Skips (BLOCKED, not passed) without DATABASE_URL.
//
// The live failure's root cause was upstream of the persist code:
// vault/003_fts.sql used array_to_string (STABLE) inside generated
// columns, so applyVaultSchema crashed on any stock fresh Postgres and
// the host kept serving a stale build. This suite boots the store the
// production way, so a schema that cannot apply fails HERE first.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";
import { openTokenStore } from "../src/tokens.js";
import { createServer, listenServer } from "../src/server.js";

const url = databaseUrl();

test("PG progress persist: PUT → GET state → GET /vault/progress '2 of 5 this week'", { skip: !url && "DATABASE_URL not set — BLOCKED" }, async () => {
  const store = await openStore({ databaseUrl: url });
  assert.equal(store.kind, "postgres");
  const tokenStore = await openTokenStore({ query: store.query });
  const bff = makeBff(store.vault, { tokenStore });
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  const dad_id = randomUUID();

  const jsonReq = async (method, path, body, token) => {
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
  };

  try {
    const prov = await jsonReq("POST", "/vault/provision", { dad_id });
    assert.equal(prov.status, 200);
    const token = prov.data.token;

    // The exact live repro payload.
    const put = await jsonReq(
      "PUT",
      "/vault/state",
      { dad_id, this_week_done: 2, this_week_total: 5, missing: ["x"] },
      token,
    );
    assert.equal(put.status, 200);
    assert.equal(put.data.this_week_done, 2);
    assert.equal(put.data.this_week_total, 5);
    assert.deepEqual(put.data.missing, ["x"]);

    // Persisted: a FRESH read sees the same values.
    const state = await jsonReq("GET", `/vault/state?dad_id=${dad_id}`, null, token);
    assert.equal(state.status, 200);
    assert.equal(state.data.this_week_done, 2);
    assert.equal(state.data.this_week_total, 5);
    assert.deepEqual(state.data.missing, ["x"]);

    const prog = await jsonReq("GET", `/vault/progress?dad_id=${dad_id}`, null, token);
    assert.equal(prog.status, 200);
    assert.equal(prog.data.line, "2 of 5 this week");
    assert.equal(prog.data.missing_one, "x");

    // Clamps hold on PG too.
    const clamped = await jsonReq(
      "PUT",
      "/vault/state",
      { dad_id, this_week_total: 99, this_week_done: 12 },
      token,
    );
    assert.equal(clamped.data.this_week_total, 7);
    assert.equal(clamped.data.this_week_done, 7);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await tokenStore.close();
    await store.close();
  }
});
