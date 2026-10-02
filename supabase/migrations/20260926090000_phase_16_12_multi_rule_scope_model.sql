-- Prepared locally only. Apply strictly after 16.9 (20260924060002), 16.10
-- (20260924065448) and 16.11 (20260925061100); all three stay byte-for-byte
-- unchanged. Nothing here activates deterministic_v2, a cohort, consumer reads,
-- push, or a production backfill. The backfill functions are owner-only and
-- are never invoked by this migration.
begin;

-- ===========================================================================
-- Separated human capabilities. Criterion review keeps its 16.10 table.
-- Identity reconciliation and decision invalidation are distinct, explicitly
-- granted capabilities. No RPC grants any capability; only the database owner can.
-- ===========================================================================
create table private.cpsc_admin_capabilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  capability text not null
    check (capability in ('identity_reconciliation', 'decision_invalidation')),
  authorized_by uuid references auth.users(id) on delete restrict,
  authorized_at timestamptz not null default now(),
  revoked_at timestamptz,
  reason text not null check (btrim(reason) <> '' and length(reason) <= 2000),
  unique (user_id, capability),
  check (revoked_at is null or revoked_at >= authorized_at)
);
alter table private.cpsc_admin_capabilities enable row level security;

-- Never NULL, so `if not ...` cannot skip the check.
create function private.cpsc_has_capability(p_capability text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(auth.role() = 'authenticated'
    and auth.uid() is not null
    and exists (
      select 1 from private.cpsc_admin_capabilities c
      where c.user_id = auth.uid() and c.capability = p_capability
        and c.authorized_at <= now()
        and (c.revoked_at is null or c.revoked_at > now())
    ), false);
$$;

-- ===========================================================================
-- Revoke-for-cause. Ordinary reviewer revocation is prospective (16.11). This
-- is the separate, deliberate action that makes specific past decisions unusable.
-- ===========================================================================
create table private.cpsc_review_decision_invalidations (
  id uuid primary key default gen_random_uuid(),
  invalidation_seq bigint generated always as identity unique,
  review_event_id uuid not null unique
    references private.cpsc_candidate_review_ledger(id) on delete restrict,
  invalidated_by uuid not null references auth.users(id) on delete restrict,
  reason text not null check (btrim(reason) <> '' and length(reason) <= 2000),
  action_kind text not null check (action_kind in ('decision', 'reviewer_window')),
  action_id uuid not null,
  invalidated_at timestamptz not null default now()
);
alter table private.cpsc_review_decision_invalidations enable row level security;
create trigger cpsc_invalidations_append_only
  before update or delete on private.cpsc_review_decision_invalidations
  for each row execute function private.cpsc_append_only();
create trigger cpsc_invalidations_no_truncate
  before truncate on private.cpsc_review_decision_invalidations
  for each statement execute function private.cpsc_append_only();
create trigger cpsc_candidate_criteria_no_truncate
  before truncate on private.cpsc_candidate_criteria
  for each statement execute function private.cpsc_append_only();

-- A usable member additionally requires that its decision was not invalidated
-- for cause. Everything else matches 16.11.
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
      )
      and not exists (
        select 1 from private.cpsc_review_decision_invalidations invalidation
        where invalidation.review_event_id = l.id
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

-- A new human decision is possible only when no effective decision exists: the
-- latest event is a stale marker on a current revision (A -> B -> A, or an API
-- identifier change), or the latest decision was invalidated for cause. A
-- decision invalidated for cause must be replaced by a different reviewer.
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
  v_latest private.cpsc_candidate_review_ledger%rowtype;
  v_invalidated boolean;
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
  select * into v_latest from private.cpsc_candidate_review_ledger
    where candidate_id = p_candidate_id order by event_seq desc limit 1;
  v_invalidated := v_latest.id is not null and exists (
    select 1 from private.cpsc_review_decision_invalidations invalidation
    where invalidation.review_event_id = v_latest.id);
  if v_latest.id is not null and v_latest.decision <> 'stale' and not v_invalidated then
    raise exception 'Candidate already has a decision';
  end if;
  if v_invalidated and v_latest.reviewer_user_id = auth.uid() then
    raise exception 'A decision invalidated for cause requires a different reviewer';
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

-- In-flight v2 evaluations compare the notice revision; advancing it makes a
-- claim taken under an invalidated criterion finalize as stale.
create function private.cpsc_touch_candidate_notices(p_candidate_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.recall_notices notice set updated_at = now()
  where notice.id in (
    select scope.recall_notice_id from private.cpsc_candidate_criteria c
    join public.recall_scopes scope on scope.id = c.proposed_scope_id
    where c.id = any(p_candidate_ids));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.invalidate_cpsc_review_decision(p_review_event_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event private.cpsc_candidate_review_ledger%rowtype;
  v_id uuid;
begin
  if not private.cpsc_has_capability('decision_invalidation') then
    raise exception 'CPSC decision invalidation authorization required' using errcode = '42501';
  end if;
  if nullif(btrim(p_reason), '') is null or length(p_reason) > 2000 then
    raise exception 'Invalidation reason is required';
  end if;
  select * into v_event from private.cpsc_candidate_review_ledger
    where id = p_review_event_id for update;
  if v_event.id is null or v_event.decision not in ('reviewed', 'rejected')
    or v_event.reviewer_user_id is null then
    raise exception 'Only a human review decision can be invalidated';
  end if;
  if exists (select 1 from private.cpsc_review_decision_invalidations
    where review_event_id = p_review_event_id) then
    raise exception 'Decision is already invalidated';
  end if;
  insert into private.cpsc_review_decision_invalidations (
    review_event_id, invalidated_by, reason, action_kind, action_id
  ) values (p_review_event_id, auth.uid(), p_reason, 'decision', gen_random_uuid())
  returning id into v_id;
  perform private.cpsc_touch_candidate_notices(array[v_event.candidate_id]);
  return jsonb_build_object('invalidationId', v_id, 'reviewEventId', p_review_event_id,
    'candidateId', v_event.candidate_id, 'decision', v_event.decision);
end;
$$;

-- For a reviewer found to be compromised: every human decision they made in a
-- bounded window becomes unusable. Other reviewers' decisions are untouched.
create function public.invalidate_cpsc_reviewer_decisions(
  p_reviewer_user_id uuid, p_decided_from timestamptz, p_decided_to timestamptz, p_reason text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_action uuid := gen_random_uuid();
  v_candidates uuid[];
  v_count integer;
begin
  if not private.cpsc_has_capability('decision_invalidation') then
    raise exception 'CPSC decision invalidation authorization required' using errcode = '42501';
  end if;
  if nullif(btrim(p_reason), '') is null or length(p_reason) > 2000 then
    raise exception 'Invalidation reason is required';
  end if;
  if p_reviewer_user_id is null or p_decided_from is null or p_decided_to is null
    or p_decided_from > p_decided_to then
    raise exception 'Invalid invalidation window';
  end if;
  select array_agg(l.candidate_id), count(*) into v_candidates, v_count
  from private.cpsc_candidate_review_ledger l
  where l.reviewer_user_id = p_reviewer_user_id
    and l.decision in ('reviewed', 'rejected')
    and l.decided_at between p_decided_from and p_decided_to
    and not exists (select 1 from private.cpsc_review_decision_invalidations i
      where i.review_event_id = l.id);
  if v_count > 1000 then
    raise exception 'Too many decisions in one invalidation; narrow the window';
  end if;
  insert into private.cpsc_review_decision_invalidations (
    review_event_id, invalidated_by, reason, action_kind, action_id
  )
  select l.id, auth.uid(), p_reason, 'reviewer_window', v_action
  from private.cpsc_candidate_review_ledger l
  where l.reviewer_user_id = p_reviewer_user_id
    and l.decision in ('reviewed', 'rejected')
    and l.decided_at between p_decided_from and p_decided_to
    and not exists (select 1 from private.cpsc_review_decision_invalidations i
      where i.review_event_id = l.id);
  if v_count > 0 then perform private.cpsc_touch_candidate_notices(v_candidates); end if;
  return jsonb_build_object('actionId', v_action, 'invalidated', v_count);
end;
$$;

-- ===========================================================================
-- Rule sets. A scope exposes any number of independently complete conjunctions:
-- OR across rule sets, AND inside each. The builder is the single definition of
-- a matcher-consumable rule set; writes and reads both re-run it.
-- ===========================================================================
create function private.cpsc_identity_fingerprint_of(p_recall_number text)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to('cpsc', 'UTF8') || decode('00', 'hex') ||
    convert_to(p_recall_number, 'UTF8')), 'hex');
$$;

-- Scope identity without database row UUIDs: the canonical recall identity plus
-- the scope's semantic columns.
create function private.cpsc_scope_semantic_fingerprint(p_scope_id uuid, p_identity_fingerprint text)
returns text language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(jsonb_build_array('recall-scope/v1', p_identity_fingerprint,
    s.brand, s.product_name, s.gtin, s.model_number, s.lot_from, s.lot_to, s.serial_from,
    s.serial_to, s.manufactured_from, s.manufactured_to, s.additional_criteria)::text, 'UTF8')), 'hex')
  from public.recall_scopes s where s.id = p_scope_id;
$$;

-- Fingerprint material (reproduced byte-for-byte by ruleSetsV2.ts):
--   'recall-rule-set/v1' LF identity fp LF scope semantic fp LF source revision LF
--   'all_of' LF member lines, byte-sorted and LF-joined, where a member line is
--   kind US operator US value-or-byte-sorted-values(RS-joined) US sourceField US
--   sha256(evidence address).
-- Excluded: row UUIDs, timestamps, reviewer identity, review event identity.
create function private.cpsc_reviewed_rule_set(p_revision_id uuid, p_group text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_base jsonb;
  v_revision private.cpsc_page_revisions%rowtype;
  v_identity private.cpsc_source_identities%rowtype;
  v_identity_fp text;
  v_scope_fp text;
  v_addresses jsonb;
  v_lines text;
  v_fingerprint text;
begin
  v_base := private.cpsc_reviewed_conjunction_criteria(p_revision_id, p_group);
  if v_base is null then return null; end if;
  select * into v_revision from private.cpsc_page_revisions where id = p_revision_id;
  select * into v_identity from private.cpsc_source_identities where id = v_revision.identity_id;
  v_identity_fp := private.cpsc_identity_fingerprint_of(v_identity.official_recall_number);
  if v_identity.id is null or v_identity.identity_status <> 'reconciled'
    or v_identity.identity_fingerprint is distinct from v_identity_fp
    or v_identity.official_recall_number is distinct from v_revision.recall_number
    or v_identity.canonical_url is distinct from v_revision.canonical_url then
    return null;
  end if;
  -- Every member's source address must name this identity's current revision.
  if exists (select 1 from private.cpsc_candidate_criteria c
    where c.revision_id = p_revision_id and coalesce(c.conjunction_key, c.id::text) = p_group
      and (c.evidence_address->>'source' is distinct from 'cpsc'
        or c.evidence_address->>'recallNumber' is distinct from v_revision.recall_number
        or c.evidence_address->>'canonicalUrl' is distinct from v_revision.canonical_url
        or c.evidence_address->>'sourceSemanticRevision' is distinct from v_revision.evidence_hash
        or nullif(btrim(c.evidence_address->>'fieldIdentity'), '') is null)) then
    return null;
  end if;
  v_scope_fp := private.cpsc_scope_semantic_fingerprint(
    (v_base #>> '{review,scopeId}')::uuid, v_identity_fp);
  select jsonb_agg(encode(sha256(convert_to(c.evidence_address::text, 'UTF8')), 'hex')
      order by c.id)
    into v_addresses
    from private.cpsc_candidate_criteria c
    where c.id in (select (item #>> '{}')::uuid
      from jsonb_array_elements(v_base #> '{review,candidateIds}') item);
  select string_agg(member.line, chr(10) order by member.line collate "C") into v_lines
  from (
    select (criterion->>'kind') || chr(31) || (criterion->>'operator') || chr(31) ||
      case when criterion ? 'value' then criterion->>'value'
        else (select string_agg(item #>> '{}', chr(30) order by (item #>> '{}') collate "C")
          from jsonb_array_elements(criterion->'values') item) end
      || chr(31) || (criterion #>> '{provenance,sourceField}') || chr(31) ||
      encode(sha256(convert_to(c.evidence_address::text, 'UTF8')), 'hex') as line
    from jsonb_array_elements(v_base->'criteria') criterion
    join private.cpsc_candidate_criteria c on 'cpsc-ledger-' || c.id::text = criterion->>'id'
  ) member;
  v_fingerprint := encode(sha256(convert_to(concat_ws(chr(10), 'recall-rule-set/v1',
    v_identity_fp, v_scope_fp, v_revision.evidence_hash, 'all_of', v_lines), 'UTF8')), 'hex');
  return jsonb_set(v_base, '{review}', (v_base->'review') || jsonb_build_object(
    'schema', 'recall_rule_set_v1',
    'ruleSetFingerprint', v_fingerprint,
    'identityFingerprint', v_identity_fp,
    'scopeSemanticFingerprint', v_scope_fp,
    'sourceAddressHashes', v_addresses));
end;
$$;

-- Append-only: a rule set that becomes stale stays as history and is simply no
-- longer served. A re-review after invalidation or a revert materializes a new
-- row with the same semantic fingerprint and a new review binding.
create table private.recall_scope_rule_sets_v2 (
  id uuid primary key default gen_random_uuid(),
  materialized_seq bigint generated always as identity unique,
  scope_id uuid not null references public.recall_scopes(id) on delete restrict,
  rule_set_fingerprint text not null check (rule_set_fingerprint ~ '^[0-9a-f]{64}$'),
  criteria_sha256 text not null check (criteria_sha256 ~ '^[0-9a-f]{64}$'),
  revision_id uuid not null references private.cpsc_page_revisions(id) on delete restrict,
  conjunction_group text not null check (btrim(conjunction_group) <> ''),
  criteria jsonb not null check (jsonb_typeof(criteria) = 'object'
    and criteria->>'semantics' = 'all_of'),
  source_url text not null,
  materialized_by uuid references auth.users(id) on delete restrict,
  materialized_at timestamptz not null default now(),
  unique (scope_id, criteria_sha256)
);
create index recall_scope_rule_sets_v2_scope_idx
  on private.recall_scope_rule_sets_v2(scope_id, rule_set_fingerprint, materialized_seq desc);
alter table private.recall_scope_rule_sets_v2 enable row level security;

-- Even the table owner cannot fabricate, edit, or delete a rule set.
create function private.cpsc_guard_rule_set_binding()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'recall_scope_rule_sets_v2 is append-only' using errcode = '42501';
  end if;
  if new.criteria is distinct from
      private.cpsc_reviewed_rule_set(new.revision_id, new.conjunction_group)
    or (new.criteria #>> '{review,scopeId}') is distinct from new.scope_id::text
    or (new.criteria #>> '{review,ruleSetFingerprint}') is distinct from new.rule_set_fingerprint
    or new.criteria_sha256 is distinct from
      encode(sha256(convert_to(new.criteria::text, 'UTF8')), 'hex')
    or new.source_url is distinct from (
      select n.official_url from public.recall_scopes s
      join public.recall_notices n on n.id = s.recall_notice_id where s.id = new.scope_id) then
    raise exception 'Matcher rule sets must originate from a current human review conjunction'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger cpsc_guard_rule_set_binding
  before insert or update or delete on private.recall_scope_rule_sets_v2
  for each row execute function private.cpsc_guard_rule_set_binding();
create trigger cpsc_rule_sets_no_truncate
  before truncate on private.recall_scope_rule_sets_v2
  for each statement execute function private.cpsc_append_only();

-- Pre-16.12 bindings that are still current become rule sets (production: 0 rows).
insert into private.recall_scope_rule_sets_v2 (
  scope_id, rule_set_fingerprint, criteria_sha256, revision_id, conjunction_group,
  criteria, source_url
)
select binding.scope_id, rule_set.criteria #>> '{review,ruleSetFingerprint}',
  encode(sha256(convert_to(rule_set.criteria::text, 'UTF8')), 'hex'),
  binding.revision_id, binding.conjunction_group, rule_set.criteria, binding.source_url
from private.recall_scope_criteria_v2 binding
cross join lateral (select private.cpsc_reviewed_rule_set(
  binding.revision_id, binding.conjunction_group) as criteria) rule_set
where binding.origin = 'human_review_ledger' and rule_set.criteria is not null
  and binding.source_url = (select n.official_url from public.recall_scopes s
    join public.recall_notices n on n.id = s.recall_notice_id where s.id = binding.scope_id)
  and binding.criteria = private.cpsc_reviewed_conjunction_criteria(
    binding.revision_id, binding.conjunction_group)
on conflict (scope_id, criteria_sha256) do nothing;

-- The single-binding table is superseded; it keeps its history and accepts no writes.
create or replace function private.cpsc_guard_reviewed_binding()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Superseded: matcher criteria are materialized as recall_scope_rule_sets_v2'
    using errcode = '42501';
end;
$$;

-- Coverage lets the matcher refuse a false "rejected": a scope is complete only
-- when its identity has exactly one current revision, no proposal on it is
-- unattributed to a scope, and every conjunction proposed for this scope is served.
create function private.cpsc_scope_rule_set_coverage(p_scope_id uuid, p_served_groups text[])
returns jsonb language sql stable security definer set search_path = '' as $$
  with current_revision as (
    select revision.id from public.recall_scopes scope
    join private.cpsc_notice_identity_links link on link.notice_id = scope.recall_notice_id
    join private.cpsc_page_revisions revision on revision.identity_id = link.identity_id
    where scope.id = p_scope_id and private.cpsc_revision_is_current(revision.id)
  ), proposal as (
    select distinct coalesce(c.conjunction_key, c.id::text) as conjunction_group,
      c.proposed_scope_id
    from private.cpsc_candidate_criteria c
    join current_revision on current_revision.id = c.revision_id
  ), summary as (
    select
      (select count(*) from current_revision) as current_revisions,
      (select count(*) from proposal where proposed_scope_id = p_scope_id) as proposed,
      (select count(*) from proposal where proposed_scope_id is null) as unattributed,
      (select count(*) from proposal where proposed_scope_id = p_scope_id
        and conjunction_group <> all(coalesce(p_served_groups, '{}'))) as unserved,
      coalesce(cardinality(p_served_groups), 0) as served
  )
  select jsonb_build_object(
    'currentRevisionId', (select id from current_revision limit 1),
    'proposedRuleSets', proposed,
    'unattributedRuleSets', unattributed,
    'servedRuleSets', served,
    'complete', current_revisions = 1 and unattributed = 0 and proposed > 0
      and unserved = 0 and served = proposed)
  from summary;
$$;

create function private.cpsc_scope_rule_set_envelope(p_scope_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_url text;
  v_sets jsonb;
  v_groups text[];
begin
  select n.official_url into v_url from public.recall_scopes s
    join public.recall_notices n on n.id = s.recall_notice_id where s.id = p_scope_id;
  select coalesce(jsonb_agg(served.criteria order by served.rule_set_fingerprint), '[]'::jsonb),
      coalesce(array_agg(served.conjunction_group order by served.rule_set_fingerprint), '{}')
    into v_sets, v_groups
  from (
    select distinct on (binding.rule_set_fingerprint) binding.rule_set_fingerprint,
      binding.criteria, binding.conjunction_group
    from private.recall_scope_rule_sets_v2 binding
    where binding.scope_id = p_scope_id and binding.source_url = v_url
      and binding.criteria = private.cpsc_reviewed_rule_set(
        binding.revision_id, binding.conjunction_group)
    order by binding.rule_set_fingerprint, binding.materialized_seq desc
  ) served;
  if jsonb_array_length(v_sets) = 0 then return null; end if;
  return jsonb_build_object(
    'semantics', 'any_of',
    'schema', 'recall_rule_sets_v1',
    'scopeId', p_scope_id,
    'ruleSets', v_sets,
    'coverage', private.cpsc_scope_rule_set_coverage(p_scope_id, v_groups));
end;
$$;

-- Read path: every served rule set is re-verified against the ledger builder.
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
    private.cpsc_scope_rule_set_envelope(scope.id) as reviewed_criteria
  from public.recall_scopes as scope
  join public.recall_notices as notice on notice.id = scope.recall_notice_id
  join public.recall_sources as source on source.id = notice.source_id
  where scope.recall_notice_id = p_recall_notice_id
    and source.is_authoritative
  order by scope.id;
$$;

create or replace function public.materialize_cpsc_reviewed_conjunction(p_candidate_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_candidate private.cpsc_candidate_criteria%rowtype;
  v_group text;
  v_rule_set jsonb;
  v_scope uuid;
  v_notice public.recall_notices%rowtype;
  v_fingerprint text;
  v_inserted uuid;
begin
  if not private.cpsc_is_human_reviewer() then
    raise exception 'CPSC human reviewer authorization required' using errcode = '42501';
  end if;
  select * into v_candidate from private.cpsc_candidate_criteria where id = p_candidate_id;
  if not found then raise exception 'Candidate does not exist'; end if;
  v_group := coalesce(v_candidate.conjunction_key, v_candidate.id::text);
  v_rule_set := private.cpsc_reviewed_rule_set(v_candidate.revision_id, v_group);
  if v_rule_set is null then
    raise exception 'Conjunction is not fully human-reviewed, current, and model-anchored';
  end if;
  v_scope := (v_rule_set #>> '{review,scopeId}')::uuid;
  v_fingerprint := v_rule_set #>> '{review,ruleSetFingerprint}';
  select n.* into v_notice from public.recall_scopes s
    join public.recall_notices n on n.id = s.recall_notice_id where s.id = v_scope
    for update of n;
  -- Other rule sets on the same scope are independent; none blocks another.
  insert into private.recall_scope_rule_sets_v2 (
    scope_id, rule_set_fingerprint, criteria_sha256, revision_id, conjunction_group,
    criteria, source_url, materialized_by
  ) values (
    v_scope, v_fingerprint, encode(sha256(convert_to(v_rule_set::text, 'UTF8')), 'hex'),
    v_candidate.revision_id, v_group, v_rule_set, v_notice.official_url, auth.uid()
  ) on conflict (scope_id, criteria_sha256) do nothing
  returning id into v_inserted;
  if v_inserted is null then
    return jsonb_build_object('status', 'unchanged', 'scopeId', v_scope,
      'ruleSetFingerprint', v_fingerprint);
  end if;
  update public.recall_notices set updated_at = now() where id = v_notice.id;
  return jsonb_build_object('status', 'materialized', 'scopeId', v_scope,
    'ruleSetFingerprint', v_fingerprint);
end;
$$;

-- ===========================================================================
-- Existing-notice revisions. Identity (source + recall number) never changes;
-- revisionable notice data is appended as a new revision, never overwritten.
-- ===========================================================================
create function private.cpsc_canonical_json(p_value jsonb)
returns text language plpgsql stable set search_path = '' as $$
declare v_out text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{' || coalesce(string_agg(to_json(entry.key)::text || ':' ||
          private.cpsc_canonical_json(entry.value), ',' order by entry.key collate "C"), '') || '}'
        into v_out from jsonb_each(p_value) entry;
      return v_out;
    when 'array' then
      select '[' || coalesce(string_agg(private.cpsc_canonical_json(item.value), ','
          order by item.ordinality), '') || ']'
        into v_out from jsonb_array_elements(p_value) with ordinality item;
      return v_out;
    when 'string' then
      return to_json(p_value #>> '{}')::text;
    else
      return p_value::text;
  end case;
end;
$$;

create function private.cpsc_canonical_json_sha256(p_value jsonb)
returns text language sql stable set search_path = '' as $$
  select encode(sha256(convert_to(private.cpsc_canonical_json(p_value), 'UTF8')), 'hex');
$$;

create function private.cpsc_normalized_text(p_value text)
returns text language sql immutable set search_path = '' as $$
  select nullif(btrim(regexp_replace(normalize(coalesce(p_value, ''), NFC), '\s+', ' ', 'g')), '');
$$;

create function private.cpsc_payload_recall_number(p_payload jsonb)
returns text language sql immutable set search_path = '' as $$
  select case when normalized ~ '^[0-9]{5}$' then normalized end
  from (select regexp_replace(coalesce(p_payload->>'RecallNumber', ''),
    '^([0-9]{2})-?([0-9]{3})$', '\1\2') as normalized) value;
$$;

create function private.cpsc_payload_text_set(p_payload jsonb, p_array text, p_field text)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(distinct_value order by distinct_value collate "C"), '[]'::jsonb)
  from (
    select distinct private.cpsc_normalized_text(item->>p_field) as distinct_value
    from jsonb_array_elements(case when jsonb_typeof(p_payload->p_array) = 'array'
      then p_payload->p_array else '[]'::jsonb end) item
    where jsonb_typeof(item) = 'object'
  ) value
  where distinct_value is not null;
$$;

-- Revisionable safety text. Whitespace and Unicode-composition differences are
-- formatting, not a revision.
create function private.cpsc_notice_content_hash(
  p_title text, p_description text, p_hazard text, p_remedy text, p_recall_date date,
  p_payload jsonb
)
returns text language sql stable set search_path = '' as $$
  select private.cpsc_canonical_json_sha256(jsonb_build_object(
    'title', private.cpsc_normalized_text(p_title),
    'description', private.cpsc_normalized_text(p_description),
    'hazard', private.cpsc_normalized_text(p_hazard),
    'remedy', private.cpsc_normalized_text(p_remedy),
    'recallDate', p_recall_date,
    'manufacturers', private.cpsc_payload_text_set(p_payload, 'Manufacturers', 'Name')));
$$;

-- Identifier-bearing payload content. A change here is treated as a possible
-- criterion change and conservatively stales the identity's reviews.
create function private.cpsc_notice_identifier_hash(p_payload jsonb)
returns text language sql stable set search_path = '' as $$
  select private.cpsc_canonical_json_sha256(jsonb_build_object(
    'models', private.cpsc_payload_text_set(p_payload, 'Products', 'Model'),
    'upcs', private.cpsc_payload_text_set(p_payload, 'ProductUPCs', 'UPC')));
$$;

create table private.cpsc_notice_revisions (
  id uuid primary key default gen_random_uuid(),
  revision_seq bigint generated always as identity unique,
  identity_id uuid not null references private.cpsc_source_identities(id) on delete restrict,
  notice_id uuid not null references public.recall_notices(id) on delete restrict,
  origin text not null check (origin in ('historical_baseline', 'api_observation')),
  observation_id uuid references private.cpsc_identity_observations(id) on delete restrict,
  supersedes_revision_id uuid references private.cpsc_notice_revisions(id) on delete restrict,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  identifier_hash text not null check (identifier_hash ~ '^[0-9a-f]{64}$'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  title text not null check (btrim(title) <> '' and length(title) <= 1000),
  description text check (length(description) <= 20000),
  hazard text check (length(hazard) <= 20000),
  remedy text check (length(remedy) <= 20000),
  recall_date date not null,
  manufacturer_names jsonb not null check (jsonb_typeof(manufacturer_names) = 'array'),
  raw_payload jsonb not null check (jsonb_typeof(raw_payload) = 'object'),
  changed_fields text[] not null default '{}',
  identifier_changed boolean not null default false,
  recorded_at timestamptz not null default now(),
  check ((origin = 'historical_baseline') = (observation_id is null)),
  check ((origin = 'historical_baseline') = (supersedes_revision_id is null))
);
create unique index cpsc_notice_revisions_one_baseline_idx
  on private.cpsc_notice_revisions(identity_id) where origin = 'historical_baseline';
create unique index cpsc_notice_revisions_observation_idx
  on private.cpsc_notice_revisions(observation_id) where observation_id is not null;
create index cpsc_notice_revisions_identity_idx
  on private.cpsc_notice_revisions(identity_id, revision_seq desc);
alter table private.cpsc_notice_revisions enable row level security;
create trigger cpsc_notice_revisions_append_only
  before update or delete on private.cpsc_notice_revisions
  for each row execute function private.cpsc_append_only();
create trigger cpsc_notice_revisions_no_truncate
  before truncate on private.cpsc_notice_revisions
  for each statement execute function private.cpsc_append_only();

create function private.cpsc_stale_identity_reviews(p_identity_id uuid, p_reason text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  insert into private.cpsc_candidate_review_ledger (
    candidate_id, decision, reviewer_user_id, attested_scope_id,
    source_revision_hash, evidence_address, attestation,
    normalized_criterion, reviewed_operator, conjunction_key,
    mandatory_eligibility, review_note
  )
  select c.id, 'stale', null, l.attested_scope_id, revision.evidence_hash,
    l.evidence_address, p_reason, l.normalized_criterion, l.reviewed_operator,
    l.conjunction_key, l.mandatory_eligibility,
    'Conservative invalidation pending renewed human review'
  from private.cpsc_candidate_criteria c
  join private.cpsc_page_revisions revision on revision.id = c.revision_id
  join lateral (
    select * from private.cpsc_candidate_review_ledger l0
    where l0.candidate_id = c.id order by l0.event_seq desc limit 1
  ) l on true
  where revision.identity_id = p_identity_id and l.decision = 'reviewed';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function private.cpsc_notice_revision_json(p_revision private.cpsc_notice_revisions)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'recorded', true, 'revisionId', p_revision.id, 'revisionSeq', p_revision.revision_seq,
    'identityId', p_revision.identity_id, 'noticeId', p_revision.notice_id,
    'origin', p_revision.origin, 'observationId', p_revision.observation_id,
    'supersedesRevisionId', p_revision.supersedes_revision_id,
    'title', p_revision.title, 'description', p_revision.description,
    'hazard', p_revision.hazard, 'remedy', p_revision.remedy,
    'recallDate', p_revision.recall_date, 'manufacturerNames', p_revision.manufacturer_names,
    'contentHash', p_revision.content_hash, 'identifierHash', p_revision.identifier_hash,
    'changedFields', to_jsonb(p_revision.changed_fields),
    'identifierChanged', p_revision.identifier_changed, 'recordedAt', p_revision.recorded_at);
$$;

create function private.cpsc_current_notice_revision(p_identity_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_revision private.cpsc_notice_revisions%rowtype;
  v_notice public.recall_notices%rowtype;
begin
  select * into v_revision from private.cpsc_notice_revisions
    where identity_id = p_identity_id order by revision_seq desc limit 1;
  if v_revision.id is not null then
    return private.cpsc_notice_revision_json(v_revision) || jsonb_build_object(
      'revisionCount', (select count(*) from private.cpsc_notice_revisions
        where identity_id = p_identity_id));
  end if;
  select n.* into v_notice from private.cpsc_source_identities i
    join public.recall_notices n on n.id = i.canonical_notice_id where i.id = p_identity_id;
  if v_notice.id is null then return null; end if;
  -- No revision recorded yet: the historical notice itself is the current content.
  return jsonb_build_object('recorded', false, 'origin', 'historical_notice',
    'identityId', p_identity_id, 'noticeId', v_notice.id, 'title', v_notice.title,
    'description', v_notice.description, 'hazard', v_notice.hazard,
    'remedy', v_notice.remedy, 'recallDate', v_notice.recall_date,
    'contentHash', private.cpsc_notice_content_hash(v_notice.title, v_notice.description,
      v_notice.hazard, v_notice.remedy, v_notice.recall_date, v_notice.raw_payload),
    'identifierHash', private.cpsc_notice_identifier_hash(v_notice.raw_payload),
    'revisionCount', 0);
end;
$$;

create function public.record_cpsc_notice_revision(
  p_observation_id uuid,
  p_description text,
  p_hazard text,
  p_remedy text,
  p_raw_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_observation private.cpsc_identity_observations%rowtype;
  v_identity private.cpsc_source_identities%rowtype;
  v_notice public.recall_notices%rowtype;
  v_current private.cpsc_notice_revisions%rowtype;
  v_existing uuid;
  v_content_hash text;
  v_identifier_hash text;
  v_changed text[] := '{}'::text[];
  v_stale integer := 0;
  v_id uuid;
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  if p_observation_id is null
    or jsonb_typeof(p_raw_payload) is distinct from 'object'
    or pg_column_size(p_raw_payload) > 262144
    or length(coalesce(p_description, '')) > 20000
    or length(coalesce(p_hazard, '')) > 20000
    or length(coalesce(p_remedy, '')) > 20000 then
    raise exception 'Invalid CPSC notice revision';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:identity-decisions'));
  select * into v_observation from private.cpsc_identity_observations where id = p_observation_id;
  if v_observation.id is null or v_observation.resolution <> 'resolved'
    or v_observation.identity_id is null then
    raise exception 'CPSC notice revision requires a resolved identity observation';
  end if;
  if p_raw_payload->>'RecallID' is distinct from v_observation.upstream_api_id
    or private.cpsc_payload_recall_number(p_raw_payload)
      is distinct from v_observation.official_recall_number then
    raise exception 'CPSC payload does not match its identity observation';
  end if;
  select * into v_identity from private.cpsc_source_identities
    where id = v_observation.identity_id for update;
  if v_identity.canonical_notice_id is null then
    raise exception 'CPSC notice revision requires an ingested canonical notice';
  end if;
  select * into v_notice from public.recall_notices where id = v_identity.canonical_notice_id;

  select * into v_current from private.cpsc_notice_revisions
    where identity_id = v_identity.id order by revision_seq desc limit 1;
  if v_current.id is null then
    -- The first recorded revision snapshots the historical notice as it stands.
    insert into private.cpsc_notice_revisions (
      identity_id, notice_id, origin, content_hash, identifier_hash, payload_sha256,
      title, description, hazard, remedy, recall_date, manufacturer_names, raw_payload
    ) values (
      v_identity.id, v_notice.id, 'historical_baseline',
      private.cpsc_notice_content_hash(v_notice.title, v_notice.description, v_notice.hazard,
        v_notice.remedy, v_notice.recall_date, v_notice.raw_payload),
      private.cpsc_notice_identifier_hash(v_notice.raw_payload),
      private.cpsc_canonical_json_sha256(v_notice.raw_payload),
      v_notice.title, v_notice.description, v_notice.hazard, v_notice.remedy,
      v_notice.recall_date,
      private.cpsc_payload_text_set(v_notice.raw_payload, 'Manufacturers', 'Name'),
      v_notice.raw_payload
    ) returning * into v_current;
  end if;

  select id into v_existing from private.cpsc_notice_revisions
    where observation_id = p_observation_id;
  if v_existing is not null then
    return jsonb_build_object('status', 'unchanged', 'revisionId', v_existing);
  end if;
  v_content_hash := private.cpsc_notice_content_hash(v_observation.title, p_description,
    p_hazard, p_remedy, v_observation.publication_date, p_raw_payload);
  v_identifier_hash := private.cpsc_notice_identifier_hash(p_raw_payload);
  if v_content_hash = v_current.content_hash and v_identifier_hash = v_current.identifier_hash then
    return jsonb_build_object('status', 'unchanged', 'revisionId', v_current.id);
  end if;

  if private.cpsc_normalized_text(v_observation.title)
    is distinct from private.cpsc_normalized_text(v_current.title) then
    v_changed := array_append(v_changed, 'title');
  end if;
  if private.cpsc_normalized_text(p_description)
    is distinct from private.cpsc_normalized_text(v_current.description) then
    v_changed := array_append(v_changed, 'description');
  end if;
  if private.cpsc_normalized_text(p_hazard)
    is distinct from private.cpsc_normalized_text(v_current.hazard) then
    v_changed := array_append(v_changed, 'hazard');
  end if;
  if private.cpsc_normalized_text(p_remedy)
    is distinct from private.cpsc_normalized_text(v_current.remedy) then
    v_changed := array_append(v_changed, 'remedy');
  end if;
  if v_observation.publication_date is distinct from v_current.recall_date then
    v_changed := array_append(v_changed, 'recall_date');
  end if;
  if private.cpsc_payload_text_set(p_raw_payload, 'Manufacturers', 'Name')
    is distinct from v_current.manufacturer_names then
    v_changed := array_append(v_changed, 'manufacturers');
  end if;
  if v_identifier_hash <> v_current.identifier_hash then
    v_changed := array_append(v_changed, 'identifiers');
  end if;

  insert into private.cpsc_notice_revisions (
    identity_id, notice_id, origin, observation_id, supersedes_revision_id,
    content_hash, identifier_hash, payload_sha256, title, description, hazard, remedy,
    recall_date, manufacturer_names, raw_payload, changed_fields, identifier_changed
  ) values (
    v_identity.id, v_notice.id, 'api_observation', p_observation_id, v_current.id,
    v_content_hash, v_identifier_hash, private.cpsc_canonical_json_sha256(p_raw_payload),
    v_observation.title, p_description, p_hazard, p_remedy, v_observation.publication_date,
    private.cpsc_payload_text_set(p_raw_payload, 'Manufacturers', 'Name'), p_raw_payload,
    v_changed, v_identifier_hash <> v_current.identifier_hash
  ) returning id into v_id;
  if v_identifier_hash <> v_current.identifier_hash then
    v_stale := private.cpsc_stale_identity_reviews(v_identity.id,
      'authoritative API identifiers changed');
  end if;
  return jsonb_build_object('status', 'created', 'revisionId', v_id,
    'supersedesRevisionId', v_current.id, 'changedFields', to_jsonb(v_changed),
    'identifierChanged', v_identifier_hash <> v_current.identifier_hash,
    'staledReviews', v_stale);
end;
$$;

create function public.get_cpsc_current_notice_revision(p_notice_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_identity uuid;
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  select identity_id into v_identity from private.cpsc_notice_identity_links
    where notice_id = p_notice_id;
  if v_identity is null then return null; end if;
  return private.cpsc_current_notice_revision(v_identity);
end;
$$;

-- ===========================================================================
-- Multi-rule reviewer packet: AND inside a rule set, OR between rule sets.
-- ===========================================================================
create or replace function public.get_cpsc_candidate_review_packet(p_candidate_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_candidate private.cpsc_candidate_criteria%rowtype;
  v_revision private.cpsc_page_revisions%rowtype;
  v_group text;
  v_rule_sets jsonb;
  v_packet jsonb;
begin
  if not private.cpsc_is_human_reviewer() then
    raise exception 'CPSC human reviewer authorization required' using errcode = '42501';
  end if;
  select * into v_candidate from private.cpsc_candidate_criteria where id = p_candidate_id;
  if v_candidate.id is null then return null; end if;
  select * into v_revision from private.cpsc_page_revisions where id = v_candidate.revision_id;
  v_group := coalesce(v_candidate.conjunction_key, v_candidate.id::text);

  with member as (
    select c.*, coalesce(c.conjunction_key, c.id::text) as conjunction_group,
      latest.decision as latest_decision, latest.id as latest_event_id,
      exists (select 1 from private.cpsc_review_decision_invalidations i
        where i.review_event_id = latest.id) as latest_invalidated
    from private.cpsc_candidate_criteria c
    left join lateral (
      select l.id, l.decision from private.cpsc_candidate_review_ledger l
      where l.candidate_id = c.id order by l.event_seq desc limit 1
    ) latest on true
    where c.revision_id = v_candidate.revision_id
      and c.proposed_scope_id is not distinct from v_candidate.proposed_scope_id
  ), row_position as (
    -- Document order comes from the revision's own table/row identities.
    select tables.value->>'identity' as table_identity, table_rows.value->>'identity' as row_identity,
      tables.ordinality * 100000 + table_rows.ordinality as position
    from jsonb_array_elements(v_revision.table_identities) with ordinality tables,
      jsonb_array_elements(case when jsonb_typeof(tables.value->'rows') = 'array'
        then tables.value->'rows' else '[]'::jsonb end) with ordinality table_rows
  ), grouped as (
    select m.conjunction_group, min(m.created_at) as first_created,
      min(doc.position) as document_position,
      jsonb_agg(jsonb_build_object(
        'candidateId', m.id, 'kind', m.criterion_kind, 'operator', m.proposed_operator,
        'value', m.criterion_value, 'excerpt', m.authoritative_excerpt,
        'evidenceAddress', m.evidence_address, 'latestDecision', m.latest_decision,
        'latestDecisionInvalidated', m.latest_invalidated)
        order by m.criterion_kind like 'date\_code%', m.id) as members,
      private.cpsc_reviewed_rule_set(v_candidate.revision_id, m.conjunction_group) as rule_set
    from member m
    left join row_position doc
      on doc.table_identity = m.evidence_address->>'tableIdentity'
        and doc.row_identity = m.evidence_address->>'rowIdentity'
    group by m.conjunction_group
  ), numbered as (
    select g.*, row_number() over (
      order by g.document_position nulls last, g.first_created, g.conjunction_group) as number
    from grouped g
  )
  select jsonb_agg(jsonb_build_object(
      'ruleSetNumber', n.number,
      'conjunctionGroup', n.conjunction_group,
      'containsThisCandidate', n.conjunction_group = v_group,
      'insideRuleSet', 'AND',
      'members', n.members,
      'state', case
        when n.rule_set is null then 'incomplete'
        when exists (select 1 from private.recall_scope_rule_sets_v2 b
          where b.criteria = n.rule_set) then 'served'
        else 'complete_not_materialized' end,
      'ruleSetFingerprint', n.rule_set #>> '{review,ruleSetFingerprint}')
      order by n.number)
    into v_rule_sets
  from numbered n;

  select jsonb_build_object(
    'candidateId', v_candidate.id, 'officialUrl', v_revision.canonical_url,
    'recallNumber', v_revision.recall_number, 'sourceRevision', v_revision.evidence_hash,
    'evidenceAddress', v_candidate.evidence_address,
    'authoritativeExcerpt', v_candidate.authoritative_excerpt,
    'normalizedCriterion', v_candidate.criterion_value,
    'criterionKind', v_candidate.criterion_kind, 'operator', v_candidate.proposed_operator,
    'conjunctionGroup', v_candidate.conjunction_key, 'parserVersion', v_candidate.parser_version,
    'allConjuncts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'candidateId', sibling.id, 'kind', sibling.criterion_kind,
        'operator', sibling.proposed_operator, 'value', sibling.criterion_value,
        'excerpt', sibling.authoritative_excerpt, 'evidenceAddress', sibling.evidence_address
      ) order by sibling.id), '[]'::jsonb)
      from private.cpsc_candidate_criteria sibling
      where sibling.revision_id = v_candidate.revision_id
        and coalesce(sibling.conjunction_key, sibling.id::text) = v_group),
    'ruleSetPresentation', jsonb_build_object(
      'semantics', 'OR between rule sets; AND inside each rule set',
      'explanation', 'A product is in scope when every member of at least one rule set matches. '
        || 'Members of different rule sets are never combined: a model from one rule set with '
        || 'a date code from another does not match.',
      'scopeId', v_candidate.proposed_scope_id,
      'ruleSetCount', coalesce(jsonb_array_length(v_rule_sets), 0),
      'ruleSets', coalesce(v_rule_sets, '[]'::jsonb)),
    'currentNoticeRevision', private.cpsc_current_notice_revision(v_revision.identity_id)
  ) into v_packet;
  return v_packet;
end;
$$;

-- ===========================================================================
-- Identity reconciliation requires its own capability (a reviewer cannot
-- reconcile unless separately granted). Bodies otherwise match 16.11.
-- ===========================================================================
create or replace function public.get_cpsc_quarantine_packet(p_observation_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.cpsc_has_capability('identity_reconciliation') then
    raise exception 'CPSC identity reconciliation authorization required' using errcode = '42501';
  end if;
  return private.cpsc_quarantine_evidence(p_observation_id);
end;
$$;

create or replace function public.reconcile_cpsc_quarantined_observation(
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
  if not private.cpsc_has_capability('identity_reconciliation') then
    raise exception 'CPSC identity reconciliation authorization required' using errcode = '42501';
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
-- Historical backfill (owner-only, never run by this migration).
-- Stages: A identities, B notice links, C historical aliases + API revisions,
-- E authoritative page revisions + fetch history ('structure' scope); D
-- historical and current identity observations through the real 16.11 gate,
-- F collision quarantine ('observations' scope). There is no G/H stage: human
-- reconciliation and reviewed criteria are never created automatically.
-- ===========================================================================
create table private.cpsc_backfill_runs (
  id uuid primary key default gen_random_uuid(),
  run_seq bigint generated always as identity unique,
  label text not null check (btrim(label) <> '' and length(label) <= 200),
  run_scope text not null check (run_scope in ('structure', 'observations')),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  report jsonb,
  retracted_at timestamptz,
  retraction_reason text,
  check ((retracted_at is null) = (retraction_reason is null))
);
create table private.cpsc_backfill_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references private.cpsc_backfill_runs(id) on delete restrict,
  item_key text not null check (btrim(item_key) <> ''),
  stage text not null check (stage in ('A_identity', 'B_link', 'C_alias', 'C_api_revision',
    'D_observation', 'E_page_revision', 'E_page_fetch', 'F_quarantine')),
  target_table text not null,
  target_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  retracted_at timestamptz
);
create unique index cpsc_backfill_items_key_idx
  on private.cpsc_backfill_items(item_key) where retracted_at is null;
create index cpsc_backfill_items_run_idx on private.cpsc_backfill_items(run_id);
alter table private.cpsc_backfill_runs enable row level security;
alter table private.cpsc_backfill_items enable row level security;

create function private.cpsc_bump(p_counts jsonb, p_key text)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_set(coalesce(p_counts, '{}'::jsonb), array[p_key],
    to_jsonb(coalesce((p_counts->>p_key)::integer, 0) + 1));
$$;

-- Digest of every historical CPSC notice and scope row, used to prove the
-- backfill rewrote nothing.
create function private.cpsc_historical_rows_digest(p_source_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(coalesce((
    select string_agg(jsonb_build_array(n.id, n.external_id, n.title, n.description,
      n.hazard, n.remedy, n.recall_date, n.official_url, n.raw_payload, n.retrieved_at,
      n.updated_at, (select jsonb_agg(to_jsonb(s) order by s.id)
        from public.recall_scopes s where s.recall_notice_id = n.id))::text, chr(10)
      order by n.id)
    from public.recall_notices n where n.source_id = p_source_id), ''), 'UTF8')), 'hex');
$$;

-- Environment-independent digest of the canonical identity layer (no UUIDs).
create function private.cpsc_canonical_identity_digest(p_source_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(coalesce((
    select string_agg(concat_ws('|', i.identity_fingerprint, i.official_recall_number,
      i.canonical_url, i.identity_status, canonical.external_id,
      (select string_agg(n.external_id, ',' order by n.external_id)
        from private.cpsc_notice_identity_links link
        join public.recall_notices n on n.id = link.notice_id
        where link.identity_id = i.id)), chr(10) order by i.official_recall_number)
    from private.cpsc_source_identities i
    left join public.recall_notices canonical on canonical.id = i.canonical_notice_id
    where i.source_id = p_source_id), ''), 'UTF8')), 'hex');
$$;

create function private.cpsc_backfill_apply(
  p_run_id uuid, p_manifest jsonb, p_scope text, p_limit integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_provenance constant text := 'Phase 16.12 historical backfill';
  v_source uuid;
  v_before text;
  v_after text;
  v_new integer := 0;
  v_complete boolean := true;
  v_counts jsonb := '{}'::jsonb;
  v_classes jsonb := '{}'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_quarantines jsonb := '[]'::jsonb;
  v_duplicates jsonb := '[]'::jsonb;
  v_usable text[] := '{}'::text[];
  v_claims text;
  v_result jsonb;
  v_identity private.cpsc_source_identities%rowtype;
  v_link uuid;
  v_id uuid;
  v_page jsonb;
  v_key text;
  v_drift integer;
  r record;
begin
  select id into v_source from public.recall_sources
    where source_key = 'cpsc' and is_authoritative;
  if v_source is null then raise exception 'Authoritative CPSC source is unavailable'; end if;
  v_before := private.cpsc_historical_rows_digest(v_source);

  if p_scope = 'structure' then
    -- A. One canonical identity per official recall number carried by history.
    for r in
      select h.recall_number,
        array_agg(distinct private.cpsc_canonical_url(h.official_url)) as urls,
        count(*) as notice_count,
        (array_agg(h.id order by case when h.external_id ~ '^[0-9]{1,18}$'
          then h.external_id::numeric end nulls last, h.created_at, h.id))[1] as chosen_notice,
        array_agg(h.id) as notice_ids
      from (select n.*, private.cpsc_payload_recall_number(n.raw_payload) as recall_number
        from public.recall_notices n where n.source_id = v_source) h
      where h.recall_number is not null
      group by h.recall_number order by h.recall_number
    loop
      select value into v_page from jsonb_array_elements(p_manifest->'pages') value
        where value->>'recallNumber' = r.recall_number limit 1;
      if cardinality(r.urls) <> 1 or r.urls[1] is null then
        v_conflicts := v_conflicts || jsonb_build_object('stage', 'A', 'recallNumber',
          r.recall_number, 'conflict', 'historical_notice_urls_disagree');
        continue;
      end if;
      if v_page is not null and v_page->>'canonicalUrl' is distinct from r.urls[1] then
        v_conflicts := v_conflicts || jsonb_build_object('stage', 'A', 'recallNumber',
          r.recall_number, 'conflict', 'authoritative_page_url_disagrees');
        continue;
      end if;
      select * into v_identity from private.cpsc_source_identities
        where source_id = v_source and official_recall_number = r.recall_number;
      if v_identity.id is not null then
        if v_identity.canonical_url <> r.urls[1] or v_identity.identity_status <> 'reconciled'
          or v_identity.canonical_notice_id is null
          or not (v_identity.canonical_notice_id = any(r.notice_ids)) then
          v_conflicts := v_conflicts || jsonb_build_object('stage', 'A', 'recallNumber',
            r.recall_number, 'conflict', 'existing_identity_disagrees');
          continue;
        end if;
        v_counts := private.cpsc_bump(v_counts, 'identitiesReused');
      else
        if exists (select 1 from private.cpsc_source_identities i
          where i.canonical_url = r.urls[1]) then
          v_conflicts := v_conflicts || jsonb_build_object('stage', 'A', 'recallNumber',
            r.recall_number, 'conflict', 'canonical_url_owned_by_other_number');
          continue;
        end if;
        if v_new >= p_limit then v_complete := false; exit; end if;
        insert into private.cpsc_source_identities (
          source_id, official_recall_number, canonical_url, canonical_notice_id, identity_status
        ) values (v_source, r.recall_number, r.urls[1], r.chosen_notice, 'reconciled')
        returning * into v_identity;
        insert into private.cpsc_backfill_items (run_id, item_key, stage, target_table,
          target_id, detail)
        values (p_run_id, 'A:' || r.recall_number, 'A_identity', 'cpsc_source_identities',
          v_identity.id, jsonb_build_object('recallNumber', r.recall_number));
        v_new := v_new + 1;
        v_counts := private.cpsc_bump(v_counts, 'identitiesCreated');
      end if;
      v_usable := array_append(v_usable, r.recall_number);
      if r.notice_count > 1 then
        v_duplicates := v_duplicates || jsonb_build_object('recallNumber', r.recall_number,
          'notices', r.notice_count);
      end if;
    end loop;
    v_counts := v_counts || jsonb_build_object('noticesWithoutRecallNumber', (
      select count(*) from public.recall_notices n where n.source_id = v_source
        and private.cpsc_payload_recall_number(n.raw_payload) is null));

    -- B + C. Every historical notice keeps its UUID and is linked, never merged.
    for r in
      select n.id, n.external_id, n.official_url, n.retrieved_at, n.raw_payload,
        private.cpsc_payload_recall_number(n.raw_payload) as recall_number, i.id as identity_id
      from public.recall_notices n
      join private.cpsc_source_identities i
        on i.source_id = v_source
          and i.official_recall_number = private.cpsc_payload_recall_number(n.raw_payload)
      where n.source_id = v_source
        and private.cpsc_payload_recall_number(n.raw_payload) = any(v_usable)
      order by 6, n.id
    loop
      exit when not v_complete;
      select identity_id into v_link from private.cpsc_notice_identity_links
        where notice_id = r.id;
      if v_link is null then
        if v_new >= p_limit then v_complete := false; exit; end if;
        insert into private.cpsc_notice_identity_links (notice_id, identity_id, provenance)
        values (r.id, r.identity_id, c_provenance);
        insert into private.cpsc_backfill_items (run_id, item_key, stage, target_table, detail)
        values (p_run_id, 'B:' || r.id, 'B_link', 'cpsc_notice_identity_links',
          jsonb_build_object('noticeId', r.id, 'recallNumber', r.recall_number));
        v_new := v_new + 1;
        v_counts := private.cpsc_bump(v_counts, 'linksCreated');
      elsif v_link = r.identity_id then
        v_counts := private.cpsc_bump(v_counts, 'linksReused');
      else
        v_conflicts := v_conflicts || jsonb_build_object('stage', 'B', 'recallNumber',
          r.recall_number, 'conflict', 'notice_linked_to_other_identity');
        continue;
      end if;

      for v_key in select unnest(array['api_id', 'official_url']) loop
        continue when v_key = 'api_id' and r.external_id !~ '^[0-9]{1,18}$';
        if exists (select 1 from private.cpsc_source_aliases a
          where a.identity_id = r.identity_id and a.alias_kind = v_key
            and a.notice_id = r.id
            and a.alias_value = case when v_key = 'api_id' then r.external_id
              else r.official_url end) then
          v_counts := private.cpsc_bump(v_counts, 'aliasesReused');
          continue;
        end if;
        if v_new >= p_limit then v_complete := false; exit; end if;
        insert into private.cpsc_source_aliases (identity_id, notice_id, alias_kind,
          alias_value, provenance, first_seen_at, last_seen_at)
        values (r.identity_id, r.id, v_key,
          case when v_key = 'api_id' then r.external_id else r.official_url end,
          c_provenance, r.retrieved_at, r.retrieved_at)
        returning id into v_id;
        insert into private.cpsc_backfill_items (run_id, item_key, stage, target_table,
          target_id, detail)
        values (p_run_id, 'C:' || v_key || ':' || r.id, 'C_alias', 'cpsc_source_aliases', v_id,
          jsonb_build_object('recallNumber', r.recall_number, 'aliasKind', v_key));
        v_new := v_new + 1;
        v_counts := private.cpsc_bump(v_counts, 'aliasesCreated');
        if v_key = 'api_id' and exists (select 1 from private.cpsc_source_aliases a
          where a.alias_kind = 'api_id' and a.alias_value = r.external_id
            and a.identity_id <> r.identity_id) then
          v_counts := private.cpsc_bump(v_counts, 'aliasValuesSharedWithOtherIdentity');
        end if;
      end loop;
      exit when not v_complete;

      continue when r.external_id !~ '^[0-9]{1,18}$';
      if exists (select 1 from private.cpsc_api_revisions a
        where a.identity_id = r.identity_id and a.upstream_api_id = r.external_id
          and a.payload_hash = private.cpsc_canonical_json_sha256(r.raw_payload)) then
        v_counts := private.cpsc_bump(v_counts, 'apiRevisionsReused');
        continue;
      end if;
      if v_new >= p_limit then v_complete := false; exit; end if;
      insert into private.cpsc_api_revisions (identity_id, upstream_api_id, payload_hash,
        provenance, first_seen_at, last_seen_at)
      values (r.identity_id, r.external_id, private.cpsc_canonical_json_sha256(r.raw_payload),
        c_provenance, r.retrieved_at, r.retrieved_at)
      returning id into v_id;
      insert into private.cpsc_backfill_items (run_id, item_key, stage, target_table,
        target_id, detail)
      values (p_run_id, 'C:api_revision:' || r.id, 'C_api_revision', 'cpsc_api_revisions', v_id,
        jsonb_build_object('recallNumber', r.recall_number));
      v_new := v_new + 1;
      v_counts := private.cpsc_bump(v_counts, 'apiRevisionsCreated');
    end loop;

    -- E. Authoritative page captures become the first page revision and fetch.
    for v_page in
      select value from jsonb_array_elements(p_manifest->'pages') value
      order by value->>'recallNumber'
    loop
      exit when not v_complete;
      if not (v_page->>'recallNumber' = any(v_usable)) then
        v_conflicts := v_conflicts || jsonb_build_object('stage', 'E', 'recallNumber',
          v_page->>'recallNumber', 'conflict', 'page_without_usable_identity');
        continue;
      end if;
      select * into v_identity from private.cpsc_source_identities
        where source_id = v_source and official_recall_number = v_page->>'recallNumber';
      select id into v_id from private.cpsc_page_revisions
        where identity_id = v_identity.id and evidence_hash = v_page->>'evidenceHash';
      if v_id is not null then
        v_counts := private.cpsc_bump(v_counts, 'pageRevisionsReused');
      elsif exists (select 1 from private.cpsc_page_revisions
          where identity_id = v_identity.id) then
        -- Never insert an older capture under live page history: it would stale
        -- current reviews and reorder currency.
        v_conflicts := v_conflicts || jsonb_build_object('stage', 'E', 'recallNumber',
          v_page->>'recallNumber', 'conflict', 'newer_page_history_present');
        continue;
      else
        if v_new >= p_limit then v_complete := false; exit; end if;
        insert into private.cpsc_page_revisions (identity_id, evidence_hash, recall_number,
          canonical_url, title, section_hashes, normalized_evidence, parser_version,
          table_identities, first_seen_at, last_seen_at, current_since)
        values (v_identity.id, v_page->>'evidenceHash', v_identity.official_recall_number,
          v_identity.canonical_url, v_page #>> '{normalizedEvidence,title}',
          v_page->'sectionHashes', v_page->'normalizedEvidence', v_page->>'parserVersion',
          coalesce(v_page->'tableIdentities', '[]'::jsonb),
          (v_page->>'fetchedAt')::timestamptz, (v_page->>'fetchedAt')::timestamptz,
          (v_page->>'fetchedAt')::timestamptz)
        returning id into v_id;
        insert into private.cpsc_backfill_items (run_id, item_key, stage, target_table,
          target_id, detail)
        values (p_run_id, 'E:revision:' || v_identity.official_recall_number || ':' ||
          (v_page->>'evidenceHash'), 'E_page_revision', 'cpsc_page_revisions', v_id,
          jsonb_build_object('recallNumber', v_identity.official_recall_number));
        v_new := v_new + 1;
        v_counts := private.cpsc_bump(v_counts, 'pageRevisionsCreated');
      end if;
      if exists (select 1 from private.cpsc_page_fetches f
        where f.identity_id = v_identity.id
          and f.fetched_at = (v_page->>'fetchedAt')::timestamptz and f.http_status = 200
          and f.raw_page_hash = v_page->>'rawPageHash') then
        v_counts := private.cpsc_bump(v_counts, 'pageFetchesReused');
        continue;
      end if;
      if v_new >= p_limit then v_complete := false; exit; end if;
      insert into private.cpsc_page_fetches (identity_id, revision_id, fetched_at, http_status,
        raw_page_hash, final_url, content_type)
      values (v_identity.id, v_id, (v_page->>'fetchedAt')::timestamptz, 200,
        v_page->>'rawPageHash', v_identity.canonical_url, 'text/html')
      returning id into v_id;
      insert into private.cpsc_backfill_items (run_id, item_key, stage, target_table,
        target_id, detail)
      values (p_run_id, 'E:fetch:' || v_identity.official_recall_number || ':' ||
        (v_page->>'rawPageHash'), 'E_page_fetch', 'cpsc_page_fetches', v_id,
        jsonb_build_object('recallNumber', v_identity.official_recall_number));
      v_new := v_new + 1;
      v_counts := private.cpsc_bump(v_counts, 'pageFetchesCreated');
    end loop;
  else
    -- Observations run through the real 16.11 decision gate, as the worker would.
    if exists (select 1 from public.recall_notices n
      where n.source_id = v_source
        and private.cpsc_payload_recall_number(n.raw_payload) is not null
        and not exists (select 1 from private.cpsc_notice_identity_links link
          where link.notice_id = n.id)) then
      raise exception 'Backfill structure stage is incomplete';
    end if;
    v_claims := current_setting('request.jwt.claims', true);
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

    -- D (historical). What each stored notice carried when it was ingested.
    for r in
      select n.id, n.external_id, n.title, n.recall_date, n.official_url, n.retrieved_at,
        n.raw_payload, private.cpsc_payload_recall_number(n.raw_payload) as recall_number
      from public.recall_notices n
      join private.cpsc_notice_identity_links link on link.notice_id = n.id
      where n.source_id = v_source and n.external_id ~ '^[0-9]{1,18}$'
      order by 8, n.id
    loop
      v_key := 'D:historical:' || r.id;
      if exists (select 1 from private.cpsc_backfill_items
        where item_key = v_key and retracted_at is null) then
        v_counts := private.cpsc_bump(v_counts, 'observationsAlreadyRecorded');
        continue;
      end if;
      if v_new >= p_limit then v_complete := false; exit; end if;
      v_result := public.record_cpsc_identity_observation(r.external_id, r.recall_number,
        r.official_url, private.cpsc_canonical_url(r.official_url), r.title, r.recall_date,
        private.cpsc_canonical_json_sha256(r.raw_payload), r.retrieved_at,
        c_provenance || ' (stored notice)');
      insert into private.cpsc_backfill_items (run_id, item_key, stage, target_table,
        target_id, detail)
      values (p_run_id, v_key, 'D_observation', 'cpsc_identity_observations',
        (v_result->>'observationId')::uuid, jsonb_build_object('recallNumber', r.recall_number,
          'decisionClass', v_result->>'decisionClass', 'kind', 'historical'));
      v_new := v_new + 1;
      v_counts := private.cpsc_bump(v_counts, 'historicalObservationsRecorded');
      v_classes := private.cpsc_bump(v_classes, v_result->>'decisionClass');
      if v_result->>'status' = 'quarantined' then
        v_quarantines := v_quarantines || jsonb_build_object('recallNumber', r.recall_number,
          'apiId', r.external_id, 'decisionClass', v_result->>'decisionClass', 'kind', 'historical');
      end if;
    end loop;

    -- D (current) + F. The captured current API observations; reused numeric IDs
    -- quarantine. No reconciliation is ever recorded here.
    for v_page in
      select value from jsonb_array_elements(p_manifest->'currentObservations') value
      order by value->>'recallNumber', value->>'apiId'
    loop
      exit when not v_complete;
      v_key := 'D:current:' || encode(sha256(convert_to(concat_ws('|', v_page->>'apiId',
        v_page->>'recallNumber', v_page->>'observedUrl', v_page->>'payloadHash',
        v_page->>'observedAt'), 'UTF8')), 'hex');
      if exists (select 1 from private.cpsc_backfill_items
        where item_key = v_key and retracted_at is null) then
        v_counts := private.cpsc_bump(v_counts, 'observationsAlreadyRecorded');
        continue;
      end if;
      if v_new >= p_limit then v_complete := false; exit; end if;
      v_result := public.record_cpsc_identity_observation(v_page->>'apiId',
        v_page->>'recallNumber', v_page->>'observedUrl',
        private.cpsc_canonical_url(v_page->>'observedUrl'), v_page->>'title',
        (v_page->>'publicationDate')::date, v_page->>'payloadHash',
        (v_page->>'observedAt')::timestamptz, c_provenance || ' (captured current API)');
      insert into private.cpsc_backfill_items (run_id, item_key, stage, target_table,
        target_id, detail)
      values (p_run_id, v_key,
        case when v_result->>'status' = 'quarantined' then 'F_quarantine' else 'D_observation' end,
        'cpsc_identity_observations', (v_result->>'observationId')::uuid,
        jsonb_build_object('recallNumber', v_page->>'recallNumber',
          'decisionClass', v_result->>'decisionClass', 'kind', 'current'));
      v_new := v_new + 1;
      v_counts := private.cpsc_bump(v_counts, 'currentObservationsRecorded');
      v_classes := private.cpsc_bump(v_classes, v_result->>'decisionClass');
      if v_result->>'status' = 'quarantined' then
        v_quarantines := v_quarantines || jsonb_build_object('recallNumber',
          v_page->>'recallNumber', 'apiId', v_page->>'apiId',
          'decisionClass', v_result->>'decisionClass', 'kind', 'current');
      end if;
    end loop;
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  end if;

  v_after := private.cpsc_historical_rows_digest(v_source);
  if v_after <> v_before then
    raise exception 'Backfill would rewrite historical CPSC rows';
  end if;
  select count(*) into v_drift
  from public.recall_notices n
  join lateral (select value from jsonb_array_elements(p_manifest->'currentObservations') value
    where value->>'recallNumber' = private.cpsc_payload_recall_number(n.raw_payload)
    limit 1) current_observation on true
  where n.source_id = v_source and n.external_id ~ '^[0-9]{1,18}$'
    and n.external_id is distinct from current_observation.value->>'apiId';

  return jsonb_build_object(
    'scope', p_scope,
    'complete', v_complete,
    'newRows', v_new,
    'counts', v_counts,
    'decisionClasses', v_classes,
    'quarantines', v_quarantines,
    'collisions', (select count(*) from jsonb_array_elements(v_quarantines) q
      where q->>'decisionClass' = 'D_api_id_reuse'),
    'duplicateGroups', v_duplicates,
    'driftRows', v_drift,
    'conflicts', v_conflicts,
    'unexpectedConflicts', jsonb_array_length(v_conflicts),
    'historicalRowsRewritten', 0,
    'historicalRowsDigest', v_after,
    'canonicalIdentityDigest', private.cpsc_canonical_identity_digest(v_source),
    'humanReconciliationsCreated', 0,
    'reviewedCriteriaCreated', 0);
end;
$$;

create function private.cpsc_validate_backfill_manifest(p_manifest jsonb)
returns void language plpgsql stable set search_path = '' as $$
begin
  if jsonb_typeof(p_manifest) is distinct from 'object'
    or p_manifest->>'manifestVersion' is distinct from 'phase-16.12-cpsc-backfill-v1'
    or jsonb_typeof(p_manifest->'pages') is distinct from 'array'
    or jsonb_typeof(p_manifest->'currentObservations') is distinct from 'array'
    or jsonb_array_length(p_manifest->'pages') > 1000
    or jsonb_array_length(p_manifest->'currentObservations') > 5000
    or octet_length(p_manifest::text) > 8388608 then
    raise exception 'Invalid CPSC backfill manifest';
  end if;
  if exists (select 1 from jsonb_array_elements(p_manifest->'pages') page
    where coalesce(page->>'recallNumber', '') !~ '^[0-9]{5}$'
      or coalesce(page->>'canonicalUrl', '') !~ '^https://www\.cpsc\.gov/Recalls/'
      or coalesce(page->>'evidenceHash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(page->>'rawPageHash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(page->>'parserVersion', '') !~ '^[a-z0-9][a-z0-9.-]{0,63}$'
      or coalesce(page->>'fetchedAt', '') !~ '^\d{4}-\d{2}-\d{2}T'
      or jsonb_typeof(page->'sectionHashes') is distinct from 'object'
      or jsonb_typeof(page->'normalizedEvidence') is distinct from 'object'
      or page #>> '{normalizedEvidence,recallNumber}' is distinct from page->>'recallNumber'
      or page #>> '{normalizedEvidence,canonicalUrl}' is distinct from page->>'canonicalUrl'
      or nullif(btrim(page #>> '{normalizedEvidence,title}'), '') is null) then
    raise exception 'Invalid CPSC backfill manifest page';
  end if;
  if exists (select 1 from jsonb_array_elements(p_manifest->'currentObservations') item
    where coalesce(item->>'apiId', '') !~ '^[0-9]{1,18}$'
      or coalesce(item->>'recallNumber', '') !~ '^[0-9]{5}$'
      or coalesce(item->>'observedUrl', '') !~ '^https://(www\.)?cpsc\.gov/Recalls/'
      or coalesce(item->>'payloadHash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(item->>'publicationDate', '') !~ '^\d{4}-\d{2}-\d{2}$'
      or coalesce(item->>'observedAt', '') !~ '^\d{4}-\d{2}-\d{2}T'
      or nullif(btrim(item->>'title'), '') is null) then
    raise exception 'Invalid CPSC backfill manifest observation';
  end if;
end;
$$;

-- Dry run executes every stage inside a savepoint and rolls it back, so its
-- report is exact (including the real gate's collision decisions) and nothing
-- persists. Scope 'all' previews or executes structure then observations in one
-- call. Execution is atomic per call, bounded by p_limit new rows per stage, and
-- resumable: already-recorded items are reused, never duplicated.
create function private.cpsc_historical_backfill(
  p_manifest jsonb, p_scope text, p_execute boolean, p_label text, p_limit integer default 500
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid;
  v_part jsonb;
  v_report jsonb := '{}'::jsonb;
  v_hash text;
  v_stage text;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated', 'service_role') then
    raise exception 'CPSC backfill is an owner-only administrative action' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('structure', 'observations', 'all')
    or p_execute is null or nullif(btrim(p_label), '') is null or length(p_label) > 200
    or p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'Invalid CPSC backfill request';
  end if;
  perform private.cpsc_validate_backfill_manifest(p_manifest);
  v_hash := private.cpsc_canonical_json_sha256(p_manifest);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:identity-decisions'));
  begin
    foreach v_stage in array case when p_scope = 'all'
      then array['structure', 'observations'] else array[p_scope] end loop
      -- An incomplete (bounded) structure stage is resumed before observations run.
      exit when v_stage = 'observations' and p_scope = 'all'
        and (v_report #>> '{structure,complete}')::boolean is false;
      insert into private.cpsc_backfill_runs (label, run_scope, manifest_sha256)
      values (p_label, v_stage, v_hash) returning id into v_run;
      v_part := private.cpsc_backfill_apply(v_run, p_manifest, v_stage, p_limit);
      if p_execute then
        update private.cpsc_backfill_runs set finished_at = now(), report = v_part
          where id = v_run;
        v_part := v_part || jsonb_build_object('runId', v_run);
      end if;
      v_report := v_report || jsonb_build_object(v_stage, v_part);
    end loop;
    if not p_execute then
      raise exception using errcode = 'P1612', message = 'cpsc backfill dry run';
    end if;
  exception when sqlstate 'P1612' then
    null;
  end;
  if p_scope <> 'all' then v_report := v_report -> p_scope; end if;
  return v_report || jsonb_build_object(
    'mode', case when p_execute then 'execute' else 'dry_run' end,
    'manifestSha256', v_hash, 'persisted', p_execute);
end;
$$;

-- Undo of a structure run's own rows (never historical rows). It refuses once
-- anything depends on them, e.g. observations, proposals, or reviews.
create function private.cpsc_backfill_retract(p_run_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run private.cpsc_backfill_runs%rowtype;
  v_deleted integer := 0;
  v_count integer;
  v_stage text;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated', 'service_role') then
    raise exception 'CPSC backfill is an owner-only administrative action' using errcode = '42501';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Retraction reason is required'; end if;
  select * into v_run from private.cpsc_backfill_runs where id = p_run_id for update;
  if v_run.id is null or v_run.retracted_at is not null or v_run.run_scope <> 'structure' then
    raise exception 'Only an unretracted structure run can be retracted';
  end if;
  foreach v_stage in array array['E_page_fetch', 'E_page_revision', 'C_api_revision',
    'C_alias', 'B_link', 'A_identity'] loop
    if v_stage = 'E_page_fetch' then
      delete from private.cpsc_page_fetches where id in (select target_id
        from private.cpsc_backfill_items where run_id = p_run_id and stage = v_stage);
    elsif v_stage = 'E_page_revision' then
      delete from private.cpsc_page_revisions where id in (select target_id
        from private.cpsc_backfill_items where run_id = p_run_id and stage = v_stage);
    elsif v_stage = 'C_api_revision' then
      delete from private.cpsc_api_revisions where id in (select target_id
        from private.cpsc_backfill_items where run_id = p_run_id and stage = v_stage);
    elsif v_stage = 'C_alias' then
      delete from private.cpsc_source_aliases where id in (select target_id
        from private.cpsc_backfill_items where run_id = p_run_id and stage = v_stage);
    elsif v_stage = 'B_link' then
      delete from private.cpsc_notice_identity_links where notice_id in (
        select (detail->>'noticeId')::uuid from private.cpsc_backfill_items
        where run_id = p_run_id and stage = v_stage);
    else
      delete from private.cpsc_source_identities where id in (select target_id
        from private.cpsc_backfill_items where run_id = p_run_id and stage = v_stage);
    end if;
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count;
  end loop;
  update private.cpsc_backfill_items set retracted_at = now() where run_id = p_run_id;
  update private.cpsc_backfill_runs set retracted_at = now(), retraction_reason = p_reason
    where id = p_run_id;
  return jsonb_build_object('runId', p_run_id, 'rowsRemoved', v_deleted);
end;
$$;

-- ===========================================================================
-- Privilege boundary.
-- ===========================================================================
revoke all on private.cpsc_admin_capabilities, private.cpsc_review_decision_invalidations,
  private.recall_scope_rule_sets_v2, private.cpsc_notice_revisions,
  private.cpsc_backfill_runs, private.cpsc_backfill_items
  from public, anon, authenticated, service_role;

revoke all on function
  private.cpsc_has_capability(text),
  private.cpsc_touch_candidate_notices(uuid[]),
  private.cpsc_identity_fingerprint_of(text),
  private.cpsc_scope_semantic_fingerprint(uuid, text),
  private.cpsc_reviewed_rule_set(uuid, text),
  private.cpsc_guard_rule_set_binding(),
  private.cpsc_scope_rule_set_coverage(uuid, text[]),
  private.cpsc_scope_rule_set_envelope(uuid),
  private.cpsc_canonical_json(jsonb),
  private.cpsc_canonical_json_sha256(jsonb),
  private.cpsc_normalized_text(text),
  private.cpsc_payload_recall_number(jsonb),
  private.cpsc_payload_text_set(jsonb, text, text),
  private.cpsc_notice_content_hash(text, text, text, text, date, jsonb),
  private.cpsc_notice_identifier_hash(jsonb),
  private.cpsc_stale_identity_reviews(uuid, text),
  private.cpsc_notice_revision_json(private.cpsc_notice_revisions),
  private.cpsc_current_notice_revision(uuid),
  private.cpsc_bump(jsonb, text),
  private.cpsc_historical_rows_digest(uuid),
  private.cpsc_canonical_identity_digest(uuid),
  private.cpsc_backfill_apply(uuid, jsonb, text, integer),
  private.cpsc_validate_backfill_manifest(jsonb),
  private.cpsc_historical_backfill(jsonb, text, boolean, text, integer),
  private.cpsc_backfill_retract(uuid, text)
  from public, anon, authenticated, service_role;

revoke all on function
  public.invalidate_cpsc_review_decision(uuid, text),
  public.invalidate_cpsc_reviewer_decisions(uuid, timestamptz, timestamptz, text),
  public.record_cpsc_notice_revision(uuid, text, text, text, jsonb),
  public.get_cpsc_current_notice_revision(uuid)
  from public, anon, authenticated, service_role;
-- Human-only (functions additionally require the decision_invalidation capability).
grant execute on function
  public.invalidate_cpsc_review_decision(uuid, text),
  public.invalidate_cpsc_reviewer_decisions(uuid, timestamptz, timestamptz, text)
  to authenticated;
-- Worker-only (functions additionally require the service role).
grant execute on function
  public.record_cpsc_notice_revision(uuid, text, text, text, jsonb),
  public.get_cpsc_current_notice_revision(uuid)
  to service_role;

commit;
