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
