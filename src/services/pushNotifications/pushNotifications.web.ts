import type { PushNotificationStatus } from './types';

const unsupported: PushNotificationStatus = {
  status: 'unsupported',
  message: 'Recall push notifications are available in the Android and iOS apps.',
};

export async function getRecallPushNotificationStatus(): Promise<PushNotificationStatus> {
  return unsupported;
}

export async function enableRecallPushNotifications(): Promise<PushNotificationStatus> {
  return unsupported;
}

export async function disableRecallPushNotifications(): Promise<PushNotificationStatus> {
  return unsupported;
}

export async function reconcileRecallPushNotifications(): Promise<void> {}

export async function unregisterRecallPushBeforeSignOut(): Promise<void> {}
