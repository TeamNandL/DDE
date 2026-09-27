// Parenting Plan seat (Slice 14) on REAL Postgres — boots the store the
// production way (applyVaultSchema incl. vault/011_parenting_plan.sql).
// Skips (BLOCKED, not passed) without DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";
import { openTokenStore } from "../src/tokens.js";

const url = databaseUrl();

test("PG parenting plan: ensure → answer → stuck/park → versioned full + prep drafts", { skip: !url && "DATABASE_URL not set — BLOCKED" }, async () => {
  const store = await openStore({ databaseUrl: url });
  assert.equal(store.kind, "postgres");
  try {
    const tokenStore = await openTokenStore({ query: store.query });
    const bff = makeBff(store.vault, { tokenStore });
    const dad_id = randomUUID();
    await bff.postVaultProvision({ dad_id });

    assert.equal((await bff.postPlanEnsure({ dad_id })).created, 6);
    assert.equal((await bff.postPlanEnsure({ dad_id })).created, 0);

    const a = await bff.postPlanAnswer({
      dad_id, topic: "medical_access", choice: "shared_portal", depth: "deeper", detail: "notice_48h", stance: "want",
    });
    assert.equal(a.topic.detail_label, "48 hours before");
    await bff.postPlanAnswer({ dad_id, topic: "holidays", choice: "split_day", stance: "trade_bait" });

    const one = await bff.postPlanStuck({ dad_id, topic: "rofr" });
    assert.equal(one.parked, false);
    const two = await bff.postPlanStuck({ dad_id, topic: "rofr" });
    assert.equal(two.parked, true);
    assert.ok(!("example" in two));

    const topics = await bff.getPlanTopics({ dad_id });
    assert.deepEqual(topics.counts, { open: 3, answered: 2, parked: 1 });
    assert.equal(topics.next.topic, "exchanges");

    const f1 = await bff.postPlanRegenerate({ dad_id, kind: "full" });
    const p2 = await bff.postPlanRegenerate({ dad_id, kind: "prep" });
    assert.deepEqual([f1.version, p2.version], [1, 2]);
    assert.match(f1.body, /Medical access: Both parents on every patient portal\./);
    assert.match(p2.body, /Trade bait \(can give back\):\n- Holidays and breaks: Split each holiday day\./);
    assert.equal((await bff.getPlanDraft({ dad_id, kind: "full" })).version, 1);
    assert.equal((await bff.getPlanDraft({ dad_id, kind: "prep" })).version, 2);

    assert.equal((await store.vault.listEvents(dad_id)).length, 0, "plan never writes intake events");
    assert.equal((await bff.getVaultExportVerified({ dad_id })).length, 0);
  } finally {
    await store.close();
  }
});
