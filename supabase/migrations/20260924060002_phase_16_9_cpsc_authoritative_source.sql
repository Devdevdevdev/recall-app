-- Prepared only. Do not apply in production during Phase 16.9.
-- This additive source layer is deliberately absent from all matcher/read-model SQL.
begin;

create table private.cpsc_source_identities (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.recall_sources(id) on delete restrict,
  official_recall_number text not null check (official_recall_number ~ '^[0-9]{5}$'),
  canonical_url text not null check (canonical_url ~ '^https://www\.cpsc\.gov/Recalls/'),
  canonical_notice_id uuid unique references public.recall_notices(id) on delete restrict,
  identity_status text not null default 'unresolved'
    check (identity_status in ('unresolved', 'reconciled')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (source_id, official_recall_number),
  unique (source_id, canonical_url),
  check (last_seen_at >= first_seen_at),
  check (identity_status <> 'reconciled' or canonical_notice_id is not null)
);

-- API numeric IDs are observations, not global keys: current IDs in the audit
-- collide with older IDs already stored for *different* official recalls.
create table private.cpsc_source_aliases (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references private.cpsc_source_identities(id) on delete restrict,
  notice_id uuid references public.recall_notices(id) on delete restrict,
  alias_kind text not null check (alias_kind in ('api_id', 'official_url')),
  alias_value text not null check (btrim(alias_value) <> ''),
  provenance text not null check (btrim(provenance) <> ''),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  unique (identity_id, alias_kind, alias_value, provenance),
  check (last_seen_at >= first_seen_at)
);
create index cpsc_source_alias_lookup_idx
  on private.cpsc_source_aliases(alias_kind, alias_value);

-- Keep API revisions distinct from official-page revisions. The full API JSON
-- already exists on historical recall_notices; this table stores lineage only.
create table private.cpsc_api_revisions (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references private.cpsc_source_identities(id) on delete restrict,
  upstream_api_id text not null check (btrim(upstream_api_id) <> ''),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  provenance text not null check (btrim(provenance) <> ''),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  unique (identity_id, upstream_api_id, payload_hash),
  check (last_seen_at >= first_seen_at)
);
create index cpsc_api_revisions_identity_time_idx
  on private.cpsc_api_revisions(identity_id, last_seen_at desc);

create table private.cpsc_page_revisions (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references private.cpsc_source_identities(id) on delete restrict,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  recall_number text not null check (recall_number ~ '^[0-9]{5}$'),
  canonical_url text not null check (canonical_url ~ '^https://www\.cpsc\.gov/Recalls/'),
  title text not null check (btrim(title) <> ''),
  section_hashes jsonb not null check (jsonb_typeof(section_hashes) = 'object'),
  normalized_evidence jsonb not null check (jsonb_typeof(normalized_evidence) = 'object'),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (identity_id, evidence_hash),
  check (last_seen_at >= first_seen_at)
);

-- Every HTTP observation can have a different byte hash while referring to the
-- same semantic revision. No arbitrary HTML or tracking markup is persisted.
create table private.cpsc_page_fetches (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references private.cpsc_source_identities(id) on delete restrict,
  revision_id uuid references private.cpsc_page_revisions(id) on delete restrict,
  fetched_at timestamptz not null,
  http_status integer not null check (http_status between 100 and 599),
  raw_page_hash text check (raw_page_hash ~ '^[0-9a-f]{64}$'),
  final_url text not null check (final_url ~ '^https://www\.cpsc\.gov/Recalls/'),
  fetch_error text,
  check ((http_status = 200 and revision_id is not null and raw_page_hash is not null)
    or http_status <> 200)
);
create index cpsc_page_fetches_identity_time_idx
  on private.cpsc_page_fetches(identity_id, fetched_at desc);

-- Parser output is unreviewed by construction; this table has no link to v2
-- reviewed bindings, evaluations, eligibility, alerts, or push writers.
create table private.cpsc_candidate_criteria (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references private.cpsc_page_revisions(id) on delete restrict,
  -- Scope IDs are historical evidence. Source refresh can replace scope rows;
  -- retaining the UUID here allows stale detection without blocking refresh.
  proposed_scope_id uuid,
  evidence_address jsonb not null check (jsonb_typeof(evidence_address) = 'object'),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  criterion_kind text not null check (criterion_kind in
    ('model_exact', 'model_set', 'date_code_exact', 'date_code_set', 'production_date_range')),
  criterion_value jsonb not null,
  proposed_operator text not null check (proposed_operator in ('exact', 'in', 'range')),
  interpretation text not null check (interpretation in
    ('mandatory_candidate', 'descriptive_candidate', 'ambiguous')),
  conjunction_key text,
  authoritative_excerpt text not null check (btrim(authoritative_excerpt) <> ''),
  status text not null default 'unreviewed' check (status = 'unreviewed'),
  created_at timestamptz not null default now(),
  unique (revision_id, evidence_fingerprint, criterion_kind, criterion_value, conjunction_key)
);

-- Future human-admin review records are append-only by contract. No worker or
-- consumer role receives mutation privileges on this table in this migration.
create table private.cpsc_candidate_review_ledger (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references private.cpsc_candidate_criteria(id) on delete restrict,
  decision text not null check (decision in ('reviewed', 'rejected', 'stale')),
  reviewer_user_id uuid references auth.users(id) on delete restrict,
  attested_scope_id uuid,
  source_revision_hash text not null check (source_revision_hash ~ '^[0-9a-f]{64}$'),
  evidence_address jsonb not null check (jsonb_typeof(evidence_address) = 'object'),
  attestation text not null check (btrim(attestation) <> ''),
  decided_at timestamptz not null default now(),
  check (decision = 'stale' or reviewer_user_id is not null),
  check (decision <> 'reviewed' or attested_scope_id is not null)
);
create index cpsc_candidate_review_ledger_latest_idx
  on private.cpsc_candidate_review_ledger(candidate_id, decided_at desc, id);

alter table private.cpsc_source_identities enable row level security;
alter table private.cpsc_source_aliases enable row level security;
alter table private.cpsc_api_revisions enable row level security;
alter table private.cpsc_page_revisions enable row level security;
alter table private.cpsc_page_fetches enable row level security;
alter table private.cpsc_candidate_criteria enable row level security;
alter table private.cpsc_candidate_review_ledger enable row level security;

revoke all on private.cpsc_source_identities, private.cpsc_source_aliases,
  private.cpsc_api_revisions, private.cpsc_page_revisions, private.cpsc_page_fetches,
  private.cpsc_candidate_criteria, private.cpsc_candidate_review_ledger
  from public, anon, authenticated, service_role;
grant select, insert, update on private.cpsc_source_identities,
  private.cpsc_source_aliases, private.cpsc_api_revisions,
  private.cpsc_page_revisions
  to service_role;
grant select, insert on private.cpsc_page_fetches,
  private.cpsc_candidate_criteria to service_role;

commit;
