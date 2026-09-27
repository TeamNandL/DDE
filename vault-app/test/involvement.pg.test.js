// Involvement Cheat Sheet (Slice 16) on REAL Postgres — boots the store the
// production way (applyVaultSchema incl. vault/013_involvement.sql).
// Skips (BLOCKED, not passed) without DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";
import { openTokenStore } from "../src/tokens.js";
import { CLAIM_FOOTER } from "../src/involvement.js";

const url = databaseUrl();

test("PG involvement: ensure → value + ask → one Missing/Next → export with pattern + claim footer", { skip: !url && "DATABASE_URL not set — BLOCKED" }, async () => {
  const store = await openStore({ databaseUrl: url });
  assert.equal(store.kind, "postgres");
  try {
    const tokenStore = await openTokenStore({ query: store.query });
    const bff = makeBff(store.vault, { tokenStore, now: Date.parse("2026-09-27T12:00:00Z") });
    const dad_id = randomUUID();
    await bff.postVaultProvision({ dad_id });

    assert.equal((await bff.postInvolvementEnsure({ dad_id, kid: "sam" })).created, 10);
    assert.equal((await bff.postInvolvementEnsure({ dad_id, kid: "sam" })).created, 0);

    const t = await bff.postInvolvementField({ dad_id, kid: "sam", field: "grade", value: "3rd, SSN 123-45-6789" });
    assert.equal(t.field.status, "filled");
    assert.doesNotMatch(t.field.value, /123-45-6789/);
    const a = await bff.postInvolvementField({
      dad_id, kid: "sam", field: "teacher", asked_on: "2026-09-10", asked_via: "co_parent", outcome: "no_answer",
    });
    assert.equal(a.field.status, "asked");
    assert.equal(a.field.asked_on, "2026-09-10");

    const n = await bff.getInvolvementNext({ dad_id });
    assert.equal(n.missing.field, "activities", "never-asked blank before the asked one");
    assert.equal(n.next.job, "re_engagement");

    const exp = await bff.getInvolvementExport({ dad_id, kid: "sam" });
    assert.match(exp.body, /Grade: 3rd, SSN \[tax-id\]/);
    assert.match(exp.body, /- Teacher: asked the other parent on 2026-09-10; no answer as of 2026-09-27\./);
    assert.ok(exp.body.endsWith(CLAIM_FOOTER));

    // DB rails: claim-only, finite fields, slug kid labels.
    await assert.rejects(
      store.query(`update involvement_fields set claim_status = 'verified' where dad_id = $1`, [dad_id]),
      /check/i,
    );
    await assert.rejects(
      store.query(
        `insert into involvement_fields (dad_id, kid_key, field_key, position) values ($1, 'sam', 'ssn', 99)`,
        [dad_id],
      ),
      /check/i,
    );
    await assert.rejects(
      store.query(
        `insert into involvement_fields (dad_id, kid_key, field_key, position) values ($1, 'Sam Rivera', 'grade', 1)`,
        [dad_id],
      ),
      /check/i,
    );

    assert.equal((await store.vault.listEvents(dad_id)).length, 0);
    assert.equal((await bff.getVaultExportVerified({ dad_id })).length, 0);
    const [ofw] = (await store.query(`select count(*)::int as n from communications where dad_id = $1`, [dad_id])).rows;
    assert.equal(ofw.n, 0, "never OFW");
  } finally {
    await store.close();
  }
});
