import type { RecallAlert } from '@/src/domain';
import { requireSupabaseClient } from '@/src/services/supabase';

import type { AlertsRepository } from './AlertsRepository';
import { toRecallAlert, type RecallAlertRow } from './alertsMappers';

const alertColumns = `
  id,
  user_id,
  recall_match_id,
  status,
  created_at,
  read_at,
  dismissed_at,
  recall_match:recall_matches!inner(
    id,
    status,
    confidence,
    match_method,
    reasoning_summary,
    evaluated_at,
    owned_product:owned_products!inner(
      id,
      brand,
      product_name,
      gtin,
      model_number,
      serial_number,
      lot_number
    ),
    recall_notice:recall_notices!inner(
      id,
      title,
      hazard,
      remedy,
      recall_date,
      official_url
    )
  )
`;

/** Read-only mobile adapter. Authentication and ownership are enforced by database RLS. */
export class SupabaseAlertsRepository implements AlertsRepository {
  async listForCurrentUser(): Promise<readonly RecallAlert[]> {
    const { data, error } = await requireSupabaseClient()
      .from('alerts')
      .select(alertColumns)
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    return (data as unknown as RecallAlertRow[]).map(toRecallAlert);
  }

  async getById(id: string): Promise<RecallAlert | null> {
    const { data, error } = await requireSupabaseClient()
      .from('alerts')
      .select(alertColumns)
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ? toRecallAlert(data as unknown as RecallAlertRow) : null;
  }
}

export const alertsRepository: AlertsRepository = new SupabaseAlertsRepository();
