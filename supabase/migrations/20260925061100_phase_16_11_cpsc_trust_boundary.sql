-- Prepared locally only. Apply strictly after 16.9 (20260924060002) and 16.10
-- (20260924065448); both drafts stay byte-for-byte unchanged. Nothing here
-- activates deterministic_v2, a cohort, consumer reads, or push.
begin;

-- ===========================================================================
-- Role predicates. Neither can return NULL, so `if not ...` never skips a check.
-- ===========================================================================
create function private.cpsc_is_worker()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(auth.role() = 'service_role', false)
    or coalesce(current_setting('role', true) = 'service_role', false);
$$;

create function private.cpsc_canonical_url(p_url text)
returns text language sql immutable set search_path = '' as $$
  select case when p_url ~ '^https://(www\.)?cpsc\.gov/Recalls/' then
    regexp_replace(regexp_replace(split_part(split_part(p_url, '#', 1), '?', 1),
      '^https://cpsc\.gov/', 'https://www.cpsc.gov/'), '/+$', '')
  end;
$$;

create function private.cpsc_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;

-- ===========================================================================
-- Page revision currency. `current_since` lets a reverted page (A -> B -> A)
-- become current again without rewriting when A was first seen.
-- ===========================================================================
alter table private.cpsc_page_revisions add column current_since timestamptz;
update private.cpsc_page_revisions set current_since = first_seen_at;
create function private.cpsc_default_current_since()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.current_since := coalesce(new.current_since, new.first_seen_at);
  return new;
end;
$$;
create trigger cpsc_default_current_since
  before insert on private.cpsc_page_revisions
  for each row execute function private.cpsc_default_current_since();
alter table private.cpsc_page_revisions
  alter column current_since set not null,
  add constraint cpsc_page_revisions_current_since_check check (current_since >= first_seen_at);

-- Only observation timestamps may move; evidence and identity are immutable.
create function private.cpsc_guard_page_revision_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.identity_id, new.evidence_hash, new.recall_number, new.canonical_url, new.title,
      new.section_hashes, new.normalized_evidence, new.parser_version,
      new.table_identities, new.first_seen_at)
    is distinct from
     (old.identity_id, old.evidence_hash, old.recall_number, old.canonical_url, old.title,
      old.section_hashes, old.normalized_evidence, old.parser_version,
      old.table_identities, old.first_seen_at) then
    raise exception 'CPSC page revision evidence is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger cpsc_guard_page_revision_update
  before update on private.cpsc_page_revisions
  for each row execute function private.cpsc_guard_page_revision_update();

create function private.cpsc_revision_is_current(p_revision_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select not exists (
      select 1 from private.cpsc_page_revisions other
      where other.identity_id = revision.identity_id
        and other.id <> revision.id
        and other.current_since >= revision.current_since)
    from private.cpsc_page_revisions revision
    where revision.id = p_revision_id), false);
$$;

-- ===========================================================================
-- Review ledger ordering. Random UUIDs cannot order events that share a
-- transaction timestamp, so the latest event is defined by a monotonic sequence.
-- ===========================================================================
alter table private.cpsc_candidate_review_ledger
  add column event_seq bigint generated always as identity,
  add constraint cpsc_candidate_review_ledger_event_seq_key unique (event_seq);
create index cpsc_candidate_review_ledger_seq_idx
  on private.cpsc_candidate_review_ledger(candidate_id, event_seq desc);
create trigger cpsc_review_ledger_append_only
  before update or delete on private.cpsc_candidate_review_ledger
  for each row execute function private.cpsc_append_only();
create trigger cpsc_review_ledger_no_truncate
  before truncate on private.cpsc_candidate_review_ledger
  for each statement execute function private.cpsc_append_only();
create trigger cpsc_candidate_criteria_append_only
  before update or delete on private.cpsc_candidate_criteria
  for each row execute function private.cpsc_append_only();

-- A usable member needs: the latest event is a reviewed, attested decision by a
-- reviewer authorized at decision time, bound to the unchanged candidate on the
-- current source revision. A conjunction is usable only as a whole.
create or replace view private.cpsc_current_reviewed_criteria
with (security_invoker = true) as
with member as (
  select c.id as candidate_id, c.revision_id,
    coalesce(c.conjunction_key, c.id::text) as conjunction_group,
    l.id as review_event_id, l.reviewer_user_id, l.decided_at as reviewed_at,
    l.attested_scope_id, l.source_revision_hash, l.evidence_address,
    l.normalized_criterion, l.reviewed_operator, l.conjunction_key,
    coalesce(l.decision = 'reviewed'
      and l.mandatory_eligibility is true
      and btrim(l.attestation) <> ''
      and l.source_revision_hash = revision.evidence_hash
      and l.attested_scope_id = c.proposed_scope_id
      and l.normalized_criterion = c.criterion_value
      and l.reviewed_operator = c.proposed_operator
      and l.evidence_address = c.evidence_address
      and l.conjunction_key is not distinct from c.conjunction_key
      and c.criterion_kind in ('model_exact', 'model_set', 'date_code_exact', 'date_code_set')
      and c.interpretation = 'mandatory_candidate'
      and private.cpsc_revision_is_current(revision.id)
      and exists (
        select 1 from private.cpsc_reviewer_authorizations grant_row
        where grant_row.user_id = l.reviewer_user_id
          and grant_row.authorized_at <= l.decided_at
          and (grant_row.revoked_at is null or grant_row.revoked_at > l.decided_at)
      ), false) as usable
  from private.cpsc_candidate_criteria c
  join private.cpsc_page_revisions revision on revision.id = c.revision_id
  left join lateral (
    select event.* from private.cpsc_candidate_review_ledger event
    where event.candidate_id = c.id
    order by event.event_seq desc limit 1
  ) l on true
)
select m.candidate_id, m.revision_id, m.review_event_id, m.reviewer_user_id,
  m.reviewed_at, m.attested_scope_id, m.source_revision_hash,
  m.evidence_address, m.normalized_criterion, m.reviewed_operator,
  m.conjunction_key
from member m
where m.usable
  and not exists (
    select 1 from member sibling
    where sibling.revision_id = m.revision_id
      and sibling.conjunction_group = m.conjunction_group
      and (not sibling.usable
        or sibling.attested_scope_id is distinct from m.attested_scope_id)
  );
revoke all on private.cpsc_current_reviewed_criteria
  from public, anon, authenticated, service_role;

create or replace function private.cpsc_stale_review_on_semantic_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into private.cpsc_candidate_review_ledger (
    candidate_id, decision, reviewer_user_id, attested_scope_id,
    source_revision_hash, evidence_address, attestation,
    normalized_criterion, reviewed_operator, conjunction_key,
    mandatory_eligibility, review_note
  )
  select c.id, 'stale', null, l.attested_scope_id, new.evidence_hash,
    l.evidence_address, 'source semantic revision changed',
    l.normalized_criterion, l.reviewed_operator, l.conjunction_key,
    l.mandatory_eligibility, 'Conservative invalidation pending renewed human review'
  from private.cpsc_candidate_criteria c
  join private.cpsc_page_revisions prior_revision on prior_revision.id = c.revision_id
  join lateral (
    select decision, attested_scope_id, evidence_address,
      normalized_criterion, reviewed_operator, conjunction_key,
      mandatory_eligibility
    from private.cpsc_candidate_review_ledger l0
    where l0.candidate_id = c.id
    order by l0.event_seq desc limit 1
  ) l on true
  where prior_revision.identity_id = new.identity_id
    and prior_revision.id <> new.id
    and prior_revision.evidence_hash <> new.evidence_hash
    and l.decision = 'reviewed';
  return new;
end;
$$;
drop trigger cpsc_stale_review_after_revision on private.cpsc_page_revisions;
create trigger cpsc_stale_review_after_revision
  after insert or update of current_since on private.cpsc_page_revisions
  for each row execute function private.cpsc_stale_review_on_semantic_revision();

create or replace function public.decide_cpsc_candidate(
  p_candidate_id uuid,
  p_decision text,
  p_mandatory_eligibility boolean,
  p_review_note text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_candidate private.cpsc_candidate_criteria%rowtype;
  v_revision private.cpsc_page_revisions%rowtype;
  v_ledger_id uuid;
begin
  if not private.cpsc_is_human_reviewer() then
    raise exception 'CPSC human reviewer authorization required' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('reviewed', 'rejected') then
    raise exception 'Invalid human review decision';
  end if;
  if p_review_note is not null and length(p_review_note) > 2000 then
    raise exception 'Review note is too long';
  end if;
  select * into v_candidate from private.cpsc_candidate_criteria
    where id = p_candidate_id for update;
  if not found then raise exception 'Candidate does not exist'; end if;
  select * into v_revision from private.cpsc_page_revisions
    where id = v_candidate.revision_id;
  if v_candidate.criterion_kind not in
    ('model_exact', 'model_set', 'date_code_exact', 'date_code_set')
    or v_candidate.interpretation <> 'mandatory_candidate' then
    raise exception 'Candidate class is deferred or ambiguous';
  end if;
  if p_decision = 'reviewed' and p_mandatory_eligibility is distinct from true then
    raise exception 'Mandatory eligibility attestation required';
  end if;
  if p_decision = 'reviewed' and v_candidate.proposed_scope_id is null then
    raise exception 'Reviewed criterion requires an explicit scope association';
  end if;
  -- Equal currency timestamps are ambiguous, so both revisions count as stale.
  if not private.cpsc_revision_is_current(v_revision.id) then
    raise exception 'Candidate source revision is stale';
  end if;
  if p_decision = 'reviewed' and not exists (
    select 1 from public.recall_scopes scope
    join private.cpsc_notice_identity_links link on link.notice_id = scope.recall_notice_id
    where scope.id = v_candidate.proposed_scope_id
      and link.identity_id = v_revision.identity_id
  ) then
    raise exception 'Candidate scope does not belong to this canonical recall';
  end if;
  if exists (select 1 from private.cpsc_candidate_review_ledger
    where candidate_id = p_candidate_id) then
    raise exception 'Candidate already has a decision';
  end if;
  insert into private.cpsc_candidate_review_ledger (
    candidate_id, decision, reviewer_user_id, attested_scope_id,
    source_revision_hash, evidence_address, attestation,
    normalized_criterion, reviewed_operator, conjunction_key,
    mandatory_eligibility, review_note
  ) values (
    p_candidate_id, p_decision, auth.uid(), v_candidate.proposed_scope_id,
    v_revision.evidence_hash, v_candidate.evidence_address,
    case when p_decision = 'reviewed' then 'mandatory eligibility evidence'
      else 'human rejection' end,
    v_candidate.criterion_value, v_candidate.proposed_operator,
    v_candidate.conjunction_key, p_mandatory_eligibility, p_review_note
  ) returning id into v_ledger_id;
  return v_ledger_id;
end;
$$;

-- ===========================================================================
-- Human review ledger -> deterministic_v2 criterion. The builder is the single
-- definition of a matcher-consumable criterion; writes and reads both re-run it.
-- ===========================================================================
create function private.cpsc_scope_fingerprint(p_scope_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(jsonb_build_array(
    s.recall_notice_id, s.brand, s.product_name, s.gtin, s.model_number,
    s.lot_from, s.lot_to, s.serial_from, s.serial_to,
    s.manufactured_from, s.manufactured_to, s.additional_criteria)::text, 'UTF8')), 'hex')
  from public.recall_scopes s where s.id = p_scope_id;
$$;

create function private.cpsc_reviewed_conjunction_criteria(p_revision_id uuid, p_group text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_members integer;
  v_usable integer;
  v_models integer;
  v_scopes integer;
  v_bad_values integer;
  v_scope uuid;
  v_revision private.cpsc_page_revisions%rowtype;
  v_notice public.recall_notices%rowtype;
  v_result jsonb;
begin
  if p_revision_id is null or p_group is null then return null; end if;
  select count(*) into v_members from private.cpsc_candidate_criteria c
    where c.revision_id = p_revision_id and coalesce(c.conjunction_key, c.id::text) = p_group;
  select count(*), count(*) filter (where c.criterion_kind like 'model\_%'),
      count(distinct v.attested_scope_id),
      count(*) filter (where not (
        (c.proposed_operator = 'exact' and jsonb_typeof(c.criterion_value) = 'string')
        or (c.proposed_operator = 'in' and jsonb_typeof(c.criterion_value) = 'array'
          and jsonb_array_length(c.criterion_value) > 0)))
    into v_usable, v_models, v_scopes, v_bad_values
    from private.cpsc_current_reviewed_criteria v
    join private.cpsc_candidate_criteria c on c.id = v.candidate_id
    where v.revision_id = p_revision_id and coalesce(c.conjunction_key, c.id::text) = p_group;
  -- A conjunction without a product-model anchor (e.g. date code alone) would widen
  -- eligibility to unrelated products, so it is never matcher-consumable.
  if v_members = 0 or v_usable <> v_members or v_models = 0 or v_scopes <> 1
    or v_bad_values <> 0 then
    return null;
  end if;
  select v.attested_scope_id into v_scope from private.cpsc_current_reviewed_criteria v
    join private.cpsc_candidate_criteria c on c.id = v.candidate_id
    where v.revision_id = p_revision_id and coalesce(c.conjunction_key, c.id::text) = p_group
    limit 1;
  select * into v_revision from private.cpsc_page_revisions where id = p_revision_id;
  select n.* into v_notice from public.recall_scopes s
    join public.recall_notices n on n.id = s.recall_notice_id where s.id = v_scope;
  if v_notice.id is null
    or not exists (select 1 from private.cpsc_notice_identity_links link
      where link.notice_id = v_notice.id and link.identity_id = v_revision.identity_id)
    or private.cpsc_canonical_url(v_notice.official_url) is distinct from v_revision.canonical_url then
    return null;
  end if;
  select jsonb_build_object(
    'semantics', 'all_of',
    'review', jsonb_build_object(
      'origin', 'human_review_ledger',
      'revisionId', p_revision_id,
      'sourceRevisionHash', v_revision.evidence_hash,
      'conjunctionGroup', p_group,
      'scopeId', v_scope,
      'scopeFingerprint', private.cpsc_scope_fingerprint(v_scope),
      'candidateIds', jsonb_agg(v.candidate_id order by v.candidate_id),
      'reviewEventIds', jsonb_agg(v.review_event_id order by v.candidate_id),
      'reviewerIds', jsonb_agg(v.reviewer_user_id order by v.candidate_id),
      'reviewedAt', max(v.reviewed_at)),
    'criteria', jsonb_agg(
      jsonb_build_object(
        'id', 'cpsc-ledger-' || v.candidate_id::text,
        'kind', case when c.criterion_kind like 'model\_%' then 'model_number' else 'date_code' end,
        'operator', case when c.proposed_operator = 'exact' then 'equals' else 'one_of' end,
        'required', true,
        'provenance', jsonb_build_object(
          'authority', 'CPSC',
          'officialUrl', v_notice.official_url,
          'sourceField', 'cpsc-page:' || coalesce(c.evidence_address->>'tableIdentity', 'description')
            || '/' || coalesce(c.evidence_address->>'rowIdentity', '-')
            || '/' || coalesce(c.evidence_address->>'fieldIdentity', '-'),
          'normalizationRule', 'identifier_v2'))
      || case when c.proposed_operator = 'exact'
        then jsonb_build_object('value', c.criterion_value #>> '{}')
        else jsonb_build_object('values', c.criterion_value) end
      order by v.candidate_id))
  into v_result
  from private.cpsc_current_reviewed_criteria v
  join private.cpsc_candidate_criteria c on c.id = v.candidate_id
  where v.revision_id = p_revision_id and coalesce(c.conjunction_key, c.id::text) = p_group;
  return v_result;
end;
$$;

-- Provenance columns make the binding's origin explicit. Pre-16.11 rows keep the
-- legacy origin and are never served to the matcher again.
alter table private.recall_scope_criteria_v2
  add column origin text not null default 'legacy_phase_16_4'
    check (origin in ('legacy_phase_16_4', 'human_review_ledger')),
  add column revision_id uuid references private.cpsc_page_revisions(id) on delete restrict,
  add column conjunction_group text,
  add constraint recall_scope_criteria_v2_ledger_provenance check (
    origin <> 'human_review_ledger'
    or (revision_id is not null and conjunction_group is not null));

-- Even the table owner cannot fabricate a matcher criterion: a write must equal
-- the ledger-derived builder output for a current, fully reviewed conjunction.
create function private.cpsc_guard_reviewed_binding()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.origin is distinct from 'human_review_ledger'
    or new.criteria is distinct from
      private.cpsc_reviewed_conjunction_criteria(new.revision_id, new.conjunction_group)
    or (new.criteria #>> '{review,scopeId}') is distinct from new.scope_id::text
    or new.source_url is distinct from (
      select n.official_url from public.recall_scopes s
      join public.recall_notices n on n.id = s.recall_notice_id where s.id = new.scope_id) then
    raise exception 'Matcher criteria must originate from a current human review conjunction'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger cpsc_guard_reviewed_binding
  before insert or update on private.recall_scope_criteria_v2
  for each row execute function private.cpsc_guard_reviewed_binding();

-- Read path: a binding is served only while it still equals the ledger builder.
-- Staleness, rejection, revocation, scope edits, or URL edits all yield NULL.
create or replace function public.get_recall_v2_scopes(p_recall_notice_id uuid)
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
    case when binding.origin = 'human_review_ledger'
        and binding.source_url = notice.official_url
        and binding.criteria = private.cpsc_reviewed_conjunction_criteria(
          binding.revision_id, binding.conjunction_group)
      then binding.criteria else null end as reviewed_criteria
  from public.recall_scopes as scope
  join public.recall_notices as notice on notice.id = scope.recall_notice_id
  join public.recall_sources as source on source.id = notice.source_id
  left join private.recall_scope_criteria_v2 as binding on binding.scope_id = scope.id
  where scope.recall_notice_id = p_recall_notice_id
    and source.is_authoritative
  order by scope.id;
$$;

create function public.materialize_cpsc_reviewed_conjunction(p_candidate_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_candidate private.cpsc_candidate_criteria%rowtype;
  v_group text;
  v_criteria jsonb;
  v_scope uuid;
  v_existing private.recall_scope_criteria_v2%rowtype;
  v_notice public.recall_notices%rowtype;
  v_status text;
begin
  if not private.cpsc_is_human_reviewer() then
    raise exception 'CPSC human reviewer authorization required' using errcode = '42501';
  end if;
  select * into v_candidate from private.cpsc_candidate_criteria where id = p_candidate_id;
  if not found then raise exception 'Candidate does not exist'; end if;
  v_group := coalesce(v_candidate.conjunction_key, v_candidate.id::text);
  v_criteria := private.cpsc_reviewed_conjunction_criteria(v_candidate.revision_id, v_group);
  if v_criteria is null then
    raise exception 'Conjunction is not fully human-reviewed, current, and model-anchored';
  end if;
  v_scope := (v_criteria #>> '{review,scopeId}')::uuid;
  select n.* into v_notice from public.recall_scopes s
    join public.recall_notices n on n.id = s.recall_notice_id where s.id = v_scope
    for update of n;
  select * into v_existing from private.recall_scope_criteria_v2 where scope_id = v_scope for update;
  if v_existing.scope_id is not null and v_existing.criteria = v_criteria then
    return jsonb_build_object('status', 'unchanged', 'scopeId', v_scope);
  end if;
  -- deterministic_v2 evaluates one all_of set per scope. A second current
  -- conjunction for the same scope is not expressible, so it fails closed.
  if v_existing.scope_id is not null and v_existing.origin = 'human_review_ledger'
    and v_existing.criteria = private.cpsc_reviewed_conjunction_criteria(
      v_existing.revision_id, v_existing.conjunction_group) then
    raise exception 'Scope already carries a different current reviewed conjunction';
  end if;
  if v_existing.scope_id is null then
    insert into private.recall_scope_criteria_v2 (
      scope_id, criteria, reviewed_at, source_url, origin, revision_id, conjunction_group
    ) values (
      v_scope, v_criteria, (v_criteria #>> '{review,reviewedAt}')::timestamptz,
      v_notice.official_url, 'human_review_ledger', v_candidate.revision_id, v_group
    );
    v_status := 'materialized';
  else
    update private.recall_scope_criteria_v2 set
      criteria = v_criteria,
      reviewed_at = (v_criteria #>> '{review,reviewedAt}')::timestamptz,
      source_url = v_notice.official_url, origin = 'human_review_ledger',
      revision_id = v_candidate.revision_id, conjunction_group = v_group
    where scope_id = v_scope;
    v_status := 'replaced';
  end if;
  -- The claim/finalize contract compares the notice revision; advancing it
  -- invalidates in-flight evaluations made under the previous binding.
  update public.recall_notices set updated_at = now() where id = v_notice.id;
  return jsonb_build_object('status', v_status, 'scopeId', v_scope);
end;
$$;

-- The Phase 16.4 free-text approval path is retired. Its signature remains so
-- already-applied history resolves, but it can no longer create any criterion.
create or replace function public.approve_cpsc_product_model_criterion_v2(
  p_scope_id uuid, p_product_index integer, p_reviewer_id text,
  p_eligibility_statement text, p_source_payload_sha256 text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Retired: CPSC criteria require the human review ledger'
    using errcode = '42501';
end;
$$;

-- ===========================================================================
-- Identity observations: decision matrix, new identities, reconciliation.
-- ===========================================================================
create table private.cpsc_identity_reconciliations (
  id uuid primary key default gen_random_uuid(),
  decision_seq bigint generated always as identity unique,
  observation_id uuid not null
    references private.cpsc_identity_observations(id) on delete restrict,
  decision text not null check (decision in
    ('confirm_alias', 'confirm_new_identity', 'reject_observation', 'leave_unresolved')),
  reviewer_user_id uuid not null references auth.users(id) on delete restrict,
  identity_id uuid references private.cpsc_source_identities(id) on delete restrict,
  rationale text not null check (btrim(rationale) <> '' and length(rationale) <= 2000),
  evidence_snapshot jsonb not null check (jsonb_typeof(evidence_snapshot) = 'object'),
  decided_at timestamptz not null default now(),
  check ((decision in ('confirm_alias', 'confirm_new_identity')) = (identity_id is not null))
);
create unique index cpsc_identity_reconciliations_terminal_idx
  on private.cpsc_identity_reconciliations(observation_id)
  where decision <> 'leave_unresolved';
alter table private.cpsc_identity_reconciliations enable row level security;
create trigger cpsc_reconciliations_append_only
  before update or delete on private.cpsc_identity_reconciliations
  for each row execute function private.cpsc_append_only();

alter table private.cpsc_source_aliases
  add column reconciliation_id uuid
    references private.cpsc_identity_reconciliations(id) on delete restrict;

alter table private.cpsc_identity_observations
  add column observation_seq bigint generated always as identity,
  add column decision_class text,
  add column revision_flags text[] not null default '{}';
create trigger cpsc_observations_append_only
  before update or delete on private.cpsc_identity_observations
  for each row execute function private.cpsc_append_only();

-- Identity-defining: source + official recall number.
-- Identity-corroborating: canonical URL (contradiction quarantines).
-- Revisional metadata: title, publication date, API payload, URL host spelling.
create or replace function public.record_cpsc_identity_observation(
  p_api_id text, p_recall_number text, p_observed_url text,
  p_canonical_url text, p_title text, p_publication_date date,
  p_payload_hash text, p_observed_at timestamptz, p_provenance text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_source_id uuid;
  v_identity private.cpsc_source_identities%rowtype;
  v_url_other boolean;
  v_url_self boolean;
  v_api_conflict boolean;
  v_api_reconciled boolean;
  v_api_established boolean;
  v_api_known boolean;
  v_history boolean;
  v_ref_title text;
  v_ref_date date;
  v_flags text[] := '{}'::text[];
  v_class text;
  v_reason text;
  v_status text;
  v_observation_id uuid;
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  if p_api_id is null or p_recall_number is null or p_observed_url is null
    or p_canonical_url is null or p_payload_hash is null or p_title is null
    or p_publication_date is null or p_observed_at is null
    or p_api_id !~ '^[0-9]{1,18}$' or p_recall_number !~ '^[0-9]{5}$'
    or p_payload_hash !~ '^[0-9a-f]{64}$' or btrim(p_title) = ''
    or length(p_title) > 1000 or length(p_observed_url) > 2048
    or nullif(btrim(p_provenance), '') is null or length(p_provenance) > 200
    or p_observed_at > now() + interval '5 minutes'
    or private.cpsc_canonical_url(p_canonical_url) is distinct from p_canonical_url
    or p_canonical_url !~ '^https://www\.cpsc\.gov/Recalls/' then
    raise exception 'Invalid CPSC observation';
  end if;
  if private.cpsc_canonical_url(p_observed_url) is distinct from p_canonical_url then
    raise exception 'Observed CPSC URL does not match canonical URL';
  end if;
  -- One identity decision at a time: creation and alias checks must not race.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:identity-decisions'));
  select source.id into v_source_id from public.recall_sources source
    where source.source_key = 'cpsc' and source.is_authoritative;
  if v_source_id is null then raise exception 'Authoritative CPSC source is unavailable'; end if;

  select identity.* into v_identity from private.cpsc_source_identities identity
    where identity.source_id = v_source_id and identity.official_recall_number = p_recall_number
    for update;
  with owner as (
    select i.id from private.cpsc_source_identities i where i.canonical_url = p_canonical_url
    union
    select a.identity_id from private.cpsc_source_aliases a
    where a.alias_kind = 'official_url' and a.reconciliation_id is not null
      and private.cpsc_canonical_url(a.alias_value) = p_canonical_url
  )
  select coalesce(bool_or(owner.id is distinct from v_identity.id), false),
    coalesce(bool_or(owner.id = v_identity.id), false)
  into v_url_other, v_url_self from owner;
  v_api_conflict := exists (
      select 1 from private.cpsc_source_aliases a
      where a.alias_kind = 'api_id' and a.alias_value = p_api_id
        and a.identity_id is distinct from v_identity.id)
    or exists (
      select 1 from public.recall_notices n
      where n.source_id = v_source_id and n.external_id = p_api_id
        and not exists (select 1 from private.cpsc_notice_identity_links link
          where link.notice_id = n.id and link.identity_id = v_identity.id));
  -- A reused numeric ID resolves only where a human confirmed it, or where this
  -- identity's own historical notice carried it.
  v_api_reconciled := v_identity.id is not null and exists (
    select 1 from private.cpsc_source_aliases a
    where a.identity_id = v_identity.id and a.alias_kind = 'api_id'
      and a.alias_value = p_api_id and a.reconciliation_id is not null);
  v_api_established := v_api_reconciled or (v_identity.id is not null
    and exists (select 1 from public.recall_notices n
      join private.cpsc_notice_identity_links link on link.notice_id = n.id
      where link.identity_id = v_identity.id and n.source_id = v_source_id
        and n.external_id = p_api_id));
  v_api_known := v_identity.id is not null and exists (
    select 1 from private.cpsc_source_aliases a
    where a.identity_id = v_identity.id and a.alias_kind = 'api_id' and a.alias_value = p_api_id);

  if v_identity.id is null then
    v_history := exists (
      select 1 from public.recall_notices n
      where n.source_id = v_source_id
        and (regexp_replace(coalesce(n.raw_payload->>'RecallNumber', ''),
              '^([0-9]{2})-?([0-9]{3})$', '\1\2') = p_recall_number
          or private.cpsc_canonical_url(n.official_url) = p_canonical_url));
    if v_url_other then
      v_class := 'E_number_url_conflict'; v_reason := 'official number and canonical URL conflict';
    elsif v_api_conflict then
      v_class := 'D_api_id_reuse'; v_reason := 'API ID belongs to another historical recall';
    elsif v_history then
      v_class := 'X_unlinked_history';
      v_reason := 'historical CPSC notice already carries this recall number or URL';
    else
      insert into private.cpsc_source_identities (
        source_id, official_recall_number, canonical_url, identity_status
      ) values (v_source_id, p_recall_number, p_canonical_url, 'unresolved')
      returning * into v_identity;
      v_class := 'C_new_identity';
      v_flags := array['identity_created'];
    end if;
  elsif v_url_other then
    v_class := 'E_number_url_conflict'; v_reason := 'official number and canonical URL conflict';
  elsif v_identity.canonical_url <> p_canonical_url and not v_url_self then
    v_class := 'E_url_changed'; v_reason := 'canonical URL changed for known recall number';
  elsif v_api_conflict and not v_api_established then
    v_class := 'D_api_id_reuse'; v_reason := 'API ID belongs to another historical recall';
  else
    v_class := case when v_api_conflict and v_api_reconciled then 'R_reconciled_alias'
      when v_api_known or v_api_conflict then 'A_known_alias' else 'B_new_alias' end;
    if v_identity.canonical_url <> p_canonical_url then
      v_flags := array_append(v_flags, 'reconciled_url_alias');
    end if;
    select n.title, n.recall_date into v_ref_title, v_ref_date
      from public.recall_notices n where n.id = v_identity.canonical_notice_id;
    if v_ref_title is null then
      select o.title, o.publication_date into v_ref_title, v_ref_date
        from private.cpsc_identity_observations o
        where o.identity_id = v_identity.id and o.resolution = 'resolved'
        order by o.observation_seq desc limit 1;
    end if;
    if v_ref_title is not null and lower(regexp_replace(btrim(v_ref_title), '\s+', ' ', 'g'))
        <> lower(regexp_replace(btrim(p_title), '\s+', ' ', 'g')) then
      v_flags := array_append(v_flags, 'title_revised');
    end if;
    if v_ref_date is not null and v_ref_date <> p_publication_date then
      v_flags := array_append(v_flags, 'publication_date_revised');
    end if;
    if exists (select 1 from private.cpsc_api_revisions r where r.identity_id = v_identity.id)
      and not exists (select 1 from private.cpsc_api_revisions r
        where r.identity_id = v_identity.id and r.payload_hash = p_payload_hash) then
      v_flags := array_append(v_flags, 'payload_revised');
    end if;
  end if;
  if p_observed_url <> p_canonical_url then
    v_flags := array_append(v_flags, 'url_spelling_alias');
  end if;

  insert into private.cpsc_identity_observations (
    identity_id, upstream_api_id, official_recall_number,
    observed_url, canonical_url, title, publication_date,
    payload_hash, observed_at, provenance, resolution, reason,
    decision_class, revision_flags
  ) values (
    v_identity.id, p_api_id, p_recall_number,
    p_observed_url, p_canonical_url, p_title, p_publication_date,
    p_payload_hash, p_observed_at, p_provenance,
    case when v_reason is null then 'resolved' else 'quarantined' end,
    v_reason, v_class, v_flags
  ) returning id into v_observation_id;

  if v_reason is not null then
    return jsonb_build_object('status', 'quarantined', 'observationId', v_observation_id,
      'reason', v_reason, 'decisionClass', v_class);
  end if;
  insert into private.cpsc_source_aliases (
    identity_id, notice_id, alias_kind, alias_value, provenance, first_seen_at, last_seen_at
  ) values
    (v_identity.id, v_identity.canonical_notice_id, 'api_id', p_api_id,
     p_provenance, p_observed_at, p_observed_at),
    (v_identity.id, v_identity.canonical_notice_id, 'official_url', p_observed_url,
     p_provenance, p_observed_at, p_observed_at)
  on conflict (identity_id, alias_kind, alias_value, provenance)
    do update set last_seen_at = greatest(cpsc_source_aliases.last_seen_at, excluded.last_seen_at);
  insert into private.cpsc_api_revisions (
    identity_id, upstream_api_id, payload_hash, provenance, first_seen_at, last_seen_at
  ) values (
    v_identity.id, p_api_id, p_payload_hash, p_provenance, p_observed_at, p_observed_at
  ) on conflict (identity_id, upstream_api_id, payload_hash)
    do update set last_seen_at = greatest(cpsc_api_revisions.last_seen_at, excluded.last_seen_at);
  update private.cpsc_source_identities set last_seen_at = greatest(last_seen_at, now())
    where id = v_identity.id;
  v_status := case when v_class = 'C_new_identity' then 'created' else 'resolved' end;
  return jsonb_build_object('status', v_status,
    'observationId', v_observation_id, 'identityId', v_identity.id,
    'canonicalNoticeId', v_identity.canonical_notice_id,
    'decisionClass', v_class, 'revisionFlags', to_jsonb(v_flags));
end;
$$;

-- A new canonical identity gets its first notice here. Identity fields come from
-- the resolved observation, so the worker cannot attach content to another recall.
-- Historical notices are never rewritten by this path.
create function public.ingest_cpsc_identity_notice(
  p_observation_id uuid,
  p_description text,
  p_hazard text,
  p_remedy text,
  p_retrieved_at timestamptz,
  p_raw_payload jsonb,
  p_scopes jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_observation private.cpsc_identity_observations%rowtype;
  v_identity private.cpsc_source_identities%rowtype;
  v_notice_id uuid;
  scope jsonb;
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  if p_observation_id is null or p_retrieved_at is null
    or p_retrieved_at > now() + interval '5 minutes'
    or jsonb_typeof(p_raw_payload) is distinct from 'object'
    or pg_column_size(p_raw_payload) > 262144
    or jsonb_typeof(p_scopes) is distinct from 'array'
    or jsonb_array_length(p_scopes) > 200
    or length(coalesce(p_description, '')) > 20000
    or length(coalesce(p_hazard, '')) > 20000
    or length(coalesce(p_remedy, '')) > 20000 then
    raise exception 'Invalid CPSC notice ingestion';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:identity-decisions'));
  select * into v_observation from private.cpsc_identity_observations where id = p_observation_id;
  if v_observation.id is null or v_observation.resolution <> 'resolved'
    or v_observation.identity_id is null then
    raise exception 'CPSC notice ingestion requires a resolved identity observation';
  end if;
  if p_raw_payload->>'RecallID' is distinct from v_observation.upstream_api_id
    or regexp_replace(coalesce(p_raw_payload->>'RecallNumber', ''),
      '^([0-9]{2})-?([0-9]{3})$', '\1\2') is distinct from v_observation.official_recall_number then
    raise exception 'CPSC payload does not match its identity observation';
  end if;
  select * into v_identity from private.cpsc_source_identities
    where id = v_observation.identity_id for update;
  if v_identity.canonical_notice_id is not null then
    return jsonb_build_object('status', 'unchanged', 'noticeId', v_identity.canonical_notice_id);
  end if;
  -- The numeric API ID is an alias, never the notice key: it can be reused.
  insert into public.recall_notices (
    source_id, external_id, title, description, hazard, remedy, recall_date,
    official_url, retrieved_at, raw_payload
  ) values (
    v_identity.source_id, 'cpsc:' || v_identity.official_recall_number,
    v_observation.title, p_description, p_hazard, p_remedy,
    v_observation.publication_date, v_identity.canonical_url, p_retrieved_at, p_raw_payload
  ) returning id into v_notice_id;
  for scope in select value from pg_catalog.jsonb_array_elements(p_scopes)
  loop
    if jsonb_typeof(scope) <> 'object' or length(scope::text) > 8192 then
      raise exception 'Invalid CPSC scope';
    end if;
    insert into public.recall_scopes (
      recall_notice_id, brand, product_name, gtin, model_number,
      lot_from, lot_to, serial_from, serial_to, additional_criteria
    ) values (
      v_notice_id,
      nullif(btrim(scope ->> 'brand'), ''),
      nullif(btrim(scope ->> 'productName'), ''),
      nullif(btrim(scope ->> 'gtin'), ''),
      nullif(btrim(scope ->> 'modelNumber'), ''),
      nullif(btrim(scope ->> 'lotFrom'), ''),
      nullif(btrim(scope ->> 'lotTo'), ''),
      nullif(btrim(scope ->> 'serialFrom'), ''),
      nullif(btrim(scope ->> 'serialTo'), ''),
      case when jsonb_typeof(scope -> 'additionalCriteria') = 'object'
        then scope -> 'additionalCriteria' end
    );
  end loop;
  insert into public.recall_notice_jurisdictions (
    recall_notice_id, jurisdiction_type, jurisdiction_code
  ) values (v_notice_id, 'country', 'US')
  on conflict (recall_notice_id, jurisdiction_type, jurisdiction_code) do nothing;
  insert into private.cpsc_notice_identity_links (notice_id, identity_id, provenance)
  values (v_notice_id, v_identity.id,
    'Phase 16.11 identity-aware ingestion from observation ' || p_observation_id::text);
  update private.cpsc_source_identities
    set canonical_notice_id = v_notice_id, identity_status = 'reconciled',
      last_seen_at = greatest(last_seen_at, now())
    where id = v_identity.id;
  update private.cpsc_source_aliases set notice_id = v_notice_id
    where identity_id = v_identity.id and notice_id is null;
  return jsonb_build_object('status', 'inserted', 'noticeId', v_notice_id);
end;
$$;

create function private.cpsc_quarantine_evidence(p_observation_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'observationId', o.id,
    'incomingApiId', o.upstream_api_id,
    'officialRecallNumber', o.official_recall_number,
    'observedUrl', o.observed_url,
    'canonicalUrl', o.canonical_url,
    'title', o.title,
    'publicationDate', o.publication_date,
    'payloadHash', o.payload_hash,
    'observedAt', o.observed_at,
    'provenance', o.provenance,
    'resolution', o.resolution,
    'reason', o.reason,
    'decisionClass', o.decision_class,
    'currentIdentity', (
      select jsonb_build_object('identityId', i.id,
        'officialRecallNumber', i.official_recall_number, 'canonicalUrl', i.canonical_url,
        'canonicalNoticeId', i.canonical_notice_id, 'status', i.identity_status,
        'linkedNotices', coalesce((select jsonb_agg(jsonb_build_object(
            'noticeId', n.id, 'externalId', n.external_id, 'title', n.title,
            'officialUrl', n.official_url, 'recallDate', n.recall_date) order by n.external_id)
          from private.cpsc_notice_identity_links link
          join public.recall_notices n on n.id = link.notice_id
          where link.identity_id = i.id), '[]'::jsonb))
      from private.cpsc_source_identities i
      where i.official_recall_number = o.official_recall_number),
    'conflictingAliases', coalesce((select jsonb_agg(jsonb_build_object(
        'identityId', a.identity_id, 'officialRecallNumber', i.official_recall_number,
        'canonicalUrl', i.canonical_url, 'aliasKind', a.alias_kind,
        'aliasValue', a.alias_value, 'noticeId', a.notice_id, 'provenance', a.provenance,
        'humanConfirmed', a.reconciliation_id is not null)
        order by i.official_recall_number, a.provenance)
      from private.cpsc_source_aliases a
      join private.cpsc_source_identities i on i.id = a.identity_id
      where (a.alias_kind = 'api_id' and a.alias_value = o.upstream_api_id)
        or (a.alias_kind = 'official_url'
          and private.cpsc_canonical_url(a.alias_value) = o.canonical_url)), '[]'::jsonb),
    'historicalNotices', coalesce((select jsonb_agg(jsonb_build_object(
        'noticeId', n.id, 'externalId', n.external_id, 'title', n.title,
        'officialUrl', n.official_url, 'recallDate', n.recall_date,
        'linkedIdentityId', link.identity_id) order by n.external_id)
      from public.recall_notices n
      join public.recall_sources s on s.id = n.source_id and s.source_key = 'cpsc'
      left join private.cpsc_notice_identity_links link on link.notice_id = n.id
      where n.external_id = o.upstream_api_id
        or private.cpsc_canonical_url(n.official_url) = o.canonical_url
        or regexp_replace(coalesce(n.raw_payload->>'RecallNumber', ''),
          '^([0-9]{2})-?([0-9]{3})$', '\1\2') = o.official_recall_number), '[]'::jsonb),
    'priorDecisions', coalesce((select jsonb_agg(jsonb_build_object(
        'decision', r.decision, 'reviewerUserId', r.reviewer_user_id,
        'identityId', r.identity_id, 'rationale', r.rationale, 'decidedAt', r.decided_at)
        order by r.decision_seq)
      from private.cpsc_identity_reconciliations r where r.observation_id = o.id), '[]'::jsonb))
  from private.cpsc_identity_observations o where o.id = p_observation_id;
$$;

create function public.get_cpsc_quarantine_packet(p_observation_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.cpsc_is_human_reviewer() then
    raise exception 'CPSC human reviewer authorization required' using errcode = '42501';
  end if;
  return private.cpsc_quarantine_evidence(p_observation_id);
end;
$$;

create function public.reconcile_cpsc_quarantined_observation(
  p_observation_id uuid, p_decision text, p_rationale text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_observation private.cpsc_identity_observations%rowtype;
  v_identity private.cpsc_source_identities%rowtype;
  v_source_id uuid;
  v_snapshot jsonb;
  v_reconciliation_id uuid;
  v_provenance text;
begin
  if not private.cpsc_is_human_reviewer() then
    raise exception 'CPSC human reviewer authorization required' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in
    ('confirm_alias', 'confirm_new_identity', 'reject_observation', 'leave_unresolved') then
    raise exception 'Invalid reconciliation decision';
  end if;
  if nullif(btrim(p_rationale), '') is null or length(p_rationale) > 2000 then
    raise exception 'Reconciliation rationale is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:identity-decisions'));
  select * into v_observation from private.cpsc_identity_observations where id = p_observation_id;
  if v_observation.id is null or v_observation.resolution <> 'quarantined' then
    raise exception 'Only a quarantined observation can be reconciled';
  end if;
  if exists (select 1 from private.cpsc_identity_reconciliations r
    where r.observation_id = p_observation_id and r.decision <> 'leave_unresolved') then
    raise exception 'Observation already has a terminal reconciliation';
  end if;
  v_snapshot := private.cpsc_quarantine_evidence(p_observation_id);
  select id into v_source_id from public.recall_sources
    where source_key = 'cpsc' and is_authoritative;
  select * into v_identity from private.cpsc_source_identities
    where source_id = v_source_id
      and official_recall_number = v_observation.official_recall_number
    for update;

  if p_decision in ('confirm_alias', 'confirm_new_identity') then
    -- A URL owned by a different canonical recall is a merge, never an alias.
    if exists (
      select 1 from private.cpsc_source_identities i
      where i.canonical_url = v_observation.canonical_url
        and i.id is distinct from v_identity.id
      union all
      select 1 from private.cpsc_source_aliases a
      where a.alias_kind = 'official_url' and a.reconciliation_id is not null
        and private.cpsc_canonical_url(a.alias_value) = v_observation.canonical_url
        and a.identity_id is distinct from v_identity.id
    ) then
      raise exception 'Canonical URL belongs to another canonical recall';
    end if;
  end if;
  if p_decision = 'confirm_alias' and v_identity.id is null then
    raise exception 'No canonical identity exists for this recall number';
  end if;
  if p_decision = 'confirm_new_identity' then
    if v_identity.id is not null then
      raise exception 'A canonical identity already exists for this recall number';
    end if;
    insert into private.cpsc_source_identities (
      source_id, official_recall_number, canonical_url, identity_status
    ) values (v_source_id, v_observation.official_recall_number,
      v_observation.canonical_url, 'unresolved')
    returning * into v_identity;
  end if;

  insert into private.cpsc_identity_reconciliations (
    observation_id, decision, reviewer_user_id, identity_id, rationale, evidence_snapshot
  ) values (
    p_observation_id, p_decision, auth.uid(),
    case when p_decision in ('confirm_alias', 'confirm_new_identity') then v_identity.id end,
    p_rationale, v_snapshot
  ) returning id into v_reconciliation_id;

  if p_decision in ('confirm_alias', 'confirm_new_identity') then
    -- Additive: historical aliases held by other identities are never touched.
    v_provenance := 'human reconciliation ' || v_reconciliation_id::text;
    insert into private.cpsc_source_aliases (
      identity_id, notice_id, alias_kind, alias_value, provenance,
      first_seen_at, last_seen_at, reconciliation_id
    ) values
      (v_identity.id, v_identity.canonical_notice_id, 'api_id', v_observation.upstream_api_id,
       v_provenance, v_observation.observed_at, v_observation.observed_at, v_reconciliation_id),
      (v_identity.id, v_identity.canonical_notice_id, 'official_url', v_observation.observed_url,
       v_provenance, v_observation.observed_at, v_observation.observed_at, v_reconciliation_id);
    insert into private.cpsc_api_revisions (
      identity_id, upstream_api_id, payload_hash, provenance, first_seen_at, last_seen_at
    ) values (
      v_identity.id, v_observation.upstream_api_id, v_observation.payload_hash,
      v_provenance, v_observation.observed_at, v_observation.observed_at
    ) on conflict (identity_id, upstream_api_id, payload_hash)
      do update set last_seen_at = greatest(cpsc_api_revisions.last_seen_at, excluded.last_seen_at);
  end if;
  return jsonb_build_object('reconciliationId', v_reconciliation_id,
    'decision', p_decision, 'identityId', v_identity.id);
end;
$$;

-- ===========================================================================
-- Worker persistence: narrow, validated, idempotent. No review capability.
-- ===========================================================================
create function public.get_cpsc_page_fetch_targets(p_limit integer)
returns table (identity_id uuid, official_recall_number text, canonical_url text,
  last_fetched_at timestamptz, sole_scope_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Invalid page fetch limit';
  end if;
  -- URLs come only from validated canonical identities, never from callers. A
  -- scope is offered only when the canonical notice has exactly one.
  return query
    select i.id, i.official_recall_number, i.canonical_url,
      (select max(f.fetched_at) from private.cpsc_page_fetches f where f.identity_id = i.id),
      (select case when count(*) = 1 then (array_agg(s.id))[1] end
        from public.recall_scopes s where s.recall_notice_id = i.canonical_notice_id)
    from private.cpsc_source_identities i
    where i.identity_status = 'reconciled'
    order by 4 asc nulls first, i.official_recall_number
    limit p_limit;
end;
$$;

create function public.record_cpsc_page_revision(
  p_identity_id uuid,
  p_evidence_hash text,
  p_normalized_evidence jsonb,
  p_section_hashes jsonb,
  p_table_identities jsonb,
  p_parser_version text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_identity private.cpsc_source_identities%rowtype;
  v_existing private.cpsc_page_revisions%rowtype;
  v_id uuid;
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  if p_identity_id is null or p_evidence_hash is null or p_evidence_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_normalized_evidence) is distinct from 'object'
    or octet_length(p_normalized_evidence::text) > 524288
    or jsonb_typeof(p_section_hashes) is distinct from 'object'
    or octet_length(p_section_hashes::text) > 16384
    or jsonb_typeof(p_table_identities) is distinct from 'array'
    or octet_length(p_table_identities::text) > 262144
    or p_parser_version is null or p_parser_version !~ '^[a-z0-9][a-z0-9.-]{0,63}$'
    or nullif(btrim(p_normalized_evidence->>'title'), '') is null
    or length(p_normalized_evidence->>'title') > 1000 then
    raise exception 'Invalid CPSC page revision';
  end if;
  select * into v_identity from private.cpsc_source_identities
    where id = p_identity_id for update;
  if v_identity.id is null or v_identity.identity_status <> 'reconciled' then
    raise exception 'CPSC page revision requires a reconciled canonical identity';
  end if;
  -- A page that names another recall is an identity contradiction, not a revision.
  if p_normalized_evidence->>'recallNumber' is distinct from v_identity.official_recall_number
    or p_normalized_evidence->>'canonicalUrl' is distinct from v_identity.canonical_url then
    raise exception 'CPSC page evidence contradicts its canonical identity';
  end if;
  select * into v_existing from private.cpsc_page_revisions
    where identity_id = p_identity_id and evidence_hash = p_evidence_hash;
  if v_existing.id is null then
    insert into private.cpsc_page_revisions (
      identity_id, evidence_hash, recall_number, canonical_url, title,
      section_hashes, normalized_evidence, parser_version, table_identities
    ) values (
      p_identity_id, p_evidence_hash, v_identity.official_recall_number,
      v_identity.canonical_url, p_normalized_evidence->>'title',
      p_section_hashes, p_normalized_evidence, p_parser_version, p_table_identities
    ) returning id into v_id;
    return jsonb_build_object('status', 'created', 'revisionId', v_id);
  end if;
  if private.cpsc_revision_is_current(v_existing.id) then
    update private.cpsc_page_revisions set last_seen_at = greatest(last_seen_at, now())
      where id = v_existing.id;
    return jsonb_build_object('status', 'unchanged', 'revisionId', v_existing.id);
  end if;
  -- A->B->A: the older semantic revision is current again; reviews of B go stale.
  update private.cpsc_page_revisions
    set current_since = now(), last_seen_at = greatest(last_seen_at, now())
    where id = v_existing.id;
  return jsonb_build_object('status', 'reverted', 'revisionId', v_existing.id);
end;
$$;

create unique index cpsc_page_fetches_idempotency_idx
  on private.cpsc_page_fetches(identity_id, fetched_at, http_status, coalesce(raw_page_hash, ''));

create function public.record_cpsc_page_fetch(
  p_identity_id uuid,
  p_revision_id uuid,
  p_fetched_at timestamptz,
  p_http_status integer,
  p_raw_page_hash text,
  p_final_url text,
  p_content_type text,
  p_etag text,
  p_last_modified text,
  p_redirect_chain jsonb,
  p_fetch_error text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_identity private.cpsc_source_identities%rowtype;
  v_id uuid;
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  if p_identity_id is null or p_fetched_at is null
    or p_fetched_at > now() + interval '5 minutes' or p_fetched_at < now() - interval '1 day'
    or p_http_status is null or p_http_status not between 100 and 599
    or p_final_url is null or length(p_final_url) > 2048
    or private.cpsc_canonical_url(p_final_url) is distinct from p_final_url
    or p_final_url !~ '^https://www\.cpsc\.gov/Recalls/'
    or length(coalesce(p_content_type, '')) > 128
    or length(coalesce(p_etag, '')) > 256
    or length(coalesce(p_last_modified, '')) > 128
    or length(coalesce(p_fetch_error, '')) > 500
    or jsonb_typeof(p_redirect_chain) is distinct from 'array'
    or jsonb_array_length(p_redirect_chain) > 3
    or exists (select 1 from jsonb_array_elements(p_redirect_chain) hop
      where jsonb_typeof(hop) <> 'string' or length(hop #>> '{}') > 2048
        or private.cpsc_canonical_url(hop #>> '{}') is null) then
    raise exception 'Invalid CPSC page fetch';
  end if;
  select * into v_identity from private.cpsc_source_identities where id = p_identity_id;
  if v_identity.id is null then raise exception 'Unknown CPSC identity'; end if;
  if p_http_status = 200 and (
    p_revision_id is null or p_raw_page_hash is null or p_raw_page_hash !~ '^[0-9a-f]{64}$'
    or p_final_url <> v_identity.canonical_url
    or not exists (select 1 from private.cpsc_page_revisions r
      where r.id = p_revision_id and r.identity_id = p_identity_id)) then
    raise exception 'A successful CPSC fetch must bind its own identity revision';
  end if;
  if p_http_status <> 200 and p_revision_id is not null then
    raise exception 'An unsuccessful CPSC fetch cannot carry a revision';
  end if;
  insert into private.cpsc_page_fetches (
    identity_id, revision_id, fetched_at, http_status, raw_page_hash, final_url,
    fetch_error, content_type, etag, last_modified, redirect_chain
  ) values (
    p_identity_id, p_revision_id, p_fetched_at, p_http_status, p_raw_page_hash, p_final_url,
    p_fetch_error, p_content_type, p_etag, p_last_modified, p_redirect_chain
  ) on conflict (identity_id, fetched_at, http_status, coalesce(raw_page_hash, ''))
    do nothing
  returning id into v_id;
  if v_id is null then
    select f.id into v_id from private.cpsc_page_fetches f
      where f.identity_id = p_identity_id and f.fetched_at = p_fetched_at
        and f.http_status = p_http_status
        and coalesce(f.raw_page_hash, '') = coalesce(p_raw_page_hash, '');
  end if;
  return v_id;
end;
$$;

create function public.propose_cpsc_candidate_criterion(
  p_revision_id uuid,
  p_proposed_scope_id uuid,
  p_evidence_address jsonb,
  p_evidence_fingerprint text,
  p_criterion_kind text,
  p_criterion_value jsonb,
  p_conjunction_key text,
  p_authoritative_excerpt text,
  p_parser_version text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_revision private.cpsc_page_revisions%rowtype;
  v_operator text;
  v_id uuid;
  v_identifier constant text := '^[A-Za-z0-9][A-Za-z0-9./ -]{0,63}$';
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  if p_criterion_kind is null or p_criterion_kind not in
    ('model_exact', 'model_set', 'date_code_exact', 'date_code_set') then
    raise exception 'Unsupported CPSC proposal class';
  end if;
  v_operator := case when p_criterion_kind like '%\_exact' then 'exact' else 'in' end;
  if p_revision_id is null
    or p_evidence_fingerprint is null or p_evidence_fingerprint !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_evidence_address) is distinct from 'object'
    or octet_length(p_evidence_address::text) > 4096
    or nullif(btrim(p_conjunction_key), '') is null or length(p_conjunction_key) > 512
    or nullif(btrim(p_authoritative_excerpt), '') is null
    or length(p_authoritative_excerpt) > 4000
    or p_parser_version is null or p_parser_version !~ '^[a-z0-9][a-z0-9.-]{0,63}$'
    or (v_operator = 'exact' and (jsonb_typeof(p_criterion_value) is distinct from 'string'
      or (p_criterion_value #>> '{}') !~ v_identifier))
    or (v_operator = 'in' and (jsonb_typeof(p_criterion_value) is distinct from 'array'
      or jsonb_array_length(p_criterion_value) not between 1 and 200
      or exists (select 1 from jsonb_array_elements(p_criterion_value) item
        where jsonb_typeof(item) <> 'string' or (item #>> '{}') !~ v_identifier)
      or (select count(distinct item #>> '{}') from jsonb_array_elements(p_criterion_value) item)
        <> jsonb_array_length(p_criterion_value))) then
    raise exception 'Invalid CPSC candidate proposal';
  end if;
  select * into v_revision from private.cpsc_page_revisions where id = p_revision_id;
  if v_revision.id is null or not private.cpsc_revision_is_current(v_revision.id) then
    raise exception 'CPSC proposal requires the current source revision';
  end if;
  if p_evidence_address->>'source' is distinct from 'cpsc'
    or p_evidence_address->>'recallNumber' is distinct from v_revision.recall_number
    or p_evidence_address->>'canonicalUrl' is distinct from v_revision.canonical_url
    or p_evidence_address->>'sourceSemanticRevision' is distinct from v_revision.evidence_hash
    or nullif(btrim(p_evidence_address->>'fieldIdentity'), '') is null then
    raise exception 'CPSC proposal address does not match its source revision';
  end if;
  if p_proposed_scope_id is not null and not exists (
    select 1 from public.recall_scopes scope
    join private.cpsc_notice_identity_links link on link.notice_id = scope.recall_notice_id
    where scope.id = p_proposed_scope_id and link.identity_id = v_revision.identity_id
  ) then
    raise exception 'Proposed scope does not belong to this canonical recall';
  end if;
  insert into private.cpsc_candidate_criteria (
    revision_id, proposed_scope_id, evidence_address, evidence_fingerprint,
    criterion_kind, criterion_value, proposed_operator, interpretation,
    conjunction_key, authoritative_excerpt, parser_version
  ) values (
    p_revision_id, p_proposed_scope_id, p_evidence_address, p_evidence_fingerprint,
    p_criterion_kind, p_criterion_value, v_operator, 'mandatory_candidate',
    p_conjunction_key, p_authoritative_excerpt, p_parser_version
  ) on conflict (revision_id, evidence_fingerprint, criterion_kind, criterion_value, conjunction_key)
    do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('status', 'created', 'candidateId', v_id);
  end if;
  select c.id into v_id from private.cpsc_candidate_criteria c
    where c.revision_id = p_revision_id and c.evidence_fingerprint = p_evidence_fingerprint
      and c.criterion_kind = p_criterion_kind and c.criterion_value = p_criterion_value
      and c.conjunction_key = p_conjunction_key;
  return jsonb_build_object('status', 'unchanged', 'candidateId', v_id);
end;
$$;

-- ===========================================================================
-- Privilege boundary.
-- ===========================================================================
revoke all on private.cpsc_source_identities, private.cpsc_source_aliases,
  private.cpsc_api_revisions, private.cpsc_page_revisions, private.cpsc_page_fetches,
  private.cpsc_candidate_criteria, private.cpsc_candidate_review_ledger,
  private.cpsc_notice_identity_links, private.cpsc_identity_observations,
  private.cpsc_reviewer_authorizations, private.cpsc_identity_reconciliations,
  private.recall_scope_criteria_v2
  from public, anon, authenticated, service_role;

-- Every CPSC notice/scope writer is a SECURITY DEFINER RPC. The service API no
-- longer holds raw write privileges that could bypass identity or scope checks.
revoke insert, update, delete, truncate, references, trigger
  on public.recall_notices, public.recall_scopes, public.recall_notice_jurisdictions,
    public.recall_sources
  from anon, authenticated, service_role;

revoke all on function private.cpsc_is_worker(), private.cpsc_canonical_url(text),
  private.cpsc_append_only(), private.cpsc_default_current_since(),
  private.cpsc_guard_page_revision_update(), private.cpsc_revision_is_current(uuid),
  private.cpsc_scope_fingerprint(uuid), private.cpsc_reviewed_conjunction_criteria(uuid, text),
  private.cpsc_guard_reviewed_binding(), private.cpsc_quarantine_evidence(uuid)
  from public, anon, authenticated, service_role;

revoke all on function
  public.approve_cpsc_product_model_criterion_v2(uuid, integer, text, text, text),
  public.materialize_cpsc_reviewed_conjunction(uuid),
  public.get_cpsc_quarantine_packet(uuid),
  public.reconcile_cpsc_quarantined_observation(uuid, text, text),
  public.record_cpsc_identity_observation(text, text, text, text, text, date, text, timestamptz, text),
  public.ingest_cpsc_identity_notice(uuid, text, text, text, timestamptz, jsonb, jsonb),
  public.get_cpsc_page_fetch_targets(integer),
  public.record_cpsc_page_revision(uuid, text, jsonb, jsonb, jsonb, text),
  public.record_cpsc_page_fetch(uuid, uuid, timestamptz, integer, text, text, text, text, text, jsonb, text),
  public.propose_cpsc_candidate_criterion(uuid, uuid, jsonb, text, text, jsonb, text, text, text)
  from public, anon, authenticated, service_role;

-- Human-only (functions additionally require a current reviewer authorization).
grant execute on function
  public.materialize_cpsc_reviewed_conjunction(uuid),
  public.get_cpsc_quarantine_packet(uuid),
  public.reconcile_cpsc_quarantined_observation(uuid, text, text)
  to authenticated;
-- Worker-only (functions additionally require the service role).
grant execute on function
  public.record_cpsc_identity_observation(text, text, text, text, text, date, text, timestamptz, text),
  public.ingest_cpsc_identity_notice(uuid, text, text, text, timestamptz, jsonb, jsonb),
  public.get_cpsc_page_fetch_targets(integer),
  public.record_cpsc_page_revision(uuid, text, jsonb, jsonb, jsonb, text),
  public.record_cpsc_page_fetch(uuid, uuid, timestamptz, integer, text, text, text, text, text, jsonb, text),
  public.propose_cpsc_candidate_criterion(uuid, uuid, jsonb, text, text, jsonb, text, text, text)
  to service_role;

commit;
