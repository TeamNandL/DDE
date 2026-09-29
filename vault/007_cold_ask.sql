-- DDE vault — cold-ask hook on state (return loop).
--
-- When the dad's One Next was a cold ask (an outgoing court-safe request),
-- Chip stores what kind of Next it was and a short plain summary, both
-- PII-stripped at the write path (src/progress.js). The return loop then
-- greets with "Last time: cold ask — <summary>. How'd it go?" instead of
-- the generic line. Draft≠send rails unchanged — this never touches
-- communications.
--
-- Idempotent: safe to re-run via the store factory / schema:apply.
-- Apply after 001 (+003..006). RLS (002) stays documented-only.
--
-- Railway / any rented Postgres, one command from vault-app/:
--   DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DB" npm run schema:apply
-- or, with psql only:
--   psql "$DATABASE_URL" -f vault/007_cold_ask.sql

alter table state add column if not exists last_next_kind text;
alter table state add column if not exists last_ask_summary text;
