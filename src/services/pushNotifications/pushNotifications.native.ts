import 'expo-sqlite/localStorage/install';

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { requireSupabaseClient } from '@/src/services/supabase';

import {
  runNotificationDisableFlow,
  runNotificationEnableFlow,
  type NotificationDiagnostic,
  type NotificationPermissionSnapshot,
} from './registrationFlow';
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

function projectId(): string | null {
  const value = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  return typeof value === 'string' && value ? value : null;
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
  const resolvedProjectId = projectId();
  if (!resolvedProjectId) throw new Error('Recall is not connected to an EAS project.');
  return (await Notifications.getExpoPushTokenAsync({ projectId: resolvedProjectId })).data;
}

async function registerExpoPushToken(token: string, platform: string): Promise<void> {
  const { error } = await requireSupabaseClient().rpc('register_push_device', {
    p_expo_push_token: token,
    p_platform: platform,
  });
  if (error) {
    const registrationError = new Error(error.message || 'Push-device registration failed.');
    registrationError.name = 'PushDeviceRegistrationError';
    Object.assign(registrationError, { code: error.code });
    throw registrationError;
  }
}

async function unregisterExpoPushToken(token: string): Promise<void> {
  const { error } = await requireSupabaseClient().rpc('unregister_push_device', {
    p_expo_push_token: token,
  });
  if (error) throw new Error('Push-device unregistration failed.');
}

async function registerToken(): Promise<void> {
  await registerExpoPushToken(await expoPushToken(), Platform.OS);
}

function permissionSnapshot(
  permission: Notifications.NotificationPermissionsStatus,
): NotificationPermissionSnapshot {
  return {
    granted: permissionGranted(permission),
    canAskAgain: permission.canAskAgain,
    status: permission.status,
  };
}

function reportDiagnostic(diagnostic: NotificationDiagnostic): void {
  if (!__DEV__) return;
  console.warn('[Recall notifications]', diagnostic);
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
  return runNotificationEnableFlow({
    platform: Platform.OS,
    configureAndroidChannel,
    getPermissions: async () => permissionSnapshot(await Notifications.getPermissionsAsync()),
    requestPermissions: async () =>
      permissionSnapshot(await Notifications.requestPermissionsAsync()),
    resolveProjectId: projectId,
    getExpoPushToken: async (resolvedProjectId) =>
      (await Notifications.getExpoPushTokenAsync({ projectId: resolvedProjectId })).data,
    registerPushDevice: registerExpoPushToken,
    persistPreference: setPreference,
    reportDiagnostic,
  });
}

export async function disableRecallPushNotifications(): Promise<PushNotificationStatus> {
  return runNotificationDisableFlow({
    persistPreference: setPreference,
    getPermissions: async () => permissionSnapshot(await Notifications.getPermissionsAsync()),
    getExpoPushToken: expoPushToken,
    unregisterPushDevice: unregisterExpoPushToken,
    unregisterNative: () => Notifications.unregisterForNotificationsAsync(),
  });
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
    await unregisterExpoPushToken(token);
    await Notifications.unregisterForNotificationsAsync().catch(() => undefined);
  } catch {
    // Sign-out must remain available offline. A later enabled-account sign-in reassigns this token.
    await Notifications.unregisterForNotificationsAsync().catch(() => undefined);
  }
}
