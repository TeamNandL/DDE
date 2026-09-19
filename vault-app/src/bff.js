// Thin BFF (§5) — seats never touch the vault directly.
//
// Phase 1: function signatures + one working implementation each, mapped
// 1:1 to the contract routes. No HTTP framework and no auth middleware yet.
//
// AUTH GOES HERE (later gate): every function below will sit behind auth
// middleware that resolves the session to a dad_id (Supabase Auth →
// auth.uid()), at which point the dad_id argument disappears from the
// public surface and RLS enforces tenancy underneath. Documented only in
// Phase 1 — not built.
//
// Rule (§5): there is NO endpoint that returns claim rows to Reporting.

import { extract } from "./extract.js";
import { log } from "./logger.js";

export function makeBff(vault) {
  return {
    // POST /vault/intake {dad_id, text} -> {written, chase} — Intake writes claim
    async postVaultIntake({ dad_id, text }, opts = {}) {
      return extract(vault, dad_id, text, opts);
    },

    // GET /vault/state {dad_id} -> state row — Edge / Front Door read
    async getVaultState({ dad_id }) {
      return vault.getState(dad_id);
    },

    // PUT /vault/state {dad_id, phase?, this_week?, missing?, next_action?}
    async putVaultState({ dad_id, ...patch }) {
      return vault.upsertState(dad_id, patch);
    },

    // POST /vault/comms/cold {dad_id, body_cold, channel} -> {id}
    // Only the cold, court-safe outgoing sentence is stored — never the vent.
    async postCommsCold({ dad_id, body_cold, channel }) {
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
    // Verified pulled record — source_ref required by the vault.
    async postCommsPull({ dad_id, channel, source_ref, body_cold, sent_at }) {
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

    // GET /vault/export/verified {dad_id} -> rows — Reporting ONLY.
    async getVaultExportVerified({ dad_id }) {
      const rows = await vault.verifiedExport(dad_id);
      log("export.verified", { dad: dad_id, rows: rows.length });
      return rows;
    },
  };
}
