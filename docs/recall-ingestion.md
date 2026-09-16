# Authoritative CPSC recall ingestion

Phase 7 adds Recall's first real recall-data source: the U.S. Consumer Product Safety Commission
(CPSC). Ingestion itself does not match products, create alerts, schedule polling, or call an AI
provider. Phase 10 consumes its normalized output through a separate administrative function.

## Source and query strategy

The server retrieves JSON only from CPSC's official Recall Retrieval REST API:

```text
https://www.saferproducts.gov/RestWebServices/Recall
  ?format=json
  &LastPublishDateStart=YYYY-MM-DD
  &LastPublishDateEnd=YYYY-MM-DD
```

`LastPublishDate` retrieves corrections as well as new notices. Invocations require an inclusive,
valid `YYYY-MM-DD` window of at most 31 days. The retrieval host is `saferproducts.gov`, but stored
notice links must be HTTPS links on `www.cpsc.gov`; the original database host trigger remains in
force.

## Server boundary and security

`supabase/functions/ingest-cpsc-recalls` is a Supabase Edge Function, deliberately not reachable
from the Expo app. It requires a `RECALL_INGESTION_KEY` Edge Function secret in the
`x-recall-ingestion-key` request header and fails closed without it or Supabase server credentials.
It uses server-only secret/service-role credentials for narrowly scoped database RPCs.

`verify_jwt = false` is intentional: this is an administrative service-to-service endpoint protected
by the separate ingestion secret, not a user endpoint. Never put this secret or server credentials
in `EXPO_PUBLIC_*`, app configuration, React Native code, or a committed mobile environment file.

## Normalization and provenance

Every accepted record retains the exact full CPSC response object in `recall_notices.raw_payload`.
`RecallID` is the external ID; only if absent is the namespaced fallback
`recall-number:<RecallNumber>` used. `(source_id, external_id)` remains the idempotency key.

`Title`, `Description`, `Hazards[].Name`, `Remedies[].Name`, `RemedyOptions[].Option`,
`RecallDate`, and `URL` map to the notice. Missing required values, bad dates, and non-CPSC URLs
reject only that record and appear in bounded, secret-free diagnostics.

Scopes are conservative. Explicit `Products[].Name` and `Products[].Model` map to name/model;
product description/type/category and manufacturer names are compact `additional_criteria`.
Manufacturer is never a brand. `ProductUPCs` are recall-level evidence, stored in separate scopes
and never associated to a particular product. Valid GS1-check-digit values populate `gtin` while
preserving leading zeroes; invalid values are retained only as `source_upc` evidence. Phase 7 does
not infer serial, lot, manufactured-date ranges, or split ambiguous model text.

The new migration's source RPC serializes create-or-locate behavior for the one CPSC source:
`U.S. Consumer Product Safety Commission (CPSC)`, `US`, `https://www.cpsc.gov`, authoritative.
Each notice RPC is transactional. A changed notice replaces its scopes atomically; an unchanged
notice only refreshes `retrieved_at`.

## Dry runs and operation

`dryRun` defaults to `true`: it calls CPSC, validates and maps real records, and reports fetched,
inserted, updated, unchanged, rejected, scope count, examples, and bounded errors. It never writes
sources, notices, or scopes.

Create an ignored local `supabase/functions/.env` file containing server-side values only:

```dotenv
RECALL_INGESTION_KEY=replace-with-a-long-random-value
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=your-local-service-role-key
```

```bash
npx supabase start
npx supabase functions serve ingest-cpsc-recalls --no-verify-jwt
export RECALL_INGESTION_KEY='the-value-in-your-ignored-local-env-file'
curl --fail --silent --show-error http://127.0.0.1:54321/functions/v1/ingest-cpsc-recalls \
  -H 'content-type: application/json' \
  -H "x-recall-ingestion-key: $RECALL_INGESTION_KEY" \
  --data '{"startDate":"2026-09-01","endDate":"2026-09-14","dryRun":true}'
```

After linking the desired project, set the secret and deploy without tracking its value:

```bash
npx supabase secrets set RECALL_INGESTION_KEY='replace-with-a-long-random-value'
npx supabase functions deploy ingest-cpsc-recalls
```

For a small real write, use the same header against the deployed function and set `dryRun` to
`false`. Confirm the CPSC authoritative source, CPSC notice/scopes, and unmodified official
`raw_payload` in Supabase. Re-run exactly the same request: it should report `unchanged` unless
CPSC changed a record, and never create duplicate `(source_id, external_id)` rows.

Scheduled ingestion, Nemotron execution inside ingestion, notifications, other sources, and product
search are outside Phase 7. CPSC establishes recall facts; the separate Phase 10 matcher may only
evaluate owned products against this stored evidence.

## Phase 8 handoff

Phase 8 consumes the Phase 7 evidence without changing this ingestion path or either migration.
`ProductUPCs` remain independent recall-level GTIN scopes, manufacturer names remain contextual
`additional_criteria` rather than brand, and full `raw_payload` remains authoritative provenance.
The deterministic baseline does not reinterpret arbitrary raw prose into model, lot, serial, or
date criteria. When normalized scopes are insufficient but preserved source evidence appears
important, it returns `needs_review` for later evaluation.

Candidate retrieval, pairwise scope matching, multi-scope aggregation, and benchmarking are
documented separately in [recall-matching.md](recall-matching.md). Phase 8 adds no ingestion calls,
database writes, alerts, or AI requests.

## Phase 10 handoff

Phase 10 remains deliberately decoupled from ingestion. A successful write-mode ingestion can be
followed by a separate targeted or cursor-based call to `process-recall-matches`, but ingestion does
not invoke it automatically. This keeps source normalization failures, matching budgets, Nebius
cost, and match persistence independently observable and retryable.

The matcher reads only authoritative notices and the normalized scopes produced here. The raw CPSC
payload remains part of canonical change detection and durable provenance, but Phase 10 sets the
production matcher's `rawEvidence` projection to `null`; it does not broaden the Nemotron prompt to
arbitrary source prose. Retrieval timestamps do not affect the evidence fingerprint, while a real
canonical payload or normalized evidence change does.

Phase 12 schedules both stages: bounded CPSC ingestion completes first, then the automation
orchestrator calls matching with explicit limits and overlap protection. Phase 13 adds source
language and notice jurisdiction metadata without changing that sequence. See
[automatic-recall-loop.md](automatic-recall-loop.md) for the operational boundary.
