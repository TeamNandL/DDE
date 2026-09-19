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

// fields: an object of { key: id | number | short enum }. Rendered as
// key=value pairs. No field value may exceed 64 chars — anything longer is
// a body sneaking in, and we drop it rather than log it.
export function log(op, fields = {}) {
  const parts = [op];
  for (const [k, v] of Object.entries(fields)) {
    const rendered = Array.isArray(v) ? v.join(",") : String(v);
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
