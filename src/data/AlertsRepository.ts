import type { RecallAlert } from '@/src/domain';

export interface AlertsRepository {
  listForCurrentUser(): Promise<readonly RecallAlert[]>;
  getById(id: string): Promise<RecallAlert | null>;
}
