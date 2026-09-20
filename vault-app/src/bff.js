// Thin BFF (§5) — seats never touch the vault directly.
//
// Phase 1: function signatures + one working implementation each, mapped
// 1:1 to the contract routes. Optional HTTP lives in server.js
// (`npm run serve` / `--http`) — this module stays framework-free.
//
// Minimal token gate (not OAuth/JWT): POST /vault/provision issues an opaque
// token. Only the SHA-256 hash is persisted via the durable token store
// (Postgres when vault is on DATABASE_URL; else .dde-tokens.json). Mutating
// routes and sensitive reads check Authorization: Bearer / X-DDE-Token via
// checkToken against that store.
//
// Rule (§5): there is NO endpoint that returns claim rows to Reporting.

import { randomUUID } from "node:crypto";
import { extract } from "./extract.js";
import { log } from "./logger.js";
import { stripPii } from "./pii.js";
import { clampProgressPatch, progressLine, softGrade } from "./progress.js";
import { createMemoryTokenStore, hashToken } from "./tokens.js";
import { parseSearchOpts } from "./search.js";

function unknownDad() {
  const err = new Error("unknown dad");
  err.status = 404;
  return err;
}

// Return-loop greeting for Chip. Plain text only — never a token, URL, or
// dad_id (Chip carries auth separately). Null when there is no Next: an
// empty Next is never invented into a "last time". PII-stripped as a
// guarantee even though next_action is chase text.
export function returnLine(lastNext) {
  if (!lastNext) return null;
  return stripPii(`Last time: ${lastNext}. How'd it go?`).text;
}

// Cold-ask variant: when the last Next was a cold ask, greet with its
// short summary instead of the raw next_action wording. Same rails:
// plain speech, PII-stripped, null when there is nothing to say.
export function coldAskLine(summary) {
  if (typeof summary !== "string" || !summary.trim()) return null;
  return stripPii(`Last time: cold ask — ${summary.trim()}. How'd it go?`).text;
}

/**
 * @param {object} vault
 * @param {{ tokenStore?: object }} [opts]
 */
export function makeBff(vault, opts = {}) {
  const tokenStore = opts.tokenStore || createMemoryTokenStore();

  async function requireDad(dad_id) {
    const state = await vault.getState(dad_id);
    if (!state) throw unknownDad();
    return state;
  }

  return {
    /** Durable (or memory) token store. Exposed for tests/docs only. */
    _tokenStore: tokenStore,

    async requireDad(dad_id) {
      return requireDad(dad_id);
    },

    /**
     * Verify opaque provision token for dad_id against durable store.
     * missing/unknown token → 401; token belongs to another dad → 403.
     */
    async checkToken(dad_id, token) {
      if (typeof token !== "string" || !token.trim()) {
        const err = new Error("unauthorized");
        err.status = 401;
        throw err;
      }
      const row = await tokenStore.lookupActive(hashToken(token.trim()));
      if (!row) {
        const err = new Error("unauthorized");
        err.status = 401;
        throw err;
      }
      if (row.dad_id !== dad_id) {
        const err = new Error("forbidden");
        err.status = 403;
        throw err;
      }
      return true;
    },

    // POST /vault/intake {dad_id, text, make_notice?} -> {written, chase}
    // — Intake writes claim. Requires provisioned dad — never creates state.
    // make_notice=true additionally notices the first written event and adds
    // {noticed_text, event_id}; the plain response shape is unchanged.
    async postVaultIntake({ dad_id, text, make_notice }, opts = {}) {
      await requireDad(dad_id);
      const { written, chase, event_ids = [] } = await extract(vault, dad_id, text, opts);
      const out = { written, chase };
      if (make_notice === true && event_ids.length > 0) {
        const noticed = await vault.noticeEvent(dad_id, event_ids[0]);
        out.noticed_text = noticed.noticed_text;
        out.event_id = noticed.event_id;
      }
      return out;
    },

    // POST /vault/return {dad_id, answer?} -> {last_next, line, written?, chase?}
    // Return loop: stamps state.last_next from the current One Next and hands
    // Chip the greeting line ({line: null} when no Next — nothing invented).
    // An answer runs the SAME intake pipeline (harm → PII → venom → claim
    // write → chase) — the dad's answer is a claim, never verified.
    async postVaultReturn({ dad_id, answer }, opts = {}) {
      await requireDad(dad_id);
      const { last_next, last_next_kind, last_ask_summary } = await vault.beginReturn(dad_id);
      // Cold-ask hook: prefer the ask summary; otherwise the generic line.
      const line =
        last_next_kind === "cold_ask" && last_ask_summary
          ? coldAskLine(last_ask_summary)
          : returnLine(last_next);
      const out = { last_next, line };
      if (typeof answer === "string" && answer.trim()) {
        const { written, chase } = await extract(vault, dad_id, answer, opts);
        out.written = written;
        out.chase = chase;
      }
      log("return", {
        dad: dad_id,
        has_next: Boolean(last_next),
        answered: Boolean(typeof answer === "string" && answer.trim()),
      });
      return out;
    },

    // POST /vault/notice {dad_id, event_id?} -> {noticed_text, event_id}
    // event_id omitted → the dad's latest event. Marks it noticed; pipe is
    // untouched (claim until verified — Exhibit never sees claim-only rows).
    async postVaultNotice({ dad_id, event_id }) {
      await requireDad(dad_id);
      const noticed = await vault.noticeEvent(dad_id, event_id ?? null);
      log("notice", { dad: dad_id, event: noticed.event_id, pipe: noticed.pipe });
      return { noticed_text: noticed.noticed_text, event_id: noticed.event_id };
    },

    // GET /vault/state {dad_id} -> state row — Edge / Front Door read (never creates)
    async getVaultState({ dad_id }) {
      return vault.getState(dad_id);
    },

    // POST /vault/provision {dad_id?} -> {dad_id, token}
    // ONLY path that creates state. Returns raw token once; store keeps hash only.
    async postVaultProvision({ dad_id } = {}) {
      const id = dad_id || randomUUID();
      await vault.provisionState(id);
      const token = `dde-stub-${randomUUID()}`;
      await tokenStore.insert({
        dad_id: id,
        token_hash: hashToken(token),
        created_at: new Date().toISOString(),
      });
      log("provision", { dad: id });
      return { dad_id: id, token };
    },

    // PUT /vault/state {dad_id, phase?, this_week?, missing?, next_action?,
    //                   this_week_done?, this_week_total?}
    // Update-only — missing dad → 404 (no silent upsert). Progress rails
    // clamp here, once, for both stores: total 3..7, done 0..total,
    // missing ≤ 7 short strings.
    async putVaultState({ dad_id, ...patch }) {
      await requireDad(dad_id);
      const clamped = clampProgressPatch(patch);
      if (typeof vault.updateState === "function") {
        return vault.updateState(dad_id, clamped);
      }
      return vault.upsertState(dad_id, clamped);
    },

    // GET /vault/progress {dad_id} -> {line, missing_one, grade}
    // Plain Chip speech, read-only. line null until both counters exist;
    // grade is warm or null — never shame; missing_one = first checklist
    // item or null (empty missing is fine).
    async getVaultProgress({ dad_id }) {
      const state = await requireDad(dad_id);
      // missing_one is spoken by Chip; the write path strips PII, and this
      // read-side strip covers rows written before that rail existed.
      const firstMissing = state.missing?.[0];
      const out = {
        line: progressLine(state),
        missing_one: firstMissing ? stripPii(String(firstMissing)).text : null,
        grade: softGrade(state),
      };
      log("progress", { dad: dad_id, has_line: Boolean(out.line), has_grade: Boolean(out.grade) });
      return out;
    },

    // POST /vault/comms/cold {dad_id, body_cold, channel} -> {id}
    async postCommsCold({ dad_id, body_cold, channel }) {
      await requireDad(dad_id);
      const rec = await vault.insertCommunication(dad_id, {
        direction: "outgoing",
        channel,
        body_cold,
        sent_at: new Date().toISOString(),
        pipe: "claim",
      });
      return { id: rec.id };
    },

    // POST /vault/comms/pull {dad_id, channel, source_ref, ...} -> {id}
    async postCommsPull({ dad_id, channel, source_ref, body_cold, sent_at }) {
      await requireDad(dad_id);
      const rec = await vault.insertCommunication(dad_id, {
        direction: "pull",
        channel,
        source_ref,
        body_cold: body_cold ?? null,
        sent_at: sent_at ?? null,
        pipe: "verified",
      });
      return { id: rec.id };
    },


    // GET /vault/search {dad_id, q?, pipe?, type?, from?, to?, limit?}
    // Claim|verified allowed. Export/Exhibit stay verified-only (unchanged).
    async getVaultSearch(raw) {
      const opts = parseSearchOpts(raw);
      await requireDad(opts.dad_id);
      if (typeof vault.search !== "function") {
        const err = new Error("search not available on this store");
        err.status = 501;
        throw err;
      }
      const result = await vault.search(opts);
      log("search", {
        dad: opts.dad_id,
        hits: result.hits?.length ?? 0,
        mode: result.mode,
        q_len: (opts.q || "").length,
      });
      return result;
    },

    // GET /vault/export/verified {dad_id} -> rows — Reporting ONLY (verified pipe).
    async getVaultExportVerified({ dad_id }) {
      await requireDad(dad_id);
      const rows = await vault.verifiedExport(dad_id);
      log("export.verified", { dad: dad_id, rows: rows.length });
      return rows;
    },
  };
}
