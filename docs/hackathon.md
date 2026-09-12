# Nebius × NVIDIA Global AI Hackathon 2026 checklist

This document tracks submission requirements and implementation evidence as Recall progresses.

## Technical requirements

- [ ] **Nebius Token Factory runtime usage:** Route real product-normalization and recall-matching
      requests through Nebius Token Factory from a secure server-side function.
- [ ] **NVIDIA open-source model usage:** Run NVIDIA Nemotron as the matching/reasoning model and
      record the exact open-source model identifier and license.
- [ ] Validate all model responses against a structured JSON schema.
- [ ] Demonstrate that the model reasons only over recall candidates retrieved from trusted
      sources and cannot invent a recall.
- [ ] Preserve recall provenance, source URLs, matched identifiers, confidence, and uncertainty.

## Submission requirements

- [x] **Public repository:** <https://github.com/Devdevdevdev/recall-app>
- [x] **Open-source license:** MIT license included in the repository.
- [ ] **Working demo/test build:** Publish an installable or reliably reproducible Android/iOS
      build and document test instructions.
- [ ] **Maximum 3-minute public YouTube demo:** Publish a public video no longer than three minutes
      and add its URL here.
- [ ] **Explanation of Nebius/NVIDIA usage:** Document the runtime path, model, prompts/schemas,
      security boundary, and why the integration is material to Recall.
- [ ] **Project feedback requirement:** Complete the organizer's required product or platform
      feedback and retain submission evidence.

## Phase status

Phase 1 provides the mobile shell and documentation only. Nebius, NVIDIA, Supabase, barcode, OCR,
recall-source, and notification integrations are intentionally deferred so they can be added with
real credentials, trusted data, and explicit validation in later phases.
