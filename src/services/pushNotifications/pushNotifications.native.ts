import 'expo-sqlite/localStorage/install';

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { requireSupabaseClient } from '@/src/services/supabase';

import type { PushNotificationStatus } from './types';

const preferenceKey = 'recall.push-notifications.enabled';
export const recallNotificationChannelId = 'recall-alerts';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function projectId(): string {
  const value = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (typeof value !== 'string' || !value) {
    throw new Error('Recall is not connected to an EAS project.');
  }
  return value;
}

function preferenceEnabled(): boolean {
  return globalThis.localStorage.getItem(preferenceKey) === 'true';
}

function setPreference(enabled: boolean): void {
  globalThis.localStorage.setItem(preferenceKey, String(enabled));
}

function permissionGranted(permission: Notifications.NotificationPermissionsStatus): boolean {
  if (Platform.OS !== 'ios') return permission.granted;
  const status = permission.ios?.status;
  return (
    status === Notifications.IosAuthorizationStatus.AUTHORIZED ||
    status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    status === Notifications.IosAuthorizationStatus.EPHEMERAL
  );
}

async function configureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(recallNotificationChannelId, {
    name: 'Recall alerts',
    description: 'Official product-safety recall alerts for products saved in Recall.',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#B42318',
  });
}

async function expoPushToken(): Promise<string> {
  await configureAndroidChannel();
  return (await Notifications.getExpoPushTokenAsync({ projectId: projectId() })).data;
}

async function registerToken(): Promise<void> {
  const token = await expoPushToken();
  const { error } = await requireSupabaseClient().rpc('register_push_device', {
    p_expo_push_token: token,
    p_platform: Platform.OS,
  });
  if (error) throw new Error('Push-device registration failed.');
}

export async function getRecallPushNotificationStatus(): Promise<PushNotificationStatus> {
  if (!preferenceEnabled()) {
    return {
      status: 'disabled',
      message: 'Notifications are off for this device.',
    };
  }
  const permission = await Notifications.getPermissionsAsync();
  if (!permissionGranted(permission)) {
    return {
      status: 'denied',
      canAskAgain: permission.canAskAgain,
      message: 'Notification permission is not enabled in system settings.',
    };
  }
  return { status: 'enabled', message: 'Notifications enabled' };
}

export async function enableRecallPushNotifications(): Promise<PushNotificationStatus> {
  try {
    await configureAndroidChannel();
    let permission = await Notifications.getPermissionsAsync();
    if (!permissionGranted(permission)) {
      permission = await Notifications.requestPermissionsAsync();
    }
    if (!permissionGranted(permission)) {
      return {
        status: 'denied',
        canAskAgain: permission.canAskAgain,
        message: 'Notification permission was not granted.',
      };
    }
    await registerToken();
    setPreference(true);
    return { status: 'enabled', message: 'Notifications enabled' };
  } catch {
    return {
      status: 'error',
      message: 'Unable to enable notifications. Check your connection and try again.',
    };
  }
}

export async function disableRecallPushNotifications(): Promise<PushNotificationStatus> {
  setPreference(false);
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (permissionGranted(permission)) {
      const token = await expoPushToken();
      const { error } = await requireSupabaseClient().rpc('unregister_push_device', {
        p_expo_push_token: token,
      });
      if (error) throw new Error('Push-device unregistration failed.');
    }
    await Notifications.unregisterForNotificationsAsync().catch(() => undefined);
    return { status: 'disabled', message: 'Notifications are off for this device.' };
  } catch {
    await Notifications.unregisterForNotificationsAsync().catch(() => undefined);
    return {
      status: 'error',
      message:
        'Notifications are disabled in Recall, but the server could not be reached. Retry before signing out.',
    };
  }
}

export async function reconcileRecallPushNotifications(): Promise<void> {
  if (!preferenceEnabled()) return;
  const permission = await Notifications.getPermissionsAsync();
  if (!permissionGranted(permission)) return;
  await registerToken();
}

export async function unregisterRecallPushBeforeSignOut(): Promise<void> {
  if (!preferenceEnabled()) return;
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (!permissionGranted(permission)) return;
    const token = await expoPushToken();
    const { error } = await requireSupabaseClient().rpc('unregister_push_device', {
      p_expo_push_token: token,
    });
    if (error) throw new Error('Push-device unregistration failed.');
    await Notifications.unregisterForNotificationsAsync().catch(() => undefined);
  } catch {
    // Sign-out must remain available offline. A later enabled-account sign-in reassigns this token.
    await Notifications.unregisterForNotificationsAsync().catch(() => undefined);
  }
}
