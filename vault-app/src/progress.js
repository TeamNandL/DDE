// Soft progress — this-week checklist rails + plain-speech lines.
//
// Rails (slice: soft progress + short checklist):
//   * this_week_total clamps to 3..7 — small enough to finish, never a
//     backlog. this_week_done clamps to 0..total.
//   * missing[] stays SHORT: at most 7 items, each at most 80 chars.
//   * Lines are Chip speech: plain words, PII-stripped, no token/URL —
//     and never shame. Nothing to say → null, never invented.

import { stripPii } from "./pii.js";

export const WEEK_TOTAL_MIN = 3;
export const WEEK_TOTAL_MAX = 7;
export const MISSING_MAX_ITEMS = 7;
export const MISSING_ITEM_MAX_CHARS = 80;

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Normalize a PUT /vault/state patch in one place (both stores go through
 * the BFF). Fields absent from the patch stay absent — untouched fields
 * are never rewritten.
 *
 * Chip-safety: the free-text fields (this_week, next_action, missing[])
 * are SPOKEN back — next_action is the One Next, missing feeds
 * /vault/progress missing_one — so PII is stripped at this write path,
 * same rule as intake.
 */
export function clampProgressPatch(patch = {}) {
  const out = { ...patch };

  for (const field of ["this_week", "next_action"]) {
    if (typeof out[field] === "string") {
      out[field] = stripPii(out[field]).text;
    }
  }

  // Cold-ask hook: both fields are Chip speech, so PII-stripped and short.
  // Empty after stripping/trimming → stored as null, never "".
  if (typeof out.last_next_kind === "string") {
    out.last_next_kind = stripPii(out.last_next_kind).text.trim().slice(0, 40) || null;
  }
  if (typeof out.last_ask_summary === "string") {
    out.last_ask_summary = stripPii(out.last_ask_summary).text.trim().slice(0, 120) || null;
  }

  if (out.this_week_total !== undefined && out.this_week_total !== null) {
    const total = toInt(out.this_week_total);
    if (total === null) {
      delete out.this_week_total;
    } else {
      out.this_week_total = Math.min(WEEK_TOTAL_MAX, Math.max(WEEK_TOTAL_MIN, total));
    }
  }

  if (out.this_week_done !== undefined && out.this_week_done !== null) {
    const done = toInt(out.this_week_done);
    if (done === null) {
      delete out.this_week_done;
    } else {
      const cap = out.this_week_total ?? WEEK_TOTAL_MAX;
      out.this_week_done = Math.min(cap, Math.max(0, done));
    }
  }

  if (Array.isArray(out.missing)) {
    out.missing = out.missing
      .map((m) => stripPii(String(m ?? "")).text.trim())
      .filter(Boolean)
      .map((m) => m.slice(0, MISSING_ITEM_MAX_CHARS))
      .slice(0, MISSING_MAX_ITEMS);
  }

  return out;
}

/** "3 of 5 this week" — null until both counters exist (never invented). */
export function progressLine(state) {
  const done = state?.this_week_done;
  const total = state?.this_week_total;
  if (done === null || done === undefined || total === null || total === undefined) {
    return null;
  }
  return stripPii(`${done} of ${total} this week`).text;
}

/**
 * The ONE ADHD-short progress line for Chip:
 *   "3 of 5 this week"                              (counters only)
 *   "3 of 5 this week; still open: pull OFW thread" (+ first open item)
 *   null                                            (no counters — never
 *                                                    invent, never shame;
 *                                                    missing alone is not
 *                                                    a counter line)
 * PII-stripped end to end; at most one open item is ever spoken.
 */
export function progressChipLine(state) {
  const line = progressLine(state);
  if (!line) return null;
  const first = state?.missing?.[0];
  if (first) {
    const one = stripPii(String(first)).text.trim();
    if (one) return stripPii(`${line}; still open: ${one}`).text;
  }
  return line;
}

// Soft grade — one warm line about the last action. Encouragement only:
// no counts of what's missing, no "only", no "behind", no shame. Null when
// there is nothing to grade.
export function softGrade(state) {
  const done = state?.this_week_done ?? null;
  const total = state?.this_week_total ?? null;
  const cameBack = Boolean(state?.last_next);

  let line = null;
  if (total !== null && done !== null && done >= total) {
    line = "That's the week's list done — steady work like this reads well later.";
  } else if (cameBack) {
    line = "You came back and closed the loop on the last one — that counts.";
  } else if (done !== null && done > 0) {
    line = "Progress logged — small steps hold up.";
  } else if (total !== null) {
    line = "Fresh list this week — one small step is a win.";
  }
  return line === null ? null : stripPii(line).text;
}
