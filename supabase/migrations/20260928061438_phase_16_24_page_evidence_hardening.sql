-- Additive hardening of the frozen Phase 16.23 page foundation. No scheduling.
begin;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'cpsc_page_worker') then
    create role cpsc_page_worker login noinherit password null;
  end if;
end $$;
grant cpsc_page_worker to postgres;
alter role cpsc_page_worker set statement_timeout = '4s';
alter role cpsc_page_worker set lock_timeout = '3s';
alter role cpsc_page_worker set idle_in_transaction_session_timeout = '5s';
grant usage on schema public to cpsc_page_worker;

-- The shared CPSC identity ingestion still uses service_role. Only this
-- predicate gains the dedicated direct-Postgres login; sensitive RPC grants
-- below remain separate.
create or replace function private.cpsc_is_worker()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(auth.role() = 'service_role', false)
    or coalesce(current_setting('role', true) = 'service_role', false)
    or session_user = 'cpsc_page_worker'
    or coalesce(current_setting('role', true) = 'cpsc_page_worker', false);
$$;

create table private.cpsc_page_raw_payloads (
  sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  raw_bytes bytea not null check (octet_length(raw_bytes) between 1 and 1000000),
  byte_length integer generated always as (octet_length(raw_bytes)) stored,
  first_retained_at timestamptz not null default now(),
  check (sha256 = encode(extensions.digest(raw_bytes, 'sha256'), 'hex'))
);
alter table private.cpsc_page_raw_payloads enable row level security;
revoke all on private.cpsc_page_raw_payloads
  from public, anon, authenticated, service_role, cpsc_page_worker;

alter table private.cpsc_page_attempts
  add column raw_payload_sha256 text
    references private.cpsc_page_raw_payloads(sha256) on delete restrict;
create index cpsc_page_attempts_raw_payload_idx
  on private.cpsc_page_attempts(raw_payload_sha256)
  where raw_payload_sha256 is not null;

create function private.cpsc_reject_raw_payload_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'CPSC raw page payload is immutable' using errcode = '42501';
end;
$$;
create trigger cpsc_raw_payload_no_update_delete
  before update or delete on private.cpsc_page_raw_payloads
  for each row execute function private.cpsc_reject_raw_payload_change();
create trigger cpsc_raw_payload_no_truncate
  before truncate on private.cpsc_page_raw_payloads
  for each statement execute function private.cpsc_reject_raw_payload_change();
revoke all on function private.cpsc_reject_raw_payload_change()
  from public, anon, authenticated, service_role, cpsc_page_worker;

-- The only page-worker evidence write entrypoint verifies exact bytes first.
-- The frozen Phase 16.23 commit and this insert execute in one transaction.
create function public.commit_cpsc_page_evidence_verified(
  p_claim_id uuid, p_snapshot jsonb, p_revision jsonb,
  p_candidates jsonb, p_ledger jsonb, p_raw_bytes bytea)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text;
  v_result jsonb;
begin
  if session_user <> 'cpsc_page_worker'
    and current_setting('role', true) <> 'cpsc_page_worker' then
    raise exception 'Dedicated page worker authorization required' using errcode = '42501';
  end if;
  if p_raw_bytes is null or octet_length(p_raw_bytes) not between 1 and 1000000
    or convert_from(p_raw_bytes, 'UTF8') is null then
    raise exception 'Invalid CPSC raw page bytes';
  end if;
  v_hash := encode(extensions.digest(p_raw_bytes, 'sha256'), 'hex');
  if p_snapshot->>'rawPageHash' is distinct from v_hash then
    raise exception 'CPSC raw page hash mismatch';
  end if;
  v_result := public.commit_cpsc_page_evidence(
    p_claim_id, p_snapshot, p_revision, p_candidates, p_ledger);
  insert into private.cpsc_page_raw_payloads(sha256, raw_bytes)
    values (v_hash, p_raw_bytes) on conflict (sha256) do nothing;
  update private.cpsc_page_attempts
    set raw_payload_sha256 = v_hash
    where id = p_claim_id and raw_page_hash = v_hash
      and revision_id = (v_result->'revision'->>'revisionId')::uuid;
  if not found then
    raise exception 'CPSC payload could not be bound to committed evidence';
  end if;
  return v_result;
end;
$$;

-- Old independent page writes must remain owner-only for historical replay.
revoke execute on function
  public.record_cpsc_page_revision(uuid, text, jsonb, jsonb, jsonb, text),
  public.record_cpsc_page_fetch(uuid, uuid, timestamptz, integer, text, text,
    text, text, text, jsonb, text),
  public.propose_cpsc_candidate_criterion(uuid, uuid, jsonb, text, text,
    jsonb, text, text, text),
  public.record_cpsc_page_coverage(uuid, jsonb),
  public.get_cpsc_page_fetch_targets(integer),
  public.commit_cpsc_page_evidence(uuid, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, cpsc_page_worker;
revoke execute on function
  public.claim_cpsc_page_evidence(integer),
  public.finish_cpsc_page_attempt(uuid, text, integer, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function
  public.claim_cpsc_page_evidence(integer),
  public.finish_cpsc_page_attempt(uuid, text, integer, text, text, text),
  public.commit_cpsc_page_evidence_verified(uuid, jsonb, jsonb, jsonb, jsonb, bytea)
  to cpsc_page_worker;
revoke execute on function
  public.commit_cpsc_page_evidence_verified(uuid, jsonb, jsonb, jsonb, jsonb, bytea)
  from public, anon, authenticated, service_role;

commit;
