// Durable provision tokens — hash-only at rest.
//
// Backends (prefer DB when vault already on Postgres):
//   1) Postgres when DATABASE_URL / query pool present → table dde_provision_tokens
//   2) else JSON file (.dde-tokens.json) — no native SQLite build on this box
//
// Columns: token_hash, dad_id, created_at, revoked_at (nullable),
// expires_at (nullable; Slice 20). Raw tokens are never persisted. Bearer
// gate hashes the presented token and looks up an unrevoked row, then
// refuses it once expired. A row with no expires_at (minted before Slice 20)
// expires at created_at + TTL — no token lives forever.
//
// Lifecycle (Slice 20): logout revokes the presented token; revoke kills
// every token for a dad; expiry is DDE_TOKEN_TTL_DAYS (default 30) from mint.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseUrl } from "./store.js";

const PG_ENSURE_SQL = `
create table if not exists dde_provision_tokens (
  token_hash text primary key,
  dad_id uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table dde_provision_tokens add column if not exists expires_at timestamptz;
create index if not exists dde_provision_tokens_dad_idx
  on dde_provision_tokens (dad_id);
`;

export const DEFAULT_TOKEN_TTL_DAYS = 30;

/** Token lifetime in ms from DDE_TOKEN_TTL_DAYS (positive number), else 30 days. */
export function tokenTtlMs(env = process.env) {
  const days = Number(env.DDE_TOKEN_TTL_DAYS);
  const d = Number.isFinite(days) && days > 0 ? days : DEFAULT_TOKEN_TTL_DAYS;
  return d * 24 * 60 * 60 * 1000;
}

/** Effective expiry (ISO) — expires_at, else created_at + TTL for legacy rows. */
export function tokenExpiresAt(row, ttlMs = tokenTtlMs()) {
  if (row?.expires_at) return new Date(row.expires_at).toISOString();
  return new Date(Date.parse(row.created_at) + ttlMs).toISOString();
}

/** Fails closed: an unreadable expiry counts as expired. */
export function isTokenExpired(row, now = Date.now(), ttlMs = tokenTtlMs()) {
  const at = row?.expires_at ? Date.parse(row.expires_at) : Date.parse(row?.created_at) + ttlMs;
  return !Number.isFinite(at) || at <= now;
}

function iso(v) {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export function hashToken(raw) {
  return createHash("sha256").update(String(raw), "utf8").digest("hex");
}

function hashesEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function defaultJsonPath() {
  const env = process.env.DDE_TOKENS_PATH;
  if (typeof env === "string" && env.trim()) return resolve(env.trim());
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../.dde-tokens.json");
}

/** In-process store (hash-only). Lost on process exit — tests / fallback. */
export function createMemoryTokenStore() {
  /** @type {Map<string, { token_hash: string, dad_id: string, created_at: string, revoked_at: string|null }>} */
  const byHash = new Map();

  return {
    kind: "memory",
    async insert({ dad_id, token_hash, created_at = new Date().toISOString(), expires_at = null }) {
      byHash.set(token_hash, {
        token_hash,
        dad_id,
        created_at,
        revoked_at: null,
        expires_at,
      });
    },
    async lookupActive(token_hash) {
      const row = byHash.get(token_hash);
      if (!row || row.revoked_at) return null;
      return { ...row };
    },
    async revoke(token_hash) {
      const row = byHash.get(token_hash);
      if (row && !row.revoked_at) {
        row.revoked_at = new Date().toISOString();
        return 1;
      }
      return 0;
    },
    async revokeAllForDad(dad_id) {
      let n = 0;
      for (const row of byHash.values()) {
        if (row.dad_id === dad_id && !row.revoked_at) {
          row.revoked_at = new Date().toISOString();
          n += 1;
        }
      }
      return n;
    },
    async close() {},
  };
}

function createJsonTokenStore(filePath) {
  const path = resolve(filePath);

  function load() {
    if (!existsSync(path)) return { tokens: [] };
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return { tokens: [] };
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.tokens)) return { tokens: [] };
    return data;
  }

  function save(data) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  }

  return {
    kind: "json",
    path,
    async insert({ dad_id, token_hash, created_at = new Date().toISOString(), expires_at = null }) {
      const data = load();
      if (data.tokens.some((t) => t.token_hash === token_hash)) {
        throw new Error("token hash already exists");
      }
      data.tokens.push({
        token_hash,
        dad_id,
        created_at,
        revoked_at: null,
        expires_at,
      });
      save(data);
    },
    async lookupActive(token_hash) {
      const data = load();
      const row = data.tokens.find(
        (t) => hashesEqual(t.token_hash, token_hash) && !t.revoked_at,
      );
      return row ? { ...row } : null;
    },
    async revoke(token_hash) {
      const data = load();
      let changed = false;
      for (const t of data.tokens) {
        if (hashesEqual(t.token_hash, token_hash) && !t.revoked_at) {
          t.revoked_at = new Date().toISOString();
          changed = true;
        }
      }
      if (changed) save(data);
      return changed ? 1 : 0;
    },
    async revokeAllForDad(dad_id) {
      const data = load();
      let n = 0;
      for (const t of data.tokens) {
        if (t.dad_id === dad_id && !t.revoked_at) {
          t.revoked_at = new Date().toISOString();
          n += 1;
        }
      }
      if (n) save(data);
      return n;
    },
    async close() {},
  };
}

function createPostgresTokenStore(query) {
  return {
    kind: "postgres",
    async insert({ dad_id, token_hash, created_at = new Date().toISOString(), expires_at = null }) {
      await query(
        `insert into dde_provision_tokens (token_hash, dad_id, created_at, revoked_at, expires_at)
         values ($1, $2, $3::timestamptz, null, $4::timestamptz)`,
        [token_hash, dad_id, created_at, expires_at],
      );
    },
    async lookupActive(token_hash) {
      const res = await query(
        `select token_hash, dad_id::text as dad_id, created_at, revoked_at, expires_at
           from dde_provision_tokens
          where token_hash = $1 and revoked_at is null
          limit 1`,
        [token_hash],
      );
      const row = res?.rows?.[0];
      if (!row) return null;
      return {
        token_hash: row.token_hash,
        dad_id: row.dad_id,
        created_at: iso(row.created_at),
        revoked_at: iso(row.revoked_at),
        expires_at: iso(row.expires_at),
      };
    },
    async revoke(token_hash) {
      const res = await query(
        `update dde_provision_tokens
            set revoked_at = now()
          where token_hash = $1 and revoked_at is null`,
        [token_hash],
      );
      return res?.rowCount ?? 0;
    },
    async revokeAllForDad(dad_id) {
      const res = await query(
        `update dde_provision_tokens
            set revoked_at = now()
          where dad_id = $1 and revoked_at is null`,
        [dad_id],
      );
      return res?.rowCount ?? 0;
    },
    async close() {},
  };
}

/**
 * Open durable token store.
 *
 * Options:
 *   - query: pg Pool#query (reuse vault pool) → Postgres
 *   - databaseUrl: open own pool → Postgres
 *   - jsonPath / path: force JSON file backend
 *   - memory: true → in-memory (tests)
 *
 * Default: DATABASE_URL → Postgres; else `.dde-tokens.json`.
 */
export async function openTokenStore(opts = {}) {
  if (opts.memory === true) {
    return createMemoryTokenStore();
  }

  if (opts.jsonPath || opts.path) {
    return createJsonTokenStore(opts.jsonPath || opts.path);
  }

  if (opts.query) {
    const exec = async (sql) => {
      await opts.query(sql);
    };
    for (const stmt of PG_ENSURE_SQL.split(";")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await exec(stmt);
    }
    return createPostgresTokenStore(opts.query);
  }

  const url =
    opts.databaseUrl !== undefined
      ? String(opts.databaseUrl || "").trim()
      : databaseUrl();

  if (url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url });
    const query = (sql, params) => pool.query(sql, params);
    for (const stmt of PG_ENSURE_SQL.split(";")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await pool.query(stmt);
    }
    const store = createPostgresTokenStore(query);
    const baseClose = store.close.bind(store);
    store.close = async () => {
      await baseClose();
      await pool.end();
    };
    store._pool = pool;
    return store;
  }

  return createJsonTokenStore(defaultJsonPath());
}

export { defaultJsonPath, PG_ENSURE_SQL };
