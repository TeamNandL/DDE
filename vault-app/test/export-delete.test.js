// Slice 21 — DAD EXPORT + DELETE ONLY (memory store). Fake family UUIDs only.
//
//   export  — dad-facing GET /vault/export → zip; claims and verified in
//             SEPARATE buckets; a claim never lands in verified/; tokens
//             masked last-4; no SSNs; server records a receipt.
//   delete  — Nick CLI only. No HTTP route. Soft first (tokens revoked, data
//             intact, cancelable); hard wipe after 14 days via purge.
//   rail    — soft-delete refused without a FRESH export receipt.
//   after   — old token replay: 401 in the soft window AND once wiped, same
//             body as a never-existed dad (Nick F1 ruling — nothing leaks).

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer, PHASE1_ROUTES } from "../src/server.js";
import { createMemoryTokenStore, hashToken } from "../src/tokens.js";
import { createMemoryOpsStore, openOpsStore } from "../src/opsstore.js";
import { unzipStore, zipStore } from "../src/zip.js";
import { CLAIM_TABLES, sanitizeDeep, splitBuckets } from "../src/dadexport.js";
import { runDadCli } from "../src/cli-dad.js";
import * as logger from "../src/logger.js";
import { jsonReq } from "./auth-cases.js";

const T0 = Date.parse("2026-09-27T16:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const UUID_FULL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function start({ now = T0, vault = new Vault(), tokenStore = createMemoryTokenStore(), opsStore = createMemoryOpsStore() } = {}) {
  const bff = makeBff(vault, { tokenStore, opsStore, now });
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  return { bff, vault, tokenStore, opsStore, base: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Provision a fake dad and give him one claim + one verified row + a working record. */
async function seedDad(s) {
  const a = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
  await jsonReq(s.base, "POST", "/vault/intake", { dad_id: a.dad_id, text: "They cancelled my Friday visit. My SSN is 123-45-6789 and my link was dde-stub-abcd1234-leak." }, { token: a.token });
  await jsonReq(s.base, "POST", "/vault/comms/pull", { dad_id: a.dad_id, channel: "ofw", source_ref: "ofw:alex:1", body_cold: "Pickup confirmed for Friday.", sent_at: "2026-09-20T17:00:00Z" }, { token: a.token });
  await jsonReq(s.base, "POST", "/vault/plan/topics/ensure", { dad_id: a.dad_id }, { token: a.token });
  return a;
}

const state = (base, dad_id, token) => jsonReq(base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });

async function fetchZip(base, dad_id, token) {
  const res = await fetch(`${base}/vault/export?dad_id=${dad_id}`, { headers: { authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), buf };
}

test("routes: GET /vault/export listed; NO delete / purge / wipe route of any kind", () => {
  assert.ok(PHASE1_ROUTES.includes("GET /vault/export"));
  assert.ok(!PHASE1_ROUTES.some((r) => /delete|purge|wipe|erase|forget/i.test(r)), "delete protects the dad from himself");
});

test("Cross-dad export → 403; no token 401; unknown dad 401 (F1)", async () => {
  const s = await start();
  try {
    const a = await seedDad(s);
    const b = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    assert.equal((await fetchZip(s.base, b.dad_id, a.token)).status, 403);
    assert.equal((await fetchZip(s.base, a.dad_id, "")).status, 401);
    assert.equal((await fetchZip(s.base, randomUUID(), a.token)).status, 401);
    assert.equal(await s.opsStore.latestReceipt(b.dad_id), null, "a refused export leaves no receipt");
  } finally {
    await s.close();
  }
});

test("Export: zip layout; claims vs verified in SEPARATE buckets; claim never packaged as verified; tokens last-4; no SSN; receipt recorded", async () => {
  const s = await start();
  try {
    const a = await seedDad(s);
    logger.reset();
    const r = await fetchZip(s.base, a.dad_id, a.token);
    assert.equal(r.status, 200);
    assert.equal(r.type, "application/zip");
    assert.match(r.disposition, /attachment; filename="dde-export-2026-09-27\.zip"/);

    const files = unzipStore(r.buf);
    assert.deepEqual(files.map((f) => f.name), ["README.txt", "claims/claims.json", "claims/claims.txt", "verified/verified.json", "verified/verified.txt"]);
    const claims = JSON.parse(files[1].data.toString());
    const verified = JSON.parse(files[3].data.toString());
    assert.deepEqual(Object.keys(claims).sort(), [...CLAIM_TABLES].sort(), "every dad table appears in claims/");
    assert.deepEqual(Object.keys(verified).sort(), ["communications", "documents", "events", "month_summary"], "only pipe tables can be verified");

    assert.equal(claims.events.length, 1, "the vent is a claim");
    assert.equal(claims.events[0].pipe, "claim");
    assert.equal(claims.state.length, 1);
    assert.ok(claims.plan_topics.length > 0, "working records ride in claims/");
    assert.equal(verified.events.length, 0, "a claim is NEVER in verified/");
    assert.equal(verified.communications.length, 1, "the OFW pull is verified");
    assert.equal(verified.communications[0].pipe, "verified");
    for (const t of Object.keys(verified)) for (const row of verified[t]) assert.equal(row.pipe, "verified");
    for (const t of Object.keys(claims)) for (const row of claims[t]) assert.notEqual(row.pipe, "verified");

    const all = r.buf.toString("utf8");
    assert.doesNotMatch(all, /123-45-6789/, "no SSN");
    assert.doesNotMatch(all, /dde-stub-/, "no raw token");
    assert.match(all, /…leak/, "token masked to last 4");
    assert.match(all, new RegExp(a.dad_id), "his own dad_id stays (it is his)");
    assert.match(files[0].data.toString(), /A claim is never placed in verified/);

    const receipt = await s.opsStore.latestReceipt(a.dad_id);
    assert.ok(receipt, "receipt recorded");
    assert.equal(receipt.actor, "dad");
    assert.equal(receipt.bytes, r.buf.length);
    assert.equal(receipt.created_at, new Date(T0).toISOString());
    assert.match(receipt.sha256, /^[0-9a-f]{64}$/);
    assert.ok(logger.lines().some((l) => l.startsWith("export.receipt ") && l.includes("actor=dad")));
    assert.doesNotMatch(logger.lines().join("\n"), UUID_FULL, "logs mask ids");
  } finally {
    await s.close();
  }
});

test("export helpers: sanitizeDeep strips PII + masks tokens, keeps ids/dates; splitBuckets never promotes a claim", () => {
  const out = sanitizeDeep({ id: "0f8fad5b-d9cb-469f-a165-70867728950e", at: "2026-09-27T16:00:00.000Z", note: "call 904-555-1212, ssn 123-45-6789, tok dde-stub-zzzz9999", n: 3, nested: [{ t: "dde-stub-x1" }] });
  assert.equal(out.id, "0f8fad5b-d9cb-469f-a165-70867728950e");
  assert.equal(out.at, "2026-09-27T16:00:00.000Z");
  assert.equal(out.note, "call [phone], ssn [tax-id], tok …9999");
  assert.equal(out.nested[0].t, "…b-x1");
  const { claims, verified } = splitBuckets({ events: [{ pipe: "claim" }, { pipe: "verified" }], plan_topics: [{ pipe: "verified" }] });
  assert.equal(claims.events.length, 1);
  assert.equal(verified.events.length, 1);
  assert.equal(claims.plan_topics.length, 1, "non-pipe tables are always claims, whatever a row says");
  assert.equal(verified.plan_topics, undefined);
  const z = zipStore([{ name: "a.txt", data: "hi" }], { now: T0 });
  assert.deepEqual(unzipStore(z).map((f) => [f.name, f.data.toString()]), [["a.txt", "hi"]]);
});

test("Delete with no export receipt → refused (412); stale receipt (> 7d) → refused; nothing changes", async () => {
  const s = await start();
  try {
    const a = await seedDad(s);
    await assert.rejects(() => s.bff.requestDelete({ dad_id: a.dad_id, now: T0 }), (e) => e.status === 412 && /export receipt required/.test(e.message));
    assert.equal((await state(s.base, a.dad_id, a.token)).status, 200, "still logged in");
    assert.equal(await s.opsStore.getDeletion(a.dad_id), null);

    await fetchZip(s.base, a.dad_id, a.token); // receipt at T0
    const later = makeBff(s.vault, { tokenStore: s.tokenStore, opsStore: s.opsStore, now: T0 + 8 * DAY });
    await assert.rejects(() => later.requestDelete({ dad_id: a.dad_id }), (e) => e.status === 412, "8-day-old receipt is not fresh");
    assert.equal((await state(s.base, a.dad_id, a.token)).status, 200);
  } finally {
    await s.close();
  }
});

test("Delete after export receipt → allowed (soft): every token 401, data intact, purge_at = +14d, cancelable, mint refused meanwhile", async () => {
  const s = await start();
  try {
    const a = await seedDad(s);
    const t2 = (await s.bff.mintToken({ dad_id: a.dad_id })).token;
    await fetchZip(s.base, a.dad_id, a.token);

    const d = await s.bff.requestDelete({ dad_id: a.dad_id, now: T0 + DAY });
    assert.equal(d.revoked, 2);
    assert.equal(d.purge_at, new Date(T0 + 15 * DAY).toISOString());
    for (const t of [a.token, t2]) {
      const r = await state(s.base, a.dad_id, t);
      assert.deepEqual([r.status, r.data], [401, { error: "unauthorized" }], "soft window: token dead, dad still exists");
    }
    assert.ok(await s.vault.getState(a.dad_id), "data intact");
    assert.equal(s.vault.events.filter((e) => e.dad_id === a.dad_id).length, 1);
    await assert.rejects(() => s.bff.mintToken({ dad_id: a.dad_id }), (e) => e.status === 409 && /deletion pending/.test(e.message));
    await assert.rejects(() => s.bff.requestDelete({ dad_id: a.dad_id, now: T0 + DAY }), (e) => e.status === 409, "no double-request");

    // Purge before the window closes does nothing.
    assert.deepEqual(await s.bff.purgeDue({ now: T0 + 14 * DAY }), { purged: [], due: 0 });
    assert.ok(await s.vault.getState(a.dad_id));

    // Cancel inside the window: data untouched, purge never fires, reissue works.
    const c = await s.bff.cancelDelete({ dad_id: a.dad_id, now: T0 + 3 * DAY });
    assert.equal(c.cancelled_at, new Date(T0 + 3 * DAY).toISOString());
    assert.deepEqual(await s.bff.purgeDue({ now: T0 + 40 * DAY }), { purged: [], due: 0 });
    assert.ok(await s.vault.getState(a.dad_id), "cancelled → still here");
    await assert.rejects(() => s.bff.cancelDelete({ dad_id: a.dad_id }), (e) => e.status === 404);
    const fresh = await s.bff.reissueToken({ dad_id: a.dad_id });
    assert.equal((await state(s.base, a.dad_id, fresh.token)).status, 200);
  } finally {
    await s.close();
  }
});

test("After hard wipe → old token replay 401 (soft window and wiped alike, F1); every table empty; tombstone; re-purge no-op", async () => {
  const s = await start();
  try {
    const a = await seedDad(s);
    const b = await seedDad(s);
    const stolen = (await s.bff.mintToken({ dad_id: a.dad_id })).token;
    await fetchZip(s.base, a.dad_id, a.token);
    await s.bff.requestDelete({ dad_id: a.dad_id, now: T0 });
    assert.equal((await state(s.base, a.dad_id, stolen)).status, 401);

    const res = await s.bff.purgeDue({ now: T0 + 14 * DAY });
    assert.equal(res.purged.length, 1);
    const p = res.purged[0];
    assert.equal(p.dad_id, a.dad_id);
    assert.equal(p.counts.events, 1);
    assert.equal(p.counts.communications, 1);
    assert.equal(p.counts.state, 1);
    assert.equal(p.counts.tokens, 2, "token rows dropped, not just revoked");
    assert.ok(p.counts.plan_topics > 0);

    // Replay: the dad no longer exists; the gate answers exactly as for a revoked token (F1).
    for (const t of [a.token, stolen]) {
      const r = await state(s.base, a.dad_id, t);
      assert.deepEqual([r.status, r.data], [401, { error: "unauthorized" }]);
      assert.equal((await jsonReq(s.base, "POST", "/vault/intake", { dad_id: a.dad_id, text: "hi" }, { token: t })).status, 401);
    }
    assert.equal(await s.tokenStore.lookupActive(hashToken(a.token)), null);
    for (const t of CLAIM_TABLES) {
      const rows = t === "state" ? (s.vault.state.has(a.dad_id) ? [1] : []) : s.vault[t].filter((r) => r.dad_id === a.dad_id);
      assert.equal(rows.length, 0, `${t} wiped`);
    }
    assert.ok(!(await s.vault.getState(a.dad_id)), "state gone");
    assert.equal((await state(s.base, b.dad_id, b.token)).status, 200, "dad B untouched");
    assert.equal(s.vault.events.filter((e) => e.dad_id === b.dad_id).length, 1);

    const tomb = await s.opsStore.getDeletion(a.dad_id);
    assert.equal(tomb.purged_at, new Date(T0 + 14 * DAY).toISOString());
    assert.deepEqual(tomb.purged_counts, p.counts);
    assert.deepEqual(await s.bff.purgeDue({ now: T0 + 30 * DAY }), { purged: [], due: 0 }, "already purged");
    await assert.rejects(() => s.bff.requestDelete({ dad_id: a.dad_id }), (e) => e.status === 404, "nothing left to delete");
    // Re-provisioning the same uuid is out of scope for this slice; it would mint a fresh empty dad.
  } finally {
    await s.close();
  }
});

test("Nick CLI: export writes zip + receipt; delete refused → allowed after export; purge waits 14d then wipes; ids masked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dde-export-"));
  const s = await start();
  try {
    const a = await seedDad(s);
    let out = "";
    const write = (x) => {
      out += x;
    };
    const refused = await runDadCli(["delete", "--dad-id", a.dad_id], { bff: s.bff, write, now: T0 });
    assert.equal(refused.code, 1);
    assert.match(out, /^refused: export receipt required/);

    out = "";
    const file = join(dir, "alex.zip");
    const ex = await runDadCli(["export", "--dad-id", a.dad_id, "--out", file], { bff: s.bff, write, now: T0 });
    assert.equal(ex.code, 0);
    assert.ok(existsSync(file));
    assert.equal(unzipStore(readFileSync(file)).length, 5);
    assert.equal((await s.opsStore.latestReceipt(a.dad_id)).actor, "operator");
    assert.doesNotMatch(out, UUID_FULL, "dad_id masked in output");
    assert.match(out, new RegExp(`dad …${a.dad_id.slice(-4)}`));

    out = "";
    const del = await runDadCli(["delete", "--dad-id", a.dad_id], { bff: s.bff, write, now: T0 + DAY });
    assert.equal(del.code, 0);
    assert.match(out, /soft-deleted dad …\w{4}: tokens revoked 1; hard wipe due 2026-10-12/);
    assert.equal((await state(s.base, a.dad_id, a.token)).status, 401);

    out = "";
    assert.match((await runDadCli(["purge"], { bff: s.bff, write, now: T0 + 10 * DAY }), out), /nothing due/);
    assert.ok(await s.vault.getState(a.dad_id));
    out = "";
    const pg = await runDadCli(["purge"], { bff: s.bff, write, now: T0 + 16 * DAY });
    assert.equal(pg.purged.length, 1);
    assert.match(out, /^PURGED dad …\w{4} at 2026-10-13/);
    assert.ok(!(await s.vault.getState(a.dad_id)), "state gone");
    assert.equal((await state(s.base, a.dad_id, a.token)).status, 401);

    assert.equal((await runDadCli(["delete"], { bff: s.bff, write })).code, 2);
    assert.equal((await runDadCli(["wipe", "--dad-id", a.dad_id], { bff: s.bff, write })).code, 2);
    out = "";
    assert.equal((await runDadCli(["cancel-delete", "--dad-id", randomUUID()], { bff: s.bff, write })).code, 1);
    assert.match(out, /refused: unknown dad/);
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable JSON ledger: receipt + pending deletion survive reopen; no dad content on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dde-ops-"));
  const jsonPath = join(dir, ".dde-ops.json");
  const vault = new Vault();
  const tokenStore = createMemoryTokenStore();
  try {
    const s1 = await start({ vault, tokenStore, opsStore: await openOpsStore({ jsonPath }) });
    let a;
    try {
      a = await seedDad(s1);
      await fetchZip(s1.base, a.dad_id, a.token);
      await s1.bff.requestDelete({ dad_id: a.dad_id, now: T0 });
    } finally {
      await s1.close();
    }
    const disk = readFileSync(jsonPath, "utf8");
    assert.doesNotMatch(disk, /cancelled my Friday|dde-stub-|Pickup confirmed/, "ledger holds ids + timestamps + hash only");
    const s2 = await start({ vault, tokenStore, opsStore: await openOpsStore({ jsonPath }) });
    try {
      const d = await s2.opsStore.getDeletion(a.dad_id);
      assert.equal(d.purge_at, new Date(T0 + 14 * DAY).toISOString());
      assert.equal((await s2.bff.purgeDue({ now: T0 + 14 * DAY })).purged.length, 1, "purge honors the ledger after restart");
    } finally {
      await s2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F1 ruling: soft-window replay, post-wipe replay, and a never-existed dad all answer 401 with the SAME body", async () => {
  const s = await start();
  try {
    const a = await seedDad(s);
    const b = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const stolen = (await s.bff.mintToken({ dad_id: a.dad_id })).token;
    await fetchZip(s.base, a.dad_id, a.token);
    await s.bff.requestDelete({ dad_id: a.dad_id, now: T0 });

    const DEAD = [401, { error: "unauthorized" }];
    // 1. soft window: token revoked, dad still exists
    const soft = await state(s.base, a.dad_id, stolen);
    assert.deepEqual([soft.status, soft.data], DEAD, "soft window");

    // 2. post-wipe: token rows gone AND dad gone
    await s.bff.purgeDue({ now: T0 + 14 * DAY });
    const wiped = await state(s.base, a.dad_id, stolen);
    assert.deepEqual([wiped.status, wiped.data], DEAD, "post-wipe replay");
    const wipedWrite = await jsonReq(s.base, "POST", "/vault/intake", { dad_id: a.dad_id, text: "hi" }, { token: stolen });
    assert.deepEqual([wipedWrite.status, wipedWrite.data], DEAD, "post-wipe replay (write)");
    // …and with a LIVE token of another dad: still 401, still the same body (never 404, never 403).
    const wipedLive = await state(s.base, a.dad_id, b.token);
    assert.deepEqual([wipedLive.status, wipedLive.data], DEAD, "wiped dad + someone else's live token");

    // 3. never existed: same answer, no token or a live one
    const ghost = randomUUID();
    const never = await state(s.base, ghost, b.token);
    assert.deepEqual([never.status, never.data], DEAD, "never-existed dad + live token");
    const neverNoTok = await state(s.base, ghost, "");
    assert.deepEqual([neverNoTok.status, neverNoTok.data], DEAD, "never-existed dad + no token");
    const neverExport = await fetchZip(s.base, ghost, b.token);
    assert.equal(neverExport.status, 401);

    // Byte-identical bodies across all three cases.
    assert.equal(JSON.stringify(soft.data), JSON.stringify(wiped.data));
    assert.equal(JSON.stringify(wiped.data), JSON.stringify(never.data));
    // Cross-dad on an EXISTING dad is still 403 — unchanged.
    assert.equal((await state(s.base, b.dad_id, (await s.bff.mintToken({ dad_id: b.dad_id })).token)).status, 200);
    const c = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    assert.equal((await state(s.base, c.dad_id, b.token)).status, 403);
    // Operator CLI wording unchanged.
    let out = "";
    assert.equal((await runDadCli(["cancel-delete", "--dad-id", ghost], { bff: s.bff, write: (x) => (out += x) })).code, 1);
    assert.match(out, /refused: unknown dad/);
  } finally {
    await s.close();
  }
});
