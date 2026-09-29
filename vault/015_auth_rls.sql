-- DDE vault — Auth + RLS (Slice 18). Supersedes the 002 draft plan.
--
-- Stays on the existing Postgres + BFF Bearer path (no Supabase Auth, no
-- OAuth, no magic links). Shape:
--
--   * The BFF connects as the table OWNER (the "service role"). It is only
--     ever used for unscoped work: schema apply, provision (the mint path),
--     the token store (hash-only), and the pre-gate "does this dad exist"
--     check. It is never exposed to Chip — Chip only holds a bearer token.
--   * After the bearer gate passes for dad X, every SQL statement for that
--     request runs as the NON-owner role dde_app with dde.dad_id = X, set
--     transaction-locally (src/scope.js). RLS applies to dde_app, so even an
--     app bug that asks for dad Y's rows gets zero rows, and any INSERT or
--     UPDATE whose dad_id is not X is rejected by WITH CHECK.
--   * Every dad-scoped table: RLS enabled + one policy
--     `for all to dde_app using (dad_id = dde_current_dad())
--      with check (dad_id = dde_current_dad())`.
--   * Views run with security_invoker so they inherit the base-table policies.
--   * dde_app gets no access to dde_provision_tokens.
--
-- Applied as ONE script (not statement-split) because of the DO blocks.
-- Idempotent. Apply after 001..014.
--   psql "$DATABASE_URL" -f vault/015_auth_rls.sql

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'dde_app') then
    create role dde_app nologin;
  end if;
end
$$;

-- The owner must be able to SET ROLE dde_app (no-op for a superuser).
do $$
begin
  execute format('grant dde_app to %I', current_user);
exception when others then
  raise notice 'grant dde_app to %: %', current_user, sqlerrm;
end
$$;

create or replace function dde_current_dad() returns uuid
  language sql stable
  as $$ select nullif(current_setting('dde.dad_id', true), '')::uuid $$;

grant usage on schema public to dde_app;
grant execute on function dde_current_dad() to dde_app;

do $$
declare
  t text;
  dad_tables text[] := array[
    'events', 'communications', 'documents', 'state', 'month_summary',
    'candidate_facts', 'notifications',
    'plan_topics', 'plan_drafts',
    'translations', 'translator_calendar_candidates',
    'involvement_fields',
    'legal_intakes', 'legal_handoff_drafts'
  ];
begin
  foreach t in array dad_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('grant select, insert, update, delete on %I to dde_app', t);
    execute format('drop policy if exists dde_own_rows on %I', t);
    execute format(
      'create policy dde_own_rows on %I for all to dde_app
         using (dad_id = dde_current_dad())
         with check (dad_id = dde_current_dad())', t);
  end loop;
end
$$;

alter view verified_export set (security_invoker = true);
alter view affidavit_support set (security_invoker = true);
grant select on verified_export, affidavit_support to dde_app;

do $$
begin
  if to_regclass('public.dde_provision_tokens') is not null then
    revoke all on dde_provision_tokens from dde_app;
  end if;
end
$$;
