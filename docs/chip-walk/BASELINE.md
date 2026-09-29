# Tip baseline — 79fbce1 (PR #8)

Contract detail: [`vault-app/CHIP_APP.md`](../../vault-app/CHIP_APP.md). This is the short version.

| Area | Live at tip |
| --- | --- |
| Chip setup | Two templates: public demo (no id/token — test-enforced) + per-dad. Token rides the URL hash only; `?token=` rejected. |
| Provision | `POST /vault/provision` → random token, stored as hash only. Seeds a 5-item kids-facts checklist ("0 of 5" on day one). |
| Vent intake | `POST /vault/intake` → claim write + chase items. Harm / PII / venom stripped first. Covers cancelled/denied visit, dated scheduling/refusal, pain + date, pasted statement → notice. |
| One Next | `state.next_action` — exactly one. |
| Return loop | `POST /vault/return` → "Last time: X. How'd it go?"; answer = one claim. Cold-ask variant. |
| Progress | `GET /vault/progress` → one `progress_line`. `/missing/fill`, `/missing/seed`. |
| Chip entry | `GET /vault/chip_entry` → pre-composed lines; null = say nothing. |
| Draft ≠ send | `POST /vault/comms/draft` → stored, graded ready/tighten. No send endpoint. Never verified. |
| Two pipes | Claim vs verified kept apart; intake rows never reach verified export. |
| Tests | 112/112 on Postgres 16 in CI (plus in-memory run). |

## Not done

| Gap | Blocks |
| --- | --- |
| Auth + RLS — `vault/002_rls_plan.sql` is a draft, all statements commented out. Bearer token is the only gate. | Any real dad (stop rule 4) |
| `scripts/chip-deeplink-curl.sh` is referenced in `CHIP_APP.md` but does not exist. | Nothing — doc gap only |
| Server has no log-file flag (`setLogFile` is not wired to the CLI). | Log capture during the walk — use response capture instead |
