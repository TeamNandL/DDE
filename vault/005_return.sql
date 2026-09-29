-- DDE vault — return loop: last-Next stamp on state.
--
-- last_next / last_next_at record the One Next that was shown to the dad
-- when he returned ("Last time: ___. How'd it go?"). Stamped only when a
-- next_action exists — an empty Next is never invented. The dad's answer
-- goes through the normal intake pipeline and writes claim rows; nothing
-- here touches pipe or the verified export.
--
-- Idempotent: safe to re-run via the store factory / schema:apply.
-- Apply after 001 (+003, 004). RLS (002) stays documented-only.
--
-- Railway / any rented Postgres, one command from vault-app/:
--   DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DB" npm run schema:apply
-- or, with psql only:
--   psql "$DATABASE_URL" -f vault/005_return.sql

alter table state add column if not exists last_next text;
alter table state add column if not exists last_next_at timestamptz;
