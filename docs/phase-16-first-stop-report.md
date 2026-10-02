# Phase 16 first stop report

Status: **design + local implementation + deterministic v2 benchmark review complete**.
Production remains on `deterministic_v1` / `hybrid_guarded_v1`. No migration, deployment, shadow
run, paid Nemotron call, alert, push, commit, or push was performed.

## Design and implementation

1. **Evidence storage:** pending forward-only migration
   `20260920160000_phase_16_product_safety_evidence.sql` adds a single atomic
   `owned_products.safety_attributes` JSONB object. A database function whitelists ten keys,
   requires bounded strings, rejects control characters, and validates real canonical date-only
   manufacture/production values. Existing product RLS remains the access boundary.
2. **Criterion model:** schema `2.0.0` defines typed criterion kinds, only-needed operators,
   required flags, value/range payloads, explicit `all_of` versus `ambiguous` semantics, and source
   provenance.
3. **Matcher versions:** `deterministic_v2` and `hybrid_guarded_v2` are separate constants and
   modules. V1 imports, constants, contracts, production policy, and results are unchanged.
4. **Required-condition semantics:** every mandatory criterion must be `matched` before an explicit
   all-of scope confirms. A safe contradiction rejects that scope. Missing or unresolved evidence
   remains `needs_review`. Ambiguous relationships cannot confirm or reject.
5. **Candidate retrieval:** unchanged. Richer evidence absence does not remove candidates.
6. **Fingerprint:** v2 uses a separate canonical fingerprint policy
   `phase_16_guarded_v2_shadow_only`; historical v1 fingerprints are untouched.
7. **Hybrid v2:** deterministic v2 runs first; only abstentions reach the injected evaluator.
   Runtime-invalid output and provider errors fail closed. AI confirmations require every mandatory
   structured criterion to be locally recomputed and cannot invent missing user evidence. The
   provider adapter remains disconnected; tests use mocks only.
8. **Shadow mode:** the pure v2 evaluator is side-effect free and suitable for a future no-persist
   shadow runner, but no production shadow integration or execution was added.

## Deterministic replay

The runner recomputed `deterministic_v1` on all 200 frozen Phase 15 cases and found **0 prediction
mismatches** against the frozen v1 result artifact. It then evaluated v2 from the frozen explicit
scope rules without changing any Phase 15 file.

| Split | Cases | Accuracy | TP / FP / FN / TN | Unsafe | Precision | Strict recall | Review | Coverage | Pairwise |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Development | 48 | 100% | 16 / 0 / 0 / 32 | 0 | 100% | 100% | 33.3% | 66.7% | 100% |
| Holdout | 120 | 100% | 40 / 0 / 0 / 80 | 0 | 100% | 100% | 33.3% | 66.7% | 100% |
| Stress | 32 | 100% | 11 / 0 / 0 / 21 | 0 | 100% | 100% | 31.3% | 68.8% | 100% |
| Overall | 200 | 100% | 67 / 0 / 0 / 133 | 0 | 100% | 100% | 33.0% | 67.0% | 100% |

The unsafe-confirm rate is 0%. This 100% replay is a consistency result against the same frozen,
source-derived structured rules used to derive the controlled labels; it is not independent
real-world generalization evidence.

### Known unsafe cases

| Case           | Expected     | v1    | v2           | Reason                                                             |
| -------------- | ------------ | ----- | ------------ | ------------------------------------------------------------------ |
| `p15-str-45-2` | no-match     | match | no-match     | Serial is safely outside the explicit mandatory fixed-width range. |
| `p15-str-45-3` | needs-review | match | needs-review | Mandatory serial evidence is missing.                              |
| `p15-str-46-3` | needs-review | match | needs-review | Mandatory lot evidence is missing.                                 |

There are **0 new unsafe confirmations** and **0 rejected true-match cases**. Fifteen changed cases
became `no_match`; every one is labelled `no_match` and has an explicit authoritative mandatory
criterion contradiction. Ten changed cases became `match` after all mandatory criteria matched.
Two unsafe v1 confirmations became `needs_review`. All 27 changes improved agreement with the
controlled labels.

The complete source-traceable delta is in
`benchmarks/recall-matching/phase-16/results/decision-delta-v1-to-v2.json`.

### Subgroups

| Subgroup                    | Cases | Accuracy | Unsafe | Precision | Recall | Review | Coverage | Pairwise |
| --------------------------- | ----: | -------: | -----: | --------: | -----: | -----: | -------: | -------: |
| GTIN                        |   104 |     100% |      0 |      100% |   100% |  32.7% |    67.3% |     100% |
| Model                       |    92 |     100% |      0 |      100% |   100% |  32.6% |    67.4% |     100% |
| Serial/range                |     8 |     100% |      0 |      100% |   100% |  50.0% |    50.0% |     100% |
| Lot                         |     8 |     100% |      0 |      100% |   100% |  25.0% |    75.0% |     100% |
| Manufacture/production/date |    20 |     100% |      0 |      100% |   100% |  30.0% |    70.0% |     100% |
| Variant                     |    28 |     100% |      0 |      100% |   100% |  32.1% |    67.9% |     100% |
| Size                        |     8 |     100% |      0 |      100% |   100% |  25.0% |    75.0% |     100% |
| Capacity                    |     4 |     100% |      0 |      100% |   100% |  25.0% |    75.0% |     100% |
| Batch                       |     4 |     100% |      0 |      100% |   100% |  25.0% |    75.0% |     100% |
| Multi-condition             |    40 |     100% |      0 |      100% |   100% |  32.5% |    67.5% |     100% |
| Hard negatives              |    67 |     100% |      0 |       n/a |    n/a |     0% |     100% |      n/a |
| Near-identical pairs        |   100 |     100% |      0 |      100% |   100% |     0% |     100% |     100% |

## Product evidence and UX

The four primary fields remain visually dominant: Product name, Brand, Scanned on, and GTIN.
Model, serial, lot/batch, purchase date, country, and category remain secondary. An optional
collapsed **Additional safety details** section stores variant, color, size, capacity, battery
model, charging port, screw state, date code, manufacture date, and production date. Detail screens
show only stored values. OCR populates these fields only from explicit label/value associations.

`scan_date`, `purchase_date`, `manufacture_date`, `production_date`, and recall date remain separate.
No inference or substitution occurs.

## Migration review gate

- **Filename:** `supabase/migrations/20260920160000_phase_16_product_safety_evidence.sql`
- **Original first-gate SHA-256:**
  `f148a32b9becd28402164db737e2b3dc8fa3a80ed30e32ac345a0a96355a45ad`
- **Current verification-gate SHA-256:**
  `ae0b79dc932d97336e0811d93caa9c4789a795a40f8afd381b052fea0d0711c8`. The
  database/server gates added narrowly scoped validator execution grants and an explicit `anon`
  revocation after local PostgreSQL 17 ACL testing.
- **Objects:** one validation function, one `owned_products` JSONB column, one check constraint, and
  one column comment.
- **RLS:** unchanged owner-only `owned_products` policies; no new table, public read, anon grant, or
  service-role client path.
- **Backfill:** PostgreSQL default `{}` only; no explicit update, fabricated attributes, timestamp
  change, match reevaluation, or v1 fingerprint change.
- **Production impact:** brief DDL lock and constraint validation scan are possible. Client code
  must not deploy before the column exists.
- **Cron:** a pause is not required for v1 matching because its explicit projection omits the new
  column; migration timing should still be coordinated before client rollout.
- **Dry run:** not run; Supabase CLI/local database is unavailable and application requires explicit
  approval.
- **pgTAP:** a 31-assertion suite is authored at
  `supabase/tests/phase-16-product-safety-evidence.sql`; it has not been executed.

## Paid evaluation estimate

V2 leaves 66/200 cases at `needs_review`, so the maximum initial Phase 16 evaluation corpus is 66
AI cases. Scaling the measured Phase 15 guarded-hybrid average (88 escalations, 101 requests,
327,268 tokens, USD 0.1601226) gives a planning estimate of about **76 requests, 245,451 tokens,
and USD 0.1201**. This is not a quote: a v2 prompt and retry distribution can change usage.

No paid call was made.

## Verification

- `npm run check`: PASS, including every historical matcher/product/orchestration suite, CPSC
  validation, Phase 9.1/15 freeze guards, and the Phase 16 freeze guard.
- `npm run test:phase-16`: 33/33 PASS.
- Android, iOS, and web production exports: PASS under Expo SDK 57.
- `git diff --check`: PASS.
- Basic secret-pattern scan: no matches.
- Expo Doctor: not run because native dependencies/config did not change.
- At the first gate, Deno, database lint, migration dry run, and pgTAP execution were unavailable.
  The later database/server verification gate records their current status separately.

The implementation followed the exact Expo 57 documentation. No artifact was committed or pushed.
