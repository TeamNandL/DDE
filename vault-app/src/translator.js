// Process Translator (Slice 15) — a dictionary, not a coach.
//
// Reactive fire-extinguisher: the dad pastes a paper's text or names a term;
// this returns what it IS in plain English, how it generally works, and
// what to be aware of. General stakes are fine. A personal verdict is never
// given — "is this good or bad for me?" becomes a sharp question for his
// lawyer. Every result carries the loud LAWYER_LINE.
//
// Timelines stay generic: we flag that a clock exists and never state a
// day-count or a state-by-state table. Dates written in a pasted paper come
// back as private_only calendar candidates (claims, not verified) — never
// written to OFW or any calendar.
//
// Soft second job: lawyer-relationship literacy (norms, red flags to
// raise, questions to ask). Never advice to drop or replace a lawyer.
//
// No LLM, no network, deterministic. DDE-worded; nothing copied from any
// court form. Not Coach, not Quill, not Parenting Plan, not Legal Intake.

import { stripPii } from "./pii.js";

export const LAWYER_LINE =
  "CONFIRM WITH YOUR LAWYER. This explains the general process — not your case. Not legal advice.";

export const VERDICT_LINE =
  "I can't tell you if this is good or bad for you — that depends on your facts, and that's your lawyer's call. Take this question to them:";

export const CLOCK_LINE =
  "There is a clock on this. Deadlines differ by state, court, and paper — get the exact date from your lawyer today. Don't guess it.";

export const UNKNOWN_LINE =
  "That one isn't in the dictionary yet. Ask your lawyer: \"What is this, what does it do, and do I need to do anything?\"";

export const CALENDAR_LINE =
  "Dates as written in what you pasted — private to you, not verified, not sent anywhere. Confirm each with your lawyer before you plan around it.";

export const MAX_PASTE = 8000;
export const MAX_TERMS_PER_PASTE = 5;

// kind: 'process' (court process term) | 'lawyer' (lawyer-relationship literacy).
// clock: true when the step usually starts a response deadline.
export const TERMS = [
  {
    key: "petition",
    kind: "process",
    term: "Petition",
    aliases: ["petition", "petitioner", "complaint for dissolution", "petition for dissolution"],
    what: "The paper that starts the case. The person who files it is the petitioner; the other parent is the respondent.",
    how: "It's filed with the court, then formally delivered (served) to the other side. It lists what the filer is asking the court for.",
    aware: "What's asked for in a petition is a request, not a ruling. Once you're served, a response clock usually starts.",
    clock: true,
    ask: "What is the petition asking for, and what's our plan to respond?",
  },
  {
    key: "response",
    kind: "process",
    term: "Response / Answer",
    aliases: ["answer", "response to petition", "counter-petition", "counterpetition", "respondent"],
    what: "The respondent's formal reply to the petition — agreeing, disagreeing, or asking for something different.",
    how: "Filed with the court and sent to the other side. A counter-petition is the respondent asking for his own relief.",
    aware: "Missing the response window can let the case move forward without your side on paper.",
    clock: true,
    ask: "Has our response been filed, and does it ask for what I actually want?",
  },
  {
    key: "summons",
    kind: "process",
    term: "Summons",
    aliases: ["summons", "served", "service of process", "process server", "proof of service", "return of service"],
    what: "The court notice that you've been sued or a case has been filed against you, delivered with the petition.",
    how: "A process server, sheriff, or other allowed method hands it over; proof of that delivery is filed with the court.",
    aware: "The date you were served usually matters — it can start a response clock. Write down when and how you got it.",
    clock: true,
    ask: "When does my response clock start from the service date, and who is tracking it?",
  },
  {
    key: "motion",
    kind: "process",
    term: "Motion",
    aliases: ["motion", "motion to", "moving party", "movant"],
    what: "A written request asking the judge to order something specific during the case.",
    how: "One side files it, the other side gets a chance to respond, and the judge decides — sometimes on paper, often at a hearing.",
    aware: "Motions can have their own response windows and hearing dates, separate from the main case.",
    clock: true,
    ask: "What exactly is this motion asking for, and do we oppose it?",
  },
  {
    key: "temporary_orders",
    kind: "process",
    term: "Temporary orders",
    aliases: ["temporary order", "temporary orders", "temporary relief", "pendente lite", "temporary hearing"],
    what: "Rules the court sets for while the case is still open — schedule, support, who stays where.",
    how: "Usually requested by motion and decided at a shorter hearing. They last until changed or replaced by a final order.",
    aware: "Temporary arrangements can shape what 'normal' looks like by the time of a final decision.",
    clock: false,
    ask: "Should we be asking for temporary orders, and what would they cover?",
  },
  {
    key: "emergency_motion",
    kind: "process",
    term: "Emergency / ex parte motion",
    aliases: ["ex parte", "emergency motion", "emergency hearing", "emergency order", "pick-up order"],
    what: "A request for fast action because someone says waiting would cause harm. Ex parte means one side asked without the other present.",
    how: "A judge may act quickly on limited information, then set a follow-up hearing where both sides are heard.",
    aware: "An emergency order is usually short-term and gets a follow-up hearing. Tell your lawyer the moment you receive one.",
    clock: true,
    ask: "When is the follow-up hearing, and what do we need to bring?",
  },
  {
    key: "hearing",
    kind: "process",
    term: "Hearing",
    aliases: ["hearing", "notice of hearing", "evidentiary hearing", "hearing date"],
    what: "A scheduled time in front of the judge (or a magistrate) about a specific issue.",
    how: "A notice of hearing sets the date, time, and place — sometimes remote. Some are short and paper-based; some take testimony.",
    aware: "Missing a hearing can mean it goes forward without you. Put the date in your private calendar and confirm it.",
    clock: false,
    ask: "Do I need to attend this hearing, and do I testify?",
  },
  {
    key: "case_management",
    kind: "process",
    term: "Case management / status conference",
    aliases: ["case management", "status conference", "scheduling conference", "pretrial conference", "pre-trial conference"],
    what: "A check-in with the court to track where the case stands and set the next steps.",
    how: "The judge may set dates for mediation, discovery, and trial. Often short; sometimes lawyers attend without clients.",
    aware: "Dates set here tend to drive the rest of the case.",
    clock: false,
    ask: "What dates came out of the conference, and which ones need me?",
  },
  {
    key: "mediation",
    kind: "process",
    term: "Mediation",
    aliases: ["mediation", "mediator", "mediated", "mediation agreement"],
    what: "A meeting with a neutral person who helps both sides try to reach agreement. The mediator doesn't decide anything.",
    how: "Often required before trial. What's said is usually confidential. If both sides agree, it gets written down and signed.",
    aware: "A signed mediation agreement can be hard to undo — read it fully before you sign.",
    clock: false,
    ask: "What should I be ready to agree to, and what should I hold on to, at mediation?",
  },
  {
    key: "discovery",
    kind: "process",
    term: "Discovery",
    aliases: ["discovery", "mandatory disclosure", "initial disclosure", "disclosures"],
    what: "The formal exchange of information and documents between the two sides.",
    how: "Each side sends requests; the other side must answer or object in time. Some disclosures are automatic.",
    aware: "Discovery answers usually run on a clock, and incomplete answers can cause problems later.",
    clock: true,
    ask: "What do you need from me for discovery, and by when?",
  },
  {
    key: "interrogatories",
    kind: "process",
    term: "Interrogatories",
    aliases: ["interrogatories", "interrogatory"],
    what: "Written questions from the other side that you answer in writing, under oath.",
    how: "Part of discovery. Your lawyer usually helps you answer and may object to some questions.",
    aware: "Answers are under oath and can be used later. Clock applies.",
    clock: true,
    ask: "Can we go through these interrogatories together before I answer?",
  },
  {
    key: "request_for_production",
    kind: "process",
    term: "Request for production",
    aliases: ["request for production", "request to produce", "production of documents"],
    what: "A written request to hand over specific documents — bank statements, texts, records.",
    how: "Part of discovery. You gather what's asked; your lawyer reviews, objects where proper, and sends it.",
    aware: "Clock applies. Don't delete or change anything that might be requested.",
    clock: true,
    ask: "What exactly do I need to gather, and in what format?",
  },
  {
    key: "deposition",
    kind: "process",
    term: "Deposition",
    aliases: ["deposition", "depose", "deposed", "notice of deposition"],
    what: "Questions asked out loud, under oath, outside the courtroom, with a court reporter recording it.",
    how: "The other side's lawyer asks; your lawyer is there and can object. The transcript can be used later.",
    aware: "It's testimony. Prep with your lawyer before, every time.",
    clock: false,
    ask: "When can we prep for the deposition, and what topics should I expect?",
  },
  {
    key: "subpoena",
    kind: "process",
    term: "Subpoena",
    aliases: ["subpoena", "subpoena duces tecum"],
    what: "A court-backed order to show up and testify, or to hand over documents.",
    how: "Can go to a party or to an outside person or business (a school, a doctor, a bank).",
    aware: "Ignoring one can have consequences. It usually has a compliance date.",
    clock: true,
    ask: "Do I have to comply with this subpoena as written, or can we object?",
  },
  {
    key: "financial_affidavit",
    kind: "process",
    term: "Financial affidavit",
    aliases: ["financial affidavit", "financial disclosure", "financial statement", "income and expense"],
    what: "A sworn form listing income, expenses, assets, and debts.",
    how: "Each side usually files one; it feeds support and property decisions.",
    aware: "It's under oath. Round numbers and guesses can cause trouble later.",
    clock: true,
    ask: "What documents do you need from me to fill out the financial affidavit accurately?",
  },
  {
    key: "guardian_ad_litem",
    kind: "process",
    term: "Guardian ad litem (GAL)",
    aliases: ["guardian ad litem", "gal"],
    what: "A person the court appoints to look into what's best for the kids and report back.",
    how: "They may interview each parent, the kids, teachers, and visit homes, then make recommendations to the judge.",
    aware: "The GAL isn't your lawyer or the other parent's. Be on time, calm, and factual in every contact.",
    clock: false,
    ask: "How should I prepare for my meetings with the guardian ad litem?",
  },
  {
    key: "custody_evaluation",
    kind: "process",
    term: "Custody evaluation / home study",
    aliases: ["custody evaluation", "home study", "social investigation", "parenting evaluation", "evaluator"],
    what: "A formal look at each parent's home and parenting by a professional the court or the parties chose.",
    how: "Interviews, home visits, sometimes testing, then a written report the judge can consider.",
    aware: "The report can carry weight. It's a process with its own schedule and costs.",
    clock: false,
    ask: "Is an evaluation likely here, and how do I get ready for it?",
  },
  {
    key: "parenting_plan",
    kind: "process",
    term: "Parenting plan",
    aliases: ["parenting plan", "time-sharing", "timesharing", "custody schedule", "parenting schedule"],
    what: "The document that sets how parenting time and decisions work for the kids.",
    how: "It can be agreed and signed, or decided by the judge. It becomes part of the order once approved.",
    aware: "To work through your own choices topic by topic, use the Parenting Plan seat — this dictionary only explains the term.",
    clock: false,
    ask: "Which parts of the parenting plan are still open between us and the other side?",
  },
  {
    key: "stipulation",
    kind: "process",
    term: "Stipulation / agreed order",
    aliases: ["stipulation", "stipulated", "agreed order", "consent order", "settlement agreement", "marital settlement agreement"],
    what: "Something both sides agree to in writing, often turned into a court order.",
    how: "Once the judge signs it, it's enforceable like any order.",
    aware: "Agreed orders can be hard to change later. Read every line before you sign.",
    clock: false,
    ask: "Before I sign this agreement, what am I giving up and what am I getting?",
  },
  {
    key: "continuance",
    kind: "process",
    term: "Continuance",
    aliases: ["continuance", "continued", "reschedule", "motion to continue"],
    what: "Moving a hearing or trial to a later date.",
    how: "Usually requested by motion or agreement; the judge decides whether to allow it.",
    aware: "Until the court says it's moved, treat the original date as real.",
    clock: false,
    ask: "Has this date actually been moved by the court, or just asked for?",
  },
  {
    key: "default",
    kind: "process",
    term: "Default",
    aliases: ["default", "default judgment", "motion for default"],
    what: "What can happen when one side doesn't respond or show up in time — the case moves forward without them.",
    how: "The other side asks the court to enter it; the judge may then decide based on one side's papers.",
    aware: "If you see this word, call your lawyer the same day.",
    clock: true,
    ask: "Is there any default risk in my case right now?",
  },
  {
    key: "contempt",
    kind: "process",
    term: "Contempt / motion to enforce",
    aliases: ["contempt", "motion for contempt", "order to show cause", "motion to enforce", "enforcement"],
    what: "A request asking the court to enforce an existing order because someone isn't following it.",
    how: "Filed by motion; there's a hearing where each side explains. Consequences vary.",
    aware: "Having your own records of what happened (dates, exchanges, messages) matters here.",
    clock: true,
    ask: "What records should I pull together for this contempt / enforcement filing?",
  },
  {
    key: "motion_to_compel",
    kind: "process",
    term: "Motion to compel",
    aliases: ["motion to compel", "compel"],
    what: "A request asking the judge to make the other side answer discovery they haven't answered.",
    how: "Filed after discovery answers are late or incomplete; often goes to a hearing.",
    aware: "It usually means someone's discovery is overdue — check whether it's aimed at you.",
    clock: true,
    ask: "Is this motion to compel about something I still owe?",
  },
  {
    key: "modification",
    kind: "process",
    term: "Modification",
    aliases: ["modification", "petition to modify", "motion to modify", "supplemental petition"],
    what: "A request to change an existing final order — schedule, support, or decision-making.",
    how: "Usually needs a real change in circumstances since the last order; it works like a smaller new case.",
    aware: "The bar to change a final order is usually higher than to set it the first time.",
    clock: true,
    ask: "Do my facts support asking for a modification, and what would we need to show?",
  },
  {
    key: "final_judgment",
    kind: "process",
    term: "Final judgment / final order",
    aliases: ["final judgment", "final order", "decree", "final decree", "judgment of dissolution"],
    what: "The judge's final decision that closes the case.",
    how: "It may come after trial or from a signed agreement the judge approves.",
    aware: "Windows to ask for rehearing or appeal can be short. Ask about them the day you get it.",
    clock: true,
    ask: "Now that there's a final judgment, are there any windows I need to know about?",
  },
  {
    key: "pro_se",
    kind: "process",
    term: "Pro se",
    aliases: ["pro se", "self-represented", "self represented", "unrepresented"],
    what: "Representing yourself in court without a lawyer.",
    how: "The same rules and deadlines apply as if you had a lawyer.",
    aware: "If the other parent is pro se, you and your lawyer may deal with them directly on case papers.",
    clock: false,
    ask: "The other side is pro se — how should communication about the case work now?",
  },
  // ---- Soft second job: lawyer-relationship literacy -----------------------
  {
    key: "retainer",
    kind: "lawyer",
    term: "Retainer and billing",
    aliases: ["retainer", "billing", "invoice", "billable", "hourly rate", "trust account", "replenish"],
    what: "A retainer is money paid up front that the lawyer bills against. Most family lawyers bill by time in small increments.",
    how: "Calls, emails, and document review usually all count as billed time. Many firms ask you to top the retainer back up.",
    aware: "It's normal to ask for itemized bills and to ask how to keep costs down (batching questions, sending organized records).",
    clock: false,
    ask: "Can I get itemized bills, and what can I do on my side to keep costs down?",
  },
  {
    key: "lawyer_communication",
    kind: "lawyer",
    term: "Hearing back from your lawyer",
    aliases: [
      "lawyer not responding", "lawyer isn't responding", "attorney not responding", "not calling me back",
      "hasn't called back", "hasn't emailed back", "no update from my lawyer", "paralegal",
    ],
    what: "How updates normally flow between you and your lawyer's office.",
    how: "Many firms route day-to-day questions through a paralegal or assistant. Urgent items (a new filing, a hearing date) should get faster handling.",
    aware: "It's fair to ask how and when to expect updates. If a real deadline is close and you can't get an answer, say so plainly in writing to the office.",
    clock: false,
    ask: "What's the best way to reach you, and how fast should I expect a reply on something urgent?",
  },
  {
    key: "lawyer_red_flags",
    kind: "lawyer",
    term: "Things worth raising with your lawyer",
    aliases: ["red flag", "red flags", "worried about my lawyer", "is my lawyer", "my lawyer won't", "my lawyer didn't"],
    what: "Patterns worth bringing up directly: missed deadlines, filings you never saw first, no answer on an urgent date, bills you don't understand.",
    how: "Raise it in writing, name the specific item, and ask what happened and what's next.",
    aware: "Most issues get fixed by a direct, specific question. Keep your own copies of everything you send and receive.",
    clock: false,
    ask: "Can we go over where things stand — what's been filed, what's due next, and who's handling each item?",
  },
  {
    key: "lawyer_questions",
    kind: "lawyer",
    term: "Good questions for any lawyer meeting",
    aliases: ["what should i ask my lawyer", "questions for my lawyer", "lawyer meeting", "meeting with my lawyer", "consultation"],
    what: "A short set of questions that keep you and your lawyer on the same page.",
    how: "Bring them written down; take notes on the answers.",
    aware: "Short, organized questions usually get better answers and cost less time.",
    clock: false,
    ask: "What's the next deadline, what do you need from me, and what's our goal for the next step?",
  },
];

export const TERM_KEYS = TERMS.map((t) => t.key);

export function termDef(key) {
  return TERMS.find((t) => t.key === key) ?? null;
}

// "good/bad for me?", "will I win/lose?", "should I…?", "what are my chances"
const VERDICT_RE =
  /\b(good|bad|great|terrible|fair|unfair)\s+(for|to)\s+me\b|\b(am i|will i|would i|could i|do i|are we)\b[^?.!]{0,40}\b(win|lose|losing|winning|screwed|in trouble|in good shape|get custody|lose custody|lose my kids)\b|\bmy (odds|chances)\b|\bshould i\b|\bwho will win\b|\bis this bad\b|\bis this good\b|\bam i going to\b/i;

export function isVerdictRequest(text) {
  return VERDICT_RE.test(String(text ?? ""));
}

// Clock language inside a pasted paper. We only FLAG it — never repeat or
// compute the count.
const CLOCK_RE =
  /\bwithin\s+(\w+|\d+)\s+(calendar\s+|business\s+|court\s+)?days?\b|\bno later than\b|\bdeadline\b|\bmust (file|respond|serve|answer|appear)\b|\bdays? (after|from) (service|receipt|the date)\b|\bfailure to (respond|appear|answer)\b|\bdue (by|on)\b/i;

export function hasClockLanguage(text) {
  return CLOCK_RE.test(String(text ?? ""));
}

function norm(s) {
  return String(s ?? "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Term lookup: exact key, exact term, or alias. Named-term input only.
export function lookupTerm(input) {
  const q = norm(input).replace(/[?.!]+$/, "").replace(/^(what is|what's|what does|define|explain)\s+(an?\s+|the\s+)?/, "")
    .replace(/\s+mean$/, "").trim();
  if (!q) return null;
  for (const t of TERMS) {
    if (t.key === q.replace(/[ -]/g, "_") || norm(t.term) === q) return t;
    if (t.aliases.some((a) => norm(a) === q)) return t;
  }
  // Loose: a named term that contains a known alias ("the summons I got").
  return findTerms(q)[0] ?? null;
}

// Every catalog term mentioned in a pasted text, in order of first mention.
// Longer aliases win (so "motion to compel" beats "motion").
export function findTerms(text) {
  const t = norm(text);
  const hits = [];
  for (const def of TERMS) {
    let first = Infinity;
    let len = 0;
    for (const a of def.aliases) {
      const m = new RegExp(`(^|[^a-z])${escapeRe(norm(a))}([^a-z]|$)`).exec(t);
      if (m && (m.index < first || (m.index === first && a.length > len))) {
        first = m.index;
        len = a.length;
      }
    }
    if (first !== Infinity) hits.push({ def, at: first, len });
  }
  // Drop a generic hit whose only match sits inside a longer, more specific
  // one at the same spot (e.g. "motion" inside "motion to compel").
  const kept = hits.filter(
    (h) => !hits.some((o) => o !== h && o.at <= h.at && o.at + o.len >= h.at + h.len && o.len > h.len),
  );
  return kept.sort((a, b) => a.at - b.at).map((h) => h.def);
}

// ---- Calendar candidates (private_only, claim ≠ verified) -------------------

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_RES = [
  { re: new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"), parse: (m) => ymd(m[3], monthNum(m[1]), m[2]) },
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, parse: (m) => ymd(m[1], Number(m[2]), m[3]) },
  { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, parse: (m) => ymd(m[3], Number(m[1]), m[2]) },
];

const LABELS = [
  ["hearing", "Hearing"],
  ["mediation", "Mediation"],
  ["deposition", "Deposition"],
  ["trial", "Trial"],
  ["conference", "Court conference"],
  ["evaluation", "Evaluation"],
  ["home study", "Home study"],
  ["deadline", "Deadline named in paper"],
  ["due", "Due date named in paper"],
];

function monthNum(name) {
  const n = name.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(n)) + 1;
}

function ymd(y, m, d) {
  const dd = Number(d);
  if (!(m >= 1 && m <= 12 && dd >= 1 && dd <= 31)) return null;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return dt.getUTCDate() === dd ? iso : null;
}

function labelNear(text, index) {
  // Same sentence only: a label from an earlier sentence never carries over.
  const before = text.slice(Math.max(0, index - 80), index);
  const cut = Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n"));
  const window = before.slice(cut + 1).toLowerCase();
  let best = null;
  let bestAt = -1;
  for (const [needle, label] of LABELS) {
    let at = -1;
    const re = new RegExp(`\\b${needle}\\b`, "g");
    for (let m; (m = re.exec(window)); ) at = m.index;
    if (at > bestAt) {
      bestAt = at;
      best = label;
    }
  }
  return best ?? "Date named in paper";
}

export function calendarCandidates(text) {
  const src = String(text ?? "");
  const out = [];
  for (const { re, parse } of DATE_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const on_date = parse(m);
      if (!on_date || out.some((c) => c.on_date === on_date)) continue;
      out.push({
        at: m.index,
        label: labelNear(src, m.index),
        date_text: m[0],
        on_date,
        visibility: "private_only",
        status: "candidate",
        verified: false,
      });
    }
  }
  return out
    .sort((a, b) => a.at - b.at)
    .slice(0, 10)
    .map(({ at, ...c }) => c);
}

// ---- Result builder ---------------------------------------------------------

function entry(def) {
  return {
    key: def.key,
    kind: def.kind,
    term: def.term,
    what_it_is: def.what,
    how_it_works: def.how,
    be_aware: def.aware,
    clock: def.clock ? CLOCK_LINE : null,
    ask_your_lawyer: def.ask,
  };
}

const VERDICT_ASK = "Given my facts, is this good or bad for me — and what's our move?";

/**
 * explain({term?, text?}) -> {input_kind, input_cold, term_keys, verdict_request,
 *   clock_flag, result, calendar_candidates}
 * Throws {status:400} on bad input. Pure; the BFF persists.
 */
export function explain({ term, text } = {}) {
  const hasTerm = typeof term === "string" && term.trim() !== "";
  const hasText = typeof text === "string" && text.trim() !== "";
  if (hasTerm === hasText) {
    throw Object.assign(new Error("send exactly one of term or text (V1: paste or named term only)"), { status: 400 });
  }
  const raw = hasTerm ? term : text;
  if (raw.length > MAX_PASTE) {
    throw Object.assign(new Error(`paste is too long (max ${MAX_PASTE} characters)`), { status: 400 });
  }
  const cold = stripPii(raw).text;
  const verdict = isVerdictRequest(cold);

  let defs;
  if (hasTerm) {
    const d = lookupTerm(cold);
    defs = d ? [d] : [];
  } else {
    defs = findTerms(cold).slice(0, MAX_TERMS_PER_PASTE);
  }

  const clockFlag = (!hasTerm && hasClockLanguage(cold)) || defs.some((d) => d.clock);
  const candidates = hasTerm ? [] : calendarCandidates(cold);
  const asks = defs.map((d) => d.ask);
  if (verdict) asks.unshift(VERDICT_ASK);

  const result = {
    lawyer_line: LAWYER_LINE,
    headline: defs.length
      ? `${LAWYER_LINE} Here's what ${defs.length === 1 ? "this is" : "these are"} in plain English.`
      : `${LAWYER_LINE} ${UNKNOWN_LINE}`,
    terms: defs.map(entry),
    verdict: verdict ? { line: VERDICT_LINE, ask: VERDICT_ASK } : null,
    clock: clockFlag ? CLOCK_LINE : null,
    calendar_line: candidates.length ? CALENDAR_LINE : null,
    ask_your_lawyer: asks.length ? asks : ["What is this, what does it do, and do I need to do anything?"],
    not_found: defs.length === 0,
  };

  return {
    input_kind: hasTerm ? "term" : "paste",
    input_cold: cold,
    term_keys: defs.map((d) => d.key),
    verdict_request: verdict,
    clock_flag: clockFlag,
    result,
    calendar_candidates: candidates,
  };
}
