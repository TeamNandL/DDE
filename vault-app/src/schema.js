// Apply Phase 1 schema (vault/001_schema.sql) only.
// Never apply vault/002_rls_plan.sql here — RLS stays documented, not enabled.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = resolve(here, "../../vault/001_schema.sql");
export const RLS_PLAN_PATH = resolve(here, "../../vault/002_rls_plan.sql");

export function readPhase1SchemaSql() {
  return readFileSync(SCHEMA_PATH, "utf8");
}

// node-pg's extended protocol rejects multi-statement strings. The Phase 1
// file has no semicolons inside literals, so a comment-strip + split is safe.
export function splitSqlStatements(sql) {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function applyPhase1Schema(exec) {
  const sql = readPhase1SchemaSql();
  if (!sql.trim()) throw new Error("001_schema.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}
