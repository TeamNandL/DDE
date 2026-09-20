// POST /vault/missing/fill — the dad's answer closes missing[0].
// Rails: harm first, PII strip, venom strip, claim ≠ verified, no invent
// on an empty checklist. Fake dad only.

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

test("empty missing → {written:0, missing_one:null, progress_line:null} — nothing invented", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    const fill = await jsonReq(
      s.base,
      "POST",
      "/vault/missing/fill",
      { dad_id, answer: "I did the thing." },
      { token },
    );
    assert.equal(fill.status, 200);
    assert.deepEqual(fill.data, { written: 0, missing_one: null, progress_line: null });
    assert.equal((await s.vault.listEvents(dad_id)).length, 0);
  } finally {
    await s.close();
  }
});

test("fill closes missing[0] as one claim event; done bumps; PII+venom never stored raw", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      {
        dad_id,
        missing: ["pull OFW thread", "file the copy"],
        this_week_done: 1,
        this_week_total: 3,
      },
      { token },
    );

    const fill = await jsonReq(
      s.base,
      "POST",
      "/vault/missing/fill",
      {
        dad_id,
        answer: `Pulled it, she was late twice. She does it on purpose. Call me at ${PHONE}.`,
      },
      { token },
    );
    assert.equal(fill.status, 200);
    assert.equal(fill.data.written, 1);
    assert.equal(fill.data.missing_one, "file the copy");
    assert.equal(fill.data.progress_line, "2 of 3 this week; still open: file the copy");

    // One claim event, item named, answer stripped of PII and venom.
    const events = await s.vault.listEvents(dad_id);
    assert.equal(events.length, 1);
    assert.equal(events[0].pipe, "claim");
    assert.equal(events[0].event_type, "other");
    assert.match(events[0].notes, /Checklist item closed: pull OFW thread/);
    assert.ok(!events[0].raw_quote.includes(PHONE));
    assert.doesNotMatch(events[0].raw_quote, /on purpose/);
    assert.match(events[0].raw_quote, /late twice/);

    // State advanced on both stores' shared path.
    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(state.data.missing, ["file the copy"]);
    assert.equal(state.data.this_week_done, 2);

    // Claim never reaches the verified export.
    const verified = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.deepEqual(verified.data, []);

    // Log hygiene: never the answer, the item text, or the PII.
    assert.doesNotMatch(logger.lines().join("\n"), /OFW thread|late twice|904-555/i);
  } finally {
    await s.close();
  }
});

test("done bump edges: at total → no bump; total unset → no bump", async () => {
  const s = await start();
  try {
    const a = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id: a.dad_id, missing: ["x1"], this_week_done: 3, this_week_total: 3 },
      { token: a.token },
    );
    await jsonReq(
      s.base,
      "POST",
      "/vault/missing/fill",
      { dad_id: a.dad_id, answer: "done" },
      { token: a.token },
    );
    const stateA = await jsonReq(s.base, "GET", `/vault/state?dad_id=${a.dad_id}`, null, {
      token: a.token,
    });
    assert.equal(stateA.data.this_week_done, 3, "done never exceeds total");

    const b = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id: b.dad_id, missing: ["x1"] },
      { token: b.token },
    );
    const fillB = await jsonReq(
      s.base,
      "POST",
      "/vault/missing/fill",
      { dad_id: b.dad_id, answer: "done" },
      { token: b.token },
    );
    assert.equal(fillB.data.written, 1);
    const stateB = await jsonReq(s.base, "GET", `/vault/state?dad_id=${b.dad_id}`, null, {
      token: b.token,
    });
    assert.equal(stateB.data.this_week_done, null, "no total → no counter invented");
    assert.equal(fillB.data.progress_line, null, "no counters → no line");
  } finally {
    await s.close();
  }
});

test("harm answer: heard → discarded — zero rows, nothing shifted, nothing bumped", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id, missing: ["pull OFW thread"], this_week_done: 0, this_week_total: 3 },
      { token },
    );
    const fill = await jsonReq(
      s.base,
      "POST",
      "/vault/missing/fill",
      { dad_id, answer: "I want to hurt Jordan for this." },
      { token },
    );
    assert.equal(fill.status, 200);
    assert.equal(fill.data.written, 0);
    assert.equal(fill.data.missing_one, "pull OFW thread", "item stays open");
    assert.equal((await s.vault.listEvents(dad_id)).length, 0);
    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(state.data.missing, ["pull OFW thread"]);
    assert.equal(state.data.this_week_done, 0);
    assert.doesNotMatch(logger.lines().join("\n"), /hurt|Jordan/i);
  } finally {
    await s.close();
  }
});

test("gates and validation: 400 empty answer; 404 unknown dad; 401 no token; 403 cross-dad", async () => {
  const s = await start();
  try {
    const a = await provisionedDad(s.base);
    const b = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id: a.dad_id, missing: ["private item"] },
      { token: a.token },
    );

    const empty = await jsonReq(
      s.base,
      "POST",
      "/vault/missing/fill",
      { dad_id: a.dad_id, answer: "   " },
      { token: a.token },
    );
    assert.equal(empty.status, 400);

    const unknown = await jsonReq(s.base, "POST", "/vault/missing/fill", {
      dad_id: randomUUID(),
      answer: "x",
    });
    assert.equal(unknown.status, 404);

    const noTok = await jsonReq(s.base, "POST", "/vault/missing/fill", {
      dad_id: a.dad_id,
      answer: "x",
    });
    assert.equal(noTok.status, 401);

    const cross = await jsonReq(
      s.base,
      "POST",
      "/vault/missing/fill",
      { dad_id: a.dad_id, answer: "leak" },
      { token: b.token },
    );
    assert.equal(cross.status, 403);
    // A's checklist untouched by the blocked cross-dad call.
    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${a.dad_id}`, null, {
      token: a.token,
    });
    assert.deepEqual(state.data.missing, ["private item"]);
  } finally {
    await s.close();
  }
});
