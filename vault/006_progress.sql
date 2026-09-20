-- DDE vault — soft progress: this-week checklist counters on state.
--
-- this_week_done / this_week_total drive the plain-speech progress line
-- ("3 of 5 this week"). App clamps total to 3..7 and done to 0..total on
-- the write path (src/progress.js); the CHECKs back that rail up against
-- console writes. missing[] (001) stays the short checklist — app caps it
-- at 7 short strings. Nothing here touches pipe or the verified export.
--
-- Idempotent: safe to re-run via the store factory / schema:apply.
-- Apply after 001 (+003, 004, 005). RLS (002) stays documented-only.
--
-- Railway / any rented Postgres, one command from vault-app/:
--   DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DB" npm run schema:apply
-- or, with psql only:
--   psql "$DATABASE_URL" -f vault/006_progress.sql

alter table state add column if not exists this_week_done integer
  check (this_week_done is null or this_week_done >= 0);
alter table state add column if not exists this_week_total integer
  check (this_week_total is null or this_week_total between 3 and 7);
