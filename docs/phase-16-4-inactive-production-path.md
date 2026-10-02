# Phase 16.4 inactive deterministic v2 production path

Status: **implemented and locally exercised; not deployed or activated**. Production remains
`phase_10_guarded_v1`. The Phase 16.3 contract migration and the Phase 16.4 forward migration are
unapplied in production. No v2 production evaluation, alert, push, or Nebius call has occurred.
The local Supabase reset is a disposable validation database, not a production application.

## Source-bound criterion review

`private.recall_scope_criteria_v2` binds a review to a stable scope ID and official URL. Source
refresh replaces scope rows and removes bindings. The Phase 16.4 service-only
`approve_cpsc_product_model_criterion_v2` RPC is the sole supported live promotion route. A reviewer
names the exact CPSC `Products[n].Model` entry and supplies their ID, an eligibility statement, and
a SHA-256 of the canonical raw source payload. The RPC checks the authoritative CPSC source, the
product-specific raw model, and the normalized scope model before storing an explicit `all_of`
criterion with field provenance. The live worker verifies the source hash, field path, value,
source URL, and reviewer attestation again. A stale or unsupported binding is treated as absent,
producing `needs_review`. There is no automatic promotion from source prose.

The reviewer must establish that the product-specific model is an eligibility condition; its
presence in the feed alone is insufficient. The current route deliberately permits one mandatory
model criterion. A future criterion class needs its own source-field contract and review gate.
Descriptive color, variant, capacity, and similar attributes stay descriptive. The Seeday color
case is a permanent example: a listed color must not become mandatory merely because it appears
in source text. `ambiguous` criterion relationships always stay unresolved. Product scope OR and
explicit `all_of` within a scope are the only supported Boolean semantics.

### Current source compatibility matrix

| Source        | Criterion class                           | Structured source support now                                                                         | Reviewed semantics now               | Production v2 eligible               | Fallback                               |
| ------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------ | -------------------------------------- |
| CPSC          | Product-level model                       | `Products[n].Model` and normalized scope model                                                        | Reviewer-attested mandatory equality | Yes, only through service review RPC | `needs_review` without current binding |
| CPSC          | GTIN/UPC                                  | `ProductUPCs` is recall-level; no proven product association                                          | Unresolved                           | No                                   | `needs_review`                         |
| CPSC          | Serial exact/range                        | Normalized scope columns exist; current mapper does not establish product-specific serial eligibility | Unresolved                           | No                                   | `needs_review`                         |
| CPSC          | Lot exact/range                           | Normalized scope columns exist; current mapper does not establish product-specific lot eligibility    | Unresolved                           | No                                   | `needs_review`                         |
| CPSC          | Manufacture/production date range         | Scope date columns exist, but current CPSC ingestion does not review source date semantics            | Unresolved                           | No                                   | `needs_review`                         |
| CPSC          | Date-code set/prefix                      | Not normalized from a product-specific source field                                                   | Unresolved                           | No                                   | `needs_review`                         |
| CPSC          | Variant, color, size, capacity            | Usually descriptive text; no mandatory relationship                                                   | Unresolved                           | No                                   | `needs_review`                         |
| Health Canada | Product/brand summary                     | Product name and source metadata in summary feed                                                      | Descriptive only                     | No                                   | `needs_review`                         |
| Health Canada | GTIN, model, serial, lot, dates, variants | Current summary feed lacks reviewed product-specific structured evidence                              | Unresolved                           | No                                   | `needs_review`                         |

The pure matcher can compare additional identifier and date operators for controlled benchmarks.
That capability does not make an ingested source field production eligible. Health Canada may gain
classes only after a separate authoritative structured detail source and semantics review.

## Worker and evidence contract

The v2 worker uses the existing bounded `get_recall_matching_batch` and `get_recall_candidates`
RPCs. A service-role-only `get_owned_product_evidence_v2` RPC then fetches the exact owned product
revision and a narrow safety projection: name, brand, category, GTIN, model, serial, lot,
identification method, and `safety_attributes`. The projection drops `purchase_date`; `scan_date`
is not accepted by the safety attribute schema. Dates require canonical `YYYY-MM-DD`. Invalid
stored attributes fail closed. No images, OCR payloads, private profile fields, or other inventory
records enter the matcher. Consumer inventory access retains owner RLS; the worker fetch is
service-only and is checked against the candidate revision.

The v2 Edge import graph contains no Nebius client, guarded model, or push provider. It computes a
v2 fingerprint from matching product evidence, current reviewed criteria and review attestation,
official recall source, and product/recall revisions. Revisions distinguish a restored value after
an intervening contradictory evaluation; replay of an unchanged revision remains idempotent. The
existing pair lease and revision checks gate immutable v2
finalization. There is no v1 hybrid fallback. Errors do not confirm. The main production endpoint
uses `RECALL_MATCHING_POLICY`, defaulting to `phase_10_guarded_v1`; unknown values fail closed.
The v2 branch additionally requires explicit recall IDs, at most 10 recalls / 50 candidate pairs,
and `maxNebiusCalls: 0`.

`process-recall-matches-v2-cohort` is a separate manual endpoint. It is disabled unless
`RECALL_V2_COHORT_ENABLED=true`, requires a separate secret, explicit recall IDs, at most five
recalls / 25 candidate pairs, and zero AI calls. It has no Cron target. Its worker creates
immutable evaluations and alert eligibility but **does not create consumer alerts**. This permits
review while the production selector and v1 scheduler remain on `phase_10_guarded_v1`.

## Alert and correction behavior

A confirmed evaluation creates one eligibility row. `create_recall_v2_alert` locks it, checks that
it is unrevoked and points to the latest confirmed evaluation, checks authoritative source and no
legacy alert, then creates one v2 alert snapshot per product/recall pair. Source and product evidence
are captured at evaluation time in private audit rows; the consumer projection omits raw payloads,
fingerprints, internal leases, provider details, and worker errors. Replay returns the existing
alert. V2 alerts have owner-checked unread/read/dismissed state, separate from immutable source and
evidence snapshots. V2 alerts do not enter the v1 push queue. The cohort endpoint never calls the
alert writer; activation of the main v2 selector is a separate decision. On first active replay,
pending confirmed cohort eligibility can create an alert if it is still the latest eligible result.

A later v2 `needs_review` or `rejected` result revokes pending eligibility and records a correction
when a v1 or v2 alert already exists. The old alert and its audit snapshot remain. The authenticated
read model reports `no_longer_confirmed`, the latest decision, and the original official source.
Consumer copy says that newer rules no longer confirm the previous match and directs the user to
the official notice; it never declares the product safe. Existing v1 alert rows from before this
migration cannot have their original source revision reconstructed. The migration captures the
source and match row available at migration time, records that capture time, and preserves the
original alert row. Future v1 alerts get a snapshot at creation.

`get_recall_safety_feed_v2` is an authenticated, owner-filtered projection. The app reads it only
when `EXPO_PUBLIC_RECALL_V2_READ_ENABLED=true`, which is unset by default. It displays confirmed,
needs review, rejected, contested historical alerts, official source, and alert state. No private
worker or administrative fields are returned. Owner-only state changes use
`update_recall_v2_alert_state`; another account cannot read or change the alert.

## First production cohort proposal (not executed)

After separate migration and inactive deployment approvals, select at most **five explicit newly
ingested CPSC notice IDs** with reviewed product-model criteria and no pre-existing v1 alert for
the chosen pairs. Preflight candidate count at **25 total**, reject a cohort exceeding the cap,
run the manual endpoint once, and observe for **24 hours**. There is no historical bulk replay and
no production shadow evaluation before approval. Keep the main selector on
`phase_10_guarded_v1`, cohort scheduling off, alert creation off, push off, and AI calls at zero.

Review per run and cumulatively: candidate pairs evaluated, confirmed, rejected, needs review,
v1/v2 disagreements, v1-confirmed to v2-review/reject transitions, duplicate attempts, eligibility
created/revoked, alerts created, corrections created, processing latency p50/p95, and database
errors. The cohort target is zero duplicate evaluations/alerts, zero unsafe confirmations on manual
review, zero database errors, zero consumer alerts/push, zero AI calls, USD 0 AI cost, and per-pair
p95 processing latency at or below five seconds. Any
unsafe confirmation, unexpected alert or push, private data exposure, malformed source binding,
nonzero AI call, unexpected DB error, p95 latency above five seconds, or cap breach stops the cohort. Disable the cohort gate;
retain immutable observations for audit. Production v1 continues. Activation requires a measured
review and its own explicit approval; it is not automatic after 24 hours.

| Metric                                                                                                       | Measurement source                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Candidate pairs, decisions, duplicate attempts, eligibility changes, alert creations, latency, AI calls/cost | Bounded Edge run summary; retain each response with its explicit recall IDs                                           |
| V1/v2 disagreements and v1 confirmed → v2 review/reject                                                      | Join the latest v2 `observation_seq` per pair to `public.recall_matches`; count only pairs with both observations     |
| Eligibility active/revoked, alert snapshots, corrections                                                     | Counts in the private v2 contract tables filtered to approved recall IDs; reconcile with Edge summaries               |
| Database errors                                                                                              | Edge 500 responses and Supabase/PostgreSQL error logs for the bounded run window; any nonzero value blocks activation |
| Push and AI                                                                                                  | Confirm no v2 push queue/delivery entry, no Nebius request, `aiCalls = 0`, and USD 0 cost                             |

## Local verification boundary

The Phase 16.4 pgTAP suite covers confirmed/review/rejected, one evaluation and alert snapshot,
replay, no v2 push queue entry, evidence change and pending eligibility revocation, v1 and v2
historical corrections, owner-only read/state changes, and official source retention. Node tests
cover source binding, Seeday-style descriptive color rejection, recall-level UPC rejection,
invalid safety evidence, purchase-date exclusion, policy default, import isolation, and bounded
worker behavior. These are local contract tests, not a measured real-world accuracy claim.
Phase 16 research found no measured need for AI in automatic confirmation once authoritative
structured evidence was modeled correctly. Nemotron remains part of the project's historical v1
work and current guarded v1 production path.
