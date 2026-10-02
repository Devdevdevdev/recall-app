import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PHASE_16_DETERMINISTIC_V2_POLICY,
  evaluateProductionPairV2,
  productionFingerprintV2,
  projectOwnedProductForProductionV2,
  projectRecallForProductionV2,
} from '../supabase/functions/_shared/recallMatching/productionPolicyV2.ts';

const productRow = {
  product_name: 'Example product',
  brand: 'Example',
  category: null,
  gtin: null,
  model_number: 'MODEL-1',
  serial_number: null,
  lot_number: null,
  purchase_date: null,
  identification_method: 'manual',
  safety_attributes: {},
};
const recallRow = {
  recall_notice_id: 'database-id',
  source_authority: 'CPSC',
  source_external_id: 'official-1',
  source_official_url: 'https://www.cpsc.gov/Recalls/example',
  source_is_authoritative: true,
  title: 'Example recall',
  description: null,
  hazard: null,
  remedy: null,
  recall_date: '2026-09-20',
  raw_payload: {},
  scopes: [{ model_number: 'MODEL-1', product_name: 'Example product' }],
};
const criterion = (kind, value) => ({
  id: kind,
  kind,
  operator: 'equals',
  required: true,
  value,
  provenance: {
    authority: 'CPSC',
    officialUrl: recallRow.source_official_url,
    sourceField: `reviewed.${kind}`,
    normalizationRule: 'human_reviewed_source_field',
  },
});

test('prepared production policy is deterministic only and does not infer CPSC or Health Canada prose', () => {
  assert.equal(PHASE_16_DETERMINISTIC_V2_POLICY, 'phase_16_deterministic_v2');
  const owned = projectOwnedProductForProductionV2(productRow);
  for (const authority of ['CPSC', 'Health Canada']) {
    const recall = projectRecallForProductionV2({ ...recallRow, source_authority: authority }, [
      null,
    ]);
    assert.equal(evaluateProductionPairV2(owned, recall).decision, 'needs_review');
  }
});

test('reviewed all-of criteria confirm only complete matching evidence', () => {
  const recall = projectRecallForProductionV2(recallRow, [
    {
      semantics: 'all_of',
      criteria: [criterion('model_number', 'MODEL-1'), criterion('lot_number', 'LOT-9')],
    },
  ]);
  for (const [lot, expected] of [
    ['LOT-9', 'confirmed'],
    ['LOT-8', 'rejected'],
    [null, 'needs_review'],
  ]) {
    const owned = projectOwnedProductForProductionV2({ ...productRow, lot_number: lot });
    assert.equal(evaluateProductionPairV2(owned, recall).decision, expected);
  }
});

test('criterion provenance must name the current official source', () => {
  const wrong = criterion('model_number', 'MODEL-1');
  wrong.provenance.officialUrl = 'https://example.invalid/recall';
  assert.throws(
    () =>
      projectRecallForProductionV2(recallRow, [
        {
          semantics: 'all_of',
          criteria: [wrong],
        },
      ]),
    /provenance/u,
  );
});

test('v2 fingerprint is version separated, canonical, and only includes matching safety attributes', async () => {
  const owned = projectOwnedProductForProductionV2({
    ...productRow,
    safety_attributes: { color: 'red', size: 'large' },
  });
  const recall = projectRecallForProductionV2(recallRow, [
    {
      semantics: 'all_of',
      criteria: [criterion('model_number', 'MODEL-1'), criterion('color', 'red')],
    },
  ]);
  const base = await productionFingerprintV2({ ownedProduct: owned, officialRecall: recall });
  assert.match(base, /^[a-f0-9]{64}$/u);
  assert.equal(
    base,
    await productionFingerprintV2({
      ownedProduct: { ...owned, attributes: [...owned.attributes].reverse() },
      officialRecall: {
        ...recall,
        recallNoticeId: 'different-database-id',
        source: {
          ...recall.source,
          retrievedAt: '2030-01-01',
        },
      },
    }),
  );
  assert.equal(
    base,
    await productionFingerprintV2({
      ownedProduct: owned,
      officialRecall: {
        ...recall,
        description: 'A revised non-matching description',
        scopes: recall.scopes.map((scope) => ({
          ...scope,
          additionalCriteria: { ingestion_timestamp: '2030-01-01T00:00:00Z' },
          criteria: { ...scope.criteria, criteria: [...scope.criteria.criteria].reverse() },
        })),
      },
    }),
  );
  assert.equal(
    base,
    await productionFingerprintV2({
      ownedProduct: projectOwnedProductForProductionV2({
        ...productRow,
        safety_attributes: { color: 'red', size: 'small' },
      }),
      officialRecall: recall,
    }),
  );
  assert.notEqual(
    base,
    await productionFingerprintV2({
      ownedProduct: projectOwnedProductForProductionV2({
        ...productRow,
        safety_attributes: { color: 'blue', size: 'large' },
      }),
      officialRecall: recall,
    }),
  );
});

test('three known Phase 15 unsafe cases remain non-confirmed in frozen v2 replay', async () => {
  const report = JSON.parse(
    await readFile(
      new URL(
        '../benchmarks/recall-matching/phase-16/results/deterministic-v2-all.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  for (const id of ['p15-str-45-2', 'p15-str-45-3', 'p15-str-46-3']) {
    assert.notEqual(report.knownUnsafeCases.find((item) => item.caseId === id)?.predicted, 'match');
  }
});

test('production entry point, orchestrator, and prepared policy have no v2.1 import or v2 AI path', async () => {
  const [policy, entry, orchestrator] = await Promise.all([
    readFile(
      new URL(
        '../supabase/functions/_shared/recallMatching/productionPolicyV2.ts',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(
      new URL('../supabase/functions/process-recall-matches/index.ts', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../supabase/functions/_shared/recallMatching/orchestrator.ts', import.meta.url),
      'utf8',
    ),
  ]);
  assert.doesNotMatch(
    policy,
    /hybridGuardedMatcherV2_1|guardedNemotron|nebius|createNemotronEvaluator/iu,
  );
  assert.doesNotMatch(entry, /productionPolicyV2|hybridGuardedMatcherV2_1/iu);
  assert.doesNotMatch(orchestrator, /productionPolicyV2|hybridGuardedMatcherV2_1/iu);
});
