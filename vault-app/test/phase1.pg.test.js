// Test 9 — Monday→Friday milestone on rented Postgres (§0, §6).
//
// The ONLY write path is the app path: extract → BFF → SqlVault →
// node-postgres → rented Postgres (vault/001_schema.sql). No console SQL,
// no MCP inserts, no manual step between Monday and Friday.
//
// Requires DATABASE_URL in the environment (never committed — the
// connection string and its password live only in env). Without it, or in
// a container whose egress policy blocks the database host, this test
// skips and Phase 1 reports test 9 as BLOCKED — it is not proven another
// way.
//
// One command (after `npm install`):
//   DATABASE_URL="postgresql://..." npm test
// Schema 001 is applied idempotently by the store factory. 002 (RLS) is not.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { SqlVault } from "../src/sqlvault.js";
import { makeBff } from "../src/bff.js";

// Day 1 (Monday) of the milestone week. Friday is just the later read.
export const MONDAY = new Date("2026-09-14T12:00:00");

// The §0 milestone opens with a denied-visit claim. Fake family only:
// Alex Rivera venting about Jordan Lee; Sam (8), Taylor (5). Contains a
// count claim ("second time") to chase and venom to strip.
export const DENIED_VISIT_VENT =
  "Jordan didn't let me pick up Sam and Taylor for my weekend visit today. " +
  "I was at the door at five like the schedule says and she wouldn't let " +
  "them leave with me. This is the second time this month. She is doing " +
  "this on purpose to sabotage my time with the kids.";

// Harm-language control input for the zero-rows-anywhere leg.
export const HARM_INPUT =
  "I am done being calm, I want to hurt Jordan for keeping the kids from me.";

const url = databaseUrl();

test(
  "Test 9: Monday→Friday milestone on rented Postgres (app write path only)",
  { skip: url ? false : "BLOCKED: DATABASE_URL not set / database egress unavailable" },
  async () => {
    const store = await openStore({ databaseUrl: url, applySchema: true });
    assert.equal(store.kind, "postgres", "test 9 must use rented Postgres, not memory");
    assert.ok(store.vault instanceof SqlVault, "writes go through SqlVault");
    const bff = makeBff(store.vault);
    const dadId = randomUUID();

    try {
      // Provision first (only create path) — tenancy/auth requires it.
      await bff.postVaultProvision({ dad_id: dadId });

      // Day 1 (Monday): denied-visit claim through Intake — the app path.
      const monday = await bff.postVaultIntake(
        { dad_id: dadId, text: DENIED_VISIT_VENT },
        { referenceDate: MONDAY },
      );
      assert.ok(monday.written >= 1, "claim written day 1");
      assert.ok(monday.chase.length >= 1, "count claim chased, not stored");

      // Harm input through the same path: zero rows anywhere.
      const harm = await bff.postVaultIntake(
        { dad_id: dadId, text: HARM_INPUT },
        { referenceDate: MONDAY },
      );
      assert.equal(harm.written, 0, "harm input writes nothing");

      // Day 5 (Friday): Edge reads state/missing via the BFF — no re-entry
      // and no write of any kind between day 1 and this read.
      const state = await bff.getVaultState({ dad_id: dadId });
      assert.ok(state.next_action, "next_action readable day 5");
      assert.ok(state.missing.length > 0, "missing readable day 5");
      assert.ok(!/\d/.test(state.next_action), "no number in the chase item");

      // Verified export still empty — claims never reach Reporting.
      const rows = await bff.getVaultExportVerified({ dad_id: dadId });
      assert.equal(rows.length, 0, "verified export clean");

      // Read-only verification of what actually landed (asserts may inspect
      // the DB directly; only the WRITE path must be the app).
      const evs = (await store.query(
        "select pipe, event_type, raw_quote, kids, notes from events where dad_id = $1",
        [dadId],
      )).rows;
      assert.equal(evs.length, 1, "exactly the one claim row (harm left zero)");
      assert.equal(evs[0].pipe, "claim");
      assert.equal(evs[0].event_type, "denied_visit");
      assert.ok(/second time/i.test(evs[0].raw_quote), "dad's own words kept in raw_quote");
      assert.ok(!/second time|\b2\b/i.test(evs[0].notes ?? ""), "no count in structured notes");
      assert.ok(!/sabotage|on purpose/i.test(evs[0].raw_quote), "venom stripped");

      const counts = (
        await store.query(
          `select (select count(*) from events where dad_id = $1)::int as events,
                  (select count(*) from communications where dad_id = $1)::int as communications,
                  (select count(*) from documents where dad_id = $1)::int as documents,
                  (select count(*) from month_summary where dad_id = $1)::int as month_summary,
                  (select count(*) from state where dad_id = $1)::int as state`,
          [dadId],
        )
      ).rows[0];
      assert.deepEqual(counts, {
        events: 1,
        communications: 0,
        documents: 0,
        month_summary: 0,
        state: 1,
      });
    } finally {
      await store.close();
    }
  },
);
