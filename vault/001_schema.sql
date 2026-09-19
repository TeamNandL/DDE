-- DDE Gate 2 vault — Phase 1 schema (kickoff §3)
-- Four data types + month_summary. Two-pipe rule on every row. Tenant = one
-- dad (dad_id on every row). RLS is DOCUMENTED ONLY in Phase 1 — see
-- vault/002_rls_plan.sql; it is enforced when auth lands.
--
-- Rails baked in here:
--   * pipe ∈ {claim, verified} — no third value, no null (CHECK)
--   * verified rows require source_ref (CHECK)
--   * month_summary pattern_tags: observable behavior only (CHECK allowlist)
--   * documents: bytes never in this table — storage_uri is a ref only
--   * verified_export view is the ONLY read surface for Reporting

-- ---------------------------------------------------------------------------
-- events — the time log
create table if not exists events (
  id            uuid primary key default gen_random_uuid(),
  dad_id        uuid not null,
  pipe          text not null check (pipe in ('claim','verified')),
  created_at    timestamptz not null default now(),
  source_ref    text,          -- id/URI of the verified source when pipe='verified'; null for claim
  raw_quote     text,          -- dad's own words for claim rows; null or source excerpt for verified

  event_type    text not null check (event_type in
                  ('exchange','denied_visit','late_exchange','visit','call','other')),
  occurred_at   timestamptz not null,
  scheduled_at  timestamptz,   -- when it was supposed to happen, if applicable
  location      text,
  kids          text[],        -- fake-family names only in demo
  notes         text,          -- observable description only, no characterization of co-parent

  constraint events_verified_needs_source
    check (pipe <> 'verified' or source_ref is not null)
);

-- Intake writes pipe='claim' only; verified events come from the record pipe
-- (OFW exports) and carry source_ref. Claims point at verified rows; they
-- never replace them. (App-enforced in the intake write path.)

-- ---------------------------------------------------------------------------
-- communications — messages and pulls
create table if not exists communications (
  id            uuid primary key default gen_random_uuid(),
  dad_id        uuid not null,
  pipe          text not null check (pipe in ('claim','verified')),
  created_at    timestamptz not null default now(),
  source_ref    text,
  raw_quote     text,

  direction     text not null check (direction in ('outgoing','incoming','pull')),
  channel       text check (channel in ('ofw','text','email','other')),
  body_cold     text,          -- the cleaned, court-safe outgoing text (outgoing only)
  sent_at       timestamptz,

  constraint communications_verified_needs_source
    check (pipe <> 'verified' or source_ref is not null)
);

-- Venom stripped from the vent is NOT stored here. Only the cold sentence
-- that goes out, or the verified pulled record.

-- ---------------------------------------------------------------------------
-- documents — gathered files and their meaning (bytes NEVER in this table)
create table if not exists documents (
  id            uuid primary key default gen_random_uuid(),
  dad_id        uuid not null,
  pipe          text not null check (pipe in ('claim','verified')),
  created_at    timestamptz not null default now(),
  source_ref    text,
  raw_quote     text,

  doc_type      text not null check (doc_type in
                  ('statement','tax_return','photo','screenshot','court','other')),
  storage_uri   text,          -- Phase 1: placeholder/null. Phase 4: object storage ref
  extracted     jsonb,         -- figures/facts pulled out of the file (verified pipe)
  period_start  date,
  period_end    date,

  constraint documents_verified_needs_source
    check (pipe <> 'verified' or source_ref is not null)
);

-- ---------------------------------------------------------------------------
-- state — where the dad is. One row per dad_id, upserted.
create table if not exists state (
  id            uuid primary key default gen_random_uuid(),
  dad_id        uuid not null unique,
  pipe          text not null default 'claim' check (pipe in ('claim','verified')),
  created_at    timestamptz not null default now(),
  source_ref    text,
  raw_quote     text,

  phase         text not null default 'intake',
  this_week     text,
  missing       text[] not null default '{}',  -- top items to chase
  next_action   text,                          -- exactly one
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- month_summary — per-month digest (Fix 4)
create table if not exists month_summary (
  id            uuid primary key default gen_random_uuid(),
  dad_id        uuid not null,
  pipe          text not null check (pipe in ('claim','verified')),
  created_at    timestamptz not null default now(),
  source_ref    text,
  raw_quote     text,

  month         date not null,  -- first of month
  summary_text  text,
  highlights    text[] not null default '{}',
  pattern_tags  text[] not null default '{}',
  source_refs   text[] not null default '{}',

  constraint month_summary_verified_needs_source
    check (pipe <> 'verified' or source_ref is not null),
  -- observable behavior only — NEVER a personality/clinical term
  constraint month_summary_observable_tags
    check (pattern_tags <@ array['late_exchange','denied_visit','schedule_change']::text[])
);

-- pipe='verified' only when EVERY source_ref resolves to a verified row.
-- App-enforced in the write path (an unverified ref forces pipe='claim').

-- ---------------------------------------------------------------------------
-- indexes: tenant key on every table
create index if not exists events_dad_idx on events (dad_id, occurred_at);
create index if not exists communications_dad_idx on communications (dad_id, sent_at);
create index if not exists documents_dad_idx on documents (dad_id);
create index if not exists month_summary_dad_idx on month_summary (dad_id, month);

-- ---------------------------------------------------------------------------
-- views (read-only)

-- verified_export — union of all tables where pipe='verified'. The ONLY
-- thing Reporting or any attorney helper may read. There is no claim
-- counterpart, by design.
create or replace view verified_export as
  select 'events' as source_table, id, dad_id, pipe, created_at, source_ref,
         to_jsonb(events.*) as row
    from events where pipe = 'verified'
  union all
  select 'communications', id, dad_id, pipe, created_at, source_ref,
         to_jsonb(communications.*)
    from communications where pipe = 'verified'
  union all
  select 'documents', id, dad_id, pipe, created_at, source_ref,
         to_jsonb(documents.*)
    from documents where pipe = 'verified'
  union all
  select 'month_summary', id, dad_id, pipe, created_at, source_ref,
         to_jsonb(month_summary.*)
    from month_summary where pipe = 'verified';

-- affidavit_support — verified documents + verified events shaped for the
-- financial-disclosure sheet. STUB SHAPE ONLY in Phase 1; populated in
-- Phase 5.
create or replace view affidavit_support as
  select d.dad_id,
         'document'::text as kind,
         d.id,
         d.doc_type as detail,
         d.extracted,
         d.period_start,
         d.period_end
    from documents d where d.pipe = 'verified'
  union all
  select e.dad_id,
         'event',
         e.id,
         e.event_type,
         null::jsonb,
         e.occurred_at::date,
         e.occurred_at::date
    from events e where e.pipe = 'verified';
