# Chip app — canonical vault contract

ADHD-short. Chip (Dad Grok Front Door) talks **only** to the HTTP BFF.
Never Supabase / Postgres direct. Fake family in demos only.

## Two-object Chip (tenant bind)

| Object | Template | Carries |
| --- | --- | --- |
| **Public** demo/door (one, findable) | [`CHIP_PUBLIC_TEMPLATE.md`](CHIP_PUBLIC_TEMPLATE.md) | fake-family demo only — **zero** dad_id/token/live URL (test-enforced) |
| **Per-dad** vault-bound (one per dad, private) | [`CHIP_DAD_TEMPLATE.md`](CHIP_DAD_TEMPLATE.md) | `{{BASE}}`/`{{DAD_ID}}`/`{{TOKEN}}` slots, filled at bind |

Bind = provision once → fill the per-dad template → open the **hash-only**
deep link (`{{BASE}}/app#dad_id=…&token=…`). `test/chip-template.test.js`
keeps the public template clean and proves the bind flow end-to-end.

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

### 4) Return loop (dad comes back)

```
POST /vault/return
Authorization: Bearer <token>
Content-Type: application/json
{ "dad_id": "<uuid>", "answer"?: "<what the dad says>" }

→ 200 { "last_next": "<the One Next that was pending>" | null,
        "line": "Last time: <last_next>. How'd it go?" | null,
        "written"?: N, "chase"?: [ … ] }   // only when answer sent
```

Chip flow: on return, POST with no `answer` → say `line` verbatim. **`line`
is plain speech — it never contains a token, URL, or dad_id; Chip must not
append them.** `line: null` means there is no pending Next — greet normally,
do **not** invent a "last time". The dad's reply goes back as `answer` (same
call) and writes claim through the intake pipeline (harm/PII/venom rails
apply).

**Answer → claim:** the dad's reply goes back as `answer` on the same call
and becomes exactly **one** claim event (`notes: "Return: how'd it go"`,
or `"Return: cold ask follow-up"` when the Next was a cold ask;
`raw_quote` = the harm/PII/venom-stripped answer — harm means nothing is
stored and `written: 0`). Response adds `written: 0|1`; no `answer` sent →
no claim write and no `written` key. A present-but-blank `answer` → 400.
Never verified — Exhibit never sees these rows.

**Cold-ask hook:** when the Next was a cold ask, Chip stores it on state at
send time via `PUT /vault/state`:

```
{ "dad_id": "<uuid>", "last_next_kind": "cold_ask",
  "last_ask_summary": "Sat window both kids 10–6" }
```

Both fields are PII-stripped on write (summary ≤ 120 chars). The next
return then greets: `Last time: cold ask — Sat window both kids 10–6.
How'd it go?` — kind without summary (or no kind) falls back to the
generic line. Draft≠send unchanged: this hook never writes comms rows.

### 5) Soft progress (this week only)

```
GET /vault/progress?dad_id=<uuid>
Authorization: Bearer <token>

→ 200 { "line": "3 of 5 this week" | null,
        "missing_one": "<first checklist item>" | null,
        "grade": "<one warm line>" | null,
        "progress_line": "3 of 5 this week; still open: <one item>" | null }
```

**`progress_line` is the one to speak** — ADHD-short, counters plus at
most one open item, PII-stripped. Null → say nothing (no counters set;
never invent). It also rides the `POST /vault/return` payload so Chip can
say it once on return, after the greeting `line`.

Chip says `line` and `grade` verbatim when present; all three can be null —
say nothing extra, invent nothing. Counters set via
`PUT /vault/state { this_week_done, this_week_total }` (total clamps 3–7,
done 0–total; `missing[]` caps at 7 short items). Grade is encouragement
only — never shame.

### 6) Fill one Missing (dad answers the checklist ask)

```
POST /vault/missing/fill
Authorization: Bearer <token>
Content-Type: application/json
{ "dad_id": "<uuid>", "answer": "<what the dad says>" }

→ 200 { "written": 1, "missing_one": "<next item>" | null,
        "progress_line": "2 of 3 this week; still open: …" | null }
→ 200 { "written": 0, "missing_one": null, "progress_line": null }  // empty checklist
```

Closes `missing[0]` (the item Chip asked about) as one claim event; the
answer rides the intake rails (harm → discarded + nothing shifted; PII and
venom stripped before storage). `this_week_done` bumps by one only when a
total is set and not yet reached. Chip then speaks `progress_line` and asks
about the new `missing_one`, or moves on when null.

### 7) Seed the checklist (kids-facts pack)

```
POST /vault/missing/seed
Authorization: Bearer <token>
Content-Type: application/json
{ "dad_id": "<uuid>", "pack"?: "kids_facts" }   // pack defaults to kids_facts

→ 200 { "written": 1, "missing_one": "Kids school name",
        "progress_line": "0 of 5 this week; still open: Kids school name" }
→ 200 { "written": 0, "missing_one": "<existing first item>",
        "progress_line": … }                     // checklist not empty: no overwrite
```

Seeds an **empty** checklist with 5 PII-safe blank labels (school name,
teacher, pediatrician/clinic, pickup person, emergency-contact
relationship) — prompts only, never case data. Counters go to 5/0 only
when **both** were null; existing counters are never touched. The dad
then fills them one at a time via `/vault/missing/fill`. Unknown pack →
400.

### 8) Chip entry bundle (speak without composing)

```
GET /vault/chip_entry?dad_id=<uuid>
Authorization: Bearer <token>

→ 200 { "progress_line": … | null, "missing_one": … | null,
        "next_action": … | null, "return_line": … | null }
```

Read-only: everything Chip says at entry, pre-composed and PII-stripped —
nulls mean say nothing (never invented). `return_line` is the same
greeting `POST /vault/return` gives, but this GET **never stamps
`last_next`** — still call the return POST for the loop itself.

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
