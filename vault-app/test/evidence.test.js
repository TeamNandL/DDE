// Slice 23 — evidence capture skeleton (synthetic dads only).
// Hash log → stage logged, routing inbox_unmapped. Guess is filename/format
// at confidence low. Duplicate hash is the same row. Never verified, never
// a Quill intake, never a document, never file bytes.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer, PHASE1_ROUTES } from "../src/server.js";
import { splitSqlStatements } from "../src/schema.js";
import { guessDocType } from "../src/evidence.js";
import * as logger from "../src/logger.js";

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const UUID_FULL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
  return (await jsonReq(base, "POST", "/vault/provision", {})).data;
}

test("017_evidence.sql is a hash log: no content column, no promotion, RLS policy splits cleanly", () => {
  const sql = read("vault/017_evidence.sql");
  const stmts = splitSqlStatements(sql);
  const table = stmts.find((s) => /create table if not exists evidence/i.test(s));
  assert.ok(table, "create table survives statement split");
  assert.match(table, /schema_version/);
  assert.match(table, /unique \(dad_id, hash\)/);
  assert.match(table, /stage = 'logged'/);
  assert.match(table, /routing = 'inbox_unmapped'/);
  assert.match(table, /doc_type_confidence = 'low'/);
  assert.match(table, /needs_ocr = false/);
  assert.doesNotMatch(table, /\bbytes\b|storage_uri|page_range|text_stripped|raw_quote/i);
  assert.ok(stmts.some((s) => /enable row level security/i.test(s)));
  assert.ok(stmts.some((s) => /create policy dde_own_rows on evidence/i.test(s)));
  assert.ok(stmts.some((s) => /dde_current_dad\(\)/.test(s)));
  assert.doesNotMatch(sql, /alter view|insert into documents|alter table documents/i);
  const view = read("vault/001_schema.sql");
  assert.match(view, /create or replace view verified_export as/);
  assert.doesNotMatch(view, /\bevidence\b/);
});

test("guess is filename/format only and low confidence or nothing", () => {
  assert.deepEqual(guessDocType({ original_filename: "Chase_Statement_March.pdf", format: "pdf" }), {
    doc_type_guess: "statement",
    doc_type_confidence: "low",
  });
  assert.deepEqual(guessDocType({ original_filename: "1040-2024.pdf" }), {
    doc_type_guess: "tax_return",
    doc_type_confidence: "low",
  });
  assert.deepEqual(guessDocType({ original_filename: "screenshot-thread.png" }), {
    doc_type_guess: "screenshot",
    doc_type_confidence: "low",
  });
  assert.deepEqual(guessDocType({ original_filename: "motion-to-compel.pdf" }), {
    doc_type_guess: "court",
    doc_type_confidence: "low",
  });
  assert.deepEqual(guessDocType({ original_filename: "camp.jpg", format: "image/jpeg" }), {
    doc_type_guess: "photo",
    doc_type_confidence: "low",
  });
  assert.deepEqual(guessDocType({}), { doc_type_guess: null, doc_type_confidence: null });
  assert.deepEqual(guessDocType({ format: "pdf" }), { doc_type_guess: null, doc_type_confidence: null });
});

test("evidence log → stage=logged, routing=inbox_unmapped, schema_version set", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const hash = sha("synthetic-statement");
    logger.reset();
    const r = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id, hash, original_filename: "UNIQUEFILENAME-statement.pdf", format: "pdf", possession: "held" },
      { token },
    );
    assert.equal(r.status, 200);
    assert.equal(r.data.stage, "logged");
    assert.equal(r.data.routing, "inbox_unmapped");
    assert.equal(r.data.schema_version, 1);
    assert.equal(r.data.hash, hash);
    assert.equal(r.data.possession, "held");
    assert.equal(r.data.doc_type_guess, "statement");
    assert.equal(r.data.doc_type_confidence, "low");
    assert.equal(r.data.needs_ocr, false);
    assert.equal(r.data.verified, false);
    assert.equal(r.data.duplicate, false);
    assert.equal(r.data.original_filename, "UNIQUEFILENAME-statement.pdf");
    const lines = logger.lines().join("\n");
    assert.match(lines, /evidence\.log /);
    assert.doesNotMatch(lines, /UNIQUEFILENAME/);
    assert.doesNotMatch(lines, new RegExp(hash));
    assert.doesNotMatch(lines, UUID_FULL, "logs mask ids");

    const inbox = await jsonReq(s.base, "GET", `/vault/evidence/inbox?dad_id=${dad_id}`, null, { token });
    assert.equal(inbox.status, 200);
    assert.equal(inbox.data.routing, "inbox_unmapped");
    assert.equal(inbox.data.items.length, 1);
    assert.equal(inbox.data.items[0].id, r.data.id);
    assert.equal("duplicate" in inbox.data.items[0], false);
  } finally {
    await s.close();
  }
});

test("dup hash same dad → idempotent return (one row)", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const hash = sha("same-bytes");
    const post = (extra) =>
      jsonReq(s.base, "POST", "/vault/evidence/log", { dad_id, hash, ...extra }, { token });
    const first = await post({ original_filename: "first.pdf", format: "pdf", possession: "held" });
    const second = await post({ original_filename: "second.pdf", format: "pdf", possession: "not located" });
    assert.equal(second.status, 200);
    assert.equal(second.data.duplicate, true);
    assert.equal(second.data.id, first.data.id);
    assert.equal(second.data.original_filename, "first.pdf", "repeat does not rewrite the row");
    assert.equal(second.data.possession, "held");
    assert.equal(second.data.stage, "logged");
    assert.equal(second.data.routing, "inbox_unmapped");
    assert.equal(s.vault.evidence.filter((r) => r.dad_id === dad_id && r.hash === hash).length, 1);

    const third = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id, hash: sha("other-bytes") },
      { token },
    );
    assert.equal(third.data.duplicate, false);
    assert.notEqual(third.data.id, first.data.id);
    const inbox = await jsonReq(s.base, "GET", `/vault/evidence/inbox?dad_id=${dad_id}`, null, { token });
    assert.equal(inbox.data.items.length, 2);
  } finally {
    await s.close();
  }
});

test("cross-dad evidence log and inbox → 403; missing token 401; unknown route 404", async () => {
  const s = await start();
  try {
    const a = await dad(s.base);
    const b = await dad(s.base);
    const hash = sha("a-only");
    const logged = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id: a.dad_id, hash },
      { token: a.token },
    );
    assert.equal(logged.status, 200);

    const crossLog = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id: b.dad_id, hash },
      { token: a.token },
    );
    assert.equal(crossLog.status, 403);
    assert.deepEqual(crossLog.data, { error: "forbidden" });
    const crossInbox = await jsonReq(
      s.base,
      "GET",
      `/vault/evidence/inbox?dad_id=${b.dad_id}`,
      null,
      { token: a.token },
    );
    assert.equal(crossInbox.status, 403);

    assert.equal(
      (await jsonReq(s.base, "POST", "/vault/evidence/log", { dad_id: a.dad_id, hash })).status,
      401,
    );
    assert.equal(
      (await jsonReq(s.base, "GET", `/vault/evidence/inbox?dad_id=${a.dad_id}`, null, { token: "not-a-token" })).status,
      401,
    );
    assert.equal(
      (await jsonReq(s.base, "POST", "/vault/evidence/log", { dad_id: randomUUID(), hash }, { token: a.token })).status,
      401,
    );
    assert.equal((await jsonReq(s.base, "POST", "/vault/evidence/verify", { dad_id: a.dad_id }, { token: a.token })).status, 404);
    assert.equal((await jsonReq(s.base, "POST", "/vault/evidence/promote", { dad_id: a.dad_id }, { token: a.token })).status, 404);

    const own = await jsonReq(s.base, "GET", `/vault/evidence/inbox?dad_id=${a.dad_id}`, null, { token: a.token });
    assert.equal(own.data.items.length, 1);
    const bInbox = await jsonReq(s.base, "GET", `/vault/evidence/inbox?dad_id=${b.dad_id}`, null, { token: b.token });
    assert.deepEqual(bInbox.data.items, []);
    assert.equal(s.vault.evidence.filter((r) => r.dad_id === b.dad_id).length, 0, "403 wrote nothing");
  } finally {
    await s.close();
  }
});

test("verified_export stays empty for evidence rows; guess cannot promote", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const hash = sha("cannot-promote");
    const ok = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id, hash, original_filename: "order.pdf", format: "pdf" },
      { token },
    );
    assert.equal(ok.data.doc_type_confidence, "low");
    assert.equal(ok.data.verified, false);
    assert.notEqual(ok.data.stage, "verified");

    for (const extra of [
      { stage: "verified" },
      { routing: "exhibit" },
      { pipe: "verified" },
      { doc_type_confidence: "high" },
      { doc_type_guess: "court" },
      { needs_ocr: true },
      { bytes: "AAAA" },
      { text: "They cancelled my visit." },
      { storage_uri: "s3://bucket/obj" },
    ]) {
      const refused = await jsonReq(
        s.base,
        "POST",
        "/vault/evidence/log",
        { dad_id, hash: sha(JSON.stringify(extra)), ...extra },
        { token },
      );
      assert.equal(refused.status, 400, JSON.stringify(extra));
    }

    assert.throws(
      () =>
        s.vault.insertEvidence(dad_id, {
          hash: sha("direct"),
          schema_version: 1,
          stage: "verified",
          routing: "inbox_unmapped",
          possession: "held",
          doc_type_guess: "court",
          doc_type_confidence: "low",
          needs_ocr: false,
        }),
      /logged only/,
    );
    assert.throws(
      () =>
        s.vault.insertEvidence(dad_id, {
          hash: sha("direct-high"),
          schema_version: 1,
          stage: "logged",
          routing: "inbox_unmapped",
          possession: "held",
          doc_type_guess: "court",
          doc_type_confidence: "high",
          needs_ocr: false,
        }),
      /low only/,
    );

    const verified = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`, null, { token });
    assert.equal(verified.status, 200);
    assert.deepEqual(verified.data, []);
    const support = s.vault.affidavitSupport(dad_id);
    assert.equal(support.documents.length, 0);
    assert.equal(support.events.length, 0);
    assert.equal(s.vault.documents.filter((d) => d.dad_id === dad_id).length, 0);
    assert.ok(PHASE1_ROUTES.includes("POST /vault/evidence/log"));
    assert.ok(PHASE1_ROUTES.includes("GET /vault/evidence/inbox"));
    assert.ok(PHASE1_ROUTES.includes("POST /vault/intake"));
  } finally {
    await s.close();
  }
});

test("vent intake still works; evidence log creates no intake event or candidates", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const vent = "They cancelled my visit with the kids this Friday.";
    const intake = await jsonReq(s.base, "POST", "/vault/intake", { dad_id, text: vent }, { token });
    assert.equal(intake.status, 200);
    assert.ok(intake.data.written >= 1, "intake still writes");
    const events = (await s.vault.listEvents(dad_id)).length;
    const candidates = s.vault.candidate_facts.filter((c) => c.dad_id === dad_id).length;
    const docs = s.vault.documents.filter((d) => d.dad_id === dad_id).length;
    assert.ok(events >= 1);
    assert.ok(candidates >= 1, "the vent still becomes candidates");
    assert.equal(docs, 0);

    const logged = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id, hash: sha(vent), original_filename: "note.pdf", possession: "user says none" },
      { token },
    );
    assert.equal(logged.status, 200);
    assert.equal(logged.data.possession, "user says none");
    assert.equal(logged.data.doc_type_guess, null, "a bare note.pdf is not a typed guess");
    assert.doesNotMatch(JSON.stringify(logged.data), /cancelled my visit/);
    assert.equal((await s.vault.listEvents(dad_id)).length, events);
    assert.equal(s.vault.candidate_facts.filter((c) => c.dad_id === dad_id).length, candidates);
    assert.equal(s.vault.documents.filter((d) => d.dad_id === dad_id).length, docs);
    assert.equal(s.vault.evidence.length, 1);
    assert.equal(Object.hasOwn(s.vault.evidence[0], "bytes"), false);
    assert.equal(Object.hasOwn(s.vault.evidence[0], "raw_quote"), false);

    const again = await jsonReq(s.base, "POST", "/vault/intake", { dad_id, text: "Pickup was late on Saturday." }, { token });
    assert.equal(again.status, 200);
    assert.ok(again.data.written >= 1, "intake still works after a hash log");
    assert.equal(s.vault.evidence.length, 1, "intake does not write evidence");
  } finally {
    await s.close();
  }
});

test("possession menu and hash shape; empty inbox is 200", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const empty = await jsonReq(s.base, "GET", `/vault/evidence/inbox?dad_id=${dad_id}`, null, { token });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data, { routing: "inbox_unmapped", items: [] });
    const badHash = await jsonReq(s.base, "POST", "/vault/evidence/log", { dad_id, hash: "abc" }, { token });
    assert.equal(badHash.status, 400);
    const badPoss = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id, hash: sha("x"), possession: "gone" },
      { token },
    );
    assert.equal(badPoss.status, 400);
    const located = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id, hash: sha("y"), possession: "not located", format: "image/jpeg" },
      { token },
    );
    assert.equal(located.status, 200);
    assert.equal(located.data.possession, "not located");
    assert.equal(located.data.doc_type_guess, "photo");
    assert.equal(located.data.doc_type_confidence, "low");
  } finally {
    await s.close();
  }
});
