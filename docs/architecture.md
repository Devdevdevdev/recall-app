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
   alert state. Storage is reserved for product images only where necessary.
9. **Alerts:** A verified source-backed match generates a clear user notification and links to the
   official recall notice.

## Planned code boundaries

- `app/`: thin Expo Router route modules and navigation layouts
- `src/features/`: product-oriented screens, hooks, and feature logic
- `src/components/`: small reusable presentation components
- `src/design/`: design tokens and navigation theme
- Future `src/domain/`: framework-independent entities and matching types
- Future `src/data/`: typed repositories and Supabase data access
- Future `src/services/`: client-side adapters for backend endpoints and device capabilities
- Future `supabase/functions/`: authenticated server-side orchestration and Nebius calls

## Trust and security model

- A recall exists only when supplied by a trusted, traceable recall source.
- Every notice and match retains provenance and a link to the official source.
- AI responses are untrusted input and must pass schema validation before storage or display.
- Low-confidence or contradictory matches require user review and must not trigger definitive
  safety claims.
- `NEBIUS_API_KEY` and Supabase service-role credentials are server-only secrets.
- The mobile app may receive only public Supabase configuration protected by Row Level Security.
- Authentication, authorization, input validation, rate limits, audit logs, and retention controls
  will be designed before backend integration.

## Phase 1 scope

Phase 1 contains only the Expo application foundation, navigation shell, reusable design tokens,
placeholder states, documentation, and quality tooling. It deliberately contains no Supabase,
Nebius, NVIDIA, ML Kit, barcode, notification, or recall-source integration.
