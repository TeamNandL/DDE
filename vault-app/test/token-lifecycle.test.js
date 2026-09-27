// Slice 20 — token lifecycle: logout / revoke / expiry ONLY.
//   logout  → the presented token dies; the dad's other tokens live.
//   revoke  → every token for the dad dies; other dads untouched.
//   expiry  → DDE_TOKEN_TTL_DAYS (default 30) from mint → 401 "token expired";
//             legacy rows with no expires_at expire at created_at + TTL.
//   operator CLI revoke / reissue — never an HTTP route.
// Fake family UUIDs only.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer, PHASE1_ROUTES } from "../src/server.js";
import {
  DEFAULT_TOKEN_TTL_DAYS,
  createMemoryTokenStore,
  hashToken,
  isTokenExpired,
  openTokenStore,
  tokenExpiresAt,
  tokenTtlMs,
} from "../src/tokens.js";
import { runTokenCli } from "../src/cli-token.js";
import * as logger from "../src/logger.js";
import { jsonReq } from "./auth-cases.js";

const T0 = Date.parse("2026-09-27T16:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

async function start({ now = T0, vault = new Vault(), tokenStore = createMemoryTokenStore() } = {}) {
  const bff = makeBff(vault, { tokenStore, now });
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  return {
    bff,
    vault,
    tokenStore,
    base: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const state = (base, dad_id, token) => jsonReq(base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });

test("routes: logout + token/revoke listed; no unauthenticated mint/reissue route", () => {
  assert.ok(PHASE1_ROUTES.includes("POST /vault/logout"));
  assert.ok(PHASE1_ROUTES.includes("POST /vault/token/revoke"));
  assert.ok(!PHASE1_ROUTES.some((r) => /reissue|mint/i.test(r)));
});

test("logout kills only the presented token; second logout is 401", async () => {
  const s = await start();
  try {
    const a = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const t2 = (await s.bff.mintToken({ dad_id: a.dad_id })).token;
    assert.equal((await state(s.base, a.dad_id, a.token)).status, 200);

    logger.reset();
    const out = await jsonReq(s.base, "POST", "/vault/logout", { dad_id: a.dad_id }, { token: a.token });
    assert.equal(out.status, 200);
    assert.deepEqual(out.data, { logged_out: true });
    assert.ok(!logger.lines().some((l) => l.includes(a.token) || l.includes(hashToken(a.token))), "logs never carry the token");

    const dead = await state(s.base, a.dad_id, a.token);
    assert.equal(dead.status, 401);
    assert.deepEqual(dead.data, { error: "unauthorized" });
    assert.equal((await jsonReq(s.base, "POST", "/vault/logout", { dad_id: a.dad_id }, { token: a.token })).status, 401);

    assert.equal((await state(s.base, a.dad_id, t2)).status, 200, "other device still in");
  } finally {
    await s.close();
  }
});

test("revoke kills every token for the dad; other dads untouched; cross-dad refused", async () => {
  const s = await start();
  try {
    const a = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const b = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const t2 = (await s.bff.mintToken({ dad_id: a.dad_id })).token;

    const cross = await jsonReq(s.base, "POST", "/vault/token/revoke", { dad_id: b.dad_id }, { token: a.token });
    assert.equal(cross.status, 403);
    const crossOut = await jsonReq(s.base, "POST", "/vault/logout", { dad_id: b.dad_id }, { token: a.token });
    assert.equal(crossOut.status, 403);
    assert.equal((await state(s.base, b.dad_id, b.token)).status, 200, "B survives A's attempts");

    const out = await jsonReq(s.base, "POST", "/vault/token/revoke", { dad_id: a.dad_id }, { token: t2 });
    assert.equal(out.status, 200);
    assert.deepEqual(out.data, { revoked: 2 });

    assert.equal((await state(s.base, a.dad_id, a.token)).status, 401);
    assert.equal((await state(s.base, a.dad_id, t2)).status, 401);
    assert.equal((await state(s.base, b.dad_id, b.token)).status, 200);
    // Vault data is untouched by revoke — only tokens die.
    assert.ok(await s.vault.getState(a.dad_id));
  } finally {
    await s.close();
  }
});

test("expiry: provision returns expires_at = now + TTL; valid until then, 401 'token expired' after", async () => {
  const vault = new Vault();
  const tokenStore = createMemoryTokenStore();
  const s = await start({ vault, tokenStore });
  let a;
  try {
    a = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    assert.equal(a.expires_at, new Date(T0 + DEFAULT_TOKEN_TTL_DAYS * DAY).toISOString());
  } finally {
    await s.close();
  }

  const before = await start({ now: T0 + 29 * DAY, vault, tokenStore });
  try {
    assert.equal((await state(before.base, a.dad_id, a.token)).status, 200);
  } finally {
    await before.close();
  }

  const after = await start({ now: T0 + 30 * DAY, vault, tokenStore });
  try {
    const r = await state(after.base, a.dad_id, a.token);
    assert.equal(r.status, 401);
    assert.deepEqual(r.data, { error: "token expired" });
    // An expired token can't log out or revoke either.
    assert.equal((await jsonReq(after.base, "POST", "/vault/logout", { dad_id: a.dad_id }, { token: a.token })).status, 401);
    assert.equal((await jsonReq(after.base, "POST", "/vault/token/revoke", { dad_id: a.dad_id }, { token: a.token })).status, 401);
    // Another dad's expired token is still 403 (never reveals B's data).
    const other = randomUUID();
    await vault.provisionState(other);
    assert.equal((await state(after.base, other, a.token)).status, 403);
  } finally {
    await after.close();
  }
});

test("expiry: TTL from DDE_TOKEN_TTL_DAYS; bad values fall back to 30; legacy rows get created_at + TTL", () => {
  assert.equal(tokenTtlMs({}), 30 * DAY);
  assert.equal(tokenTtlMs({ DDE_TOKEN_TTL_DAYS: "7" }), 7 * DAY);
  assert.equal(tokenTtlMs({ DDE_TOKEN_TTL_DAYS: "0.5" }), 0.5 * DAY);
  for (const bad of ["0", "-3", "abc", ""]) assert.equal(tokenTtlMs({ DDE_TOKEN_TTL_DAYS: bad }), 30 * DAY, bad);

  const created_at = new Date(T0).toISOString();
  const legacy = { created_at, expires_at: null };
  assert.equal(tokenExpiresAt(legacy, 30 * DAY), new Date(T0 + 30 * DAY).toISOString());
  assert.equal(isTokenExpired(legacy, T0 + 29 * DAY, 30 * DAY), false);
  assert.equal(isTokenExpired(legacy, T0 + 30 * DAY, 30 * DAY), true);
  const legacyJson = { created_at }; // JSON rows written before Slice 20 have no key at all
  assert.equal(isTokenExpired(legacyJson, T0 + 31 * DAY, 30 * DAY), true);
  const explicit = { created_at, expires_at: new Date(T0 + DAY).toISOString() };
  assert.equal(isTokenExpired(explicit, T0 + 2 * DAY, 30 * DAY), true, "explicit expires_at wins");
  assert.equal(isTokenExpired({ created_at: "garbage" }, T0, 30 * DAY), true, "unreadable → expired (fail closed)");
});

test("expiry: bff tokenTtlMs option shortens the lifetime", async () => {
  const vault = new Vault();
  const tokenStore = createMemoryTokenStore();
  const bff = makeBff(vault, { tokenStore, now: T0, tokenTtlMs: 60 * 60 * 1000 });
  const a = await bff.postVaultProvision({});
  assert.equal(a.expires_at, new Date(T0 + 60 * 60 * 1000).toISOString());
  const later = makeBff(vault, { tokenStore, now: T0 + 2 * 60 * 60 * 1000 });
  await assert.rejects(() => later.checkToken(a.dad_id, a.token), (e) => e.status === 401 && e.message === "token expired");
});

test("durable JSON: expires_at persisted, revoke survives reopen, raw token never on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dde-tokens-"));
  const jsonPath = join(dir, ".dde-tokens.json");
  const vault = new Vault();
  try {
    const s1 = await start({ vault, tokenStore: await openTokenStore({ jsonPath }) });
    let a;
    let t2;
    try {
      a = (await jsonReq(s1.base, "POST", "/vault/provision", {})).data;
      t2 = (await s1.bff.mintToken({ dad_id: a.dad_id })).token;
      assert.equal((await jsonReq(s1.base, "POST", "/vault/logout", { dad_id: a.dad_id }, { token: a.token })).status, 200);
    } finally {
      await s1.close();
    }
    const disk = readFileSync(jsonPath, "utf8");
    assert.doesNotMatch(disk, /dde-stub-/);
    assert.match(disk, /"expires_at"/);

    const s2 = await start({ vault, tokenStore: await openTokenStore({ jsonPath }) });
    try {
      assert.equal((await state(s2.base, a.dad_id, a.token)).status, 401, "logout survives restart");
      assert.equal((await state(s2.base, a.dad_id, t2)).status, 200);
      const r = await jsonReq(s2.base, "POST", "/vault/token/revoke", { dad_id: a.dad_id }, { token: t2 });
      assert.deepEqual(r.data, { revoked: 1 });
    } finally {
      await s2.close();
    }
    const s3 = await start({ vault, tokenStore: await openTokenStore({ jsonPath }) });
    try {
      assert.equal((await state(s3.base, a.dad_id, t2)).status, 401, "revoke survives restart");
    } finally {
      await s3.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator CLI: revoke + reissue (token printed once); unknown dad / bad args refused", async () => {
  const s = await start();
  try {
    const a = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    let out = "";
    const write = (x) => {
      out += x;
    };

    const re = await runTokenCli(["reissue", "--dad-id", a.dad_id], { bff: s.bff, write });
    assert.equal(re.code, 0);
    assert.equal(re.revoked, 1);
    assert.equal(out.split(re.token).length - 1, 1, "raw token printed exactly once");
    assert.match(out, /expires_at 2026-10-27T16:00:00\.000Z/);
    assert.equal((await state(s.base, a.dad_id, a.token)).status, 401, "old token dead");
    assert.equal((await state(s.base, a.dad_id, re.token)).status, 200, "new token works");

    out = "";
    const rv = await runTokenCli(["revoke", "--dad-id", a.dad_id], { bff: s.bff, write });
    assert.equal(rv.code, 0);
    assert.equal(rv.revoked, 1);
    assert.doesNotMatch(out, /dde-stub-/);
    assert.equal((await state(s.base, a.dad_id, re.token)).status, 401);

    out = "";
    const unk = await runTokenCli(["reissue", "--dad-id", randomUUID()], { bff: s.bff, write });
    assert.equal(unk.code, 1);
    assert.match(out, /^unknown dad/);
    assert.equal((await runTokenCli(["reissue"], { bff: s.bff, write })).code, 2);
    assert.equal((await runTokenCli(["nuke", "--dad-id", a.dad_id], { bff: s.bff, write })).code, 2);
  } finally {
    await s.close();
  }
});
