import { evaluateDeterministicMatchV2 } from './deterministicMatcherV2.ts';
import type { MatchDecision } from './types.ts';
import type {
  DeterministicMatchEvaluationV2,
  OfficialRecallEvidenceV2,
  OfficialRecallScopeEvidenceV2,
  OwnedProductEvidenceV2,
  RecallCriterionSet,
} from './typesV2.ts';

/**
 * Versioned OR-of-AND adapter over the frozen deterministic_v2 core. The frozen
 * matcher already confirms when ANY explicit all_of scope is fully satisfied, so
 * each rule set is evaluated as its own all_of unit. The frozen files are not
 * modified and no conjunction is ever flattened across rule sets.
 */
export const DETERMINISTIC_RULE_SETS_ADAPTER_V2 = 'deterministic_v2_rule_sets_v1';

export type ScopeRuleSetV2 = RecallCriterionSet & { semantics: 'all_of'; ruleSetId: string };

export type OfficialRecallScopeRuleSetsV2 = Omit<OfficialRecallScopeEvidenceV2, 'criteria'> & {
  /** OR across rule sets; AND inside each rule set. */
  ruleSets?: readonly ScopeRuleSetV2[];
  /** True only when every authoritative conjunction of the scope is represented. */
  ruleSetCoverageComplete: boolean;
};

export type OfficialRecallRuleSetsV2 = Omit<OfficialRecallEvidenceV2, 'scopes'> & {
  scopes: readonly OfficialRecallScopeRuleSetsV2[];
};

export type RuleSetUnitV2 = { scopeIndex: number; ruleSetId: string | null };

export type RuleSetTraceV2 = RuleSetUnitV2 & { decision: MatchDecision };

export type DeterministicRuleSetsEvaluationV2 = DeterministicMatchEvaluationV2 & {
  adapter: typeof DETERMINISTIC_RULE_SETS_ADAPTER_V2;
  ruleSetTrace: readonly RuleSetTraceV2[];
  coverageComplete: boolean;
  /** A contradiction of the served rule sets cannot prove the product is out of scope. */
  rejectionWithheld: boolean;
};

export type ExpandedRuleSetsV2 = {
  official: OfficialRecallEvidenceV2;
  units: readonly RuleSetUnitV2[];
  coverageComplete: boolean;
};

export function expandRuleSetsV2(recall: OfficialRecallRuleSetsV2): ExpandedRuleSetsV2 {
  const scopes: OfficialRecallScopeEvidenceV2[] = [];
  const units: RuleSetUnitV2[] = [];
  recall.scopes.forEach((scope, scopeIndex) => {
    const { ruleSets, ruleSetCoverageComplete: _coverage, ...base } = scope;
    if (!ruleSets?.length) {
      scopes.push(base);
      units.push({ scopeIndex, ruleSetId: null });
      return;
    }
    const ids = new Set<string>();
    for (const ruleSet of ruleSets) {
      if (
        ruleSet.semantics !== 'all_of' ||
        !ruleSet.criteria.length ||
        !ruleSet.ruleSetId ||
        ids.has(ruleSet.ruleSetId)
      ) {
        throw new Error('Rule set semantics are invalid.');
      }
      ids.add(ruleSet.ruleSetId);
      scopes.push({ ...base, criteria: ruleSet });
      units.push({ scopeIndex, ruleSetId: ruleSet.ruleSetId });
    }
  });
  const coverageComplete =
    recall.scopes.length > 0 &&
    recall.scopes.every(
      (scope) => scope.ruleSetCoverageComplete && Boolean(scope.ruleSets?.length),
    );
  return { official: { ...recall, scopes }, units, coverageComplete };
}

/** Pure evaluation of already-expanded units. No I/O, persistence, alerting, or inference. */
export function evaluateExpandedRuleSetsV2(
  ownedProduct: OwnedProductEvidenceV2,
  official: OfficialRecallEvidenceV2,
  units: readonly RuleSetUnitV2[],
  coverageComplete: boolean,
): DeterministicRuleSetsEvaluationV2 {
  if (units.length !== official.scopes.length) {
    throw new Error('Rule set units must match the expanded scopes.');
  }
  const evaluation = evaluateDeterministicMatchV2(ownedProduct, official);
  const ruleSetTrace = units.map((unit, index) => ({
    ...unit,
    decision: evaluateDeterministicMatchV2(ownedProduct, {
      ...official,
      scopes: [official.scopes[index]!],
    }).decision,
  }));
  const rejectionWithheld = evaluation.decision === 'rejected' && !coverageComplete;
  return {
    ...evaluation,
    ...(rejectionWithheld
      ? {
          decision: 'needs_review' as const,
          confidence: 0,
          reasoningSummary:
            'Every served rule set is contradicted, but authoritative rule-set coverage is ' +
            'incomplete, so v2 cannot declare the product outside the recall.',
        }
      : {}),
    adapter: DETERMINISTIC_RULE_SETS_ADAPTER_V2,
    ruleSetTrace,
    coverageComplete,
    rejectionWithheld,
  };
}

export function evaluateDeterministicRuleSetsV2(
  ownedProduct: OwnedProductEvidenceV2,
  recall: OfficialRecallRuleSetsV2,
): DeterministicRuleSetsEvaluationV2 {
  const { official, units, coverageComplete } = expandRuleSetsV2(recall);
  return evaluateExpandedRuleSetsV2(ownedProduct, official, units, coverageComplete);
}
