// Slice 15 — Process Translator (synthetic Alex only).
// Dictionary ≠ coach · paste or named term → what it IS + mechanics +
// awareness · never a personal verdict · loud lawyer line every result ·
// clocks flagged, never counted · calendar candidates private_only, never
// OFW · lawyer-relationship literacy, never "replace your lawyer" ·
// not Coach / Quill / Parenting Plan / Legal Intake.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import {
  CLOCK_LINE,
  LAWYER_LINE,
  TERMS,
  TERM_KEYS,
  VERDICT_LINE,
  calendarCandidates,
  explain,
  isVerdictRequest,
  lookupTerm,
} from "../src/translator.js";
import * as logger from "../src/logger.js";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b/;
const DAY_COUNT_RE = /\b\d+\s*(calendar\s+|business\s+|court\s+)?days?\b|\b(ten|twenty|thirty|sixty|ninety)\s+days?\b/i;
// A verdict STATEMENT ("this is bad for you", "you'll win") — the refusal
// line "if this is good or bad for you" is not one.
const VERDICT_WORDS_RE = /\b(this|that|it)('s| is) (good|bad|great|terrible) for you\b|\byou('ll| will) (win|lose)\b|\byou('re| are) (fine|screwed|in trouble|going to (win|lose))\b/i;
const FIRE_RE = /fire (your|him|her|them|the) lawyer|new lawyer|replace (your|the) lawyer|switch lawyers|drop your lawyer/i;
const STATE_RE = /\b(Florida|Texas|California|Georgia|New York|Ohio)\b/;

const ALEX_PASTE = [
  "IN THE CIRCUIT COURT. In re the marriage of Alex Rivera and Jordan Rivera.",
  "Alex Rivera, SSN 123-45-6789, 482 Maple Street Apt 3, (904) 555-0142, alex@example.com.",
  "NOTICE OF HEARING: the Motion for Temporary Orders is set for hearing on October 14, 2026 at 9:00 AM.",
  "Mediation is scheduled for 11/03/2026.",
  "Respondent must respond within 20 days after service. Failure to respond may result in a default.",
  "Is this bad for me?",
].join("\n");

async function start() {
  logger.reset();
  const vault = new Vault();
  const bff = makeBff(vault);
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

test("catalog: every term has what/how/aware/ask; DDE-worded; no day-counts, no state tables, no verdicts", () => {
  assert.ok(TERMS.length >= 20);
  assert.equal(new Set(TERM_KEYS).size, TERM_KEYS.length);
  for (const t of TERMS) {
    assert.ok(t.what && t.how && t.aware && t.ask && t.aliases.length, `${t.key} incomplete`);
    assert.ok(["process", "lawyer"].includes(t.kind));
    assert.equal(typeof t.clock, "boolean");
  }
  const all = JSON.stringify(TERMS) + LAWYER_LINE + CLOCK_LINE + VERDICT_LINE;
  assert.doesNotMatch(all, DAY_COUNT_RE, "never exact day-counts");
  assert.doesNotMatch(all, STATE_RE, "never a 50-state table");
  assert.doesNotMatch(all, VERDICT_WORDS_RE, "never a personal verdict");
  assert.doesNotMatch(all, FIRE_RE, "never 'fire your lawyer'");
  assert.match(LAWYER_LINE, /^CONFIRM WITH YOUR LAWYER\./);
  assert.match(LAWYER_LINE, /not your case/);
  assert.match(LAWYER_LINE, /Not legal advice/);
  // Soft second job exists.
  assert.ok(TERMS.filter((t) => t.kind === "lawyer").length >= 3);
});

test("named term → plain English what it IS + mechanics + awareness + lawyer ask; aliases resolve", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const r = await jsonReq(s.base, "POST", "/vault/translate/explain", { dad_id, term: "What is a GAL?" }, { token });
    assert.equal(r.status, 200);
    assert.equal(r.data.input_kind, "term");
    assert.deepEqual(r.data.term_keys, ["guardian_ad_litem"]);
    const [g] = r.data.terms;
    assert.match(g.what_it_is, /court appoints/);
    assert.ok(g.how_it_works && g.be_aware && g.ask_your_lawyer);
    assert.equal(r.data.lawyer_line, LAWYER_LINE);
    assert.ok(r.data.headline.startsWith(LAWYER_LINE), "loud lawyer line leads");
    assert.equal(r.data.calendar_candidates.length, 0, "named term never yields dates");

    assert.equal(lookupTerm("interrogatories").key, "interrogatories");
    assert.equal(lookupTerm("ex parte").key, "emergency_motion");
    assert.equal(lookupTerm("what does default mean?").key, "default");

    const unk = await jsonReq(s.base, "POST", "/vault/translate/explain", { dad_id, term: "quantum escrow" }, { token });
    assert.equal(unk.status, 200);
    assert.equal(unk.data.not_found, true);
    assert.ok(unk.data.headline.startsWith(LAWYER_LINE));
    assert.match(unk.data.ask_your_lawyer[0], /What is this/);
  } finally {
    await s.close();
  }
});

test("paste → terms found, clock flagged without a count, verdict → sharp lawyer ask, PII stripped", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const r = await jsonReq(s.base, "POST", "/vault/translate/explain", { dad_id, text: ALEX_PASTE }, { token });
    assert.equal(r.status, 200);
    assert.equal(r.data.input_kind, "paste");
    for (const k of ["hearing", "temporary_orders", "mediation"]) assert.ok(r.data.term_keys.includes(k), k);
    assert.ok(r.data.term_keys.length <= 5);

    // Clock: flagged, never counted.
    assert.equal(r.data.clock_flag, true);
    assert.equal(r.data.clock, CLOCK_LINE);
    const out = JSON.stringify(r.data);
    assert.doesNotMatch(out, DAY_COUNT_RE, "the paste's '20 days' is never echoed or computed");

    // Dictionary ≠ coach.
    assert.equal(r.data.verdict_request, true);
    assert.equal(r.data.verdict.line, VERDICT_LINE);
    assert.match(r.data.ask_your_lawyer[0], /good or bad for me/);
    assert.doesNotMatch(out, VERDICT_WORDS_RE);

    // No SSN / PII in the response or the stored row.
    assert.doesNotMatch(out, SSN_RE);
    const row = s.vault.translations.at(-1);
    assert.doesNotMatch(row.input_cold, SSN_RE);
    assert.doesNotMatch(row.input_cold, /555-0142|alex@example\.com|482 Maple/);
    assert.match(row.input_cold, /\[tax-id\]/);
  } finally {
    await s.close();
  }
});

test("verdict detector: good/bad for me, win/lose, chances → flagged; plain definitions → not", () => {
  for (const q of ["Is this good for me?", "is this bad for me", "Am I going to lose custody?", "will I win", "what are my chances", "Should I sign this?"]) {
    assert.ok(isVerdictRequest(q), q);
  }
  for (const q of ["what is mediation", "Motion to compel", "NOTICE OF HEARING"]) assert.ok(!isVerdictRequest(q), q);
  const r = explain({ term: "is mediation good for me?" });
  assert.deepEqual(r.term_keys, ["mediation"]);
  assert.equal(r.verdict_request, true);
  assert.equal(r.result.verdict.ask, "Given my facts, is this good or bad for me — and what's our move?");
});

test("calendar candidates: private_only, claim ≠ verified, no write target, never OFW / events / calendar", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const r = await jsonReq(s.base, "POST", "/vault/translate/explain", { dad_id, text: ALEX_PASTE }, { token });
    const c = r.data.calendar_candidates;
    assert.deepEqual(c.map((x) => [x.label, x.on_date]), [["Hearing", "2026-10-14"], ["Mediation", "2026-11-03"]]);
    for (const x of c) {
      assert.equal(x.visibility, "private_only");
      assert.equal(x.status, "candidate");
      assert.equal(x.verified, false);
      assert.equal(x.write_target, null);
    }
    assert.match(r.data.calendar_line, /private to you, not verified, not sent anywhere/);
    assert.equal(s.vault.translator_calendar_candidates.length, 2);

    // Anti-jobs: no OFW row, no intake event (Quill), no Coach draft, no
    // court-prep candidate / check-in, no plan row, nothing verified.
    assert.equal(s.vault.communications.length, 0, "never OFW / Coach");
    assert.equal((await s.vault.listEvents(dad_id)).length, 0, "not Quill / not Legal Intake");
    assert.equal(s.vault.candidate_facts.length, 0, "not court-prep capture");
    assert.equal(s.vault.notifications.length, 0);
    assert.equal(s.vault.plan_topics.length, 0, "not Parenting Plan");
    const verified = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(verified.data, []);

    // Invalid dates never become candidates.
    assert.equal(calendarCandidates("hearing on 02/30/2026").length, 0);
  } finally {
    await s.close();
  }
});

test("lawyer-relationship literacy: norms + what to raise; never 'fire your lawyer'", () => {
  for (const q of ["retainer", "my lawyer isn't responding", "red flags", "what should I ask my lawyer"]) {
    const r = explain({ term: q });
    assert.equal(r.result.terms[0]?.kind, "lawyer", q);
    assert.doesNotMatch(JSON.stringify(r.result), FIRE_RE);
    assert.ok(r.result.headline.startsWith(LAWYER_LINE));
  }
});

test("endpoints: explain · last · list; bad input 400; nothing yet 404; no edit path", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const post = (b) => jsonReq(s.base, "POST", "/vault/translate/explain", { dad_id, ...b }, { token });

    assert.equal((await jsonReq(s.base, "GET", `/vault/translate/last?dad_id=${dad_id}`, null, { token })).status, 404);
    assert.equal((await post({})).status, 400, "needs term or text");
    assert.equal((await post({ term: "motion", text: "motion" })).status, 400, "exactly one");
    assert.equal((await post({ text: "x".repeat(8001) })).status, 400, "paste cap");
    assert.equal((await post({ file: "petition.pdf" })).status, 400, "no upload in V1");

    const a = await post({ term: "subpoena" });
    const b = await post({ text: "Notice of deposition. Deposition set for 2026-12-01." });
    const last = await jsonReq(s.base, "GET", `/vault/translate/last?dad_id=${dad_id}`, null, { token });
    assert.equal(last.status, 200);
    assert.equal(last.data.id, b.data.id);
    assert.deepEqual(last.data.term_keys, ["deposition"]);
    assert.equal(last.data.calendar_candidates[0].on_date, "2026-12-01");
    assert.equal(last.data.lawyer_line, LAWYER_LINE);

    const list = await jsonReq(s.base, "GET", `/vault/translate/list?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(list.data.items.map((i) => i.id), [b.data.id, a.data.id]);
    assert.ok(!("input_cold" in list.data.items[0]) && !("result" in list.data.items[0]));

    for (const method of ["PUT", "PATCH", "DELETE"]) {
      assert.equal((await jsonReq(s.base, method, "/vault/translate/last", { dad_id }, { token })).status, 404);
    }
  } finally {
    await s.close();
  }
});

test("tenancy + log hygiene: 401 no token, 403 other dad, logs ids + keys only", async () => {
  const s = await start();
  try {
    const a = await dad(s.base);
    const b = await dad(s.base);
    assert.equal((await jsonReq(s.base, "POST", "/vault/translate/explain", { dad_id: a.dad_id, term: "motion" })).status, 401);
    assert.equal(
      (await jsonReq(s.base, "POST", "/vault/translate/explain", { dad_id: b.dad_id, term: "motion" }, { token: a.token })).status,
      403,
    );
    assert.equal((await jsonReq(s.base, "GET", `/vault/translate/last?dad_id=${b.dad_id}`, null, { token: a.token })).status, 403);
    assert.equal((await jsonReq(s.base, "GET", `/vault/translate/list?dad_id=${b.dad_id}`, null, { token: a.token })).status, 403);

    await jsonReq(s.base, "POST", "/vault/translate/explain", { dad_id: a.dad_id, text: ALEX_PASTE }, { token: a.token });
    const logs = logger.lines().join("\n");
    assert.match(logs, /translate\.explain .*terms=hearing/);
    assert.doesNotMatch(logs, /Alex|Rivera|123-45-6789|October|Maple|CONFIRM/i, "never the paste or result text");
  } finally {
    await s.close();
  }
});

test("CHIP_APP §12 pointer + dad template: dictionary ≠ coach, private_only, MAP deferred", () => {
  const app = read("CHIP_APP.md");
  assert.match(app, /### 12\) Process Translator — Slice 15 \(pointer\)/);
  assert.match(app, /\*\*Dictionary, not coach\.\*\*/);
  assert.match(app, /visibility: private_only/);
  assert.match(app, /MAP: deferred\./);
  for (const r of ["/vault/translate/explain", "/vault/translate/last", "/vault/translate/list"]) assert.ok(app.includes(r), r);
  const dadT = read("CHIP_DAD_TEMPLATE.md");
  assert.match(dadT, /## Process Translator \(Slice 15\)/);
  assert.match(dadT, /never a\s+day-count/);
});
