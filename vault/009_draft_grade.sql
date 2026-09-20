-- DDE vault — persist the draft soft grade (Razor: chip_entry must return
-- the SAME grade the draft POST did).
--
-- The grade is computed once at POST /vault/comms/draft from PRE-strip
-- knowledge (venom that was stripped, tone flags, length) and stored with
-- the row. Reads never recompute from the cleaned body alone — the venom
-- that earned "tighten" is already gone from it.
--
-- Idempotent: safe to re-run via the store factory / schema:apply.
-- Apply after 001 (+003..008). RLS (002) stays documented-only.
--
-- Railway / any rented Postgres, one command from vault-app/:
--   DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DB" npm run schema:apply
-- or, with psql only:
--   psql "$DATABASE_URL" -f vault/009_draft_grade.sql

alter table communications add column if not exists soft_grade text;
