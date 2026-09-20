// Apply Phase 1 schema (vault/001_schema.sql) + FTS (vault/003_fts.sql)
// + noticed fields (vault/004_noticed.sql).
// Never apply vault/002_rls_plan.sql here — RLS stays documented, not enabled.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = resolve(here, "../../vault/001_schema.sql");
export const RLS_PLAN_PATH = resolve(here, "../../vault/002_rls_plan.sql");
export const FTS_SCHEMA_PATH = resolve(here, "../../vault/003_fts.sql");
export const NOTICED_SCHEMA_PATH = resolve(here, "../../vault/004_noticed.sql");

export function readPhase1SchemaSql() {
  return readFileSync(SCHEMA_PATH, "utf8");
}

export function readFtsSchemaSql() {
  return readFileSync(FTS_SCHEMA_PATH, "utf8");
}

export function readNoticedSchemaSql() {
  return readFileSync(NOTICED_SCHEMA_PATH, "utf8");
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

export async function applyFtsSchema(exec) {
  const sql = readFtsSchemaSql();
  if (!sql.trim()) throw new Error("003_fts.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}

export async function applyNoticedSchema(exec) {
  const sql = readNoticedSchemaSql();
  if (!sql.trim()) throw new Error("004_noticed.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}

/** Phase 1 tables + FTS generated columns / GIN indexes + noticed fields. */
export async function applyVaultSchema(exec) {
  await applyPhase1Schema(exec);
  await applyFtsSchema(exec);
  await applyNoticedSchema(exec);
}
