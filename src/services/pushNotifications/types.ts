export type PushNotificationStatus =
  | { status: 'unsupported'; message: string }
  | { status: 'disabled'; message: string }
  | { status: 'denied'; message: string; canAskAgain: boolean }
  | { status: 'enabled'; message: string }
  | { status: 'error'; message: string };

export type NotificationNavigationPayload = { alertId: string };
