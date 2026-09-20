// Vault search — hard dad_id tenancy tests (in-memory backend).
//
// Matrix (per Nick):
//   (a) dad A cannot see dad B hits
//   (b) FTS finds the cancelled/denied-visit claim
//   (c) verified filter excludes claims
//   (d) missing dad_id → 400
//   (e) log hygiene grep still clean
// Plus rails: search cannot resurrect harm-discarded or venom-stripped
// text; empty q = filtered list; type/date filters work; HTTP route wired.
//
// All seeding goes through the BFF — the same app path Intake uses.
// Fake family / test UUIDs only.

import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { handleBffRequest } from "../src/server.js";
import * as logger from "../src/logger.js";
import { readFixedVent } from "../src/demo.js";

// Same fixtures as test 9 (kept local — importing a test file would
// re-register its tests). Fake family only.
const MONDAY = new Date("2026-09-14T12:00:00");
const DENIED_VISIT_VENT =
  "Jordan didn't let me pick up Sam and Taylor for my weekend visit today. " +
  "I was at the door at five like the schedule says and she wouldn't let " +
  "them leave with me. This is the second time this month. She is doing " +
  "this on purpose to sabotage my time with the kids.";
const HARM_INPUT =
  "I am done being calm, I want to hurt Jordan for keeping the kids from me.";

const here = dirname(fileURLToPath(import.meta.url));
logger.setLogFile(join(here, "..", "test-output", "run.log"));

const DAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // denied-visit vent
const DAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // fixed vent (Maple Street)

async function seededSession() {
  logger.reset();
  const vault = new Vault();
  const bff = makeBff(vault);

  // Dad A: denied-visit claim + a verified OFW pull. Dad B: late-exchange
  // claim (Maple Street / sitter words live only in B's record).
  await bff.postVaultIntake(
    { dad_id: DAD_A, text: DENIED_VISIT_VENT },
    { referenceDate: MONDAY },
  );
  await bff.postCommsPull({
    dad_id: DAD_A,
    channel: "ofw",
    source_ref: "ofw:test:2026-09-14",
    body_cold: "OFW thread pulled for the September weekend exchange record.",
    sent_at: "2026-09-14T19:00:00.000Z",
  });
  await bff.postVaultIntake(
    { dad_id: DAD_B, text: readFixedVent() },
    { referenceDate: MONDAY },
  );
  // Harm input on dad A: discarded — zero rows, so zero search hits ever.
  await bff.postVaultIntake(
    { dad_id: DAD_A, text: HARM_INPUT },
    { referenceDate: MONDAY },
  );
  return { vault, bff };
}

test("(a) tenancy — dad A cannot see dad B hits, in either direction", async () => {
  const { bff } = await seededSession();

  // "sitter" and "Maple" exist only in dad B's record.
  const aForB = await bff.getVaultSearch({ dad_id: DAD_A, q: "sitter Maple" });
  assert.equal(aForB.length, 0, "dad A gets zero hits on dad B's words");

  const bForB = await bff.getVaultSearch({ dad_id: DAD_B, q: "sitter" });
  assert.ok(bForB.length >= 1, "dad B finds his own row");
  assert.ok(bForB.every((r) => r.dad_id === DAD_B), "every hit belongs to the searcher");

  // "weekend" appears in dad A's record; dad B must not see it.
  const bForA = await bff.getVaultSearch({ dad_id: DAD_B, q: "weekend visit door" });
  assert.equal(bForA.length, 0, "dad B gets zero hits on dad A's words");

  // Unfiltered list is tenant-scoped too.
  const aAll = await bff.getVaultSearch({ dad_id: DAD_A });
  assert.ok(aAll.length >= 2);
  assert.ok(aAll.every((r) => r.dad_id === DAD_A), "empty-q list never crosses tenants");
});

test("(b) FTS finds the denied-visit claim, labeled with pipe", async () => {
  const { bff } = await seededSession();
  const hits = await bff.getVaultSearch({ dad_id: DAD_A, q: "weekend visit" });
  assert.ok(hits.length >= 1, "denied-visit claim found");
  const ev = hits.find((r) => r.source_table === "events");
  assert.ok(ev, "hit comes from events");
  assert.equal(ev.pipe, "claim", "two-pipe: the claim is labeled claim");
  assert.ok(/weekend/i.test(ev.snippet), "snippet shows the match");
  assert.ok(ev.id && ev.ts, "ids and timestamps returned");
});

test("(c) pipe filter — verified excludes claims, claim excludes verified", async () => {
  const { bff } = await seededSession();

  const verifiedOnly = await bff.getVaultSearch({ dad_id: DAD_A, pipe: "verified" });
  assert.ok(verifiedOnly.length >= 1, "the verified OFW pull is findable");
  assert.ok(verifiedOnly.every((r) => r.pipe === "verified"), "no claim leaks into verified filter");

  // A query that only matches claim text returns nothing under pipe=verified.
  const claimWordsVerified = await bff.getVaultSearch({
    dad_id: DAD_A,
    q: "schedule door",
    pipe: "verified",
  });
  assert.equal(claimWordsVerified.length, 0);

  const claimOnly = await bff.getVaultSearch({ dad_id: DAD_A, pipe: "claim" });
  assert.ok(claimOnly.length >= 1);
  assert.ok(claimOnly.every((r) => r.pipe === "claim"));
});

test("(d) missing dad_id → 400, bad filters → 400", async () => {
  const { bff } = await seededSession();

  for (const params of [{}, { q: "weekend" }, { dad_id: "not-a-uuid" }]) {
    await assert.rejects(bff.getVaultSearch(params), (err) => err.status === 400);
  }
  await assert.rejects(
    bff.getVaultSearch({ dad_id: DAD_A, pipe: "leaked" }),
    (err) => err.status === 400,
  );
  await assert.rejects(
    bff.getVaultSearch({ dad_id: DAD_A, type: "everything" }),
    (err) => err.status === 400,
  );
  await assert.rejects(
    bff.getVaultSearch({ dad_id: DAD_A, limit: 500 }),
    (err) => err.status === 400,
  );

  // HTTP surface: GET /vault/search without dad_id is a 400 before the
  // vault is touched.
  const url = new URL("http://127.0.0.1/vault/search?q=weekend");
  await assert.rejects(
    handleBffRequest(bff, { method: "GET" }, url, {}),
    (err) => err.status === 400,
  );

  // And with dad_id the HTTP route returns tenant-scoped rows.
  const ok = await handleBffRequest(
    bff,
    { method: "GET" },
    new URL(`http://127.0.0.1/vault/search?dad_id=${DAD_A}&q=weekend`),
    {},
  );
  assert.equal(ok.status, 200);
  assert.ok(ok.body.length >= 1);
  assert.ok(ok.body.every((r) => r.dad_id === DAD_A));
});

test("rails — search cannot resurrect harm-discarded or venom-stripped text", async () => {
  const { bff } = await seededSession();

  // Harm input wrote zero rows, so its words are unfindable.
  const harm = await bff.getVaultSearch({ dad_id: DAD_A, q: "hurt" });
  assert.equal(harm.length, 0, "harm-discarded text has no rows to find");

  // Venom was stripped on intake (dad A: "sabotage"/"on purpose",
  // dad B: "spiteful"/"destroying") — none of it is searchable.
  for (const [dad, word] of [
    [DAD_A, "sabotage"],
    [DAD_B, "spiteful"],
    [DAD_B, "destroying"],
  ]) {
    const hits = await bff.getVaultSearch({ dad_id: dad, q: word });
    assert.equal(hits.length, 0, `venom word '${word}' is unfindable`);
  }
});

test("filters — type and date range narrow correctly; rank orders q hits", async () => {
  const { bff } = await seededSession();

  const stateOnly = await bff.getVaultSearch({ dad_id: DAD_A, type: "state" });
  assert.ok(stateOnly.length >= 1);
  assert.ok(stateOnly.every((r) => r.source_table === "state"));

  const before = await bff.getVaultSearch({
    dad_id: DAD_A,
    type: "events",
    to: "2026-09-15T00:00:00Z",
  });
  assert.equal(before.length, 1, "event on Monday is inside the range");
  const after = await bff.getVaultSearch({
    dad_id: DAD_A,
    type: "events",
    from: "2026-09-15T00:00:00Z",
  });
  assert.equal(after.length, 0, "event on Monday is outside from=Tuesday");

  const ranked = await bff.getVaultSearch({ dad_id: DAD_A, q: "weekend" });
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].rank >= ranked[i].rank, "rank descends");
  }
});

test("(e) log hygiene — no query text, kid names, or stored bodies in logs", async () => {
  const { bff } = await seededSession();
  await bff.getVaultSearch({ dad_id: DAD_A, q: "Sam Taylor weekend sitter" });
  const all = logger.lines().join("\n");
  assert.ok(logger.lines().length > 0, "the runs do log id-only lines");
  for (const banned of [/sam/i, /taylor/i, /jordan/i, /weekend/i, /sitter/i, /maple/i, /hurt/i]) {
    assert.ok(!banned.test(all), `log must not contain ${banned}`);
  }
});
