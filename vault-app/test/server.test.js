// HTTP BFF — Phase 1 routes. Fake family only.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer, PHASE1_ROUTES, resolveListenHostPort } from "../src/server.js";
import { readFixedVent } from "../src/demo.js";
import * as logger from "../src/logger.js";

async function start() {
  logger.reset();
  const vault = new Vault();
  const bff = makeBff(vault);
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    vault,
    bff,
    server,
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function jsonReq(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}

test("HTTP BFF Phase 1 routes: intake → state → verified stays clean; comms pull is the only verified row", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const health = await jsonReq(s.base, "GET", "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(health.data, { ok: true });

    const root = await jsonReq(s.base, "GET", "/");
    assert.equal(root.status, 200);
    assert.deepEqual(root.data.routes, PHASE1_ROUTES);

    const intake = await jsonReq(s.base, "POST", "/vault/intake", {
      dad_id,
      text: readFixedVent(),
    });
    assert.equal(intake.status, 200);
    assert.ok(intake.data.written >= 1);
    assert.ok(intake.data.chase.length >= 1);

    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`);
    assert.equal(state.status, 200);
    assert.match(state.data.next_action, /verify count in OFW record/);

    const empty = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`);
    assert.equal(empty.status, 200);
    assert.equal(empty.data.length, 0);

    const harm = await jsonReq(s.base, "POST", "/vault/intake", {
      dad_id,
      text: "I am so angry I could hurt Jordan the next time she pulls this at the exchange.",
    });
    assert.equal(harm.status, 200);
    assert.deepEqual(harm.data, { written: 0, chase: [] });

    const cold = await jsonReq(s.base, "POST", "/vault/comms/cold", {
      dad_id,
      channel: "ofw",
      body_cold: "I arrived at the scheduled exchange time.",
    });
    assert.equal(cold.status, 200);
    assert.ok(cold.data.id);

    const pull = await jsonReq(s.base, "POST", "/vault/comms/pull", {
      dad_id,
      channel: "ofw",
      source_ref: "ofw:demo:http-test",
      body_cold: "Pulled OFW thread.",
      sent_at: "2026-09-14T18:00:00.000Z",
    });
    assert.equal(pull.status, 200);

    const verified = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`);
    assert.equal(verified.status, 200);
    assert.equal(verified.data.length, 1);
    assert.equal(verified.data[0].pipe, "verified");
    assert.equal(verified.data[0].source_table, "communications");

    const put = await jsonReq(s.base, "PUT", "/vault/state", {
      dad_id,
      this_week: "pull OFW September thread",
    });
    assert.equal(put.status, 200);
    assert.equal(put.data.this_week, "pull OFW September thread");
    assert.equal(put.data.next_action, state.data.next_action);

    const logs = logger.lines().join("\n");
    assert.doesNotMatch(logs, /Sam|Taylor|Jordan|hurt/i);
  } finally {
    await s.close();
  }
});

test("resolveListenHostPort: loopback locally, 0.0.0.0 in production", () => {
  assert.deepEqual(resolveListenHostPort({ env: {} }), { host: "127.0.0.1", port: 8787 });
  assert.deepEqual(resolveListenHostPort({ env: { NODE_ENV: "production" } }), {
    host: "0.0.0.0",
    port: 8787,
  });
  assert.deepEqual(resolveListenHostPort({ env: { HOST: "0.0.0.0", PORT: "3000" } }), {
    host: "0.0.0.0",
    port: 3000,
  });
  assert.deepEqual(resolveListenHostPort({ host: "127.0.0.1", port: "9999", env: { HOST: "0.0.0.0" } }), {
    host: "127.0.0.1",
    port: 9999,
  });
});

test("HTTP BFF rejects missing dad_id and unknown routes", async () => {
  const s = await start();
  try {
    const bad = await jsonReq(s.base, "POST", "/vault/intake", { text: "hello" });
    assert.equal(bad.status, 400);
    const missing = await jsonReq(s.base, "GET", "/vault/nope");
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});
