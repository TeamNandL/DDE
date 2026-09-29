// Slice 23 — evidence hash log on REAL Postgres.
// Skips (BLOCKED, not passed) without DATABASE_URL.
// Schema boot includes vault/017_evidence.sql. Checks block promotion.
// verified_export stays empty. RLS refuses a cross-dad insert.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";
import { openTokenStore } from "../src/tokens.js";
import { runAsDad } from "../src/scope.js";

const url = databaseUrl();
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("PG evidence: log, idempotent dup, RLS, checks block promotion, verified_export empty", { skip: !url && "DATABASE_URL not set — BLOCKED" }, async () => {
  const store = await openStore({ databaseUrl: url });
  assert.equal(store.kind, "postgres");
  try {
    const tokenStore = await openTokenStore({ query: store.query });
    const bff = makeBff(store.vault, { tokenStore });
    const dad_id = randomUUID();
    const other = randomUUID();
    await bff.postVaultProvision({ dad_id });
    await bff.postVaultProvision({ dad_id: other });

    const hash = sha("pg-synthetic");
    const first = await bff.postEvidenceLog({
      dad_id,
      hash,
      original_filename: "march-statement.pdf",
      format: "pdf",
    });
    assert.equal(first.stage, "logged");
    assert.equal(first.routing, "inbox_unmapped");
    assert.equal(first.schema_version, 1);
    assert.equal(first.doc_type_guess, "statement");
    assert.equal(first.doc_type_confidence, "low");
    assert.equal(first.needs_ocr, false);
    assert.equal(first.verified, false);
    assert.equal(first.duplicate, false);

    const again = await bff.postEvidenceLog({
      dad_id,
      hash,
      original_filename: "renamed.pdf",
      possession: "not located",
    });
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
    assert.equal(again.original_filename, "march-statement.pdf");

    const otherHash = await bff.postEvidenceLog({ dad_id: other, hash });
    assert.equal(otherHash.duplicate, false);
    assert.notEqual(otherHash.id, first.id);

    const inbox = await bff.getEvidenceInbox({ dad_id });
    assert.equal(inbox.routing, "inbox_unmapped");
    assert.deepEqual(inbox.items.map((r) => r.id), [first.id]);

    const { rows: cols } = await store.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'evidence'`,
    );
    const names = cols.map((c) => c.column_name);
    assert.ok(names.includes("schema_version"));
    assert.ok(names.includes("needs_ocr"));
    assert.equal(names.includes("bytes"), false);
    assert.equal(names.includes("storage_uri"), false);
    assert.equal(names.includes("raw_quote"), false);

    await assert.rejects(
      store.query(`update evidence set stage = 'verified' where id = $1`, [first.id]),
      /check/i,
    );
    await assert.rejects(
      store.query(`update evidence set doc_type_confidence = 'high' where id = $1`, [first.id]),
      /check/i,
    );
    await assert.rejects(
      store.query(`update evidence set routing = 'exhibit' where id = $1`, [first.id]),
      /check/i,
    );
    await assert.rejects(
      store.query(`update evidence set needs_ocr = true where id = $1`, [first.id]),
      /check/i,
    );

    const verified = await bff.getVaultExportVerified({ dad_id });
    assert.equal(verified.length, 0, "evidence never reaches verified_export");
    const { rows: docs } = await store.query(`select count(*)::int as n from documents where dad_id = $1`, [dad_id]);
    assert.equal(docs[0].n, 0, "evidence log does not insert documents");
    const { rows: events } = await store.query(`select count(*)::int as n from events where dad_id = $1`, [dad_id]);
    assert.equal(events[0].n, 0, "evidence log is not an intake");

    await assert.rejects(
      runAsDad(dad_id, () =>
        store.exec(
          `insert into evidence (id, dad_id, hash, possession)
           values ('${randomUUID()}', '${other}', '${sha("cross")}', 'held');`,
        ),
      ),
      /row-level security/,
      "INSERT must match the bound dad",
    );
    const seen = await runAsDad(dad_id, () => store.exec(`select dad_id from evidence;`));
    assert.deepEqual(
      [...new Set(seen.map((r) => r.dad_id))],
      [dad_id],
      "dde_app sees only the bound dad",
    );
  } finally {
    await store.close();
  }
});
