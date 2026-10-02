import type { CpscIngestionOutcome } from './ingestionGate.ts';

/**
 * Phase 16.16A row outcomes. Every fetched record gets exactly one.
 *
 * - processed:   a new notice was inserted, or a notice revision was created
 * - unchanged:   resolved to a known identity with no content change
 * - quarantined: held for a human, with the complete payload durably retained
 * - unresolved:  held for a human, with the complete payload durably retained
 *                (reserved: no current database decision produces it)
 * - failed:      anything else, including a hold whose retention is unconfirmed
 *
 * Only `failed` is fatal to a source run. A hold is non-fatal because the
 * database has already stored and verified the evidence that produced it.
 */
export type CpscRowOutcome = 'processed' | 'unchanged' | 'quarantined' | 'unresolved' | 'failed';

export type CpscOutcomeCounts = Record<CpscRowOutcome, number>;

const HEX64 = /^[0-9a-f]{64}$/u;

export function emptyOutcomeCounts(): CpscOutcomeCounts {
  return { processed: 0, unchanged: 0, quarantined: 0, unresolved: 0, failed: 0 };
}

/** Throws (so the caller counts `failed`) unless a hold is proven durable. */
export function classifyCpscIngestion(
  outcome: CpscIngestionOutcome,
): Exclude<CpscRowOutcome, 'failed'> {
  if (outcome.status === 'quarantined') {
    const observation = outcome.observation;
    if (observation.status !== 'quarantined' || !HEX64.test(observation.payloadSha256)) {
      throw new Error('CPSC quarantine without a retained source payload.');
    }
    return 'quarantined';
  }
  if (outcome.status === 'inserted' || outcome.noticeRevision?.status === 'created') {
    return 'processed';
  }
  return 'unchanged';
}

/**
 * The run may report success (and so advance the watermark) only when no row
 * failed and every fetched row is accounted for by exactly one outcome.
 */
export function sourceRunComplete(fetched: number, counts: CpscOutcomeCounts): boolean {
  const accounted =
    counts.processed + counts.unchanged + counts.quarantined + counts.unresolved + counts.failed;
  return counts.failed === 0 && accounted === fetched;
}
