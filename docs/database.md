# Recall database

Phase 2 defines the database in
`supabase/migrations/20260912000000_phase_2_foundation.sql`. SQL migrations are the source of truth;
tables and policies should not be recreated manually in the Supabase dashboard.
`supabase/config.toml` contains the standard local CLI configuration with seeding disabled because
Phase 2 intentionally creates no fake users or recall data.

## Relationships

```text
auth.users
  ├──── user_preferences
  └──< owned_products
         └──< recall_matches >── recall_notices >── recall_sources
                  │                    │
                  │                    ├──< recall_scopes
                  │                    └──< recall_notice_jurisdictions
                  │
                  └── alerts >── auth.users

auth.users
  └──< private.push_devices
alerts
  ├── private.push_alert_queue
  └──< private.push_deliveries >── private.push_devices

private.recall_automation_control (singleton)
private.recall_automation_state (singleton watermark)
private.recall_automation_runs
private.recall_automation_lease (singleton active claim)
public.recall_notices
  └── private.recall_automation_pending_recalls
public.country_codes
  ├──< owned_products
  ├──< user_preferences
  └──< recall_notice_jurisdictions (country rows only)
```

- A user owns many inventory records.
- A user has at most one minimal preferences row.
- A recall source publishes many notices; `(source_id, external_id)` uniquely identifies a notice.
- A notice has one or more structured scopes in normal ingestion, though the database permits a
  notice to exist before its scopes are parsed.
- A notice can have multiple normalized country, region, or global jurisdiction rows.
- A product/notice pair has at most one current match evaluation.
- A match has at most one user alert. A trigger guarantees that the alert user owns the matched
  product.

## Tables

### `owned_products`

Stores a particular item owned by a user. Brand, name, category, GTIN, model, serial, lot, image,
purchase date, country of purchase, and identification metadata are nullable because a useful
inventory record can be incomplete. Identification confidence is constrained to `0..1`. Deleting
an auth user cascades to their inventory and dependent private records.

Phase 4 uses this existing table without a schema change. The mobile inventory adapter maps its
snake_case columns to `OwnedProduct`, uses the authenticated Supabase user only for an insert's
`user_id`, and lets RLS enforce every other operation. Manual entries persist
`identification_method = 'manual'`, with `identification_confidence` and `image_path` left `null`.
Blank optional form values are normalized to `null`, preserving a single representation of missing
metadata.

Phase 13 adds nullable `purchase_country_code`. The database rejects malformed or unsupported
values through the protected 249-entry `country_codes` catalog; the application uses the same ISO
3166-1 alpha-2 catalog and displays English names. Existing rows remain `NULL`. This field is
user-supplied market context, not GPS, nationality, manufacturer origin, or recall jurisdiction.

Phase 14 adds required `scan_date` as a PostgreSQL `date`. Legacy rows use the UTC calendar date of
their immutable `created_at`; the backfill preserves `updated_at` so existing inventory order does
not change. Current clients write the user's local calendar date and may edit it without changing
matching evidence or `created_at`.

### `user_preferences`

Stores one optional `default_purchase_country_code` per authenticated user and no broader profile
data. Its primary key is the owning `user_id`; deletion of the auth user cascades to the preference.
RLS allows a user to select, insert, update, or delete only their own row. The default initializes
new manual, barcode, or OCR-assisted forms but never modifies existing products.

### `recall_sources`

Stores the publisher, stable `source_key`, legacy source jurisdiction, base URL, authoritative flag,
explicit activation flag, and optional `source_language_code`. New rows default inactive so an
authority must be deliberately enabled after verification.
The source key, name, jurisdiction, and base URL are immutable; corrections or a materially different
publisher/origin require a new source row so historical provenance cannot be rewritten.
Phase 13 records CPSC as English (`en`). The code is source metadata only: authoritative text is
not translated or rewritten.

### `recall_notices`

Stores the official source relationship, source-specific ID, title, descriptive safety fields,
recall date, official URL, retrieval time, and original JSON object. The source relationship uses
`ON DELETE RESTRICT`, and matches also restrict notice deletion, so provenance cannot be silently
removed from existing evaluations. The source and external ID are immutable after insertion.
Official notice URLs must use the same host as the source base URL.

### `recall_scopes`

Stores deterministic targeting criteria for a notice: product text, GTIN, model, lot or serial
bounds, manufacturing dates, and structured additional criteria. At least one nonblank, nonempty
criterion is required. Manufacturing dates have an ordered-range check. Lot and serial bounds are
intentionally stored as text without a SQL ordering constraint because manufacturer numbering
schemes are not universally comparable. A scope cannot later be moved to a different notice.

### `recall_notice_jurisdictions`

Stores normalized notice jurisdiction metadata independently from owned-product country. Each row
has a notice, controlled `jurisdiction_type` (`country`, `region`, or `global`), controlled code,
and creation time. A uniqueness constraint prevents duplicate notice/type/code relationships, and
rows cascade with their notice. Authenticated users may read jurisdictions only when the related
source is authoritative; only privileged ingestion can write them.

The Phase 13 migration and CPSC ingestion RPC idempotently associate CPSC notices with country
`US`. Jurisdiction insertion does not touch the notice's matching revision, raw payload, scopes,
existing evidence fingerprint, match row, or alert history.

### `recall_matches`

Stores an evaluation of one owned product against one existing trusted notice. Its status is one
of `candidate`, `confirmed`, `rejected`, or `needs_review`; confidence is constrained to `0..1`.
The record retains method, matched identifiers, reasoning summary, optional AI provenance, schema
version, and evaluation time. The unique product/notice pair represents the current evaluation and
prevents accidental duplicate alerts. A trigger rejects evaluations for sources that are not
currently approved as authoritative, and product/notice relationships are immutable once created.
Every later evaluation update rechecks source approval.

`confirmed` means the matching system concluded that the owned identifiers fit the scope of an
already stored notice. It never means that AI established that a recall exists.

### `alerts`

Stores the delivery state for a match: `unread`, `read`, or `dismissed`, with consistent read and
dismissal timestamps. `user_id` makes owner filtering and delivery efficient, while the ownership
trigger prevents it from disagreeing with the matched product owner or referring to an unapproved
source. Product ownership itself is immutable, so that relationship cannot become stale later.

### Private push tables

`private.push_devices` stores one globally unique Expo token, its authenticated owner, platform,
enabled state, and registration timestamps. `private.push_alert_queue` contains only confirmed
alerts inserted after the Phase 11 migration; the migration performs no historical backfill.
`private.push_deliveries` stores one logical attempt stream per alert/device, Expo ticket IDs,
normalized result codes, bounded attempt counters, leases, and ticket/receipt timestamps.

### Private automation tables

`private.recall_automation_control` contains the processing, AI, and push kill switches plus
bounded run limits. All switches default to false. `private.recall_automation_state` stores only
the last successfully covered CPSC `LastPublishDate` UTC date. `private.recall_automation_runs`
stores aggregate operational counts and normalized errors without user/product identifiers or raw
provider data. `private.recall_automation_lease` provides one crash-recoverable active run, and
`private.recall_automation_pending_recalls` preserves inserted/materially updated notice IDs until
matching completes.

Phase 14 adds `private.recall_source_sync_state`, keyed by source ID. It stores only that authority's
watermark, attempt/success times, status, normalized error code, and aggregate metrics. Direct table
access is revoked; bounded service-role RPCs own reads and updates. Failed syncs never replace the
last successful watermark.

## Identifier strategy

GTIN, model, serial, and lot identifiers remain nullable and textual. Text preserves leading zeros,
prefixes, separators, and manufacturer-specific formats. The schema does not assume every item has
a barcode and does not pretend that every lot or serial range can be ordered lexically.

Candidate lookup starts with indexed exact attributes such as GTIN, model, serial, and lot. Phase
10 adds expression indexes for the matcher's normalized exact values and a simple-language
full-text product-name index. The server-safe retriever and matcher still refine every bounded SQL
candidate; SQL retrieval alone never confirms a match. Ambiguous cases may be evaluated by NVIDIA
Nemotron only against normalized evidence from existing authoritative notices and the same
versioned match contract.

## Provenance strategy

Every notice belongs to a source and preserves its external ID, official URL, retrieval timestamp,
and raw payload. Source deletion is restricted while notices exist, and notice deletion is
restricted while matches exist. This gives each match a durable path back to the authoritative
record. No real sources or notices are seeded in Phase 2.

AI metadata lives only on `recall_matches`. It cannot create a source, notice, or scope through the
mobile client, and it is evidence about matching rather than evidence that the recall itself exists.

## Row Level Security and privileges

RLS is enabled on every application table. Explicit grants are paired with policies; both must
allow an operation.

| Table                         | Authenticated mobile access           | Ownership rule                               |
| ----------------------------- | ------------------------------------- | -------------------------------------------- |
| `owned_products`              | Select, insert, update, delete        | `auth.uid() = user_id`                       |
| `user_preferences`            | Select, insert, update, delete        | `auth.uid() = user_id`                       |
| `recall_sources`              | Select only                           | Global data where `is_authoritative` is true |
| `recall_notices`              | Select only                           | Source must be authoritative                 |
| `recall_scopes`               | Select only                           | Notice source must be authoritative          |
| `recall_notice_jurisdictions` | Select only                           | Notice source must be authoritative          |
| `recall_matches`              | Select only                           | Owned product and authoritative source       |
| `alerts`                      | Select; update status/timestamps only | Owner and authoritative source must agree    |

All three private push tables have RLS enabled and no direct grants, including to `service_role`.
Authenticated users can only register or unregister a token through fixed-signature,
owner-derived RPCs. Service delivery and receipt RPCs are executable only by `service_role`.

The five private automation tables follow the same isolation pattern. `service_role` can execute
fixed-signature `SECURITY DEFINER` automation RPCs but has no direct table privilege. `anon` and
`authenticated` cannot claim leases, change watermarks, inspect run history, or administer Cron.

The anonymous role receives no application-table access. Rows from sources not explicitly approved as
authoritative are also hidden from authenticated clients, including dependent notices, scopes,
matches, and alerts. There are no mobile write policies or grants for recall data or match
evaluations, and no mobile insert/delete permission for alerts. Server-side ingestion and matching
use privileged execution that is never bundled into the app. The mobile client uses
only a Supabase publishable key, and RLS protects user data. Supabase secret credentials and Nebius
credentials are server-only and must never enter Expo client code.

Global recall data is shared because an official notice and its scope are the same facts for every
user. Inventory, evaluations, and alerts are private because they reveal ownership and personalized
safety results.

## Indexes and integrity

- Inventory: owner plus partial indexes for non-null GTIN, model, serial, and lot identifiers.
- Preferences: one row per user, with canonical nullable country code.
- Notices: source and recall date, plus a unique source/external ID pair.
- Scopes: notice, GTIN, model, and brand.
- Jurisdictions: notice lookup plus a unique notice/type/code relationship.
- Matches: a unique product/notice pair plus notice lookup.
- Alerts: user lookup plus a unique match relationship.
- JSON fields that represent structured records are constrained to JSON objects.
- `updated_at` is maintained by a small trigger on mutable tables.
- Ownership, notice provenance, and match identity keys are immutable after creation.
- Source identity is immutable, while match and alert creation require current source approval.
- Notice URLs are constrained to HTTP(S) and the approved source host.

## Ingestion and matching flow

1. A privileged server process retrieves a notice from a pre-approved authoritative source.
2. It stores or updates the source and deduplicated notice while preserving the raw response and
   official URL. The database requires that URL to use the approved source host; the ingestion
   boundary must still validate the expected path and notice identity.
3. It parses one or more deterministic scopes from that notice.
4. Indexed identifiers and conservative text evidence select candidates.
5. `deterministic_v1` evaluates scopes and aggregates confirmed/rejected/needs-review evidence.
6. The privileged Phase 10 orchestrator claims the pair, persists a schema-validated evaluation,
   and releases the lease transactionally.
7. A confirmed evaluation creates or reuses one alert; other decisions create none, and a later
   reversal retains the existing alert as visible history.
8. A new confirmed alert is queued by an insert trigger. A later bounded claim creates unique
   alert/device deliveries only where the enabled device owner still equals the alert owner and
   the match is still confirmed.

## Phase 7 CPSC ingestion

The Phase 7 migration adds two service-role-only RPCs without changing the Phase 2 schema or RLS
policies. `ensure_cpsc_recall_source()` serializes registration of the authoritative CPSC source.
`ingest_cpsc_recall(...)` upserts a notice by the existing `(source_id, external_id)` constraint and
replaces that notice's scopes in the same transaction only when official data changed. The
notice-host trigger accepts only the exact HTTPS CPSC hosts `cpsc.gov` and `www.cpsc.gov`,
preserving the authoritative URL while rejecting subdomains, lookalikes, userinfo, and HTTP.

No authenticated mobile grants, policies, or client write paths were added for recall sources,
notices, scopes, matches, or alerts. The RPCs are executable only by `service_role`, from the
server-side Edge Function. Phase 10 later adds matching and in-app alerts without changing that
mobile write boundary. Phase 11 adds push registration only through narrow authenticated RPCs; raw
tokens remain outside the mobile-readable schema.

## Phase 8 matching

Phase 8 requires no migration. The pure matcher and benchmark do not connect to Supabase, write
`recall_matches`, or create alerts. This keeps benchmark execution read-only and avoids overloading
`matched_identifiers` with the richer common contract's conflicting/evidence fields.

Phase 10 persists the baseline with status, heuristic confidence,
`match_method = 'deterministic_v1'`, matched identifiers, reasoning, null AI provenance, and schema
version `1.0.0`. The write remains privileged and source-backed. The richer in-memory evidence
contract is not overloaded into existing columns.

## Phase 10 matching orchestration

`supabase/migrations/20260914100000_phase_10_recall_matching.sql` adds a nullable,
lowercase-SHA-256-constrained `recall_matches.evidence_fingerprint`, normalized candidate indexes,
and `private.recall_matching_leases`. The lease table has RLS enabled and all direct privileges are
revoked from `PUBLIC`, `anon`, `authenticated`, and `service_role`. It is intentionally absent from
the mobile API surface.

Four fixed-signature `SECURITY DEFINER` RPCs use an empty `search_path`; their execute privilege is
revoked from public/mobile roles and granted only to `service_role`:

- `get_recall_matching_batch` pages authoritative notices by UUID and supports an optional targeted
  UUID list. It aggregates normalized scopes in stable canonical order.
- `get_recall_candidates` returns a bounded, ranked product page using a composite
  `(exact_rank, owned_product_id)` cursor.
- `claim_recall_match_evaluation` compares the canonical evidence fingerprint and current
  product/notice revisions, then acquires or rejects an expiring per-pair lease.
- `finalize_recall_match_evaluation` validates the live lease, authority, revisions, allowed status,
  matching method, and AI provenance before atomically upserting the match and conditionally
  creating an alert.

The unique product/notice match constraint and unique match/alert constraint remain the final
database idempotency guards. Repeated identical evidence is skipped before inference. Concurrent
runs cannot both finalize the same claimed input. A stale worker cannot persist after product or
notice changes. Alert creation is in the same transaction as a confirmed match, so a committed
confirmation cannot exist without its in-app alert.

The mobile Alerts repository reads the existing RLS-protected relationships. It receives no access
to fingerprints, raw notice payloads, leases, claims, or finalization RPCs. See
[automatic-recall-loop.md](automatic-recall-loop.md) for the runtime and verification procedure.

## Phase 11 push delivery

`supabase/migrations/20260915100000_phase_11_push_notifications.sql` adds the private push tables,
future-alert trigger, two authenticated device RPCs, and four service delivery/receipt RPCs.
Delivery uses expiring leases and `FOR UPDATE SKIP LOCKED`; unique `(alert_id, push_device_id)` rows
prevent duplicate logical fan-out. Transient sends retry at most three times, permanent failures do
not retry, and `DeviceNotRegistered` disables the device. See
[push-notifications.md](push-notifications.md) for the runtime and security model.

## Phase 13 global-ready metadata

The forward-only Phase 13 migration adds `owned_products.purchase_country_code`, the minimal
`user_preferences` table, the protected `country_codes` integrity catalog,
`recall_sources.source_language_code`, normalized
`recall_notice_jurisdictions`, and `public.get_monitoring_status()`.

`get_monitoring_status()` is a zero-argument, fixed-search-path `SECURITY DEFINER` function granted
only to `authenticated` callers. It returns exactly three aggregates:
`monitoring_enabled`, `last_successful_check_at`, and `active_source_count`. It cannot mutate or
expose private automation controls, run rows, errors, limits, leases, watermarks, Cron
administration, Vault values, AI credentials, push tokens, or service-role data.

Country of purchase, notice jurisdictions, and source language are presentation and future-routing
metadata in Phase 13. They are not selected into the Phase 10 matcher contract or evidence
fingerprint, so metadata-only changes do not create pointless reevaluation. The Phase 12 Cron
schedule, activation state, controls, limits, watermarks, leases, AI policy, and push gates remain
unchanged. See [global-coverage.md](global-coverage.md).

## Phase 14 global recall network

`supabase/migrations/20260918100000_phase_14_global_recall_network.sql` adds `scan_date`, immutable
source adapter keys, explicit source activation, private per-source sync state, and service-only
generic ingestion RPCs. CPSC remains active and its legacy RPC remains compatible. Health Canada is
registered as authoritative but inactive. `get_monitoring_status()` keeps its three-field public
contract while counting and timestamping only active authoritative sources.
