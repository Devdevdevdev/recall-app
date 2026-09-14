# Recall matching benchmark

This directory contains Recall's executable, non-AI reference benchmark for product-to-recall
matching. It measures `deterministic_v1` on a frozen internal evaluation set before any Nemotron
integration. Normal benchmark execution is offline, read-only, and makes zero model or network
calls.

The safety boundary is absolute: CPSC establishes that a recall exists. A matcher evaluates only
whether controlled owned-product evidence appears to fall within that existing authoritative
recall. It may not invent, broaden, or rewrite a recall.

## Files and versions

- `cases.v1.json`: dataset version `1`, containing 30 controlled cases and 12 compact normalized
  CPSC notice records
- `benchmark.schema.json`: JSON Schema for the normalized dataset/reference format
- `dataset.ts`: dependency-free validation, privacy checks, and recall-reference hydration
- `metrics.ts`: shared three-class metric definitions
- `run.mjs`: human- and machine-readable benchmark runner
- `validate.mjs`: standalone dataset validator

The common match output schema is `1.0.0`; the matcher is `deterministic_v1`. Any later semantic
change must receive a new dataset, matcher, or output-schema version as appropriate.

## Dataset construction and provenance

The source records are field-reduced copies of public results from the official CPSC Recall
Retrieval API, retrieved on 2026-09-14. Every record retains the CPSC external ID, official CPSC
URL, recall date, normalized scopes used by the matcher, and a compact statement of important
unmodeled evidence. The benchmark stores only evidence required by the cases, not CPSC history.

The 30 cases are balanced by expected decision:

| Expected label | Count | Label provenance            |
| -------------- | ----: | --------------------------- |
| `match`        |    10 | `official_exact_evidence`   |
| `no_match`     |    10 | `controlled_counterfactual` |
| `needs_review` |    10 | `source_ambiguity`          |

Seven positive controls use exact valid GTINs explicitly supplied by CPSC. Three more use exact
official model plus required lot/serial-prefix evidence that remains in CPSC source prose after
Phase 7 normalization. Those three are deliberately valid expected matches that
`deterministic_v1` must abstain on, giving Phase 9 a measurable, traceable improvement target.
Negative controls pair public product-style evidence from one recall with a different, unrelated
CPSC recall whose explicit valid GTIN scopes contradict it; disjoint product names ensure a broad
descriptive scope does not remain plausible. Ambiguous cases preserve incomplete situations where
model, lot, serial prefix, date, or variant restrictions cannot resolve the product.

No case is labelled `human_reviewed`. Codex-derived labels never claim human review. This is an
internal Recall evaluation set, not a population sample and not evidence of clinical, statistical,
or general real-world performance.

## Privacy

Owned products are controlled benchmark objects derived from public recall evidence. The validator
rejects user/auth/email/UUID/OCR-shaped fields. The dataset contains no real users, private
inventory, ownership metadata, email addresses, images, or private OCR output.

## Decisions and confidence

The runner maps the common contract as follows:

- `confirmed` → benchmark `match`
- `rejected` → benchmark `no_match`
- `needs_review` → benchmark `needs_review`

Confidence is a deterministic heuristic evidence-strength score. It is not statistically
calibrated: `0.90` does not mean a 90% probability that a product is recalled. Product-name overlap
alone never confirms. Ambiguous or incomplete evidence intentionally produces `needs_review`.

## Metrics

- **Exact 3-class accuracy:** predictions equal expected labels across all three classes.
- **MATCH TP/FP/FN/TN:** one-vs-rest counts for the positive `match` class.
- **MATCH precision:** TP / (TP + FP).
- **Strict MATCH recall:** confirmed expected matches / all expected matches. A positive abstention
  is a false negative for this metric and is also reported as an unresolved positive.
- **False-positive rate:** FP / (FP + TN), when the denominator exists.
- **Needs-review rate:** predicted `needs_review` / all cases.
- **Decision coverage:** predictions that are `match` or `no_match` / all cases.
- **Confusion matrix:** rows are expected and columns are predicted in the order `match`,
  `no_match`, `needs_review`.
- **Latency:** one-pass total duration plus average, p50, and p95 local matcher time sampled with
  `performance.now`. Sub-millisecond values vary by machine/runtime and should not be overread.
- **AI cost:** explicitly zero calls and USD 0 for the deterministic baseline.

Failures and all predicted abstentions include the case ID, expected/predicted labels, short
deterministic reasoning, and matched/conflicting identifiers. These lists are inputs for later
Phase 9 prompt and schema work.

## Run

Node.js 22.13 or newer is required by the Expo 57 project.

```bash
npm run benchmark:matching:validate
npm run test:matching
npm run benchmark:matching
```

Use `--json` for machine-readable stdout or `--output <path>` to write a result deliberately:

```bash
npm run benchmark:matching -- --json
npm run benchmark:matching -- --output benchmarks/recall-matching/results/local.json
```

Generated results are not committed automatically. A committed result must state its timestamp,
dataset/matcher/schema versions, runtime, case count, and Git commit when available.

## Phase 9 comparison and limitations

Nemotron will later receive the same hydrated `OwnedProductEvidence` and
`OfficialRecallEvidence`, produce the same schema-validated `MatchEvaluation`, and be scored by the
same metric code on exactly these cases. Phase 8 contains no prompt, model choice, API key, model
call, or AI result.

This small control set emphasizes explicit identifiers and known ambiguity boundaries. It does not
measure prevalence, calibration, multilingual text, every manufacturer numbering scheme, or live
candidate-database query performance. It should grow only with traceable labels and explicit
versioning.
