# Deterministic recall matching

Phase 8 establishes Recall's server-safe, non-AI reference matcher and offline benchmark. Phase 10
reuses that exact matcher inside the production orchestration path; the historical Phase 8
benchmark itself remains read-only and unchanged.

## Separation of responsibilities

1. **Candidate retrieval** finds plausible authoritative recalls using exact valid GTIN, exact
   normalized model/serial/lot evidence, or conservative product-name overlap. Manufacturer text is
   retrieval-only context and never authoritative brand equality.
2. **Pairwise matching** evaluates one controlled owned product against every scope of one existing
   authoritative notice. It produces the common `MatchEvaluation` contract.
3. **Benchmarking** maps the three production decisions to labelled cases, computes safety and
   coverage metrics, and performs no persistence or network access.

All production matching logic lives under `supabase/functions/_shared/matching/`, outside React
Native screens. The modules import no Supabase client, Deno runtime, network adapter, or mobile
code, so Node tests and the privileged Phase 10 Edge Function can share them.

## Common contract

`OwnedProductEvidence` contains product name, brand, category, GTIN, model, serial, lot, purchase
date, and identification method. `OfficialRecallEvidence` contains the notice ID, CPSC provenance,
title/safety fields, recall date, normalized scopes, and preserved raw evidence.

`MatchEvaluation` schema `1.0.0` contains:

- decision: `confirmed`, `rejected`, or `needs_review`
- heuristic confidence in `0..1`
- matched and conflicting identifiers
- ordered evidence used
- deterministic reasoning summary
- match method `deterministic_v1`
- explicit schema version

Confidence ranks deterministic evidence strength. It is not a calibrated probability and must not
be shown as “percent probability recalled.” The contract is JSON-shaped so a Nemotron result can be
schema-validated against the same concepts.

## Normalization

- GTINs are trimmed, must contain digits only, and must be valid GTIN-8/12/13/14 values under the
  standard GS1 check digit. They are never converted to numbers, preserving leading zeroes.
- Model, serial, and lot identifiers use NFKC normalization, trim/collapse whitespace, and compare
  case-insensitively while preserving meaningful hyphens, slashes, dots, letters, and digits.
- Product names use NFKC, lowercase, punctuation-to-space normalization, a small documented stop
  word set, and symmetric Jaccard token overlap. There is no stemming, embedding, fuzzy service, or
  semantic transformation.
- Serial/lot ranges are ordered only when the value and both bounds are fixed-width digits. Equal
  endpoints are safe exact identifiers. Mixed, missing-bound, differently sized, or alphanumeric
  ranges abstain instead of using arbitrary lexical order.

## `deterministic_v1` rules

- Exact valid GTIN in one official scope confirms with the strongest score unless that same scope
  contains another structured identifier conflict.
- A valid GTIN mismatch rejects that scope only. Sibling scopes are still evaluated.
- Exact model plus product-name Jaccard overlap of at least `0.35` can confirm. Exact model without
  compatible surrounding identity produces `needs_review`.
- Exact serial/lot and safely included numeric ranges confirm; safely excluded numeric ranges
  reject the scope; ambiguous ranges require review.
- Product-name or explicit brand evidence alone only supports `needs_review`.
- CPSC manufacturer names remain contextual and are never mapped or compared as official brand.
- Purchase date is never compared as manufacture date.
- Complex `additionalCriteria` and arbitrary raw prose are not parsed into identifiers. Plausible
  cases that depend on them require review.
- Absence of comparable evidence is uncertainty, not proof of non-match.

## Multiple scopes

Scopes are evaluated independently. Any strongly confirmed compatible scope confirms the notice;
a different UPC scope mismatch cannot override it. Without a confirmation, any plausible unresolved
scope produces `needs_review`. A notice is rejected only when every relevant scope is concretely
contradicted. If there are no relevant/comparable scopes, the matcher abstains.

This preserves Phase 7 semantics: CPSC `ProductUPCs` are recall-level scopes and are not silently
joined to individual `Products[]` entries.

## Candidate retrieval

The pure retriever ranks exact valid GTIN highest, then exact serial/lot/model, then transparent name
overlap. A low name threshold favors recall over precision because candidate retrieval is not the
final decision. Manufacturer text may retain a candidate at very low weight but cannot confirm it.

Phase 10's server repository uses normalized exact-expression indexes and a simple-language
full-text product-name index for initial bounded SQL retrieval, then calls this pure retriever and
matcher. Candidate pages use a composite rank/product cursor. Serial/lot range notices include
products with that identifier conservatively so SQL never decides unsafe range semantics.

## Phase 8 security boundary

Phase 8 adds no endpoint. That avoids exposing a new privileged write surface before a production
orchestrator is required. It also adds no migration because the existing `recall_matches` table can
represent the core deterministic result. Full `evidenceUsed` and `conflictingIdentifiers` remain in
the common evaluation contract; persistence design is deferred rather than overloading existing
columns.

Phase 10's later server-only integration persists `match_method = deterministic_v1`, null AI
provenance, and schema version `1.0.0` using service credentials. It retains the rich evidence only
in the evaluation boundary rather than overloading the database's matched-identifier JSON.

The authoritative source establishes the recall. Deterministic and Nemotron matching only
establish whether an owned product appears to fit that recall. Neither may invent one.

## Phase 9 measured Nemotron comparison

Phase 9 preserves this contract while adding `nemotron_v1` through the server-only Nebius Token
Factory boundary. The exact frozen dataset SHA-256 is
`c547d61df8e9eacc1d47d46ec505e409d88cd23795abc20cbbfb4e96f67fb3f8`. An explicit projection
passes only the owned-product and authoritative-recall evidence to the model; automated tests prove
that labels, provenance, reasons, case metadata, deterministic output, and metrics are absent.

The fixed prompt version is `1.0.0`. The target model supports strict function tools but did not
advertise JSON-schema response format, so it returns a forced `submit_recall_match_evaluation` tool
call whose arguments use the strict local schema. Provider/model metadata is attached only after
validation. Any invalid output safely abstains and is separately counted as a technical failure.

On the one-pass 30-case run, `nvidia/nemotron-3-super-120b-a12b` produced 70.0% integrity-adjusted
exact accuracy, 69.2% MATCH precision, 90.0% strict MATCH recall, a 20.0% false-positive rate,
33.3% needs-review rate, and 66.7% decision coverage. It confirmed all three baseline unresolved
positives but introduced four false positives. Structured-output success was 26/30. These results
do not justify production alerts or a claim of general accuracy. See [nebius-nemotron.md](nebius-nemotron.md)
for full methodology, latency, token usage, cost, limitations, and the read-only hybrid simulation.

## Phase 9.1 guarded hybrid policy and independent holdout

`hybrid_guarded_v1` always executes `deterministic_v1` first. Deterministic `confirmed` and
`rejected` results return without a model call; only `needs_review` is eligible for Nebius. The
model receives a label-free projection and must use the forced
`submit_guarded_recall_match_evaluation` function. Its controlled claims address an owned field and
an authoritative scope or raw-evidence field by index. The local verifier, not the model, performs
the final comparison.

A guarded confirmation requires exact GTIN, model, serial/prefix, or lot/range evidence that can be
recomputed locally, has compatible product identity, is unambiguous across source associations,
and is not blocked by additional criteria or manufacture/sale windows. Names and brands alone
cannot confirm. Purchase date cannot satisfy a manufacture or sale date. AI `rejected` is advisory
and remains `needs_review`. Invalid output, provider failure, timeout, or an unverifiable claim also
fails closed to `needs_review`.

The policy and prompt were frozen after offline work on `development.v1.json` (24 cases: 8 per
class, 8 official CPSC sources; SHA-256
`1887da996161611c1d48d3fa75fea281d29f49d27befcb52ce818b0728bd81b1`). No paid development
inference was used: there were zero model-backed prompt variants and one policy/prompt version was
frozen. The independent `holdout.v1.json` contains 36 cases (12 per class) from 12
additional CPSC recalls that overlap neither development nor the historical 30-case dataset. Its
frozen SHA-256 is `3dd19b7075cc7f865816f7217984d1e98f6fd83e1aea2cba6ebbc4554502e608`.

| Metric                     | Deterministic holdout | Guarded hybrid holdout |
| -------------------------- | --------------------: | ---------------------: |
| Exact three-class accuracy |                 77.8% |                  88.9% |
| MATCH TP / FP / FN / TN    |        8 / 0 / 4 / 24 |        12 / 0 / 0 / 24 |
| MATCH precision            |                100.0% |                 100.0% |
| Strict MATCH recall        |                 66.7% |                 100.0% |
| False-positive rate        |                  0.0% |                   0.0% |
| Needs-review rate          |                 55.6% |                  44.4% |
| Decision coverage          |                 44.4% |                  55.6% |

The deterministic baseline resolved 16 cases and escalated 20. Those 20 escalations made 24 total
requests: four first responses violated the structured schema and each succeeded on its single
eligible retry. Primary structured-output success was 16/20 (80.0%); final structured-output
success after the bounded retries was 20/20 (100.0%), or 20 valid outputs across 24 attempts. There
were no provider failures, and no expected positive remained unresolved. The hybrid improved four
cases, worsened none, and left 32 unchanged. It produced no false-positive case to list.

Escalated inference latency was 135.608 seconds total, 6.780 seconds average, 6.494 seconds p50, and
10.342 seconds p95. Nebius reported 50,334 input and 31,895 output tokens, 82,229 total; separate
reasoning-token usage was unavailable. At the live rates of USD 0.30/M input and USD 0.90/M output,
the calculated cost was USD 0.0438057. The benchmark remains read-only and adds no endpoint,
migration, persistence, alert, notification, or production policy.

## Phase 10 production integration

The production orchestrator preserves `hybrid_guarded_v1` without relaxing any verifier rule. It
runs `deterministic_v1` first and lazily initializes the pinned Nebius client only for abstentions
within the explicit run budget. Its projection contains normalized authoritative notice/scopes and
sets `rawEvidence` to `null`; Phase 10 does not expose arbitrary raw payload content to the model.
The provider transport has zero retries so the existing guarded orchestration remains the sole
single-retry authority.

Canonical evidence fingerprints include matching-policy versions and canonical evidence, but not
database row IDs, retrieval timestamps, update timestamps, or scope insertion order. Private
expiring leases and revision checks prevent duplicate concurrent or stale finalization. Confirmed
results create one transactional in-app alert; all provider, schema, budget, and verification
failures remain `needs_review` and create none.

The production path, database RPCs, limits, deployment, deterministic E2E, and paid-inference
approval gate are documented in [automatic-recall-loop.md](automatic-recall-loop.md).
