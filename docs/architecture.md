# Recall architecture

## Goals

Recall must be straightforward enough for a hackathon demo while leaving clean boundaries for
secure commercial development. The mobile client owns capture and confirmation UX. Trusted data
retrieval, privileged credentials, AI calls, matching decisions, and persistence belong on the
server.

## Planned end-to-end flow

```text
Mobile
  → on-device scan / OCR
  → secure backend
  → trusted recall candidate retrieval
  → Nebius Token Factory
  → NVIDIA Nemotron matching / reasoning
  → structured match result
  → Supabase
  → alerts
```

1. **Mobile:** The React Native app captures a barcode or image and lets the user confirm product
   identity.
2. **On-device scan/OCR:** Barcode and text recognition produce product identifiers without
   exposing server credentials.
3. **Secure backend:** A Supabase Edge Function authenticates the request, validates input, and
   coordinates downstream work.
4. **Trusted recall candidate retrieval:** Recall adapters query authoritative recall sources and
   preserve the source URL, publisher, retrieval time, and original identifiers.
5. **Nebius Token Factory:** The backend submits only relevant product metadata and trusted recall
   candidates to the hosted model runtime.
6. **NVIDIA Nemotron:** Nemotron normalizes noisy metadata and reasons about model, reference, lot,
   and date-range compatibility. It cannot create or independently assert a recall.
7. **Structured match result:** Model output is validated against a versioned JSON schema with a
   confidence score, matched identifiers, rationale, and explicit uncertainty.
8. **Supabase:** PostgreSQL stores users, inventory, source records, candidate evaluations, and
   alert state. The Phase 2 schema and RLS policies are defined in SQL migrations. Storage is
   reserved for product images only where necessary.
9. **Alerts:** A verified source-backed match generates a clear user notification and links to the
   official recall notice.

## Planned code boundaries

- `app/`: thin Expo Router route modules and navigation layouts
- `src/features/`: product-oriented screens, hooks, and feature logic
- `src/components/`: small reusable presentation components
- `src/design/`: design tokens and navigation theme
- `src/domain/`: framework-independent entities and matching types
- `src/data/`: repository interfaces that keep query syntax out of UI code
- `src/services/supabase/`: validated public configuration and the one optional mobile client
- `src/providers/AuthProvider.tsx`: session restoration, auth-state subscription, and app-level
  authentication state
- `src/features/auth/`: authentication UI and the only mobile feature service that calls Supabase
- Future repository adapters under `src/data/`: Supabase query implementations
- Future services under `src/services/`: adapters for backend endpoints and device capabilities
- Future `supabase/functions/`: authenticated server-side orchestration and Nebius calls

No screen imports or queries Supabase directly. Authentication screens use their typed provider,
whose service boundary owns Supabase Auth calls. Product feature code will depend on repository
interfaces, and concrete adapters will translate between database rows and domain types.

## Trust and security model

- A recall exists only when supplied by a trusted, traceable recall source.
- Every notice and match retains provenance and a link to the official source.
- AI responses are untrusted input and must pass schema validation before storage or display.
- Low-confidence or contradictory matches require user review and must not trigger definitive
  safety claims.
- The mobile app uses only Supabase's publishable key. Row Level Security protects user data.
- `NEBIUS_API_KEY` and Supabase secret credentials are server-only; they must never enter Expo
  client code.
- Future Edge Functions may use Supabase's platform-provided publishable/secret key environment
  configuration. No Edge Function is implemented in Phase 2.
- RLS limits inventory to its owner and derives match ownership through the matched product.
- Recall sources explicitly approved as authoritative, and their notices and scopes, are readable
  by authenticated users but have no mobile write privileges or policies.
- Match and alert creation are server-controlled. The mobile client can only read its matches and
  update the state fields of its own alerts.
- Password recovery, OAuth/social login, input validation at ingestion boundaries, rate limits,
  audit logs, and retention controls remain future work.

## Phase status

Phase 1 established the Expo application shell and Phase 2 added the Supabase client boundary,
database schema, domain types, repository contracts, and RLS foundation. Phase 3 adds real email/
password authentication, persisted-session restoration, protected routes, and sign-out. It
deliberately contains no password recovery, OAuth/social login, ingestion jobs, Edge Functions,
Nebius/NVIDIA calls, ML Kit, barcode, notification, or recall-source integration.

The detailed table relationships and policy matrix are in [database.md](database.md).
