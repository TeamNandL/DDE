# vault-app — Phase 1 local in-memory proof

Local, in-memory proof of the Gate 2 vault per `CLAUDE_CODE_PHASE1_KICKOFF.md`.
No database, no network, no cloud. This exists only to prove the rails before
anything is created on rented Postgres (Supabase creation is blocked until
Nick's exact-yes).

## What this proves

- Four data types plus `month_summary` (§3 semantics, in-memory)
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
src/vault.js    in-memory tables + views + write gates (mirrors §3)
src/extract.js  the middle layer (§4): harm_check → strip_venom →
                extract_fields → tag_pipe → write → claim_chase
src/bff.js      thin BFF (§5): function-per-endpoint, no HTTP yet
src/logger.js   hygiene logger — IDs only, capturable for grep
test/phase1.test.js  §6 tests 1–8
FIXED_VENT.md   the fixed vent (Alex Rivera) used as standard input
```

## Run

```
cd vault-app
npm test
```

Log output from the run lands in `test-output/run.log` for the hygiene grep
(test 7 / §8 report).

## Rented Postgres (test 9)

`src/sqlvault.js` is the Postgres-backed vault path over
`vault/001_schema.sql`. Test 9 (Monday→Friday milestone,
`test/phase1.pg.test.js`) runs ONLY through the app write path:
extract → BFF → SqlVault → node-postgres → rented Postgres. Console SQL,
dashboard inserts, or any other channel that bypasses the app is not a
valid proof of this milestone.

To run it: `npm install`, set `DATABASE_URL` in the environment, then
`npm test`. The connection string and its password live **only** in the
environment — never commit them. Without `DATABASE_URL`, or where the
network blocks the database host, the test skips and test 9 counts as
BLOCKED, not passed.

## Rails (non-negotiable)

Fake family only: Alex Rivera (dad) · Jordan Lee (co-parent) · Sam (8) ·
Taylor (5). No real case data, ever. Education and organization only.
