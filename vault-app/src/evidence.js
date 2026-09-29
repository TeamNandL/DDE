// Slice 23 — evidence skeleton.
//
// Hash-only log. A vent is not evidence. A filename is a low-confidence
// guess (basename only, PII stripped), never a document type and never bytes.

import { stripPii } from "./pii.js";

const SHA256_RE = /^[0-9a-f]{64}$/;

// Row shape pin. Every create writes this; the column CHECK refuses anything else.
export const SCHEMA_VERSION = 1;

// Where the original file is. The vault never holds the bytes.
export const POSSESSIONS = ["held", "not located", "user says none"];

// Shape of a vent / intake payload. Presence is enough — the log refuses it.
const VENT_KEYS = ["text", "vent", "story", "raw_quote", "body", "body_cold", "notes"];

// Anything that would carry file contents. The log stores a digest only.
const BYTE_KEYS = ["bytes", "bytea", "content", "contents", "data", "file", "blob", "base64", "raw", "payload"];

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

export function normalizeSha256(value) {
  if (typeof value !== "string") throw bad("sha256 is required and must be a 64-character hex hash");
  const sha = value.trim().toLowerCase();
  if (!SHA256_RE.test(sha)) throw bad("sha256 is required and must be a 64-character hex hash");
  return sha;
}

/**
 * Basename only, then the vault PII strip (emails, SSN/EIN, phones, and
 * the other shapes stripPii already redacts). Confidence is always "low"
 * when a guess is kept — the name is not the file, and this path never
 * reads bytes.
 * @returns {{ filename_guess: string|null, filename_confidence: "low"|null }}
 */
export function filenameGuess(filename) {
  if (filename == null || filename === "") {
    return { filename_guess: null, filename_confidence: null };
  }
  if (typeof filename !== "string") throw bad("filename must be a string");
  const base = filename.replaceAll("\\", "/").split("/").pop().replaceAll("\0", "").trim();
  if (!base || base === "." || base === "..") {
    return { filename_guess: null, filename_confidence: null };
  }
  const stripped = stripPii(base).text.replaceAll("\0", "").trim();
  if (!stripped || stripped === "." || stripped === "..") {
    return { filename_guess: null, filename_confidence: null };
  }
  if (stripped.length > 180) throw bad("filename must be at most 180 characters");
  return { filename_guess: stripped, filename_confidence: "low" };
}

/** Validate a log body. Returns the row fields the vault may store. */
export function prepareEvidenceLog(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("evidence log body must be an object");
  for (const key of VENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) throw bad("vent is not evidence");
  }
  for (const key of BYTE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) throw bad("evidence log stores a hash only — no bytes");
  }
  if (Object.prototype.hasOwnProperty.call(body, "stage") && body.stage != null && body.stage !== "logged") {
    throw bad("stage must be logged");
  }
  if (Object.prototype.hasOwnProperty.call(body, "routing") && body.routing != null && body.routing !== "inbox_unmapped") {
    throw bad("routing must be inbox_unmapped");
  }
  if (
    Object.prototype.hasOwnProperty.call(body, "filename_confidence") &&
    body.filename_confidence != null &&
    body.filename_confidence !== "low"
  ) {
    throw bad("filename confidence stays low");
  }
  if (body.sha256 != null && body.hash != null && String(body.sha256).trim().toLowerCase() !== String(body.hash).trim().toLowerCase()) {
    throw bad("sha256 and hash must match");
  }
  if (
    Object.prototype.hasOwnProperty.call(body, "schema_version") &&
    body.schema_version != null &&
    Number(body.schema_version) !== SCHEMA_VERSION
  ) {
    throw bad("schema_version must be 1");
  }
  let possession = "held";
  if (body.possession != null && body.possession !== "") {
    if (typeof body.possession !== "string" || !POSSESSIONS.includes(body.possession)) {
      throw bad("possession must be held, not located, or user says none");
    }
    possession = body.possession;
  }
  return {
    sha256: normalizeSha256(body.sha256 ?? body.hash),
    schema_version: SCHEMA_VERSION,
    possession,
    stage: "logged",
    routing: "inbox_unmapped",
    ...filenameGuess(body.filename),
  };
}

export function publicEvidence(row, extra = {}) {
  const created_at = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  return {
    id: row.id,
    sha256: row.sha256,
    stage: row.stage,
    routing: row.routing,
    filename_guess: row.filename_guess ?? null,
    filename_confidence: row.filename_confidence ?? null,
    schema_version: Number(row.schema_version),
    possession: row.possession,
    created_at,
    ...extra,
  };
}
