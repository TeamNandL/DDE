// Court-prep capture — COURT_PREP_PRINCIPLES §2–§5, pure functions only.
//
// §2 Keyword hits flag CANDIDATES — low confidence, never asserted true.
// §3 Conversation facts stay "not proof yet" until an OFW cross-check.
//    OFW (verified pull rows) is only ever READ here — never overwritten.
//    A disagreement surfaces as ONE clear line for the parent.
// §4 Factual utterances become structured facts: who / what / when / kids.
// §5 Proactive check-ins: two windows a day (floor: one) as Notification
//    items with due window + status.
//
// No LLM, no live OFW, no push. Behavior words only — never motive.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const KNOWN_KIDS = ["Sam", "Taylor"]; // fake family only (§2 of the kickoff)

// Ordered: first hit wins. "didn't show up until" is late before it is a
// no-show; "didn't come" is a cancel before "came" reads as attended.
const WHAT_CUES = [
  ["late", /\b(late|didn'?t show(?: up)? until|not until)\b/i],
  [
    "cancelled",
    /\b(cancel(?:l?ed|s|l?ing)?|called off|denied|refus\w*|no[- ]show(?:ed)?|never showed|didn'?t (?:come|show|bring)|did not (?:come|show|bring)|skipped|kept the kids|withheld)\b/i,
  ],
  [
    "attended",
    /\b(did come|came|showed up|completed|happened|took place|went ahead|occurred|picked (?:them |the kids |him |her )?up|dropped (?:them |the kids |him |her )?off|was there|attended|made it)\b/i,
  ],
  [
    "time_with",
    /\b(time with|spent (?:the )?(?:day|night|evening|afternoon|morning|weekend) with|had (?:the kids|them|my (?:son|daughter|kids))|dinner with|visit(?:ed)? with)\b/i,
  ],
  [
    "schedule",
    /\b(moved|changed|changing|switched|rescheduled|pick-?up|drop-?off|exchange|visit|appointment|weekend|calendar|schedule)\b/i,
  ],
];

// A day phrase wins over a clock time ("6pm tomorrow" → "tomorrow").
const DAY_RE = new RegExp(
  [
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
    String.raw`\b(?:last|this|next)\s+(?:${WEEKDAYS.join("|")})\b`,
    String.raw`\b(?:${WEEKDAYS.join("|")})\b`,
    String.raw`\b(?:today|tonight|yesterday|tomorrow|this morning|this afternoon|this evening|last night)\b`,
  ].join("|"),
  "i",
);
const TIME_RE = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/i;

const KID_WORDS_RE = /\b(son|daughter|kids?|children|boys?|girls?)\b/gi;

// Capitalized words that are sentence scaffolding, not people.
const NOT_WHO = new Set([
  "I", "I'm", "I've", "I'll", "The", "They", "She", "He", "We", "My", "It", "This", "That",
  "There", "Then", "And", "But", "So", "If", "When", "Our", "Her", "His", "Their", "Help",
  "Want", "Can", "Could", "Would", "Please", "Last", "Next", "Today", "Tonight", "Yesterday",
  "Tomorrow", "OFW", "Not", "No", "Yes", "Just", "Also", "After", "Before", "At", "On", "In",
  "Mom", "Dad", "Statement", "Questions", "Call", "Time", "Kids", "Pickup", "Visit", "Dinner",
  "Nothing", "Everything", "Visit", "Exchange", "Drop", "Morning", "Evening", "Check",
  ...WEEKDAYS.map((d) => d[0].toUpperCase() + d.slice(1)),
  ...MONTHS.map((m) => m[0].toUpperCase() + m.slice(1)),
]);

export const WHAT_KINDS = ["cancelled", "attended", "late", "time_with", "schedule", "mention"];

const WHAT_LABEL = {
  cancelled: "visit cancelled",
  attended: "they came",
  late: "late exchange",
  time_with: "time with the kids",
  schedule: "schedule change",
  mention: "noted",
};

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

// Resolve a when-phrase to a calendar day only when it is unambiguous.
// Bare / "this" weekdays stay null (could be past or future) — the fact
// keeps its when_text and stays "not proof yet" rather than guessing.
export function resolveWhen(whenText, referenceDate = new Date()) {
  if (!whenText) return null;
  const t = whenText.toLowerCase();
  const ref = new Date(referenceDate);
  const iso = t.match(/\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  if (/^(today|tonight|this morning|this afternoon|this evening)$/.test(t)) return isoDay(ref);
  if (/^(yesterday|last night)$/.test(t)) return isoDay(addDays(ref, -1));
  if (t === "tomorrow") return isoDay(addDays(ref, 1));
  const lastDay = t.match(/^last\s+(\w+)$/);
  if (lastDay && WEEKDAYS.includes(lastDay[1])) {
    const want = WEEKDAYS.indexOf(lastDay[1]);
    let back = (ref.getUTCDay() - want + 7) % 7;
    if (back === 0) back = 7;
    return isoDay(addDays(ref, -back));
  }
  const nextDay = t.match(/^next\s+(\w+)$/);
  if (nextDay && WEEKDAYS.includes(nextDay[1])) {
    const want = WEEKDAYS.indexOf(nextDay[1]);
    let fwd = (want - ref.getUTCDay() + 7) % 7;
    if (fwd === 0) fwd = 7;
    return isoDay(addDays(ref, fwd));
  }
  return null;
}

export function classifyWhat(text) {
  for (const [kind, re] of WHAT_CUES) {
    if (re.test(text)) return kind;
  }
  return null;
}

// Rail: no live dollar figures in court-prep capture (kickoff rule 3).
// The fact is kept; the figure is masked.
const AMOUNT_RE = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|bucks|usd)\b/gi;

export function maskAmounts(text) {
  return String(text ?? "").replace(AMOUNT_RE, "[amount]");
}

function splitSentences(text) {
  return String(text ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function whoIn(sentence) {
  const out = [];
  for (const m of sentence.matchAll(/\b[A-Z][a-z]+(?:'s)?\b/g)) {
    const w = m[0].replace(/'s$/, "");
    if (NOT_WHO.has(w) || NOT_WHO.has(m[0])) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

function kidsIn(sentence) {
  const kids = KNOWN_KIDS.filter((k) => new RegExp(`\\b${k}\\b`).test(sentence));
  for (const m of sentence.matchAll(KID_WORDS_RE)) {
    const w = m[1].toLowerCase();
    if (!kids.includes(w)) kids.push(w);
  }
  return kids;
}

/**
 * §2 + §4: every sentence with a keyword hit (an event cue OR a when cue)
 * becomes ONE candidate fact. Over-capture: nothing with a hit is dropped
 * here — each note waits for the dad's review (keep / toss). Callers pass text that
 * already went through the harm → PII → venom rails.
 *
 * -> [{ what, who[], when_text, when_on, kids[], cues[], quote }]
 */
export function candidateFacts(text, referenceDate = new Date()) {
  const facts = [];
  for (const sentence of splitSentences(maskAmounts(text))) {
    const what = classifyWhat(sentence);
    const whenMatch = sentence.match(DAY_RE) ?? sentence.match(TIME_RE);
    if (!what && !whenMatch) continue;
    const when_text = whenMatch ? whenMatch[0] : null;
    const cues = [];
    if (what) cues.push(what);
    if (when_text) cues.push("when");
    facts.push({
      what: what ?? "mention",
      who: whoIn(sentence),
      when_text,
      when_on: resolveWhen(when_text, referenceDate),
      kids: kidsIn(sentence),
      cues,
      quote: sentence,
    });
  }
  return facts;
}

// Which OFW readings agree / disagree with a conversation fact.
const AGREES = {
  cancelled: ["cancelled"],
  attended: ["attended", "time_with", "late"],
  time_with: ["attended", "time_with", "late"],
  late: ["late"],
};
const DISAGREES = {
  cancelled: ["attended", "time_with", "late"],
  attended: ["cancelled"],
  time_with: ["cancelled"],
  late: ["cancelled"],
};

function ofwDay(row) {
  if (!row?.sent_at) return null;
  const d = new Date(row.sent_at);
  return Number.isNaN(d.getTime()) ? null : isoDay(d);
}

/**
 * §3 OFW cross-check STUB. Reads the dad's stored OFW pull rows (verified
 * pipe) — no live OFW, and it never writes to them. Only facts with a
 * resolved day and a comparable kind can match; everything else stays
 * parent-asserted, "not proof yet".
 *
 * -> { status: 'not_proof_yet'|'matched'|'conflict', ofw_ref, ofw_what }
 */
export function crossCheck(fact, ofwRows = []) {
  const none = { status: "not_proof_yet", ofw_ref: null, ofw_what: null };
  if (!fact.when_on || !AGREES[fact.what]) return none;
  const sameDay = ofwRows.filter((r) => ofwDay(r) === fact.when_on);
  let agree = null;
  for (const row of sameDay) {
    const ofw_what = classifyWhat(String(row.body_cold ?? ""));
    if (!ofw_what) continue;
    if (DISAGREES[fact.what].includes(ofw_what)) {
      return { status: "conflict", ofw_ref: row.source_ref ?? row.id ?? null, ofw_what };
    }
    if (!agree && AGREES[fact.what].includes(ofw_what)) {
      agree = { status: "matched", ofw_ref: row.source_ref ?? row.id ?? null, ofw_what };
    }
  }
  return agree ?? none;
}

function labelOf(fact) {
  const base =
    fact.what === "attended" && fact.who?.length ? `${fact.who[0]} came` : WHAT_LABEL[fact.what];
  if (!fact.when_text) return base[0].toUpperCase() + base.slice(1);
  const when = fact.when_text[0].toUpperCase() + fact.when_text.slice(1);
  return `${when}: ${base}`;
}

/** The ONE line the parent sees for a fact. Never motive, never a verdict. */
export function factLine(fact, check) {
  const label = labelOf(fact);
  if (check.status === "matched") return `${label} — OFW shows the same.`;
  if (check.status === "conflict") {
    return `${label} — OFW for ${fact.when_on} shows ${WHAT_LABEL[check.ofw_what]}. Check before you rely on it.`;
  }
  return `${label} — your account, not proof yet.`;
}

// §5 check-in windows, local time via a fixed offset (minutes east of UTC,
// e.g. -240 for US Eastern daylight). Two per day; the floor of one is
// always met because both are created together.
export const CHECKIN_SLOTS = [
  { slot: "morning", start: 8, end: 12, title: "Morning check-in: anything from last night or today to log?" },
  { slot: "evening", start: 18, end: 22, title: "Evening check-in: how did today go with the kids?" },
];

export function checkinWindows(forDate, tzOffsetMinutes = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(forDate))) throw new Error("date must be YYYY-MM-DD");
  const midnightUtc = Date.parse(`${forDate}T00:00:00.000Z`);
  if (Number.isNaN(midnightUtc)) throw new Error("date must be YYYY-MM-DD");
  const offsetMs = Number(tzOffsetMinutes) * 60_000;
  return CHECKIN_SLOTS.map(({ slot, start, end, title }) => ({
    kind: "check_in",
    slot,
    for_date: forDate,
    title,
    due_start: new Date(midnightUtc + start * 3_600_000 - offsetMs).toISOString(),
    due_end: new Date(midnightUtc + end * 3_600_000 - offsetMs).toISOString(),
  }));
}

/** Stored status is unread|read|done; past its window and not done → missed. */
export function effectiveStatus(item, now = new Date()) {
  if (item.status === "done") return "done";
  if (new Date(item.due_end).getTime() < new Date(now).getTime()) return "missed";
  return item.status;
}
