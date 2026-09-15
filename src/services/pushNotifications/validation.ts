const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function notificationAlertId(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const alertId = (data as Record<string, unknown>).alertId;
  return typeof alertId === 'string' && uuidPattern.test(alertId) ? alertId : null;
}
