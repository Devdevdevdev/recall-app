# Authentication

## Scope

Phase 3 implements email/password authentication through Supabase Auth. Password recovery,
magic links, OAuth, and social providers are intentionally deferred.

## Mobile architecture

`src/providers/AuthProvider.tsx` is the single session boundary for the application. It restores the
existing session through the one shared Supabase client, listens for future auth-state changes, and
unsubscribes when the provider is removed. It exposes a small app-level API to the UI: a
credential-free session/user summary, loading and authentication state, and sign-in, sign-up, and
sign-out actions.

Supabase calls remain in `src/features/auth/services/authService.ts`; screens do not import the
client. The provider never exposes access tokens, refresh tokens, or raw Supabase session objects
to feature screens.

The client persists the Supabase session through Expo-compatible storage configured in
`src/services/supabase/client.ts`. Passwords and tokens are never manually stored or logged.

## Routes

The root Expo Router stack uses protected route groups after session restoration completes:

- `app/(auth)/` contains the public sign-in and sign-up flow, available only while signed out.
- `app/(tabs)/` remains the authenticated application and is unavailable while signed out.

The root shows a loading state while Supabase restores a session, avoiding a visible route flash.
Expo Router then redirects a protected deep link to the available auth route automatically.

## Sign-up behavior

`signUp` handles both Supabase configurations. When email confirmation is disabled, Supabase
returns a session and the protected application appears. When confirmation is enabled, Supabase
returns no session and Recall shows a confirmation instruction only after Supabase accepted the
request. The user must then confirm their email and sign in.

## Configuration and security

The Expo app reads only `EXPO_PUBLIC_SUPABASE_URL` and
`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from the ignored `.env.local`. These values are public
client configuration, not privileged credentials. If either is missing or invalid, Recall shows a
controlled configuration message without printing a value or crashing.

Never add a Supabase secret/service-role key or `NEBIUS_API_KEY` to this client. PostgreSQL Row
Level Security uses `auth.uid()` to restrict owned rows to their authenticated owner; privileged
writes remain server-side work for a later phase.

## Supabase dashboard checklist

1. In **Authentication → Providers**, enable Email and configure the desired email-confirmation
   setting.
2. If confirmation is enabled, configure valid redirect URLs and an email template appropriate for
   the Recall app.
3. Keep the database migration's Row Level Security policies enabled. Do not use a service-role
   credential in the mobile app.

## Manual test plan

1. **Open app while signed out:** the sign-in screen appears.
2. **Attempt invalid credentials:** a safe user-facing error appears without technical details.
3. **Create a new account:** the app either enters an authenticated session or shows the email
   confirmation instruction, depending on the Supabase dashboard configuration.
4. **Sign in with a valid account:** the authenticated tabs appear.
5. **Close and reopen the application:** the session persists and the authenticated tabs return.
6. **Sign out:** the app returns to the auth flow and tabs are no longer accessible.
7. **Navigate directly to an authenticated route while signed out:** Expo Router redirects to the
   auth flow.
8. **Remove Supabase environment configuration in a local development copy:** a controlled
   configuration message appears instead of an application crash.
