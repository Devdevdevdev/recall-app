// Phase 16.32: the worker's invocation credential is checked before any
// database access, and a revoked (unset or rotated) credential fails closed.
// Run: npx -y deno@2 test --allow-env tests/phase-16-32-worker-invocation-auth.test.ts
type Handler = (request: Request) => Response | Promise<Response>;

let handler: Handler | undefined;
Object.defineProperty(Deno, 'serve', {
  configurable: true,
  value: (serve: Handler) => {
    handler = serve;
    return { finished: Promise.resolve(), shutdown: async () => {} };
  },
});
await import('../supabase/functions/process-cpsc-page-evidence/index.ts');
if (!handler) throw new Error('worker handler was not registered');

const KEY = 'a'.repeat(64);
const call = async (method: string, key?: string) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (key !== undefined) headers.set('x-cpsc-page-worker-key', key);
  const response = await handler!(
    new Request('http://local/process-cpsc-page-evidence', {
      method,
      headers,
      body: method === 'POST' ? '{"maxPages":1}' : undefined,
    }),
  );
  return { status: response.status, body: await response.json() };
};
const expect = (actual: unknown, expected: unknown, label: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

Deno.test('an unset worker key rejects every caller before database access', async () => {
  Deno.env.delete('CPSC_PAGE_WORKER_KEY');
  Deno.env.delete('CPSC_PAGE_DB_URL');
  expect(await call('POST', KEY), { status: 401, body: { error: 'Unauthorized.' } }, 'unset');
  expect(await call('POST', ''), { status: 401, body: { error: 'Unauthorized.' } }, 'empty');
});

Deno.test('missing, wrong and rotated keys are rejected; only POST is accepted', async () => {
  Deno.env.set('CPSC_PAGE_WORKER_KEY', KEY);
  Deno.env.delete('CPSC_PAGE_DB_URL');
  expect(await call('GET', KEY), { status: 405, body: { error: 'Only POST is allowed.' } }, 'GET');
  expect(await call('POST'), { status: 401, body: { error: 'Unauthorized.' } }, 'missing');
  expect(
    await call('POST', 'b'.repeat(64)),
    { status: 401, body: { error: 'Unauthorized.' } },
    'wrong',
  );
  // With the right key and no database capability, the handler stops before
  // connecting: authorization precedes any database access.
  expect(
    await call('POST', KEY),
    { status: 500, body: { error: 'Page database capability is unavailable.' } },
    'authorized without DB capability',
  );
  Deno.env.set('CPSC_PAGE_DB_URL', 'postgresql://service_role:x@127.0.0.1:1/postgres');
  expect(
    await call('POST', KEY),
    { status: 500, body: { error: 'Page database capability is invalid.' } },
    'a non-worker database login is refused',
  );
  // Rotation: the previous key stops working immediately.
  Deno.env.set('CPSC_PAGE_WORKER_KEY', 'c'.repeat(64));
  expect(await call('POST', KEY), { status: 401, body: { error: 'Unauthorized.' } }, 'rotated');
  Deno.env.delete('CPSC_PAGE_WORKER_KEY');
  Deno.env.delete('CPSC_PAGE_DB_URL');
});
