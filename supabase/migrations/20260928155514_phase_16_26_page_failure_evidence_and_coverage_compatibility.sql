-- Phase 16.26 is a local candidate. Do not schedule or deploy page evidence.
begin;

alter table private.cpsc_page_attempts
  drop constraint cpsc_page_attempts_outcome_check;
alter table private.cpsc_page_attempts
  add constraint cpsc_page_attempts_outcome_check check (outcome in
    ('claimed', 'fetched_unchanged', 'fetched_changed', 'unresolved_structure',
     'identity_redirect', 'temporary_failure', 'permanent_unsupported',
     'budget_deferred', 'evidence_rejected', 'database_timeout', 'internal_failure'));
alter table private.cpsc_page_attempts
  add column transport_content_type text,
  add column transport_redirect_chain jsonb,
  add column transport_fetched_at timestamptz,
  add constraint cpsc_page_transport_content_type_check check
    (transport_content_type is null or
      (length(transport_content_type) <= 128 and transport_content_type ~* '^text/html([[:space:]]*;|$)')),
  add constraint cpsc_page_transport_redirect_chain_check check
    (transport_redirect_chain is null or
      (jsonb_typeof(transport_redirect_chain) = 'array' and
       jsonb_array_length(transport_redirect_chain) <= 3));
alter table private.cpsc_page_work_state
  add column manual_review_required boolean not null default false;
-- The work-state row and identity lock define the sole active claim. Expired
-- attempts stay untouched as audit history when a new claim takes the lease.
drop index private.cpsc_page_attempts_one_claim_idx;
create unique index cpsc_page_work_current_claim_idx
  on private.cpsc_page_work_state(claim_id) where claim_id is not null;

-- This record adds a parser/census-specific structural view of a frozen
-- semantic revision. No historical revision column is rewritten.
create table private.cpsc_page_structural_snapshots (
  revision_id uuid not null references private.cpsc_page_revisions(id) on delete restrict,
  parser_version text not null,
  extractor_version text not null,
  census_version text not null,
  semantic_hash text not null check (semantic_hash ~ '^[0-9a-f]{64}$'),
  table_identities jsonb not null check (jsonb_typeof(table_identities) = 'array'),
  recorded_at timestamptz not null default now(),
  primary key (revision_id, parser_version, extractor_version, census_version)
);
alter table private.cpsc_page_structural_snapshots enable row level security;
revoke all on private.cpsc_page_structural_snapshots
  from public, anon, authenticated, service_role, cpsc_page_worker;

create function private.cpsc_reject_structural_snapshot_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'CPSC structural snapshot is immutable' using errcode = '42501';
end;
$$;

-- A validated transport is durable before parsing or semantic acceptance.
-- This is a separate bounded statement and never creates a semantic fetch.
create function public.retain_cpsc_page_transport(
  p_claim_id uuid, p_snapshot jsonb, p_raw_bytes bytea)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state private.cpsc_page_work_state%rowtype;
  v_identity private.cpsc_source_identities%rowtype;
  v_hash text;
  v_redirect jsonb;
begin
  if session_user <> 'cpsc_page_worker'
    and current_setting('role', true) <> 'cpsc_page_worker' then
    raise exception 'Dedicated page worker authorization required' using errcode = '42501';
  end if;
  select * into v_state from private.cpsc_page_work_state
    where claim_id = p_claim_id for update;
  if v_state.identity_id is null or v_state.claim_expires_at <= now() then
    raise exception 'Page claim is missing or expired' using errcode = '42501';
  end if;
  select * into v_identity from private.cpsc_source_identities
    where id = v_state.identity_id;
  if v_identity.id is null or v_identity.identity_status <> 'reconciled'
    or jsonb_typeof(p_snapshot) is distinct from 'object'
    or octet_length(p_snapshot::text) > 16384
    or p_snapshot->>'canonicalUrl' is distinct from v_identity.canonical_url
    or p_snapshot->>'finalUrl' is distinct from v_identity.canonical_url
    or p_snapshot->>'httpStatus' is distinct from '200'
    or coalesce(p_snapshot->>'contentType', '') !~* '^text/html([[:space:]]*;|$)'
    or length(p_snapshot->>'contentType') > 128
    or jsonb_typeof(p_snapshot->'redirectChain') is distinct from 'array'
    or jsonb_array_length(p_snapshot->'redirectChain') > 3
    or (p_snapshot->>'fetchedAt')::timestamptz is null
    or p_raw_bytes is null or octet_length(p_raw_bytes) not between 1 and 1000000
    or convert_from(p_raw_bytes, 'UTF8') is null then
    raise exception 'Invalid CPSC page transport';
  end if;
  for v_redirect in select value from jsonb_array_elements(p_snapshot->'redirectChain')
  loop
    if jsonb_typeof(v_redirect) is distinct from 'string'
      or private.cpsc_canonical_url(v_redirect #>> '{}') is distinct from (v_redirect #>> '{}') then
      raise exception 'Invalid CPSC redirect transport';
    end if;
  end loop;
  v_hash := encode(extensions.digest(p_raw_bytes, 'sha256'), 'hex');
  if p_snapshot->>'rawPageHash' is distinct from v_hash then
    raise exception 'CPSC raw page hash mismatch';
  end if;
  insert into private.cpsc_page_raw_payloads(sha256, raw_bytes)
    values (v_hash, p_raw_bytes) on conflict (sha256) do nothing;
  update private.cpsc_page_attempts
    set http_status = 200, final_url = p_snapshot->>'finalUrl',
      raw_page_hash = v_hash, raw_payload_sha256 = v_hash,
      transport_content_type = p_snapshot->>'contentType',
      transport_redirect_chain = p_snapshot->'redirectChain',
      transport_fetched_at = (p_snapshot->>'fetchedAt')::timestamptz
    where id = p_claim_id and identity_id = v_identity.id and outcome = 'claimed'
      and (raw_payload_sha256 is null or raw_payload_sha256 = v_hash);
  if not found then raise exception 'Page transport cannot bind to claim'; end if;
  return jsonb_build_object('rawPageHash', v_hash, 'byteLength', octet_length(p_raw_bytes));
end;
$$;

-- This separate transaction runs after any failed semantic statement rolls back.
-- A lease that expired during processing may still finish if no newer claim
-- replaced it; a replaced claim is protected by the claim_id predicate.
create or replace function public.finish_cpsc_page_attempt(
  p_claim_id uuid, p_outcome text, p_http_status integer default null,
  p_final_url text default null, p_raw_page_hash text default null,
  p_error_code text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state private.cpsc_page_work_state%rowtype;
  v_attempt private.cpsc_page_attempts%rowtype;
  v_failures integer;
  v_next timestamptz;
  v_review boolean;
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  if p_outcome not in ('unresolved_structure', 'identity_redirect',
      'temporary_failure', 'permanent_unsupported', 'budget_deferred',
      'evidence_rejected', 'database_timeout', 'internal_failure')
    or p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,79}$'
    or (p_http_status is not null and p_http_status not between 100 and 599)
    or (p_raw_page_hash is not null and p_raw_page_hash !~ '^[0-9a-f]{64}$')
    or (p_final_url is not null and (length(p_final_url) > 2048
      or private.cpsc_canonical_url(p_final_url) is distinct from p_final_url)) then
    raise exception 'Invalid page attempt outcome';
  end if;
  select * into v_attempt from private.cpsc_page_attempts
    where id = p_claim_id and outcome = 'claimed' for update;
  select * into v_state from private.cpsc_page_work_state
    where identity_id = v_attempt.identity_id for update;
  if v_state.identity_id is null or v_attempt.id is null
    or v_attempt.identity_id <> v_state.identity_id
    or (v_attempt.raw_payload_sha256 is not null and
      (p_raw_page_hash is not null and p_raw_page_hash <> v_attempt.raw_payload_sha256
       or p_final_url is not null and p_final_url <> v_attempt.final_url
       or p_http_status is not null and p_http_status <> v_attempt.http_status)) then
    raise exception 'Page claim is missing or superseded' using errcode = '42501';
  end if;
  if v_state.claim_id is distinct from p_claim_id then
    update private.cpsc_page_attempts
      set outcome = p_outcome, completed_at = now(),
        http_status = coalesce(v_attempt.http_status, p_http_status),
        final_url = coalesce(v_attempt.final_url, p_final_url),
        raw_page_hash = coalesce(v_attempt.raw_page_hash, p_raw_page_hash),
        error_code = p_error_code
      where id = p_claim_id and outcome = 'claimed';
    return jsonb_build_object('outcome', p_outcome, 'superseded', true);
  end if;
  v_failures := v_state.consecutive_failures +
    case when p_outcome = 'budget_deferred' then 0 else 1 end;
  v_review := p_outcome = 'evidence_rejected';
  v_next := case p_outcome
    when 'budget_deferred' then now() + interval '1 minute'
    when 'temporary_failure' then now() +
      (least(86400, 300 * power(2::numeric, least(v_failures - 1, 8)))) * interval '1 second'
    when 'database_timeout' then now() + interval '1 hour'
    when 'internal_failure' then now() + interval '1 day'
    when 'unresolved_structure' then now() + interval '7 days'
    when 'evidence_rejected' then now() + interval '100 years'
    else now() + interval '30 days' end;
  update private.cpsc_page_attempts
    set outcome = p_outcome, completed_at = now(),
      http_status = coalesce(v_attempt.http_status, p_http_status),
      final_url = coalesce(v_attempt.final_url, p_final_url),
      raw_page_hash = coalesce(v_attempt.raw_page_hash, p_raw_page_hash),
      error_code = p_error_code
    where id = p_claim_id and outcome = 'claimed';
  if not found then raise exception 'Page attempt is not claimed'; end if;
  update private.cpsc_page_work_state
    set claim_id = null, claim_expires_at = null,
      next_attempt_at = v_next, consecutive_failures = v_failures,
      manual_review_required = v_review, last_outcome = p_outcome
    where identity_id = v_state.identity_id;
  return jsonb_build_object('outcome', p_outcome, 'nextAttemptAt', v_next,
    'manualReviewRequired', v_review);
end;
$$;

-- The semantic RPC now consumes transport already retained by the preceding
-- statement. A coverage rejection leaves those exact bytes and attempt link.
create or replace function public.commit_cpsc_page_evidence_verified(
  p_claim_id uuid, p_snapshot jsonb, p_revision jsonb,
  p_candidates jsonb, p_ledger jsonb, p_raw_bytes bytea)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text;
  v_attempt private.cpsc_page_attempts%rowtype;
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
  select * into v_attempt from private.cpsc_page_attempts
    where id = p_claim_id and outcome = 'claimed';
  if v_attempt.id is null or v_attempt.raw_payload_sha256 is distinct from v_hash
    or v_attempt.raw_page_hash is distinct from v_hash
    or p_snapshot->>'rawPageHash' is distinct from v_hash
    or p_revision->>'parserVersion' is distinct from 'phase-16.13-structured-v2'
    or jsonb_typeof(p_revision->'normalized'->'tables') is distinct from 'array'
    or p_snapshot->>'finalUrl' is distinct from v_attempt.final_url
    or p_snapshot->>'contentType' is distinct from v_attempt.transport_content_type
    or p_snapshot->'redirectChain' is distinct from v_attempt.transport_redirect_chain then
    raise exception 'CPSC semantic commit lacks matching transport';
  end if;
  return public.commit_cpsc_page_evidence(
    p_claim_id, p_snapshot, p_revision, p_candidates, p_ledger);
end;
$$;

revoke all on function public.retain_cpsc_page_transport(uuid, jsonb, bytea)
  from public, anon, authenticated, service_role, cpsc_page_worker;
grant execute on function public.retain_cpsc_page_transport(uuid, jsonb, bytea)
  to cpsc_page_worker;
create trigger cpsc_structural_snapshot_no_update_delete
  before update or delete on private.cpsc_page_structural_snapshots
  for each row execute function private.cpsc_reject_structural_snapshot_change();
create trigger cpsc_structural_snapshot_no_truncate
  before truncate on private.cpsc_page_structural_snapshots
  for each statement execute function private.cpsc_reject_structural_snapshot_change();
revoke all on function private.cpsc_reject_structural_snapshot_change()
  from public, anon, authenticated, service_role, cpsc_page_worker;

-- Canonical table identities are recomputed from immutable normalized evidence.
-- The worker's proposed identities must equal this result before coverage can
-- attach to an old revision with incomplete table_identities.
create function private.cpsc_expected_page_tables(p_normalized jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_table record;
  v_row record;
  v_tables jsonb := '[]'::jsonb;
  v_rows jsonb;
begin
  if jsonb_typeof(p_normalized->'tables') is distinct from 'array' then
    raise exception 'Invalid structural evidence';
  end if;
  for v_table in
    select value, ordinality from jsonb_array_elements(p_normalized->'tables') with ordinality
  loop
    if jsonb_typeof(v_table.value) is distinct from 'array'
      or jsonb_array_length(v_table.value) = 0
      or jsonb_typeof(v_table.value->0) is distinct from 'array' then
      raise exception 'Invalid structural evidence';
    end if;
    v_rows := '[]'::jsonb;
    for v_row in
      select value from jsonb_array_elements(v_table.value) with ordinality r(value, n)
        where n > 1 order by n
    loop
      if jsonb_typeof(v_row.value) is distinct from 'array' then
        raise exception 'Invalid structural evidence';
      end if;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'identity', private.cpsc_canonical_json_sha256(v_row.value),
        'evidence', v_row.value));
    end loop;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object(
      'identity', 'description/table/' || (v_table.ordinality - 1)::text || '/' ||
        private.cpsc_canonical_json_sha256(v_table.value->0),
      'rows', v_rows));
  end loop;
  return v_tables;
end;
$$;
revoke all on function private.cpsc_expected_page_tables(jsonb)
  from public, anon, authenticated, service_role, cpsc_page_worker;

create function private.cpsc_record_page_structural_snapshot(
  p_revision_id uuid, p_revision jsonb, p_ledger jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_revision private.cpsc_page_revisions%rowtype;
  v_expected jsonb;
  v_existing private.cpsc_page_structural_snapshots%rowtype;
begin
  perform private.cpsc_validate_coverage_ledger(p_ledger);
  select * into v_revision from private.cpsc_page_revisions
    where id = p_revision_id for update;
  if v_revision.id is null
    or p_revision->>'semanticHash' is distinct from v_revision.evidence_hash
    or p_revision->'normalized' is distinct from v_revision.normalized_evidence
    or p_revision->>'parserVersion' is distinct from p_ledger->>'parserVersion'
    or p_ledger->>'censusVersion' is distinct from 'phase-16.13-census-v1'
    or p_ledger->>'extractorVersion' is distinct from 'phase-16.11-html-v1' then
    raise exception 'CPSC structural evidence is incompatible with revision';
  end if;
  v_expected := private.cpsc_expected_page_tables(v_revision.normalized_evidence);
  if p_revision->'tableIdentities' is distinct from v_expected
    or (v_revision.parser_version = p_revision->>'parserVersion'
        and v_revision.table_identities is distinct from v_expected) then
    raise exception 'CPSC structural census is incompatible with revision';
  end if;
  insert into private.cpsc_page_structural_snapshots
    (revision_id, parser_version, extractor_version, census_version,
     semantic_hash, table_identities)
  values (p_revision_id, p_ledger->>'parserVersion',
    p_ledger->>'extractorVersion', p_ledger->>'censusVersion',
    v_revision.evidence_hash, v_expected)
  on conflict do nothing;
  select * into v_existing from private.cpsc_page_structural_snapshots
    where revision_id = p_revision_id
      and parser_version = p_ledger->>'parserVersion'
      and extractor_version = p_ledger->>'extractorVersion'
      and census_version = p_ledger->>'censusVersion';
  if v_existing.semantic_hash is distinct from v_revision.evidence_hash
    or v_existing.table_identities is distinct from v_expected then
    raise exception 'CPSC structural snapshot conflicts with revision';
  end if;
end;
$$;
revoke all on function private.cpsc_record_page_structural_snapshot(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role, cpsc_page_worker;

create or replace function private.cpsc_check_coverage_binding(p_revision_id uuid, p_ledger jsonb)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  v_revision private.cpsc_page_revisions%rowtype;
  v_tables jsonb;
begin
  select * into v_revision from private.cpsc_page_revisions where id = p_revision_id;
  if v_revision.id is null then raise exception 'Unknown CPSC page revision'; end if;
  select s.table_identities into v_tables
    from private.cpsc_page_structural_snapshots s
    where s.revision_id = p_revision_id
      and s.parser_version = p_ledger->>'parserVersion'
      and s.extractor_version = p_ledger->>'extractorVersion'
      and s.census_version = p_ledger->>'censusVersion';
  if not found then
    -- Owner-only historical replay keeps the original revision binding path.
    -- The dedicated verified commit always records a compatible snapshot first.
    v_tables := v_revision.table_identities;
  end if;
  if p_ledger->>'sourceSemanticRevision' is distinct from v_revision.evidence_hash then
    raise exception 'CPSC coverage ledger names another source revision';
  end if;
  if (select count(*) from jsonb_array_elements(p_ledger->'structures') s(body)
      where body->>'kind' = 'table' and body->>'tableIdentity' is not null)
      <> jsonb_array_length(v_tables)
    or exists (select 1 from jsonb_array_elements(v_tables) with ordinality t(body, n)
      where (select count(*) from jsonb_array_elements(p_ledger->'structures') s(sbody)
        where sbody->>'kind' = 'table' and (sbody->>'tableIndex')::integer = t.n - 1
          and sbody->>'tableIdentity' = t.body->>'identity') <> 1)
    or exists (select 1 from jsonb_array_elements(p_ledger->'structures') s(body)
      where body->>'kind' = 'table' and body->>'tableIdentity' is null
        and (body->>'tableIndex')::integer < jsonb_array_length(v_tables)) then
    raise exception 'CPSC coverage ledger does not account for every stored table';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_tables) with ordinality t(body, n)
    join lateral (select sbody from jsonb_array_elements(p_ledger->'structures') s(sbody)
      where sbody->>'tableIdentity' = t.body->>'identity') st on true
    where exists (select 1 from jsonb_array_elements(st.sbody->'records') r(rec)
        where rec->>'rowIdentity' is not null
          and not exists (select 1 from jsonb_array_elements(
              case when jsonb_typeof(t.body->'rows') = 'array' then t.body->'rows'
                else '[]'::jsonb end) stored(row_body)
            where stored.row_body->>'identity' = rec->>'rowIdentity'))
      or (jsonb_array_length(st.sbody->'anomalies') = 0
        and (select coalesce(array_agg(rec->>'rowIdentity' order by n), '{}')
            from jsonb_array_elements(st.sbody->'records') with ordinality r(rec, n)
            where rec->>'rowIdentity' is not null)
          is distinct from (select coalesce(array_agg(row_body->>'identity' order by n), '{}')
            from jsonb_array_elements(case when jsonb_typeof(t.body->'rows') = 'array'
              then t.body->'rows' else '[]'::jsonb end) with ordinality stored(row_body, n)))
  ) then
    raise exception 'CPSC coverage ledger rows do not match the stored revision';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_ledger->'structures') s(body),
      jsonb_array_elements(body->'records') r(rec)
    where rec->>'disposition' = 'parsed_reviewable'
      and (
        (body->>'kind' = 'table' and (
          rec->>'rowIdentity' is null
          or rec->>'relation' is distinct from
            (body->>'tableIdentity') || '/' || (rec->>'rowIdentity')
          or not exists (select 1 from private.cpsc_candidate_criteria c
            where c.revision_id = v_revision.id and c.conjunction_key = rec->>'relation')))
        or (body->>'kind' = 'prose' and not exists (
          select 1 from jsonb_array_elements(p_ledger->'structures') other(obody)
          where obody->>'kind' = 'table' and obody->>'tableIdentity' is not null
            and rec->>'relation' = 'governs:' || (obody->>'tableIdentity'))))
  ) then
    raise exception 'CPSC coverage ledger reviewable records are not bound to proposals';
  end if;
end;
$$;

create or replace function public.claim_cpsc_page_evidence(p_limit integer default 1)
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
      and not coalesce(w.manual_review_required, false)
      and coalesce(w.next_attempt_at, '-infinity'::timestamptz) <= now()
      and (w.claim_id is null or w.claim_expires_at <= now())
    order by coalesce(w.next_attempt_at, '-infinity'::timestamptz),
      coalesce(w.last_success_at, w.last_attempt_at, i.first_seen_at),
      i.official_recall_number
    limit p_limit for update of i skip locked
  loop
    -- The expired attempt is preserved. Only work-state claim_id changes.
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

create or replace function public.commit_cpsc_page_evidence(
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
  if jsonb_typeof(p_revision->'normalized'->'tables') = 'array'
    and p_ledger->>'parserVersion' = 'phase-16.13-structured-v2' then
    perform private.cpsc_record_page_structural_snapshot(
      (v_revision->>'revisionId')::uuid, p_revision, p_ledger);
  end if;
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

commit;
