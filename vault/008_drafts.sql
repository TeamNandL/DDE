-- DDE vault — cold draft store (draft ≠ send).
--
-- A draft is a communication that was NEVER sent: direction='draft',
-- sent_at null, pipe='claim' (never verified — verified_export excludes it
-- by pipe). draft_kind tags what the draft is ('cold_ask' for now). The
-- write path (bff) runs harm → PII → venom before anything is stored.
-- There is NO send endpoint in this slice; /vault/comms/cold remains the
-- separate outgoing write and drafts never flow into it.
--
-- Idempotent: the drop+add pair re-applies safely on every boot.
-- Apply after 001 (+003..007). RLS (002) stays documented-only.
--
-- Railway / any rented Postgres, one command from vault-app/:
--   DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DB" npm run schema:apply
-- or, with psql only:
--   psql "$DATABASE_URL" -f vault/008_drafts.sql

alter table communications add column if not exists draft_kind text;

alter table communications drop constraint if exists communications_direction_check;
alter table communications add constraint communications_direction_check
  check (direction in ('outgoing','incoming','pull','draft'));
