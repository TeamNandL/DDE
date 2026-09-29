// Chip one-Next undercarriage.
//
// One dad blurt → one track → one Next. Vent is never an evidence row.
// A file cue notes a hash only (Slice 23 log). No bytes, no storage_uri,
// no OCR. Exhibit reads verified_export only.

import { stripPii } from "./pii.js";

// Locked PRIMARY (Nick). Curly apostrophe is the shelf lock — do not straighten.
export const UNDER_FLOOR_SAY =
  "Got that file. It\u2019s under the floor. Next: open it when you need it.";

// One smaller ask. Not a menu. Never "got it."
export const SHRINK_SAY = "One thing. What happened, in one sentence?";

// File named, hash not here yet. Do not speak PRIMARY — nothing was noted.
export const FILE_WAIT_SAY = "Next: open the file on this phone. Nothing is kept yet.";

// Gauge is a principle here, not Play-It-Forward code. No vault write.
export const GAUGE_SAY = "Not sent. Next: read it once; send it only if it still fits.";

// Tone. Draft ≠ send. Chip speaks this one line, not a second Next.
export const TONE_SAY = "Draft ready \u2014 you send or not.";

export const EXHIBIT_EMPTY_SAY = "Nothing to show yet.";
export const EXHIBIT_READY_SAY = "Next: open the case page when you want it.";

const EMOTION_RE =
  /\b(angry|anger|furious|rage|raging|pissed|upset|overwhelmed|overwhelm|sobbing|crying|hate|screaming|drowning|freaking out|panick\w*|too much|can(?:not|'t) take)\b/i;
const OVERWHELM_RE =
  /\b(overwhelmed|overwhelm|too much|drowning|everything at once|can(?:not|'t) do this|shutting down)\b/i;
// File in hand — not the bare word "statement" inside a story.
const FILE_RE =
  /\b(pdf|screenshot|attachment)\b|\bscans?\b|\b(i have|i've got|ive got|got a|holding)\b[^.]{0,48}\b(file|statement|pdf)\b|\b(file|statement)\b[^.]{0,32}\b(in (?:my )?hand|attached)\b/i;
const GAUGE_RE =
  /\b(about to send|before i send|gonna send|going to send|should i (?:hit )?send|hit send)\b/i;
const TONE_RE =
  /\b(what should i say|what do i (?:say|write|reply|text)|help me (?:say|write|reply)|draft (?:a |the )?(?:reply|message|text)|something (?:calm|factual))\b/i;
const EDDIE_RE =
  /\b(what(?:'|’)?s next|what is next|what(?:'|’)?s missing|what am i missing|what should i do next)\b/i;
const EXHIBIT_RE =
  /\b(show my case|show the case|my exhibit|show the exhibit|court packet)\b/i;

const BANNED_SAY = [
  /\bgot it\b/i,
  /\bverified\b/i,
  /\bevidence logged\b/i,
  /\buploaded to court\b/i,
  /\bocr\b/i,
  /https?:\/\//i,
  /\bdad_id\b/i,
  /\bselect\s+.+\s+from\b/i,
];

export function scrubDadSay(text, dadId) {
  if (text == null) return null;
  let s = stripPii(String(text)).text;
  s = s.replace(/https?:\/\/\S+/gi, "");
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "");
  if (dadId) s = s.split(String(dadId)).join("");
  s = s.replace(/[ \t]{2,}/g, " ").replace(/\s+([.?!])/g, "$1").trim();
  return s || null;
}

export function assertDadSay(text) {
  if (text == null) return;
  for (const re of BANNED_SAY) {
    if (re.test(text)) {
      const err = new Error("dad-facing line failed the scrub");
      err.status = 500;
      throw err;
    }
  }
}

/**
 * One fork. Emotion dominates a mixed blurt; a file in hand with no emotion
 * is the evidence track. Second cue waits for the next turn.
 * @returns {{ track: string, shrink: boolean }}
 */
export function classifyChipCue(text) {
  const raw = String(text ?? "");
  const emotion = EMOTION_RE.test(raw);
  const file = FILE_RE.test(raw);
  const shrink = OVERWHELM_RE.test(raw);
  if (GAUGE_RE.test(raw)) return { track: "gauge", shrink: false };
  if (shrink && !file) return { track: "vent", shrink: true };
  if (file && emotion) return { track: "vent", shrink };
  if (file) return { track: "evidence", shrink: false };
  if (TONE_RE.test(raw)) return { track: "tone", shrink: false };
  if (EXHIBIT_RE.test(raw)) return { track: "exhibit", shrink: false };
  if (EDDIE_RE.test(raw)) return { track: "eddie", shrink: false };
  return { track: "vent", shrink };
}

export function oneNextFromState(nextAction, dadId) {
  const next = nextAction ? scrubDadSay(String(nextAction), dadId) : null;
  if (!next) return null;
  const bare = next.replace(/[.!?]+$/, "");
  return scrubDadSay(`Next: ${bare}.`, dadId);
}
