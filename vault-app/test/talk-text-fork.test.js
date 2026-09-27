// Slice 4 — talk/text fork (locked): every Chip intake offers "Want to tell
// me? Talk or text."; the dad picks one; either way he gets the same
// feedback (ack + claim ≠ verified + one Next). Slice 1 notice, Slice 2
// Coach draft, and the return loop stay unchanged.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Vault } from "../src/vault.js";
import { makeBff, FORK_LINE, tellFeedback } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import { readFixedVent } from "../src/demo.js";
import * as logger from "../src/logger.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, "..", rel), "utf8");

const PASTE_1 =
  "They cancelled my visit with the kids this Friday. I’m upset and don’t know what to do next.";
const HARM = "I am so angry I could hurt Jordan the next time she pulls this at the exchange.";
const STORY =
  "Friday I drove to the exchange at 6 and waited. Call me at 904-555-1212. She is doing this on purpose.";
const NEXT = "Pull the September exchange thread";

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

async function dadWithNext(base) {
  const prov = await jsonReq(base, "POST", "/vault/provision", {});
  const { dad_id, token } = prov.data;
  const put = await jsonReq(base, "PUT", "/vault/state", { dad_id, next_action: NEXT }, { token });
  assert.equal(put.status, 200);
  return { dad_id, token };
}

function assertFeedback(fb) {
  assert.match(fb, /^I heard you\. /, "ack first");
  assert.match(fb, /not proof yet/, "claim ≠ verified in plain words");
  assert.equal((fb.match(/\bNext\b/g) ?? []).length, 1, "exactly one Next");
  assert.doesNotMatch(fb, /hang tight|soft|grade|https?:\/\/|login|portal/i);
}

test("fork line + feedback units: one question; feedback with and without a Next", () => {
  assert.equal(FORK_LINE, "Want to tell me? Talk or text.");
  assert.equal((FORK_LINE.match(/\?/g) ?? []).length, 1, "one question, not a menu");
  assert.equal(
    tellFeedback(NEXT),
    `I heard you. It's kept as your account — not proof yet. Next: ${NEXT}.`,
  );
  assertFeedback(tellFeedback(NEXT));
  assertFeedback(tellFeedback(null));
});

test("fork offered on every Chip intake: paste 1 (with say) and a non-visit vent; never on harm", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dadWithNext(s.base);
    const p1 = await jsonReq(
      s.base, "POST", "/vault/intake", { dad_id, text: PASTE_1, make_notice: true }, { token },
    );
    // Slice 1 unchanged: same say; the fork rides alongside as the next beat.
    assert.equal(p1.data.say, "They cancelled your Friday visit. Matter to you?");
    assert.equal(p1.data.fork, FORK_LINE);
    assert.ok(!("next_action" in p1.data));

    const late = await jsonReq(
      s.base, "POST", "/vault/intake", { dad_id, text: readFixedVent(), make_notice: true }, { token },
    );
    assert.ok(!("say" in late.data));
    assert.equal(late.data.fork, FORK_LINE);

    const harm = await jsonReq(
      s.base, "POST", "/vault/intake", { dad_id, text: HARM, make_notice: true }, { token },
    );
    assert.equal(harm.data.written, 0);
    assert.ok(!("fork" in harm.data), "harm → real help only, no fork");

    // Plain intake shape (no make_notice) still {written, chase}.
    const plain = await jsonReq(s.base, "POST", "/vault/intake", { dad_id, text: PASTE_1 }, { token });
    assert.deepEqual(Object.keys(plain.data).sort(), ["chase", "written"]);
  } finally {
    await s.close();
  }
});

test("talk path and text path → same feedback, one claim row each, never verified", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dadWithNext(s.base);
    const talk = await jsonReq(
      s.base, "POST", "/vault/tell", { dad_id, channel: "talk", story: STORY }, { token },
    );
    const text = await jsonReq(
      s.base, "POST", "/vault/tell", { dad_id, channel: "text", story: STORY }, { token },
    );
    for (const r of [talk, text]) {
      assert.equal(r.status, 200);
      assert.equal(r.data.written, 1);
      assertFeedback(r.data.feedback);
      assert.ok(!r.data.feedback.includes(dad_id) && !r.data.feedback.includes(token));
    }
    assert.equal(talk.data.channel, "talk");
    assert.equal(text.data.channel, "text");
    assert.equal(talk.data.feedback, text.data.feedback, "same outcome either modality");
    assert.equal(talk.data.feedback, tellFeedback(NEXT));

    const events = await s.vault.listEvents(dad_id);
    const told = events.filter((e) => /^Told by /.test(e.notes ?? ""));
    assert.deepEqual(told.map((e) => e.notes).sort(), ["Told by talk", "Told by text"]);
    for (const e of told) {
      assert.equal(e.pipe, "claim");
      assert.doesNotMatch(e.raw_quote, /904-555-1212/, "PII stripped");
      assert.doesNotMatch(e.raw_quote, /on purpose/, "venom stripped");
      assert.match(e.raw_quote, /drove to the exchange at 6/, "observable facts kept");
    }
    const verified = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(verified.data, []);

    // Logs: ids/enums only.
    assert.doesNotMatch(logger.lines().join("\n"), /heard you|drove|904-555/);
  } finally {
    await s.close();
  }
});

test("tell rails: harm → nothing kept, feedback null; bad channel / empty story → 400", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dadWithNext(s.base);
    const harm = await jsonReq(
      s.base, "POST", "/vault/tell", { dad_id, channel: "talk", story: HARM }, { token },
    );
    assert.deepEqual(harm.data, { written: 0, channel: "talk", feedback: null });
    assert.equal((await s.vault.listEvents(dad_id)).length, 0);

    const bad = await jsonReq(
      s.base, "POST", "/vault/tell", { dad_id, channel: "email", story: STORY }, { token },
    );
    assert.equal(bad.status, 400);
    const empty = await jsonReq(
      s.base, "POST", "/vault/tell", { dad_id, channel: "text", story: "  " }, { token },
    );
    assert.equal(empty.status, 400);
    const noAuth = await jsonReq(s.base, "POST", "/vault/tell", { dad_id, channel: "text", story: STORY });
    assert.equal(noAuth.status, 401);
  } finally {
    await s.close();
  }
});

test("Slice 2 Coach draft + return loop unchanged (no fork on either)", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dadWithNext(s.base);
    const draft = await jsonReq(
      s.base, "POST", "/vault/comms/draft",
      { dad_id, body: "Please add the kids' dentist appointments to the shared calendar." },
      { token },
    );
    assert.equal(draft.data.say, "Not sent. Next: send it yourself — it puts your ask on the record.");
    assert.ok(!("fork" in draft.data));

    const ret = await jsonReq(s.base, "POST", "/vault/return", { dad_id }, { token });
    assert.equal(ret.data.line, `Last time: ${NEXT}. How'd it go?`);
    assert.ok(!("fork" in ret.data));
  } finally {
    await s.close();
  }
});

test("Chip templates + CHIP_APP document the fork and its stop rules", () => {
  const dadT = read("CHIP_DAD_TEMPLATE.md");
  assert.match(dadT, /Talk\/text fork/);
  assert.match(dadT, /Want to\s+tell me\? Talk or text\./);
  assert.match(dadT, /POST \{\{BASE\}\}\/vault\/tell/);
  assert.match(dadT, /never a soft grade in\s+its place/);
  assert.match(dadT, /Same feedback either way/);

  const app = read("CHIP_APP.md");
  assert.match(app, /POST \/vault\/tell/);
  assert.match(app, /never verified/);

  const pub = read("CHIP_PUBLIC_TEMPLATE.md");
  assert.match(pub, /Want to tell me\? Talk or text\./);
});
