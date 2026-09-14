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
  → deterministic_v1 evidence evaluation
  → confirmed / rejected / needs-review
  → measured Nemotron comparison for difficult cases
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
5. **Deterministic baseline:** Pure server-safe logic evaluates exact identifiers, safe ranges, and
   transparent supporting text for every recall scope, then returns confirmed, rejected, or
   needs-review.
6. **Nemotron comparison:** A server-only Nebius adapter can evaluate the same evidence against the
   common contract. Phase 9 measured it only in a read-only benchmark; it cannot create or
   independently assert a recall.
7. **Structured match result:** Deterministic and future model output share a versioned contract
   with heuristic confidence, matched/conflicting identifiers, evidence, rationale, and explicit
   uncertainty.
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
- `supabase/functions/_shared/matching/`: pure common contract, normalization, candidate retrieval,
  per-scope evidence, deterministic matching, multi-scope aggregation, the versioned Nemotron
  prompt/schema, and local model-output validation
- `supabase/functions/_shared/nebius/`: server-only configuration, redacted errors, and the
  standards-based Token Factory HTTP client
- Future `supabase/functions/`: authenticated production orchestration; Phase 9 adds only shared
  Nebius modules and a local benchmark, not a callable endpoint
- `benchmarks/recall-matching/`: offline CPSC-backed dataset, validator, metrics, and runner; this
  layer never owns production matching decisions or persistence

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
- Matching confidence is a heuristic evidence-strength score, never a calibrated recall
  probability.
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
transient scan evidence. Phase 7 adds the first recall-source integration: a server-only CPSC Edge
Function retrieves date-bounded JSON records, preserves complete official payloads, and writes only
conservative notice/scope evidence. Phase 8 adds pure `deterministic_v1` matching and a 30-case
offline benchmark. Phase 9 adds one real Nebius/NVIDIA evaluation on that frozen evidence plus a
strict server-only model boundary. Nemotron improved strict recall but introduced four false
positives and four structured-output failures, so production orchestration remains deferred.
Neither phase adds an endpoint, database writes, migration, alerts, or notifications.

The detailed table relationships and policy matrix are in [database.md](database.md).
