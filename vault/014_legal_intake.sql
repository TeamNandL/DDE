-- DDE vault — Legal Intake seat (Slice 17). Intake + triage + handoff draft.
-- Never answers the law.
--
-- legal_intakes: v1 capture only — who (menu), what (PII-stripped, money
--   and out-of-venture mentions redacted; a claim, never verified), urgency
--   (the DAD's menu pick — the bot never decides a legal emergency).
--   flags = human-review flags; route = lawyer_handoff | process_translator
--   (decode-this-paper goes to the Translator, "what should I do?" stays).
--
-- legal_handoff_drafts: versioned handoff packet drafts for the dad's
--   lawyer path. sent_at is LOCKED NULL by CHECK — draft ≠ send. There is
--   no recipient / counsel-contact column (that channel is still open).
--
-- Not evidence: never feeds verified_export, never an intake event (Quill),
-- never an OFW row. Idempotent. Apply after 001..013. RLS (002) stays
-- documented-only (Auth+RLS is Slice 18).
--   psql "$DATABASE_URL" -f vault/014_legal_intake.sql

create table if not exists legal_intakes (
  id           uuid primary key,
  dad_id       uuid not null,
  created_at   timestamptz not null default now(),
  who          text not null
               check (who in ('co_parent','my_lawyer','their_lawyer','court','school','provider','other')),
  what_cold    text not null check (length(what_cold) <= 2000),
  urgency      text not null check (urgency in ('today','this_week','this_month','not_sure')),
  flags        text[] not null default '{}'
               check (flags <@ array['safety','deadline_language','fire_lawyer','custody_emergency',
                                     'money_numbers','out_of_venture']::text[]),
  route        text not null check (route in ('lawyer_handoff','process_translator')),
  claim_status text not null default 'claim' check (claim_status = 'claim')
);

create index if not exists legal_intakes_dad_created on legal_intakes (dad_id, created_at desc);

create table if not exists legal_handoff_drafts (
  id         uuid primary key,
  intake_id  uuid not null references legal_intakes(id),
  dad_id     uuid not null,
  version    int not null,
  body       text not null,
  created_at timestamptz not null default now(),
  sent_at    timestamptz check (sent_at is null),
  unique (intake_id, version)
)
