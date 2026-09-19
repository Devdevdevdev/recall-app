import type { PushNotificationStatus } from './types';

export type NotificationEnableStage =
  | 'configureAndroidChannel'
  | 'getPermissionsAsync'
  | 'requestPermissionsAsync'
  | 'projectIdResolution'
  | 'getExpoPushTokenAsync'
  | 'register_push_device'
  | 'localPreferencePersistence';

export type NotificationPermissionSnapshot = {
  granted: boolean;
  canAskAgain: boolean;
  status: string;
};

export type NotificationDiagnostic = {
  stage: NotificationEnableStage;
  errorName: string;
  message: string;
  code?: string;
  platform: string;
  projectIdPresent: boolean;
  permissionStatus?: string;
};

type EnableDependencies = {
  platform: string;
  configureAndroidChannel: () => Promise<void>;
  getPermissions: () => Promise<NotificationPermissionSnapshot>;
  requestPermissions: () => Promise<NotificationPermissionSnapshot>;
  resolveProjectId: () => string | null;
  getExpoPushToken: (projectId: string) => Promise<string>;
  registerPushDevice: (token: string, platform: string) => Promise<void>;
  persistPreference: (enabled: boolean) => void | Promise<void>;
  reportDiagnostic?: (diagnostic: NotificationDiagnostic) => void;
};

type DisableDependencies = {
  persistPreference: (enabled: boolean) => void | Promise<void>;
  getPermissions: () => Promise<NotificationPermissionSnapshot>;
  getExpoPushToken: () => Promise<string>;
  unregisterPushDevice: (token: string) => Promise<void>;
  unregisterNative: () => Promise<void>;
};

type DiagnosticContext = {
  platform: string;
  projectIdPresent: boolean;
  permissionStatus?: string;
};

class NotificationStageError extends Error {
  readonly stage: NotificationEnableStage;
  readonly originalError: unknown;

  constructor(stage: NotificationEnableStage, originalError: unknown) {
    super(`Notification enable failed during ${stage}.`);
    this.name = 'NotificationStageError';
    this.stage = stage;
    this.originalError = originalError;
  }
}

const pushTokenPattern = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]+\]$/u;
const sensitivePatterns = [
  { pattern: /Expo(?:nent)?PushToken\[[^\]]+\]/giu, replacement: '[REDACTED_PUSH_TOKEN]' },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
    replacement: '[REDACTED_JWT]',
  },
  {
    pattern: /\b(?:gh[pousr]|sbp|sk)_[A-Za-z0-9_-]{16,}\b/gu,
    replacement: '[REDACTED_CREDENTIAL]',
  },
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/gu, replacement: '[REDACTED_API_KEY]' },
  { pattern: /\bBearer\s+[^\s,;]+/giu, replacement: 'Bearer [REDACTED]' },
  {
    pattern: /([?&](?:access_?token|api_?key|key|token)=)[^&#\s]+/giu,
    replacement: '$1[REDACTED]',
  },
  {
    pattern: /\b(access_?token|api_?key|key|token)=([^\s,;&]+)/giu,
    replacement: '$1=[REDACTED]',
  },
] as const;

export function sanitizeNotificationDiagnostic(value: unknown): string {
  let sanitized = value instanceof Error ? value.message : String(value ?? 'Unknown error');
  for (const { pattern, replacement } of sensitivePatterns) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized.slice(0, 240);
}

function errorProperty(error: unknown, property: 'code' | 'message' | 'name'): unknown {
  if (!error || typeof error !== 'object') return undefined;
  return Reflect.get(error, property);
}

function safeErrorName(error: unknown): string {
  const value = errorProperty(error, 'name');
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value)
    ? value
    : 'Error';
}

function safeErrorCode(error: unknown): string | undefined {
  const value = errorProperty(error, 'code');
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(value) ? value : undefined;
}

function originalError(error: unknown): unknown {
  return error instanceof NotificationStageError ? error.originalError : error;
}

function notificationDiagnostic(
  error: unknown,
  context: DiagnosticContext,
): NotificationDiagnostic {
  const original = originalError(error);
  return {
    stage: error instanceof NotificationStageError ? error.stage : 'localPreferencePersistence',
    errorName: safeErrorName(original),
    message: sanitizeNotificationDiagnostic(errorProperty(original, 'message') ?? original),
    ...(safeErrorCode(original) ? { code: safeErrorCode(original) } : {}),
    platform: context.platform,
    projectIdPresent: context.projectIdPresent,
    ...(context.permissionStatus ? { permissionStatus: context.permissionStatus } : {}),
  };
}

function looksLikeNetworkFailure(error: unknown): boolean {
  const original = originalError(error);
  const code = safeErrorCode(original)?.toLowerCase() ?? '';
  const message = sanitizeNotificationDiagnostic(errorProperty(original, 'message') ?? original);
  return (
    ['aborterror', 'networkerror', 'timeout', 'timed_out', 'fetch_error'].includes(code) ||
    /network request failed|failed to fetch|fetch failed|network error|timed? out|timeout/iu.test(
      message,
    )
  );
}

function errorStatus(error: unknown): PushNotificationStatus {
  if (looksLikeNetworkFailure(error)) {
    return {
      status: 'error',
      message: 'Recall could not reach the notification service. Try again.',
    };
  }

  if (error instanceof NotificationStageError) {
    if (error.stage === 'getPermissionsAsync' || error.stage === 'requestPermissionsAsync') {
      return {
        status: 'error',
        message: 'Recall could not check notification permission. Try again.',
      };
    }
    if (error.stage === 'localPreferencePersistence') {
      return {
        status: 'error',
        message: 'Recall could not save notification settings on this device.',
      };
    }
  }

  return {
    status: 'error',
    message: 'Recall could not register this device for notifications.',
  };
}

async function atStage<T>(stage: NotificationEnableStage, operation: () => T | Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    throw new NotificationStageError(stage, error);
  }
}

export async function runNotificationEnableFlow(
  dependencies: EnableDependencies,
): Promise<PushNotificationStatus> {
  const context: DiagnosticContext = {
    platform: dependencies.platform,
    projectIdPresent: false,
  };

  try {
    await atStage('configureAndroidChannel', dependencies.configureAndroidChannel);
    let permission = await atStage('getPermissionsAsync', dependencies.getPermissions);
    context.permissionStatus = permission.status;

    if (!permission.granted) {
      permission = await atStage('requestPermissionsAsync', dependencies.requestPermissions);
      context.permissionStatus = permission.status;
    }

    if (!permission.granted) {
      dependencies.reportDiagnostic?.({
        stage: 'requestPermissionsAsync',
        errorName: 'PermissionDenied',
        message: 'Notification permission was not granted.',
        platform: context.platform,
        projectIdPresent: false,
        permissionStatus: permission.status,
      });
      return {
        status: 'denied',
        canAskAgain: permission.canAskAgain,
        message: 'Notification permission is not enabled.',
      };
    }

    const projectId = await atStage('projectIdResolution', () => {
      const value = dependencies.resolveProjectId();
      if (typeof value !== 'string' || value.length === 0) {
        context.projectIdPresent = false;
        const error = new Error('The EAS project ID is unavailable.');
        error.name = 'MissingProjectIdError';
        throw error;
      }
      context.projectIdPresent = true;
      return value;
    });

    const token = await atStage('getExpoPushTokenAsync', () =>
      dependencies.getExpoPushToken(projectId),
    );
    if (!pushTokenPattern.test(token)) {
      const error = new Error('Expo returned an invalid push token format.');
      error.name = 'InvalidExpoPushTokenError';
      throw new NotificationStageError('getExpoPushTokenAsync', error);
    }

    await atStage('register_push_device', () =>
      dependencies.registerPushDevice(token, dependencies.platform),
    );
    await atStage('localPreferencePersistence', () => dependencies.persistPreference(true));
    return { status: 'enabled', message: 'Notifications enabled' };
  } catch (error) {
    try {
      dependencies.reportDiagnostic?.(notificationDiagnostic(error, context));
    } catch {
      // Diagnostics must never change notification behavior.
    }
    return errorStatus(error);
  }
}

export async function runNotificationDisableFlow(
  dependencies: DisableDependencies,
): Promise<PushNotificationStatus> {
  await dependencies.persistPreference(false);
  try {
    const permission = await dependencies.getPermissions();
    if (permission.granted) {
      await dependencies.unregisterPushDevice(await dependencies.getExpoPushToken());
    }
    await dependencies.unregisterNative().catch(() => undefined);
    return { status: 'disabled', message: 'Notifications are off for this device.' };
  } catch {
    await dependencies.unregisterNative().catch(() => undefined);
    return {
      status: 'error',
      message:
        'Notifications are disabled in Recall, but the server could not be reached. Retry before signing out.',
    };
  }
}
