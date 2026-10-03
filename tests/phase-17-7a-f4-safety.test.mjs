// Phase 17.7a F-4: automatic alert eligibility. The database derives the proof
// (supabase/tests/phase-17-7a-f4-automatic-alert-safety.sql); these tests keep the
// TypeScript side consistent with it and check the v1 orchestrator reports what the
// database stored.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { normalizeIdentifier } from '../supabase/functions/_shared/matching/normalization.ts';
import { assessJurisdiction } from '../supabase/functions/_shared/productCheck/gate.ts';
import { processRecallMatches } from '../supabase/functions/_shared/recallMatching/orchestrator.ts';

const suite = await readFile(
  new URL('../supabase/tests/phase-17-7a-f4-automatic-alert-safety.sql', import.meta.url),
  'utf8',
);

function block(name) {
  const start = suite.indexOf(`-- ${name}:start`);
  const end = suite.indexOf(`-- ${name}:end`);
  assert.ok(start > 0 && end > start, name);
  return suite.slice(start, end);
}

const sqlText = (value) => (value === 'NULL' ? null : value.slice(1, -1).replaceAll("''", "'"));

test('the SQL and TypeScript jurisdiction rules agree on every shared case', () => {
  const rows = [
    ...block('jurisdiction-parity-cases').matchAll(
      /\('([^']+)', (NULL|'[^']*'), '(\[[^']*\])', '([a-z_]+)'\)/gu,
    ),
  ];
  assert.ok(rows.length >= 10, `parsed ${rows.length} cases`);
  for (const [, label, country, jurisdictions, expected] of rows) {
    assert.equal(assessJurisdiction(sqlText(country), JSON.parse(jurisdictions)), expected, label);
  }
});

test('SQL identifier matching is a subset of the TypeScript normalization', () => {
  const rows = [
    ...block('identifier-parity-cases').matchAll(
      /\('([^']+)', (E?'(?:[^']|'')*'), (NULL|'[^']*')\)/gu,
    ),
  ];
  assert.ok(rows.length >= 5, `parsed ${rows.length} cases`);
  for (const [, label, rawInput, expected] of rows) {
    const input = rawInput.startsWith('E')
      ? rawInput.slice(2, -1).replaceAll('\\t', '\t').replaceAll('\\n', '\n')
      : sqlText(rawInput);
    const sql = sqlText(expected);
    // Where SQL produces a value it must equal the TypeScript value; SQL may withhold.
    if (sql !== null) assert.equal(normalizeIdentifier(input), sql, label);
  }
});

// ---------------------------------------------------------------------------
// v1 orchestrator reports the stored status
// ---------------------------------------------------------------------------
const R1 = '10000000-0000-4000-8000-0000000000f4';
const recallRow = {
  recall_notice_id: R1,
  recall_notice_updated_at: '2026-10-02T00:00:00.000001+00:00',
  source_authority: 'U.S. Consumer Product Safety Commission (CPSC)',
  source_external_id: '8877',
  source_official_url: 'https://www.cpsc.gov/Recalls/2020/Thule',
  source_is_authoritative: true,
  title: 'Thule Recalls Strollers Due to Injury Hazard',
  description: null,
  hazard: null,
  remedy: null,
  recall_date: '2020-08-12',
  raw_payload: {},
  scopes: [
    {
      gtin: '091021037090',
      additional_criteria: { association: 'recall-level', evidence_level: 'recall' },
    },
  ],
};
const productRow = {
  owned_product_id: 'p-f4',
  owned_product_updated_at: '2026-10-01T00:00:00.000001+00:00',
  product_name: 'Thule Sleek stroller',
  brand: 'Thule',
  category: null,
  gtin: '091021037090',
  model_number: null,
  serial_number: null,
  lot_number: null,
  purchase_date: null,
  identification_method: 'barcode_scan',
  exact_rank: 4,
};

function store(finalize) {
  const finalized = [];
  return {
    finalized,
    async listAuthoritativeRecalls({ afterRecallId }) {
      return afterRecallId === null ? [recallRow] : [];
    },
    async listRecallCandidateProducts({ afterProductId }) {
      return afterProductId === null ? [productRow] : [];
    },
    async claimPair() {
      return { status: 'claimed', leaseToken: 'lease' };
    },
    async finalizePair(input) {
      finalized.push(input);
      return finalize(input);
    },
  };
}

const run = (s) =>
  processRecallMatches(
    { maxRecalls: 1, maxCandidatePairs: 10, maxNebiusCalls: 0, recallNoticeIds: [R1] },
    {
      store: s,
      modelId: 'nvidia/nemotron-3-super-120b-a12b',
      createNemotronEvaluator() {
        throw new Error('no AI');
      },
    },
  );

test('v1 still proposes confirmed on a GTIN-only scope; the stored needs_review is what is counted', async () => {
  const s = store(() => ({
    status: 'finalized',
    alertOutcome: 'none',
    storedStatus: 'needs_review',
    safetyStatus: 'unsupported_scope',
  }));
  const summary = await run(s);
  assert.equal(s.finalized[0].status, 'confirmed', 'the matcher decision itself is unchanged');
  assert.equal(summary.confirmed, 0);
  assert.equal(summary.needsReview, 1);
  assert.equal(summary.safetyWithheld, 1);
  assert.equal(summary.alertsCreated, 0);
  assert.deepEqual(summary.resolvedRecallIds, [R1], 'a withheld pair is resolved, not retried');
});

test('a proven confirmation is counted as confirmed, with its alert', async () => {
  const summary = await run(
    store(() => ({
      status: 'finalized',
      alertOutcome: 'created',
      storedStatus: 'confirmed',
      safetyStatus: 'eligible',
    })),
  );
  assert.equal(summary.confirmed, 1);
  assert.equal(summary.safetyWithheld, 0);
  assert.equal(summary.alertsCreated, 1);
});

test('an older database without the F-4 result columns keeps the previous counting', async () => {
  const summary = await run(store(() => ({ status: 'finalized', alertOutcome: 'none' })));
  assert.equal(summary.confirmed, 1);
  assert.equal(summary.safetyWithheld, 0);
});

test('the migration keeps the policy switch, the v1 fingerprint and the allowlist untouched', async () => {
  const migration = await readFile(
    new URL(
      '../supabase/migrations/20261002110000_phase_17_7a_f4_automatic_alert_safety.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const code = migration.replace(/^\s*--.*$/gmu, '');
  assert.doesNotMatch(code, /RECALL_MATCHING_POLICY|phase_16_deterministic_v2/u);
  assert.doesNotMatch(code, /select\s+private\.neutralize_unsafe_automatic_alerts/iu);
  assert.match(code, /'kind', ''\) not in \('model_number', 'date_code'\)/u);
  const fingerprint = await readFile(
    new URL('../supabase/functions/_shared/recallMatching/fingerprint.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(fingerprint, /safety|eligib/iu);
});

// ---------------------------------------------------------------------------
// TS/SQL parity on the essential gate decisions (same 27 cases on both sides)
// ---------------------------------------------------------------------------
test('the pgTAP suite embeds exactly the generated parity cases', async () => {
  const { parityCases } = await import('../scripts/generate-phase-17-7a-f4-parity-cases.mjs');
  const start = suite.indexOf('$cases$') + '$cases$'.length;
  const end = suite.indexOf('$cases$', start);
  assert.ok(start > 7 && end > start);
  assert.deepEqual(JSON.parse(suite.slice(start, end)), await parityCases());
});

test('the TypeScript product-check path classifies every parity case like SQL', async () => {
  const { parityCases } = await import('../scripts/generate-phase-17-7a-f4-parity-cases.mjs');
  const { assessRecallForProduct } =
    await import('../supabase/functions/_shared/productCheck/orchestrator.ts');
  const { projectOwnedProductForProductionV2 } =
    await import('../supabase/functions/_shared/recallMatching/productionPolicyV2.ts');
  const cases = await parityCases();
  assert.ok(cases.length >= 25);
  const labels = new Set(cases.map((item) => item.label));
  for (const required of [
    'non_official_source',
    'coverage_incomplete',
    'negative_evidence_not_eligible',
    'ambiguous_rule_set_only',
    'unsupported_criterion_kind',
    'stale_review_not_served',
    'model_matched',
    'model_and_date_code_matched',
    'missing_required_date_code',
    'jurisdiction_mismatch',
    'global_notice_unknown_country',
    'multi_scope_mixes_two_scopes',
  ]) {
    assert.ok(labels.has(required), required);
  }
  for (const item of cases) {
    const owned = projectOwnedProductForProductionV2({
      owned_product_id: 'parity-product',
      owned_product_updated_at: '2026-10-03T00:00:00Z',
      user_id: 'parity-user',
      product_name: 'Parity product',
      brand: null,
      category: null,
      gtin: null,
      model_number: item.model,
      serial_number: null,
      lot_number: null,
      identification_method: 'manual',
      safety_attributes: item.dateCode ? { date_code: item.dateCode } : {},
    });
    const recall = {
      recall_notice_id: 'parity-notice',
      recall_notice_updated_at: '2026-10-03T00:00:00Z',
      source_authority: item.authority,
      source_external_id: 'parity',
      source_official_url: item.url,
      source_is_authoritative: item.authoritative,
      title: 'Parity recall',
      description: null,
      hazard: null,
      remedy: null,
      recall_date: '2026-01-01',
      raw_payload: {},
      scopes: [],
      jurisdictions: item.jurisdictions,
    };
    const scopes = item.scopes.map((scope) => ({
      scope_id: scope.scopeId,
      brand: null,
      product_name: null,
      gtin: null,
      model_number: null,
      lot_from: null,
      lot_to: null,
      serial_from: null,
      serial_to: null,
      manufactured_from: null,
      manufactured_to: null,
      additional_criteria: null,
      reviewed_criteria: scope.envelope,
    }));
    const assessment = await assessRecallForProduct(owned, recall, scopes, item.country);
    assert.equal(assessment.classification, item.expected, item.label);
  }
});

// ---------------------------------------------------------------------------
// Production bypass surface: none
// ---------------------------------------------------------------------------
async function filesUnder(relative, extensions) {
  const { readdir } = await import('node:fs/promises');
  const root = new URL(`../${relative}/`, import.meta.url);
  const out = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !extensions.some((ext) => entry.name.endsWith(ext))) continue;
    const parent = entry.parentPath ?? entry.path;
    out.push(new URL(`${parent.endsWith('/') ? parent : `${parent}/`}${entry.name}`, 'file://'));
  }
  return out;
}

test('no runtime code can override, skip, or force the automatic-alert proof', async () => {
  const runtime = [
    ...(await filesUnder('supabase/migrations', ['.sql'])),
    ...(await filesUnder('supabase/functions', ['.ts'])),
    ...(await filesUnder('src', ['.ts', '.tsx'])),
    ...(await filesUnder('app', ['.ts', '.tsx'])),
  ];
  assert.ok(runtime.length > 50);
  const definitions = [];
  for (const file of runtime) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(
      text,
      /(bypass|skip|force|disable)_?(safety|proof|gate|f4)|x-(bypass|test)-|RECALL_[A-Z_]*TEST_MODE/iu,
      file.pathname,
    );
    if (/function\s+private\.automatic_alert_eligibility\s*\(/u.test(text)) {
      definitions.push(file.pathname.split('/').at(-1));
    }
  }
  assert.deepEqual(definitions, ['20261002110000_phase_17_7a_f4_automatic_alert_safety.sql']);
});

test('test seams exist only in local pgTAP suites, never in the remote production suite', async () => {
  const seam = /create or replace function private\.automatic_alert_eligibility/u;
  const local = [];
  for (const file of await filesUnder('supabase/tests', ['.sql'])) {
    const text = await readFile(file, 'utf8');
    const name = file.pathname.split('/supabase/tests/')[1];
    if (name.startsWith('remote/')) {
      assert.doesNotMatch(text, seam, name);
      assert.doesNotMatch(
        text,
        /disable trigger|insert into public\.alerts|recall_alert_eligibility_v2 \(/u,
        name,
      );
      continue;
    }
    if (seam.test(text)) {
      local.push(name);
      assert.match(text, /^begin;/mu, name);
      assert.match(text, /^rollback;\s*$/mu, name);
      assert.doesNotMatch(text, /^commit;/mu, name);
    }
  }
  assert.deepEqual(local.sort(), [
    'phase-10-recall-loop.sql',
    'phase-11-push-notifications.sql',
    'phase-16-33-security-and-v1-correctness.sql',
    'phase-16-4-full-path.sql',
    'phase-17-7a-1-owned-product-recall-checks.sql',
  ]);
});

test('the migration never deletes an alert and never runs the neutralization', async () => {
  const migration = await readFile(
    new URL(
      '../supabase/migrations/20261002110000_phase_17_7a_f4_automatic_alert_safety.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const code = migration.replace(/^\s*--.*$/gmu, '');
  assert.doesNotMatch(
    code,
    /delete\s+from\s+public\.alerts|delete\s+from\s+private\.recall_alert/iu,
  );
  assert.doesNotMatch(
    code,
    /(select|perform)\s+(\*\s+from\s+)?private\.neutralize_unsafe_automatic_alerts/iu,
  );
});
