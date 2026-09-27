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

// Dates come back as text so memory and Postgres rows compare the same.
const CANDIDATE_COLS = `id, dad_id, pipe, created_at, source, source_event_id, quote, who, what,
  when_text, to_char(when_on, 'YYYY-MM-DD') as when_on, kids, cues, confidence, review, status, ofw_ref, line`;
const NOTIFICATION_COLS = `id, dad_id, created_at, kind, slot,
  to_char(for_date, 'YYYY-MM-DD') as for_date, title, due_start, due_end, status`;

const TRANSLATION_COLS = `id, dad_id, created_at, input_kind, input_cold, term_keys, verdict_request,
  clock_flag, result`;
const TRANSLATOR_CAND_COLS = `id, dad_id, translation_id, created_at, label, date_text,
  to_char(on_date, 'YYYY-MM-DD') as on_date, visibility, status`;

const INVOLVEMENT_COLS = `dad_id, kid_key, field_key, position, value,
  to_char(asked_on, 'YYYY-MM-DD') as asked_on, asked_via, outcome, source, claim_status, updated_at`;

const LEGAL_INTAKE_COLS = `id, dad_id, created_at, who, what_cold, urgency, flags, route, claim_status`;
const HANDOFF_COLS = `id, intake_id, dad_id, version, body, created_at, sent_at`;

const PLAN_TOPIC_COLS = `dad_id, topic_key, position, status, choice, detail, stance, depth,
  example_shown, updated_at`;

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
                                   direction, channel, body_cold, sent_at, draft_kind, soft_grade)
       values (${lit(id)}, ${lit(dadId)}, ${lit(row.pipe)}, ${lit(row.source_ref ?? null)},
               ${lit(row.raw_quote ?? null)}, ${lit(row.direction)}, ${lit(row.channel ?? null)},
               ${lit(row.body_cold ?? null)}, ${lit(row.sent_at ?? null)},
               ${lit(row.draft_kind ?? null)}, ${lit(row.soft_grade ?? null)});`,
    );
    log("comm.insert", { table: "communications", id, dad: dadId, pipe: row.pipe });
    return { id, dad_id: dadId, ...row };
  }

  // Drafts only — the never-sent communications (direction='draft').
  async listDrafts(dadId) {
    return (
      (await this.exec(
        `select id, dad_id, pipe, direction, body_cold, draft_kind, soft_grade, created_at
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

  // ---- court-prep (vault/010_court_prep.sql) -------------------------------

  async insertCandidate(dadId, row) {
    const id = randomUUID();
    const rows = await this.exec(
      `insert into candidate_facts (id, dad_id, source, source_event_id, quote, who, what,
                                    when_text, when_on, kids, cues, status, ofw_ref, line)
       values (${lit(id)}, ${lit(dadId)}, ${lit(row.source)}, ${lit(row.source_event_id ?? null)},
               ${lit(row.quote ?? null)}, ${litArr(row.who)}, ${lit(row.what)},
               ${lit(row.when_text ?? null)}, ${lit(row.when_on ?? null)}, ${litArr(row.kids)},
               ${litArr(row.cues)}, ${lit(row.status ?? "not_proof_yet")}, ${lit(row.ofw_ref ?? null)},
               ${lit(row.line)})
       returning ${CANDIDATE_COLS};`,
    );
    log("candidate.insert", { table: "candidate_facts", id, dad: dadId, status: row.status ?? "not_proof_yet" });
    return rows?.[0] ?? { id, dad_id: dadId, ...row };
  }

  async listCandidates(dadId) {
    return (
      (await this.exec(
        `select ${CANDIDATE_COLS} from candidate_facts
          where dad_id = ${lit(dadId)} order by created_at, id;`,
      )) ?? []
    );
  }

  async updateCandidateCheck(dadId, id, { status, ofw_ref, line }) {
    const rows = await this.exec(
      `update candidate_facts set status = ${lit(status)}, ofw_ref = ${lit(ofw_ref ?? null)},
              line = ${lit(line)}
        where dad_id = ${lit(dadId)} and id = ${lit(id)}
        returning ${CANDIDATE_COLS};`,
    );
    return rows?.[0] ?? null;
  }

  async setCandidateReview(dadId, id, review) {
    const rows = await this.exec(
      `update candidate_facts set review = ${lit(review)}
        where dad_id = ${lit(dadId)} and id = ${lit(id)}
        returning ${CANDIDATE_COLS};`,
    );
    return rows?.[0] ?? null;
  }

  async listOfwPulls(dadId) {
    return (
      (await this.exec(
        `select id, source_ref, body_cold, sent_at from communications
          where dad_id = ${lit(dadId)} and direction = 'pull' and channel = 'ofw'
            and pipe = 'verified';`,
      )) ?? []
    );
  }

  async ensureNotifications(dadId, items) {
    let created = 0;
    for (const it of items) {
      const rows = await this.exec(
        `insert into notifications (id, dad_id, kind, slot, for_date, title, due_start, due_end)
         values (${lit(randomUUID())}, ${lit(dadId)}, ${lit(it.kind)}, ${lit(it.slot)},
                 ${lit(it.for_date)}, ${lit(it.title)}, ${lit(it.due_start)}, ${lit(it.due_end)})
         on conflict (dad_id, kind, for_date, slot) do nothing
         returning id;`,
      );
      created += rows?.length ?? 0;
    }
    return created;
  }

  async listNotifications(dadId) {
    return (
      (await this.exec(
        `select ${NOTIFICATION_COLS} from notifications
          where dad_id = ${lit(dadId)} order by due_start, slot;`,
      )) ?? []
    );
  }

  async setNotificationStatus(dadId, id, status) {
    const rows = await this.exec(
      `update notifications set status = ${lit(status)}
        where dad_id = ${lit(dadId)} and id = ${lit(id)}
        returning ${NOTIFICATION_COLS};`,
    );
    return rows?.[0] ?? null;
  }

  async completeOpenCheckins(dadId, nowIso) {
    const rows = await this.exec(
      `update notifications set status = 'done'
        where dad_id = ${lit(dadId)} and status <> 'done'
          and due_start <= ${lit(nowIso)} and ${lit(nowIso)} <= due_end
        returning id;`,
    );
    return rows?.length ?? 0;
  }

  // ---- parenting plan (vault/011_parenting_plan.sql) ----------------------

  async ensurePlanTopics(dadId, topics) {
    let created = 0;
    for (const { key, position } of topics) {
      const rows = await this.exec(
        `insert into plan_topics (dad_id, topic_key, position)
         values (${lit(dadId)}, ${lit(key)}, ${Number(position)})
         on conflict (dad_id, topic_key) do nothing
         returning topic_key;`,
      );
      created += rows?.length ?? 0;
    }
    return created;
  }

  async listPlanTopics(dadId) {
    return (
      (await this.exec(
        `select ${PLAN_TOPIC_COLS} from plan_topics
          where dad_id = ${lit(dadId)} order by position;`,
      )) ?? []
    );
  }

  async updatePlanTopic(dadId, key, patch) {
    const sets = [];
    for (const col of ["status", "choice", "detail", "stance", "depth"]) {
      if (col in patch) sets.push(`${col} = ${lit(patch[col])}`);
    }
    if ("example_shown" in patch) sets.push(`example_shown = ${patch.example_shown ? "true" : "false"}`);
    sets.push("updated_at = now()");
    const rows = await this.exec(
      `update plan_topics set ${sets.join(", ")}
        where dad_id = ${lit(dadId)} and topic_key = ${lit(key)}
        returning ${PLAN_TOPIC_COLS};`,
    );
    return rows?.[0] ?? null;
  }

  async insertPlanDraft(dadId, { kind, body }) {
    const id = randomUUID();
    const rows = await this.exec(
      `insert into plan_drafts (id, dad_id, version, kind, body)
       select ${lit(id)}, ${lit(dadId)}, coalesce(max(version), 0) + 1, ${lit(kind)}, ${lit(body)}
         from plan_drafts where dad_id = ${lit(dadId)}
       returning id, dad_id, version, kind, body, created_at;`,
    );
    const rec = rows?.[0];
    log("plan.draft", { table: "plan_drafts", id, dad: dadId, version: rec?.version, kind });
    return rec;
  }

  async latestPlanDraft(dadId, kind) {
    const rows = await this.exec(
      `select id, dad_id, version, kind, body, created_at from plan_drafts
        where dad_id = ${lit(dadId)} and kind = ${lit(kind)}
        order by version desc limit 1;`,
    );
    return rows?.[0] ?? null;
  }

  // ---- process translator (vault/012_process_translator.sql) ---------------

  async insertTranslation(dadId, t, candidates = []) {
    const id = randomUUID();
    const rows = await this.exec(
      `insert into translations (id, dad_id, input_kind, input_cold, term_keys, verdict_request, clock_flag, result)
       values (${lit(id)}, ${lit(dadId)}, ${lit(t.input_kind)}, ${lit(t.input_cold)}, ${litArr(t.term_keys)},
               ${t.verdict_request ? "true" : "false"}, ${t.clock_flag ? "true" : "false"},
               ${lit(JSON.stringify(t.result))}::jsonb)
       returning ${TRANSLATION_COLS};`,
    );
    const cands = [];
    for (const c of candidates) {
      const cr = await this.exec(
        `insert into translator_calendar_candidates (id, dad_id, translation_id, label, date_text, on_date)
         values (${lit(randomUUID())}, ${lit(dadId)}, ${lit(id)}, ${lit(c.label)}, ${lit(c.date_text)},
                 ${c.on_date ? `${lit(c.on_date)}::date` : "null"})
         returning ${TRANSLATOR_CAND_COLS};`,
      );
      cands.push(cr[0]);
    }
    log("translate.insert", { table: "translations", id, dad: dadId, kind: t.input_kind, cands: cands.length });
    return { ...rows[0], calendar_candidates: cands };
  }

  async _withCands(rec) {
    if (!rec) return null;
    const cands =
      (await this.exec(
        `select ${TRANSLATOR_CAND_COLS} from translator_calendar_candidates
          where translation_id = ${lit(rec.id)} order by created_at, on_date;`,
      )) ?? [];
    return { ...rec, calendar_candidates: cands };
  }

  async getTranslation(dadId, id) {
    const rows = await this.exec(
      `select ${TRANSLATION_COLS} from translations where dad_id = ${lit(dadId)} and id = ${lit(id)};`,
    );
    return this._withCands(rows?.[0]);
  }

  async lastTranslation(dadId) {
    const rows = await this.exec(
      `select ${TRANSLATION_COLS} from translations where dad_id = ${lit(dadId)}
        order by created_at desc, id desc limit 1;`,
    );
    return this._withCands(rows?.[0]);
  }

  async listTranslations(dadId, limit = 20) {
    return (
      (await this.exec(
        `select id, created_at, input_kind, term_keys, verdict_request, clock_flag from translations
          where dad_id = ${lit(dadId)} order by created_at desc, id desc limit ${Number(limit)};`,
      )) ?? []
    );
  }

  // ---- involvement cheat sheet (vault/013_involvement.sql) ----------------

  async ensureInvolvement(dadId, kidKey, fields) {
    let created = 0;
    for (const { key, position } of fields) {
      const rows = await this.exec(
        `insert into involvement_fields (dad_id, kid_key, field_key, position)
         values (${lit(dadId)}, ${lit(kidKey)}, ${lit(key)}, ${Number(position)})
         on conflict (dad_id, kid_key, field_key) do nothing
         returning field_key;`,
      );
      created += rows?.length ?? 0;
    }
    return created;
  }

  async listInvolvementKids(dadId) {
    const rows =
      (await this.exec(
        `select distinct kid_key from involvement_fields where dad_id = ${lit(dadId)} order by kid_key;`,
      )) ?? [];
    return rows.map((r) => r.kid_key);
  }

  async listInvolvement(dadId, kidKey) {
    return (
      (await this.exec(
        `select ${INVOLVEMENT_COLS} from involvement_fields
          where dad_id = ${lit(dadId)} and kid_key = ${lit(kidKey)} order by position;`,
      )) ?? []
    );
  }

  async updateInvolvementField(dadId, kidKey, key, patch) {
    const sets = [];
    for (const col of ["value", "asked_via", "outcome"]) {
      if (col in patch) sets.push(`${col} = ${lit(patch[col])}`);
    }
    if ("asked_on" in patch) sets.push(`asked_on = ${patch.asked_on ? `${lit(patch.asked_on)}::date` : "null"}`);
    sets.push("updated_at = now()");
    const rows = await this.exec(
      `update involvement_fields set ${sets.join(", ")}
        where dad_id = ${lit(dadId)} and kid_key = ${lit(kidKey)} and field_key = ${lit(key)}
        returning ${INVOLVEMENT_COLS};`,
    );
    log("involvement.update", { table: "involvement_fields", dad: dadId, field: key });
    return rows?.[0] ?? null;
  }

  // ---- legal intake (vault/014_legal_intake.sql) ---------------------------

  async insertLegalIntake(dadId, c) {
    const id = randomUUID();
    const rows = await this.exec(
      `insert into legal_intakes (id, dad_id, who, what_cold, urgency, flags, route)
       values (${lit(id)}, ${lit(dadId)}, ${lit(c.who)}, ${lit(c.what_cold)}, ${lit(c.urgency)},
               ${litArr(c.flags)}, ${lit(c.route)})
       returning ${LEGAL_INTAKE_COLS};`,
    );
    log("legal.intake", { table: "legal_intakes", id, dad: dadId, route: c.route });
    return rows?.[0] ?? null;
  }

  async getLegalIntake(dadId, id) {
    const rows = await this.exec(
      `select ${LEGAL_INTAKE_COLS} from legal_intakes where dad_id = ${lit(dadId)} and id = ${lit(id)};`,
    );
    return rows?.[0] ?? null;
  }

  async latestLegalIntake(dadId) {
    const rows = await this.exec(
      `select ${LEGAL_INTAKE_COLS} from legal_intakes where dad_id = ${lit(dadId)}
        order by created_at desc, id desc limit 1;`,
    );
    return rows?.[0] ?? null;
  }

  async latestHandoffDraft(intakeId) {
    const rows = await this.exec(
      `select ${HANDOFF_COLS} from legal_handoff_drafts where intake_id = ${lit(intakeId)}
        order by version desc limit 1;`,
    );
    return rows?.[0] ?? null;
  }

  async insertHandoffDraft(dadId, intakeId, version, body) {
    const id = randomUUID();
    const rows = await this.exec(
      `insert into legal_handoff_drafts (id, intake_id, dad_id, version, body)
       values (${lit(id)}, ${lit(intakeId)}, ${lit(dadId)}, ${Number(version)}, ${lit(body)})
       returning ${HANDOFF_COLS};`,
    );
    log("legal.handoff", { table: "legal_handoff_drafts", id, dad: dadId, version });
    return rows?.[0] ?? null;
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

  // ---- Slice 21: export + delete. Called from the operator path (unscoped
  // owner) or, for export, inside a bound request where RLS limits rows to
  // the dad anyway. ---------------------------------------------------------

  static DAD_TABLES = [
    "events", "communications", "documents", "month_summary", "state",
    "candidate_facts", "notifications", "plan_topics", "plan_drafts",
    "translations", "translator_calendar_candidates", "involvement_fields",
    "legal_intakes", "legal_handoff_drafts",
  ];

  async exportAll(dadId) {
    const out = {};
    for (const t of SqlVault.DAD_TABLES) {
      out[t] = (await this.exec(`select * from ${t} where dad_id = ${lit(dadId)};`)) ?? [];
    }
    return out;
  }

  /** HARD wipe: children before parents (FKs). Returns counts removed. */
  async wipeDad(dadId) {
    const counts = {};
    const order = [
      "legal_handoff_drafts", "legal_intakes",
      "translator_calendar_candidates", "translations",
      "plan_drafts", "plan_topics", "involvement_fields",
      "notifications", "candidate_facts",
      "month_summary", "documents", "communications", "events",
      "state",
    ];
    for (const t of order) {
      const rows = (await this.exec(`delete from ${t} where dad_id = ${lit(dadId)} returning 1;`)) ?? [];
      counts[t] = rows.length;
    }
    return counts;
  }

  async verifiedExport(dadId) {
    return (
      (await this.exec(
        `select source_table, id, dad_id, pipe, created_at, source_ref, row
           from verified_export where dad_id = ${lit(dadId)};`,
      )) ?? []
    );
  }

  // affidavit_support view — verified documents + verified events, the
  // financial-disclosure sheet. Mirrors the memory vault's flattened shape.
  async affidavitSupport(dadId) {
    return (
      (await this.exec(
        `select dad_id, kind, id, detail, extracted, period_start, period_end
           from affidavit_support where dad_id = ${lit(dadId)}
          order by period_start nulls last, id;`,
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
