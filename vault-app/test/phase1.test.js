// Phase 1 §6 tests 1–8, run against the local in-memory vault proof.
// Test 9 (Monday→Friday on rented Postgres) lives in phase1.pg.test.js
// and runs only through extract → BFF → SqlVault → node-postgres.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import * as logger from "../src/logger.js";

const here = dirname(fileURLToPath(import.meta.url));

// The fixed vent is the single source of truth in FIXED_VENT.md — the
// paragraph between the two --- rules.
const FIXED_VENT = readFileSync(join(here, "..", "FIXED_VENT.md"), "utf8")
  .split(/^---$/m)[1]
  .replace(/\s+/g, " ")
  .trim();

const DAD_ID = "11111111-1111-4111-8111-111111111111";
// Monday, September 14, 2026 — the "Monday" of the milestone week.
const MONDAY = new Date("2026-09-14T12:00:00");

logger.setLogFile(join(here, "..", "test-output", "run.log"));

function freshSession() {
  logger.reset();
  const vault = new Vault();
  return { vault, bff: makeBff(vault) };
}

async function ventSession() {
  const s = freshSession();
  s.intakeResult = await s.bff.postVaultIntake(
    { dad_id: DAD_ID, text: FIXED_VENT },
    { referenceDate: MONDAY },
  );
  return s;
}

function dump(vault) {
  return JSON.stringify(vault.allRows());
}

test("Test 1: Intake claim write — fixed vent → ≥1 events row, pipe='claim', event_type='late_exchange', raw_quote present", async () => {
  const { vault, intakeResult } = await ventSession();
  assert.ok(intakeResult.written >= 1, "at least one row written");
  assert.ok(vault.events.length >= 1, "events table has a row");
  const ev = vault.events[0];
  assert.equal(ev.pipe, "claim");
  assert.equal(ev.event_type, "late_exchange");
  assert.ok(typeof ev.raw_quote === "string" && ev.raw_quote.length > 0, "raw_quote present");
  assert.equal(ev.dad_id, DAD_ID);
});

test("Test 2: Claim chase, not count — 'third time this month' → no number stored; state.missing has a verify item", async () => {
  const { vault } = await ventSession();
  // §4: raw_quote = original minus harm/venom — the dad's own words stay on
  // the claim pipe, count claim included.
  const ev = vault.events[0];
  assert.ok(/third time/i.test(ev.raw_quote), "claim raw_quote keeps the dad's own words");
  // But the count is never stored as data: no structured field anywhere
  // (notes, kids, location, state, missing, summaries) carries it, and no
  // verified row exists at all.
  const structured = JSON.stringify(
    vault.allRows().map(({ raw_quote, ...rest }) => rest),
  );
  assert.ok(!/\bthird\b/i.test(structured), "ordinal 'third' in no structured field");
  assert.ok(!/\bthree times\b/i.test(structured), "'three times' in no structured field");
  assert.ok(!/\b3 times\b/i.test(structured), "'3 times' in no structured field");
  assert.equal(
    vault.verifiedExport(DAD_ID).length,
    0,
    "the count claim produced nothing on the verified pipe",
  );
  const state = vault.getState(DAD_ID);
  assert.ok(state, "state row exists");
  const item = state.missing.find((m) => /verify count in OFW record for/i.test(m));
  assert.ok(item, "state.missing contains a verify item");
  assert.equal(item, "verify count in OFW record for September");
  assert.ok(!/\d/.test(item), "the verify item itself carries no number");
});

test("Test 3: Venom stripped — no row anywhere contains 'destroying', 'spiteful', or characterization of Jordan", async () => {
  const { vault } = await ventSession();
  const stored = dump(vault);
  assert.ok(!/destroying/i.test(stored));
  assert.ok(!/spiteful/i.test(stored));
  assert.ok(!/on purpose/i.test(stored), "intent-reading stripped");
  assert.ok(!/doing this to/i.test(stored));
});

test("Test 4: Edge read — GET /vault/state returns next_action and missing with no re-entry", async () => {
  const { bff } = await ventSession();
  // No further writes between intake and this read — Edge just reads.
  const state = await bff.getVaultState({ dad_id: DAD_ID });
  assert.ok(state, "state readable");
  assert.ok(typeof state.next_action === "string" && state.next_action.length > 0, "next_action present");
  assert.ok(Array.isArray(state.missing) && state.missing.length > 0, "missing present");
});

test("Test 5: Verified export clean — GET /vault/export/verified returns zero rows from the vent session", async () => {
  const { bff } = await ventSession();
  const rows = await bff.getVaultExportVerified({ dad_id: DAD_ID });
  assert.equal(rows.length, 0, "verified export is empty — claims never leak to Reporting");
});

test("Test 6: Harm discard — harm-language input → written: 0, zero rows, zero log lines containing the input", async () => {
  const { vault, bff } = freshSession();
  const harmInput =
    "I am so angry I could hurt Jordan the next time she pulls this at the exchange.";
  const result = await bff.postVaultIntake(
    { dad_id: DAD_ID, text: harmInput },
    { referenceDate: MONDAY },
  );
  assert.deepEqual(result, { written: 0, chase: [] });
  assert.equal(vault.allRows().length, 0, "zero rows anywhere");
  assert.equal(logger.lines().length, 0, "zero log lines at all from the harm call");
  assert.ok(!dump(vault).includes("hurt"), "zero retention of the input");
});

test("Test 7: Log hygiene — no message bodies, no 'Sam', no 'Taylor', no amounts in any log line", async () => {
  await ventSession();
  const all = logger.lines().join("\n");
  assert.ok(logger.lines().length > 0, "the vent run does produce id-only log lines");
  assert.ok(!/sam/i.test(all), "no 'Sam' in logs");
  assert.ok(!/taylor/i.test(all), "no 'Taylor' in logs");
  assert.ok(!/jordan/i.test(all), "no co-parent name in logs");
  assert.ok(!/\$\s?\d/.test(all), "no amounts in logs");
  assert.ok(!/parking lot|sitter|supposed to/i.test(all), "no message-body fragments in logs");
});

// Quill live intake round-trip expected (fake family only):
//   POST /vault/intake {
//     dad_id,
//     text: "Jordan cancelled Tuesday again. Sam and Taylor were waiting. This is the third time this month."
//   }
//   → { written: ≥1, chase: ["verify count in OFW record for <Month>"] }
//   events row: pipe='claim', event_type='denied_visit' (or late_exchange if late)
//   raw_quote keeps "third time this month"; no structured count field
//   claim_chase writes state.missing verify-count (no number)
//   GET /vault/export/verified → []
test("cancelled/denied visit phrasing writes ≥1 claim event and still chases the count", async () => {
  const cases = [
    {
      text: "Jordan cancelled Tuesday again. Sam and Taylor were waiting. This is the third time this month.",
      event_type: "denied_visit",
    },
    {
      text: "Jordan canceled Saturday pickup. Sam and Taylor were waiting. This is the third time this month.",
      event_type: "denied_visit",
    },
    {
      text: "Jordan denied the visit Tuesday. Sam and Taylor were waiting. This is the third time this month.",
      event_type: "denied_visit",
    },
    {
      text: "Jordan cancelled and showed up late at 7pm for the exchange. This is the third time this month.",
      event_type: "late_exchange",
    },
  ];

  for (const { text, event_type } of cases) {
    const { vault, bff } = freshSession();
    const result = await bff.postVaultIntake(
      { dad_id: DAD_ID, text },
      { referenceDate: MONDAY },
    );
    assert.ok(result.written >= 1, `intake must write ≥1 claim event for: ${text}`);
    assert.ok(result.chase.length >= 1, "count claim still chased");
    const ev = vault.events[0];
    assert.equal(ev.pipe, "claim");
    assert.equal(ev.event_type, event_type, text);
    assert.ok(/third time/i.test(ev.raw_quote), "raw_quote keeps the count phrase");
    const structured = JSON.stringify(
      vault.allRows().map(({ raw_quote, ...rest }) => rest),
    );
    assert.ok(!/\bthird\b/i.test(structured), "ordinal 'third' in no structured field");
    const state = vault.getState(DAD_ID);
    const item = state.missing.find((m) => /verify count in OFW record for/i.test(m));
    assert.ok(item, "claim_chase still writes Missing");
    assert.equal(item, "verify count in OFW record for September");
    assert.ok(!/\d/.test(item), "the verify item itself carries no number");
    const verified = await bff.getVaultExportVerified({ dad_id: DAD_ID });
    assert.deepEqual(verified, [], "verified export stays empty — claims never leak");
  }
});

test("Test 8: month_summary gate — one unverified source_ref → write rejected or forced to pipe='claim'", () => {
  const { vault } = freshSession();
  const verified = vault.insertEvent(DAD_ID, {
    event_type: "exchange",
    occurred_at: "2026-09-07T18:00:00.000Z",
    pipe: "verified",
    source_ref: "ofw:export:2026-09",
  });
  const claim = vault.insertEvent(DAD_ID, {
    event_type: "late_exchange",
    occurred_at: "2026-09-14T18:45:00.000Z",
    pipe: "claim",
  });

  // One unverified ref in the set → the whole summary is forced to claim.
  const gated = vault.insertMonthSummary(DAD_ID, {
    month: "2026-09-01",
    summary_text: "Exchanges logged for the month.",
    pattern_tags: ["late_exchange"],
    source_refs: [verified.id, claim.id],
    pipe: "verified",
  });
  assert.equal(gated.row.pipe, "claim", "forced to claim");
  assert.equal(gated.forced_claim, true);

  // Control: all refs verified → verified stands.
  const clean = vault.insertMonthSummary(DAD_ID, {
    month: "2026-09-01",
    summary_text: "Exchanges logged for the month.",
    pattern_tags: ["late_exchange"],
    source_refs: [verified.id],
    pipe: "verified",
  });
  assert.equal(clean.row.pipe, "verified");
  assert.equal(clean.forced_claim, false);

  // Rail: personality/clinical pattern tags are rejected outright.
  assert.throws(() =>
    vault.insertMonthSummary(DAD_ID, {
      month: "2026-09-01",
      pattern_tags: ["narcissistic"],
      source_refs: [verified.id],
      pipe: "verified",
    }),
  );
});
