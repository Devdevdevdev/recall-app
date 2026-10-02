import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const [migration, pgTap] = await Promise.all([
  readFile(
    new URL(
      '../supabase/migrations/20260920160000_phase_16_product_safety_evidence.sql',
      import.meta.url,
    ),
    'utf8',
  ),
  readFile(
    new URL('../supabase/tests/phase-16-product-safety-evidence.sql', import.meta.url),
    'utf8',
  ),
]);
const migrationDirectory = new URL('../supabase/migrations/', import.meta.url);
const remediationNames = (await readdir(migrationDirectory)).filter((name) =>
  name.endsWith('_phase_16_fix_immutable_safety_date_validation.sql'),
);
const remediation =
  remediationNames.length === 1
    ? await readFile(new URL(remediationNames[0], migrationDirectory), 'utf8')
    : '';

test('Phase 16 migration is forward-only and adds validated safety attributes without backfill', () => {
  assert.match(migration, /^begin;/u);
  assert.match(migration, /add column safety_attributes jsonb not null default '\{\}'::jsonb/u);
  assert.match(migration, /validate_owned_product_safety_attributes/u);
  assert.match(migration, /variant[\s\S]+color[\s\S]+size[\s\S]+capacity/u);
  assert.match(migration, /manufacture_date[\s\S]+production_date/u);
  assert.doesNotMatch(migration, /update public\.owned_products/u);
  assert.match(migration, /commit;\s*$/u);
});

test('safety attributes inherit owner-only RLS and cannot expose raw OCR or images', () => {
  assert.doesNotMatch(migration, /create table public\.owned_product_attributes/u);
  assert.doesNotMatch(migration, /'raw_ocr'|'image'|SUPABASE_SERVICE_ROLE_KEY/u);
  assert.doesNotMatch(migration, /grant [^;]+ to anon/u);
  assert.match(
    migration,
    /revoke all on function public\.validate_owned_product_safety_attributes\(jsonb\) from public;[\s\S]+revoke all on function public\.validate_owned_product_safety_attributes\(jsonb\) from anon;/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.validate_owned_product_safety_attributes\(jsonb\)[\s\S]+to authenticated, service_role/u,
  );
});

test('adding empty evidence does not reevaluate historical matches', () => {
  assert.doesNotMatch(migration, /recall_matches|alerts|matching_fingerprint/u);
});

test('the pgTAP plan covers constraints, canonical dates, and cross-user isolation', () => {
  assert.match(pgTap, /extensions\.plan\(44\)/u);
  assert.match(pgTap, /PUBLIC cannot execute the constraint validator/u);
  assert.match(pgTap, /authenticated can execute the constraint validator/u);
  assert.match(pgTap, /service_role can execute the constraint validator/u);
  assert.match(pgTap, /anonymous users cannot execute the constraint validator/u);
  assert.match(pgTap, /anonymous users receive no owned_products table privileges/u);
  assert.match(pgTap, /unknown safety keys are rejected/u);
  assert.match(pgTap, /non-string safety values are rejected/u);
  assert.match(pgTap, /non-canonical date formats are rejected/u);
  assert.match(pgTap, /invalid calendar dates are rejected/u);
  assert.match(pgTap, /owner can update richer safety evidence/u);
  assert.match(pgTap, /another user cannot read product evidence/u);
  assert.match(pgTap, /another user cannot update product evidence/u);
  assert.match(pgTap, /anonymous users cannot read product evidence/u);
  assert.match(pgTap, /anonymous users cannot update product evidence/u);
  assert.match(pgTap, /legacy-compatible products receive no fabricated evidence/u);
  assert.match(pgTap, /safety evidence updates preserve created_at/u);
  assert.match(pgTap, /safety evidence updates advance updated_at/u);
  assert.match(pgTap, /do not mutate the existing deterministic_v1 match/u);
  assert.match(pgTap, /do not create an alert/u);
});

test('the forward-only remediation keeps canonical date validation genuinely immutable', () => {
  assert.equal(remediationNames.length, 1);
  assert.ok(remediationNames[0] > '20260920160000_phase_16_product_safety_evidence.sql');
  assert.match(remediation, /^begin;/u);
  assert.match(
    remediation,
    /create or replace function public\.validate_owned_product_safety_attributes\(attributes jsonb\)/u,
  );
  assert.match(remediation, /language plpgsql[\s\S]+immutable[\s\S]+strict/u);
  assert.match(remediation, /set search_path = ''/u);
  assert.match(remediation, /\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\$/u);
  assert.match(remediation, /pg_catalog\.substr\(attribute_value, 1, 4\)::integer/u);
  assert.match(remediation, /pg_catalog\.substr\(attribute_value, 6, 2\)::integer/u);
  assert.match(remediation, /pg_catalog\.substr\(attribute_value, 9, 2\)::integer/u);
  assert.match(remediation, /pg_catalog\.make_date\(/u);
  assert.match(remediation, /exception when others then[\s\S]+return false/u);
  assert.doesNotMatch(remediation, /to_date|to_char|::date|cast\([^)]* as date\)/iu);
  assert.doesNotMatch(
    remediation,
    /drop function|alter table|owned_products|recall_matches|alerts/iu,
  );
  assert.match(
    remediation,
    /revoke all on function public\.validate_owned_product_safety_attributes\(jsonb\) from public;[\s\S]+revoke all on function public\.validate_owned_product_safety_attributes\(jsonb\) from anon;[\s\S]+grant execute on function public\.validate_owned_product_safety_attributes\(jsonb\)[\s\S]+to authenticated, service_role/u,
  );
  assert.match(remediation, /commit;\s*$/u);
});
