import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { retrieveRecallCandidates } from '../supabase/functions/_shared/matching/candidateRetrieval.ts';
import {
  evaluateDeterministicRuleSetsV2,
  expandRuleSetsV2,
} from '../supabase/functions/_shared/matching/deterministicRuleSetsV2.ts';
import {
  productionFingerprintV2,
  projectOwnedProductForProductionV2,
} from '../supabase/functions/_shared/recallMatching/productionPolicyV2.ts';

// Phase 16.12: the gate now runs on the ledger path (worker evidence -> human
// review -> rule set), so it needs the full local migration chain through 16.12.
let pgTap = await readFile(
  new URL('../supabase/test-fixtures/phase-16-3-production-gate.sql.template', import.meta.url),
  'utf8',
);

const officialUrl = 'https://www.cpsc.gov/Recalls/2026/phase-16-3';
const criterion = (id, kind, value) => ({
  id,
  kind,
  operator: 'equals',
  required: true,
  value,
  provenance: {
    authority: 'CPSC',
    officialUrl,
    sourceField: `cpsc-page:gate-table/row-1/${kind}`,
    normalizationRule: 'identifier_v2',
  },
});
const recall = {
  recallNoticeId: 'phase-16-3',
  source: {
    authority: 'U.S. Consumer Product Safety Commission (CPSC)',
    externalId: 'cpsc:99163',
    officialUrl,
  },
  title: 'Controlled v2 recall',
  description: null,
  hazard: null,
  remedy: null,
  recallDate: '2026-09-01',
  rawEvidence: null,
  scopes: [
    {
      productName: 'Controlled product',
      modelNumber: 'MODEL-1',
      ruleSetCoverageComplete: true,
      ruleSets: [
        {
          semantics: 'all_of',
          ruleSetId: 'gate-table/row-1',
          criteria: [
            criterion('model', 'model_number', 'MODEL-1'),
            criterion('date', 'date_code', '2510'),
          ],
        },
      ],
    },
  ],
};
const { official } = expandRuleSetsV2(recall);
const productRow = (dateCode) => ({
  product_name: 'Controlled product',
  brand: null,
  category: null,
  gtin: null,
  model_number: 'MODEL-1',
  serial_number: null,
  lot_number: null,
  purchase_date: null,
  identification_method: 'manual',
  safety_attributes: dateCode ? { date_code: dateCode } : {},
});

for (const [number, dateCode, expected] of [
  [5, '2510', 'confirmed'],
  [6, null, 'needs_review'],
  [7, '2509', 'rejected'],
  ['REVERSED', null, 'needs_review'],
]) {
  const owned = projectOwnedProductForProductionV2(productRow(dateCode));
  assert.equal(retrieveRecallCandidates(owned, [official], { maxCandidates: 1 }).length, 1);
  const evaluation = evaluateDeterministicRuleSetsV2(owned, recall);
  assert.equal(evaluation.decision, expected);
  const fingerprint = await productionFingerprintV2({
    ownedProduct: owned,
    officialRecall: official,
  });
  pgTap = pgTap.replaceAll(`__FINGERPRINT_${number}__`, fingerprint);
  pgTap = pgTap.replaceAll(`__DECISION_${number}__`, evaluation.decision);
}
assert.doesNotMatch(pgTap, /__(?:FINGERPRINT|DECISION)_[A-Z0-9]+__/u);

const script = pgTap;

const child = spawn(
  'docker',
  [
    'exec',
    '-i',
    'supabase_db_RECALL',
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-At',
  ],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);
let output = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
child.stdin.end(script);
const exitCode = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', resolve);
});
if (exitCode !== 0) process.exit(exitCode ?? 1);
if (/^not ok\b|^# Looks like/imu.test(output)) process.exit(1);
