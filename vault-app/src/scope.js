// Per-request dad scope (Slice 18 — Auth + RLS).
//
// Every HTTP request runs inside runRequestScope(). When the bearer gate
// passes for dad X (server.js gateDad), bindDad(X) marks the request, and
// from then on the Postgres exec (store.js) runs each statement as the
// non-owner role dde_app with dde.dad_id = X — both set transaction-locally,
// so they reset after the statement, even on error. RLS in
// vault/015_auth_rls.sql then limits every row read or written to dad X.
//
// Unbound work (schema apply, provision, token store, the pre-gate
// unknown-dad check, direct test/CLI calls) runs as the owner.

import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function runRequestScope(fn) {
  return als.run({ dad_id: null }, fn);
}

/** Run fn with dad_id already bound (tests / internal callers). */
export function runAsDad(dad_id, fn) {
  if (!UUID_RE.test(String(dad_id))) throw new Error("scope: dad_id must be a uuid");
  return als.run({ dad_id }, fn);
}

export function bindDad(dad_id) {
  const ctx = als.getStore();
  if (!ctx) return false;
  if (!UUID_RE.test(String(dad_id))) throw new Error("scope: dad_id must be a uuid");
  if (ctx.dad_id && ctx.dad_id !== dad_id) throw new Error("scope: request already bound to another dad");
  ctx.dad_id = dad_id;
  return true;
}

export function currentDad() {
  return als.getStore()?.dad_id ?? null;
}

/** Wrap one SQL statement so it runs as dde_app bound to dad_id. */
export function scopedSql(dad_id, sql) {
  if (!UUID_RE.test(String(dad_id))) throw new Error("scope: dad_id must be a uuid");
  return (
    "select set_config('role', 'dde_app', true); " +
    `select set_config('dde.dad_id', '${dad_id}', true); ` +
    sql
  );
}
