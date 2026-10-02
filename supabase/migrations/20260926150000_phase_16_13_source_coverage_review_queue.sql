-- Phase 16.13: extraction completeness (source-coverage ledger), fail-closed
-- negative evidence, and the human reviewer pending-candidate queue.
--
-- Forward-only. Requires 16.9 -> 16.10 -> 16.11 -> 16.12. Nothing here activates
-- the page worker, a cohort, the matcher selector, consumer v2 reads, or push.
begin;

-- ===========================================================================
-- Source-coverage ledger. One append-only row per recorded interpretation of a
-- page revision. The worker supplies the ledger; the database validates its
-- shape, binds it to the stored revision and proposals, and recomputes every
-- status and fingerprint itself. The latest row per revision is authoritative.
-- ===========================================================================
create table private.cpsc_page_coverage_ledgers (
  id uuid primary key default gen_random_uuid(),
  recorded_seq bigint generated always as identity unique,
  revision_id uuid not null references private.cpsc_page_revisions(id) on delete restrict,
  ledger_version text not null check (ledger_version ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  parser_version text not null check (parser_version ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  extractor_version text not null check (extractor_version ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  census_version text not null check (census_version ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  coverage_fingerprint text not null check (coverage_fingerprint ~ '^[0-9a-f]{64}$'),
  interpretation_fingerprint text not null check (interpretation_fingerprint ~ '^[0-9a-f]{64}$'),
  structural_status text not null check (structural_status in ('complete', 'partial', 'unresolved')),
  criterion_status text not null check (criterion_status in ('complete', 'partial', 'unresolved')),
  coverage_status text not null check (coverage_status in ('complete', 'partial', 'unresolved')),
  positive_status text not null check (positive_status in ('independent', 'blocked')),
  negative_evidence_eligible boolean not null,
  authoritative_records integer not null check (authoritative_records >= 0),
  accounted_records integer not null check (accounted_records >= 0),
  reviewable_relations text[] not null,
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  ledger jsonb not null check (jsonb_typeof(ledger) = 'object'),
  recorded_at timestamptz not null default now(),
  check (not negative_evidence_eligible or (coverage_status = 'complete'
    and positive_status = 'independent' and authoritative_records = accounted_records))
);
create index cpsc_page_coverage_ledgers_revision_idx
  on private.cpsc_page_coverage_ledgers(revision_id, recorded_seq desc);
alter table private.cpsc_page_coverage_ledgers enable row level security;

-- Strict shape. Unknown keys are refused, so no timestamp, database id, or
-- reviewer identity can enter a ledger or its fingerprint.
create function private.cpsc_validate_coverage_ledger(p_ledger jsonb)
returns void language plpgsql stable set search_path = '' as $$
declare
  c_version constant text := '^[a-z0-9][a-z0-9.-]{0,63}$';
  c_ledger_keys constant text[] := array['censusVersion', 'extractorVersion', 'ledgerVersion',
    'parserVersion', 'schema', 'sourceSemanticRevision', 'structures'];
  c_structure_keys constant text[] := array['anomalies', 'authoritativeRecordCount', 'kind',
    'records', 'sectionIdentity', 'structureId', 'tableIdentity', 'tableIndex'];
  c_record_keys constant text[] := array['cells', 'disposition', 'effect', 'extraction',
    'ordinal', 'reason', 'recordIdentity', 'relation', 'rowIdentity'];
  c_cell_keys constant text[] := array['column', 'criterionClass', 'status'];
  c_anomalies constant text[] := array['empty_header_row', 'header_cells_in_body',
    'merged_header_cells', 'multiple_header_rows', 'nested_table',
    'prose_reconstruction_mismatch', 'row_count_mismatch', 'rowspan_overflow',
    'table_count_mismatch'];
begin
  if jsonb_typeof(p_ledger) is distinct from 'object'
    or octet_length(p_ledger::text) > 1048576
    or (select array_agg(k order by k collate "C") from jsonb_object_keys(p_ledger) k)
      is distinct from c_ledger_keys
    or p_ledger->>'schema' is distinct from 'cpsc_source_coverage_v1'
    or coalesce(p_ledger->>'ledgerVersion', '') !~ c_version
    or coalesce(p_ledger->>'parserVersion', '') !~ c_version
    or coalesce(p_ledger->>'extractorVersion', '') !~ c_version
    or coalesce(p_ledger->>'censusVersion', '') !~ c_version
    or coalesce(p_ledger->>'sourceSemanticRevision', '') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_ledger->'structures') is distinct from 'array'
    or jsonb_array_length(p_ledger->'structures') not between 1 and 200 then
    raise exception 'Invalid CPSC coverage ledger';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_ledger->'structures') s(body)
    where jsonb_typeof(body) is distinct from 'object'
      or (select array_agg(k order by k collate "C") from jsonb_object_keys(body) k)
        is distinct from c_structure_keys
      or jsonb_typeof(body->'structureId') is distinct from 'string'
      or length(body->>'structureId') not between 1 and 300
      or body->>'kind' not in ('prose', 'table', 'region')
      or body->>'sectionIdentity' not in ('description', 'recall-details')
      or jsonb_typeof(body->'tableIndex') not in ('null', 'number')
      or (jsonb_typeof(body->'tableIndex') = 'number' and (body->>'tableIndex') !~ '^[0-9]{1,4}$')
      or jsonb_typeof(body->'tableIdentity') not in ('null', 'string')
      or length(coalesce(body->>'tableIdentity', '')) > 300
      or jsonb_typeof(body->'authoritativeRecordCount') is distinct from 'number'
      or (body->>'authoritativeRecordCount') !~ '^[0-9]{1,4}$'
      or jsonb_typeof(body->'anomalies') is distinct from 'array'
      or exists (select 1 from jsonb_array_elements(body->'anomalies') a
        where jsonb_typeof(a) <> 'string' or not ((a #>> '{}') = any(c_anomalies)))
      or (select coalesce(array_agg(a order by a collate "C"), '{}') from
          jsonb_array_elements_text(body->'anomalies') a)
        is distinct from (select coalesce(array_agg(a order by o), '{}') from
          jsonb_array_elements_text(body->'anomalies') with ordinality x(a, o))
      or (select count(distinct a) from jsonb_array_elements_text(body->'anomalies') a)
        <> jsonb_array_length(body->'anomalies')
      or jsonb_typeof(body->'records') is distinct from 'array'
      or jsonb_array_length(body->'records') > 5000
      or (body->>'kind' = 'table') <> (jsonb_typeof(body->'tableIndex') = 'number')
      or (body->>'kind' <> 'table' and jsonb_typeof(body->'tableIdentity') <> 'null')
  ) then
    raise exception 'Invalid CPSC coverage ledger structure';
  end if;
  if (select count(*) from jsonb_array_elements(p_ledger->'structures') s(body)
      where body->>'kind' = 'prose') <> 1
    or (select count(distinct body->>'structureId') from
        jsonb_array_elements(p_ledger->'structures') s(body))
      <> jsonb_array_length(p_ledger->'structures') then
    raise exception 'CPSC coverage ledger needs exactly one prose structure and unique structures';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_ledger->'structures') s(body),
      jsonb_array_elements(body->'records') with ordinality r(rec, n)
    where jsonb_typeof(rec) is distinct from 'object'
      or (select array_agg(k order by k collate "C") from jsonb_object_keys(rec) k)
        is distinct from c_record_keys
      or jsonb_typeof(rec->'ordinal') is distinct from 'number'
      or (rec->>'ordinal') !~ '^[0-9]{1,4}$' or (rec->>'ordinal')::integer <> n - 1
      or jsonb_typeof(rec->'recordIdentity') is distinct from 'string'
      or length(rec->>'recordIdentity') not between 1 and 200
      or jsonb_typeof(rec->'rowIdentity') not in ('null', 'string')
      or (jsonb_typeof(rec->'rowIdentity') = 'string' and (rec->>'rowIdentity') !~ '^[0-9a-f]{64}$')
      or rec->>'extraction' not in ('extracted', 'failed')
      or rec->>'disposition' not in ('parsed_reviewable', 'parsed_deferred', 'unresolved',
        'unsupported', 'ignored_non_safety')
      or rec->>'effect' not in ('none', 'additive', 'restrictive')
      or jsonb_typeof(rec->'relation') not in ('null', 'string')
      or length(coalesce(rec->>'relation', '')) > 700
      or jsonb_typeof(rec->'reason') is distinct from 'string'
      or length(rec->>'reason') > 300
      or jsonb_typeof(rec->'cells') is distinct from 'array'
      or jsonb_array_length(rec->'cells') > 50
      or exists (select 1 from jsonb_array_elements(rec->'cells') cell
        where jsonb_typeof(cell) is distinct from 'object'
          or (select array_agg(k order by k collate "C") from jsonb_object_keys(cell) k)
            is distinct from c_cell_keys
          or jsonb_typeof(cell->'column') is distinct from 'string'
          or length(cell->>'column') > 200
          or jsonb_typeof(cell->'criterionClass') is distinct from 'string'
          or length(cell->>'criterionClass') > 64
          or cell->>'status' not in ('recognized', 'deferred', 'unsupported', 'invalid',
            'descriptive'))
      -- Internal consistency of a disposition.
      or ((rec->>'disposition' = 'parsed_reviewable') <> (jsonb_typeof(rec->'relation') = 'string'))
      or (rec->>'extraction' = 'failed' and rec->>'disposition' <> 'unresolved')
      or (rec->>'disposition' in ('ignored_non_safety', 'parsed_reviewable')
        and rec->>'effect' <> 'none')
      or (rec->>'disposition' = 'parsed_reviewable' and body->>'kind' = 'region')
  ) then
    raise exception 'Invalid CPSC coverage ledger record';
  end if;
end;
$$;

-- Deterministic mirror of summarizeCpscCoverageLedger (sourceCoverage.ts).
create function private.cpsc_coverage_summary(p_ledger jsonb)
returns jsonb language sql stable set search_path = '' as $$
  with structure as (
    select s.body, s.n from jsonb_array_elements(p_ledger->'structures') with ordinality s(body, n)
  ), record as (
    select st.n as sn, r.n as rn, st.body->>'structureId' as structure_id,
      st.body->>'kind' as kind, r.body
    from structure st, jsonb_array_elements(st.body->'records') with ordinality r(body, n)
  ), facts as (
    select
      coalesce((select sum((body->>'authoritativeRecordCount')::integer) from structure), 0)
        as authoritative,
      (select count(*) from record) as accounted,
      not exists (select 1 from structure
        where jsonb_array_length(body->'records') <> (body->>'authoritativeRecordCount')::integer
          or body->'anomalies' ?| array['row_count_mismatch', 'empty_header_row',
            'prose_reconstruction_mismatch', 'table_count_mismatch']) as accounted_ok,
      exists (select 1 from structure where jsonb_array_length(body->'anomalies') > 0)
        as any_anomaly,
      exists (select 1 from record where body->>'extraction' = 'failed') as any_failed,
      exists (select 1 from record
        where body->>'disposition' in ('parsed_deferred', 'unresolved', 'unsupported'))
        as any_blocking,
      exists (select 1 from record
        where kind = 'table' and body->>'disposition' = 'parsed_reviewable') as any_reviewable,
      coalesce((select jsonb_agg(structure_id || '#' || (body->>'ordinal') order by sn, rn)
        from record where body->>'effect' = 'restrictive'
          and body->>'disposition' in ('parsed_deferred', 'unresolved', 'unsupported')),
        '[]'::jsonb) as blockers,
      coalesce((select array_agg(body->>'relation' order by body->>'relation' collate "C")
        from record where kind = 'table' and body->>'disposition' = 'parsed_reviewable'),
        '{}'::text[]) as relations,
      (select jsonb_object_agg(d, (select count(*) from record where body->>'disposition' = d))
        from unnest(array['parsed_reviewable', 'parsed_deferred', 'unresolved', 'unsupported',
          'ignored_non_safety']) d) as counts,
      private.cpsc_canonical_json_sha256(jsonb_build_object(
        'schema', 'cpsc_source_coverage_interpretation_v1',
        'sourceSemanticRevision', p_ledger->'sourceSemanticRevision',
        'structures', coalesce((select jsonb_agg((st.body - 'records') || jsonb_build_object(
            'records', coalesce((select jsonb_agg(r.body - 'reason' order by r.n)
              from jsonb_array_elements(st.body->'records') with ordinality r(body, n)),
              '[]'::jsonb)) order by st.n)
          from structure st), '[]'::jsonb))) as interpretation
  ), status as (
    select f.*,
      case when not accounted_ok then 'unresolved'
        when any_anomaly or any_failed then 'partial' else 'complete' end as structural,
      case when not any_reviewable then 'unresolved'
        when any_blocking then 'partial' else 'complete' end as criterion
    from facts f
  ), final as (
    select s.*,
      case when structural = 'complete' and criterion = 'complete' then 'complete'
        when structural = 'unresolved' or criterion = 'unresolved' then 'unresolved'
        else 'partial' end as coverage,
      case when jsonb_array_length(blockers) > 0 or structural = 'unresolved'
        then 'blocked' else 'independent' end as positive
    from status s
  )
  select jsonb_build_object(
    'structuralStatus', structural,
    'criterionStatus', criterion,
    'coverageStatus', coverage,
    'positiveStatus', positive,
    'negativeEvidenceEligible', coverage = 'complete' and positive = 'independent',
    'authoritativeRecords', authoritative,
    'accountedRecords', accounted,
    'dispositionCounts', counts,
    'reviewableRelations', to_jsonb(relations),
    'blockers', blockers,
    'interpretationFingerprint', interpretation,
    'coverageFingerprint', private.cpsc_canonical_json_sha256(jsonb_build_object(
      'schema', 'cpsc_source_coverage_v1',
      'ledgerVersion', p_ledger->'ledgerVersion',
      'parserVersion', p_ledger->'parserVersion',
      'extractorVersion', p_ledger->'extractorVersion',
      'censusVersion', p_ledger->'censusVersion',
      'interpretationFingerprint', interpretation)))
  from final;
$$;

-- Binds a ledger to its stored revision: every stored table is accounted for by
-- exactly one structure, row identities are the revision's own rows (in order
-- when the table has no anomaly), and every reviewable conjunction is a proposal
-- on this revision bound to its own table row.
create function private.cpsc_check_coverage_binding(p_revision_id uuid, p_ledger jsonb)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  v_revision private.cpsc_page_revisions%rowtype;
  v_tables jsonb;
begin
  select * into v_revision from private.cpsc_page_revisions where id = p_revision_id;
  if v_revision.id is null then raise exception 'Unknown CPSC page revision'; end if;
  v_tables := case when jsonb_typeof(v_revision.table_identities) = 'array'
    then v_revision.table_identities else '[]'::jsonb end;
  if p_ledger->>'sourceSemanticRevision' is distinct from v_revision.evidence_hash then
    raise exception 'CPSC coverage ledger names another source revision';
  end if;
  if (select count(*) from jsonb_array_elements(p_ledger->'structures') s(body)
      where body->>'kind' = 'table' and body->>'tableIdentity' is not null)
      <> jsonb_array_length(v_tables)
    or exists (select 1 from jsonb_array_elements(v_tables) with ordinality t(body, n)
      where (select count(*) from jsonb_array_elements(p_ledger->'structures') s(sbody)
        where sbody->>'kind' = 'table' and (sbody->>'tableIndex')::integer = t.n - 1
          and sbody->>'tableIdentity' = t.body->>'identity') <> 1)
    or exists (select 1 from jsonb_array_elements(p_ledger->'structures') s(body)
      where body->>'kind' = 'table' and body->>'tableIdentity' is null
        and (body->>'tableIndex')::integer < jsonb_array_length(v_tables)) then
    raise exception 'CPSC coverage ledger does not account for every stored table';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_tables) with ordinality t(body, n)
    join lateral (select sbody from jsonb_array_elements(p_ledger->'structures') s(sbody)
      where sbody->>'tableIdentity' = t.body->>'identity') st on true
    where exists (select 1 from jsonb_array_elements(st.sbody->'records') r(rec)
        where rec->>'rowIdentity' is not null
          and not exists (select 1 from jsonb_array_elements(
              case when jsonb_typeof(t.body->'rows') = 'array' then t.body->'rows'
                else '[]'::jsonb end) stored(row_body)
            where stored.row_body->>'identity' = rec->>'rowIdentity'))
      or (jsonb_array_length(st.sbody->'anomalies') = 0
        and (select coalesce(array_agg(rec->>'rowIdentity' order by n), '{}')
            from jsonb_array_elements(st.sbody->'records') with ordinality r(rec, n)
            where rec->>'rowIdentity' is not null)
          is distinct from (select coalesce(array_agg(row_body->>'identity' order by n), '{}')
            from jsonb_array_elements(case when jsonb_typeof(t.body->'rows') = 'array'
              then t.body->'rows' else '[]'::jsonb end) with ordinality stored(row_body, n)))
  ) then
    raise exception 'CPSC coverage ledger rows do not match the stored revision';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_ledger->'structures') s(body),
      jsonb_array_elements(body->'records') r(rec)
    where rec->>'disposition' = 'parsed_reviewable'
      and (
        (body->>'kind' = 'table' and (
          rec->>'rowIdentity' is null
          or rec->>'relation' is distinct from
            (body->>'tableIdentity') || '/' || (rec->>'rowIdentity')
          or not exists (select 1 from private.cpsc_candidate_criteria c
            where c.revision_id = v_revision.id and c.conjunction_key = rec->>'relation')))
        or (body->>'kind' = 'prose' and not exists (
          select 1 from jsonb_array_elements(p_ledger->'structures') other(obody)
          where obody->>'kind' = 'table' and obody->>'tableIdentity' is not null
            and rec->>'relation' = 'governs:' || (obody->>'tableIdentity'))))
  ) then
    raise exception 'CPSC coverage ledger reviewable records are not bound to proposals';
  end if;
end;
$$;

-- Even the table owner cannot record a ledger whose statuses or fingerprints do
-- not follow from its own content, or rewrite one afterwards.
create function private.cpsc_guard_coverage_ledger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_summary jsonb;
begin
  if tg_op <> 'INSERT' then
    raise exception 'cpsc_page_coverage_ledgers is append-only' using errcode = '42501';
  end if;
  perform private.cpsc_validate_coverage_ledger(new.ledger);
  perform private.cpsc_check_coverage_binding(new.revision_id, new.ledger);
  v_summary := private.cpsc_coverage_summary(new.ledger);
  if new.summary is distinct from v_summary
    or new.ledger_version is distinct from new.ledger->>'ledgerVersion'
    or new.parser_version is distinct from new.ledger->>'parserVersion'
    or new.extractor_version is distinct from new.ledger->>'extractorVersion'
    or new.census_version is distinct from new.ledger->>'censusVersion'
    or new.coverage_fingerprint is distinct from v_summary->>'coverageFingerprint'
    or new.interpretation_fingerprint is distinct from v_summary->>'interpretationFingerprint'
    or new.structural_status is distinct from v_summary->>'structuralStatus'
    or new.criterion_status is distinct from v_summary->>'criterionStatus'
    or new.coverage_status is distinct from v_summary->>'coverageStatus'
    or new.positive_status is distinct from v_summary->>'positiveStatus'
    or new.negative_evidence_eligible is distinct from
      (v_summary->>'negativeEvidenceEligible')::boolean
    or new.authoritative_records is distinct from (v_summary->>'authoritativeRecords')::integer
    or new.accounted_records is distinct from (v_summary->>'accountedRecords')::integer
    or new.reviewable_relations is distinct from (select coalesce(array_agg(x order by n), '{}')
      from jsonb_array_elements_text(v_summary->'reviewableRelations') with ordinality v(x, n)) then
    raise exception 'CPSC coverage ledger row does not follow from its content'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger cpsc_guard_coverage_ledger
  before insert or update or delete on private.cpsc_page_coverage_ledgers
  for each row execute function private.cpsc_guard_coverage_ledger();
create trigger cpsc_coverage_ledgers_no_truncate
  before truncate on private.cpsc_page_coverage_ledgers
  for each statement execute function private.cpsc_append_only();

-- The one current revision of the scope's canonical identity, or NULL when there
-- is not exactly one.
create function private.cpsc_scope_current_revision(p_scope_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select case when count(*) = 1 then (array_agg(revision.id))[1] end
  from public.recall_scopes scope
  join private.cpsc_notice_identity_links link on link.notice_id = scope.recall_notice_id
  join private.cpsc_page_revisions revision on revision.identity_id = link.identity_id
  where scope.id = p_scope_id and private.cpsc_revision_is_current(revision.id);
$$;

-- Compact coverage state of a revision's latest ledger. A revision without a
-- ledger is "missing": it can never support a negative conclusion.
create function private.cpsc_revision_coverage(p_revision_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((
    select jsonb_build_object(
      'state', 'recorded',
      'coverageStatus', l.coverage_status,
      'structuralStatus', l.structural_status,
      'criterionStatus', l.criterion_status,
      'positiveStatus', l.positive_status,
      'negativeEvidenceEligible', l.negative_evidence_eligible,
      'authoritativeRecords', l.authoritative_records,
      'accountedRecords', l.accounted_records,
      'dispositionCounts', l.summary->'dispositionCounts',
      'reviewableRuleSets', cardinality(l.reviewable_relations),
      'coverageFingerprint', l.coverage_fingerprint,
      'interpretationFingerprint', l.interpretation_fingerprint,
      'ledgerVersion', l.ledger_version,
      'parserVersion', l.parser_version)
    from private.cpsc_page_coverage_ledgers l
    where l.revision_id = p_revision_id
    order by l.recorded_seq desc limit 1),
    jsonb_build_object('state', 'missing', 'coverageStatus', 'unresolved',
      'structuralStatus', 'unresolved', 'criterionStatus', 'unresolved',
      'positiveStatus', 'unknown', 'negativeEvidenceEligible', false));
$$;

-- In-flight v2 evaluations compare the notice revision; a changed coverage proof
-- advances it so a claim taken under the previous proof finalizes as stale.
create function private.cpsc_touch_identity_notices(p_identity_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.recall_notices notice set updated_at = now()
  where notice.id in (select link.notice_id from private.cpsc_notice_identity_links link
    where link.identity_id = p_identity_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Worker-only. Records the ledger for the CURRENT revision after its proposals.
create function public.record_cpsc_page_coverage(p_revision_id uuid, p_ledger jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_revision private.cpsc_page_revisions%rowtype;
  v_summary jsonb;
  v_latest private.cpsc_page_coverage_ledgers%rowtype;
  v_id uuid;
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  if p_revision_id is null then raise exception 'Invalid CPSC coverage ledger'; end if;
  -- Serializes concurrent ledger writes for one revision.
  select * into v_revision from private.cpsc_page_revisions where id = p_revision_id for update;
  if v_revision.id is null or not private.cpsc_revision_is_current(v_revision.id) then
    raise exception 'CPSC coverage requires the current source revision';
  end if;
  perform private.cpsc_validate_coverage_ledger(p_ledger);
  perform private.cpsc_check_coverage_binding(v_revision.id, p_ledger);
  v_summary := private.cpsc_coverage_summary(p_ledger);
  select * into v_latest from private.cpsc_page_coverage_ledgers
    where revision_id = v_revision.id order by recorded_seq desc limit 1;
  if v_latest.id is not null and v_latest.coverage_fingerprint = v_summary->>'coverageFingerprint' then
    return v_summary || jsonb_build_object('status', 'unchanged', 'ledgerId', v_latest.id);
  end if;
  insert into private.cpsc_page_coverage_ledgers (
    revision_id, ledger_version, parser_version, extractor_version, census_version,
    coverage_fingerprint, interpretation_fingerprint, structural_status, criterion_status,
    coverage_status, positive_status, negative_evidence_eligible, authoritative_records,
    accounted_records, reviewable_relations, summary, ledger
  ) values (
    v_revision.id, p_ledger->>'ledgerVersion', p_ledger->>'parserVersion',
    p_ledger->>'extractorVersion', p_ledger->>'censusVersion',
    v_summary->>'coverageFingerprint', v_summary->>'interpretationFingerprint',
    v_summary->>'structuralStatus', v_summary->>'criterionStatus', v_summary->>'coverageStatus',
    v_summary->>'positiveStatus', (v_summary->>'negativeEvidenceEligible')::boolean,
    (v_summary->>'authoritativeRecords')::integer, (v_summary->>'accountedRecords')::integer,
    (select coalesce(array_agg(x order by n), '{}')
      from jsonb_array_elements_text(v_summary->'reviewableRelations') with ordinality v(x, n)),
    v_summary, p_ledger
  ) returning id into v_id;
  perform private.cpsc_touch_identity_notices(v_revision.identity_id);
  return v_summary || jsonb_build_object('status', 'created', 'ledgerId', v_id,
    'interpretationChanged', v_latest.id is not null
      and v_latest.interpretation_fingerprint <> v_summary->>'interpretationFingerprint');
end;
$$;

-- ===========================================================================
-- Coverage and serving. Negative evidence requires a recorded ledger that proves
-- the rule universe complete and matches the revision's proposals exactly. A
-- ledger whose positives are blocked serves no rule set at all; when a ledger
-- exists, only its reviewable conjunctions are served.
-- ===========================================================================
create or replace function private.cpsc_scope_rule_set_coverage(p_scope_id uuid, p_served_groups text[])
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
  ), ledger as (
    select l.* from private.cpsc_page_coverage_ledgers l
    where l.revision_id = private.cpsc_scope_current_revision(p_scope_id)
    order by l.recorded_seq desc limit 1
  ), summary as (
    select
      (select count(*) from current_revision) as current_revisions,
      (select count(*) from proposal where proposed_scope_id = p_scope_id) as proposed,
      (select count(*) from proposal where proposed_scope_id is null) as unattributed,
      (select count(*) from proposal where proposed_scope_id = p_scope_id
        and conjunction_group <> all(coalesce(p_served_groups, '{}'))) as unserved,
      coalesce(cardinality(p_served_groups), 0) as served,
      coalesce((select negative_evidence_eligible from ledger), false) as ledger_negative,
      coalesce((select reviewable_relations from ledger), '{}') as relations,
      coalesce((select array_agg(distinct conjunction_group) from proposal), '{}') as groups
  )
  select jsonb_build_object(
    'currentRevisionId', (select id from current_revision limit 1),
    'proposedRuleSets', proposed,
    'unattributedRuleSets', unattributed,
    'servedRuleSets', served,
    'sourceCoverage', private.cpsc_revision_coverage(private.cpsc_scope_current_revision(p_scope_id)),
    'complete', current_revisions = 1 and unattributed = 0 and proposed > 0
      and unserved = 0 and served = proposed
      and ledger_negative and relations @> groups and groups @> relations)
  from summary;
$$;

create or replace function private.cpsc_scope_rule_set_envelope(p_scope_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_url text;
  v_sets jsonb;
  v_groups text[];
  v_ledger private.cpsc_page_coverage_ledgers%rowtype;
begin
  select n.official_url into v_url from public.recall_scopes s
    join public.recall_notices n on n.id = s.recall_notice_id where s.id = p_scope_id;
  select * into v_ledger from private.cpsc_page_coverage_ledgers
    where revision_id = private.cpsc_scope_current_revision(p_scope_id)
    order by recorded_seq desc limit 1;
  if v_ledger.id is not null and v_ledger.positive_status <> 'independent' then
    return null;
  end if;
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
      and (v_ledger.id is null or binding.conjunction_group = any(v_ledger.reviewable_relations))
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

-- ===========================================================================
-- Reviewer pending-candidate queue. Human reviewers only; bounded, keyset
-- paginated, deterministic. One item per rule set (conjunction) that still has
-- a member without an effective decision. No owned-product data, no reviewer
-- identities, no worker or administrative internals.
-- ===========================================================================
create function private.cpsc_criterion_preview(p_kind text, p_value jsonb)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_kind like 'model%' then 'model_number' else 'date_code' end
    || case when jsonb_typeof(p_value) = 'array'
      then ' one of ' || p_value::text else ' equals ' || p_value::text end;
$$;

create function public.list_cpsc_pending_review_candidates(
  p_page_size integer default 20,
  p_cursor text default null
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_rows jsonb;
  v_count integer;
  v_items jsonb;
  v_next text;
begin
  if not private.cpsc_is_human_reviewer() then
    raise exception 'CPSC human reviewer authorization required' using errcode = '42501';
  end if;
  if p_page_size is null or p_page_size < 1 or p_page_size > 50 then
    raise exception 'Review page size must be between 1 and 50';
  end if;
  if p_cursor is not null and (length(p_cursor) > 1200
    or p_cursor !~ '^[0-9]{5}\|[0-9]{12}\|[0-9a-f~-]{1,36}\|.+$') then
    raise exception 'Invalid review cursor';
  end if;

  with revision as (
    select r.* from private.cpsc_page_revisions r
    where exists (select 1 from private.cpsc_candidate_criteria c where c.revision_id = r.id)
      and private.cpsc_revision_is_current(r.id)
  ), member as (
    select c.*, coalesce(c.conjunction_key, c.id::text) as grp,
      latest.decision as latest_decision,
      coalesce(exists (select 1 from private.cpsc_review_decision_invalidations i
        where i.review_event_id = latest.id), false) as latest_invalidated,
      (latest.id is null or latest.decision = 'stale' or exists (
        select 1 from private.cpsc_review_decision_invalidations i
        where i.review_event_id = latest.id)) as pending
    from private.cpsc_candidate_criteria c
    join revision on revision.id = c.revision_id
    left join lateral (
      select l.id, l.decision from private.cpsc_candidate_review_ledger l
      where l.candidate_id = c.id order by l.event_seq desc limit 1
    ) latest on true
  ), row_position as (
    select revision.id as revision_id, tables.value->>'identity' as table_identity,
      table_rows.value->>'identity' as row_identity,
      tables.ordinality * 100000 + table_rows.ordinality as position
    from revision,
      jsonb_array_elements(case when jsonb_typeof(revision.table_identities) = 'array'
        then revision.table_identities else '[]'::jsonb end) with ordinality tables,
      jsonb_array_elements(case when jsonb_typeof(tables.value->'rows') = 'array'
        then tables.value->'rows' else '[]'::jsonb end) with ordinality table_rows
  ), grouped as (
    select m.revision_id, m.proposed_scope_id, m.grp,
      bool_or(m.pending) as any_pending,
      count(*) filter (where m.pending) as pending_members,
      min(pos.position) as document_position,
      jsonb_agg(jsonb_build_object(
        'candidateId', m.id, 'kind', m.criterion_kind, 'operator', m.proposed_operator,
        'value', m.criterion_value, 'excerpt', m.authoritative_excerpt,
        'fieldIdentity', m.evidence_address->>'fieldIdentity',
        'parserVersion', m.parser_version,
        'pending', m.pending, 'latestDecision', m.latest_decision,
        'latestDecisionInvalidated', m.latest_invalidated)
        order by m.criterion_kind like 'date\_code%', m.id) as members,
      string_agg(private.cpsc_criterion_preview(m.criterion_kind, m.criterion_value), ' AND '
        order by m.criterion_kind like 'date\_code%', m.id) as preview,
      (array_agg(m.evidence_address order by m.id))[1] as address
    from member m
    left join row_position pos on pos.revision_id = m.revision_id
      and pos.table_identity = m.evidence_address->>'tableIdentity'
      and pos.row_identity = m.evidence_address->>'rowIdentity'
    group by m.revision_id, m.proposed_scope_id, m.grp
  ), numbered as (
    select g.*,
      row_number() over (partition by g.revision_id, g.proposed_scope_id
        order by g.document_position nulls last, g.grp collate "C") as rule_set_number,
      count(*) over (partition by g.revision_id, g.proposed_scope_id) as rule_set_count
    from grouped g
  ), keyed as (
    select n.*, r.recall_number, r.canonical_url, r.evidence_hash,
      r.recall_number || '|' || lpad(coalesce(n.document_position, 999999999999)::text, 12, '0')
        || '|' || coalesce(n.proposed_scope_id::text, '~') || '|' || n.grp as sort_key
    from numbered n join private.cpsc_page_revisions r on r.id = n.revision_id
    where n.any_pending
  ), page as (
    select * from keyed
    where p_cursor is null or sort_key collate "C" > p_cursor collate "C"
    order by sort_key collate "C"
    limit p_page_size + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'sortKey', p.sort_key,
      'recallNumber', p.recall_number,
      'officialUrl', p.canonical_url,
      'sourceRevision', p.evidence_hash,
      'revisionId', p.revision_id,
      'scopeId', p.proposed_scope_id,
      'scopeAttributed', p.proposed_scope_id is not null,
      'conjunctionGroup', p.grp,
      'ruleSetNumber', p.rule_set_number,
      'ruleSetCount', p.rule_set_count,
      'semantics', 'OR between rule sets; AND inside each rule set',
      'insideRuleSet', 'AND',
      'evidenceLocation', jsonb_build_object(
        'sectionIdentity', p.address->>'sectionIdentity',
        'tableIdentity', p.address->>'tableIdentity',
        'rowIdentity', p.address->>'rowIdentity'),
      'criterionPreview', p.preview,
      'pendingMembers', p.pending_members,
      'members', p.members,
      'parserCoverage', private.cpsc_revision_coverage(p.revision_id))
      order by p.sort_key collate "C"), '[]'::jsonb), count(*)
    into v_rows, v_count
  from page p;

  if v_count > p_page_size then
    select jsonb_agg(item order by n), (array_agg(item->>'sortKey' order by n))[p_page_size]
      into v_items, v_next
    from jsonb_array_elements(v_rows) with ordinality x(item, n)
    where n <= p_page_size;
  else
    v_items := v_rows;
    v_next := null;
  end if;
  return jsonb_build_object(
    'schema', 'cpsc_pending_review_page_v1',
    'semantics', 'OR between rule sets; AND inside each rule set',
    'pageSize', p_page_size,
    'items', v_items,
    'hasMore', v_next is not null,
    'nextCursor', v_next);
end;
$$;

-- ===========================================================================
-- Privilege boundary.
-- ===========================================================================
revoke all on private.cpsc_page_coverage_ledgers from public, anon, authenticated, service_role;
revoke all on function
  private.cpsc_validate_coverage_ledger(jsonb),
  private.cpsc_coverage_summary(jsonb),
  private.cpsc_check_coverage_binding(uuid, jsonb),
  private.cpsc_guard_coverage_ledger(),
  private.cpsc_scope_current_revision(uuid),
  private.cpsc_revision_coverage(uuid),
  private.cpsc_touch_identity_notices(uuid),
  private.cpsc_criterion_preview(text, jsonb),
  private.cpsc_scope_rule_set_coverage(uuid, text[]),
  private.cpsc_scope_rule_set_envelope(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  public.record_cpsc_page_coverage(uuid, jsonb),
  public.list_cpsc_pending_review_candidates(integer, text)
  from public, anon, authenticated, service_role;
-- Worker-only (the function additionally requires the service role).
grant execute on function public.record_cpsc_page_coverage(uuid, jsonb) to service_role;
-- Human-only (the function additionally requires a current reviewer authorization).
grant execute on function public.list_cpsc_pending_review_candidates(integer, text)
  to authenticated;

commit;
