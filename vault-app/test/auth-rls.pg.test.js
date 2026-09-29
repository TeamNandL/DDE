// Slice 18 — Auth + RLS proofs on REAL Postgres (vault/015_auth_rls.sql).
// Skips (BLOCKED, not passed) without DATABASE_URL.
//
//   1. RLS is enabled with the dde_own_rows policy on every dad-scoped table.
//   2. As dde_app bound to dad A: only A's rows are visible; inserting or
//      updating into dad B is rejected; unbound sees nothing.
//   3. Views run security_invoker; dde_app cannot touch the token table.
//   4. Scoped exec: an app-level bug asking for B's rows inside A's request
//      gets nothing, and a write for B is refused by the database.
//   5. Full HTTP auth matrix on every route runs through RLS: 401/403/401/200.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";
import { openTokenStore } from "../src/tokens.js";
import { createServer, listenServer } from "../src/server.js";
import { runAsDad } from "../src/scope.js";
import { authMatrix, jsonReq } from "./auth-cases.js";

const url = databaseUrl();
const skip = !url && "DATABASE_URL not set — BLOCKED";

export const DAD_TABLES = [
  "events", "communications", "documents", "state", "month_summary",
  "candidate_facts", "notifications", "plan_topics", "plan_drafts",
  "translations", "translator_calendar_candidates", "involvement_fields",
  "legal_intakes", "legal_handoff_drafts", "evidence_log",
];

async function open() {
  const store = await openStore({ databaseUrl: url });
  const tokenStore = await openTokenStore({ query: store.query });
  const bff = makeBff(store.vault, { tokenStore, now: Date.parse("2026-09-27T16:00:00Z") });
  return { store, bff };
}

// Run statements as dde_app bound to `dad` (or unbound) in one transaction.
async function asApp(store, dad, sql, params = []) {
  const client = await (async () => {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    return c;
  })();
  try {
    await client.query("begin");
    await client.query("set local role dde_app");
    if (dad) await client.query("select set_config('dde.dad_id', $1, true)", [dad]);
    return await client.query(sql, params);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

test("PG RLS: every dad-scoped table has RLS on + dde_own_rows policy for dde_app only", { skip }, async () => {
  const { store } = await open();
  try {
    const { rows } = await store.query(
      `select c.relname, c.relrowsecurity,
              (select array_agg(p.polname::text) from pg_policy p where p.polrelid = c.oid) as policies,
              (select array_agg(r.rolname::text) from pg_policy p join pg_roles r on r.oid = any(p.polroles)
                 where p.polrelid = c.oid) as roles
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.relname, r]));
    for (const t of DAD_TABLES) {
      assert.ok(byName[t], `${t} exists`);
      assert.equal(byName[t].relrowsecurity, true, `${t} RLS enabled`);
      assert.deepEqual(byName[t].policies, ["dde_own_rows"], `${t} policy`);
      assert.deepEqual(byName[t].roles, ["dde_app"], `${t} policy applies to dde_app`);
    }
    // Every table that carries dad_id is covered (nothing dad-scoped left open).
    const { rows: withDad } = await store.query(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'dad_id'
          and table_name in (select tablename from pg_tables where schemaname = 'public')`,
    );
    // Owner-only ledgers (tokens, export receipts, deletions) are exempt ONLY
    // when dde_app truly has no privilege on them — asserted, not assumed.
    const OWNER_ONLY = ["dde_provision_tokens", "dde_export_receipts", "dde_deletions"];
    for (const { table_name } of withDad) {
      if (OWNER_ONLY.includes(table_name)) {
        const { rows: priv } = await store.query(
          `select bool_or(has_table_privilege('dde_app', $1, p)) as any
             from unnest(array['SELECT','INSERT','UPDATE','DELETE']) as p`,
          [table_name],
        );
        assert.equal(priv[0].any, false, `${table_name} is owner-only (dde_app has no privilege)`);
        continue;
      }
      assert.ok(DAD_TABLES.includes(table_name), `${table_name} has dad_id but no RLS policy`);
    }
    const { rows: views } = await store.query(
      `select relname, reloptions from pg_class where relname in ('verified_export','affidavit_support')`,
    );
    for (const v of views) assert.ok((v.reloptions ?? []).includes("security_invoker=true"), `${v.relname} security_invoker`);
  } finally {
    await store.close();
  }
});

test("PG RLS: dde_app sees only its dad; cross-dad insert/update/delete refused; unbound sees nothing", { skip }, async () => {
  const { store, bff } = await open();
  try {
    const a = randomUUID();
    const b = randomUUID();
    await bff.postVaultProvision({ dad_id: a });
    await bff.postVaultProvision({ dad_id: b });
    for (const d of [a, b]) {
      await bff.postVaultIntake({ dad_id: d, text: "They cancelled my visit with the kids this Friday." });
      await bff.postLegalIntake({ dad_id: d, who: "school", what: "Report card came home.", urgency: "this_month" });
      await bff.postInvolvementField({ dad_id: d, kid: "sam", field: "grade", value: "3rd" });
    }

    for (const t of ["events", "state", "legal_intakes", "involvement_fields"]) {
      const mine = await asApp(store, a, `select distinct dad_id from ${t}`);
      assert.deepEqual(mine.rows.map((r) => r.dad_id), [a], `${t}: only dad A visible`);
      const none = await asApp(store, null, `select count(*)::int as n from ${t}`);
      assert.equal(none.rows[0].n, 0, `${t}: unbound dde_app sees nothing`);
    }
    const ve = await asApp(store, a, `select distinct dad_id from verified_export`);
    assert.ok(ve.rows.every((r) => r.dad_id === a), "view inherits RLS");

    await assert.rejects(
      asApp(store, a, `insert into legal_intakes (id, dad_id, who, what_cold, urgency, route)
                       values ($1, $2, 'school', 'x', 'not_sure', 'lawyer_handoff')`, [randomUUID(), b]),
      /row-level security/,
      "INSERT must match the bound dad",
    );
    const upd = await asApp(store, a, `update events set noticed_at = now() where dad_id = $1`, [b]);
    assert.equal(upd.rowCount, 0, "cannot update another dad's rows");
    const del = await asApp(store, a, `delete from involvement_fields where dad_id = $1`, [b]);
    assert.equal(del.rowCount, 0, "cannot delete another dad's rows");
    await assert.rejects(
      asApp(store, a, `update state set dad_id = $1 where dad_id = $2`, [b, a]),
      /row-level security/,
      "cannot move a row to another dad",
    );
    await assert.rejects(asApp(store, a, `select * from dde_provision_tokens`), /permission denied/);

    // Owner (service role) still sees both — it is never handed to Chip.
    const owner = await store.query(`select count(distinct dad_id)::int as n from state where dad_id = any($1)`, [[a, b]]);
    assert.equal(owner.rows[0].n, 2);
  } finally {
    await store.close();
  }
});

test("PG scoped exec: an app bug asking for dad B inside dad A's request gets nothing; writes for B refused", { skip }, async () => {
  const { store, bff } = await open();
  try {
    const a = randomUUID();
    const b = randomUUID();
    await bff.postVaultProvision({ dad_id: a });
    await bff.postVaultProvision({ dad_id: b });
    await bff.postVaultIntake({ dad_id: b, text: "They cancelled my visit with the kids this Friday." });
    assert.ok((await store.vault.listEvents(b)).length > 0, "owner sees B's events");

    await runAsDad(a, async () => {
      assert.deepEqual(await store.vault.listEvents(b), [], "RLS hides B inside A's scope");
      assert.equal(await store.vault.getState(b), null);
      await assert.rejects(
        store.vault.insertLegalIntake(b, { who: "school", what_cold: "x", urgency: "not_sure", flags: [], route: "lawyer_handoff" }),
        /row-level security/,
      );
      const [who] = await store.exec("select current_user as u, dde_current_dad() as d");
      assert.deepEqual(who, { u: "dde_app", d: a });
    });
    const [after] = await store.exec("select current_user as u");
    assert.notEqual(after.u, "dde_app", "scope resets after the request");
  } finally {
    await store.close();
  }
});

test("PG auth matrix through RLS: every route 401 none/bad · 403 cross · 401 unknown (F1) · 200 own", { skip }, async () => {
  const { store, bff } = await open();
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const a = (await jsonReq(base, "POST", "/vault/provision", {})).data;
    const b = (await jsonReq(base, "POST", "/vault/provision", {})).data;
    const mint = async (id) => (await bff.mintToken({ dad_id: id })).token;
    const rows = await authMatrix(base, a, b, randomUUID(), mint);
    assert.equal(rows.length, 45);
    for (const r of rows) {
      assert.deepEqual(
        [r.none, r.bad, r.cross, r.unknown, r.own],
        [401, 401, 403, 401, 200],
        `${r.route}: ${JSON.stringify(r.error)}`,
      );
    }
    // Every row the own-token requests wrote belongs to dad A (WITH CHECK held).
    for (const t of ["events", "communications", "plan_topics", "translations", "involvement_fields", "legal_handoff_drafts", "evidence_log"]) {
      const { rows: bad } = await store.query(`select count(*)::int as n from ${t} where dad_id = $1`, [b.dad_id]);
      assert.equal(bad[0].n, 0, `${t}: nothing written for dad B`);
    }
    const drafts = await store.query(`select count(*)::int as n from legal_handoff_drafts where sent_at is not null`);
    assert.equal(drafts.rows[0].n, 0, "draft ≠ send still holds");
  } finally {
    await new Promise((r) => server.close(r));
    await store.close();
  }
});
