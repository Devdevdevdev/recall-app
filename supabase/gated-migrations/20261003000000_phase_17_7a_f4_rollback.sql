-- Phase 17.7a F-4 ROLLBACK (gated). NEVER in supabase/migrations: it is applied only
-- on an explicit "GO F4-ROLLBACK" after a failed or unwanted installation.
-- It restores the exact pre-F-4 definitions of the four replaced functions (generated
-- with pg_get_functiondef from a database at 20261001090000; their md5 must equal the
-- production pre-installation values recorded in the install plan) and removes every
-- F-4 trigger and helper. It changes NO data: evaluations already stored as
-- needs_review by F-4 stay needs_review and are never re-promoted automatically.
begin;

drop trigger if exists alerts_require_safe_scope on public.alerts;
drop trigger if exists recall_alert_eligibility_v2_require_safe_scope on private.recall_alert_eligibility_v2;
drop trigger if exists recall_alert_snapshots_v2_require_safe_scope on private.recall_alert_snapshots_v2;
drop trigger if exists recall_matches_require_safe_confirmation on public.recall_matches;
drop trigger if exists recall_match_evaluations_v2_require_safe_confirmation on private.recall_match_evaluations_v2;

drop function public.finalize_recall_match_evaluation(
  uuid, uuid, text, timestamptz, timestamptz, uuid, public.recall_match_status, numeric,
  text, jsonb, text, text, text, text);

CREATE OR REPLACE FUNCTION public.finalize_recall_match_evaluation(p_owned_product_id uuid, p_recall_notice_id uuid, p_evidence_fingerprint text, p_expected_product_updated_at timestamp with time zone, p_expected_recall_updated_at timestamp with time zone, p_lease_token uuid, p_status recall_match_status, p_confidence numeric, p_match_method text, p_matched_identifiers jsonb, p_reasoning_summary text, p_ai_provider text, p_ai_model text, p_schema_version text)
 RETURNS TABLE(status text, recall_match_id uuid, alert_id uuid, alert_outcome text, previous_status recall_match_status, confirmation_reversed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.finalize_recall_match_evaluation_v2(p_owned_product_id uuid, p_recall_notice_id uuid, p_evidence_fingerprint text, p_expected_product_updated_at timestamp with time zone, p_expected_recall_updated_at timestamp with time zone, p_lease_token uuid, p_status recall_match_status, p_confidence numeric, p_matched_identifiers jsonb, p_reasoning_summary text)
 RETURNS TABLE(status text, evaluation_id uuid, alert_eligibility text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  select r.status, r.evaluation_id, r.alert_eligibility
  into status, evaluation_id, alert_eligibility
  from public.finalize_recall_match_evaluation_v2_phase163(
    p_owned_product_id,p_recall_notice_id,p_evidence_fingerprint,
    p_expected_product_updated_at,p_expected_recall_updated_at,p_lease_token,
    p_status,p_confidence,p_matched_identifiers,p_reasoning_summary) r;
  if status = 'finalized' and p_status = 'confirmed' and alert_eligibility = 'none'
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
end; $function$
;

CREATE OR REPLACE FUNCTION public.create_recall_v2_alert(p_owned_product_id uuid, p_recall_notice_id uuid)
 RETURNS TABLE(status text, alert_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end; $function$
;

CREATE OR REPLACE FUNCTION public.queue_recall_push_alerts(p_alert_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  on conflict on constraint push_alert_queue_pkey do nothing;

  get diagnostics v_queued = row_count;
  return v_queued;
end;
$function$
;

revoke all on function public.finalize_recall_match_evaluation(
  uuid, uuid, text, timestamptz, timestamptz, uuid, public.recall_match_status, numeric,
  text, jsonb, text, text, text, text) from public, anon, authenticated;
grant execute on function public.finalize_recall_match_evaluation(
  uuid, uuid, text, timestamptz, timestamptz, uuid, public.recall_match_status, numeric,
  text, jsonb, text, text, text, text) to service_role;

drop function private.require_safe_v1_alert();
drop function private.require_safe_v2_eligibility();
drop function private.require_safe_v2_alert_snapshot();
drop function private.require_safe_confirmation();
drop function private.neutralize_unsafe_automatic_alerts(boolean);
drop function private.automatic_alert_eligibility(uuid, uuid);
drop function private.automatic_alert_classification(boolean, text, text, text, text, text, jsonb, jsonb);
drop function private.automatic_alert_rule_set_valid(jsonb, text, text, text);
drop function private.automatic_alert_jurisdiction(text, jsonb);
drop function private.automatic_alert_identifier(text);

commit;
