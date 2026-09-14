import { useLocalSearchParams } from 'expo-router';

import { AlertDetailScreen } from '@/src/features/alerts/AlertDetailScreen';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function AlertDetailRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const routeId = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = routeId && uuidPattern.test(routeId) ? routeId : null;

  return <AlertDetailScreen id={id} />;
}
