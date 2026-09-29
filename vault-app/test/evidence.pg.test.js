// Slice 23 — evidence skeleton on REAL Postgres.
// Skips (BLOCKED, not passed) without DATABASE_URL.
// Unique (dad_id, sha256), stage/routing/low-conf checks, RLS, no bytes,
// documents untouched. Synthetic dads only.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";
import { openTokenStore } from "../src/tokens.js";
import { runAsDad } from "../src/scope.js";

const url = databaseUrl();
const skip = !url && "DATABASE_URL not set — BLOCKED";
const HASH = "ab".repeat(32);

test("PG evidence log: unique dad+hash, checks, RLS, no bytes, documents untouched; after log, verified_export empty for those rows", { skip }, async () => {
  const store = await openStore({ databaseUrl: url });
  assert.equal(store.kind, "postgres");
  try {
    const tokenStore = await openTokenStore({ query: store.query });
    const bff = makeBff(store.vault, { tokenStore });
    const a = randomUUID();
    const b = randomUUID();
    await bff.postVaultProvision({ dad_id: a });
    await bff.postVaultProvision({ dad_id: b });

    const cols = await store.query(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'evidence_log'`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r.data_type]));
    assert.equal(byName.sha256, "text");
    assert.equal(byName.schema_version, "integer");
    assert.equal(byName.possession, "text");
    assert.equal(byName.bytes, undefined);
    assert.ok(!Object.values(byName).includes("bytea"), "no bytea column");

    const docCols = await store.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'documents'`,
    );
    const docNames = docCols.rows.map((r) => r.column_name);
    for (const col of ["id", "dad_id", "pipe", "doc_type", "storage_uri", "extracted"]) {
      assert.ok(docNames.includes(col), `documents.${col} still present`);
    }
    assert.ok(!docNames.includes("sha256") && !docNames.includes("filename_guess"), "documents schema unchanged");

    const first = await bff.postEvidenceLog({ dad_id: a, sha256: HASH, filename: "scans/IMG_2044.jpg" });
    assert.equal(first.created, true);
    assert.equal(first.stage, "logged");
    assert.equal(first.routing, "inbox_unmapped");
    assert.equal(first.filename_guess, "IMG_2044.jpg");
    assert.equal(first.filename_confidence, "low");
    assert.equal(first.schema_version, 1, "schema_version set on create");
    assert.equal(first.possession, "held");

    const dup = await bff.postEvidenceLog({ dad_id: a, hash: HASH, filename: "renamed.pdf" });
    assert.equal(dup.created, false);
    assert.equal(dup.id, first.id);
    assert.equal(dup.filename_guess, "IMG_2044.jpg");

    const other = await bff.postEvidenceLog({ dad_id: b, sha256: HASH });
    assert.equal(other.created, true);
    assert.notEqual(other.id, first.id);

    const inbox = await bff.getEvidenceInbox({ dad_id: a });
    assert.deepEqual(inbox.items.map((i) => i.sha256), [HASH]);

    await bff.postVaultIntake({ dad_id: a, text: "They cancelled my visit with the kids this Friday." });
    const afterVent = await store.query(`select count(*)::int as n from evidence_log where dad_id = $1`, [a]);
    assert.equal(afterVent.rows[0].n, 1, "vent does not add an evidence row");
    const docs = await store.query(`select count(*)::int as n from documents where dad_id = $1`, [a]);
    assert.equal(docs.rows[0].n, 0, "evidence log does not write documents");

    await assert.rejects(
      store.query(
        `insert into evidence_log (id, dad_id, sha256) values ($1, $2, $3)`,
        [randomUUID(), a, HASH],
      ),
      /duplicate key|unique/i,
    );
    await assert.rejects(
      store.query(`update evidence_log set stage = 'verified' where id = $1`, [first.id]),
      /check/i,
    );
    await assert.rejects(
      store.query(`update evidence_log set routing = 'mapped' where id = $1`, [first.id]),
      /check/i,
    );
    await assert.rejects(
      store.query(`update evidence_log set filename_confidence = 'high' where id = $1`, [first.id]),
      /check/i,
    );
    await assert.rejects(
      store.query(`update evidence_log set schema_version = 2 where id = $1`, [first.id]),
      /check/i,
    );
    await assert.rejects(
      store.query(`update evidence_log set possession = 'vault' where id = $1`, [first.id]),
      /check/i,
    );

    const verified = await store.query(
      `select source_table, row::text as row from verified_export where dad_id = $1`,
      [a],
    );
    assert.equal(verified.rows.length, 0, "after log, verified_export empty for those rows");
    assert.ok(!verified.rows.some((r) => String(r.row).includes(HASH) || r.source_table === "evidence_log"));
    const viewdef = await store.query(`select pg_get_viewdef('verified_export'::regclass) as def`);
    assert.doesNotMatch(viewdef.rows[0].def, /evidence_log/);

    await runAsDad(a, async () => {
      const mine = await store.vault.listEvidenceInbox(b);
      assert.deepEqual(mine, [], "RLS hides the other dad's inbox");
      await assert.rejects(
        store.vault.logEvidence(b, {
          sha256: "ef".repeat(32),
          stage: "logged",
          routing: "inbox_unmapped",
          filename_guess: null,
          filename_confidence: null,
        }),
        /row-level security/,
      );
    });
  } finally {
    await store.close();
  }
});
