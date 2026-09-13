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
- `src/data/`: repository interfaces and the `SupabaseOwnedProductsRepository`, which keeps query
  syntax out of UI code and maps database records to domain objects
- `src/services/supabase/`: validated public configuration and the one optional mobile client
- `src/providers/AuthProvider.tsx`: session restoration, auth-state subscription, and app-level
  authentication state
- `src/features/auth/`: authentication UI and its typed Supabase Auth service boundary
- Product screens use the inventory repository only; it derives a create operation's owner from the
  authenticated Supabase user and relies on RLS for every operation.
- `src/domain/barcode.ts`: framework-independent GTIN normalization/checksum validation and scanned
  barcode model, including the distinction between valid GTINs, transient non-GTIN Code 128 product
  codes, and invalid/unsupported payloads; `src/features/scan/` adapts Expo camera events into it
- `src/features/products/purchaseDate.ts`: timezone-safe local calendar conversion for PostgreSQL
  date-only values; platform-specific purchase-date fields keep the native picker out of web bundles
- `src/domain/productLabel.ts`: pure explicit-label identifier parsing and a transient evidence type
  that can later combine barcode and OCR observations
- `src/services/ocr/`: platform-specific ML Kit adapter, normalized OCR result contract, web
  fallback, and temporary-image cleanup boundary
- Future services under `src/services/`: adapters for backend endpoints and device capabilities
- Future `supabase/functions/`: authenticated server-side orchestration and Nebius calls

No screen imports or queries Supabase directly. Authentication screens use their typed provider,
whose service boundary owns Supabase Auth calls. Product feature code depends on the inventory
repository, whose concrete adapter translates database rows and domain types. The product form
normalizes blank optional text to `null`; it never accepts an owner ID. Manual entries use the
stable `manual` identification method, with no AI confidence value.

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
password authentication, persisted-session restoration, protected routes, and sign-out. Phase 5
adds local barcode acquisition only: the Scan screen uses Expo Camera, confirms a validated barcode,
then reuses the existing product form and repository. Phase 6 adds still-image Latin OCR through a
native development build. The image exists only temporarily in app cache, recognition stays on
device, and the user reviews conservative explicit-label candidates before the same form. OCR is
perception only; it does not infer brand, product identity, safety, or recall status. Phase 6.1
adds native date-only purchase-date selection and preserves non-GTIN Code 128 values only as
transient scan evidence. Ingestion jobs,
Edge Functions, Nebius/NVIDIA calls, notifications, and recall-source integration remain future
work.

The detailed table relationships and policy matrix are in [database.md](database.md).
