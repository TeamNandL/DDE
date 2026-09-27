-- DDE vault — court-prep capture (COURT_PREP_PRINCIPLES §2–§5).
--
-- candidate_facts: every keyword hit from the dad's own words, structured
--   (who / what / when / kids), confidence 'low', claim pipe ONLY. The OFW
--   cross-check stub stamps status: 'not_proof_yet' (OFW silent or not
--   comparable), 'matched', or 'conflict' (+ ofw_ref and one parent line).
--   Candidates are never verified rows and never feed verified_export;
--   promotion is a later human-supervised pass (not built). OFW rows in
--   communications are read, never written, by the cross-check.
--
-- notifications: proactive check-ins — two windows per day (floor one),
--   unread → read → done; "missed" is computed at read time past due_end.
--   One row per (dad, kind, day, slot) so ensure is idempotent.
--
-- Idempotent (if not exists). Apply after 001..009. RLS (002) stays
-- documented-only — Auth + RLS is a separate, parked slice.
--
--   DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DB" npm run schema:apply
-- or: psql "$DATABASE_URL" -f vault/010_court_prep.sql

create table if not exists candidate_facts (
  id              uuid primary key,
  dad_id          uuid not null,
  pipe            text not null default 'claim' check (pipe = 'claim'),
  created_at      timestamptz not null default now(),
  source          text not null check (source in ('intake','tell','return')),
  source_event_id uuid,
  quote           text,
  who             text[] not null default '{}',
  what            text not null
                  check (what in ('cancelled','attended','late','time_with','schedule','mention')),
  when_text       text,
  when_on         date,
  kids            text[] not null default '{}',
  cues            text[] not null default '{}',
  confidence      text not null default 'low' check (confidence = 'low'),
  status          text not null default 'not_proof_yet'
                  check (status in ('not_proof_yet','matched','conflict')),
  ofw_ref         text,
  line            text not null
);

create index if not exists candidate_facts_dad_idx on candidate_facts (dad_id, created_at);

create table if not exists notifications (
  id         uuid primary key,
  dad_id     uuid not null,
  created_at timestamptz not null default now(),
  kind       text not null check (kind in ('check_in')),
  slot       text not null check (slot in ('morning','evening')),
  for_date   date not null,
  title      text not null,
  due_start  timestamptz not null,
  due_end    timestamptz not null,
  status     text not null default 'unread' check (status in ('unread','read','done')),
  unique (dad_id, kind, for_date, slot)
);

create index if not exists notifications_dad_idx on notifications (dad_id, due_start)
