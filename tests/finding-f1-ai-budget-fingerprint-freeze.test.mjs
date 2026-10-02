// Finding F-1 (tracked separately from Phase 17.7a, not fixed here).
// Characterizes CURRENT behavior: when the AI budget is exhausted, the v1
// orchestrator finalizes the deterministic needs_review with the canonical
// fingerprint. The next run then sees `unchanged`, never escalates the pair and
// reports the recall as resolved, although Phase 16.33 retained it for retry.
// See docs/findings/f-1-ai-budget-fingerprint-freeze.md.
import assert from 'node:assert/strict';
import test from 'node:test';

import { processRecallMatches } from '../supabase/functions/_shared/recallMatching/orchestrator.ts';

const MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';
const R1 = '10000000-0000-4000-8000-0000000000f1';

const recallRow = {
  recall_notice_id: R1,
  recall_notice_updated_at: '2026-10-02T00:00:00.000001+00:00',
  source_authority: 'U.S. Consumer Product Safety Commission (CPSC)',
  source_external_id: 'F1',
  source_official_url: 'https://www.cpsc.gov/Recalls/2026/f1',
  source_is_authoritative: true,
  title: 'Widget recall',
  description: null,
  hazard: null,
  remedy: null,
  recall_date: '2026-09-01',
  raw_payload: { id: 'F1' },
  scopes: [{ model_number: 'WX-100' }],
};

// Exact model without compatible name evidence: deterministic_v1 -> needs_review.
const productRow = {
  owned_product_id: 'p-f1',
  owned_product_updated_at: '2026-10-01T00:00:00.000001+00:00',
  product_name: 'Kitchen gadget',
  brand: null,
  category: null,
  gtin: null,
  model_number: 'WX-100',
  serial_number: null,
  lot_number: null,
  purchase_date: null,
  identification_method: 'manual',
  exact_rank: 2,
};

// Mirrors the claim RPC: `unchanged` when the stored match has the same fingerprint.
function fingerprintStore() {
  const stored = new Map();
  return {
    stored,
    async listAuthoritativeRecalls({ afterRecallId }) {
      return afterRecallId === null ? [recallRow] : [];
    },
    async listRecallCandidateProducts({ afterProductId }) {
      return afterProductId === null ? [productRow] : [];
    },
    async claimPair({ ownedProductId, recallNoticeId, evidenceFingerprint }) {
      const key = `${ownedProductId}|${recallNoticeId}`;
      return stored.get(key)?.fingerprint === evidenceFingerprint
        ? { status: 'unchanged' }
        : { status: 'claimed', leaseToken: 'lease' };
    },
    async finalizePair(input) {
      stored.set(`${input.ownedProductId}|${input.recallNoticeId}`, {
        fingerprint: input.evidenceFingerprint,
        status: input.status,
        matchMethod: input.matchMethod,
      });
      return { status: 'finalized', alertOutcome: 'none' };
    },
  };
}

const limits = (maxNebiusCalls) => ({
  maxRecalls: 1,
  maxCandidatePairs: 10,
  maxNebiusCalls,
  recallNoticeIds: [R1],
});

test('F-1: a needs_review finalized without AI budget is never escalated on the retry', async () => {
  const store = fingerprintStore();

  const first = await processRecallMatches(limits(0), {
    store,
    modelId: MODEL_ID,
    createNemotronEvaluator() {
      throw new Error('no AI budget in the first run');
    },
  });
  assert.equal(first.needsReview, 1);
  assert.deepEqual(first.unresolvedRecalls, [{ recallNoticeId: R1, reason: 'limit' }]);
  assert.deepEqual(
    [...store.stored.values()].map((row) => [row.status, row.matchMethod]),
    [['needs_review', 'deterministic_v1']],
  );

  let evaluatorCreated = 0;
  const retry = await processRecallMatches(limits(5), {
    store,
    modelId: MODEL_ID,
    createNemotronEvaluator() {
      evaluatorCreated += 1;
      throw new Error('would escalate');
    },
  });
  // Current (defective) behavior: the retry is a no-op that resolves the recall.
  assert.equal(retry.unchangedSkipped, 1);
  assert.equal(retry.nemotronEscalated, 0);
  assert.equal(evaluatorCreated, 0);
  assert.deepEqual(retry.resolvedRecallIds, [R1]);
  assert.deepEqual(retry.unresolvedRecalls, []);
});
