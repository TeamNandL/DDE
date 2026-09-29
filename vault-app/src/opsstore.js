// Operator ledger (Slice 21): export receipts + the deletion ledger.
// Same shape as tokens.js — Postgres via the unscoped owner pool when the
// vault is on DATABASE_URL, else a JSON file (.dde-ops.json), else memory.
// Holds ids, timestamps and a hash only. Never dad content.
//
// The receipt gate lives in bff.js: no soft-delete / wipe without a receipt
// newer than DDE_EXPORT_FRESH_DAYS (default 7). The 14-day window is
// DDE_DELETE_GRACE_DAYS (default 14).

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseUrl } from "./store.js";

const DAY = 24 * 60 * 60 * 1000;

export function exportFreshMs(env = process.env) {
  const d = Number(env.DDE_EXPORT_FRESH_DAYS);
  return (Number.isFinite(d) && d > 0 ? d : 7) * DAY;
}

export function deleteGraceMs(env = process.env) {
  const d = Number(env.DDE_DELETE_GRACE_DAYS);
  return (Number.isFinite(d) && d > 0 ? d : 14) * DAY;
}

export function defaultOpsPath() {
  const env = process.env.DDE_OPS_PATH;
  if (typeof env === "string" && env.trim()) return resolve(env.trim());
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../.dde-ops.json");
}

function iso(v) {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function fromRows({ receipts, deletions }) {
  return {
    async insertReceipt({ dad_id, sha256, bytes, actor, created_at = new Date().toISOString() }) {
      const row = { id: randomUUID(), dad_id, created_at, sha256, bytes, actor };
      receipts.push(row);
      return { ...row };
    },
    async latestReceipt(dad_id) {
      const mine = receipts.filter((r) => r.dad_id === dad_id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return mine[0] ? { ...mine[0] } : null;
    },
    async getDeletion(dad_id) {
      const d = deletions.find((x) => x.dad_id === dad_id);
      return d ? { ...d } : null;
    },
    async requestDeletion({ dad_id, receipt_id, requested_at, purge_at }) {
      const existing = deletions.find((x) => x.dad_id === dad_id);
      if (existing) {
        if (existing.purged_at) throw Object.assign(new Error("dad already purged"), { status: 409 });
        if (!existing.cancelled_at) throw Object.assign(new Error("deletion already pending"), { status: 409 });
        Object.assign(existing, { receipt_id, requested_at, purge_at, cancelled_at: null });
        return { ...existing };
      }
      const row = { dad_id, receipt_id, requested_at, purge_at, cancelled_at: null, purged_at: null, purged_counts: null };
      deletions.push(row);
      return { ...row };
    },
    async cancelDeletion(dad_id, at = new Date().toISOString()) {
      const d = deletions.find((x) => x.dad_id === dad_id);
      if (!d || d.cancelled_at || d.purged_at) return null;
      d.cancelled_at = at;
      return { ...d };
    },
    async listDue(now = Date.now()) {
      return deletions
        .filter((d) => !d.cancelled_at && !d.purged_at && Date.parse(d.purge_at) <= now)
        .map((d) => ({ ...d }));
    },
    async markPurged(dad_id, at, counts) {
      const d = deletions.find((x) => x.dad_id === dad_id);
      if (!d) return null;
      d.purged_at = at;
      d.purged_counts = counts;
      return { ...d };
    },
  };
}

export function createMemoryOpsStore() {
  return { kind: "memory", ...fromRows({ receipts: [], deletions: [] }), async close() {} };
}

function createJsonOpsStore(filePath) {
  const path = resolve(filePath);
  function load() {
    if (!existsSync(path)) return { receipts: [], deletions: [] };
    const raw = readFileSync(path, "utf8");
    const data = raw.trim() ? JSON.parse(raw) : {};
    return { receipts: Array.isArray(data.receipts) ? data.receipts : [], deletions: Array.isArray(data.deletions) ? data.deletions : [] };
  }
  function save(data) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  }
  // Every op: load → act on the in-memory shape → save.
  const wrap = (name) => async (...args) => {
    const data = load();
    const out = await fromRows(data)[name](...args);
    save(data);
    return out;
  };
  return {
    kind: "json",
    path,
    insertReceipt: wrap("insertReceipt"),
    latestReceipt: wrap("latestReceipt"),
    getDeletion: wrap("getDeletion"),
    requestDeletion: wrap("requestDeletion"),
    cancelDeletion: wrap("cancelDeletion"),
    listDue: wrap("listDue"),
    markPurged: wrap("markPurged"),
    async close() {},
  };
}

function rowOut(r) {
  if (!r) return null;
  const o = { ...r };
  for (const k of ["created_at", "requested_at", "purge_at", "cancelled_at", "purged_at"]) if (k in o) o[k] = iso(o[k]);
  if (o.dad_id) o.dad_id = String(o.dad_id);
  return o;
}

function createPostgresOpsStore(query) {
  return {
    kind: "postgres",
    async insertReceipt({ dad_id, sha256, bytes, actor, created_at = new Date().toISOString() }) {
      const id = randomUUID();
      await query(
        `insert into dde_export_receipts (id, dad_id, created_at, sha256, bytes, actor)
         values ($1, $2, $3::timestamptz, $4, $5, $6)`,
        [id, dad_id, created_at, sha256, bytes, actor],
      );
      return { id, dad_id, created_at, sha256, bytes, actor };
    },
    async latestReceipt(dad_id) {
      const res = await query(
        `select id, dad_id::text as dad_id, created_at, sha256, bytes, actor
           from dde_export_receipts where dad_id = $1 order by created_at desc limit 1`,
        [dad_id],
      );
      return rowOut(res.rows[0]);
    },
    async getDeletion(dad_id) {
      const res = await query(`select * from dde_deletions where dad_id = $1`, [dad_id]);
      return rowOut(res.rows[0]);
    },
    async requestDeletion({ dad_id, receipt_id, requested_at, purge_at }) {
      const cur = await this.getDeletion(dad_id);
      if (cur?.purged_at) throw Object.assign(new Error("dad already purged"), { status: 409 });
      if (cur && !cur.cancelled_at) throw Object.assign(new Error("deletion already pending"), { status: 409 });
      await query(
        `insert into dde_deletions (dad_id, receipt_id, requested_at, purge_at)
         values ($1, $2, $3::timestamptz, $4::timestamptz)
         on conflict (dad_id) do update
           set receipt_id = excluded.receipt_id, requested_at = excluded.requested_at,
               purge_at = excluded.purge_at, cancelled_at = null`,
        [dad_id, receipt_id, requested_at, purge_at],
      );
      return this.getDeletion(dad_id);
    },
    async cancelDeletion(dad_id, at = new Date().toISOString()) {
      const res = await query(
        `update dde_deletions set cancelled_at = $2::timestamptz
          where dad_id = $1 and cancelled_at is null and purged_at is null`,
        [dad_id, at],
      );
      return res.rowCount ? this.getDeletion(dad_id) : null;
    },
    async listDue(now = Date.now()) {
      const res = await query(
        `select * from dde_deletions
          where cancelled_at is null and purged_at is null and purge_at <= $1::timestamptz
          order by purge_at`,
        [new Date(now).toISOString()],
      );
      return res.rows.map(rowOut);
    },
    async markPurged(dad_id, at, counts) {
      await query(
        `update dde_deletions set purged_at = $2::timestamptz, purged_counts = $3::jsonb where dad_id = $1`,
        [dad_id, at, JSON.stringify(counts ?? null)],
      );
      return this.getDeletion(dad_id);
    },
    async close() {},
  };
}

/** Open the ledger. Same option shape as openTokenStore. */
export async function openOpsStore(opts = {}) {
  if (opts.memory === true) return createMemoryOpsStore();
  if (opts.jsonPath || opts.path) return createJsonOpsStore(opts.jsonPath || opts.path);
  if (opts.query) return createPostgresOpsStore(opts.query);
  const url = opts.databaseUrl !== undefined ? String(opts.databaseUrl || "").trim() : databaseUrl();
  if (url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url });
    const store = createPostgresOpsStore((sql, params) => pool.query(sql, params));
    store.close = async () => pool.end();
    return store;
  }
  return createJsonOpsStore(defaultOpsPath());
}
