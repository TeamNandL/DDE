-- DDE vault — Dad export receipts + deletion ledger (Slice 21).
--
-- Both tables are OPERATOR metadata, not dad content: ids, timestamps, a
-- hash. They are owner-only (dde_app gets nothing) and are written through
-- the unscoped owner path, exactly like dde_provision_tokens.
--
--   dde_export_receipts — one row per successful export of a dad's data.
--     The server refuses to soft-delete or wipe a dad unless a FRESH receipt
--     exists (a rail, not a warning): nobody loses data they never got a
--     copy of.
--   dde_deletions — one row per dad ever scheduled for deletion.
--     requested_at → soft-deleted (tokens revoked, data intact, cancelable)
--     purge_at     → when the hard wipe becomes due (requested_at + 14 days)
--     cancelled_at → Nick cancelled inside the window; data untouched
--     purged_at    → hard wipe done. The row stays as a tombstone (dad_id +
--                    timestamps only) so the ledger can say it happened.
--
-- Idempotent. Apply after 015.

create table if not exists dde_export_receipts (
  id          uuid primary key,
  dad_id      uuid not null,
  created_at  timestamptz not null default now(),
  sha256      text not null,
  bytes       int not null,
  actor       text not null check (actor in ('dad', 'operator'))
);
create index if not exists dde_export_receipts_dad_idx
  on dde_export_receipts (dad_id, created_at desc);

create table if not exists dde_deletions (
  dad_id        uuid primary key,
  receipt_id    uuid not null references dde_export_receipts(id),
  requested_at  timestamptz not null default now(),
  purge_at      timestamptz not null,
  cancelled_at  timestamptz,
  purged_at     timestamptz,
  purged_counts jsonb
);

revoke all on dde_export_receipts from dde_app;
revoke all on dde_deletions from dde_app;
