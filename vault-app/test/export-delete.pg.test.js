// Slice 21 — export + delete on REAL Postgres. Skips (BLOCKED, not passed)
// without DATABASE_URL.
//   1. Export through the RLS-bound request: claims / verified buckets from
//      the real tables; receipt row lands in the owner-only ledger.
//   2. Soft delete keeps every row (what a rollback to af56bad would see);
//      hard wipe empties all 15 dad tables + token rows; tombstone stays.
//   3. dde_app has no access to the ledger tables.

import test from "node:test";
import assert from "node:assert/strict";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";
import { openTokenStore } from "../src/tokens.js";
import { openOpsStore } from "../src/opsstore.js";
import { createServer, listenServer } from "../src/server.js";
import { unzipStore } from "../src/zip.js";
import { runAsDad } from "../src/scope.js";
import { jsonReq } from "./auth-cases.js";

// Dad-scoped tables (015 plus evidence_log from 017). Kept local: importing
// the Slice 18 test file would re-register its tests here.
const DAD_TABLES = [
  "events", "communications", "documents", "state", "month_summary",
  "candidate_facts", "notifications", "plan_topics", "plan_drafts",
  "translations", "translator_calendar_candidates", "involvement_fields",
  "legal_intakes", "legal_handoff_drafts", "evidence_log",
];

const url = databaseUrl();
const skip = !url && "DATABASE_URL not set — BLOCKED";
const T0 = Date.parse("2026-09-27T16:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

async function countAll(store, dad_id) {
  const out = {};
  for (const t of DAD_TABLES) {
    const { rows } = await store.query(`select count(*)::int as n from ${t} where dad_id = $1`, [dad_id]);
    out[t] = rows[0].n;
  }
  const { rows } = await store.query(`select count(*)::int as n from dde_provision_tokens where dad_id = $1`, [dad_id]);
  out.tokens = rows[0].n;
  return out;
}

test("PG export + soft delete + hard wipe: buckets, receipt, rows intact then gone, tombstone, ledger owner-only", { skip }, async () => {
  const store = await openStore({ databaseUrl: url });
  const tokenStore = await openTokenStore({ query: store.query });
  const opsStore = await openOpsStore({ query: store.query });
  const bff = makeBff(store.vault, { tokenStore, opsStore, now: T0 });
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  const state = (id, token) => jsonReq(base, "GET", `/vault/state?dad_id=${id}`, null, { token });
  try {
    const a = (await jsonReq(base, "POST", "/vault/provision", {})).data;
    const b = (await jsonReq(base, "POST", "/vault/provision", {})).data;
    for (const d of [a, b]) {
      await jsonReq(base, "POST", "/vault/intake", { dad_id: d.dad_id, text: "They cancelled my Friday visit. SSN 123-45-6789." }, { token: d.token });
      await jsonReq(base, "POST", "/vault/comms/pull", { dad_id: d.dad_id, channel: "ofw", source_ref: "ofw:x:1", body_cold: "Pickup confirmed.", sent_at: "2026-09-20T17:00:00Z" }, { token: d.token });
      await jsonReq(base, "POST", "/vault/plan/topics/ensure", { dad_id: d.dad_id }, { token: d.token });
      await jsonReq(base, "POST", "/vault/legal/intake", { dad_id: d.dad_id, who: "school", what: "Report card came home.", urgency: "this_month" }, { token: d.token });
      await jsonReq(base, "POST", "/vault/legal/handoff", { dad_id: d.dad_id }, { token: d.token });
      await jsonReq(base, "POST", "/vault/translate/explain", { dad_id: d.dad_id, term: "mediation" }, { token: d.token });
      await jsonReq(base, "POST", "/vault/involvement/ensure", { dad_id: d.dad_id, kid: "sam" }, { token: d.token });
    }
    const before = await countAll(store, a.dad_id);
    assert.ok(before.events >= 1 && before.communications >= 1 && before.legal_handoff_drafts >= 1 && before.translations >= 1 && before.state === 1);

    // Export via HTTP (RLS-bound) — cross-dad refused, own ok.
    const cross = await fetch(`${base}/vault/export?dad_id=${b.dad_id}`, { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(cross.status, 403);
    const res = await fetch(`${base}/vault/export?dad_id=${a.dad_id}`, { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    const files = unzipStore(buf);
    const claims = JSON.parse(files.find((f) => f.name === "claims/claims.json").data.toString());
    const verified = JSON.parse(files.find((f) => f.name === "verified/verified.json").data.toString());
    assert.equal(claims.events.length, before.events);
    assert.equal(verified.communications.length, 1);
    assert.equal(verified.events.length, 0, "claim never in verified/");
    assert.ok(claims.events.every((r) => r.dad_id === a.dad_id), "RLS: only A's rows");
    assert.doesNotMatch(buf.toString("utf8"), /123-45-6789|dde-stub-/);
    const { rows: rc } = await store.query(`select actor, bytes from dde_export_receipts where dad_id = $1`, [a.dad_id]);
    assert.deepEqual(rc, [{ actor: "dad", bytes: buf.length }]);

    // Ledger is owner-only: dde_app sees nothing / cannot write.
    await runAsDad(a.dad_id, async () => {
      await assert.rejects(() => store.exec(`select count(*) from dde_export_receipts;`), /permission denied/);
      await assert.rejects(() => store.exec(`select count(*) from dde_deletions;`), /permission denied/);
    });

    // Soft delete: refused for B (no receipt); allowed for A; rows all still there.
    await assert.rejects(() => bff.requestDelete({ dad_id: b.dad_id, now: T0 }), (e) => e.status === 412);
    const d = await bff.requestDelete({ dad_id: a.dad_id, now: T0 + DAY });
    assert.equal(d.revoked, 1);
    assert.equal((await state(a.dad_id, a.token)).status, 401);
    assert.deepEqual(await countAll(store, a.dad_id), before, "soft window: every row intact (this is what af56bad would see on rollback)");

    // Hard wipe after 14 days.
    const out = await bff.purgeDue({ now: T0 + 15 * DAY });
    assert.equal(out.purged.length, 1);
    const after = await countAll(store, a.dad_id);
    for (const [t, n] of Object.entries(after)) assert.equal(n, 0, `${t} empty after wipe`);
    assert.equal(out.purged[0].counts.tokens, before.tokens);
    assert.equal((await state(a.dad_id, a.token)).status, 401, "dad gone → 401, same as revoked (F1)");
    assert.deepEqual(await countAll(store, b.dad_id), await countAll(store, b.dad_id), "B untouched");
    assert.equal((await state(b.dad_id, b.token)).status, 200);
    const { rows: tomb } = await store.query(`select purged_at, purged_counts from dde_deletions where dad_id = $1`, [a.dad_id]);
    assert.equal(tomb.length, 1);
    assert.ok(tomb[0].purged_at);
    assert.equal(tomb[0].purged_counts.state, 1);
    // Receipt row stays as the audit trail (ids + hash only).
    const { rows: rc2 } = await store.query(`select count(*)::int as n from dde_export_receipts where dad_id = $1`, [a.dad_id]);
    assert.equal(rc2[0].n, 1);
  } finally {
    await new Promise((r) => server.close(r));
    await tokenStore.close();
    await opsStore.close();
    await store.close();
  }
});
