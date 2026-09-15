import { useCallback, useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { router, type Href } from 'expo-router';
import { AppState } from 'react-native';

import {
  notificationAlertId,
  reconcileRecallPushNotifications,
} from '@/src/services/pushNotifications';

type Props = {
  isAuthenticated: boolean;
  isLoading: boolean;
  userId: string | null;
};

export function PushNotificationCoordinator({ isAuthenticated, isLoading, userId }: Props) {
  const pendingAlertId = useRef<string | null>(null);

  const handleResponse = useCallback((response: Notifications.NotificationResponse | null) => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    pendingAlertId.current = notificationAlertId(response.notification.request.content.data);
  }, []);

  useEffect(() => {
    const lastResponse = Notifications.getLastNotificationResponse();
    handleResponse(lastResponse);
    if (lastResponse) {
      void Notifications.clearLastNotificationResponseAsync();
    }
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      handleResponse(response);
      const alertId = pendingAlertId.current;
      if (alertId && isAuthenticated) {
        pendingAlertId.current = null;
        router.push(`/alerts/${alertId}` as Href);
      }
    });
    return () => subscription.remove();
  }, [handleResponse, isAuthenticated]);

  useEffect(() => {
    const alertId = pendingAlertId.current;
    if (isLoading || !isAuthenticated || !alertId) return;
    pendingAlertId.current = null;
    router.push(`/alerts/${alertId}` as Href);
  }, [isAuthenticated, isLoading]);

  useEffect(() => {
    if (!userId) return;
    void reconcileRecallPushNotifications().catch(() => undefined);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void reconcileRecallPushNotifications().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [userId]);

  return null;
}
