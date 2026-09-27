// Slice 20 — token lifecycle on REAL Postgres. Skips (BLOCKED, not passed)
// without DATABASE_URL.
//   1. Upgrade: a pre-Slice-20 dde_provision_tokens (no expires_at) gains the
//      column on open; its old rows expire at created_at + TTL.
//   2. Logout / revoke run on the owner token table while the request is
//      bound to dde_app (RLS) — and still refuse cross-dad.

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

test("PG upgrade: old token table gains expires_at; legacy rows expire at created_at + TTL", { skip }, async () => {
  const { default: pg } = await import("pg");
  const schema = `slice20_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    await pool.query(`create table dde_provision_tokens (
      token_hash text primary key, dad_id uuid not null,
      created_at timestamptz not null default now(), revoked_at timestamptz)`);
    const dad = randomUUID();
    await pool.query(
      `insert into dde_provision_tokens (token_hash, dad_id, created_at) values ($1, $2, $3), ($4, $2, $5)`,
      [hashToken("old"), dad, new Date(T0 - 31 * DAY).toISOString(), hashToken("recent"), new Date(T0 - DAY).toISOString()],
    );

    const store = await openTokenStore({ query: (sql, p) => pool.query(sql, p) });
    const { rows } = await pool.query(
      `select 1 from information_schema.columns
        where table_schema = $1 and table_name = 'dde_provision_tokens' and column_name = 'expires_at'`,
      [schema],
    );
    assert.equal(rows.length, 1, "expires_at added");

    const vault = { getState: async (id) => (id === dad ? { dad_id: id } : null) };
    const bff = makeBff(vault, { tokenStore: store, now: T0 });
    await assert.rejects(() => bff.checkToken(dad, "old"), (e) => e.status === 401 && e.message === "token expired");
    assert.equal(await bff.checkToken(dad, "recent"), true);

    const minted = await bff.mintToken({ dad_id: dad });
    const row = await store.lookupActive(hashToken(minted.token));
    assert.equal(row.expires_at, minted.expires_at);
    assert.equal(await store.revokeAllForDad(dad), 3);
    assert.equal(await store.revokeAllForDad(dad), 0);
  } finally {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  }
});

test("PG logout / revoke through the RLS-bound request", { skip }, async () => {
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

    assert.equal((await jsonReq(base, "POST", "/vault/token/revoke", { dad_id: b.dad_id }, { token: a.token })).status, 403);

    const out = await jsonReq(base, "POST", "/vault/logout", { dad_id: a.dad_id }, { token: a.token });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal((await state(a.dad_id, a.token)).status, 401);
    assert.equal((await state(a.dad_id, t2)).status, 200);

    const rv = await jsonReq(base, "POST", "/vault/token/revoke", { dad_id: a.dad_id }, { token: t2 });
    assert.deepEqual([rv.status, rv.data], [200, { revoked: 1 }]);
    assert.equal((await state(a.dad_id, t2)).status, 401);
    assert.equal((await state(b.dad_id, b.token)).status, 200, "B untouched");

    const { rows } = await store.query(
      `select count(*)::int as live from dde_provision_tokens where dad_id = $1 and revoked_at is null`,
      [a.dad_id],
    );
    assert.equal(rows[0].live, 0);
  } finally {
    await new Promise((r) => server.close(r));
    await tokenStore.close();
    await store.close();
  }
});
