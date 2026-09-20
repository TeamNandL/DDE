# Chip app — canonical vault contract

ADHD-short. Chip (Dad Grok Front Door) talks **only** to the HTTP BFF.
Never Supabase / Postgres direct. Fake family in demos only.

## Live vs tip

| Base | Notes |
| --- | --- |
| Tip / local | `http://127.0.0.1:8787` |
| Live Railway | `https://dde-vault-bff-production.up.railway.app` |

**LIVE BFF note:** Railway may **lag tip** until the next deploy. Prove against localhost tip first; do not assume production already has `/app` or `/chip/entry`.

Tokens are **durable** (hash-only at rest): Postgres table `dde_provision_tokens` when the vault is on `DATABASE_URL`; otherwise `.dde-tokens.json`. Raw Bearer is returned once at provision and never stored.

## Canonical contract

### 1) Provision (only create path)

```
POST /vault/provision
Content-Type: application/json
{ "dad_id"?: "<uuid>" }   // omit → server mints uuid

→ 200 { "dad_id": "<uuid>", "token": "dde-stub-<uuid>" }
→ 409 if that dad_id already provisioned
```

No prior Bearer required.

### 2) State (Edge / One Next)

```
GET /vault/state?dad_id=<uuid>
Authorization: Bearer <token>

→ 200 state row: { dad_id, phase, this_week, missing[], next_action, … }
→ 404 { "error": "unknown dad" }
→ 401 / 403 unauthorized / forbidden
```

**One Next = `state.next_action`.** Chip shows that string. Do not invent a second “next”.

### 3) Intake (vent → claim write + chase)

```
POST /vault/intake
Authorization: Bearer <token>
Content-Type: application/json
{ "dad_id": "<uuid>", "text": "<vent>" }

→ 200 { "written": N, "chase": [ … ] }
```

Then re-`GET /vault/state` — chase items land in `missing`; `next_action` is the One Next.

### Auth header

`Authorization: Bearer <token>` (preferred) or `X-DDE-Token: <token>`.
Zero extra auth theater — no OAuth, no login page, no MFA on this slice.

## Chip deep-link entry (minimal HTML)

Same origin as BFF:

| Path | Serves |
| --- | --- |
| `GET /app` | static Chip entry HTML |
| `GET /chip/entry` | same HTML |

**Hash-only token.** Page reads `dad_id` + `token` from **`location.hash` only** (`#dad_id=…&token=…`), or paste-once fields. **`?token=` query is ignored/rejected** (never used as a credential). After read, `history.replaceState` clears the hash (and any query token leftover). Do not log the token.

### Deep-link example (tip) — hash only

After provision:

```
http://127.0.0.1:8787/app#dad_id=<uuid>&token=<dde-stub-…>
```

or

```
http://127.0.0.1:8787/chip/entry#dad_id=<uuid>&token=<dde-stub-…>
```

**Never** put the token in the query string:

```
# WRONG — rejected
http://127.0.0.1:8787/app?dad_id=<uuid>&token=<dde-stub-…>
```

Live mirror (after deploy):

```
https://dde-vault-bff-production.up.railway.app/app#dad_id=<uuid>&token=<token>
```

## Operator blurb

Paste-ready Chip description: [`CHIP_OPERATOR_BLURB.md`](CHIP_OPERATOR_BLURB.md).

## Curl smoke

```
./scripts/chip-deeplink-curl.sh
# or: BASE=http://127.0.0.1:8787 ./scripts/chip-deeplink-curl.sh
```

## Out of scope (this slice)

Dad HTML redesign, OAuth/MFA, CloudAgent, spend, Nick real case data, Railway deploy.
