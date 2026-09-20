-- DDE vault — statement → notice slice: noticed stamp on events.
--
-- noticed_at / noticed_text mark that a cold, court-safe, PII-free notice
-- string was produced from a claim event. Pipe is NOT changed by noticing:
-- a noticed row stays 'claim' until verified, so verified_export and
-- affidavit_support are unchanged and a claim-only noticed row never
-- appears in either.
--
-- Idempotent: safe to re-run via the store factory / schema:apply.
-- Apply after 001 (+003). RLS (002) stays documented-only.
--
-- Railway / any rented Postgres, one command from vault-app/:
--   DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DB" npm run schema:apply
-- or, with psql only:
--   psql "$DATABASE_URL" -f vault/004_noticed.sql

alter table events add column if not exists noticed_at timestamptz;
alter table events add column if not exists noticed_text text;

create index if not exists events_noticed_idx on events (dad_id, noticed_at);
