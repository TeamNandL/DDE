// Return answer → claim: optional body.answer on POST /vault/return writes
// exactly ONE claim event on the return beat. Harm/PII/venom rails, 400 on
// whitespace, written:0|1, log hygiene. Fake dad only.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import * as logger from "../src/logger.js";

const PHONE = "904-555-1212";

async function start() {
  logger.reset();
  const vault = new Vault();
  const bff = makeBff(vault);
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    vault,
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function jsonReq(base, method, path, body, { token } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function provisionedDad(base) {
  const dad_id = randomUUID();
  const prov = await jsonReq(base, "POST", "/vault/provision", { dad_id });
  assert.equal(prov.status, 200);
  return { dad_id, token: prov.data.token };
}

test("answer → ONE claim event 'Return: how'd it go'; PII stripped; response keeps line + progress_line", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id, next_action: "pull the OFW thread", this_week_done: 1, this_week_total: 3 },
      { token },
    );

    const ret = await jsonReq(
      s.base,
      "POST",
      "/vault/return",
      { dad_id, answer: `Went okay. She confirmed by text from ${PHONE}.` },
      { token },
    );
    assert.equal(ret.status, 200);
    assert.equal(ret.data.written, 1);
    assert.equal(ret.data.line, "Last time: pull the OFW thread. How'd it go?");
    // Provision auto-seeded the checklist, so the first blank rides along.
    assert.equal(ret.data.progress_line, "1 of 3 this week; still open: Kids school name");

    const events = await s.vault.listEvents(dad_id);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "other");
    assert.equal(events[0].pipe, "claim");
    assert.equal(events[0].notes, "Return: how'd it go");
    assert.ok(!events[0].raw_quote.includes(PHONE), "PII stripped from stored answer");
    assert.match(events[0].raw_quote, /\[phone\]/);

    // Never verified.
    const verified = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.deepEqual(verified.data, []);

    // Log hygiene: never the answer text or PII.
    assert.doesNotMatch(logger.lines().join("\n"), /Went okay|confirmed by text|904-555/i);
  } finally {
    await s.close();
  }
});

test("cold-ask return answer → notes 'Return: cold ask follow-up'", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      {
        dad_id,
        next_action: "send the Saturday cold ask",
        last_next_kind: "cold_ask",
        last_ask_summary: "Sat window both kids 10–6",
      },
      { token },
    );
    const ret = await jsonReq(
      s.base,
      "POST",
      "/vault/return",
      { dad_id, answer: "She agreed to the Saturday window." },
      { token },
    );
    assert.equal(ret.data.written, 1);
    assert.match(ret.data.line, /^Last time: cold ask — Sat window both kids 10–6/);
    const [event] = await s.vault.listEvents(dad_id);
    assert.equal(event.notes, "Return: cold ask follow-up");
    assert.equal(event.pipe, "claim");
  } finally {
    await s.close();
  }
});

// RAZOR regression: realistic harm shapes — not just the textbook fixture —
// must ALL short-circuit the return answer: written:0, event count
// unchanged, zero answer text in logs. Greeting may still return.
test("RAZOR return harm short-circuit: realistic harm answers → written:0, no rows, no log text", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id, next_action: "pull the OFW thread" },
      { token },
    );

    const HARM_SHAPES = [
      "It went nowhere. I could kill that woman.",
      "Next exchange I am bringing my gun.",
      "She would be better off dead.",
      "Badly. I just want to die.",
      "Honestly thinking about ending it all tonight.",
      "I am going to make her pay for this.",
      "I will murder him if this keeps up.",
      "Might do something violent next time I see her.",
      "I want to hurt Jordan for this.",
    ];

    for (const answer of HARM_SHAPES) {
      const before = (await s.vault.listEvents(dad_id)).length;
      const ret = await jsonReq(s.base, "POST", "/vault/return", { dad_id, answer }, { token });
      assert.equal(ret.status, 200, answer);
      assert.equal(ret.data.written, 0, `harm not short-circuited: ${answer}`);
      assert.match(ret.data.line ?? "", /^Last time:/, "greeting may still return");
      const after = (await s.vault.listEvents(dad_id)).length;
      assert.equal(after, before, `event count changed for: ${answer}`);
    }
    assert.equal((await s.vault.listEvents(dad_id)).length, 0);

    // Zero retention anywhere: no fragment of any harm answer in logs.
    const logs = logger.lines().join("\n");
    for (const frag of ["kill", "gun", "dead", "die", "ending it", "murder", "violent", "hurt", "Jordan"]) {
      assert.ok(!new RegExp(`\\b${frag}`, "i").test(logs), `log retains harm fragment: ${frag}`);
    }

    // Guard the other side: ordinary vents about hurt feelings or shifts
    // are NOT harm — they still write the one claim event.
    const okAnswers = [
      "It hurt to hear Sam cry about it.",
      "We missed the end of her shift again.",
    ];
    for (const answer of okAnswers) {
      const ret = await jsonReq(s.base, "POST", "/vault/return", { dad_id, answer }, { token });
      assert.equal(ret.data.written, 1, `false discard of ordinary vent: ${answer}`);
    }
  } finally {
    await s.close();
  }
});

test("harm answer → written:0, zero rows, zero retention; no answer → no written key", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id, next_action: "pull the OFW thread" },
      { token },
    );

    const harm = await jsonReq(
      s.base,
      "POST",
      "/vault/return",
      { dad_id, answer: "It went nowhere and I want to hurt Jordan over it." },
      { token },
    );
    assert.equal(harm.status, 200);
    assert.equal(harm.data.written, 0);
    assert.equal((await s.vault.listEvents(dad_id)).length, 0);
    assert.doesNotMatch(logger.lines().join("\n"), /hurt|Jordan/i);

    const noAnswer = await jsonReq(s.base, "POST", "/vault/return", { dad_id }, { token });
    assert.equal(noAnswer.status, 200);
    assert.equal(noAnswer.data.written, undefined, "no answer → no claim write");
  } finally {
    await s.close();
  }
});

test("whitespace/non-string answer → 400; nothing written", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    for (const bad of ["   ", "", 42]) {
      const res = await jsonReq(
        s.base,
        "POST",
        "/vault/return",
        { dad_id, answer: bad },
        { token },
      );
      assert.equal(res.status, 400, `expected 400 for answer=${JSON.stringify(bad)}`);
    }
    assert.equal((await s.vault.listEvents(dad_id)).length, 0);
  } finally {
    await s.close();
  }
});

test("gates: cross-dad answer blocked before any write", async () => {
  const s = await start();
  try {
    const a = await provisionedDad(s.base);
    const b = await provisionedDad(s.base);
    const cross = await jsonReq(
      s.base,
      "POST",
      "/vault/return",
      { dad_id: a.dad_id, answer: "leak attempt" },
      { token: b.token },
    );
    assert.equal(cross.status, 403);
    assert.equal((await s.vault.listEvents(a.dad_id)).length, 0);
  } finally {
    await s.close();
  }
});
