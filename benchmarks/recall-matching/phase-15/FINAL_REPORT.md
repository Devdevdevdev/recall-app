# Recall Safety Benchmark 2.0 — final results

> This is a controlled internal CPSC-backed safety evaluation, not a representative estimate of all real-world recalls.

## Continuation integrity

The guarded run originally stopped at `p15-hol-29-1` after two provider-success/schema-invalid attempts. A separate fail-closed continuation was authorized. That case remained `needs_review`; no additional request was made for it. The remaining 87 cases were processed exactly once. Eleven total cases exhausted the one frozen retry and remained `needs_review`. No prompt, schema, matcher, verifier, eligibility, or retry policy was relaxed. The original checkpoint and stop reports remain unchanged.

## Three-system measurements

| System            | Accuracy | TP/FP/FN/TN | Unsafe confirmations | Precision | Strict recall | Needs review | Coverage | Pairwise |      AI cost |
| ----------------- | -------: | ----------- | -------------------: | --------: | ------------: | -----------: | -------: | -------: | -----------: |
| deterministic_v1  |    86.5% | 57/3/10/130 |                    3 |     95.0% |         85.1% |        44.0% |    56.0% |    78.0% |        USD 0 |
| nemotron_v1       |    89.5% | 61/7/6/126  |                    7 |     89.7% |         91.0% |        38.5% |    61.5% |    84.0% | USD 0.260004 |
| hybrid_guarded_v1 |    84.5% | 57/3/10/130 |                    3 |     95.0% |         85.1% |        44.0% |    56.0% |    78.0% | USD 0.160123 |

Combined paid cost was USD 0.420126. Nemotron used 200 requests and 538,637 tokens. Guarded hybrid escalated 88 cases, used 101 requests including 13 retries, and consumed 327,268 tokens. It recorded 24 schema-invalid attempts, 11 exhausted cases, zero provider failures, and zero timeouts.

## Results by split

| Split       | System            | Accuracy | TP/FP/FN/TN | Unsafe | Precision | Strict recall | Needs review | Coverage | Pairwise |
| ----------- | ----------------- | -------: | ----------- | -----: | --------: | ------------: | -----------: | -------: | -------: |
| development | deterministic_v1  |   100.0% | 16/0/0/32   |      0 |    100.0% |        100.0% |        33.3% |    66.7% |   100.0% |
| development | nemotron_v1       |   100.0% | 16/0/0/32   |      0 |    100.0% |        100.0% |        33.3% |    66.7% |   100.0% |
| development | hybrid_guarded_v1 |   100.0% | 16/0/0/32   |      0 |    100.0% |        100.0% |        33.3% |    66.7% |   100.0% |
| holdout     | deterministic_v1  |    90.0% | 35/0/5/80   |      0 |    100.0% |         87.5% |        43.3% |    56.7% |    83.3% |
| holdout     | nemotron_v1       |    90.8% | 36/4/4/76   |      4 |     90.0% |         90.0% |        38.3% |    61.7% |    86.7% |
| holdout     | hybrid_guarded_v1 |    89.2% | 35/0/5/80   |      0 |    100.0% |         87.5% |        43.3% |    56.7% |    83.3% |
| stress      | deterministic_v1  |    53.1% | 6/3/5/18    |      3 |     66.7% |         54.5% |        62.5% |    37.5% |    25.0% |
| stress      | nemotron_v1       |    68.8% | 9/3/2/18    |      3 |     75.0% |         81.8% |        46.9% |    53.1% |    50.0% |
| stress      | hybrid_guarded_v1 |    43.8% | 6/3/5/18    |      3 |     66.7% |         54.5% |        62.5% |    37.5% |    25.0% |

## Operational measurements by split

| Split       | System            | Requests | Retries | Tokens | Average latency ms |         Cost |
| ----------- | ----------------- | -------: | ------: | -----: | -----------------: | -----------: |
| development | deterministic_v1  |        0 |       0 |      0 |              0.016 | USD 0.000000 |
| development | nemotron_v1       |       48 |       0 | 124894 |          23007.932 | USD 0.059754 |
| development | hybrid_guarded_v1 |       16 |       0 |  44557 |           6670.386 | USD 0.019499 |
| holdout     | deterministic_v1  |        0 |       0 |      0 |              0.024 | USD 0.000000 |
| holdout     | nemotron_v1       |      120 |       0 | 327299 |          21703.544 | USD 0.159316 |
| holdout     | hybrid_guarded_v1 |       58 |       6 | 185130 |          10435.887 | USD 0.089527 |
| stress      | deterministic_v1  |        0 |       0 |      0 |              0.021 | USD 0.000000 |
| stress      | nemotron_v1       |       32 |       0 |  86444 |          20672.797 | USD 0.040934 |
| stress      | hybrid_guarded_v1 |       27 |       7 |  97581 |          19918.133 | USD 0.051096 |

## Evidence subgroups — accuracy / unsafe confirmations

| Evidence         | Deterministic |   Nemotron | Guarded hybrid |
| ---------------- | ------------: | ---------: | -------------: |
| gtin             |    100.0% / 0 | 100.0% / 0 |     100.0% / 0 |
| model            |     72.8% / 3 |  79.3% / 7 |      68.5% / 3 |
| serial_range     |     62.5% / 2 | 100.0% / 0 |      50.0% / 2 |
| lot              |     37.5% / 1 |  62.5% / 0 |      37.5% / 1 |
| manufacture_date |     33.3% / 0 |  41.7% / 0 |      25.0% / 0 |
| production_date  |     25.0% / 0 |  25.0% / 0 |       0.0% / 0 |
| date             |     25.0% / 0 |  50.0% / 2 |      25.0% / 0 |
| variant          |     42.9% / 0 |  42.9% / 7 |      39.3% / 0 |
| size             |     25.0% / 0 |  25.0% / 1 |      12.5% / 0 |
| capacity         |     25.0% / 0 |  25.0% / 3 |      25.0% / 0 |
| batch            |     50.0% / 1 | 100.0% / 0 |      50.0% / 1 |
| multi_condition  |     37.5% / 3 |  52.5% / 7 |      27.5% / 3 |

Hard-negative accuracy was 77.6% deterministic, 82.1% Nemotron, and 77.6% guarded hybrid. Pairwise discrimination was 78.0%, 84.0%, and 78.0%, respectively.

## Stress-only perturbations — accuracy / unsafe confirmations

| Perturbation                      | Deterministic |   Nemotron | Guarded hybrid |
| --------------------------------- | ------------: | ---------: | -------------: |
| boundary_date                     |      0.0% / 0 |   0.0% / 0 |       0.0% / 0 |
| conflicting_identifiers           |      0.0% / 0 |   0.0% / 1 |       0.0% / 0 |
| lot_near_miss                     |      0.0% / 0 | 100.0% / 0 |       0.0% / 0 |
| purchase_date_as_manufacture_date |    100.0% / 0 | 100.0% / 0 |       0.0% / 0 |
| serial_just_outside_range         |      0.0% / 1 | 100.0% / 0 |       0.0% / 1 |
| single_character_model_mutation   |    100.0% / 0 | 100.0% / 0 |     100.0% / 0 |
| transposed_digits                 |    100.0% / 0 | 100.0% / 0 |     100.0% / 0 |
| variant_mismatch                  |      0.0% / 0 |   0.0% / 2 |       0.0% / 0 |

## Guarded-hybrid unsafe confirmations (3)

- **p15-str-45-2** (cpsc-family-10855, expected no_match, produced confirmed): deterministic=confirmed; AI invoked=false; verifier evidence=0; failure=deterministic_confirmation_bypassed_ai_guard.
- **p15-str-45-3** (cpsc-family-10855, expected needs_review, produced confirmed): deterministic=confirmed; AI invoked=false; verifier evidence=0; failure=deterministic_confirmation_bypassed_ai_guard.
- **p15-str-46-3** (cpsc-family-10846, expected needs_review, produced confirmed): deterministic=confirmed; AI invoked=false; verifier evidence=0; failure=deterministic_confirmation_bypassed_ai_guard.

All three bypassed AI because deterministic_v1 confirmed first. The guard therefore could not intervene.

## Guarded-hybrid missed affected cases (10)

All were `needs_review` abstentions; none were rejected.

- **p15-hol-27-1** (cpsc-family-10986, needs_review_abstained): deterministic=needs_review; AI invoked=true; AI decision=needs_review; technical=none; verifier rejections=0; mechanism=ai_remained_unresolved.
- **p15-hol-29-1** (cpsc-family-10978, needs_review_abstained): deterministic=needs_review; AI invoked=true; AI decision=none; technical=schema_violation; verifier rejections=0; mechanism=schema_exhausted_fail_closed.
- **p15-hol-31-1** (cpsc-family-10969, needs_review_abstained): deterministic=needs_review; AI invoked=true; AI decision=confirmed; technical=none; verifier rejections=2; mechanism=ai_confirmation_rejected_by_local_verifier.
- **p15-hol-31-4** (cpsc-family-10969, needs_review_abstained): deterministic=needs_review; AI invoked=true; AI decision=none; technical=schema_violation; verifier rejections=0; mechanism=schema_exhausted_fail_closed.
- **p15-hol-38-1** (cpsc-family-10859, needs_review_abstained): deterministic=needs_review; AI invoked=true; AI decision=confirmed; technical=none; verifier rejections=1; mechanism=ai_confirmation_rejected_by_local_verifier.
- **p15-str-47-1** (cpsc-family-10885, needs_review_abstained): deterministic=needs_review; AI invoked=true; AI decision=confirmed; technical=none; verifier rejections=1; mechanism=ai_confirmation_rejected_by_local_verifier.
- **p15-str-48-1** (cpsc-family-10864, needs_review_abstained): deterministic=needs_review; AI invoked=true; AI decision=confirmed; technical=none; verifier rejections=1; mechanism=ai_confirmation_rejected_by_local_verifier.
- **p15-str-49-1** (cpsc-family-10845, needs_review_abstained): deterministic=needs_review; AI invoked=true; AI decision=confirmed; technical=none; verifier rejections=1; mechanism=ai_confirmation_rejected_by_local_verifier.
- **p15-str-49-4** (cpsc-family-10845, needs_review_abstained): deterministic=needs_review; AI invoked=true; AI decision=needs_review; technical=none; verifier rejections=0; mechanism=ai_remained_unresolved.
- **p15-str-50-1** (cpsc-family-10851, needs_review_abstained): deterministic=needs_review; AI invoked=true; AI decision=none; technical=schema_violation; verifier rejections=0; mechanism=schema_exhausted_fail_closed.

## Architecture finding

Several Benchmark 2.0 dimensions—size, color, charging-port type, screw state, battery model, date-code prefix, and manufacture/production dates—are not representable in the current production-shaped `OwnedProductEvidence` projection. The frozen systems often saw a matching model but not the extended attribute proving inclusion, exclusion, or ambiguity. This contract was intentionally not changed during Phase 15; it is future-phase work.

## Measured trade-offs

- Standalone Nemotron increased aggregate accuracy, recall, coverage, and pairwise discrimination versus deterministic_v1, but increased unsafe confirmations and reduced precision.
- Guarded hybrid prevented AI-originated unsafe confirmations in this benchmark, but retained unsafe deterministic confirmations because deterministic confirmed decisions bypass AI.
- Guarded hybrid's exact accuracy is reduced by schema-exhausted technical failures, which are not counted as correct abstentions even when the final safe decision is `needs_review`.
- Guarded hybrid used fewer requests and lower cost than standalone Nemotron, with more abstention and lower coverage.

No subjective winner is declared.
