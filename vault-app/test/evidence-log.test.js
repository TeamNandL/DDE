// Slice 23 — EVIDENCE CAPTURE SKELETON ONLY (hash-log → inbox_unmapped).
// Fake test dads only (fresh UUIDs from /vault/provision).
//
//   flow   — client hash → POST /vault/evidence/log → classify-guess (low)
//            → stage 'logged' · routing 'inbox_unmapped'. One row. No bytes.
//   rails  — vent ≠ evidence (/vault/intake untouched, never writes here);
//            documents table untouched; Exhibit / verified_export empty for
//            these rows; OCR never truth (needs_ocr is a client flag only,
//            no OCR worker, no OCR text); logs carry ids only — never the
//            filename, never the hash, never an unmasked dad_id or token.
//   defer  — storage_uri / bytes / evidence_requirement_link / page_range:
//            no such field anywhere in the response.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer, PHASE1_ROUTES } from "../src/server.js";
import { CLAIM_TABLES, PIPE_TABLES, splitBuckets } from "../src/dadexport.js";
import {
  CONFIDENCE,
  DUPLICATE_SAY,
  KINDS,
  LOGGED_SAY,
  ROUTING,
  SCHEMA_VERSION,
  STAGE,
  checkEvidenceLog,
  classifyGuess,
} from "../src/evidence.js";
import * as logger from "../src/logger.js";
import { jsonReq } from "./auth-cases.js";

const NOW = Date.parse("2026-09-28T23:30:00Z");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const UUID_FULL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DEFERRED = ["storage_uri", "bytes", "size_bytes", "evidence_requirement_link", "page_range", "ocr_text", "text"];

async function start() {
  logger.reset();
  const vault = new Vault();
  const bff = makeBff(vault, { now: NOW });
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  return { vault, bff, base: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(r)) };
}

const dad = async (base) => (await jsonReq(base, "POST", "/vault/provision", {})).data;
const logReq = (s, dad_id, token, body) =>
  jsonReq(s.base, "POST", "/vault/evidence/log", { dad_id, ...body }, { token });

test("routes: POST /vault/evidence/log listed; NO upload / storage / ocr / map route exists", () => {
  assert.ok(PHASE1_ROUTES.includes("POST /vault/evidence/log"));
  assert.ok(!PHASE1_ROUTES.some((r) => /upload|storage|ocr|blob|file|map|exhibit/i.test(r)), "skeleton only");
  assert.ok(PHASE1_ROUTES.includes("POST /vault/intake"), "Quill vent route untouched");
});

test("constants: stage / routing / confidence pinned; say lines carry no token, url, hash or id", () => {
  assert.equal(STAGE, "logged");
  assert.equal(ROUTING, "inbox_unmapped");
  assert.equal(CONFIDENCE, "low");
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(KINDS, ["statement", "tax_return", "photo", "screenshot", "court", "other"], "documents doc_type vocabulary — no new taxonomy");
  for (const line of [LOGGED_SAY, DUPLICATE_SAY]) {
    assert.doesNotMatch(line, /dde-stub|https?:|[0-9a-f]{32}|dad_id/i);
    assert.match(line, /not (filed|proof)|nothing new/i);
    assert.equal((line.match(/Next:/g) ?? []).length, 1, "exactly one Next");
  }
});

test("auth: no token 401; unknown dad 401 (F1); another dad's token 403; nothing written on refusal", async () => {
  const s = await start();
  try {
    const a = await dad(s.base);
    const b = await dad(s.base);
    const body = { sha256: sha("x") };
    assert.equal((await logReq(s, a.dad_id, "", body)).status, 401);
    assert.equal((await logReq(s, randomUUID(), a.token, body)).status, 401);
    assert.equal((await logReq(s, b.dad_id, a.token, body)).status, 403);
    assert.equal(s.vault.evidence.length, 0);
  } finally {
    await s.close();
  }
});

test("validation: sha256 must be 64 hex; filename string ≤255; mime type/subtype; needs_ocr boolean only", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const post = (b) => logReq(s, dad_id, token, b);
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ sha256: "abc" })).status, 400);
    assert.equal((await post({ sha256: "z".repeat(64) })).status, 400);
    assert.equal((await post({ sha256: sha("a"), filename: 42 })).status, 400);
    assert.equal((await post({ sha256: sha("a"), filename: "x".repeat(256) })).status, 400);
    assert.equal((await post({ sha256: sha("a"), mime: "not a mime" })).status, 400);
    assert.equal((await post({ sha256: sha("a"), needs_ocr: "true" })).status, 400, "never coerced from a string");
    assert.equal((await post({ sha256: sha("a"), needs_ocr: 1 })).status, 400);
    assert.equal(s.vault.evidence.length, 0, "a refused log writes nothing");
  } finally {
    await s.close();
  }
});

test("happy path: one row · kind guess low · stage logged · routing inbox_unmapped · needs_ocr absent → false · claim, never verified", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const hex = sha("statement-bytes");
    const r = await logReq(s, dad_id, token, {
      sha256: hex.toUpperCase(),
      filename: "Chase statement Aug 2026 acct 123456789012.pdf",
      mime: "application/PDF",
    });
    assert.equal(r.status, 200);
    const d = r.data;
    assert.equal(d.sha256, hex, "hash normalized to lowercase");
    assert.match(d.id, UUID_FULL);
    assert.equal(d.kind_guess, "statement");
    assert.equal(d.confidence, "low");
    assert.equal(d.stage, "logged");
    assert.equal(d.routing, "inbox_unmapped");
    assert.equal(d.needs_ocr, false, "flag only when the client sends it");
    assert.equal(d.schema_version, 1);
    assert.equal(d.mime, "application/pdf");
    assert.doesNotMatch(d.filename, /123456789012/, "filename is PII-stripped");
    assert.equal(d.claim, true);
    assert.equal(d.verified, false);
    assert.equal(d.duplicate, false);
    assert.equal(d.say, LOGGED_SAY);
    for (const k of DEFERRED) assert.ok(!(k in d), `${k} is deferred — not on the wire`);
    assert.ok(!("dad_id" in d), "dad_id never echoed in the body");

    const row = s.vault.evidence[0];
    assert.equal(s.vault.evidence.length, 1);
    assert.equal(row.claim_status, "claim");
    assert.doesNotMatch(row.filename, /123456789012/);
    for (const k of DEFERRED) assert.ok(!(k in row), `${k} not stored`);

    const ocr = await logReq(s, dad_id, token, { sha256: sha("scan"), filename: "scan_001.jpg", mime: "image/jpeg", needs_ocr: true });
    assert.equal(ocr.data.needs_ocr, true);
    assert.equal(ocr.data.kind_guess, "photo");
    assert.equal(ocr.data.stage, "logged", "needs_ocr changes nothing else — no OCR worker, OCR never truth");
  } finally {
    await s.close();
  }
});

test("duplicate: same hash for one dad → existing row, duplicate: true, no second write; other dad may log the same hash", async () => {
  const s = await start();
  try {
    const a = await dad(s.base);
    const b = await dad(s.base);
    const hex = sha("same-file");
    const first = await logReq(s, a.dad_id, a.token, { sha256: hex, filename: "one.pdf" });
    const again = await logReq(s, a.dad_id, a.token, { sha256: hex.toUpperCase(), filename: "renamed.pdf" });
    assert.equal(again.status, 200);
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.id, first.data.id);
    assert.equal(again.data.filename, "one.pdf", "the first log wins; a rename does not rewrite the row");
    assert.equal(again.data.say, DUPLICATE_SAY);
    assert.equal(s.vault.listEvidence(a.dad_id).length, 1);

    const other = await logReq(s, b.dad_id, b.token, { sha256: hex });
    assert.equal(other.status, 200);
    assert.equal(other.data.duplicate, false, "uniqueness is per dad");
    assert.equal(s.vault.evidence.length, 2);
  } finally {
    await s.close();
  }
});

test("duplicate race: a second write that slips past the pre-check lands on the unique index → same row, duplicate: true, never 500", async () => {
  const s = await start();
  try {
    const { dad_id } = await dad(s.base);
    const hex = sha("race");
    const first = await s.bff.postEvidenceLog({ dad_id, sha256: hex, filename: "a.pdf" });
    // Simulate the race: the pre-check misses once, the vault insert refuses.
    const orig = s.vault.findEvidenceByHash.bind(s.vault);
    let missOnce = true;
    s.vault.findEvidenceByHash = (d, h) => (missOnce ? ((missOnce = false), null) : orig(d, h));
    const second = await s.bff.postEvidenceLog({ dad_id, sha256: hex, filename: "b.pdf" });
    assert.equal(second.duplicate, true);
    assert.equal(second.id, first.id);
    assert.equal(s.vault.evidence.length, 1);
  } finally {
    await s.close();
  }
});

test("classify-guess: filename/mime heuristic, always low, only the documents vocabulary", () => {
  const g = (filename, mime) => classifyGuess({ filename, mime });
  assert.deepEqual(g("2025 Form 1040.pdf", "application/pdf"), { kind_guess: "tax_return", confidence: "low" });
  assert.deepEqual(g("W2_2025.pdf").kind_guess, "tax_return");
  assert.deepEqual(g("Motion to Modify.pdf").kind_guess, "court");
  assert.deepEqual(g("bank statement july.pdf").kind_guess, "statement");
  assert.deepEqual(g("Screenshot 2026-09-01 at 9.12.pm.png", "image/png").kind_guess, "screenshot");
  assert.deepEqual(g("IMG_2041.HEIC", "image/heic").kind_guess, "photo");
  assert.deepEqual(g("IMG_1099.jpg", "image/jpeg").kind_guess, "photo", "camera roll name is never a tax form");
  assert.deepEqual(g("DSC_1040.JPG").kind_guess, "photo");
  assert.deepEqual(g("notes.txt", "text/plain").kind_guess, "other");
  assert.deepEqual(g(undefined, undefined).kind_guess, "other");
  for (const f of ["1040.pdf", "order.pdf", "x.png", ""]) {
    const out = g(f, "image/png");
    assert.equal(out.confidence, "low");
    assert.ok(KINDS.includes(out.kind_guess));
  }
});

test("checkEvidenceLog: normalizes; strips PII from filename; needs_ocr defaults false", () => {
  const c = checkEvidenceLog({ sha256: ` ${sha("q").toUpperCase()} `, filename: " SSN 123-45-6789 scan.pdf ", mime: " Application/PDF " });
  assert.equal(c.sha256, sha("q"));
  assert.doesNotMatch(c.filename, /123-45-6789/);
  assert.equal(c.mime, "application/pdf");
  assert.equal(c.needs_ocr, false);
  assert.throws(() => checkEvidenceLog({ sha256: sha("q"), needs_ocr: "yes" }), (e) => e.status === 400);
  assert.throws(() => checkEvidenceLog({}), (e) => e.status === 400);
});

test("vent ≠ evidence: /vault/intake writes events, never evidence; evidence log writes no event, no document; Exhibit stays empty", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const vent = await jsonReq(s.base, "POST", "/vault/intake", { dad_id, text: "They cancelled my Friday visit again. I have the screenshot, sha256 deadbeef." }, { token });
    assert.equal(vent.status, 200);
    assert.ok(vent.data.written >= 1, "Quill still writes claim events");
    assert.equal(s.vault.evidence.length, 0, "vent text never becomes an evidence row");

    const eventsBefore = (await s.vault.listEvents(dad_id)).length;
    const docsBefore = s.vault.documents.length;
    const r = await logReq(s, dad_id, token, { sha256: sha("shot"), filename: "screenshot.png", mime: "image/png" });
    assert.equal(r.status, 200);
    assert.equal((await s.vault.listEvents(dad_id)).length, eventsBefore, "no intake event from a hash log");
    assert.equal(s.vault.documents.length, docsBefore, "documents table untouched");
    assert.equal(s.vault.communications.filter((c) => c.dad_id === dad_id).length, 0, "no OFW / send row");

    const verified = await jsonReq(s.base, "GET", `/vault/export/verified?dad_id=${dad_id}`, null, { token });
    assert.equal(verified.status, 200);
    assert.deepEqual(verified.data, [], "verified_export empty — Exhibit = verified-only");
    assert.deepEqual(s.vault.affidavitSupport(dad_id), { documents: [], events: [] });

    // Dad export (Slice 21): evidence rides in claims/, never verified/.
    const { claims, verified: vb } = splitBuckets(s.vault.exportAll(dad_id));
    assert.ok(CLAIM_TABLES.includes("evidence"));
    assert.ok(!PIPE_TABLES.includes("evidence"), "evidence has no pipe column — it can never be verified");
    assert.equal(claims.evidence.length, 1);
    assert.equal(vb.evidence, undefined);
  } finally {
    await s.close();
  }
});

test("log hygiene: no filename, no hash, no unmasked dad_id, no token in any log line", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await dad(s.base);
    const hex = sha("hygiene");
    await logReq(s, dad_id, token, { sha256: hex, filename: "Sam pediatric bill Taylor.pdf", mime: "application/pdf" });
    await logReq(s, dad_id, token, { sha256: hex });
    const lines = logger.lines().filter((l) => /evidence/.test(l));
    assert.ok(lines.length >= 3, "http + vault + bff lines");
    const all = logger.lines().join("\n");
    assert.doesNotMatch(all, /pediatric|Sam|Taylor|\.pdf/i, "never the filename");
    assert.doesNotMatch(all, new RegExp(hex.slice(0, 12)), "never the hash");
    assert.doesNotMatch(all, UUID_FULL, "dad_id / ids masked to last 4");
    assert.doesNotMatch(all, /dde-stub-[a-z0-9]/i, "never a token");
    assert.ok(lines.some((l) => /evidence\.duplicate/.test(l)));
  } finally {
    await s.close();
  }
});
