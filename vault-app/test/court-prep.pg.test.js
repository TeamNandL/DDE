// Court-prep capture on REAL Postgres — boots the store the production way
// (applyVaultSchema incl. vault/010_court_prep.sql), then drives candidates,
// the OFW cross-check stub, and check-in notifications through SqlVault.
// Skips (BLOCKED, not passed) without DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";
import { openTokenStore } from "../src/tokens.js";

const url = databaseUrl();
const REF = new Date("2026-09-26T15:00:00Z");

test("PG court-prep: candidate → OFW conflict (OFW untouched) → check-ins idempotent + answered", { skip: !url && "DATABASE_URL not set — BLOCKED" }, async () => {
  const store = await openStore({ databaseUrl: url });
  assert.equal(store.kind, "postgres");
  try {
    const tokenStore = await openTokenStore({ query: store.query });
    const bff = makeBff(store.vault, { tokenStore });
    const dad_id = randomUUID();
    const other = randomUUID();
    await bff.postVaultProvision({ dad_id });
    await bff.postVaultProvision({ dad_id: other });

    await bff.postVaultTell(
      { dad_id, channel: "talk", story: "Jordan cancelled the visit yesterday. Call 904-555-1212." },
      { referenceDate: REF },
    );
    let { candidates } = await bff.getVaultCandidates({ dad_id });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].what, "cancelled");
    assert.equal(candidates[0].when_on, "2026-09-25", "date comes back as YYYY-MM-DD text");
    assert.equal(candidates[0].confidence, "low");
    assert.equal(candidates[0].status, "not_proof_yet");
    assert.doesNotMatch(JSON.stringify(candidates), /904-555-1212/);

    const body_cold = "Visit completed, pickup at 6.";
    await bff.postCommsPull({
      dad_id, channel: "ofw", source_ref: "ofw:pg:2026-09-25", body_cold, sent_at: "2026-09-25T18:00:00Z",
    });
    ({ candidates } = await bff.getVaultCandidates({ dad_id }));
    assert.equal(candidates[0].status, "conflict");
    assert.match(candidates[0].line, /OFW for 2026-09-25 shows they came\. Check before you rely on it\.$/);
    const [ofw] = await store.vault.listOfwPulls(dad_id);
    assert.equal(ofw.body_cold, body_cold, "OFW never auto-overwritten");

    // Sticky-note review persists (010 review column) and never changes status.
    const kept = await bff.postCandidateReview({ dad_id, id: candidates[0].id, review: "keep" });
    assert.equal(kept.review, "kept");
    assert.equal(kept.status, "conflict");
    await bff.postCandidateReview({ dad_id, id: candidates[0].id, review: "toss" });
    assert.equal((await bff.getVaultCandidates({ dad_id })).candidates.length, 0);
    assert.equal((await bff.getVaultCandidates({ dad_id, include_tossed: true })).candidates.length, 1);

    const verified = await bff.getVaultExportVerified({ dad_id });
    assert.equal(verified.length, 1, "candidates never reach verified_export");

    const first = await bff.postCheckinsEnsure({ dad_id, date: "2026-09-27", tz_offset_minutes: -240 });
    assert.equal(first.created, 2);
    const again = await bff.postCheckinsEnsure({ dad_id, date: "2026-09-27", tz_offset_minutes: -240 });
    assert.equal(again.created, 0);

    await bff.postVaultTell(
      { dad_id, channel: "text", story: "Time with my son tonight." },
      { referenceDate: new Date("2026-09-27T23:00:00Z"), now: "2026-09-27T23:00:00Z" },
    );
    const notes = await bff.getVaultNotifications({ dad_id }, { now: "2026-09-27T23:30:00Z" });
    assert.deepEqual(notes.items.map((i) => [i.slot, i.status]), [["morning", "missed"], ["evening", "done"]]);

    await assert.rejects(
      bff.postNotificationMark({ dad_id: other, id: notes.items[0].id, status: "done" }),
      (err) => err.status === 404,
      "another dad cannot touch this dad's notification",
    );
  } finally {
    await store.close();
  }
});
