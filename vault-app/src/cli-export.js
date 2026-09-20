#!/usr/bin/env node
// On-demand spreadsheet views from the vault.
//
//   npm run export:events
//   npm run export:state
//   npm run export:verified
//   npm run export:all
//
// With DATABASE_URL: reads rented Postgres for --dad-id.
// Without: requires --demo (fake family only) and uses the in-memory vault.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeBff } from "./bff.js";
import { databaseUrl, openStore } from "./store.js";
import { ALL_VIEWS, VIEW_EVENTS, VIEW_STATE, VIEW_VERIFIED, defaultExportDir, writeExports } from "./export.js";
import { DEMO_DAD_ID, seedDemo } from "./demo.js";

const VIEW_ALIASES = {
  events: VIEW_EVENTS,
  event: VIEW_EVENTS,
  "time-log": VIEW_EVENTS,
  state: VIEW_STATE,
  missing: VIEW_STATE,
  checklist: VIEW_STATE,
  verified: VIEW_VERIFIED,
  export: VIEW_VERIFIED,
  all: "all",
};

function usage() {
  return `Usage: node src/cli-export.js <events|state|verified|all> [options]

Options:
  --demo              Seed the fake-family demo (Alex Rivera) in memory
  --on-db             With --demo, seed into DATABASE_URL (off by default)
  --dad-id <uuid>     Tenant to export (required against DATABASE_URL unless --demo)
  --out <dir>         Output directory (default: vault-app/exports/)
  --help              Show this help

Views are generated outputs. The vault is the source of truth — do not
commit spreadsheets or treat them as the record.

Examples:
  npm run export:all -- --demo
  DATABASE_URL=... npm run export:events -- --dad-id <uuid>
`;
}

export async function runExportCli(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      demo: { type: "boolean", default: false },
      "on-db": { type: "boolean", default: false },
      "dad-id": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    return { ok: true, stdout: usage(), stderr: "", exitCode: 0 };
  }

  const which = (positionals[0] || "all").toLowerCase();
  if (!(which in VIEW_ALIASES)) {
    return { ok: false, stdout: "", stderr: `unknown view '${which}'\n\n${usage()}`, exitCode: 2 };
  }

  const views = VIEW_ALIASES[which] === "all" ? ALL_VIEWS : [VIEW_ALIASES[which]];
  const url = databaseUrl();
  const demo = values.demo;
  const onDb = values["on-db"];
  const dadId = values["dad-id"] || (demo ? DEMO_DAD_ID : "");
  // --demo stays in-memory unless --on-db is explicit, so a leftover
  // DATABASE_URL cannot write fake-family rows into rented Postgres.
  const usePostgres = Boolean(url) && (!demo || onDb);

  if (!usePostgres && !demo) {
    return {
      ok: false,
      stdout: "",
      stderr:
        "Need --demo (in-memory fake family) or DATABASE_URL plus --dad-id.\n" +
        "Spreadsheets are views of the vault, not a store.\n",
      exitCode: 2,
    };
  }
  if (usePostgres && !dadId) {
    return {
      ok: false,
      stdout: "",
      stderr: "DATABASE_URL is set; pass --dad-id <uuid>.\n",
      exitCode: 2,
    };
  }

  const store = await openStore({ databaseUrl: usePostgres ? url : "" });
  try {
    const bff = makeBff(store.vault);
    if (demo) await seedDemo(bff, dadId);
    const result = await writeExports({
      vault: store.vault,
      dadId,
      outDir: values.out || defaultExportDir(),
      views,
      store: store.kind,
    });
    const lines = [
      `store=${store.kind} dad_id=${dadId} out=${result.dir}`,
      ...result.written.map((w) => `${w.view} rows=${w.rows} csv=${w.csv} xlsx=${w.xlsx}`),
    ];
    return { ok: true, stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0, result };
  } finally {
    await store.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const out = await runExportCli();
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.exitCode);
}
