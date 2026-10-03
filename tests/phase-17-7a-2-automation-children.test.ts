// Phase 17.7a-2: the automation -> product-check worker boundary and the
// lease-bound flag read. Run: npx -y deno@2 test --allow-env tests/phase-17-7a-2-automation-children.test.ts
import {
  ChildFunctionError,
  PRODUCT_CHECK_TIMEOUT_MS,
  RecallAutomationChildren,
} from '../supabase/functions/run-recall-automation/children.ts';
import { SupabaseAutomationStore } from '../supabase/functions/run-recall-automation/store.ts';

const ROOT = 'http://functions.local/functions/v1';
const SECRETS = { ingestion: 'ingest-secret', matching: 'matching-secret', push: 'push-secret' };

const assert = (condition: unknown, label: string) => {
  if (!condition) throw new Error(label);
};
const equal = (actual: unknown, expected: unknown, label: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

type Seen = { url: string; headers: Headers; body: unknown };

function stubFetch(respond: (seen: Seen, signal: AbortSignal | null) => Promise<Response>) {
  const seen: Seen[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const entry = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    seen.push(entry);
    return respond(entry, init?.signal ?? null);
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = original) };
}

const summary = (overrides: Record<string, unknown> = {}) => ({
  claimed: 2,
  completed: 1,
  continued: 0,
  retrying: 1,
  exhausted: 0,
  rearmed: 0,
  staleLeases: 0,
  confirmed: 0,
  rejected: 0,
  possibleMatches: 1,
  alertsCreated: 0,
  aiCalls: 0,
  ...overrides,
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof ChildFunctionError, 'a ChildFunctionError');
    return (error as ChildFunctionError).code;
  }
  throw new Error('expected a failure');
}

Deno.test(
  'worker call: matching key header, worker URL, bounded body, parsed summary',
  async () => {
    const stub = stubFetch(() => Promise.resolve(json(200, summary())));
    try {
      const result = await new RecallAutomationChildren(ROOT, SECRETS).checkProducts({
        maxProducts: 3,
      });
      equal(result, summary(), 'summary');
      equal(stub.seen.length, 1, 'one call');
      const [call] = stub.seen as [Seen];
      equal(call.url, `${ROOT}/process-owned-product-checks`, 'url');
      equal(call.headers.get('x-recall-matching-key'), 'matching-secret', 'matching key');
      equal(call.headers.get('x-recall-automation-key'), null, 'no automation key');
      equal(call.headers.get('authorization'), null, 'no bearer credential');
      equal(call.body, { maxProducts: 3 }, 'body');
    } finally {
      stub.restore();
    }
  },
);

Deno.test('worker call: 401, 403, 500 and 502 fail closed with a stable code', async () => {
  for (const status of [401, 403, 500, 502]) {
    const stub = stubFetch(() => Promise.resolve(json(status, { error: 'x' })));
    try {
      const code = await failure(
        new RecallAutomationChildren(ROOT, SECRETS).checkProducts({ maxProducts: 3 }),
      );
      equal(code, `child_http_${status}`, `status ${status}`);
      equal(stub.seen.length, 1, 'no retry inside the run');
    } finally {
      stub.restore();
    }
  }
});

Deno.test('worker call: network failure is child_unavailable', async () => {
  const stub = stubFetch(() => Promise.reject(new TypeError('connection refused')));
  try {
    equal(
      await failure(new RecallAutomationChildren(ROOT, SECRETS).checkProducts({ maxProducts: 3 })),
      'child_unavailable',
      'unavailable',
    );
  } finally {
    stub.restore();
  }
});

Deno.test('worker call: a slow worker is abandoned at the stage timeout', async () => {
  equal(PRODUCT_CHECK_TIMEOUT_MS, 75_000, 'documented timeout');
  const stub = stubFetch(
    (_seen, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () =>
          reject(new DOMException('The signal has been aborted', 'AbortError')),
        );
      }),
  );
  try {
    equal(
      await failure(
        new RecallAutomationChildren(ROOT, SECRETS, 20).checkProducts({ maxProducts: 3 }),
      ),
      'child_timeout',
      'timeout',
    );
  } finally {
    stub.restore();
  }
});

Deno.test('worker call: every invalid response is refused', async () => {
  // A body that is not JSON keeps the pre-existing invoke() code (child_unavailable).
  const stub = stubFetch(() => Promise.resolve(new Response('<html>', { status: 200 })));
  try {
    equal(
      await failure(new RecallAutomationChildren(ROOT, SECRETS).checkProducts({ maxProducts: 3 })),
      'child_unavailable',
      'not JSON',
    );
  } finally {
    stub.restore();
  }
  const invalid: [string, () => Response][] = [
    ['array', () => json(200, [])],
    ['missing field', () => json(200, (({ aiCalls: _a, ...rest }) => rest)(summary()))],
    ['extra field', () => json(200, { ...summary(), ownedProductId: 'x' })],
    ['negative', () => json(200, summary({ retrying: -1, completed: 2 }))],
    ['fraction', () => json(200, summary({ possibleMatches: 0.5 }))],
    ['string count', () => json(200, summary({ claimed: '2' }))],
    ['AI call', () => json(200, summary({ aiCalls: 1 }))],
    ['over budget', () => json(200, summary({ claimed: 4, completed: 3 }))],
    ['outcomes do not add up', () => json(200, summary({ completed: 0 }))],
    ['alerts without confirmation', () => json(200, summary({ alertsCreated: 1 }))],
  ];
  for (const [label, respond] of invalid) {
    const stub = stubFetch(() => Promise.resolve(respond()));
    try {
      equal(
        await failure(
          new RecallAutomationChildren(ROOT, SECRETS).checkProducts({ maxProducts: 3 }),
        ),
        'invalid_child_response',
        label,
      );
    } finally {
      stub.restore();
    }
  }
});

Deno.test('worker call: an oversized response is refused', async () => {
  const stub = stubFetch(() =>
    Promise.resolve(new Response('x'.repeat(1024 * 1024 + 1), { status: 200 })),
  );
  try {
    equal(
      await failure(new RecallAutomationChildren(ROOT, SECRETS).checkProducts({ maxProducts: 3 })),
      'child_response_too_large',
      'too large',
    );
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// Flag read
// ---------------------------------------------------------------------------
function database(answer: { data: unknown; error: unknown }) {
  const calls: [string, unknown][] = [];
  return {
    calls,
    client: {
      rpc(name: string, args: unknown) {
        calls.push([name, args]);
        return Promise.resolve(answer);
      },
    },
  };
}

Deno.test('flag read: lease-bound RPC, explicit boolean only', async () => {
  const lease = { runId: 'run', leaseToken: 'lease' };
  for (const value of [true, false]) {
    const db = database({ data: [{ product_check_enabled: value }], error: null });
    // deno-lint-ignore no-explicit-any
    const store = new SupabaseAutomationStore(db.client as any);
    equal(await store.getProductCheckPlan(lease), { enabled: value }, `flag ${value}`);
    equal(
      db.calls,
      [['get_recall_automation_product_check_plan', { p_run_id: 'run', p_lease_token: 'lease' }]],
      'rpc',
    );
  }
  for (const answer of [
    { data: null, error: { message: 'lease unavailable' } },
    { data: [], error: null },
    { data: [{ product_check_enabled: 'true' }], error: null },
    { data: [{ product_check_enabled: null }], error: null },
    { data: [{ product_check_enabled: true }], error: { message: 'x' } },
  ]) {
    const db = database(answer);
    // deno-lint-ignore no-explicit-any
    const store = new SupabaseAutomationStore(db.client as any);
    let threw = false;
    try {
      await store.getProductCheckPlan(lease);
    } catch {
      threw = true;
    }
    assert(threw, `fails closed on ${JSON.stringify(answer)}`);
  }
});
