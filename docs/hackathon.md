# Nebius × NVIDIA Global AI Hackathon 2026 checklist

This document tracks submission requirements and implementation evidence as Recall progresses.

## Technical requirements

- [ ] **Nebius Token Factory runtime usage:** Route real product-normalization and recall-matching
      requests through Nebius Token Factory from a secure server-side function.
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
Password recovery, social login, production matching orchestration, notifications, and scheduled
ingestion remain deferred.
