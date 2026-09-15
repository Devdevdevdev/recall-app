// TypeScript resolves this fallback while Metro selects the .native or .web implementation.
export {
  disableRecallPushNotifications,
  enableRecallPushNotifications,
  getRecallPushNotificationStatus,
  reconcileRecallPushNotifications,
  unregisterRecallPushBeforeSignOut,
} from './pushNotifications.native';
