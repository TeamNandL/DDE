-- DDE vault — Evidence capture SKELETON (Slice 23). Hash-log → inbox_unmapped.
--
-- ONE new table. The documents table is NOT extended (Nick lock 2026-09-28).
--
--   evidence — one row per file the dad's client has HASHED and logged.
--     The bytes never come here (storage_uri / bytes / page_range /
--     evidence_requirement_link are deferred — no column exists for them).
--     What lands: the client sha256, a filename + mime (PII-stripped by the
--     BFF), a LOW-confidence kind guess, and two locked pins:
--       stage      = 'logged'          (the only value this slice knows)
--       routing    = 'inbox_unmapped'  (nothing is filed, mapped or sorted)
--     confidence is locked 'low' and claim_status locked 'claim': a hash-log
--     row is never verified, never Exhibit. needs_ocr is a FLAG the client
--     may set; there is no OCR worker and OCR is never truth.
--     schema_version pins the row shape (1) so a later slice can migrate
--     rows forward instead of guessing what they meant.
--
-- Not evidence doctrine: Figures owns that. Not Quill: POST /vault/intake
-- (vent) never writes here and vent text never lands here.
-- verified_export / affidavit_support are NOT touched — this table has no
-- pipe column and is never unioned in, so Exhibit stays empty for these rows.
--
-- Dad-scoped: RLS on + the same dde_own_rows policy 015 gives every dad
-- table (dde_current_dad() comes from 015; apply after 016).
-- Idempotent. Statement-split safe (no semicolons inside literals).
--   psql "$DATABASE_URL" -f vault/017_evidence.sql

create table if not exists evidence (
  id              uuid primary key,
  dad_id          uuid not null,
  created_at      timestamptz not null default now(),
  sha256          text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  filename        text check (filename is null or length(filename) <= 255),
  mime            text check (mime is null or length(mime) <= 128),
  kind_guess      text not null check (kind_guess in
                    ('statement','tax_return','photo','screenshot','court','other')),
  confidence      text not null default 'low' check (confidence = 'low'),
  stage           text not null default 'logged' check (stage = 'logged'),
  routing         text not null default 'inbox_unmapped' check (routing = 'inbox_unmapped'),
  needs_ocr       boolean not null default false,
  claim_status    text not null default 'claim' check (claim_status = 'claim'),
  schema_version  int not null default 1 check (schema_version = 1),
  unique (dad_id, sha256)
);

create index if not exists evidence_dad_created on evidence (dad_id, created_at desc);

alter table evidence enable row level security;
grant select, insert, update, delete on evidence to dde_app;
drop policy if exists dde_own_rows on evidence;
create policy dde_own_rows on evidence for all to dde_app
  using (dad_id = dde_current_dad())
  with check (dad_id = dde_current_dad());
