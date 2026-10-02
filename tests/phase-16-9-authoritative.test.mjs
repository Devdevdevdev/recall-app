import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const dataset = JSON.parse(
  readFileSync(new URL('../docs/phase-16-9-prototype-dataset.json', import.meta.url)),
);
const byNumber = new Map(dataset.pages.map((page) => [page.recallNumber, page]));

test('canonical identity reconciles 30 stored rows without trusting API IDs', () => {
  assert.equal(dataset.counts.storedNotices, 30);
  assert.equal(dataset.counts.stableCanonicalIdentities, 27);
  assert.equal(dataset.counts.duplicateGroups, 3);
  assert.equal(
    dataset.noticeRows.filter((row) => row.storedExternalId !== row.currentApiId).length,
    12,
  );
  assert.equal(new Set(dataset.pages.map((page) => page.identity)).size, 27);
  assert.equal(
    dataset.pages.every((page) => page.httpStatus === 200),
    true,
  );
});

test('AGA table preserves model and production date as one conjunction per row', () => {
  const page = byNumber.get('26756');
  assert.equal(page.tables.length, 1);
  assert.equal(page.tables[0].length, 7);
  assert.equal(page.candidates.length, 12);
  const groups = new Map();
  for (const candidate of page.candidates) {
    const members = groups.get(candidate.group) ?? [];
    members.push(candidate.kind);
    groups.set(candidate.group, members);
    assert.equal(candidate.status, 'unreviewed');
    assert.ok(candidate.evidence.address.rowIdentity);
    assert.equal(candidate.evidence.address.sourceRevisionHash, page.normalizedEvidenceHash);
  }
  assert.equal(groups.size, 6);
  for (const kinds of groups.values())
    assert.deepEqual(kinds, ['model_exact', 'production_date_range']);
});

test('Char-Broil table retains nine model rows with a mandatory date-code set', () => {
  const page = byNumber.get('26773');
  assert.equal(page.tables[0].length, 10);
  assert.equal(page.candidates.length, 18);
  assert.equal(page.candidates.filter((candidate) => candidate.kind === 'model_exact').length, 9);
  assert.equal(page.candidates.filter((candidate) => candidate.kind === 'date_code_set').length, 9);
  assert.deepEqual([...new Set(page.candidates.map((candidate) => candidate.group))].length, 9);
  assert.equal(
    page.candidates.every((candidate) => candidate.status === 'unreviewed'),
    true,
  );
});

test('unsafe serial and alternative conditions remain unresolved', () => {
  for (const number of ['26776', '26763', '26783', '26784', '26780']) {
    const page = byNumber.get(number);
    assert.equal(page.candidates.length, 0, number);
    assert.ok(page.unresolved.length, number);
  }
  assert.equal(
    dataset.pages
      .flatMap((page) => page.candidates)
      .some((candidate) => candidate.status !== 'unreviewed'),
    false,
  );
});

test('explicit single-model prose is proposed only as unreviewed evidence', () => {
  assert.deepEqual(
    byNumber
      .get('26754')
      .candidates.map((candidate) => [candidate.kind, candidate.value, candidate.status]),
    [['model_exact', 'XR-8801', 'unreviewed']],
  );
});
