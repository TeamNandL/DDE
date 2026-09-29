// Process Translator (Slice 15) on REAL Postgres — boots the store the
// production way (applyVaultSchema incl. vault/012_process_translator.sql).
// Skips (BLOCKED, not passed) without DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";
import { openTokenStore } from "../src/tokens.js";
import { LAWYER_LINE } from "../src/translator.js";

const url = databaseUrl();

test("PG process translator: explain paste + term → last/list; private_only candidates; no PII; no OFW", { skip: !url && "DATABASE_URL not set — BLOCKED" }, async () => {
  const store = await openStore({ databaseUrl: url });
  assert.equal(store.kind, "postgres");
  try {
    const tokenStore = await openTokenStore({ query: store.query });
    const bff = makeBff(store.vault, { tokenStore });
    const dad_id = randomUUID();
    await bff.postVaultProvision({ dad_id });

    const paste = await bff.postTranslateExplain({
      dad_id,
      text: "Alex Rivera SSN 123-45-6789. Notice of hearing: hearing set for October 14, 2026. Must respond within 20 days. Is this bad for me?",
    });
    assert.ok(paste.headline.startsWith(LAWYER_LINE));
    assert.ok(paste.term_keys.includes("hearing"));
    assert.equal(paste.clock_flag, true);
    assert.equal(paste.verdict_request, true);
    assert.deepEqual(
      paste.calendar_candidates.map((c) => [c.label, c.on_date, c.visibility, c.status, c.verified]),
      [["Hearing", "2026-10-14", "private_only", "candidate", false]],
    );
    assert.doesNotMatch(JSON.stringify(paste), /123-45-6789|\b20 days\b/);

    const term = await bff.postTranslateExplain({ dad_id, term: "retainer" });
    assert.equal(term.terms[0].kind, "lawyer");

    const last = await bff.getTranslateLast({ dad_id });
    assert.equal(last.id, term.id);
    assert.deepEqual(last.term_keys, ["retainer"]);
    assert.equal(last.lawyer_line, LAWYER_LINE);
    const { items } = await bff.getTranslateList({ dad_id });
    assert.deepEqual(items.map((i) => i.id), [term.id, paste.id]);

    const [row] = (await store.query(`select input_cold from translations where id = $1`, [paste.id])).rows;
    assert.doesNotMatch(row.input_cold, /123-45-6789/);

    // DB rail: visibility can't be anything but private_only.
    await assert.rejects(
      store.query(
        `insert into translator_calendar_candidates (id, dad_id, translation_id, label, date_text, visibility)
         values ($1, $2, $3, 'x', 'x', 'ofw')`,
        [randomUUID(), dad_id, paste.id],
      ),
      /check/i,
    );

    assert.equal((await store.vault.listEvents(dad_id)).length, 0, "never an intake event");
    assert.equal((await bff.getVaultExportVerified({ dad_id })).length, 0);
    const [ofw] = (await store.query(`select count(*)::int as n from communications where dad_id = $1`, [dad_id])).rows;
    assert.equal(ofw.n, 0, "never OFW");
  } finally {
    await store.close();
  }
});
