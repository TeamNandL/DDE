// Slice 18 — Auth matrix on EVERY dad-scoped BFF route (memory store).
// no token → 401 · bad token → 401 · another dad's token → 403 ·
// unknown dad → 404 · own token → 200. Provision stays the only mint path.
// The Postgres leg (auth-rls.pg.test.js) runs the same matrix with RLS on.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer, PHASE1_ROUTES } from "../src/server.js";
import { bindDad, currentDad, runAsDad, runRequestScope, scopedSql } from "../src/scope.js";
import { MINT_ROUTES, authMatrix, jsonReq, routeCases } from "./auth-cases.js";

async function start() {
  const vault = new Vault();
  const bff = makeBff(vault, { now: Date.parse("2026-09-27T16:00:00Z") });
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  return { bff, base: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(r)) };
}

test("matrix covers every dad-scoped route in PHASE1_ROUTES (+ PATCH /vault/state)", () => {
  const covered = new Set(routeCases(randomUUID()).map((c) => `${c.method} ${c.path.split("?")[0]}`));
  for (const r of PHASE1_ROUTES) {
    if (MINT_ROUTES.includes(r)) continue;
    assert.ok(covered.has(r), `auth matrix is missing ${r}`);
  }
  assert.ok(covered.has("PATCH /vault/state"));
});

test("auth matrix (memory): 401 none/bad · 403 cross-dad · 404 unknown · 200 own — every route", async () => {
  const s = await start();
  try {
    const a = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const b = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const mint = async (id) => (await s.bff.mintToken({ dad_id: id })).token;
    const rows = await authMatrix(s.base, a, b, randomUUID(), mint);
    for (const r of rows) {
      assert.equal(r.none, 401, `${r.route} no token`);
      assert.equal(r.bad, 401, `${r.route} bad token`);
      assert.equal(r.cross, 403, `${r.route} cross-dad`);
      assert.equal(r.unknown, 404, `${r.route} unknown dad`);
      assert.equal(r.own, 200, `${r.route} own token: ${JSON.stringify(r.error)}`);
    }
    assert.equal(rows.length, 43);
  } finally {
    await s.close();
  }
});

test("provision is the only unauthenticated mint path; raw token never stored", async () => {
  const s = await start();
  try {
    const p = await jsonReq(s.base, "POST", "/vault/provision", {});
    assert.equal(p.status, 200);
    assert.match(p.data.token, /\S{20,}/);
    // No other route creates a dad: an unknown dad is 404 even with a token.
    const other = randomUUID();
    const intake = await jsonReq(s.base, "POST", "/vault/intake", { dad_id: other, text: "hi" }, { token: p.data.token });
    assert.equal(intake.status, 404);
  } finally {
    await s.close();
  }
});

test("scope: bind once per request, uuid only, resets outside the request", async () => {
  assert.equal(currentDad(), null);
  const a = randomUUID();
  await runRequestScope(async () => {
    assert.equal(currentDad(), null, "unbound until the gate passes");
    bindDad(a);
    await Promise.resolve();
    assert.equal(currentDad(), a, "survives awaits");
    assert.throws(() => bindDad(randomUUID()), /already bound/);
    assert.doesNotThrow(() => bindDad(a));
  });
  assert.equal(currentDad(), null);
  assert.throws(() => runAsDad("x'; drop table events; --", () => {}), /uuid/);
  assert.throws(() => scopedSql("nope", "select 1"), /uuid/);
  assert.match(scopedSql(a, "select 1"), new RegExp(`^select set_config\\('role', 'dde_app', true\\); select set_config\\('dde.dad_id', '${a}', true\\); select 1$`));
  assert.equal(bindDad(a), false, "no request scope → nothing bound (owner path)");
});
