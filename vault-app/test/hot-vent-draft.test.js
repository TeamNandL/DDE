// Slice 19 — hot vent → complete calm court-safe draft (synthetic Alex).
// Five real-heat fixtures + the exact Round Two vent. Every result is
// either ONE complete clean draft that keeps the real issue / real ask, or
// NO body + a plain say. Never a fragment. Never the vent echoed. Draft ≠ send.

import test from "node:test";
import assert from "node:assert/strict";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import { FAILSAFE_SAY, calmRewrite, hasHeat, isCleanComplete } from "../src/calmdraft.js";
import * as logger from "../src/logger.js";
import { jsonReq } from "./auth-cases.js";
import { FIXTURES, ROUND_TWO } from "./hot-vent-fixtures.js";

// What must NEVER appear in a draft body.
const HOT_RE =
  /fuck|shit|damn|hell\b|crap|bitch|narcissis|alienat|on purpose|control everything|tell her off|so done|sick of|i swear|parking lot/i;

async function start() {
  logger.reset();
  const vault = new Vault();
  const bff = makeBff(vault);
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  return { vault, base: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(r)) };
}

function assertCalmComplete(data, vent) {
  assert.equal(data.written, 1);
  assert.equal(data.rewritten, true);
  assert.ok(isCleanComplete(data.body), `not clean + complete: ${data.body}`);
  assert.doesNotMatch(data.body, HOT_RE, "no heat in the draft");
  assert.match(data.body, /\.$/);
  assert.match(data.body, /Please /, "one clear ask");
  // Never echo the vent: no hot sentence of it appears in the body.
  for (const s of vent.match(/[^.!?]+[.!?]*/g)) {
    if (HOT_RE.test(s)) assert.ok(!data.body.includes(s.trim()), `echoed: ${s}`);
  }
  assert.equal(data.soft_grade, "ready");
  assert.match(data.say, /^Not sent\./);
}

test("Round Two vent → complete calm draft, keeps the cancelled weekend; never the truncated fragment", async () => {
  const s = await start();
  try {
    const { dad_id, token } = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const r = await jsonReq(s.base, "POST", "/vault/comms/draft", { dad_id, body: ROUND_TWO }, { token });
    assert.equal(r.status, 200);
    assert.notEqual(r.data.body, "I am so fucking done.", "Round Two failure is dead");
    assert.equal(
      r.data.body,
      "My weekend parenting time was cancelled again. Please let me know when we can schedule the make-up time. Thank you.",
    );
    assertCalmComplete(r.data, ROUND_TWO);
    assert.equal(r.data.mode, "document", "a missed-time ask is worth putting on the record");
    const [row] = await s.vault.listDrafts(dad_id);
    assert.equal(row.body_cold, r.data.body, "only the calm draft is stored");
    assert.equal(row.sent_at, null, "draft ≠ send");
  } finally {
    await s.close();
  }
});

test("five heat fixtures → one complete calm draft each, real issue kept", async () => {
  const s = await start();
  try {
    const { dad_id, token } = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const post = async (body) => (await jsonReq(s.base, "POST", "/vault/comms/draft", { dad_id, body }, { token })).data;

    const swearing = await post(FIXTURES.swearing);
    assertCalmComplete(swearing, FIXTURES.swearing);
    assert.match(swearing.body, /^The exchange started late\./);

    const diagnosis = await post(FIXTURES.diagnosis);
    assertCalmComplete(diagnosis, FIXTURES.diagnosis);
    assert.match(diagnosis.body, /school information/);

    const tellOff = await post(FIXTURES.tell_off);
    assertCalmComplete(tellOff, FIXTURES.tell_off);
    assert.match(tellOff.body, /^My visit with the kids was cancelled\./);

    const cancelled = await post(FIXTURES.cancelled_time);
    assertCalmComplete(cancelled, FIXTURES.cancelled_time);
    assert.match(cancelled.body, /parenting time was cancelled again\./);
    assert.match(cancelled.body, /make-up time/);

    const ask = await post(FIXTURES.request_in_anger);
    assertCalmComplete(ask, FIXTURES.request_in_anger);
    assert.match(ask.body, /Please send me the dentist appointment dates for October\./, "the real ask survives");
    assert.equal(ask.mode, "document", "the ask goes on the record");

    assert.equal(s.vault.communications.filter((c) => c.sent_at).length, 0, "nothing sent");
  } finally {
    await s.close();
  }
});

test("request in anger + on_record:true → document mode, real ask kept", async () => {
  const s = await start();
  try {
    const { dad_id, token } = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const r = await jsonReq(
      s.base, "POST", "/vault/comms/draft",
      { dad_id, body: "Damn it. Can you please add the kids' dentist appointments to the shared calendar already?", on_record: true },
      { token },
    );
    assert.equal(r.data.mode, "document");
    assert.equal(r.data.body, "Please add the kids' dentist appointments to the shared calendar. Thank you.");
    assert.match(r.data.say, /on the record/);
  } finally {
    await s.close();
  }
});

test("fail-safe: nothing clean to say → NO body, nothing stored, plain say, vent never echoed", async () => {
  const s = await start();
  try {
    const { dad_id, token } = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    for (const vent of [
      "I am so fucking done.",
      "She is a narcissist and I want to tell her off.",
      "Fuck this. She is alienating them.",
    ]) {
      const r = await jsonReq(s.base, "POST", "/vault/comms/draft", { dad_id, body: vent }, { token });
      assert.equal(r.status, 200);
      assert.deepEqual(r.data, { written: 0, rewritten: false, say: FAILSAFE_SAY });
      assert.ok(!("body" in r.data), "no draft body");
    }
    assert.equal(s.vault.communications.length, 0, "nothing stored");
    assert.doesNotMatch(FAILSAFE_SAY, HOT_RE);
    assert.doesNotMatch(logger.lines().join("\n"), /fuck|narcissist|alienat|weekend/i, "logs: ids only");
  } finally {
    await s.close();
  }
});

test("pure rewriter: heat detection, pronoun-bearing asks fall back, validator rejects fragments", () => {
  assert.equal(hasHeat(ROUND_TWO), true);
  assert.equal(hasHeat("Confirming Thursday pickup time."), false, "clean drafts keep the old path");
  assert.equal(hasHeat("She is spiteful and toxic."), false, "venom-only keeps the old strip path");
  // An ask that points at "her" can't be re-aimed safely → topic default ask.
  const r = calmRewrite("Fuck. She cancelled my weekend. I need her to call her mother about it.");
  assert.equal(r.ok, true);
  assert.equal(r.ask_kept, false);
  assert.match(r.body, /make-up time/);
  for (const bad of ["I am so fucking done.", "My weekend was", "Please send me the", "Thank you", ""]) {
    assert.equal(isCleanComplete(bad), false, `validator must reject: ${JSON.stringify(bad)}`);
  }
  assert.equal(isCleanComplete("The exchange started late. Please confirm the exchange time for next time. Thank you."), true);
});

// ---- Slice 19b — widen ------------------------------------------------------

import { DEFEAT_SAY, SAFETY_SAY, isSafetyReport } from "../src/calmdraft.js";
import { EXPECTED, FIXTURES_19B } from "./hot-vent-fixtures.js";

const HOT_19B_RE =
  /poison|a lie|losing my mind|on purpose|bad guy|hiding|vacation|spent|drunk|whatever|nobody listens|25th|slide/i;

test("19b: all 10 fixtures → exact expected output (5 calm drafts from 19 + 3 drafts / 2 no-draft from 19b)", async () => {
  const s = await start();
  try {
    const { dad_id, token } = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const all = { ...FIXTURES, ...FIXTURES_19B };
    assert.equal(Object.keys(all).length, 10);
    for (const [key, vent] of Object.entries(all)) {
      const r = await jsonReq(s.base, "POST", "/vault/comms/draft", { dad_id, body: vent }, { token });
      assert.equal(r.status, 200, key);
      if (EXPECTED[key] === null) {
        assert.equal(r.data.written, 0, `${key}: no draft`);
        assert.ok(!("body" in r.data), `${key}: no body`);
      } else {
        assert.equal(r.data.body, EXPECTED[key], key);
        assertCalmComplete(r.data, vent);
        assert.doesNotMatch(r.data.body, HOT_19B_RE, `${key}: no heat / motive / echo`);
      }
    }
    assert.equal(s.vault.communications.filter((c) => c.sent_at).length, 0, "nothing sent");
    assert.equal(s.vault.listDrafts(dad_id).length, 8, "exactly the 8 calm drafts stored");
  } finally {
    await s.close();
  }
});

test("19b C1: 'poisoning' + 'a lie' → adult-topics draft, no motive, no argument about payments", async () => {
  const s = await start();
  try {
    const { dad_id, token } = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const r = await jsonReq(s.base, "POST", "/vault/comms/draft", { dad_id, body: FIXTURES_19B.c1_poisoning }, { token });
    assert.equal(r.data.rewritten, true);
    assert.doesNotMatch(r.data.body, /poison|lie|two years|every single/i);
    assert.match(r.data.body, /away from the kids/);
  } finally {
    await s.close();
  }
});

test("19b C2: the real ask (fall schedule) is kept; 'on purpose' / 'hiding' dropped; document mode", async () => {
  const s = await start();
  try {
    const { dad_id, token } = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const r = await jsonReq(s.base, "POST", "/vault/comms/draft", { dad_id, body: FIXTURES_19B.c2_schedule }, { token });
    assert.match(r.data.body, /Please send me the fall schedule\./);
    assert.equal(r.data.mode, "document");
  } finally {
    await s.close();
  }
});

test("19b C3: drunk at the exchange with the kids → NO draft, safety say, nothing stored, not echoed", async () => {
  const s = await start();
  try {
    const { dad_id, token } = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const r = await jsonReq(s.base, "POST", "/vault/comms/draft", { dad_id, body: FIXTURES_19B.c3_safety }, { token });
    assert.deepEqual(r.data, { written: 0, rewritten: false, route: "safety", say: SAFETY_SAY });
    assert.doesNotMatch(SAFETY_SAY, /drunk|25th|911|police/i, "no echo, no invented emergency number");
    assert.match(SAFETY_SAY, /lawyer/);
    assert.equal(s.vault.communications.length, 0);
    assert.equal(isSafetyReport("Confirming Thursday pickup time."), false);
  } finally {
    await s.close();
  }
});

test("19b C4: worn-out 'whatever… nobody listens' → NO draft, gentle say, nothing stored", async () => {
  const s = await start();
  try {
    const { dad_id, token } = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const r = await jsonReq(s.base, "POST", "/vault/comms/draft", { dad_id, body: FIXTURES_19B.c4_defeat }, { token });
    assert.deepEqual(r.data, { written: 0, rewritten: false, say: DEFEAT_SAY });
    assert.doesNotMatch(DEFEAT_SAY, /whatever|nobody listens/i);
    assert.equal(s.vault.communications.length, 0);
  } finally {
    await s.close();
  }
});

test("19b C5: 529 withdrawal → facts + records ask, vacation claim dropped, on the record", async () => {
  const s = await start();
  try {
    const { dad_id, token } = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const r = await jsonReq(s.base, "POST", "/vault/comms/draft", { dad_id, body: FIXTURES_19B.c5_money }, { token });
    assert.match(r.data.body, /four thousand dollars was taken out of the kids' 529 account in September\./);
    assert.match(r.data.body, /Please send me the 529 account statement for September/);
    assert.doesNotMatch(r.data.body, /vacation|spent|without telling/i, "unverified claim dropped");
    assert.equal(r.data.mode, "document", "'I want it documented' → on the record");
  } finally {
    await s.close();
  }
});
