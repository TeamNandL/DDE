// Evidence capture SKELETON (Slice 23) — hash-log → inbox_unmapped.
//
// Pure helpers, no I/O. What this slice IS: the client hashes a file, POSTs
// the hash + a filename/mime, the vault logs one row with a LOW-confidence
// kind guess, stage 'logged', routing 'inbox_unmapped'. What it is NOT:
// upload, storage, OCR, mapping to a requirement, page ranges, Exhibit.
//
// Rails (Nick lock 2026-09-28):
//   * OCR is never truth. No OCR worker. `needs_ocr` is a flag the client
//     may set; absent → false. Nothing here reads a file.
//   * Vent ≠ evidence. This module never sees vent text; POST /vault/intake
//     is untouched and never writes an evidence row.
//   * Figures owns evidence doctrine. The kind guess reuses the existing
//     documents doc_type vocabulary — no new taxonomy is invented here.
//   * Exhibit = verified-only. A hash-log row is a claim (claim_status
//     'claim', confidence 'low') and never appears in verified_export.

import { stripPii } from "./pii.js";

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const KINDS = ["statement", "tax_return", "photo", "screenshot", "court", "other"];
export const STAGE = "logged";
export const ROUTING = "inbox_unmapped";
export const CONFIDENCE = "low";
export const SCHEMA_VERSION = 1;
export const MAX_FILENAME = 255;
export const MAX_MIME = 128;

// The ONE line Chip says after a log. Plain speech: logged ≠ filed ≠ proof,
// and exactly one Next. No token, URL, hash or dad_id.
export const LOGGED_SAY = "Logged. It sits in your unsorted inbox — not filed, not proof yet. Next: keep the original file safe.";
export const DUPLICATE_SAY = "Already logged. Same file, same inbox — nothing new kept. Next: keep the original file safe.";

function bad(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

/**
 * Validate + normalize the POST /vault/evidence/log body.
 * sha256: required, 64 hex (any case → lowercase). filename: optional string
 * ≤ 255, PII-stripped. mime: optional string ≤ 128, lowercased. needs_ocr:
 * optional boolean; anything else 400 (never coerced from a string).
 */
export function checkEvidenceLog(body = {}) {
  const raw = typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase() : "";
  if (!SHA256_RE.test(raw)) throw bad("sha256 is required and must be 64 hex characters");

  let filename = null;
  if (body.filename !== undefined && body.filename !== null && body.filename !== "") {
    if (typeof body.filename !== "string") throw bad("filename must be a string");
    const cleaned = stripPii(body.filename.trim()).text;
    if (cleaned.length > MAX_FILENAME) throw bad(`filename must be <= ${MAX_FILENAME} characters`);
    filename = cleaned || null;
  }

  let mime = null;
  if (body.mime !== undefined && body.mime !== null && body.mime !== "") {
    if (typeof body.mime !== "string") throw bad("mime must be a string");
    mime = body.mime.trim().toLowerCase();
    if (mime.length > MAX_MIME || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) {
      throw bad("mime must look like type/subtype");
    }
  }

  let needs_ocr = false;
  if (body.needs_ocr !== undefined && body.needs_ocr !== null) {
    if (typeof body.needs_ocr !== "boolean") throw bad("needs_ocr must be a boolean when present");
    needs_ocr = body.needs_ocr;
  }

  return { sha256: raw, filename, mime, needs_ocr };
}

// Word edges that treat "_" as a separator too ("W2_2025.pdf", "IMG_0412").
const TAX_RE = /(?<![a-z0-9])(1040|w-?2|1099|k-?1|tax|irs)(?![a-z0-9])/i;
const STATEMENT_RE = /(?<![a-z0-9])(statement|stmt|bank|checking|savings|visa|mastercard|amex|card|invoice|receipt|pay ?stub|payroll)(?![a-z0-9])/i;
const COURT_RE = /(?<![a-z0-9])(order|motion|petition|court|hearing|filing|decree|affidavit|summons|judgment|docket)(?![a-z0-9])/i;
const SCREENSHOT_RE = /(?<![a-z0-9])(screen ?shot|screencap|screen ?recording)(?![a-z0-9])/i;
// Camera / phone roll names ("IMG_1099.jpg") are photos, never a tax form.
const CAMERA_RE = /^(img|dsc|dscn|pxl|photo|image)[_-]?\d+\./i;

/**
 * One heuristic, no LLM, no file read: a kind GUESS from filename + mime.
 * Always low confidence — this is a hint for a human, never a fact. Returns
 * { kind_guess, confidence: 'low' }.
 */
export function classifyGuess({ filename, mime } = {}) {
  const name = String(filename ?? "");
  const type = String(mime ?? "").toLowerCase();
  let kind_guess = "other";
  if (CAMERA_RE.test(name)) kind_guess = "photo";
  else if (TAX_RE.test(name)) kind_guess = "tax_return";
  else if (COURT_RE.test(name)) kind_guess = "court";
  else if (STATEMENT_RE.test(name)) kind_guess = "statement";
  else if (SCREENSHOT_RE.test(name)) kind_guess = "screenshot";
  else if (type.startsWith("image/")) kind_guess = "photo";
  return { kind_guess, confidence: CONFIDENCE };
}

/** The dad-facing shape of an evidence row. No bytes, no storage, no map. */
export function publicEvidence(rec, duplicate = false) {
  return {
    id: rec.id,
    created_at: rec.created_at,
    sha256: rec.sha256,
    filename: rec.filename ?? null,
    mime: rec.mime ?? null,
    kind_guess: rec.kind_guess,
    confidence: rec.confidence,
    stage: rec.stage,
    routing: rec.routing,
    needs_ocr: Boolean(rec.needs_ocr),
    schema_version: Number(rec.schema_version),
    claim: true,
    verified: false,
    duplicate,
    say: duplicate ? DUPLICATE_SAY : LOGGED_SAY,
  };
}
