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
  verifiedExport(dadId) {
    const tag = (source_table) => (r) => ({ source_table, ...r });
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
