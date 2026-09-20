# Phase 15 TDD evidence

## Source and journeys

Journeys were derived from the Phase 15 brief.

- As a benchmark maintainer, I can validate independently split, privacy-safe cases so unsupported labels or leakage block freezing.
- As a safety evaluator, I can measure unsafe confirmations, missed affected products, and near-identical pair discrimination.
- As a release reviewer, I can verify new and historical artifact hashes without live websites or paid inference.
- As a model-run approver, I can review exact datasets, request ceilings, token/cost/runtime estimates, and prompt/policy hashes before authorizing paid calls.

## RED / GREEN evidence

| Behavior                      | RED evidence                                                                                                     | GREEN evidence                                                                                                      | Guarantee                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase 15 module and artifacts | `node ... --test tests/phase-15-benchmark.test.mjs` failed with `ERR_MODULE_NOT_FOUND` for `phase-15/dataset.ts` | `npm run test:phase-15` passes 11/11                                                                                | Dataset validation, audit invariants, safety metrics, stress-only perturbations, and freeze checks are executable. |
| Dataset label support         | New tests could not load any v2 splits before implementation                                                     | `npm run benchmark:phase-15:validate` reports 200 cases, zero overlap, zero duplicates, and zero unsupported labels | Every committed label agrees with the controlled-scope oracle.                                                     |
| Frozen integrity              | No Phase 15 manifest or guard existed                                                                            | `npm run benchmark:phase-15:freeze:verify` passes and historical Phase 9.1 verification also passes                 | Six v2 artifacts, twelve matcher/prompt policy files, and all 17 historical benchmark files are hash-pinned.       |
| Paid execution guardrails     | Importing `phase-15/paidRun.ts` initially failed with `ERR_MODULE_NOT_FOUND`                                     | `npm run test:phase-15` passes projection, request/cost-cap, and technical-failure tests                            | Paid inputs exclude labels, caps fail closed, and technical failures cannot become correct abstentions.            |
| Fail-closed continuation      | `validateHybridContinuationCheckpoint` was initially absent                                                      | `npm run test:phase-15` verifies the exact 113/87 boundary and rejects duplicate or reordered completed IDs         | The exhausted case cannot be rerun and only remaining frozen-order cases are eligible for continuation.            |

## Coverage and known gaps

The project uses Node's native test runner and has no repository-wide line-coverage command. Phase 15 exercises its exported validator, audit, metric, freeze, projection, paid-run guardrail, and continuation-boundary paths directly. Paid execution was explicitly authorized. Nemotron v1 completed; guarded hybrid stopped at its first schema-exhausted case and later completed under a separate fail-closed continuation. The original checkpoint remained unchanged, that case was not rerun, and validation was never relaxed.

No TDD checkpoint commits were created because the user explicitly prohibited commits in this phase.
