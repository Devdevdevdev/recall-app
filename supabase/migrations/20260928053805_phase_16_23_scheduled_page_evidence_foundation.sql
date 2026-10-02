-- Phase 16.23 local foundation only. No schedule, cron, or matcher integration.
begin;

create table private.cpsc_page_work_state (
  identity_id uuid primary key references private.cpsc_source_identities(id) on delete restrict,
  claim_id uuid,
  claim_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_outcome text,
  check ((claim_id is null) = (claim_expires_at is null))
);
create index cpsc_page_work_due_idx
  on private.cpsc_page_work_state(next_attempt_at, last_success_at, last_attempt_at);
alter table private.cpsc_page_work_state enable row level security;

create table private.cpsc_page_attempts (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references private.cpsc_source_identities(id) on delete restrict,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  outcome text not null check (outcome in ('claimed', 'fetched_unchanged',
    'fetched_changed', 'unresolved_structure', 'identity_redirect',
    'temporary_failure', 'permanent_unsupported', 'budget_deferred')),
  http_status integer check (http_status between 100 and 599),
  final_url text,
  raw_page_hash text check (raw_page_hash ~ '^[0-9a-f]{64}$'),
  error_code text check (length(error_code) <= 80),
  revision_id uuid references private.cpsc_page_revisions(id) on delete restrict,
  fetch_id uuid references private.cpsc_page_fetches(id) on delete restrict,
  check ((outcome = 'claimed') = (completed_at is null)),
  check (revision_id is null or outcome in ('fetched_unchanged', 'fetched_changed'))
);
create index cpsc_page_attempts_identity_time_idx
  on private.cpsc_page_attempts(identity_id, claimed_at desc);
create unique index cpsc_page_attempts_one_claim_idx
  on private.cpsc_page_attempts(identity_id) where outcome = 'claimed';
alter table private.cpsc_page_attempts enable row level security;

-- Identity row locks serialize first claims even when no work-state row exists.
create function public.claim_cpsc_page_evidence(p_limit integer default 1)
returns table (claim_id uuid, identity_id uuid, official_recall_number text,
  canonical_url text, sole_scope_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_identity record;
  v_claim uuid;
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 10 then
    raise exception 'Invalid page claim limit';
  end if;
  for v_identity in
    select i.id, i.official_recall_number, i.canonical_url,
      (select case when count(*) = 1 then (array_agg(s.id))[1] end
       from public.recall_scopes s where s.recall_notice_id = i.canonical_notice_id)
        as sole_scope_id
    from private.cpsc_source_identities i
    left join private.cpsc_page_work_state w on w.identity_id = i.id
    where i.identity_status = 'reconciled'
      and private.cpsc_canonical_url(i.canonical_url) = i.canonical_url
      and coalesce(w.next_attempt_at, '-infinity'::timestamptz) <= now()
      and (w.claim_id is null or w.claim_expires_at <= now())
    order by coalesce(w.next_attempt_at, '-infinity'::timestamptz),
      coalesce(w.last_success_at, w.last_attempt_at, i.first_seen_at),
      i.official_recall_number
    limit p_limit for update of i skip locked
  loop
    -- A lease is recoverable; the old attempt is durably closed first.
    update private.cpsc_page_attempts a
      set outcome = 'temporary_failure', completed_at = now(), error_code = 'claim_expired'
      where a.id = (select w.claim_id from private.cpsc_page_work_state w
                    where w.identity_id = v_identity.id)
        and a.outcome = 'claimed';
    v_claim := gen_random_uuid();
    insert into private.cpsc_page_work_state
      (identity_id, claim_id, claim_expires_at, next_attempt_at, attempt_count, last_attempt_at)
      values (v_identity.id, v_claim, now() + interval '30 seconds',
        now(), 1, now())
      on conflict on constraint cpsc_page_work_state_pkey do update set
        claim_id = excluded.claim_id,
        claim_expires_at = excluded.claim_expires_at,
        attempt_count = cpsc_page_work_state.attempt_count + 1,
        last_attempt_at = excluded.last_attempt_at;
    insert into private.cpsc_page_attempts(id, identity_id, outcome)
      values (v_claim, v_identity.id, 'claimed');
    claim_id := v_claim;
    identity_id := v_identity.id;
    official_recall_number := v_identity.official_recall_number;
    canonical_url := v_identity.canonical_url;
    sole_scope_id := v_identity.sole_scope_id;
    return next;
  end loop;
end;
$$;

create function public.finish_cpsc_page_attempt(
  p_claim_id uuid, p_outcome text, p_http_status integer default null,
  p_final_url text default null, p_raw_page_hash text default null,
  p_error_code text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state private.cpsc_page_work_state%rowtype;
  v_failures integer;
  v_next timestamptz;
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  if p_outcome not in ('unresolved_structure', 'identity_redirect',
      'temporary_failure', 'permanent_unsupported', 'budget_deferred')
    or length(coalesce(p_error_code, '')) > 80
    or (p_http_status is not null and p_http_status not between 100 and 599)
    or (p_raw_page_hash is not null and p_raw_page_hash !~ '^[0-9a-f]{64}$')
    or (p_final_url is not null and (length(p_final_url) > 2048
      or private.cpsc_canonical_url(p_final_url) is distinct from p_final_url)) then
    raise exception 'Invalid page attempt outcome';
  end if;
  select w.* into v_state from private.cpsc_page_work_state w
    where w.claim_id = p_claim_id for update;
  if v_state.identity_id is null or v_state.claim_expires_at <= now() then
    raise exception 'Page claim is missing or expired' using errcode = '42501';
  end if;
  v_failures := v_state.consecutive_failures +
    case when p_outcome = 'budget_deferred' then 0 else 1 end;
  v_next := case p_outcome
    when 'budget_deferred' then now() + interval '1 minute'
    when 'temporary_failure' then now() +
      (least(86400, 300 * power(2::numeric, least(v_failures - 1, 8)))) * interval '1 second'
    when 'unresolved_structure' then now() + interval '7 days'
    else now() + interval '30 days' end;
  update private.cpsc_page_attempts set outcome = p_outcome, completed_at = now(),
    http_status = p_http_status, final_url = p_final_url,
    raw_page_hash = p_raw_page_hash, error_code = p_error_code
    where id = p_claim_id and outcome = 'claimed';
  if not found then raise exception 'Page attempt is not claimed'; end if;
  update private.cpsc_page_work_state set claim_id = null, claim_expires_at = null,
    next_attempt_at = v_next, consecutive_failures = v_failures,
    last_outcome = p_outcome where identity_id = v_state.identity_id;
  return jsonb_build_object('outcome', p_outcome, 'nextAttemptAt', v_next);
end;
$$;

-- Every evidence writer below runs in one Postgres transaction. A rejected
-- fetch, proposal, or ledger rolls back the semantic revision and staleness.
create function public.commit_cpsc_page_evidence(
  p_claim_id uuid, p_snapshot jsonb, p_revision jsonb,
  p_candidates jsonb, p_ledger jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state private.cpsc_page_work_state%rowtype;
  v_identity private.cpsc_source_identities%rowtype;
  v_revision jsonb;
  v_fetch_id uuid;
  v_coverage jsonb;
  v_candidate jsonb;
  v_proposal jsonb;
  v_created integer := 0;
  v_unchanged integer := 0;
  v_outcome text;
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  select w.* into v_state from private.cpsc_page_work_state w
    where w.claim_id = p_claim_id for update;
  if v_state.identity_id is null or v_state.claim_expires_at <= now() then
    raise exception 'Page claim is missing or expired' using errcode = '42501';
  end if;
  select * into v_identity from private.cpsc_source_identities
    where id = v_state.identity_id for update;
  if v_identity.id is null or v_identity.identity_status <> 'reconciled'
    or p_snapshot->>'canonicalUrl' is distinct from v_identity.canonical_url
    or p_snapshot->>'finalUrl' is distinct from v_identity.canonical_url
    or p_snapshot->>'httpStatus' is distinct from '200'
    or coalesce(p_snapshot->>'contentType', '') !~* '^text/html([[:space:]]*;|$)'
    or p_revision->'normalized'->>'recallNumber'
      is distinct from v_identity.official_recall_number
    or p_revision->'normalized'->>'canonicalUrl'
      is distinct from v_identity.canonical_url
    or jsonb_typeof(p_candidates) is distinct from 'array'
    or jsonb_array_length(p_candidates) > 1000
    or octet_length(p_candidates::text) > 1048576
    or octet_length(p_snapshot::text) > 16384
    or octet_length(p_revision::text) > 1048576 then
    raise exception 'CPSC page evidence contradicts its claimed identity';
  end if;
  -- Existing validated RPCs are reused, including their append-only and
  -- coverage-binding triggers. Their writes are atomic inside this invocation.
  v_revision := public.record_cpsc_page_revision(v_identity.id,
    p_revision->>'semanticHash', p_revision->'normalized',
    p_revision->'sections', p_revision->'tableIdentities',
    p_revision->>'parserVersion');
  v_fetch_id := public.record_cpsc_page_fetch(v_identity.id,
    (v_revision->>'revisionId')::uuid,
    (p_snapshot->>'fetchedAt')::timestamptz, 200,
    p_snapshot->>'rawPageHash', p_snapshot->>'finalUrl',
    p_snapshot->>'contentType', p_snapshot->>'etag',
    p_snapshot->>'lastModified', p_snapshot->'redirectChain', null);
  for v_candidate in select value from jsonb_array_elements(p_candidates)
  loop
    v_proposal := public.propose_cpsc_candidate_criterion(
      (v_revision->>'revisionId')::uuid,
      nullif(v_candidate->>'proposedScopeId', '')::uuid,
      v_candidate->'evidenceAddress', v_candidate->>'evidenceFingerprint',
      v_candidate->>'kind', v_candidate->'value',
      v_candidate->>'conjunctionKey', v_candidate->>'authoritativeExcerpt',
      p_revision->>'parserVersion');
    if v_proposal->>'status' = 'created' then v_created := v_created + 1;
    elsif v_proposal->>'status' = 'unchanged' then v_unchanged := v_unchanged + 1;
    else raise exception 'Invalid candidate result'; end if;
  end loop;
  v_coverage := public.record_cpsc_page_coverage(
    (v_revision->>'revisionId')::uuid, p_ledger);
  v_outcome := case when v_revision->>'status' = 'unchanged'
    then 'fetched_unchanged' else 'fetched_changed' end;
  update private.cpsc_page_attempts set outcome = v_outcome, completed_at = now(),
    http_status = 200, final_url = p_snapshot->>'finalUrl',
    raw_page_hash = p_snapshot->>'rawPageHash',
    revision_id = (v_revision->>'revisionId')::uuid, fetch_id = v_fetch_id
    where id = p_claim_id and outcome = 'claimed';
  if not found then raise exception 'Page attempt is not claimed'; end if;
  update private.cpsc_page_work_state set claim_id = null, claim_expires_at = null,
    next_attempt_at = now() + interval '1 day', consecutive_failures = 0,
    last_success_at = now(), last_outcome = v_outcome
    where identity_id = v_identity.id;
  return jsonb_build_object('outcome', v_outcome, 'revision', v_revision,
    'fetchId', v_fetch_id, 'coverage', v_coverage,
    'proposalsCreated', v_created, 'proposalsUnchanged', v_unchanged);
end;
$$;

revoke all on private.cpsc_page_work_state, private.cpsc_page_attempts
  from public, anon, authenticated, service_role;
revoke all on function public.claim_cpsc_page_evidence(integer),
  public.finish_cpsc_page_attempt(uuid, text, integer, text, text, text),
  public.commit_cpsc_page_evidence(uuid, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_cpsc_page_evidence(integer),
  public.finish_cpsc_page_attempt(uuid, text, integer, text, text, text),
  public.commit_cpsc_page_evidence(uuid, jsonb, jsonb, jsonb, jsonb)
  to service_role;

commit;
