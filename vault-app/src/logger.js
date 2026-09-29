// Hygiene logger — the ONLY logging surface in the vault app.
//
// Rail (§2, §9): logs carry IDs and event refs only. Never message bodies,
// kid names, amounts, audio, or transcripts. Callers must pass only ids,
// counts, and table names; this module additionally refuses free text by
// accepting structured fields, not a message string.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const captured = [];
let logFilePath = null;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TOKEN_RE = /dde-stub-\S+/gi;

// Slice 20 masking: a dad_id or a token never appears in full anywhere a
// human reads — only its last 4 characters (credit-card style). Applied
// centrally so no call site can forget.
export function mask(value) {
  return String(value ?? "")
    .replace(TOKEN_RE, (m) => `…${m.slice(-4)}`)
    .replace(UUID_RE, (m) => `…${m.slice(-4)}`);
}

// fields: an object of { key: id | number | short enum }. Rendered as
// key=value pairs. No field value may exceed 64 chars — anything longer is
// a body sneaking in, and we drop it rather than log it.
export function log(op, fields = {}) {
  const parts = [op];
  for (const [k, v] of Object.entries(fields)) {
    const rendered = mask(Array.isArray(v) ? v.join(",") : String(v));
    if (rendered.length > 64) continue; // never log long free text
    parts.push(`${k}=${rendered}`);
  }
  const line = parts.join(" ");
  captured.push(line);
  if (logFilePath) {
    mkdirSync(dirname(logFilePath), { recursive: true });
    appendFileSync(logFilePath, line + "\n");
  }
}

export function setLogFile(path) {
  logFilePath = path;
}

export function lines() {
  return [...captured];
}

export function reset() {
  captured.length = 0;
}
