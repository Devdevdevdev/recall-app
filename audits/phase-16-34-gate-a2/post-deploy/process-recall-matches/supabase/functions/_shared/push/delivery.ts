import { ExpoPushRequestError } from './expoClient.ts';
import { buildRecallPushMessage } from './payload.ts';
import type {
  ExpoPushProvider,
  PushDeliveryStore,
  ReceiptOutcome,
  TicketOutcome,
} from './types.ts';
import { isExpoPushToken } from './validation.ts';

export type PushDeliverySummary = {
  claimed: number;
  accepted: number;
  failed: number;
  invalidDevices: number;
  transientFailures: number;
  receiptsChecked: number;
  receiptOk: number;
};

function ticketOutcome(errorCode: string | undefined): TicketOutcome {
  if (errorCode === 'DeviceNotRegistered') return 'invalid_device';
  if (errorCode === 'MessageRateExceeded') return 'transient_error';
  return 'permanent_error';
}

function receiptOutcome(errorCode: string | undefined): ReceiptOutcome {
  if (errorCode === 'DeviceNotRegistered') return 'invalid_device';
  if (errorCode === 'MessageRateExceeded') return 'transient_error';
  return 'permanent_error';
}

export async function deliverQueuedRecallNotifications(
  input: {
    alertIds: readonly string[] | null;
    batchSize: number;
    checkReceipts: boolean;
  },
  dependencies: { store: PushDeliveryStore; provider: ExpoPushProvider },
): Promise<PushDeliverySummary> {
  const summary: PushDeliverySummary = {
    claimed: 0,
    accepted: 0,
    failed: 0,
    invalidDevices: 0,
    transientFailures: 0,
    receiptsChecked: 0,
    receiptOk: 0,
  };

  if (input.alertIds) {
    await dependencies.store.queueAlerts({ alertIds: input.alertIds });
  }

  if (input.checkReceipts) {
    const receipts = await dependencies.store.claimReceipts({ limit: input.batchSize });
    if (receipts.length) {
      try {
        const result = await dependencies.provider.getReceipts(
          receipts.map((receipt) => receipt.expoTicketId),
        );
        for (const claimed of receipts) {
          const receipt = result[claimed.expoTicketId];
          summary.receiptsChecked += 1;
          if (!receipt) {
            summary.transientFailures += 1;
            await dependencies.store.recordReceipt({
              deliveryId: claimed.deliveryId,
              leaseToken: claimed.leaseToken,
              outcome: 'transient_error',
              errorCode: 'receipt_unavailable',
            });
          } else if (receipt.status === 'ok') {
            summary.receiptOk += 1;
            await dependencies.store.recordReceipt({
              deliveryId: claimed.deliveryId,
              leaseToken: claimed.leaseToken,
              outcome: 'ok',
              errorCode: null,
            });
          } else {
            const errorCode = receipt.details?.error;
            const outcome = receiptOutcome(errorCode);
            if (outcome === 'invalid_device') summary.invalidDevices += 1;
            else if (outcome === 'transient_error') summary.transientFailures += 1;
            else summary.failed += 1;
            await dependencies.store.recordReceipt({
              deliveryId: claimed.deliveryId,
              leaseToken: claimed.leaseToken,
              outcome,
              errorCode: errorCode ?? 'receipt_error',
            });
          }
        }
      } catch (error) {
        const transient = error instanceof ExpoPushRequestError ? error.transient : true;
        for (const claimed of receipts) {
          if (transient) summary.transientFailures += 1;
          else summary.failed += 1;
          await dependencies.store.recordReceipt({
            deliveryId: claimed.deliveryId,
            leaseToken: claimed.leaseToken,
            outcome: transient ? 'transient_error' : 'permanent_error',
            errorCode: error instanceof ExpoPushRequestError ? error.code : 'provider_error',
          });
        }
      }
    }
  }

  const claimed = await dependencies.store.claimDeliveries({
    limit: input.batchSize,
    alertIds: input.alertIds,
  });
  summary.claimed = claimed.length;
  if (!claimed.length) return summary;

  const valid = claimed.filter((delivery) => isExpoPushToken(delivery.expoPushToken));
  const invalid = claimed.filter((delivery) => !isExpoPushToken(delivery.expoPushToken));
  for (const delivery of invalid) {
    summary.invalidDevices += 1;
    await dependencies.store.recordTicket({
      deliveryId: delivery.deliveryId,
      leaseToken: delivery.leaseToken,
      outcome: 'invalid_device',
      expoTicketId: null,
      errorCode: 'invalid_token',
    });
  }

  if (!valid.length) return summary;
  try {
    const tickets = await dependencies.provider.send(
      valid.map((delivery) =>
        buildRecallPushMessage({
          expoPushToken: delivery.expoPushToken,
          alertId: delivery.alertId,
        }),
      ),
    );
    for (let index = 0; index < valid.length; index += 1) {
      const delivery = valid[index];
      const ticket = tickets[index];
      if (!delivery || !ticket) continue;
      if (ticket.status === 'ok') {
        summary.accepted += 1;
        await dependencies.store.recordTicket({
          deliveryId: delivery.deliveryId,
          leaseToken: delivery.leaseToken,
          outcome: 'accepted',
          expoTicketId: ticket.id,
          errorCode: null,
        });
      } else {
        const errorCode = ticket.details?.error;
        const outcome = ticketOutcome(errorCode);
        if (outcome === 'invalid_device') summary.invalidDevices += 1;
        else if (outcome === 'transient_error') summary.transientFailures += 1;
        else summary.failed += 1;
        await dependencies.store.recordTicket({
          deliveryId: delivery.deliveryId,
          leaseToken: delivery.leaseToken,
          outcome,
          expoTicketId: null,
          errorCode: errorCode ?? 'ticket_error',
        });
      }
    }
  } catch (error) {
    const transient = error instanceof ExpoPushRequestError ? error.transient : true;
    for (const delivery of valid) {
      if (transient) summary.transientFailures += 1;
      else summary.failed += 1;
      await dependencies.store.recordTicket({
        deliveryId: delivery.deliveryId,
        leaseToken: delivery.leaseToken,
        outcome: transient ? 'transient_error' : 'permanent_error',
        expoTicketId: null,
        errorCode: error instanceof ExpoPushRequestError ? error.code : 'provider_error',
      });
    }
  }

  return summary;
}
