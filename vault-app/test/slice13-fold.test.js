// Slice 13 fold — Coach de-escalate vs document-this (on_record), Coach ≠
// intake, and court-prep candidates as "Needs reviewed" sticky notes
// (keep what's true / toss junk). Chip never asserts truth.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import * as logger from "../src/logger.js";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

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

test("Coach on_record: dad wants it on the record → document, even when wording misses it", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const plain = "Noted. I'll be at the exchange at 6.";
    const base = await jsonReq(s.base, "POST", "/vault/comms/draft", { dad_id, body: plain }, { token });
    assert.equal(base.data.mode, "de_escalate");

    const onRecord = await jsonReq(
      s.base, "POST", "/vault/comms/draft", { dad_id, body: plain, on_record: true }, { token },
    );
    assert.equal(onRecord.data.mode, "document");
    assert.equal(onRecord.data.say, "Not sent. Next: send it yourself — it puts your ask on the record.");

    // on_record:false never downgrades a detected record ask (medical-calendar textbook).
    const ask = "Please add the kids' doctor and dentist appointments to the shared calendar.";
    const kept = await jsonReq(
      s.base, "POST", "/vault/comms/draft", { dad_id, body: ask, on_record: false }, { token },
    );
    assert.equal(kept.data.mode, "document");

    const bad = await jsonReq(
      s.base, "POST", "/vault/comms/draft", { dad_id, body: plain, on_record: "yes" }, { token },
    );
    assert.equal(bad.status, 400);

    // Still draft ≠ send, still no intake write.
    const [row] = await s.vault.listDrafts(dad_id);
    assert.equal(row.sent_at, null);
    assert.equal((await s.vault.listEvents(dad_id)).length, 0);
  } finally {
    await s.close();
  }
});

test("sticky notes: start Needs reviewed; keep stays not proof yet; toss hides, never deletes", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    await jsonReq(
      s.base, "POST", "/vault/tell",
      { dad_id, channel: "text", story: "Quinn did come last Friday. It was 5pm. Pickup is at 6pm tomorrow." },
      { token },
    );
    let res = await jsonReq(s.base, "GET", `/vault/candidates?dad_id=${dad_id}`, null, { token });
    assert.equal(res.data.candidates.length, 3);
    assert.equal(res.data.needs_reviewed, 3);
    for (const c of res.data.candidates) {
      assert.equal(c.review, "needs_reviewed");
      assert.equal(c.label, "Needs reviewed");
    }
    const [keep, toss] = res.data.candidates;

    const kept = await jsonReq(
      s.base, "POST", "/vault/candidates/review", { dad_id, id: keep.id, review: "keep" }, { token },
    );
    assert.equal(kept.status, 200);
    assert.equal(kept.data.label, "Kept");
    assert.equal(kept.data.status, "not_proof_yet", "keeping never makes it proof");
    assert.equal(kept.data.confidence, "low");
    assert.equal(kept.data.line, keep.line);

    await jsonReq(s.base, "POST", "/vault/candidates/review", { dad_id, id: toss.id, review: "toss" }, { token });
    res = await jsonReq(s.base, "GET", `/vault/candidates?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(res.data.candidates.map((c) => c.id).includes(toss.id), false, "tossed is hidden");
    assert.equal(res.data.needs_reviewed, 1);
    const all = await jsonReq(
      s.base, "GET", `/vault/candidates?dad_id=${dad_id}&include_tossed=true`, null, { token },
    );
    assert.equal(all.data.candidates.length, 3, "tossed is never deleted");
    assert.equal(s.vault.candidate_facts.length, 3);

    const bad = await jsonReq(
      s.base, "POST", "/vault/candidates/review", { dad_id, id: keep.id, review: "verify" }, { token },
    );
    assert.equal(bad.status, 400);

    const other = await dad(s.base);
    const steal = await jsonReq(
      s.base, "POST", "/vault/candidates/review",
      { dad_id: other.dad_id, id: keep.id, review: "toss" }, { token: other.token },
    );
    assert.equal(steal.status, 404, "another dad cannot review this dad's notes");
  } finally {
    await s.close();
  }
});

test("Chip never asserts truth: no candidate line or label claims a fact is true or proven", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    await jsonReq(
      s.base, "POST", "/vault/tell",
      { dad_id, channel: "talk", story: "Jordan cancelled the visit yesterday. Quinn did come last Friday." },
      { token },
    );
    await jsonReq(
      s.base, "POST", "/vault/comms/pull",
      { dad_id, channel: "ofw", source_ref: "ofw:x", body_cold: "Visit cancelled.", sent_at: new Date(Date.now() - 864e5).toISOString() },
      { token },
    );
    const res = await jsonReq(s.base, "GET", `/vault/candidates?dad_id=${dad_id}`, null, { token });
    for (const c of res.data.candidates) {
      assert.doesNotMatch(`${c.label} ${c.line}`, /\b(true|truth|proven|proof:|confirmed|verified|fact:)\b/i);
    }
  } finally {
    await s.close();
  }
});

test("docs: Coach ≠ intake, on_record, Needs reviewed sticky notes, no weed jargon in product copy", () => {
  const app = read("CHIP_APP.md");
  assert.match(app, /Coach ≠ intake/);
  assert.match(app, /"on_record": true/);
  assert.match(app, /POST \/vault\/candidates\/review/);
  assert.match(app, /Needs reviewed/);
  const dadT = read("CHIP_DAD_TEMPLATE.md");
  assert.match(dadT, /sendable cold/);
  assert.match(dadT, /The noticed sentence is Quill intake, never Coach/);
  assert.match(dadT, /Needs reviewed/);
  for (const [name, text] of [["CHIP_APP.md", app], ["CHIP_DAD_TEMPLATE.md", dadT], ["CHIP_PUBLIC_TEMPLATE.md", read("CHIP_PUBLIC_TEMPLATE.md")]]) {
    assert.doesNotMatch(text, /\bweed/i, `${name} carries weed jargon`);
  }
});
