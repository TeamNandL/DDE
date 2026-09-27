// One factory for every app path: tests, HTTP BFF, spreadsheet exports.
//
//   DATABASE_URL set  -> SqlVault over node-postgres (rented Postgres)
//   DATABASE_URL unset -> in-memory Vault (local proof / demos)
//
// Writes still go extract → BFF → vault. This module only opens the store.

import { Vault } from "./vault.js";
import { SqlVault } from "./sqlvault.js";
import { applyVaultSchema } from "./schema.js";
import { currentDad, scopedSql } from "./scope.js";
import "./env.js";

export function databaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (typeof raw !== "string") return "";
  const url = raw.trim();
  return url.length ? url : "";
}

export async function openStore(opts = {}) {
  const url = opts.databaseUrl !== undefined ? String(opts.databaseUrl || "").trim() : databaseUrl();

  if (url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url });
    // Bound request (bearer gate passed) → the statement runs as dde_app
    // with dde.dad_id set, so RLS (vault/015_auth_rls.sql) applies.
    // Unbound → owner (schema apply, provision, pre-gate checks).
    const exec = async (sql) => {
      const dad = currentDad();
      if (!dad) return (await pool.query(sql)).rows;
      const res = await pool.query(scopedSql(dad, sql));
      return res[res.length - 1].rows;
    };
    const query = (sql, params) => pool.query(sql, params);
    if (opts.applySchema !== false) {
      await applyVaultSchema(exec);
    }
    return {
      kind: "postgres",
      vault: new SqlVault(exec),
      exec,
      query,
      async close() {
        await pool.end();
      },
    };
  }

  return {
    kind: "memory",
    vault: new Vault(),
    exec: null,
    query: null,
    async close() {},
  };
}
