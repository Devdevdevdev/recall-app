# Recall database

Phase 2 defines the database in
`supabase/migrations/20260912000000_phase_2_foundation.sql`. SQL migrations are the source of truth;
tables and policies should not be recreated manually in the Supabase dashboard.
`supabase/config.toml` contains the standard local CLI configuration with seeding disabled because
Phase 2 intentionally creates no fake users or recall data.

## Relationships

```text
auth.users
  └──< owned_products
         └──< recall_matches >── recall_notices >── recall_sources
                  │                    │
                  │                    └──< recall_scopes
                  │
                  └── alerts >── auth.users
```

- A user owns many inventory records.
- A recall source publishes many notices; `(source_id, external_id)` uniquely identifies a notice.
- A notice has one or more structured scopes in normal ingestion, though the database permits a
  notice to exist before its scopes are parsed.
- A product/notice pair has at most one current match evaluation.
- A match has at most one user alert. A trigger guarantees that the alert user owns the matched
  product.

## Tables

### `owned_products`

Stores a particular item owned by a user. Brand, name, category, GTIN, model, serial, lot, image,
purchase date, and identification metadata are nullable because a useful inventory record can be
incomplete. Identification confidence is constrained to `0..1`. Deleting an auth user cascades to
their inventory and dependent private records.

Phase 4 uses this existing table without a schema change. The mobile inventory adapter maps its
snake_case columns to `OwnedProduct`, uses the authenticated Supabase user only for an insert's
`user_id`, and lets RLS enforce every other operation. Manual entries persist
`identification_method = 'manual'`, with `identification_confidence` and `image_path` left `null`.
Blank optional form values are normalized to `null`, preserving a single representation of missing
metadata.

### `recall_sources`

Stores the publisher, jurisdiction, base URL, and authoritative flag for a source. New rows default
to non-authoritative so a source must be deliberately approved by privileged ingestion code.
The name, jurisdiction, and base URL are immutable; corrections or a materially different
publisher/origin require a new source row so historical provenance cannot be rewritten.

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

## Identifier strategy

GTIN, model, serial, and lot identifiers remain nullable and textual. Text preserves leading zeros,
prefixes, separators, and manufacturer-specific formats. The schema does not assume every item has
a barcode and does not pretend that every lot or serial range can be ordered lexically.

Candidate lookup starts with indexed exact attributes such as GTIN, model number, and brand.
Application-side normalization and later trusted matching logic can refine candidates. Ambiguous
cases may later be evaluated by NVIDIA Nemotron, but only after deterministic filtering against
stored recall scopes.

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

| Table            | Authenticated mobile access           | Ownership rule                               |
| ---------------- | ------------------------------------- | -------------------------------------------- |
| `owned_products` | Select, insert, update, delete        | `auth.uid() = user_id`                       |
| `recall_sources` | Select only                           | Global data where `is_authoritative` is true |
| `recall_notices` | Select only                           | Source must be authoritative                 |
| `recall_scopes`  | Select only                           | Notice source must be authoritative          |
| `recall_matches` | Select only                           | Owned product and authoritative source       |
| `alerts`         | Select; update status/timestamps only | Owner and authoritative source must agree    |

The anonymous role receives no table access. Rows from sources not explicitly approved as
authoritative are also hidden from authenticated clients, including dependent notices, scopes,
matches, and alerts. There are no mobile write policies or grants for recall data or match
evaluations, and no mobile insert/delete permission for alerts. Future server-side ingestion and
matching will use privileged execution that is never bundled into the app. The mobile client uses
only a Supabase publishable key, and RLS protects user data. Supabase secret credentials and Nebius
credentials are server-only and must never enter Expo client code. Future Edge Functions may use
Supabase's platform-provided publishable/secret key environment configuration when they are
implemented; none are part of Phase 2.

Global recall data is shared because an official notice and its scope are the same facts for every
user. Inventory, evaluations, and alerts are private because they reveal ownership and personalized
safety results.

## Indexes and integrity

- Inventory: owner plus partial indexes for non-null GTIN, model, serial, and lot identifiers.
- Notices: source and recall date, plus a unique source/external ID pair.
- Scopes: notice, GTIN, model, and brand.
- Matches: a unique product/notice pair plus notice lookup.
- Alerts: user lookup plus a unique match relationship.
- JSON fields that represent structured records are constrained to JSON objects.
- `updated_at` is maintained by a small trigger on mutable tables.
- Ownership, notice provenance, and match identity keys are immutable after creation.
- Source identity is immutable, while match and alert creation require current source approval.
- Notice URLs are constrained to HTTP(S) and the approved source host.

## Planned ingestion flow

1. A privileged server process retrieves a notice from a pre-approved authoritative source.
2. It stores or updates the source and deduplicated notice while preserving the raw response and
   official URL. The database requires that URL to use the approved source host; the ingestion
   boundary must still validate the expected path and notice identity.
3. It parses one or more deterministic scopes from that notice.
4. Indexed identifiers select potentially affected owned products.
5. Deterministic logic, and later schema-validated AI reasoning where necessary, creates or updates
   a match evaluation.
6. A confirmed source-backed match creates an alert for the product owner.

## Phase 7 CPSC ingestion

The Phase 7 migration adds two service-role-only RPCs without changing the Phase 2 schema or RLS
policies. `ensure_cpsc_recall_source()` serializes registration of the authoritative CPSC source.
`ingest_cpsc_recall(...)` upserts a notice by the existing `(source_id, external_id)` constraint and
replaces that notice's scopes in the same transaction only when official data changed. The existing
notice-host trigger still requires `www.cpsc.gov` official URLs.

No authenticated mobile grants, policies, or client write paths were added for recall sources,
notices, scopes, matches, or alerts. The RPCs are executable only by `service_role`, from the
server-side Edge Function. Matching, alerts, and notifications remain future work.
