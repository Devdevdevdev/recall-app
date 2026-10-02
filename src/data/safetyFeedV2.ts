import { requireSupabaseClient } from '@/src/services/supabase';

export type SafetyObservationV2 = {
  ownedProductId: string;
  recallNoticeId: string;
  productName: string | null;
  decision: 'confirmed' | 'rejected' | 'needs_review';
  displayState:
    | 'confirmed_alert'
    | 'confirmed_pending_alert'
    | 'no_longer_confirmed'
    | 'rejected'
    | 'needs_review';
  evaluatedAt: string;
  alertId: string | null;
  alertCreatedAt: string | null;
  alertState: 'unread' | 'read' | 'dismissed' | null;
  previousAlertId: string | null;
  previousAlertState: 'unread' | 'read' | 'dismissed' | null;
  previousMatchStatus: 'confirmed' | 'rejected' | 'needs_review' | 'candidate' | null;
  authority: string;
  title: string;
  officialUrl: string;
  recallDate: string;
  hazard: string | null;
  remedy: string | null;
};

type Row = {
  owned_product_id: string;
  recall_notice_id: string;
  product_name: string | null;
  decision: SafetyObservationV2['decision'];
  display_state: SafetyObservationV2['displayState'];
  evaluated_at: string;
  alert_id: string | null;
  alert_created_at: string | null;
  alert_state: SafetyObservationV2['alertState'];
  previous_alert_id: string | null;
  previous_alert_state: SafetyObservationV2['previousAlertState'];
  previous_match_status: SafetyObservationV2['previousMatchStatus'];
  authority: string;
  title: string;
  official_url: string;
  recall_date: string;
  hazard: string | null;
  remedy: string | null;
};

/** Hidden until the v2 database contract and consumer display are approved. */
export const safetyFeedV2Enabled = process.env.EXPO_PUBLIC_RECALL_V2_READ_ENABLED === 'true';

export async function listSafetyObservationsV2(): Promise<readonly SafetyObservationV2[]> {
  if (!safetyFeedV2Enabled) return [];
  const { data, error } = await requireSupabaseClient().rpc('get_recall_safety_feed_v2');
  if (error || !Array.isArray(data)) throw new Error('Unable to load safety evaluations.');
  return (data as Row[]).map((row) => ({
    ownedProductId: row.owned_product_id,
    recallNoticeId: row.recall_notice_id,
    productName: row.product_name,
    decision: row.decision,
    displayState: row.display_state,
    evaluatedAt: row.evaluated_at,
    alertId: row.alert_id,
    alertCreatedAt: row.alert_created_at,
    alertState: row.alert_state,
    previousAlertId: row.previous_alert_id,
    previousAlertState: row.previous_alert_state,
    previousMatchStatus: row.previous_match_status,
    authority: row.authority,
    title: row.title,
    officialUrl: row.official_url,
    recallDate: row.recall_date,
    hazard: row.hazard,
    remedy: row.remedy,
  }));
}

export async function markSafetyAlertReadV2(alertId: string): Promise<void> {
  if (!safetyFeedV2Enabled) throw new Error('V2 safety feed is disabled.');
  const { data, error } = await requireSupabaseClient().rpc('update_recall_v2_alert_state', {
    p_alert_id: alertId,
    p_state: 'read',
  });
  if (error || data !== true) throw new Error('Unable to mark safety alert as read.');
}
