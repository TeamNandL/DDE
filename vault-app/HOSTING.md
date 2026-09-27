# Host the vault-app HTTP BFF

Production path: Docker image runs `node src/server.js --http` on `0.0.0.0:$PORT` (default `8787`). Local `npm run serve` still binds `127.0.0.1` unless you set `HOST` or `NODE_ENV=production`.

**Zero secrets in git.** Put `DATABASE_URL` in the platform secret store only. Do not commit `.env`, connection strings, or passwords. Schema apply is `vault/001_schema.sql` only — do **not** run `vault/002_rls_plan.sql` (RLS stays off).

Minimal token gate: `POST /vault/provision` returns `{dad_id, token}`. Mutating routes and sensitive reads (`GET /vault/state`, `GET /vault/export/verified`) require `Authorization: Bearer <token>` or `X-DDE-Token`. Token **hashes** persist (Postgres `dde_provision_tokens` when `DATABASE_URL` / vault on PG; else `.dde-tokens.json`). Not OAuth/JWT. Binding `0.0.0.0` still exposes the URL — treat as a trusted-bot endpoint.

## Health

| Path | Needs DB? | Notes |
| --- | --- | --- |
| `GET /health` | No | `{ "ok": true }` — use this for Fly/Render checks |
| `GET /vault/state?dad_id=<uuid>` | Yes | Requires Bearer/`X-DDE-Token`. 200 when provisioned; **404** `{"error":"unknown dad"}` otherwise (read-only — no create) |
| `POST /vault/provision` | Yes | **Only** create path. Inserts `state` (`phase=intake`, `missing=[]`, `next_action=null`). Returns `{dad_id, token}` (`dde-stub-<uuid>`). Stores **token_hash** only (durable) |

## Build locally

From the **repository root** (the image copies `vault/001_schema.sql`):

```
docker build -f vault-app/Dockerfile -t dde-vault-bff .
docker run --rm -p 8787:8787 -e DATABASE_URL dde-vault-bff
curl -s http://127.0.0.1:8787/health
```

Pass `-e DATABASE_URL="$DATABASE_URL"` from your shell. Never bake the URL into the image.

## Fly.io (free / hobby)

1. Install [flyctl](https://fly.io/docs/flyctl/install/), then from the repo root: `fly launch --no-deploy` (or `fly apps create`). Use the stub `fly.toml` — change `app` and `primary_region`.
2. Secret only: `fly secrets set DATABASE_URL="postgresql://…"`
3. `fly deploy`
4. Check: `curl -s https://<app>.fly.dev/health`

`fly.toml` sets `HOST=0.0.0.0` and checks `GET /health`. It contains no secrets.

## Render (free / starter)

1. New **Web Service**, Docker, repo root. Or apply the stub `render.yaml`.
2. Image: `dockerfilePath` = `./vault-app/Dockerfile`, `dockerContext` = `.`
3. Set secret `DATABASE_URL` in the dashboard (`sync: false` in the stub — never put the value in YAML).
4. Health check path: `/health`. Render injects `PORT`; the image already sets `HOST=0.0.0.0`.

## Binding notes

- `PORT` — platform or `8787`
- `HOST` — `0.0.0.0` in the image / production; `127.0.0.1` on a laptop
- `DATABASE_URL` unset → in-memory vault (fine for a smoke `GET /health`; state routes will not persist)

## Chip entry + live lag

`GET /app` and `GET /chip/entry` serve the same minimal Chip HTML (see `CHIP_APP.md`).

**LIVE BFF note:** `https://dde-vault-bff-production.up.railway.app` may lag tip until the next deploy — tip/localhost is the source of truth for this slice.

## Auth + RLS (Slice 18)

Boot applies `vault/015_auth_rls.sql` after 001–014. It creates the
`dde_app` role (NOLOGIN) and grants it to the connecting user, so the
`DATABASE_URL` user must be the table owner **and** able to create roles
(the default `postgres` user on Railway / Fly / Render Postgres is). If
boot fails with `permission denied to create role`, create it once by hand:

    create role dde_app nologin;
    grant dde_app to <DATABASE_URL user>;

Then redeploy. No new env vars, no Supabase, no paid add-on. The
`DATABASE_URL` user is the service role: it stays in host env only and is
never given to Chip.

Proof on any Postgres (zero skips required):

    cd vault-app && DATABASE_URL=... npm test
    DATABASE_URL=... node --test test/auth-rls.pg.test.js

Real dads stay closed: provision synthetic dads only until the Razor gate
passes and Nick gives an exact yes.

## Token lifecycle (Slice 20)

Optional env: `DDE_TOKEN_TTL_DAYS` (default `30`; non-positive / non-numeric
→ 30). Expiry is **30 days of inactivity** (sliding on use), not 30 days
from mint. Logout is all-device (`POST /vault/logout` = `POST /vault/panic`).

Boot adds `last_seen_at` to `dde_provision_tokens` (idempotent
`add column if not exists`) and backfills every existing row to `now()`.
**Nobody is logged out by the deploy**: every token that exists keeps
working and starts its 30-day inactivity clock at that boot.

Nick-only commands (run where the server's `DATABASE_URL` is set; there is
no HTTP equivalent):

    npm run token:revoke     -- --dad-id <uuid>   # every token for one dad
    npm run token:reissue    -- --dad-id <uuid>   # revoke all, print one fresh token once
    npm run token:sweep                            # durably revoke every token idle > TTL
    npm run token:revoke-all -- --yes              # NUCLEAR: every token, every dad

Output masks tokens and dad_ids to their last 4; only `reissue` prints a
raw token, once.

Proof: `DATABASE_URL=... node --test test/token-lifecycle.test.js test/token-lifecycle.pg.test.js`

### Rollback (Slice 20)

There is **no signing key** in this system. Tokens are random opaque
strings; the only truth is the `dde_provision_tokens` row, and 476ff09
already honors `revoked_at` (its lookup is `where token_hash = $1 and
revoked_at is null`). So:

| Token state at rollback | Fate under 476ff09 | Why |
| --- | --- | --- |
| Logged out / panicked / Nick-revoked | **stays dead** | written as `revoked_at`, which 476ff09 checks |
| Expired and presented since | **stays dead** | expiry is written as `revoked_at` the moment it is seen |
| Idle > 30 days but never presented | **would revive** (476ff09 has no expiry) | `revoked_at` still null |

The "rotate the signing key" step is therefore a row rotation. One-step
rollback, in this order:

1. Kill every pre-rollback token so none can be replayed under the old code
   (this is the key rotation — every dad gets a fresh link from Nick):

       cd vault-app && DATABASE_URL=... npm run token:revoke-all -- --yes

   Softer alternative when the fleet is small and no compromise is
   suspected: `npm run token:sweep` only, which durably revokes the
   never-presented idle tokens and leaves active dads logged in.
2. Deploy 476ff09 (`git checkout 476ff09` → build → deploy; same
   `DATABASE_URL`). The extra `last_seen_at` column is ignored by 476ff09
   and harmless; on a later roll-forward the ensure step backfills any
   null it left.
3. `token:reissue` each dad you killed in step 1 and send the new link.

Proof the revoked rows are dead under the old code: `test/token-lifecycle.pg.test.js`
runs 476ff09's lookup SQL verbatim after logout / expiry / sweep and asserts
no row comes back.

### 3-minute post-deploy check (fake dad only)

    B=https://<host>
    P=$(curl -s -X POST $B/vault/provision -H 'content-type: application/json' -d '{}')
    D=$(echo "$P" | jq -r .dad_id); T=$(echo "$P" | jq -r .token)
    curl -s -o /dev/null -w '%{http_code}\n' "$B/vault/state?dad_id=$D" -H "Authorization: Bearer $T"     # 200
    curl -s -X POST $B/vault/logout -H "Authorization: Bearer $T" -H 'content-type: application/json' -d "{\"dad_id\":\"$D\"}"   # {"logged_out":true,"revoked":1}
    curl -s -o /dev/null -w '%{http_code}\n' "$B/vault/state?dad_id=$D" -H "Authorization: Bearer $T"     # 401 — old token rejected

Then `npm run token:revoke -- --dad-id $D` to retire the fake dad's row.

## Dad export + delete (Slice 21)

Boot applies `vault/016_export_delete.sql` after 015: two **owner-only**
ledger tables (`dde_app` gets nothing), holding ids, timestamps, a hash —
never dad content.

| Table | Row means |
| --- | --- |
| `dde_export_receipts` | one successful export of that dad's bundle (`actor` = `dad` via `GET /vault/export`, or `operator` via CLI) |
| `dde_deletions` | one dad ever scheduled for deletion: `requested_at` → soft; `purge_at` = +`DDE_DELETE_GRACE_DAYS` (14); `cancelled_at`; `purged_at` + `purged_counts` (tombstone) |

Optional env: `DDE_EXPORT_FRESH_DAYS` (default 7), `DDE_DELETE_GRACE_DAYS`
(default 14), `DDE_OPS_PATH` (JSON ledger path when no `DATABASE_URL`).

### Nick-only commands (no HTTP equivalent exists)

    npm run dad:export        -- --dad-id <uuid> [--out file.zip]  # bundle + receipt
    npm run dad:delete        -- --dad-id <uuid>                   # SOFT delete
    npm run dad:cancel-delete -- --dad-id <uuid>                   # inside the 14 days
    npm run dad:purge         [-- --dad-id <uuid>]                 # HARD wipe of every due deletion

**The receipt gate is a server rail, not a warning.** `dad:delete` is
refused (`412 export receipt required`) unless a receipt newer than
`DDE_EXPORT_FRESH_DAYS` exists for that dad. Purge re-checks that a receipt
exists before wiping. Nobody loses data they never got a copy of.

Soft delete: every token for the dad is revoked on the spot (his link dies:
`401`), every row stays, `dad:cancel-delete` restores access (then
`token:reissue`). No new token can be minted for a dad inside the window.

Hard wipe (`dad:purge`, run by Nick — cron it daily or run it by hand):
deletes every row for the dad from all 14 dad tables (children before
parents) **and drops his token rows**, then writes `purged_at` +
`purged_counts` on the ledger row. The dad no longer exists: any old token
replayed gets `404 unknown dad` (the Slice 18 gate order — dad exists
before token — is unchanged; during the soft window it was `401`).

### Irreversible — a code rollback does NOT restore data

After `dad:purge` the rows are gone from Postgres. Rolling the code back to
af56bad (or any commit) changes nothing about that: the old code reads the
same database, and the rows are not in it. The only copy is the export
bundle the receipt gate made you produce first. There is no undo, no
recycle bin, no snapshot in this app. If you need a restore path, that is a
database-level backup (host PITR / pg_dump), outside this slice.

### Rollback to af56bad (one step)

`git checkout af56bad` → build → deploy, same `DATABASE_URL`. Nothing to
migrate down: the 016 tables are owner-only and af56bad never reads them.

| Ledger state at rollback | Under af56bad |
| --- | --- |
| Soft-deleted dad (window open) | **rows intact, tokens stay revoked** (af56bad honors `revoked_at`). He is locked out but nothing is lost. `token:reissue` from af56bad's CLI restores access; the pending deletion sits in the ledger and resumes if you roll forward and run `dad:purge` — cancel it first if that's not wanted. |
| Purged dad | gone, as above. Tombstone stays. |
| Export receipts | ignored by af56bad; harmless. |

Proof: `DATABASE_URL=... node --test test/export-delete.test.js test/export-delete.pg.test.js`
(PG leg asserts every row is still present during the soft window and that
all 14 tables + token rows read zero after purge).
