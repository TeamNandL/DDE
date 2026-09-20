-- DDE vault — RLS PLAN (kickoff §3). DRAFT ONLY — DO NOT RUN IN PHASE 1.
-- vault-app never applies this file (schema:apply and test 9 use 001 only).
--
-- RLS is documented now and enforced when the auth gate lands (Supabase
-- Auth). Until then the vault is reached only through the thin BFF; no
-- public client exists. Every policy below is the same shape:
-- dad_id = auth.uid() on every table — one dad sees exactly his record.
--
-- When auth lands, run the statements below (uncommented) as a migration,
-- then verify with the §6 tests that claim/verified behavior is unchanged.

-- alter table events         enable row level security;
-- alter table communications enable row level security;
-- alter table documents      enable row level security;
-- alter table state          enable row level security;
-- alter table month_summary  enable row level security;

-- create policy events_own_rows on events
--   for all using (dad_id = auth.uid()) with check (dad_id = auth.uid());

-- create policy communications_own_rows on communications
--   for all using (dad_id = auth.uid()) with check (dad_id = auth.uid());

-- create policy documents_own_rows on documents
--   for all using (dad_id = auth.uid()) with check (dad_id = auth.uid());

-- create policy state_own_rows on state
--   for all using (dad_id = auth.uid()) with check (dad_id = auth.uid());

-- create policy month_summary_own_rows on month_summary
--   for all using (dad_id = auth.uid()) with check (dad_id = auth.uid());

-- Views: verified_export and affidavit_support inherit the base tables'
-- policies once security_invoker is set — do that in the same migration:
-- alter view verified_export  set (security_invoker = true);
-- alter view affidavit_support set (security_invoker = true);

-- Note for the auth-gate migration: also revoke default table privileges
-- from anon/authenticated where the BFF's service role should be the only
-- writer, and re-grant read on verified_export to the Reporting role only.
