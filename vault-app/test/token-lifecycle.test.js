// Slice 20 — token lifecycle (revised brief): logout / revoke / expiry ONLY.
//   logout  → ALL-DEVICE. Every token the dad holds dies. /vault/panic = same.
//   revoke  → Nick only (CLI). No dad-facing HTTP revoke route.
//   expiry  → 30 days of INACTIVITY (sliding): use slides last_seen_at;
//             idle past DDE_TOKEN_TTL_DAYS → 401 "token expired" and the row
//             is revoked on the spot (durable, rollback-safe).
//   cutover → pre-Slice-20 rows start their clock at first open (no mass logout).
//   masking → logs show only the last 4 of a token or dad_id.
//   replay  → a stolen token is dead after logout, after revoke, after expiry.
// Fake family UUIDs only.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer, PHASE1_ROUTES } from "../src/server.js";
import {
  DEFAULT_TOKEN_TTL_DAYS,
  TOUCH_MIN_MS,
  createMemoryTokenStore,
  hashToken,
  isTokenExpired,
  maskToken,
  openTokenStore,
  shouldTouch,
  tokenTtlMs,
} from "../src/tokens.js";
import { runTokenCli } from "../src/cli-token.js";
import * as logger from "../src/logger.js";
import { jsonReq } from "./auth-cases.js";

const T0 = Date.parse("2026-09-27T16:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const UUID_FULL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
const intake = (base, dad_id, token) =>
  jsonReq(base, "POST", "/vault/intake", { dad_id, text: "They cancelled my visit Friday." }, { token });

test("routes: logout + panic listed; NO dad-facing revoke / mint / reissue route", () => {
  assert.ok(PHASE1_ROUTES.includes("POST /vault/logout"));
  assert.ok(PHASE1_ROUTES.includes("POST /vault/panic"));
  assert.ok(!PHASE1_ROUTES.some((r) => /revoke|reissue|mint/i.test(r)), "revoke is Nick-only (CLI)");
});

test("REPLAY after LOGOUT: all-device — every token the dad holds dies, the stolen one included", async () => {
  const s = await start();
  try {
    const a = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const phone = a.token;
    const tabletAtOtherHouse = (await s.bff.mintToken({ dad_id: a.dad_id })).token; // the threat
    const b = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    assert.equal((await state(s.base, a.dad_id, tabletAtOtherHouse)).status, 200, "tablet works before logout");

    const out = await jsonReq(s.base, "POST", "/vault/logout", { dad_id: a.dad_id }, { token: phone });
    assert.equal(out.status, 200);
    assert.deepEqual(out.data, { logged_out: true, revoked: 2 });

    // Replay: both tokens, read + write, all shut.
    for (const t of [phone, tabletAtOtherHouse]) {
      assert.deepEqual([(await state(s.base, a.dad_id, t)).status, (await intake(s.base, a.dad_id, t)).status], [401, 401]);
      assert.deepEqual((await state(s.base, a.dad_id, t)).data, { error: "unauthorized" });
    }
    // A dead token can't log out again, and the other dad is untouched.
    assert.equal((await jsonReq(s.base, "POST", "/vault/logout", { dad_id: a.dad_id }, { token: phone })).status, 401);
    assert.equal((await state(s.base, b.dad_id, b.token)).status, 200);
    assert.ok(await s.vault.getState(a.dad_id), "vault data untouched by logout");
  } finally {
    await s.close();
  }
});

test("PANIC 'log out everywhere now' = same all-device kill via POST /vault/panic; cross-dad 403", async () => {
  const s = await start();
  try {
    const a = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const b = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const t2 = (await s.bff.mintToken({ dad_id: a.dad_id })).token;

    assert.equal((await jsonReq(s.base, "POST", "/vault/panic", { dad_id: b.dad_id }, { token: a.token })).status, 403);
    assert.equal((await state(s.base, b.dad_id, b.token)).status, 200, "B survives A's attempt");

    const out = await jsonReq(s.base, "POST", "/vault/panic", { dad_id: a.dad_id }, { token: t2 });
    assert.deepEqual([out.status, out.data], [200, { logged_out: true, revoked: 2 }]);
    assert.equal((await state(s.base, a.dad_id, a.token)).status, 401);
    assert.equal((await state(s.base, a.dad_id, t2)).status, 401);
  } finally {
    await s.close();
  }
});

test("REPLAY after REVOKE (Nick CLI): every token dead; reissue prints one fresh token once; other dads untouched", async () => {
  const s = await start();
  try {
    const a = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const b = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const t2 = (await s.bff.mintToken({ dad_id: a.dad_id })).token;
    let out = "";
    const write = (x) => {
      out += x;
    };

    const rv = await runTokenCli(["revoke", "--dad-id", a.dad_id], { bff: s.bff, write });
    assert.deepEqual([rv.code, rv.revoked], [0, 2]);
    assert.doesNotMatch(out, /dde-stub-/, "no token in output");
    assert.doesNotMatch(out, UUID_FULL, "dad_id masked");
    assert.match(out, new RegExp(`…${a.dad_id.slice(-4)}`));
    for (const t of [a.token, t2]) {
      assert.deepEqual([(await state(s.base, a.dad_id, t)).status, (await intake(s.base, a.dad_id, t)).status], [401, 401]);
    }
    assert.equal((await state(s.base, b.dad_id, b.token)).status, 200);

    out = "";
    const re = await runTokenCli(["reissue", "--dad-id", a.dad_id], { bff: s.bff, write });
    assert.equal(re.code, 0);
    assert.equal(re.revoked, 0, "nothing live was left to revoke");
    assert.equal(out.split(re.token).length - 1, 1, "raw token printed exactly once");
    assert.equal((await state(s.base, a.dad_id, re.token)).status, 200);
    assert.equal((await state(s.base, a.dad_id, a.token)).status, 401, "old still dead");

    out = "";
    assert.equal((await runTokenCli(["reissue", "--dad-id", randomUUID()], { bff: s.bff, write })).code, 1);
    assert.match(out, /^unknown dad/);
    assert.doesNotMatch(out, UUID_FULL);
    assert.equal((await runTokenCli(["reissue"], { bff: s.bff, write })).code, 2);
    assert.equal((await runTokenCli(["nuke", "--dad-id", a.dad_id], { bff: s.bff, write })).code, 2);
    assert.equal((await runTokenCli(["revoke-all"], { bff: s.bff, write })).code, 2, "nuclear needs --yes");
  } finally {
    await s.close();
  }
});

test("REPLAY after NATURAL EXPIRY: 30 days of INACTIVITY (sliding) — use extends, idle kills, death is durable", async () => {
  const vault = new Vault();
  const tokenStore = createMemoryTokenStore();
  let a;
  {
    const s = await start({ vault, tokenStore });
    a = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    assert.equal(a.expires_at, undefined, "no fixed expiry on the wire — sliding");
    await s.close();
  }
  // Day 29: still in. This use slides last_seen_at to day 29.
  {
    const s = await start({ now: T0 + 29 * DAY, vault, tokenStore });
    try {
      assert.equal((await state(s.base, a.dad_id, a.token)).status, 200);
    } finally {
      await s.close();
    }
  }
  // Day 45 (< 29 + 30): the day-29 use kept it alive. Fixed-from-mint would have killed it at day 30.
  {
    const s = await start({ now: T0 + 45 * DAY, vault, tokenStore });
    try {
      assert.equal((await state(s.base, a.dad_id, a.token)).status, 200, "sliding, not fixed");
    } finally {
      await s.close();
    }
  }
  // Day 75 (= 45 + 30): idle for exactly the TTL → expired.
  {
    const s = await start({ now: T0 + 75 * DAY, vault, tokenStore });
    try {
      const r = await state(s.base, a.dad_id, a.token);
      assert.deepEqual([r.status, r.data], [401, { error: "token expired" }]);
      assert.equal((await intake(s.base, a.dad_id, a.token)).status, 401, "replay write shut");
      // Expired can't log out / panic either, and it is dead for every dad.
      assert.equal((await jsonReq(s.base, "POST", "/vault/logout", { dad_id: a.dad_id }, { token: a.token })).status, 401);
      const other = randomUUID();
      await vault.provisionState(other);
      assert.equal((await state(s.base, other, a.token)).status, 401);
    } finally {
      await s.close();
    }
  }
  // Durable: the expiry was written as revoked_at, so even a clock that
  // goes BACKWARDS (or old code with no expiry check) never revives it.
  assert.equal(await tokenStore.lookupActive(hashToken(a.token)), null, "row revoked on expiry");
  {
    const s = await start({ now: T0 + 10 * DAY, vault, tokenStore });
    try {
      assert.equal((await state(s.base, a.dad_id, a.token)).status, 401, "dead even with the clock wound back");
    } finally {
      await s.close();
    }
  }
});

test("expiry helpers: TTL env; sliding base = last_seen_at else created_at; fail closed; touch throttle", () => {
  assert.equal(DEFAULT_TOKEN_TTL_DAYS, 30);
  assert.equal(tokenTtlMs({}), 30 * DAY);
  assert.equal(tokenTtlMs({ DDE_TOKEN_TTL_DAYS: "7" }), 7 * DAY);
  for (const bad of ["0", "-3", "abc", ""]) assert.equal(tokenTtlMs({ DDE_TOKEN_TTL_DAYS: bad }), 30 * DAY, bad);

  const created_at = new Date(T0).toISOString();
  const seen = { created_at, last_seen_at: new Date(T0 + 20 * DAY).toISOString() };
  assert.equal(isTokenExpired(seen, T0 + 49 * DAY, 30 * DAY), false, "20 + 30 > 49");
  assert.equal(isTokenExpired(seen, T0 + 50 * DAY, 30 * DAY), true, "20 + 30 <= 50");
  assert.equal(isTokenExpired({ created_at }, T0 + 30 * DAY, 30 * DAY), true, "no last_seen → created_at");
  assert.equal(isTokenExpired({ created_at: "garbage" }, T0, 30 * DAY), true, "unreadable → expired (fail closed)");
  assert.equal(isTokenExpired({}, T0, 30 * DAY), true);

  assert.equal(shouldTouch(seen, T0 + 20 * DAY + TOUCH_MIN_MS - 1), false, "throttled");
  assert.equal(shouldTouch(seen, T0 + 20 * DAY + TOUCH_MIN_MS), true);
  assert.equal(shouldTouch({}, T0), true, "unreadable → write a real clock");
});

test("touch throttle: a burst of requests writes last_seen_at once; a later one slides it", async () => {
  const vault = new Vault();
  const tokenStore = createMemoryTokenStore();
  let writes = 0;
  const baseTouch = tokenStore.touch.bind(tokenStore);
  tokenStore.touch = async (h, at) => {
    writes += 1;
    return baseTouch(h, at);
  };
  const s0 = await start({ vault, tokenStore });
  const a = (await jsonReq(s0.base, "POST", "/vault/provision", {})).data;
  await s0.close();

  const s1 = await start({ now: T0 + 60 * 1000, vault, tokenStore }); // 1 min later
  try {
    for (let i = 0; i < 5; i++) assert.equal((await state(s1.base, a.dad_id, a.token)).status, 200);
  } finally {
    await s1.close();
  }
  assert.equal(writes, 0, "within TOUCH_MIN_MS of mint: no rewrite");

  const s2 = await start({ now: T0 + DAY, vault, tokenStore });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await state(s2.base, a.dad_id, a.token)).status, 200);
  } finally {
    await s2.close();
  }
  assert.equal(writes, 1, "first request past the window slides the clock; the rest of the burst is throttled");
  const row = await tokenStore.lookupActive(hashToken(a.token));
  assert.equal(row.last_seen_at, new Date(T0 + DAY).toISOString());
});

test("MASKING: log lines never carry a full token, token hash, or dad_id — last 4 only", async () => {
  const s = await start();
  try {
    const a = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    logger.reset();
    await state(s.base, a.dad_id, a.token);
    await intake(s.base, a.dad_id, a.token);
    await jsonReq(s.base, "POST", "/vault/panic", { dad_id: a.dad_id }, { token: a.token });
    await state(s.base, a.dad_id, a.token); // dead → 401 path
    const lines = logger.lines();
    assert.ok(lines.some((l) => l.startsWith("http.panic ")), "panic logged");
    assert.ok(lines.some((l) => l.startsWith("token.logout_all ") && /revoked=1/.test(l)));
    const all = lines.join("\n");
    assert.doesNotMatch(all, UUID_FULL, "no full dad_id");
    assert.doesNotMatch(all, /dde-stub-/, "no token");
    assert.doesNotMatch(all, new RegExp(hashToken(a.token)), "no token hash");
    assert.match(all, new RegExp(`dad=…${a.dad_id.slice(-4)}`), "last 4 of the dad_id");
    assert.equal(logger.mask(`x ${a.token} ${a.dad_id}`), `x …${a.token.slice(-4)} …${a.dad_id.slice(-4)}`);
    assert.equal(maskToken(a.token), `…${a.token.slice(-4)}`);
    assert.equal(maskToken(""), "");
  } finally {
    await s.close();
  }
});

test("durable JSON: logout + expiry survive restart as revoked_at; cutover backfills last_seen_at; raw token never on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dde-tokens-"));
  const jsonPath = join(dir, ".dde-tokens.json");
  const vault = new Vault();
  try {
    // A pre-Slice-20 file: rows without last_seen_at, one of them 40 days old.
    const legacyDad = randomUUID();
    await vault.provisionState(legacyDad);
    writeFileSync(
      jsonPath,
      JSON.stringify({
        tokens: [
          { token_hash: hashToken("legacy-old"), dad_id: legacyDad, created_at: new Date(T0 - 40 * DAY).toISOString(), revoked_at: null },
        ],
      }),
    );

    const s1 = await start({ vault, tokenStore: await openTokenStore({ jsonPath }) });
    let a;
    try {
      // Grandfather: 40 days old but honored — its clock started at first open.
      assert.equal((await state(s1.base, legacyDad, "legacy-old")).status, 200, "no surprise logout at cutover");
      a = (await jsonReq(s1.base, "POST", "/vault/provision", {})).data;
      const t2 = (await s1.bff.mintToken({ dad_id: a.dad_id })).token;
      assert.equal((await jsonReq(s1.base, "POST", "/vault/logout", { dad_id: a.dad_id }, { token: a.token })).status, 200);
      assert.equal((await state(s1.base, a.dad_id, t2)).status, 401, "all-device on disk too");
    } finally {
      await s1.close();
    }
    const disk = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.doesNotMatch(JSON.stringify(disk), /dde-stub-/);
    assert.ok(disk.tokens.every((t) => t.last_seen_at), "backfilled");
    assert.equal(disk.tokens.filter((t) => t.dad_id === a.dad_id && t.revoked_at).length, 2, "both revoked_at set");

    // Restart: still dead. Then the legacy token idles 30 days from the
    // cutover backfill (wall clock, not T0) → expired → revoked_at.
    const seen = Date.parse(disk.tokens.find((t) => t.dad_id === legacyDad).last_seen_at);
    const s2 = await start({ now: seen + 31 * DAY, vault, tokenStore: await openTokenStore({ jsonPath }) });
    try {
      assert.equal((await state(s2.base, a.dad_id, a.token)).status, 401, "logout survives restart");
      const r = await state(s2.base, legacyDad, "legacy-old");
      assert.deepEqual([r.status, r.data], [401, { error: "token expired" }]);
    } finally {
      await s2.close();
    }
    const after = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.ok(after.tokens.find((t) => t.dad_id === legacyDad).revoked_at, "expiry persisted as revoked_at");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ROLLBACK prep (Nick CLI): sweep durably revokes idle tokens; revoke-all --yes kills everything", async () => {
  const s = await start();
  try {
    const a = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const b = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    let out = "";
    const write = (x) => {
      out += x;
    };
    // Nothing idle yet.
    let sw = await runTokenCli(["sweep"], { bff: s.bff, write, now: T0 + DAY });
    assert.deepEqual([sw.code, sw.revoked], [0, 0]);
    // 30 days later, both idle → both durably revoked without ever being presented.
    sw = await runTokenCli(["sweep"], { bff: s.bff, write, now: T0 + 30 * DAY });
    assert.deepEqual([sw.code, sw.revoked], [0, 2]);
    assert.equal(await s.tokenStore.lookupActive(hashToken(a.token)), null);
    assert.equal(await s.tokenStore.lookupActive(hashToken(b.token)), null);

    const c = (await jsonReq(s.base, "POST", "/vault/provision", {})).data;
    const all = await runTokenCli(["revoke-all", "--yes"], { bff: s.bff, write });
    assert.deepEqual([all.code, all.revoked], [0, 1]);
    assert.equal((await state(s.base, c.dad_id, c.token)).status, 401);
    assert.doesNotMatch(out, /dde-stub-/);
    assert.doesNotMatch(out, UUID_FULL);
  } finally {
    await s.close();
  }
});

test("bff tokenTtlMs option shortens the inactivity window", async () => {
  const vault = new Vault();
  const tokenStore = createMemoryTokenStore();
  const bff = makeBff(vault, { tokenStore, now: T0, tokenTtlMs: 60 * 60 * 1000 });
  const a = await bff.postVaultProvision({});
  const later = makeBff(vault, { tokenStore, now: T0 + 2 * 60 * 60 * 1000, tokenTtlMs: 60 * 60 * 1000 });
  await assert.rejects(() => later.checkToken(a.dad_id, a.token), (e) => e.status === 401 && e.message === "token expired");
});
