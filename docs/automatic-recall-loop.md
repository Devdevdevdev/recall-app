# Automatic recall matching loop

Phase 10 turns the frozen Phase 9.1 guarded hybrid policy into a bounded production workflow. It
selects authoritative recalls, retrieves owned-product candidates, evaluates each pair, persists a
current result, and creates an in-app alert only for a confirmed match. It does not schedule itself,
send push notifications, or broaden the evidence supplied to Nemotron.

## Runtime flow

```text
administrative caller
  -> POST process-recall-matches with x-recall-matching-key
  -> page authoritative recall notices
  -> page bounded owned-product candidates for each notice
  -> canonical evidence fingerprint
  -> atomic claim or unchanged/busy/stale skip
  -> deterministic_v1
       -> confirmed/rejected: persist without AI
       -> needs_review: optional hybrid_guarded_v1 within Nebius budget
  -> atomic revision check, match upsert, and confirmed-alert creation
  -> aggregate secret-free counters
```

The Edge Function is an administrative service-to-service endpoint. It is not called from the Expo
application and has JWT verification disabled deliberately because it uses a separate high-entropy
`RECALL_MATCHING_KEY`. It accepts POST only and compares the key from
`x-recall-matching-key` without an early-exit string comparison.

The function creates a privileged Supabase client from platform-provided server credentials. It
prefers the `default` entry in `SUPABASE_SECRET_KEYS` and retains
`SUPABASE_SERVICE_ROLE_KEY` only as a compatibility fallback. None of these values may appear in an
`EXPO_PUBLIC_*` variable, mobile source, app configuration, logs, responses, or commits.

## Request and budgets

The JSON body is optional only in the sense that an empty object uses conservative defaults:

```json
{
  "maxRecalls": 20,
  "maxCandidatePairs": 200,
  "maxNebiusCalls": 10,
  "afterRecallId": null,
  "recallNoticeIds": null
}
```

The hard caps are 100 recalls, 1,000 candidate pairs, and 100 Nebius attempts. Negative,
non-integer, malformed, or over-cap values are rejected. `afterRecallId` is an optional UUID cursor.
`recallNoticeIds` is an optional de-duplicated list of 1 to 100 UUIDs for targeted operation; it
does not bypass source-authority checks.

Recall pages contain at most 25 notices and candidate pages contain at most 50 products. Candidate
pagination uses `(exact_rank, owned_product_id)` rather than an offset so equal-rank rows cannot be
silently skipped. Retrieval prioritizes exact normalized GTIN, model, serial, and lot evidence,
then bounded full-text product-name evidence. When a notice contains a serial or lot range,
retrieval conservatively includes products with the relevant identifier so the matcher—not SQL—can
decide safe inclusion, exclusion, or ambiguity.

## Authoritative evidence projection

Only notices whose source is currently marked authoritative enter the loop. The production
projection contains the owned-product fields and normalized notice/scopes needed by the existing
matcher. It deliberately sets `rawEvidence` to `null`; Phase 10 does not send preserved raw CPSC
payload prose or new evidence categories to Nemotron.

An evidence fingerprint is SHA-256 over canonical JSON containing:

- normalized owned-product evidence;
- normalized authoritative notice and scopes;
- a SHA-256 of the canonical raw source payload;
- deterministic matcher, guarded hybrid, prompt, schema, production-policy, and model versions.

Object keys and scopes are sorted canonically. Database row IDs, retrieval timestamps, update
timestamps, and scope insertion order do not affect the fingerprint. A real evidence or policy
change does. Product and recall revision timestamps are checked separately to prevent a stale
worker from persisting a result after inputs change.

## Matching safety policy

`deterministic_v1` always runs first. Its `confirmed` and `rejected` results never initialize the
Nebius client. Only `needs_review` can enter the unchanged `hybrid_guarded_v1` path, and only while
the run's Nebius-attempt budget remains.

Production pins:

- base URL: `https://api.tokenfactory.us-central1.nebius.com/v1/`
- model: `nvidia/nemotron-3-super-120b-a12b`
- transport retries: `0`

The guarded orchestrator remains the only retry authority and permits at most its existing single
eligible structured-output retry, still within the run budget. AI rejection is advisory and remains
`needs_review`. Provider configuration errors, API errors, timeouts, invalid structured output,
unverifiable claims, and exhausted budgets all fail safely to `needs_review`; they cannot create an
alert. A model-proposed confirmation becomes `confirmed` only when the Phase 9.1 local verifier can
reconstruct exact, unambiguous, source-addressable identifier evidence.

## Concurrency, idempotency, and atomic persistence

`private.recall_matching_leases` provides one expiring claim per product/notice pair. The table has
RLS enabled and is inaccessible to `PUBLIC`, `anon`, `authenticated`, and `service_role`, including
direct table access. Fixed-signature `SECURITY DEFINER` RPCs with an empty `search_path` are the only
access path. Only `service_role` may execute those RPCs.

Claims use a random lease token and a 300-second expiry. The claim RPC checks product and notice
revisions before and after acquisition. It returns one of `claimed`, `unchanged`, `busy`, `stale`,
or `missing`. A matching stored fingerprint returns `unchanged`; a live competing lease returns
`busy`; an expired lease can be reclaimed.

Finalization requires the same pair, lease token, fingerprint, and revisions. In one transaction it
rechecks authority and freshness, upserts the unique current `recall_matches` row, creates an alert
if and only if the result is `confirmed`, and releases the lease. It rejects the provisional
`candidate` status and validates method/provenance consistency:

- `deterministic_v1` must have null AI provider/model metadata;
- `hybrid_guarded_v1` must identify Nebius and the exact pinned Nemotron model.

Repeated confirmation reuses the existing alert. If a later evidence change reverses a prior
confirmation, the alert is retained as history and the app displays that the evaluation is no
longer confirmed. This avoids silently erasing a safety message the user may already have seen.

## Mobile read model

Authenticated users read alerts through `SupabaseAlertsRepository`. Its nested query relies on the
existing RLS chain from alert to match to owned product and authoritative notice. The adapter maps
only consumer-safe fields: alert state, product name/brand/identifiers, notice title/hazard/remedy/
date/official URL, current match status/method, and reasoning summary. Raw source payloads, evidence
fingerprints, AI prompts, lease data, user IDs, and server credentials are not part of the mobile
domain type.

The Alerts tab supports initial loading, retry, pull-to-refresh, an empty state, and navigation to a
protected detail route. Detail links open the stored official HTTPS recall URL through Expo Linking.

## Deployment

Apply migrations through the normal reviewed Supabase workflow, then set server-only secrets and
deploy the function:

```bash
npx supabase db push
npx supabase secrets set RECALL_MATCHING_KEY='replace-with-a-long-random-value'
npx supabase secrets set NEBIUS_API_KEY='replace-with-the-provider-key'
npx supabase secrets set NEBIUS_MODEL_ID='nvidia/nemotron-3-super-120b-a12b'
npx supabase secrets set NEBIUS_BASE_URL='https://api.tokenfactory.us-central1.nebius.com/v1/'
npx supabase functions deploy process-recall-matches --no-verify-jwt
```

Do not place literal secret values in shell history, documentation, source files, CI logs, or mobile
configuration; use the deployment environment's secret-input mechanism in real operations. Phase
10 does not add a cron job. A future scheduler should invoke the same bounded endpoint after a
successful ingestion run, use narrow limits, avoid overlap, and alert operators on repeated
failures.

## Verification without paid inference

Run repository and database checks first:

```bash
npm run check
npm run test:database
```

The SQL test suite checks RPC privileges, complete lease-table isolation, atomic confirmed-alert
creation, unchanged skips, confirmation reversal, alert reuse, non-confirmed behavior, targeted
selection, and cross-user RLS. `npm run test:database` requires the local Supabase stack and Docker.

The controlled deterministic demo uses the real CPSC RecallID `8877`, “Thule Recalls Strollers Due
to Injury Hazard,” and its published GTIN `091021037090`:

1. Start the local Supabase stack, apply migrations, and serve both Edge Functions with their
   separate administrative keys.
2. Sign up a dedicated demo user in Recall. Add a controlled inventory record named `Thule Sleek
stroller`, brand `Thule`, with GTIN `091021037090`. State clearly that this is public-source demo
   evidence, not the user's historical purchase.
3. Invoke `ingest-cpsc-recalls` in write mode for the one-day window `2020-08-12` through
   `2020-08-12`. Confirm that the stored notice has `external_id = '8877'`, the official CPSC URL,
   the unchanged raw payload, and its normalized GTIN scope.

   ```bash
   curl --fail --silent --show-error \
     http://127.0.0.1:54321/functions/v1/ingest-cpsc-recalls \
     -H 'content-type: application/json' \
     -H "x-recall-ingestion-key: $RECALL_INGESTION_KEY" \
     --data '{"startDate":"2020-08-12","endDate":"2020-08-12","dryRun":false}'
   ```

4. Resolve the database notice UUID without copying other recall data:

   ```sql
   select recall_notice.id
   from public.recall_notices as recall_notice
   join public.recall_sources as recall_source on recall_source.id = recall_notice.source_id
   where recall_source.is_authoritative
     and recall_notice.external_id = '8877';
   ```

5. Start `process-recall-matches` with Supabase server credentials and `RECALL_MATCHING_KEY`.
   Deliberately omit `NEBIUS_API_KEY`, and invoke this targeted zero-AI run:

```bash
curl --fail --silent --show-error \
  http://127.0.0.1:54321/functions/v1/process-recall-matches \
  -H 'content-type: application/json' \
  -H "x-recall-matching-key: $RECALL_MATCHING_KEY" \
  --data '{"recallNoticeIds":["REPLACE_WITH_NOTICE_UUID"],"maxRecalls":1,"maxCandidatePairs":10,"maxNebiusCalls":0}'
```

6. Verify that the response reports one deterministic confirmation, zero Nemotron escalations, and
   one created alert. Confirm one `recall_matches` row and one `alerts` row for the pair. Repeat the
   same request: it must report an unchanged skip and must not create a duplicate.
7. Sign in as the demo owner, refresh Alerts, open the detail, and verify product, title, hazard,
   remedy, method, reason, date, and official CPSC link. Sign in as a second user and verify that the
   first user's product, match, and alert are absent.

Any E2E case that may reach Nemotron is paid inference. Stop before sending it, state the exact
candidate count and `maxNebiusCalls`, estimate the upper-bound input/output cost using current
provider pricing, and obtain explicit approval for that specific run. No paid production E2E was
performed during Phase 10 implementation.

## Operations and scaling limits

The function returns only aggregate counters: recalls and pairs processed, deterministic and AI
counts, decisions, alert outcomes, skips, failures, retries, duration, limit hits, and provider token
usage. It does not label an estimated cost as actual cost because the completion response does not
provide a reliable charge; operators can calculate an estimate from returned token counts and
current published pricing. Pair-level error logs contain a counter rather than product, recall,
prompt, credential, or provider-body data.

The current design intentionally favors bounded safety over high throughput. Before materially
larger deployments, measure normalized/FTS candidate selectivity, RPC latency, lease contention,
function duration, provider latency/cost, `needs_review` volume, and confirmation-reversal rates.
Add scheduling, operational alerting, retention policy, human-review workflow, and push delivery as
separately reviewed changes; do not weaken the guarded verifier or expose the lease table to gain
throughput.
