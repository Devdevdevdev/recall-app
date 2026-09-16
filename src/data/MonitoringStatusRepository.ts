import type { MonitoringStatusProjection } from '@/src/features/coverage/coveragePresentation';

export interface MonitoringStatusRepository {
  getStatus(): Promise<MonitoringStatusProjection>;
}
