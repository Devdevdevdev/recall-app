import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildCpscIdentityIndex,
  canonicalCpscUrl,
  identityFingerprint,
  resolveCpscObservation,
} from '../supabase/functions/_shared/cpsc/identity.ts';

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url)));
const historical = read('./fixtures/phase-16-10-notices.json');
const audit = read('../docs/phase-16-9-identity-audit.json');
const dataset = read('../docs/phase-16-9-prototype-dataset.json');
const pages = new Map(dataset.pages.map((page) => [page.recallNumber, page]));
const historicalRows = historical.map((row) => ({
  noticeId: row.id,
  apiId: row.external_id,
  recallNumber: row.recall_number,
  officialUrl: row.official_url,
  title: row.title,
  publicationDate: row.recall_date,
}));
const index = buildCpscIdentityIndex(historicalRows);

test('30 historical rows link to 27 canonical identities without rewriting IDs or references', () => {
  assert.equal(historical.length, 30);
  assert.equal(index.identities.size, 27);
  assert.equal(
    [...index.identities.values()].reduce((sum, value) => sum + value.noticeIds.length, 0),
    30,
  );
  assert.equal(
    new Set([...index.identities.values()].flatMap((value) => value.noticeIds)).size,
    30,
  );
  assert.equal(
    historical.reduce((sum, row) => sum + row.scopes.length, 0),
    43,
  );
  assert.equal(
    historical.reduce((sum, row) => sum + row.match_count + row.alert_count, 0),
    0,
  );
});

test('canonical fingerprint is stable across API ID, URL host spelling, and fetch time', async () => {
  const left = await identityFingerprint('26-748');
  const right = await identityFingerprint('26748');
  assert.equal(left, right);
  assert.match(left, /^[0-9a-f]{64}$/u);
  assert.equal(
    canonicalCpscUrl('https://cpsc.gov/Recalls/2026/Example/?utm_source=x'),
    'https://www.cpsc.gov/Recalls/2026/Example',
  );
});

test('all 12 actual drift observations resolve or quarantine against official evidence', () => {
  assert.equal(audit.driftCases.length, 12);
  const outcomes = audit.driftCases.map((drift) => {
    const page = pages.get(drift.officialRecallNumber);
    assert.ok(page, drift.officialRecallNumber);
    const decision = resolveCpscObservation(index, {
      apiId: drift.currentApiId,
      recallNumber: drift.officialRecallNumber,
      officialUrl: drift.currentOfficialUrl,
      title: page.title,
      publicationDate: page.publicationDate,
    });
    if (decision.status === 'resolved') {
      assert.equal(decision.identity.recallNumber, drift.officialRecallNumber);
      assert.ok(decision.identity.noticeIds.includes(drift.internalNoticeId));
    } else {
      assert.equal(decision.reason, 'API ID belongs to another historical recall');
      assert.ok(decision.conflictingKeys.length);
    }
    return decision.status;
  });
  assert.equal(outcomes.filter((value) => value === 'resolved').length, 6);
  assert.equal(outcomes.filter((value) => value === 'quarantined').length, 6);
});

test('three duplicate groups link both historical rows to one canonical recall', () => {
  assert.equal(audit.duplicateGroups.length, 3);
  for (const group of audit.duplicateGroups) {
    const identity = index.identities.get(`cpsc:${group.officialRecallNumber}`);
    assert.ok(identity);
    assert.equal(identity.noticeIds.length, 2);
    assert.deepEqual(
      new Set(identity.noticeIds),
      new Set(group.aliases.map((alias) => alias.noticeId)),
    );
    const page = pages.get(group.officialRecallNumber);
    const current = group.aliases.find(
      (alias) => alias.externalId === group.canonicalCandidateExternalId,
    );
    const decision = resolveCpscObservation(index, {
      apiId: group.canonicalCandidateExternalId,
      recallNumber: group.officialRecallNumber,
      officialUrl: current.storedOfficialUrl,
      title: page.title,
      publicationDate: page.publicationDate,
    });
    assert.equal(decision.status, 'resolved');
    assert.equal(decision.duplicate, true);
  }
});

test('conflicting title, date, URL, number, and API collision fail closed', () => {
  const page = pages.get('26748');
  const base = {
    apiId: '10962',
    recallNumber: '26748',
    officialUrl: page.canonicalUrl,
    title: page.title,
    publicationDate: page.publicationDate,
  };
  for (const patch of [
    { title: 'A different recall' },
    { publicationDate: '2026-09-11' },
    { officialUrl: 'https://www.cpsc.gov/Recalls/2026/Other' },
    { recallNumber: '26749' },
    { apiId: '10968' },
  ]) {
    assert.equal(resolveCpscObservation(index, { ...base, ...patch }).status, 'quarantined');
  }
  for (const url of [
    'http://www.cpsc.gov/Recalls/2026/X',
    'https://www.cpsc.gov.evil.test/Recalls/2026/X',
    'https://user@www.cpsc.gov/Recalls/2026/X',
    'https://www.cpsc.gov:444/Recalls/2026/X',
    'https://127.0.0.1/Recalls/2026/X',
  ])
    assert.throws(() => canonicalCpscUrl(url));
});
