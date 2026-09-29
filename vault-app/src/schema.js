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
export const DRAFT_GRADE_SCHEMA_PATH = resolve(here, "../../vault/009_draft_grade.sql");
export const COURT_PREP_SCHEMA_PATH = resolve(here, "../../vault/010_court_prep.sql");
export const PARENTING_PLAN_SCHEMA_PATH = resolve(here, "../../vault/011_parenting_plan.sql");
export const PROCESS_TRANSLATOR_SCHEMA_PATH = resolve(here, "../../vault/012_process_translator.sql");
export const INVOLVEMENT_SCHEMA_PATH = resolve(here, "../../vault/013_involvement.sql");
export const LEGAL_INTAKE_SCHEMA_PATH = resolve(here, "../../vault/014_legal_intake.sql");
export const AUTH_RLS_SCHEMA_PATH = resolve(here, "../../vault/015_auth_rls.sql");
export const EXPORT_DELETE_SCHEMA_PATH = resolve(here, "../../vault/016_export_delete.sql");
export const EVIDENCE_SCHEMA_PATH = resolve(here, "../../vault/017_evidence.sql");

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

export function readDraftGradeSchemaSql() {
  return readFileSync(DRAFT_GRADE_SCHEMA_PATH, "utf8");
}

export function readCourtPrepSchemaSql() {
  return readFileSync(COURT_PREP_SCHEMA_PATH, "utf8");
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

export async function applyDraftGradeSchema(exec) {
  const sql = readDraftGradeSchemaSql();
  if (!sql.trim()) throw new Error("009_draft_grade.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}

// Court-prep capture: candidate_facts + notifications (check-ins).
export async function applyCourtPrepSchema(exec) {
  const sql = readCourtPrepSchemaSql();
  if (!sql.trim()) throw new Error("010_court_prep.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}

// Parenting Plan seat (Slice 14): plan_topics + plan_drafts.
export async function applyParentingPlanSchema(exec) {
  const sql = readFileSync(PARENTING_PLAN_SCHEMA_PATH, "utf8");
  if (!sql.trim()) throw new Error("011_parenting_plan.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}

// Process Translator (Slice 15): translations + private calendar candidates.
export async function applyProcessTranslatorSchema(exec) {
  const sql = readFileSync(PROCESS_TRANSLATOR_SCHEMA_PATH, "utf8");
  if (!sql.trim()) throw new Error("012_process_translator.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}

// Involvement Cheat Sheet (Slice 16): involvement_fields.
export async function applyInvolvementSchema(exec) {
  const sql = readFileSync(INVOLVEMENT_SCHEMA_PATH, "utf8");
  if (!sql.trim()) throw new Error("013_involvement.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}

// Legal Intake seat (Slice 17): legal_intakes + legal_handoff_drafts.
export async function applyLegalIntakeSchema(exec) {
  const sql = readFileSync(LEGAL_INTAKE_SCHEMA_PATH, "utf8");
  if (!sql.trim()) throw new Error("014_legal_intake.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}

// Auth + RLS (Slice 18): dde_app role + dad_id policies. Run as ONE script
// (DO blocks contain semicolons, so it is not statement-split).
export async function applyAuthRlsSchema(exec) {
  const sql = readFileSync(AUTH_RLS_SCHEMA_PATH, "utf8");
  if (!sql.trim()) throw new Error("015_auth_rls.sql is empty");
  await exec(sql);
}

// Export receipts + deletion ledger (Slice 21). Owner-only tables; must run
// after 015 so the dde_app role exists for the revoke.
export async function applyExportDeleteSchema(exec) {
  const sql = readFileSync(EXPORT_DELETE_SCHEMA_PATH, "utf8");
  if (!sql.trim()) throw new Error("016_export_delete.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}

// Evidence hash log (Slice 23). Dad-scoped RLS; must run after 015 so
// dde_app and dde_current_dad() exist. Same statement-split path as 016.
export async function applyEvidenceSchema(exec) {
  const sql = readFileSync(EVIDENCE_SCHEMA_PATH, "utf8");
  if (!sql.trim()) throw new Error("017_evidence.sql is empty");
  for (const stmt of splitSqlStatements(sql)) {
    await exec(stmt);
  }
}

/** Phase 1 tables + FTS + noticed + return + progress + cold-ask + drafts (+grade) + court-prep. */
export async function applyVaultSchema(exec) {
  await applyPhase1Schema(exec);
  await applyFtsSchema(exec);
  await applyNoticedSchema(exec);
  await applyReturnSchema(exec);
  await applyProgressSchema(exec);
  await applyColdAskSchema(exec);
  await applyDraftsSchema(exec);
  await applyDraftGradeSchema(exec);
  await applyCourtPrepSchema(exec);
  await applyParentingPlanSchema(exec);
  await applyProcessTranslatorSchema(exec);
  await applyInvolvementSchema(exec);
  await applyLegalIntakeSchema(exec);
  await applyAuthRlsSchema(exec);
  await applyExportDeleteSchema(exec);
  await applyEvidenceSchema(exec);
}
