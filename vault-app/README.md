# vault-app — Phase 1 working product

Gate 2 vault: in-memory proof (tests 1–8), rented-Postgres app path (test 9),
optional HTTP BFF, and on-demand spreadsheet views. The vault is the source
of truth. Spreadsheets are generated outputs — never stored as the record.

Per `CLAUDE_CODE_PHASE1_KICKOFF.md`. Fake family only in demos:
Alex Rivera (dad) · Jordan Lee (co-parent) · Sam (8) · Taylor (5).
No real case data. No secrets in git.

## What this proves

- Four data types plus `month_summary` (§3 semantics)
- Two-pipe rule: `pipe ∈ {claim, verified}`, no third value, no null
- Intake writes `claim` only; verified rows require `source_ref`
- Harm language: heard → discarded → zero rows, zero log lines, zero retention
- Venom stripped: characterizations of the co-parent never stored
- Claim chase: count/frequency claims become a `state.missing` verify item —
  the number is never written as a structured field or verified row (the
  dad's own words stay in the claim row's `raw_quote` per §4)
- `verified_export` is the only read surface for Reporting; it never returns
  claim rows
- `month_summary` gate: `pipe='verified'` only when every `source_ref`
  resolves to a verified row, else forced to `claim`
- Logs: IDs and event refs only — never message bodies, kid names, or amounts

## Layout

```
src/vault.js        in-memory tables + views + write gates (mirrors §3)
src/sqlvault.js     Postgres-backed vault (same interface, async)
src/store.js        opens memory or SqlVault from DATABASE_URL
src/extract.js      middle layer (§4): harm → venom → fields → claim write → chase
src/bff.js          thin BFF functions (§5) — seats never touch the vault
src/tokens.js       durable provision tokens (hash-only; PG or .dde-tokens.json)
src/server.js       optional HTTP for those functions (`npm run serve`)
public/chip-entry.html  Chip deep-link entry (GET /app, GET /chip/entry)
CHIP_APP.md         Chip canonical contract (provision → state → intake)
CHIP_OPERATOR_BLURB.md  paste block for Chip description
scripts/chip-deeplink-curl.sh  localhost tip smoke (entry + Bearer)
Dockerfile          production image: `node src/server.js --http` on 0.0.0.0:$PORT
HOSTING.md          Fly.io / Render free-tier deploy (DATABASE_URL is a secret)
src/export.js       CSV/XLSX views from vault data (not a store)
src/cli-export.js   `npm run export:events` / `state` / `verified` / `all`
src/logger.js       hygiene logger — IDs only
src/schema.js       applies vault/001_schema.sql + vault/003_fts.sql (never 002)
src/search.js       search option parsing + memory snippet helpers
test/search.test.js vault FTS / search tenancy+auth+pipe tests
test/phase1.test.js     §6 tests 1–8 (in-memory)
test/phase1.pg.test.js  §6 test 9 (rented Postgres, app write path only)
FIXED_VENT.md       fake-family vent used as standard input
```

Schema lives next to the app, not inside it:

- `vault/001_schema.sql` — tables, checks, `verified_export` / `affidavit_support` views
- `vault/002_rls_plan.sql` — **draft only, do not run in Phase 1**
- `vault/003_fts.sql` — generated `search_tsv` + GIN indexes (applied with 001)

## Tests

```
cd vault-app
npm install
npm test
```

| Script | What it runs |
| --- | --- |
| `npm test` | All tests: 1–8, test 9 (skip unless `DATABASE_URL`), exports, HTTP BFF |
| `npm run test:phase1` | Tests 1–8 plus test 9 (the Phase 1 milestone suite) |
| `npm run test:memory` | Tests 1–8 only (always in-memory) |

Log output from tests 1–8 lands in `test-output/run.log` for the hygiene grep
(test 7 / §8 report).

### Test 9 — one command

Test 9 is **extract → BFF → SqlVault → node-postgres → Postgres** only.
Console SQL, dashboard inserts, or any channel that bypasses the app is not
a valid proof.

```
cd vault-app
npm install
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/postgres" npm test
```

That is the one command. `001_schema.sql` is applied idempotently by the
store (`create table if not exists` / `create or replace view`). RLS
(`002_rls_plan.sql`) is **not** applied.

`DATABASE_URL` lives only in the environment — never commit it. Copy
`.env.example` to `.env` if you want a local file; `.env` is gitignored
and does not override a URL already in the environment.

Intended rented target: Supabase project **dde-vault**. Without
`DATABASE_URL`, or where the network cannot reach the host, test 9
**skips** and counts as **BLOCKED**, not passed.


## Vault search (FTS)

`GET /vault/search?dad_id=&q=&pipe=&type=&from=&to=&limit=`

- **dad_id required** (400 if missing). Same Bearer / `X-DDE-Token` gate as state/export.
- Search may return `claim|verified` (two-pipe intact). **Export/Exhibit stay verified-only.**
- Postgres: `tsvector` + GIN (`vault/003_fts.sql`), `ts_rank` + recency, `ts_headline` snippets.
- Memory store fallback: **substring** match (`mode: "substring"`) — not Postgres FTS. Documented; no 501.
- Logs: ids/counts/`q_len` only — never full `raw_quote`.

## Optional HTTP BFF

Off unless you start it. Product bots call these Phase 1 routes:

| Method | Path | Body / query |
| --- | --- | --- |
| `POST` | `/vault/intake` | `{ dad_id, text }` → `{ written, chase }` |
| `POST` | `/vault/provision` | `{ dad_id? }` → `{ dad_id, token }` (**only** create path; opaque token; **hash** persisted) |

**Auth (minimal):** After provision, send `Authorization: Bearer <token>` or `X-DDE-Token: <token>` on intake/state/comms/export. Missing/wrong → **401**; token for another dad → **403**; unprovisioned dad → **404** `unknown dad`. Writes never silent-create state. **Durable tokens:** SHA-256 hash only in Postgres (`dde_provision_tokens`) when vault is on `DATABASE_URL`, else `.dde-tokens.json` (override with `DDE_TOKENS_PATH`).
| `GET` | `/vault/state` | `?dad_id=` → state row; **404** `{ "error": "unknown dad" }` if none (read-only) |
| `PUT` | `/vault/state` | `{ dad_id, phase?, this_week?, missing?, next_action? }` |
| `POST` | `/vault/comms/cold` | `{ dad_id, body_cold, channel }` → `{ id }` |
| `POST` | `/vault/comms/pull` | `{ dad_id, channel, source_ref, body_cold?, sent_at? }` → `{ id }` |
| `GET` | `/vault/export/verified` | `?dad_id=` → verified rows only |

```
npm run serve -- --http
npm run serve -- --http --demo          # in-memory fake-family Alex Rivera
DATABASE_URL=... npm run serve -- --http   # rented Postgres, no demo seed
```

Listens on `127.0.0.1:8787` (`PORT` / `HOST` override). Production and
Docker bind `0.0.0.0:$PORT` — see [`HOSTING.md`](HOSTING.md). Minimal Bearer
gate after provision; Chip entry is same-origin HTML (**hash-only** `#dad_id=&token=` — never `?token=` query).

`GET /health` returns `{ "ok": true }` and does not touch the vault.

There is **no** HTTP route that returns claim rows to Reporting.

## Spreadsheet views (from the vault)

Generated on demand. Do not commit `exports/` and do not treat the files
as the record.

| Script | View |
| --- | --- |
| `npm run export:events` | events time-log |
| `npm run export:state` | state / missing checklist |
| `npm run export:verified` | `verified_export` (Reporting) |
| `npm run export:all` | all three, CSV + XLSX |

```
npm run export:all -- --demo
DATABASE_URL=... npm run export:events -- --dad-id <uuid>
```

`--demo` uses the fake family only (FIXED_VENT + a court-safe OFW cold
sentence and a verified OFW pull) and **stays in-memory** even if
`DATABASE_URL` is set, so a leftover env var cannot write demo rows into
rented Postgres. Pass `--on-db` only if you really mean to seed the demo
into that database. Each XLSX includes a `_generated` sheet stating the
vault is the source of truth.

## Schema

```
DATABASE_URL=... npm run schema:apply
```

Applies `vault/001_schema.sql` only. Leaves RLS disabled.

## Rails (non-negotiable)

Fake family only in demos. No Nick real case data, ever. Education and
organization only. Connection strings and passwords stay in the environment.
