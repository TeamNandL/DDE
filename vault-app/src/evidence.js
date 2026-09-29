// Evidence capture skeleton (Slice 23).
//
// Client hash → logged + inbox_unmapped. Guess comes from the filename and
// format string only, and only at confidence "low". No file content, no
// vent text, no OCR, no verified promotion.

export const EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_STAGE = "logged";
export const EVIDENCE_ROUTING = "inbox_unmapped";
export const POSSESSIONS = ["held", "not located", "user says none"];

const HASH_RE = /^[0-9a-f]{64}$/;
const FORMAT_RE = /^[a-z0-9][a-z0-9.+/-]{0,63}$/i;
const ALLOWED = new Set(["dad_id", "hash", "original_filename", "format", "possession"]);

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * Low-confidence type guess from the name and format token only.
 * No match → both fields null. Never returns high / verified.
 */
export function guessDocType({ original_filename, format } = {}) {
  const name = String(original_filename || "").toLowerCase();
  const fmt = String(format || "").toLowerCase().trim().replace(/^\./, "");
  let guess = null;
  if (/statement|paystub|pay-stub|paycheck/.test(name)) guess = "statement";
  else if (/tax|1040|w-?2|1099/.test(name)) guess = "tax_return";
  else if (/screenshot|screen[-_ ]?shot/.test(name)) guess = "screenshot";
  else if (/\bcourt\b|subpoena|summons|\bmotion\b|decree|judgment|judgement/.test(name)) guess = "court";
  else if (/^image\//.test(fmt) || /^(jpe?g|png|gif|webp|heic|heif)$/.test(fmt) || /\.(jpe?g|png|gif|webp|heic|heif)$/.test(name)) {
    guess = "photo";
  }
  if (!guess) return { doc_type_guess: null, doc_type_confidence: null };
  return { doc_type_guess: guess, doc_type_confidence: "low" };
}

function optionalFilename(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw bad("original_filename must be a string");
  const name = v.trim();
  if (!name) return null;
  if (name.length > 255) throw bad("original_filename is too long");
  if (/[\u0000-\u001f]/.test(name)) throw bad("original_filename must not contain control characters");
  return name;
}

function optionalFormat(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw bad("format must be a string");
  const fmt = v.trim();
  if (!fmt) return null;
  if (!FORMAT_RE.test(fmt)) throw bad("format must be a short type token");
  return fmt;
}

/** Validate a log body. Unknown keys (bytes, text, stage, …) are refused. */
export function buildEvidenceInsert(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("invalid json");
  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) throw bad(`unknown field: ${key}`);
  }
  if (typeof body.hash !== "string" || !HASH_RE.test(body.hash.trim().toLowerCase())) {
    throw bad("hash must be a sha256 hex digest");
  }
  let possession = "held";
  if (body.possession !== undefined && body.possession !== null && body.possession !== "") {
    if (typeof body.possession !== "string" || !POSSESSIONS.includes(body.possession)) {
      throw bad("possession must be held, not located, or user says none");
    }
    possession = body.possession;
  }
  const original_filename = optionalFilename(body.original_filename);
  const format = optionalFormat(body.format);
  return {
    hash: body.hash.trim().toLowerCase(),
    schema_version: EVIDENCE_SCHEMA_VERSION,
    stage: EVIDENCE_STAGE,
    routing: EVIDENCE_ROUTING,
    possession,
    original_filename,
    format,
    needs_ocr: false,
    ...guessDocType({ original_filename, format }),
  };
}

function iso(v) {
  if (v instanceof Date) return v.toISOString();
  return v ?? null;
}

/** Dad-facing row. verified is always false — this table cannot promote. */
export function toEvidenceLog(row, opts = {}) {
  const out = {
    id: row.id,
    hash: row.hash,
    schema_version: Number(row.schema_version),
    stage: row.stage,
    routing: row.routing,
    possession: row.possession,
    doc_type_guess: row.doc_type_guess ?? null,
    doc_type_confidence: row.doc_type_confidence ?? null,
    original_filename: row.original_filename ?? null,
    format: row.format ?? null,
    needs_ocr: row.needs_ocr === true,
    created_at: iso(row.created_at),
    verified: false,
  };
  if ("duplicate" in opts) out.duplicate = opts.duplicate === true;
  return out;
}
