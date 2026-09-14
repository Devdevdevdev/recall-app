import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const edgeUrl = new URL('../supabase/functions/process-recall-matches/index.ts', import.meta.url);
const storeUrl = new URL('../supabase/functions/process-recall-matches/store.ts', import.meta.url);
const configUrl = new URL('../supabase/config.toml', import.meta.url);
const appConfigUrl = new URL('../app.json', import.meta.url);

test('production matching endpoint is POST-only and fails closed on its dedicated secret', async () => {
  const [edge, config] = await Promise.all([
    readFile(edgeUrl, 'utf8'),
    readFile(configUrl, 'utf8'),
  ]);

  assert.match(edge, /request\.method !== 'POST'/u);
  assert.match(edge, /Deno\.env\.get\('RECALL_MATCHING_KEY'\)/u);
  assert.match(edge, /x-recall-matching-key/u);
  assert.match(edge, /constantTimeEqual/u);
  assert.match(config, /\[functions\.process-recall-matches\]\s+verify_jwt = false/u);
});

test('Nebius is pinned server-side with transport retries disabled', async () => {
  const edge = await readFile(edgeUrl, 'utf8');

  assert.match(edge, /nvidia\/nemotron-3-super-120b-a12b/u);
  assert.match(edge, /https:\/\/api\.tokenfactory\.us-central1\.nebius\.com\/v1\//u);
  assert.match(edge, /maxRetries: 0/u);
  assert.match(edge, /createNemotronEvaluator: createProductionEvaluator/u);
});

test('the Edge adapter uses only service-role RPCs and never serializes secret configuration', async () => {
  const [edge, store] = await Promise.all([readFile(edgeUrl, 'utf8'), readFile(storeUrl, 'utf8')]);
  const returnedBody = edge.slice(edge.indexOf('return json(200'));

  for (const rpc of [
    'get_recall_matching_batch',
    'get_recall_candidates',
    'claim_recall_match_evaluation',
    'finalize_recall_match_evaluation',
  ]) {
    assert.match(store, new RegExp(`rpc\\('${rpc}'`, 'u'));
  }
  assert.equal(returnedBody.includes('NEBIUS_API_KEY'), false);
  assert.equal(returnedBody.includes('RECALL_MATCHING_KEY'), false);
});

test('Nebius and privileged Supabase secrets are absent from mobile configuration and source', async () => {
  const appConfig = await readFile(appConfigUrl, 'utf8');
  assert.equal(appConfig.includes('NEBIUS_'), false);
  assert.equal(appConfig.includes('SUPABASE_SERVICE_ROLE_KEY'), false);
  assert.equal(appConfig.includes('RECALL_MATCHING_KEY'), false);
});
