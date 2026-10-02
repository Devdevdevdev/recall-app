-- Phase 16.16A: durable CPSC source payloads, idempotent quarantine replay, and a
-- database-enforced watermark safety rule. Prepared locally only. Additive and
-- forward-only: no earlier migration is edited, no existing table is rewritten,
-- and the 9-argument observation RPC keeps its body and grants. Nothing here
-- ingests, reconciles, attaches payloads, or activates anything.
begin;

-- ===========================================================================
-- Hash contract `cpsc-canonical-json-sha256/v1`: SHA-256 over the UTF-8 bytes of
-- canonical JSON. Object keys are sorted by code point (C collation) at every
-- depth, arrays keep their order, there is no whitespace, strings use PostgreSQL
-- JSON escaping, and numbers use their jsonb text. It produces the same text as
-- 16.12's private.cpsc_canonical_json using only immutable operations (jsonb
-- output and keyvalue() share PostgreSQL's escape_json), so a generated column can
-- compute it. It equals the worker's sourcePayloadSha256 on every captured payload.
-- There is no raw-byte hash: the CPSC API returns one array per window, so a
-- single record has no stable transport byte range to hash.
-- ===========================================================================
create function private.cpsc_canonical_json_v1(p_value jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare v_out text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{' || coalesce(string_agg((pair -> 'key')::text || ':' ||
          private.cpsc_canonical_json_v1(pair -> 'value'), ','
          order by pair ->> 'key' collate "C"), '') || '}'
        into v_out from jsonb_path_query(p_value, '$.keyvalue()') pair;
      return v_out;
    when 'array' then
      select '[' || coalesce(string_agg(private.cpsc_canonical_json_v1(item.value), ','
          order by item.ordinality), '') || ']'
        into v_out from jsonb_array_elements(p_value) with ordinality item;
      return v_out;
    else
      -- Scalars (string, number, boolean, null) as jsonb prints them.
      return p_value::text;
  end case;
end;
$$;

create function private.cpsc_payload_sha256_v1(p_payload jsonb)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(private.cpsc_canonical_json_v1(p_payload), 'UTF8')), 'hex');
$$;

-- ===========================================================================
-- Source revisions: one row per distinct authoritative CPSC API payload.
-- The key is computed by the database from the stored payload, so a caller can
-- never store a payload under a hash that does not belong to it. A changed payload
-- has a different hash and becomes a new row. No row is ever updated or deleted.
-- Public CPSC source data only: no owned-product, user, or credential data.
-- ===========================================================================
create table private.cpsc_observation_payloads (
  canonical_payload_sha256 text
    generated always as (private.cpsc_payload_sha256_v1(payload)) stored primary key,
  revision_seq bigint generated always as identity unique,
  payload jsonb not null,
  upstream_api_id text generated always as (payload ->> 'RecallID') stored,
  official_recall_number text
    generated always as (private.cpsc_payload_recall_number(payload)) stored,
  canonical_payload_bytes integer
    generated always as (octet_length(private.cpsc_canonical_json_v1(payload))) stored,
  hash_contract text not null default 'cpsc-canonical-json-sha256/v1'
    check (hash_contract = 'cpsc-canonical-json-sha256/v1'),
  payload_contract text not null default 'cpsc-recall-api-record/v1'
    check (payload_contract = 'cpsc-recall-api-record/v1'),
  recorded_via text not null
    check (recorded_via in ('worker_observation', 'captured_payload_attachment')),
  provenance text not null check (btrim(provenance) <> '' and length(provenance) <= 500),
  recorded_at timestamptz not null default now(),
  constraint cpsc_observation_payloads_object check (jsonb_typeof(payload) = 'object'),
  constraint cpsc_observation_payloads_size check (canonical_payload_bytes <= 262144),
  constraint cpsc_observation_payloads_api_id check (
    jsonb_typeof(payload -> 'RecallID') in ('number', 'string')
    and upstream_api_id ~ '^[0-9]{1,18}$'),
  constraint cpsc_observation_payloads_recall_number check (official_recall_number is not null),
  constraint cpsc_observation_payloads_url check (
    jsonb_typeof(payload -> 'URL') = 'string'
    and private.cpsc_canonical_url(payload ->> 'URL') is not null),
  constraint cpsc_observation_payloads_title check (
    jsonb_typeof(payload -> 'Title') = 'string' and btrim(payload ->> 'Title') <> ''),
  constraint cpsc_observation_payloads_recall_date check (
    jsonb_typeof(payload -> 'RecallDate') = 'string'
    and payload ->> 'RecallDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
);
create index cpsc_observation_payloads_lineage_idx
  on private.cpsc_observation_payloads(upstream_api_id, official_recall_number, revision_seq);
alter table private.cpsc_observation_payloads enable row level security;
create trigger cpsc_observation_payloads_append_only
  before update or delete on private.cpsc_observation_payloads
  for each row execute function private.cpsc_append_only();
create trigger cpsc_observation_payloads_no_truncate
  before truncate on private.cpsc_observation_payloads
  for each statement execute function private.cpsc_append_only();

-- Supports retention joins and quarantine replay lookups.
create index cpsc_identity_observations_payload_idx
  on private.cpsc_identity_observations(payload_hash);

-- ===========================================================================
-- Repeat sightings. Compact counters live beside the append-only observation,
-- never in it: the observation (the review item) is written once.
-- ===========================================================================
create table private.cpsc_observation_sightings (
  observation_id uuid primary key
    references private.cpsc_identity_observations(id) on delete restrict,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  seen_count bigint not null check (seen_count >= 1),
  last_provenance text not null
    check (btrim(last_provenance) <> '' and length(last_provenance) <= 200),
  check (last_seen_at >= first_seen_at)
);
alter table private.cpsc_observation_sightings enable row level security;

create function private.cpsc_guard_sighting_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'CPSC sightings are never deleted' using errcode = '42501';
  end if;
  if new.observation_id <> old.observation_id or new.first_seen_at <> old.first_seen_at
    or new.seen_count <= old.seen_count or new.last_seen_at < old.last_seen_at then
    raise exception 'CPSC sightings only move forward' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger cpsc_guard_sighting_update
  before update or delete on private.cpsc_observation_sightings
  for each row execute function private.cpsc_guard_sighting_update();
create trigger cpsc_observation_sightings_no_truncate
  before truncate on private.cpsc_observation_sightings
  for each statement execute function private.cpsc_append_only();

-- ===========================================================================
-- Retention is derived, never asserted: an observation's payload is retained iff
-- a stored source revision has the same database-computed hash AND the same API
-- ID and recall number. Everything else is `legacy_hash_only`, including every
-- observation recorded before this migration (none is rewritten or fabricated).
-- ===========================================================================
create view private.cpsc_observation_payload_retention
with (security_invoker = true) as
select o.id as observation_id, o.observation_seq, o.upstream_api_id,
  o.official_recall_number, o.resolution, o.decision_class, o.payload_hash,
  o.observed_at, payload.recorded_via, payload.revision_seq,
  case when payload.canonical_payload_sha256 is null then 'legacy_hash_only'
    else 'retained' end as payload_retention
from private.cpsc_identity_observations o
left join private.cpsc_observation_payloads payload
  on payload.canonical_payload_sha256 = o.payload_hash
  and payload.upstream_api_id = o.upstream_api_id
  and payload.official_recall_number = o.official_recall_number;

-- Watermark rule: the CPSC watermark may advance only while every quarantined
-- observation retains its reviewable source payload. Resolved observations are
-- accounted for by canonical identity state. A hash-only quarantine (from any
-- path, legacy or not, reconciled or not) is never watermark-safe.
create function private.cpsc_watermark_safety()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'contract', 'cpsc-watermark-safety/v1',
    'safe', count(*) filter (where r.payload_retention <> 'retained') = 0,
    'quarantined', count(*),
    'retained', count(*) filter (where r.payload_retention = 'retained'),
    'legacyHashOnly', count(*) filter (where r.payload_retention = 'legacy_hash_only'),
    'unaccounted', coalesce(jsonb_agg(jsonb_build_object(
        'observationId', r.observation_id, 'apiId', r.upstream_api_id,
        'recallNumber', r.official_recall_number, 'payloadHash', r.payload_hash,
        'decisionClass', r.decision_class)
        order by r.observation_seq) filter (where r.payload_retention <> 'retained'), '[]'::jsonb))
  from private.cpsc_observation_payload_retention r
  where r.resolution = 'quarantined';
$$;

create function private.cpsc_guard_watermark_advance()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_safety jsonb;
begin
  if new.watermark is null
    or (tg_op = 'UPDATE' and new.watermark is not distinct from old.watermark) then
    return new;
  end if;
  if not exists (select 1 from public.recall_sources source
    where source.id = new.source_id and source.source_key = 'cpsc') then
    return new;
  end if;
  v_safety := private.cpsc_watermark_safety();
  if not coalesce((v_safety ->> 'safe')::boolean, false) then
    raise exception 'CPSC watermark cannot advance: % quarantined observation(s) lack a retained source payload',
      jsonb_array_length(v_safety -> 'unaccounted') using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger cpsc_guard_watermark_advance
  before insert or update of watermark on private.recall_source_sync_state
  for each row execute function private.cpsc_guard_watermark_advance();

-- ===========================================================================
-- Worker RPC: the identity decision is made by the unchanged 16.11 gate
-- (public.record_cpsc_identity_observation), so there is one decision matrix.
-- This wrapper verifies and stores the payload first, then replays an identical
-- quarantine onto its existing review item instead of appending a new one.
-- It cannot reconcile, review, create criteria, or invalidate decisions.
-- ===========================================================================
create function public.record_cpsc_retained_observation(
  p_api_id text, p_recall_number text, p_observed_url text,
  p_canonical_url text, p_title text, p_publication_date date,
  p_payload_hash text, p_observed_at timestamptz, p_provenance text,
  p_raw_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text;
  v_payload_recorded boolean;
  v_result jsonb;
  v_prior private.cpsc_identity_observations%rowtype;
  v_seen_count bigint;
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  -- Cheap bound before canonicalizing, then the exact bound on the hashed bytes.
  if p_raw_payload is null or jsonb_typeof(p_raw_payload) <> 'object'
    or pg_column_size(p_raw_payload) > 1048576
    or octet_length(private.cpsc_canonical_json_v1(p_raw_payload)) > 262144 then
    raise exception 'Invalid CPSC source payload' using errcode = '22023';
  end if;
  v_hash := private.cpsc_payload_sha256_v1(p_raw_payload);
  if p_payload_hash is distinct from v_hash then
    raise exception 'CPSC payload hash does not match its payload' using errcode = '22023';
  end if;
  if p_raw_payload ->> 'RecallID' is distinct from p_api_id
    or private.cpsc_payload_recall_number(p_raw_payload) is distinct from p_recall_number
    or btrim(p_raw_payload ->> 'URL') is distinct from p_observed_url
    or left(p_raw_payload ->> 'RecallDate', 10)
      is distinct from to_char(p_publication_date, 'YYYY-MM-DD')
    or coalesce(strpos(p_raw_payload ->> 'Title', p_title), 0) = 0 then
    raise exception 'CPSC payload does not match its observation' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:identity-decisions'));

  insert into private.cpsc_observation_payloads (payload, recorded_via, provenance)
  values (p_raw_payload, 'worker_observation', p_provenance)
  on conflict (canonical_payload_sha256) do nothing;
  v_payload_recorded := found;

  begin
    v_result := public.record_cpsc_identity_observation(p_api_id, p_recall_number,
      p_observed_url, p_canonical_url, p_title, p_publication_date, v_hash,
      p_observed_at, p_provenance);
    if v_result ->> 'status' = 'quarantined' then
      select o.* into v_prior from private.cpsc_identity_observations o
      where o.id <> (v_result ->> 'observationId')::uuid
        and o.resolution = 'quarantined' and o.payload_hash = v_hash
        and o.upstream_api_id = p_api_id and o.official_recall_number = p_recall_number
        and o.observed_url = p_observed_url and o.canonical_url = p_canonical_url
        and o.title = p_title and o.publication_date = p_publication_date
        and o.decision_class = v_result ->> 'decisionClass'
        and o.reason = v_result ->> 'reason'
      order by o.observation_seq limit 1;
      if v_prior.id is not null then
        -- Same source revision, same decision: undo the duplicate review item.
        raise exception 'replayed CPSC quarantine' using errcode = 'RCQ01';
      end if;
    end if;
  exception when sqlstate 'RCQ01' then
    null;
  end;

  if not exists (select 1 from private.cpsc_observation_payloads payload
    where payload.canonical_payload_sha256 = v_hash and payload.upstream_api_id = p_api_id
      and payload.official_recall_number = p_recall_number) then
    raise exception 'CPSC source payload was not retained';
  end if;

  if v_prior.id is not null then
    insert into private.cpsc_observation_sightings as sighting (
      observation_id, first_seen_at, last_seen_at, seen_count, last_provenance
    ) values (
      v_prior.id, v_prior.observed_at, greatest(v_prior.observed_at, p_observed_at), 2,
      p_provenance
    ) on conflict (observation_id) do update
      set last_seen_at = greatest(sighting.last_seen_at, excluded.last_seen_at),
        seen_count = sighting.seen_count + 1, last_provenance = excluded.last_provenance
    returning sighting.seen_count into v_seen_count;
    return jsonb_build_object('status', 'quarantined', 'observationId', v_prior.id,
      'reason', v_prior.reason, 'decisionClass', v_prior.decision_class,
      'replayed', true, 'seenCount', v_seen_count, 'payloadSha256', v_hash,
      'payloadRetention', 'retained', 'payloadRecorded', v_payload_recorded);
  end if;
  if v_result ->> 'status' = 'quarantined' then
    insert into private.cpsc_observation_sightings (
      observation_id, first_seen_at, last_seen_at, seen_count, last_provenance
    ) values ((v_result ->> 'observationId')::uuid, p_observed_at, p_observed_at, 1, p_provenance);
    return v_result || jsonb_build_object('replayed', false, 'seenCount', 1,
      'payloadSha256', v_hash, 'payloadRetention', 'retained',
      'payloadRecorded', v_payload_recorded);
  end if;
  return v_result || jsonb_build_object('payloadSha256', v_hash,
    'payloadRetention', 'retained', 'payloadRecorded', v_payload_recorded);
end;
$$;

-- ===========================================================================
-- Reconciliation packet: 16.11 fields unchanged, plus the stored source payload,
-- its database re-verified hash, sightings, and the source-revision lineage for
-- the same API ID and recall number, so review never needs a CPSC refetch.
-- ===========================================================================
create or replace function private.cpsc_quarantine_evidence(p_observation_id uuid)
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
      from private.cpsc_identity_reconciliations r where r.observation_id = o.id), '[]'::jsonb),
    'payloadRetention', case when source_revision.canonical_payload_sha256 is null
      then 'legacy_hash_only' else 'retained' end,
    'sourceRevision', case when source_revision.canonical_payload_sha256 is not null then
      jsonb_build_object(
        'payloadSha256', source_revision.canonical_payload_sha256,
        'hashVerified', source_revision.canonical_payload_sha256
          = private.cpsc_payload_sha256_v1(source_revision.payload),
        'hashContract', source_revision.hash_contract,
        'payloadContract', source_revision.payload_contract,
        'revisionSeq', source_revision.revision_seq,
        'recordedVia', source_revision.recorded_via,
        'recordedAt', source_revision.recorded_at,
        'provenance', source_revision.provenance,
        'payloadBytes', source_revision.canonical_payload_bytes,
        'payload', source_revision.payload) end,
    'sightings', coalesce((select jsonb_build_object('firstSeenAt', s.first_seen_at,
        'lastSeenAt', s.last_seen_at, 'seenCount', s.seen_count)
      from private.cpsc_observation_sightings s where s.observation_id = o.id),
      jsonb_build_object('firstSeenAt', o.observed_at, 'lastSeenAt', o.observed_at,
        'seenCount', 1)),
    'sourceRevisionLineage', coalesce((select jsonb_agg(jsonb_build_object(
        'payloadSha256', p.canonical_payload_sha256, 'revisionSeq', p.revision_seq,
        'recordedVia', p.recorded_via, 'recordedAt', p.recorded_at,
        'thisObservation', p.canonical_payload_sha256 = o.payload_hash,
        'quarantinedObservationIds', coalesce((select jsonb_agg(q.id order by q.observation_seq)
          from private.cpsc_identity_observations q
          where q.resolution = 'quarantined' and q.payload_hash = p.canonical_payload_sha256
            and q.upstream_api_id = p.upstream_api_id
            and q.official_recall_number = p.official_recall_number), '[]'::jsonb))
        order by p.revision_seq)
      from private.cpsc_observation_payloads p
      where p.upstream_api_id = o.upstream_api_id
        and p.official_recall_number = o.official_recall_number), '[]'::jsonb))
  from private.cpsc_identity_observations o
  left join private.cpsc_observation_payloads source_revision
    on source_revision.canonical_payload_sha256 = o.payload_hash
    and source_revision.upstream_api_id = o.upstream_api_id
    and source_revision.official_recall_number = o.official_recall_number
  where o.id = p_observation_id;
$$;

-- ===========================================================================
-- Bounded attachment of captured payloads to EXISTING quarantined observations
-- (owner-only; never granted, never invoked here). An item is accepted only if
-- its database-computed hash equals the hash that a quarantined observation
-- already recorded for the same API ID and recall number, so it can only supply
-- the exact preimage of recorded evidence. It never writes an observation,
-- identity, alias, notice, reconciliation, or criterion. Idempotent; all-or-nothing.
-- ===========================================================================
create function private.cpsc_attach_captured_payloads(p_attachment jsonb, p_execute boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_hash text;
  v_observations jsonb;
  v_present boolean;
  v_attached integer := 0;
  v_already integer := 0;
  v_report jsonb := '[]'::jsonb;
  v_provenance text;
begin
  if p_execute is null or jsonb_typeof(p_attachment) is distinct from 'object'
    or p_attachment ->> 'attachmentVersion' is distinct from 'phase-16.16a-captured-payload-attachment-v1'
    or p_attachment ->> 'apiRoot' is distinct from 'https://www.saferproducts.gov/RestWebServices/Recall'
    or coalesce(p_attachment ->> 'captureSha256', '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_attachment ->> 'capturedAtUtc', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    or jsonb_typeof(p_attachment -> 'items') is distinct from 'array'
    or jsonb_array_length(p_attachment -> 'items') not between 1 and 50
    or (select count(distinct value ->> 'payloadSha256')
      from jsonb_array_elements(p_attachment -> 'items')) <> jsonb_array_length(p_attachment -> 'items') then
    raise exception 'Invalid captured payload attachment' using errcode = '22023';
  end if;
  v_provenance := 'Phase 16.16A captured payload attachment; capture sha256 '
    || (p_attachment ->> 'captureSha256') || ' at ' || (p_attachment ->> 'capturedAtUtc');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:identity-decisions'));

  for v_item in select value from jsonb_array_elements(p_attachment -> 'items') order by value ->> 'recallNumber'
  loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or (select count(*) from jsonb_object_keys(v_item)) <> 4
      or jsonb_typeof(v_item -> 'payload') is distinct from 'object'
      or coalesce(v_item ->> 'apiId', '') !~ '^[0-9]{1,18}$'
      or coalesce(v_item ->> 'recallNumber', '') !~ '^[0-9]{5}$'
      or octet_length(private.cpsc_canonical_json_v1(v_item -> 'payload')) > 262144 then
      raise exception 'Invalid captured payload item' using errcode = '22023';
    end if;
    v_hash := private.cpsc_payload_sha256_v1(v_item -> 'payload');
    if v_hash is distinct from v_item ->> 'payloadSha256' then
      raise exception 'Captured payload hash mismatch for recall %', v_item ->> 'recallNumber'
        using errcode = '22023';
    end if;
    if v_item -> 'payload' ->> 'RecallID' is distinct from v_item ->> 'apiId'
      or private.cpsc_payload_recall_number(v_item -> 'payload') is distinct from v_item ->> 'recallNumber' then
      raise exception 'Captured payload identity mismatch for recall %', v_item ->> 'recallNumber'
        using errcode = '22023';
    end if;
    select jsonb_agg(o.id order by o.observation_seq) into v_observations
    from private.cpsc_identity_observations o
    where o.resolution = 'quarantined' and o.payload_hash = v_hash
      and o.upstream_api_id = v_item ->> 'apiId'
      and o.official_recall_number = v_item ->> 'recallNumber';
    if v_observations is null then
      raise exception 'No quarantined observation recorded payload % for recall %',
        v_hash, v_item ->> 'recallNumber' using errcode = '22023';
    end if;
    v_present := exists (select 1 from private.cpsc_observation_payloads p
      where p.canonical_payload_sha256 = v_hash);
    if p_execute and not v_present then
      insert into private.cpsc_observation_payloads (payload, recorded_via, provenance)
      values (v_item -> 'payload', 'captured_payload_attachment', v_provenance);
    end if;
    if v_present then v_already := v_already + 1; else v_attached := v_attached + 1; end if;
    v_report := v_report || jsonb_build_object('recallNumber', v_item ->> 'recallNumber',
      'apiId', v_item ->> 'apiId', 'payloadSha256', v_hash,
      'quarantinedObservationIds', v_observations,
      'action', case when v_present then 'already_retained'
        when p_execute then 'attached' else 'would_attach' end);
  end loop;
  return jsonb_build_object('execute', p_execute, 'items', jsonb_array_length(v_report),
    'attached', case when p_execute then v_attached else 0 end,
    'wouldAttach', case when p_execute then 0 else v_attached end,
    'alreadyRetained', v_already, 'report', v_report,
    'watermarkSafety', private.cpsc_watermark_safety());
end;
$$;

-- ===========================================================================
-- Privilege boundary. New tables and the view are private with RLS and no
-- policies; only SECURITY DEFINER functions touch them. The worker gets exactly
-- one new RPC. The reconciliation packet keeps its 16.12 capability gate.
-- ===========================================================================
revoke all on private.cpsc_observation_payloads, private.cpsc_observation_sightings,
  private.cpsc_observation_payload_retention
  from public, anon, authenticated, service_role;
revoke all on function
  private.cpsc_canonical_json_v1(jsonb),
  private.cpsc_payload_sha256_v1(jsonb),
  private.cpsc_guard_sighting_update(),
  private.cpsc_watermark_safety(),
  private.cpsc_guard_watermark_advance(),
  private.cpsc_attach_captured_payloads(jsonb, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.record_cpsc_retained_observation(
  text, text, text, text, text, date, text, timestamptz, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_cpsc_retained_observation(
  text, text, text, text, text, date, text, timestamptz, text, jsonb)
  to service_role;

commit;
