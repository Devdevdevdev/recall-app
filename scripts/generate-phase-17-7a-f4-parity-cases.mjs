// Generates the shared TS/SQL gate parity cases embedded (between $cases$
// delimiters) in supabase/tests/phase-17-7a-f4-automatic-alert-safety.sql and read
// back by tests/phase-17-7a-f4-safety.test.mjs. Rule-set fingerprints are computed by
// the real TypeScript function so the live validator accepts them. Deterministic.
// Usage: node --experimental-strip-types scripts/generate-phase-17-7a-f4-parity-cases.mjs
import { computeRuleSetFingerprintV2 } from '../supabase/functions/_shared/recallMatching/ruleSetsV2.ts';

export const PARITY_AUTHORITY = 'U.S. Consumer Product Safety Commission (CPSC)';
export const PARITY_URL = 'https://www.cpsc.gov/Recalls/2026/P17F4-Parity';
const S1 = '17a4f000-0000-4000-8000-0000000000a1';
const S2 = '17a4f000-0000-4000-8000-0000000000a2';
const hex = (c) => c.repeat(64);
const uuid = (n) => `17a4f000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const MODEL1 = { kind: 'model_number', operator: 'equals', value: 'MODEL-1' };
const MODEL2 = { kind: 'model_number', operator: 'equals', value: 'MODEL-2' };
const DATES1 = { kind: 'date_code', operator: 'one_of', values: ['2501', '2502'] };
const DATES2 = { kind: 'date_code', operator: 'equals', value: '2601' };
const LOT = { kind: 'lot_number', operator: 'equals', value: '1500' };

let seq = 0;
async function ruleSet(scopeId, criteria, overrides = {}) {
  seq += 1;
  const candidateIds = criteria.map((_, index) => uuid(1000 + seq * 10 + index));
  const set = {
    semantics: overrides.semantics ?? 'all_of',
    criteria: criteria.map((criterion, index) => ({
      id: `cpsc-ledger-${candidateIds[index]}`,
      required: true,
      provenance: {
        authority: 'CPSC',
        officialUrl: overrides.officialUrl ?? PARITY_URL,
        sourceField: `cpsc-page:description/table/0/row/${seq}`,
        normalizationRule: 'identifier_v2',
      },
      ...criterion,
    })),
    review: {
      origin: 'human_review_ledger',
      schema: 'recall_rule_set_v1',
      revisionId: uuid(500),
      sourceRevisionHash: hex('a'),
      conjunctionGroup: `group-${seq}`,
      scopeId,
      scopeFingerprint: hex('b'),
      candidateIds,
      reviewEventIds: criteria.map((_, index) => uuid(2000 + seq * 10 + index)),
      reviewerIds: criteria.map(() => uuid(3000)),
      reviewedAt: '2026-10-01T00:00:00Z',
      identityFingerprint: hex('c'),
      scopeSemanticFingerprint: hex('d'),
      sourceAddressHashes: criteria.map((_, index) => hex(String((seq + index) % 10))),
      ruleSetFingerprint: hex('0'),
    },
  };
  set.review.ruleSetFingerprint = await computeRuleSetFingerprintV2(set);
  return set;
}

function envelope(scopeId, sets, { proposed, coverage = {}, source = {} } = {}) {
  return {
    semantics: 'any_of',
    schema: 'recall_rule_sets_v1',
    scopeId,
    ruleSets: sets,
    coverage: {
      currentRevisionId: uuid(500),
      proposedRuleSets: proposed ?? sets.length,
      unattributedRuleSets: 0,
      servedRuleSets: sets.length,
      complete: true,
      sourceCoverage: {
        state: 'recorded',
        coverageStatus: 'complete',
        positiveStatus: 'independent',
        negativeEvidenceEligible: true,
        ...source,
      },
      ...coverage,
    },
  };
}

const US = [{ type: 'country', code: 'US' }];
const one = async (criteria = [MODEL1, DATES1], options = {}) => [
  { scopeId: S1, envelope: envelope(S1, [await ruleSet(S1, criteria)], options) },
];
const product = (model, dateCode, country = 'US') => ({ model, dateCode, country });

export async function parityCases() {
  seq = 0;
  const twoScopes = async (second) => [
    { scopeId: S1, envelope: envelope(S1, [await ruleSet(S1, [MODEL1, DATES1])]) },
    {
      scopeId: S2,
      envelope: second === undefined ? envelope(S2, [await ruleSet(S2, [MODEL2, DATES2])]) : second,
    },
  ];
  const valid = await ruleSet(S1, [MODEL1, DATES1]);
  const cases = [
    [
      'non_official_source',
      { authoritative: false },
      product('MODEL-1', '2501'),
      US,
      await one(),
      'unsupported_scope',
    ],
    [
      'coverage_incomplete',
      {},
      product('MODEL-1', '2501'),
      US,
      await one(undefined, { coverage: { complete: false } }),
      'unsupported_scope',
    ],
    [
      'negative_evidence_not_eligible',
      {},
      product('MODEL-1', '2501'),
      US,
      await one(undefined, { source: { negativeEvidenceEligible: false } }),
      'unsupported_scope',
    ],
    [
      'ambiguous_rule_set_only',
      {},
      product('MODEL-1', '2501'),
      US,
      [
        {
          scopeId: S1,
          envelope: envelope(
            S1,
            [await ruleSet(S1, [MODEL1, DATES1], { semantics: 'ambiguous' })],
            { proposed: 0 },
          ),
        },
      ],
      'unsupported_scope',
    ],
    [
      'ambiguous_next_to_valid',
      {},
      product('MODEL-1', '2501'),
      US,
      [
        {
          scopeId: S1,
          envelope: envelope(S1, [valid, await ruleSet(S1, [MODEL1], { semantics: 'ambiguous' })], {
            proposed: 1,
          }),
        },
      ],
      'human_review_required',
    ],
    [
      'unsupported_criterion_kind',
      {},
      product('MODEL-1', '2501'),
      US,
      await one([MODEL1, LOT], { proposed: 0 }),
      'unsupported_scope',
    ],
    [
      'no_model_anchor',
      {},
      product('MODEL-1', '2501'),
      US,
      await one([DATES1], { proposed: 0 }),
      'unsupported_scope',
    ],
    [
      'stale_review_not_served',
      {},
      product('MODEL-1', '2501'),
      US,
      [{ scopeId: S1, envelope: null }],
      'unsupported_scope',
    ],
    ['model_matched', {}, product('MODEL-1', null), US, await one([MODEL1]), 'eligible'],
    ['model_and_date_code_matched', {}, product('MODEL-1', '2502'), US, await one(), 'eligible'],
    [
      'fullwidth_model_normalized',
      {},
      product('ＭＯＤＥＬ－１', '2501'),
      US,
      await one(),
      'eligible',
    ],
    [
      'date_code_mismatch',
      {},
      product('MODEL-1', '2599'),
      US,
      await one(),
      'criteria_not_satisfied',
    ],
    [
      'missing_required_date_code',
      {},
      product('MODEL-1', null),
      US,
      await one(),
      'criteria_not_satisfied',
    ],
    ['wrong_model', {}, product('MODEL-9', '2501'), US, await one(), 'criteria_not_satisfied'],
    [
      'jurisdiction_mismatch',
      {},
      product('MODEL-1', '2501', 'CA'),
      US,
      await one(),
      'jurisdiction_mismatch',
    ],
    [
      'unknown_country_country_notice',
      {},
      product('MODEL-1', '2501', null),
      US,
      await one(),
      'incomplete_evidence',
    ],
    [
      'global_notice_unknown_country',
      {},
      product('MODEL-1', '2501', null),
      [{ type: 'global', code: 'GLOBAL' }],
      await one(),
      'eligible',
    ],
    [
      'multi_scope_matches_scope_1',
      {},
      product('MODEL-1', '2501'),
      US,
      await twoScopes(),
      'eligible',
    ],
    [
      'multi_scope_matches_scope_2',
      {},
      product('MODEL-2', '2601'),
      US,
      await twoScopes(),
      'eligible',
    ],
    [
      'multi_scope_matches_none',
      {},
      product('MODEL-3', '2501'),
      US,
      await twoScopes(),
      'criteria_not_satisfied',
    ],
    [
      'multi_scope_mixes_two_scopes',
      {},
      product('MODEL-1', '2601'),
      US,
      await twoScopes(),
      'criteria_not_satisfied',
    ],
    [
      'multi_scope_second_not_served',
      {},
      product('MODEL-1', '2501'),
      US,
      await twoScopes(null),
      'unsupported_scope',
    ],
    [
      'multi_scope_second_incomplete',
      {},
      product('MODEL-1', '2501'),
      US,
      await twoScopes(
        envelope(S2, [await ruleSet(S2, [MODEL2, DATES2])], { coverage: { complete: false } }),
      ),
      'unsupported_scope',
    ],
    [
      'envelope_bound_to_another_scope',
      {},
      product('MODEL-1', '2501'),
      US,
      [{ scopeId: S1, envelope: envelope(S2, [await ruleSet(S2, [MODEL1, DATES1])]) }],
      'human_review_required',
    ],
    [
      'provenance_not_the_official_url',
      {},
      product('MODEL-1', '2501'),
      US,
      [
        {
          scopeId: S1,
          envelope: envelope(
            S1,
            [
              await ruleSet(S1, [MODEL1, DATES1], {
                officialUrl: 'https://www.cpsc.gov/Recalls/other',
              }),
            ],
            { proposed: 0 },
          ),
        },
      ],
      'unsupported_scope',
    ],
    [
      'duplicate_rule_set',
      {},
      product('MODEL-1', '2501'),
      US,
      [{ scopeId: S1, envelope: envelope(S1, [valid, valid], { proposed: 1 }) }],
      'human_review_required',
    ],
    ['no_scope', {}, product('MODEL-1', '2501'), US, [], 'unsupported_scope'],
  ];
  return cases.map(([label, source, owned, jurisdictions, scopes, expected]) => ({
    label,
    authoritative: source.authoritative ?? true,
    authority: PARITY_AUTHORITY,
    url: PARITY_URL,
    country: owned.country,
    model: owned.model,
    dateCode: owned.dateCode,
    jurisdictions,
    scopes,
    expected,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${JSON.stringify(await parityCases())}\n`);
}
