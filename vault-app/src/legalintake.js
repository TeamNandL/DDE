// Legal Intake seat (Slice 17) — intake + triage + handoff packet draft.
//
// One job: capture what happened, flag what a person must look at, and
// draft a handoff packet for the dad's lawyer. It NEVER answers the law:
// no strategy, no options menu, no "you should". Every reply carries the
// loud LAWYER_LINE and ONE next step.
//
// Capture v1: who (menu) · what (PII-stripped, claim) · urgency (the dad's
// own menu pick — the bot never decides a legal emergency). An
// emergency-feeling intake is flagged for a human; no emergency numbers,
// no jurisdiction rules are invented.
//
// Split: "what does this paper mean?" → Process Translator (Slice 15).
// "What should I do?" → stays here, becomes a question for the lawyer.
//
// Draft ≠ send: packets are stored with sent_at null; there is no send
// path and no counsel-contact channel. Deterministic; no LLM.
// Personal venture only — business (N&L / NNO) mentions are redacted and
// flagged, never carried into a packet.

import { stripPii } from "./pii.js";

export const LAWYER_LINE =
  "CONFIRM WITH YOUR LAWYER. This seat collects and organizes — it does not answer the law. Not legal advice.";

export const DRAFT_FOOTER =
  "Dad-entered. Claim, not verified. DRAFT ONLY — not sent. Nothing here is sent automatically.";

export const MAX_WHAT = 2000;

export const WHO = {
  co_parent: "The other parent",
  my_lawyer: "My lawyer",
  their_lawyer: "The other parent's lawyer",
  court: "The court",
  school: "The school",
  provider: "A doctor or provider",
  other: "Someone else",
};

// The dad picks; the bot never upgrades or downgrades it.
export const URGENCY = {
  today: "Today",
  this_week: "This week",
  this_month: "This month",
  not_sure: "Not sure",
};

export const FLAG_LABELS = {
  safety: "Safety words — a person should read this first.",
  deadline_language: "Deadline language — confirm the exact date with your lawyer.",
  fire_lawyer: "Lawyer-relationship concern — raise it with your lawyer directly.",
  custody_emergency: "Feels like a custody emergency — a person should read this first.",
  money_numbers: "Money figures were mentioned — amounts removed from this draft.",
  out_of_venture: "Business mention removed — outside this personal venture.",
};

export const FLAG_KEYS = Object.keys(FLAG_LABELS);

const FLAG_RES = {
  safety: /\b(hurt|hit|hits|hitting|threat|threaten\w*|unsafe|weapon|gun|knife|abus\w*|police|cops|scared for|in danger|bruise\w*|violent|violence)\b/i,
  deadline_language: /\bdeadline\b|\bdue (by|on)\b|\bwithin \w+ days?\b|\bno later than\b|\bhearing (on|is|date)\b|\bcourt date\b|\bmust (file|respond|answer|appear)\b|\bserved\b/i,
  fire_lawyer: /\bfire (my|the|our) (lawyer|attorney)\b|\bnew (lawyer|attorney)\b|\bswitch (lawyers|attorneys)\b|\breplace my (lawyer|attorney)\b|\bdrop my (lawyer|attorney)\b/i,
  custody_emergency: /\btook the (kids|children)\b|\bwon'?t (return|give back|bring back)\b|\bnot (returning|bringing back)\b|\bkept the (kids|children)\b|\bleft the state\b|\bmoving away with\b|\bemergency custody\b|\bpick-?up order\b|\bcan'?t find (my|the) (kids|son|daughter)\b/i,
};

const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*(?:\.\d{2})?\s?(?:dollars|bucks|usd)\b|\b\d+k\b/gi;
const VENTURE_RE = /\bteam\s*n\s*&\s*l\b|\bn\s*&\s*l\b|\bnno\b|\bwealth builders\b|\bn&l wealth\b/gi;

// "Decode this paper" → Process Translator. "What should I do?" stays.
const DECODE_RE = /\bwhat does (this|it|that|the)\b[^?.!]{0,40}\b(mean|say)\b|\bwhat is (a|an|the|this)\b|\bexplain (this|the|what)\b|\bdecode\b|\bwhat'?s (a|an|this)\b|\bwhat do these words mean\b/i;
const WHAT_DO_RE = /\bwhat (should|do|can) (i|we) do\b|\bhow do i\b|\bshould i\b|\bwhat now\b|\bhelp me\b/i;

function bad(msg) {
  return Object.assign(new Error(msg), { status: 400 });
}

/**
 * capture({who, what, urgency}) -> {who, urgency, what_cold, flags, route}
 * Pure. PII stripped, money + business mentions redacted.
 */
export function capture({ who, what, urgency } = {}) {
  if (!(who in WHO)) throw bad(`who must be one of: ${Object.keys(WHO).join(", ")}`);
  if (!(urgency in URGENCY)) throw bad(`urgency must be one of: ${Object.keys(URGENCY).join(", ")}`);
  if (typeof what !== "string" || !what.trim()) throw bad("what is required");
  if (what.length > MAX_WHAT) throw bad(`what is too long (max ${MAX_WHAT} characters)`);

  let cold = stripPii(what.trim()).text;
  const flags = [];
  for (const [key, re] of Object.entries(FLAG_RES)) if (re.test(cold)) flags.push(key);
  const redacted = cold.replace(MONEY_RE, "[amount]");
  if (redacted !== cold) flags.push("money_numbers");
  cold = redacted;
  const noBleed = cold.replace(VENTURE_RE, "[removed]");
  if (noBleed !== cold) flags.push("out_of_venture");
  cold = noBleed;

  const route = DECODE_RE.test(cold) && !WHAT_DO_RE.test(cold) ? "process_translator" : "lawyer_handoff";
  return { who, urgency, what_cold: cold, flags: FLAG_KEYS.filter((k) => flags.includes(k)), route };
}

// A person must look before anything else: safety or custody-emergency
// feel, or the dad himself picked "today".
export function needsHuman(intake) {
  return (
    intake.flags.includes("safety") ||
    intake.flags.includes("custody_emergency") ||
    intake.urgency === "today"
  );
}

export const HUMAN_LINE =
  "Flagged for a person to review. If anyone is in danger right now, get help now — don't wait on this app.";

/** ONE next step, dad-facing. Never a strategy menu. */
export function nextStep(intake, hasDraft = false) {
  if (intake.route === "process_translator") {
    return {
      seat: "process_translator",
      line: "That's a what-does-this-mean question. Paste the paper into the Process Translator.",
    };
  }
  if (hasDraft) {
    return {
      seat: "legal_intake",
      line: "Read the draft. Nothing has been sent — if you want your lawyer to have it, you send it yourself.",
    };
  }
  return { seat: "legal_intake", line: "Build the handoff draft for your lawyer." };
}

/** Handoff packet draft. Pure; deterministic for (intake, version, today). */
export function renderPacket(intake, version, today) {
  const lines = [
    `HANDOFF PACKET — DRAFT v${version} (NOT SENT)`,
    LAWYER_LINE,
    `Prepared ${today} · intake ${intake.id}`,
    "",
    `Who: ${WHO[intake.who]}`,
    `Urgency (dad's pick): ${URGENCY[intake.urgency]}`,
    "",
    "What happened (dad's words, personal info removed):",
    intake.what_cold,
  ];
  if (needsHuman(intake) || intake.flags.length) {
    lines.push("", "Flagged for human review:");
    if (needsHuman(intake)) lines.push("- Read this first — a person should look before anything else.");
    for (const f of intake.flags) lines.push(`- ${FLAG_LABELS[f]}`);
  }
  lines.push(
    "",
    "Questions for my lawyer:",
    "- What do you need from me on this, and by when?",
    "- Is there anything time-sensitive here I should know about?",
    "",
    DRAFT_FOOTER,
  );
  return lines.join("\n");
}
