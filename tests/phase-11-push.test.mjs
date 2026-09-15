import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { deliverQueuedRecallNotifications } from '../supabase/functions/_shared/push/delivery.ts';
import {
  ExpoPushClient,
  ExpoPushRequestError,
} from '../supabase/functions/_shared/push/expoClient.ts';
import {
  buildRecallPushMessage,
  RECALL_NOTIFICATION_BODY,
  RECALL_NOTIFICATION_TITLE,
} from '../supabase/functions/_shared/push/payload.ts';
import {
  isExpoPushToken,
  parseSendRecallNotificationsRequest,
} from '../supabase/functions/_shared/push/validation.ts';
import { notificationAlertId } from '../src/services/pushNotifications/validation.ts';

const alertId = '10000000-0000-4000-8000-000000000001';
const deliveryId = '20000000-0000-4000-8000-000000000002';
const deviceId = '30000000-0000-4000-8000-000000000003';
const leaseToken = '40000000-0000-4000-8000-000000000004';
const expoToken = 'ExpoPushToken[phase11_test-token]';

function claimedDelivery(overrides = {}) {
  return {
    deliveryId,
    alertId,
    pushDeviceId: deviceId,
    expoPushToken: expoToken,
    attemptCount: 1,
    leaseToken,
    ...overrides,
  };
}

function fakeStore(overrides = {}) {
  const tickets = [];
  const receipts = [];
  const queuedAlertIds = [];
  return {
    tickets,
    receipts,
    queuedAlertIds,
    async queueAlerts({ alertIds }) {
      queuedAlertIds.push(...alertIds);
      return alertIds.length;
    },
    async claimDeliveries() {
      return [claimedDelivery()];
    },
    async recordTicket(input) {
      tickets.push(input);
    },
    async claimReceipts() {
      return [];
    },
    async recordReceipt(input) {
      receipts.push(input);
    },
    ...overrides,
  };
}

test('Expo push token validation accepts documented formats and rejects malformed values', () => {
  assert.equal(isExpoPushToken(expoToken), true);
  assert.equal(isExpoPushToken('ExponentPushToken[legacy_token-1]'), true);
  assert.equal(isExpoPushToken('plain-device-token'), false);
  assert.equal(isExpoPushToken('ExpoPushToken[]'), false);
});

test('request parsing is bounded and validates optional alert IDs', () => {
  assert.deepEqual(parseSendRecallNotificationsRequest(null), {
    alertIds: null,
    batchSize: 25,
    checkReceipts: true,
  });
  assert.deepEqual(
    parseSendRecallNotificationsRequest({ alertIds: [alertId, alertId], batchSize: 50 }),
    { alertIds: [alertId], batchSize: 50, checkReceipts: true },
  );
  assert.throws(() => parseSendRecallNotificationsRequest({ alertIds: ['not-an-id'] }));
  assert.throws(() => parseSendRecallNotificationsRequest({ batchSize: 51 }));
});

test('notification payload is generic and contains only the alert navigation ID', () => {
  const message = buildRecallPushMessage({ expoPushToken: expoToken, alertId });
  assert.deepEqual(message, {
    to: expoToken,
    title: RECALL_NOTIFICATION_TITLE,
    body: RECALL_NOTIFICATION_BODY,
    data: { alertId },
    channelId: 'recall-alerts',
    priority: 'high',
  });
  const serialized = JSON.stringify(message);
  for (const privateField of [
    'email',
    'serial_number',
    'lot_number',
    'raw_payload',
    'ocr',
    'nebius',
  ]) {
    assert.equal(serialized.toLowerCase().includes(privateField), false);
  }
});

test('notification navigation accepts only a UUID alertId', () => {
  assert.equal(notificationAlertId({ alertId }), alertId);
  assert.equal(notificationAlertId({ alertId: '../settings' }), null);
  assert.equal(notificationAlertId({ url: `/alerts/${alertId}` }), null);
});

test('Expo client validates a successful ticket response without logging provider data', async () => {
  const client = new ExpoPushClient({
    fetch: async () =>
      new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket-1' }] }), {
        status: 200,
      }),
  });
  assert.deepEqual(
    await client.send([buildRecallPushMessage({ expoPushToken: expoToken, alertId })]),
    [{ status: 'ok', id: 'ticket-1' }],
  );
});

test('Expo client classifies HTTP throttling as transient', async () => {
  const client = new ExpoPushClient({ fetch: async () => new Response('', { status: 429 }) });
  await assert.rejects(
    () => client.send([buildRecallPushMessage({ expoPushToken: expoToken, alertId })]),
    (error) =>
      error instanceof ExpoPushRequestError && error.code === 'http_429' && error.transient,
  );
});

test('an accepted Expo ticket is persisted as accepted, not delivered', async () => {
  const store = fakeStore();
  const summary = await deliverQueuedRecallNotifications(
    { alertIds: [alertId], batchSize: 25, checkReceipts: false },
    {
      store,
      provider: {
        async send() {
          return [{ status: 'ok', id: 'ticket-1' }];
        },
        async getReceipts() {
          return {};
        },
      },
    },
  );
  assert.equal(summary.accepted, 1);
  assert.deepEqual(store.queuedAlertIds, [alertId]);
  assert.deepEqual(store.tickets[0], {
    deliveryId,
    leaseToken,
    outcome: 'accepted',
    expoTicketId: 'ticket-1',
    errorCode: null,
  });
});

test('DeviceNotRegistered disables the logical device delivery', async () => {
  const store = fakeStore();
  const summary = await deliverQueuedRecallNotifications(
    { alertIds: null, batchSize: 25, checkReceipts: false },
    {
      store,
      provider: {
        async send() {
          return [
            {
              status: 'error',
              message: 'Device is no longer registered.',
              details: { error: 'DeviceNotRegistered' },
            },
          ];
        },
        async getReceipts() {
          return {};
        },
      },
    },
  );
  assert.equal(summary.invalidDevices, 1);
  assert.equal(store.tickets[0].outcome, 'invalid_device');
});

test('transient provider failures are persisted for bounded database retry', async () => {
  const store = fakeStore();
  const summary = await deliverQueuedRecallNotifications(
    { alertIds: null, batchSize: 25, checkReceipts: false },
    {
      store,
      provider: {
        async send() {
          throw new ExpoPushRequestError('timeout', true);
        },
        async getReceipts() {
          return {};
        },
      },
    },
  );
  assert.equal(summary.transientFailures, 1);
  assert.equal(store.tickets[0].outcome, 'transient_error');
});

test('permanent provider failures are not marked retryable', async () => {
  const store = fakeStore();
  const summary = await deliverQueuedRecallNotifications(
    { alertIds: null, batchSize: 25, checkReceipts: false },
    {
      store,
      provider: {
        async send() {
          return [
            {
              status: 'error',
              message: 'Credentials rejected.',
              details: { error: 'InvalidCredentials' },
            },
          ];
        },
        async getReceipts() {
          return {};
        },
      },
    },
  );
  assert.equal(summary.failed, 1);
  assert.equal(store.tickets[0].outcome, 'permanent_error');
});

test('receipt success records provider handoff separately from ticket acceptance', async () => {
  const store = fakeStore({
    async claimDeliveries() {
      return [];
    },
    async claimReceipts() {
      return [{ deliveryId, pushDeviceId: deviceId, expoTicketId: 'ticket-1', leaseToken }];
    },
  });
  const summary = await deliverQueuedRecallNotifications(
    { alertIds: null, batchSize: 25, checkReceipts: true },
    {
      store,
      provider: {
        async send() {
          return [];
        },
        async getReceipts() {
          return { 'ticket-1': { status: 'ok' } };
        },
      },
    },
  );
  assert.equal(summary.receiptOk, 1);
  assert.equal(store.receipts[0].outcome, 'ok');
});

test('push path contains no Nebius import and mobile code contains no server push credential', async () => {
  const deliverySource = await readFile(
    new URL('../supabase/functions/_shared/push/delivery.ts', import.meta.url),
    'utf8',
  );
  const edgeSource = await readFile(
    new URL('../supabase/functions/send-recall-notifications/index.ts', import.meta.url),
    'utf8',
  );
  const mobileSource = await readFile(
    new URL('../src/services/pushNotifications/pushNotifications.native.ts', import.meta.url),
    'utf8',
  );
  assert.equal(/nebius|nemotron/i.test(deliverySource + edgeSource), false);
  assert.equal(/EXPO_ACCESS_TOKEN|RECALL_PUSH_DELIVERY_KEY/.test(mobileSource), false);
  assert.match(edgeSource, /RECALL_PUSH_DELIVERY_ENABLED/);
});

test('both remote delivery entry points require the server-side kill switch', async () => {
  const sendSource = await readFile(
    new URL('../supabase/functions/send-recall-notifications/index.ts', import.meta.url),
    'utf8',
  );
  const matchingSource = await readFile(
    new URL('../supabase/functions/process-recall-matches/index.ts', import.meta.url),
    'utf8',
  );
  assert.match(sendSource, /RECALL_PUSH_DELIVERY_ENABLED/);
  assert.match(sendSource, /Recall push delivery is disabled/);
  assert.match(matchingSource, /RECALL_PUSH_DELIVERY_ENABLED/);
});
