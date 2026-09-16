import type { RecallAlert } from '@/src/domain';

export interface AlertsRepository {
  getActiveCount(): Promise<number>;
  listForCurrentUser(): Promise<readonly RecallAlert[]>;
  getById(id: string): Promise<RecallAlert | null>;
}
