import type { ExpoPushMessage } from './types.ts';

export const RECALL_NOTIFICATION_TITLE = 'Product recall alert';
export const RECALL_NOTIFICATION_BODY =
  'A product in your Recall inventory may be affected by an official safety recall.';
export const RECALL_NOTIFICATION_CHANNEL_ID = 'recall-alerts';

export function buildRecallPushMessage(input: {
  expoPushToken: string;
  alertId: string;
}): ExpoPushMessage {
  return {
    to: input.expoPushToken,
    title: RECALL_NOTIFICATION_TITLE,
    body: RECALL_NOTIFICATION_BODY,
    data: { alertId: input.alertId },
    channelId: RECALL_NOTIFICATION_CHANNEL_ID,
    priority: 'high',
  };
}
