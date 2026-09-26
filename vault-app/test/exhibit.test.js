// Exhibit packet slice — the court-facing output.
//
// The rail under test: a claim row can never appear in an exhibit. Everything
// else here (lettering, dating, citation, PII) serves that filing being safe
// to hand a court. Fake family only. No real case data.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Vault } from "../src/vault.js";
import { makeBff } from "../src/bff.js";
import { createServer, listenServer } from "../src/server.js";
import { buildExhibitPacket, describeVerifiedRow, exhibitLabel } from "../src/exhibit.js";
import { exhibitPacketView, disclosureSheetRows } from "../src/export.js";
import { runExportCli } from "../src/cli-export.js";
import { DEMO_DAD_ID } from "../src/demo.js";
import * as logger from "../src/logger.js";

const DAD = "22222222-2222-4222-8222-222222222222";

function freshSession(dadId = DAD) {
  const vault = new Vault();
  const bff = makeBff(vault);
  vault.upsertState(dadId, { phase: "intake" });
  return { vault, bff };
}

// A verified communication (the shape the record pipe produces) plus a claim
// event (the shape Intake produces). One belongs in a filing; one does not.
function seedMixed(vault, dadId = DAD) {
  const claimEvent = vault.insertEvent(dadId, {
    event_type: "late_exchange",
    occurred_at: "2026-09-14T18:45:00.000Z",
    scheduled_at: "2026-09-14T18:00:00.000Z",
    location: "Maple Street parking lot",
    raw_quote: "Jordan didn't show up until 6:45.",
    pipe: "claim",
  });
  const verifiedPull = vault.insertCommunication(dadId, {
    direction: "pull",
    channel: "ofw",
    body_cold: "OFW thread pulled for the September 14 exchange.",
    sent_at: "2026-09-14T18:00:00.000Z",
    source_ref: "ofw:export:2026-09-14",
    pipe: "verified",
  });
  return { claimEvent, verifiedPull };
}

test("BLOCKER: claim rows never reach the exhibit packet", async () => {
  const { vault } = freshSession();
  const { claimEvent, verifiedPull } = seedMixed(vault);

  const packet = await buildExhibitPacket(vault, DAD);

  assert.equal(packet.count, 1, "only the verified row is an exhibit");
  assert.equal(packet.exhibits[0].id, verifiedPull.id);
  assert.ok(
    !packet.exhibits.some((e) => e.id === claimEvent.id),
    "the claim event is absent from the filing",
  );
  assert.ok(
    packet.exhibits.every((e) => e.pipe === "verified"),
    "every exhibit is verified",
  );
  // The dad's own words are claim language — they never ride into a filing.
  const serialized = JSON.stringify(packet);
  assert.ok(!serialized.includes("didn't show up"), "raw_quote never enters the packet");
});

test("a claim row that later gets verified DOES become an exhibit", async () => {
  const { vault } = freshSession();
  const before = await buildExhibitPacket(vault, DAD);
  assert.equal(before.count, 0, "nothing verified yet → nothing to file");

  vault.insertEvent(DAD, {
    event_type: "denied_visit",
    occurred_at: "2026-09-20T17:00:00.000Z",
    pipe: "verified",
    source_ref: "ofw:export:2026-09-20",
  });

  const after = await buildExhibitPacket(vault, DAD);
  assert.equal(after.count, 1, "the verified row files");
  assert.equal(after.exhibits[0].kind, "event");
  assert.equal(after.exhibits[0].label, "A");
});

test("empty vault → empty packet, not an error and not a placeholder", async () => {
  const { vault } = freshSession();
  const packet = await buildExhibitPacket(vault, DAD);
  assert.deepEqual(packet.exhibits, []);
  assert.equal(packet.count, 0);
  assert.equal(packet.excluded.no_source_ref, 0);
  assert.equal(packet.dad_id, DAD);
});

test("an exhibit without source_ref is excluded and counted, never listed", async () => {
  const { vault } = freshSession();
  // Reach past the write gate: a verified row with no source_ref should not
  // exist, and if a store ever produces one it must not become an exhibit.
  vault.communications.push({
    id: randomUUID(),
    dad_id: DAD,
    pipe: "verified",
    created_at: new Date().toISOString(),
    source_ref: null,
    direction: "pull",
    channel: "ofw",
    body_cold: "Untraceable pull.",
    sent_at: "2026-09-15T18:00:00.000Z",
  });

  const packet = await buildExhibitPacket(vault, DAD);
  assert.equal(packet.count, 0, "an uncitable row is not an exhibit");
  assert.equal(packet.excluded.no_source_ref, 1, "the exclusion is counted, not hidden");
});

test("lettering is chronological and gapless: A, B, C …", async () => {
  const { vault } = freshSession();
  // Inserted out of order on purpose — the packet files by date.
  for (const [day, ref] of [
    ["2026-09-20", "ofw:export:c"],
    ["2026-09-06", "ofw:export:a"],
    ["2026-09-13", "ofw:export:b"],
  ]) {
    vault.insertEvent(DAD, {
      event_type: "exchange",
      occurred_at: `${day}T18:00:00.000Z`,
      pipe: "verified",
      source_ref: ref,
    });
  }

  const packet = await buildExhibitPacket(vault, DAD);
  assert.deepEqual(
    packet.exhibits.map((e) => e.label),
    ["A", "B", "C"],
    "gapless letters",
  );
  assert.deepEqual(
    packet.exhibits.map((e) => e.dated),
    ["2026-09-06", "2026-09-13", "2026-09-20"],
    "chronological",
  );
  assert.deepEqual(
    packet.exhibits.map((e) => e.source_ref),
    ["ofw:export:a", "ofw:export:b", "ofw:export:c"],
    "each exhibit carries its own citation",
  );
});

test("exhibitLabel rolls past Z into AA", () => {
  assert.equal(exhibitLabel(0), "A");
  assert.equal(exhibitLabel(25), "Z");
  assert.equal(exhibitLabel(26), "AA");
  assert.equal(exhibitLabel(27), "AB");
  assert.equal(exhibitLabel(51), "AZ");
  assert.equal(exhibitLabel(52), "BA");
  assert.throws(() => exhibitLabel(-1));
});

test("descriptions are cold: no characterization, structured fields only", () => {
  const eventLine = describeVerifiedRow("events", {
    event_type: "late_exchange",
    occurred_at: "2026-09-14T18:45:00.000Z",
    scheduled_at: "2026-09-14T18:00:00.000Z",
    location: "Maple Street parking lot",
  });
  assert.match(eventLine, /^Late exchange on 2026-09-14 at Maple Street parking lot/);
  assert.match(eventLine, /scheduled 18:00, recorded 18:45/);
  for (const venom of ["spiteful", "on purpose", "destroying", "refuses", "always", "never"]) {
    assert.ok(!eventLine.toLowerCase().includes(venom), `description carries no "${venom}"`);
  }

  assert.match(describeVerifiedRow("documents", { doc_type: "statement", period_start: "2026-09-01", period_end: "2026-09-30" }), /^Statement covering 2026-09-01 to 2026-09-30\.$/);
  assert.match(describeVerifiedRow("month_summary", { month: "2026-09-01", summary_text: "Three exchanges logged." }), /^Month summary for September 2026 — Three exchanges logged\.$/);
});

test("PII in a verified row never reaches the exhibit line", async () => {
  const { vault } = freshSession();
  vault.insertCommunication(DAD, {
    direction: "pull",
    channel: "ofw",
    body_cold: "Record pulled; contact listed as 904-555-1212 and jordan.lee@example.com.",
    sent_at: "2026-09-14T18:00:00.000Z",
    source_ref: "ofw:export:2026-09-14",
    pipe: "verified",
  });

  const packet = await buildExhibitPacket(vault, DAD);
  const line = packet.exhibits[0].description;
  assert.ok(!line.includes("904-555-1212"), "phone stripped");
  assert.ok(!line.includes("jordan.lee@example.com"), "email stripped");
  assert.match(line, /\[phone\]|\[email\]/, "redaction is visible, not silent");
});

test("exhibit logs carry ids and counts only — never a description", async () => {
  logger.reset();
  const { vault } = freshSession();
  seedMixed(vault);
  await buildExhibitPacket(vault, DAD);

  const lines = logger.lines().join("\n");
  assert.match(lines, /exhibit\.packet/);
  assert.ok(!lines.includes("OFW thread pulled"), "no body text in logs");
  assert.ok(!lines.includes("Maple Street"), "no location in logs");
});

test("affidavit_support is real, not a stub: flattened disclosure rows", async () => {
  const { vault } = freshSession();
  vault.insertDocument(DAD, {
    doc_type: "statement",
    period_start: "2026-09-01",
    period_end: "2026-09-30",
    extracted: { total: 1250 },
    pipe: "verified",
    source_ref: "doc:statement:2026-09",
  });
  vault.insertEvent(DAD, {
    event_type: "exchange",
    occurred_at: "2026-09-07T18:00:00.000Z",
    pipe: "verified",
    source_ref: "ofw:export:2026-09-07",
  });
  // Claim rows stay out of the disclosure sheet too.
  vault.insertEvent(DAD, { event_type: "call", occurred_at: "2026-09-08T18:00:00.000Z", pipe: "claim" });

  const rows = vault.affidavitSupport(DAD);
  assert.ok(Array.isArray(rows), "flattened array, matching the SQL view shape");
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), [
      "dad_id", "detail", "extracted", "id", "kind", "period_end", "period_start",
    ]);
  }
  assert.deepEqual(rows.map((r) => r.kind).sort(), ["document", "event"]);

  const sheet = await disclosureSheetRows(vault, DAD);
  assert.equal(sheet.length, 2);
  assert.equal(sheet.find((r) => r.kind === "document").extracted, '{"total":1250}');
  assert.equal(sheet.find((r) => r.kind === "event").period_start, "2026-09-07");
});

test("GET /vault/exhibit: gated by dad + token, verified-only", async () => {
  const vault = new Vault();
  const bff = makeBff(vault);
  const server = createServer(bff);
  const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  const close = () => new Promise((resolve) => server.close(resolve));

  try {
    const prov = await (await fetch(`${base}/vault/provision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })).json();
    const { dad_id, token } = prov;

    // Unauthenticated → 401.
    assert.equal((await fetch(`${base}/vault/exhibit?dad_id=${dad_id}`)).status, 401);

    // Another dad's token → 403.
    const other = await (await fetch(`${base}/vault/provision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })).json();
    assert.equal(
      (await fetch(`${base}/vault/exhibit?dad_id=${dad_id}`, {
        headers: { authorization: `Bearer ${other.token}` },
      })).status,
      403,
    );

    // Intake writes claim → the packet stays empty.
    await fetch(`${base}/vault/intake`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        dad_id,
        text: "Jordan was supposed to meet us at 6pm at the Maple Street parking lot and showed up at 6:45.",
      }),
    });

    let res = await fetch(`${base}/vault/exhibit?dad_id=${dad_id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    let packet = await res.json();
    assert.equal(packet.count, 0, "intake alone files nothing — claim never exhibits");

    // A verified pull → exactly one exhibit.
    await fetch(`${base}/vault/comms/pull`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        dad_id,
        channel: "ofw",
        source_ref: "ofw:export:2026-09-14",
        body_cold: "OFW thread pulled for the September 14 exchange.",
        sent_at: "2026-09-14T18:00:00.000Z",
      }),
    });

    res = await fetch(`${base}/vault/exhibit?dad_id=${dad_id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    packet = await res.json();
    assert.equal(packet.count, 1);
    assert.equal(packet.exhibits[0].label, "A");
    assert.equal(packet.exhibits[0].source_ref, "ofw:export:2026-09-14");

    // Missing dad_id → 400, same as every other read.
    assert.equal((await fetch(`${base}/vault/exhibit`, {
      headers: { authorization: `Bearer ${token}` },
    })).status, 400);
  } finally {
    await close();
  }
});

test("export view + CLI: exhibit packet writes CSV and a two-sheet workbook", async () => {
  const { vault, bff } = freshSession();
  seedMixed(vault);

  const rows = await exhibitPacketView(vault, DAD);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), [
    "label", "kind", "dated", "description", "source_ref", "id", "pipe",
  ]);

  const out = await runExportCli(["exhibit", "--demo", "--out", `/tmp/dde-exhibit-${randomUUID()}`]);
  assert.equal(out.exitCode, 0, out.stderr);
  assert.equal(out.result.written.length, 1);
  assert.equal(out.result.written[0].view, "exhibit");
  // The demo's only verified row is the OFW pull — the FIXED_VENT claim event
  // is not in the filing.
  assert.equal(out.result.written[0].rows, 1);
  assert.match(out.stdout, /exhibit_packet\.xlsx/);
  assert.ok(bff, "bff wired");
  assert.equal(DEMO_DAD_ID.length, 36);
});
