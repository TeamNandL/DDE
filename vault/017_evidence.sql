-- DDE vault — Evidence skeleton (Slice 23).
--
-- A hash log is not a vent and not a document. Intake (the vent) never
-- writes here. This file does not alter `documents` and stores no bytes:
-- the only content identity is a sha256 hex digest.
--
--   schema_version — pinned to 1 on every create. A later slice migrates
--                    rows forward instead of guessing the old shape.
--   possession     — where the original file is. The vault does not hold
--                    bytes. 'held' | 'not located' | 'user says none'.
--   stage          — skeleton has one value: 'logged'
--   routing        — skeleton has one value: 'inbox_unmapped'
--                    (the GET inbox reads this bucket)
--   unique (dad_id, sha256) — the same hash may exist for two dads;
--                    one dad cannot log it twice
--   filename_guess — optional basename only. Confidence is locked to
--                    'low' whenever a guess is stored. A name is not the file.
--
-- This table is not in verified_export. A logged hash is never Exhibit.
--
-- RLS matches vault/015_auth_rls.sql: dde_app, dde_own_rows, dad_id =
-- dde_current_dad(). Idempotent. Apply after 016.
--
-- One-step rollback to 6fce1d2: that commit never reads this table.
--   drop table if exists evidence_log;
--
--   psql "$DATABASE_URL" -f vault/017_evidence.sql

create table if not exists evidence_log (
  id                   uuid primary key,
  dad_id               uuid not null,
  created_at           timestamptz not null default now(),
  sha256               text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  schema_version       int not null default 1,
  possession           text not null default 'held',
  stage                text not null default 'logged' check (stage = 'logged'),
  routing              text not null default 'inbox_unmapped' check (routing = 'inbox_unmapped'),
  filename_guess       text check (filename_guess is null or length(filename_guess) <= 180),
  filename_confidence  text,
  constraint evidence_log_dad_hash unique (dad_id, sha256),
  constraint evidence_log_schema_version check (schema_version = 1),
  constraint evidence_log_possession check (possession in ('held', 'not located', 'user says none')),
  constraint evidence_log_filename_low_conf check (
    (filename_guess is null and filename_confidence is null)
    or (filename_guess is not null and filename_confidence = 'low')
  )
);

-- Re-apply onto a table created before schema_version / possession existed.
alter table evidence_log add column if not exists schema_version int not null default 1;
alter table evidence_log add column if not exists possession text not null default 'held';
alter table evidence_log drop constraint if exists evidence_log_schema_version;
alter table evidence_log add constraint evidence_log_schema_version check (schema_version = 1);
alter table evidence_log drop constraint if exists evidence_log_possession;
alter table evidence_log add constraint evidence_log_possession check (
  possession in ('held', 'not located', 'user says none')
);

create index if not exists evidence_log_dad_created_idx
  on evidence_log (dad_id, created_at desc);

alter table evidence_log enable row level security;
grant select, insert, update, delete on evidence_log to dde_app;
drop policy if exists dde_own_rows on evidence_log;
create policy dde_own_rows on evidence_log for all to dde_app
  using (dad_id = dde_current_dad())
  with check (dad_id = dde_current_dad());
