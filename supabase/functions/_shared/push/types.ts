export type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data: { alertId: string };
  channelId: 'recall-alerts';
  priority: 'high';
};

export type ExpoPushTicket =
  { status: 'ok'; id: string } | { status: 'error'; message: string; details?: { error?: string } };

export type ExpoPushReceipt =
  { status: 'ok' } | { status: 'error'; message: string; details?: { error?: string } };

export type ClaimedPushDelivery = {
  deliveryId: string;
  alertId: string;
  pushDeviceId: string;
  expoPushToken: string;
  attemptCount: number;
  leaseToken: string;
};

export type ClaimedPushReceipt = {
  deliveryId: string;
  pushDeviceId: string;
  expoTicketId: string;
  leaseToken: string;
};

export type TicketOutcome = 'accepted' | 'transient_error' | 'permanent_error' | 'invalid_device';
export type ReceiptOutcome = 'ok' | 'transient_error' | 'permanent_error' | 'invalid_device';

export type PushDeliveryStore = {
  queueAlerts(input: { alertIds: readonly string[] }): Promise<number>;
  claimDeliveries(input: {
    limit: number;
    alertIds: readonly string[] | null;
  }): Promise<readonly ClaimedPushDelivery[]>;
  recordTicket(input: {
    deliveryId: string;
    leaseToken: string;
    outcome: TicketOutcome;
    expoTicketId: string | null;
    errorCode: string | null;
  }): Promise<void>;
  claimReceipts(input: { limit: number }): Promise<readonly ClaimedPushReceipt[]>;
  recordReceipt(input: {
    deliveryId: string;
    leaseToken: string;
    outcome: ReceiptOutcome;
    errorCode: string | null;
  }): Promise<void>;
};

export type ExpoPushProvider = {
  send(messages: readonly ExpoPushMessage[]): Promise<readonly ExpoPushTicket[]>;
  getReceipts(ticketIds: readonly string[]): Promise<Readonly<Record<string, ExpoPushReceipt>>>;
};
