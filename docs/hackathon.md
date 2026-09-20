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
deferred. Phase 14 is release-closed: CPSC and Health Canada are the two active official sources,
and the bounded autonomous loop processes them independently without changing the frozen
deterministic-first guarded-AI policy.

Phase 15 constructs and freezes a new 200-case controlled safety benchmark with 48 development,
120 holdout, and 32 stress cases. It measures unsafe confirmations, missed affected products,
abstention, pairwise discrimination, subgroup behavior, technical failures, latency, token usage,
and cost across `deterministic_v1`, `nemotron_v1`, and `hybrid_guarded_v1`. The approved
`nemotron_v1` run completed. The guarded-hybrid run initially stopped after one case exhausted its
strict schema retry, then resumed under a separately approved fail-closed continuation without
rerunning that case or relaxing any policy. All 200 cases are now complete. The original stop
checkpoint/report remain preserved.

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

Recall automatically checks official CPSC and Health Canada recall data on a recurring bounded
schedule and processes affected inventory without user intervention. Matching remains
deterministic-first; only ambiguous candidates may reach guarded Nebius verification, and only
confirmed persisted alerts are eligible for push delivery. Per-source state isolates retrieval
failures while global matching, AI, and push limits remain in force.

## Devpost-safe Phase 15 measurements

These are controlled internal measurements from a 200-case CPSC-backed benchmark, not estimates of
all real-world recalls. Present safety, abstention, and technical-failure results alongside
accuracy; do not reduce the result to a subjective winner.

| Metric                  | Deterministic v1 | Nemotron v1 | Guarded hybrid v1 |
| ----------------------- | ---------------: | ----------: | ----------------: |
| Unsafe confirmations    |                3 |           7 |                 3 |
| Strict recall           |            85.1% |       91.0% |             85.1% |
| MATCH precision         |            95.0% |       89.7% |             95.0% |
| Needs-review rate       |            44.0% |       38.5% |             44.0% |
| Decision coverage       |            56.0% |       61.5% |             56.0% |
| Pairwise discrimination |            78.0% |       84.0% |             78.0% |
| Stress accuracy         |            53.1% |       68.8% |             43.8% |
| AI requests             |                0 |         200 |               101 |
| Total tokens            |                0 |     538,637 |           327,268 |
| Actual cost             |            USD 0 |  USD 0.2600 |        USD 0.1601 |

Guarded hybrid recorded zero provider failures and zero timeouts, but 24 schema-invalid attempts;
11 cases exhausted the single allowed retry and remained safely `needs_review`. Its three unsafe
confirmations originated in deterministic confirmations that bypassed AI. Phase 15 also measured a
future architecture need: size, color, charging-port type, screw state, battery model, date-code
prefix, and manufacture/production dates are not representable in the current production-shaped
owned-product projection.

## Devpost-safe Phase 9.1 language

Initial evaluation showed that Nemotron improved recall on complex product-identification cases but
could introduce unsafe false positives when used alone. Recall therefore runs deterministic
matching first, escalates only ambiguous cases to Nemotron, and requires machine-verifiable
authoritative evidence before accepting an AI-derived confirmation. On a separate frozen 36-case
CPSC-backed holdout, this guarded hybrid improved strict MATCH recall from 66.7% to 100.0% while
retaining zero false positives; the result is a small controlled evaluation, not a claim of general
real-world accuracy or production readiness.
