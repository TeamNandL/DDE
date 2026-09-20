// STATEMENT DROP → ONE NOTICED SENTENCE. Hard Razor gates:
//   1) noticed_text non-empty and NEVER receipt tone
//   2) zero raw account/routing digit runs after strip (notice + storage)
//   3) fake fixture only
// PII strip first; claim ≠ verified; verified export [].

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import { extractFields } from "../src/extract.js";
import * as logger from "../src/logger.js";

// Fake fixture only: fake bank, fake sitter business, fake numbers.
export const SAMPLE_FAKE_STATEMENT =
  "First Fake Bank statement, account #12345678, routing 021000021. " +
  "2026-09-12 payment of $1,250.00 to Maple Street Sitters. " +
  "Balance $3,410.22. Questions: call 904-555-1212.";

const RAW_PII = ["12345678", "021000021", "904-555-1212"];
const RECEIPT_RE = /\bgot it\b|\bupload/i;
const RECEIPT_RE2 = /\breceived\b|\byour file\b|\bthanks\b/i;
const DIGIT_RUN = /\d{8,17}/;

function assertNoticedSafe(text, label) {
  assert.ok(typeof text === "string" && text.trim().length > 0, `${label} empty`);
  assert.doesNotMatch(text, RECEIPT_RE, `${label} receipt tone`);
  assert.doesNotMatch(text, RECEIPT_RE2, `${label} receipt tone`);
  assert.doesNotMatch(text, DIGIT_RUN, `${label} raw digit run`);
  for (const v of RAW_PII) assert.ok(!text.includes(v), `${label} leaks ${v}`);
}

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

test("statement arm: date/amount/payee land in one cold sentence; minimal statement still speaks", () => {
  const REF = new Date("2026-09-20T12:00:00");
  const events = extractFields(
    "2026-09-12 payment of $1,250.00 to Maple Street Sitters. Balance $3,410.22.",
    { referenceDate: REF, source: "statement" },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, "other");
  assert.equal(events[0].notes, "Statement: $1,250.00 to Maple Street Sitters on 2026-09-12.");
  assert.equal(String(events[0].occurred_at).slice(0, 10), "2026-09-12");

  // Bare minimum: no payee/date, amount only.
  const minimal = extractFields("Card statement. $89.99 due.", {
    referenceDate: REF,
    source: "statement",
  });
  assert.equal(minimal.length, 1);
  assert.equal(minimal[0].notes, "Statement: $89.99.");
});

test("RAZOR: statement drop via intake make_notice → one noticed sentence, no receipt tone, no raw PII", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);

    const intake = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: SAMPLE_FAKE_STATEMENT, make_notice: true, source: "statement" },
      { token },
    );
    assert.equal(intake.status, 200);
    assert.ok(intake.data.written >= 1, "statement must write");
    const noticed = intake.data.noticed_text;
    // Gate 1: non-empty, cold, one Statement sentence + claim caveat.
    assertNoticedSafe(noticed, "noticed_text");
    assert.match(noticed, /^Statement: \$1,250\.00 to Maple Street Sitters on 2026-09-12\./);
    assert.match(noticed, /parent statement \(claim\)/);

    // Gate 2: stored fields clean too (row + state + logs).
    const [event] = await s.vault.listEvents(dad_id);
    assert.equal(event.pipe, "claim");
    const storedJson = JSON.stringify(event);
    assert.doesNotMatch(storedJson, DIGIT_RUN, "stored row raw digit run");
    for (const v of RAW_PII) assert.ok(!storedJson.includes(v), `stored row leaks ${v}`);
    assert.match(event.raw_quote, /\[account\]/);
    assert.doesNotMatch(logger.lines().join("\n"), /12345678|021000021|904-555|Maple Street Sitters/);

    // claim ≠ verified: export stays [].
    const verified = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.deepEqual(verified.data, []);
  } finally {
    await s.close();
  }
});

// RAZOR residual gate: make_notice=true + statement-like body with NO
// source field must take the same one-noticed-sentence path.
test("RAZOR: statement body, make_notice, NO source → written>=1 + Statement sentence", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);

    // The full fixture — including the "Questions: call <number>" footer
    // that must NOT turn this into a call event.
    const full = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: SAMPLE_FAKE_STATEMENT, make_notice: true },
      { token },
    );
    assert.equal(full.status, 200);
    assert.ok(full.data.written >= 1, "sourceless statement must write");
    assertNoticedSafe(full.data.noticed_text, "sourceless noticed_text");
    assert.match(full.data.noticed_text, /^Statement: \$1,250\.00 to Maple Street Sitters on 2026-09-12\./);
    assert.doesNotMatch(full.data.noticed_text, /^Call\b/, "call footer must not win");

    // Keyword-less raw paste: no "statement" word — the [account] token
    // the PII strip minted is the evidence.
    const other = await provisionedDad(s.base);
    const raw = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      {
        dad_id: other.dad_id,
        text: "ACCT 12345678 ROUTING 021000021 POS PURCHASE $1,250.00 MAPLE STREET SITTERS",
        make_notice: true,
      },
      { token: other.token },
    );
    assert.ok(raw.data.written >= 1, "raw paste must write");
    assertNoticedSafe(raw.data.noticed_text, "raw-paste noticed_text");
    assert.match(raw.data.noticed_text, /^Statement: \$1,250\.00/);

    // Incident arms still win over false statement detect.
    const third = await provisionedDad(s.base);
    const incident = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      {
        dad_id: third.dad_id,
        text: "She cancelled the visit on 2026-09-12 over the $40 sitter balance.",
        make_notice: true,
      },
      { token: third.token },
    );
    assert.match(incident.data.noticed_text, /^Denied or cancelled visit on 2026-09-12\./);
  } finally {
    await s.close();
  }
});

test("statement-like text is detected without source; neutral text still writes nothing", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);

    const implicit = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      {
        dad_id,
        text: "Here's the card statement: $89.99 to Fake Cable Co on 9/12.",
        make_notice: true,
      },
      { token },
    );
    assert.equal(implicit.status, 200);
    assert.ok(implicit.data.written >= 1);
    assert.match(implicit.data.noticed_text, /^Statement: \$89\.99 to Fake Cable Co on 2026-09-12\./);
    assertNoticedSafe(implicit.data.noticed_text, "implicit noticed_text");

    // POST /vault/notice on the same event says the same sentence.
    const notice = await jsonReq(s.base, "POST", "/vault/notice", { dad_id }, { token });
    assert.match(notice.data.noticed_text, /^Statement: \$89\.99/);

    // Neutral non-statement text keeps writing nothing.
    const other = await provisionedDad(s.base);
    const neutral = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id: other.dad_id, text: "Nice weather today.", make_notice: true },
      { token: other.token },
    );
    assert.equal(neutral.data.written, 0);

    // Unknown source value → 400.
    const bad = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: "x", source: "war_plan" },
      { token },
    );
    assert.equal(bad.status, 400);
  } finally {
    await s.close();
  }
});
