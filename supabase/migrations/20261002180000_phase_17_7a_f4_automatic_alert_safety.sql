-- Phase 17.7a F-4 is a LOCAL candidate. Do not apply in production, deploy, or
-- run the neutralization routine without a separately authorized installation.
--
-- F-4: deterministic_v1 (and hybrid_guarded_v1) could confirm a pair on an exact
-- GTIN while the official notice imposes other conditions (lot, manufacture
-- window, sticker) or a different jurisdiction, and the confirmation created an
-- automatic alert. This migration separates "confirmed by a matcher" from
-- "eligible for an automatic alert":
--
--   1. private.automatic_alert_eligibility(product, notice) derives, from server
--      data only, whether an automatic alert is proven safe: authoritative source,
--      compatible structured jurisdiction, every scope served with human-reviewed
--      rule sets whose authoritative coverage is complete, supported criterion
--      kinds only (model_number, date_code; equals / one_of), and at least one
--      rule set fully satisfied by the product. No caller-supplied flag is used.
--   2. Both finalizers downgrade an unproven 'confirmed' to 'needs_review' (the
--      candidate stays observable) and never create an alert or eligibility.
--   3. Guards on public.alerts, private.recall_alert_eligibility_v2 and
--      private.recall_alert_snapshots_v2 refuse any write without the proof, so a
--      stale Edge Function or an unexpected caller cannot reintroduce F-4.
--   4. private.neutralize_unsafe_automatic_alerts(apply) inventories and (only
--      when explicitly applied by an operator) neutralizes pre-existing unsafe
--      confirmations. It is NOT run by this migration.
-- RECALL_MATCHING_POLICY, the v1 fingerprint, AI behavior, and the v2 allowlist
-- are unchanged.
begin;

-- ===========================================================================
-- 1. Server-derived proof.
-- ===========================================================================

-- Mirrors normalizeIdentifier (NFKC, trim, collapse whitespace, upper-case) but
-- only for values that are printable ASCII after NFKC; anything else cannot be
-- compared here and never matches. SQL matching is therefore a subset of the
-- TypeScript comparison: it can withhold, never widen.
create function private.automatic_alert_identifier(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when normalized ~ '^[ -~]+$' then normalized end
  from (
    select pg_catalog.upper(pg_catalog.regexp_replace(
      pg_catalog.btrim(normalize(p_value, NFKC), E' \t\n\r\f\v'),
      '[[:space:]]+', ' ', 'g')) as normalized
  ) as value
  where p_value is not null;
$$;

-- Same rule as productCheck/gate.ts assessJurisdiction (parity tested).
create function private.automatic_alert_jurisdiction(p_country text, p_jurisdictions jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
begin
  if p_jurisdictions is null or pg_catalog.jsonb_typeof(p_jurisdictions) <> 'array'
    or pg_catalog.jsonb_array_length(p_jurisdictions) = 0 then
    return 'unsupported_scope';
  end if;
  for v_item in select value from pg_catalog.jsonb_array_elements(p_jurisdictions) loop
    if not (
      (v_item->>'type' = 'country' and coalesce(v_item->>'code', '') ~ '^[A-Z]{2}$')
      or (v_item->>'type' = 'region' and coalesce(v_item->>'code', '') ~ '^[A-Z][A-Z0-9]{1,7}$')
      or (v_item->>'type' = 'global' and v_item->>'code' = 'GLOBAL')
    ) then
      return 'human_review_required';
    end if;
  end loop;
  if p_jurisdictions @> '[{"type":"global"}]' then return 'compatible'; end if;
  if p_country is null then return 'incomplete_evidence'; end if;
  if p_country !~ '^[A-Z]{2}$' then return 'human_review_required'; end if;
  if p_jurisdictions @> pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('type', 'country', 'code', p_country)) then
    return 'compatible';
  end if;
  if p_jurisdictions @> '[{"type":"region"}]' then return 'human_review_required'; end if;
  return 'jurisdiction_mismatch';
end;
$$;

-- Mirrors validateLiveReviewedCriteriaV2 plus the rule-set identity checks of
-- validateLiveRuleSetEnvelopeV2 (except the semantic fingerprint recomputation:
-- the envelope read at runtime is built by the database itself). A rule set that
-- fails is "dropped", exactly as in TypeScript.
create function private.automatic_alert_rule_set_valid(
  p_set jsonb,
  p_scope_id text,
  p_source_authority text,
  p_source_url text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_hex constant text := '^[0-9a-f]{64}$';
  v_review jsonb;
  v_criteria jsonb;
  v_count integer;
  v_criterion jsonb;
  v_expected text[];
  v_id text;
  v_models integer := 0;
  v_values jsonb;
  v_exact boolean;
  v_listed boolean;
begin
  if p_set is null or pg_catalog.jsonb_typeof(p_set) is distinct from 'object' then return false; end if;
  v_review := p_set->'review';
  v_criteria := p_set->'criteria';
  if pg_catalog.jsonb_typeof(v_review) is distinct from 'object'
    or pg_catalog.jsonb_typeof(v_criteria) is distinct from 'array' then
    return false;
  end if;
  v_count := pg_catalog.jsonb_array_length(v_criteria);
  if v_review->>'origin' is distinct from 'human_review_ledger'
    or coalesce(v_review->>'revisionId', '') !~ v_uuid
    or coalesce(v_review->>'sourceRevisionHash', '') !~ v_hex
    or coalesce(v_review->>'scopeFingerprint', '') !~ v_hex
    or coalesce(v_review->>'conjunctionGroup', '') = ''
    or v_review->>'scopeId' is distinct from p_scope_id
    or coalesce(v_review->>'reviewedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
    or v_count = 0
    or p_set->>'semantics' is distinct from 'all_of'
    or pg_catalog.strpos(coalesce(p_source_authority, ''), 'CPSC') = 0
    or v_review->>'schema' is distinct from 'recall_rule_set_v1'
    or coalesce(v_review->>'ruleSetFingerprint', '') !~ v_hex
    or coalesce(v_review->>'identityFingerprint', '') !~ v_hex
    or coalesce(v_review->>'scopeSemanticFingerprint', '') !~ v_hex then
    return false;
  end if;
  foreach v_id in array array['candidateIds', 'reviewEventIds', 'reviewerIds'] loop
    if pg_catalog.jsonb_typeof(v_review->v_id) is distinct from 'array'
      or pg_catalog.jsonb_array_length(v_review->v_id) <> v_count
      or exists (select 1 from pg_catalog.jsonb_array_elements(v_review->v_id) as item
        where pg_catalog.jsonb_typeof(item) <> 'string' or item #>> '{}' !~ v_uuid) then
      return false;
    end if;
  end loop;
  if pg_catalog.jsonb_typeof(v_review->'sourceAddressHashes') is distinct from 'array'
    or pg_catalog.jsonb_array_length(v_review->'sourceAddressHashes') <> v_count
    or exists (select 1 from pg_catalog.jsonb_array_elements(v_review->'sourceAddressHashes') as item
      where pg_catalog.jsonb_typeof(item) <> 'string' or item #>> '{}' !~ v_hex) then
    return false;
  end if;
  select pg_catalog.array_agg('cpsc-ledger-' || item)
  into v_expected
  from pg_catalog.jsonb_array_elements_text(v_review->'candidateIds') as item;

  for v_criterion in select value from pg_catalog.jsonb_array_elements(v_criteria) loop
    if pg_catalog.jsonb_typeof(v_criterion) is distinct from 'object' then return false; end if;
    v_id := v_criterion->>'id';
    if v_id is null or not (v_id = any (v_expected)) then return false; end if;
    v_expected := pg_catalog.array_remove(v_expected, v_id);
    v_values := v_criterion->'values';
    v_exact := v_criterion->>'operator' = 'equals'
      and pg_catalog.jsonb_typeof(v_criterion->'value') = 'string'
      and pg_catalog.btrim(v_criterion->>'value') <> ''
      and not (v_criterion ? 'values');
    v_listed := v_criterion->>'operator' = 'one_of'
      and not (v_criterion ? 'value')
      and pg_catalog.jsonb_typeof(v_values) = 'array'
      and pg_catalog.jsonb_array_length(v_values) > 0
      and not exists (select 1 from pg_catalog.jsonb_array_elements(v_values) as item
        where pg_catalog.jsonb_typeof(item) <> 'string' or pg_catalog.btrim(item #>> '{}') = '')
      and (select count(distinct item) from pg_catalog.jsonb_array_elements_text(v_values) as item)
        = pg_catalog.jsonb_array_length(v_values);
    if coalesce(v_criterion->>'kind', '') not in ('model_number', 'date_code')
      or not coalesce(v_exact or v_listed, false)
      or v_criterion->'required' is distinct from 'true'::jsonb
      or v_criterion#>>'{provenance,authority}' is distinct from 'CPSC'
      or v_criterion#>>'{provenance,officialUrl}' is distinct from p_source_url
      or coalesce(v_criterion#>>'{provenance,sourceField}', '') not like 'cpsc-page:%'
      or v_criterion#>>'{provenance,normalizationRule}' is distinct from 'identifier_v2' then
      return false;
    end if;
    if v_criterion->>'kind' = 'model_number' then v_models := v_models + 1; end if;
  end loop;
  return v_models > 0;
end;
$$;

-- Pure classification shared by the runtime proof and the TS/SQL parity tests.
-- Same order as productCheck/gate.ts and the product-check orchestrator:
-- source -> jurisdiction -> envelope validity -> scope coverage -> criteria.
-- Every scope must be served by complete reviewed rule sets; the product needs to
-- satisfy only ONE rule set (OR across rule sets and scopes, AND inside a set).
-- Returns eligible | unsupported_scope | incomplete_evidence |
-- jurisdiction_mismatch | human_review_required | criteria_not_satisfied.
create function private.automatic_alert_classification(
  p_authoritative boolean,
  p_source_authority text,
  p_source_url text,
  p_purchase_country text,
  p_model_number text,
  p_date_code text,
  p_jurisdictions jsonb,
  p_scopes jsonb
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_jurisdiction text;
  v_scope jsonb;
  v_envelope jsonb;
  v_coverage jsonb;
  v_source jsonb;
  v_set jsonb;
  v_valid_sets jsonb := '[]'::jsonb;
  v_scope_valid integer;
  v_scope_dropped integer;
  v_seen text[];
  v_any_invalid boolean := false;
  v_any_absent boolean := false;
  v_any_dropped boolean := false;
  v_any_incomplete boolean := false;
  v_criterion jsonb;
  v_owned text;
  v_expected text[];
  v_set_matched boolean;
begin
  if p_authoritative is distinct from true then return 'unsupported_scope'; end if;
  v_jurisdiction := private.automatic_alert_jurisdiction(p_purchase_country, p_jurisdictions);
  if v_jurisdiction <> 'compatible' then return v_jurisdiction; end if;
  if pg_catalog.jsonb_typeof(p_scopes) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_scopes) = 0 then
    return 'unsupported_scope';
  end if;

  for v_scope in select value from pg_catalog.jsonb_array_elements(p_scopes) loop
    v_envelope := v_scope->'envelope';
    if v_envelope is null or pg_catalog.jsonb_typeof(v_envelope) = 'null' then
      v_any_absent := true;
      continue;
    end if;
    v_coverage := v_envelope->'coverage';
    if pg_catalog.jsonb_typeof(v_envelope) <> 'object'
      or v_envelope->>'semantics' is distinct from 'any_of'
      or v_envelope->>'schema' is distinct from 'recall_rule_sets_v1'
      or coalesce(v_scope->>'scopeId', '') = ''
      or v_envelope->>'scopeId' is distinct from v_scope->>'scopeId'
      or pg_catalog.jsonb_typeof(v_envelope->'ruleSets') is distinct from 'array'
      or pg_catalog.jsonb_array_length(v_envelope->'ruleSets') = 0
      or pg_catalog.jsonb_typeof(v_coverage) is distinct from 'object'
      or coalesce(v_coverage->>'proposedRuleSets', '') !~ '^-?[0-9]+$'
      or coalesce(v_coverage->>'unattributedRuleSets', '') !~ '^-?[0-9]+$'
      or coalesce(v_coverage->>'servedRuleSets', '') !~ '^-?[0-9]+$'
      or pg_catalog.jsonb_typeof(v_coverage->'complete') is distinct from 'boolean' then
      v_any_invalid := true;
      continue;
    end if;
    v_scope_valid := 0;
    v_scope_dropped := 0;
    v_seen := '{}';
    for v_set in select value from pg_catalog.jsonb_array_elements(v_envelope->'ruleSets') loop
      if private.automatic_alert_rule_set_valid(v_set, v_scope->>'scopeId', p_source_authority,
          p_source_url)
        and not (coalesce(v_set#>>'{review,ruleSetFingerprint}', '') = any (v_seen)) then
        v_seen := v_seen || (v_set#>>'{review,ruleSetFingerprint}');
        v_scope_valid := v_scope_valid + 1;
        v_valid_sets := v_valid_sets || pg_catalog.jsonb_build_array(v_set);
      else
        v_scope_dropped := v_scope_dropped + 1;
      end if;
    end loop;
    if v_scope_valid = 0 then v_any_absent := true; end if;
    if v_scope_dropped > 0 then v_any_dropped := true; end if;
    v_source := v_coverage->'sourceCoverage';
    if not coalesce(
      v_coverage->'complete' = 'true'::jsonb
      and v_source->'state' = '"recorded"'::jsonb
      and v_source->'coverageStatus' = '"complete"'::jsonb
      and v_source->'positiveStatus' = '"independent"'::jsonb
      and v_source->'negativeEvidenceEligible' = 'true'::jsonb
      and v_scope_dropped = 0
      and (v_coverage->>'unattributedRuleSets')::numeric = 0
      and (v_coverage->>'servedRuleSets')::numeric
        = pg_catalog.jsonb_array_length(v_envelope->'ruleSets')
      and (v_coverage->>'proposedRuleSets')::numeric = v_scope_valid, false) then
      v_any_incomplete := true;
    end if;
  end loop;

  if v_any_invalid then return 'human_review_required'; end if;
  if v_any_absent then return 'unsupported_scope'; end if;
  if v_any_dropped then return 'human_review_required'; end if;
  if v_any_incomplete then return 'unsupported_scope'; end if;

  for v_set in select value from pg_catalog.jsonb_array_elements(v_valid_sets) loop
    v_set_matched := true;
    for v_criterion in select value from pg_catalog.jsonb_array_elements(v_set->'criteria') loop
      v_owned := private.automatic_alert_identifier(case v_criterion->>'kind'
        when 'model_number' then p_model_number else p_date_code end);
      select pg_catalog.array_agg(private.automatic_alert_identifier(expected.value))
      into v_expected
      from (
        select v_criterion->>'value' as value where v_criterion->>'operator' = 'equals'
        union all
        select item from pg_catalog.jsonb_array_elements_text(
          case when v_criterion->>'operator' = 'one_of' then v_criterion->'values'
            else '[]'::jsonb end) as item
      ) as expected;
      if v_owned is null or v_expected is null
        or pg_catalog.array_position(v_expected, null) is not null
        or not (v_owned = any (v_expected)) then
        v_set_matched := false;
      end if;
    end loop;
    if v_set_matched then return 'eligible'; end if;
  end loop;
  return 'criteria_not_satisfied';
end;
$$;

-- Runtime proof. Takes only two ids; every input is read from server data (the
-- owner's product, the authoritative notice and source, structured jurisdictions,
-- and the database-built reviewed envelope per scope). Fail-closed on any error.
create function private.automatic_alert_eligibility(
  p_owned_product_id uuid,
  p_recall_notice_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_product public.owned_products%rowtype;
  v_authoritative boolean;
  v_authority text;
  v_url text;
begin
  select * into v_product from public.owned_products as product
  where product.id = p_owned_product_id;
  if not found then return 'unsupported_scope'; end if;
  select source.is_authoritative, source.name, notice.official_url
  into v_authoritative, v_authority, v_url
  from public.recall_notices as notice
  join public.recall_sources as source on source.id = notice.source_id
  where notice.id = p_recall_notice_id;
  if not found then return 'unsupported_scope'; end if;

  return private.automatic_alert_classification(
    v_authoritative,
    v_authority,
    v_url,
    v_product.purchase_country_code,
    v_product.model_number,
    v_product.safety_attributes->>'date_code',
    coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'type', jurisdiction.jurisdiction_type, 'code', jurisdiction.jurisdiction_code)
        order by jurisdiction.jurisdiction_type, jurisdiction.jurisdiction_code)
      from public.recall_notice_jurisdictions as jurisdiction
      where jurisdiction.recall_notice_id = p_recall_notice_id
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'scopeId', scope.id::text,
        'envelope', private.cpsc_scope_rule_set_envelope(scope.id)) order by scope.id)
      from public.recall_scopes as scope
      where scope.recall_notice_id = p_recall_notice_id
    ), '[]'::jsonb));
exception when others then
  return 'human_review_required';
end;
$$;

revoke all on function private.automatic_alert_identifier(text)
  from public, anon, authenticated, service_role;
revoke all on function private.automatic_alert_jurisdiction(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.automatic_alert_eligibility(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.automatic_alert_rule_set_valid(jsonb, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.automatic_alert_classification(
  boolean, text, text, text, text, text, jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- ===========================================================================
-- 2. Last-line guards on every automatic alert write.
-- ===========================================================================
create function private.require_safe_v1_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match public.recall_matches%rowtype;
begin
  select * into v_match from public.recall_matches as recall_match
  where recall_match.id = new.recall_match_id;
  if v_match.status is distinct from 'confirmed'::public.recall_match_status
    or private.automatic_alert_eligibility(v_match.owned_product_id, v_match.recall_notice_id)
      <> 'eligible' then
    raise exception 'automatic alert requires a proven complete official scope';
  end if;
  return new;
end;
$$;
create trigger alerts_require_safe_scope
  before insert or update of recall_match_id on public.alerts
  for each row execute function private.require_safe_v1_alert();

create function private.require_safe_v2_eligibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.revoked_at is null and (
    tg_op = 'INSERT'
    or old.revoked_at is not null
    or new.evaluation_id is distinct from old.evaluation_id
  ) and (
    not exists (
      select 1 from private.recall_match_evaluations_v2 as evaluation
      where evaluation.id = new.evaluation_id
        and evaluation.status = 'confirmed'::public.recall_match_status
    )
    or private.automatic_alert_eligibility(new.owned_product_id, new.recall_notice_id)
      <> 'eligible'
  ) then
    raise exception 'automatic alert eligibility requires a proven complete official scope';
  end if;
  return new;
end;
$$;
create trigger recall_alert_eligibility_v2_require_safe_scope
  before insert or update on private.recall_alert_eligibility_v2
  for each row execute function private.require_safe_v2_eligibility();

create function private.require_safe_v2_alert_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.automatic_alert_eligibility(new.owned_product_id, new.recall_notice_id)
    <> 'eligible' then
    raise exception 'automatic alert requires a proven complete official scope';
  end if;
  return new;
end;
$$;
create trigger recall_alert_snapshots_v2_require_safe_scope
  before insert on private.recall_alert_snapshots_v2
  for each row execute function private.require_safe_v2_alert_snapshot();

revoke all on function private.require_safe_v1_alert()
  from public, anon, authenticated, service_role;
revoke all on function private.require_safe_v2_eligibility()
  from public, anon, authenticated, service_role;
revoke all on function private.require_safe_v2_alert_snapshot()
  from public, anon, authenticated, service_role;

-- A match or v2 evaluation may only BECOME confirmed with the proof, so a direct
-- service_role write cannot set the status that push targeting relies on.
create function private.require_safe_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'confirmed'::public.recall_match_status
    and (tg_op = 'INSERT' or old.status is distinct from 'confirmed'::public.recall_match_status)
    and private.automatic_alert_eligibility(new.owned_product_id, new.recall_notice_id)
      <> 'eligible' then
    raise exception 'an automatic confirmation requires a proven complete official scope';
  end if;
  return new;
end;
$$;
create trigger recall_matches_require_safe_confirmation
  before insert or update of status on public.recall_matches
  for each row execute function private.require_safe_confirmation();
create trigger recall_match_evaluations_v2_require_safe_confirmation
  before insert on private.recall_match_evaluations_v2
  for each row execute function private.require_safe_confirmation();
revoke all on function private.require_safe_confirmation()
  from public, anon, authenticated, service_role;

-- Explicit push targeting (service_role) also requires the proof.
create or replace function public.queue_recall_push_alerts(p_alert_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queued integer;
begin
  if p_alert_ids is null
    or pg_catalog.cardinality(p_alert_ids) < 1
    or pg_catalog.cardinality(p_alert_ids) > 50 then
    raise exception 'targeted push queue requires between 1 and 50 alert ids';
  end if;

  insert into private.push_alert_queue (alert_id)
  select alert.id
  from public.alerts as alert
  join public.recall_matches as recall_match on recall_match.id = alert.recall_match_id
  where alert.id = any (p_alert_ids)
    and recall_match.status = 'confirmed'::public.recall_match_status
    and private.automatic_alert_eligibility(recall_match.owned_product_id,
      recall_match.recall_notice_id) = 'eligible'
  on conflict on constraint push_alert_queue_pkey do nothing;

  get diagnostics v_queued = row_count;
  return v_queued;
end;
$$;

-- ===========================================================================
-- 3. v1 finalizer: identical contract, plus the safety downgrade. Two result
-- columns are appended (stored_status, safety_status); existing readers keep
-- working. An unproven 'confirmed' is stored as 'needs_review' with the reason.
-- ===========================================================================
drop function public.finalize_recall_match_evaluation(
  uuid, uuid, text, timestamptz, timestamptz, uuid, public.recall_match_status, numeric,
  text, jsonb, text, text, text, text);

create function public.finalize_recall_match_evaluation(
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
  confirmation_reversed boolean,
  stored_status public.recall_match_status,
  safety_status text
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
  v_status public.recall_match_status := p_status;
  v_reasoning text := p_reasoning_summary;
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
    alert_outcome := 'none';
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
    alert_outcome := 'none';
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
    alert_outcome := 'none';
    confirmation_reversed := false;
    return next;
    return;
  end if;

  -- F-4: a matcher confirmation is a candidate signal, not an alert. It becomes an
  -- automatic confirmation only with the server-derived proof (rows locked above).
  if p_status = 'confirmed'::public.recall_match_status then
    safety_status := private.automatic_alert_eligibility(p_owned_product_id, p_recall_notice_id);
    if safety_status <> 'eligible' then
      v_status := 'needs_review'::public.recall_match_status;
      v_reasoning := 'Automatic alert withheld (' || safety_status
        || '): the official scope is not proven complete for this product. Matcher: '
        || p_reasoning_summary;
    end if;
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
    v_status,
    p_confidence,
    p_match_method,
    p_matched_identifiers,
    v_reasoning,
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

  if v_status = 'confirmed'::public.recall_match_status then
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
    and v_status <> 'confirmed'::public.recall_match_status;
  stored_status := v_status;

  delete from private.recall_matching_leases as matching_lease
  where matching_lease.owned_product_id = p_owned_product_id
    and matching_lease.recall_notice_id = p_recall_notice_id
    and matching_lease.lease_token = p_lease_token;

  status := 'finalized';
  return next;
end;
$$;

revoke all on function public.finalize_recall_match_evaluation(
  uuid, uuid, text, timestamptz, timestamptz, uuid, public.recall_match_status, numeric,
  text, jsonb, text, text, text, text) from public, anon, authenticated;
grant execute on function public.finalize_recall_match_evaluation(
  uuid, uuid, text, timestamptz, timestamptz, uuid, public.recall_match_status, numeric,
  text, jsonb, text, text, text, text) to service_role;

-- ===========================================================================
-- 4. v2 finalizer wrapper (same signature and result): the same downgrade before
-- the Phase 16.3 core records the evaluation; eligibility only with the proof.
-- ===========================================================================
create or replace function public.finalize_recall_match_evaluation_v2(
  p_owned_product_id uuid, p_recall_notice_id uuid, p_evidence_fingerprint text,
  p_expected_product_updated_at timestamptz, p_expected_recall_updated_at timestamptz,
  p_lease_token uuid, p_status public.recall_match_status, p_confidence numeric,
  p_matched_identifiers jsonb, p_reasoning_summary text
)
returns table (status text, evaluation_id uuid, alert_eligibility text)
language plpgsql security definer set search_path = '' as $$
declare
  v_status public.recall_match_status := p_status;
  v_confidence numeric := p_confidence;
  v_reasoning text := p_reasoning_summary;
  v_safety text;
begin
  if p_status = 'confirmed'::public.recall_match_status then
    v_safety := private.automatic_alert_eligibility(p_owned_product_id, p_recall_notice_id);
    if v_safety <> 'eligible' then
      v_status := 'needs_review'::public.recall_match_status;
      v_confidence := 0;
      v_reasoning := 'Automatic alert withheld (' || v_safety
        || '): the official scope is not proven complete for this product. Matcher: '
        || coalesce(p_reasoning_summary, '');
    end if;
  end if;

  select r.status, r.evaluation_id, r.alert_eligibility
  into status, evaluation_id, alert_eligibility
  from public.finalize_recall_match_evaluation_v2_phase163(
    p_owned_product_id,p_recall_notice_id,p_evidence_fingerprint,
    p_expected_product_updated_at,p_expected_recall_updated_at,p_lease_token,
    v_status,v_confidence,p_matched_identifiers,v_reasoning) r;
  if status = 'finalized' and v_status = 'confirmed' and alert_eligibility = 'none'
    and not exists (select 1 from private.recall_alert_snapshots_v2 a
      where a.owned_product_id = p_owned_product_id and a.recall_notice_id = p_recall_notice_id)
    and not exists (select 1 from public.alerts a join public.recall_matches m
      on m.id = a.recall_match_id where m.owned_product_id = p_owned_product_id
      and m.recall_notice_id = p_recall_notice_id) then
    update private.recall_alert_eligibility_v2 e
    set evaluation_id = finalize_recall_match_evaluation_v2.evaluation_id,
      revoked_at = null, revoked_by_evaluation_id = null, created_at = now()
    where e.owned_product_id = p_owned_product_id and e.recall_notice_id = p_recall_notice_id
      and e.evaluation_id is distinct from finalize_recall_match_evaluation_v2.evaluation_id;
    if found then alert_eligibility := 'created'; end if;
  end if;
  return next;
end; $$;

-- ===========================================================================
-- 5. v2 alert writer: an eligibility row that is no longer proven safe (for
-- example one recorded before F-4, reached again through a retry/unchanged
-- recovery) yields 'ineligible' instead of an alert.
-- ===========================================================================
create or replace function public.create_recall_v2_alert(p_owned_product_id uuid, p_recall_notice_id uuid)
returns table (status text, alert_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_e private.recall_alert_eligibility_v2%rowtype; v_eval private.recall_match_evaluations_v2%rowtype;
  v_user uuid; v_source jsonb; v_evidence jsonb; v_id uuid;
begin
  select * into v_e from private.recall_alert_eligibility_v2 e
  where e.owned_product_id = p_owned_product_id and e.recall_notice_id = p_recall_notice_id
  for update;
  if not found or v_e.revoked_at is not null then
    status := 'ineligible'; alert_id := null; return next; return;
  end if;
  select * into v_eval from private.recall_match_evaluations_v2 e where e.id = v_e.evaluation_id;
  if v_eval.status is distinct from 'confirmed' or exists (
    select 1 from private.recall_match_evaluations_v2 newer
    where newer.owned_product_id = p_owned_product_id
      and newer.recall_notice_id = p_recall_notice_id
      and newer.observation_seq > v_eval.observation_seq
  ) then status := 'ineligible'; alert_id := null; return next; return; end if;
  select a.id into v_id from private.recall_alert_snapshots_v2 a
  where a.owned_product_id = p_owned_product_id and a.recall_notice_id = p_recall_notice_id;
  if v_id is not null then status := 'existing'; alert_id := v_id; return next; return; end if;
  -- F-4: no new alert unless the server-derived proof holds now.
  if private.automatic_alert_eligibility(p_owned_product_id, p_recall_notice_id) <> 'eligible' then
    status := 'ineligible'; alert_id := null; return next; return;
  end if;
  if exists (select 1 from public.alerts a join public.recall_matches m on m.id = a.recall_match_id
    where m.owned_product_id = p_owned_product_id and m.recall_notice_id = p_recall_notice_id)
  then status := 'ineligible'; alert_id := null; return next; return; end if;
  select p.user_id into v_user from public.owned_products p
  where p.id = p_owned_product_id for share;
  select e.source_snapshot - 'raw_payload' into v_source
  from private.recall_evaluation_evidence_v2 e where e.evaluation_id = v_eval.id;
  if not exists (select 1 from public.recall_notices n
    join public.recall_sources s on s.id = n.source_id
    where n.id = p_recall_notice_id and s.is_authoritative) then
    status := 'ineligible'; alert_id := null; return next; return;
  end if;
  if v_user is null or v_source is null then
    status := 'ineligible'; alert_id := null; return next; return;
  end if;
  v_evidence := jsonb_build_object('fingerprint', v_eval.evidence_fingerprint,
    'status', v_eval.status, 'match_method', v_eval.match_method,
    'schema_version', v_eval.schema_version, 'matched_identifiers', v_eval.matched_identifiers,
    'reasoning_summary', v_eval.reasoning_summary, 'evaluated_at', v_eval.evaluated_at,
    'evidence', (select to_jsonb(e) - 'evaluation_id' - 'captured_at'
      from private.recall_evaluation_evidence_v2 e where e.evaluation_id = v_eval.id));
  insert into private.recall_alert_snapshots_v2
    (user_id, owned_product_id, recall_notice_id, evaluation_id, source_snapshot, evidence_snapshot)
  values (v_user, p_owned_product_id, p_recall_notice_id, v_eval.id, v_source, v_evidence)
  on conflict (owned_product_id, recall_notice_id) do nothing returning id into v_id;
  status := case when v_id is null then 'existing' else 'created' end;
  if v_id is null then select a.id into v_id from private.recall_alert_snapshots_v2 a
    where a.owned_product_id = p_owned_product_id and a.recall_notice_id = p_recall_notice_id; end if;
  alert_id := v_id; return next;
end; $$;

-- ===========================================================================
-- 6. Operator-only neutralization of confirmations recorded before F-4. Not run
-- here. With p_apply = false it is a read-only inventory. Applied, it never
-- deletes an alert (alerts are history; the read models then show the pair as no
-- longer confirmed):
--   v1: the confirmed match becomes needs_review and its fingerprint is cleared
--       so the next run re-evaluates it under the F-4 finalizer;
--   v2: an append-only needs_review evaluation is recorded and the active
--       eligibility is revoked by it.
-- ===========================================================================
create function private.neutralize_unsafe_automatic_alerts(p_apply boolean)
returns table (
  kind text,
  owned_product_id uuid,
  recall_notice_id uuid,
  reason text,
  has_alert boolean,
  action text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row record;
  v_evaluation uuid;
begin
  if p_apply is null then raise exception 'p_apply is required'; end if;

  for v_row in
    select recall_match.id, recall_match.owned_product_id, recall_match.recall_notice_id,
      private.automatic_alert_eligibility(recall_match.owned_product_id,
        recall_match.recall_notice_id) as reason,
      exists (select 1 from public.alerts as alert
        where alert.recall_match_id = recall_match.id) as has_alert
    from public.recall_matches as recall_match
    where recall_match.status = 'confirmed'::public.recall_match_status
    order by recall_match.owned_product_id, recall_match.recall_notice_id
  loop
    continue when v_row.reason = 'eligible';
    if p_apply then
      update public.recall_matches as recall_match
      set status = 'needs_review'::public.recall_match_status,
        reasoning_summary = 'F-4 neutralization: automatic confirmation withdrawn ('
          || v_row.reason || '). Previous: ' || recall_match.reasoning_summary,
        evidence_fingerprint = null,
        evaluated_at = pg_catalog.now()
      where recall_match.id = v_row.id;
    end if;
    kind := 'v1_match';
    owned_product_id := v_row.owned_product_id;
    recall_notice_id := v_row.recall_notice_id;
    reason := v_row.reason;
    has_alert := v_row.has_alert;
    action := case when p_apply then 'downgraded' else 'would_downgrade' end;
    return next;
  end loop;

  for v_row in
    select eligibility.owned_product_id, eligibility.recall_notice_id, eligibility.evaluation_id,
      private.automatic_alert_eligibility(eligibility.owned_product_id,
        eligibility.recall_notice_id) as reason,
      exists (select 1 from private.recall_alert_snapshots_v2 as snapshot
        where snapshot.owned_product_id = eligibility.owned_product_id
          and snapshot.recall_notice_id = eligibility.recall_notice_id) as has_alert
    from private.recall_alert_eligibility_v2 as eligibility
    where eligibility.revoked_at is null
    order by eligibility.owned_product_id, eligibility.recall_notice_id
  loop
    continue when v_row.reason = 'eligible';
    if p_apply then
      insert into private.recall_match_evaluations_v2 (
        owned_product_id, recall_notice_id, evidence_fingerprint, status, confidence,
        matched_identifiers, reasoning_summary
      ) values (
        v_row.owned_product_id, v_row.recall_notice_id,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          'phase-17-7a-f4-neutralization:' || v_row.evaluation_id::text, 'UTF8')), 'hex'),
        'needs_review'::public.recall_match_status, 0, '{}'::jsonb,
        'F-4 neutralization: automatic alert eligibility revoked (' || v_row.reason || ').'
      )
      on conflict (owned_product_id, recall_notice_id, evidence_fingerprint) do nothing
      returning id into v_evaluation;
      if v_evaluation is null then
        select evaluation.id into v_evaluation from private.recall_match_evaluations_v2 as evaluation
        where evaluation.owned_product_id = v_row.owned_product_id
          and evaluation.recall_notice_id = v_row.recall_notice_id
          and evaluation.evidence_fingerprint = pg_catalog.encode(pg_catalog.sha256(
            pg_catalog.convert_to('phase-17-7a-f4-neutralization:' || v_row.evaluation_id::text,
              'UTF8')), 'hex');
      end if;
      update private.recall_alert_eligibility_v2 as eligibility
      set revoked_at = pg_catalog.now(), revoked_by_evaluation_id = v_evaluation
      where eligibility.owned_product_id = v_row.owned_product_id
        and eligibility.recall_notice_id = v_row.recall_notice_id
        and eligibility.revoked_at is null;
    end if;
    kind := 'v2_eligibility';
    owned_product_id := v_row.owned_product_id;
    recall_notice_id := v_row.recall_notice_id;
    reason := v_row.reason;
    has_alert := v_row.has_alert;
    action := case when p_apply then 'revoked' else 'would_revoke' end;
    return next;
  end loop;
end;
$$;
revoke all on function private.neutralize_unsafe_automatic_alerts(boolean)
  from public, anon, authenticated, service_role;

commit;
