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

/** True when the draft needs the calm rewrite (Slice 19 heat). */
export function hasHeat(text) {
  const t = String(text ?? "");
  return SWEAR_RE.test(t) || TELL_OFF_RE.test(t) || /\b(narcissis\w*|alienat\w*|gaslight\w*|sociopath\w*|psychopath\w*)\b/i.test(t);
}

export const FAILSAFE_SAY =
  "I couldn't turn that into a calm message without losing what you meant, so nothing was saved. Tell me the one thing you need from her, in one sentence.";

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

export function findIssue(text) {
  const t = String(text ?? "");
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
  for (const re of ASK_PATTERNS) {
    const m = re.exec(String(text ?? ""));
    if (!m) continue;
    let clause = m[1].replace(FILLER_RE, "").replace(/\s+/g, " ").replace(/[\s,;:]+$/, "").trim();
    clause = clause.replace(/^please\s+/i, "");
    if (!clause || clause.split(" ").length < 2) continue;
    // Third-person pronouns can't be re-aimed safely ("send her schedule"
    // vs "call her") — use the topic's default ask instead.
    if (/\b(she|he|her|him|his|hers|they|them|their)\b/i.test(clause)) continue;
    if (TELL_OFF_RE.test(clause) || SWEAR_RE.test(clause) || DIAGNOSIS_RE.test(clause) || INSULT_RE.test(clause)) continue;
    return `Please ${clause.charAt(0).toLowerCase()}${clause.slice(1)}.`;
  }
  return null;
}

// ---- validation -------------------------------------------------------------

/** Complete + clean: every sentence starts capitalized, ends . ? or !, >= 3 words. */
export function isCleanComplete(body) {
  const b = String(body ?? "").trim();
  if (!b || b.length > 280) return false;
  if (SWEAR_RE.test(b) || DIAGNOSIS_RE.test(b) || TELL_OFF_RE.test(b) || INSULT_RE.test(b) || hasVenom(b)) return false;
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
  return { ok: true, body, topic: issue?.topic ?? "request", ask_kept: Boolean(ask) };
}
