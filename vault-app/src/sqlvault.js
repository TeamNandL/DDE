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
import { buildNoticeText } from "./pii.js";

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
                                   direction, channel, body_cold, sent_at, draft_kind)
       values (${lit(id)}, ${lit(dadId)}, ${lit(row.pipe)}, ${lit(row.source_ref ?? null)},
               ${lit(row.raw_quote ?? null)}, ${lit(row.direction)}, ${lit(row.channel ?? null)},
               ${lit(row.body_cold ?? null)}, ${lit(row.sent_at ?? null)},
               ${lit(row.draft_kind ?? null)});`,
    );
    log("comm.insert", { table: "communications", id, dad: dadId, pipe: row.pipe });
    return { id, dad_id: dadId, ...row };
  }

  // Drafts only — the never-sent communications (direction='draft').
  async listDrafts(dadId) {
    return (
      (await this.exec(
        `select id, dad_id, pipe, direction, body_cold, draft_kind, created_at
           from communications
          where dad_id = ${lit(dadId)} and direction = 'draft'
          order by created_at;`,
      )) ?? []
    );
  }

  // statement → notice: stamp noticed_at/noticed_text on one of the dad's
  // events (latest by created_at when eventId is null). Pipe untouched —
  // a noticed row stays 'claim' until verified. Requires vault/004_noticed.sql.
  async noticeEvent(dadId, eventId = null) {
    const where = eventId
      ? `dad_id = ${lit(dadId)} and id = ${lit(eventId)}`
      : `dad_id = ${lit(dadId)}`;
    const rows = await this.exec(
      `select id, dad_id, pipe, event_type, occurred_at, scheduled_at, location, notes
         from events
        where ${where}
        order by created_at desc
        limit 1;`,
    );
    const event = rows?.[0];
    if (!event) {
      const e = new Error("unknown event");
      e.status = 404;
      throw e;
    }
    const noticed_text = buildNoticeText(event);
    const updated = await this.exec(
      `update events set noticed_at = now(), noticed_text = ${lit(noticed_text)}
        where id = ${lit(event.id)} and dad_id = ${lit(dadId)}
        returning id, pipe, noticed_at;`,
    );
    log("event.notice", { table: "events", id: event.id, dad: dadId, pipe: event.pipe });
    return {
      event_id: event.id,
      noticed_at: updated?.[0]?.noticed_at ?? new Date().toISOString(),
      noticed_text,
      pipe: event.pipe,
    };
  }

  // Claim chase — update-only. Missing dad → 404 (no silent insert).
  async appendMissing(dadId, item) {
    const existing = await this.getState(dadId);
    if (!existing) {
      const e = new Error("unknown dad");
      e.status = 404;
      throw e;
    }
    await this.exec(
      `update state set
         missing = case when ${lit(item)} = any(state.missing)
                          or cardinality(state.missing) >= 7
                        then state.missing
                        else array_append(state.missing, ${lit(item)}::text) end,
         next_action = coalesce(state.next_action, ${lit(item)}),
         updated_at = now()
       where dad_id = ${lit(dadId)};`,
    );
    log("state.update", { table: "state", dad: dadId });
  }

  // Legacy upsert kept for internal/tools — prefer updateState on HTTP writes.
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

  // PUT /vault/state — update-only. Does not create.
  async updateState(dadId, patch) {
    const existing = await this.getState(dadId);
    if (!existing) {
      const e = new Error("unknown dad");
      e.status = 404;
      throw e;
    }
    await this.exec(
      `update state set
         phase = coalesce(${lit(patch.phase ?? null)}, state.phase),
         this_week = coalesce(${lit(patch.this_week ?? null)}, state.this_week),
         missing = ${patch.missing ? litArr(patch.missing) : "state.missing"},
         next_action = coalesce(${lit(patch.next_action ?? null)}, state.next_action),
         this_week_done = coalesce(${lit(patch.this_week_done ?? null)}::integer, state.this_week_done),
         this_week_total = coalesce(${lit(patch.this_week_total ?? null)}::integer, state.this_week_total),
         last_next_kind = coalesce(${lit(patch.last_next_kind ?? null)}, state.last_next_kind),
         last_ask_summary = coalesce(${lit(patch.last_ask_summary ?? null)}, state.last_ask_summary),
         updated_at = now()
       where dad_id = ${lit(dadId)};`,
    );
    log("state.update", { table: "state", dad: dadId });
    return this.getState(dadId);
  }

  async getState(dadId) {
    const rows = await this.exec(
      `select dad_id, phase, this_week, missing, next_action, last_next,
              last_next_at, this_week_done, this_week_total,
              last_next_kind, last_ask_summary, updated_at
         from state where dad_id = ${lit(dadId)};`,
    );
    return rows?.[0] ?? null;
  }

  // Return loop: stamp last_next = current next_action (see vault.js twin).
  // Empty next_action stamps nothing — a "last time" is never invented.
  // Requires vault/005_return.sql.
  async beginReturn(dadId) {
    const existing = await this.getState(dadId);
    if (!existing) {
      const e = new Error("unknown dad");
      e.status = 404;
      throw e;
    }
    const last_next = existing.next_action ?? null;
    if (last_next) {
      await this.exec(
        `update state set last_next = state.next_action, last_next_at = now(),
                          updated_at = now()
          where dad_id = ${lit(dadId)} and state.next_action is not null;`,
      );
    }
    log("state.return", { table: "state", dad: dadId, has_next: Boolean(last_next) });
    return {
      last_next,
      last_next_kind: existing.last_next_kind ?? null,
      last_ask_summary: existing.last_ask_summary ?? null,
    };
  }

  // POST /vault/provision — insert-only (no ON CONFLICT). GET stays read-only.
  async provisionState(dadId) {
    try {
      await this.exec(
        `insert into state (dad_id, phase, missing, next_action)
         values (${lit(dadId)}, 'intake', '{}'::text[], null);`,
      );
    } catch (err) {
      const msg = String(err?.message || err);
      if (/unique|duplicate|already exists/i.test(msg)) {
        const e = new Error("dad already provisioned");
        e.status = 409;
        throw e;
      }
      throw err;
    }
    log("state.provision", { table: "state", dad: dadId });
    return this.getState(dadId);
  }

  async listEvents(dadId) {
    return (
      (await this.exec(
        `select id, dad_id, pipe, created_at, source_ref, raw_quote, event_type,
                occurred_at, scheduled_at, location, kids, notes,
                noticed_at, noticed_text
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

  /**
   * Postgres FTS search. Always filters by dad_id (caller must supply).
   * Returns { mode: "fts", hits: [{id,type,pipe,snippet,rank,ts,dad_id}] }.
   * Logs never include raw_quote / body text.
   */
  async search(opts) {
    const dadId = opts.dad_id;
    const q = opts.q || "";
    const pipe = opts.pipe || null;
    const type = opts.type || "all";
    const from = opts.from || null;
    const to = opts.to || null;
    const limit = opts.limit || 50;

    const types =
      type === "all"
        ? ["events", "communications", "documents", "state", "month_summary"]
        : [type];

    const arms = [];
    const qLit = lit(q);
    const hasQ = Boolean(q);

    const pipeClause = (alias = "") => {
      const p = alias ? `${alias}.pipe` : "pipe";
      return pipe ? ` and ${p} = ${lit(pipe)}` : "";
    };
    const rangeClause = (col) => {
      let s = "";
      if (from) s += ` and ${col} >= ${lit(from)}::timestamptz`;
      if (to) s += ` and ${col} <= ${lit(to)}::timestamptz`;
      return s;
    };

    if (types.includes("events")) {
      arms.push(`
        select e.id, e.dad_id, e.pipe, 'events'::text as type,
               ${hasQ ? `ts_rank(e.search_tsv, query)` : "0::float"} as rank,
               ${
                 hasQ
                   ? `ts_headline('english', coalesce(e.notes,'') || ' ' || coalesce(e.raw_quote,''), query,
                        'MaxFragments=1, MaxWords=18, MinWords=4')`
                   : `left(coalesce(e.notes, e.raw_quote, ''), 120)`
               } as snippet,
               e.occurred_at as ts
          from events e${hasQ ? `, plainto_tsquery('english', ${qLit}) query` : ""}
         where e.dad_id = ${lit(dadId)}
           ${pipeClause("e")}
           ${rangeClause("e.occurred_at")}
           ${hasQ ? "and e.search_tsv @@ query" : ""}
      `);
    }

    if (types.includes("communications")) {
      arms.push(`
        select c.id, c.dad_id, c.pipe, 'communications'::text as type,
               ${hasQ ? `ts_rank(c.search_tsv, query)` : "0::float"} as rank,
               ${
                 hasQ
                   ? `ts_headline('english', coalesce(c.body_cold,'') || ' ' || coalesce(c.raw_quote,''), query,
                        'MaxFragments=1, MaxWords=18, MinWords=4')`
                   : `left(coalesce(c.body_cold, c.raw_quote, ''), 120)`
               } as snippet,
               coalesce(c.sent_at, c.created_at) as ts
          from communications c${hasQ ? `, plainto_tsquery('english', ${qLit}) query` : ""}
         where c.dad_id = ${lit(dadId)}
           ${pipeClause("c")}
           ${rangeClause("coalesce(c.sent_at, c.created_at)")}
           ${hasQ ? "and c.search_tsv @@ query" : ""}
      `);
    }

    if (types.includes("documents")) {
      arms.push(`
        select d.id, d.dad_id, d.pipe, 'documents'::text as type,
               ${hasQ ? `ts_rank(d.search_tsv, query)` : "0::float"} as rank,
               ${
                 hasQ
                   ? `ts_headline('english', coalesce(d.extracted::text,'') || ' ' || coalesce(d.raw_quote,''), query,
                        'MaxFragments=1, MaxWords=18, MinWords=4')`
                   : `left(coalesce(d.extracted::text, d.raw_quote, ''), 120)`
               } as snippet,
               d.created_at as ts
          from documents d${hasQ ? `, plainto_tsquery('english', ${qLit}) query` : ""}
         where d.dad_id = ${lit(dadId)}
           ${pipeClause("d")}
           ${rangeClause("d.created_at")}
           ${hasQ ? "and d.search_tsv @@ query" : ""}
      `);
    }

    if (types.includes("state")) {
      arms.push(`
        select s.id, s.dad_id, s.pipe, 'state'::text as type,
               ${hasQ ? `ts_rank(s.search_tsv, query)` : "0::float"} as rank,
               ${
                 hasQ
                   ? `ts_headline('english',
                        coalesce(s.this_week,'') || ' ' || coalesce(array_to_string(s.missing,' '),'') || ' ' || coalesce(s.next_action,''),
                        query, 'MaxFragments=1, MaxWords=18, MinWords=4')`
                   : `left(coalesce(s.this_week, s.next_action, ''), 120)`
               } as snippet,
               s.updated_at as ts
          from state s${hasQ ? `, plainto_tsquery('english', ${qLit}) query` : ""}
         where s.dad_id = ${lit(dadId)}
           ${pipeClause("s")}
           ${rangeClause("s.updated_at")}
           ${hasQ ? "and s.search_tsv @@ query" : ""}
      `);
    }

    if (types.includes("month_summary")) {
      arms.push(`
        select m.id, m.dad_id, m.pipe, 'month_summary'::text as type,
               ${hasQ ? `ts_rank(m.search_tsv, query)` : "0::float"} as rank,
               ${
                 hasQ
                   ? `ts_headline('english',
                        coalesce(m.summary_text,'') || ' ' || coalesce(array_to_string(m.highlights,' '),''),
                        query, 'MaxFragments=1, MaxWords=18, MinWords=4')`
                   : `left(coalesce(m.summary_text, ''), 120)`
               } as snippet,
               m.created_at as ts
          from month_summary m${hasQ ? `, plainto_tsquery('english', ${qLit}) query` : ""}
         where m.dad_id = ${lit(dadId)}
           ${pipeClause("m")}
           ${rangeClause("m.created_at")}
           ${hasQ ? "and m.search_tsv @@ query" : ""}
      `);
    }

    if (arms.length === 0) {
      return { mode: "fts", hits: [] };
    }

    const sql = `
      select id, dad_id, pipe, type, rank, snippet, ts
        from (
          ${arms.join("\n union all \n")}
        ) hits
       order by rank desc nulls last, ts desc nulls last
       limit ${Number(limit)};
    `;

    const rows = (await this.exec(sql)) ?? [];
    log("search.fts", {
      dad: dadId,
      hits: rows.length,
      type,
      pipe: pipe || "any",
      q_len: q.length,
    });

    return {
      mode: "fts",
      hits: rows.map((r) => ({
        id: r.id,
        dad_id: r.dad_id,
        type: r.type,
        pipe: r.pipe,
        snippet: r.snippet ?? "",
        rank: Number(r.rank) || 0,
        ts: r.ts,
      })),
    };
  }

}
