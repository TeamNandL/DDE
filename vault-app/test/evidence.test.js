// Slice 23 — evidence skeleton (synthetic dads only; never a real case).
// Hash-only log → stage logged, routing inbox_unmapped.
// Unique per dad_id+hash. Filename guess stays low-confidence.
// Vent ≠ evidence. Documents unchanged. No bytes.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer, PHASE1_ROUTES } from "../src/server.js";
import { filenameGuess, prepareEvidenceLog } from "../src/evidence.js";
import { readFixedVent } from "../src/demo.js";
import { jsonReq } from "./auth-cases.js";

const HASH = "ab".repeat(32);
const HASH_B = "cd".repeat(32);
const SQL = readFileSync(new URL("../../vault/017_evidence.sql", import.meta.url), "utf8");
const DOCUMENTS_SQL = readFileSync(new URL("../../vault/001_schema.sql", import.meta.url), "utf8");

async function start() {
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

async function dad(base) {
  const res = await jsonReq(base, "POST", "/vault/provision", {});
  assert.equal(res.status, 200);
  return res.data;
}

test("017_evidence.sql: hash log, unique dad+hash, RLS, no bytes, documents untouched", () => {
  assert.match(SQL, /create table if not exists evidence_log/);
  assert.match(SQL, /unique \(dad_id, sha256\)/);
  assert.match(SQL, /stage = 'logged'/);
  assert.match(SQL, /routing = 'inbox_unmapped'/);
  assert.match(SQL, /filename_confidence = 'low'/);
  assert.match(SQL, /enable row level security/);
  assert.match(SQL, /create policy dde_own_rows on evidence_log/);
  assert.match(SQL, /dde_current_dad\(\)/);
  assert.doesNotMatch(SQL, /bytea/i);
  assert.doesNotMatch(SQL, /alter table documents/i);
  assert.doesNotMatch(SQL, /insert into documents/i);
  assert.match(DOCUMENTS_SQL, /documents: bytes never in this table/);
  assert.ok(PHASE1_ROUTES.includes("POST /vault/evidence/log"));
  assert.ok(PHASE1_ROUTES.includes("GET /vault/evidence/inbox"));
});

test("filename guess is the basename at low confidence — never a document type", () => {
  assert.deepEqual(filenameGuess(null), { filename_guess: null, filename_confidence: null });
  assert.deepEqual(filenameGuess("C:\\fake\\scans\\IMG_2044.JPG"), {
    filename_guess: "IMG_2044.JPG",
    filename_confidence: "low",
  });
  assert.deepEqual(filenameGuess("../../not-a-real-user/note.pdf"), {
    filename_guess: "note.pdf",
    filename_confidence: "low",
  });
  assert.equal(prepareEvidenceLog({ sha256: HASH, filename: "IMG_2044.jpg" }).filename_confidence, "low");
  assert.throws(() => prepareEvidenceLog({ sha256: HASH, filename_confidence: "high" }), /filename confidence stays low/);
});

test("POST /vault/evidence/log stores a hash only; duplicate dad+hash is the same row; inbox is unmapped", async () => {
  const s = await start();
  try {
    const a = await dad(s.base);
    const b = await dad(s.base);
    const docsBefore = s.vault.documents.length;
    const eventsBefore = s.vault.events.length;

    const logged = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id: a.dad_id, sha256: HASH.toUpperCase(), filename: "folder/IMG_2044.jpg" },
      { token: a.token },
    );
    assert.equal(logged.status, 200);
    assert.equal(logged.data.created, true);
    assert.equal(logged.data.stage, "logged");
    assert.equal(logged.data.routing, "inbox_unmapped");
    assert.equal(logged.data.sha256, HASH);
    assert.equal(logged.data.filename_guess, "IMG_2044.jpg");
    assert.equal(logged.data.filename_confidence, "low");
    assert.equal(s.vault.documents.length, docsBefore, "documents unchanged");
    assert.equal(s.vault.events.length, eventsBefore, "not a vent / event");
    assert.equal(Object.hasOwn(logged.data, "bytes"), false);

    const again = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id: a.dad_id, hash: HASH, filename: "other-name.pdf" },
      { token: a.token },
    );
    assert.equal(again.status, 200);
    assert.equal(again.data.created, false);
    assert.equal(again.data.id, logged.data.id);
    assert.equal(again.data.filename_guess, "IMG_2044.jpg", "first guess sticks");
    assert.equal(s.vault.evidence_log.filter((r) => r.dad_id === a.dad_id).length, 1);

    const otherDad = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id: b.dad_id, sha256: HASH },
      { token: b.token },
    );
    assert.equal(otherDad.status, 200);
    assert.equal(otherDad.data.created, true);
    assert.notEqual(otherDad.data.id, logged.data.id);
    assert.equal(otherDad.data.filename_guess, null);
    assert.equal(otherDad.data.filename_confidence, null);

    const second = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id: a.dad_id, sha256: HASH_B },
      { token: a.token },
    );
    assert.equal(second.data.created, true);

    const inbox = await jsonReq(s.base, "GET", `/vault/evidence/inbox?dad_id=${a.dad_id}`, null, { token: a.token });
    assert.equal(inbox.status, 200);
    assert.equal(inbox.data.routing, "inbox_unmapped");
    assert.deepEqual(inbox.data.items.map((i) => i.sha256).sort(), [HASH, HASH_B].sort());
    assert.ok(inbox.data.items[0].created_at >= inbox.data.items[1].created_at, "newest first");
    assert.ok(inbox.data.items.every((i) => i.stage === "logged" && i.routing === "inbox_unmapped"));
    assert.ok(inbox.data.items.every((i) => !("bytes" in i)));

    const bInbox = await jsonReq(s.base, "GET", `/vault/evidence/inbox?dad_id=${b.dad_id}`, null, { token: b.token });
    assert.deepEqual(bInbox.data.items.map((i) => i.id), [otherDad.data.id]);

    const cross = await jsonReq(s.base, "GET", `/vault/evidence/inbox?dad_id=${b.dad_id}`, null, { token: a.token });
    assert.equal(cross.status, 403);
  } finally {
    await s.close();
  }
});

test("vent is not evidence: intake writes no hash row; the log refuses vent text and bytes", async () => {
  const s = await start();
  try {
    const a = await dad(s.base);
    const vent = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id: a.dad_id, text: readFixedVent() },
      { token: a.token },
    );
    assert.equal(vent.status, 200);
    assert.ok(s.vault.events.some((e) => e.dad_id === a.dad_id));
    assert.equal(s.vault.evidence_log.length, 0, "a vent does not become evidence");

    const asEvidence = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id: a.dad_id, sha256: HASH, text: "They cancelled Friday." },
      { token: a.token },
    );
    assert.equal(asEvidence.status, 400);
    assert.match(asEvidence.data.error, /vent is not evidence/);

    const bytes = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id: a.dad_id, sha256: HASH, bytes: "not-the-file" },
      { token: a.token },
    );
    assert.equal(bytes.status, 400);
    assert.match(bytes.data.error, /no bytes/);

    const weak = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id: a.dad_id, sha256: "ab".repeat(16) },
      { token: a.token },
    );
    assert.equal(weak.status, 400);

    const promoted = await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id: a.dad_id, sha256: HASH, stage: "verified", routing: "mapped" },
      { token: a.token },
    );
    assert.equal(promoted.status, 400);
    assert.equal(s.vault.evidence_log.length, 0);
    assert.equal(s.vault.documents.length, 0);

    const noTok = await jsonReq(s.base, "POST", "/vault/evidence/log", { dad_id: a.dad_id, sha256: HASH });
    assert.equal(noTok.status, 401);
  } finally {
    await s.close();
  }
});

test("export and wipe include the hash log and still leave documents as documents", async () => {
  const s = await start();
  try {
    const a = await dad(s.base);
    await jsonReq(
      s.base,
      "POST",
      "/vault/evidence/log",
      { dad_id: a.dad_id, sha256: HASH, filename: "IMG_2044.jpg" },
      { token: a.token },
    );
    const dumped = s.vault.exportAll(a.dad_id);
    assert.equal(dumped.evidence_log.length, 1);
    assert.equal(dumped.evidence_log[0].sha256, HASH);
    assert.equal(dumped.documents.length, 0);
    assert.equal(Object.hasOwn(dumped.evidence_log[0], "bytes"), false);
    const counts = s.vault.wipeDad(a.dad_id);
    assert.equal(counts.evidence_log, 1);
    assert.equal(s.vault.evidence_log.length, 0);
  } finally {
    await s.close();
  }
});
