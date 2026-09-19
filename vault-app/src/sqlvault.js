// SqlVault — the Postgres-backed vault path (rented Postgres, vault/001_schema.sql).
//
// Same interface as the in-memory Vault, async. All I/O goes through one
// injected executor so the transport is swappable without touching vault
// logic:
//
//   exec(sql) -> Promise<rows[]>
//
// Transport: node-postgres Pool against DATABASE_URL — the connection
// string with its password lives ONLY in the environment, never in this
// repo. See test/phase1.pg.test.js. This module IS the app write path to
// rented Postgres; console SQL or any channel that bypasses it proves
// nothing.
//
// Every operation is a single self-contained statement — no
// read-modify-write across calls.

import { randomUUID } from "node:crypto";
import { log } from "./logger.js";

// SQL literal helpers. Values are embedded (not bound) because the emit
// transport needs full statements; everything funnels through these quoters.
function lit(v) {
  if (v === null || v === undefined) return "null";
  return `'${String(v).replace(/'/g, "''")}'`;
}
function litArr(arr) {
  if (!arr || arr.length === 0) return "'{}'::text[]";
  return `array[${arr.map(lit).join(",")}]::text[]`;
}

export class SqlVault {
  constructor(exec) {
    this.exec = exec;
  }

  async insertEvent(dadId, row) {
    const id = randomUUID();
    const rows = await this.exec(
      `insert into events (id, dad_id, pipe, source_ref, raw_quote, event_type,
                           occurred_at, scheduled_at, location, kids, notes)
       values (${lit(id)}, ${lit(dadId)}, ${lit(row.pipe)}, ${lit(row.source_ref ?? null)},
               ${lit(row.raw_quote ?? null)}, ${lit(row.event_type)}, ${lit(row.occurred_at)},
               ${lit(row.scheduled_at ?? null)}, ${lit(row.location ?? null)},
               ${litArr(row.kids)}, ${lit(row.notes ?? null)})
       returning id, dad_id, pipe;`,
    );
    log("event.insert", { table: "events", id, dad: dadId, pipe: row.pipe });
    return { id, dad_id: dadId, ...row, ...(rows?.[0] ?? {}) };
  }

  async insertCommunication(dadId, row) {
    const id = randomUUID();
    await this.exec(
      `insert into communications (id, dad_id, pipe, source_ref, raw_quote,
                                   direction, channel, body_cold, sent_at)
       values (${lit(id)}, ${lit(dadId)}, ${lit(row.pipe)}, ${lit(row.source_ref ?? null)},
               ${lit(row.raw_quote ?? null)}, ${lit(row.direction)}, ${lit(row.channel ?? null)},
               ${lit(row.body_cold ?? null)}, ${lit(row.sent_at ?? null)});`,
    );
    log("comm.insert", { table: "communications", id, dad: dadId, pipe: row.pipe });
    return { id, dad_id: dadId, ...row };
  }

  // One statement: upsert state, append the chase item if absent, and make
  // it the next_action when none is set (Edge needs exactly one).
  async appendMissing(dadId, item) {
    await this.exec(
      `insert into state (dad_id, missing, next_action)
       values (${lit(dadId)}, ${litArr([item])}, ${lit(item)})
       on conflict (dad_id) do update set
         missing = case when ${lit(item)} = any(state.missing)
                        then state.missing
                        else array_append(state.missing, ${lit(item)}::text) end,
         next_action = coalesce(state.next_action, ${lit(item)}),
         updated_at = now();`,
    );
    log("state.upsert", { table: "state", dad: dadId });
  }

  async upsertState(dadId, patch) {
    await this.exec(
      `insert into state (dad_id, phase, this_week, missing, next_action)
       values (${lit(dadId)}, ${lit(patch.phase ?? "intake")}, ${lit(patch.this_week ?? null)},
               ${litArr(patch.missing)}, ${lit(patch.next_action ?? null)})
       on conflict (dad_id) do update set
         phase = coalesce(${lit(patch.phase ?? null)}, state.phase),
         this_week = coalesce(${lit(patch.this_week ?? null)}, state.this_week),
         missing = ${patch.missing ? litArr(patch.missing) : "state.missing"},
         next_action = coalesce(${lit(patch.next_action ?? null)}, state.next_action),
         updated_at = now();`,
    );
    log("state.upsert", { table: "state", dad: dadId });
    return this.getState(dadId);
  }

  async getState(dadId) {
    const rows = await this.exec(
      `select dad_id, phase, this_week, missing, next_action, updated_at
         from state where dad_id = ${lit(dadId)};`,
    );
    return rows?.[0] ?? null;
  }

  async listEvents(dadId) {
    return (
      (await this.exec(
        `select id, dad_id, pipe, created_at, source_ref, raw_quote, event_type,
                occurred_at, scheduled_at, location, kids, notes
           from events
          where dad_id = ${lit(dadId)}
          order by occurred_at;`,
      )) ?? []
    );
  }

  async verifiedExport(dadId) {
    return (
      (await this.exec(
        `select source_table, id, dad_id, pipe, created_at, source_ref, row
           from verified_export where dad_id = ${lit(dadId)};`,
      )) ?? []
    );
  }

  // Row counts per table for a dad — used by the harm-discard assertion.
  async countRows(dadId) {
    const rows = await this.exec(
      `select (select count(*) from events where dad_id = ${lit(dadId)}) as events,
              (select count(*) from communications where dad_id = ${lit(dadId)}) as communications,
              (select count(*) from documents where dad_id = ${lit(dadId)}) as documents,
              (select count(*) from month_summary where dad_id = ${lit(dadId)}) as month_summary,
              (select count(*) from state where dad_id = ${lit(dadId)}) as state;`,
    );
    return rows?.[0] ?? null;
  }
}
