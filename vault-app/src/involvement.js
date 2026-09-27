// Involvement Cheat Sheet (Slice 16) — a living one-pager per dad per kid.
//
// Three jobs:
//   1. Deposition armor — the dad knows his kid's basics cold.
//   2. Blanks = gatekeeping evidence — a blank he ASKED for is logged as a
//      documentable pattern: who was asked, when, what came back. Behavior
//      only. Never why; never a motive word.
//   3. Re-engagement — each blank has one plain next step to fill it,
//      usually straight from the school or provider.
//
// ADHD default: one Missing + one Next. The whole sheet is never spoken.
// Every value is dad-entered: a claim, not verified. No SSNs (stripPii),
// no money amounts, no contact numbers. Deterministic; no LLM.
// Not Stan/OFW, not Parenting Plan, not Process Translator, not Coach,
// not Quill.

import { stripPii } from "./pii.js";

export const CLAIM_FOOTER =
  "Dad-entered. Claim, not verified — confirm with the school or provider before relying on any line.";

export const MAX_VALUE = 200;
export const MAX_KIDS = 6;

// Finite field set, easiest → hardest to find out. `source` is who to ask
// directly (re-engagement); `find` is the plain ask.
export const FIELDS = [
  { key: "grade", label: "Grade", source: "the school office", find: "what grade they're in" },
  { key: "teacher", label: "Teacher", source: "the school office or the school portal", find: "their teacher's name" },
  { key: "activities", label: "Activities", source: "the coach, club, or program", find: "what activities they're in and when" },
  { key: "friends", label: "Friends", source: "your kid, at pickup or dinner", find: "who their close friends are" },
  { key: "doctor", label: "Doctor", source: "your insurance card or the pediatrician's office", find: "who their doctor is" },
  { key: "dentist", label: "Dentist", source: "your insurance or the dental office", find: "who their dentist is" },
  { key: "allergies", label: "Allergies", source: "the doctor's office or the school nurse", find: "any allergies (or \"none\")" },
  { key: "meds", label: "Medications", source: "the doctor's office or the pharmacy", find: "any medications (or \"none\")" },
  { key: "therapist", label: "Therapist / counselor", source: "the school counselor or the provider", find: "whether they see a therapist or counselor (or \"none\")" },
  {
    key: "emergency_contact_known",
    label: "Emergency contact on file",
    source: "the school office",
    find: "whether you're listed as an emergency contact at school",
    options: ["yes", "no"],
  },
];

export const FIELD_KEYS = FIELDS.map((f) => f.key);

export const ASKED_VIA = {
  co_parent: "the other parent",
  school: "the school",
  provider: "the provider",
  in_person: "in person",
  other: "another channel",
};

export const OUTCOMES = { no_answer: "no answer", declined: "request declined" };

export function fieldDef(key) {
  return FIELDS.find((f) => f.key === key) ?? null;
}

const KID_RE = /^[a-z0-9_-]{1,24}$/;
const MONEY_RE = /\$\s?\d|\b\d+(?:\.\d{2})?\s?(?:usd|dollars|bucks)\b|\b(balance|paycheck|salary|income|owed|owes)\b/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bad(msg) {
  return Object.assign(new Error(msg), { status: 400 });
}

export function checkKid(kid) {
  if (typeof kid !== "string" || !KID_RE.test(kid)) {
    throw bad("kid must be a short label: lowercase letters, digits, - or _ (max 24) — not a full name");
  }
  return kid;
}

/**
 * Validate one field update. Either a value, or an ask record
 * {asked_on, asked_via, outcome}. Returns a clean patch.
 */
export function checkFieldUpdate({ field, value, asked_on, asked_via, outcome }) {
  const def = fieldDef(field);
  if (!def) throw bad("unknown field");
  const hasValue = value !== undefined && value !== null;
  const hasAsk = asked_on !== undefined || asked_via !== undefined || outcome !== undefined;
  if (hasValue === hasAsk) throw bad("send a value, or an ask (asked_on, asked_via, outcome) — not both");

  if (hasValue) {
    if (typeof value !== "string" || !value.trim()) throw bad("value must be text");
    if (value.length > MAX_VALUE) throw bad(`value is too long (max ${MAX_VALUE})`);
    if (MONEY_RE.test(value)) throw bad("no money or financial details on the cheat sheet");
    let clean = stripPii(value.trim()).text;
    if (def.options) {
      clean = clean.toLowerCase();
      if (!def.options.includes(clean)) throw bad(`value must be one of: ${def.options.join(", ")}`);
    }
    return { field, patch: { value: clean } };
  }

  if (typeof asked_on !== "string" || !DATE_RE.test(asked_on) || Number.isNaN(Date.parse(asked_on))) {
    throw bad("asked_on must be YYYY-MM-DD");
  }
  if (!(asked_via in ASKED_VIA)) throw bad(`asked_via must be one of: ${Object.keys(ASKED_VIA).join(", ")}`);
  if (!(outcome in OUTCOMES)) throw bad(`outcome must be one of: ${Object.keys(OUTCOMES).join(", ")}`);
  return { field, patch: { asked_on, asked_via, outcome } };
}

// 'filled' | 'asked' (blank, but asked for — pattern evidence) | 'blank'.
// "No" on emergency_contact_known is still a blank: he isn't on file.
export function fieldStatus(row) {
  const filled = row.value != null && !(row.field_key === "emergency_contact_known" && row.value === "no");
  if (filled) return "filled";
  return row.asked_on ? "asked" : "blank";
}

/** Pattern line for an asked-for blank. Behavior only — never why. */
export function patternLine(row, today) {
  const def = fieldDef(row.field_key);
  const via = ASKED_VIA[row.asked_via] ?? "another channel";
  if (row.outcome === "declined") {
    return `${def.label}: asked ${via} on ${row.asked_on}; request declined.`;
  }
  return `${def.label}: asked ${via} on ${row.asked_on}; no answer as of ${today}.`;
}

/**
 * The ONE Missing + ONE Next. Missing = first not-filled field in order
 * (never-asked blanks first, then asked blanks). Next = one action.
 */
export function missingNext(rows, today) {
  const ordered = rows.slice().sort((a, b) => a.position - b.position);
  const blanks = ordered.filter((r) => fieldStatus(r) === "blank");
  const asked = ordered.filter((r) => fieldStatus(r) === "asked");
  const row = blanks[0] ?? asked[0] ?? null;
  const left = blanks.length + asked.length;

  if (!row) {
    return {
      missing: null,
      next: {
        job: "deposition_armor",
        line: "Your sheet is full. Read it out loud once this week — know it cold.",
      },
      left: 0,
    };
  }
  const def = fieldDef(row.field_key);
  const missing = { kid: row.kid_key, field: row.field_key, label: def.label, status: fieldStatus(row) };
  if (missing.status === "blank") {
    return {
      missing,
      next: {
        job: "re_engagement",
        line: `Find out ${def.find}. Ask ${def.source} directly. If you ask and don't get it, log the ask here.`,
      },
      left,
    };
  }
  return {
    missing,
    next: {
      job: "gatekeeping_log",
      line: `Logged: ${patternLine(row, today)} Next, ask ${def.source} directly.`,
    },
    left,
  };
}

/** One-pager export for a kid. Pure; deterministic for (rows, today). */
export function renderOnePager(kid, rows, today) {
  const ordered = rows.slice().sort((a, b) => a.position - b.position);
  const lines = [
    `INVOLVEMENT CHEAT SHEET — ${kid}`,
    `As of ${today}. Know these cold.`,
    "",
  ];
  for (const r of ordered) {
    const def = fieldDef(r.field_key);
    const st = fieldStatus(r);
    if (st === "filled") lines.push(`${def.label}: ${r.value}`);
    else if (st === "asked") lines.push(`${def.label}: (blank — asked, see pattern below)`);
    else lines.push(`${def.label}: (blank — not asked yet)`);
  }
  const asked = ordered.filter((r) => fieldStatus(r) === "asked");
  if (asked.length) {
    lines.push("", "Documentable pattern (behavior only):");
    for (const r of asked) lines.push(`- ${patternLine(r, today)}`);
    lines.push(`${asked.length} of ${ordered.length} basics asked for and not received.`);
  }
  lines.push("", CLAIM_FOOTER);
  return lines.join("\n");
}
