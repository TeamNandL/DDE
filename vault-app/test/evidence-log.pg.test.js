// Slice 23 — evidence capture skeleton on REAL Postgres. Boots the store the
// production way (applyVaultSchema incl. vault/017_evidence.sql). Fake dads
// only (fresh UUIDs). Skips (BLOCKED, not passed) without DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";
import { openTokenStore } from "../src/tokens.js";

const url = databaseUrl();
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("PG evidence: hash-log → inbox_unmapped row; CHECKs pin stage/routing/confidence/claim/version; unique per dad; RLS on; Exhibit empty", { skip: !url && "DATABASE_URL not set — BLOCKED" }, async () => {
  const store = await openStore({ databaseUrl: url });
  assert.equal(store.kind, "postgres");
  try {
    const tokenStore = await openTokenStore({ query: store.query });
    const bff = makeBff(store.vault, { tokenStore, now: Date.parse("2026-09-28T23:30:00Z") });
    const dad_id = randomUUID();
    await bff.postVaultProvision({ dad_id });

    const hex = sha("pg-statement");
    const r = await bff.postEvidenceLog({ dad_id, sha256: hex.toUpperCase(), filename: "Chase statement acct 123456789012.pdf", mime: "application/pdf" });
    assert.equal(r.stage, "logged");
    assert.equal(r.routing, "inbox_unmapped");
    assert.equal(r.confidence, "low");
    assert.equal(r.kind_guess, "statement");
    assert.equal(r.needs_ocr, false);
    assert.equal(r.schema_version, 1);
    assert.equal(r.duplicate, false);

    const again = await bff.postEvidenceLog({ dad_id, sha256: hex, filename: "renamed.pdf" });
    assert.equal(again.duplicate, true);
    assert.equal(again.id, r.id);

    const { rows } = await store.query(`select * from evidence where dad_id = $1`, [dad_id]);
    assert.equal(rows.length, 1, "one row, no second write on duplicate");
    const row = rows[0];
    assert.equal(row.sha256, hex);
    assert.equal(row.claim_status, "claim");
    assert.doesNotMatch(row.filename, /123456789012/);
    for (const k of ["storage_uri", "bytes", "page_range", "evidence_requirement_link", "ocr_text"]) {
      assert.ok(!(k in row), `${k} column is deferred — does not exist`);
    }

    // DB rails: the pins are CHECKs, not conventions.
    const rej = (sql, params) => assert.rejects(store.query(sql, params), /check|unique|duplicate/i);
    await rej(`update evidence set stage = 'filed' where id = $1`, [r.id]);
    await rej(`update evidence set routing = 'mapped' where id = $1`, [r.id]);
    await rej(`update evidence set confidence = 'high' where id = $1`, [r.id]);
    await rej(`update evidence set claim_status = 'verified' where id = $1`, [r.id]);
    await rej(`update evidence set schema_version = 2 where id = $1`, [r.id]);
    await rej(`update evidence set kind_guess = 'ofw_export' where id = $1`, [r.id]);
    await rej(`insert into evidence (id, dad_id, sha256, kind_guess) values ($1, $2, 'nothex', 'other')`, [randomUUID(), dad_id]);
    await rej(`insert into evidence (id, dad_id, sha256, kind_guess) values ($1, $2, $3, 'other')`, [randomUUID(), dad_id, hex]);

    // Another dad may hold the same hash (uniqueness is per dad).
    const other = randomUUID();
    await bff.postVaultProvision({ dad_id: other });
    assert.equal((await bff.postEvidenceLog({ dad_id: other, sha256: hex })).duplicate, false);

    // RLS: on, one policy, dde_app only (015 shape).
    const { rows: pol } = await store.query(
      `select c.relrowsecurity, array_agg(p.polname::text) as policies
         from pg_class c left join pg_policy p on p.polrelid = c.oid
        where c.relname = 'evidence' group by c.relrowsecurity`,
    );
    assert.equal(pol[0].relrowsecurity, true);
    assert.deepEqual(pol[0].policies, ["dde_own_rows"]);

    // Exhibit = verified-only: nothing from evidence, and documents untouched.
    assert.equal((await bff.getVaultExportVerified({ dad_id })).length, 0);
    const [{ n: docs }] = (await store.query(`select count(*)::int as n from documents where dad_id = $1`, [dad_id])).rows;
    assert.equal(docs, 0, "documents table not extended, not written");
    const [{ n: ev }] = (await store.query(`select count(*)::int as n from events where dad_id = $1`, [dad_id])).rows;
    assert.equal(ev, 0, "not Quill — no intake event");
    const { rows: cols } = await store.query(
      `select column_name from information_schema.columns where table_name = 'documents' order by ordinal_position`,
    );
    assert.ok(!cols.some((c) => /sha256|stage|routing|needs_ocr|schema_version/.test(c.column_name)), "documents schema unchanged");
  } finally {
    await store.close();
  }
});
