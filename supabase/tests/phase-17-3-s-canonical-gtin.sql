-- Phase 17.3-S: canonical GTIN equivalence. Primitive parity with gtin.ts (shared vectors),
-- candidate retrieval in both directions for the Thule representations, legacy predicates kept,
-- historical raw values untouched, and F-4 still the final gate (no alert from equivalence).
-- Runs on the local stack only.
begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

-- ===========================================================================
-- Primitive properties and privileges.
-- ===========================================================================
select extensions.ok(
  (select p.provolatile = 'i' and p.proisstrict and not p.prosecdef
      and p.proconfig = array['search_path=""']
    from pg_proc p where p.oid = 'private.canonical_gtin14(text)'::regprocedure),
  'canonical_gtin14 is immutable, strict, invoker rights, empty search_path');
select extensions.ok(
  not pg_catalog.has_function_privilege('anon', 'private.canonical_gtin14(text)', 'EXECUTE')
  and not exists (
    select 1 from pg_proc p, pg_catalog.aclexplode(p.proacl) acl
    where p.oid = 'private.canonical_gtin14(text)'::regprocedure and acl.grantee = 0),
  'canonical_gtin14 is not executable by anon or PUBLIC');
select extensions.ok(
  pg_catalog.has_function_privilege('authenticated', 'private.canonical_gtin14(text)', 'EXECUTE')
  and pg_catalog.has_function_privilege('service_role', 'private.canonical_gtin14(text)', 'EXECUTE'),
  'the two roles that write indexed rows can evaluate the index expression');
select extensions.ok(
  not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r
    where pg_catalog.has_schema_privilege(r, 'private', 'USAGE')),
  'no API role can reach schema private by name');
select extensions.is(
  (select array_agg(indexname::text order by indexname) from pg_indexes
    where schemaname = 'public' and indexdef like '%private.canonical_gtin14(gtin)%'
      and indexdef like '%WHERE (gtin IS NOT NULL)%'),
  array['owned_products_canonical_gtin14_idx', 'recall_scopes_canonical_gtin14_idx'],
  'partial expression indexes exist on owned_products and recall_scopes');
select extensions.ok(
  (select bool_and(p.prosecdef and p.proconfig = array['search_path=""']
      and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE'))
    from pg_proc p
    where p.oid in ('public.get_recall_candidates(uuid,integer,uuid,integer)'::regprocedure,
      'public.get_owned_product_recall_candidates(uuid,integer,uuid,integer)'::regprocedure)),
  'candidate functions keep security definer, empty search_path and service_role-only grants');

-- ===========================================================================
-- Shared vectors: the JSON below is byte-identical to
-- tests/fixtures/phase-17-3-s-gtin-vectors.json (checked by
-- tests/phase-17-3-s-gtin-equivalence.test.mjs, which runs the same vectors through gtin.ts).
-- ===========================================================================
select extensions.is(private.canonical_gtin14(v->>'input'), v->>'canonical',
  'canonical_gtin14 vector: ' || (v->>'id'))
from jsonb_array_elements(($vectors$
{
  "schema": "phase-17-3-s-gtin-vectors/v1",
  "canonical": [
    { "id": "A-upc-a-12", "input": "091021037090", "canonical": "00091021037090" },
    { "id": "A-ean-13-leading-zero", "input": "0091021037090", "canonical": "00091021037090" },
    { "id": "A-gtin-14", "input": "00091021037090", "canonical": "00091021037090" },
    { "id": "C-ean-13-not-upc", "input": "4006381333931", "canonical": "04006381333931" },
    { "id": "C-ean-13-never-truncated", "input": "006381333931", "canonical": null },
    { "id": "D-zero-stripped-11-digits", "input": "91021037090", "canonical": null },
    { "id": "E-bad-check-12", "input": "091021037091", "canonical": null },
    { "id": "E-bad-check-13", "input": "0091021037091", "canonical": null },
    { "id": "E-bad-check-14", "input": "00091021037091", "canonical": null },
    { "id": "G-all-zero-gtin-14", "input": "00000000000000", "canonical": "00000000000000" },
    { "id": "G-15-digits", "input": "000091021037090", "canonical": null },
    { "id": "H-gtin-8", "input": "96385074", "canonical": "00000096385074" },
    { "id": "H-gtin-8-also-valid-upc-e", "input": "01234558", "canonical": "00000001234558" },
    { "id": "J-upc-e-without-symbology", "input": "04252614", "canonical": null },
    { "id": "indicator-1-is-another-item", "input": "10091021037097", "canonical": "10091021037097" },
    { "id": "length-9", "input": "123456789", "canonical": null },
    { "id": "length-10", "input": "0123456789", "canonical": null },
    { "id": "empty", "input": "", "canonical": null },
    { "id": "blank", "input": "   ", "canonical": null },
    { "id": "null", "input": null, "canonical": null },
    { "id": "trim-spaces", "input": " 091021037090 ", "canonical": "00091021037090" },
    { "id": "trim-tab-newline", "input": "\t0091021037090\r\n", "canonical": "00091021037090" },
    { "id": "trim-nbsp-bom", "input": "\u00a0091021037090\ufeff", "canonical": "00091021037090" },
    { "id": "trim-ideographic-space", "input": "\u3000091021037090\u2028", "canonical": "00091021037090" },
    { "id": "no-trim-zero-width-space", "input": "\u200b091021037090", "canonical": null },
    { "id": "no-trim-next-line", "input": "\u0085091021037090", "canonical": null },
    { "id": "inner-space", "input": "0910 2103 7090", "canonical": null },
    { "id": "hyphens", "input": "0910-2103-7090", "canonical": null },
    { "id": "fullwidth-digits", "input": "\uff10\uff19\uff11\uff10\uff12\uff11\uff10\uff13\uff17\uff10\uff19\uff10", "canonical": null },
    { "id": "arabic-indic-digits", "input": "\u0660\u0669\u0661\u0660\u0662\u0661\u0660\u0663\u0667\u0660\u0669\u0660", "canonical": null },
    { "id": "sign", "input": "+091021037090", "canonical": null }
  ],
  "upce": [
    { "id": "I-upc-e-d6-1", "input": "04252614", "expanded": "042100005264", "canonical": "00042100005264" },
    { "id": "upc-e-d6-0", "input": "01234505", "expanded": "012000003455", "canonical": "00012000003455" },
    { "id": "upc-e-d6-2", "input": "01234523", "expanded": "012200003453", "canonical": "00012200003453" },
    { "id": "upc-e-d6-3", "input": "01234531", "expanded": "012300000451", "canonical": "00012300000451" },
    { "id": "upc-e-d6-4", "input": "01234543", "expanded": "012340000053", "canonical": "00012340000053" },
    { "id": "upc-e-d6-5", "input": "01234558", "expanded": "012345000058", "canonical": "00012345000058" },
    { "id": "upc-e-d6-9", "input": "06543297", "expanded": "065432000097", "canonical": "00065432000097" },
    { "id": "upc-e-number-system-1", "input": "12345670", "expanded": "123456000070", "canonical": "00123456000070" },
    { "id": "upc-e-number-system-1-d6-0", "input": "19876502", "expanded": "198000007652", "canonical": "00198000007652" },
    { "id": "upc-e-bad-check", "input": "04252615", "expanded": null, "canonical": null },
    { "id": "upc-e-number-system-2", "input": "24252614", "expanded": null, "canonical": null },
    { "id": "upc-e-7-digits", "input": "4252614", "expanded": null, "canonical": null }
  ]
}
$vectors$::jsonb)->'canonical') v;

-- ===========================================================================
-- Thule fixture: one CPSC notice per scope representation, products P1..P6.
-- ===========================================================================
create function pg_temp.id(p_suffix text) returns uuid language sql immutable as $$
  select ('17350000-0000-4000-8000-' || lpad(p_suffix, 12, '0'))::uuid;
$$;

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values (pg_temp.id('9001'), 'authenticated', 'authenticated', 'p173s@example.invalid', '', now(),
  '{}', '{}', now(), now());

select set_config('t173s.source', public.ensure_cpsc_recall_source()::text, true);

insert into public.recall_notices (id, source_id, external_id, title, recall_date, official_url,
  retrieved_at, raw_payload)
select pg_temp.id(n.suffix), current_setting('t173s.source')::uuid, 'p173s-' || n.suffix,
  'Phase seventeen notice ' || n.suffix, date '2020-08-12',
  'https://www.cpsc.gov/Recalls/2020/P173S-' || n.suffix, now(), '{}'::jsonb
from (values ('101'), ('102'), ('103'), ('104'), ('105')) as n(suffix);

insert into public.recall_scopes (recall_notice_id, gtin)
values
  (pg_temp.id('101'), '091021037090'),     -- N1: UPC-A as CPSC publishes it
  (pg_temp.id('102'), '0910-2103-7090'),   -- N2: legacy digit-string match only
  (pg_temp.id('103'), '4006381333931'),    -- N3: a different GTIN
  (pg_temp.id('104'), '042100005264'),     -- N4: UPC-A expansion of UPC-E 04252614
  (pg_temp.id('105'), '00091021037090');   -- N5: the same GTIN published as GTIN-14

insert into public.recall_notice_jurisdictions (recall_notice_id, jurisdiction_type, jurisdiction_code)
select pg_temp.id(n.suffix), 'country', 'US'
from (values ('101'), ('102'), ('103'), ('104'), ('105')) as n(suffix);

insert into public.owned_products (id, user_id, product_name, gtin, purchase_country_code)
values
  (pg_temp.id('1'), pg_temp.id('9001'), 'Item one', '091021037090', 'US'),    -- P1 GTIN-12
  (pg_temp.id('2'), pg_temp.id('9001'), 'Item two', '0091021037090', 'US'),   -- P2 GTIN-13
  (pg_temp.id('3'), pg_temp.id('9001'), 'Item three', '00091021037090', 'US'),-- P3 GTIN-14
  (pg_temp.id('4'), pg_temp.id('9001'), 'Item four', '4006381333931', 'US'),  -- P4 other GTIN
  (pg_temp.id('5'), pg_temp.id('9001'), 'Item five', '0091021037091', 'US'),  -- P5 bad check digit
  (pg_temp.id('6'), pg_temp.id('9001'), 'Item six', '04252614', 'US');        -- P6 8 digits, no symbology

create function pg_temp.products_for(p_notice text) returns text language sql as $$
  select coalesce(string_agg(right(c.owned_product_id::text, 1) || ':' || c.exact_rank, ','
    order by c.owned_product_id), '')
  from public.get_recall_candidates(pg_temp.id(p_notice), null, null, 250) c
  where c.owned_product_id between pg_temp.id('1') and pg_temp.id('6');
$$;
create function pg_temp.notices_for(p_product text) returns text language sql as $$
  select coalesce(string_agg(right(c.recall_notice_id::text, 3) || ':' || c.exact_rank, ','
    order by c.recall_notice_id), '')
  from public.get_owned_product_recall_candidates(pg_temp.id(p_product), null, null, 100) c
  where c.recall_notice_id between pg_temp.id('101') and pg_temp.id('105');
$$;

-- ===========================================================================
-- The EXECUTE grant only serves index maintenance: an API role writes indexed rows,
-- but still cannot reach schema private (no USAGE), its tables, or the function by name.
-- ===========================================================================
create function pg_temp.sqlstate_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'state:ok';
exception when others then
  return 'state:' || sqlstate;
end $$;

select set_config('request.jwt.claims',
  pg_catalog.json_build_object('role', 'authenticated', 'sub', pg_temp.id('9001'))::text, true);
set local role authenticated;
select set_config('t173s.insert', pg_temp.sqlstate_of(
  $q$insert into public.owned_products (id, user_id, product_name, gtin, purchase_country_code)
     values ('17350000-0000-4000-8000-000000000007', '17350000-0000-4000-8000-000000009001',
       'Item seven', '0091021037090', 'US')$q$), true);
select set_config('t173s.private_table', pg_temp.sqlstate_of(
  'select count(*) from private.owned_product_recall_checks'), true);
select set_config('t173s.private_control', pg_temp.sqlstate_of(
  'select count(*) from private.recall_automation_control'), true);
select set_config('t173s.private_function', pg_temp.sqlstate_of(
  $q$select private.canonical_gtin14('091021037090')$q$), true);
set local role anon;
select set_config('t173s.anon_function', pg_temp.sqlstate_of(
  $q$select private.canonical_gtin14('091021037090')$q$), true);
set local role postgres;
select set_config('request.jwt.claims', '', true);

select extensions.is(current_setting('t173s.insert'), 'state:ok',
  'authenticated inserts an owned product with a 13-digit GTIN (index expression evaluated)');
select extensions.is(
  (select gtin || '|' || private.canonical_gtin14(gtin) from public.owned_products
    where id = pg_temp.id('7')),
  '0091021037090|00091021037090', 'the raw value is stored as typed and indexed canonically');
select extensions.is(current_setting('t173s.private_table'), 'state:42501',
  'authenticated still cannot read private.owned_product_recall_checks');
select extensions.is(current_setting('t173s.private_control'), 'state:42501',
  'authenticated still cannot read private.recall_automation_control');
select extensions.is(current_setting('t173s.private_function'), 'state:42501',
  'authenticated cannot call private.canonical_gtin14 by name (no USAGE on private)');
select extensions.is(current_setting('t173s.anon_function'), 'state:42501',
  'anon cannot call private.canonical_gtin14');
delete from public.owned_products where id = pg_temp.id('7');

-- ===========================================================================
-- Candidate generation, recall -> products (get_recall_candidates).
-- ===========================================================================
select extensions.is(pg_temp.products_for('101'), '1:4,2:4,3:4',
  'N1 (12 digits) retrieves P1, P2 and P3 with the same GTIN rank');
select extensions.is(pg_temp.products_for('105'), '1:4,2:4,3:4',
  'N5 (GTIN-14) retrieves P1, P2 and P3 with the same GTIN rank');
select extensions.is(pg_temp.products_for('102'), '1:4',
  'legacy digit-string equality is kept (nothing narrowed)');
select extensions.is(pg_temp.products_for('103'), '4:4', 'a different GTIN retrieves only its product');
select extensions.is(pg_temp.products_for('104'), '',
  'an 8-digit value is never expanded as UPC-E without symbology');

-- ===========================================================================
-- Candidate generation, product -> recalls (get_owned_product_recall_candidates).
-- ===========================================================================
select extensions.is(pg_temp.notices_for('1'), '101:4,102:4,105:4', 'P1 finds N1, N2 and N5');
select extensions.is(pg_temp.notices_for('2'), '101:4,105:4', 'P2 (13 digits) finds N1 and N5');
select extensions.is(pg_temp.notices_for('3'), '101:4,105:4', 'P3 (14 digits) finds N1 and N5');
select extensions.is(pg_temp.notices_for('4'), '103:4', 'P4 finds only its own GTIN');
select extensions.is(pg_temp.notices_for('5'), '', 'an invalid check digit never gets a canonical key');
select extensions.is(pg_temp.notices_for('6'), '', 'P6 is not guessed to be a UPC-E');
select extensions.is(
  (select count(distinct (c.recall_notice_id, c.external_id, c.authority, c.official_url, c.title,
      c.recall_date, c.scopes, c.jurisdictions, c.exact_rank))::integer
    from unnest(array['1', '2', '3']) p(suffix)
    cross join lateral public.get_owned_product_recall_candidates(pg_temp.id(p.suffix), null, null, 100) c
    where c.recall_notice_id = pg_temp.id('101')),
  1, 'P1, P2 and P3 receive the identical N1 candidate row');

select extensions.is(
  (select count(*)::integer from (
    select c.owned_product_id, n.id as recall_notice_id, c.exact_rank
    from public.recall_notices n
    cross join lateral public.get_recall_candidates(n.id, null, null, 250) c
    where n.id between pg_temp.id('101') and pg_temp.id('105')
      and c.owned_product_id between pg_temp.id('1') and pg_temp.id('6')
    except
    select p.id, c.recall_notice_id, c.exact_rank
    from public.owned_products p
    cross join lateral public.get_owned_product_recall_candidates(p.id, null, null, 100) c
    where p.id between pg_temp.id('1') and pg_temp.id('6')) as only_one_direction),
  0, 'both directions agree on every (product, recall, rank)');

-- ===========================================================================
-- Historical data: raw values are kept; canonical keys are derived, never stored.
-- ===========================================================================
select extensions.is(
  (select string_agg(gtin, ',' order by id) from public.owned_products
    where id between pg_temp.id('1') and pg_temp.id('6')),
  '091021037090,0091021037090,00091021037090,4006381333931,0091021037091,04252614',
  'raw GTIN values (valid and invalid) stay exactly as stored');
select extensions.is(
  (select string_agg(coalesce(private.canonical_gtin14(gtin), '-'), ',' order by id)
    from public.owned_products where id between pg_temp.id('1') and pg_temp.id('6')),
  '00091021037090,00091021037090,00091021037090,04006381333931,-,-',
  'canonical keys: equivalent rows converge, invalid rows fail closed');

-- ===========================================================================
-- F-4 stays the final gate: equivalence creates no automatic alert.
-- ===========================================================================
select extensions.is(
  (select string_agg(private.automatic_alert_eligibility(pg_temp.id(p.suffix), pg_temp.id('101')),
      ',' order by p.suffix)
    from unnest(array['1', '2', '3']) p(suffix)),
  'unsupported_scope,unsupported_scope,unsupported_scope',
  'a GTIN-only scope is never eligible, whatever the representation');

create function pg_temp.v1(p_product text, p_notice text) returns text language plpgsql as $$
declare v_lease uuid; v_p timestamptz; v_n timestamptz; v_gtin text; v_fp text; r record;
begin
  select updated_at, gtin into v_p, v_gtin from public.owned_products where id = pg_temp.id(p_product);
  select updated_at into v_n from public.recall_notices where id = pg_temp.id(p_notice);
  v_fp := encode(sha256(convert_to('p173s:' || p_product || ':' || p_notice, 'UTF8')), 'hex');
  select c.lease_token into v_lease from public.claim_recall_match_evaluation(
    pg_temp.id(p_product), pg_temp.id(p_notice), v_fp, v_p, v_n, 60) c;
  select * into r from public.finalize_recall_match_evaluation(
    pg_temp.id(p_product), pg_temp.id(p_notice), v_fp, v_p, v_n, v_lease,
    'confirmed', 1, 'deterministic_v1', jsonb_build_object('gtin', jsonb_build_array(v_gtin)),
    'Equivalent valid GTIN.', null, null, '1.0.0');
  return concat_ws('|', r.status, r.stored_status, coalesce(r.safety_status, '-'), r.alert_outcome);
end $$;

select extensions.is(pg_temp.v1(p.suffix, '101'), 'finalized|needs_review|unsupported_scope|none',
  'v1 confirmed on an equivalent GTIN is stored as needs_review, no alert (P' || p.suffix || ')')
from unnest(array['1', '2', '3']) p(suffix);
select extensions.is(
  (select count(*)::integer from public.alerts a
    join public.recall_matches m on m.id = a.recall_match_id
    where m.owned_product_id between pg_temp.id('1') and pg_temp.id('6')),
  0, 'no alert exists for any Thule representation');
select extensions.is(
  (select string_agg(status::text || ':' || (matched_identifiers->'gtin'->>0), ','
      order by owned_product_id)
    from public.recall_matches where recall_notice_id = pg_temp.id('101')),
  'needs_review:091021037090,needs_review:0091021037090,needs_review:00091021037090',
  'each candidate stays observable with its own raw GTIN');

select * from extensions.finish();
rollback;
