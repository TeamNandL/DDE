# Walk runbook — Alex Rivera, three pastes

Run against **tip on localhost**, never live Railway, never Postgres with real data.

## 1. Start tip (in-memory, fake family)

```
cd vault-app
npm ci
npm run serve -- --http --demo --port 8787
```

`--demo` seeds Alex Rivera · Jordan Lee · Sam (8) · Taylor (5) in memory only.

## 2. Provision a walk dad

```
curl -s -X POST http://127.0.0.1:8787/vault/provision -H 'Content-Type: application/json' -d '{}'
```

Keep `dad_id` + `token` in your shell only. Never paste the token into the friction log.

## 3. Per paste (repeat for pastes 1–3 from `DAD_CHIP_TEST_SCRIPT.md`)

| Step | Call | Capture |
| --- | --- | --- |
| a | `GET /vault/chip_entry` | What Chip would say before the paste |
| b | `POST /vault/intake` with the paste as `text` | `written`, `chase[]` |
| c | `GET /vault/state` | `missing[]` before → after, `next_action` |
| d | `GET /vault/chip_entry` | Lines Chip says after |
| e | If the script asks for a reply draft: `POST /vault/comms/draft` | `soft_grade`, stripped `body` |

Save every response to `walk-out/paste-N-<step>.json` (gitignored — do not commit).

## 4. Friction checks (per paste)

| Type | Check | It's friction when… |
| --- | --- | --- |
| **Miss** | `written`, `chase[]`, notice text | The script expects a claim/notice and got `written: 0` or no chase |
| **Wrong tone** | Every spoken line (`progress_line`, `return_line`, `next_action`, draft body) | Shames, lectures, guesses the ex's motive, or is not ADHD-short. Razor cold-checks each line. |
| **Missing Next** | `next_action` | Null when there is work, or more than one Next implied |
| **Leak** | All response bodies | Token, dad_id, URL, `$` / dollar amount, real name, or a draft showing `sent_at` / verified |
| **On-the-record** | Paste content | Paste asks for something on the record and Chip does not flag de-escalate vs document |

## 5. Return beat (after paste 3)

`POST /vault/return` with no `answer` → check `line` is plain speech, no token/URL/id. Then send one `answer` → check `written: 1` (or `0` if harm).

## 6. Hand-off

Log each friction item in [`FRICTION_LOG.md`](FRICTION_LOG.md). Zero rows = no code slice. One row = one slice, briefed by Forge.
