// Slice 17 — Legal Intake seat (synthetic Alex only).
// Intake + triage + handoff DRAFT · never answers the law · who / what /
// urgency menu (dad decides) · human-review flags · emergency feel →
// human, no numbers or jurisdiction invented · draft ≠ send (sent_at null)
// · decode → Process Translator · no SSNs · no N&L / NNO bleed ·
// not Coach / Quill / Parenting Plan / Translator-as-advice.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import {
  DRAFT_FOOTER,
  FLAG_LABELS,
  HUMAN_LINE,
  LAWYER_LINE,
  capture,
  nextStep,
  renderPacket,
} from "../src/legalintake.js";
import * as logger from "../src/logger.js";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const NOW = Date.parse("2026-09-27T12:00:00Z");
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b/;
// Bot-authored text must never answer the law or offer strategy.
const ADVICE_RE = /\byou should\b|\bwe recommend\b|\byour (best )?options? (is|are)\b|\bfile (a|an|for)\b|\byou (will|'ll) (win|lose)\b|\bstrategy\b|\boption [a-c]\b/i;
const EMERGENCY_INVENT_RE = /\b911\b|\b988\b|\bhotline\b|\bin (your|most) (state|county)\b|\bjurisdiction\b|\bcall the police\b/i;
const BLEED_RE = /\bN\s*&\s*L\b|\bNNO\b|wealth builders/i;

const ALEX = {
  who: "co_parent",
  urgency: "this_week",
  what: [
    "Jordan kept the kids past Sunday's exchange and says she won't return them until Wednesday.",
    "My lawyer mentioned a hearing on October 14. She also wants $1,200 for camp.",
    "SSN 123-45-6789, call me at (904) 555-0142.",
    "Also slammed at Team N&L this week. What should I do? Should I fire my lawyer?",
  ].join(" "),
};

async function start() {
  logger.reset();
  const vault = new Vault();
  const bff = makeBff(vault, { now: NOW });
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  return {
    vault,
    bff,
    base: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function jsonReq(base, method, path, body, { token } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function dad(base) {
  return (await jsonReq(base, "POST", "/vault/provision", {})).data;
}

test("bot-authored text: loud lawyer line, never law, never strategy, no invented emergency numbers", () => {
  const all = [LAWYER_LINE, DRAFT_FOOTER, HUMAN_LINE, ...Object.values(FLAG_LABELS)].join("\n");
  assert.match(LAWYER_LINE, /^CONFIRM WITH YOUR LAWYER\./);
  assert.match(LAWYER_LINE, /does not answer the law/);
  assert.doesNotMatch(all, ADVICE_RE);
  assert.doesNotMatch(all, EMERGENCY_INVENT_RE);
  assert.match(DRAFT_FOOTER, /DRAFT ONLY — not sent/);
});

test("capture v1: who / what / urgency menus; what is PII-stripped; bad input 400", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const post = (b) => jsonReq(s.base, "POST", "/vault/legal/intake", { dad_id, ...b }, { token });
    assert.equal((await post({ ...ALEX, who: "judge_judy" })).status, 400);
    assert.equal((await post({ ...ALEX, urgency: "emergency" })).status, 400, "no bot-decided emergency tier");
    assert.equal((await post({ ...ALEX, what: "" })).status, 400);
    assert.equal((await post({ ...ALEX, what: "x".repeat(2001) })).status, 400);

    const r = await post(ALEX);
    assert.equal(r.status, 200);
    assert.equal(r.data.who, "co_parent");
    assert.equal(r.data.urgency, "this_week", "urgency is exactly the dad's pick");
    assert.equal(r.data.claim, true);
    assert.equal(r.data.verified, false);
    assert.doesNotMatch(r.data.what, SSN_RE);
    assert.doesNotMatch(r.data.what, /555-0142|1,200/);
    assert.match(r.data.what, /\[amount\] for camp/);
    assert.doesNotMatch(r.data.what, BLEED_RE, "no N&L / NNO bleed");
    const row = s.vault.legal_intakes.at(-1);
    assert.doesNotMatch(row.what_cold, SSN_RE);
    assert.equal(row.claim_status, "claim");
  } finally {
    await s.close();
  }
});

test("human-review flags: safety, deadline, fire-my-lawyer, custody-emergency feel, money, out-of-venture", () => {
  const f = (what, urgency = "not_sure") => capture({ who: "other", what, urgency }).flags;
  assert.deepEqual(f("He threatened me and I'm scared for the kids."), ["safety"]);
  assert.deepEqual(f("The paper says I must respond by a deadline."), ["deadline_language"]);
  assert.deepEqual(f("I think I need to fire my lawyer."), ["fire_lawyer"]);
  assert.deepEqual(f("She took the kids and left the state."), ["custody_emergency"]);
  assert.deepEqual(f("She says I owe $450."), ["money_numbers"]);
  assert.deepEqual(f("Mention of NNO leads."), ["out_of_venture"]);
  assert.deepEqual(f("Pickup went fine today."), []);

  const all = capture(ALEX);
  assert.deepEqual(all.flags, ["deadline_language", "fire_lawyer", "custody_emergency", "money_numbers", "out_of_venture"]);
});

test("emergency feel → human_review + human line; never 911 / jurisdiction; dad's urgency untouched", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const post = (b) => jsonReq(s.base, "POST", "/vault/legal/intake", { dad_id, ...b }, { token });
    const e = await post({ who: "co_parent", urgency: "not_sure", what: "She took the kids and won't return them. I can't find my son." });
    assert.equal(e.data.human_review, true);
    assert.equal(e.data.human_line, HUMAN_LINE);
    assert.equal(e.data.urgency, "not_sure", "the bot never upgrades urgency");
    assert.doesNotMatch(JSON.stringify(e.data), EMERGENCY_INVENT_RE);

    const today = await post({ who: "school", urgency: "today", what: "School called about a pickup form." });
    assert.equal(today.data.human_review, true, "dad picked 'today' → a person looks");

    const calm = await post({ who: "school", urgency: "this_month", what: "Pickup went fine." });
    assert.equal(calm.data.human_review, false);
    assert.equal(calm.data.human_line, null);
  } finally {
    await s.close();
  }
});

test("split: decode-this-paper → Process Translator (no packet); 'what should I do?' stays here", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const post = (b) => jsonReq(s.base, "POST", "/vault/legal/intake", { dad_id, ...b }, { token });
    const d = await post({ who: "court", urgency: "not_sure", what: "Got a motion to compel. What does this mean?" });
    assert.equal(d.data.route, "process_translator");
    assert.equal(d.data.next.seat, "process_translator");
    const h = await jsonReq(s.base, "POST", "/vault/legal/handoff", { dad_id, id: d.data.id }, { token });
    assert.equal(h.status, 409, "decode questions get no handoff packet");
    assert.equal(s.vault.translations.length, 0, "points to the Translator; does not run it");

    const w = await post({ who: "court", urgency: "not_sure", what: "Got a motion to compel. What should I do?" });
    assert.equal(w.data.route, "lawyer_handoff");
    assert.equal(w.data.next.seat, "legal_intake");
  } finally {
    await s.close();
  }
});

test("handoff draft: versioned packet, sent_at null, no send path, claim footer, ONE next", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const i = await jsonReq(s.base, "POST", "/vault/legal/intake", { dad_id, ...ALEX }, { token });
    assert.equal(i.data.next.line, "Build the handoff draft for your lawyer.");
    assert.equal(typeof i.data.next.line, "string", "one next, not a menu");

    const h1 = await jsonReq(s.base, "POST", "/vault/legal/handoff", { dad_id }, { token });
    assert.equal(h1.status, 200);
    assert.equal(h1.data.handoff.version, 1);
    assert.equal(h1.data.handoff.sent_at, null);
    assert.equal(h1.data.handoff.status, "draft");
    const body = h1.data.handoff.body;
    assert.match(body, /^HANDOFF PACKET — DRAFT v1 \(NOT SENT\)\nCONFIRM WITH YOUR LAWYER\./);
    assert.match(body, /Who: The other parent\nUrgency \(dad's pick\): This week/);
    assert.match(body, /Flagged for human review:\n- Read this first/);
    assert.match(body, /- Deadline language — confirm the exact date with your lawyer\./);
    assert.match(body, /Questions for my lawyer:\n- What do you need from me on this, and by when\?/);
    assert.ok(body.endsWith(DRAFT_FOOTER));
    assert.doesNotMatch(body, SSN_RE);
    assert.doesNotMatch(body, BLEED_RE);
    assert.match(h1.data.next.line, /Nothing has been sent/);

    // Bot-authored part of the packet (everything but the dad's own words)
    // never answers the law.
    const botPart = body.replace(i.data.what, "");
    assert.doesNotMatch(botPart, ADVICE_RE);
    assert.doesNotMatch(botPart, EMERGENCY_INVENT_RE);

    const h2 = await jsonReq(s.base, "POST", "/vault/legal/handoff", { dad_id, id: i.data.id }, { token });
    assert.equal(h2.data.handoff.version, 2);
    const got = await jsonReq(s.base, "GET", `/vault/legal/intake?dad_id=${dad_id}&id=${i.data.id}`, null, { token });
    assert.equal(got.data.handoff.version, 2);
    assert.ok(s.vault.legal_handoff_drafts.every((d) => d.sent_at === null));

    for (const path of ["/vault/legal/send", "/vault/legal/handoff/send", "/vault/legal/email"]) {
      assert.equal((await jsonReq(s.base, "POST", path, { dad_id }, { token })).status, 404, `no ${path}`);
    }
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      assert.equal((await jsonReq(s.base, method, "/vault/legal/handoff", { dad_id }, { token })).status, 404);
    }
  } finally {
    await s.close();
  }
});

test("get: latest by default, by id, 404 none, 400 bad id", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    assert.equal((await jsonReq(s.base, "GET", `/vault/legal/intake?dad_id=${dad_id}`, null, { token })).status, 404);
    assert.equal((await jsonReq(s.base, "POST", "/vault/legal/handoff", { dad_id }, { token })).status, 404);
    const a = await jsonReq(s.base, "POST", "/vault/legal/intake", { dad_id, ...ALEX }, { token });
    const b = await jsonReq(s.base, "POST", "/vault/legal/intake", { dad_id, who: "school", urgency: "this_month", what: "Report card came home." }, { token });
    assert.equal((await jsonReq(s.base, "GET", `/vault/legal/intake?dad_id=${dad_id}`, null, { token })).data.id, b.data.id);
    assert.equal((await jsonReq(s.base, "GET", `/vault/legal/intake?dad_id=${dad_id}&id=${a.data.id}`, null, { token })).data.id, a.data.id);
    assert.equal((await jsonReq(s.base, "GET", `/vault/legal/intake?dad_id=${dad_id}&id=nope`, null, { token })).status, 400);
  } finally {
    await s.close();
  }
});

test("anti-jobs + logs: no Quill event, Coach/OFW row, plan, translator, candidates; logs ids + keys only", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    await jsonReq(s.base, "POST", "/vault/legal/intake", { dad_id, ...ALEX }, { token });
    await jsonReq(s.base, "POST", "/vault/legal/handoff", { dad_id }, { token });
    assert.equal((await s.vault.listEvents(dad_id)).length, 0, "not Quill");
    assert.equal(s.vault.communications.length, 0, "not Coach, not OFW, no send");
    assert.equal(s.vault.plan_topics.length + s.vault.plan_drafts.length, 0, "not Parenting Plan");
    assert.equal(s.vault.translations.length, 0, "not Process Translator");
    assert.equal(s.vault.candidate_facts.length + s.vault.notifications.length, 0);
    assert.equal(s.vault.involvement_fields.length, 0);
    const verified = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(verified.data, []);
    const logs = logger.lines().join("\n");
    assert.match(logs, /legal\.capture .*route=lawyer_handoff/);
    assert.doesNotMatch(logs, /Jordan|camp|October|HANDOFF PACKET|fire my/i);
  } finally {
    await s.close();
  }
});

test("tenancy: 401 without token, 403 with another dad's token, 404 across dads by id", async () => {
  const s = await start();
  try {
    const a = await dad(s.base);
    const b = await dad(s.base);
    assert.equal((await jsonReq(s.base, "POST", "/vault/legal/intake", { dad_id: a.dad_id, ...ALEX })).status, 401);
    assert.equal((await jsonReq(s.base, "POST", "/vault/legal/intake", { dad_id: b.dad_id, ...ALEX }, { token: a.token })).status, 403);
    const bi = await jsonReq(s.base, "POST", "/vault/legal/intake", { dad_id: b.dad_id, ...ALEX }, { token: b.token });
    assert.equal(
      (await jsonReq(s.base, "GET", `/vault/legal/intake?dad_id=${a.dad_id}&id=${bi.data.id}`, null, { token: a.token })).status,
      404,
      "an id from another dad is not found",
    );
    assert.equal((await jsonReq(s.base, "POST", "/vault/legal/handoff", { dad_id: a.dad_id, id: bi.data.id }, { token: a.token })).status, 404);
  } finally {
    await s.close();
  }
});

test("pure: packet deterministic; nextStep one line per state", () => {
  const c = { ...capture(ALEX), id: "00000000-0000-0000-0000-000000000000" };
  assert.equal(renderPacket(c, 3, "2026-09-27"), renderPacket(c, 3, "2026-09-27"));
  assert.equal(nextStep({ ...c, route: "process_translator" }).seat, "process_translator");
  assert.match(nextStep(c, true).line, /you send it yourself/);
});

test("CHIP_APP §14 pointer + dad template: never answers the law, draft never sent", () => {
  const app = read("CHIP_APP.md");
  assert.match(app, /### 14\) Legal Intake seat — Slice 17 \(pointer\)/);
  assert.match(app, /Never answers the law\./);
  assert.match(app, /`sent_at: null`, never sent/);
  const dadT = read("CHIP_DAD_TEMPLATE.md");
  assert.match(dadT, /## Legal Intake \(Slice 17\)/);
  assert.match(dadT, /Chip never sends it/);
});
