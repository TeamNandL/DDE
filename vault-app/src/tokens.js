// Durable provision tokens — hash-only at rest.
//
// Backends (prefer DB when vault already on Postgres):
//   1) Postgres when DATABASE_URL / query pool present → table dde_provision_tokens
//   2) else JSON file (.dde-tokens.json) — no native SQLite build on this box
//
// Columns: token_hash, dad_id, created_at, revoked_at (nullable).
// Raw tokens are never persisted. Bearer gate hashes the presented token and
// looks up an active (revoked_at IS NULL) row.

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
create index if not exists dde_provision_tokens_dad_idx
  on dde_provision_tokens (dad_id);
`;

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
    async insert({ dad_id, token_hash, created_at = new Date().toISOString() }) {
      byHash.set(token_hash, {
        token_hash,
        dad_id,
        created_at,
        revoked_at: null,
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
      }
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
    async insert({ dad_id, token_hash, created_at = new Date().toISOString() }) {
      const data = load();
      if (data.tokens.some((t) => t.token_hash === token_hash)) {
        throw new Error("token hash already exists");
      }
      data.tokens.push({
        token_hash,
        dad_id,
        created_at,
        revoked_at: null,
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
    },
    async close() {},
  };
}

function createPostgresTokenStore(query) {
  return {
    kind: "postgres",
    async insert({ dad_id, token_hash, created_at = new Date().toISOString() }) {
      await query(
        `insert into dde_provision_tokens (token_hash, dad_id, created_at, revoked_at)
         values ($1, $2, $3::timestamptz, null)`,
        [token_hash, dad_id, created_at],
      );
    },
    async lookupActive(token_hash) {
      const res = await query(
        `select token_hash, dad_id::text as dad_id, created_at, revoked_at
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
        created_at:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : String(row.created_at),
        revoked_at: row.revoked_at
          ? row.revoked_at instanceof Date
            ? row.revoked_at.toISOString()
            : String(row.revoked_at)
          : null,
      };
    },
    async revoke(token_hash) {
      await query(
        `update dde_provision_tokens
            set revoked_at = now()
          where token_hash = $1 and revoked_at is null`,
        [token_hash],
      );
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
