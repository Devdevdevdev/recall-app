// Phase 16.33: scheduled invocations carry a single-use database ticket, never
// a static key. A malformed ticket is refused before any database access, and
// a ticket never lets the request body choose the run's bounds.
// Run: npx -y deno@2 test --allow-env tests/phase-16-33-ticket-invocation.test.ts
type Handler = (request: Request) => Response | Promise<Response>;

const handlers: Handler[] = [];
Object.defineProperty(Deno, 'serve', {
  configurable: true,
  value: (serve: Handler) => {
    handlers.push(serve);
    return { finished: Promise.resolve(), shutdown: async () => {} };
  },
});
await import('../supabase/functions/process-cpsc-page-evidence/index.ts');
await import('../supabase/functions/run-recall-automation/index.ts');
const [worker, automation] = handlers;
if (!worker || !automation) throw new Error('handlers were not registered');

const call = async (handler: Handler, headers: Record<string, string>, body = '{}') => {
  const response = await handler(
    new Request('http://local/fn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }),
  );
  return { status: response.status, body: await response.json() };
};
const expect = (actual: unknown, expected: unknown, label: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};
const unauthorized = { status: 401, body: { error: 'Unauthorized.' } };
const TICKET = 'e'.repeat(64);

Deno.test('page worker: a malformed ticket is refused before database access', async () => {
  Deno.env.delete('CPSC_PAGE_WORKER_KEY');
  Deno.env.delete('CPSC_PAGE_DB_URL');
  for (const ticket of ['', 'x', 'E'.repeat(64), 'e'.repeat(63), `${TICKET}0`]) {
    expect(await call(worker, { 'x-cpsc-page-ticket': ticket }), unauthorized, `ticket ${ticket}`);
  }
});

Deno.test('page worker: a well-formed ticket still needs the database to accept it', async () => {
  Deno.env.delete('CPSC_PAGE_DB_URL');
  expect(
    await call(worker, { 'x-cpsc-page-ticket': TICKET }, '{"maxPages":10,"timeBudgetMs":1}'),
    { status: 500, body: { error: 'Page database capability is unavailable.' } },
    'no DB capability',
  );
  Deno.env.set('CPSC_PAGE_DB_URL', 'postgresql://service_role:x@127.0.0.1:1/postgres');
  expect(
    await call(worker, { 'x-cpsc-page-ticket': TICKET }),
    { status: 500, body: { error: 'Page database capability is invalid.' } },
    'a non-worker database login is refused',
  );
  // Worker login but an unreachable database: consumption fails, so the run is refused.
  Deno.env.set('CPSC_PAGE_DB_URL', 'postgresql://cpsc_page_worker:x@127.0.0.1:1/postgres');
  expect(await call(worker, { 'x-cpsc-page-ticket': TICKET }), unauthorized, 'unconsumed ticket');
  Deno.env.delete('CPSC_PAGE_DB_URL');
});

Deno.test('page worker: a static key is not accepted in place of a ticket', async () => {
  Deno.env.delete('CPSC_PAGE_WORKER_KEY');
  expect(
    await call(worker, { 'x-cpsc-page-worker-key': TICKET }),
    unauthorized,
    'no key configured',
  );
});

Deno.test('automation: malformed and unconsumable tickets are refused', async () => {
  Deno.env.delete('RECALL_AUTOMATION_KEY');
  Deno.env.delete('SUPABASE_URL');
  Deno.env.delete('SUPABASE_SECRET_KEYS');
  Deno.env.delete('SUPABASE_SERVICE_ROLE_KEY');
  expect(
    await call(automation, { 'x-recall-automation-ticket': 'nope' }),
    unauthorized,
    'malformed',
  );
  // Without server credentials the ticket cannot be consumed: refused, not run.
  expect(
    await call(automation, { 'x-recall-automation-ticket': TICKET }, '{"trigger":"manual"}'),
    unauthorized,
    'unconsumable',
  );
  // The static key path is unchanged and still requires the configured key.
  expect(await call(automation, { 'x-recall-automation-key': TICKET }), unauthorized, 'static key');
});
