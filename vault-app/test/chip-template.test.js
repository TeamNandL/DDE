// Tenant bind — two-object Chip.
// Public template = demo/door: zero secrets. Per-dad template = vault-bound
// via hash-only /app entry. Fake family only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, "..", rel), "utf8");

const PUBLIC_TEMPLATE = read("CHIP_PUBLIC_TEMPLATE.md");
const DAD_TEMPLATE = read("CHIP_DAD_TEMPLATE.md");
const ENTRY_HTML = read("public/chip-entry.html");

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---------------------------------------------------------------------------
// 1) Public template: the demo/door object carries ZERO secrets.

test("public Chip template: no dad_id, no token, no live URL, no auth wording", () => {
  assert.doesNotMatch(PUBLIC_TEMPLATE, UUID_RE, "public template carries a dad_id/uuid");
  assert.doesNotMatch(PUBLIC_TEMPLATE, /dde-stub/i, "public template carries a token value");
  assert.doesNotMatch(PUBLIC_TEMPLATE, /token/i, "public template mentions tokens");
  assert.doesNotMatch(PUBLIC_TEMPLATE, /bearer|authorization|x-dde-token/i, "public template carries auth wording");
  assert.doesNotMatch(PUBLIC_TEMPLATE, /railway/i, "public template carries the Railway host");
  assert.doesNotMatch(PUBLIC_TEMPLATE, /https?:\/\//i, "public template carries a live URL");
  assert.doesNotMatch(PUBLIC_TEMPLATE, /127\.0\.0\.1|localhost|:8787/i, "public template carries a base address");
  // It is still the demo: fake family named, real-data disclaimer present.
  assert.match(PUBLIC_TEMPLATE, /Alex Rivera/);
  assert.match(PUBLIC_TEMPLATE, /demo/i);
});

// ---------------------------------------------------------------------------
// 2) Per-dad template: placeholders only, hash-only bind, never query token.

test("per-dad Chip template: hash-only bind, placeholders only, no live values", () => {
  // The documented deep link is hash-only.
  assert.match(DAD_TEMPLATE, /\{\{BASE\}\}\/app#dad_id=\{\{DAD_ID\}\}&token=\{\{TOKEN\}\}/);
  assert.doesNotMatch(DAD_TEMPLATE, /\?token=/, "per-dad template shows a query-string token");
  // Slots, never values: no real uuid, no real token, no hardcoded base.
  assert.doesNotMatch(DAD_TEMPLATE, UUID_RE, "per-dad template carries a real dad_id");
  assert.doesNotMatch(DAD_TEMPLATE, /dde-stub-[0-9a-f]/i, "per-dad template carries a real token");
  assert.doesNotMatch(DAD_TEMPLATE, /https?:\/\//i, "per-dad template hardcodes a base URL");
  assert.doesNotMatch(DAD_TEMPLATE, /railway/i, "per-dad template hardcodes the Railway host");
  // Bind flow is documented: provision → deep-link.
  assert.match(DAD_TEMPLATE, /\/vault\/provision/);
  assert.match(DAD_TEMPLATE, /hash/i);
});

// ---------------------------------------------------------------------------
// Entry page ships with no baked-in credentials either.

test("chip-entry.html: no baked-in dad_id/token/live URL; query token rejected", () => {
  assert.doesNotMatch(ENTRY_HTML, UUID_RE, "entry page carries a uuid");
  assert.doesNotMatch(ENTRY_HTML, /dde-stub/i, "entry page carries a token value");
  assert.doesNotMatch(ENTRY_HTML, /railway/i, "entry page carries the Railway host");
  // The page's ?token= mentions are the REJECTION path, which must exist.
  assert.match(ENTRY_HTML, /Reject \?token= query/, "entry page must reject query tokens");
  assert.match(ENTRY_HTML, /location\.hash/, "entry page reads creds from the hash only");
});

// ---------------------------------------------------------------------------
// 3) The documented bind flow works: provision → fill placeholders →
// hash deep-link entry serves, and the bound credential reaches state.

test("bind flow: provision → filled deep link → entry HTML + Bearer state; cross-dad stays blocked", async () => {
  const vault = new Vault();
  const bff = makeBff(vault);
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    // Provision once (operator step).
    const prov = await fetch(`${base}/vault/provision`, { method: "POST" });
    assert.equal(prov.status, 200);
    const { dad_id, token } = await prov.json();

    // Fill the per-dad template's documented link.
    const deepLink = DAD_TEMPLATE.match(/\{\{BASE\}\}\/app#dad_id=\{\{DAD_ID\}\}&token=\{\{TOKEN\}\}/)[0]
      .replace("{{BASE}}", base)
      .replace("{{DAD_ID}}", dad_id)
      .replace("{{TOKEN}}", token);
    assert.ok(deepLink.includes("#dad_id="), "bind link is hash-only");

    // The path part serves the entry HTML (hash never reaches the server).
    const entryUrl = new URL(deepLink);
    assert.equal(entryUrl.hash.includes(token), true);
    assert.equal(entryUrl.search, "", "no query part in the bind link");
    const page = await fetch(`${entryUrl.origin}${entryUrl.pathname}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") || "", /text\/html/);
    assert.match(await page.text(), /Chip vault entry/);

    // The bound credential works for its own dad…
    const state = await fetch(`${base}/vault/state?dad_id=${dad_id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(state.status, 200);

    // …and for no one else (tenant bind).
    const other = await fetch(`${base}/vault/provision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dad_id: randomUUID() }),
    });
    const otherDad = (await other.json()).dad_id;
    const cross = await fetch(`${base}/vault/state?dad_id=${otherDad}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(cross.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
