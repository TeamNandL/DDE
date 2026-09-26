// Walk friction row 1 (Alex Rivera, paste 1): a cancelled-visit vent must
// come back as one plain noticed sentence + "Matter to you?" — no receipt,
// no menu, no claim jargon, no Next, and never an OFW hop. The vault hands
// Chip that line as `say` on POST /vault/intake with make_notice:true; the
// Chip templates tell Chip to say it verbatim and stop.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Vault } from "../src/vault.js";
import { makeBff, noticeSayLine } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import { seedDemo, readFixedVent, DEMO_DAD_ID } from "../src/demo.js";
import * as logger from "../src/logger.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, "..", rel), "utf8");

// DAD_CHIP_TEST_SCRIPT.md paste 1, verbatim.
const PASTE_1 =
  "They cancelled my visit with the kids this Friday. I’m upset and don’t know what to do next.";

const RECEIPT_RE = /\bgot it\b|\breceived\b|\bthanks\b|\bupload/i;
const JARGON_RE = /claim|verif|record|statement|pending/i;
const HOP_RE = /\bOFW\b|\bStan\b|login|portal|https?:\/\//i;

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

function assertDadFacing(say, { dad_id, token }) {
  assert.equal(typeof say, "string");
  assert.match(say, /Matter to you\?$/);
  // One noticed sentence + the question: exactly two sentences.
  assert.equal(say.split(/(?<=[.?])\s+/).length, 2, `not one sentence + question: ${say}`);
  assert.doesNotMatch(say, RECEIPT_RE, "receipt tone");
  assert.doesNotMatch(say, JARGON_RE, "claim/record jargon");
  assert.doesNotMatch(say, HOP_RE, "OFW / login hop");
  assert.doesNotMatch(say, /\bnext\b/i, "a Next rides the notice turn");
  assert.doesNotMatch(say, /\d/, "invented date or number");
  assert.ok(!say.includes(dad_id) && !say.includes(token), "plumbing leak");
}

test("noticeSayLine: cancelled + weekday, no weekday, refusal, other types", () => {
  assert.equal(noticeSayLine(PASTE_1, "denied_visit"), "They cancelled your Friday visit. Matter to you?");
  assert.equal(
    noticeSayLine("Jordan cancelled the visit again.", "denied_visit"),
    "They cancelled your visit. Matter to you?",
  );
  assert.equal(
    noticeSayLine("She refused to let me see the kids on Sunday.", "denied_visit"),
    "Your Sunday visit didn't happen. Matter to you?",
  );
  assert.equal(noticeSayLine(readFixedVent(), "late_exchange"), null);
  assert.equal(noticeSayLine(PASTE_1, undefined), null);
});

test("walk paste 1 on the --demo dad: say = noticed + Matter to you?, no OFW Next in the reply", async () => {
  const s = await start();
  try {
    // --demo seed: the fixed vent leaves an OFW verify item as next_action.
    const { token } = await seedDemo(s.bff);
    const dad_id = DEMO_DAD_ID;
    const before = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.match(before.data.next_action, /OFW/, "fixture precondition: demo carries an OFW Next");

    const intake = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: PASTE_1, make_notice: true },
      { token },
    );
    assert.equal(intake.status, 200);
    assert.equal(intake.data.written, 1);
    assert.deepEqual(intake.data.chase, []);
    assert.equal(intake.data.say, "They cancelled your Friday visit. Matter to you?");
    assertDadFacing(intake.data.say, { dad_id, token });
    // The reply itself carries no Next of any kind.
    assert.ok(!("next_action" in intake.data));
    // Record copy still written for the claim pipe (unchanged contract).
    assert.match(intake.data.noticed_text, /^Denied or cancelled visit on /);

    // Logs: ids only — never the spoken line.
    assert.doesNotMatch(logger.lines().join("\n"), /Matter to you|Friday/);
  } finally {
    await s.close();
  }
});

test("make_notice on a non-visit vent: no say (nothing invented)", async () => {
  const s = await start();
  try {
    const prov = await jsonReq(s.base, "POST", "/vault/provision", {});
    const { dad_id, token } = prov.data;
    const late = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: readFixedVent(), make_notice: true },
      { token },
    );
    assert.equal(late.status, 200);
    assert.ok(late.data.written >= 1);
    assert.ok(!("say" in late.data));
  } finally {
    await s.close();
  }
});

test("plain intake (no make_notice) keeps {written, chase} — no say", async () => {
  const s = await start();
  try {
    const prov = await jsonReq(s.base, "POST", "/vault/provision", {});
    const { dad_id, token } = prov.data;
    const plain = await jsonReq(s.base, "POST", "/vault/intake", { dad_id, text: PASTE_1 }, { token });
    assert.deepEqual(Object.keys(plain.data).sort(), ["chase", "written"]);
  } finally {
    await s.close();
  }
});

test("Chip templates: intake sends make_notice, says `say` verbatim and stops, never hops to OFW", () => {
  const dad = read("CHIP_DAD_TEMPLATE.md");
  assert.match(dad, /"make_notice": true/);
  assert.match(dad, /`say`[\s\S]*verbatim[\s\S]*\*\*stop\*\*/);
  assert.match(dad, /never opens OFW, Stan, a portal, or any login page/);
  assert.match(dad, /Never read `noticed_text` aloud/);

  const pub = read("CHIP_PUBLIC_TEMPLATE.md");
  assert.match(pub, /Matter to you\?/);
  assert.match(pub, /never open OFW, a portal, or any login page/);
});
