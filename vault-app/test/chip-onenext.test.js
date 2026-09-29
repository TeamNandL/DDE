// Chip one-Next undercarriage. Fake dads only.
// File cue → hash log → PRIMARY under-floor line.
// Vent cue → intake only. Overwhelm shrinks to one ask.
// Exhibit empty is honest. No bytes. No storage_uri.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer, PHASE1_ROUTES } from "../src/server.js";
import {
  EXHIBIT_EMPTY_SAY,
  FILE_WAIT_SAY,
  GAUGE_SAY,
  SHRINK_SAY,
  TONE_SAY,
  UNDER_FLOOR_SAY,
  classifyChipCue,
} from "../src/chip-onenext.js";
import { jsonReq } from "./auth-cases.js";

const here = dirname(fileURLToPath(import.meta.url));
const HASH = "ab".repeat(32);
const NEXT = "Pull the September exchange thread";

function read(rel) {
  return readFileSync(resolve(here, "..", rel), "utf8");
}

async function start() {
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

async function dad(base) {
  const res = await jsonReq(base, "POST", "/vault/provision", {});
  assert.equal(res.status, 200);
  return res.data;
}

function assertOneNext(say) {
  assert.equal(typeof say, "string");
  assert.ok((say.match(/\bNext\b/g) ?? []).length <= 1);
  assert.doesNotMatch(say, /\bgot it\b/i);
  assert.doesNotMatch(say, /\bverified\b/i);
  assert.doesNotMatch(say, /https?:\/\//i);
  assert.doesNotMatch(say, /\bdad_id\b/i);
  assert.doesNotMatch(say, /\bselect\b/i);
}

test("classifier: one track; emotion beats a file in the same blurt", () => {
  assert.equal(classifyChipCue("I have the bank statement PDF").track, "evidence");
  assert.equal(classifyChipCue("I am furious and I have the PDF statement").track, "vent");
  assert.equal(classifyChipCue("I am overwhelmed. Everything at once.").track, "vent");
  assert.equal(classifyChipCue("I am overwhelmed. Everything at once.").shrink, true);
  assert.equal(classifyChipCue("I am about to send this reply").track, "gauge");
  assert.equal(classifyChipCue("What should I say about Friday pickup?").track, "tone");
  assert.equal(classifyChipCue("What's next?").track, "eddie");
  assert.equal(classifyChipCue("Show my case").track, "exhibit");
  assert.equal(classifyChipCue("She cancelled Friday and I am upset.").track, "vent");
  assert.equal((UNDER_FLOOR_SAY.match(/\bNext\b/g) ?? []).length, 1);
  assert.equal(UNDER_FLOOR_SAY.includes("\u2019"), true);
});

test("C1 file cue + hash → evidence log + exact PRIMARY; no intake row", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const beforeEvents = (await s.vault.listEvents(dad_id)).length;
    const turn = await jsonReq(
      s.base,
      "POST",
      "/vault/chip/turn",
      { dad_id, text: "I have the bank statement PDF", sha256: HASH, filename: "statement.pdf" },
      { token },
    );
    assert.equal(turn.status, 200);
    assert.equal(turn.data.track, "evidence");
    assert.equal(turn.data.wrote, "evidence/log");
    assert.equal(turn.data.say, UNDER_FLOOR_SAY);
    assertOneNext(turn.data.say);
    assert.equal((await s.vault.listEvents(dad_id)).length, beforeEvents);
    assert.equal(s.vault.evidence_log.length, 1);
    assert.equal(s.vault.evidence_log[0].stage, "logged");
    assert.equal(s.vault.evidence_log[0].routing, "inbox_unmapped");
    assert.equal(s.vault.evidence_log[0].sha256, HASH);
    assert.equal(Object.hasOwn(s.vault.evidence_log[0], "storage_uri"), false);
    const verified = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(verified.data, []);
    const inbox = await jsonReq(s.base, "GET", `/vault/evidence/inbox?dad_id=${dad_id}`, null, { token });
    assert.equal(inbox.data.items.length, 1);
  } finally {
    await s.close();
  }
});

test("file cue without a hash does not log and does not speak PRIMARY", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const turn = await jsonReq(
      s.base,
      "POST",
      "/vault/chip/turn",
      { dad_id, text: "I have a PDF" },
      { token },
    );
    assert.equal(turn.status, 200);
    assert.equal(turn.data.wrote, null);
    assert.equal(turn.data.say, FILE_WAIT_SAY);
    assert.notEqual(turn.data.say, UNDER_FLOOR_SAY);
    assert.equal(s.vault.evidence_log.length, 0);
  } finally {
    await s.close();
  }
});

test("C2 vent cue → intake only, never evidence/log; mixed blurt stays vent", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const vent = await jsonReq(
      s.base,
      "POST",
      "/vault/chip/turn",
      { dad_id, text: "She cancelled Friday and I am upset.", sha256: HASH },
      { token },
    );
    assert.equal(vent.status, 200);
    assert.equal(vent.data.track, "vent");
    assert.equal(vent.data.wrote, "intake");
    assert.equal(vent.data.say, "They cancelled your Friday visit. Matter to you?");
    assert.equal(s.vault.evidence_log.length, 0);
    const mixed = await jsonReq(
      s.base,
      "POST",
      "/vault/chip/turn",
      { dad_id, text: "I am furious and I have the PDF statement", sha256: HASH },
      { token },
    );
    assert.equal(mixed.data.track, "vent");
    assert.equal(s.vault.evidence_log.length, 0);
  } finally {
    await s.close();
  }
});

test("overwhelm + file in one blurt stays vent and does not log", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const cues = [
      "Everything at once. I have the PDF",
      "I can't do this. Here is the statement PDF",
      "Shutting down. Got a scan of the order",
    ];
    for (const text of cues) {
      const fork = classifyChipCue(text);
      assert.equal(fork.track, "vent", text);
      assert.equal(fork.shrink, true, text);
      const turn = await jsonReq(
        s.base,
        "POST",
        "/vault/chip/turn",
        { dad_id, text, sha256: HASH, filename: "order.pdf" },
        { token },
      );
      assert.equal(turn.status, 200, text);
      assert.equal(turn.data.track, "vent", text);
      assert.equal(turn.data.say, SHRINK_SAY, text);
      assert.equal(s.vault.evidence_log.length, 0, text);
    }
  } finally {
    await s.close();
  }
});

test("C3 overwhelm → one smaller ask, no menu", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const turn = await jsonReq(
      s.base,
      "POST",
      "/vault/chip/turn",
      { dad_id, text: "I am overwhelmed. Everything at once." },
      { token },
    );
    assert.equal(turn.status, 200);
    assert.equal(turn.data.track, "vent");
    assert.equal(turn.data.say, SHRINK_SAY);
    assert.equal((turn.data.say.match(/\?/g) ?? []).length, 1);
    assert.doesNotMatch(turn.data.say, /\bor\b/i);
    assert.equal(s.vault.evidence_log.length, 0);
  } finally {
    await s.close();
  }
});

test("C4 exhibit ask with empty verified → soft hide, not a search dump", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const turn = await jsonReq(
      s.base,
      "POST",
      "/vault/chip/turn",
      { dad_id, text: "Show my case" },
      { token },
    );
    assert.equal(turn.status, 200);
    assert.equal(turn.data.track, "exhibit");
    assert.equal(turn.data.say, EXHIBIT_EMPTY_SAY);
    assert.equal(turn.data.wrote, null);
    assert.ok(!("hits" in turn.data));
    assert.ok(!("items" in turn.data));
    const verified = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(verified.data, []);
  } finally {
    await s.close();
  }
});

test("C5 dad-visible scrub: no url, token, dad_id in say", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const put = await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id, next_action: `Open https://secret.example/${dad_id} then call` },
      { token },
    );
    assert.equal(put.status, 200);
    const eddie = await jsonReq(
      s.base,
      "POST",
      "/vault/chip/turn",
      { dad_id, text: "What's next?" },
      { token },
    );
    assert.equal(eddie.status, 200);
    assert.equal(eddie.data.track, "eddie");
    assertOneNext(eddie.data.say);
    assert.ok(!eddie.data.say.includes(dad_id));
    assert.ok(!eddie.data.say.includes(token));
    assert.doesNotMatch(eddie.data.say, /https?:\/\//i);
    assert.match(eddie.data.say, /^Next: /);
  } finally {
    await s.close();
  }
});

test("vent with a stored Next quotes it once; gauge writes nothing; tone is a draft", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const put = await jsonReq(s.base, "PUT", "/vault/state", { dad_id, next_action: NEXT }, { token });
    assert.equal(put.status, 200);
    const vent = await jsonReq(
      s.base,
      "POST",
      "/vault/chip/turn",
      { dad_id, text: "Pickup on 2026-09-12 was 45 minutes late." },
      { token },
    );
    assert.equal(vent.data.track, "vent");
    assert.equal(vent.data.say, `Next: ${NEXT}.`);
    assert.equal((vent.data.say.match(/\bNext\b/g) ?? []).length, 1);

    const commsBefore = s.vault.communications.length;
    const gauge = await jsonReq(
      s.base,
      "POST",
      "/vault/chip/turn",
      { dad_id, text: "I am about to send this reply." },
      { token },
    );
    assert.equal(gauge.data.track, "gauge");
    assert.equal(gauge.data.wrote, null);
    assert.equal(gauge.data.say, GAUGE_SAY);
    assert.equal(s.vault.communications.length, commsBefore);

    const tone = await jsonReq(
      s.base,
      "POST",
      "/vault/chip/turn",
      { dad_id, text: "What should I say? Can we swap Friday pickup for Saturday?" },
      { token },
    );
    assert.equal(tone.data.track, "tone");
    assert.equal(tone.data.wrote, "comms/draft");
    assert.equal(tone.data.say, TONE_SAY);
    const draft = s.vault.communications.find((c) => c.direction === "draft");
    assert.ok(draft);
    assert.equal(draft.sent_at, null);
  } finally {
    await s.close();
  }
});

test("bytes and storage_uri are refused; cross-dad is 403; route is listed", async () => {
  const s = await start();
  try {
    const a = await dad(s.base);
    const b = await dad(s.base);
    const bytes = await jsonReq(
      s.base,
      "POST",
      "/vault/chip/turn",
      { dad_id: a.dad_id, text: "I have a PDF", sha256: HASH, storage_uri: "s3://nope", bytes: "abc" },
      { token: a.token },
    );
    assert.equal(bytes.status, 400);
    assert.equal(s.vault.evidence_log.length, 0);
    const cross = await jsonReq(
      s.base,
      "POST",
      "/vault/chip/turn",
      { dad_id: b.dad_id, text: "I have a PDF", sha256: HASH },
      { token: a.token },
    );
    assert.equal(cross.status, 403);
    assert.ok(PHASE1_ROUTES.includes("POST /vault/chip/turn"));
  } finally {
    await s.close();
  }
});

test("entry page hashes locally and posts chip/turn — no bytes field", () => {
  const html = read("public/chip-entry.html");
  assert.match(html, /\/vault\/chip\/turn/);
  assert.match(html, /crypto\.subtle\.digest\("SHA-256"/);
  assert.doesNotMatch(html, /storage_uri/);
  assert.doesNotMatch(html, /FormData/);
  assert.doesNotMatch(html, /https?:\/\//i);
  const dadT = read("CHIP_DAD_TEMPLATE.md");
  assert.match(dadT, /One-Next undercarriage/);
  assert.match(dadT, /Got that file/);
  assert.doesNotMatch(dadT, /https?:\/\//i);
});
