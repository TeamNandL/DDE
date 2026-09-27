-- DDE vault — Process Translator (Slice 15). Dictionary, not coach.
--
-- translations: one row per explain call. input_kind 'term' | 'paste'.
--   input_cold is the PII-STRIPPED input (never the raw paste — no SSNs,
--   account numbers, phones, emails, addresses). result is the bot-built
--   explanation (general mechanics + awareness + lawyer asks). Never
--   evidence: never feeds verified_export, never an intake event.
--
-- translator_calendar_candidates: dates AS WRITTEN in a pasted paper.
--   visibility is locked to 'private_only' and status to 'candidate' —
--   a claim, not a verified date. There is no write target column: no
--   OFW write, no Google / in-app calendar write (target still open).
--
-- Idempotent. Apply after 001..011. RLS (002) stays documented-only.
--   psql "$DATABASE_URL" -f vault/012_process_translator.sql

create table if not exists translations (
  id              uuid primary key,
  dad_id          uuid not null,
  created_at      timestamptz not null default now(),
  input_kind      text not null check (input_kind in ('term','paste')),
  input_cold      text not null,
  term_keys       text[] not null default '{}',
  verdict_request boolean not null default false,
  clock_flag      boolean not null default false,
  result          jsonb not null
);

create index if not exists translations_dad_created on translations (dad_id, created_at desc);

create table if not exists translator_calendar_candidates (
  id             uuid primary key,
  dad_id         uuid not null,
  translation_id uuid not null references translations(id),
  created_at     timestamptz not null default now(),
  label          text not null,
  date_text      text not null,
  on_date        date,
  visibility     text not null default 'private_only' check (visibility = 'private_only'),
  status         text not null default 'candidate' check (status = 'candidate')
)
