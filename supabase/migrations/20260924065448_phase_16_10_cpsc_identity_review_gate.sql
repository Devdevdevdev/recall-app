-- Prepared locally only. Phase 16.9's reviewed artifact remains byte-for-byte unchanged.
begin;

alter table private.cpsc_source_identities add column identity_fingerprint text;
update private.cpsc_source_identities set identity_fingerprint =
  encode(sha256(convert_to('cpsc', 'UTF8') || decode('00', 'hex') ||
    convert_to(official_recall_number, 'UTF8')), 'hex');
alter table private.cpsc_source_identities
  alter column identity_fingerprint set not null;
create function private.cpsc_set_identity_fingerprint()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.identity_fingerprint := encode(sha256(convert_to('cpsc', 'UTF8') ||
    decode('00', 'hex') || convert_to(new.official_recall_number, 'UTF8')), 'hex');
  return new;
end;
$$;
create trigger cpsc_set_identity_fingerprint
  before insert or update of official_recall_number on private.cpsc_source_identities
  for each row execute function private.cpsc_set_identity_fingerprint();
create function private.cpsc_validate_identity_source()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.recall_sources source
    where source.id = new.source_id and source.source_key = 'cpsc'
      and source.is_authoritative) then
    raise exception 'CPSC identity requires authoritative CPSC source';
  end if;
  return new;
end;
$$;
create trigger cpsc_validate_identity_source
  before insert or update of source_id on private.cpsc_source_identities
  for each row execute function private.cpsc_validate_identity_source();
revoke all on function private.cpsc_set_identity_fingerprint(),
  private.cpsc_validate_identity_source()
  from public, anon, authenticated, service_role;
create unique index cpsc_source_identity_fingerprint_idx
  on private.cpsc_source_identities(identity_fingerprint);

-- Historical notices, scopes, matches, and alerts keep their original UUIDs.
create table private.cpsc_notice_identity_links (
  notice_id uuid primary key references public.recall_notices(id) on delete restrict,
  identity_id uuid not null references private.cpsc_source_identities(id) on delete restrict,
  linked_at timestamptz not null default now(),
  provenance text not null check (btrim(provenance) <> '')
);
create index cpsc_notice_identity_links_identity_idx
  on private.cpsc_notice_identity_links(identity_id);

-- Every API observation is append-only. A collision is evidence, never an alias
-- reassignment. Neither table contains owned-product data.
create table private.cpsc_identity_observations (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid references private.cpsc_source_identities(id) on delete restrict,
  upstream_api_id text not null check (upstream_api_id ~ '^[0-9]+$'),
  official_recall_number text not null check (official_recall_number ~ '^[0-9]{5}$'),
  observed_url text not null check (observed_url ~ '^https://(www\.)?cpsc\.gov/Recalls/'),
  canonical_url text not null check (canonical_url ~ '^https://www\.cpsc\.gov/Recalls/'),
  title text not null check (btrim(title) <> ''),
  publication_date date not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null,
  provenance text not null check (btrim(provenance) <> ''),
  resolution text not null check (resolution in ('resolved', 'quarantined')),
  reason text,
  check ((resolution = 'resolved' and identity_id is not null and reason is null)
      or (resolution = 'quarantined' and reason is not null))
);
create index cpsc_identity_observations_api_idx
  on private.cpsc_identity_observations(upstream_api_id, observed_at desc);
create index cpsc_identity_observations_identity_idx
  on private.cpsc_identity_observations(identity_id, observed_at desc);

-- This is an observation gate, not a recall-notice writer. It records a
-- quarantined conflict rather than trusting a reused numeric API ID.
create function public.record_cpsc_identity_observation(
  p_api_id text, p_recall_number text, p_observed_url text,
  p_canonical_url text, p_title text, p_publication_date date,
  p_payload_hash text, p_observed_at timestamptz, p_provenance text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_identity private.cpsc_source_identities%rowtype;
  v_by_url uuid;
  v_conflict uuid;
  v_legacy_conflict boolean;
  v_notice public.recall_notices%rowtype;
  v_reason text;
  v_observation_id uuid;
begin
  if p_api_id is null or p_recall_number is null or p_observed_url is null
    or p_canonical_url is null or p_payload_hash is null
    or p_api_id !~ '^[0-9]+$' or p_recall_number !~ '^[0-9]{5}$'
    or p_payload_hash !~ '^[0-9a-f]{64}$' or p_title is null
    or btrim(p_title) = '' or p_publication_date is null
    or p_observed_at is null or nullif(btrim(p_provenance), '') is null
    or p_observed_url !~ '^https://(www\.)?cpsc\.gov/Recalls/'
    or p_canonical_url !~ '^https://www\.cpsc\.gov/Recalls/' then
    raise exception 'Invalid CPSC observation';
  end if;
  if regexp_replace(
      regexp_replace(split_part(split_part(p_observed_url, '?', 1), '#', 1),
        '^https://cpsc\.gov', 'https://www.cpsc.gov'), '/$', ''
    ) <> p_canonical_url then
    raise exception 'Observed CPSC URL does not match canonical URL';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:identity:' || p_api_id));
  select identity.* into v_identity from private.cpsc_source_identities identity
    join public.recall_sources source on source.id = identity.source_id
    where identity.official_recall_number = p_recall_number
      and source.source_key = 'cpsc' for update of identity;
  select id into v_by_url from private.cpsc_source_identities
    where canonical_url = p_canonical_url;
  select identity_id into v_conflict from private.cpsc_source_aliases
    where alias_kind = 'api_id' and alias_value = p_api_id
      and identity_id is distinct from v_identity.id limit 1;
  select exists (
    select 1 from public.recall_notices notice
    join public.recall_sources source on source.id = notice.source_id
    where source.source_key = 'cpsc' and notice.external_id = p_api_id
      and not exists (
        select 1 from private.cpsc_notice_identity_links link
        where link.notice_id = notice.id and link.identity_id = v_identity.id
      )
  ) into v_legacy_conflict;

  if v_identity.id is null then
    v_reason := 'unknown official recall number';
  elsif v_identity.canonical_url <> p_canonical_url
    or (v_by_url is not null and v_by_url <> v_identity.id) then
    v_reason := 'official number and canonical URL conflict';
  elsif v_conflict is not null or v_legacy_conflict then
    v_reason := 'API ID belongs to another historical recall';
  else
    select * into v_notice from public.recall_notices
      where id = v_identity.canonical_notice_id;
    if v_notice.id is null or v_notice.recall_date <> p_publication_date
      or regexp_replace(
        regexp_replace(split_part(split_part(v_notice.official_url, '?', 1), '#', 1),
          '^https://cpsc\.gov', 'https://www.cpsc.gov'), '/$', ''
      ) <> v_identity.canonical_url
      or lower(regexp_replace(btrim(v_notice.title), '\s+', ' ', 'g')) <>
         lower(regexp_replace(btrim(p_title), '\s+', ' ', 'g')) then
      v_reason := 'title or publication date conflicts with official recall';
    end if;
  end if;

  insert into private.cpsc_identity_observations (
    identity_id, upstream_api_id, official_recall_number,
    observed_url, canonical_url, title, publication_date,
    payload_hash, observed_at, provenance, resolution, reason
  ) values (
    v_identity.id, p_api_id, p_recall_number,
    p_observed_url, p_canonical_url, p_title, p_publication_date,
    p_payload_hash, p_observed_at, p_provenance,
    case when v_reason is null then 'resolved' else 'quarantined' end,
    v_reason
  ) returning id into v_observation_id;

  if v_reason is not null then
    return jsonb_build_object('status', 'quarantined',
      'observationId', v_observation_id, 'reason', v_reason);
  end if;
  insert into private.cpsc_source_aliases (
    identity_id, notice_id, alias_kind, alias_value, provenance,
    first_seen_at, last_seen_at
  ) values (
    v_identity.id, v_identity.canonical_notice_id, 'api_id', p_api_id,
    p_provenance, p_observed_at, p_observed_at
  ) on conflict (identity_id, alias_kind, alias_value, provenance)
    do update set last_seen_at = greatest(cpsc_source_aliases.last_seen_at, excluded.last_seen_at);
  insert into private.cpsc_source_aliases (
    identity_id, notice_id, alias_kind, alias_value, provenance,
    first_seen_at, last_seen_at
  ) values (
    v_identity.id, v_identity.canonical_notice_id, 'official_url',
    p_observed_url, p_provenance, p_observed_at, p_observed_at
  ) on conflict (identity_id, alias_kind, alias_value, provenance)
    do update set last_seen_at = greatest(cpsc_source_aliases.last_seen_at, excluded.last_seen_at);
  insert into private.cpsc_api_revisions (
    identity_id, upstream_api_id, payload_hash, provenance,
    first_seen_at, last_seen_at
  ) values (
    v_identity.id, p_api_id, p_payload_hash, p_provenance,
    p_observed_at, p_observed_at
  ) on conflict (identity_id, upstream_api_id, payload_hash)
    do update set last_seen_at = greatest(cpsc_api_revisions.last_seen_at, excluded.last_seen_at);
  return jsonb_build_object('status', 'resolved',
    'observationId', v_observation_id, 'identityId', v_identity.id,
    'canonicalNoticeId', v_identity.canonical_notice_id);
end;
$$;
revoke all on function public.record_cpsc_identity_observation(
  text, text, text, text, text, date, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.record_cpsc_identity_observation(
  text, text, text, text, text, date, text, timestamptz, text
) to service_role;

alter table private.cpsc_page_revisions
  add column parser_version text not null default 'phase-16.9-v1'
    check (btrim(parser_version) <> ''),
  add column table_identities jsonb not null default '[]'::jsonb
    check (jsonb_typeof(table_identities) = 'array');
-- A page snapshot of one recall must never be attached to another identity.
create function private.cpsc_validate_page_revision_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from private.cpsc_source_identities identity
    where identity.id = new.identity_id
      and identity.official_recall_number = new.recall_number
      and identity.canonical_url = new.canonical_url) then
    raise exception 'CPSC page revision does not match its canonical identity';
  end if;
  return new;
end;
$$;
create trigger cpsc_validate_page_revision_identity
  before insert or update on private.cpsc_page_revisions
  for each row execute function private.cpsc_validate_page_revision_identity();
revoke all on function private.cpsc_validate_page_revision_identity()
  from public, anon, authenticated, service_role;
alter table private.cpsc_page_fetches
  add column content_type text,
  add column etag text,
  add column last_modified text,
  add column redirect_chain jsonb not null default '[]'::jsonb
    check (jsonb_typeof(redirect_chain) = 'array');
alter table private.cpsc_candidate_criteria
  add column parser_version text not null default 'phase-16.9-v1'
    check (btrim(parser_version) <> '');

-- The reviewed row is a complete historical attestation; subsequent source
-- revisions append a stale event rather than altering it.
alter table private.cpsc_candidate_review_ledger
  add column normalized_criterion jsonb,
  add column reviewed_operator text,
  add column conjunction_key text,
  add column mandatory_eligibility boolean,
  add column review_note text;

create table private.cpsc_reviewer_authorizations (
  user_id uuid primary key references auth.users(id) on delete restrict,
  authorized_by uuid references auth.users(id) on delete restrict,
  authorized_at timestamptz not null default now(),
  revoked_at timestamptz,
  reason text not null check (btrim(reason) <> '')
);

alter table private.cpsc_notice_identity_links enable row level security;
alter table private.cpsc_identity_observations enable row level security;
alter table private.cpsc_reviewer_authorizations enable row level security;
revoke all on private.cpsc_notice_identity_links,
  private.cpsc_identity_observations, private.cpsc_reviewer_authorizations
  from public, anon, authenticated, service_role;
revoke all on private.cpsc_source_identities, private.cpsc_source_aliases,
  private.cpsc_api_revisions, private.cpsc_page_revisions
  from service_role;
grant select on private.cpsc_source_identities to service_role;
grant select, insert on private.cpsc_page_revisions to service_role;
grant select on private.cpsc_identity_observations to service_role;

-- PostgREST sets only request.jwt.claims; auth.role() reads it (and the legacy
-- GUC). The result is never NULL, because `if not NULL` would skip the check.
create function private.cpsc_is_human_reviewer()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(auth.role() = 'authenticated'
    and auth.uid() is not null
    and exists (
      select 1 from private.cpsc_reviewer_authorizations r
      where r.user_id = auth.uid() and r.revoked_at is null
    ), false);
$$;
revoke all on function private.cpsc_is_human_reviewer() from public, anon, authenticated, service_role;

-- This packet is the future review UI contract. It exposes exact evidence and
-- every member of the proposed conjunction to an authorized human only.
create function public.get_cpsc_candidate_review_packet(p_candidate_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_packet jsonb;
begin
  if not private.cpsc_is_human_reviewer() then
    raise exception 'CPSC human reviewer authorization required' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'candidateId', c.id, 'officialUrl', r.canonical_url,
    'recallNumber', r.recall_number, 'sourceRevision', r.evidence_hash,
    'evidenceAddress', c.evidence_address,
    'authoritativeExcerpt', c.authoritative_excerpt,
    'normalizedCriterion', c.criterion_value,
    'criterionKind', c.criterion_kind, 'operator', c.proposed_operator,
    'conjunctionGroup', c.conjunction_key, 'parserVersion', c.parser_version,
    'allConjuncts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'candidateId', sibling.id, 'kind', sibling.criterion_kind,
        'operator', sibling.proposed_operator, 'value', sibling.criterion_value,
        'excerpt', sibling.authoritative_excerpt, 'evidenceAddress', sibling.evidence_address
      ) order by sibling.id), '[]'::jsonb)
      from private.cpsc_candidate_criteria sibling
      where sibling.revision_id = c.revision_id
        and coalesce(sibling.conjunction_key, sibling.id::text) =
          coalesce(c.conjunction_key, c.id::text)
    )
  ) into v_packet
  from private.cpsc_candidate_criteria c
  join private.cpsc_page_revisions r on r.id = c.revision_id
  where c.id = p_candidate_id;
  return v_packet;
end;
$$;
revoke all on function public.get_cpsc_candidate_review_packet(uuid)
  from public, anon, service_role;
grant execute on function public.get_cpsc_candidate_review_packet(uuid) to authenticated;

create function public.decide_cpsc_candidate(
  p_candidate_id uuid,
  p_decision text,
  p_mandatory_eligibility boolean,
  p_review_note text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_candidate private.cpsc_candidate_criteria%rowtype;
  v_revision private.cpsc_page_revisions%rowtype;
  v_latest text;
  v_ledger_id uuid;
begin
  if not private.cpsc_is_human_reviewer() then
    raise exception 'CPSC human reviewer authorization required' using errcode = '42501';
  end if;
  if p_decision not in ('reviewed', 'rejected') then
    raise exception 'Invalid human review decision';
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
  -- Equal timestamps are ambiguous, so both revisions count as stale.
  if exists (
    select 1 from private.cpsc_page_revisions newer
    where newer.identity_id = v_revision.identity_id
      and newer.id <> v_revision.id
      and newer.first_seen_at >= v_revision.first_seen_at
  ) then raise exception 'Candidate source revision is stale'; end if;
  select decision into v_latest from private.cpsc_candidate_review_ledger
    where candidate_id = p_candidate_id order by decided_at desc, id desc limit 1;
  if v_latest is not null then raise exception 'Candidate already has a decision'; end if;
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
revoke all on function public.decide_cpsc_candidate(uuid, text, boolean, text)
  from public, anon, service_role;
grant execute on function public.decide_cpsc_candidate(uuid, text, boolean, text)
  to authenticated;

create function private.cpsc_stale_review_on_semantic_revision()
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
    order by l0.decided_at desc, l0.id desc limit 1
  ) l on true
  where prior_revision.identity_id = new.identity_id
    and prior_revision.id <> new.id
    and prior_revision.evidence_hash <> new.evidence_hash
    and l.decision = 'reviewed';
  return new;
end;
$$;
create trigger cpsc_stale_review_after_revision
  after insert on private.cpsc_page_revisions
  for each row execute function private.cpsc_stale_review_on_semantic_revision();
revoke all on function private.cpsc_stale_review_on_semantic_revision()
  from public, anon, authenticated, service_role;

-- A conjunction is usable only as a whole: approving `model` while its paired
-- `date_code` is unreviewed, rejected, or stale would widen the recall scope.
create view private.cpsc_current_reviewed_criteria
with (security_invoker = true) as
with member as (
  select c.id as candidate_id, c.revision_id,
    coalesce(c.conjunction_key, c.id::text) as conjunction_group,
    l.id as review_event_id, l.reviewer_user_id, l.decided_at as reviewed_at,
    l.attested_scope_id, l.source_revision_hash, l.evidence_address,
    l.normalized_criterion, l.reviewed_operator, l.conjunction_key,
    coalesce(l.decision = 'reviewed'
      and l.mandatory_eligibility is true
      and l.source_revision_hash = revision.evidence_hash
      and not exists (
        select 1 from private.cpsc_page_revisions newer
        where newer.identity_id = revision.identity_id
          and newer.id <> revision.id
          and newer.first_seen_at >= revision.first_seen_at
      ), false) as usable
  from private.cpsc_candidate_criteria c
  join private.cpsc_page_revisions revision on revision.id = c.revision_id
  left join lateral (
    select event.* from private.cpsc_candidate_review_ledger event
    where event.candidate_id = c.id
    order by event.decided_at desc, event.id desc limit 1
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

-- No candidate table or ledger grants reach normal consumers or the worker.
-- The original v2 matcher still reads only private.recall_scope_criteria_v2.

-- The service API must not bypass identity resolution through legacy numeric-ID RPCs.
revoke execute on function public.ingest_cpsc_recall(text,text,text,text,text,date,text,timestamptz,jsonb,jsonb) from service_role;

create or replace function public.ingest_authoritative_recall(
  p_source_key text,
  p_external_id text,
  p_title text,
  p_description text,
  p_hazard text,
  p_remedy text,
  p_recall_date date,
  p_official_url text,
  p_retrieved_at timestamptz,
  p_raw_payload jsonb,
  p_scopes jsonb,
  p_jurisdictions jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_id uuid;
  v_notice_id uuid;
  v_notice_changed boolean;
  v_inserted boolean := false;
  scope jsonb;
  jurisdiction jsonb;
begin
  if p_source_key = 'cpsc' and (coalesce(auth.role(), '') = 'service_role'
      or coalesce(current_setting('role', true), '') = 'service_role') then
    raise exception 'CPSC ingestion requires canonical identity observation gate' using errcode = '42501';
  end if;
  select id into v_source_id
  from public.recall_sources as recall_source
  where recall_source.source_key = p_source_key
    and recall_source.is_authoritative
    and recall_source.is_active
  for update;

  if v_source_id is null then
    raise exception 'recall source is not active';
  end if;
  if p_external_id is null or pg_catalog.btrim(p_external_id) = '' then
    raise exception 'external id is required';
  end if;
  if p_title is null or pg_catalog.btrim(p_title) = '' then
    raise exception 'title is required';
  end if;
  if p_recall_date is null or p_official_url is null or p_retrieved_at is null then
    raise exception 'recall date, official URL, and retrieval time are required';
  end if;
  if pg_catalog.jsonb_typeof(p_raw_payload) <> 'object' then
    raise exception 'raw payload must be an object';
  end if;
  if pg_catalog.jsonb_typeof(p_scopes) <> 'array'
    or pg_catalog.jsonb_typeof(p_jurisdictions) <> 'array' then
    raise exception 'scopes and jurisdictions must be arrays';
  end if;

  select id,
    title is distinct from p_title
      or description is distinct from p_description
      or hazard is distinct from p_hazard
      or remedy is distinct from p_remedy
      or recall_date is distinct from p_recall_date
      or official_url is distinct from p_official_url
      or raw_payload is distinct from p_raw_payload
  into v_notice_id, v_notice_changed
  from public.recall_notices as recall_notice
  where recall_notice.source_id = v_source_id
    and recall_notice.external_id = p_external_id
  for update;

  if v_notice_id is null then
    insert into public.recall_notices (
      source_id, external_id, title, description, hazard, remedy, recall_date,
      official_url, retrieved_at, raw_payload
    ) values (
      v_source_id, p_external_id, p_title, p_description, p_hazard, p_remedy,
      p_recall_date, p_official_url, p_retrieved_at, p_raw_payload
    ) returning id into v_notice_id;
    v_notice_changed := true;
    v_inserted := true;
  elsif v_notice_changed then
    update public.recall_notices
    set
      title = p_title,
      description = p_description,
      hazard = p_hazard,
      remedy = p_remedy,
      recall_date = p_recall_date,
      official_url = p_official_url,
      retrieved_at = p_retrieved_at,
      raw_payload = p_raw_payload
    where id = v_notice_id;
  else
    update public.recall_notices
    set retrieved_at = p_retrieved_at
    where id = v_notice_id;
  end if;

  if v_notice_changed then
    delete from public.recall_scopes where recall_notice_id = v_notice_id;
    for scope in select value from pg_catalog.jsonb_array_elements(p_scopes)
    loop
      insert into public.recall_scopes (
        recall_notice_id, brand, product_name, gtin, model_number,
        lot_from, lot_to, serial_from, serial_to, additional_criteria
      ) values (
        v_notice_id,
        nullif(pg_catalog.btrim(scope ->> 'brand'), ''),
        nullif(pg_catalog.btrim(scope ->> 'productName'), ''),
        nullif(pg_catalog.btrim(scope ->> 'gtin'), ''),
        nullif(pg_catalog.btrim(scope ->> 'modelNumber'), ''),
        nullif(pg_catalog.btrim(scope ->> 'lotFrom'), ''),
        nullif(pg_catalog.btrim(scope ->> 'lotTo'), ''),
        nullif(pg_catalog.btrim(scope ->> 'serialFrom'), ''),
        nullif(pg_catalog.btrim(scope ->> 'serialTo'), ''),
        case
          when pg_catalog.jsonb_typeof(scope -> 'additionalCriteria') = 'object'
            then scope -> 'additionalCriteria'
          else null
        end
      );
    end loop;

    delete from public.recall_notice_jurisdictions where recall_notice_id = v_notice_id;
    for jurisdiction in select value from pg_catalog.jsonb_array_elements(p_jurisdictions)
    loop
      insert into public.recall_notice_jurisdictions (
        recall_notice_id, jurisdiction_type, jurisdiction_code
      ) values (
        v_notice_id,
        jurisdiction ->> 'type',
        jurisdiction ->> 'code'
      );
    end loop;
  end if;

  return case
    when v_inserted then 'inserted'
    when v_notice_changed then 'updated'
    else 'unchanged'
  end;
end;
$$;

commit;
