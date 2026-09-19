# Nebius × NVIDIA Global AI Hackathon 2026 checklist

This document tracks submission requirements and implementation evidence as Recall progresses.

## Technical requirements

- [x] **Nebius Token Factory runtime integration:** The production matching function routes only
      deterministic abstentions through the pinned Nemotron model using the server-only client.
- [ ] **Paid production E2E evidence:** Run one explicitly approved, bounded production-path
      inference and record its redacted counters and cost. Phase 10 implementation sends none.
- [x] **NVIDIA open-source model usage:** Run NVIDIA Nemotron as the matching/reasoning model and
      record the exact open-source model identifier and license.
- [x] Validate all model responses against a structured JSON schema.
- [x] Demonstrate that the model reasons only over recall candidates retrieved from trusted
      sources and cannot invent a recall.
- [x] Define persistence for recall provenance, source URLs, matched identifiers, confidence, and
      uncertainty.
- [x] Protect user inventory and match results with Row Level Security from the first database
      migration.
- [x] Establish an executable deterministic baseline with a common structured contract, explicit
      abstention, false-positive metrics, latency, and zero AI cost.

## Submission requirements

- [x] **Public repository:** <https://github.com/Devdevdevdev/recall-app>
- [x] **Open-source license:** MIT license included in the repository.
- [ ] **Working demo/test build:** Publish an installable or reliably reproducible Android/iOS
      build and document test instructions.
- [x] Add reproducible local development-build instructions for the native on-device OCR demo.
- [x] Add an Android development-build path for Expo Push Service notifications using FCM v1.
- [ ] **Maximum 3-minute public YouTube demo:** Publish a public video no longer than three minutes
      and add its URL here.
- [x] **Explanation of Nebius/NVIDIA usage:** Document the runtime path, model, prompts/schemas,
      security boundary, and why the integration is material to Recall.
- [ ] **Project feedback requirement:** Complete the organizer's required product or platform
      feedback and retain submission evidence.

## Phase status

Phase 1 provided the mobile shell and documentation. Phase 2 added the migration-defined Supabase
schema, RLS policies, domain types, repository boundaries, and guarded client configuration. Phase
3 added real Supabase email/password authentication, persisted sessions, protected routes, and
sign-out. Phase 4 adds authenticated inventory CRUD using the existing `owned_products` RLS
policies: list, refresh, manually create, view, edit, and confirmed delete. Phase 5 adds private,
on-device barcode acquisition and confirmation before it reuses that inventory flow. Phase 6 adds
still-image Latin OCR entirely on device, deletes the temporary cache image on best effort, and asks
the user to review only conservatively parsed identifiers. It performs no product lookup and makes
no recall claim. Phase 6.1 adds native date-only purchase-date selection without a schema change and
treats non-GTIN Code 128 scans as transient, unclassified product-code evidence rather than
incorrectly persisting them as a GTIN, model, serial, or lot. Phase 7 adds server-only,
date-bounded CPSC ingestion with raw-payload provenance and conservative scopes, but deliberately
creates no matches or alerts and makes no AI calls. Phase 8 adds `deterministic_v1` and a frozen
30-case CPSC-backed evaluation set. Phase 9 evaluates the exact same evidence once with
`nvidia/nemotron-3-super-120b-a12b` through Nebius Token Factory. Nemotron raised strict recall from
70.0% to 90.0% but reduced exact accuracy to 70.0%, introduced four false positives, and produced
valid structured output on 26/30 cases. It is measured evidence, not a production alert policy.
Phase 9.1 responds with a frozen guarded hybrid: deterministic decisions bypass AI, only 20/36
holdout abstentions were sent to the exact Nemotron model, and a local verifier required exact
source-addressable identifier evidence before confirmation. The independent holdout reached 88.9%
exact accuracy, 100.0% MATCH precision and recall, zero false positives, and 55.6% decision coverage.
All 20 escalations ended with valid structured output after four eligible schema-failure retries;
24 requests used 82,229 tokens and cost USD 0.0438057. Phase 10 connects that unchanged guarded
policy to a secret-protected bounded Edge Function, canonical evidence fingerprints, private
expiring pair leases, transactional match/alert persistence, and RLS-backed in-app alert list/detail
screens. Its production projection is limited to normalized authoritative evidence. The
deterministic production path is covered without paid inference; no paid production E2E was sent.
Phase 11 adds explicit mobile notification opt-in, Expo token registration, private/RLS-isolated
device and delivery state, server-side Expo Push Service delivery, bounded receipts/retries, and
protected notification-tap routing. It preserves the alert as source of truth and requires explicit
approval before the first real push. Phase 12 adds a production-ready scheduled monitoring
architecture with Vault-backed Cron authentication, a bounded CPSC watermark/catch-up window,
private run/lease controls, a five-call autonomous AI cap, and reuse of the existing push worker.
After separate production approvals and a zero-AI/zero-push verification, the controls and Cron job
are active at the bounded six-hour cadence. Phase 13 adds optional country-of-purchase context, an
owner-isolated default for new products, normalized notice jurisdictions, source-language metadata,
and clearer product, alert, Coverage, and monitoring presentation. Existing CPSC notices are
classified as United States/English without altering matcher inputs or fingerprints. Phase 14 adds
bounded official-source adapters for CPSC and Health Canada without changing the matcher,
deterministic-first policy, global limits, or historical-push protections. Password recovery,
social login, additional authorities, translation, and public build/demo publication remain
deferred.

## Devpost-safe current coverage language

Recall is architected for multi-jurisdiction recall monitoring and captures the market context of
owned products. Recall currently monitors official product-safety recall data from the U.S.
Consumer Product Safety Commission and Health Canada. The official authority establishes that a
recall exists; Recall's deterministic-first, guarded matching pipeline assesses whether an owned
product appears to be in scope.

Do not claim that Recall monitors recalls worldwide, covers Europe or Australia, or monitors any
authority beyond the two active sources. Controlled benchmark results remain evidence from small
frozen CPSC datasets, not a general-world accuracy claim.

## Devpost-safe Phase 12 language

Recall automatically checks official CPSC recall data on a recurring bounded schedule and processes
affected inventory without user intervention. Matching remains deterministic-first; only ambiguous
candidates may reach guarded Nebius verification, and only confirmed persisted alerts are eligible
for push delivery.

## Devpost-safe Phase 9.1 language

Initial evaluation showed that Nemotron improved recall on complex product-identification cases but
could introduce unsafe false positives when used alone. Recall therefore runs deterministic
matching first, escalates only ambiguous cases to Nemotron, and requires machine-verifiable
authoritative evidence before accepting an AI-derived confirmation. On a separate frozen 36-case
CPSC-backed holdout, this guarded hybrid improved strict MATCH recall from 66.7% to 100.0% while
retaining zero false positives; the result is a small controlled evaluation, not a claim of general
real-world accuracy or production readiness.
