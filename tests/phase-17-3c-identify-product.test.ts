// Phase 17.3c: identify-product entry point as deployed. Without PRODUCT_LOOKUP_ENABLED and
// OFF_USER_AGENT_CONTACT it never reaches Open Food Facts. No network, no database.
// Run: npx -y deno@2 test --allow-env tests/phase-17-3c-identify-product.test.ts
type Handler = (request: Request) => Response | Promise<Response>;
const registered: Handler[] = [];
Object.defineProperty(Deno, 'serve', {
  configurable: true,
  value: (serve: Handler) => {
    registered.push(serve);
    return { finished: Promise.resolve(), shutdown: async () => {} };
  },
});

const fetchCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input: string | URL | Request) => {
  fetchCalls.push(String(input));
  return Promise.reject(new Error('network is not allowed in this test'));
};

Deno.env.delete('PRODUCT_LOOKUP_ENABLED');
Deno.env.delete('OFF_USER_AGENT_CONTACT');
await import('../supabase/functions/identify-product/index.ts');
const [handler] = registered;
if (!handler) throw new Error('handler was not registered');

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
}

Deno.test('identify-product: registered, POST only, bearer required, no OFF call', async () => {
  assertEquals((await handler(new Request('http://local/identify-product'))).status, 405);
  const anonymous = await handler(
    new Request('http://local/identify-product', {
      method: 'POST',
      body: JSON.stringify({ gtin: '3017620422003' }),
    }),
  );
  assertEquals(anonymous.status, 401);
  assertEquals(fetchCalls.filter((url) => url.includes('openfoodfacts')).length, 0);
});

Deno.test({
  name: 'identify-product: restore fetch',
  fn: () => {
    globalThis.fetch = realFetch;
  },
});
