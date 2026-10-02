// Phase 17.7a-1: check-owned-product (user JWT) and process-owned-product-checks
// (admin worker) request handling. No network, no database, no AI.
// Run: npx -y deno@2 test --allow-env tests/phase-17-7a-1-check-owned-product.test.ts
import {
  createCheckOwnedProductHandler,
  createProductCheckWorkerHandler,
  type CompletionInput,
  type MonitoringSnapshot,
  type ProductCheckStores,
  type UserClaimResult,
} from '../supabase/functions/_shared/productCheck/handler.ts';
import type { ProductCheckClaim } from '../supabase/functions/_shared/productCheck/orchestrator.ts';

type Handler = (request: Request) => Response | Promise<Response>;
const registered: Handler[] = [];
Object.defineProperty(Deno, 'serve', {
  configurable: true,
  value: (serve: Handler) => {
    registered.push(serve);
    return { finished: Promise.resolve(), shutdown: async () => {} };
  },
});
await import('../supabase/functions/check-owned-product/index.ts');
await import('../supabase/functions/process-owned-product-checks/index.ts');
const [deployedUser, deployedWorker] = registered;
if (!deployedUser || !deployedWorker) throw new Error('handlers were not registered');

const PRODUCT = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-00000000000a';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

function expect(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

async function call(
  handler: Handler,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  const response = await handler(
    new Request('http://local/fn', {
      method: init.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body:
        init.method === 'GET'
          ? undefined
          : (init.body ?? JSON.stringify({ ownedProductId: PRODUCT })),
    }),
  );
  return { status: response.status, body: await response.json() };
}

const snapshot = (state: MonitoringSnapshot['state'], extra: Partial<MonitoringSnapshot> = {}) => ({
  state,
  checkedAt: null,
  possibleMatches: 0,
  confirmedAlerts: 0,
  retrying: false,
  ...extra,
});

const claim: ProductCheckClaim = {
  ownedProductId: PRODUCT,
  leaseToken: 'job-lease',
  matchingRevision: 1,
  productUpdatedAt: '2026-10-02T10:00:00.000001+00:00',
  purchaseCountryCode: 'US',
  cursor: null,
  maxCandidates: 25,
};

function stores(options: {
  claimResult?: UserClaimResult | 'throw';
  completeThrows?: boolean;
  productThrows?: boolean;
}) {
  const seen = { claims: [] as unknown[], completions: [] as CompletionInput[], dueLimit: 0 };
  const value: ProductCheckStores = {
    jobs: {
      async claimForUser(input) {
        seen.claims.push(input);
        if (options.claimResult === 'throw') throw new Error('db down');
        return options.claimResult ?? { status: 'claimed', claim, snapshot: snapshot('checking') };
      },
      async claimDue(limit) {
        seen.dueLimit = limit;
        return [claim, { ...claim, ownedProductId: '00000000-0000-4000-8000-000000000002' }];
      },
      async complete(input) {
        seen.completions.push(input);
        if (options.completeThrows) throw new Error('db down');
        return {
          status: input.outcome === 'complete' ? 'completed' : 'retrying',
          snapshot:
            input.outcome === 'complete'
              ? snapshot('monitored_no_known_recall', { checkedAt: '2026-10-02T10:00:01Z' })
              : snapshot('check_failed_retrying', { retrying: true }),
        };
      },
    },
    pairs: {
      async getProductEvidence(id) {
        if (options.productThrows) throw new Error('db down');
        return {
          owned_product_id: id,
          owned_product_updated_at: claim.productUpdatedAt,
          user_id: USER,
          product_name: 'Widget',
          brand: null,
          category: null,
          gtin: null,
          model_number: null,
          serial_number: null,
          lot_number: null,
          purchase_date: null,
          identification_method: 'manual',
          safety_attributes: {},
        };
      },
      async listCandidateRecalls() {
        return [];
      },
      async getReviewedScopes() {
        return [];
      },
      async claimPair() {
        throw new Error('no pair expected');
      },
      async finalizeV2() {
        throw new Error('no pair expected');
      },
      async createAlert() {
        throw new Error('no pair expected');
      },
    },
  };
  return { value, seen };
}

function userHandler(
  options: Parameters<typeof stores>[0] & {
    user?: string | null;
    now?: () => number;
  } = {},
) {
  const built = stores(options);
  const tokens: string[] = [];
  const handler = createCheckOwnedProductHandler({
    async authenticate(token) {
      tokens.push(token);
      return options.user === undefined ? USER : options.user;
    },
    createStores: () => built.value,
    now: options.now,
  });
  return { handler, seen: built.seen, tokens };
}

const auth = { authorization: `Bearer ${TOKEN}` };

Deno.test(
  'deployed user endpoint: no or malformed JWT is 401 before any database access',
  async () => {
    Deno.env.delete('SUPABASE_URL');
    expect(
      await call(deployedUser),
      { status: 401, body: { error: 'Unauthorized.' } },
      'no header',
    );
    expect(
      await call(deployedUser, { headers: { authorization: 'Bearer not-a-jwt' } }),
      { status: 401, body: { error: 'Unauthorized.' } },
      'malformed',
    );
    expect(
      await call(deployedUser, { headers: { authorization: `Basic ${TOKEN}` } }),
      { status: 401, body: { error: 'Unauthorized.' } },
      'wrong scheme',
    );
    // A JWT-shaped token that cannot be verified (no auth server configured) is refused.
    expect(
      await call(deployedUser, { headers: auth }),
      { status: 401, body: { error: 'Unauthorized.' } },
      'unverifiable',
    );
    expect((await call(deployedUser, { method: 'GET', headers: auth })).status, 405, 'GET');
  },
);

Deno.test('deployed worker endpoint requires the administrative key', async () => {
  Deno.env.delete('RECALL_MATCHING_KEY');
  expect(
    await call(deployedWorker, { body: '{}' }),
    { status: 401, body: { error: 'Unauthorized.' } },
    'no key',
  );
  Deno.env.set('RECALL_MATCHING_KEY', 'k'.repeat(40));
  expect(
    (await call(deployedWorker, { headers: { 'x-recall-matching-key': 'wrong' }, body: '{}' }))
      .status,
    401,
    'wrong key',
  );
  Deno.env.delete('RECALL_MATCHING_KEY');
});

Deno.test(
  'a token the auth server rejects is 401; the token is passed through unchanged',
  async () => {
    const { handler, seen, tokens } = userHandler({ user: null });
    expect(
      await call(handler, { headers: auth }),
      { status: 401, body: { error: 'Unauthorized.' } },
      'rejected',
    );
    expect(tokens, [TOKEN], 'token');
    expect(seen.claims.length, 0, 'no claim');
  },
);

Deno.test('invalid bodies are 400 and never reach the database', async () => {
  const { handler, seen } = userHandler();
  for (const body of [
    'not json',
    '[]',
    '{}',
    JSON.stringify({ ownedProductId: 'x' }),
    JSON.stringify({ ownedProductId: PRODUCT, userId: USER }),
    JSON.stringify({ ownedProductIds: [PRODUCT] }),
  ]) {
    expect((await call(handler, { headers: auth, body })).status, 400, body);
  }
  expect(seen.claims.length, 0, 'no claim');
});

Deno.test('the verified user id, never a body field, scopes the claim', async () => {
  const { handler, seen } = userHandler();
  await call(handler, { headers: auth });
  expect(seen.claims, [{ ownedProductId: PRODUCT, userId: USER }], 'claim input');
});

Deno.test('a foreign or missing product is 404 without detail', async () => {
  const { handler } = userHandler({ claimResult: { status: 'not_found' } });
  expect(
    await call(handler, { headers: auth }),
    { status: 404, body: { error: 'Product not found.' } },
    '404',
  );
});

Deno.test('own product: a check runs and returns only the bounded state', async () => {
  const { handler, seen } = userHandler();
  const response = await call(handler, { headers: auth });
  expect(
    response,
    {
      status: 200,
      body: {
        state: 'monitored_no_known_recall',
        checkedAt: '2026-10-02T10:00:01Z',
        possibleMatches: 0,
        confirmedAlerts: 0,
        retrying: false,
      },
    },
    'response',
  );
  expect(
    seen.completions.map((item) => [item.outcome, item.error, item.path]),
    [['complete', null, 'user']],
    'completion',
  );
});

Deno.test('non-claimed outcomes return the current state without work', async () => {
  for (const status of ['disabled', 'complete', 'busy', 'not_due'] as const) {
    const { handler, seen } = userHandler({
      claimResult: { status, snapshot: snapshot('pending_check') },
    });
    const response = await call(handler, { headers: auth });
    expect(response.status, 200, status);
    expect(response.body.state, 'pending_check', status);
    expect(seen.completions.length, 0, `${status} completions`);
  }
  const limited = userHandler({
    claimResult: { status: 'rate_limited', snapshot: snapshot('pending_check') },
  });
  expect((await call(limited.handler, { headers: auth })).status, 429, 'rate limited');
});

Deno.test('a failing check is recorded as a retry; the product is unaffected', async () => {
  const { handler, seen } = userHandler({ productThrows: true });
  const response = await call(handler, { headers: auth });
  expect(response.body.state, 'check_failed_retrying', 'state');
  expect(response.body.retrying, true, 'retrying');
  expect(
    seen.completions.map((item) => [item.outcome, item.error]),
    [['retry', 'failure']],
    'completion',
  );
});

Deno.test('the time budget is enforced: an exhausted budget is a timeout retry', async () => {
  const { handler, seen } = userHandler({ now: () => 0 });
  await call(handler, { headers: auth });
  expect(
    seen.completions.map((item) => [item.outcome, item.error]),
    [['retry', 'timeout']],
    'timeout',
  );
});

Deno.test('a completion failure still answers (retrying) and a claim failure is 503', async () => {
  const completing = userHandler({ completeThrows: true });
  const response = await call(completing.handler, { headers: auth });
  expect([response.status, response.body.retrying], [200, true], 'completion failure');
  const claiming = userHandler({ claimResult: 'throw' });
  expect((await call(claiming.handler, { headers: auth })).status, 503, 'claim failure');
});

Deno.test('worker: bounded batch, aggregate counters only, zero AI calls', async () => {
  const built = stores({});
  const handler = createProductCheckWorkerHandler({
    authorized: () => true,
    createStores: () => built.value,
  });
  expect((await call(handler, { body: JSON.stringify({ maxProducts: 26 }) })).status, 400, 'bound');
  expect((await call(handler, { body: JSON.stringify({ all: true }) })).status, 400, 'field');
  const response = await call(handler, { body: JSON.stringify({ maxProducts: 2 }) });
  expect(built.seen.dueLimit, 2, 'limit');
  expect(
    response.body,
    {
      claimed: 2,
      completed: 2,
      continued: 0,
      retrying: 0,
      exhausted: 0,
      rearmed: 0,
      staleLeases: 0,
      confirmed: 0,
      rejected: 0,
      possibleMatches: 0,
      alertsCreated: 0,
      aiCalls: 0,
    },
    'summary',
  );
  expect(
    built.seen.completions.map((item) => item.path),
    ['worker', 'worker'],
    'path',
  );
});
