// statement → notice slice: PII strip + noticed field + POST /vault/notice.
// Fake family only. No real case data.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import { buildNoticeText, stripPii } from "../src/pii.js";
import { readFixedVent } from "../src/demo.js";
import * as logger from "../src/logger.js";

// PII strings that must never survive intake → storage → notice → logs.
// Fake values only.
const PII = {
  phone1: "904-555-1212",
  phone2: "(904) 555-9876",
  email: "jordan.lee@example.com",
  ssn: "123-45-6789",
  ein: "12-3456789",
  address: "482 Maple Street Apt 3",
  account: "12345678",
  routing: "021000021",
  schoolId: "S-4482",
};

const PII_VENT =
  `Jordan cancelled the visit today and told me to call ${PII.phone1} ` +
  `or ${PII.phone2} or email ${PII.email}. ` +
  `She wants my SSN ${PII.ssn} and the business tax id ${PII.ein} ` +
  `for the form, plus checking account #${PII.account} and routing ${PII.routing}. ` +
  `She moved to ${PII.address}. Sam's student ID ${PII.schoolId} is on the school form.`;

function assertNoPii(text, label) {
  // Whitespace-squashed comparison catches mangled leaks too (the venom
  // strip's sentence split once turned "dad@example.com" into
  // "dad@example. com", which dodged an exact-substring check).
  const squashed = String(text).replace(/\s+/g, "");
  for (const [key, value] of Object.entries(PII)) {
    assert.ok(
      !String(text).includes(value) && !squashed.includes(value.replace(/\s+/g, "")),
      `${label} leaks ${key}: ${value}`,
    );
  }
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

// ---------------------------------------------------------------------------
// stripPii unit: every PII category redacted, observable facts kept.

test("stripPii: phones/emails/tax ids/addresses/accounts/school ids gone; facts kept", () => {
  const { text, counts } = stripPii(PII_VENT);
  assertNoPii(text, "stripped text");
  assert.match(text, /\[phone\]/);
  assert.match(text, /\[email\]/);
  assert.match(text, /\[tax-id\]/);
  assert.match(text, /\[address\]/);
  assert.match(text, /\[account\]/);
  assert.match(text, /\[school-id\]/);
  // Observable facts survive.
  assert.match(text, /cancelled the visit today/);
  assert.ok(counts.phone >= 2);
  assert.ok(counts.email >= 1);
  assert.ok(counts.tax_id >= 2);
});

test("stripPii keeps times, dates, amounts, and unnumbered place names", () => {
  const { text } = stripPii(
    "Jordan was supposed to meet at 6pm at the Maple Street parking lot and " +
      "didn't show until 6:45 on 2026-09-14. I paid the sitter $30 extra.",
  );
  assert.match(text, /6pm/);
  assert.match(text, /6:45/);
  assert.match(text, /2026-09-14/);
  assert.match(text, /\$30/);
  // No leading house number → location, not an address.
  assert.match(text, /Maple Street parking lot/);
});

test("stripPii leaves the fixed vent's observable extraction intact", async () => {
  const vault = new Vault();
  const bff = makeBff(vault);
  const dad_id = randomUUID();
  await bff.postVaultProvision({ dad_id });
  const result = await bff.postVaultIntake(
    { dad_id, text: readFixedVent() },
    { referenceDate: new Date("2026-09-14T12:00:00") },
  );
  assert.ok(result.written >= 1);
  const [event] = await vault.listEvents(dad_id);
  assert.equal(event.event_type, "late_exchange");
  assert.equal(event.location, "Maple Street parking lot");
});

// ---------------------------------------------------------------------------
// buildNoticeText: cold, court-safe, claim-status line, PII-free.

test("buildNoticeText: cancelled visit → cold notice string with claim caveat", () => {
  const text = buildNoticeText({
    event_type: "denied_visit",
    occurred_at: "2026-09-16T18:00:00.000Z",
    notes: null,
    location: null,
  });
  assert.match(text, /^Denied or cancelled visit on 2026-09-16\./);
  assert.match(text, /parent statement \(claim\)/);
  assert.match(text, /verification .* pending/i);
});

// ---------------------------------------------------------------------------
// HTTP: intake with PII → storage, state, search, notice, logs all clean.

test("intake make_notice=true: cancelled visit → {noticed_text, event_id}, no PII anywhere", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const { token } = await provision(s.base, dad_id);

    const intake = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: PII_VENT, make_notice: true },
      { token },
    );
    assert.equal(intake.status, 200);
    assert.ok(intake.data.written >= 1);
    assert.ok(intake.data.event_id);
    assert.match(intake.data.noticed_text, /Denied or cancelled visit on \d{4}-\d{2}-\d{2}\./);
    assert.match(intake.data.noticed_text, /parent statement \(claim\)/);
    assertNoPii(intake.data.noticed_text, "noticed_text");

    // The stored row itself is PII-free (raw_quote included) and noticed.
    const [event] = await s.vault.listEvents(dad_id);
    assert.equal(event.id, intake.data.event_id);
    assert.equal(event.pipe, "claim");
    assert.ok(event.noticed_at);
    assert.equal(event.noticed_text, intake.data.noticed_text);
    assertNoPii(JSON.stringify(event), "stored event row");

    // GET /vault/state — no raw PII.
    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.equal(state.status, 200);
    assertNoPii(JSON.stringify(state.data), "state response");

    // GET /vault/search — snippets built from stored (stripped) text only.
    const search = await jsonReq(
      s.base,
      "GET",
      `/vault/search?dad_id=${dad_id}&q=cancelled`,
      null,
      { token },
    );
    assert.equal(search.status, 200);
    assert.ok(search.data.hits.length >= 1);
    assertNoPii(JSON.stringify(search.data), "search response");

    // Noticed claim row never reaches the verified export (Exhibit).
    const verified = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.equal(verified.status, 200);
    assert.deepEqual(verified.data, []);

    // Logs: never the stripped values, never noticed_text.
    assertNoPii(logger.lines().join("\n"), "log lines");
  } finally {
    await s.close();
  }
});

test("intake without make_notice is unchanged: {written, chase} only", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const { token } = await provision(s.base, dad_id);
    const intake = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: "Jordan cancelled the visit today." },
      { token },
    );
    assert.equal(intake.status, 200);
    assert.deepEqual(Object.keys(intake.data).sort(), ["chase", "written"]);
  } finally {
    await s.close();
  }
});

test("POST /vault/notice: no event_id → latest event; explicit event_id works", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const { token } = await provision(s.base, dad_id);
    await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: "Jordan cancelled Tuesday's visit again." },
      { token },
    );

    const notice = await jsonReq(s.base, "POST", "/vault/notice", { dad_id }, { token });
    assert.equal(notice.status, 200);
    assert.ok(notice.data.event_id);
    assert.match(notice.data.noticed_text, /Denied or cancelled visit/);
    assertNoPii(notice.data.noticed_text, "noticed_text");

    const again = await jsonReq(
      s.base,
      "POST",
      "/vault/notice",
      { dad_id, event_id: notice.data.event_id },
      { token },
    );
    assert.equal(again.status, 200);
    assert.equal(again.data.event_id, notice.data.event_id);

    const badUuid = await jsonReq(
      s.base,
      "POST",
      "/vault/notice",
      { dad_id, event_id: "not-a-uuid" },
      { token },
    );
    assert.equal(badUuid.status, 400);

    const missing = await jsonReq(
      s.base,
      "POST",
      "/vault/notice",
      { dad_id, event_id: randomUUID() },
      { token },
    );
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});

test("POST /vault/notice: 404 when the dad has no events yet", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const { token } = await provision(s.base, dad_id);
    const notice = await jsonReq(s.base, "POST", "/vault/notice", { dad_id }, { token });
    assert.equal(notice.status, 404);
  } finally {
    await s.close();
  }
});

test("BLOCKER auth on /vault/notice: 401 no token, 404 unknown dad, 403 cross-dad", async () => {
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
      { dad_id: dadA, text: "Jordan cancelled the visit." },
      { token: a.token },
    );

    // Unprovisioned dad → 404 before any token check.
    const unknown = await jsonReq(s.base, "POST", "/vault/notice", { dad_id: randomUUID() });
    assert.equal(unknown.status, 404);

    // No token → 401.
    const noTok = await jsonReq(s.base, "POST", "/vault/notice", { dad_id: dadA });
    assert.equal(noTok.status, 401);

    // B's token against A's dad_id → 403.
    const cross = await jsonReq(
      s.base,
      "POST",
      "/vault/notice",
      { dad_id: dadA },
      { token: b.token },
    );
    assert.equal(cross.status, 403);

    // B cannot notice A's event via their own dad_id + A's event_id → 404.
    const eventA = (await s.vault.listEvents(dadA))[0];
    const steal = await jsonReq(
      s.base,
      "POST",
      "/vault/notice",
      { dad_id: dadB, event_id: eventA.id },
      { token: b.token },
    );
    assert.equal(steal.status, 404);
    assert.equal(eventA.noticed_at, null, "A's event stays un-noticed");

    // intake make_notice cross-dad is blocked by the same gate → 403.
    const crossIntake = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id: dadB, text: "Cancelled visit.", make_notice: true },
      { token: a.token },
    );
    assert.equal(crossIntake.status, 403);
  } finally {
    await s.close();
  }
});
