// Phase 17.7a F-4: the v1 store adapter reads the stored status and the safety
// reason returned by the F-4 finalizer, and tolerates an older database.
// Run: npx -y deno@2 test --allow-env tests/phase-17-7a-f4-store.test.ts
import { SupabaseRecallMatchingStore } from '../supabase/functions/process-recall-matches/store.ts';
import type { FinalizePairInput } from '../supabase/functions/_shared/recallMatching/types.ts';

function expect(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

const input: FinalizePairInput = {
  ownedProductId: 'p',
  recallNoticeId: 'r',
  expectedProductUpdatedAt: 'a',
  expectedRecallUpdatedAt: 'b',
  leaseToken: 'l',
  evidenceFingerprint: 'f'.repeat(64),
  status: 'confirmed',
  confidence: 1,
  matchMethod: 'deterministic_v1',
  matchedIdentifiers: {},
  reasoningSummary: 'x',
  aiProvider: null,
  aiModel: null,
  schemaVersion: '1.0.0',
};

function adapterReturning(row: Record<string, unknown>) {
  const database = {
    rpc: () => Promise.resolve({ data: [row], error: null }),
  };
  return new SupabaseRecallMatchingStore(database as never);
}

const base = {
  status: 'finalized',
  recall_match_id: 'm1',
  alert_id: null,
  alert_outcome: 'none',
  confirmation_reversed: false,
};

Deno.test('the F-4 finalizer result is surfaced to the orchestrator', async () => {
  const result = await adapterReturning({
    ...base,
    stored_status: 'needs_review',
    safety_status: 'jurisdiction_mismatch',
  }).finalizePair(input);
  expect(
    [result.storedStatus, result.safetyStatus],
    ['needs_review', 'jurisdiction_mismatch'],
    'F-4',
  );
});

Deno.test('a pre-F-4 finalizer result keeps the previous meaning', async () => {
  const result = await adapterReturning(base).finalizePair(input);
  expect([result.storedStatus, result.safetyStatus], [undefined, null], 'legacy');
});

Deno.test('an unknown stored status is ignored rather than trusted', async () => {
  const result = await adapterReturning({ ...base, stored_status: 'candidate' }).finalizePair(
    input,
  );
  expect(result.storedStatus, undefined, 'unknown');
});
