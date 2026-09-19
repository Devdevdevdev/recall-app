import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  runNotificationDisableFlow,
  runNotificationEnableFlow,
  sanitizeNotificationDiagnostic,
} from '../src/services/pushNotifications/registrationFlow.ts';

const validToken = 'ExpoPushToken[phase14-device-token]';

function dependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    platform: 'android',
    async configureAndroidChannel() {
      calls.push('configureAndroidChannel');
    },
    async getPermissions() {
      calls.push('getPermissionsAsync');
      return { granted: true, canAskAgain: true, status: 'granted' };
    },
    async requestPermissions() {
      calls.push('requestPermissionsAsync');
      return { granted: true, canAskAgain: true, status: 'granted' };
    },
    resolveProjectId() {
      calls.push('projectIdResolution');
      return 'e7b1d5e3-952c-4e6a-9222-9129fb6f3d56';
    },
    async getExpoPushToken() {
      calls.push('getExpoPushTokenAsync');
      return validToken;
    },
    async registerPushDevice() {
      calls.push('register_push_device');
    },
    persistPreference(enabled) {
      calls.push(`localPreferencePersistence:${enabled}`);
    },
    reportDiagnostic(diagnostic) {
      calls.push({ diagnostic });
    },
    ...overrides,
  };
}

test('permission denial is actionable and stops before token registration', async () => {
  const deps = dependencies({
    async getPermissions() {
      deps.calls.push('getPermissionsAsync');
      return { granted: false, canAskAgain: true, status: 'undetermined' };
    },
    async requestPermissions() {
      deps.calls.push('requestPermissionsAsync');
      return { granted: false, canAskAgain: false, status: 'denied' };
    },
  });
  assert.deepEqual(await runNotificationEnableFlow(deps), {
    status: 'denied',
    canAskAgain: false,
    message: 'Notification permission is not enabled.',
  });
  assert.equal(deps.calls.includes('getExpoPushTokenAsync'), false);
  assert.equal(deps.calls.includes('register_push_device'), false);
});

test('missing project ID is identified without attempting token retrieval', async () => {
  const deps = dependencies({
    resolveProjectId() {
      deps.calls.push('projectIdResolution');
      return null;
    },
  });
  assert.deepEqual(await runNotificationEnableFlow(deps), {
    status: 'error',
    message: 'Recall could not register this device for notifications.',
  });
  assert.equal(deps.calls.includes('getExpoPushTokenAsync'), false);
  const diagnostic = deps.calls.find((call) => typeof call === 'object').diagnostic;
  assert.equal(diagnostic.stage, 'projectIdResolution');
  assert.equal(diagnostic.projectIdPresent, false);
});

test('Expo push-token failure is categorized and diagnostics redact secrets', async () => {
  const deps = dependencies({
    async getExpoPushToken() {
      deps.calls.push('getExpoPushTokenAsync');
      throw new Error(
        'Provider rejected ExpoPushToken[private-token] with eyJabcdefghijk.eyJabcdefghijk.signaturevalue',
      );
    },
  });
  assert.deepEqual(await runNotificationEnableFlow(deps), {
    status: 'error',
    message: 'Recall could not register this device for notifications.',
  });
  const diagnostic = deps.calls.find((call) => typeof call === 'object').diagnostic;
  assert.equal(diagnostic.stage, 'getExpoPushTokenAsync');
  assert.equal(diagnostic.message.includes('private-token'), false);
  assert.equal(diagnostic.message.includes('eyJ'), false);
});

test('Supabase registration failure never enables the local preference', async () => {
  const deps = dependencies({
    async registerPushDevice() {
      deps.calls.push('register_push_device');
      const error = new Error('RPC rejected registration');
      error.name = 'PushDeviceRegistrationError';
      error.code = '42501';
      throw error;
    },
  });
  assert.deepEqual(await runNotificationEnableFlow(deps), {
    status: 'error',
    message: 'Recall could not register this device for notifications.',
  });
  assert.equal(deps.calls.includes('localPreferencePersistence:true'), false);
  const diagnostic = deps.calls.find((call) => typeof call === 'object').diagnostic;
  assert.equal(diagnostic.stage, 'register_push_device');
  assert.equal(diagnostic.code, '42501');
});

test('successful enable performs every stage before persisting the preference', async () => {
  const deps = dependencies();
  assert.deepEqual(await runNotificationEnableFlow(deps), {
    status: 'enabled',
    message: 'Notifications enabled',
  });
  assert.deepEqual(deps.calls, [
    'configureAndroidChannel',
    'getPermissionsAsync',
    'projectIdResolution',
    'getExpoPushTokenAsync',
    'register_push_device',
    'localPreferencePersistence:true',
  ]);
});

test('diagnostic sanitizer removes push tokens, JWTs, API keys, and bearer values', () => {
  const sanitized = sanitizeNotificationDiagnostic(
    'ExpoPushToken[private-token] eyJabcdefghijk.eyJabcdefghijk.signaturevalue ' +
      'sbp_abcdefghijklmnopqrstuvwxyz Bearer secret-value token=hidden-value',
  );
  for (const secret of ['private-token', 'eyJ', 'sbp_', 'secret-value', 'hidden-value']) {
    assert.equal(sanitized.includes(secret), false);
  }
});

test('successful disable clears preference, unregisters the server token, and unregisters native notifications', async () => {
  const calls = [];
  assert.deepEqual(
    await runNotificationDisableFlow({
      persistPreference(enabled) {
        calls.push(`localPreferencePersistence:${enabled}`);
      },
      async getPermissions() {
        calls.push('getPermissionsAsync');
        return { granted: true, canAskAgain: true, status: 'granted' };
      },
      async getExpoPushToken() {
        calls.push('getExpoPushTokenAsync');
        return validToken;
      },
      async unregisterPushDevice() {
        calls.push('unregister_push_device');
      },
      async unregisterNative() {
        calls.push('unregisterForNotificationsAsync');
      },
    }),
    { status: 'disabled', message: 'Notifications are off for this device.' },
  );
  assert.deepEqual(calls, [
    'localPreferencePersistence:false',
    'getPermissionsAsync',
    'getExpoPushTokenAsync',
    'unregister_push_device',
    'unregisterForNotificationsAsync',
  ]);
});

test('native notification setup retains the Android HIGH channel', async () => {
  const nativeSource = await readFile(
    new URL('../src/services/pushNotifications/pushNotifications.native.ts', import.meta.url),
    'utf8',
  );
  assert.match(nativeSource, /recallNotificationChannelId = 'recall-alerts'/u);
  assert.match(nativeSource, /importance: Notifications\.AndroidImportance\.HIGH/u);
});
