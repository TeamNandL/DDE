// Test 9 driver — Monday→Friday milestone (§0, §6) against rented Postgres.
//
// The real middle layer (harm check, venom strip, extraction, claim chase)
// runs in this process against SqlVault. In "emit" mode the executor records
// each fully-materialized SQL statement instead of running it, so the exact
// same sequence can be executed over a sanctioned channel (the Supabase MCP
// SQL runner) when this container's egress policy blocks the database host.
// No manual step exists between the statements: the sequence is generated
// end-to-end by this script.
//
// Usage: node test/milestone9-driver.js emit
//   → writes test-output/milestone9.json  (steps + assert queries)
//   → logger output to test-output/run-pg.log (hygiene grep surface)

import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SqlVault } from "../src/sqlvault.js";
import { extract } from "../src/extract.js";
import * as logger from "../src/logger.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "test-output");

// Day 1 (Monday) and day 5 (Friday) of the milestone week.
export const MONDAY = new Date("2026-09-14T12:00:00");
export const FRIDAY = new Date("2026-09-18T12:00:00");

// The §0 milestone opens with a denied-visit claim. Fake family only:
// Alex Rivera venting about Jordan Lee; Sam (8), Taylor (5).
export const DENIED_VISIT_VENT =
  "Jordan didn't let me pick up Sam and Taylor for my weekend visit today. " +
  "I was at the door at five like the schedule says and she wouldn't let " +
  "them leave with me. This is the second time this month. She is doing " +
  "this on purpose to sabotage my time with the kids.";

// Harm-language control input for the milestone's zero-rows-anywhere leg.
export const HARM_INPUT =
  "I am done being calm, I want to hurt Jordan for keeping the kids from me.";

export async function buildMilestone() {
  const dadId = randomUUID();
  const steps = [];
  const recordingExec = async (sql) => {
    steps.push(sql.replace(/\s+/g, " ").trim());
    return [{ id: "recorded" }];
  };
  const vault = new SqlVault(recordingExec);

  // Day 1 (Monday): Intake writes the denied-visit claim. claim_chase adds
  // the verify item to state in the same automated pass.
  const monday = await extract(vault, dadId, DENIED_VISIT_VENT, {
    referenceDate: MONDAY,
  });
  const stepsAfterMonday = steps.length;

  // Harm input: must short-circuit — zero SQL, zero rows, zero log lines.
  const logLinesBeforeHarm = logger.lines().length;
  const harm = await extract(vault, dadId, HARM_INPUT, { referenceDate: MONDAY });
  const harmEmittedSql = steps.length - stepsAfterMonday;
  const harmEmittedLogLines = logger.lines().length - logLinesBeforeHarm;

  // Day 5 (Friday): read-only assert queries — Edge reads state/missing with
  // no re-entry; verified export still empty.
  const asserts = [
    {
      name: "claim_written_day1",
      sql: `select count(*)::int as n from events where dad_id = '${dadId}' and pipe = 'claim' and event_type = 'denied_visit';`,
      expect: { n: 1 },
    },
    {
      name: "state_readable_day5",
      sql: `select next_action, missing from state where dad_id = '${dadId}';`,
      expect: {
        next_action: "verify count in OFW record for September",
        missing_contains: "verify count in OFW record for September",
      },
    },
    {
      name: "verified_export_still_empty",
      sql: `select count(*)::int as n from verified_export where dad_id = '${dadId}';`,
      expect: { n: 0 },
    },
    {
      name: "harm_left_zero_rows_anywhere",
      sql:
        `select (select count(*) from events where dad_id = '${dadId}')::int as events, ` +
        `(select count(*) from communications where dad_id = '${dadId}')::int as communications, ` +
        `(select count(*) from documents where dad_id = '${dadId}')::int as documents, ` +
        `(select count(*) from month_summary where dad_id = '${dadId}')::int as month_summary, ` +
        `(select count(*) from state where dad_id = '${dadId}')::int as state;`,
      expect: { events: 1, communications: 0, documents: 0, month_summary: 0, state: 1 },
    },
  ];

  return {
    dad_id: dadId,
    monday: MONDAY.toISOString(),
    friday: FRIDAY.toISOString(),
    in_process: {
      monday_written: monday.written,
      monday_chase: monday.chase,
      harm_written: harm.written,
      harm_emitted_sql_statements: harmEmittedSql,
      harm_emitted_log_lines: harmEmittedLogLines,
    },
    steps,
    asserts,
  };
}

if (process.argv[2] === "emit") {
  mkdirSync(outDir, { recursive: true });
  logger.setLogFile(join(outDir, "run-pg.log"));
  const plan = await buildMilestone();
  writeFileSync(join(outDir, "milestone9.json"), JSON.stringify(plan, null, 2));
  // stdout: structure only — no vent text, no kid names.
  console.log(
    JSON.stringify(
      {
        dad_id: plan.dad_id,
        sql_steps: plan.steps.length,
        asserts: plan.asserts.length,
        in_process: plan.in_process,
      },
      null,
      2,
    ),
  );
}
