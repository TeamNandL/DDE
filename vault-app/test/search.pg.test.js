// Vault search on rented Postgres — same tenancy matrix as search.test.js,
// running through the app path only: BFF → SqlVault → vault_search()
// (vault/003_search.sql) → node-postgres.
//
// Requires DATABASE_URL (never committed). Without it, or where the network
// blocks the database host, this SKIPS and the Postgres leg counts as
// BLOCKED, not passed. Test UUIDs and fake-family text only; rows created
// here are deleted at the end.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";

const url = databaseUrl();

const MONDAY = new Date("2026-09-14T12:00:00");
const DENIED_VISIT_VENT =
  "Jordan didn't let me pick up Sam and Taylor for my weekend visit today. " +
  "I was at the door at five like the schedule says and she wouldn't let " +
  "them leave with me. This is the second time this month. She is doing " +
  "this on purpose to sabotage my time with the kids.";

test(
  "search on rented Postgres — hard dad_id tenancy, pipe filter, 400s",
  { skip: url ? false : "BLOCKED: DATABASE_URL not set / database egress unavailable" },
  async () => {
    const store = await openStore({ databaseUrl: url, applySchema: true });
    const bff = makeBff(store.vault);
    const dadA = randomUUID();
    const dadB = randomUUID();

    try {
      await bff.postVaultIntake(
        { dad_id: dadA, text: DENIED_VISIT_VENT },
        { referenceDate: MONDAY },
      );
      await bff.postCommsPull({
        dad_id: dadA,
        channel: "ofw",
        source_ref: `ofw:test:${dadA}`,
        body_cold: "OFW thread pulled for the September weekend exchange record.",
        sent_at: "2026-09-14T19:00:00.000Z",
      });
      await bff.postCommsCold({
        dad_id: dadB,
        channel: "ofw",
        body_cold: "Confirming the Maple Street parking lot for the sitter handoff.",
      });

      // (a) tenancy both directions.
      const aForB = await bff.getVaultSearch({ dad_id: dadA, q: "Maple sitter" });
      assert.equal(aForB.length, 0, "dad A cannot see dad B hits");
      const bForA = await bff.getVaultSearch({ dad_id: dadB, q: "weekend visit" });
      assert.equal(bForA.length, 0, "dad B cannot see dad A hits");
      const aOwn = await bff.getVaultSearch({ dad_id: dadA, q: "weekend visit" });
      assert.ok(aOwn.length >= 1, "FTS finds the denied-visit claim");
      assert.ok(aOwn.every((r) => r.dad_id === dadA));
      const evHit = aOwn.find((r) => r.source_table === "events");
      assert.equal(evHit?.pipe, "claim");

      // (c) verified filter excludes claims.
      const verifiedOnly = await bff.getVaultSearch({ dad_id: dadA, pipe: "verified" });
      assert.ok(verifiedOnly.length >= 1);
      assert.ok(verifiedOnly.every((r) => r.pipe === "verified"));

      // Empty q = filtered list, tenant-scoped.
      const list = await bff.getVaultSearch({ dad_id: dadA });
      assert.ok(list.length >= 2);
      assert.ok(list.every((r) => r.dad_id === dadA));

      // (d) missing dad_id → 400.
      await assert.rejects(bff.getVaultSearch({ q: "weekend" }), (e) => e.status === 400);
    } finally {
      // Clean up the test uuids' rows (test data only), then close.
      for (const t of ["events", "communications", "documents", "month_summary", "state"]) {
        await store.query(`delete from ${t} where dad_id = $1 or dad_id = $2`, [dadA, dadB]);
      }
      await store.close();
    }
  },
);
