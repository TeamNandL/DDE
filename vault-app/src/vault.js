// In-memory vault — local proof of the §3 schema semantics.
//
// Tables: events, communications, documents, state, month_summary.
// Every row (state included) carries the common columns:
//   id, dad_id, pipe ('claim' | 'verified' — no third value, no null),
//   created_at, source_ref, raw_quote.
// state is one row per dad_id, upserted.
//
// This file is the semantic twin of vault/001_schema.sql (to be refined on
// rented Postgres only after Nick's exact-yes). Checks that Postgres would
// enforce as constraints are thrown errors here.

import { randomUUID } from "node:crypto";
import { log } from "./logger.js";
import { buildNoticeText } from "./pii.js";
import { makeSnippet, textIncludes } from "./search.js";

const PIPES = new Set(["claim", "verified"]);

const EVENT_TYPES = new Set([
  "exchange",
  "denied_visit",
  "late_exchange",
  "visit",
  "call",
  "other",
]);

// 'draft' = never sent (sent_at null) and never verified — draft ≠ send.
const DIRECTIONS = new Set(["outgoing", "incoming", "pull", "draft"]);

const DOC_TYPES = new Set([
  "statement",
  "tax_return",
  "photo",
  "screenshot",
  "court",
  "other",
]);

// Rail (§3 month_summary, §9): pattern tags are observable behavior only.
// Allowlist — anything outside it (including any personality or clinical
// term) is rejected at the write path.
const PATTERN_TAGS = new Set([
  "late_exchange",
  "denied_visit",
  "schedule_change",
]);

const CANDIDATE_WHATS = new Set(["cancelled", "attended", "late", "time_with", "schedule", "mention"]);
const CANDIDATE_STATUSES = new Set(["not_proof_yet", "matched", "conflict"]);

function commonColumns(dadId, row) {
  const pipe = row.pipe;
  if (!PIPES.has(pipe)) {
    throw new Error(`pipe must be 'claim' or 'verified'`);
  }
  if (pipe === "verified" && !row.source_ref) {
    throw new Error(`verified rows require source_ref`);
  }
  return {
    id: randomUUID(),
    dad_id: dadId,
    pipe,
    created_at: row.created_at ?? new Date().toISOString(),
    source_ref: row.source_ref ?? null,
    raw_quote: row.raw_quote ?? null,
  };
}

export class Vault {
  constructor() {
    this.events = [];
    this.communications = [];
    this.documents = [];
    this.month_summary = [];
    this.state = new Map(); // dad_id -> single state row (upserted)
    this.candidate_facts = []; // court-prep candidates (claim only, low)
    this.notifications = []; // court-prep check-ins
    this.plan_topics = []; // parenting plan checklist (Slice 14)
    this.plan_drafts = []; // bot-owned versioned drafts
    this.translations = []; // process translator (Slice 15)
    this.translator_calendar_candidates = []; // private_only, claim ≠ verified
    this.involvement_fields = []; // involvement cheat sheet (Slice 16)
    this.legal_intakes = []; // legal intake seat (Slice 17)
    this.legal_handoff_drafts = []; // draft ≠ send: sent_at always null
  }

  insertEvent(dadId, row) {
    if (!EVENT_TYPES.has(row.event_type)) {
      throw new Error(`unknown event_type`);
    }
    if (!row.occurred_at) throw new Error(`occurred_at is required`);
    const rec = {
      ...commonColumns(dadId, row),
      event_type: row.event_type,
      occurred_at: row.occurred_at,
      scheduled_at: row.scheduled_at ?? null,
      location: row.location ?? null,
      kids: row.kids ?? [],
      notes: row.notes ?? null,
      noticed_at: null,
      noticed_text: null,
    };
    this.events.push(rec);
    log("event.insert", { table: "events", id: rec.id, dad: rec.dad_id, pipe: rec.pipe });
    return rec;
  }

  insertCommunication(dadId, row) {
    if (!DIRECTIONS.has(row.direction)) {
      throw new Error(`unknown direction`);
    }
    const rec = {
      ...commonColumns(dadId, row),
      direction: row.direction,
      channel: row.channel ?? null,
      body_cold: row.body_cold ?? null,
      sent_at: row.sent_at ?? null,
      draft_kind: row.draft_kind ?? null,
      soft_grade: row.soft_grade ?? null,
    };
    this.communications.push(rec);
    log("comm.insert", { table: "communications", id: rec.id, dad: rec.dad_id, pipe: rec.pipe });
    return rec;
  }

  // Drafts only — the never-sent communications (direction='draft').
  listDrafts(dadId) {
    return this.communications
      .filter((c) => c.dad_id === dadId && c.direction === "draft")
      .slice()
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  insertDocument(dadId, row) {
    if (!DOC_TYPES.has(row.doc_type)) {
      throw new Error(`unknown doc_type`);
    }
    // Rail (§2, §3): bytes never in this table — storage_uri is a
    // placeholder ref only in Phase 1.
    const rec = {
      ...commonColumns(dadId, row),
      doc_type: row.doc_type,
      storage_uri: row.storage_uri ?? null,
      extracted: row.extracted ?? null,
      period_start: row.period_start ?? null,
      period_end: row.period_end ?? null,
    };
    this.documents.push(rec);
    log("doc.insert", { table: "documents", id: rec.id, dad: rec.dad_id, pipe: rec.pipe });
    return rec;
  }

  // month_summary gate (§3, Fix 4): pipe='verified' only when every
  // source_ref resolves to a verified row. App-enforced in the write path —
  // an unverified ref forces the whole summary to 'claim'.
  insertMonthSummary(dadId, row) {
    if (!row.month) throw new Error(`month is required`);
    for (const tag of row.pattern_tags ?? []) {
      if (!PATTERN_TAGS.has(tag)) {
        throw new Error(`pattern_tags allows observable behavior tags only`);
      }
    }
    let pipe = row.pipe ?? "claim";
    let forced = false;
    if (pipe === "verified") {
      const refs = row.source_refs ?? [];
      const allVerified =
        refs.length > 0 && refs.every((ref) => this.#resolvesVerified(dadId, ref));
      if (!allVerified) {
        pipe = "claim";
        forced = true;
      }
    }
    const rec = {
      ...commonColumns(dadId, {
        ...row,
        pipe,
        // common-column check requires source_ref on verified rows; the
        // summary's refs live in source_refs, so mirror the first one.
        source_ref: pipe === "verified" ? (row.source_refs?.[0] ?? null) : row.source_ref ?? null,
      }),
      month: row.month,
      summary_text: row.summary_text ?? null,
      highlights: row.highlights ?? [],
      pattern_tags: row.pattern_tags ?? [],
      source_refs: row.source_refs ?? [],
    };
    this.month_summary.push(rec);
    log("summary.insert", {
      table: "month_summary",
      id: rec.id,
      dad: rec.dad_id,
      pipe: rec.pipe,
      forced_claim: forced,
    });
    return { row: rec, forced_claim: forced };
  }

  // statement → notice: stamp noticed_at/noticed_text on one of the dad's
  // events (latest by created_at when eventId is null). Pipe is untouched —
  // a noticed row stays 'claim' until verified, so verified_export /
  // affidavit_support never pick it up on notice alone.
  noticeEvent(dadId, eventId = null) {
    const mine = this.events.filter((e) => e.dad_id === dadId);
    const event = eventId
      ? (mine.find((e) => e.id === eventId) ?? null)
      : (mine
          .slice()
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
          .pop() ?? null);
    if (!event) {
      const err = new Error("unknown event");
      err.status = 404;
      throw err;
    }
    event.noticed_at = new Date().toISOString();
    event.noticed_text = buildNoticeText(event);
    log("event.notice", { table: "events", id: event.id, dad: dadId, pipe: event.pipe });
    return {
      event_id: event.id,
      noticed_at: event.noticed_at,
      noticed_text: event.noticed_text,
      pipe: event.pipe,
    };
  }

  #resolvesVerified(dadId, ref) {
    const all = [...this.events, ...this.communications, ...this.documents];
    const hit = all.find((r) => r.dad_id === dadId && r.id === ref);
    return Boolean(hit && hit.pipe === "verified");
  }

  // state — one row per dad_id.
  // upsertState may create (used ONLY by provisionState).
  // updateState / appendMissing never create — missing dad → 404.
  upsertState(dadId, patch) {
    const existing = this.state.get(dadId);
    const rec = {
      id: existing?.id ?? randomUUID(),
      dad_id: dadId,
      pipe: "claim",
      created_at: existing?.created_at ?? new Date().toISOString(),
      source_ref: null,
      raw_quote: null,
      phase: patch.phase ?? existing?.phase ?? "intake",
      this_week: patch.this_week ?? existing?.this_week ?? null,
      missing: patch.missing ?? existing?.missing ?? [],
      next_action: patch.next_action ?? existing?.next_action ?? null,
      last_next: patch.last_next ?? existing?.last_next ?? null,
      last_next_at: patch.last_next_at ?? existing?.last_next_at ?? null,
      this_week_done: patch.this_week_done ?? existing?.this_week_done ?? null,
      this_week_total: patch.this_week_total ?? existing?.this_week_total ?? null,
      last_next_kind: patch.last_next_kind ?? existing?.last_next_kind ?? null,
      last_ask_summary: patch.last_ask_summary ?? existing?.last_ask_summary ?? null,
      updated_at: new Date().toISOString(),
    };
    this.state.set(dadId, rec);
    log("state.upsert", { table: "state", id: rec.id, dad: rec.dad_id });
    return rec;
  }

  // PUT /vault/state — update-only. Does not create.
  updateState(dadId, patch) {
    const existing = this.state.get(dadId);
    if (!existing) {
      const err = new Error("unknown dad");
      err.status = 404;
      throw err;
    }
    return this.upsertState(dadId, patch);
  }

  getState(dadId) {
    return this.state.get(dadId) ?? null;
  }

  // Return loop: stamp last_next = the current One Next, so "Last time: ___"
  // reflects what the dad was actually asked. Empty next_action → nothing is
  // stamped and last_next comes back null — a "last time" is never invented.
  beginReturn(dadId) {
    const existing = this.getState(dadId);
    if (!existing) {
      const err = new Error("unknown dad");
      err.status = 404;
      throw err;
    }
    const last_next = existing.next_action ?? null;
    if (last_next) {
      this.upsertState(dadId, { last_next, last_next_at: new Date().toISOString() });
    }
    log("state.return", { table: "state", dad: dadId, has_next: Boolean(last_next) });
    return {
      last_next,
      last_next_kind: existing.last_next_kind ?? null,
      last_ask_summary: existing.last_ask_summary ?? null,
    };
  }

  // POST /vault/provision — insert-only. Never used by GET /vault/state.
  provisionState(dadId) {
    if (this.state.has(dadId)) {
      const err = new Error("dad already provisioned");
      err.status = 409;
      throw err;
    }
    return this.upsertState(dadId, {
      phase: "intake",
      missing: [],
      next_action: null,
    });
  }

  // ---- court-prep (vault/010_court_prep.sql twin) -------------------------

  insertCandidate(dadId, row) {
    if (!CANDIDATE_WHATS.has(row.what)) throw new Error("unknown candidate what");
    if (!CANDIDATE_STATUSES.has(row.status ?? "not_proof_yet")) throw new Error("unknown status");
    const rec = {
      id: randomUUID(),
      dad_id: dadId,
      pipe: "claim",
      created_at: new Date().toISOString(),
      source: row.source,
      source_event_id: row.source_event_id ?? null,
      quote: row.quote ?? null,
      who: row.who ?? [],
      what: row.what,
      when_text: row.when_text ?? null,
      when_on: row.when_on ?? null,
      kids: row.kids ?? [],
      cues: row.cues ?? [],
      confidence: "low",
      status: row.status ?? "not_proof_yet",
      ofw_ref: row.ofw_ref ?? null,
      line: row.line,
      review: "needs_reviewed",
    };
    this.candidate_facts.push(rec);
    log("candidate.insert", { table: "candidate_facts", id: rec.id, dad: dadId, status: rec.status });
    return rec;
  }

  listCandidates(dadId) {
    return this.candidate_facts
      .filter((c) => c.dad_id === dadId)
      .slice()
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  updateCandidateCheck(dadId, id, { status, ofw_ref, line }) {
    const rec = this.candidate_facts.find((c) => c.dad_id === dadId && c.id === id);
    if (!rec) return null;
    if (!CANDIDATE_STATUSES.has(status)) throw new Error("unknown status");
    Object.assign(rec, { status, ofw_ref: ofw_ref ?? null, line });
    return rec;
  }

  setCandidateReview(dadId, id, review) {
    if (!["needs_reviewed", "kept", "tossed"].includes(review)) throw new Error("unknown review");
    const rec = this.candidate_facts.find((c) => c.dad_id === dadId && c.id === id);
    if (!rec) return null;
    rec.review = review;
    return rec;
  }

  // OFW = verified pull rows on the ofw channel. Read-only for court-prep.
  listOfwPulls(dadId) {
    return this.communications.filter(
      (c) => c.dad_id === dadId && c.direction === "pull" && c.channel === "ofw" && c.pipe === "verified",
    );
  }

  // Idempotent per (dad, kind, for_date, slot). Returns that day's items.
  ensureNotifications(dadId, items) {
    let created = 0;
    for (const it of items) {
      const exists = this.notifications.some(
        (n) => n.dad_id === dadId && n.kind === it.kind && n.for_date === it.for_date && n.slot === it.slot,
      );
      if (exists) continue;
      this.notifications.push({
        id: randomUUID(),
        dad_id: dadId,
        created_at: new Date().toISOString(),
        status: "unread",
        ...it,
      });
      created += 1;
    }
    return created;
  }

  listNotifications(dadId) {
    return this.notifications
      .filter((n) => n.dad_id === dadId)
      .slice()
      .sort((a, b) => String(a.due_start).localeCompare(String(b.due_start)));
  }

  setNotificationStatus(dadId, id, status) {
    const rec = this.notifications.find((n) => n.dad_id === dadId && n.id === id);
    if (!rec) return null;
    rec.status = status;
    return rec;
  }

  // A dad's words inside an open, not-done check-in window answer it.
  completeOpenCheckins(dadId, nowIso) {
    const now = new Date(nowIso).getTime();
    let done = 0;
    for (const n of this.notifications) {
      if (n.dad_id !== dadId || n.status === "done") continue;
      if (new Date(n.due_start).getTime() <= now && now <= new Date(n.due_end).getTime()) {
        n.status = "done";
        done += 1;
      }
    }
    return done;
  }

  // ---- parenting plan (vault/011_parenting_plan.sql twin) -------------------

  ensurePlanTopics(dadId, topics) {
    let created = 0;
    for (const { key, position } of topics) {
      if (this.plan_topics.some((t) => t.dad_id === dadId && t.topic_key === key)) continue;
      this.plan_topics.push({
        dad_id: dadId,
        topic_key: key,
        position,
        status: "open",
        choice: null,
        detail: null,
        stance: null,
        depth: "simple",
        example_shown: false,
        updated_at: new Date().toISOString(),
      });
      created += 1;
    }
    return created;
  }

  listPlanTopics(dadId) {
    return this.plan_topics
      .filter((t) => t.dad_id === dadId)
      .slice()
      .sort((a, b) => a.position - b.position);
  }

  updatePlanTopic(dadId, key, patch) {
    const rec = this.plan_topics.find((t) => t.dad_id === dadId && t.topic_key === key);
    if (!rec) return null;
    Object.assign(rec, patch, { updated_at: new Date().toISOString() });
    return rec;
  }

  insertPlanDraft(dadId, { kind, body }) {
    const version =
      Math.max(0, ...this.plan_drafts.filter((d) => d.dad_id === dadId).map((d) => d.version)) + 1;
    const rec = { id: randomUUID(), dad_id: dadId, version, kind, body, created_at: new Date().toISOString() };
    this.plan_drafts.push(rec);
    log("plan.draft", { table: "plan_drafts", id: rec.id, dad: dadId, version, kind });
    return rec;
  }

  latestPlanDraft(dadId, kind) {
    const rows = this.plan_drafts.filter((d) => d.dad_id === dadId && d.kind === kind);
    return rows.sort((a, b) => b.version - a.version)[0] ?? null;
  }

  // ---- process translator (vault/012_process_translator.sql twin) ----------

  insertTranslation(dadId, t, candidates = []) {
    const rec = {
      id: randomUUID(),
      dad_id: dadId,
      created_at: new Date().toISOString(),
      input_kind: t.input_kind,
      input_cold: t.input_cold,
      term_keys: [...t.term_keys],
      verdict_request: Boolean(t.verdict_request),
      clock_flag: Boolean(t.clock_flag),
      result: t.result,
    };
    this.translations.push(rec);
    const cands = candidates.map((c) => {
      const row = {
        id: randomUUID(),
        dad_id: dadId,
        translation_id: rec.id,
        created_at: rec.created_at,
        label: c.label,
        date_text: c.date_text,
        on_date: c.on_date ?? null,
        visibility: "private_only",
        status: "candidate",
      };
      this.translator_calendar_candidates.push(row);
      return row;
    });
    log("translate.insert", { table: "translations", id: rec.id, dad: dadId, kind: t.input_kind, cands: cands.length });
    return { ...rec, calendar_candidates: cands };
  }

  _withCands(rec) {
    if (!rec) return null;
    const cands = this.translator_calendar_candidates.filter((c) => c.translation_id === rec.id);
    return { ...rec, calendar_candidates: cands };
  }

  getTranslation(dadId, id) {
    return this._withCands(this.translations.find((t) => t.dad_id === dadId && t.id === id));
  }

  lastTranslation(dadId) {
    const rows = this.translations.filter((t) => t.dad_id === dadId);
    return this._withCands(rows[rows.length - 1]);
  }

  listTranslations(dadId, limit = 20) {
    return this.translations
      .filter((t) => t.dad_id === dadId)
      .slice()
      .reverse()
      .slice(0, limit)
      .map((t) => ({
        id: t.id,
        created_at: t.created_at,
        input_kind: t.input_kind,
        term_keys: [...t.term_keys],
        verdict_request: t.verdict_request,
        clock_flag: t.clock_flag,
      }));
  }

  // ---- involvement cheat sheet (vault/013_involvement.sql twin) -------------

  ensureInvolvement(dadId, kidKey, fields) {
    let created = 0;
    for (const { key, position } of fields) {
      if (this.involvement_fields.some((r) => r.dad_id === dadId && r.kid_key === kidKey && r.field_key === key)) {
        continue;
      }
      this.involvement_fields.push({
        dad_id: dadId,
        kid_key: kidKey,
        field_key: key,
        position,
        value: null,
        asked_on: null,
        asked_via: null,
        outcome: null,
        source: "dad_entered",
        claim_status: "claim",
        updated_at: new Date().toISOString(),
      });
      created += 1;
    }
    return created;
  }

  listInvolvementKids(dadId) {
    return [...new Set(this.involvement_fields.filter((r) => r.dad_id === dadId).map((r) => r.kid_key))].sort();
  }

  listInvolvement(dadId, kidKey) {
    return this.involvement_fields
      .filter((r) => r.dad_id === dadId && r.kid_key === kidKey)
      .slice()
      .sort((a, b) => a.position - b.position);
  }

  updateInvolvementField(dadId, kidKey, key, patch) {
    const rec = this.involvement_fields.find(
      (r) => r.dad_id === dadId && r.kid_key === kidKey && r.field_key === key,
    );
    if (!rec) return null;
    Object.assign(rec, patch, { updated_at: new Date().toISOString() });
    log("involvement.update", { table: "involvement_fields", dad: dadId, field: key });
    return rec;
  }

  // ---- legal intake (vault/014_legal_intake.sql twin) ----------------------

  insertLegalIntake(dadId, c) {
    const rec = {
      id: randomUUID(),
      dad_id: dadId,
      created_at: new Date().toISOString(),
      who: c.who,
      what_cold: c.what_cold,
      urgency: c.urgency,
      flags: [...c.flags],
      route: c.route,
      claim_status: "claim",
    };
    this.legal_intakes.push(rec);
    log("legal.intake", { table: "legal_intakes", id: rec.id, dad: dadId, route: c.route });
    return rec;
  }

  getLegalIntake(dadId, id) {
    return this.legal_intakes.find((r) => r.dad_id === dadId && r.id === id) ?? null;
  }

  latestLegalIntake(dadId) {
    const rows = this.legal_intakes.filter((r) => r.dad_id === dadId);
    return rows[rows.length - 1] ?? null;
  }

  latestHandoffDraft(intakeId) {
    const rows = this.legal_handoff_drafts.filter((d) => d.intake_id === intakeId);
    return rows.sort((a, b) => b.version - a.version)[0] ?? null;
  }

  insertHandoffDraft(dadId, intakeId, version, body) {
    const rec = {
      id: randomUUID(),
      intake_id: intakeId,
      dad_id: dadId,
      version,
      body,
      created_at: new Date().toISOString(),
      sent_at: null,
    };
    this.legal_handoff_drafts.push(rec);
    log("legal.handoff", { table: "legal_handoff_drafts", id: rec.id, dad: dadId, version });
    return rec;
  }

  // Read helpers used by spreadsheet views (same names as SqlVault).
  async listEvents(dadId) {
    return this.events
      .filter((e) => e.dad_id === dadId)
      .slice()
      .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  }

  // Claim chase — requires provisioned state. Never silent-creates.
  appendMissing(dadId, item) {
    const existing = this.getState(dadId);
    if (!existing) {
      const err = new Error("unknown dad");
      err.status = 404;
      throw err;
    }
    const missing = [...(existing.missing ?? [])];
    // Short-checklist rail: missing holds at most 7 items — a full list
    // takes no more chase items until something clears.
    if (!missing.includes(item) && missing.length < 7) missing.push(item);
    // Edge needs exactly one next_action; the chase item becomes it when
    // nothing else is queued.
    const next_action = existing.next_action ?? item;
    return this.updateState(dadId, { missing, next_action });
  }

  // verified_export view — union of all tables where pipe='verified'.
  // The ONLY thing Reporting or any attorney helper may read.
  // ---- Slice 21: export + delete (owner / operator paths only) ----------

  /** Every row this dad owns, per table. Raw — the export builder sanitizes. */
  exportAll(dadId) {
    const pick = (arr) => arr.filter((r) => r.dad_id === dadId).map((r) => ({ ...r }));
    const st = this.state.get(dadId);
    return {
      events: pick(this.events),
      communications: pick(this.communications),
      documents: pick(this.documents),
      month_summary: pick(this.month_summary),
      state: st ? [{ ...st }] : [],
      candidate_facts: pick(this.candidate_facts),
      notifications: pick(this.notifications),
      plan_topics: pick(this.plan_topics),
      plan_drafts: pick(this.plan_drafts),
      translations: pick(this.translations),
      translator_calendar_candidates: pick(this.translator_calendar_candidates),
      involvement_fields: pick(this.involvement_fields),
      legal_intakes: pick(this.legal_intakes),
      legal_handoff_drafts: pick(this.legal_handoff_drafts),
    };
  }

  /** HARD wipe: every row for this dad, every table. Returns counts removed. */
  wipeDad(dadId) {
    const counts = {};
    for (const t of [
      "events", "communications", "documents", "month_summary", "candidate_facts",
      "notifications", "plan_topics", "plan_drafts", "translations",
      "translator_calendar_candidates", "involvement_fields", "legal_intakes",
      "legal_handoff_drafts",
    ]) {
      const before = this[t].length;
      this[t] = this[t].filter((r) => r.dad_id !== dadId);
      counts[t] = before - this[t].length;
    }
    counts.state = this.state.delete(dadId) ? 1 : 0;
    return counts;
  }

  verifiedExport(dadId) {
    const tag = (source_table) => (r) => ({ source_table, ...r });
    return [
      ...this.events.map(tag("events")),
      ...this.communications.map(tag("communications")),
      ...this.documents.map(tag("documents")),
      ...this.month_summary.map(tag("month_summary")),
    ].filter((r) => r.dad_id === dadId && r.pipe === "verified");
  }

  // affidavit_support view — verified documents + verified events shaped for
  // the financial-disclosure sheet. Same flattened columns the SQL view in
  // vault/001_schema.sql emits, so memory and Postgres answer identically.
  affidavitSupport(dadId) {
    const documents = this.documents
      .filter((r) => r.dad_id === dadId && r.pipe === "verified")
      .map((d) => ({
        dad_id: d.dad_id,
        kind: "document",
        id: d.id,
        detail: d.doc_type ?? null,
        extracted: d.extracted ?? null,
        period_start: d.period_start ?? null,
        period_end: d.period_end ?? null,
      }));
    const events = this.events
      .filter((r) => r.dad_id === dadId && r.pipe === "verified")
      .map((e) => {
        const day = e.occurred_at ? new Date(e.occurred_at).toISOString().slice(0, 10) : null;
        return {
          dad_id: e.dad_id,
          kind: "event",
          id: e.id,
          detail: e.event_type ?? null,
          extracted: null,
          period_start: day,
          period_end: day,
        };
      });
    return [...documents, ...events];
  }


  /**
   * Memory-store search fallback: case-insensitive substring (not Postgres FTS).
   * Always filters by dad_id. mode is always "substring".
   * Documented: no GIN/tsvector on memory path.
   */
  search(opts) {
    const dadId = opts.dad_id;
    const q = opts.q || "";
    const pipe = opts.pipe || null;
    const type = opts.type || "all";
    const from = opts.from ? new Date(opts.from).getTime() : null;
    const to = opts.to ? new Date(opts.to).getTime() : null;
    const limit = opts.limit || 50;

    const inRange = (iso) => {
      if (!iso && (from != null || to != null)) return false;
      if (!iso) return true;
      const t = new Date(iso).getTime();
      if (Number.isNaN(t)) return false;
      if (from != null && t < from) return false;
      if (to != null && t > to) return false;
      return true;
    };

    const hits = [];

    const want = (t) => type === "all" || type === t;

    if (want("events")) {
      for (const e of this.events) {
        if (e.dad_id !== dadId) continue;
        if (pipe && e.pipe !== pipe) continue;
        if (!inRange(e.occurred_at)) continue;
        const blob = `${e.notes ?? ""} ${e.raw_quote ?? ""}`;
        if (!textIncludes(blob, q)) continue;
        hits.push({
          id: e.id,
          dad_id: e.dad_id,
          type: "events",
          pipe: e.pipe,
          snippet: makeSnippet(blob, q),
          rank: q ? 1 : 0,
          ts: e.occurred_at,
        });
      }
    }

    if (want("communications")) {
      for (const c of this.communications) {
        if (c.dad_id !== dadId) continue;
        if (pipe && c.pipe !== pipe) continue;
        const ts = c.sent_at ?? c.created_at;
        if (!inRange(ts)) continue;
        const blob = `${c.body_cold ?? ""} ${c.raw_quote ?? ""}`;
        if (!textIncludes(blob, q)) continue;
        hits.push({
          id: c.id,
          dad_id: c.dad_id,
          type: "communications",
          pipe: c.pipe,
          snippet: makeSnippet(blob, q),
          rank: q ? 1 : 0,
          ts,
        });
      }
    }

    if (want("documents")) {
      for (const d of this.documents) {
        if (d.dad_id !== dadId) continue;
        if (pipe && d.pipe !== pipe) continue;
        if (!inRange(d.created_at)) continue;
        const extracted =
          d.extracted == null
            ? ""
            : typeof d.extracted === "string"
              ? d.extracted
              : JSON.stringify(d.extracted);
        const blob = `${extracted} ${d.raw_quote ?? ""}`;
        if (!textIncludes(blob, q)) continue;
        hits.push({
          id: d.id,
          dad_id: d.dad_id,
          type: "documents",
          pipe: d.pipe,
          snippet: makeSnippet(blob, q),
          rank: q ? 1 : 0,
          ts: d.created_at,
        });
      }
    }

    if (want("state")) {
      for (const s of this.state.values()) {
        if (s.dad_id !== dadId) continue;
        if (pipe && s.pipe !== pipe) continue;
        if (!inRange(s.updated_at)) continue;
        const blob = `${s.this_week ?? ""} ${(s.missing ?? []).join(" ")} ${s.next_action ?? ""}`;
        if (!textIncludes(blob, q)) continue;
        hits.push({
          id: s.id,
          dad_id: s.dad_id,
          type: "state",
          pipe: s.pipe,
          snippet: makeSnippet(blob, q),
          rank: q ? 1 : 0,
          ts: s.updated_at,
        });
      }
    }

    if (want("month_summary")) {
      for (const m of this.month_summary) {
        if (m.dad_id !== dadId) continue;
        if (pipe && m.pipe !== pipe) continue;
        if (!inRange(m.created_at)) continue;
        const blob = `${m.summary_text ?? ""} ${(m.highlights ?? []).join(" ")}`;
        if (!textIncludes(blob, q)) continue;
        hits.push({
          id: m.id,
          dad_id: m.dad_id,
          type: "month_summary",
          pipe: m.pipe,
          snippet: makeSnippet(blob, q),
          rank: q ? 1 : 0,
          ts: m.created_at,
        });
      }
    }

    hits.sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      return String(b.ts || "").localeCompare(String(a.ts || ""));
    });

    const out = hits.slice(0, limit);
    log("search.substring", {
      dad: dadId,
      hits: out.length,
      type,
      pipe: pipe || "any",
      q_len: q.length,
    });
    return { mode: "substring", hits: out };
  }

  // Test helper: every stored row across every table (state included).
  allRows() {
    return [
      ...this.events,
      ...this.communications,
      ...this.documents,
      ...this.month_summary,
      ...this.state.values(),
    ];
  }
}
