// Test 9 — Monday→Friday milestone, direct-connection variant.
//
// Runs the full milestone against rented Postgres when DATABASE_URL is set
// in the environment (node-postgres, `npm i pg` first). The connection
// string and its password live ONLY in the environment — never in this
// repo. In containers whose egress policy blocks the database host, use
// test/milestone9-driver.js instead (same sequence over a sanctioned SQL
// channel).

import test from "node:test";
import assert from "node:assert/strict";

import { SqlVault } from "../src/sqlvault.js";
import { makeBff } from "../src/bff.js";
import {
  buildMilestone,
  DENIED_VISIT_VENT,
  HARM_INPUT,
  MONDAY,
} from "./milestone9-driver.js";

const url = process.env.DATABASE_URL;

test(
  "Test 9: Monday→Friday milestone on rented Postgres",
  { skip: url ? false : "DATABASE_URL not set — run via milestone9-driver.js emit + sanctioned SQL channel" },
  async () => {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url });
    const exec = async (sql) => (await pool.query(sql)).rows;
    const vault = new SqlVault(exec);
    const bff = makeBff(vault);
    const { randomUUID } = await import("node:crypto");
    const dadId = randomUUID();

    try {
      // Day 1 (Monday): denied-visit claim via Intake.
      const monday = await bff.postVaultIntake(
        { dad_id: dadId, text: DENIED_VISIT_VENT },
        { referenceDate: MONDAY },
      );
      assert.ok(monday.written >= 1, "claim written day 1");

      // Harm input: zero rows anywhere.
      const harm = await bff.postVaultIntake(
        { dad_id: dadId, text: HARM_INPUT },
        { referenceDate: MONDAY },
      );
      assert.equal(harm.written, 0);

      // Day 5 (Friday): Edge reads state/missing — no re-entry between.
      const state = await bff.getVaultState({ dad_id: dadId });
      assert.ok(state.next_action, "next_action readable day 5");
      assert.ok(state.missing.length > 0, "missing readable day 5");

      // Verified export still empty.
      const rows = await bff.getVaultExportVerified({ dad_id: dadId });
      assert.equal(rows.length, 0, "verified export clean");

      const counts = await vault.countRows(dadId);
      assert.equal(Number(counts.events), 1, "exactly the one claim row");
    } finally {
      await pool.end();
    }
  },
);

// Re-exported so `node --test` treats a build failure as a test failure even
// without DATABASE_URL.
test("milestone plan builds (emit mode sanity)", async () => {
  const plan = await buildMilestone();
  assert.ok(plan.steps.length >= 2, "Monday intake emits event insert + state upsert");
  assert.equal(plan.in_process.harm_written, 0);
  assert.equal(plan.in_process.harm_emitted_sql_statements, 0);
  assert.equal(plan.in_process.harm_emitted_log_lines, 0);
});
