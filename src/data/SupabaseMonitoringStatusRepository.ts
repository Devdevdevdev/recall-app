import type { MonitoringStatusProjection } from '@/src/features/coverage/coveragePresentation';
import { requireSupabaseClient } from '@/src/services/supabase';

import type { MonitoringStatusRepository } from './MonitoringStatusRepository';

type MonitoringStatusRow = {
  monitoring_enabled: boolean;
  last_successful_check_at: string | null;
  active_source_count: number;
};

export class SupabaseMonitoringStatusRepository implements MonitoringStatusRepository {
  async getStatus(): Promise<MonitoringStatusProjection> {
    const { data, error } = await requireSupabaseClient().rpc('get_monitoring_status');
    if (error) throw error;

    const row = (data as MonitoringStatusRow[] | null)?.[0];
    if (!row) throw new Error('Monitoring status is unavailable.');

    return {
      monitoringEnabled: row.monitoring_enabled,
      lastSuccessfulCheckAt: row.last_successful_check_at,
      activeSourceCount: Number(row.active_source_count),
    };
  }
}

export const monitoringStatusRepository: MonitoringStatusRepository =
  new SupabaseMonitoringStatusRepository();
