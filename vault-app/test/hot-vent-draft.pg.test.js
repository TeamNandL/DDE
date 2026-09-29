// Slice 19 on REAL Postgres, through HTTP under Bearer + RLS (dde_app).
// Skips (BLOCKED, not passed) without DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";
import { openTokenStore } from "../src/tokens.js";
import { createServer, listenServer } from "../src/server.js";
import { FAILSAFE_SAY, isCleanComplete } from "../src/calmdraft.js";
import { jsonReq } from "./auth-cases.js";
import { EXPECTED, FIXTURES, FIXTURES_19B, ROUND_TWO } from "./hot-vent-fixtures.js";

const url = databaseUrl();

test("PG hot vent: Round Two + five fixtures → calm complete drafts stored, fail-safe stores nothing", { skip: !url && "DATABASE_URL not set — BLOCKED" }, async () => {
  const store = await openStore({ databaseUrl: url });
  const tokenStore = await openTokenStore({ query: store.query });
  const server = createServer(makeBff(store.vault, { tokenStore }));
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const { dad_id, token } = (await jsonReq(base, "POST", "/vault/provision", {})).data;
    const post = (body) => jsonReq(base, "POST", "/vault/comms/draft", { dad_id, body }, { token });

    const ids = [];
    for (const vent of [ROUND_TWO, ...Object.values(FIXTURES)]) {
      const r = await post(vent);
      assert.equal(r.status, 200);
      assert.equal(r.data.written, 1);
      assert.ok(isCleanComplete(r.data.body), r.data.body);
      assert.doesNotMatch(r.data.body, /fuck|narcissis|alienat|tell her off/i);
      ids.push(r.data.draft_id);
    }
    const fail = await post("I am so fucking done.");
    assert.deepEqual(fail.data, { written: 0, rewritten: false, say: FAILSAFE_SAY });
    assert.equal((await jsonReq(base, "POST", "/vault/comms/draft", { dad_id, body: ROUND_TWO })).status, 401, "Bearer still required");

    const { rows } = await store.query(
      `select body_cold, sent_at from communications where dad_id = $1 and direction = 'draft' order by created_at`,
      [dad_id],
    );
    assert.equal(rows.length, 6, "fail-safe stored nothing");
    for (const row of rows) {
      assert.equal(row.sent_at, null, "draft ≠ send");
      assert.doesNotMatch(row.body_cold, /fuck|damn|shit|crap|narcissis|alienat|tell her off|I am so/i);
    }
    assert.equal(
      rows[0].body_cold,
      "My weekend parenting time was cancelled again. Please let me know when we can schedule the make-up time. Thank you.",
    );

    // 19b on Postgres: 3 more calm drafts, 2 no-draft routes (safety, worn-out).
    for (const [key, vent] of Object.entries(FIXTURES_19B)) {
      const r = await post(vent);
      if (EXPECTED[key] === null) assert.equal(r.data.written, 0, key);
      else assert.equal(r.data.body, EXPECTED[key], key);
    }
    const { rows: after } = await store.query(
      `select count(*)::int as n from communications where dad_id = $1 and direction = 'draft'`,
      [dad_id],
    );
    assert.equal(after[0].n, 9, "6 + 3 calm drafts; safety + worn-out stored nothing");
  } finally {
    await new Promise((r) => server.close(r));
    await store.close();
  }
});
