// GET /vault/chip_entry — read-only speakable bundle for Chip:
// progress_line, missing_one, next_action, return_line. Nulls when there
// is nothing (no invented counters, no invented greeting). Fake dad only.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";

const PHONE = "904-555-1212";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function assertChipSafe(text) {
  assert.equal(typeof text, "string");
  assert.doesNotMatch(text, /dde-stub/i);
  assert.doesNotMatch(text, /https?:\/\//i);
  assert.doesNotMatch(text, /bearer|authorization|x-dde-token/i);
  assert.doesNotMatch(text, UUID_RE);
  assert.ok(!text.includes(PHONE));
}

async function start() {
  const vault = new Vault();
  const bff = makeBff(vault);
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    vault,
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
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
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function provisionedDad(base) {
  const dad_id = randomUUID();
  const prov = await jsonReq(base, "POST", "/vault/provision", { dad_id });
  assert.equal(prov.status, 200);
  return { dad_id, token: prov.data.token };
}

test("fresh dad → seeded kids-facts speak; greeting fields stay null (nothing invented)", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    const entry = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    assert.equal(entry.status, 200);
    // Provision auto-seeds kids_facts (5 blanks, 0 of 5) — but there is
    // still no Next, so the greeting fields are null, not invented.
    assert.deepEqual(entry.data, {
      progress_line: "0 of 5 this week; still open: Kids school name",
      missing_one: "Kids school name",
      next_action: null,
      return_line: null,
    });

    // A truly empty (pre-auto-seed / legacy) dad still gets all nulls.
    const st = s.vault.getState(dad_id);
    st.missing = [];
    st.this_week_done = null;
    st.this_week_total = null;
    const legacy = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(legacy.data, {
      progress_line: null,
      missing_one: null,
      next_action: null,
      return_line: null,
    });
  } finally {
    await s.close();
  }
});

test("seeded state → all four speakable, PII-stripped, matching the other routes", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      {
        dad_id,
        next_action: `text her at ${PHONE} about Friday pickup`,
        missing: [`drop paperwork at 482 Maple Street Apt 3`, "file the copy"],
        this_week_done: 2,
        this_week_total: 4,
      },
      { token },
    );

    const entry = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    assert.equal(entry.status, 200);
    assert.equal(
      entry.data.progress_line,
      "2 of 4 this week; still open: drop paperwork at [address]",
    );
    assert.equal(entry.data.missing_one, "drop paperwork at [address]");
    assert.equal(entry.data.next_action, "text her at [phone] about Friday pickup");
    assert.equal(entry.data.return_line, "Last time: text her at [phone] about Friday pickup. How'd it go?");
    for (const v of Object.values(entry.data)) assertChipSafe(v);
    assert.ok(!JSON.stringify(entry.data).includes(PHONE));

    // Same greeting POST /vault/return would give (no divergence).
    const ret = await jsonReq(s.base, "POST", "/vault/return", { dad_id }, { token });
    assert.equal(ret.data.line, entry.data.return_line);
  } finally {
    await s.close();
  }
});

test("cold-ask state → return_line uses the ask summary", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      {
        dad_id,
        next_action: "send the Saturday cold ask",
        last_next_kind: "cold_ask",
        last_ask_summary: "Sat window both kids 10–6",
      },
      { token },
    );
    const entry = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    assert.equal(
      entry.data.return_line,
      "Last time: cold ask — Sat window both kids 10–6. How'd it go?",
    );
  } finally {
    await s.close();
  }
});

test("latest_draft hint: omitted with no drafts; newest draft's grade + 80-char preview; read-only", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);

    // No drafts → no latest_draft key at all.
    const empty = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    assert.ok(!("latest_draft" in empty.data), "latest_draft must be omitted with no drafts");

    // First draft: clean and short → ready; preview is the exact body.
    const first = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/draft",
      { dad_id, body: "Confirming Thursday pickup time.", kind: "cold_ask" },
      { token },
    );
    assert.equal(first.data.written, 1);
    const one = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    assert.deepEqual(one.data.latest_draft, {
      soft_grade: "ready",
      preview: "Confirming Thursday pickup time.",
    });

    // Second draft is NEWER and long (> 280 clean) → tighten, 80-char preview.
    const longBody = "Requesting a calm written plan for the fall schedule. ".repeat(7).trim();
    await jsonReq(s.base, "POST", "/vault/comms/draft", { dad_id, body: longBody }, { token });
    const two = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    assert.equal(two.data.latest_draft.soft_grade, "tighten");
    assert.equal(two.data.latest_draft.preview, longBody.slice(0, 80));
    assert.equal(two.data.latest_draft.preview.length, 80);
    assertChipSafe(two.data.latest_draft.preview);

    // Legacy dirty row (pre-persistence: no stored grade, venom snuck into
    // storage) → the recompute FALLBACK says tighten, and the preview is
    // belt-stripped of PII.
    const drafts = s.vault.listDrafts(dad_id);
    drafts[drafts.length - 1].body_cold = `She is toxic. Call ${PHONE} about the window.`;
    drafts[drafts.length - 1].soft_grade = null;
    const dirty = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    assert.equal(dirty.data.latest_draft.soft_grade, "tighten");
    assert.ok(!dirty.data.latest_draft.preview.includes(PHONE));
    assert.match(dirty.data.latest_draft.preview, /\[phone\]/);

    // Still read-only: no state stamp, no new rows from any of the GETs.
    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.equal(state.data.last_next, null);
    assert.equal(s.vault.listDrafts(dad_id).length, 2);
  } finally {
    await s.close();
  }
});

// RAZOR hard gate: chip_entry's latest_draft.soft_grade must be THE grade
// the draft POST returned — persisted, never recomputed from the cleaned
// body (where the venom that earned "tighten" is already gone).
test("RAZOR: chip_entry soft_grade matches the draft POST grade", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);

    // Exact Razor case: tone flag, storable, graded tighten at POST.
    const post = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/draft",
      { dad_id, body: "This is stupid." },
      { token },
    );
    assert.equal(post.data.written, 1);
    assert.equal(post.data.soft_grade, "tighten");
    const entry = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    assert.equal(entry.data.latest_draft.soft_grade, "tighten", "must match the POST grade");
    assert.equal(entry.data.latest_draft.preview, "This is stupid.");

    // The mismatch class: venom stripped at write → stored body is clean
    // and would recompute "ready" — the STORED grade must still say
    // tighten.
    const venomy = await jsonReq(
      s.base,
      "POST",
      "/vault/comms/draft",
      { dad_id, body: "She is toxic. Meet Saturday at ten." },
      { token },
    );
    assert.equal(venomy.data.soft_grade, "tighten");
    assert.doesNotMatch(venomy.data.body, /toxic/, "venom is gone from storage");
    const entry2 = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    assert.equal(entry2.data.latest_draft.soft_grade, "tighten", "stored grade, not recompute");
    assert.match(entry2.data.latest_draft.preview, /^Meet Saturday at ten\./);

    // Shape, GET-only, and rails all hold.
    assert.deepEqual(Object.keys(entry2.data.latest_draft).sort(), ["preview", "soft_grade"]);
    assert.equal(s.vault.listDrafts(dad_id).length, 2, "GET wrote nothing");
    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.equal(state.data.last_next, null);
    const verified = await jsonReq(
      s.base,
      "GET",
      `/vault/export/verified?dad_id=${dad_id}`,
      null,
      { token },
    );
    assert.deepEqual(verified.data, []);

    // Omit-when-empty still holds for a dad with no drafts.
    const other = await provisionedDad(s.base);
    const none = await jsonReq(
      s.base,
      "GET",
      `/vault/chip_entry?dad_id=${other.dad_id}`,
      null,
      { token: other.token },
    );
    assert.ok(!("latest_draft" in none.data));
  } finally {
    await s.close();
  }
});

test("read-only: chip_entry never stamps last_next or writes anything", async () => {
  const s = await start();
  try {
    const { dad_id, token } = await provisionedDad(s.base);
    await jsonReq(
      s.base,
      "PUT",
      "/vault/state",
      { dad_id, next_action: "pull the OFW thread" },
      { token },
    );
    await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${dad_id}`, null, { token });
    const state = await jsonReq(s.base, "GET", `/vault/state?dad_id=${dad_id}`, null, { token });
    assert.equal(state.data.last_next, null, "GET must not stamp last_next");
    assert.equal((await s.vault.listEvents(dad_id)).length, 0);
  } finally {
    await s.close();
  }
});

test("gates: 404 unknown dad, 401 no token, 403 cross-dad", async () => {
  const s = await start();
  try {
    const a = await provisionedDad(s.base);
    const b = await provisionedDad(s.base);

    const unknown = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${randomUUID()}`);
    assert.equal(unknown.status, 404);

    const noTok = await jsonReq(s.base, "GET", `/vault/chip_entry?dad_id=${a.dad_id}`);
    assert.equal(noTok.status, 401);

    const cross = await jsonReq(
      s.base,
      "GET",
      `/vault/chip_entry?dad_id=${a.dad_id}`,
      null,
      { token: b.token },
    );
    assert.equal(cross.status, 403);
  } finally {
    await s.close();
  }
});
