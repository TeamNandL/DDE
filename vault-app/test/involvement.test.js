// Slice 16 — Involvement Cheat Sheet (synthetic Alex only).
// Living one-pager per kid · finite fields · claim ≠ verified · asked-for
// blanks → behavior pattern, never motive · ONE Missing + ONE Next ·
// export with claim footer · no SSNs / money · not OFW / Plan / Translator
// / Coach / Quill.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import {
  CLAIM_FOOTER,
  FIELDS,
  FIELD_KEYS,
  missingNext,
  patternLine,
  renderOnePager,
} from "../src/involvement.js";
import * as logger from "../src/logger.js";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const NOW = Date.parse("2026-09-27T12:00:00Z");
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b/;
const MOTIVE_RE = /on purpose|spite|alienat|narcissis|manipulat|punish|vindictive|deliberate|intentional|trying to|wants to|because (she|he|they)|hiding|withhold/i;

async function start() {
  logger.reset();
  const vault = new Vault();
  const bff = makeBff(vault, { now: NOW });
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

test("fields: finite ten, each with a direct source to ask; emergency contact is yes|no only", () => {
  assert.deepEqual(new Set(FIELD_KEYS), new Set([
    "teacher", "grade", "doctor", "dentist", "therapist", "meds", "allergies", "friends", "activities",
    "emergency_contact_known",
  ]));
  assert.equal(FIELDS.length, 10);
  for (const f of FIELDS) assert.ok(f.label && f.source && f.find, f.key);
  assert.deepEqual(FIELDS.find((f) => f.key === "emergency_contact_known").options, ["yes", "no"]);
  assert.doesNotMatch(JSON.stringify(FIELDS) + CLAIM_FOOTER, MOTIVE_RE);
  assert.match(CLAIM_FOOTER, /Claim, not verified/);
});

test("ensure is idempotent per kid; speaks ONE Missing + ONE Next, never the whole sheet", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const first = await jsonReq(s.base, "POST", "/vault/involvement/ensure", { dad_id, kid: "sam" }, { token });
    assert.equal(first.status, 200);
    assert.equal(first.data.created, 10);
    assert.deepEqual(first.data.counts, { filled: 0, asked: 0, blank: 10 });
    assert.equal((await jsonReq(s.base, "POST", "/vault/involvement/ensure", { dad_id, kid: "sam" }, { token })).data.created, 0);

    const next = await jsonReq(s.base, "GET", `/vault/involvement/next?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(Object.keys(next.data).sort(), ["claim_footer", "left", "missing", "next"]);
    assert.equal(next.data.missing.field, "grade", "easiest first");
    assert.equal(typeof next.data.next.line, "string", "exactly one next line");
    assert.equal(next.data.next.job, "re_engagement");
    assert.match(next.data.next.line, /Ask the school office directly/);
    assert.ok(!Array.isArray(next.data.missing) && !Array.isArray(next.data.next));

    // Kid label must be a short slug, not a full name.
    assert.equal((await jsonReq(s.base, "POST", "/vault/involvement/ensure", { dad_id, kid: "Sam Rivera" }, { token })).status, 400);
  } finally {
    await s.close();
  }
});

test("upsert: values are dad-entered claims; PII stripped; no money; yes|no enforced; bad input 400", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const put = (b) => jsonReq(s.base, "POST", "/vault/involvement/field", { dad_id, kid: "sam", ...b }, { token });

    const t = await put({ field: "teacher", value: "Ms. Lopez, room 12. Her cell (904) 555-0142, SSN 123-45-6789" });
    assert.equal(t.status, 200);
    assert.equal(t.data.field.status, "filled");
    assert.equal(t.data.field.claim, true);
    assert.equal(t.data.field.verified, false);
    assert.doesNotMatch(t.data.field.value, SSN_RE);
    assert.doesNotMatch(t.data.field.value, /555-0142/);
    assert.match(t.data.field.value, /Ms\. Lopez/);
    assert.equal(s.vault.involvement_fields.find((r) => r.field_key === "teacher").source, "dad_entered");

    assert.equal((await put({ field: "activities", value: "Soccer, $120 a month" })).status, 400, "no money");
    assert.equal((await put({ field: "emergency_contact_known", value: "maybe" })).status, 400);
    assert.equal((await put({ field: "shoe_size", value: "4" })).status, 400, "finite fields only");
    assert.equal((await put({ field: "grade" })).status, 400, "value or ask required");
    assert.equal((await put({ field: "grade", value: "3rd", asked_on: "2026-09-01" })).status, 400, "not both");
    assert.equal((await put({ field: "grade", value: "x".repeat(201) })).status, 400);
    assert.equal((await put({ field: "grade", asked_on: "09/01/2026", asked_via: "school", outcome: "no_answer" })).status, 400);
    assert.equal((await put({ field: "grade", asked_on: "2026-09-01", asked_via: "carrier_pigeon", outcome: "no_answer" })).status, 400);

    // "no" on emergency contact is still a blank — he isn't on file.
    const ec = await put({ field: "emergency_contact_known", value: "No" });
    assert.equal(ec.data.field.value, "no");
    assert.equal(ec.data.field.status, "blank");
  } finally {
    await s.close();
  }
});

test("asked-for blanks → documentable pattern (behavior only, never motive); Next logs then goes direct", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const put = (b) => jsonReq(s.base, "POST", "/vault/involvement/field", { dad_id, kid: "sam", ...b }, { token });
    for (const f of FIELD_KEYS) {
      if (!["doctor", "dentist"].includes(f)) await put({ field: f, value: f === "emergency_contact_known" ? "yes" : "none" });
    }
    const d = await put({ field: "doctor", asked_on: "2026-09-10", asked_via: "co_parent", outcome: "no_answer" });
    assert.equal(d.data.field.status, "asked");
    const r = await put({ field: "dentist", asked_on: "2026-09-12", asked_via: "co_parent", outcome: "declined" });

    // Next: the asked blank, logged as behavior, then ask the source directly.
    assert.equal(r.data.speak.missing.field, "doctor");
    assert.equal(r.data.speak.next.job, "gatekeeping_log");
    assert.equal(
      r.data.speak.next.line,
      "Logged: Doctor: asked the other parent on 2026-09-10; no answer as of 2026-09-27. Next, ask your insurance card or the pediatrician's office directly.",
    );
    assert.equal(r.data.speak.left, 2);

    const exp = await jsonReq(s.base, "GET", `/vault/involvement/export?dad_id=${dad_id}&kid=sam`, null, { token });
    assert.equal(exp.status, 200);
    const body = exp.data.body;
    assert.match(body, /^INVOLVEMENT CHEAT SHEET — sam\nAs of 2026-09-27\. Know these cold\./);
    assert.match(body, /Documentable pattern \(behavior only\):\n- Doctor: asked the other parent on 2026-09-10; no answer as of 2026-09-27\.\n- Dentist: asked the other parent on 2026-09-12; request declined\./);
    assert.match(body, /2 of 10 basics asked for and not received\./);
    assert.ok(body.endsWith(CLAIM_FOOTER), "claim footer on every export");
    assert.equal(exp.data.verified, false);
    assert.doesNotMatch(body + JSON.stringify(r.data), MOTIVE_RE, "never motive");

    // Filling it later closes the pattern line.
    const fill = await put({ field: "doctor", value: "Dr. Chen, Riverside Pediatrics" });
    assert.equal(fill.data.field.status, "filled");
    assert.equal(fill.data.speak.missing.field, "dentist");
  } finally {
    await s.close();
  }
});

test("full sheet → deposition armor Next; multi-kid Next picks the kid with something left", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const put = (kid, b) => jsonReq(s.base, "POST", "/vault/involvement/field", { dad_id, kid, ...b }, { token });
    for (const f of FIELD_KEYS) await put("ava", { field: f, value: f === "emergency_contact_known" ? "yes" : "none" });
    await jsonReq(s.base, "POST", "/vault/involvement/ensure", { dad_id, kid: "sam" }, { token });

    const ava = await jsonReq(s.base, "GET", `/vault/involvement/next?dad_id=${dad_id}&kid=ava`, null, { token });
    assert.equal(ava.data.missing, null);
    assert.equal(ava.data.next.job, "deposition_armor");
    assert.match(ava.data.next.line, /know it cold/);

    const any = await jsonReq(s.base, "GET", `/vault/involvement/next?dad_id=${dad_id}`, null, { token });
    assert.equal(any.data.missing.kid, "sam");

    const list = await jsonReq(s.base, "GET", `/vault/involvement?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(list.data.kids.map((k) => k.kid), ["ava", "sam"]);
    assert.deepEqual(list.data.kids[0].counts, { filled: 10, asked: 0, blank: 0 });
    assert.equal(list.data.speak.missing.kid, "sam", "list still speaks only one Missing + one Next");

    assert.equal((await jsonReq(s.base, "GET", `/vault/involvement/export?dad_id=${dad_id}&kid=zed`, null, { token })).status, 404);
  } finally {
    await s.close();
  }
});

test("anti-jobs: no OFW / Coach, no intake, no plan, no translator, no court-prep; logs ids + keys only", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const put = (b) => jsonReq(s.base, "POST", "/vault/involvement/field", { dad_id, kid: "sam", ...b }, { token });
    await put({ field: "teacher", value: "Ms. Lopez" });
    await put({ field: "doctor", asked_on: "2026-09-10", asked_via: "co_parent", outcome: "no_answer" });
    await jsonReq(s.base, "GET", `/vault/involvement/export?dad_id=${dad_id}&kid=sam`, null, { token });

    assert.equal(s.vault.communications.length, 0, "not Stan/OFW, not Coach");
    assert.equal((await s.vault.listEvents(dad_id)).length, 0, "not Quill");
    assert.equal(s.vault.plan_topics.length + s.vault.plan_drafts.length, 0, "not Parenting Plan");
    assert.equal(s.vault.translations.length, 0, "not Process Translator");
    assert.equal(s.vault.candidate_facts.length + s.vault.notifications.length, 0);
    const verified = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(verified.data, [], "claims never become verified rows");

    assert.doesNotMatch(logger.lines().join("\n"), /Lopez|sam\b|INVOLVEMENT CHEAT/i, "logs: ids + field keys only");

    for (const method of ["PUT", "PATCH", "DELETE"]) {
      assert.equal((await jsonReq(s.base, method, "/vault/involvement", { dad_id }, { token })).status, 404);
    }
  } finally {
    await s.close();
  }
});

test("tenancy: 401 without token, 403 with another dad's token", async () => {
  const s = await start();
  try {
    const a = await dad(s.base);
    const b = await dad(s.base);
    assert.equal((await jsonReq(s.base, "GET", `/vault/involvement/next?dad_id=${a.dad_id}`)).status, 401);
    assert.equal(
      (await jsonReq(s.base, "POST", "/vault/involvement/field", { dad_id: b.dad_id, kid: "sam", field: "grade", value: "3rd" }, { token: a.token })).status,
      403,
    );
    assert.equal((await jsonReq(s.base, "GET", `/vault/involvement/export?dad_id=${b.dad_id}&kid=sam`, null, { token: a.token })).status, 403);
    assert.equal((await jsonReq(s.base, "POST", "/vault/involvement/ensure", { dad_id: b.dad_id, kid: "sam" }, { token: a.token })).status, 403);
  } finally {
    await s.close();
  }
});

test("pure helpers: pattern + one-pager deterministic; kid cap", async () => {
  const rows = FIELD_KEYS.map((k, i) => ({ field_key: k, kid_key: "sam", position: i + 1, value: null }));
  rows[4] = { ...rows[4], asked_on: "2026-09-01", asked_via: "school", outcome: "no_answer" };
  assert.equal(renderOnePager("sam", rows, "2026-09-27"), renderOnePager("sam", rows, "2026-09-27"));
  assert.equal(patternLine(rows[4], "2026-09-27"), `${FIELDS[4].label}: asked the school on 2026-09-01; no answer as of 2026-09-27.`);
  assert.equal(missingNext(rows, "2026-09-27").missing.status, "blank", "never-asked blanks come first");

  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    for (const k of ["k1", "k2", "k3", "k4", "k5", "k6"]) {
      assert.equal((await jsonReq(s.base, "POST", "/vault/involvement/ensure", { dad_id, kid: k }, { token })).status, 200);
    }
    assert.equal((await jsonReq(s.base, "POST", "/vault/involvement/ensure", { dad_id, kid: "k7" }, { token })).status, 400);
  } finally {
    await s.close();
  }
});

test("CHIP_APP §13 pointer + dad template: one Missing + one Next, behavior not why", () => {
  const app = read("CHIP_APP.md");
  assert.match(app, /### 13\) Involvement Cheat Sheet — Slice 16 \(pointer\)/);
  assert.match(app, /Say ONE Missing \+ ONE Next — never the whole\s+sheet/);
  for (const k of FIELD_KEYS) assert.ok(app.includes(`\`${k}\``), `pointer missing ${k}`);
  const dadT = read("CHIP_DAD_TEMPLATE.md");
  assert.match(dadT, /## Involvement Cheat Sheet \(Slice 16\)/);
  assert.match(dadT, /Say what happened, never why/);
});
