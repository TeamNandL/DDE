// Apply Phase 1 schema (vault/001_schema.sql) + FTS (vault/003_fts.sql)
// + noticed fields (vault/004_noticed.sql) + return loop (vault/005_return.sql).
// Never apply vault/002_rls_plan.sql here — RLS stays documented, not enabled.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = resolve(here, "../../vault/001_schema.sql");
export const RLS_PLAN_PATH = resolve(here, "../../vault/002_rls_plan.sql");
export const FTS_SCHEMA_PATH = resolve(here, "../../vault/003_fts.sql");
export const NOTICED_SCHEMA_PATH = resolve(here, "../../vault/004_noticed.sql");
export const RETURN_SCHEMA_PATH = resolve(here, "../../vault/005_return.sql");
export const PROGRESS_SCHEMA_PATH = resolve(here, "../../vault/006_progress.sql");
export const COLD_ASK_SCHEMA_PATH = resolve(here, "../../vault/007_cold_ask.sql");
export const DRAFTS_SCHEMA_PATH = resolve(here, "../../vault/008_drafts.sql");

export function readPhase1SchemaSql() {
  return readFileSync(SCHEMA_PATH, "utf8");
}

export function readFtsSchemaSql() {
  return readFileSync(FTS_SCHEMA_PATH, "utf8");
}

export function readNoticedSchemaSql() {
  return readFileSync(NOTICED_SCHEMA_PATH, "utf8");
}

export function readReturnSchemaSql() {
  return readFileSync(RETURN_SCHEMA_PATH, "utf8");
}

export function readProgressSchemaSql() {
  return readFileSync(PROGRESS_SCHEMA_PATH, "utf8");
}

export function readColdAskSchemaSql() {
  return readFileSync(COLD_ASK_SCHEMA_PATH, "utf8");
}

export function readDraftsSchemaSql() {
  return readFileSync(DRAFTS_SCHEMA_PATH, "utf8");
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

export async function applyReturnSchema(exec) {
  const sql = readReturnSchemaSql();
  if (!sql.trim()) throw new Error("005_return.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}

export async function applyProgressSchema(exec) {
  const sql = readProgressSchemaSql();
  if (!sql.trim()) throw new Error("006_progress.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}

export async function applyColdAskSchema(exec) {
  const sql = readColdAskSchemaSql();
  if (!sql.trim()) throw new Error("007_cold_ask.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}

export async function applyDraftsSchema(exec) {
  const sql = readDraftsSchemaSql();
  if (!sql.trim()) throw new Error("008_drafts.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}

/** Phase 1 tables + FTS + noticed + return + progress + cold-ask + drafts. */
export async function applyVaultSchema(exec) {
  await applyPhase1Schema(exec);
  await applyFtsSchema(exec);
  await applyNoticedSchema(exec);
  await applyReturnSchema(exec);
  await applyProgressSchema(exec);
  await applyColdAskSchema(exec);
  await applyDraftsSchema(exec);
}
