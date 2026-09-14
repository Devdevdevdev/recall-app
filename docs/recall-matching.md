# Deterministic recall matching

Phase 8 establishes Recall's server-safe, non-AI reference matcher and offline benchmark. It does
not write match rows, generate alerts, call an LLM, or change the database.

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
code, so Node tests and a future privileged Edge Function can share them.

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
be shown as “percent probability recalled.” The contract is JSON-shaped so a future Nemotron result
can be schema-validated against the same concepts.

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

At production scale, a server repository should use existing raw GTIN/model indexes for initial
exact queries, perform bounded text retrieval, then call the pure retriever and matcher. The current
schema has no normalized model/name index, so Phase 8 deliberately does not claim a complete
database query plan.

## Security and integration status

Phase 8 adds no endpoint. That avoids exposing a new privileged write surface before a production
orchestrator is required. It also adds no migration because the existing `recall_matches` table can
represent the core deterministic result. Full `evidenceUsed` and `conflictingIdentifiers` remain in
the common evaluation contract; persistence design is deferred rather than overloading existing
columns.

A later server-only integration may persist `match_method = deterministic_v1`, `ai_provider = null`,
`ai_model = null`, and schema version `1.0.0` using service credentials. It must fail closed and may
not create alerts until the deterministic/Nemotron comparison and alerting policy are approved.

The authoritative source establishes the recall. Deterministic and future Nemotron matching only
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
