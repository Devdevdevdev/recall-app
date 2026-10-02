export type ProductionMatcherPolicy = 'phase_10_guarded_v1' | 'phase_16_deterministic_v2';

export function productionMatcherPolicy(value: string | undefined): ProductionMatcherPolicy {
  if (value === undefined || value === '' || value === 'phase_10_guarded_v1') {
    return 'phase_10_guarded_v1';
  }
  if (value === 'phase_16_deterministic_v2') return value;
  throw new Error('Unknown recall matching policy.');
}
