# Chip app — canonical vault contract

ADHD-short. Chip (Dad Grok Front Door) talks **only** to the HTTP BFF.
Never Supabase / Postgres direct. Fake family in demos only.

## Seats (two pipes — never merged)

| Seat | Pipe | Route |
| --- | --- | --- |
| Chip | front door — one pipe per message | — |
| Quill | vent → claim; notice line (`say`: "… Matter to you?") | `POST /vault/intake` + `make_notice` |
| Coach / Tone | vent hot → one cold draft, draft ≠ send (`say`: "Not sent. Next: …") | `POST /vault/comms/draft` |
| Quill — talk/text fork | "Want to tell me? Talk or text." → story → `feedback` | intake `fork` → `POST /vault/tell` |
| Eddie | state / One Next | `GET /vault/state` |

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

→ 200 { "dad_id": "<uuid>", "token": "dde-stub-<uuid>",
        "expires_at": "<iso, mint + 30 days>",
        "missing_one": "Kids school name",
        "progress_line": "0 of 5 this week; still open: Kids school name" }
→ 409 if that dad_id already provisioned
```

Provision **auto-seeds the kids_facts checklist** (same pack as
`/vault/missing/seed`: 5 blanks, total 5 / done 0) so Chip can speak
`progress_line` and ask about `missing_one` immediately. Non-empty
missing is never overwritten.

```
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

**Notice path (Chip sends `make_notice: true`):**

```
→ 200 { "written": 1, "chase": [], "noticed_text": "<record copy>", "event_id": "<uuid>",
        "say": "They cancelled your Friday visit. Matter to you?" }
```

**Talk/text fork (every Chip intake):** the `make_notice` reply also carries
`"fork": "Want to tell me? Talk or text."` (absent only when harm was heard).
Chip says it as the next beat — after the dad answers `say`, or at once when
there is no `say`. The dad's pick goes to:

```
POST /vault/tell
{ "dad_id": "<uuid>", "channel": "talk" | "text", "story": "<his words>" }
→ 200 { "written": 1, "channel": "talk", "feedback": "I heard you. It's kept as your account — not proof yet. Next: …" }
→ 200 { "written": 0, "channel": …, "feedback": null }   // harm heard: nothing kept, real help only
→ 400 bad channel / empty story
```

One claim event ('other', notes "Told by talk" / "Told by text"), harm →
PII → venom rails first, never verified. `feedback` is the same for talk
and text: ack + claim ≠ verified in plain words + exactly one Next
(`next_action`, spoken as words — never an OFW hop). Chip says it verbatim
and stops.

`say` is present only for a cancelled/denied visit: one plain noticed
sentence + "Matter to you?" — no date, no claim jargon, no Next. Chip says
it **verbatim and stops** that turn (no Next, no OFW, no login hop); the
Next comes only after the dad answers. `noticed_text` is the record copy —
never read aloud. Without `make_notice` the response stays `{written, chase}`.

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
        "next_action": … | null, "return_line": … | null,
        "latest_draft"?: { "soft_grade": "ready"|"tighten", "preview": "<first ~80 chars>" } }
```

`latest_draft` is the newest stored draft's hint (grade recomputed with
the same heuristic as the draft POST); the key is **omitted** when the
dad has no drafts.

Read-only: everything Chip says at entry, pre-composed and PII-stripped —
nulls mean say nothing (never invented). `return_line` is the same
greeting `POST /vault/return` gives, but this GET **never stamps
`last_next`** — still call the return POST for the loop itself.

### 9) Cold draft store (draft ≠ send)

```
POST /vault/comms/draft
{ "dad_id": "<uuid>", "body": "<cold ask text>", "kind"?: "cold_ask", "on_record"?: true }
→ 200 { "written": 1, "draft_id": "<uuid>", "body": "<stripped>",
        "soft_grade": "ready" | "tighten",   // ready = nothing stripped for tone and ≤ 280 chars; tighten = venom came out or runs long (stored either way); absent when written:0
        "mode": "document" | "de_escalate",
        "say": "Not sent. Next: …" }
→ 200 { "written": 0 }        // harm heard
→ 200 { "written": 0, "rewritten": false, "say": "<plain line>" }   // no clean, complete message possible
→ 200 { "written": 0, "rewritten": false, "route": "safety", "say": "…", "facts": [...] }   // impaired-care report: never a draft
→ 200 { "written": 0, "rewritten": false, "route": "check_in", "say": "…" }   // worn-out / hopeless: no draft, human check-in
→ 400 empty body / unknown kind
```

**Every draft is rewritten (Slice 19 + 19b).** No heat gate: the body is
never the dad's input and never a slice of it. A known issue (cancelled
time, late exchange, info not shared, adult topics the kids repeat,
activities on the dad's time, 529 / college-fund withdrawal) is rebuilt
from a behavior-only template that keeps concrete facts — dates, times,
durations, counts, amounts, notice, the real ask — and drops swearing,
insults and motive ("poisoning", "on purpose", "alienating",
"narcissist", "hiding", "make me look like…"). Anything else keeps every
clean, complete sentence the dad wrote plus "Thank you."; heat sentences
are dropped whole. If nothing clean and complete is left: no body, the
fail-safe `say`, nothing stored — Chip never repeats the vent.

- Safety (e.g. drunk at the exchange with the kids): `say` is exactly
  "This is serious. Document it exactly as it happened and take it to your
  lawyer before you send anything to her." `facts` lists what to write
  down (for the dad, not for her). No draft.
- Worn-out ("whatever… nobody listens"): `say` is a human check-in —
  "Sounds like a rough night. There's no message to send here - I just
  want to make sure you're alright. What's going on?" No draft.

Example: the Round Two vent becomes "My weekend parenting time was
cancelled again. Please let me know when we can schedule the make-up
time. Thank you."

```
GET /vault/comms/drafts?dad_id=<uuid>
→ 200 [ { "draft_id", "body", "kind", "created_at" } ]   // drafts ONLY
```

**Coach ≠ intake.** Coach's primary job is vent → one **sendable cold**
draft. The noticed sentence ("They cancelled your Friday visit. Matter to
you?") is Quill **intake** — a separate pipe, never Coach.

**De-escalate vs document-this.** When the dad says he wants the request
**on the record**, Chip sends `"on_record": true` with the draft: `mode`
is then always `document` (Next: send it — it puts your ask on the
record), even if the wording heuristic missed it. Without the flag the
heuristic decides; `on_record: false` never downgrades a detected record
ask. Same seat, same endpoint — no new seat.

**Coach / Tone seat (vent hot → send cold).** When the dad asks for words
("help me say something calm…"), Chip writes ONE cold, OFW-ready draft and
POSTs it here — never to intake. Chip shows the returned `body`, then says
`say` verbatim: draft ≠ send + exactly one Next, in one beat (no "hang
tight", no "draft next"). `mode` (Drift 2, de-escalate vs document):
`document` when the draft asks the co-parent for something on the record
(appointments, calendar, school, schedule — the medical-calendar ask is the
textbook case), so the Next is to send it; `de_escalate` otherwise, sending
optional. Behavior only — never the co-parent's motive.

Drafts are **never sent and never verified** (direction `draft`, no
`sent_at`, claim pipe) — there is **no send endpoint** for drafts; sending
stays a separate human decision via `/vault/comms/cold`. Harm → PII →
venom rails run before anything is stored.

### 10) Court-prep capture — Slice 13 (COURT_PREP_PRINCIPLES §2–§5)

Automatic on every non-harm intake (except statement drops — Track 2),
`/vault/tell`, and `/vault/return` answer: each keyword-hit sentence
(event cue or day/time cue) becomes ONE **candidate fact** — structured
`who / what / when_text / when_on / kids`, `confidence: "low"`, claim pipe
only, dollar amounts masked `[amount]`. No response shape changes.

**Sticky notes — "Needs reviewed".** To the dad each candidate is a
sticky note: it starts **Needs reviewed**; he keeps what's true and
tosses junk. Keeping does **not** make it proof — a kept note is still
his account (claim, low, "not proof yet") until OFW agrees. Tossed notes
are hidden, never deleted. Chip never asserts a note is true.

```
GET /vault/candidates?dad_id=<uuid>[&include_tossed=true]
→ 200 { "needs_reviewed": N,
        "candidates": [ { "id", "what", "who", "when_text", "when_on",
        "kids", "confidence": "low",
        "review": "needs_reviewed"|"kept"|"tossed", "label": "Needs reviewed"|"Kept"|"Tossed",
        "status": "not_proof_yet" | "matched" | "conflict",
        "line": "Yesterday: visit cancelled — your account, not proof yet.",
        "quote", "source", "created_at" } ] }
```

```
POST /vault/candidates/review { "dad_id", "id", "review": "keep" | "toss" }
→ 200 <the note>   // 400 bad review, 404 not this dad's note
```

**OFW stub (§3):** compares candidates with a resolved day against the
dad's stored OFW pulls (`POST /vault/comms/pull`, `channel: "ofw"`) — no
live OFW. Same day + same reading → `matched` ("OFW shows the same.");
same day + opposite reading → `conflict`, one line: "Yesterday: visit
cancelled — OFW for 2026-09-25 shows they came. Check before you rely on
it." OFW silent, no day, or not comparable → `not_proof_yet`. A new OFW
pull re-checks the dad's candidates. OFW rows are read, **never written**;
candidates never reach `verified_export`. Chip may say a `conflict` line
once, verbatim — never a motive, never a verdict.

**Check-ins / Notifications tab (§5):**

```
POST /vault/checkins/ensure { "dad_id", "date"?: "YYYY-MM-DD", "tz_offset_minutes"?: -240 }
→ 200 { "created": 0|1|2, "items": [ … ] }      // idempotent per day + slot

GET /vault/notifications?dad_id=<uuid>
→ 200 { "unread": N, "items": [ { "id", "kind": "check_in", "slot": "morning"|"evening",
        "for_date", "title", "due_start", "due_end",
        "status": "unread"|"read"|"done"|"missed" } ] }

POST /vault/notifications/mark { "dad_id", "id", "status": "read"|"done" }
```

Two windows a day — morning 8–12, evening 18–22 local (floor of one is
always met). `missed` is computed past `due_end`. Any tell / intake /
return answer inside an open window marks it `done`. No push — Chip calls
`ensure` at entry and says an open, unread item's `title` once.

### 11) Parenting Plan seat — Slice 14 (pointer)

**Default path = these BFF routes. Planform stays soft-hidden** (not
exposed, not linked; no Chip-vs-Planform ownership change).

| Route | Does |
|---|---|
| `POST /vault/plan/topics/ensure {dad_id}` | the finite checklist (six core topics) |
| `GET /vault/plan/topics?dad_id[&depth=deeper]` | status + `next` prompt (term explained first, menu) |
| `POST /vault/plan/answer {dad_id, topic, choice, stance?, depth?, detail?}` | menu keys only; `stance` want \| trade_bait; `depth` simple (default) \| deeper |
| `POST /vault/plan/stuck {dad_id, topic}` | 1st: ONE example · 2nd: park + move on |
| `POST /vault/plan/park {dad_id, topic}` | park now, move on |
| `POST /vault/plan/draft/regenerate {dad_id, kind: full\|prep}` | new bot-owned version |
| `GET /vault/plan/draft?dad_id&kind=full\|prep` | latest version |

Topic keys, easiest → hardest: `exchanges`, `holidays`, `schedule`,
`rofr`, `medical_access`, `decision_making`. Tie-breaker is offered as
"Ask for it. You can always give it back later." Medical gatekeeping is
named as a documentable pattern (behavior only, never why). Menus only —
every reply carries "Confirm every choice with your lawyer…"; not legal
advice; assumes the dad has a lawyer. Not Coach, not Quill, not OFW, not
court-prep capture: plan answers write none of those. No outside edits,
no Google Doc sync.

### 12) Process Translator — Slice 15 (pointer)

**Dictionary, not coach.** Paste a paper's text or name a term → plain
English: what it IS, how it generally works, what to be aware of. Never a
personal win/lose; "good or bad for me?" → a sharp question for the lawyer.
Every result carries the loud `lawyer_line`.

| Route | Does |
|---|---|
| `POST /vault/translate/explain {dad_id, term \| text}` | exactly one of `term` / `text` (V1: paste or named term only) |
| `GET /vault/translate/last?dad_id` | latest stored explanation |
| `GET /vault/translate/list?dad_id[&limit]` | ids + term keys, newest first |

Clocks: `clock` says a deadline exists — never a day-count, never a
state table. `calendar_candidates` are dates as written in the paste:
`visibility: private_only`, `status: candidate`, `verified: false`,
`write_target: null` — never written to OFW or any calendar. Also
explains lawyer-relationship basics (billing, updates, what to raise) —
never "replace your lawyer". Not Coach, not Quill, not Parenting Plan
(§11), not Legal Intake, no OFW case dates. MAP: deferred.

### 13) Involvement Cheat Sheet — Slice 16 (pointer)

**Living one-pager per kid. Say ONE Missing + ONE Next — never the whole
sheet.** `kid` is a short label (lowercase slug), never a full name.

| Route | Does |
|---|---|
| `POST /vault/involvement/ensure {dad_id, kid}` | the finite sheet for that kid |
| `GET /vault/involvement?dad_id[&kid]` | fields (display) + `speak` {missing, next} |
| `POST /vault/involvement/field {dad_id, kid, field, value}` | dad-entered value (claim) |
| `POST /vault/involvement/field {dad_id, kid, field, asked_on, asked_via, outcome}` | he asked, didn't get it |
| `GET /vault/involvement/next?dad_id[&kid]` | the one Missing + one Next |
| `GET /vault/involvement/export?dad_id&kid` | one-pager text + claim footer |

Fields: `grade`, `teacher`, `activities`, `friends`, `doctor`, `dentist`,
`allergies`, `meds`, `therapist`, `emergency_contact_known` (yes|no).
Jobs: deposition armor · asked-for blanks become a documentable pattern
("asked the school on 2026-09-10; no answer as of …") — behavior only,
never why · re-engagement (ask the school or provider directly). Values
are claims, never verified; no SSNs, no money. Not Stan/OFW, not
Parenting Plan (§11), not Process Translator (§12), not Coach, not Quill.

### 14) Legal Intake seat — Slice 17 (pointer)

**Intake + triage + handoff DRAFT. Never answers the law.** Every reply
leads with the loud `lawyer_line` and carries ONE `next`.

| Route | Does |
|---|---|
| `POST /vault/legal/intake {dad_id, who, what, urgency}` | capture v1; flags + route |
| `GET /vault/legal/intake?dad_id[&id]` | that intake (or latest) + latest draft |
| `POST /vault/legal/handoff {dad_id, id?}` | new packet draft — `sent_at: null`, never sent |

`who`: `co_parent`, `my_lawyer`, `their_lawyer`, `court`, `school`,
`provider`, `other`. `urgency` is the dad's pick (`today`, `this_week`,
`this_month`, `not_sure`) — the bot never decides a legal emergency.
Human-review `flags`: `safety`, `deadline_language`, `fire_lawyer`,
`custody_emergency`, `money_numbers`, `out_of_venture`. Emergency feel →
`human_review: true`, no numbers or jurisdiction rules invented. "What
does this paper mean?" → `route: process_translator` (§12); "what should I
do?" stays here and becomes a question for the lawyer. No send path, no
counsel channel. Not Coach, not Quill, not Parenting Plan (§11).

### Auth header

`Authorization: Bearer <token>` (preferred) or `X-DDE-Token: <token>`.
Zero extra auth theater — no OAuth, no login page, no MFA on this slice.

Auth matrix (Slice 18, every dad-scoped route): unknown dad → `404` ·
no or bad token → `401` · another dad's token → `403` · own token → the
route runs. After the gate, every database statement for that request runs
as the non-owner role `dde_app` bound to that dad, and Postgres row-level
security (`vault/015_auth_rls.sql`) limits reads and writes to his rows.
Chip only ever holds a dad's bearer token — never a database credential.
`POST /vault/provision` stays the only mint path; synthetic dads only until
the real-dad gate is opened by Nick.

### Token lifecycle (Slice 20 — logout / revoke / expiry)

Same gate as every dad route (404 / 401 / 403 above). A dead token can't
log itself out — that's a `401`, not an error to retry.

```
POST /vault/logout        { "dad_id": "<uuid>" }  + Bearer
→ 200 { "logged_out": true }   // ONLY the presented token dies

POST /vault/token/revoke  { "dad_id": "<uuid>" }  + Bearer
→ 200 { "revoked": <n> }       // EVERY token for this dad dies, caller's too
```

**Expiry.** Every token expires `DDE_TOKEN_TTL_DAYS` (default **30**) after
mint; provision returns `expires_at`. Tokens minted before Slice 20 (no
`expires_at`) expire at `created_at` + TTL. Expired → `401 {"error":"token
expired"}`; revoked / unknown → `401 {"error":"unauthorized"}`. Chip on
either 401: stop, tell the dad his link needs a refresh — never retry, never
provision again (provision on an existing dad is `409`).

**New token after logout / revoke / expiry: operator only.** No HTTP route
mints or reissues. Operator runs, with the server's `DATABASE_URL` (or
`DDE_TOKENS_PATH`):

```
npm run token:reissue -- --dad-id <uuid>   # revoke all, print one fresh token + expires_at
npm run token:revoke  -- --dad-id <uuid>   # revoke all (lost phone / leaked link)
```

Revoke never touches vault data — only tokens.

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

## Standing principles (court-prep / Chip conversation)

Non-negotiable source rules for over-capture, keyword candidates, OFW
cross-check, structured account facts, and proactive check-ins live in
[`COURT_PREP_PRINCIPLES.md`](COURT_PREP_PRINCIPLES.md). Obey them; do not
weaken in code or copy without Nick exact-yes.

## Operating spine (Mamba principles)

DDE product / Chip operating principles (process → craft, journey over
result, learn from the greats, keep showing up) live in
[`MAMBA_PRINCIPLES.md`](MAMBA_PRINCIPLES.md). Use that file — not the
third-party “Bryant’s 10 Rules” poster list.
