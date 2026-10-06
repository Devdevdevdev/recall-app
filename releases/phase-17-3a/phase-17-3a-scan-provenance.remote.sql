-- Phase 17.3a REMOTE verification suite (rollback-only). Derived deterministically from
-- supabase/tests/phase-17-3a-scan-provenance.sql (commit b440a2f) by
-- releases/phase-17-3a/build-remote-suite.py: the pgTAP install line is removed (the runner
-- injects a transaction-scoped pgTAP), the transient REVOKE/GRANT probe is removed (never change a
-- production privilege, even rolled back; it is proved locally), and production guards, timeouts
-- and frozen fingerprints are added. Run ONLY with: npm run test:remote-pgtap -- --file <this file>
-- Phase 17.3a: scan provenance columns on owned_products. The provenance describes the CURRENT
-- gtin (kept while it stays canonically equivalent, cleared otherwise), is never a matching
-- input, and a UPC-E saved as its UPC-A matches through the unchanged Phase 17.3-S canonical
-- retrieval, while an 8-digit value without symbology does not.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local idle_in_transaction_session_timeout = '60s';
do $guard$
begin
  if pg_catalog.to_regprocedure('private.expand_upce_to_upca(text)') is null
    or (select count(*) from information_schema.columns where table_schema = 'public'
          and table_name = 'owned_products' and column_name in ('barcode_raw_value', 'barcode_symbology')) <> 2 then
    raise exception 'Phase 17.3a is not installed: the remote suite refuses to run';
  end if;
  if pg_catalog.to_regprocedure('private.automatic_alert_eligibility(uuid,uuid)') is null then
    raise exception 'Phase 17.7a F-4 is not installed: the remote suite refuses to run';
  end if;
end;
$guard$;
set local role postgres;
select extensions.no_plan();

select extensions.has_column('public', 'owned_products', 'barcode_raw_value', 'barcode_raw_value exists');
select extensions.has_column('public', 'owned_products', 'barcode_symbology', 'barcode_symbology exists');
select extensions.col_is_null('public', 'owned_products', 'barcode_raw_value', 'barcode_raw_value is nullable');
select extensions.col_is_null('public', 'owned_products', 'barcode_symbology', 'barcode_symbology is nullable');
select extensions.col_hasnt_default('public', 'owned_products', 'barcode_raw_value', 'no inferred raw value');
select extensions.col_hasnt_default('public', 'owned_products', 'barcode_symbology', 'no inferred symbology');

create function pg_temp.id(p_suffix text) returns uuid language sql immutable as $$
  select ('173a0000-0000-4000-8000-' || lpad(p_suffix, 12, '0'))::uuid;
$$;

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values (pg_temp.id('9001'), 'authenticated', 'authenticated', 'p173a@example.invalid', '', now(),
  '{}', '{}', now(), now());

select set_config('t173a.source', public.ensure_cpsc_recall_source()::text, true);

insert into public.recall_notices (id, source_id, external_id, title, recall_date, official_url,
  retrieved_at, raw_payload)
select pg_temp.id(n.suffix), current_setting('t173a.source')::uuid, 'p173a-' || n.suffix,
  'Phase seventeen three a notice ' || n.suffix, date '2020-08-12',
  'https://www.cpsc.gov/Recalls/2020/P173A-' || n.suffix, now(), '{}'::jsonb
from (values ('101'), ('102')) as n(suffix);

insert into public.recall_scopes (recall_notice_id, gtin)
values
  (pg_temp.id('101'), '042100005264'),   -- N1: UPC-A expansion of UPC-E 04252614
  (pg_temp.id('102'), '091021037090');   -- N2: UPC-A

insert into public.recall_notice_jurisdictions (recall_notice_id, jurisdiction_type, jurisdiction_code)
select pg_temp.id(n.suffix), 'country', 'US' from (values ('101'), ('102')) as n(suffix);

create function pg_temp.sqlstate_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'state:ok';
exception when others then
  return 'state:' || sqlstate;
end $$;

create function pg_temp.notices_for(p_product text) returns text language sql as $$
  select coalesce(string_agg(right(c.recall_notice_id::text, 3) || ':' || c.exact_rank, ','
    order by c.recall_notice_id), '')
  from public.get_owned_product_recall_candidates(pg_temp.id(p_product), null, null, 100) c
  where c.recall_notice_id between pg_temp.id('101') and pg_temp.id('102');
$$;

-- ===========================================================================
-- The app writes provenance as the authenticated owner (RLS unchanged).
-- ===========================================================================
select set_config('request.jwt.claims',
  pg_catalog.json_build_object('role', 'authenticated', 'sub', pg_temp.id('9001'))::text, true);
set local role authenticated;
select set_config('t173a.upce', pg_temp.sqlstate_of($q$
  insert into public.owned_products (id, user_id, product_name, gtin, purchase_country_code,
    identification_method, barcode_raw_value, barcode_symbology)
  values ('173a0000-0000-4000-8000-000000000001', '173a0000-0000-4000-8000-000000009001',
    'UPC-E scan', '042100005264', 'US', 'barcode_scan', '04252614', 'upc_e')$q$), true);
select set_config('t173a.upca', pg_temp.sqlstate_of($q$
  insert into public.owned_products (id, user_id, product_name, gtin, purchase_country_code,
    identification_method, barcode_raw_value, barcode_symbology)
  values ('173a0000-0000-4000-8000-000000000002', '173a0000-0000-4000-8000-000000009001',
    'UPC-A scan', '091021037090', 'US', 'barcode_scan', '091021037090', 'upc_a')$q$), true);
select set_config('t173a.manual8', pg_temp.sqlstate_of($q$
  insert into public.owned_products (id, user_id, product_name, gtin, purchase_country_code,
    identification_method)
  values ('173a0000-0000-4000-8000-000000000003', '173a0000-0000-4000-8000-000000009001',
    'Manual eight digits', '04252614', 'US', 'manual')$q$), true);
select set_config('t173a.edit', pg_temp.sqlstate_of($q$
  update public.owned_products set product_name = 'UPC-E scan, renamed', brand = 'Brand'
  where id = '173a0000-0000-4000-8000-000000000001'$q$), true);
-- Exactly what the app's update sends: every editable column, gtin unchanged.
select set_config('t173a.edit_same_gtin', pg_temp.sqlstate_of($q$
  update public.owned_products set gtin = '042100005264', model_number = 'M-1'
  where id = '173a0000-0000-4000-8000-000000000001'$q$), true);

-- Update scenarios P4..P9, all scanned UPC-E 04252614 (gtin 042100005264), plus P10 legacy.
select set_config('t173a.fixtures', pg_temp.sqlstate_of($q$
  insert into public.owned_products (id, user_id, product_name, gtin, purchase_country_code,
    identification_method, barcode_raw_value, barcode_symbology)
  select ('173a0000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
    '173a0000-0000-4000-8000-000000009001', 'UPC-E scan ' || n, '042100005264', 'US',
    'barcode_scan', '04252614', 'upc_e'
  from pg_catalog.generate_series(4, 9) as n$q$), true);
select set_config('t173a.legacy', pg_temp.sqlstate_of($q$
  insert into public.owned_products (id, user_id, product_name, gtin, purchase_country_code)
  values ('173a0000-0000-4000-8000-000000000010', '173a0000-0000-4000-8000-000000009001',
    'Legacy product', '091021037090', 'US')$q$), true);
select set_config('t173a.u4', pg_temp.sqlstate_of($q$update public.owned_products
  set gtin = '00042100005264' where id = '173a0000-0000-4000-8000-000000000004'$q$), true);
select set_config('t173a.u5', pg_temp.sqlstate_of($q$update public.owned_products
  set gtin = '012345678905' where id = '173a0000-0000-4000-8000-000000000005'$q$), true);
select set_config('t173a.u6', pg_temp.sqlstate_of($q$update public.owned_products
  set gtin = null where id = '173a0000-0000-4000-8000-000000000006'$q$), true);
select set_config('t173a.u7', pg_temp.sqlstate_of($q$update public.owned_products
  set gtin = '042100005265' where id = '173a0000-0000-4000-8000-000000000007'$q$), true);
select set_config('t173a.u8a', pg_temp.sqlstate_of($q$update public.owned_products
  set gtin = '0042100005264' where id = '173a0000-0000-4000-8000-000000000008'$q$), true);
select set_config('t173a.u8b', pg_temp.sqlstate_of($q$update public.owned_products
  set gtin = '00042100005264' where id = '173a0000-0000-4000-8000-000000000008'$q$), true);
select set_config('t173a.u8c', pg_temp.sqlstate_of($q$update public.owned_products
  set gtin = '042100005264' where id = '173a0000-0000-4000-8000-000000000008'$q$), true);
select set_config('t173a.u9a', pg_temp.sqlstate_of($q$update public.owned_products
  set gtin = '012345678905' where id = '173a0000-0000-4000-8000-000000000009'$q$), true);
select set_config('t173a.u9b', pg_temp.sqlstate_of($q$update public.owned_products
  set gtin = '042100005264' where id = '173a0000-0000-4000-8000-000000000009'$q$), true);
select set_config('t173a.u10', pg_temp.sqlstate_of($q$update public.owned_products
  set gtin = '4006381333931' where id = '173a0000-0000-4000-8000-000000000010'$q$), true);
-- Re-attaching provenance that does not describe gtin is refused.
select set_config('t173a.reattach', pg_temp.sqlstate_of($q$update public.owned_products
  set barcode_raw_value = '091021037090', barcode_symbology = 'upc_a'
  where id = '173a0000-0000-4000-8000-000000000005'$q$), true);
set local role postgres;
select set_config('request.jwt.claims', '', true);

select extensions.is(current_setting('t173a.upce'), 'state:ok',
  'authenticated owner saves a UPC-E scan (gtin = UPC-A, raw = UPC-E)');
select extensions.is(current_setting('t173a.upca'), 'state:ok', 'authenticated owner saves a UPC-A scan');
select extensions.is(current_setting('t173a.manual8'), 'state:ok',
  'a manual product needs no provenance');
select extensions.is(current_setting('t173a.edit'), 'state:ok', 'the owner can edit a scanned product');

select extensions.is(
  (select gtin || '|' || barcode_raw_value || '|' || barcode_symbology || '|'
      || private.canonical_gtin14(gtin)
    from public.owned_products where id = pg_temp.id('1')),
  '042100005264|04252614|upc_e|00042100005264',
  'UPC-E: raw and symbology preserved; the matching GTIN has the expected canonical key');
select extensions.is(
  (select barcode_raw_value || '|' || barcode_symbology from public.owned_products
    where id = pg_temp.id('1')),
  '04252614|upc_e', 'name, brand, model edits and an unchanged gtin keep the provenance');
select extensions.is(current_setting('t173a.edit_same_gtin'), 'state:ok',
  'the app update shape (gtin re-sent unchanged) succeeds as authenticated');

-- ===========================================================================
-- Provenance describes the CURRENT gtin (BEFORE UPDATE trigger, run as authenticated).
-- ===========================================================================
create function pg_temp.provenance(p_suffix text) returns text language sql as $$
  select coalesce(gtin, '<null>') || '|' || coalesce(barcode_raw_value, '<null>') || '|'
    || coalesce(barcode_symbology, '<null>')
  from public.owned_products where id = pg_temp.id(p_suffix);
$$;

select extensions.is(
  current_setting('t173a.fixtures') || current_setting('t173a.legacy')
    || current_setting('t173a.u4') || current_setting('t173a.u5') || current_setting('t173a.u6')
    || current_setting('t173a.u7') || current_setting('t173a.u8a') || current_setting('t173a.u8b')
    || current_setting('t173a.u8c') || current_setting('t173a.u9a') || current_setting('t173a.u9b')
    || current_setting('t173a.u10'),
  repeat('state:ok', 12), 'every update scenario succeeds as authenticated');
select extensions.is(pg_temp.provenance('4'), '00042100005264|04252614|upc_e',
  'equivalent GTIN-14 representation keeps the provenance');
select extensions.is(pg_temp.provenance('5'), '012345678905|<null>|<null>',
  'a non-equivalent GTIN clears the provenance');
select extensions.is(pg_temp.provenance('6'), '<null>|<null>|<null>',
  'removing the GTIN clears the provenance');
select extensions.is(pg_temp.provenance('7'), '042100005265|<null>|<null>',
  'an invalid GTIN clears the provenance (fail closed)');
select extensions.is(pg_temp.provenance('8'), '042100005264|04252614|upc_e',
  '12 -> 13 -> 14 -> 12 equivalent representations keep the provenance');
select extensions.is(pg_temp.provenance('9'), '042100005264|<null>|<null>',
  'once cleared, restoring the old GTIN does not resurrect the provenance');
select extensions.is(pg_temp.provenance('10'), '4006381333931|<null>|<null>',
  'a historical product without provenance updates normally and stays without provenance');
select extensions.is(current_setting('t173a.reattach'), 'state:23514',
  'provenance that does not describe the current gtin cannot be written');
select extensions.is(
  (select count(*)::integer from public.owned_products where barcode_symbology is not null
    and private.canonical_gtin14(gtin) is null),
  0, 'no row keeps provenance without a valid current gtin');
select extensions.ok(
  (select barcode_raw_value is null and barcode_symbology is null from public.owned_products
    where id = pg_temp.id('3')),
  'a manual 8-digit product gets no invented symbology');

-- ===========================================================================
-- Matching: unchanged 17.3-S retrieval, gtin only.
-- ===========================================================================
select extensions.is(pg_temp.notices_for('1'), '101:4',
  'a UPC-E saved as its UPC-A retrieves the UPC-A recall scope');
select extensions.is(pg_temp.notices_for('2'), '102:4', 'a UPC-A scan retrieves its scope');
select extensions.is(pg_temp.notices_for('3'), '',
  'a manual 8-digit value is a GTIN-8, never guessed to be a UPC-E');

-- ===========================================================================
-- Constraints fail closed.
-- ===========================================================================
create function pg_temp.insert_state(p_gtin text, p_raw text, p_symbology text) returns text
language sql as $$
  select pg_temp.sqlstate_of(pg_catalog.format(
    'insert into public.owned_products (user_id, product_name, gtin, barcode_raw_value, barcode_symbology)
     values (%L, %L, %L, %L, %L)', pg_temp.id('9001'), 'constraint probe', p_gtin, p_raw, p_symbology));
$$;

select extensions.is(pg_temp.insert_state('042100005264', '04252614', null), 'state:23514',
  'raw without symbology is rejected');
select extensions.is(pg_temp.insert_state('042100005264', null, 'upc_e'), 'state:23514',
  'symbology without raw is rejected');
select extensions.is(pg_temp.insert_state('091021037090', '091021037090', 'code128'), 'state:23514',
  'code128 is not a GTIN carrier');
select extensions.is(pg_temp.insert_state('091021037090', '091021037090', 'qr'), 'state:23514',
  'an unknown symbology is rejected');
select extensions.is(pg_temp.insert_state('091021037090', ' 091021037090', 'upc_a'), 'state:23514',
  'a raw value with whitespace is rejected (never trimmed silently)');
select extensions.is(pg_temp.insert_state('01234565', '01234565', 'upc_a'), 'state:23514',
  'UPC-A cannot carry 8 digits');
select extensions.is(pg_temp.insert_state('00091021037090', '00091021037090', 'ean13'), 'state:23514',
  'EAN-13 cannot carry 14 digits');
select extensions.is(pg_temp.insert_state('0425261', '0425261', 'upc_e'), 'state:23514',
  'a 7-digit UPC-E payload is rejected');
select extensions.is(pg_temp.insert_state('091021037090', '091021037090', 'itf14'), 'state:23514',
  'ITF-14 carries exactly 14 digits');
select extensions.is(pg_temp.insert_state('09102103709A', '09102103709A', 'upc_a'), 'state:23514',
  'a non-numeric raw value is rejected');
select extensions.is(pg_temp.insert_state(null, '04252614', 'upc_e'), 'state:23514',
  'provenance without a current gtin is rejected');
select extensions.is(pg_temp.insert_state('042100005265', '04252614', 'upc_e'), 'state:23514',
  'provenance with an invalid current gtin is rejected');
select extensions.is(pg_temp.insert_state('4006381333931', '091021037090', 'upc_a'), 'state:23514',
  'a UPC-A raw value must have the same canonical GTIN-14 as gtin');
select extensions.is(pg_temp.insert_state('042100005264', '042100005264', 'upc_e'), 'state:ok',
  'an already expanded 12-digit UPC-E must equal gtin canonically');
select extensions.is(pg_temp.insert_state('4006381333931', '042100005264', 'upc_e'), 'state:23514',
  'an expanded 12-digit UPC-E describing another gtin is rejected');
select extensions.is(pg_temp.insert_state('4006381333931', null, null), 'state:ok',
  'rows without provenance (manual and historical) are unaffected');
select extensions.is(pg_temp.insert_state('00091021037090', '00091021037090', 'itf14'), 'state:ok',
  'a 14-digit ITF-14 is accepted');
select extensions.is(pg_temp.insert_state('0091021037090', '0091021037090', 'upc_a'), 'state:ok',
  'EAN-13 and UPC-A share one symbol family (12 or 13 digits)');

-- ===========================================================================
-- UPC-E provenance is checked in SQL too (private.expand_upce_to_upca, symbology-aware).
-- ===========================================================================
select extensions.ok(
  (select p.provolatile = 'i' and p.proisstrict and not p.prosecdef and p.prosqlbody is not null
      and p.proconfig = array['search_path=""']
    from pg_proc p where p.oid = 'private.expand_upce_to_upca(text)'::regprocedure),
  'expand_upce_to_upca: immutable, strict, invoker rights, empty search_path, SQL-standard body');
select extensions.ok(
  not pg_catalog.has_function_privilege('anon', 'private.expand_upce_to_upca(text)', 'EXECUTE')
  and not exists (
    select 1 from pg_proc p, pg_catalog.aclexplode(p.proacl) acl
    where p.oid = 'private.expand_upce_to_upca(text)'::regprocedure and acl.grantee = 0),
  'expand_upce_to_upca is not executable by anon or PUBLIC');
select extensions.ok(
  pg_catalog.has_function_privilege('authenticated', 'private.expand_upce_to_upca(text)', 'EXECUTE')
  and pg_catalog.has_function_privilege('service_role', 'private.expand_upce_to_upca(text)', 'EXECUTE'),
  'the two roles that write owned_products can evaluate the constraint');
select extensions.ok(
  not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r
    where pg_catalog.has_schema_privilege(r, 'private', 'USAGE')),
  'no API role can reach schema private by name');
select extensions.is(
  (select pg_catalog.string_agg(c.relname, ',') from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relkind in ('r', 'p', 'v', 'm')
      and (pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
        or pg_catalog.has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))),
  null, 'no private table is granted to an API role');

-- Shared vectors: the two JSON blocks below are byte-identical to
-- tests/fixtures/phase-17-3-s-gtin-vectors.json and tests/fixtures/phase-17-3a-upce-vectors.json
-- (checked by tests/phase-17-3a-scan-identity.test.mjs, which runs them through expandUpcE).
create function pg_temp.upce_mismatches(p_vectors jsonb) returns text language sql as $$
  select coalesce(pg_catalog.string_agg(v ->> 'id', ','), '')
  from jsonb_array_elements(p_vectors -> 'upce') v
  where private.expand_upce_to_upca(v ->> 'input') is distinct from v ->> 'expanded'
    or private.canonical_gtin14(private.expand_upce_to_upca(v ->> 'input'))
      is distinct from v ->> 'canonical';
$$;
select extensions.is(pg_temp.upce_mismatches($vectors$
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
$vectors$::jsonb), '', 'every 17.3-S UPC-E vector: SQL expansion = expandUpcE');
select extensions.is(pg_temp.upce_mismatches($vectors173a$
{
  "schema": "phase-17-3a-upce-vectors/v1",
  "note": "Supplements the upce list of phase-17-3-s-gtin-vectors.json. Expected values were computed with expandUpcE (supabase/functions/_shared/matching/gtin.ts) and checked by hand for 12345639 and 01234565. private.expand_upce_to_upca must return exactly `expanded`; like expandUpcE it never trims.",
  "upce": [
    {
      "id": "upc-e-d6-6",
      "input": "01234565",
      "expanded": "012345000065",
      "canonical": "00012345000065"
    },
    {
      "id": "upc-e-d6-7",
      "input": "01234572",
      "expanded": "012345000072",
      "canonical": "00012345000072"
    },
    {
      "id": "upc-e-d6-8",
      "input": "01234589",
      "expanded": "012345000089",
      "canonical": "00012345000089"
    },
    {
      "id": "upc-e-number-system-1-d6-2",
      "input": "19876520",
      "expanded": "198200007650",
      "canonical": "00198200007650"
    },
    {
      "id": "upc-e-number-system-1-d6-3",
      "input": "12345639",
      "expanded": "123400000569",
      "canonical": "00123400000569"
    },
    {
      "id": "upc-e-number-system-1-d6-4",
      "input": "12345649",
      "expanded": "123450000069",
      "canonical": "00123450000069"
    },
    {
      "id": "upc-e-also-valid-ean-8",
      "input": "01234558",
      "expanded": "012345000058",
      "canonical": "00012345000058"
    },
    {
      "id": "valid-ean-8-not-upc-e",
      "input": "96385074",
      "expanded": null,
      "canonical": null
    },
    {
      "id": "upc-e-number-system-9",
      "input": "94252614",
      "expanded": null,
      "canonical": null
    },
    {
      "id": "upc-e-9-digits",
      "input": "042526140",
      "expanded": null,
      "canonical": null
    },
    { "id": "upc-e-empty", "input": "", "expanded": null, "canonical": null },
    {
      "id": "upc-e-non-digit",
      "input": "0425261A",
      "expanded": null,
      "canonical": null
    },
    {
      "id": "upc-e-leading-space",
      "input": " 04252614",
      "expanded": null,
      "canonical": null
    },
    {
      "id": "upc-e-trailing-space",
      "input": "04252614 ",
      "expanded": null,
      "canonical": null
    },
    {
      "id": "upc-e-trailing-newline",
      "input": "04252614\n",
      "expanded": null,
      "canonical": null
    }
  ]
}
$vectors173a$::jsonb), '', 'every 17.3a UPC-E vector (all branches, both number systems, no trim)');
select extensions.ok(
  jsonb_array_length(($vectors173a$
{
  "schema": "phase-17-3a-upce-vectors/v1",
  "note": "Supplements the upce list of phase-17-3-s-gtin-vectors.json. Expected values were computed with expandUpcE (supabase/functions/_shared/matching/gtin.ts) and checked by hand for 12345639 and 01234565. private.expand_upce_to_upca must return exactly `expanded`; like expandUpcE it never trims.",
  "upce": [
    {
      "id": "upc-e-d6-6",
      "input": "01234565",
      "expanded": "012345000065",
      "canonical": "00012345000065"
    },
    {
      "id": "upc-e-d6-7",
      "input": "01234572",
      "expanded": "012345000072",
      "canonical": "00012345000072"
    },
    {
      "id": "upc-e-d6-8",
      "input": "01234589",
      "expanded": "012345000089",
      "canonical": "00012345000089"
    },
    {
      "id": "upc-e-number-system-1-d6-2",
      "input": "19876520",
      "expanded": "198200007650",
      "canonical": "00198200007650"
    },
    {
      "id": "upc-e-number-system-1-d6-3",
      "input": "12345639",
      "expanded": "123400000569",
      "canonical": "00123400000569"
    },
    {
      "id": "upc-e-number-system-1-d6-4",
      "input": "12345649",
      "expanded": "123450000069",
      "canonical": "00123450000069"
    },
    {
      "id": "upc-e-also-valid-ean-8",
      "input": "01234558",
      "expanded": "012345000058",
      "canonical": "00012345000058"
    },
    {
      "id": "valid-ean-8-not-upc-e",
      "input": "96385074",
      "expanded": null,
      "canonical": null
    },
    {
      "id": "upc-e-number-system-9",
      "input": "94252614",
      "expanded": null,
      "canonical": null
    },
    {
      "id": "upc-e-9-digits",
      "input": "042526140",
      "expanded": null,
      "canonical": null
    },
    { "id": "upc-e-empty", "input": "", "expanded": null, "canonical": null },
    {
      "id": "upc-e-non-digit",
      "input": "0425261A",
      "expanded": null,
      "canonical": null
    },
    {
      "id": "upc-e-leading-space",
      "input": " 04252614",
      "expanded": null,
      "canonical": null
    },
    {
      "id": "upc-e-trailing-space",
      "input": "04252614 ",
      "expanded": null,
      "canonical": null
    },
    {
      "id": "upc-e-trailing-newline",
      "input": "04252614\n",
      "expanded": null,
      "canonical": null
    }
  ]
}
$vectors173a$::jsonb) -> 'upce') >= 15, '17.3a vectors are present');
select extensions.is(private.expand_upce_to_upca(null), null, 'NULL in, NULL out (strict)');
select extensions.is(private.canonical_gtin14('04252614'), null,
  'canonical_gtin14 is unchanged: 8 digits without symbology are never expanded');

-- A..F: insert invariant.
select extensions.is(pg_temp.insert_state('042100005264', '04252614', 'upc_e'), 'state:ok',
  'A: UPC-E raw with its UPC-A gtin is accepted');
select extensions.is(pg_temp.insert_state('00042100005264', '04252614', 'upc_e'), 'state:ok',
  'B: UPC-E raw with the equivalent GTIN-14 is accepted');
select extensions.is(pg_temp.insert_state('0042100005264', '04252614', 'upc_e'), 'state:ok',
  'B: UPC-E raw with the equivalent GTIN-13 is accepted');
select extensions.is(pg_temp.insert_state('012345678905', '04252614', 'upc_e'), 'state:23514',
  'C: UPC-E raw with another product''s GTIN is rejected');
select extensions.is(pg_temp.insert_state('4006381333931', '04252614', 'upc_e'), 'state:23514',
  'C: UPC-E raw with an unrelated EAN-13 is rejected');
select extensions.is(pg_temp.insert_state('042100005264', '04252615', 'upc_e'), 'state:23514',
  'D: UPC-E with a bad check digit is rejected');
select extensions.is(pg_temp.insert_state('042100005264', '24252614', 'upc_e'), 'state:23514',
  'D: UPC-E number system 2 is rejected');
select extensions.is(pg_temp.insert_state('96385074', '96385074', 'ean8'), 'state:ok',
  'E: an EAN-8 with symbology ean8 is a GTIN-8');
select extensions.is(pg_temp.insert_state('01234558', '01234558', 'ean8'), 'state:ok',
  'E: 01234558 under ean8 is the GTIN-8 01234558');
select extensions.is(pg_temp.insert_state('012345000058', '01234558', 'ean8'), 'state:23514',
  'E: an ean8 value is never expanded as UPC-E');
select extensions.is(pg_temp.insert_state('012345000058', '01234558', 'upc_e'), 'state:ok',
  'E: the same digits under upc_e are the UPC-A 012345000058');
select extensions.is(pg_temp.insert_state('4006381333931', '96385074', 'ean8'), 'state:23514',
  'F: an EAN-8 raw with a different gtin is rejected');
select extensions.is(pg_temp.insert_state('091021037090', '091021037091', 'upc_a'), 'state:23514',
  'an invalid raw value never passes as a NULL comparison');

-- Re-attaching a UPC-E to another product, and the exact grant the constraint needs.
select set_config('request.jwt.claims',
  pg_catalog.json_build_object('role', 'authenticated', 'sub', pg_temp.id('9001'))::text, true);
set local role authenticated;
select set_config('t173a.reattach_upce', pg_temp.sqlstate_of($q$update public.owned_products
  set barcode_raw_value = '04252614', barcode_symbology = 'upc_e'
  where id = '173a0000-0000-4000-8000-000000000005'$q$), true);
select set_config('t173a.reattach_upce_ok', pg_temp.sqlstate_of($q$update public.owned_products
  set barcode_raw_value = '04252614', barcode_symbology = 'upc_e'
  where id = '173a0000-0000-4000-8000-000000000009'$q$), true);
select set_config('t173a.call_by_name', pg_temp.sqlstate_of(
  $q$select private.expand_upce_to_upca('04252614')$q$), true);
set local role postgres;
select set_config('request.jwt.claims', '', true);

select extensions.is(current_setting('t173a.reattach_upce'), 'state:23514',
  'C: a UPC-E cannot be re-attached to another product''s gtin');
select extensions.is(current_setting('t173a.reattach_upce_ok'), 'state:ok',
  'the matching UPC-E can be attached to its own UPC-A gtin');
select extensions.is(current_setting('t173a.call_by_name'), 'state:42501',
  'authenticated cannot call private.expand_upce_to_upca by name (no USAGE on private)');

-- ===========================================================================
-- Production fingerprints frozen by the 17.3a release review (unchanged by 17.3a).
-- ===========================================================================
select extensions.is(md5(pg_get_functiondef('private.canonical_gtin14(text)'::regprocedure)),
  '1f360d45c59400d5a49ee82636ff680c', 'canonical_gtin14 unchanged (17.3-S body)');
select extensions.is(md5(pg_get_functiondef('public.get_recall_candidates(uuid,integer,uuid,integer)'::regprocedure)),
  '695243ea58ac9b8b7cd61cfe9830555e', 'get_recall_candidates unchanged (17.3-S body)');
select extensions.is(md5(pg_get_functiondef('public.get_owned_product_recall_candidates(uuid,integer,uuid,integer)'::regprocedure)),
  '985de76d0dee90834b720c55d46d7e2e', 'get_owned_product_recall_candidates unchanged (17.3-S body)');
select extensions.is(
  (select md5(string_agg(pg_get_functiondef(p.oid), ',' order by p.oid::regprocedure::text))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'automatic_alert_eligibility%'),
  'b6a31c8dd6b5e631b0ec2a1038483353', 'F-4 eligibility function unchanged');
select extensions.is((select count(*)::integer from pg_trigger where not tgisinternal and tgname in (
  'alerts_require_safe_scope', 'recall_alert_eligibility_v2_require_safe_scope',
  'recall_alert_snapshots_v2_require_safe_scope', 'recall_matches_require_safe_confirmation',
  'recall_match_evaluations_v2_require_safe_confirmation')), 5, 'F-4 guards all five automatic alert writes');
select extensions.is(
  (select to_jsonb(c) - 'updated_at' from private.recall_automation_control c),
  '{"enabled": true, "singleton": true, "ai_enabled": true, "push_enabled": true, "catch_up_days": 7, "overlap_hours": 48, "bootstrap_days": 7, "max_recalls_per_run": 100, "product_check_enabled": true, "max_ai_escalations_per_run": 5, "max_candidate_pairs_per_run": 500, "max_notification_batch_size": 25, "max_product_check_candidates": 25}'::jsonb,
  'automation flags unchanged');
select extensions.is(
  (select jsonb_agg(jsonb_build_object('jobname', jobname, 'schedule', schedule, 'active', active) order by jobid) from cron.job),
  '[{"active": true, "jobname": "recall-automation-every-6h", "schedule": "17 */6 * * *"}]'::jsonb,
  'cron unchanged');

-- ===========================================================================
-- Nothing else changed.
-- ===========================================================================
select extensions.is(
  (select pg_catalog.pg_get_triggerdef(t.oid) ~ 'barcode_' from pg_catalog.pg_trigger t
    where t.tgname = 'owned_products_arm_recall_check_update'),
  false, 'the recall-check arming trigger does not watch provenance columns');
select extensions.is(
  (select pg_catalog.string_agg(n.nspname || '.' || p.proname, ',')
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosrc ~ 'barcode_(raw_value|symbology)'),
  'private.clear_stale_owned_product_barcode_provenance',
  'only the clearing trigger touches the provenance columns (not a matching input)');
select extensions.is(
  (select p.prosecdef::text || '|' || pg_catalog.array_to_string(p.proconfig, ',')
    || '|' || coalesce(pg_catalog.array_to_string(p.proacl, ','), '')
    from pg_catalog.pg_proc p where p.proname = 'clear_stale_owned_product_barcode_provenance'),
  'false|search_path=""|postgres=X/postgres',
  'the clearing function is security invoker, pinned search_path, executable by its owner only');
select extensions.is(
  (select t.tgtype::integer & 2 = 2 from pg_catalog.pg_trigger t
    where t.tgname = 'owned_products_clear_stale_barcode_provenance'),
  true, 'the clearing trigger runs BEFORE the row is written');

select * from extensions.finish();
rollback;
