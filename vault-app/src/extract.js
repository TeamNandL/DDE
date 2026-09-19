// The middle layer — the only custom code (§4).
//
// extract(vault, dad_id, text, opts) -> { written, chase }
//
//   1. harm_check(text)   -> harm detected: return {written: 0}, log NOTHING,
//                            retain NOTHING (short-circuits before any parse)
//   2. strip_venom(text)  -> drop characterizations of the co-parent;
//                            keep facts and requests
//   3. extract_fields     -> event_type, occurred_at, scheduled_at, location,
//                            kids, notes (observable only)
//   4. tag_pipe           -> 'claim', always, for spoken/typed input
//   5. write              -> one row per extracted event;
//                            raw_quote = original minus harm/venom
//   6. claim_chase        -> a count/frequency claim becomes a state.missing
//                            verify item — the number itself is never stored
//
// Deterministic, rule-based, sized to the fixed vent (§6). The LLM engine
// test comes after the vault holds — not Phase 1.

import { log } from "./logger.js";

// ---------------------------------------------------------------------------
// 1. harm_check — first, before anything is parsed or logged.
// A hit short-circuits the whole call: zero rows, zero log lines, zero
// retention of the input.
const HARM_PATTERNS = [
  /\b(kill|hurt|harm|beat|strangle|choke|shoot|stab|attack)\b[^.!?]{0,60}\b(her|him|them|myself|jordan|the kids?)\b/i,
  /\bmake\s+(her|him|jordan)\s+(pay|suffer|regret)\b/i,
  /\b(end it all|not want to be here anymore|better off without me)\b/i,
  /\b(hurt|kill)ing?\s+(myself|herself|himself)\b/i,
];

export function harmCheck(text) {
  return HARM_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// 2. strip_venom — characterizations of the co-parent are never stored.
// A sentence containing a characterization is dropped whole: intent-reading
// and name-calling are not separable facts.
const VENOM_PATTERNS = [
  /\b(spiteful|vindictive|toxic|evil|crazy|psycho|unstable|narcissis\w*|manipulat\w*|liar|lying|destroying|ruining|sabotag\w*)\b/i,
  /\bon purpose\b/i,
  /\bdoing this to (me|us)\b/i,
];

export function stripVenom(text) {
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  return sentences
    .filter((s) => !VENOM_PATTERNS.some((re) => re.test(s)))
    .map((s) => s.trim())
    .join(" ")
    .trim();
}

// ---------------------------------------------------------------------------
// 6 (detection). Count/frequency claims — chased, never stored.
const COUNT_CLAIM =
  /\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|\d+(?:st|nd|rd|th)?)\s+time\b[^.!?]*/i;

function detectCountClaim(text) {
  return COUNT_CLAIM.test(text);
}

// ---------------------------------------------------------------------------
// 3. extract_fields — deterministic rules sized to the fixed vent.
const KNOWN_KIDS = ["Sam", "Taylor"]; // fake family only (§2)

function parseClockTime(s) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(s);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  // Bare hours in exchange talk ("until 6:45") inherit the scheduled side
  // of the day: treat 1–11 with no am/pm as pm.
  if (!ampm && hour >= 1 && hour <= 11) hour += 12;
  return { hour, minute };
}

function atTime(referenceDate, clock) {
  const d = new Date(referenceDate);
  d.setHours(clock.hour, clock.minute, 0, 0);
  return d.toISOString();
}

export function extractFields(text, { referenceDate }) {
  const events = [];
  const lower = text.toLowerCase();

  const mentionsExchange = /\bexchange\b/.test(lower);
  const late =
    /\b(late|didn'?t show(?: up)?\s+until|not\s+until)\b/.test(lower);
  const denied =
    /\b(denied|refused|wouldn'?t let|didn'?t let|no[- ]showed|never showed)\b/.test(lower);

  let event_type = null;
  if (mentionsExchange && denied) event_type = "denied_visit";
  else if (mentionsExchange && late) event_type = "late_exchange";
  else if (mentionsExchange) event_type = "exchange";
  else if (denied) event_type = "denied_visit";
  else if (/\bvisit\b/.test(lower)) event_type = "visit";
  else if (/\b(call|phone)\b/.test(lower)) event_type = "call";

  if (!event_type) return events;

  const schedMatch = /\b(?:supposed to(?:\s+\w+){0,4}?\s+at|scheduled(?:\s+for)?)\s+([\d:]+\s*(?:am|pm)?)/i.exec(text);
  const actualMatch = /\b(?:until|showed(?:\s+up)?\s+at|arrived(?:\s+at)?)\s+([\d:]+\s*(?:am|pm)?)/i.exec(text);
  const locMatch = /\bat the ([A-Z][\w' ]*?(?:lot|park|school|house|center|court|library|station))\b/i.exec(text);

  const scheduledClock = schedMatch ? parseClockTime(schedMatch[1]) : null;
  const actualClock = actualMatch ? parseClockTime(actualMatch[1]) : null;

  const scheduled_at = scheduledClock ? atTime(referenceDate, scheduledClock) : null;
  const occurred_at = actualClock
    ? atTime(referenceDate, actualClock)
    : scheduled_at ?? new Date(referenceDate).toISOString();

  const kids = KNOWN_KIDS.filter((k) => new RegExp(`\\b${k}\\b`).test(text));

  // notes: observable description only — times, place, who was present.
  // No characterization of the co-parent, no counts.
  const noteParts = [];
  if (scheduledClock) {
    noteParts.push(
      `Exchange scheduled for ${fmtClock(scheduledClock)}${locMatch ? ` at ${locMatch[1]}` : ""}.`,
    );
  }
  if (actualClock) {
    const lateMin =
      scheduledClock !== null
        ? actualClock.hour * 60 + actualClock.minute - (scheduledClock.hour * 60 + scheduledClock.minute)
        : null;
    noteParts.push(
      `Co-parent arrived ${fmtClock(actualClock)}${lateMin && lateMin > 0 ? ` (${lateMin} minutes after scheduled time)` : ""}.`,
    );
  }
  if (kids.length) noteParts.push(`Children present: ${kids.join(", ")}.`);

  events.push({
    event_type,
    occurred_at,
    scheduled_at,
    location: locMatch ? locMatch[1] : null,
    kids,
    notes: noteParts.join(" ") || null,
  });
  return events;
}

function fmtClock({ hour, minute }) {
  const h12 = ((hour + 11) % 12) + 1;
  const ampm = hour >= 12 ? "pm" : "am";
  return `${h12}:${String(minute).padStart(2, "0")}${ampm}`;
}

function monthName(referenceDate) {
  return new Date(referenceDate).toLocaleString("en-US", { month: "long" });
}

// ---------------------------------------------------------------------------
// The pipeline.
export function extract(vault, dadId, text, opts = {}) {
  const referenceDate = opts.referenceDate ?? new Date();

  // 1. harm check FIRST. Nothing parsed, nothing logged, nothing retained.
  if (harmCheck(text)) {
    return { written: 0, chase: [] };
  }

  // 2. venom out. raw_quote = original text minus harm/venom (§4) — the
  // dad's own words survive on the claim pipe, count claims included. The
  // count is never written as a structured field or a verified row; the
  // chase item below is what the record keeps of it.
  const cold = stripVenom(text);

  // 3. fields from the venom-free text. notes/location/kids/times are
  // constructed observable fields — a count claim never lands in them.
  const fields = extractFields(cold, { referenceDate });

  // 4 + 5. tag claim, one row per event.
  const rows = fields.map((f) =>
    vault.insertEvent(dadId, {
      ...f,
      pipe: "claim", // Intake writes claim ONLY (§3 events rule)
      raw_quote: cold,
    }),
  );

  // 6. claim chase — the verify item, never the number.
  const chase = [];
  if (detectCountClaim(text)) {
    const item = `verify count in OFW record for ${monthName(referenceDate)}`;
    vault.appendMissing(dadId, item);
    chase.push(item);
  }

  log("intake.extract", {
    dad: dadId,
    written: rows.length,
    refs: rows.map((r) => r.id),
    chase: chase.length,
  });

  return { written: rows.length, chase };
}
