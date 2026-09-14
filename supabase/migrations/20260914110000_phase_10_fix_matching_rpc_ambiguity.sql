create or replace function public.claim_recall_match_evaluation(
  p_owned_product_id uuid,
  p_recall_notice_id uuid,
  p_evidence_fingerprint text,
  p_expected_product_updated_at timestamptz,
  p_expected_recall_updated_at timestamptz,
  p_lease_seconds integer default 120
)
returns table (
  status text,
  lease_token uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product_updated_at timestamptz;
  v_recall_updated_at timestamptz;
  v_lease_token uuid := gen_random_uuid();
  v_lease_expires_at timestamptz;
begin
  if p_evidence_fingerprint is null
    or p_evidence_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'a canonical SHA-256 evidence fingerprint is required';
  end if;

  select owned_product.updated_at
  into v_product_updated_at
  from public.owned_products as owned_product
  where owned_product.id = p_owned_product_id;

  select recall_notice.updated_at
  into v_recall_updated_at
  from public.recall_notices as recall_notice
  join public.recall_sources as recall_source
    on recall_source.id = recall_notice.source_id
  where recall_notice.id = p_recall_notice_id
    and recall_source.is_authoritative;

  if v_product_updated_at is null or v_recall_updated_at is null then
    status := 'missing';
    lease_token := null;
    lease_expires_at := null;
    return next;
    return;
  end if;

  if v_product_updated_at is distinct from p_expected_product_updated_at
    or v_recall_updated_at is distinct from p_expected_recall_updated_at then
    status := 'stale';
    lease_token := null;
    lease_expires_at := null;
    return next;
    return;
  end if;

  if exists (
    select 1
    from public.recall_matches as recall_match
    where recall_match.owned_product_id = p_owned_product_id
      and recall_match.recall_notice_id = p_recall_notice_id
      and recall_match.evidence_fingerprint = p_evidence_fingerprint
  ) then
    status := 'unchanged';
    lease_token := null;
    lease_expires_at := null;
    return next;
    return;
  end if;

  v_lease_expires_at := pg_catalog.now() + pg_catalog.make_interval(
    secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 300)
  );

  insert into private.recall_matching_leases as recall_matching_leases (
    owned_product_id,
    recall_notice_id,
    evidence_fingerprint,
    lease_token,
    lease_expires_at
  )
  values (
    p_owned_product_id,
    p_recall_notice_id,
    p_evidence_fingerprint,
    v_lease_token,
    v_lease_expires_at
  )
  on conflict (owned_product_id, recall_notice_id) do update
  set
    evidence_fingerprint = excluded.evidence_fingerprint,
    lease_token = excluded.lease_token,
    lease_expires_at = excluded.lease_expires_at,
    claimed_at = pg_catalog.now(),
    attempt_count = recall_matching_leases.attempt_count + 1
  where recall_matching_leases.lease_expires_at <= pg_catalog.now()
  returning recall_matching_leases.lease_token, recall_matching_leases.lease_expires_at
  into lease_token, lease_expires_at;

  if lease_token is null then
    status := 'busy';
    return next;
    return;
  end if;

  select owned_product.updated_at
  into v_product_updated_at
  from public.owned_products as owned_product
  where owned_product.id = p_owned_product_id;

  select recall_notice.updated_at
  into v_recall_updated_at
  from public.recall_notices as recall_notice
  join public.recall_sources as recall_source
    on recall_source.id = recall_notice.source_id
  where recall_notice.id = p_recall_notice_id
    and recall_source.is_authoritative;

  if v_product_updated_at is distinct from p_expected_product_updated_at
    or v_recall_updated_at is distinct from p_expected_recall_updated_at then
    delete from private.recall_matching_leases as matching_lease
    where matching_lease.owned_product_id = p_owned_product_id
      and matching_lease.recall_notice_id = p_recall_notice_id
      and matching_lease.lease_token = v_lease_token;
    status := 'stale';
    lease_token := null;
    lease_expires_at := null;
    return next;
    return;
  end if;

  if exists (
    select 1
    from public.recall_matches as recall_match
    where recall_match.owned_product_id = p_owned_product_id
      and recall_match.recall_notice_id = p_recall_notice_id
      and recall_match.evidence_fingerprint = p_evidence_fingerprint
  ) then
    delete from private.recall_matching_leases as matching_lease
    where matching_lease.owned_product_id = p_owned_product_id
      and matching_lease.recall_notice_id = p_recall_notice_id
      and matching_lease.lease_token = v_lease_token;
    status := 'unchanged';
    lease_token := null;
    lease_expires_at := null;
    return next;
    return;
  end if;

  status := 'claimed';
  return next;
end;
$$;

create or replace function public.finalize_recall_match_evaluation(
  p_owned_product_id uuid,
  p_recall_notice_id uuid,
  p_evidence_fingerprint text,
  p_expected_product_updated_at timestamptz,
  p_expected_recall_updated_at timestamptz,
  p_lease_token uuid,
  p_status public.recall_match_status,
  p_confidence numeric,
  p_match_method text,
  p_matched_identifiers jsonb,
  p_reasoning_summary text,
  p_ai_provider text,
  p_ai_model text,
  p_schema_version text
)
returns table (
  status text,
  recall_match_id uuid,
  alert_id uuid,
  alert_outcome text,
  previous_status public.recall_match_status,
  confirmation_reversed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease_valid boolean := false;
  v_product_updated_at timestamptz;
  v_recall_updated_at timestamptz;
  v_user_id uuid;
  v_recall_match_id uuid;
  v_existing_alert_id uuid;
begin
  if p_evidence_fingerprint is null
    or p_evidence_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'a canonical SHA-256 evidence fingerprint is required';
  end if;
  if p_lease_token is null then
    raise exception 'lease token is required';
  end if;
  if p_status = 'candidate'::public.recall_match_status then
    raise exception 'candidate is not a final production evaluation status';
  end if;
  if p_match_method not in ('deterministic_v1', 'hybrid_guarded_v1') then
    raise exception 'unsupported production match method';
  end if;
  if p_match_method = 'deterministic_v1'
    and (p_ai_provider is not null or p_ai_model is not null) then
    raise exception 'deterministic evaluations cannot contain AI provenance';
  end if;
  if p_match_method = 'hybrid_guarded_v1'
    and (
      p_ai_provider is distinct from 'nebius'
      or p_ai_model is distinct from 'nvidia/nemotron-3-super-120b-a12b'
    ) then
    raise exception 'guarded hybrid evaluations require the approved Nebius model provenance';
  end if;

  select true
  into v_lease_valid
  from private.recall_matching_leases as matching_lease
  where matching_lease.owned_product_id = p_owned_product_id
    and matching_lease.recall_notice_id = p_recall_notice_id
    and matching_lease.lease_token = p_lease_token
    and matching_lease.evidence_fingerprint = p_evidence_fingerprint
    and matching_lease.lease_expires_at > pg_catalog.now()
  for update;

  if not coalesce(v_lease_valid, false) then
    status := 'stale';
    recall_match_id := null;
    alert_id := null;
    alert_outcome := 'none';
    previous_status := null;
    confirmation_reversed := false;
    return next;
    return;
  end if;

  select owned_product.updated_at, owned_product.user_id
  into v_product_updated_at, v_user_id
  from public.owned_products as owned_product
  where owned_product.id = p_owned_product_id
  for share;

  select recall_notice.updated_at
  into v_recall_updated_at
  from public.recall_notices as recall_notice
  join public.recall_sources as recall_source
    on recall_source.id = recall_notice.source_id
  where recall_notice.id = p_recall_notice_id
    and recall_source.is_authoritative
  for share of recall_notice, recall_source;

  if v_product_updated_at is null or v_recall_updated_at is null then
    delete from private.recall_matching_leases as matching_lease
    where matching_lease.owned_product_id = p_owned_product_id
      and matching_lease.recall_notice_id = p_recall_notice_id
      and matching_lease.lease_token = p_lease_token;
    status := 'missing';
    recall_match_id := null;
    alert_id := null;
    alert_outcome := 'none';
    previous_status := null;
    confirmation_reversed := false;
    return next;
    return;
  end if;

  if v_product_updated_at is distinct from p_expected_product_updated_at
    or v_recall_updated_at is distinct from p_expected_recall_updated_at then
    delete from private.recall_matching_leases as matching_lease
    where matching_lease.owned_product_id = p_owned_product_id
      and matching_lease.recall_notice_id = p_recall_notice_id
      and matching_lease.lease_token = p_lease_token;
    status := 'stale';
    recall_match_id := null;
    alert_id := null;
    alert_outcome := 'none';
    previous_status := null;
    confirmation_reversed := false;
    return next;
    return;
  end if;

  select recall_match.status
  into previous_status
  from public.recall_matches as recall_match
  where recall_match.owned_product_id = p_owned_product_id
    and recall_match.recall_notice_id = p_recall_notice_id
  for update;

  insert into public.recall_matches (
    owned_product_id,
    recall_notice_id,
    status,
    confidence,
    match_method,
    matched_identifiers,
    reasoning_summary,
    ai_provider,
    ai_model,
    schema_version,
    evidence_fingerprint,
    evaluated_at
  )
  values (
    p_owned_product_id,
    p_recall_notice_id,
    p_status,
    p_confidence,
    p_match_method,
    p_matched_identifiers,
    p_reasoning_summary,
    p_ai_provider,
    p_ai_model,
    p_schema_version,
    p_evidence_fingerprint,
    pg_catalog.now()
  )
  on conflict (owned_product_id, recall_notice_id)
  do update set
    status = excluded.status,
    confidence = excluded.confidence,
    match_method = excluded.match_method,
    matched_identifiers = excluded.matched_identifiers,
    reasoning_summary = excluded.reasoning_summary,
    ai_provider = excluded.ai_provider,
    ai_model = excluded.ai_model,
    schema_version = excluded.schema_version,
    evidence_fingerprint = excluded.evidence_fingerprint,
    evaluated_at = excluded.evaluated_at
  returning id into v_recall_match_id;

  recall_match_id := v_recall_match_id;

  select alert.id
  into v_existing_alert_id
  from public.alerts as alert
  where alert.recall_match_id = v_recall_match_id;

  if p_status = 'confirmed'::public.recall_match_status then
    if v_existing_alert_id is null then
      insert into public.alerts (user_id, recall_match_id)
      values (v_user_id, v_recall_match_id)
      on conflict on constraint alerts_recall_match_id_key do nothing
      returning id into alert_id;

      if alert_id is null then
        select alert.id
        into alert_id
        from public.alerts as alert
        where alert.recall_match_id = v_recall_match_id;
        alert_outcome := 'existing';
      else
        alert_outcome := 'created';
      end if;
    else
      alert_id := v_existing_alert_id;
      alert_outcome := 'existing';
    end if;
  else
    alert_id := v_existing_alert_id;
    alert_outcome := 'none';
  end if;

  confirmation_reversed := previous_status = 'confirmed'::public.recall_match_status
    and p_status <> 'confirmed'::public.recall_match_status;

  delete from private.recall_matching_leases as matching_lease
  where matching_lease.owned_product_id = p_owned_product_id
    and matching_lease.recall_notice_id = p_recall_notice_id
    and matching_lease.lease_token = p_lease_token;

  status := 'finalized';
  return next;
end;
$$;

revoke all on function public.claim_recall_match_evaluation(
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz,
  integer
)
from public, anon, authenticated;

revoke all on function public.finalize_recall_match_evaluation(
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz,
  uuid,
  public.recall_match_status,
  numeric,
  text,
  jsonb,
  text,
  text,
  text,
  text
)
from public, anon, authenticated;

grant execute on function public.claim_recall_match_evaluation(
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz,
  integer
)
to service_role;

grant execute on function public.finalize_recall_match_evaluation(
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz,
  uuid,
  public.recall_match_status,
  numeric,
  text,
  jsonb,
  text,
  text,
  text,
  text
)
to service_role;
