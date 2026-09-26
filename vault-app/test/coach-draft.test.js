// Slice 2 — Coach / Tone seat (vent hot → send cold) is its own pipe:
// POST /vault/comms/draft, draft ≠ send, one beat ("Not sent. Next: …").
// Quill (intake / notice) stays separate and unchanged. Drift 2: a draft
// that asks for something on the record flips mode to "document".

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Vault } from "../src/vault.js";
import { makeBff, draftMode, draftSayLine } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import * as logger from "../src/logger.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, "..", rel), "utf8");

// DAD_CHIP_TEST_SCRIPT.md paste 2, verbatim (what the dad says).
const PASTE_2 =
  "My co-parent keeps changing the pickup plan at the last minute and I’m furious. Help me say something calm and factual.";
// What Chip (Coach seat) writes from it and POSTs — the cold draft.
const COLD_FROM_PASTE_2 =
  "The pickup plan has changed at the last minute several times. Can we keep the agreed pickup time? Please confirm in writing.";
// Paste 1 (Slice 1 notice path) — must be untouched by Slice 2.
const PASTE_1 =
  "They cancelled my visit with the kids this Friday. I’m upset and don’t know what to do next.";

const BEAT_RE = /hang tight|draft next|one sec|working on/i;
const HOP_RE = /\bOFW\b|\bStan\b|login|portal|https?:\/\//i;

async function start() {
  logger.reset();
  const vault = new Vault();
  const bff = makeBff(vault);
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  return {
    vault,
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

function assertOneBeat(say) {
  assert.match(say, /^Not sent\. Next: /, "draft ≠ send first, then the Next");
  assert.equal((say.match(/\bNext\b/g) ?? []).length, 1, "exactly one Next");
  assert.doesNotMatch(say, BEAT_RE, "second 'hang tight' beat");
  assert.doesNotMatch(say, HOP_RE, "OFW / login hop");
}

test("draftMode: medical-calendar ask → document; plain reply → de_escalate", () => {
  assert.equal(
    draftMode("Please add the kids' doctor, dentist, and counseling appointments to the shared calendar."),
    "document",
  );
  assert.equal(draftMode(COLD_FROM_PASTE_2), "document");
  assert.equal(draftMode("Noted. I'll be at the exchange at 6."), "de_escalate");
  assert.equal(draftMode("Please stop texting me late at night."), "de_escalate");
  assert.equal(draftMode(""), "de_escalate");
  assertOneBeat(draftSayLine("document"));
  assertOneBeat(draftSayLine("de_escalate"));
  assert.notEqual(draftSayLine("document"), draftSayLine("de_escalate"));
});

test("walk paste 2 → Coach draft path: calm draft stored, not sent, one beat, no intake write", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const stateBefore = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });

    const draft = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/draft",
      { dad_id, body: COLD_FROM_PASTE_2 },
      { token },
    );
    assert.equal(draft.status, 200);
    assert.equal(draft.data.written, 1);
    assert.equal(draft.data.body, COLD_FROM_PASTE_2);
    assert.equal(draft.data.soft_grade, "ready");
    assert.equal(draft.data.mode, "document");
    assert.equal(draft.data.say, "Not sent. Next: send it yourself — it puts your ask on the record.");
    assertOneBeat(draft.data.say);
    assert.ok(!draft.data.say.includes(dad_id) && !draft.data.say.includes(token));

    // draft ≠ send: listed as a draft only, never sent, never verified.
    const drafts = await jsonReq(s.base, "GET", `/vault/comms/drafts?dad_id=${dad_id}`, null, { token });
    assert.equal(drafts.data.length, 1);
    const [row] = await s.vault.listDrafts(dad_id);
    assert.equal(row.direction, "draft");
    assert.equal(row.sent_at, null);
    const verified = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(verified.data, []);

    // Separate pipe: Coach wrote no claim event and did not move the Next.
    assert.equal((await s.vault.listEvents(dad_id)).length, 0);
    const stateAfter = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.equal(stateAfter.data.next_action, stateBefore.data.next_action);

    // Logs: ids + enums only — never the draft or the spoken line.
    assert.doesNotMatch(logger.lines().join("\n"), /pickup|Not sent|record/);
  } finally {
    await s.close();
  }
});

test("hot vent posted raw → venom stripped, graded tighten, still not sent", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const hot = `${PASTE_2} She is doing this on purpose, she's spiteful.`;
    const draft = await jsonReq(s.base, "POST", "/vault/comms/draft", { dad_id, body: hot }, { token });
    assert.equal(draft.status, 200);
    assert.equal(draft.data.written, 1);
    assert.doesNotMatch(draft.data.body, /spiteful|on purpose/);
    assert.equal(draft.data.soft_grade, "tighten");
    assertOneBeat(draft.data.say);
    const [row] = await s.vault.listDrafts(dad_id);
    assert.equal(row.sent_at, null);
  } finally {
    await s.close();
  }
});

test("Slice 1 notice path unchanged: paste 1 → Quill say, no draft, no mode", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const intake = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: PASTE_1, make_notice: true },
      { token },
    );
    assert.equal(intake.data.say, "They cancelled your Friday visit. Matter to you?");
    assert.ok(!("mode" in intake.data));
    const drafts = await jsonReq(s.base, "GET", `/vault/comms/drafts?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(drafts.data, []);
  } finally {
    await s.close();
  }
});

test("Chip templates + CHIP_APP name the seats and route words-asks to Coach, one beat", () => {
  const dadT = read("CHIP_DAD_TEMPLATE.md");
  for (const seat of ["**Chip**", "**Quill**", "**Coach / Tone**", "**Eddie**"]) {
    assert.ok(dadT.includes(seat), `dad template missing seat ${seat}`);
  }
  assert.match(dadT, /POST \{\{BASE\}\}\/vault\/comms\/draft/);
  assert.match(dadT, /Coach never replaces Quill; Quill never writes a draft/);
  assert.match(dadT, /No "hang tight", no "draft next"/);
  assert.match(dadT, /mode: "document"/);

  const app = read("CHIP_APP.md");
  assert.match(app, /## Seats \(two pipes — never merged\)/);
  assert.match(app, /Coach \/ Tone seat \(vent hot → send cold\)/);

  const pub = read("CHIP_PUBLIC_TEMPLATE.md");
  assert.match(pub, /\*\*not sent\*\*/);
});
