# Host the vault-app HTTP BFF

Production path: Docker image runs `node src/server.js --http` on `0.0.0.0:$PORT` (default `8787`). Local `npm run serve` still binds `127.0.0.1` unless you set `HOST` or `NODE_ENV=production`.

**Zero secrets in git.** Put `DATABASE_URL` in the platform secret store only. Do not commit `.env`, connection strings, or passwords. Schema apply is `vault/001_schema.sql` only — do **not** run `vault/002_rls_plan.sql` (RLS stays off).

Auth is a later gate. Binding `0.0.0.0` makes every Phase 1 route reachable on the public URL. Treat this as a trusted-bot endpoint, not a public client.

## Health

| Path | Needs DB? | Notes |
| --- | --- | --- |
| `GET /health` | No | `{ "ok": true }` — use this for Fly/Render checks |
| `GET /vault/state?dad_id=<uuid>` | Yes | 200 when that dad has a state row; 404 otherwise |

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
