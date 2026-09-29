-- DDE vault — Evidence capture skeleton (Slice 23).
--
-- Hash log only. The client sends a content sha256; this table stores the
-- hash and a low-confidence filename/format guess. It does not store file
-- content, a storage pointer, a page range, or a vent body.
--
-- Every row is stage = logged and routing = inbox_unmapped. There is no
-- verified promotion path on this table: stage cannot change, and a guess
-- confidence cannot be anything but low. Exhibit / verified_export does
-- not read this table. Quill intake (/vault/intake) does not write here.
--
-- needs_ocr is reserved and locked false. Nothing here runs OCR.
--
-- Unique (dad_id, hash): a repeat log is the same row.
-- RLS: dde_app + dde_current_dad(), same shape as vault/015_auth_rls.sql.
-- Idempotent. Apply after 016.
--
-- Down: drop table if exists evidence;

create table if not exists evidence (
  id                   uuid primary key,
  dad_id               uuid not null,
  hash                 text not null check (hash ~ '^[0-9a-f]{64}$'),
  schema_version       int not null default 1 check (schema_version = 1),
  stage                text not null default 'logged' check (stage = 'logged'),
  routing              text not null default 'inbox_unmapped' check (routing = 'inbox_unmapped'),
  possession           text not null default 'held'
                       check (possession in ('held', 'not located', 'user says none')),
  doc_type_guess       text
                       check (doc_type_guess is null or doc_type_guess in
                         ('statement','tax_return','photo','screenshot','court','other')),
  doc_type_confidence  text
                       check (doc_type_confidence is null or doc_type_confidence = 'low'),
  original_filename    text check (original_filename is null or length(original_filename) <= 255),
  format               text check (format is null or length(format) <= 64),
  needs_ocr            boolean not null default false check (needs_ocr = false),
  created_at           timestamptz not null default now(),
  unique (dad_id, hash),
  constraint evidence_guess_low_only check (
    (doc_type_guess is null and doc_type_confidence is null)
    or (doc_type_guess is not null and doc_type_confidence = 'low')
  )
);

create index if not exists evidence_dad_created_idx
  on evidence (dad_id, created_at desc);

alter table evidence enable row level security;

grant select, insert, update, delete on evidence to dde_app;

drop policy if exists dde_own_rows on evidence;

create policy dde_own_rows on evidence
  for all
  to dde_app
  using (dad_id = dde_current_dad())
  with check (dad_id = dde_current_dad());
