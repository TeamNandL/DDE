// Return loop: pull last Next → "Last time: ___. How'd it go?" → answer
// writes claim. Fake family only. No real case data.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff, returnLine } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import { readFixedVent } from "../src/demo.js";
import * as logger from "../src/logger.js";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function start() {
  logger.reset();
  const vault = new Vault();
  const bff = makeBff(vault);
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    vault,
    bff,
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

async function provision(base, dad_id) {
  const prov = await jsonReq(base, "POST", "/vault/provision", { dad_id });
  assert.equal(prov.status, 200);
  return prov.data;
}

// The Chip line is plain speech: no auth token, no URL, no uuid, no header.
function assertChipSafeLine(line) {
  assert.equal(typeof line, "string");
  assert.doesNotMatch(line, /dde-stub/i, "line carries a token");
  assert.doesNotMatch(line, /https?:\/\//i, "line carries a URL");
  assert.doesNotMatch(line, /bearer|authorization|x-dde-token/i, "line carries auth wording");
  assert.doesNotMatch(line, UUID_RE, "line carries a uuid");
}

// ---------------------------------------------------------------------------
// returnLine unit: shape, and no invention on empty Next.

test("returnLine: builds the greeting from the Next; empty Next → null, never invented", () => {
  const line = returnLine("verify count in OFW record for September");
  assert.equal(line, "Last time: verify count in OFW record for September. How'd it go?");
  assertChipSafeLine(line);

  assert.equal(returnLine(null), null);
  assert.equal(returnLine(""), null);
  assert.equal(returnLine(undefined), null);
});

// ---------------------------------------------------------------------------
// HTTP: full loop — vent seeds a Next, return pulls it, answer writes claim.

test("return loop: vent → Next → return line → answer writes claim; last_next persisted", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const { token } = await provision(s.base, dad_id);

    // Seed the One Next via the fixed vent (count claim → chase item).
    const intake = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: readFixedVent() },
      { token },
    );
    assert.equal(intake.status, 200);
    assert.ok(intake.data.chase.length >= 1);
    const eventsBefore = (await s.vault.listEvents(dad_id)).length;

    // Dad returns: line reflects the actual Next, nothing else.
    const ret = await jsonReq(s.base, "POST", "/vault/return", { dad_id }, { token });
    assert.equal(ret.status, 200);
    assert.match(ret.data.last_next, /verify count in OFW record/);
    assert.equal(ret.data.line, `Last time: ${ret.data.last_next}. How'd it go?`);
    assertChipSafeLine(ret.data.line);
    assert.equal(ret.data.written, undefined, "no answer → no claim write");

    // last_next stamped on state and visible to Chip's state read.
    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.equal(state.status, 200);
    assert.equal(state.data.last_next, ret.data.last_next);
    assert.ok(state.data.last_next_at);

    // Answer becomes exactly ONE claim event on the return beat (harm →
    // PII → venom rails still apply to what gets stored).
    const answer = await jsonReq(
      s.base,
      "POST",
      "/vault/return",
      {
        dad_id,
        answer:
          "I pulled it up. Jordan cancelled the visit again on Tuesday. She is doing this on purpose.",
      },
      { token },
    );
    assert.equal(answer.status, 200);
    assert.equal(answer.data.written, 1);
    const events = await s.vault.listEvents(dad_id);
    assert.equal(events.length, eventsBefore + 1);
    const newest = events.find((e) => /^Return: how'd it go/.test(e.notes ?? ""));
    assert.ok(newest, "answer produced the return claim event");
    assert.equal(newest.event_type, "other");
    assert.equal(newest.pipe, "claim");
    assert.doesNotMatch(newest.raw_quote ?? "", /on purpose/, "venom stripped from answer");
    assert.match(newest.raw_quote ?? "", /cancelled the visit again/);

    // Claim answers never reach the verified export.
    const verified = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.equal(verified.status, 200);
    assert.deepEqual(verified.data, []);

    // Log hygiene: no line text, no answer text, no fake-family names.
    const logs = logger.lines().join("\n");
    assert.doesNotMatch(logs, /How'd it go|cancelled|Jordan|Sam|Taylor/i);
  } finally {
    await s.close();
  }
});

test("return with empty Next: {line: null, last_next: null} — nothing invented, nothing stamped", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const { token } = await provision(s.base, dad_id);

    const ret = await jsonReq(s.base, "POST", "/vault/return", { dad_id }, { token });
    assert.equal(ret.status, 200);
    assert.equal(ret.data.last_next, null);
    assert.equal(ret.data.line, null);

    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.equal(state.data.last_next, null);
    assert.equal(state.data.last_next_at, null);

    // Answering with no Next still writes the claim (it is just a statement).
    const answer = await jsonReq(
      s.base,
      "POST",
      "/vault/return",
      { dad_id, answer: "Jordan cancelled the visit today." },
      { token },
    );
    assert.equal(answer.status, 200);
    assert.equal(answer.data.line, null);
    assert.ok(answer.data.written >= 1);
    assert.equal((await s.vault.listEvents(dad_id))[0].pipe, "claim");
  } finally {
    await s.close();
  }
});

test("BLOCKER auth on /vault/return: 404 unknown dad, 401 no token, 403 cross-dad", async () => {
  const s = await start();
  const dadA = randomUUID();
  const dadB = randomUUID();
  try {
    const a = await provision(s.base, dadA);
    const b = await provision(s.base, dadB);

    await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id: dadA, text: readFixedVent() },
      { token: a.token },
    );

    // Unprovisioned dad → 404 before any token check.
    const unknown = await jsonReq(s.base, "POST", "/vault/return", { dad_id: randomUUID() });
    assert.equal(unknown.status, 404);

    // No token → 401.
    const noTok = await jsonReq(s.base, "POST", "/vault/return", { dad_id: dadA });
    assert.equal(noTok.status, 401);

    // B's token against A's dad_id → 403; A's Next never leaks to B.
    const cross = await jsonReq(
      s.base,
      "POST",
      "/vault/return",
      { dad_id: dadA },
      { token: b.token },
    );
    assert.equal(cross.status, 403);
    assert.deepEqual(cross.data, { error: "forbidden" });

    // B's own return sees B's (empty) Next, not A's.
    const own = await jsonReq(s.base, "POST", "/vault/return", { dad_id: dadB }, { token: b.token });
    assert.equal(own.status, 200);
    assert.equal(own.data.last_next, null);

    // Cross-dad answer is blocked before any claim write.
    const crossAnswer = await jsonReq(
      s.base,
      "POST",
      "/vault/return",
      { dad_id: dadA, answer: "leak attempt" },
      { token: b.token },
    );
    assert.equal(crossAnswer.status, 403);
    assert.ok(!(await s.vault.listEvents(dadA)).some((e) => /leak/.test(e.raw_quote ?? "")));
  } finally {
    await s.close();
  }
});
