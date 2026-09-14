# Recall matching benchmark (foundation)

This directory reserves the evaluation contract for the future product-to-authoritative-recall
matcher. It intentionally contains no results, model calls, or fabricated labels.

```json
{
  "caseId": "...",
  "ownedProduct": {},
  "officialRecall": {},
  "expected": "match | no_match | needs_review",
  "reason": "human-labelled explanation"
}
```

The same owned-product and CPSC-backed recall evidence will be evaluated by a deterministic
identifier/text baseline and a schema-validated Nemotron structured-reasoning layer. Planned
metrics: accuracy, precision, recall, false positives, false negatives, needs-review rate,
latency, structured-output success rate, and cost per evaluation after AI is introduced.
