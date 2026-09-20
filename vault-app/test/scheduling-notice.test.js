// Sweeper NOTICE_POST_GAPS: OFW-style scheduling/refusal text with dates
// must write a claim and produce noticed_text WITHOUT emotion words.
// Claim ≠ verified and PII-strip-first stay intact. Fake family only.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import { extractFields, parseMentionedDate } from "../src/extract.js";

const REF = new Date("2026-09-20T12:00:00");

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

// ---------------------------------------------------------------------------
// Units.

test("parseMentionedDate: on/for + month-name or slash; future allowed; junk null", () => {
  assert.equal(parseMentionedDate("for October 3", REF), "2026-10-03");
  assert.equal(parseMentionedDate("for October 3rd, 2025", REF), "2025-10-03");
  assert.equal(parseMentionedDate("on 9/12", REF), "2026-09-12");
  assert.equal(parseMentionedDate("on 9/12/25", REF), "2025-09-12");
  // Future stays future — a refused upcoming weekend is a real date.
  assert.equal(parseMentionedDate("for October 3", new Date("2026-09-20")), "2026-10-03");
  assert.equal(parseMentionedDate("on the schedule", REF), null);
});

test("extractFields: OFW-style refusal/schedule claims fire without emotion words", () => {
  // Declined makeup weekend, dated, future.
  const declined = extractFields("She declined the makeup weekend I proposed for October 3.", {
    referenceDate: REF,
  });
  assert.equal(declined.length, 1);
  assert.equal(declined[0].event_type, "denied_visit");
  assert.equal(declined[0].occurred_at, "2026-10-03T12:00:00.000Z");
  assert.match(declined[0].notes, /Reported date: 2026-10-03/);

  // "can't come" + dated.
  const cantCome = extractFields("On 9/12 she said Sam can't come to my weekend.", {
    referenceDate: REF,
  });
  assert.equal(cantCome.length, 1);
  assert.equal(cantCome[0].event_type, "denied_visit");
  assert.equal(cantCome[0].occurred_at, "2026-09-12T12:00:00.000Z");
  assert.deepEqual(cantCome[0].kids, ["Sam"]);

  // Keeping the kids.
  const keeping = extractFields(
    "She is keeping the kids this weekend even though it is my scheduled time.",
    { referenceDate: REF },
  );
  assert.equal(keeping.length, 1);
  assert.equal(keeping[0].event_type, "denied_visit");

  // Schedule change, no refusal verb.
  const moved = extractFields("She moved the pickup from Saturday to Sunday again.", {
    referenceDate: REF,
  });
  assert.equal(moved.length, 1);
  assert.equal(moved[0].event_type, "other");
  assert.match(moved[0].notes, /Schedule change reported\./);

  // Limited time + date, ZERO emotion words (the Sweeper case).
  const limited = extractFields("Limited time with the kids since 4/19.", {
    referenceDate: REF,
  });
  assert.equal(limited.length, 1);
  assert.match(limited[0].notes, /limited time with the children since 2026-04-19/);

  // Neutral OFW text still writes nothing.
  assert.equal(
    extractFields("Thanks for confirming Thursday's dinner.", { referenceDate: REF }).length,
    0,
  );
});

// ---------------------------------------------------------------------------
// HTTP: written>=1 and a cold noticed_text for each Sweeper shape.

test("scheduling/refusal vents → written>=1 + non-empty noticed_text; claim never verified; PII stripped", async () => {
  const s = await start();
  try {
    const vents = [
      "She declined the makeup weekend I proposed for October 3.",
      "On 9/12 she said the kids can't come to my weekend.",
      "She moved the pickup from Saturday to Sunday without agreement.",
      "Limited time with the kids since 4/19.",
    ];
    for (const text of vents) {
      const dad_id = randomUUID();
      const prov = await jsonReq(s.base, "POST", "/vault/provision", { dad_id });
      const token = prov.data.token;
      const intake = await jsonReq(
        s.base,
        "POST",
        "/vault/intake",
        { dad_id, text: `${text} My cell is 904-555-1212.`, make_notice: true },
        { token },
      );
      assert.equal(intake.status, 200, text);
      assert.ok(intake.data.written >= 1, `written=0 for: ${text}`);
      const noticed = intake.data.noticed_text;
      assert.ok(typeof noticed === "string" && noticed.trim().length > 0, `empty notice: ${text}`);
      assert.match(noticed, /parent statement \(claim\)/);
      assert.doesNotMatch(noticed, /904-555-1212/, `PII in notice: ${text}`);

      const [event] = await s.vault.listEvents(dad_id);
      assert.equal(event.pipe, "claim");

      const verified = await jsonReq(
        s.base,
        "GET",
        `/vault/export/verified?dad_id=${dad_id}`,
        null,
        { token },
      );
      assert.deepEqual(verified.data, [], `claim leaked to export: ${text}`);
    }
  } finally {
    await s.close();
  }
});

test("dated refusal notice carries the named date, not the venting day", async () => {
  const s = await start();
  const dad_id = randomUUID();
  try {
    const prov = await jsonReq(s.base, "POST", "/vault/provision", { dad_id });
    const token = prov.data.token;
    const intake = await jsonReq(
      s.base,
      "POST",
      "/vault/intake",
      { dad_id, text: "She declined my request for the exchange on 9/12.", make_notice: true },
      { token },
    );
    assert.equal(intake.status, 200);
    assert.match(intake.data.noticed_text, /2026-09-12/);
  } finally {
    await s.close();
  }
});
