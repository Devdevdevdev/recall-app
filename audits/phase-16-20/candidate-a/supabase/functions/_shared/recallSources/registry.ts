import { cpscRecallSourceAdapter } from '../cpsc/adapter.ts';
import { healthCanadaRecallSourceAdapter } from '../healthCanada/adapter.ts';
import type { RecallSourceAdapter } from './types.ts';

const adapters: readonly RecallSourceAdapter[] = [
  cpscRecallSourceAdapter,
  healthCanadaRecallSourceAdapter,
];

export function getRecallSourceAdapter(sourceKey: string): RecallSourceAdapter | null {
  return adapters.find((adapter) => adapter.definition.key === sourceKey) ?? null;
}

export function listRecallSourceAdapters(): readonly RecallSourceAdapter[] {
  return adapters;
}
