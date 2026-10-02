import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { extractCpscPageStructure } from '../supabase/functions/_shared/cpsc/htmlExtractor.ts';
import {
  CPSC_PAGE_PARSER_VERSION,
  proposeCpscTableCriteria,
  semanticCpscRevision,
} from '../supabase/functions/_shared/cpsc/pageEvidence.ts';
import { ingestCpscOfficialPage } from '../supabase/functions/_shared/cpsc/pageIngestion.ts';
import {
  buildCpscSourceCoverage,
  cpscCoverageInterpretationFingerprint,
  summarizeCpscCoverageLedger,
} from '../supabase/functions/_shared/cpsc/sourceCoverage.ts';
import { projectOwnedProductForProductionV2 } from '../supabase/functions/_shared/recallMatching/productionPolicyV2.ts';
import {
  computeRuleSetFingerprintV2,
  evaluateRuleSetsPairV2,
  projectRecallRuleSetsForProductionV2,
  validateLiveRuleSetEnvelopeV2,
} from '../supabase/functions/_shared/recallMatching/ruleSetsV2.ts';

const root = new URL('../', import.meta.url);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const uuid = (seed) => {
  const hex = sha(String(seed));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const html = (name) => readFile(new URL(`tests/fixtures/cpsc-pages/${name}.html`, root), 'utf8');
const canonicalOf = (body) => /<link rel="canonical" href="([^"]+)"/u.exec(body)[1];

async function analyze(body) {
  const { page, census } = extractCpscPageStructure(body, canonicalOf(body));
  return { page, census, ...(await buildCpscSourceCoverage(page, census)) };
}

const tableOf = (ledger) => ledger.structures.find((structure) => structure.kind === 'table');
const proseOf = (ledger) => ledger.structures.find((structure) => structure.kind === 'prose');

/**
 * Emulates the database read path after human review of every proposal:
 * a blocked ledger serves nothing; otherwise only the ledger's reviewable
 * conjunctions serve, and coverage is complete only when the ledger proves it.
 * `legacy` reproduces Phase 16.12, which counted parser proposals only.
 */
async function servedEnvelope(page, { candidates, summary }, { legacy = false } = {}) {
  if (!legacy && summary.positiveStatus !== 'independent') return null;
  const revision = await semanticCpscRevision(page);
  const scopeId = uuid(`${page.recallNumber}:scope`);
  const groups = new Map();
  candidates.forEach((proposal, index) => {
    const members = groups.get(proposal.conjunctionKey) ?? [];
    members.push({ ...proposal, candidateId: uuid(`${page.recallNumber}:candidate:${index}`) });
    groups.set(proposal.conjunctionKey, members);
  });
  const ruleSets = [];
  for (const [conjunctionGroup, members] of groups) {
    members.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
    const set = {
      semantics: 'all_of',
      criteria: members.map((member) => ({
        id: `cpsc-ledger-${member.candidateId}`,
        kind: member.kind.startsWith('model') ? 'model_number' : 'date_code',
        operator: member.operator === 'exact' ? 'equals' : 'one_of',
        required: true,
        provenance: {
          authority: 'CPSC',
          officialUrl: page.canonicalUrl,
          sourceField: `cpsc-page:${member.sourceAddress.tableIdentity}/${member.sourceAddress.rowIdentity}/${member.sourceAddress.fieldIdentity}`,
          normalizationRule: 'identifier_v2',
        },
        ...(member.operator === 'exact' ? { value: member.value } : { values: member.value }),
      })),
      review: {
        origin: 'human_review_ledger',
        revisionId: uuid(`${page.recallNumber}:revision`),
        sourceRevisionHash: revision.semanticHash,
        conjunctionGroup,
        scopeId,
        scopeFingerprint: sha(`${scopeId}:fingerprint`),
        candidateIds: members.map((member) => member.candidateId),
        reviewEventIds: members.map((member) => uuid(`${member.candidateId}:event`)),
        reviewerIds: members.map(() => uuid('reviewer')),
        reviewedAt: '2026-09-26T10:00:00.000Z',
        schema: 'recall_rule_set_v1',
        identityFingerprint: sha(`cpsc\u0000${page.recallNumber}`),
        scopeSemanticFingerprint: sha(`${page.recallNumber}:semantic-scope`),
        sourceAddressHashes: members.map((member) => sha(JSON.stringify(member.sourceAddress))),
        ruleSetFingerprint: '',
      },
    };
    set.review.ruleSetFingerprint = await computeRuleSetFingerprintV2(set);
    ruleSets.push(set);
  }
  const relations = new Set(summary.reviewableRelations);
  const served = legacy
    ? ruleSets
    : ruleSets.filter((set) => relations.has(set.review.conjunctionGroup));
  if (!served.length) return null;
  const proposalGroups = [...groups.keys()];
  const sameUniverse =
    proposalGroups.length === relations.size && proposalGroups.every((key) => relations.has(key));
  return {
    scopeId,
    envelope: {
      semantics: 'any_of',
      schema: 'recall_rule_sets_v1',
      scopeId,
      ruleSets: served,
      coverage: {
        currentRevisionId: uuid(`${page.recallNumber}:revision`),
        proposedRuleSets: groups.size,
        unattributedRuleSets: 0,
        servedRuleSets: served.length,
        complete: legacy
          ? served.length === groups.size
          : served.length === groups.size && summary.negativeEvidenceEligible && sameUniverse,
        sourceCoverage: legacy
          ? // What 16.12 effectively believed: every proposal served means complete.
            {
              state: 'recorded',
              coverageStatus: 'complete',
              positiveStatus: 'independent',
              negativeEvidenceEligible: true,
            }
          : {
              state: 'recorded',
              coverageStatus: summary.coverageStatus,
              positiveStatus: summary.positiveStatus,
              negativeEvidenceEligible: summary.negativeEvidenceEligible,
            },
      },
    },
  };
}

function recallRow(page) {
  return {
    recall_notice_id: uuid(`${page.recallNumber}:notice`),
    recall_notice_updated_at: '2026-09-26T10:00:00Z',
    source_authority: 'U.S. Consumer Product Safety Commission (CPSC)',
    source_external_id: `cpsc:${page.recallNumber}`,
    source_official_url: page.canonicalUrl,
    source_is_authoritative: true,
    title: page.title,
    description: null,
    hazard: null,
    remedy: null,
    recall_date: '2026-09-20',
    raw_payload: {},
    scopes: [],
  };
}

const owned = (modelNumber, dateCode) =>
  projectOwnedProductForProductionV2({
    owned_product_id: 'owned',
    owned_product_updated_at: '2026-09-26T10:00:00Z',
    user_id: 'user',
    product_name: 'Product',
    brand: null,
    category: null,
    gtin: null,
    model_number: modelNumber,
    serial_number: null,
    lot_number: null,
    purchase_date: null,
    identification_method: 'manual',
    safety_attributes: dateCode ? { date_code: dateCode } : {},
  });

async function decider(page, served) {
  const recall = recallRow(page);
  const scope = {
    scope_id: served?.scopeId ?? uuid(`${page.recallNumber}:scope`),
    product_name: 'Product',
    model_number: null,
  };
  const validated = served
    ? await validateLiveRuleSetEnvelopeV2(recall, scope, served.envelope)
    : null;
  const projection = projectRecallRuleSetsForProductionV2({ ...recall, scopes: [scope] }, [
    validated,
  ]);
  return (model, code) => evaluateRuleSetsPairV2(owned(model, code), projection).decision;
}

const CHAR_BROIL_MODELS = [
  '25302145',
  '25302146',
  '25302147',
  '25302148',
  '25302149',
  '25302150',
  '25302151',
  '25302159',
  '25302163',
];

// ---------------------------------------------------------------------------
// Char-Broil completeness
// ---------------------------------------------------------------------------

test('Char-Broil: 9 authoritative rows, 9 rule sets, 9 / 9 dispositions, coverage complete', async () => {
  const body = await html('char-broil');
  const { page, census, ledger, summary, candidates } = await analyze(body);
  assert.equal(census.descriptionTables.length, 1);
  assert.equal(census.descriptionTables[0].rows.length, 10, 'header + 9 DOM rows');
  const table = tableOf(ledger);
  assert.equal(table.authoritativeRecordCount, 9);
  assert.equal(table.records.length, 9);
  assert.deepEqual(table.anomalies, []);
  assert.ok(table.records.every((record) => record.disposition === 'parsed_reviewable'));
  assert.equal(new Set(table.records.map((record) => record.relation)).size, 9);
  assert.equal(summary.structuralStatus, 'complete');
  assert.equal(summary.criterionStatus, 'complete');
  assert.equal(summary.coverageStatus, 'complete');
  assert.equal(summary.positiveStatus, 'independent');
  assert.equal(summary.negativeEvidenceEligible, true);
  assert.equal(summary.authoritativeRecords, summary.accountedRecords);
  assert.equal(
    Object.values(summary.dispositionCounts).reduce((sum, count) => sum + count, 0),
    summary.authoritativeRecords,
    'sum of dispositions = authoritative records',
  );
  assert.deepEqual(summary.dispositionCounts, {
    parsed_reviewable: 10,
    parsed_deferred: 0,
    unresolved: 0,
    unsupported: 0,
    ignored_non_safety: 4,
  });
  assert.equal(summary.reviewableRelations.length, 9);
  // The positive path is byte-identical to the 16.12 proposer.
  assert.deepEqual(candidates, (await proposeCpscTableCriteria(page)).candidates);
  assert.equal(candidates.length, 18);
  const decide = await decider(page, await servedEnvelope(page, { candidates, summary }));
  for (const model of CHAR_BROIL_MODELS) assert.equal(decide(model, '2511'), 'confirmed', model);
  assert.equal(decide('25302145', '2509'), 'rejected', 'complete proof allows a safe rejection');
  assert.equal(decide('25302199', '2510'), 'rejected', 'unlisted model under a complete universe');
});

test('Char-Broil: a row omitted from parser output is incomplete and never rejects its product', async () => {
  const body = await html('char-broil');
  const { page, census } = extractCpscPageStructure(body, canonicalOf(body));
  // Simulated parser defect: the extractor loses the 25302149 row; the DOM census still has it.
  const defective = {
    ...page,
    tables: [page.tables[0].filter((row) => !row.includes('25302149'))],
  };
  const result = await buildCpscSourceCoverage(defective, census);
  const table = tableOf(result.ledger);
  assert.equal(table.authoritativeRecordCount, 9, 'the census still counts 9 rows');
  assert.deepEqual(table.anomalies, ['row_count_mismatch']);
  assert.equal(result.summary.structuralStatus, 'unresolved');
  assert.equal(result.summary.coverageStatus, 'unresolved');
  assert.equal(result.summary.positiveStatus, 'blocked');
  assert.equal(result.summary.negativeEvidenceEligible, false);
  assert.deepEqual(result.candidates, [], 'an unaccountable table proposes nothing');

  const decide = await decider(defective, await servedEnvelope(defective, result));
  assert.equal(decide('25302149', '2510'), 'needs_review', 'the omitted product is never rejected');
  assert.equal(decide('25302145', '2510'), 'needs_review');

  // Counterfactual: 16.12 counted parser proposals only, so 8 served of 8 proposed
  // looked complete and the omitted product would have been rejected.
  const legacyProposals = await proposeCpscTableCriteria(defective);
  assert.equal(legacyProposals.candidates.length, 16);
  const legacy = await decider(
    defective,
    await servedEnvelope(
      defective,
      { ...legacyProposals, summary: result.summary },
      { legacy: true },
    ),
  );
  assert.equal(
    legacy('25302149', '2510'),
    'rejected',
    'the 16.12 false negative this phase closes',
  );
});

test('Char-Broil: an additive unparsed row keeps positives and withholds every rejection', async () => {
  const body = (await html('char-broil')).replace(
    '<span lang="EN-US">25302149</span>',
    '<span lang="EN-US">25302149 (black)</span>',
  );
  const result = await analyze(body);
  const table = tableOf(result.ledger);
  const unresolved = table.records.filter((record) => record.disposition === 'unresolved');
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].effect, 'additive');
  assert.equal(result.summary.structuralStatus, 'complete');
  assert.equal(result.summary.criterionStatus, 'partial');
  assert.equal(result.summary.positiveStatus, 'independent');
  assert.equal(result.candidates.length, 16);
  const decide = await decider(result.page, await servedEnvelope(result.page, result));
  assert.equal(decide('25302145', '2510'), 'confirmed', 'an independent rule set still confirms');
  assert.equal(decide('25302149', '2510'), 'needs_review', 'the unparsed row is never rejected');
  assert.equal(
    decide('25302199', '2510'),
    'needs_review',
    'no negative without a complete universe',
  );
});

// ---------------------------------------------------------------------------
// Table structure validation (generic, on mutated official markup)
// ---------------------------------------------------------------------------

const ROW_49 =
  '<tr><td><span lang="EN-US">Bistro Pro™ Tabletop Electric Grill Black</span><span>&nbsp;</span></td><td><span lang="EN-US">25302149</span><span>&nbsp;</span></td></tr>';

test('structure anomalies are reported, never silently dropped', async () => {
  const base = await html('char-broil');
  assert.ok(base.includes(ROW_49), 'fixture row markup');
  const cases = [
    {
      name: 'row without cells',
      body: base.replace(ROW_49, '<tr></tr>'),
      expect: { structural: 'partial', positive: 'independent', candidates: 16 },
    },
    {
      name: 'nested table',
      body: base.replace(
        '<span lang="EN-US">25302149</span>',
        '<table><tr><td>25302149</td></tr><tr><td>25302155</td></tr></table>',
      ),
      expect: {
        structural: 'unresolved',
        positive: 'blocked',
        candidates: 0,
        anomaly: 'nested_table',
      },
    },
    {
      name: 'merged cells across columns',
      body: base.replace(
        ROW_49,
        '<tr><td colspan="2"><span lang="EN-US">25302149</span></td></tr>',
      ),
      expect: { structural: 'complete', positive: 'independent', candidates: 16 },
    },
    {
      name: 'duplicate row',
      body: base.replace(ROW_49, ROW_49 + ROW_49),
      expect: { structural: 'complete', positive: 'independent', candidates: 18 },
    },
    {
      name: 'unexpected extra column',
      body: base.replace(ROW_49, ROW_49.replace('</tr>', '<td>EXTRA</td></tr>')),
      expect: { structural: 'complete', positive: 'independent', candidates: 16 },
    },
    {
      name: 'rowspan beyond the table',
      body: base.replace(
        '<td><span lang="EN-US">Bistro Pro™ Electric Grill &amp; Griddle + Charcoal Mode Emerald',
        '<td rowspan="4"><span lang="EN-US">Bistro Pro™ Electric Grill &amp; Griddle + Charcoal Mode Emerald',
      ),
      expect: {
        structural: 'partial',
        positive: 'blocked',
        candidates: 0,
        anomaly: 'rowspan_overflow',
      },
    },
    {
      name: 'header cells in the body',
      body: base.replace(ROW_49, ROW_49.replaceAll('<td>', '<th>').replaceAll('</td>', '</th>')),
      expect: {
        structural: 'partial',
        positive: 'blocked',
        candidates: 0,
        anomaly: 'header_cells_in_body',
      },
    },
    {
      name: 'content outside paragraphs and tables',
      body: base.replace(
        '<table dir="ltr">',
        '<ul><li>Only units with serial numbers ending in 7 are included.</li></ul><table dir="ltr">',
      ),
      expect: { structural: 'partial', positive: 'blocked', candidates: 0 },
    },
    {
      name: 'second table with unrecognized columns',
      body: base.replace(
        '</tbody></table>',
        '</tbody></table><table><tr><td>Item #</td></tr><tr><td>SKU-1</td></tr></table>',
      ),
      expect: { structural: 'complete', positive: 'blocked', candidates: 0 },
    },
    {
      name: 'second descriptive table',
      body: base.replace(
        '</tbody></table>',
        '</tbody></table><table><tr><td>Product</td><td>Color</td></tr><tr><td>Grill cover</td><td>Black</td></tr></table>',
      ),
      expect: { structural: 'complete', positive: 'independent', candidates: 18 },
    },
    {
      name: 'identifier-bearing prose',
      body: base.replace(
        'are included in this recall.</span>',
        'are included in this recall. The models also include 25302199.</span>',
      ),
      expect: { structural: 'complete', positive: 'independent', candidates: 18 },
    },
  ];
  for (const item of cases) {
    const { summary, candidates, ledger } = await analyze(item.body);
    assert.equal(summary.structuralStatus, item.expect.structural, `${item.name}: structural`);
    assert.equal(summary.positiveStatus, item.expect.positive, `${item.name}: positive`);
    assert.equal(candidates.length, item.expect.candidates, `${item.name}: candidates`);
    assert.notEqual(summary.coverageStatus, 'complete', `${item.name}: never complete`);
    assert.equal(summary.negativeEvidenceEligible, false, `${item.name}: no negative evidence`);
    assert.equal(summary.accountedRecords, summary.authoritativeRecords, `${item.name}: accounted`);
    if (item.expect.anomaly) {
      assert.ok(
        ledger.structures.some((structure) => structure.anomalies.includes(item.expect.anomaly)),
        `${item.name}: anomaly`,
      );
    }
  }
});

test('a recall-details table outside the description is an unresolved region', async () => {
  const base = await html('char-broil');
  // Inside the recall-details region (the first occurrences are page metadata).
  const at = base.indexOf(
    'Consumers should stop using the recalled',
    base.indexOf('recall-product__details"'),
  );
  assert.ok(at > 0);
  const { summary, candidates, ledger } = await analyze(
    `${base.slice(0, at)}<table><tr><td>Serial</td></tr><tr><td>S-1</td></tr></table>${base.slice(at)}`,
  );
  assert.ok(
    ledger.structures.some((structure) => structure.structureId === 'recall-details/tables'),
  );
  assert.equal(summary.positiveStatus, 'blocked');
  assert.equal(candidates.length, 0);
});

// ---------------------------------------------------------------------------
// AGA and Friedrich
// ---------------------------------------------------------------------------

test('AGA: 6 rows accounted for, model recognized, production date deferred, not confirmation-ready', async () => {
  const { ledger, summary, candidates } = await analyze(await html('aga'));
  const table = tableOf(ledger);
  assert.equal(table.authoritativeRecordCount, 6);
  assert.equal(table.records.length, 6);
  for (const record of table.records) {
    assert.equal(record.extraction, 'extracted', 'row detected');
    assert.equal(record.disposition, 'parsed_deferred');
    assert.deepEqual(
      record.cells.map((cell) => [cell.criterionClass, cell.status]),
      [
        ['model', 'recognized'],
        ['production_date_range', 'deferred'],
      ],
    );
  }
  assert.equal(summary.structuralStatus, 'complete', 'structural extraction is complete');
  assert.equal(summary.criterionStatus, 'unresolved', 'criterion support is not');
  assert.equal(summary.coverageStatus, 'unresolved');
  assert.equal(summary.negativeEvidenceEligible, false);
  assert.equal(summary.dispositionCounts.parsed_deferred, 6);
  assert.deepEqual(candidates, []);
});

test('Friedrich: prose models and the serial subset stay unresolved; nothing is proposed', async () => {
  const { ledger, summary, candidates } = await analyze(await html('friedrich'));
  assert.equal(tableOf(ledger), undefined, 'no table on the page');
  const prose = proseOf(ledger);
  const models = prose.records.find((record) => record.reason === 'identifier-bearing prose');
  assert.equal(models.disposition, 'unresolved');
  assert.equal(models.effect, 'additive');
  const serial = prose.records.find((record) => record.disposition === 'unsupported');
  assert.equal(serial.effect, 'restrictive');
  assert.equal(summary.coverageStatus, 'unresolved');
  assert.equal(summary.positiveStatus, 'blocked');
  assert.deepEqual(candidates, []);
  const decide = await decider(
    (await analyze(await html('friedrich'))).page,
    await servedEnvelope((await analyze(await html('friedrich'))).page, { candidates, summary }),
  );
  assert.equal(decide('KCVQ08B10A', null), 'needs_review', 'a listed model is never rejected');
});

// ---------------------------------------------------------------------------
// Fingerprints and parser versions
// ---------------------------------------------------------------------------

test('coverage fingerprints are deterministic and ignore transport-only noise', async () => {
  const body = await html('char-broil');
  const first = await analyze(body);
  const second = await analyze(body);
  assert.equal(first.summary.coverageFingerprint, second.summary.coverageFingerprint);
  const noisy = body
    .replace('<table dir="ltr">', '<!-- cache 2026-09-26T10:00:00Z --><table dir="rtl" data-x="1">')
    .replace('<div class="recall-product__details">', '<div class="recall-product__details">\n\n');
  const cosmetic = await analyze(noisy);
  assert.equal(cosmetic.summary.coverageFingerprint, first.summary.coverageFingerprint);
  assert.equal(cosmetic.summary.interpretationFingerprint, first.summary.interpretationFingerprint);
  const reworded = structuredClone(first.ledger);
  reworded.structures[1].records[0].reason = 'different wording';
  assert.equal(
    await cpscCoverageInterpretationFingerprint(reworded),
    first.summary.interpretationFingerprint,
    'free-text reasons are not semantic',
  );
});

test('a new parser version with the same interpretation keeps the interpretation fingerprint', async () => {
  const { ledger, summary } = await analyze(await html('char-broil'));
  assert.equal(ledger.parserVersion, CPSC_PAGE_PARSER_VERSION);
  const next = await summarizeCpscCoverageLedger({
    ...ledger,
    parserVersion: 'phase-16.14-structured-v3',
  });
  assert.notEqual(
    next.coverageFingerprint,
    summary.coverageFingerprint,
    'the proof is re-recorded',
  );
  assert.equal(
    next.interpretationFingerprint,
    summary.interpretationFingerprint,
    'no semantic change',
  );
  assert.equal(next.coverageStatus, 'complete');
  const changed = structuredClone(ledger);
  const row = tableOf(changed).records[4];
  Object.assign(row, { disposition: 'unresolved', effect: 'additive', relation: null });
  const reinterpreted = await summarizeCpscCoverageLedger({
    ...changed,
    parserVersion: 'phase-16.14-structured-v3',
  });
  assert.notEqual(reinterpreted.interpretationFingerprint, summary.interpretationFingerprint);
  assert.equal(reinterpreted.coverageStatus, 'partial', 'a changed universe is no longer complete');
  assert.equal(reinterpreted.reviewableRelations.length, 8);
});

// ---------------------------------------------------------------------------
// Generic production logic and the validator
// ---------------------------------------------------------------------------

test('production coverage logic names no recall, brand, or page', async () => {
  for (const file of [
    'sourceCoverage.ts',
    'pageEvidence.ts',
    'htmlExtractor.ts',
    'pageIngestion.ts',
  ]) {
    const source = await readFile(new URL(`supabase/functions/_shared/cpsc/${file}`, root), 'utf8');
    assert.doesNotMatch(
      source,
      /267[0-9]{2}|Char-?Broil|Friedrich|Bistro|KCVQ|Rangemaster/iu,
      file,
    );
    assert.doesNotMatch(source, /\bAGA\b/u, file);
  }
});

test('the validator never reads completeness from an envelope without a recorded proof', async () => {
  const body = await html('char-broil');
  const result = await analyze(body);
  const served = await servedEnvelope(result.page, result);
  const recall = recallRow(result.page);
  const scope = { scope_id: served.scopeId, product_name: 'Product', model_number: null };
  const check = async (sourceCoverage) =>
    (
      await validateLiveRuleSetEnvelopeV2(recall, scope, {
        ...served.envelope,
        coverage: { ...served.envelope.coverage, sourceCoverage },
      })
    ).coverageComplete;
  assert.equal(await check(served.envelope.coverage.sourceCoverage), true);
  assert.equal(await check(undefined), false, 'absent proof');
  assert.equal(
    await check({
      state: 'missing',
      coverageStatus: 'unresolved',
      positiveStatus: 'unknown',
      negativeEvidenceEligible: false,
    }),
    false,
    'missing ledger',
  );
  assert.equal(
    await check({
      state: 'recorded',
      coverageStatus: 'partial',
      positiveStatus: 'independent',
      negativeEvidenceEligible: false,
    }),
    false,
    'partial ledger',
  );
});

test('the page worker fails closed when the database does not accept the ledger as computed', async () => {
  const body = await html('char-broil');
  const target = {
    identityId: 'a0000000-0000-4000-8000-000000000010',
    officialRecallNumber: '26773',
    canonicalUrl: canonicalOf(body),
    soleScopeId: 'a0000000-0000-4000-8000-000000000011',
  };
  const calls = [];
  const database = {
    rpc(name, parameters) {
      calls.push(name);
      const data = {
        record_cpsc_page_revision: { status: 'created', revisionId: 'revision-1' },
        record_cpsc_page_fetch: 'fetch-1',
        propose_cpsc_candidate_criterion: { status: 'created', candidateId: 'c' },
        record_cpsc_page_coverage: {
          status: 'created',
          coverageFingerprint: 'f'.repeat(64),
          coverageStatus: 'complete',
          positiveStatus: 'independent',
        },
      }[name];
      return Promise.resolve({ data, error: null });
    },
  };
  await assert.rejects(
    ingestCpscOfficialPage(
      database,
      target,
      async () => new Response(body, { headers: { 'content-type': 'text/html' } }),
    ),
    /coverage ledger was not accepted/u,
  );
  assert.equal(calls.at(-1), 'record_cpsc_page_coverage');
});
