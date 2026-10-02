const expoPushTokenPattern = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,200}\]$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && expoPushTokenPattern.test(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

export type SendRecallNotificationsRequest = {
  alertIds: readonly string[] | null;
  batchSize: number;
  checkReceipts: boolean;
};

export function parseSendRecallNotificationsRequest(
  value: unknown,
): SendRecallNotificationsRequest {
  if (value === null || value === undefined) {
    return { alertIds: null, batchSize: 25, checkReceipts: true };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be an object.');
  }

  const input = value as Record<string, unknown>;
  const allowed = new Set(['alertIds', 'batchSize', 'checkReceipts']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error('Request body contains unsupported fields.');
  }

  let alertIds: readonly string[] | null = null;
  if (input.alertIds !== undefined && input.alertIds !== null) {
    if (
      !Array.isArray(input.alertIds) ||
      input.alertIds.length === 0 ||
      input.alertIds.length > 50 ||
      input.alertIds.some((id) => !isUuid(id))
    ) {
      throw new Error('alertIds must contain between 1 and 50 UUIDs.');
    }
    alertIds = [...new Set(input.alertIds as string[])];
  }

  const batchSize = input.batchSize ?? 25;
  if (!Number.isInteger(batchSize) || Number(batchSize) < 1 || Number(batchSize) > 50) {
    throw new Error('batchSize must be an integer between 1 and 50.');
  }

  const checkReceipts = input.checkReceipts ?? true;
  if (typeof checkReceipts !== 'boolean') {
    throw new Error('checkReceipts must be a boolean.');
  }

  return { alertIds, batchSize: Number(batchSize), checkReceipts };
}
