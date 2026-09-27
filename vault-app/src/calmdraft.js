// Calm rewrite (Slice 19) — hot vent → one complete, court-safe draft.
//
// The old path stripped hot SENTENCES and kept the rest verbatim, so a
// vent like "I am so fucking done. She is a narcissist who is alienating
// the kids and I want to tell her off for cancelling my weekend again."
// came back as the fragment "I am so fucking done." (Round Two failure).
//
// Now, when a draft carries HEAT — swearing, diagnosing the other parent
// (narcissist / alienating / motive), or "tell her off" — nothing from the
// vent is kept verbatim except a cleaned explicit ask. The draft is BUILT:
//
//   issue sentence (behavior only, from a fixed template)
//   + the dad's real ask (cleaned) or the topic's default ask
//   + "Thank you."
//
// then validated (no heat, no venom, no tone words, every sentence complete,
// <= 280 chars). If anything fails, there is NO body — only a plain `say`.
// Never a fragment. Never the dad's vent echoed back. Deterministic; no LLM.

import { hasVenom } from "./extract.js";

const SWEAR_RE =
  /\b(f+u+c+k\w*|fk\w*|motherf\w*|shit\w*|bullshit|damn\w*|goddamn\w*|bitch\w*|ass(?:hole)?s?|bastard\w*|crap\w*|piss\w*|wtf|hell)\b/i;
const DIAGNOSIS_RE =
  /\b(narcissis\w*|alienat\w*|bipolar|borderline|sociopath\w*|psychopath\w*|gaslight\w*|manipulat\w*|controlling|crazy|psycho|unstable|toxic|spiteful|vindictive|evil|on purpose|deliberately|intentionally|to (?:punish|hurt|spite) me|doing this to (?:me|us))\b/i;
const TELL_OFF_RE =
  /\b(tell (?:her|him|them) off|give (?:her|him|them) a piece of my mind|let (?:her|him|them) have it|rip into (?:her|him|them)|chew (?:her|him|them) out|put (?:her|him|them) in (?:her|his|their) place|set (?:her|him|them) straight)\b/i;
const INSULT_RE = /\b(stupid|idiot\w*|moron\w*|pathetic|worthless|useless|loser|a joke|ridiculous)\b/i;
// 19b: motive / mind-reading heat that never belongs in a draft.
const MOTIVE_HEAT_RE =
  /\b(poison\w*|(?:she'?s|he'?s|they'?re|been|keeps?) hiding|hiding (?:it|things|them|the \w+) from me|a lie|liar|losing my mind|so (?:that )?i look like|turning (?:them|the kids) against)\b/i;
// 19b: worn-out / defeated — nothing to send.
const DEFEAT_RE =
  /\b(whatever|i give up|nobody listens|no one listens|what'?s the point|(?:can|do) what(?:ever)? (?:she|he) wants|i don'?t care anymore)\b/i;
// 19b: a safety report (impaired driving / care of the kids) is never a Coach draft.
const IMPAIRED_RE =
  /\b(drunk|intoxicated|under the influence|impaired|high on|wasted|dui|dwi|smelled (?:like|of) (?:alcohol|booze|liquor|weed))\b/i;
const KIDS_CONTEXT_RE = /\b(kids?|children|boys|girls|son|daughter|car|driv\w*|exchange|pick-?up|drop-?off)\b/i;

/** True when the draft needs the calm rewrite (Slice 19 heat + 19b widen). */
export function hasHeat(text) {
  const t = String(text ?? "");
  return (
    SWEAR_RE.test(t) ||
    TELL_OFF_RE.test(t) ||
    MOTIVE_HEAT_RE.test(t) ||
    DEFEAT_RE.test(t) ||
    /\b(narcissis\w*|alienat\w*|gaslight\w*|sociopath\w*|psychopath\w*)\b/i.test(t) ||
    Boolean(findFinance(t))
  );
}

/** 19b: impaired-care report → no draft, a safety say (checked before heat). */
export function isSafetyReport(text) {
  const t = String(text ?? "");
  return IMPAIRED_RE.test(t) && KIDS_CONTEXT_RE.test(t);
}

export function isDefeat(text) {
  return DEFEAT_RE.test(String(text ?? ""));
}

export const FAILSAFE_SAY =
  "I couldn't turn that into a calm message without losing what you meant, so nothing was saved. Tell me the one thing you need from her, in one sentence.";

export const SAFETY_SAY =
  "This sounds like a safety concern, so I didn't draft a message to her. Write down what you saw — the date, time, place, and who was there — and bring it to your lawyer.";

export const DEFEAT_SAY =
  "Nothing was saved — there's no message to send right now. When you're ready, tell me the one thing you need from her, in one sentence.";

// ---- issue topics (behavior only) -------------------------------------------

const CANCEL_RE = /\b(cancel\w*|called off|took away|skipped|no-?show\w*|didn'?t show)\b/i;
const TIME_WORDS = [
  [/\bweekend\b/i, "my weekend parenting time"],
  [/\bovernight\b/i, "my overnight"],
  [/\bholiday\b/i, "my holiday time"],
  [/\bvisit\b/i, "my visit with the kids"],
  [/\bparenting time\b/i, "my parenting time"],
  [/\b(pick-?up|exchange|drop-?off)\b/i, "the exchange"],
  [/\btime with (?:the )?(?:kids|children)\b/i, "my time with the kids"],
];
const LATE_RE = /\b(late|kept me waiting|made me wait|waited)\b/i;
const WITHHOLD_RE =
  /\b(never tells?|doesn'?t tell|won'?t tell|didn'?t tell|won'?t share|doesn'?t share|never shares?|didn'?t share|left me out|keeps? me out|not told|no one told me|kept from me|won'?t send|never sends?)\b/i;
const INFO_WORDS = [
  [/\bdentist\w*\b/i, "dentist appointment"],
  [/\b(doctor|pediatrician|medical|clinic)\b/i, "medical"],
  [/\b(school|teacher|report card|grades?|conference)\b/i, "school"],
  [/\b(therap\w*|counsel\w*)\b/i, "counseling"],
];

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// 19b: things the kids repeat about money / court.
const KIDS_REPEAT_RE =
  /\b(?:kids?|boys|girls|children)\b[^.!?]{0,40}\b(came back|told me|said|saying|repeat\w*|asked me)\b/i;
const ADULT_TOPIC_RE = /\b(pay|paid|paying|money|support|court|custody|lawyer|divorce)\b/i;

// 19b: activities booked onto the dad's time.
const BOOKED_RE = /\b(scheduled|signed (?:them|the kids|the boys|the girls) up|registered|booked|enrolled)\b/i;
const MY_TIME_RE = /\bmy (weekends?|time|days|parenting time|nights)\b/i;
const ACTIVITY_RE = /\b(soccer|baseball|softball|basketball|football|hockey|dance|swim\w*|practice|games|lessons|tournaments?|camp|activities)\b/i;
const KIDS_NOUN_RE = /\b(boys|girls|kids|children)\b/i;

// 19b: money taken from the kids' college / savings account.
const ACCOUNT_RE = /\b(529(?: plan| account)?|college (?:fund|money|savings|account)|(?:kids'? )?savings account)\b/i;
const TOOK_RE = /\b(spent|took|taken|withdr[ae]w\w*|took out|emptied|drained|cashed out|pulled)\b/i;
const AMOUNT_RE =
  /\$\s?\d[\d,]*(?:\.\d{2})?|\b(?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty)\s+(?:hundred|thousand)(?:\s+dollars)?\b|\b\d[\d,]*\s+dollars\b/i;
const MONTH_RE =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i;

export function findFinance(text) {
  const t = String(text ?? "");
  const acct = ACCOUNT_RE.exec(t);
  if (!acct || !TOOK_RE.test(t)) return null;
  const is529 = /\b529\b/.test(t);
  const full = is529 ? "the kids' 529 account" : "the kids' college fund";
  const short = is529 ? "529 account" : "college fund";
  const amount = AMOUNT_RE.exec(t)?.[0]?.toLowerCase().replace(/\s+/g, " ");
  const month = MONTH_RE.exec(t)?.[0];
  const monthCap = month ? cap(month.toLowerCase()) : null;
  return {
    topic: "account_withdrawal",
    sentence: `I learned that ${amount ?? "money"} was taken out of ${full}${monthCap ? ` in ${monthCap}` : ""}.`,
    ask: `Please send me the ${short} statement${monthCap ? ` for ${monthCap}` : ""} and let me know what the withdrawal was for.`,
    on_record: true,
  };
}

export function findIssue(text) {
  const t = String(text ?? "");
  const finance = findFinance(t);
  if (finance) return finance;
  if (KIDS_REPEAT_RE.test(t) && ADULT_TOPIC_RE.test(t)) {
    return {
      topic: "adult_topics",
      sentence: "The kids came back repeating things about money and support.",
      ask: "Please keep adult topics like support between us and away from the kids.",
    };
  }
  const myTime = MY_TIME_RE.exec(t);
  if (BOOKED_RE.test(t) && myTime) {
    const kids = (KIDS_NOUN_RE.exec(t)?.[1] ?? "kids").toLowerCase();
    const activity = (ACTIVITY_RE.exec(t)?.[1] ?? "activities").toLowerCase();
    const when = myTime[1].toLowerCase() === "weekend" ? "weekends" : myTime[1].toLowerCase();
    return {
      topic: "schedule_conflict",
      sentence: `The ${kids}' ${activity} ${/s$/.test(activity) && activity !== "practice" ? "are" : "is"} scheduled during my ${when}.`,
      ask: "Please send me the full schedule so we can plan around it.",
    };
  }
  if (CANCEL_RE.test(t)) {
    const what = TIME_WORDS.find(([re]) => re.test(t))?.[1];
    if (what) {
      const again = /\bagain\b/i.test(t) ? " again" : "";
      return {
        topic: "cancelled_time",
        sentence: `${cap(what)} was cancelled${again}.`,
        ask: "Please let me know when we can schedule the make-up time.",
      };
    }
  }
  if (WITHHOLD_RE.test(t)) {
    const info = INFO_WORDS.find(([re]) => re.test(t))?.[1];
    if (info) {
      return {
        topic: "info_not_shared",
        sentence: `I haven't received the kids' ${info} information.`,
        ask: `Please send me the ${info} information.`,
      };
    }
  }
  if (LATE_RE.test(t) && /\b(pick-?up|exchange|drop-?off)\b/i.test(t)) {
    return {
      topic: "late_exchange",
      sentence: "The exchange started late.",
      ask: "Please confirm the exchange time for next time.",
    };
  }
  return null;
}

// ---- the real ask, buried in anger ------------------------------------------

const DOC_RE = /\b(schedule|calendar|dates?|records?|statements?|report\w*|information|info|copy|copies|list|forms?|receipts?|itinerary)\b/i;
const REL_CLAUSE_RE =
  /\s+(?:that |which |who )?(?:she|he|they)(?:'s|'ve|'d| has| have| had| is| was| keeps?| won'?t| never| been)?\b.*$/i;

/** 19b: "I need the fall schedule she's been hiding" → "Please send me the fall schedule." */
function findNeedDoc(text) {
  const m = /\bi (?:need|want) ((?:the|a|an|my|our) [^.!?]+)/i.exec(String(text ?? ""));
  if (!m) return null;
  let clause = m[1].replace(REL_CLAUSE_RE, "").replace(FILLER_RE, "").replace(/[\s,;:]+$/, "").trim();
  if (!DOC_RE.test(clause) || clause.split(" ").length < 2) return null;
  clause = clause.replace(/^my /i, "the ");
  if (/\b(she|he|her|him|his|they|them|their)\b/i.test(clause)) return null;
  if (SWEAR_RE.test(clause) || DIAGNOSIS_RE.test(clause) || MOTIVE_HEAT_RE.test(clause)) return null;
  return `Please send me ${clause}.`;
}

const ASK_PATTERNS = [
  /\bi (?:need|want) (?:her|him|them|you) to ([^.!?]+)/i,
  /\b(?:she|he|they) (?:needs?|has|have) to ([^.!?]+)/i,
  /\b(?:can|could|would|will) you (?:please )?([^.!?]+)/i,
  /\bplease ([^.!?]+)/i,
];
const FILLER_RE =
  /,?\s*\b(for god'?s sake|for crying out loud|for once(?: in (?:her|his) life)?|already|finally|like i asked|like a normal person|like an adult|seriously|i swear)\b/gi;

/** The dad's explicit ask, cleaned into "Please …." — or null. */
export function findAsk(text) {
  const doc = findNeedDoc(text);
  if (doc) return doc;
  for (const re of ASK_PATTERNS) {
    const m = re.exec(String(text ?? ""));
    if (!m) continue;
    let clause = m[1].replace(FILLER_RE, "").replace(/\s+/g, " ").replace(/[\s,;:]+$/, "").trim();
    clause = clause.replace(/^please\s+/i, "");
    if (!clause || clause.split(" ").length < 2) continue;
    // Third-person pronouns can't be re-aimed safely ("send her schedule"
    // vs "call her") — use the topic's default ask instead.
    if (/\b(she|he|her|him|his|hers|they|them|their)\b/i.test(clause)) continue;
    if (TELL_OFF_RE.test(clause) || SWEAR_RE.test(clause) || DIAGNOSIS_RE.test(clause) || INSULT_RE.test(clause) || MOTIVE_HEAT_RE.test(clause)) continue;
    return `Please ${clause.charAt(0).toLowerCase()}${clause.slice(1)}.`;
  }
  return null;
}

// ---- validation -------------------------------------------------------------

/** Complete + clean: every sentence starts capitalized, ends . ? or !, >= 3 words. */
export function isCleanComplete(body) {
  const b = String(body ?? "").trim();
  if (!b || b.length > 280) return false;
  if (
    SWEAR_RE.test(b) || DIAGNOSIS_RE.test(b) || TELL_OFF_RE.test(b) || INSULT_RE.test(b) ||
    MOTIVE_HEAT_RE.test(b) || DEFEAT_RE.test(b) || IMPAIRED_RE.test(b) || hasVenom(b)
  ) return false;
  const sentences = b.match(/[^.!?]+[.!?]/g);
  // Every character belongs to a terminated sentence — no trailing fragment.
  if (!sentences || sentences.join("").replace(/\s/g, "") !== b.replace(/\s/g, "")) return false;
  return sentences.every((s) => {
    const t = s.trim();
    return /^[A-Z]/.test(t) && /[.!?]$/.test(t) && (t.split(/\s+/).length >= 3 || t === "Thank you.");
  });
}

/**
 * calmRewrite(text) -> {ok:true, body, topic, ask_kept} | {ok:false}
 * text is already PII-stripped. Nothing from it is kept verbatim except a
 * cleaned explicit ask.
 */
export function calmRewrite(text) {
  const issue = findIssue(text);
  const ask = findAsk(text);
  if (!issue && !ask) return { ok: false };
  const parts = [];
  if (issue) parts.push(issue.sentence);
  parts.push(ask ?? issue.ask);
  parts.push("Thank you.");
  const body = parts.join(" ");
  if (!isCleanComplete(body)) return { ok: false };
  const on_record = Boolean(issue?.on_record) || /\b(documented|document it|on the record|for the record|in writing)\b/i.test(text);
  return { ok: true, body, topic: issue?.topic ?? "request", ask_kept: Boolean(ask), on_record };
}
