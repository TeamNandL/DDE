// Durable tokens + hash-only chip entry. Fake family UUIDs only.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer, CHIP_ENTRY_PATHS } from "../src/server.js";
import { hashToken, openTokenStore } from "../src/tokens.js";
import * as logger from "../src/logger.js";

async function startWithStore(tokenStore, vault = new Vault()) {
  logger.reset();
  const bff = makeBff(vault, { tokenStore });
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    vault,
    bff,
    server,
    base,
    tokenStore,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await tokenStore.close();
    },
  };
}

async function jsonReq(base, method, path, body, { token } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}

test("durable JSON: provision → reopen store → same Bearer 200; bad 401; cross-dad 403", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dde-tokens-"));
  const jsonPath = join(dir, ".dde-tokens.json");
  const vault = new Vault();
  const dadA = randomUUID();
  const dadB = randomUUID();
  let tokenA;
  let tokenB;

  try {
    const store1 = await openTokenStore({ jsonPath });
    const s1 = await startWithStore(store1, vault);
    try {
      const a = await jsonReq(s1.base, "POST", "/vault/provision", { dad_id: dadA });
      assert.equal(a.status, 200, JSON.stringify(a.data));
      tokenA = a.data.token;
      assert.match(tokenA, /^dde-stub-/);

      const b = await jsonReq(s1.base, "POST", "/vault/provision", { dad_id: dadB });
      assert.equal(b.status, 200);
      tokenB = b.data.token;

      const ok = await jsonReq(s1.base, "GET", `/vault/state?dad_id=${dadA}`, null, {
        token: tokenA,
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.data.dad_id, dadA);
    } finally {
      await s1.close();
    }

    // File must store hash only — never the raw token
    const disk = readFileSync(jsonPath, "utf8");
    assert.doesNotMatch(disk, /dde-stub-/);
    assert.match(disk, new RegExp(hashToken(tokenA)));
    assert.match(disk, /"token_hash"/);
    assert.match(disk, /"dad_id"/);
    assert.match(disk, /"created_at"/);
    assert.match(disk, /"revoked_at"/);

    // Restart / reopen store — same vault (simulates durable vault + token reopen)
    const store2 = await openTokenStore({ jsonPath });
    const s2 = await startWithStore(store2, vault);
    try {
      const still = await jsonReq(s2.base, "GET", `/vault/state?dad_id=${dadA}`, null, {
        token: tokenA,
      });
      assert.equal(still.status, 200, JSON.stringify(still.data));
      assert.equal(still.data.dad_id, dadA);

      const bad = await jsonReq(s2.base, "GET", `/vault/state?dad_id=${dadA}`, null, {
        token: "dde-stub-not-real",
      });
      assert.equal(bad.status, 401);
      assert.deepEqual(bad.data, { error: "unauthorized" });

      const cross = await jsonReq(s2.base, "GET", `/vault/state?dad_id=${dadB}`, null, {
        token: tokenA,
      });
      assert.equal(cross.status, 403);
      assert.deepEqual(cross.data, { error: "forbidden" });

      const bOk = await jsonReq(s2.base, "GET", `/vault/state?dad_id=${dadB}`, null, {
        token: tokenB,
      });
      assert.equal(bOk.status, 200);
    } finally {
      await s2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable tokens: unknown dad → 404 before token check", async () => {
  const store = await openTokenStore({ memory: true });
  const s = await startWithStore(store);
  try {
    const unknown = randomUUID();
    const res = await jsonReq(s.base, "GET", `/vault/state?dad_id=${unknown}`, null, {
      token: "dde-stub-whatever",
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.data, { error: "unknown dad" });
  } finally {
    await s.close();
  }
});

test("chip-entry HTML: hash-only token; rejects query token path", async () => {
  const store = await openTokenStore({ memory: true });
  const s = await startWithStore(store);
  try {
    for (const path of CHIP_ENTRY_PATHS) {
      const res = await fetch(`${s.base}${path}`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /hash/i);
      assert.match(html, /queryHasToken|Query token was ignored|not the query string/);
      assert.match(html, /parseHashCreds|location\.hash/);
      assert.match(html, /replaceState/);
      // Must not treat query as a credential source for token
      assert.doesNotMatch(html, /q\.forEach.*out\[k\]/);
      assert.match(html, /searchParams\.has\("token"\)|queryHasToken/);
    }
  } finally {
    await s.close();
  }
});

test("durable Postgres: reopen store → same Bearer 200 (skip unless DATABASE_URL)", async (t) => {
  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) {
    t.skip("DATABASE_URL unset");
    return;
  }

  const { openStore } = await import("../src/store.js");
  const dad_id = randomUUID();
  let token;

  const store = await openStore({ databaseUrl: url });
  try {
    const ts1 = await openTokenStore({ query: store.query });
    const bff1 = makeBff(store.vault, { tokenStore: ts1 });
    const prov = await bff1.postVaultProvision({ dad_id });
    token = prov.token;
    await bff1.checkToken(dad_id, token);
    await ts1.close();

    const ts2 = await openTokenStore({ query: store.query });
    const bff2 = makeBff(store.vault, { tokenStore: ts2 });
    await bff2.checkToken(dad_id, token);

    try {
      await bff2.checkToken(dad_id, "dde-stub-bad");
      assert.fail("expected 401");
    } catch (err) {
      assert.equal(err.status, 401);
    }

    const other = randomUUID();
    await store.vault.provisionState(other);
    try {
      await bff2.checkToken(other, token);
      assert.fail("expected 403");
    } catch (err) {
      assert.equal(err.status, 403);
    }

    await ts2.close();
  } finally {
    await store.close();
  }
});
