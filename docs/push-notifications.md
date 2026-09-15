# Recall push notifications

Phase 11 adds best-effort operating-system notification delivery for newly created, confirmed
recall alerts. The database alert remains the source of truth. A provider, network, credential, or
device failure never deletes, hides, or rolls back the alert.

## Architecture

```text
confirmed recall match
  -> transactional alerts insert
  -> insert-only private push eligibility queue
  -> bounded delivery claim per enabled device
  -> Expo Push Service ticket
  -> delayed Expo receipt check
  -> FCM v1 / APNs provider handoff
  -> Android/iOS notification
  -> protected /alerts/[alertId] route on tap
```

`process-recall-matches` runs the push worker only after matching and alert persistence have
completed. It catches push failures and still returns the successful matching result. The separate
`send-recall-notifications` Edge Function provides the same bounded worker behind a server-only
administrative key for retries and receipt checks. Neither endpoint is called from the mobile app.
Both paths require the server-only `RECALL_PUSH_DELIVERY_ENABLED` switch to equal `true`; leaving it
unset keeps queued work intact while making an accidental first remote send impossible.

The migration adds an `AFTER INSERT` trigger to `alerts`; it does not scan or backfill existing
rows. Only alerts inserted after Phase 11 and whose current match is `confirmed` enter
`private.push_alert_queue`. This prevents a deployment-time flood of historical unread alerts,
including the existing Thule verification alert.

Each device also has a stable `enabled_at` boundary. A device is eligible only when it was already
enabled when the alert entered the queue. Registering or re-enabling notifications cannot turn an
older queued alert into a surprise push; an ordinary reconciliation of an already-enabled device
keeps its original boundary.

The service-role-only `queue_recall_push_alerts` RPC is the sole exception for a deliberate,
bounded replay. It accepts at most 50 explicit alert UUIDs and revalidates that each alert's match
is currently confirmed. Automatic matching never calls it because automatic delivery uses an
untargeted claim. This supports the controlled first-push test without broad historical backfill.

## Expo and native configuration

Recall uses `expo-notifications ~57.0.18` with Expo SDK 57 and the Expo Push Service. Android remote
push is tested only in the custom development client, not Expo Go. The config plugin sets the
default Android channel to `recall-alerts`; runtime initialization creates that channel with high
importance, ordinary vibration, and no custom sound, alarm, or full-screen behavior.

The EAS identity is `@silversys/recall`, project ID
`e7b1d5e3-952c-4e6a-9222-9129fb6f3d56`, and Android application ID
`com.silversys.recall`. Token acquisition resolves the project ID from
`Constants.expoConfig?.extra?.eas?.projectId` and then `Constants.easConfig?.projectId`; it fails
closed if neither is present.

The local Firebase client configuration is `./google-services.json`. It is ignored by Git. Remote
EAS builds receive the same file from the project-scoped, secret FILE variable
`GOOGLE_SERVICES_JSON`, assigned to the development, preview, and production environments.
`app.config.js` selects `process.env.GOOGLE_SERVICES_JSON ?? './google-services.json'`. The file is
never exposed through an `EXPO_PUBLIC_*` variable or committed.

Any change to `expo-notifications`, its config plugin, Android Firebase configuration, or iOS push
entitlements requires a new native build:

```bash
npx eas build --profile development --platform android
```

Local native builds use:

```bash
npx expo run:android --device
```

## Permission and registration UX

Recall never requests notification permission at startup. An authenticated user explicitly taps
**Enable notifications** in Settings. The app then:

1. creates the Android `recall-alerts` channel;
2. reads the existing OS permission and requests it only when needed;
3. obtains an Expo push token with the verified EAS project ID;
4. calls `register_push_device` with that token and the native platform;
5. records the local device preference only after server registration succeeds.

When the local preference is enabled, authenticated app startup and foreground activation
reconcile the token idempotently without showing another permission prompt. This covers ordinary
token refresh, reinstall, and account switching. Settings can disable the registration; operating
system permission remains under system settings.

Sign-out attempts server unregistration before destroying the Supabase session. It never blocks
logout permanently: if the network is unavailable, it also asks the native notification module to
unregister locally on best effort. The unavoidable offline limitation is that the stale server row
may remain enabled until Expo reports `DeviceNotRegistered` or a later enabled-account
registration reassigns the token. Notification text is deliberately generic to limit lock-screen
exposure during that window.

## Token storage and ownership

Raw Expo tokens live only in `private.push_devices`. That table, the eligibility queue, and
delivery records have RLS enabled and no direct privileges for `PUBLIC`, `anon`, `authenticated`,
or `service_role`. Fixed-signature `SECURITY DEFINER` RPCs with an empty search path are the only
access path:

- authenticated users may call `register_push_device` and `unregister_push_device`;
- those functions derive ownership exclusively from `auth.uid()`;
- only `service_role` may claim delivery/receipt work and record provider results.
- only `service_role` may explicitly queue a bounded list of older confirmed alerts.

The token column is globally unique. Registering the same token twice updates one row. Registering
it after signing into another account atomically reassigns it and cancels pending work belonging to
the previous account. Every delivery claim also rechecks that device and alert owners still match,
the device is enabled, and the match is still confirmed. Possession of an alert ID or notification
payload never grants data access; the detail repository fetches through the existing alert RLS.

## Payload privacy and navigation

Every notification uses the same lock-screen-safe content:

- Title: `Product recall alert`
- Body: `A product in your Recall inventory may be affected by an official safety recall.`
- Data: `{ "alertId": "<uuid>" }`

No email, product name, serial/lot identifier, OCR text, raw recall payload, matching evidence, or
provider metadata is sent. The app accepts only a UUID `alertId`. Foreground notifications may show
a banner/list through the SDK 57 handler but never create another in-app alert. Foreground,
background, and cold-start taps are observed; navigation waits for authentication and opens the
protected `/alerts/[id]` route, which performs its normal RLS-protected query.

## Delivery state, idempotency, and retries

`private.push_deliveries` has a unique `(alert_id, push_device_id)` constraint. A bounded claim
creates at most one logical row per alert/device and leases at most 50 rows using
`FOR UPDATE SKIP LOCKED`. Recall uses 25 by default, far below Expo's documented 100-message request
batch and 600-notification/second project limit.

Statuses distinguish provider stages:

- `pending` / `processing`: not yet accepted by Expo;
- `accepted`: Expo returned a successful push ticket;
- `receipt_checking` / `receipt_ok`: delayed receipt processing, where `receipt_ok` means Expo
  successfully handed the message to FCM/APNs, not that the handset displayed it;
- `failed`, `invalid_device`, or `cancelled`: terminal states.

Transient network, timeout, HTTP 429/5xx, and `MessageRateExceeded` results return to `pending` with
backoff. A delivery has at most three send attempts. Permanent ticket errors fail immediately.
`DeviceNotRegistered` from either a ticket or receipt disables the device registration. Receipt
checks begin after 15 minutes and are also capped at three attempts. Only normalized error codes
and ticket IDs are stored; raw provider responses are not retained.

The Expo client uses a ten-second timeout. It does not immediately replay an ambiguous send HTTP
request; retry state is persisted and reclaimed later, reducing intentional duplicates while
acknowledging that exactly-once display cannot be guaranteed by remote push systems.

## Provider security and deployment

Expo enhanced push security was inspected for project
`e7b1d5e3-952c-4e6a-9222-9129fb6f3d56` and is currently disabled. Therefore no
`EXPO_ACCESS_TOKEN` is configured or sent. If enhanced security is deliberately enabled later, set
its access token only as a Supabase Edge Function secret; never include it in the app.

Set a high-entropy administrative key through secure operator input, apply the migration, and
deploy both server functions:

```bash
npx supabase secrets set RECALL_PUSH_DELIVERY_KEY
npx supabase secrets set RECALL_PUSH_DELIVERY_ENABLED=false
npx supabase db push
npx supabase functions deploy send-recall-notifications --no-verify-jwt
npx supabase functions deploy process-recall-matches --no-verify-jwt
```

Do not put secret values in shell history, documentation, mobile configuration, or Git.
Keep delivery disabled through migration, deployment, and device registration. Change the switch
to `true` only after the required first-push review and explicit approval.

## Verification and first-send approval

Automated verification:

```bash
npm run check
npm run test:database
npx expo export --platform android
npx expo export --platform ios
npx expo export --platform web
npx expo-doctor
```

The pgTAP suite requires Docker Desktop or Podman for the local Supabase stack. It verifies table
isolation, RPC privileges, ownership/reassignment, duplicate registration, historical-alert
exclusion, confirmed-only eligibility, cross-user delivery isolation, delivery uniqueness,
bounded retries, invalid-device disabling, and receipts.

For the first Android E2E, enable notifications in Settings and confirm exactly one private device
registration. Use only the already verified CPSC RecallID `8877` / GTIN `091021037090` deterministic
path or a deliberately targeted delivery of its real alert. Before invoking the push worker or
creating one new eligible confirmed alert, report the registered-device count, target alert ID,
exact expected push count, provider, cost, and generic payload, then obtain explicit user approval.
Do not send a remote test notification before that approval.

## iOS readiness

The registration, payload, handler, and tap-navigation code supports iOS. Real iOS build and push
verification remain blocked until a deliberate bundle identifier, Apple signing, and APNs
credentials are configured for the EAS project. Android verification does not depend on those
credentials.
