-- Phase 16.29 is a local candidate. Do not apply in production, deploy, or
-- schedule page evidence. Canonical API identity semantics are unchanged:
-- `identity_status = 'reconciled'` still gates API observations and notices.
-- This migration adds a separate, fail-closed UNATTENDED PAGE eligibility rule.
begin;

-- ===========================================================================
-- Durable page-identity holds. A hold only tightens eligibility; it is never
-- a human decision. Holds come from a hash-bound executed backfill manifest or
-- from a worker identity_redirect outcome, never from caller-supplied text.
-- ===========================================================================
create table private.cpsc_page_identity_holds (
  id uuid primary key default gen_random_uuid(),
  hold_seq bigint generated always as identity unique,
  identity_id uuid references private.cpsc_source_identities(id) on delete restrict,
  official_recall_number text not null check (official_recall_number ~ '^[0-9]{5}$'),
  hold_class text not null check (hold_class in
    ('backfill_manifest_unresolved_identity', 'worker_identity_redirect')),
  origin_manifest_sha256 text check (origin_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  -- Validated on insert, not a foreign key: attempts keep their 16.24
  -- truncate semantics. Holds are append-only, so the binding cannot drift.
  origin_attempt_id uuid,
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'
    and octet_length(evidence::text) <= 65536),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  check ((hold_class = 'backfill_manifest_unresolved_identity')
    = (origin_manifest_sha256 is not null and origin_attempt_id is null)),
  check ((hold_class = 'worker_identity_redirect')
    = (origin_attempt_id is not null and origin_manifest_sha256 is null
      and identity_id is not null))
);
create unique index cpsc_page_identity_holds_manifest_idx
  on private.cpsc_page_identity_holds(official_recall_number, origin_manifest_sha256)
  where origin_manifest_sha256 is not null;
create unique index cpsc_page_identity_holds_attempt_idx
  on private.cpsc_page_identity_holds(origin_attempt_id)
  where origin_attempt_id is not null;
create index cpsc_page_identity_holds_identity_idx
  on private.cpsc_page_identity_holds(identity_id);
create index cpsc_page_identity_holds_number_idx
  on private.cpsc_page_identity_holds(official_recall_number);
alter table private.cpsc_page_identity_holds enable row level security;

-- Only an authorized human (the 16.12 identity_reconciliation capability)
-- can clear a hold. The guard trigger rejects any insert that is not made by
-- that authenticated human, including owner inserts with a free-text marker.
create table private.cpsc_page_identity_hold_resolutions (
  id uuid primary key default gen_random_uuid(),
  resolution_seq bigint generated always as identity unique,
  hold_id uuid not null references private.cpsc_page_identity_holds(id) on delete restrict,
  decision text not null check (decision in ('clear_page_hold', 'keep_page_hold')),
  reviewer_user_id uuid not null references auth.users(id) on delete restrict,
  rationale text not null check (btrim(rationale) <> '' and length(rationale) <= 2000),
  evidence_snapshot jsonb not null check (jsonb_typeof(evidence_snapshot) = 'object'),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  decided_at timestamptz not null default now()
);
create unique index cpsc_page_identity_hold_resolutions_clear_idx
  on private.cpsc_page_identity_hold_resolutions(hold_id)
  where decision = 'clear_page_hold';
alter table private.cpsc_page_identity_hold_resolutions enable row level security;

-- One row per executed backfill manifest whose page-identity dispositions have
-- been imported. Until then, identities it created are not page-eligible.
create table private.cpsc_backfill_page_hold_imports (
  manifest_sha256 text primary key check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  unresolved_count integer not null check (unresolved_count >= 0),
  holds_created integer not null check (holds_created >= 0),
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  imported_at timestamptz not null default now()
);
alter table private.cpsc_backfill_page_hold_imports enable row level security;

create trigger cpsc_page_identity_holds_append_only
  before update or delete on private.cpsc_page_identity_holds
  for each row execute function private.cpsc_append_only();
create trigger cpsc_page_identity_holds_no_truncate
  before truncate on private.cpsc_page_identity_holds
  for each statement execute function private.cpsc_append_only();
create trigger cpsc_page_hold_resolutions_append_only
  before update or delete on private.cpsc_page_identity_hold_resolutions
  for each row execute function private.cpsc_append_only();
create trigger cpsc_page_hold_resolutions_no_truncate
  before truncate on private.cpsc_page_identity_hold_resolutions
  for each statement execute function private.cpsc_append_only();
create trigger cpsc_backfill_page_hold_imports_append_only
  before update or delete on private.cpsc_backfill_page_hold_imports
  for each row execute function private.cpsc_append_only();
create trigger cpsc_backfill_page_hold_imports_no_truncate
  before truncate on private.cpsc_backfill_page_hold_imports
  for each statement execute function private.cpsc_append_only();

create function private.cpsc_prepare_page_identity_hold()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.identity_id is not null and not exists (
    select 1 from private.cpsc_source_identities i
    where i.id = new.identity_id
      and i.official_recall_number = new.official_recall_number) then
    raise exception 'CPSC page hold does not match its identity';
  end if;
  if new.origin_attempt_id is not null and not exists (
    select 1 from private.cpsc_page_attempts a
    where a.id = new.origin_attempt_id and a.identity_id = new.identity_id
      and a.outcome = 'identity_redirect') then
    raise exception 'CPSC page hold does not match its identity redirect attempt';
  end if;
  new.evidence_sha256 := private.cpsc_canonical_json_sha256(new.evidence);
  new.created_at := now();
  return new;
end;
$$;
create trigger cpsc_prepare_page_identity_hold
  before insert on private.cpsc_page_identity_holds
  for each row execute function private.cpsc_prepare_page_identity_hold();

create function private.cpsc_guard_page_hold_resolution()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not private.cpsc_has_capability('identity_reconciliation')
    or auth.uid() is distinct from new.reviewer_user_id then
    raise exception 'CPSC identity reconciliation authorization required' using errcode = '42501';
  end if;
  new.evidence_sha256 := private.cpsc_canonical_json_sha256(new.evidence_snapshot);
  new.decided_at := now();
  return new;
end;
$$;
create trigger cpsc_guard_page_hold_resolution
  before insert on private.cpsc_page_identity_hold_resolutions
  for each row execute function private.cpsc_guard_page_hold_resolution();

-- A human identity decision counts only if its reviewer held the separate
-- identity_reconciliation capability when deciding. A free-text reviewer id,
-- provenance string, or backfill marker never qualifies.
create function private.cpsc_identity_decision_authorized(p_reviewer uuid, p_at timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_reviewer is not null and p_at is not null and exists (
    select 1 from private.cpsc_admin_capabilities c
    where c.user_id = p_reviewer and c.capability = 'identity_reconciliation'
      and c.authorized_at <= p_at
      and (c.revoked_at is null or c.revoked_at > p_at)), false);
$$;

-- ===========================================================================
-- The general page-eligibility rule. An empty array means eligible. The array
-- order is stable, so the first element is the primary reason.
-- ===========================================================================
create function private.cpsc_page_identity_blockers(p_identity_id uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  select case when i.id is null then array['identity_missing']::text[] else array_remove(array[
    case when i.identity_status <> 'reconciled' or i.canonical_notice_id is null
      then 'identity_unresolved' end,
    case when private.cpsc_canonical_url(i.canonical_url) is distinct from i.canonical_url
      then 'canonical_url_invalid' end,
    -- The canonical notice must be linked and carry the same number and URL.
    case when not exists (
        select 1 from public.recall_notices n
        join private.cpsc_notice_identity_links l
          on l.notice_id = n.id and l.identity_id = i.id
        where n.id = i.canonical_notice_id and n.source_id = i.source_id
          and private.cpsc_payload_recall_number(n.raw_payload) = i.official_recall_number
          and private.cpsc_canonical_url(n.official_url) = i.canonical_url)
      then 'canonical_notice_inconsistent' end,
    case when exists (
        select 1 from private.cpsc_identity_observations o
        where o.resolution = 'quarantined'
          and (o.identity_id = i.id or o.official_recall_number = i.official_recall_number
            or o.canonical_url = i.canonical_url)
          and not exists (
            select 1 from private.cpsc_identity_reconciliations r
            where r.observation_id = o.id
              and r.decision in ('confirm_alias', 'confirm_new_identity', 'reject_observation')
              and private.cpsc_identity_decision_authorized(r.reviewer_user_id, r.decided_at)))
      then 'unresolved_quarantine' end,
    -- Every URL in the identity's lineage must canonicalize to its page URL,
    -- unless an authorized human confirmed that exact URL as an alias.
    case when exists (
        select 1 from private.cpsc_notice_identity_links l
        join public.recall_notices n on n.id = l.notice_id
        where l.identity_id = i.id
          and private.cpsc_canonical_url(n.official_url) is distinct from i.canonical_url)
      or exists (
        select 1 from private.cpsc_source_aliases a
        where a.identity_id = i.id and a.alias_kind = 'official_url'
          and private.cpsc_canonical_url(a.alias_value) is distinct from i.canonical_url
          and not exists (select 1 from private.cpsc_identity_reconciliations r
            where r.id = a.reconciliation_id
              and private.cpsc_identity_decision_authorized(r.reviewer_user_id, r.decided_at)))
      or exists (
        select 1 from private.cpsc_identity_observations o
        where (o.identity_id = i.id or o.official_recall_number = i.official_recall_number)
          and o.canonical_url is distinct from i.canonical_url
          and not exists (select 1 from private.cpsc_identity_reconciliations r
            where r.observation_id = o.id and r.decision = 'reject_observation'
              and private.cpsc_identity_decision_authorized(r.reviewer_user_id, r.decided_at))
          and not exists (select 1 from private.cpsc_source_aliases a
            join private.cpsc_identity_reconciliations r on r.id = a.reconciliation_id
            where a.identity_id = i.id and a.alias_kind = 'official_url'
              and private.cpsc_canonical_url(a.alias_value) = o.canonical_url
              and private.cpsc_identity_decision_authorized(r.reviewer_user_id, r.decided_at)))
      or exists (
        select 1 from private.cpsc_source_aliases a
        where a.identity_id <> i.id and a.alias_kind = 'official_url'
          and private.cpsc_canonical_url(a.alias_value) = i.canonical_url)
      then 'url_lineage_conflict' end,
    -- A backfill-created `reconciled` status is not page provenance until the
    -- executed manifest's page-identity dispositions have been imported.
    case when exists (
        select 1 from private.cpsc_backfill_items b
        join private.cpsc_backfill_runs r on r.id = b.run_id
        where b.retracted_at is null and r.retracted_at is null
          and (b.target_id = i.id or b.detail->>'recallNumber' = i.official_recall_number)
          and not exists (select 1 from private.cpsc_backfill_page_hold_imports h
            where h.manifest_sha256 = r.manifest_sha256))
      then 'backfill_page_provenance_unverified' end,
    case when exists (
        select 1 from private.cpsc_page_identity_holds h
        where (h.identity_id = i.id or h.official_recall_number = i.official_recall_number)
          and not exists (select 1 from private.cpsc_page_identity_hold_resolutions x
            where x.hold_id = h.id and x.decision = 'clear_page_hold'
              and private.cpsc_identity_decision_authorized(x.reviewer_user_id, x.decided_at)))
      then 'human_reconciliation_required' end,
    case when exists (select 1 from private.cpsc_page_work_state w
        where w.identity_id = i.id and w.manual_review_required)
      then 'manual_review_required' end
  ]::text[], null) end
  from (select 1) one
  left join private.cpsc_source_identities i on i.id = p_identity_id;
$$;

create function private.cpsc_page_identity_eligible(p_identity_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(cardinality(private.cpsc_page_identity_blockers(p_identity_id)) = 0, false);
$$;

-- Owner/audit read model. No API role can select it.
create view private.cpsc_page_identity_eligibility
with (security_invoker = true) as
select i.id as identity_id, i.official_recall_number, i.canonical_url,
  i.identity_status, blockers.value as blockers,
  coalesce(blockers.value[1], 'eligible') as page_eligibility
from private.cpsc_source_identities i
cross join lateral (select private.cpsc_page_identity_blockers(i.id) as value) blockers;

-- Human evidence packet. Raw page bytes are never included.
create function private.cpsc_page_identity_evidence(p_identity_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'identity', to_jsonb(i),
    'pageEligibility', private.cpsc_page_identity_blockers(i.id),
    'canonicalNotice', (select jsonb_build_object('noticeId', n.id,
        'externalId', n.external_id, 'title', n.title, 'officialUrl', n.official_url,
        'recallDate', n.recall_date,
        'payloadRecallNumber', private.cpsc_payload_recall_number(n.raw_payload))
      from public.recall_notices n where n.id = i.canonical_notice_id),
    'linkedNotices', coalesce((select jsonb_agg(jsonb_build_object('noticeId', n.id,
        'externalId', n.external_id, 'officialUrl', n.official_url,
        'provenance', l.provenance) order by n.external_id)
      from private.cpsc_notice_identity_links l
      join public.recall_notices n on n.id = l.notice_id
      where l.identity_id = i.id), '[]'::jsonb),
    'aliases', coalesce((select jsonb_agg(jsonb_build_object('aliasKind', a.alias_kind,
        'aliasValue', a.alias_value, 'provenance', a.provenance,
        'reconciliationId', a.reconciliation_id) order by a.alias_kind, a.alias_value, a.provenance)
      from private.cpsc_source_aliases a where a.identity_id = i.id), '[]'::jsonb),
    'observations', coalesce((select jsonb_agg(jsonb_build_object('observationId', o.id,
        'apiId', o.upstream_api_id, 'observedUrl', o.observed_url,
        'canonicalUrl', o.canonical_url, 'resolution', o.resolution,
        'decisionClass', o.decision_class, 'revisionFlags', o.revision_flags,
        'provenance', o.provenance, 'observedAt', o.observed_at) order by o.observation_seq)
      from private.cpsc_identity_observations o
      where o.identity_id = i.id or o.official_recall_number = i.official_recall_number), '[]'::jsonb),
    'reconciliations', coalesce((select jsonb_agg(jsonb_build_object('reconciliationId', r.id,
        'observationId', r.observation_id, 'decision', r.decision,
        'reviewerUserId', r.reviewer_user_id, 'decidedAt', r.decided_at,
        'authorized', private.cpsc_identity_decision_authorized(r.reviewer_user_id, r.decided_at))
        order by r.decision_seq)
      from private.cpsc_identity_reconciliations r
      join private.cpsc_identity_observations o on o.id = r.observation_id
      where o.identity_id = i.id or o.official_recall_number = i.official_recall_number), '[]'::jsonb),
    'holds', coalesce((select jsonb_agg(jsonb_build_object('holdId', h.id,
        'holdClass', h.hold_class, 'evidence', h.evidence, 'evidenceSha256', h.evidence_sha256,
        'originManifestSha256', h.origin_manifest_sha256, 'originAttemptId', h.origin_attempt_id,
        'createdAt', h.created_at,
        'resolutions', coalesce((select jsonb_agg(jsonb_build_object('decision', x.decision,
            'reviewerUserId', x.reviewer_user_id, 'rationale', x.rationale,
            'decidedAt', x.decided_at) order by x.resolution_seq)
          from private.cpsc_page_identity_hold_resolutions x where x.hold_id = h.id), '[]'::jsonb))
        order by h.hold_seq)
      from private.cpsc_page_identity_holds h
      where h.identity_id = i.id or h.official_recall_number = i.official_recall_number), '[]'::jsonb),
    'pageFetches', coalesce((select jsonb_agg(jsonb_build_object('fetchId', f.id,
        'fetchedAt', f.fetched_at, 'httpStatus', f.http_status, 'finalUrl', f.final_url,
        'redirectChain', f.redirect_chain, 'rawPageHash', f.raw_page_hash) order by f.fetched_at)
      from private.cpsc_page_fetches f where f.identity_id = i.id), '[]'::jsonb),
    'pageAttempts', coalesce((select jsonb_agg(jsonb_build_object('attemptId', a.id,
        'claimedAt', a.claimed_at, 'outcome', a.outcome, 'errorCode', a.error_code,
        'httpStatus', a.http_status, 'finalUrl', a.final_url,
        'redirectChain', a.transport_redirect_chain, 'rawPageHash', a.raw_page_hash)
        order by a.claimed_at)
      from private.cpsc_page_attempts a where a.identity_id = i.id), '[]'::jsonb),
    'backfillProvenance', coalesce((select jsonb_agg(jsonb_build_object('itemKey', b.item_key,
        'stage', b.stage, 'runSeq', r.run_seq, 'manifestSha256', r.manifest_sha256,
        'manifestImported', exists (select 1 from private.cpsc_backfill_page_hold_imports h
          where h.manifest_sha256 = r.manifest_sha256)) order by b.item_key)
      from private.cpsc_backfill_items b join private.cpsc_backfill_runs r on r.id = b.run_id
      where b.retracted_at is null
        and (b.target_id = i.id or b.detail->>'recallNumber' = i.official_recall_number)), '[]'::jsonb))
  from private.cpsc_source_identities i where i.id = p_identity_id;
$$;

-- ===========================================================================
-- Hold sources.
-- ===========================================================================
-- Owner-only. The manifest must hash to an executed, unretracted backfill run,
-- so the dispositions are the reviewed ones that produced production state.
create function private.cpsc_import_backfill_page_holds(p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text;
  v_items jsonb;
  v_item jsonb;
  v_identity private.cpsc_source_identities%rowtype;
  v_runs jsonb;
  v_created integer := 0;
  v_without_identity jsonb := '[]'::jsonb;
  v_held jsonb := '[]'::jsonb;
  v_report jsonb;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated', 'service_role')
    or session_user = 'cpsc_page_worker'
    or coalesce(current_setting('role', true), '') = 'cpsc_page_worker' then
    raise exception 'CPSC backfill hold import is an owner-only administrative action'
      using errcode = '42501';
  end if;
  perform private.cpsc_validate_backfill_manifest(p_manifest);
  v_hash := private.cpsc_canonical_json_sha256(p_manifest);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:identity-decisions'));
  select jsonb_agg(r.run_seq order by r.run_seq) into v_runs
    from private.cpsc_backfill_runs r
    where r.manifest_sha256 = v_hash and r.finished_at is not null and r.retracted_at is null;
  if v_runs is null then
    raise exception 'Manifest does not match an executed CPSC backfill run';
  end if;
  if exists (select 1 from private.cpsc_backfill_page_hold_imports
    where manifest_sha256 = v_hash) then
    raise exception 'Backfill manifest page holds were already imported';
  end if;
  v_items := coalesce(p_manifest->'unresolvedIdentities', '[]'::jsonb);
  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) > 1000
    or exists (select 1 from jsonb_array_elements(v_items) item
      where jsonb_typeof(item) is distinct from 'object'
        or coalesce(item->>'recallNumber', '') !~ '^[0-9]{5}$'
        or nullif(btrim(item->>'requiredAction'), '') is null
        or length(item->>'requiredAction') > 2000
        or octet_length(item::text) > 32768) then
    raise exception 'Invalid backfill manifest unresolved identities';
  end if;
  for v_item in select value from jsonb_array_elements(v_items) order by value->>'recallNumber'
  loop
    v_identity := null;
    select i.* into v_identity from private.cpsc_source_identities i
      join public.recall_sources s on s.id = i.source_id
      where s.source_key = 'cpsc' and s.is_authoritative
        and i.official_recall_number = v_item->>'recallNumber'
      for update of i;
    insert into private.cpsc_page_identity_holds (identity_id, official_recall_number,
      hold_class, origin_manifest_sha256, evidence, evidence_sha256)
    values (v_identity.id, v_item->>'recallNumber', 'backfill_manifest_unresolved_identity',
      v_hash, jsonb_build_object('manifestSha256', v_hash, 'backfillRunSeqs', v_runs,
        'manifestEntry', v_item), repeat('0', 64))
    on conflict (official_recall_number, origin_manifest_sha256)
      where origin_manifest_sha256 is not null do nothing;
    if found then v_created := v_created + 1; end if;
    if v_identity.id is null then
      v_without_identity := v_without_identity || to_jsonb(v_item->>'recallNumber');
    else
      v_held := v_held || to_jsonb(v_item->>'recallNumber');
    end if;
  end loop;
  v_report := jsonb_build_object('manifestSha256', v_hash, 'backfillRunSeqs', v_runs,
    'heldRecallNumbers', v_held, 'withoutIdentity', v_without_identity);
  insert into private.cpsc_backfill_page_hold_imports (manifest_sha256, unresolved_count,
    holds_created, report)
  values (v_hash, jsonb_array_length(v_items), v_created, v_report);
  return v_report || jsonb_build_object('unresolvedCount', jsonb_array_length(v_items),
    'holdsCreated', v_created);
end;
$$;

-- An identity-changing redirect, final-URL mismatch, recall-number mismatch,
-- or canonical-link contradiction needs a human decision before any retry.
create function private.cpsc_hold_page_identity_redirect()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into private.cpsc_page_identity_holds (identity_id, official_recall_number,
    hold_class, origin_attempt_id, evidence, evidence_sha256)
  select i.id, i.official_recall_number, 'worker_identity_redirect', new.id,
    jsonb_build_object('attemptId', new.id, 'errorCode', new.error_code,
      'httpStatus', new.http_status, 'finalUrl', new.final_url,
      'canonicalUrl', i.canonical_url, 'rawPageHash', new.raw_page_hash,
      'redirectChain', new.transport_redirect_chain, 'completedAt', new.completed_at),
    repeat('0', 64)
  from private.cpsc_source_identities i where i.id = new.identity_id
  on conflict (origin_attempt_id) where origin_attempt_id is not null do nothing;
  return null;
end;
$$;
create trigger cpsc_hold_page_identity_redirect
  after update of outcome on private.cpsc_page_attempts
  for each row when (old.outcome = 'claimed' and new.outcome = 'identity_redirect')
  execute function private.cpsc_hold_page_identity_redirect();

-- ===========================================================================
-- Authorized human path. Neither RPC changes identities, aliases,
-- observations, notices, work state, or schedules.
-- ===========================================================================
create function public.get_cpsc_page_identity_hold_packet(p_hold_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_hold private.cpsc_page_identity_holds%rowtype;
begin
  if not private.cpsc_has_capability('identity_reconciliation') then
    raise exception 'CPSC identity reconciliation authorization required' using errcode = '42501';
  end if;
  select * into v_hold from private.cpsc_page_identity_holds where id = p_hold_id;
  if v_hold.id is null then raise exception 'CPSC page hold does not exist'; end if;
  return jsonb_build_object('holdId', v_hold.id, 'holdClass', v_hold.hold_class,
    'officialRecallNumber', v_hold.official_recall_number,
    'holdEvidence', v_hold.evidence, 'holdEvidenceSha256', v_hold.evidence_sha256,
    'identityEvidence', private.cpsc_page_identity_evidence(v_hold.identity_id));
end;
$$;

create function public.resolve_cpsc_page_identity_hold(
  p_hold_id uuid, p_decision text, p_rationale text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hold private.cpsc_page_identity_holds%rowtype;
  v_snapshot jsonb;
  v_resolution_id uuid;
begin
  if not private.cpsc_has_capability('identity_reconciliation') then
    raise exception 'CPSC identity reconciliation authorization required' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('clear_page_hold', 'keep_page_hold') then
    raise exception 'Invalid page hold decision';
  end if;
  if nullif(btrim(p_rationale), '') is null or length(p_rationale) > 2000 then
    raise exception 'Page hold rationale is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:identity-decisions'));
  select * into v_hold from private.cpsc_page_identity_holds where id = p_hold_id;
  if v_hold.id is null then raise exception 'CPSC page hold does not exist'; end if;
  -- Serializes with an in-flight claim of the same identity.
  perform 1 from private.cpsc_source_identities where id = v_hold.identity_id for update;
  if exists (select 1 from private.cpsc_page_identity_hold_resolutions
    where hold_id = p_hold_id and decision = 'clear_page_hold') then
    raise exception 'CPSC page hold is already cleared';
  end if;
  v_snapshot := jsonb_build_object('hold', to_jsonb(v_hold),
    'identityEvidence', private.cpsc_page_identity_evidence(v_hold.identity_id));
  insert into private.cpsc_page_identity_hold_resolutions (hold_id, decision,
    reviewer_user_id, rationale, evidence_snapshot, evidence_sha256)
  values (p_hold_id, p_decision, auth.uid(), p_rationale, v_snapshot, repeat('0', 64))
  returning id into v_resolution_id;
  return jsonb_build_object('resolutionId', v_resolution_id, 'holdId', p_hold_id,
    'decision', p_decision,
    'pageEligibility', private.cpsc_page_identity_blockers(v_hold.identity_id));
end;
$$;

-- ===========================================================================
-- Claim and semantic commit consume the rule. Ordering is unchanged.
-- ===========================================================================
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
      and private.cpsc_page_identity_eligible(i.id)
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

-- A hold or quarantine recorded while a claim is in flight still blocks the
-- semantic binding.
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
  if not private.cpsc_page_identity_eligible(v_attempt.identity_id) then
    raise exception 'CPSC page identity is not eligible for unattended evidence';
  end if;
  return public.commit_cpsc_page_evidence(
    p_claim_id, p_snapshot, p_revision, p_candidates, p_ledger);
end;
$$;

-- ===========================================================================
-- Privilege boundary. The worker gains nothing: it cannot read or write holds,
-- resolutions, imports, or the eligibility functions directly.
-- ===========================================================================
revoke all on private.cpsc_page_identity_holds, private.cpsc_page_identity_hold_resolutions,
  private.cpsc_backfill_page_hold_imports, private.cpsc_page_identity_eligibility
  from public, anon, authenticated, service_role, cpsc_page_worker;
revoke all on function
  private.cpsc_prepare_page_identity_hold(),
  private.cpsc_guard_page_hold_resolution(),
  private.cpsc_identity_decision_authorized(uuid, timestamptz),
  private.cpsc_page_identity_blockers(uuid),
  private.cpsc_page_identity_eligible(uuid),
  private.cpsc_page_identity_evidence(uuid),
  private.cpsc_import_backfill_page_holds(jsonb),
  private.cpsc_hold_page_identity_redirect(),
  public.get_cpsc_page_identity_hold_packet(uuid),
  public.resolve_cpsc_page_identity_hold(uuid, text, text)
  from public, anon, authenticated, service_role, cpsc_page_worker;
grant execute on function
  public.get_cpsc_page_identity_hold_packet(uuid),
  public.resolve_cpsc_page_identity_hold(uuid, text, text)
  to authenticated;
-- The replaced claim and commit keep their 16.24 grants (worker only); restate.
revoke all on function public.claim_cpsc_page_evidence(integer),
  public.commit_cpsc_page_evidence_verified(uuid, jsonb, jsonb, jsonb, jsonb, bytea)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_cpsc_page_evidence(integer),
  public.commit_cpsc_page_evidence_verified(uuid, jsonb, jsonb, jsonb, jsonb, bytea)
  to cpsc_page_worker;

commit;
