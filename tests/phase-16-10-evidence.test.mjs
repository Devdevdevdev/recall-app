import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  proposeCpscTableCriteria,
  semanticCpscRevision,
} from '../supabase/functions/_shared/cpsc/pageEvidence.ts';

const dataset = JSON.parse(
  readFileSync(new URL('../docs/phase-16-9-prototype-dataset.json', import.meta.url)),
);
const page = (number) => dataset.pages.find((entry) => entry.recallNumber === number);
const shape = (entry) => ({
  recallNumber: entry.recallNumber,
  canonicalUrl: entry.canonicalUrl,
  title: entry.title,
  publicationDate: entry.publicationDate,
  description: entry.description,
  recallDetails: entry.recallDetails,
  tables: entry.tables,
});

test('cosmetic whitespace and URL host spelling preserve semantic revision', async () => {
  const original = shape(page('26773'));
  const changed = {
    ...original,
    canonicalUrl:
      original.canonicalUrl.replace('www.cpsc.gov', 'cpsc.gov') + '?utm_campaign=tracking',
    description: `  ${original.description.replaceAll(' ', '  ')}  `,
    tables: original.tables.map((table) => table.map((row) => row.map((cell) => ` ${cell} `))),
  };
  assert.equal(
    (await semanticCpscRevision(original)).semanticHash,
    (await semanticCpscRevision(changed)).semanticHash,
  );
});

test('table value, mandatory wording, title, and source identity change semantic revision', async () => {
  const original = shape(page('26773'));
  const initial = (await semanticCpscRevision(original)).semanticHash;
  const variants = [
    { ...original, tables: original.tables.map((table) => table.map((row) => [...row])) },
    {
      ...original,
      description: original.description.replace('Only Bistro Pro', 'Some Bistro Pro'),
    },
    { ...original, title: `${original.title} amended` },
    { ...original, recallNumber: '26774' },
  ];
  variants[0].tables[0][1][1] = 'DIFFERENT';
  for (const variant of variants) {
    assert.notEqual((await semanticCpscRevision(variant)).semanticHash, initial);
  }
});

test('Char-Broil produces nine distinct model AND date-code conjunctions', async () => {
  const result = await proposeCpscTableCriteria(shape(page('26773')));
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.candidates.length, 18);
  const groups = new Map();
  for (const candidate of result.candidates) {
    assert.equal(candidate.status, 'unreviewed');
    assert.equal(candidate.sourceAddress.source, 'cpsc');
    assert.equal(candidate.sourceAddress.recallNumber, '26773');
    assert.ok(candidate.sourceAddress.tableIdentity);
    assert.ok(candidate.sourceAddress.rowIdentity);
    assert.ok(candidate.sourceAddress.fieldIdentity);
    const group = groups.get(candidate.conjunctionKey) ?? [];
    group.push(candidate);
    groups.set(candidate.conjunctionKey, group);
  }
  assert.equal(groups.size, 9);
  for (const pair of groups.values()) {
    assert.deepEqual(
      pair.map((entry) => entry.kind),
      ['model_exact', 'date_code_set'],
    );
    assert.deepEqual(pair[1].value, ['2510', '2511', '2512']);
  }
  assert.equal(new Set([...groups.values()].map((pair) => pair[0].value)).size, 9);
});

test('Char-Broil date-code list is read completely or not at all', async () => {
  const original = shape(page('26773'));
  const listed = '2510 (Oct-2025), 2511 (Nov-2025) and 2512 (Dec-2025)';
  assert.ok(original.description.includes(listed));
  const amended = await proposeCpscTableCriteria({
    ...original,
    description: original.description.replace(listed, `${listed.replace(' and', ',')} and 2601`),
  });
  assert.deepEqual(amended.unresolved, []);
  for (const candidate of amended.candidates.filter((entry) => entry.kind === 'date_code_set')) {
    assert.deepEqual(candidate.value, ['2510', '2511', '2512', '2601']);
  }
  for (const replacement of [
    '2510 (Oct-2025), 2511 (Nov-2025) or 2512 (Dec-2025)',
    '2510 (Oct-2025), 2511 (Nov-2025) and some 2512 units',
    '2510, 2510 and 2512',
  ]) {
    const result = await proposeCpscTableCriteria({
      ...original,
      description: original.description.replace(listed, replacement),
    });
    assert.deepEqual(result.candidates, [], replacement);
    // Phase 16.11: the generic parser names the unparsed restriction, not the recall.
    assert.ok(
      result.unresolved.some((reason) => reason.startsWith('unsupported restriction: Only ')),
      replacement,
    );
  }
});

test('generic model/date-code rows stay pairwise and never form a cross product', async () => {
  const result = await proposeCpscTableCriteria({
    recallNumber: '26999',
    canonicalUrl: 'https://www.cpsc.gov/Recalls/2026/Pairwise-Fixture',
    title: 'Pairwise fixture',
    publicationDate: '2026-09-01',
    description: 'Fixture.',
    recallDetails: {},
    tables: [
      [
        ['Model', 'Date Code'],
        ['A1', 'X9'],
        ['B2', 'Y8'],
        ['C3', 'masked 12**'],
      ],
    ],
  });
  const groups = new Map();
  for (const candidate of result.candidates) {
    assert.equal(candidate.status, 'unreviewed');
    groups.set(candidate.conjunctionKey, [
      ...(groups.get(candidate.conjunctionKey) ?? []),
      candidate.value,
    ]);
  }
  assert.deepEqual([...groups.values()].sort(), [
    ['A1', 'X9'],
    ['B2', 'Y8'],
  ]);
  assert.deepEqual(result.unresolved, ['ambiguous model/date-code row']);
});

test('AGA preserves six model/date row associations and defers date-range review', async () => {
  const aga = shape(page('26756'));
  assert.equal(aga.tables.length, 1);
  assert.equal(aga.tables[0].length, 7);
  const revision = await semanticCpscRevision(aga);
  assert.equal(revision.tableIdentities[0].rows.length, 6);
  assert.equal(new Set(revision.tableIdentities[0].rows.map((row) => row.identity)).size, 6);
  const result = await proposeCpscTableCriteria(aga);
  assert.deepEqual(result.candidates, []);
  assert.ok(result.unresolved.includes('production_date_range deferred: 6 paired rows'));
});

test('Friedrich affected serial subset stays unresolved', async () => {
  const result = await proposeCpscTableCriteria(shape(page('26776')));
  assert.equal(result.candidates.length, 0);
  assert.ok(result.unresolved.some((reason) => /Only some serial numbers/u.test(reason)));
});
