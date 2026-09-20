#!/usr/bin/env node
// Apply vault/001_schema.sql + vault/003_fts.sql to DATABASE_URL.
// Does not run 002_rls_plan.sql.

import { databaseUrl, openStore } from "./store.js";
import { SCHEMA_PATH, FTS_SCHEMA_PATH } from "./schema.js";

const url = databaseUrl();
if (!url) {
  process.stderr.write("DATABASE_URL is required to apply vault schema + FTS\n");
  process.exit(2);
}

const store = await openStore({ databaseUrl: url, applySchema: true });
await store.close();
process.stdout.write(`applied ${SCHEMA_PATH} + ${FTS_SCHEMA_PATH} (RLS plan not applied)\n`);
