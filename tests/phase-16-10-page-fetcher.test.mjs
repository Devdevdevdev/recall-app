import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CPSC_PAGE_MAX_BYTES,
  fetchCpscOfficialPage,
} from '../supabase/functions/_shared/cpsc/pageFetcher.ts';

const official = 'https://www.cpsc.gov/Recalls/2026/Example';
const html = '<html><body>Recall Number: 26-748</body></html>';
const ok = () =>
  new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', etag: '"v1"' },
  });

test('bounded official page fetch records transport provenance and raw hash', async () => {
  const requests = [];
  const result = await fetchCpscOfficialPage(official, async (url, options) => {
    requests.push({ url, options });
    return ok();
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.redirect, 'manual');
  assert.equal(result.canonicalUrl, official);
  assert.equal(result.html, html);
  assert.equal(result.etag, '"v1"');
  assert.match(result.rawPageHash, /^[0-9a-f]{64}$/u);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
});

test('safe redirect is followed only after exact-host validation', async () => {
  let calls = 0;
  const result = await fetchCpscOfficialPage(official, async () => {
    calls += 1;
    return calls === 1
      ? new Response(null, {
          status: 302,
          headers: { location: 'https://cpsc.gov/Recalls/2026/Example' },
        })
      : ok();
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.redirectChain, ['https://cpsc.gov/Recalls/2026/Example']);
});

test('host, userinfo, port, local address, and redirect tricks are refused', async () => {
  const bad = [
    'https://cpsc.gov.evil.test/Recalls/2026/X',
    'https://user@cpsc.gov/Recalls/2026/X',
    'https://cpsc.gov:443/Recalls/2026/X',
    'https://127.0.0.1/Recalls/2026/X',
    'http://cpsc.gov/Recalls/2026/X',
  ];
  for (const url of bad) {
    await assert.rejects(fetchCpscOfficialPage(url, async () => ok()));
  }
  for (const location of [
    'https://169.254.169.254/latest/meta-data',
    'https://cpsc.gov.evil.test/Recalls/X',
    'http://cpsc.gov/Recalls/X',
  ]) {
    await assert.rejects(
      fetchCpscOfficialPage(
        official,
        async () => new Response(null, { status: 302, headers: { location } }),
      ),
    );
  }
});

test('content type, body cap, and redirect cap fail closed', async () => {
  await assert.rejects(
    fetchCpscOfficialPage(
      official,
      async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    ),
  );
  await assert.rejects(
    fetchCpscOfficialPage(
      official,
      async () =>
        new Response('x', {
          headers: {
            'content-type': 'text/html',
            'content-length': String(CPSC_PAGE_MAX_BYTES + 1),
          },
        }),
    ),
  );
  await assert.rejects(
    fetchCpscOfficialPage(
      official,
      async () =>
        new Response('x'.repeat(CPSC_PAGE_MAX_BYTES + 1), {
          headers: { 'content-type': 'text/html' },
        }),
    ),
  );
  await assert.rejects(
    fetchCpscOfficialPage(
      official,
      async () => new Response(null, { status: 302, headers: { location: official } }),
    ),
  );
});

test('caller-controlled URLs outside the CPSC recall authority are refused before any fetch', async () => {
  for (const url of [
    'https://www.cpsc.gov/Newsroom/News-Releases/2026/X',
    'https://www.cpsc.gov/Recalls/../Newsroom/X',
    'https://www.cpsc.gov@evil.test/Recalls/2026/X',
    'https://www.cpsc.gov\\@evil.test/Recalls/2026/X',
    'https://evil.test/https://www.cpsc.gov/Recalls/2026/X',
    'https://2130706433/Recalls/2026/X',
    'https://[::1]/Recalls/2026/X',
    'https://localhost/Recalls/2026/X',
    'file:///etc/passwd',
  ]) {
    let called = false;
    await assert.rejects(
      fetchCpscOfficialPage(url, async () => {
        called = true;
        return ok();
      }),
      undefined,
      url,
    );
    assert.equal(called, false, url);
  }
});

test('missing, protocol-relative, and off-host final redirects fail closed', async () => {
  for (const headers of [{}, { location: '//evil.test/Recalls/2026/X' }]) {
    await assert.rejects(
      fetchCpscOfficialPage(official, async () => new Response(null, { status: 301, headers })),
    );
  }
  await assert.rejects(
    fetchCpscOfficialPage(official, async () => {
      const response = ok();
      Object.defineProperty(response, 'url', { value: 'https://evil.test/Recalls/2026/X' });
      return response;
    }),
  );
});

test('non-200 status and invalid UTF-8 fail closed', async () => {
  await assert.rejects(
    fetchCpscOfficialPage(official, async () => new Response(html, { status: 500 })),
  );
  await assert.rejects(
    fetchCpscOfficialPage(
      official,
      async () =>
        new Response(new Uint8Array([0x3c, 0xff, 0xfe]), {
          headers: { 'content-type': 'text/html' },
        }),
    ),
  );
});
