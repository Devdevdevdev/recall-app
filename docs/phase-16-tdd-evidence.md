# Phase 16 TDD evidence

## Scope and user journeys

The implementation was derived from the Phase 16 safety-hardening brief. The tested journeys are:

- A product with a matching model confirms only when every explicit mandatory criterion matches.
- Missing mandatory evidence remains `needs_review`; safe contradictions reject only under proven
  all-of semantics.
- Users may store optional bounded safety attributes without mixing scan, purchase, manufacture,
  production, and recall dates.
- AI cannot invent missing user evidence, and production v1 remains untouched.

## RED → GREEN evidence

| Behavior                                     | RED evidence                                                                                                  | GREEN evidence                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| V2 matcher, verifier, fingerprint, migration | `npm run test:phase-16` failed with missing v2 modules and migration                                          | 33/33 Phase 16 tests passed                                                                                                                |
| Typed app integration                        | New fields initially had unresolved TypeScript intersections                                                  | `npm run typecheck` passed                                                                                                                 |
| OCR explicit labels                          | `COLOR: BLACK` initially failed the parser regression                                                         | Phase 16 OCR regression and the historical 11-case parser validation passed                                                                |
| Constraint validator permissions             | Rolled-back PostgreSQL 17 experiment failed with `42501 permission denied for function`                       | Revised grants accepted authenticated insert/update in the same rolled-back experiment                                                     |
| Database behavior coverage                   | Static test rejected the 14-assertion pgTAP plan as incomplete                                                | 31 assertions now pass against a reset local database, covering ACLs, value types, RLS roles, timestamps, v1 state, and alert non-creation |
| Immutable date remediation                   | Remote lint reported two volatility warnings and the static suite found no forward-only remediation migration | New migration uses fixed-position integers plus `make_date`; local lint is clean and the expanded 44-assertion pgTAP suite passes          |

No checkpoint commit was created because the Phase 16 brief explicitly prohibits commits before
this review gate.

## Guarantees

| Guarantee                                                                                  | Test/command                        | Type                 | Result |
| ------------------------------------------------------------------------------------------ | ----------------------------------- | -------------------- | ------ |
| Required serial/lot/date/variant match, conflict, and missing states are distinct          | `tests/phase-16-safety.test.mjs`    | unit                 | PASS   |
| Exact GTIN cannot bypass an explicit narrower criterion                                    | `tests/phase-16-safety.test.mjs`    | unit                 | PASS   |
| AI cannot fill absent mandatory evidence                                                   | `tests/phase-16-safety.test.mjs`    | unit                 | PASS   |
| Rich evidence serializes with separate canonical dates                                     | `tests/phase-16-safety.test.mjs`    | integration          | PASS   |
| Pending migration is constrained, forward-only, owner-RLS preserving, and non-reevaluating | `tests/phase-16-database.test.mjs`  | static DB contract   | PASS   |
| Frozen 200-case replay fixes known unsafe cases and reports all deltas/subgroups           | `tests/phase-16-benchmark.test.mjs` | benchmark regression | PASS   |

## Coverage and gaps

The repository has no configured code-coverage command, so a numeric 80% coverage claim is not
available. The focused suite covers all specified v2 criterion states and the full 200-case replay.
The local database reset and 31-assertion pgTAP suite now pass. Migration application, native-device
UI interaction, production shadow mode, and paid AI evaluation remain gated. The linked dry run,
remote lint, and Deno results are recorded in the separate database/server verification report.
