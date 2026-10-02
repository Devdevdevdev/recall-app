-- Prepared only. Do not deploy this migration before the Phase 16.3 activation gate.
begin;

-- Scope rows are replaced on source refresh, so reviewed bindings disappear rather than
-- silently attaching to a new version of the official record.
create table private.recall_scope_criteria_v2 (
  scope_id uuid primary key references public.recall_scopes(id) on delete cascade,
  criteria jsonb not null,
  reviewed_at timestamptz not null,
  source_url text not null,
  constraint recall_scope_criteria_v2_shape check (
    jsonb_typeof(criteria) = 'object'
    and criteria->>'semantics' in ('all_of', 'ambiguous')
    and jsonb_typeof(criteria->'criteria') = 'array'
    and jsonb_array_length(criteria->'criteria') > 0
  ),
  constraint recall_scope_criteria_v2_official_url check (source_url ~ '^https://[^/]+/')
);
alter table private.recall_scope_criteria_v2 enable row level security;

-- Every v2 evaluation is an immutable observation. The v1 recall_matches row and any
-- existing alert remain untouched. The unique fingerprint makes replay idempotent.
create table private.recall_match_evaluations_v2 (
  id uuid primary key default gen_random_uuid(),
  owned_product_id uuid not null references public.owned_products(id) on delete cascade,
  recall_notice_id uuid not null references public.recall_notices(id) on delete restrict,
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  status public.recall_match_status not null check (status <> 'candidate'),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  match_method text not null default 'deterministic_v2'
    check (match_method = 'deterministic_v2'),
  schema_version text not null default '2.0.0' check (schema_version = '2.0.0'),
  matched_identifiers jsonb not null default '{}'::jsonb
    check (jsonb_typeof(matched_identifiers) = 'object'),
  reasoning_summary text not null check (btrim(reasoning_summary) <> ''),
  evaluated_at timestamptz not null default now(),
  unique (owned_product_id, recall_notice_id, evidence_fingerprint)
);
alter table private.recall_match_evaluations_v2 enable row level security;

-- An eligibility record is not an alert or push request. Activation needs a separately
-- reviewed alert writer/read model. The pair uniqueness prevents duplicate eligibility.
create table private.recall_alert_eligibility_v2 (
  owned_product_id uuid not null references public.owned_products(id) on delete cascade,
  recall_notice_id uuid not null references public.recall_notices(id) on delete restrict,
  evaluation_id uuid not null unique references private.recall_match_evaluations_v2(id)
    on delete restrict,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by_evaluation_id uuid references private.recall_match_evaluations_v2(id)
    on delete restrict,
  constraint recall_alert_eligibility_v2_revocation_check check (
    (revoked_at is null and revoked_by_evaluation_id is null)
    or (revoked_at is not null and revoked_by_evaluation_id is not null)
  ),
  primary key (owned_product_id, recall_notice_id)
);
alter table private.recall_alert_eligibility_v2 enable row level security;

-- Keep the existing bounded candidate RPC unchanged. The v2 runner reads these
-- scope rows by ID, never by an array index inferred from the v1 batch payload.
create function public.get_recall_v2_scopes(p_recall_notice_id uuid)
returns table (
  scope_id uuid,
  brand text,
  product_name text,
  gtin text,
  model_number text,
  lot_from text,
  lot_to text,
  serial_from text,
  serial_to text,
  manufactured_from date,
  manufactured_to date,
  additional_criteria jsonb,
  reviewed_criteria jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select scope.id, scope.brand, scope.product_name, scope.gtin,
    scope.model_number, scope.lot_from, scope.lot_to, scope.serial_from,
    scope.serial_to, scope.manufactured_from, scope.manufactured_to,
    scope.additional_criteria,
    case when binding.source_url = notice.official_url then binding.criteria
      else null end as reviewed_criteria
  from public.recall_scopes as scope
  join public.recall_notices as notice on notice.id = scope.recall_notice_id
  join public.recall_sources as source on source.id = notice.source_id
  left join private.recall_scope_criteria_v2 as binding on binding.scope_id = scope.id
  where scope.recall_notice_id = p_recall_notice_id
    and source.is_authoritative
  order by scope.id;
$$;

create function public.finalize_recall_match_evaluation_v2(
  p_owned_product_id uuid,
  p_recall_notice_id uuid,
  p_evidence_fingerprint text,
  p_expected_product_updated_at timestamptz,
  p_expected_recall_updated_at timestamptz,
  p_lease_token uuid,
  p_status public.recall_match_status,
  p_confidence numeric,
  p_matched_identifiers jsonb,
  p_reasoning_summary text
)
returns table (status text, evaluation_id uuid, alert_eligibility text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product_revision timestamptz;
  v_recall_revision timestamptz;
  v_existing_id uuid;
  v_eligible_id uuid;
  v_final_eval_id uuid;
begin
  if p_evidence_fingerprint is null or p_evidence_fingerprint !~ '^[0-9a-f]{64}$'
    or p_lease_token is null or p_status is null or p_status = 'candidate'
    or p_confidence is null or p_confidence < 0 or p_confidence > 1
    or p_matched_identifiers is null or jsonb_typeof(p_matched_identifiers) <> 'object'
    or p_reasoning_summary is null or btrim(p_reasoning_summary) = '' then
    raise exception 'invalid deterministic_v2 finalization';
  end if;

  perform 1 from private.recall_matching_leases as lease
  where lease.owned_product_id = p_owned_product_id
    and lease.recall_notice_id = p_recall_notice_id
    and lease.evidence_fingerprint = p_evidence_fingerprint
    and lease.lease_token = p_lease_token
    and lease.lease_expires_at > pg_catalog.now()
  for update;
  if not found then
    status := 'stale'; evaluation_id := null; alert_eligibility := 'none';
    return next; return;
  end if;

  select product.updated_at into v_product_revision
  from public.owned_products as product where product.id = p_owned_product_id for share;
  select notice.updated_at into v_recall_revision
  from public.recall_notices as notice
  join public.recall_sources as source on source.id = notice.source_id
  where notice.id = p_recall_notice_id and source.is_authoritative
  for share of notice, source;
  if v_product_revision is null or v_recall_revision is null then
    status := 'missing'; evaluation_id := null; alert_eligibility := 'none';
    return next; return;
  end if;
  if v_product_revision is distinct from p_expected_product_updated_at
    or v_recall_revision is distinct from p_expected_recall_updated_at then
    status := 'stale'; evaluation_id := null; alert_eligibility := 'none';
    return next; return;
  end if;

  insert into private.recall_match_evaluations_v2 (
    owned_product_id, recall_notice_id, evidence_fingerprint, status, confidence,
    matched_identifiers, reasoning_summary
  ) values (
    p_owned_product_id, p_recall_notice_id, p_evidence_fingerprint, p_status,
    p_confidence, p_matched_identifiers, p_reasoning_summary
  ) on conflict (owned_product_id, recall_notice_id, evidence_fingerprint) do nothing
  returning id into evaluation_id;
  if evaluation_id is null then
    select v2.id into v_existing_id
    from private.recall_match_evaluations_v2 as v2
    where v2.owned_product_id = p_owned_product_id
      and v2.recall_notice_id = p_recall_notice_id
      and v2.evidence_fingerprint = p_evidence_fingerprint;
    evaluation_id := v_existing_id;
    status := 'unchanged';
  else
    status := 'finalized';
  end if;
  v_final_eval_id := evaluation_id;

  alert_eligibility := 'none';
  if p_status = 'confirmed' and status = 'finalized'
    and not exists (
      select 1 from public.alerts as alert
      join public.recall_matches as legacy on legacy.id = alert.recall_match_id
      where legacy.owned_product_id = p_owned_product_id
        and legacy.recall_notice_id = p_recall_notice_id
    ) then
    insert into private.recall_alert_eligibility_v2 as eligibility (
      owned_product_id, recall_notice_id, evaluation_id
    ) values (p_owned_product_id, p_recall_notice_id, evaluation_id)
    on conflict (owned_product_id, recall_notice_id) do nothing
    returning eligibility.evaluation_id into v_eligible_id;
    if v_eligible_id is not null then alert_eligibility := 'created'; end if;
  elsif p_status <> 'confirmed' and status = 'finalized' then
    update private.recall_alert_eligibility_v2 as eligibility
    set revoked_at = pg_catalog.now(), revoked_by_evaluation_id = v_final_eval_id
    where eligibility.owned_product_id = p_owned_product_id
      and eligibility.recall_notice_id = p_recall_notice_id
      and eligibility.revoked_at is null;
    if found then alert_eligibility := 'revoked'; end if;
  end if;

  delete from private.recall_matching_leases as lease
  where lease.owned_product_id = p_owned_product_id
    and lease.recall_notice_id = p_recall_notice_id
    and lease.lease_token = p_lease_token;
  return next;
end;
$$;

revoke all on table private.recall_scope_criteria_v2 from public, anon, authenticated;
revoke all on table private.recall_match_evaluations_v2 from public, anon, authenticated;
revoke all on table private.recall_alert_eligibility_v2 from public, anon, authenticated;
revoke all on function public.get_recall_v2_scopes(uuid) from public, anon, authenticated;
revoke all on function public.finalize_recall_match_evaluation_v2(
  uuid, uuid, text, timestamptz, timestamptz, uuid,
  public.recall_match_status, numeric, jsonb, text
) from public, anon, authenticated;
grant execute on function public.finalize_recall_match_evaluation_v2(
  uuid, uuid, text, timestamptz, timestamptz, uuid,
  public.recall_match_status, numeric, jsonb, text
) to service_role;
grant execute on function public.get_recall_v2_scopes(uuid) to service_role;

commit;
