// Court-prep capture — COURT_PREP_PRINCIPLES §2–§5 on the in-memory vault.
//   §2 keyword hits → candidate facts, confidence low, never asserted
//   §3 OFW stub: not_proof_yet | matched | conflict (one line), OFW never overwritten
//   §4 structured who / what / when / kids
//   §5 two check-ins a day as Notifications (unread → read → done; missed past window)

import test from "node:test";
import assert from "node:assert/strict";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import {
  candidateFacts,
  checkinWindows,
  crossCheck,
  effectiveStatus,
  factLine,
  maskAmounts,
  resolveWhen,
} from "../src/courtprep.js";
import * as logger from "../src/logger.js";

const REF = new Date("2026-09-26T15:00:00Z"); // a Saturday
const PASTE_1 =
  "They cancelled my visit with the kids this Friday. I’m upset and don’t know what to do next.";
const HARM = "I am so angry I could hurt Jordan the next time she pulls this at the exchange.";

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
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function dad(base) {
  const prov = await jsonReq(base, "POST", "/vault/provision", {});
  assert.equal(prov.status, 200);
  return prov.data;
}

// ---------------------------------------------------------------------------
// Pure units

test("§2/§4 candidateFacts: one structured, low-signal candidate per keyword-hit sentence", () => {
  const facts = candidateFacts(
    "Friday cancel. Quinn did come last Friday. Time with daughter tonight. It rained a lot.",
    REF,
  );
  assert.equal(facts.length, 3, "the sentence with no hit is not a fact; every hit is kept");
  assert.deepEqual(
    facts.map((f) => [f.what, f.when_text, f.when_on]),
    [
      ["cancelled", "Friday", null],
      ["attended", "last Friday", "2026-09-25"],
      ["time_with", "tonight", "2026-09-26"],
    ],
  );
  assert.deepEqual(facts[1].who, ["Quinn"]);
  assert.deepEqual(facts[2].kids, ["daughter"]);
  // A when-only hit is still captured (over-capture), as a plain mention.
  const [mention] = candidateFacts("Pickup is at 6pm tomorrow.", REF);
  assert.equal(mention.what, "schedule");
  assert.equal(mention.when_on, "2026-09-27");
  assert.equal(candidateFacts("See you at 5pm.", REF)[0].what, "mention");
});

test("resolveWhen: only unambiguous days resolve; bare/this weekday stays null", () => {
  assert.equal(resolveWhen("2026-09-12", REF), "2026-09-12");
  assert.equal(resolveWhen("yesterday", REF), "2026-09-25");
  assert.equal(resolveWhen("last Saturday", REF), "2026-09-19");
  assert.equal(resolveWhen("next Monday", REF), "2026-09-28");
  assert.equal(resolveWhen("this Friday", REF), null);
  assert.equal(resolveWhen("Friday", REF), null);
});

test("no live dollar figures: amounts are masked, the fact is kept", () => {
  assert.equal(maskAmounts("paid $1,250.00 and 30 dollars"), "paid [amount] and [amount]");
  const [f] = candidateFacts("I paid the sitter $30 extra tonight.", REF);
  assert.doesNotMatch(f.quote, /\$|30/);
  assert.match(f.quote, /\[amount\]/);
});

test("§3 crossCheck stub: silent → not proof yet; agree → matched; disagree → conflict (one line)", () => {
  const [f] = candidateFacts("Jordan cancelled the visit yesterday.", REF);
  const ofw = (body) => [{ id: "o1", source_ref: "ofw:2026-09-25", body_cold: body, sent_at: "2026-09-25T18:00:00Z" }];

  const silent = crossCheck(f, []);
  assert.equal(silent.status, "not_proof_yet");
  assert.equal(factLine(f, silent), "Yesterday: visit cancelled — your account, not proof yet.");

  const otherDay = crossCheck(f, [{ ...ofw("Visit completed.")[0], sent_at: "2026-09-20T18:00:00Z" }]);
  assert.equal(otherDay.status, "not_proof_yet");

  const matched = crossCheck(f, ofw("Visit cancelled by parent."));
  assert.equal(matched.status, "matched");
  assert.equal(matched.ofw_ref, "ofw:2026-09-25");
  assert.equal(factLine(f, matched), "Yesterday: visit cancelled — OFW shows the same.");

  const rows = ofw("Visit completed, pickup at 6.");
  const before = structuredClone(rows);
  const conflict = crossCheck(f, rows);
  assert.equal(conflict.status, "conflict");
  const line = factLine(f, conflict);
  assert.equal(
    line,
    "Yesterday: visit cancelled — OFW for 2026-09-25 shows they came. Check before you rely on it.",
  );
  assert.equal(line.split(/(?<=\.)\s+(?=[A-Z])/).length <= 2 && !line.includes("\n"), true, "one line");
  assert.doesNotMatch(line, /lying|lied|on purpose|spite|wants to|trying to/i, "never motive");
  assert.deepEqual(rows, before, "OFW rows are read, never written");

  // A fact without a resolved day can't be compared — stays not proof yet.
  const [undated] = candidateFacts("They cancelled my visit this Friday.", REF);
  assert.equal(crossCheck(undated, rows).status, "not_proof_yet");
});

test("§5 check-in windows: two per day at 8–12 and 18–22 local; missed past the window", () => {
  const w = checkinWindows("2026-09-27", -240); // US Eastern daylight
  assert.deepEqual(
    w.map((x) => [x.slot, x.due_start, x.due_end]),
    [
      ["morning", "2026-09-27T12:00:00.000Z", "2026-09-27T16:00:00.000Z"],
      ["evening", "2026-09-27T22:00:00.000Z", "2026-09-28T02:00:00.000Z"],
    ],
  );
  const item = { ...w[0], status: "unread" };
  assert.equal(effectiveStatus(item, new Date("2026-09-27T13:00:00Z")), "unread");
  assert.equal(effectiveStatus(item, new Date("2026-09-27T17:00:00Z")), "missed");
  assert.equal(effectiveStatus({ ...item, status: "done" }, new Date("2026-09-28T00:00:00Z")), "done");
  assert.throws(() => checkinWindows("27-09-2026"));
});

// ---------------------------------------------------------------------------
// HTTP / BFF

test("intake + tell + return capture candidates; all claim, low, not proof yet; never verified", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const intake = await jsonReq(
      s.base, "POST", "/vault/intake", { dad_id, text: PASTE_1, make_notice: true }, { token },
    );
    // Slice 1 + Slice 4 unchanged.
    assert.equal(intake.data.say, "They cancelled your Friday visit. Matter to you?");
    assert.equal(intake.data.fork, "Want to tell me? Talk or text.");

    const tell = await jsonReq(
      s.base, "POST", "/vault/tell",
      { dad_id, channel: "talk", story: "Quinn did come last Friday. Call me at 904-555-1212." },
      { token },
    );
    assert.equal(tell.data.written, 1);

    await jsonReq(s.base, "PUT", "/vault/state", { dad_id, next_action: "Log the pickup" }, { token });
    await jsonReq(s.base, "POST", "/vault/return", { dad_id, answer: "Pickup was late yesterday." }, { token });

    const res = await jsonReq(s.base, "GET", `/vault/candidates?dad_id=${dad_id}`, null, { token });
    assert.equal(res.status, 200);
    const c = res.data.candidates;
    assert.deepEqual(c.map((x) => [x.source, x.what]), [
      ["intake", "cancelled"],
      ["tell", "attended"],
      ["return", "late"],
    ]);
    for (const x of c) {
      assert.equal(x.confidence, "low");
      assert.equal(x.status, "not_proof_yet");
      assert.match(x.line, /not proof yet\.$/);
      assert.doesNotMatch(JSON.stringify(x), /904-555-1212/, "PII stripped before capture");
    }
    assert.deepEqual(c[1].who, ["Quinn"]);
    assert.equal(s.vault.candidate_facts.every((r) => r.pipe === "claim"), true);

    const verified = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(verified.data, [], "candidates never reach the verified export");

    assert.doesNotMatch(logger.lines().join("\n"), /Quinn|not proof yet|cancelled your/, "logs: ids only");
  } finally {
    await s.close();
  }
});

test("OFW pull flips a matching candidate to conflict — one line — and the OFW row is untouched", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    await s.bff.postVaultTell(
      { dad_id, channel: "text", story: "Jordan cancelled the visit yesterday." },
      { referenceDate: REF },
    );
    const before = await jsonReq(s.base, "GET", `/vault/candidates?dad_id=${dad_id}`, null, { token });
    assert.equal(before.data.candidates[0].status, "not_proof_yet");

    const body_cold = "Visit completed, pickup at 6.";
    const pull = await jsonReq(
      s.base, "POST", "/vault/comms/pull",
      { dad_id, channel: "ofw", source_ref: "ofw:2026-09-25", body_cold, sent_at: "2026-09-25T18:00:00Z" },
      { token },
    );
    assert.equal(pull.status, 200);

    const after = await jsonReq(s.base, "GET", `/vault/candidates?dad_id=${dad_id}`, null, { token });
    const [cand] = after.data.candidates;
    assert.equal(cand.status, "conflict");
    assert.equal(
      cand.line,
      "Yesterday: visit cancelled — OFW for 2026-09-25 shows they came. Check before you rely on it.",
    );

    const ofwRow = s.vault.communications.find((r) => r.source_ref === "ofw:2026-09-25");
    assert.equal(ofwRow.body_cold, body_cold, "OFW is never auto-overwritten");
    assert.equal(ofwRow.pipe, "verified");
    const verified = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`, null, { token });
    assert.equal(verified.data.length, 1, "verified export holds the OFW row only");
    assert.equal(verified.data[0].source_ref, "ofw:2026-09-25");
  } finally {
    await s.close();
  }
});

test("harm → no candidates; statement drop → not captured (Track 2 parked)", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    await jsonReq(s.base, "POST", "/vault/intake", { dad_id, text: HARM, make_notice: true }, { token });
    await jsonReq(s.base, "POST", "/vault/tell", { dad_id, channel: "talk", story: HARM }, { token });
    await jsonReq(
      s.base, "POST", "/vault/intake",
      { dad_id, text: "Statement 2026-09-12 payment of $1,250.00 to Maple Street Sitters.", source: "statement" },
      { token },
    );
    const res = await jsonReq(s.base, "GET", `/vault/candidates?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(res.data.candidates, []);
  } finally {
    await s.close();
  }
});

test("§5 Notifications: ensure is idempotent (2 a day), mark read/done, missed computed, tell answers an open window", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const first = await jsonReq(
      s.base, "POST", "/vault/checkins/ensure", { dad_id, date: "2026-09-27", tz_offset_minutes: -240 }, { token },
    );
    assert.equal(first.status, 200);
    assert.equal(first.data.created, 2);
    assert.deepEqual(first.data.items.map((i) => i.slot), ["morning", "evening"]);
    const again = await jsonReq(
      s.base, "POST", "/vault/checkins/ensure", { dad_id, date: "2026-09-27", tz_offset_minutes: -240 }, { token },
    );
    assert.equal(again.data.created, 0, "idempotent per day + slot");
    assert.equal(again.data.items.length, 2);

    const [morning, evening] = first.data.items;
    const read = await jsonReq(
      s.base, "POST", "/vault/notifications/mark", { dad_id, id: morning.id, status: "read" }, { token },
    );
    assert.equal(read.status, 200);

    // Missed is computed at read time past due_end (stored status unchanged).
    const late = await s.bff.getVaultNotifications({ dad_id }, { now: "2026-09-27T17:00:00Z" });
    assert.deepEqual(late.items.map((i) => i.status), ["missed", "unread"]);
    assert.equal(late.unread, 1);

    // The dad's words inside the open evening window answer it.
    await s.bff.postVaultTell(
      { dad_id, channel: "text", story: "Time with my son tonight at dinner." },
      { referenceDate: new Date("2026-09-27T23:00:00Z"), now: "2026-09-27T23:00:00Z" },
    );
    const done = await s.bff.getVaultNotifications({ dad_id }, { now: "2026-09-27T23:30:00Z" });
    assert.deepEqual(done.items.map((i) => i.status), ["missed", "done"]);

    // Explicit mark done works too.
    const mark = await jsonReq(
      s.base, "POST", "/vault/notifications/mark", { dad_id, id: evening.id, status: "done" }, { token },
    );
    assert.equal(mark.data.status, "done");

    const bad = await jsonReq(
      s.base, "POST", "/vault/notifications/mark", { dad_id, id: morning.id, status: "sent" }, { token },
    );
    assert.equal(bad.status, 400);
    const badTz = await jsonReq(
      s.base, "POST", "/vault/checkins/ensure", { dad_id, tz_offset_minutes: 9999 }, { token },
    );
    assert.equal(badTz.status, 400);
  } finally {
    await s.close();
  }
});

test("tenancy: another dad's token → 403; another dad's notification id → 404", async () => {
  const s = await start();
  try {
    const a = await dad(s.base);
    const b = await dad(s.base);
    const cross = await jsonReq(s.base, "GET", `/vault/candidates?dad_id=${b.dad_id}`, null, { token: a.token });
    assert.equal(cross.status, 403);
    const crossN = await jsonReq(s.base, "GET", `/vault/notifications?dad_id=${b.dad_id}`, null, { token: a.token });
    assert.equal(crossN.status, 403);
    const noAuth = await jsonReq(s.base, "GET", `/vault/candidates?dad_id=${a.dad_id}`);
    assert.equal(noAuth.status, 401);

    const ens = await jsonReq(s.base, "POST", "/vault/checkins/ensure", { dad_id: b.dad_id }, { token: b.token });
    const bId = ens.data.items[0].id;
    const steal = await jsonReq(
      s.base, "POST", "/vault/notifications/mark", { dad_id: a.dad_id, id: bId, status: "done" }, { token: a.token },
    );
    assert.equal(steal.status, 404);
  } finally {
    await s.close();
  }
});

test("Chip contract docs name the court-prep endpoints and keep the rails", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../CHIP_APP.md", import.meta.url), "utf8");
  for (const route of [
    "GET /vault/candidates",
    "POST /vault/checkins/ensure",
    "GET /vault/notifications",
    "POST /vault/notifications/mark",
  ]) {
    assert.ok(app.includes(route), `CHIP_APP.md missing ${route}`);
  }
  assert.match(app, /OFW rows are read, \*\*never written\*\*/);
  const dadT = readFileSync(new URL("../CHIP_DAD_TEMPLATE.md", import.meta.url), "utf8");
  assert.match(dadT, /Never\s+guess why; never pick a side/);
  // The principles file is canonical and untouched by this slice.
  const principles = readFileSync(new URL("../COURT_PREP_PRINCIPLES.md", import.meta.url), "utf8");
  assert.match(principles, /OFW is the verified record and is never\s+auto-overwritten/);
});
