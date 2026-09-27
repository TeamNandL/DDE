// Slice 20 — token lifecycle on REAL Postgres. Skips (BLOCKED, not passed)
// without DATABASE_URL.
//   1. Cutover: a pre-Slice-20 dde_provision_tokens (no last_seen_at) gains
//      the column and every existing row is backfilled to now() — a 40-day-old
//      token is still honored (no mass logout on first deploy).
//   2. ROLLBACK proof: after logout / sweep, the EXACT lookup query that
//      476ff09 runs (`revoked_at is null`) finds no row — revoked tokens stay
//      dead under the old code. There is no signing key; the row is the truth.
//   3. Logout (all-device) and expiry through the RLS-bound request.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";
import { hashToken, openTokenStore } from "../src/tokens.js";
import { createServer, listenServer } from "../src/server.js";
import { jsonReq } from "./auth-cases.js";

const url = databaseUrl();
const skip = !url && "DATABASE_URL not set — BLOCKED";
const T0 = Date.parse("2026-09-27T16:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

// Verbatim from vault-app/src/tokens.js @ 476ff09 (createPostgresTokenStore.lookupActive).
const LOOKUP_SQL_AT_476ff09 = `select token_hash, dad_id::text as dad_id, created_at, revoked_at
           from dde_provision_tokens
          where token_hash = $1 and revoked_at is null
          limit 1`;

test("PG cutover: old-shape table gains last_seen_at, rows backfilled to now(); 40-day-old token still honored", { skip }, async () => {
  const { default: pg } = await import("pg");
  const schema = `slice20_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    // Exact 476ff09 shape.
    await pool.query(`create table dde_provision_tokens (
      token_hash text primary key, dad_id uuid not null,
      created_at timestamptz not null default now(), revoked_at timestamptz)`);
    const dad = randomUUID();
    const before = Date.now();
    await pool.query(
      `insert into dde_provision_tokens (token_hash, dad_id, created_at) values ($1, $2, $3), ($4, $2, $5)`,
      [hashToken("old"), dad, new Date(before - 40 * DAY).toISOString(), hashToken("recent"), new Date(before - DAY).toISOString()],
    );

    const store = await openTokenStore({ query: (sql, p) => pool.query(sql, p) });
    const { rows: col } = await pool.query(
      `select 1 from information_schema.columns
        where table_schema = $1 and table_name = 'dde_provision_tokens' and column_name = 'last_seen_at'`,
      [schema],
    );
    assert.equal(col.length, 1, "last_seen_at added");
    const { rows } = await pool.query(`select last_seen_at from dde_provision_tokens where dad_id = $1`, [dad]);
    assert.equal(rows.length, 2);
    for (const r of rows) assert.ok(r.last_seen_at && r.last_seen_at.getTime() >= before, "backfilled to now(), not created_at");

    const vault = { getState: async (id) => (id === dad ? { dad_id: id } : null) };
    const bff = makeBff(vault, { tokenStore: store, now: Date.now() });
    assert.equal(await bff.checkToken(dad, "old"), true, "40 days old, still honored — clock starts at cutover");
    assert.equal(await bff.checkToken(dad, "recent"), true);

    // 30 days of silence from the cutover → dead, and durably so.
    const later = makeBff(vault, { tokenStore: store, now: Date.now() + 30 * DAY });
    await assert.rejects(() => later.checkToken(dad, "old"), (e) => e.status === 401 && e.message === "token expired");
    const { rows: gone } = await pool.query(LOOKUP_SQL_AT_476ff09, [hashToken("old")]);
    assert.equal(gone.length, 0, "ROLLBACK: 476ff09's own lookup finds nothing — stays dead");

    // sweep catches the one never presented again.
    assert.equal(await store.revokeIdle(30 * DAY, Date.now() + 30 * DAY), 1);
    const { rows: gone2 } = await pool.query(LOOKUP_SQL_AT_476ff09, [hashToken("recent")]);
    assert.equal(gone2.length, 0);
    assert.equal(await store.revokeAll(), 0);
  } finally {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  }
});

test("PG all-device logout / panic through the RLS-bound request; 476ff09 lookup finds no row after", { skip }, async () => {
  const store = await openStore({ databaseUrl: url });
  const tokenStore = await openTokenStore({ query: store.query });
  const bff = makeBff(store.vault, { tokenStore, now: T0 });
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  const state = (id, token) => jsonReq(base, "GET", `/vault/state?dad_id=${id}`, null, { token });
  try {
    const a = (await jsonReq(base, "POST", "/vault/provision", {})).data;
    const b = (await jsonReq(base, "POST", "/vault/provision", {})).data;
    const t2 = (await bff.mintToken({ dad_id: a.dad_id })).token;

    assert.equal((await jsonReq(base, "POST", "/vault/panic", { dad_id: b.dad_id }, { token: a.token })).status, 403);

    const out = await jsonReq(base, "POST", "/vault/logout", { dad_id: a.dad_id }, { token: a.token });
    assert.deepEqual([out.status, out.data], [200, { logged_out: true, revoked: 2 }]);
    assert.equal((await state(a.dad_id, a.token)).status, 401);
    assert.equal((await state(a.dad_id, t2)).status, 401, "all-device");
    assert.equal((await state(b.dad_id, b.token)).status, 200, "B untouched");

    for (const t of [a.token, t2]) {
      const { rows } = await store.query(LOOKUP_SQL_AT_476ff09, [hashToken(t)]);
      assert.equal(rows.length, 0, "ROLLBACK: dead under 476ff09's query too");
    }
    const { rows } = await store.query(
      `select count(*)::int as live from dde_provision_tokens where dad_id = $1 and revoked_at is null`,
      [a.dad_id],
    );
    assert.equal(rows[0].live, 0);

    // Sliding: B's use at T0 is its clock; touch persisted.
    const { rows: seen } = await store.query(`select last_seen_at from dde_provision_tokens where token_hash = $1`, [hashToken(b.token)]);
    assert.equal(seen[0].last_seen_at.toISOString(), new Date(T0).toISOString());
  } finally {
    await new Promise((r) => server.close(r));
    await tokenStore.close();
    await store.close();
  }
});
