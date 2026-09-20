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
import { piiTotal, stripPii } from "./pii.js";

// ---------------------------------------------------------------------------
// 1. harm_check — first, before anything is parsed or logged.
// A hit short-circuits the whole call: zero rows, zero log lines, zero
// retention of the input.
// Razor return-harm FAIL taught us the original list was too narrow:
// realistic shapes ("kill that woman", "bringing my gun", "better off
// dead", "want to die", "murder him") all slipped through and got stored
// as claims. The rail's cost asymmetry favors discarding — a false
// discard loses one vent; a false store keeps harm language in the
// record — so these patterns lean wide on harm verbs, targets, weapon
// intent, and self-harm phrasings.
const HARM_PATTERNS = [
  /\b(kill|murder|hurt|harm|beat|strangle|choke|shoot|stab|attack)\b[^.!?]{0,60}\b(her|him|them|myself|jordan|the kids?|that (?:woman|man)|some(?:one|body))\b/i,
  /\bmake\s+(her|him|them|jordan)\s+(pay|suffer|regret)\b/i,
  /\b(end(?:ing)? it all|not want to be here anymore|better off without me|want to die|wanna die|suicid\w*)\b/i,
  /\b(hurt|kill)ing?\s+(myself|herself|himself)\b/i,
  /\bbetter off dead\b/i,
  /\b(bring(?:ing)?|grab(?:bing)?|get(?:ting)?|us(?:e|ing))\s+(?:my|a|the)\s+(gun|knife|weapon|pistol|rifle|bat)\b/i,
  /\bdo something (violent|drastic)\b/i,
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

/** True when the text contains venom the strip would drop (heuristic). */
export function hasVenom(text) {
  return VENOM_PATTERNS.some((re) => re.test(text));
}

export function stripVenom(text) {
  // Guard decimal points ("$1,250.00") from the sentence split — the same
  // mangle once let "dad@example.com" slip past the PII net as
  // "dad@example. com". Restored after the venom filter.
  const guarded = text.replace(/(\d)\.(\d)/g, "$1\u0000$2");
  const sentences = guarded.match(/[^.!?]+[.!?]*/g) ?? [guarded];
  return sentences
    .filter((s) => !VENOM_PATTERNS.some((re) => re.test(s)))
    .map((s) => s.trim())
    .join(" ")
    .trim()
    .replace(/\u0000/g, ".");
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

// ---------------------------------------------------------------------------
// Emotion-notice arm (live-vent gap): pure pain + date vents carry facts too.
// "I miss the kids… since April 19 limited time" has no incident keyword,
// but "limited contact since <date>" and "waiting in an empty house" are
// recordable parent statements. Pain markers gate the arm so ordinary text
// still extracts nothing.
const PAIN_PATTERNS = [
  /\bmiss(?:ing)?\s+(?:the\s+kids?|them|him|her|my\s+(?:kids?|children|son|daughter)|Sam|Taylor)\b/i,
  /\blimited\s+(?:time|contact|visits?|visitation)\b/i,
  /\b(?:haven'?t|have\s+not|barely|hardly)\s+(?:seen|had)\b/i,
  /\bno\s+(?:time|contact|visits?)\s+with\b/i,
  /\b(?:house|home)\s+(?:is|feels)\s+(?:so\s+)?(?:empty|quiet)\b/i,
  /\bempty\s+house\b/i,
  /\bwaiting\s+(?:at\s+home|around|for\s+(?:them|the\s+kids?))\b/i,
];

const MONTH_BY_PREFIX = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * "on 9/12", "for October 3[rd][, 2026]" -> "YYYY-MM-DD" | null.
 * Scheduling/refusal claims (Sweeper NOTICE_POST_GAPS) name the affected
 * date; a FUTURE date is legitimate here — a refused upcoming weekend —
 * so unlike "since" there is no past-guard. Bare month+day takes the
 * reference year.
 */
export function parseMentionedDate(text, referenceDate) {
  const ref = new Date(referenceDate);
  let month = null;
  let day = null;
  let year = null;

  // ISO "2026-09-12" is unambiguous — no on/for prefix required (Razor
  // date gate: "Visit on 2026-09-12 was cancelled").
  let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else {
    m =
      /\b(?:on|for)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i.exec(
        text,
      );
    if (m) {
      month = MONTH_BY_PREFIX[m[1].toLowerCase()];
      day = Number(m[2]);
      year = m[3] ? Number(m[3]) : null;
    } else {
      m = /\b(?:on|for)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/i.exec(text);
      if (m) {
        month = Number(m[1]);
        day = Number(m[2]);
        year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
      }
    }
  }

  if (!month || !day || month > 12 || day > 31) return null;
  if (year === null) year = ref.getFullYear();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * "since April 19[, 2026]" / "since 4/19[/2026]" -> "YYYY-MM-DD" | null.
 * A bare month+day takes the reference year, stepping back one year when
 * that lands in the future — "since April 19" said in February means last
 * April, not the next one.
 */
export function parseSinceDate(text, referenceDate) {
  const ref = new Date(referenceDate);
  let month = null;
  let day = null;
  let year = null;

  let m = /\bsince\s+(\d{4})-(\d{1,2})-(\d{1,2})\b/i.exec(text);
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else {
    m =
      /\bsince\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i.exec(
        text,
      );
    if (m) {
      month = MONTH_BY_PREFIX[m[1].toLowerCase()];
      day = Number(m[2]);
      year = m[3] ? Number(m[3]) : null;
    } else {
      m = /\bsince\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/i.exec(text);
      if (m) {
        month = Number(m[1]);
        day = Number(m[2]);
        year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
      }
    }
  }

  if (!month || !day || month > 12 || day > 31) return null;
  if (year === null) {
    year = ref.getFullYear();
    if (Date.UTC(year, month - 1, day) > ref.getTime()) year -= 1;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Statement arm (statement drop → one noticed sentence): a dropped bank/
// billing statement becomes ONE claim event whose notes ARE the cold
// sentence — date/amount/payee when present, never receipt tone. Runs on
// the already-PII-stripped text (account/routing runs are tokens by now).
function statementEvent(text, referenceDate) {
  const amount = /\$\s?[\d,]+(?:\.\d{2})?/.exec(text)?.[0] ?? null;
  const payee =
    /\b(?:to|from)\s+([A-Z][A-Za-z&'. -]{2,40}?)(?=\s+on\b|\s*[.,\n]|\s*$)/.exec(text)?.[1]?.trim() ??
    null;
  const day = parseMentionedDate(text, referenceDate);
  const parts = [];
  if (amount) parts.push(amount);
  if (payee) parts.push(`to ${payee}`);
  if (day) parts.push(`on ${day}`);
  const notes = parts.length ? `Statement: ${parts.join(" ")}.` : "Statement reported.";
  return {
    event_type: "other",
    occurred_at: day ? `${day}T12:00:00.000Z` : new Date(referenceDate).toISOString(),
    scheduled_at: null,
    location: null,
    kids: [],
    notes,
  };
}

const STATEMENT_LIKE = /\b(statement|balance|invoice|billing)\b/i;

export function extractFields(text, { referenceDate, source } = {}) {
  const events = [];
  const lower = text.toLowerCase();

  // Explicit statement drop wins over every other arm.
  if (source === "statement") {
    events.push(statementEvent(text, referenceDate));
    return events;
  }

  const mentionsExchange = /\bexchange\b/.test(lower);
  const late =
    /\b(late|didn'?t show(?: up)?\s+until|not\s+until)\b/.test(lower);
  // Cancelled/denied visit phrasing is a claim event even when the vent
  // never says "visit" or "exchange" ("Jordan cancelled Tuesday again").
  // Sweeper NOTICE_POST_GAPS: OFW-style scheduling refusals count too —
  // declined, won't agree/let/allow/confirm/respond, blocked, withheld,
  // keeping/kept the kids, can't come/see, not letting/allowing.
  const denied =
    /\b(denied|refus\w*|declin\w*|wouldn'?t let|didn'?t let|no[- ]showed|never showed|cancel(?:l?ed|s|l?ing)?|called off|won'?t\s+(?:agree|allow|let|confirm|respond)|blocked|withheld|withholding|keeping the kids|kept the kids|can'?t\s+(?:come|see)|not\s+(?:letting|allowing))\b/.test(
      lower,
    );

  // Custody-context nouns: "Pickup on 2026-09-12 was 45 minutes late" is a
  // late claim even though the vent never says "exchange".
  const custodyContext =
    /\b(pick-?up|drop-?off|exchange|visit|weekend|parenting time|schedule)\b/.test(lower);

  let event_type = null;
  // Late wins when both apply so "cancelled and late" is late_exchange.
  if (late && (mentionsExchange || denied || custodyContext)) event_type = "late_exchange";
  else if (denied) event_type = "denied_visit";
  else if (mentionsExchange) event_type = "exchange";
  else if (/\bvisit\b/.test(lower)) event_type = "visit";
  // Guard: PII redaction tokens ("[phone]", "[email]") must never read as
  // incident keywords — "call me at [phone]" is not a call event.
  else if (/(?<!\[)\b(call|phone)\b(?!\])/.test(lower)) event_type = "call";

  // Schedule-change arm (Sweeper): "moved the pickup", "switched the
  // weekend", "rescheduled the exchange" — a dated scheduling claim with
  // no refusal verb. Recorded as 'other' with an observable note.
  const scheduleChange =
    !event_type &&
    /\b(moved|changed|switched|rescheduled|pushed|swapped)\b/.test(lower) &&
    /\b(pick-?up|drop-?off|exchange|schedule|weekend|visit|parenting time)\b/.test(lower);
  if (scheduleChange) event_type = "other";

  if (!event_type) {
    // Statement-like text (keyword + a dollar amount) with no incident
    // keyword: record the statement drop.
    if (STATEMENT_LIKE.test(text) && /\$\s?\d/.test(text)) {
      events.push(statementEvent(text, referenceDate));
      return events;
    }
    // No incident keyword: try the emotion-notice arm before giving up.
    if (!PAIN_PATTERNS.some((re) => re.test(text))) return events;
    const since = parseSinceDate(text, referenceDate);
    const kids = KNOWN_KIDS.filter((k) => new RegExp(`\\b${k}\\b`).test(text));
    // Cold parent-statement facts only — the feeling stays in raw_quote.
    const noteParts = [
      since
        ? `Parent reports limited time with the children since ${since}.`
        : `Parent reports limited time with the children.`,
    ];
    if (
      /\b(?:house|home)\s+(?:is|feels)\s+(?:so\s+)?(?:empty|quiet)\b/i.test(text) ||
      /\bempty\s+house\b/i.test(text) ||
      /\bwaiting\s+at\s+home\b/i.test(text)
    ) {
      noteParts.push("Parent reports waiting at home without the children.");
    }
    if (kids.length) noteParts.push(`Children named: ${kids.join(", ")}.`);
    events.push({
      event_type: "other",
      // Razor date gate: a mentioned date is the event's date — the start
      // of the limited-contact period — not the day of the venting.
      occurred_at: since ? `${since}T12:00:00.000Z` : new Date(referenceDate).toISOString(),
      scheduled_at: null,
      location: null,
      kids,
      notes: noteParts.join(" "),
    });
    return events;
  }

  const schedMatch = /\b(?:supposed to(?:\s+\w+){0,4}?\s+at|scheduled(?:\s+for)?)\s+([\d:]+\s*(?:am|pm)?)/i.exec(text);
  const actualMatch = /\b(?:until|showed(?:\s+up)?\s+at|arrived(?:\s+at)?)\s+([\d:]+\s*(?:am|pm)?)/i.exec(text);
  const locMatch = /\bat the ([A-Z][\w' ]*?(?:lot|park|school|house|center|court|library|station))\b/i.exec(text);

  const scheduledClock = schedMatch ? parseClockTime(schedMatch[1]) : null;
  const actualClock = actualMatch ? parseClockTime(actualMatch[1]) : null;

  const scheduled_at = scheduledClock ? atTime(referenceDate, scheduledClock) : null;
  // Dated claim ("on 9/12", "for October 3"): with no clock time in the
  // vent, the named date is the event's date, not the day of the venting.
  const mentionedDate =
    !scheduledClock && !actualClock ? parseMentionedDate(text, referenceDate) : null;
  const occurred_at = actualClock
    ? atTime(referenceDate, actualClock)
    : scheduled_at ??
      (mentionedDate
        ? `${mentionedDate}T12:00:00.000Z`
        : new Date(referenceDate).toISOString());

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
  if (scheduleChange) noteParts.push("Schedule change reported.");
  if (mentionedDate) noteParts.push(`Reported date: ${mentionedDate}.`);

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
// The pipeline. Async so the same code runs against the in-memory vault
// (sync methods) and the Postgres-backed SqlVault (async methods).
export async function extract(vault, dadId, text, opts = {}) {
  const referenceDate = opts.referenceDate ?? new Date();

  // 1. harm check FIRST. Nothing parsed, nothing logged, nothing retained.
  if (harmCheck(text)) {
    return { written: 0, chase: [] };
  }

  // 2. venom out. raw_quote = original text minus harm/venom (§4) — the
  // dad's own words survive on the claim pipe, count claims included. The
  // count is never written as a structured field or a verified row; the
  // chase item below is what the record keeps of it.
  //
  // 2b. PII out (statement → notice slice): phones, emails, tax ids,
  // numbered street addresses, account/routing numbers, kid school ids are
  // redacted BEFORE anything is stored, so raw_quote/notes — and therefore
  // state/search/notice — never carry raw PII. Only redaction counts may be
  // logged; the stripped values are gone. PII strip runs BEFORE venom strip:
  // venom's sentence split breaks emails ("dad@example. com") and would let
  // them slip past the redaction.
  const { text: piiFree, counts: piiCounts } = stripPii(text);
  const cold = stripVenom(piiFree);

  // 3. fields from the venom-free text. notes/location/kids/times are
  // constructed observable fields — a count claim never lands in them.
  const fields = extractFields(cold, { referenceDate, source: opts.source });

  // 4 + 5. tag claim, one row per event.
  const rows = [];
  for (const f of fields) {
    rows.push(
      await vault.insertEvent(dadId, {
        ...f,
        pipe: "claim", // Intake writes claim ONLY (§3 events rule)
        raw_quote: cold,
      }),
    );
  }

  // 6. claim chase — the verify item, never the number.
  const chase = [];
  if (detectCountClaim(text)) {
    const item = `verify count in OFW record for ${monthName(referenceDate)}`;
    await vault.appendMissing(dadId, item);
    chase.push(item);
  }

  log("intake.extract", {
    dad: dadId,
    written: rows.length,
    refs: rows.map((r) => r.id),
    chase: chase.length,
    pii: piiTotal(piiCounts),
  });

  // event_ids is internal (BFF notice hook) — the HTTP intake response
  // stays { written, chase } unless make_notice is set.
  return { written: rows.length, chase, event_ids: rows.map((r) => r.id) };
}
