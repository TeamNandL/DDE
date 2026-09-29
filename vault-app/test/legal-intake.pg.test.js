// Legal Intake seat (Slice 17) on REAL Postgres — boots the store the
// production way (applyVaultSchema incl. vault/014_legal_intake.sql).
// Skips (BLOCKED, not passed) without DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";
import { openTokenStore } from "../src/tokens.js";
import { DRAFT_FOOTER, LAWYER_LINE } from "../src/legalintake.js";

const url = databaseUrl();

test("PG legal intake: capture → flags → handoff drafts (sent_at locked null) → get", { skip: !url && "DATABASE_URL not set — BLOCKED" }, async () => {
  const store = await openStore({ databaseUrl: url });
  assert.equal(store.kind, "postgres");
  try {
    const tokenStore = await openTokenStore({ query: store.query });
    const bff = makeBff(store.vault, { tokenStore, now: Date.parse("2026-09-27T12:00:00Z") });
    const dad_id = randomUUID();
    await bff.postVaultProvision({ dad_id });

    const i = await bff.postLegalIntake({
      dad_id,
      who: "co_parent",
      urgency: "this_week",
      what: "Jordan kept the kids and won't return them. Hearing on October 14. She wants $1,200. SSN 123-45-6789. Team N&L. What should I do?",
    });
    assert.deepEqual(i.flags, ["deadline_language", "custody_emergency", "money_numbers", "out_of_venture"]);
    assert.equal(i.human_review, true);
    assert.equal(i.route, "lawyer_handoff");
    assert.equal(i.lawyer_line, LAWYER_LINE);
    assert.doesNotMatch(i.what, /123-45-6789|1,200|N&L/);

    const h1 = await bff.postLegalHandoff({ dad_id });
    const h2 = await bff.postLegalHandoff({ dad_id, id: i.id });
    assert.deepEqual([h1.handoff.version, h2.handoff.version], [1, 2]);
    assert.ok(h2.handoff.body.endsWith(DRAFT_FOOTER));
    const got = await bff.getLegalIntake({ dad_id, id: i.id });
    assert.equal(got.handoff.version, 2);
    assert.equal(got.handoff.sent_at, null);

    const [row] = (await store.query(`select sent_at, what_cold from legal_handoff_drafts d
      join legal_intakes i on i.id = d.intake_id where d.id = $1`, [h2.handoff.id])).rows;
    assert.equal(row.sent_at, null);
    assert.doesNotMatch(row.what_cold, /123-45-6789/);

    // DB rails: draft can never be marked sent; flags + urgency are closed menus; claim only.
    await assert.rejects(
      store.query(`update legal_handoff_drafts set sent_at = now() where id = $1`, [h2.handoff.id]),
      /check/i,
    );
    await assert.rejects(
      store.query(`update legal_intakes set urgency = 'emergency' where id = $1`, [i.id]),
      /check/i,
    );
    await assert.rejects(
      store.query(`update legal_intakes set flags = array['strategy'] where id = $1`, [i.id]),
      /check/i,
    );
    await assert.rejects(
      store.query(`update legal_intakes set claim_status = 'verified' where id = $1`, [i.id]),
      /check/i,
    );

    const d = await bff.postLegalIntake({ dad_id, who: "court", urgency: "not_sure", what: "What does this motion mean?" });
    assert.equal(d.route, "process_translator");
    await assert.rejects(bff.postLegalHandoff({ dad_id, id: d.id }), (e) => e.status === 409);

    assert.equal((await store.vault.listEvents(dad_id)).length, 0, "not Quill");
    assert.equal((await bff.getVaultExportVerified({ dad_id })).length, 0);
    const [ofw] = (await store.query(`select count(*)::int as n from communications where dad_id = $1`, [dad_id])).rows;
    assert.equal(ofw.n, 0, "never OFW / Coach / send");
  } finally {
    await store.close();
  }
});
