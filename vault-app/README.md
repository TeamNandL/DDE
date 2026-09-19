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

## Rails (non-negotiable)

Fake family only: Alex Rivera (dad) · Jordan Lee (co-parent) · Sam (8) ·
Taylor (5). No real case data, ever. Education and organization only.
