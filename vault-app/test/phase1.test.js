// Phase 1 §6 tests 1–8, run against the local in-memory vault proof.
// Test 9 (Monday→Friday on rented Postgres) is intentionally absent: no
// Supabase instance exists until Nick's exact-yes.

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

function ventSession() {
  const s = freshSession();
  s.intakeResult = s.bff.postVaultIntake(
    { dad_id: DAD_ID, text: FIXED_VENT },
    { referenceDate: MONDAY },
  );
  return s;
}

function dump(vault) {
  return JSON.stringify(vault.allRows());
}

test("Test 1: Intake claim write — fixed vent → ≥1 events row, pipe='claim', event_type='late_exchange', raw_quote present", () => {
  const { vault, intakeResult } = ventSession();
  assert.ok(intakeResult.written >= 1, "at least one row written");
  assert.ok(vault.events.length >= 1, "events table has a row");
  const ev = vault.events[0];
  assert.equal(ev.pipe, "claim");
  assert.equal(ev.event_type, "late_exchange");
  assert.ok(typeof ev.raw_quote === "string" && ev.raw_quote.length > 0, "raw_quote present");
  assert.equal(ev.dad_id, DAD_ID);
});

test("Test 2: Claim chase, not count — 'third time this month' → no number stored; state.missing has a verify item", () => {
  const { vault } = ventSession();
  const stored = dump(vault);
  assert.ok(!/\bthird\b/i.test(stored), "ordinal 'third' stored nowhere");
  assert.ok(!/\bthree times\b/i.test(stored), "'three times' stored nowhere");
  assert.ok(!/\b3 times\b/i.test(stored), "'3 times' stored nowhere");
  assert.ok(!/\bthis month\b/i.test(stored), "count-claim sentence stored nowhere");
  const state = vault.getState(DAD_ID);
  assert.ok(state, "state row exists");
  const item = state.missing.find((m) => /verify count in OFW record for/i.test(m));
  assert.ok(item, "state.missing contains a verify item");
  assert.equal(item, "verify count in OFW record for September");
  assert.ok(!/\d/.test(item), "the verify item itself carries no number");
});

test("Test 3: Venom stripped — no row anywhere contains 'destroying', 'spiteful', or characterization of Jordan", () => {
  const { vault } = ventSession();
  const stored = dump(vault);
  assert.ok(!/destroying/i.test(stored));
  assert.ok(!/spiteful/i.test(stored));
  assert.ok(!/on purpose/i.test(stored), "intent-reading stripped");
  assert.ok(!/doing this to/i.test(stored));
});

test("Test 4: Edge read — GET /vault/state returns next_action and missing with no re-entry", () => {
  const { bff } = ventSession();
  // No further writes between intake and this read — Edge just reads.
  const state = bff.getVaultState({ dad_id: DAD_ID });
  assert.ok(state, "state readable");
  assert.ok(typeof state.next_action === "string" && state.next_action.length > 0, "next_action present");
  assert.ok(Array.isArray(state.missing) && state.missing.length > 0, "missing present");
});

test("Test 5: Verified export clean — GET /vault/export/verified returns zero rows from the vent session", () => {
  const { bff } = ventSession();
  const rows = bff.getVaultExportVerified({ dad_id: DAD_ID });
  assert.equal(rows.length, 0, "verified export is empty — claims never leak to Reporting");
});

test("Test 6: Harm discard — harm-language input → written: 0, zero rows, zero log lines containing the input", () => {
  const { vault, bff } = freshSession();
  const harmInput =
    "I am so angry I could hurt Jordan the next time she pulls this at the exchange.";
  const result = bff.postVaultIntake(
    { dad_id: DAD_ID, text: harmInput },
    { referenceDate: MONDAY },
  );
  assert.deepEqual(result, { written: 0, chase: [] });
  assert.equal(vault.allRows().length, 0, "zero rows anywhere");
  assert.equal(logger.lines().length, 0, "zero log lines at all from the harm call");
  assert.ok(!dump(vault).includes("hurt"), "zero retention of the input");
});

test("Test 7: Log hygiene — no message bodies, no 'Sam', no 'Taylor', no amounts in any log line", () => {
  ventSession();
  const all = logger.lines().join("\n");
  assert.ok(logger.lines().length > 0, "the vent run does produce id-only log lines");
  assert.ok(!/sam/i.test(all), "no 'Sam' in logs");
  assert.ok(!/taylor/i.test(all), "no 'Taylor' in logs");
  assert.ok(!/jordan/i.test(all), "no co-parent name in logs");
  assert.ok(!/\$\s?\d/.test(all), "no amounts in logs");
  assert.ok(!/parking lot|sitter|supposed to/i.test(all), "no message-body fragments in logs");
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
