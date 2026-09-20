// HTTP BFF — Phase 1 routes + tenancy/auth gate. Fake family only.

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
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}

async function provision(base, dad_id) {
  const prov = await jsonReq(base, "POST", "/vault/provision", dad_id ? { dad_id } : {});
  assert.equal(prov.status, 200, JSON.stringify(prov.data));
  assert.ok(prov.data.token);
  return prov.data;
}

test("HTTP BFF Phase 1 routes: provision → intake → state → verified stays clean", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const health = await jsonReq(s.base, "GET", "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(health.data, { ok: true });

    const root = await jsonReq(s.base, "GET", "/");
    assert.equal(root.status, 200);
    assert.deepEqual(root.data.routes, PHASE1_ROUTES);

    const { token } = await provision(s.base, dad_id);

    const intake = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: readFixedVent() },
      { token },
    );
    assert.equal(intake.status, 200);
    assert.ok(intake.data.written >= 1);
    assert.ok(intake.data.chase.length >= 1);

    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.equal(state.status, 200);
    assert.match(state.data.next_action, /verify count in OFW record/);

    const empty = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.equal(empty.status, 200);
    assert.equal(empty.data.length, 0);

    const harm = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      {
        dad_id,
        text: "I am so angry I could hurt Jordan the next time she pulls this at the exchange.",
      },
      { token },
    );
    assert.equal(harm.status, 200);
    assert.deepEqual(harm.data, { written: 0, chase: [] });

    const cold = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/cold",
      {
        dad_id,
        channel: "ofw",
        body_cold: "I arrived at the scheduled exchange time.",
      },
      { token },
    );
    assert.equal(cold.status, 200);
    assert.ok(cold.data.id);

    const pull = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/pull",
      {
        dad_id,
        channel: "ofw",
        source_ref: "ofw:demo:http-test",
        body_cold: "Pulled OFW thread.",
        sent_at: "2026-09-14T18:00:00.000Z",
      },
      { token },
    );
    assert.equal(pull.status, 200);

    const verified = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.equal(verified.status, 200);
    assert.equal(verified.data.length, 1);
    assert.equal(verified.data[0].pipe, "verified");
    assert.equal(verified.data[0].source_table, "communications");
    // Zero claim leak
    assert.ok(verified.data.every((r) => r.pipe === "verified"));

    const put = await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id, this_week: "pull OFW September thread" },
      { token },
    );
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

test("HTTP BFF: GET unknown dad → 404; POST provision → 200; GET that dad → 200", async () => {
  const s = await start();
  const unknown = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  try {
    const miss = await jsonReq(s.base, "GET", `/vault/state?dad_id=${unknown}`);
    assert.equal(miss.status, 404);
    assert.deepEqual(miss.data, { error: "unknown dad" });

    const prov = await jsonReq(s.base, "POST", "/vault/provision", {
      dad_id: unknown,
    });
    assert.equal(prov.status, 200);
    assert.equal(prov.data.dad_id, unknown);
    assert.match(prov.data.token, /^dde-stub-/);

    const hit = await jsonReq(
      s.base,
      "GET",
      `/vault/state?dad_id=${unknown}`,
      null,
      { token: prov.data.token },
    );
    assert.equal(hit.status, 200);
    assert.equal(hit.data.dad_id, unknown);
    assert.equal(hit.data.phase, "intake");
    // Provision auto-seeds the kids_facts checklist (5 blanks, 0 of 5).
    assert.deepEqual(hit.data.missing, [
      "Kids school name",
      "Teacher name (oldest)",
      "Pediatrician / clinic name",
      "After-school pickup person",
      "Emergency contact relationship",
    ]);
    assert.equal(hit.data.this_week_total, 5);
    assert.equal(hit.data.this_week_done, 0);
    assert.equal(hit.data.next_action, null);

    const again = await jsonReq(s.base, "POST", "/vault/provision", {
      dad_id: unknown,
    });
    assert.equal(again.status, 409);
  } finally {
    await s.close();
  }
});

test("BLOCKER: intake/PUT without provision → 404 unknown dad (no silent upsert)", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const intake = await jsonReq(s.base, "POST", "/vault/intake", {
      dad_id,
      text: "Jordan was late to the exchange at 6:45.",
    });
    assert.equal(intake.status, 404);
    assert.deepEqual(intake.data, { error: "unknown dad" });
    assert.equal(s.vault.getState(dad_id), null);
    assert.equal(s.vault.events.length, 0);

    const put = await jsonReq(s.base, "PUT", "/vault/state", {
      dad_id,
      this_week: "should not create",
    });
    assert.equal(put.status, 404);
    assert.deepEqual(put.data, { error: "unknown dad" });
    assert.equal(s.vault.getState(dad_id), null);
  } finally {
    await s.close();
  }
});

test("MAJOR: token gate — missing/bad → 401; good token → OK; X-DDE-Token works", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const { token } = await provision(s.base, dad_id);

    const noTok = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`);
    assert.equal(noTok.status, 401);
    assert.deepEqual(noTok.data, { error: "unauthorized" });

    const bad = await jsonReq(
      s.base,
      "GET",
      `/vault/state?dad_id=${dad_id}`,
      null,
      { token: "dde-stub-not-real" },
    );
    assert.equal(bad.status, 401);

    const ok = await jsonReq(
      s.base,
      "GET",
      `/vault/state?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.equal(ok.status, 200);

    // X-DDE-Token header
    const res = await fetch(`${s.base}/vault/state?dad_id=${dad_id}`, {
      headers: { "x-dde-token": token },
    });
    assert.equal(res.status, 200);

    const putNo = await jsonReq(s.base, "PUT", "/vault/state", {
      dad_id,
      this_week: "x",
    });
    assert.equal(putNo.status, 401);
  } finally {
    await s.close();
  }
});

test("BLOCKER tenancy: dad A cannot read/write dad B → 403", async () => {
  const s = await start();
  const dadA = randomUUID();
  const dadB = randomUUID();
  try {
    const a = await provision(s.base, dadA);
    const b = await provision(s.base, dadB);

    await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id: dadA, text: "Late to the exchange at 6:45." },
      { token: a.token },
    );

    // A token + B dad_id → 403
    const crossGet = await jsonReq(
      s.base,
      "GET",
      `/vault/state?dad_id=${dadB}`,
      null,
      { token: a.token },
    );
    assert.equal(crossGet.status, 403);
    assert.deepEqual(crossGet.data, { error: "forbidden" });

    const crossPut = await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id: dadB, this_week: "leak" },
      { token: a.token },
    );
    assert.equal(crossPut.status, 403);

    const crossIntake = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id: dadB, text: "Late to the exchange again." },
      { token: a.token },
    );
    assert.equal(crossIntake.status, 403);

    const crossExport = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dadB}`,
      null,
      { token: a.token },
    );
    assert.equal(crossExport.status, 403);

    // B's own read still works; A's data not returned
    const bState = await jsonReq(
      s.base,
      "GET",
      `/vault/state?dad_id=${dadB}`,
      null,
      { token: b.token },
    );
    assert.equal(bState.status, 200);
    assert.equal(bState.data.dad_id, dadB);
    assert.notEqual(bState.data.dad_id, dadA);
  } finally {
    await s.close();
  }
});

test("MAJOR: export/verified enforces dad+token; verified pipe only", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const { token } = await provision(s.base, dad_id);
    await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: readFixedVent() },
      { token },
    );
    await jsonReq(
      s.base,
      "POST",
      "/vault/comms/pull",
      {
        dad_id,
        channel: "ofw",
        source_ref: "ofw:export-test",
        body_cold: "verified pull",
      },
      { token },
    );

    const noTok = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`);
    assert.equal(noTok.status, 401);

    const rows = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.equal(rows.status, 200);
    assert.ok(rows.data.length >= 1);
    for (const r of rows.data) {
      assert.equal(r.pipe, "verified");
      assert.equal(r.dad_id, dad_id);
    }
  } finally {
    await s.close();
  }
});

test("Chip deep-link: GET /app and /chip/entry serve HTML; Bearer state+intake work", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    for (const path of ["/app", "/chip/entry"]) {
      const res = await fetch(`${s.base}${path}`);
      assert.equal(res.status, 200);
      const ct = res.headers.get("content-type") || "";
      assert.match(ct, /text\/html/);
      const html = await res.text();
      assert.match(html, /Chip vault entry/);
      assert.match(html, /Authorization/);
      assert.match(html, /\/vault\/state/);
      assert.match(html, /\/vault\/intake/);
    }

    const root = await jsonReq(s.base, "GET", "/");
    assert.equal(root.status, 200);
    assert.deepEqual(root.data.chip_entry, ["/app", "/chip/entry"]);

    const { token } = await provision(s.base, dad_id);
    const state0 = await jsonReq(
      s.base,
      "GET",
      `/vault/state?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.equal(state0.status, 200);
    assert.equal(state0.data.phase, "intake");

    const intake = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      {
        dad_id,
        text: "Jordan was late to the exchange until 6:45. This is the third time this month.",
      },
      { token },
    );
    assert.equal(intake.status, 200);
    assert.ok(intake.data.written >= 1);

    const state1 = await jsonReq(
      s.base,
      "GET",
      `/vault/state?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.equal(state1.status, 200);
    // One Next = next_action
    assert.ok(state1.data.next_action);
    assert.match(String(state1.data.next_action), /verify|OFW|count/i);
  } finally {
    await s.close();
  }
});
