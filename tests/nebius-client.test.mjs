import assert from 'node:assert/strict';
import test from 'node:test';

import { NebiusClient } from '../supabase/functions/_shared/nebius/client.ts';
import { loadNebiusConfig } from '../supabase/functions/_shared/nebius/config.ts';
import { NebiusError, nebiusErrorForStatus } from '../supabase/functions/_shared/nebius/errors.ts';

const secret = 'test-secret-that-must-never-appear';

function config(overrides = {}) {
  return loadNebiusConfig(
    {
      NEBIUS_API_KEY: secret,
      NEBIUS_MODEL_ID: 'test/model',
      NEBIUS_BASE_URL: 'https://api.example.test/v1/',
    },
    { requestTimeoutMs: 25, maxRetries: 0, ...overrides },
  );
}

test('configuration fails closed and validates the credential destination', () => {
  assert.throws(
    () =>
      loadNebiusConfig({
        NEBIUS_MODEL_ID: 'test/model',
        NEBIUS_BASE_URL: 'https://api.example.test/v1/',
      }),
    /NEBIUS_API_KEY is missing/u,
  );
  assert.throws(
    () =>
      loadNebiusConfig(
        {
          NEBIUS_API_KEY: secret,
          NEBIUS_MODEL_ID: 'test/model',
          NEBIUS_BASE_URL: 'http://api.example.test/v1/',
        },
        { expectedHost: 'api.example.test' },
      ),
    /credential-free HTTPS/u,
  );
  assert.throws(
    () =>
      loadNebiusConfig(
        {
          NEBIUS_API_KEY: secret,
          NEBIUS_MODEL_ID: 'test/model',
          NEBIUS_BASE_URL: 'https://other.example.test/v1/',
        },
        { expectedHost: 'api.example.test' },
      ),
    /required api\.example\.test host/u,
  );
});

test('authentication errors discard provider bodies and redact credentials', async () => {
  const client = new NebiusClient(config(), {
    fetch: async () =>
      new Response(JSON.stringify({ detail: `bad authorization Bearer ${secret}` }), {
        status: 401,
      }),
  });
  await assert.rejects(client.listModels(), (error) => {
    assert.ok(error instanceof NebiusError);
    assert.equal(error.code, 'authentication');
    assert.equal(error.retryable, false);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('only transient statuses are classified as retryable', () => {
  assert.equal(nebiusErrorForStatus(429).retryable, true);
  assert.equal(nebiusErrorForStatus(503).retryable, true);
  assert.equal(nebiusErrorForStatus(400).retryable, false);
  assert.equal(nebiusErrorForStatus(401).retryable, false);
});

test('the client retries a transient response a bounded number of times', async () => {
  let calls = 0;
  const client = new NebiusClient(config({ maxRetries: 1 }), {
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response('{}', { status: 429 })
        : new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 });
    },
    sleep: async () => undefined,
  });
  const result = await client.listModels();
  assert.equal(calls, 2);
  assert.equal(result.retries, 1);
});

test('an exhausted transient failure reports its retry count', async () => {
  let calls = 0;
  const client = new NebiusClient(config({ maxRetries: 2 }), {
    fetch: async () => {
      calls += 1;
      return new Response('{}', { status: 503 });
    },
    sleep: async () => undefined,
  });
  await assert.rejects(client.listModels(), (error) => {
    assert.ok(error instanceof NebiusError);
    assert.equal(error.code, 'provider_server');
    assert.equal(error.retries, 2);
    assert.equal(calls, 3);
    return true;
  });
});

test('timeout failures are surfaced with a safe typed error', async () => {
  const client = new NebiusClient(config(), {
    fetch: async () => {
      throw new DOMException('request aborted', 'AbortError');
    },
  });
  await assert.rejects(client.listModels(), (error) => {
    assert.ok(error instanceof NebiusError);
    assert.equal(error.code, 'timeout');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});
