// Spreadsheet views are generated from the vault. Fake family only.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { seedDemo, DEMO_DAD_ID } from "../src/demo.js";
import {
  EVENTS_HEADERS,
  STATE_HEADERS,
  VERIFIED_HEADERS,
  eventsTimeLog,
  stateMissingChecklist,
  verifiedExportView,
  writeExports,
  toCsv,
} from "../src/export.js";
import { runExportCli } from "../src/cli-export.js";

test("events time-log + state checklist come from the vault; verified stays clean after intake", async () => {
  const vault = new Vault();
  const bff = makeBff(vault);
  const { intake } = await seedDemo(bff, DEMO_DAD_ID);
  assert.ok(intake.written >= 1);

  const events = await eventsTimeLog(vault, DEMO_DAD_ID);
  assert.equal(events.length, 1);
  assert.equal(events[0].pipe, "claim");
  assert.equal(events[0].event_type, "late_exchange");
  assert.ok(/third time/i.test(events[0].raw_quote));
  assert.ok(!/spiteful|destroying|on purpose/i.test(events[0].raw_quote));
  assert.ok(!/spiteful|destroying/i.test(events[0].notes));

  const checklist = await stateMissingChecklist(vault, DEMO_DAD_ID);
  assert.ok(checklist.length >= 1);
  assert.equal(checklist[0].missing_item, "verify count in OFW record for September");
  assert.equal(checklist[0].is_next_action, "yes");
  assert.ok(!/\d/.test(checklist[0].missing_item));

  const verified = await verifiedExportView(vault, DEMO_DAD_ID);
  assert.equal(verified.length, 1, "demo OFW pull is the only verified row");
  assert.equal(verified[0].source_table, "communications");
  assert.equal(verified[0].pipe, "verified");
  assert.equal(verified[0].source_ref, "ofw:demo:2026-09-14");
  assert.ok(verified.every((r) => r.pipe === "verified"));
  assert.ok(!verified.some((r) => r.source_table === "events"), "claim events never appear on verified_export");
});

test("writeExports emits CSV and XLSX views, not a source of truth", async () => {
  const vault = new Vault();
  const bff = makeBff(vault);
  await seedDemo(bff, DEMO_DAD_ID);
  const dir = mkdtempSync(join(tmpdir(), "dde-export-"));
  const result = await writeExports({ vault, dadId: DEMO_DAD_ID, outDir: dir, store: "memory" });
  assert.equal(result.written.length, 3);

  const eventsCsv = readFileSync(join(dir, "events_time_log.csv"), "utf8");
  assert.ok(eventsCsv.startsWith(EVENTS_HEADERS.join(",")));
  assert.match(eventsCsv, /late_exchange/);
  assert.doesNotMatch(eventsCsv, /spiteful/);

  const stateCsv = readFileSync(join(dir, "state_missing_checklist.csv"), "utf8");
  assert.ok(stateCsv.startsWith(STATE_HEADERS.join(",")));
  assert.match(stateCsv, /verify count in OFW record for September/);

  const verifiedCsv = readFileSync(join(dir, "verified_export.csv"), "utf8");
  assert.ok(verifiedCsv.startsWith(VERIFIED_HEADERS.join(",")));
  assert.match(verifiedCsv, /ofw:demo:2026-09-14/);
  assert.doesNotMatch(verifiedCsv, /late_exchange/);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(join(dir, "events_time_log.xlsx"));
  assert.ok(wb.getWorksheet("_generated"));
  assert.ok(wb.getWorksheet("events"));
  const gen = wb.getWorksheet("_generated");
  const keys = [];
  gen.eachRow((row, i) => {
    if (i === 1) return;
    keys.push(String(row.getCell(1).value));
  });
  assert.ok(keys.includes("source_of_truth"));
});

test("toCsv quotes commas and never invents a third pipe", () => {
  const csv = toCsv(["pipe", "notes"], [{ pipe: "claim", notes: "a, b" }]);
  assert.equal(csv, "pipe,notes\nclaim,\"a, b\"\n");
});

test("export CLI --demo writes the three views without DATABASE_URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dde-cli-"));
  const out = await runExportCli(["all", "--demo", "--out", dir]);
  assert.equal(out.exitCode, 0, out.stderr);
  assert.match(out.stdout, /store=memory/);
  assert.match(out.stdout, /events rows=1/);
  readFileSync(join(dir, "verified_export.xlsx"));
});
