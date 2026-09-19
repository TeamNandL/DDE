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

const PIPES = new Set(["claim", "verified"]);

const EVENT_TYPES = new Set([
  "exchange",
  "denied_visit",
  "late_exchange",
  "visit",
  "call",
  "other",
]);

const DIRECTIONS = new Set(["outgoing", "incoming", "pull"]);

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
    };
    this.communications.push(rec);
    log("comm.insert", { table: "communications", id: rec.id, dad: rec.dad_id, pipe: rec.pipe });
    return rec;
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

  #resolvesVerified(dadId, ref) {
    const all = [...this.events, ...this.communications, ...this.documents];
    const hit = all.find((r) => r.dad_id === dadId && r.id === ref);
    return Boolean(hit && hit.pipe === "verified");
  }

  // state — one row per dad_id, upserted. Front Door and Edge read/write.
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
      updated_at: new Date().toISOString(),
    };
    this.state.set(dadId, rec);
    log("state.upsert", { table: "state", id: rec.id, dad: rec.dad_id });
    return rec;
  }

  getState(dadId) {
    return this.state.get(dadId) ?? null;
  }

  appendMissing(dadId, item) {
    const existing = this.getState(dadId);
    const missing = [...(existing?.missing ?? [])];
    if (!missing.includes(item)) missing.push(item);
    // Edge needs exactly one next_action; the chase item becomes it when
    // nothing else is queued.
    const next_action = existing?.next_action ?? item;
    return this.upsertState(dadId, { missing, next_action });
  }

  // verified_export view — union of all tables where pipe='verified'.
  // The ONLY thing Reporting or any attorney helper may read.
  verifiedExport(dadId) {
    const tag = (table) => (r) => ({ table, ...r });
    return [
      ...this.events.map(tag("events")),
      ...this.communications.map(tag("communications")),
      ...this.documents.map(tag("documents")),
      ...this.month_summary.map(tag("month_summary")),
    ].filter((r) => r.dad_id === dadId && r.pipe === "verified");
  }

  // affidavit_support view — stub shape only (§3); populated in Phase 5.
  // Verified documents + verified events only.
  affidavitSupport(dadId) {
    return {
      documents: this.documents.filter((r) => r.dad_id === dadId && r.pipe === "verified"),
      events: this.events.filter((r) => r.dad_id === dadId && r.pipe === "verified"),
    };
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
