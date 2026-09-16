# Recall architecture

## Goals

Recall must be straightforward enough for a hackathon demo while leaving clean boundaries for
secure commercial development. The mobile client owns capture and confirmation UX. Trusted data
retrieval, privileged credentials, AI calls, matching decisions, and persistence belong on the
server.

## End-to-end flow

```text
Mobile
  → on-device scan / OCR
  → secure backend
  → trusted recall candidate retrieval
  → deterministic_v1 evidence evaluation
  → confirmed / rejected / needs-review
  → guarded Nemotron evaluation only for deterministic abstentions
  → structured match result
  → Supabase
  → alerts
  → private push queue and delivery claim
  → Expo Push Service
  → protected alert detail on notification tap
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
6. **Guarded Nemotron fallback:** A server-only Nebius adapter can evaluate only deterministic
   abstentions. Phase 9.1 accepts an AI confirmation only when a local verifier can reconstruct an
   exact, unambiguous identifier comparison from controlled owned-product and authoritative-source
   fields. AI rejection, unverifiable evidence, and technical failure remain `needs_review`.
7. **Structured match result:** Deterministic and model-assisted output share a versioned contract
   with heuristic confidence, matched/conflicting identifiers, evidence, rationale, and explicit
   uncertainty.
8. **Supabase:** PostgreSQL stores users, inventory, source records, candidate evaluations, and
   alert state. The Phase 2 schema and RLS policies are defined in SQL migrations. Storage is
   reserved for product images only where necessary.
9. **Alerts:** A verified source-backed confirmation creates an in-app alert and links to the
   official recall notice.
10. **Push delivery:** Future confirmed alerts enter a private insert-only eligibility queue. A
    bounded server worker sends a generic notification through Expo Push Service; delivery failure
    never changes the database alert.

## Code boundaries

- `app/`: thin Expo Router route modules and navigation layouts
- `src/features/`: product-oriented screens, hooks, and feature logic
- `src/components/`: small reusable presentation components
- `src/design/`: design tokens and navigation theme
- `src/domain/`: framework-independent entities and matching types
- `src/data/`: inventory and alerts repository interfaces and Supabase adapters, which keep query
  syntax out of UI code and map database records to consumer-safe domain objects
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
- `src/services/pushNotifications/`: platform-specific permission, Expo token registration, local
  preference, and payload validation; web remains an explicit unsupported fallback
- `src/providers/PushNotificationCoordinator*`: authenticated token reconciliation and protected
  foreground/background/cold-start tap routing
- `supabase/functions/_shared/matching/`: pure common contract, normalization, candidate retrieval,
  per-scope evidence, deterministic matching, multi-scope aggregation, the versioned Nemotron
  prompt/schema, strict local output validation, and the guarded evidence verifier
- `supabase/functions/_shared/nebius/`: server-only configuration, redacted errors, and the
  standards-based Token Factory HTTP client
- `supabase/functions/_shared/recallMatching/`: authoritative evidence projection, canonical
  fingerprints, request limits, and the bounded production orchestrator
- `supabase/functions/process-recall-matches/`: secret-protected administrative endpoint and the
  service-role RPC adapter; it is never imported or invoked by the mobile client
- `supabase/functions/_shared/push/`: generic payload construction, Expo HTTPS validation, bounded
  delivery/receipt orchestration, and the service-role database adapter
- `supabase/functions/send-recall-notifications/`: independently invokable privileged push worker
- `supabase/functions/_shared/automation/`: request bounds and orchestration-only sequencing
- `supabase/functions/run-recall-automation/`: dedicated automation authentication, service-role
  state adapter, and calls into the existing Phase 7, 10, and 11 endpoints
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
- Edge Functions use Supabase's platform-provided server credentials only on the server. The
  matching endpoint additionally requires `RECALL_MATCHING_KEY` and accepts POST only.
- RLS limits inventory to its owner and derives match ownership through the matched product.
- Recall sources explicitly approved as authoritative, and their notices and scopes, are readable
  by authenticated users but have no mobile write privileges or policies.
- Match and alert creation are server-controlled. The mobile client can only read its matches and
  update the state fields of its own alerts.
- Push tokens and delivery history are private and have no direct table grants. Authenticated
  registration RPCs derive ownership from `auth.uid()`; delivery RPCs are service-role-only.
- Notification payloads contain only a generic safety message and an opaque alert UUID. Alert
  details remain protected by the existing RLS query.
- Automation controls, run history, watermark, pending affected-recall queue, and singleton lease
  are private and service-RPC mediated. Cron authentication is resolved from Vault by name; the
  dedicated `RECALL_AUTOMATION_KEY` never enters a migration or mobile bundle.
- The `private.recall_matching_leases` table has no grants for `PUBLIC`, `anon`, `authenticated`, or
  `service_role`; only fixed-signature, `SECURITY DEFINER` RPCs mediate claims and finalization.
- Evidence fingerprints are canonical across retrieval timestamps, database row identifiers, and
  scope insertion order. Product/recall revisions are checked both when claiming and finalizing.
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
strict server-only model boundary. Phase 9.1 freezes a locally verified hybrid policy, develops it
on a separate 24-case set, and evaluates it once on a 36-case independent holdout. The hybrid
resolved all four deterministic positive abstentions with zero false positives, while retaining 16
ambiguous/negative cases for review. Phase 10 adds the bounded administrative endpoint, canonical
idempotency/concurrency controls, atomic match/alert persistence, and the RLS-backed mobile alerts
read model. Phase 11 adds explicit notification opt-in, private token storage, Expo Push Service
delivery, receipts, bounded retry, account-switch protection, and protected alert-detail routing.
Phase 12 adds backend-only Cron/Vault orchestration, a watermark and bounded catch-up, a run lease,
a hard autonomous AI cap, and aggregate operational history. It does not alter the matcher or push
provider. Production activation followed separate automation, AI, and push approvals plus a
zero-AI/zero-push verification; the independent controls remain immediate kill switches. See
[autonomous-monitoring.md](autonomous-monitoring.md).

The detailed table relationships and policy matrix are in [database.md](database.md).
