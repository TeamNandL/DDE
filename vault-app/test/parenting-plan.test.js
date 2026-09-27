// Slice 14 — Parenting Plan seat (synthetic Alex only).
// Finite checklist · menus only · want vs trade_bait · simple/deeper ·
// stuck = one example → park → move on · bot-owned versioned full/prep
// draft · tie-breaker "ask for it" · medical gatekeeping named plainly ·
// lawyer line everywhere · never Coach / Quill / OFW / court-prep.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import { PLAN_TOPICS, TOPIC_KEYS, LAWYER_LINE, TIE_BREAKER_LINE, renderDraft } from "../src/plan.js";
import * as logger from "../src/logger.js";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b/;

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

test("catalog: finite core six, easiest → hardest, every term explained, menus + one example", () => {
  assert.deepEqual(TOPIC_KEYS, ["exchanges", "holidays", "schedule", "rofr", "medical_access", "decision_making"]);
  assert.ok(PLAN_TOPICS.length <= 12);
  for (const t of PLAN_TOPICS) {
    assert.ok(t.explainer && t.question && t.example, `${t.key} incomplete`);
    assert.ok(t.options.length >= 2 && t.deeper.options.length >= 2, `${t.key} menus`);
    assert.equal(typeof t.example, "string", "exactly one example");
  }
  const dm = PLAN_TOPICS.find((t) => t.key === "decision_making");
  assert.equal(dm.ask_line, "Ask for it. You can always give it back later.");
  assert.equal(TIE_BREAKER_LINE, dm.ask_line);
  const med = PLAN_TOPICS.find((t) => t.key === "medical_access");
  assert.match(med.explainer, /documentable pattern/);
  assert.match(med.explainer, /without guessing why/);
  assert.doesNotMatch(JSON.stringify(PLAN_TOPICS), /on purpose|spite|alienat|narcissis/i, "never motive");
  assert.match(LAWYER_LINE, /Confirm every choice with your lawyer/);
  assert.match(LAWYER_LINE, /not legal advice/);
});

test("ensure is idempotent; next prompt explains the term first, menu only, skippable, lawyer line", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const first = await jsonReq(s.base, "POST", "/vault/plan/topics/ensure", { dad_id }, { token });
    assert.equal(first.status, 200);
    assert.equal(first.data.created, 6);
    const again = await jsonReq(s.base, "POST", "/vault/plan/topics/ensure", { dad_id }, { token });
    assert.equal(again.data.created, 0);

    const { next } = first.data;
    assert.equal(next.topic, "exchanges");
    assert.equal(next.depth, "simple", "simple is the default depth");
    assert.match(next.explainer, /^Exchanges are/);
    assert.ok(next.options.every((o) => o.key && o.label));
    assert.equal(next.skippable, true);
    assert.equal(next.lawyer_line, LAWYER_LINE);

    const deeper = await jsonReq(s.base, "GET", `/vault/plan/topics?dad_id=${dad_id}&depth=deeper`, null, { token });
    assert.equal(deeper.data.next.question, "Who drives?", "deeper is opt-in");
  } finally {
    await s.close();
  }
});

test("answers: menu keys only; want vs trade_bait; deeper needs a deeper-menu detail", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const post = (b) => jsonReq(s.base, "POST", "/vault/plan/answer", { dad_id, ...b }, { token });

    assert.equal((await post({ topic: "exchanges", choice: "my SSN is 123-45-6789" })).status, 400, "no free text");
    assert.equal((await post({ topic: "custody_of_the_dog", choice: "x" })).status, 400, "finite topics only");
    assert.equal((await post({ topic: "exchanges", choice: "curbside", stance: "maybe" })).status, 400);
    assert.equal((await post({ topic: "exchanges", choice: "curbside", detail: "split_driving" })).status, 400);
    assert.equal((await post({ topic: "exchanges", choice: "curbside", depth: "deeper", detail: "nope" })).status, 400);

    const a = await post({ topic: "exchanges", choice: "school_daycare", depth: "deeper", detail: "receiving_parent" });
    assert.equal(a.status, 200);
    assert.equal(a.data.topic.stance, "want", "want is the default stance");
    assert.equal(a.data.topic.detail_label, "The receiving parent picks up");
    assert.equal(a.data.next.topic, "holidays");

    const b = await post({ topic: "holidays", choice: "alternate_years", stance: "trade_bait" });
    assert.equal(b.data.topic.stance, "trade_bait");
    assert.equal(b.data.topic.depth, "simple");
    assert.equal(b.data.lawyer_line, LAWYER_LINE);
  } finally {
    await s.close();
  }
});

test("stuck rule: one example → park → move on; never a second example", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const stuck = () => jsonReq(s.base, "POST", "/vault/plan/stuck", { dad_id, topic: "rofr" }, { token });

    const one = await stuck();
    assert.equal(one.data.parked, false);
    assert.match(one.data.example, /asked first before a babysitter/);
    assert.equal(one.data.prompt.topic, "rofr");

    const two = await stuck();
    assert.equal(two.data.parked, true);
    assert.ok(!("example" in two.data), "no second example");
    assert.equal(two.data.topic.status, "parked");
    assert.equal(two.data.next.topic, "exchanges", "moves on to the next open topic");

    const three = await stuck();
    assert.equal(three.data.parked, true);
    assert.ok(!("example" in three.data), "still never a second example");

    // Direct park works too; parked topics are skipped by `next`.
    const park = await jsonReq(s.base, "POST", "/vault/plan/park", { dad_id, topic: "exchanges" }, { token });
    assert.equal(park.data.next.topic, "holidays");
    // A parked topic can still be answered later.
    const ans = await jsonReq(
      s.base, "POST", "/vault/plan/answer", { dad_id, topic: "rofr", choice: "rofr_4h" }, { token },
    );
    assert.equal(ans.data.topic.status, "answered");
  } finally {
    await s.close();
  }
});

test("bot-owned versioned drafts: full + prep regenerate, latest per kind, no outside edits", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const none = await jsonReq(s.base, "GET", `/vault/plan/draft?dad_id=${dad_id}`, null, { token });
    assert.equal(none.status, 404);

    const answer = (b) => jsonReq(s.base, "POST", "/vault/plan/answer", { dad_id, ...b }, { token });
    await answer({ topic: "exchanges", choice: "school_daycare" });
    await answer({ topic: "holidays", choice: "alternate_years", stance: "trade_bait" });
    await answer({ topic: "medical_access", choice: "shared_portal", depth: "deeper", detail: "notice_48h" });
    await answer({ topic: "decision_making", choice: "shared_tiebreaker_you" });
    await jsonReq(s.base, "POST", "/vault/plan/park", { dad_id, topic: "rofr" }, { token });

    const regen = (kind) => jsonReq(s.base, "POST", "/vault/plan/draft/regenerate", { dad_id, kind }, { token });
    const f1 = await regen("full");
    assert.equal(f1.data.version, 1);
    assert.match(f1.data.body, /^PARENTING PLAN — WORKING DRAFT v1\nCONFIRM EVERY LINE WITH YOUR LAWYER\./);
    assert.match(f1.data.body, /Exchanges: At school or daycare \(no face-to-face\)\. \[Want\]/);
    assert.match(f1.data.body, /Holidays and breaks: .* \[Trade bait\]/);
    assert.match(f1.data.body, /Medical access: Both parents on every patient portal\. How much notice before routine appointments\? 48 hours before\./);
    assert.match(f1.data.body, /Parked — bring to your lawyer:\n- Right of first refusal/);
    assert.match(f1.data.body, /Not answered yet:\n- Regular schedule/);

    const p2 = await regen("prep");
    assert.equal(p2.data.version, 2);
    assert.match(p2.data.body, /^LAWYER PREP SHEET — v2/);
    assert.match(p2.data.body, /Ask for \(wants\):\n- Exchanges/);
    assert.match(p2.data.body, /Trade bait \(can give back\):\n- Holidays/);
    assert.match(p2.data.body, /Walk me through my options on right of first refusal\./);
    assert.match(p2.data.body, /How do we ask for a tie-breaker/);

    const f3 = await regen("full");
    assert.equal(f3.data.version, 3);
    const latestFull = await jsonReq(s.base, "GET", `/vault/plan/draft?dad_id=${dad_id}`, null, { token });
    assert.equal(latestFull.data.version, 3);
    const latestPrep = await jsonReq(s.base, "GET", `/vault/plan/draft?dad_id=${dad_id}&kind=prep`, null, { token });
    assert.equal(latestPrep.data.version, 2);
    assert.equal(s.vault.plan_drafts.length, 3, "append-only versions");

    for (const method of ["PUT", "PATCH"]) {
      const edit = await jsonReq(s.base, method, "/vault/plan/draft", { dad_id, body: "my edits" }, { token });
      assert.equal(edit.status, 404, `no ${method} edit path`);
    }
    assert.equal((await regen("pdf")).status, 400);

    for (const d of s.vault.plan_drafts) assert.doesNotMatch(d.body, SSN_RE, "no SSNs / long digit runs");
  } finally {
    await s.close();
  }
});

test("anti-jobs: plan work writes no intake event, Coach draft, candidate, check-in, or verified row", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    await jsonReq(s.base, "POST", "/vault/plan/answer", { dad_id, topic: "exchanges", choice: "curbside" }, { token });
    await jsonReq(s.base, "POST", "/vault/plan/stuck", { dad_id, topic: "holidays" }, { token });
    await jsonReq(s.base, "POST", "/vault/plan/draft/regenerate", { dad_id, kind: "full" }, { token });
    assert.equal((await s.vault.listEvents(dad_id)).length, 0, "not Quill");
    assert.equal(s.vault.communications.filter((c) => c.dad_id === dad_id).length, 0, "not Coach / not OFW");
    assert.equal(s.vault.candidate_facts.length, 0, "not court-prep capture");
    assert.equal(s.vault.notifications.length, 0);
    const verified = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(verified.data, []);
    assert.doesNotMatch(logger.lines().join("\n"), /Curbside|PARENTING PLAN|school pickup|Thanksgiving/i, "logs: ids + keys only");
  } finally {
    await s.close();
  }
});

test("tenancy: 401 without token, 403 with another dad's token", async () => {
  const s = await start();
  try {
    const a = await dad(s.base);
    const b = await dad(s.base);
    assert.equal((await jsonReq(s.base, "GET", `/vault/plan/topics?dad_id=${a.dad_id}`)).status, 401);
    const cross = await jsonReq(
      s.base, "POST", "/vault/plan/answer",
      { dad_id: b.dad_id, topic: "exchanges", choice: "curbside" }, { token: a.token },
    );
    assert.equal(cross.status, 403);
    assert.equal(
      (await jsonReq(s.base, "GET", `/vault/plan/draft?dad_id=${b.dad_id}`, null, { token: a.token })).status,
      403,
    );
  } finally {
    await s.close();
  }
});

test("renderDraft is pure and deterministic from answers", () => {
  const rows = [
    { topic_key: "schedule", status: "answered", choice: "equal_week_on", stance: "want", detail: null },
    { topic_key: "exchanges", status: "open" },
  ];
  assert.equal(renderDraft("full", rows, 7), renderDraft("full", rows, 7));
  assert.match(renderDraft("full", rows, 7), /1\. Regular schedule: Equal time — week on \/ week off\. \[Want\]/);
});

test("CHIP_APP pointer: §11, BFF default, Planform stays soft-hidden, topic keys, lawyer line", () => {
  const app = read("CHIP_APP.md");
  assert.match(app, /### 11\) Parenting Plan seat — Slice 14 \(pointer\)/);
  assert.match(app, /Default path = these BFF routes\. Planform stays soft-hidden/);
  for (const k of TOPIC_KEYS) assert.ok(app.includes(`\`${k}\``), `pointer missing ${k}`);
  assert.match(app, /Ask for it\. You can always give it back later\./);
  const dadT = read("CHIP_DAD_TEMPLATE.md");
  assert.match(dadT, /## Parenting Plan \(Slice 14\)/);
  assert.match(dadT, /never write plan language yourself/);
});
