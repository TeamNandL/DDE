// Emotion-notice gap (live dad vent test): pure pain + date vents must
// still produce a claim row and a cold noticed sentence — no "cancelled
// visit" wording required. Claim ≠ verified, PII strip first.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import { extractFields, parseSinceDate } from "../src/extract.js";
import * as logger from "../src/logger.js";

const REF = new Date("2026-09-20T12:00:00");

// The live-gap vent: emotion + date, zero incident keywords, plus PII to
// prove the strip still runs first.
const EMOTION_VENT =
  "I just miss the kids so much. Since April 19 I've had limited time with them. " +
  "The house is so quiet every night. If anyone needs me I'm at 904-555-1212.";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ENG_LEAK_RE = /event_type|undefined|\bnull\b|dad_id|uuid|raw_quote|pipe=|noticed_at/i;

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

async function provision(base, dad_id) {
  const prov = await jsonReq(base, "POST", "/vault/provision", { dad_id });
  assert.equal(prov.status, 200);
  return prov.data;
}

// ---------------------------------------------------------------------------
// Units: date parsing and the emotion arm.

test("parseSinceDate: month-name and slash forms, future guard, junk → null", () => {
  assert.equal(parseSinceDate("since April 19", REF), "2026-04-19");
  assert.equal(parseSinceDate("since April 19th, 2025", REF), "2025-04-19");
  assert.equal(parseSinceDate("since 4/19", REF), "2026-04-19");
  assert.equal(parseSinceDate("since 4/19/25", REF), "2025-04-19");
  // Said in February, "since April 19" means LAST April.
  assert.equal(parseSinceDate("since April 19", new Date("2026-02-01")), "2025-04-19");
  assert.equal(parseSinceDate("since forever", REF), null);
  assert.equal(parseSinceDate("no date here", REF), null);
});

test("extractFields: pain+date → one 'other' claim event with cold notes; plain text → nothing", () => {
  const events = extractFields(EMOTION_VENT, { referenceDate: REF });
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, "other");
  assert.match(events[0].notes, /limited time with the children since 2026-04-19/);
  assert.match(events[0].notes, /waiting at home without the children/);

  // Pain without a date still records the statement.
  const noDate = extractFields("I miss the kids. The house is so empty.", { referenceDate: REF });
  assert.equal(noDate.length, 1);
  assert.match(noDate[0].notes, /limited time with the children\./i);

  // No pain, no incident → still nothing (no invention).
  assert.equal(extractFields("Nice weather today.", { referenceDate: REF }).length, 0);
});

// ---------------------------------------------------------------------------
// HTTP: the live gap closed end-to-end.

test("emotion+date vent: intake make_notice → written>=1, non-empty noticed_text, no PII/eng leaks", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const { token } = await provision(s.base, dad_id);

    const intake = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: EMOTION_VENT, make_notice: true },
      { token },
    );
    assert.equal(intake.status, 200);
    assert.ok(intake.data.written >= 1, "emotion+date vent must write a claim row");
    assert.ok(intake.data.event_id);
    const noticed = intake.data.noticed_text;
    assert.equal(typeof noticed, "string");
    assert.ok(noticed.trim().length > 0, "noticed_text must not be empty");
    assert.match(noticed, /since 2026-04-19/);
    assert.match(noticed, /parent statement \(claim\)/);
    // PII strip ran first; no engineering wording leaks into the sentence.
    assert.doesNotMatch(noticed, /904-555-1212/);
    assert.doesNotMatch(noticed, ENG_LEAK_RE, `eng leak in: ${noticed}`);
    assert.doesNotMatch(noticed, UUID_RE);

    // Row is claim; the vent's feeling survives (PII-stripped) in raw_quote.
    const [event] = await s.vault.listEvents(dad_id);
    assert.equal(event.pipe, "claim");
    assert.match(event.raw_quote, /miss the kids/);
    assert.doesNotMatch(event.raw_quote, /904-555-1212/);

    // No forced Next: nothing to chase in a pure emotion vent.
    assert.deepEqual(intake.data.chase, []);

    // Claim stays out of the verified export.
    const verified = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.deepEqual(verified.data, []);

    assert.doesNotMatch(logger.lines().join("\n"), /miss the kids|904-555/i);
  } finally {
    await s.close();
  }
});

test("emotion+date vent: plain intake then POST /vault/notice also produces the sentence", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const { token } = await provision(s.base, dad_id);

    const intake = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: "Since 4/19 I've barely seen Sam and Taylor. I miss them." },
      { token },
    );
    assert.equal(intake.status, 200);
    assert.ok(intake.data.written >= 1);

    const notice = await jsonReq(s.base, "POST", "/vault/notice", { dad_id }, { token });
    assert.equal(notice.status, 200);
    assert.ok(notice.data.noticed_text.trim().length > 0);
    assert.match(notice.data.noticed_text, /since 2026-04-19/);
    assert.doesNotMatch(notice.data.noticed_text, ENG_LEAK_RE);
  } finally {
    await s.close();
  }
});
