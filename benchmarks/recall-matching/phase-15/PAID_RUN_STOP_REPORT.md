# Phase 15 paid-run stop report

> **STOPPED AT THE RESULTS REVIEW GATE. Do not publish a three-system Phase 15 comparison.** Nemotron v1 completed, but guarded hybrid stopped safely after both permitted attempts for one case failed the strict schema.

## Run status

- deterministic_v1: complete, 200/200 cases.
- nemotron_v1: complete, 200/200 cases; 200 requests; zero retries, provider failures, or structured-output failures.
- hybrid_guarded_v1: **partial, 113/200 cases**; 40 escalations; 41 requests; one allowed retry; stopped on two consecutive schema violations for `p15-hol-29-1`.
- Cost: Nemotron USD 0.260004 + partial hybrid USD 0.056918 = USD 0.316922, below the USD 1.60 cap.

## Complete-system measurements

| System           | Cases | Accuracy | Unsafe confirmations | Precision | Strict recall | Needs review | Coverage | Pairwise discrimination |
| ---------------- | ----: | -------: | -------------------: | --------: | ------------: | -----------: | -------: | ----------------------: |
| deterministic_v1 |   200 |    86.5% |                    3 |     95.0% |         85.1% |        44.0% |    56.0% |                   78.0% |
| nemotron_v1      |   200 |    89.5% |                    7 |     89.7% |         91.0% |        38.5% |    61.5% |                   84.0% |

No full guarded-hybrid row is shown because its run did not complete. Its prefix metrics in the JSON artifact are diagnostic only and not comparable.

## Nemotron safety failures

### Unsafe confirmations (7)

- **p15-hol-29-4** (cpsc-family-10978, expected no_match, produced confirmed): The unchanged production-shaped projection omitted the Phase 15 extended attribute carrying the contradiction; the model confirmed from the visible identifier alone. Model reasoning: The owned product's model number HT-10 exactly matches the recall scope's model number. Brand and product name also match. No conflicting identifiers. Although size and color attributes are not provided, the specific model number match is sufficient to confirm the product falls within the recall.
- **p15-hol-38-2** (cpsc-family-10859, expected no_match, produced confirmed): The unchanged production-shaped projection omitted the Phase 15 extended attribute carrying the contradiction; the model confirmed from the visible identifier alone. Model reasoning: The owned product's modelNumber KB 624-06 exactly matches one of the recall scopes (index 2). No conflicting identifiers are present. Therefore the product is confirmed to be within the recall.
- **p15-hol-38-3** (cpsc-family-10859, expected needs_review, produced confirmed): The unchanged production-shaped projection omitted the required Phase 15 extended attribute state; the model confirmed from the visible identifier instead of abstaining. Model reasoning: The owned product's modelNumber KB 624-06 exactly matches one of the recall scopes (index 2). No conflicting identifiers are present. Therefore the product is confirmed to be within the recall.
- **p15-hol-38-4** (cpsc-family-10859, expected no_match, produced confirmed): The unchanged production-shaped projection omitted the Phase 15 extended attribute carrying the contradiction; the model confirmed from the visible identifier alone. Model reasoning: Owned product's modelNumber KB 624-06 exactly matches one of the recall scopes (index 2). Product name also aligns. No conflicting evidence. Therefore the product is within the recall.
- **p15-str-48-4** (cpsc-family-10864, expected needs_review, produced confirmed): The unchanged production-shaped projection omitted the required Phase 15 extended attribute state; the model confirmed from the visible identifier instead of abstaining. Model reasoning: The owned product's modelNumber 9000-1129 exactly matches one of the recall scopes (index 0). Brand also matches. No conflicting evidence. Therefore the product falls within the authoritative recall.
- **p15-str-49-2** (cpsc-family-10845, expected no_match, produced confirmed): The unchanged production-shaped projection omitted the Phase 15 extended attribute carrying the contradiction; the model confirmed from the visible identifier alone. Model reasoning: The owned product's modelNumber RH99A2U1 exactly matches one of the two model numbers listed in recall scope 0. Product name and brand also match the recall description. No conflicting identifiers are present. Therefore the product falls within the authoritative recall scope.
- **p15-str-49-3** (cpsc-family-10845, expected needs_review, produced confirmed): The unchanged production-shaped projection omitted the required Phase 15 extended attribute state; the model confirmed from the visible identifier instead of abstaining. Model reasoning: The owned product's modelNumber RH99A2U1 exactly matches one of the two model numbers listed in recall scope 0. Product name and brand also match the recall description. No conflicting identifiers are present. Therefore the product falls within the recall scope.

### Missed affected cases (6)

All were abstentions; none were rejected.

- **p15-hol-27-1** (cpsc-family-10986, abstained_needs_review): The unchanged production-shaped projection omitted the Phase 15 extended attribute that satisfied the scope; the model therefore abstained on an otherwise affected product. Model reasoning: The owned product matches the recall's product name and brand, but lacks critical identifier data such as dateCode required by the recall's controlled scope. Without evidence of the dateCode falling within the recalled range (2510, 2511, 2512), a definitive match cannot be established, necessitating further review.
- **p15-hol-29-1** (cpsc-family-10978, abstained_needs_review): The unchanged production-shaped projection omitted the Phase 15 extended attribute that satisfied the scope; the model therefore abstained on an otherwise affected product. Model reasoning: Owned product matches brand, productName, and modelNumber exactly. However recall scope includes additional criteria for attributes.size and attributes.color which are not provided in owned product evidence. Without confirmation that the owned product's size and color fall within the recall's controlled scope (M/L size and green/black colors), a definitive match cannot be established. Therefore the evaluation requires review.
- **p15-hol-31-1** (cpsc-family-10969, abstained_needs_review): The unchanged production-shaped projection omitted the Phase 15 extended attribute that satisfied the scope; the model therefore abstained on an otherwise affected product. Model reasoning: The owned product matches the recall scope on modelNumber, lotNumber, productName, and brand. However, the recall scope includes additional criteria (manufactureMonth, size, color) that are not provided in the owned product evidence. Without confirmation of these attributes, a definitive match cannot be established, so the result is needs_review.
- **p15-hol-31-4** (cpsc-family-10969, abstained_needs_review): The unchanged production-shaped projection omitted the Phase 15 extended attribute that satisfied the scope; the model therefore abstained on an otherwise affected product. Model reasoning: The owned product matches the recall's brand, product name, model number, and lot number. However, the recall scope additionally requires specific attribute values (manufactureMonth, size, color) that are not provided in the owned product evidence. Without evidence on these attributes, we cannot confirm the product falls within the recall scope, nor do we have conflicting evidence. Therefore, the outcome is needs_review.
- **p15-str-48-1** (cpsc-family-10864, abstained_needs_review): The unchanged production-shaped projection omitted the Phase 15 extended attribute that satisfied the scope; the model therefore abstained on an otherwise affected product. Model reasoning: The owned product's modelNumber matches one of the recall scopes (9000-1129). However, the recall scope requires the attribute visibleTopCapScrew to equal 'no', which is not provided in the owned product evidence. Without confirmation of this attribute, a definitive match cannot be established, necessitating review.
- **p15-str-50-1** (cpsc-family-10851, abstained_needs_review): The unchanged production-shaped projection omitted the Phase 15 extended attribute that satisfied the scope; the model therefore abstained on an otherwise affected product. Model reasoning: Owned product matches product name, brand, and model number exactly with the recall scope. However, the recall scope includes a production date range attribute that is not present in the owned product evidence, preventing confirmation of full scope compliance. Without production date evidence, a definitive match cannot be established.

## Guarded-hybrid stop

Case `p15-hol-29-1` expected MATCH. deterministic_v1 abstained and correctly escalated. Both allowed Nemotron attempts reached the provider but returned schema-invalid output. Each attempt used 2,140 input and 1,242 output tokens and took about 22.8 seconds. The second failure exhausted the one orchestration retry. Validation, eligibility, and retry limits were not relaxed.

The partial prefix contains 0 unsafe confirmations and 2 missed affected cases, but these figures must not be compared with complete 200-case results.

## Interpretation boundary

The completed measurements show trade-offs between deterministic_v1 and standalone nemotron_v1. They do not establish a completed Phase 15 result for hybrid_guarded_v1, do not support a subjective winner, and must not be converted into Devpost claims. A future continuation would require explicit authorization and a defined policy for resuming after the recorded technical failure; no such continuation occurred here.
