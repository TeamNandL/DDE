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
import { createMemoryTokenStore, hashToken } from "./tokens.js";
import { parseSearchOpts } from "./search.js";

function unknownDad() {
  const err = new Error("unknown dad");
  err.status = 404;
  return err;
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

    // POST /vault/intake {dad_id, text} -> {written, chase} — Intake writes claim
    // Requires provisioned dad — never creates state.
    async postVaultIntake({ dad_id, text }, opts = {}) {
      await requireDad(dad_id);
      return extract(vault, dad_id, text, opts);
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

    // PUT /vault/state {dad_id, phase?, this_week?, missing?, next_action?}
    // Update-only — missing dad → 404 (no silent upsert).
    async putVaultState({ dad_id, ...patch }) {
      await requireDad(dad_id);
      if (typeof vault.updateState === "function") {
        return vault.updateState(dad_id, patch);
      }
      return vault.upsertState(dad_id, patch);
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
