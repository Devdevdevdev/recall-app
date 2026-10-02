-- Forward-only completion of the inactive Phase 16.3 contract. Apply locally for tests only.
begin;

-- Transaction timestamps can tie. A monotonic insertion order defines the latest
-- immutable observation for alert eligibility and consumer display.
alter table private.recall_match_evaluations_v2
  add column observation_seq bigint generated always as identity unique;

create function public.get_owned_product_evidence_v2(p_owned_product_id uuid)
returns table (
  owned_product_id uuid, owned_product_updated_at timestamptz, user_id uuid,
  product_name text, brand text, category text, gtin text, model_number text,
  serial_number text, lot_number text, identification_method text,
  safety_attributes jsonb
)
language sql stable security definer set search_path = '' as $$
  select p.id, p.updated_at, p.user_id, p.product_name, p.brand, p.category,
    p.gtin, p.model_number, p.serial_number, p.lot_number,
    p.identification_method, p.safety_attributes
  from public.owned_products p
  where p.id = p_owned_product_id and p.user_id is not null;
$$;
revoke all on function public.get_owned_product_evidence_v2(uuid) from public, anon, authenticated;
grant execute on function public.get_owned_product_evidence_v2(uuid) to service_role;

-- Explicit human promotion of one structured, product-specific CPSC model. There is
-- deliberately no promotion route for recall-level UPCs or free-form descriptions.
create function public.approve_cpsc_product_model_criterion_v2(
  p_scope_id uuid, p_product_index integer, p_reviewer_id text,
  p_eligibility_statement text, p_source_payload_sha256 text
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_scope public.recall_scopes%rowtype; v_notice public.recall_notices%rowtype;
  v_model text;
begin
  if p_product_index is null or p_product_index < 0 or p_product_index > 99
    or nullif(btrim(p_reviewer_id), '') is null
    or nullif(btrim(p_eligibility_statement), '') is null
    or p_source_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid source-bound review attestation';
  end if;
  select * into v_scope from public.recall_scopes where id = p_scope_id for share;
  select n.* into v_notice from public.recall_notices n
  join public.recall_sources s on s.id = n.source_id
  where n.id = v_scope.recall_notice_id and s.source_key = 'cpsc'
    and s.is_authoritative for share of n;
  if v_notice.id is null then raise exception 'authoritative CPSC scope required'; end if;
  v_model := v_notice.raw_payload #>> array['Products',p_product_index::text,'Model'];
  if nullif(btrim(v_model), '') is null or v_model <> v_scope.model_number then
    raise exception 'source product model does not match this scope';
  end if;
  insert into private.recall_scope_criteria_v2(scope_id, criteria, reviewed_at, source_url)
  values (p_scope_id, jsonb_build_object(
    'semantics','all_of',
    'review',jsonb_build_object('reviewerId',p_reviewer_id,'reviewedAt',now(),
      'sourcePayloadSha256',p_source_payload_sha256,
      'eligibilityStatement',p_eligibility_statement),
    'criteria',jsonb_build_array(jsonb_build_object(
      'id',format('cpsc-product-%s-model',p_product_index),
      'kind','model_number','operator','equals','required',true,'value',v_model,
      'provenance',jsonb_build_object('authority','CPSC',
        'officialUrl',v_notice.official_url,
        'sourceField',format('Products[%s].Model',p_product_index),
        'normalizationRule','identifier_v2')))), now(), v_notice.official_url)
  on conflict (scope_id) do update set criteria = excluded.criteria,
    reviewed_at = excluded.reviewed_at, source_url = excluded.source_url;
  -- The existing claim/finalize contract compares the notice revision. Advancing it
  -- invalidates in-flight evaluations based on the previous reviewed binding.
  update public.recall_notices set updated_at = now() where id = v_notice.id;
end; $$;
revoke all on function public.approve_cpsc_product_model_criterion_v2(
  uuid,integer,text,text,text) from public, anon, authenticated;
grant execute on function public.approve_cpsc_product_model_criterion_v2(
  uuid,integer,text,text,text) to service_role;

create table private.recall_alert_snapshots_v2 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  owned_product_id uuid not null references public.owned_products(id) on delete cascade,
  recall_notice_id uuid not null references public.recall_notices(id) on delete restrict,
  evaluation_id uuid not null unique references private.recall_match_evaluations_v2(id),
  source_snapshot jsonb not null check (jsonb_typeof(source_snapshot) = 'object'),
  evidence_snapshot jsonb not null check (jsonb_typeof(evidence_snapshot) = 'object'),
  state public.alert_status not null default 'unread',
  read_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint recall_alert_snapshots_v2_state_check check (
    (state = 'unread' and read_at is null and dismissed_at is null)
    or (state = 'read' and read_at is not null and dismissed_at is null)
    or (state = 'dismissed' and dismissed_at is not null)
  ),
  unique (owned_product_id, recall_notice_id)
);
alter table private.recall_alert_snapshots_v2 enable row level security;
revoke all on private.recall_alert_snapshots_v2 from public, anon, authenticated;

create table private.recall_evaluation_evidence_v2 (
  evaluation_id uuid primary key references private.recall_match_evaluations_v2(id) on delete cascade,
  source_snapshot jsonb not null,
  product_snapshot jsonb not null,
  criteria_snapshot jsonb not null,
  captured_at timestamptz not null default now()
);
alter table private.recall_evaluation_evidence_v2 enable row level security;
revoke all on private.recall_evaluation_evidence_v2 from public, anon, authenticated;

create function private.capture_evaluation_evidence_v2()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into private.recall_evaluation_evidence_v2
    (evaluation_id, source_snapshot, product_snapshot, criteria_snapshot)
  select new.id,
    jsonb_build_object('authority', s.name, 'title', n.title,
      'official_url', n.official_url, 'recall_date', n.recall_date,
      'hazard', n.hazard, 'remedy', n.remedy, 'raw_payload', n.raw_payload),
    jsonb_build_object('product_name', p.product_name, 'brand', p.brand,
      'gtin', p.gtin, 'model_number', p.model_number, 'serial_number', p.serial_number,
      'lot_number', p.lot_number, 'safety_attributes', p.safety_attributes),
    coalesce((select jsonb_agg(jsonb_build_object('scope_id', sc.id,
      'criteria', b.criteria) order by sc.id)
      from public.recall_scopes sc
      left join private.recall_scope_criteria_v2 b on b.scope_id = sc.id
      where sc.recall_notice_id = n.id), '[]'::jsonb)
  from public.owned_products p cross join public.recall_notices n
  join public.recall_sources s on s.id = n.source_id
  where p.id = new.owned_product_id and n.id = new.recall_notice_id;
  return new;
end; $$;
create trigger evaluations_capture_evidence_v2
after insert on private.recall_match_evaluations_v2
for each row execute function private.capture_evaluation_evidence_v2();

-- Historical alerts are retained. This captures the source and mutable v1 row as
-- available when this migration runs; it does not claim to reconstruct older revisions.
create table private.recall_legacy_alert_snapshots_v2 (
  alert_id uuid primary key references public.alerts(id) on delete cascade,
  source_snapshot jsonb not null,
  match_snapshot jsonb not null,
  captured_at timestamptz not null default now()
);
alter table private.recall_legacy_alert_snapshots_v2 enable row level security;
revoke all on private.recall_legacy_alert_snapshots_v2 from public, anon, authenticated;

create function private.capture_legacy_alert_snapshot_v2()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into private.recall_legacy_alert_snapshots_v2(alert_id, source_snapshot, match_snapshot)
  select new.id,
    jsonb_build_object('authority', s.name, 'title', n.title,
      'official_url', n.official_url, 'recall_date', n.recall_date,
      'hazard', n.hazard, 'remedy', n.remedy),
    jsonb_build_object('status', m.status, 'method', m.match_method,
      'confidence', m.confidence, 'reasoning', m.reasoning_summary,
      'evaluated_at', m.evaluated_at, 'matched_identifiers', m.matched_identifiers)
  from public.recall_matches m
  join public.recall_notices n on n.id = m.recall_notice_id
  join public.recall_sources s on s.id = n.source_id
  where m.id = new.recall_match_id
  on conflict (alert_id) do nothing;
  return new;
end; $$;
create trigger alerts_capture_legacy_snapshot_v2 after insert on public.alerts
for each row execute function private.capture_legacy_alert_snapshot_v2();
insert into private.recall_legacy_alert_snapshots_v2(alert_id, source_snapshot, match_snapshot)
select a.id,
  jsonb_build_object('authority', s.name, 'title', n.title,
    'official_url', n.official_url, 'recall_date', n.recall_date,
    'hazard', n.hazard, 'remedy', n.remedy),
  jsonb_build_object('status', m.status, 'method', m.match_method,
    'confidence', m.confidence, 'reasoning', m.reasoning_summary,
    'evaluated_at', m.evaluated_at, 'matched_identifiers', m.matched_identifiers)
from public.alerts a join public.recall_matches m on m.id = a.recall_match_id
join public.recall_notices n on n.id = m.recall_notice_id
join public.recall_sources s on s.id = n.source_id
on conflict (alert_id) do nothing;

create table private.recall_alert_corrections_v2 (
  id uuid primary key default gen_random_uuid(),
  owned_product_id uuid not null references public.owned_products(id) on delete cascade,
  recall_notice_id uuid not null references public.recall_notices(id) on delete restrict,
  evaluation_id uuid not null unique references private.recall_match_evaluations_v2(id),
  legacy_alert_id uuid references public.alerts(id) on delete restrict,
  v2_alert_id uuid references private.recall_alert_snapshots_v2(id) on delete restrict,
  previous_source_snapshot jsonb not null,
  correction_status text not null check (correction_status in ('needs_review', 'rejected')),
  created_at timestamptz not null default now(),
  check (num_nonnulls(legacy_alert_id, v2_alert_id) = 1)
);
alter table private.recall_alert_corrections_v2 enable row level security;
revoke all on private.recall_alert_corrections_v2 from public, anon, authenticated;

create function private.record_recall_correction_v2()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_legacy uuid; v_v2 uuid; v_source jsonb;
begin
  if new.status = 'confirmed' then return new; end if;
  select a.id, h.source_snapshot into v_legacy, v_source
  from public.alerts a
  join public.recall_matches m on m.id = a.recall_match_id
  join private.recall_legacy_alert_snapshots_v2 h on h.alert_id = a.id
  where m.owned_product_id = new.owned_product_id
    and m.recall_notice_id = new.recall_notice_id limit 1;
  if v_legacy is null then
    select a.id, a.source_snapshot into v_v2, v_source
    from private.recall_alert_snapshots_v2 a
    where a.owned_product_id = new.owned_product_id
      and a.recall_notice_id = new.recall_notice_id;
  end if;
  if v_legacy is not null or v_v2 is not null then
    insert into private.recall_alert_corrections_v2
      (owned_product_id, recall_notice_id, evaluation_id, legacy_alert_id,
       v2_alert_id, previous_source_snapshot, correction_status)
    values (new.owned_product_id, new.recall_notice_id, new.id, v_legacy,
      v_v2, v_source, new.status::text)
    on conflict (evaluation_id) do nothing;
  end if;
  return new;
end; $$;
create trigger evaluations_record_correction_v2
after insert on private.recall_match_evaluations_v2
for each row execute function private.record_recall_correction_v2();

-- Reconfirmation after a revoked, undelivered eligibility must be possible.
alter function public.finalize_recall_match_evaluation_v2(
  uuid,uuid,text,timestamptz,timestamptz,uuid,public.recall_match_status,numeric,jsonb,text
) rename to finalize_recall_match_evaluation_v2_phase163;
create function public.finalize_recall_match_evaluation_v2(
  p_owned_product_id uuid, p_recall_notice_id uuid, p_evidence_fingerprint text,
  p_expected_product_updated_at timestamptz, p_expected_recall_updated_at timestamptz,
  p_lease_token uuid, p_status public.recall_match_status, p_confidence numeric,
  p_matched_identifiers jsonb, p_reasoning_summary text
)
returns table (status text, evaluation_id uuid, alert_eligibility text)
language plpgsql security definer set search_path = '' as $$
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
end; $$;
revoke all on function public.finalize_recall_match_evaluation_v2_phase163(
  uuid,uuid,text,timestamptz,timestamptz,uuid,public.recall_match_status,numeric,jsonb,text
) from public, anon, authenticated, service_role;
revoke all on function public.finalize_recall_match_evaluation_v2(
  uuid,uuid,text,timestamptz,timestamptz,uuid,public.recall_match_status,numeric,jsonb,text
) from public, anon, authenticated;
grant execute on function public.finalize_recall_match_evaluation_v2(
  uuid,uuid,text,timestamptz,timestamptz,uuid,public.recall_match_status,numeric,jsonb,text
) to service_role;

create function public.create_recall_v2_alert(p_owned_product_id uuid, p_recall_notice_id uuid)
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
revoke all on function public.create_recall_v2_alert(uuid,uuid) from public, anon, authenticated;
grant execute on function public.create_recall_v2_alert(uuid,uuid) to service_role;

create function public.update_recall_v2_alert_state(
  p_alert_id uuid, p_state public.alert_status
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or p_state is null then return false; end if;
  update private.recall_alert_snapshots_v2 a
  set state = p_state,
    read_at = case when p_state = 'unread' then null
      else coalesce(a.read_at, now()) end,
    dismissed_at = case when p_state = 'dismissed' then now() else null end
  where a.id = p_alert_id and a.user_id = (select auth.uid());
  return found;
end; $$;
revoke all on function public.update_recall_v2_alert_state(uuid,public.alert_status)
  from public, anon;
grant execute on function public.update_recall_v2_alert_state(uuid,public.alert_status)
  to authenticated;

-- Authenticated projection returns only display fields and latest status. No leases,
-- fingerprints, provider metadata, private errors or administrative columns.
create function public.get_recall_safety_feed_v2()
returns table (
  owned_product_id uuid, recall_notice_id uuid, product_name text,
  decision text, display_state text, evaluated_at timestamptz,
  alert_id uuid, alert_created_at timestamptz, alert_state text,
  previous_alert_id uuid, previous_alert_state text, previous_match_status text,
  authority text, title text, official_url text, recall_date date,
  hazard text, remedy text
)
language sql stable security definer set search_path = '' as $$
  with latest as (
    select distinct on (e.owned_product_id,e.recall_notice_id) e.*
    from private.recall_match_evaluations_v2 e
    join public.owned_products p on p.id = e.owned_product_id
    where p.user_id = (select auth.uid())
    order by e.owned_product_id,e.recall_notice_id,e.observation_seq desc
  )
  select e.owned_product_id,e.recall_notice_id,p.product_name,e.status::text,
    case when (a.id is not null or old.id is not null) and e.status <> 'confirmed'
      then 'no_longer_confirmed'
      when a.id is not null or old.id is not null then 'confirmed_alert'
      when e.status = 'confirmed' then 'confirmed_pending_alert'
      else e.status::text end,
    e.evaluated_at,a.id,a.created_at,a.state::text,old.id,old.status::text,m.status::text,
    coalesce(a.source_snapshot->>'authority',h.source_snapshot->>'authority',s.name),
    coalesce(a.source_snapshot->>'title',h.source_snapshot->>'title',n.title),
    coalesce(a.source_snapshot->>'official_url',h.source_snapshot->>'official_url',n.official_url),
    coalesce((a.source_snapshot->>'recall_date')::date,
      (h.source_snapshot->>'recall_date')::date,n.recall_date),
    coalesce(a.source_snapshot->>'hazard',h.source_snapshot->>'hazard',n.hazard),
    coalesce(a.source_snapshot->>'remedy',h.source_snapshot->>'remedy',n.remedy)
  from latest e join public.owned_products p on p.id = e.owned_product_id
  join public.recall_notices n on n.id = e.recall_notice_id
  join public.recall_sources s on s.id = n.source_id and s.is_authoritative
  left join private.recall_alert_snapshots_v2 a
    on a.owned_product_id = e.owned_product_id and a.recall_notice_id = e.recall_notice_id
  left join public.recall_matches m
    on m.owned_product_id = e.owned_product_id and m.recall_notice_id = e.recall_notice_id
  left join public.alerts old on old.recall_match_id = m.id and old.user_id = (select auth.uid())
  left join private.recall_legacy_alert_snapshots_v2 h on h.alert_id = old.id
  where p.user_id = (select auth.uid());
$$;
revoke all on function public.get_recall_safety_feed_v2() from public, anon;
grant execute on function public.get_recall_safety_feed_v2() to authenticated;

commit;
