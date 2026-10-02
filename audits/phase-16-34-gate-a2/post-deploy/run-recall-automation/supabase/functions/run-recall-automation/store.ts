import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import type {
  AutomationClaim,
  AutomationRunRequest,
  AutomationStore,
} from '../_shared/automation/index.ts';

function firstRecord(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === 'object' && !Array.isArray(row)
    ? (row as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${context} returned invalid data.`);
  return value;
}

function requiredNumber(value: unknown, context: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${context} returned invalid data.`);
  }
  return Number(value);
}

export class SupabaseAutomationStore implements AutomationStore {
  constructor(private readonly database: SupabaseClient) {}

  async claimRun(input: AutomationRunRequest): Promise<AutomationClaim> {
    const { data, error } = await this.database.rpc('claim_recall_automation_run', {
      p_trigger: input.trigger,
      p_verification_mode: input.verificationMode,
      p_max_recalls: input.maxRecalls,
      p_max_candidate_pairs: input.maxCandidatePairs,
      p_max_ai_escalations: input.maxAiEscalations,
      p_notification_batch_size: input.notificationBatchSize,
    });
    if (error) throw new Error('Automation run claim failed.');
    const row = firstRecord(data);
    const status = row?.claim_status;
    const runId = requiredString(row?.run_id, 'Automation run claim');
    if (status === 'skipped_disabled' || status === 'already_running') {
      return { status, runId };
    }
    if (status !== 'claimed') throw new Error('Automation run claim returned invalid data.');
    return {
      status,
      runId,
      leaseToken: requiredString(row?.lease_token, 'Automation run claim'),
      windowStart: requiredString(row?.window_start, 'Automation run claim'),
      windowEnd: requiredString(row?.window_end, 'Automation run claim'),
      maxRecalls: requiredNumber(row?.max_recalls, 'Automation run claim'),
      maxCandidatePairs: requiredNumber(row?.max_candidate_pairs, 'Automation run claim'),
      maxAiEscalations: requiredNumber(row?.max_ai_escalations, 'Automation run claim'),
      notificationBatchSize: requiredNumber(row?.notification_batch_size, 'Automation run claim'),
      aiEnabled: row?.ai_enabled === true,
      pushEnabled: row?.push_enabled === true,
    };
  }

  async recordIngestion(input: Parameters<AutomationStore['recordIngestion']>[0]): Promise<void> {
    const { error } = await this.database.rpc('record_recall_automation_ingestion', {
      p_run_id: input.runId,
      p_lease_token: input.leaseToken,
      p_seen: input.summary.fetched,
      p_inserted: input.summary.inserted,
      p_updated: input.summary.updated,
      p_unchanged: input.summary.unchanged,
      p_affected_recall_ids: input.summary.affectedRecallIds,
    });
    if (error) throw new Error('Automation ingestion persistence failed.');
  }

  async listPendingRecalls(
    input: Parameters<AutomationStore['listPendingRecalls']>[0],
  ): Promise<readonly string[]> {
    const { data, error } = await this.database.rpc('get_recall_automation_pending_recalls', {
      p_run_id: input.runId,
      p_lease_token: input.leaseToken,
      p_limit: input.limit,
    });
    if (error || !Array.isArray(data)) throw new Error('Pending recall retrieval failed.');
    return data.map((value) => {
      const row = firstRecord(value);
      return requiredString(row?.recall_notice_id, 'Pending recall retrieval');
    });
  }

  async recordMatching(input: Parameters<AutomationStore['recordMatching']>[0]): Promise<void> {
    const { error } = await this.database.rpc('record_recall_automation_matching', {
      p_run_id: input.runId,
      p_lease_token: input.leaseToken,
      p_recall_notice_ids: input.recallNoticeIds,
      p_complete: input.complete,
      p_candidate_pairs: input.summary.candidatePairs,
      p_deterministic_resolved: input.summary.deterministicResolved,
      p_confirmed: input.summary.confirmed,
      p_rejected: input.summary.rejected,
      p_needs_review: input.summary.needsReview,
      p_ai_escalations: input.summary.nemotronEscalated,
      p_provider_failures: input.summary.providerFailures,
      p_alerts_created: input.summary.alertsCreated,
    });
    if (error) throw new Error('Automation matching persistence failed.');
  }

  async completeRun(input: Parameters<AutomationStore['completeRun']>[0]): Promise<void> {
    const pushFailed = input.push
      ? input.push.failed + input.push.invalidDevices + input.push.transientFailures
      : 0;
    const { error } = await this.database.rpc('complete_recall_automation_run', {
      p_run_id: input.runId,
      p_lease_token: input.leaseToken,
      p_status: input.status,
      p_push_claimed: input.push?.claimed ?? 0,
      p_push_accepted: input.push?.accepted ?? 0,
      p_push_failed: pushFailed,
      p_error_step: input.errorStep,
      p_error_code: input.errorCode,
    });
    if (error) throw new Error('Automation run completion failed.');
  }
}
