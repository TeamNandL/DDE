-- DDE vault — Parenting Plan seat (Slice 14).
--
-- plan_topics: the dad's finite topic checklist (core six). Answers are
--   MENU KEYS only — no free text, so no PII / SSNs can land here.
--   stance 'want' | 'trade_bait'; depth 'simple' (default) | 'deeper';
--   status 'open' | 'answered' | 'parked'. example_shown enforces the
--   stuck rule: one example, then park, never a second example.
--
-- plan_drafts: bot-owned, versioned drafts ('full' plan or lawyer 'prep'
--   sheet) regenerated from plan_topics. Append-only — there is no edit
--   path and no outside sync. Not evidence: never feeds verified_export.
--
-- Idempotent. Apply after 001..010. RLS (002) stays documented-only.
--   psql "$DATABASE_URL" -f vault/011_parenting_plan.sql

create table if not exists plan_topics (
  dad_id        uuid not null,
  topic_key     text not null
                check (topic_key in ('exchanges','holidays','schedule','rofr','medical_access','decision_making')),
  position      int not null,
  status        text not null default 'open' check (status in ('open','answered','parked')),
  choice        text,
  detail        text,
  stance        text check (stance in ('want','trade_bait')),
  depth         text not null default 'simple' check (depth in ('simple','deeper')),
  example_shown boolean not null default false,
  updated_at    timestamptz not null default now(),
  primary key (dad_id, topic_key)
);

create table if not exists plan_drafts (
  id         uuid primary key,
  dad_id     uuid not null,
  version    int not null,
  kind       text not null check (kind in ('full','prep')),
  body       text not null,
  created_at timestamptz not null default now(),
  unique (dad_id, version)
)
