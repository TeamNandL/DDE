// Parenting Plan seat — Slice 14. Pure catalog + rules, no I/O.
//
// Finite topic checklist (core six, easiest → hardest). Every topic:
//   explainer  — the term in plain English, said BEFORE the question
//   question   — one question, answered from a MENU only (no free text,
//                so nothing like an SSN can ever land here)
//   deeper     — opt-in second menu (depth 'deeper'); 'simple' is default
//   example    — the ONE example offered when the dad is stuck
//
// Wording is DDE's own, topic-level only — never copied from any purchased
// or court plan form. Menus, not advice: every surface carries the lawyer
// line, and the seat assumes the dad HAS a lawyer (not pro-se).

export const LAWYER_LINE =
  "Confirm every choice with your lawyer before it goes anywhere. This is a menu, not legal advice.";

export const TIE_BREAKER_LINE = "Ask for it. You can always give it back later.";

export const STANCES = ["want", "trade_bait"];
export const DEPTHS = ["simple", "deeper"];
export const DRAFT_KINDS = ["full", "prep"];

const opt = (key, label) => ({ key, label });

export const PLAN_TOPICS = [
  {
    key: "exchanges",
    title: "Exchanges",
    explainer: "Exchanges are where and how the kids move from one home to the other.",
    question: "Where should exchanges happen?",
    options: [
      opt("school_daycare", "At school or daycare (no face-to-face)"),
      opt("curbside", "Curbside at a home"),
      opt("neutral_public", "A neutral public place"),
      opt("supervised_center", "A supervised exchange center"),
    ],
    deeper: {
      question: "Who drives?",
      options: [
        opt("receiving_parent", "The receiving parent picks up"),
        opt("delivering_parent", "The delivering parent drops off"),
        opt("split_driving", "Split the driving"),
      ],
    },
    example: "Some families use school pickup on exchange days, so the parents never have to meet.",
  },
  {
    key: "holidays",
    title: "Holidays and breaks",
    explainer:
      "Holidays and school breaks say who has the kids on those days. They usually override the regular week-to-week schedule.",
    question: "How should holidays be shared?",
    options: [
      opt("alternate_years", "Alternate each holiday by year (even / odd)"),
      opt("split_day", "Split each holiday day"),
      opt("fixed_holidays", "Each parent keeps the same holidays every year"),
    ],
    deeper: {
      question: "How should summer break work?",
      options: [
        opt("summer_equal", "Split summer equally"),
        opt("summer_blocks", "Extended blocks for each parent"),
        opt("summer_regular", "Keep the regular schedule"),
      ],
    },
    example: "In even years one parent has Thanksgiving; in odd years the other parent does.",
  },
  {
    key: "schedule",
    title: "Regular schedule",
    explainer: "The regular schedule is the normal week-to-week calendar of which home the kids sleep at.",
    question: "What regular schedule do you want to ask for?",
    options: [
      opt("equal_223", "Equal time — 2-2-3 rotation"),
      opt("equal_week_on", "Equal time — week on / week off"),
      opt("equal_5225", "Equal time — 5-2-2-5"),
      opt("alt_weekends_midweek", "Every other weekend plus a midweek visit"),
    ],
    deeper: {
      question: "Anything midweek?",
      options: [
        opt("midweek_overnight", "A midweek overnight"),
        opt("midweek_dinner", "A midweek dinner only"),
        opt("midweek_none", "Nothing midweek"),
      ],
    },
    example: "Week on / week off means the kids switch homes on the same day every week, like Friday after school.",
  },
  {
    key: "rofr",
    title: "Right of first refusal",
    explainer:
      "Right of first refusal means: if a parent can't care for the kids during their own time for a set stretch, the other parent gets asked first — before a sitter.",
    question: "Do you want right of first refusal?",
    options: [
      opt("rofr_4h", "Yes — when it's 4 hours or more"),
      opt("rofr_overnight", "Yes — overnights only"),
      opt("rofr_none", "No right of first refusal"),
    ],
    deeper: {
      question: "How fast should the other parent have to answer?",
      options: [
        opt("respond_1h", "Within 1 hour"),
        opt("respond_same_day", "The same day"),
      ],
    },
    example: "If one parent has a night shift on their time, the other parent is asked first before a babysitter is called.",
  },
  {
    key: "medical_access",
    title: "Medical access",
    explainer:
      "Medical access means both parents can see the kids' medical, dental, and counseling records and get told about appointments. Being kept out of medical information or appointments is a documentable pattern: log each time — what and when — without guessing why.",
    question: "What medical access do you want to ask for?",
    options: [
      opt("equal_access_notice", "Equal access to every provider, plus notice of every appointment"),
      opt("shared_portal", "Both parents on every patient portal"),
      opt("shared_calendar", "Every appointment on a shared calendar"),
      opt("emergency_notice_only", "Notice for emergencies only"),
    ],
    deeper: {
      question: "How much notice before routine appointments?",
      options: [
        opt("notice_48h", "48 hours before"),
        opt("notice_same_day", "The same day"),
        opt("notice_asap_emergency", "As soon as possible for emergencies"),
      ],
    },
    example:
      "Both parents are listed on the pediatrician's portal, and routine appointments go on the shared calendar 48 hours ahead.",
  },
  {
    key: "decision_making",
    title: "Decision-making and tie-breaker",
    explainer:
      "Decision-making covers who decides the big things — school, health, religion. A tie-breaker gives one parent the final say in an area after an honest try to agree.",
    question: "How should major decisions be made?",
    ask_line: TIE_BREAKER_LINE,
    options: [
      opt("shared_tiebreaker_you", "Shared, with you as tie-breaker"),
      opt("shared_tiebreaker_split", "Shared, tie-breaker split by area"),
      opt("shared_mediator", "Shared, with a mediator if you disagree"),
      opt("one_parent", "One parent decides"),
    ],
    deeper: {
      question: "Which areas should your tie-breaker cover?",
      options: [
        opt("tb_education", "Education"),
        opt("tb_health", "Health"),
        opt("tb_activities", "Activities"),
        opt("tb_all", "All areas"),
      ],
    },
    example: "Decisions are shared; if the parents can't agree after talking, one parent has the final call on school.",
  },
];

export const TOPIC_KEYS = PLAN_TOPICS.map((t) => t.key);
const BY_KEY = new Map(PLAN_TOPICS.map((t) => [t.key, t]));

export function topicDef(key) {
  return BY_KEY.get(key) ?? null;
}

function labelOf(def, key, deeper = false) {
  const list = deeper ? def.deeper.options : def.options;
  return list.find((o) => o.key === key)?.label ?? null;
}

/** The one-question prompt Chip says for a topic (term explained first). */
export function topicPrompt(key, depth = "simple") {
  const def = topicDef(key);
  if (!def) return null;
  const deeper = depth === "deeper";
  return {
    topic: def.key,
    title: def.title,
    explainer: def.explainer,
    question: deeper ? def.deeper.question : def.question,
    options: deeper ? def.deeper.options : def.options,
    depth: deeper ? "deeper" : "simple",
    ...(def.ask_line ? { ask_line: def.ask_line } : {}),
    skippable: true,
    lawyer_line: LAWYER_LINE,
  };
}

/** Validate a menu answer. Throws {status:400} on anything off-menu. */
export function checkAnswer({ topic, choice, stance = "want", depth = "simple", detail = null }) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  const def = topicDef(topic);
  if (!def) throw bad("unknown topic");
  if (!labelOf(def, choice)) throw bad("choice must be one of the topic's menu keys");
  if (!STANCES.includes(stance)) throw bad("stance must be want or trade_bait");
  if (!DEPTHS.includes(depth)) throw bad("depth must be simple or deeper");
  if (depth === "simple" && detail) throw bad("detail needs depth deeper");
  if (depth === "deeper" && !labelOf(def, detail, true)) {
    throw bad("detail must be one of the topic's deeper menu keys");
  }
  return { topic, choice, stance, depth, detail: depth === "deeper" ? detail : null };
}

/** Next open topic in catalog order (answered and parked are skipped). */
export function nextTopic(rows) {
  const byKey = new Map(rows.map((r) => [r.topic_key, r]));
  for (const key of TOPIC_KEYS) {
    const r = byKey.get(key);
    if (r && r.status === "open") return key;
  }
  return null;
}

const HEADER = "CONFIRM EVERY LINE WITH YOUR LAWYER. Menu picks only — not legal advice.";

function ordered(rows) {
  const byKey = new Map(rows.map((r) => [r.topic_key, r]));
  return TOPIC_KEYS.map((k) => byKey.get(k)).filter(Boolean);
}

function answerLine(r) {
  const def = topicDef(r.topic_key);
  let line = `${def.title}: ${labelOf(def, r.choice)}.`;
  if (r.detail) line += ` ${def.deeper.question} ${labelOf(def, r.detail, true)}.`;
  return line;
}

/**
 * Bot-owned draft text, regenerated from the answer store. 'full' = the
 * working plan; 'prep' = the one-page sheet for the lawyer meeting.
 */
export function renderDraft(kind, rows, version) {
  const list = ordered(rows);
  const answered = list.filter((r) => r.status === "answered");
  const parked = list.filter((r) => r.status === "parked");
  const open = list.filter((r) => r.status === "open");
  const out = [];
  if (kind === "prep") {
    out.push(`LAWYER PREP SHEET — v${version}`, HEADER, "");
    out.push("Ask for (wants):");
    for (const r of answered.filter((x) => x.stance === "want")) out.push(`- ${answerLine(r)}`);
    out.push("", "Trade bait (can give back):");
    for (const r of answered.filter((x) => x.stance === "trade_bait")) out.push(`- ${answerLine(r)}`);
    out.push("", "Parked — work these through with your lawyer:");
    for (const r of parked) out.push(`- ${topicDef(r.topic_key).title}`);
    out.push("", "Questions for your lawyer:");
    for (const r of parked) out.push(`- Walk me through my options on ${topicDef(r.topic_key).title.toLowerCase()}.`);
    if (answered.some((r) => r.topic_key === "decision_making" && r.choice.startsWith("shared_tiebreaker"))) {
      out.push("- How do we ask for a tie-breaker, and what would I be willing to give back?");
    }
    out.push("- Does anything here not fit how it usually works where we live?");
  } else {
    out.push(`PARENTING PLAN — WORKING DRAFT v${version}`, HEADER, "");
    let n = 0;
    for (const r of answered) {
      n += 1;
      const tag = r.stance === "trade_bait" ? "Trade bait" : "Want";
      out.push(`${n}. ${answerLine(r)} [${tag}]`);
    }
    if (parked.length) {
      out.push("", "Parked — bring to your lawyer:");
      for (const r of parked) out.push(`- ${topicDef(r.topic_key).title}`);
    }
    if (open.length) {
      out.push("", "Not answered yet:");
      for (const r of open) out.push(`- ${topicDef(r.topic_key).title}`);
    }
  }
  return out.join("\n");
}
