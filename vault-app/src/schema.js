// Apply the vault schema: 001 (tables/views) + 003 (search).
// Never apply vault/002_rls_plan.sql here — RLS stays documented, not enabled.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = resolve(here, "../../vault/001_schema.sql");
export const RLS_PLAN_PATH = resolve(here, "../../vault/002_rls_plan.sql");
export const SEARCH_SCHEMA_PATH = resolve(here, "../../vault/003_search.sql");

export function readPhase1SchemaSql() {
  return readFileSync(SCHEMA_PATH, "utf8");
}

export function readSearchSchemaSql() {
  return readFileSync(SEARCH_SCHEMA_PATH, "utf8");
}

// node-pg's extended protocol rejects multi-statement strings. The schema
// files keep semicolons out of literals and dollar-quoted bodies, so a
// comment-strip + split is safe.
export function splitSqlStatements(sql) {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function applyPhase1Schema(exec) {
  for (const [name, sql] of [
    ["001_schema.sql", readPhase1SchemaSql()],
    ["003_search.sql", readSearchSchemaSql()],
  ]) {
    if (!sql.trim()) throw new Error(`${name} is empty`);
    for (const stmt of splitSqlStatements(sql)) {
      await exec(stmt);
    }
  }
}
