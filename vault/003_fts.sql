-- DDE vault FTS — tsvector + GIN on searchable fields (brief §1).
-- App still enforces dad_id on every search; RLS remains off (002 not applied).
-- Idempotent: safe to re-run via store factory / schema:apply.

-- events: notes + raw_quote
alter table events
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(notes, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(raw_quote, '')), 'B')
  ) stored;
create index if not exists events_search_tsv_idx on events using gin (search_tsv);

-- communications: body_cold (+ raw_quote when present)
alter table communications
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(body_cold, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(raw_quote, '')), 'B')
  ) stored;
create index if not exists communications_search_tsv_idx on communications using gin (search_tsv);

-- documents: extracted jsonb as text (+ raw_quote)
alter table documents
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(extracted::text, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(raw_quote, '')), 'B')
  ) stored;
create index if not exists documents_search_tsv_idx on documents using gin (search_tsv);

-- state: this_week / missing / next_action
alter table state
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(this_week, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(array_to_string(missing, ' '), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(next_action, '')), 'A')
  ) stored;
create index if not exists state_search_tsv_idx on state using gin (search_tsv);

-- month_summary: summary_text / highlights
alter table month_summary
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(summary_text, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(array_to_string(highlights, ' '), '')), 'B')
  ) stored;
create index if not exists month_summary_search_tsv_idx on month_summary using gin (search_tsv);
