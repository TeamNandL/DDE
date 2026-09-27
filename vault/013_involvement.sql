-- DDE vault — Involvement Cheat Sheet (Slice 16). Living one-pager per kid.
--
-- involvement_fields: one row per (dad, kid, field). Finite field keys only.
--   value is DAD-ENTERED and PII-stripped (<= 200 chars): a claim, never
--   verified — source and claim_status are locked by CHECK. No SSNs, no
--   money amounts, no contact numbers (emergency_contact_known is yes|no).
--   A blank that was asked for keeps the ask (asked_on, asked_via, outcome)
--   so the export can state the pattern as behavior — never why.
--
-- kid_key is a short dad-chosen label (lowercase slug), never a full name.
-- Not evidence: never feeds verified_export, never an intake event, never
-- an OFW row. Idempotent. Apply after 001..012. RLS (002) documented-only.
--   psql "$DATABASE_URL" -f vault/013_involvement.sql

create table if not exists involvement_fields (
  dad_id       uuid not null,
  kid_key      text not null check (kid_key ~ '^[a-z0-9_-]{1,24}$'),
  field_key    text not null
               check (field_key in ('teacher','grade','doctor','dentist','therapist','meds',
                                    'allergies','friends','activities','emergency_contact_known')),
  position     int not null,
  value        text check (value is null or length(value) <= 200),
  asked_on     date,
  asked_via    text check (asked_via in ('co_parent','school','provider','in_person','other')),
  outcome      text check (outcome in ('no_answer','declined')),
  source       text not null default 'dad_entered' check (source = 'dad_entered'),
  claim_status text not null default 'claim' check (claim_status = 'claim'),
  updated_at   timestamptz not null default now(),
  primary key (dad_id, kid_key, field_key)
)
