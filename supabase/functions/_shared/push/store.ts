import type { ClaimedPushDelivery, ClaimedPushReceipt, PushDeliveryStore } from './types.ts';

type RpcClient = {
  rpc(
    name: string,
    parameters: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
};

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Push delivery RPC returned invalid data.');
  return value.filter(
    (row): row is Record<string, unknown> =>
      Boolean(row) && typeof row === 'object' && !Array.isArray(row),
  );
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value)
    throw new Error('Push delivery RPC returned invalid data.');
  return value;
}

export class SupabasePushDeliveryStore implements PushDeliveryStore {
  constructor(private readonly database: RpcClient) {}

  async queueAlerts(input: { alertIds: readonly string[] }): Promise<number> {
    const { data, error } = await this.database.rpc('queue_recall_push_alerts', {
      p_alert_ids: input.alertIds,
    });
    if (error || typeof data !== 'number') throw new Error('Targeted push queueing failed.');
    return data;
  }

  async claimDeliveries(input: {
    limit: number;
    alertIds: readonly string[] | null;
  }): Promise<readonly ClaimedPushDelivery[]> {
    const { data, error } = await this.database.rpc('claim_recall_push_deliveries', {
      p_limit: input.limit,
      p_alert_ids: input.alertIds,
      p_lease_seconds: 60,
    });
    if (error) throw new Error('Push delivery claim failed.');
    return records(data).map((row) => ({
      deliveryId: requiredString(row.delivery_id),
      alertId: requiredString(row.alert_id),
      pushDeviceId: requiredString(row.push_device_id),
      expoPushToken: requiredString(row.expo_push_token),
      attemptCount: Number(row.attempt_count),
      leaseToken: requiredString(row.lease_token),
    }));
  }

  async recordTicket(input: Parameters<PushDeliveryStore['recordTicket']>[0]): Promise<void> {
    const { error } = await this.database.rpc('record_recall_push_ticket', {
      p_delivery_id: input.deliveryId,
      p_lease_token: input.leaseToken,
      p_outcome: input.outcome,
      p_expo_ticket_id: input.expoTicketId,
      p_error_code: input.errorCode,
    });
    if (error) throw new Error('Push ticket persistence failed.');
  }

  async claimReceipts(input: { limit: number }): Promise<readonly ClaimedPushReceipt[]> {
    const { data, error } = await this.database.rpc('claim_recall_push_receipts', {
      p_limit: input.limit,
      p_lease_seconds: 60,
    });
    if (error) throw new Error('Push receipt claim failed.');
    return records(data).map((row) => ({
      deliveryId: requiredString(row.delivery_id),
      pushDeviceId: requiredString(row.push_device_id),
      expoTicketId: requiredString(row.expo_ticket_id),
      leaseToken: requiredString(row.lease_token),
    }));
  }

  async recordReceipt(input: Parameters<PushDeliveryStore['recordReceipt']>[0]): Promise<void> {
    const { error } = await this.database.rpc('record_recall_push_receipt', {
      p_delivery_id: input.deliveryId,
      p_lease_token: input.leaseToken,
      p_outcome: input.outcome,
      p_error_code: input.errorCode,
    });
    if (error) throw new Error('Push receipt persistence failed.');
  }
}
