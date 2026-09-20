-- DDE vault — full-text search + filter API with hard dad_id tenancy.
--
-- Rails:
--   * EVERY query goes through vault_search(p_dad_id, ...) — dad_id is a
--     required argument and every branch filters on it. A null dad_id
--     matches nothing. App-enforced tenancy (RLS still off per the Phase 1
--     auth-gate decision; when RLS lands these queries keep working).
--   * Two-pipe intact: search may return claim AND verified rows, each
--     labeled with its pipe; the pipe filter narrows to one. Reporting /
--     exhibit paths still read verified_export ONLY — search is a seat
--     surface (Intake / Edge / Front Door), never a Reporting input.
--   * Search reads only what the vault stores. Harm-discarded and
--     venom-stripped text was never written, so it cannot be found.
--   * Results carry ids, type, pipe, snippet, timestamps. Full raw_quote
--     never goes to logs (app rule; nothing here logs).
--
-- Idempotent: safe to re-apply.

-- array_to_string is only STABLE, so generated columns need an IMMUTABLE
-- wrapper. Safe for text[]: output depends only on the input array.
create or replace function dde_join_text(parts text[])
returns text
language sql
immutable
as $$ select coalesce(array_to_string(parts, ' '), '') $$;

-- Generated tsvector per searchable table -----------------------------------

alter table events add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector('english',
      coalesce(raw_quote, '') || ' ' ||
      coalesce(notes, '') || ' ' ||
      coalesce(location, '') || ' ' ||
      coalesce(event_type, '') || ' ' ||
      dde_join_text(kids))
  ) stored;

alter table communications add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector('english',
      coalesce(body_cold, '') || ' ' ||
      coalesce(raw_quote, '') || ' ' ||
      coalesce(channel, '') || ' ' ||
      coalesce(direction, ''))
  ) stored;

alter table documents add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector('english',
      coalesce(doc_type, '') || ' ' ||
      coalesce(extracted::text, ''))
  ) stored;

alter table state add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector('english',
      coalesce(this_week, '') || ' ' ||
      coalesce(next_action, '') || ' ' ||
      coalesce(phase, '') || ' ' ||
      dde_join_text(missing))
  ) stored;

alter table month_summary add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector('english',
      coalesce(summary_text, '') || ' ' ||
      dde_join_text(highlights) || ' ' ||
      dde_join_text(pattern_tags))
  ) stored;

-- GIN indexes (dad_id stays on its existing btree indexes; the planner
-- combines them) --------------------------------------------------------------

create index if not exists events_search_tsv_idx on events using gin (search_tsv);
create index if not exists communications_search_tsv_idx on communications using gin (search_tsv);
create index if not exists documents_search_tsv_idx on documents using gin (search_tsv);
create index if not exists state_search_tsv_idx on state using gin (search_tsv);
create index if not exists month_summary_search_tsv_idx on month_summary using gin (search_tsv);

-- The one search entry point -------------------------------------------------
--
--   p_dad_id  REQUIRED — filters every branch; null matches nothing
--   p_query   optional — empty/null means "filtered list only" (rank 0)
--   p_pipe    optional — 'claim' | 'verified' | null (both)
--   p_type    optional — 'events'|'communications'|'documents'|'state'
--                        |'month_summary'|'all'|null (all)
--   p_from/p_to optional — range on the per-table timestamp:
--       events.occurred_at · communications.sent_at (fallback created_at)
--       documents.created_at · state.updated_at · month_summary.month
--   p_limit   1..50 (default 20)
--
-- Rank: ts_rank when a query is present, recency tiebreak always.
-- There is NO variant of this function without p_dad_id.

create or replace function vault_search(
  p_dad_id uuid,
  p_query text default null,
  p_pipe text default null,
  p_type text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit int default 20
)
returns table (
  source_table text,
  id uuid,
  dad_id uuid,
  pipe text,
  rank real,
  snippet text,
  ts timestamptz,
  created_at timestamptz
)
language sql
stable
as $$
  with q as (
    select websearch_to_tsquery('english', coalesce(p_query, '')) as tsq,
           length(trim(coalesce(p_query, ''))) > 0 as has_q,
           coalesce(nullif(trim(coalesce(p_type, '')), ''), 'all') as want
  )
  select * from (
    select 'events'::text as source_table, e.id, e.dad_id, e.pipe,
           case when q.has_q then ts_rank(e.search_tsv, q.tsq)::real else 0::real end as rank,
           case when q.has_q
                then ts_headline('english', coalesce(e.raw_quote, e.notes, ''), q.tsq,
                                 'MaxWords=18, MinWords=6, MaxFragments=1')
                else left(coalesce(e.notes, e.raw_quote, ''), 160) end as snippet,
           e.occurred_at as ts, e.created_at
      from events e, q
     where e.dad_id = p_dad_id
       and q.want in ('all', 'events')
       and (p_pipe is null or e.pipe = p_pipe)
       and (p_from is null or e.occurred_at >= p_from)
       and (p_to is null or e.occurred_at <= p_to)
       and (not q.has_q or e.search_tsv @@ q.tsq)
    union all
    select 'communications', c.id, c.dad_id, c.pipe,
           case when q.has_q then ts_rank(c.search_tsv, q.tsq)::real else 0::real end,
           case when q.has_q
                then ts_headline('english', coalesce(c.body_cold, c.raw_quote, ''), q.tsq,
                                 'MaxWords=18, MinWords=6, MaxFragments=1')
                else left(coalesce(c.body_cold, c.raw_quote, ''), 160) end,
           coalesce(c.sent_at, c.created_at), c.created_at
      from communications c, q
     where c.dad_id = p_dad_id
       and q.want in ('all', 'communications')
       and (p_pipe is null or c.pipe = p_pipe)
       and (p_from is null or coalesce(c.sent_at, c.created_at) >= p_from)
       and (p_to is null or coalesce(c.sent_at, c.created_at) <= p_to)
       and (not q.has_q or c.search_tsv @@ q.tsq)
    union all
    select 'documents', d.id, d.dad_id, d.pipe,
           case when q.has_q then ts_rank(d.search_tsv, q.tsq)::real else 0::real end,
           case when q.has_q
                then ts_headline('english', coalesce(d.extracted::text, d.doc_type, ''), q.tsq,
                                 'MaxWords=18, MinWords=6, MaxFragments=1')
                else left(coalesce(d.extracted::text, d.doc_type, ''), 160) end,
           d.created_at, d.created_at
      from documents d, q
     where d.dad_id = p_dad_id
       and q.want in ('all', 'documents')
       and (p_pipe is null or d.pipe = p_pipe)
       and (p_from is null or d.created_at >= p_from)
       and (p_to is null or d.created_at <= p_to)
       and (not q.has_q or d.search_tsv @@ q.tsq)
    union all
    select 'state', s.id, s.dad_id, s.pipe,
           case when q.has_q then ts_rank(s.search_tsv, q.tsq)::real else 0::real end,
           case when q.has_q
                then ts_headline('english',
                                 coalesce(s.next_action, '') || ' ' || dde_join_text(s.missing),
                                 q.tsq, 'MaxWords=18, MinWords=6, MaxFragments=1')
                else left(coalesce(s.next_action, '') || ' ' || dde_join_text(s.missing), 160) end,
           s.updated_at, s.created_at
      from state s, q
     where s.dad_id = p_dad_id
       and q.want in ('all', 'state')
       and (p_pipe is null or s.pipe = p_pipe)
       and (p_from is null or s.updated_at >= p_from)
       and (p_to is null or s.updated_at <= p_to)
       and (not q.has_q or s.search_tsv @@ q.tsq)
    union all
    select 'month_summary', m.id, m.dad_id, m.pipe,
           case when q.has_q then ts_rank(m.search_tsv, q.tsq)::real else 0::real end,
           case when q.has_q
                then ts_headline('english', coalesce(m.summary_text, ''), q.tsq,
                                 'MaxWords=18, MinWords=6, MaxFragments=1')
                else left(coalesce(m.summary_text, ''), 160) end,
           m.month::timestamptz, m.created_at
      from month_summary m, q
     where m.dad_id = p_dad_id
       and q.want in ('all', 'month_summary')
       and (p_pipe is null or m.pipe = p_pipe)
       and (p_from is null or m.month::timestamptz >= p_from)
       and (p_to is null or m.month::timestamptz <= p_to)
       and (not q.has_q or m.search_tsv @@ q.tsq)
  ) hits
  where p_dad_id is not null
  order by rank desc, ts desc nulls last
  limit greatest(1, least(coalesce(p_limit, 20), 50))
$$;
