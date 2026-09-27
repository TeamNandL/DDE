// Exhibit packet on rented Postgres — app path only:
// BFF → SqlVault → verified_export / affidavit_support → node-postgres.
//
// The memory leg (test/exhibit.test.js) proves the rails; this proves the SQL
// answers identically, including the affidavit_support view the memory vault
// mirrors by hand.
//
// Requires DATABASE_URL (never committed). Without it this SKIPS and the
// Postgres leg counts as BLOCKED, not passed. Fake-family text and throwaway
// UUIDs only; rows created here are deleted at the end.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "../src/env.js";
import { databaseUrl, openStore } from "../src/store.js";
import { makeBff } from "../src/bff.js";
import { buildExhibitPacket } from "../src/exhibit.js";
import { disclosureSheetRows, exhibitPacketView } from "../src/export.js";
import { createServer, listenServer } from "../src/server.js";

const url = databaseUrl();

const VENT =
  "Jordan was supposed to meet us at 6pm at the Maple Street parking lot " +
  "for the exchange and didn't show up until 6:45. She is doing this on " +
  "purpose and she's spiteful.";

test(
  "exhibit packet on rented Postgres — verified only, lettered, cited",
  { skip: url ? false : "BLOCKED: DATABASE_URL not set / database egress unavailable" },
  async () => {
    const store = await openStore({ databaseUrl: url });
    const bff = makeBff(store.vault);
    const dad = randomUUID();

    try {
      await bff.postVaultProvision({ dad_id: dad });

      // Intake writes claim only.
      await bff.postVaultIntake({ dad_id: dad, text: VENT });
      let packet = await buildExhibitPacket(store.vault, dad);
      assert.equal(packet.count, 0, "a vent files nothing — claim never exhibits");
      assert.deepEqual(packet.exhibits, []);

      // The record pipe writes verified, with a source_ref.
      await bff.postCommsPull({
        dad_id: dad,
        channel: "ofw",
        source_ref: "ofw:export:2026-09-14",
        body_cold: "OFW thread pulled for the September 14 exchange.",
        sent_at: "2026-09-14T18:00:00.000Z",
      });
      // A second verified row, earlier — proves the packet files by date, not
      // by insertion order, on the SQL path too.
      await bff.postCommsPull({
        dad_id: dad,
        channel: "email",
        source_ref: "email:export:2026-09-06",
        body_cold: "Email thread pulled for the September 6 exchange.",
        sent_at: "2026-09-06T18:00:00.000Z",
      });

      packet = await buildExhibitPacket(store.vault, dad);
      assert.equal(packet.count, 2);
      assert.deepEqual(packet.exhibits.map((e) => e.label), ["A", "B"]);
      assert.deepEqual(packet.exhibits.map((e) => e.dated), ["2026-09-06", "2026-09-14"]);
      assert.deepEqual(
        packet.exhibits.map((e) => e.source_ref),
        ["email:export:2026-09-06", "ofw:export:2026-09-14"],
      );
      assert.ok(packet.exhibits.every((e) => e.pipe === "verified"));
      // The venom in the vent never reaches a filing, by any route.
      const serialized = JSON.stringify(packet);
      assert.ok(!serialized.includes("spiteful"));
      assert.ok(!serialized.includes("on purpose"));
      assert.ok(!/Maple Street/.test(serialized), "claim-row location stays out of the packet");

      // BFF route returns the same packet.
      const viaBff = await bff.getVaultExhibit({ dad_id: dad });
      assert.equal(viaBff.count, 2);

      // Spreadsheet view over the SQL store.
      const rows = await exhibitPacketView(store.vault, dad);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].label, "A");

      // affidavit_support on the SQL path: verified documents + verified
      // events, flattened the same way the memory vault does it.
      const beforeDisclosure = await disclosureSheetRows(store.vault, dad);
      assert.deepEqual(beforeDisclosure, [], "no verified documents or events yet");

      // NOTE: the document arm of affidavit_support is covered on the memory
      // leg only — SqlVault has no insertDocument (documents get their app
      // write path in Phase 4), and seeding one by raw SQL would bypass the
      // app path this leg exists to prove. The event arm runs here.
      await store.vault.insertEvent(dad, {
        event_type: "exchange",
        occurred_at: "2026-09-07T18:00:00.000Z",
        pipe: "verified",
        source_ref: "ofw:export:2026-09-07",
      });

      const disclosure = await disclosureSheetRows(store.vault, dad);
      assert.equal(disclosure.length, 1, "one verified event, no verified documents");
      const ev = disclosure[0];
      assert.equal(ev.kind, "event");
      assert.equal(ev.detail, "exchange");
      assert.equal(ev.period_start, "2026-09-07");
      assert.equal(ev.period_end, "2026-09-07");
      assert.equal(ev.extracted, "", "events carry no extracted figures");
      assert.equal(ev.dad_id, dad);

      // The verified event is an exhibit now as well.
      const finalPacket = await buildExhibitPacket(store.vault, dad);
      assert.equal(finalPacket.count, 3);
      assert.deepEqual(finalPacket.exhibits.map((e) => e.label), ["A", "B", "C"]);
      assert.deepEqual(
        finalPacket.exhibits.map((e) => e.kind),
        ["communication", "event", "communication"],
        "2026-09-06 email, 2026-09-07 event, 2026-09-14 OFW",
      );
    } finally {
      // Throwaway tenant — leave the database as it was found.
      for (const t of ["events", "communications", "documents", "month_summary", "state"]) {
        await store.query(`delete from ${t} where dad_id = $1`, [dad]);
      }
      await store.close();
    }
  },
);

// Slice 18 turned on Postgres RLS: reads run as the non-owner role dde_app
// with dde.dad_id set transaction-locally. The bearer matrix asserts this
// route answers 200 — but an empty packet is also a 200, and a filing that
// silently comes back with zero exhibits is the worst failure this slice
// has. So prove the content survives RLS, over real HTTP, not just the
// status code.
test(
  "exhibit over HTTP under RLS: the filing is not silently empty, and stays verified-only",
  { skip: url ? false : "BLOCKED: DATABASE_URL not set / database egress unavailable" },
  async () => {
    const store = await openStore({ databaseUrl: url });
    const bff = makeBff(store.vault, { tokenStore: store.tokenStore });
    const server = createServer(bff);
    const addr = await listenServer(server, { host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${addr.port}`;
    const close = () => new Promise((resolve) => server.close(resolve));

    const req = async (method, path, body, token) => {
      const headers = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    };

    let dad;
    try {
      const prov = await req("POST", "/vault/provision", {});
      assert.equal(prov.status, 200);
      const { dad_id, token } = prov.data;
      dad = dad_id;

      // One verified, citable row — the only kind that may be filed.
      const pull = await req(
        "POST",
        "/vault/comms/pull",
        {
          dad_id,
          channel: "ofw",
          source_ref: "ofw:export:2026-09-14",
          body_cold: "OFW thread pulled for the September 14 exchange.",
          sent_at: "2026-09-14T18:00:00.000Z",
        },
        token,
      );
      assert.equal(pull.status, 200);

      // One claim row, which must never reach the filing.
      await req("POST", "/vault/intake", { dad_id, text: VENT }, token);

      const res = await req("GET", `/vault/exhibit?dad_id=${dad_id}`, null, token);
      assert.equal(res.status, 200);
      assert.equal(res.data.count, 1, "RLS must not zero out the filing");
      assert.equal(res.data.exhibits.length, 1);
      const [ex] = res.data.exhibits;
      assert.equal(ex.label, "A");
      assert.equal(ex.pipe, "verified");
      assert.equal(ex.source_ref, "ofw:export:2026-09-14");
      assert.equal(ex.dated, "2026-09-14");
      // The vent's venom and location never enter a filing, RLS or not.
      const serialized = JSON.stringify(res.data);
      assert.ok(!serialized.includes("spiteful"));
      assert.ok(!/Maple Street/.test(serialized));
    } finally {
      await close();
      if (dad) {
        for (const t of ["events", "communications", "documents", "month_summary", "state"]) {
          await store.query(`delete from ${t} where dad_id = $1`, [dad]);
        }
      }
      await store.close();
    }
  },
);
