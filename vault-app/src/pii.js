// PII strip — deterministic Phase-1 redaction (statement → notice slice).
//
//   stripPii(text) -> { text, counts }
//
// Redacts, in order: emails, SSN/EIN tax ids, labeled account/routing
// numbers, kid school ids, phones, numbered street addresses, and bare
// 8–17 digit runs (unlabeled account/routing shapes).
//
// Keeps observable facts on purpose: dates, clock times ("6:45", "6pm"),
// dollar amounts ("$30"), denied/cancelled/late wording, and unnumbered
// place names ("the Maple Street parking lot" is a location, not an
// address — the address rule requires a leading house number).
//
// The matched PII values never leave this function. Callers may keep the
// redaction COUNTS only — never the stripped values — and logger.js
// refuses long free text anyway.

// Order matters: labeled/state-specific shapes first, generic digit runs last.
const RULES = [
  {
    key: "email",
    token: "[email]",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    // SSN 123-45-6789, then EIN 12-3456789. A date like 2026-09-14 never
    // matches: its digit groups are 4-2-2 and \b cannot fall between digits.
    key: "tax_id",
    token: "[tax-id]",
    re: /\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b/g,
  },
  {
    // "account #12345678", "routing 021000021", "checking no. 4432-9987"
    key: "account",
    token: "$1$2[account]",
    re: /\b(acct|account|routing|aba|checking|savings)(\s*(?:#|no\.?|num(?:ber)?)?\s*:?\s*)(\d[\d -]{4,20}\d)/gi,
  },
  {
    // "student ID S-4482", "school id 88-4521"
    key: "school_id",
    token: "$1$2[school-id]",
    re: /\b(student|school)(\s*(?:id)?\s*(?:#|no\.?|num(?:ber)?)?\s*:?\s*)([A-Za-z]{0,2}-?\d[\w-]{2,})/gi,
  },
  {
    // (904) 555-1212 / 904-555-1212 / +1 904.555.1212. Separators are
    // required, so clock times ("6:45") and counts never match.
    key: "phone",
    token: "[phone]",
    re: /(?:\+?1[-. ]?)?\(\d{3}\)[-. ]?\d{3}[-. ]?\d{4}\b|\b(?:\+?1[-. ])?\d{3}[-. ]\d{3}[-. ]\d{4}\b/g,
  },
  {
    // Numbered street address (+ optional unit). Requires the house number:
    // "482 Maple Street Apt 3" is stripped; "the Maple Street parking lot"
    // (event location, no number) is kept.
    key: "address",
    token: "[address]",
    re: /\b\d{1,5}\s+(?:[A-Z][A-Za-z']*\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Court|Ct|Circle|Cir|Place|Pl|Way|Terrace|Ter|Trail|Trl)\b\.?(?:,?\s*(?:Apt|Apartment|Suite|Ste|Unit|#)\.?\s*\w+)?/g,
  },
  {
    // Bare 8–17 digit run: unlabeled account/routing/member numbers.
    // Short enough facts (years, times, "$30", day-of-month) never reach 8.
    key: "account",
    token: "[account]",
    re: /\b\d{8,17}\b/g,
  },
];

export function stripPii(text) {
  let out = String(text ?? "");
  const counts = {};
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args) => {
      counts[rule.key] = (counts[rule.key] ?? 0) + 1;
      if (!rule.token.includes("$")) return rule.token;
      // Labeled rules keep the label ($1) and spacing ($2), drop the value.
      return rule.token.replace("$1", args[1]).replace("$2", args[2]);
    });
  }
  return { text: out, counts };
}

export function piiTotal(counts) {
  return Object.values(counts ?? {}).reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// buildNoticeText(event) -> cold, court-safe notice string.
//
// Observable fields only: event type, date, scheduled time, location, and
// the constructed notes (already characterization-free from extract.js).
// Ends with the claim-status line — a noticed row is still pipe='claim'
// until verified, and the notice string says so. The whole string passes
// through stripPii as a final guarantee.

const EVENT_LABELS = {
  denied_visit: "Denied or cancelled visit",
  late_exchange: "Late exchange",
  exchange: "Exchange",
  visit: "Visit",
  call: "Call",
  other: "Parenting-time event",
};

function isoDay(v) {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
}

export function buildNoticeText(event) {
  // Statement drops: the notes already ARE the one cold sentence — no
  // parenting-time heading (wrong label, duplicate date), never receipt
  // tone.
  if (/^Statement\b/.test(event.notes ?? "")) {
    return stripPii(
      `${event.notes} This entry is recorded as a parent statement (claim); verification against the record is pending.`,
    ).text;
  }
  const label = EVENT_LABELS[event.event_type] ?? "Parenting-time event";
  const parts = [`${label} on ${isoDay(event.occurred_at)}.`];
  if (event.notes) {
    parts.push(String(event.notes));
  } else if (event.location) {
    parts.push(`Location: ${event.location}.`);
  }
  parts.push(
    "This entry is recorded as a parent statement (claim); verification against the record is pending.",
  );
  return stripPii(parts.join(" ")).text;
}
