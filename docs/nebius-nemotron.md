# Nebius Token Factory and NVIDIA Nemotron

Phase 9 adds a server-only `nemotron_v1` evaluation path and measures it against the exact frozen
Phase 8 dataset. Phase 9 itself does not create a production endpoint, write database rows,
generate alerts, or change recall-source data; Phase 10 later reuses only the frozen guarded Phase
9.1 policy in production.

## Provider boundary and secrets

The standards-based client lives in `supabase/functions/_shared/nebius/`; the prompt, output schema,
and matcher live beside the deterministic matcher in `supabase/functions/_shared/matching/`. The
benchmark is a local server process. No module under `app/` or `src/` imports the provider.

`NEBIUS_API_KEY`, `NEBIUS_MODEL_ID`, and `NEBIUS_BASE_URL` are read from the server process. The
client fails closed when any value is absent, validates the credential destination as a
credential-free HTTPS URL, never serializes configuration into results, discards provider error
bodies, and never logs headers. The API key must never use an `EXPO_PUBLIC_` name.

Phase 9 used:

- endpoint: `https://api.tokenfactory.us-central1.nebius.com/v1/chat/completions`
- model: `nvidia/nemotron-3-super-120b-a12b`
- upstream license: [NVIDIA Nemotron Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/)
- matcher: `nemotron_v1`
- prompt: `1.0.0`
- common schema: `1.0.0`
- temperature: `0`
- maximum output tokens: `2,400`
- timeout: `120,000 ms`
- maximum retries: two per case, only for 429, selected 5xx, timeout, or network failure

The model-access preflight confirmed the exact model. No model substitution occurred.

## Structured output

The target model's live verbose metadata advertised `tools` and `reasoning`, but did not advertise
JSON-schema response format. A development smoke request using `response_format=json_schema` was
rejected before inference. Phase 9 therefore uses one named function tool,
`submit_recall_match_evaluation`, with `strict: true` and the same JSON Schema as its parameters.
The tool is forced by name. Its JSON arguments are parsed and independently validated locally.

Validation rejects invalid JSON, unknown decisions, missing or unexpected fields, out-of-range
confidence, malformed identifier evidence, and empty reasoning. Refusal, empty output, invalid
JSON, schema failure, or provider failure becomes a safe `needs_review` application fallback while
remaining a separately disclosed benchmark technical failure. A technical fallback cannot count
as a correct expected `needs_review` result.

Provider, model, matcher, prompt, and schema metadata are attached after validation and cannot be
controlled by the model. Confidence remains a model-reported heuristic, not a calibrated
probability.

## Label isolation and frozen evidence

The dataset SHA-256 before and after the run was:

`c547d61df8e9eacc1d47d46ec505e409d88cd23795abc20cbbfb4e96f67fb3f8`

`projectBenchmarkCaseForNemotron` constructs a new object containing only `ownedProduct` and the
referenced `officialRecall`. Tests parse the serialized user message and prove it contains no case
ID, expected label, label provenance, benchmark reason/notes, baseline prediction, metrics, or
confusion data. No web search or additional evidence is used during inference.

The prompt was fixed before the primary run. There were 30 sequential primary evaluations, one per
case. The frozen set was not used for prompt variants, and no case was rerun after results were
observed.

## Measured results

The run completed on 2026-09-14. Four responses failed the structured-output gate, so exact
accuracy excludes the one technical fallback that happened to share an expected `needs_review`
label. The three-class confusion matrix still shows application-safe fallback decisions; this is
why its visible diagonal sums to 22 while integrity-adjusted exact accuracy is 21/30.

| Metric                     | `deterministic_v1` |  `nemotron_v1` |
| -------------------------- | -----------------: | -------------: |
| Exact three-class accuracy |              90.0% |          70.0% |
| MATCH TP / FP / FN / TN    |     7 / 0 / 3 / 20 | 9 / 4 / 1 / 16 |
| MATCH precision            |             100.0% |          69.2% |
| Strict MATCH recall        |              70.0% |          90.0% |
| False-positive rate        |               0.0% |          20.0% |
| Needs-review rate          |              43.3% |          33.3% |
| Decision coverage          |              56.7% |          66.7% |

Nemotron confusion matrix, rows expected and columns predicted in
`[match, no_match, needs_review]` order:

- `match`: `[9, 0, 1]`
- `no_match`: `[0, 7, 3]`
- `needs_review`: `[4, 0, 6]`

The three deterministic unresolved positives all became valid Nemotron confirmations:

- CPSC 10588: `match`
- CPSC 10826: `match`
- CPSC 10930: `match`

The gain in strict recall is not a safe overall improvement. Nemotron introduced four false
positives on ambiguous controls: `ambiguous-peony-name-only`, `ambiguous-bottle-item-number`,
`ambiguous-dive-stick-model-sale-date`, and `ambiguous-fire-pit-model-association`. It also returned
`needs_review` for one expected positive that deterministic matching confirmed. Phase 10 must not
use `nemotron_v1` to generate automatic alerts without a revised, independently evaluated safety
policy.

Structured-output success was 26/30 (86.7%). There were zero final provider/API failures and zero
retries. Technical failures were three empty tool outputs and one invalid JSON tool argument.

Remote inference latency was 141.928 seconds total, 4.731 seconds average, 4.303 seconds p50, and
9.832 seconds p95. This is not directly comparable to the local deterministic matcher's
sub-millisecond CPU measurements.

Nebius returned usage for all 30 primary requests: 53,046 input tokens, 50,786 output tokens, and
103,832 total tokens. Separate reasoning-token counts were not returned and are recorded as null,
not zero. The live verbose models endpoint reported USD 0.30 per million input tokens and USD 0.90
per million output tokens at the run timestamp. The calculated primary benchmark cost is
USD 0.0616212. Preflight, metadata, and development smoke traffic are excluded from that amount.

## Comparison and hybrid simulation

Nemotron improved three cases, worsened nine when technical failures and false positives are
included, and left eighteen unchanged. The read-only `hybrid_simulation_v1` reuses the primary
Nemotron result only where deterministic matching abstained. It reaches 83.3% accuracy, 100% strict
recall, 80.0% coverage, and a 20.0% false-positive rate. The four false positives make this hybrid
unsafe for production alerting; it is analysis only.

Machine-readable evidence is stored in:

- `benchmarks/recall-matching/results/deterministic-v1.json`
- `benchmarks/recall-matching/results/nemotron-v1.json`
- `benchmarks/recall-matching/results/comparison.json`

## Reproduction

These commands intentionally separate offline validation, model access, one synthetic smoke test,
and the paid frozen evaluation:

```bash
npm run benchmark:matching:validate
npm run test:nemotron
npm run benchmark:matching:nebius:preflight
npm run benchmark:matching:nemotron:smoke
npm run benchmark:matching:nemotron
```

The Nemotron runner refuses to overwrite existing result files. Archive or deliberately select new
output paths before a future explicitly versioned evaluation. Do not rerun `nemotron_v1` on the
frozen set for prompt tuning.

## Evidence suitable for a submission

The measured evidence supports only a bounded statement: Recall evaluated NVIDIA
`nvidia/nemotron-3-super-120b-a12b` through Nebius Token Factory against a frozen 30-case,
CPSC-backed internal benchmark using a server-only strict structured-output boundary. It does not
support a claim of general real-world accuracy, calibrated confidence, or production-safe alerting.

## Phase 9.1 guarded hybrid evaluation

Phase 9.1 does not replace or relabel the historical Phase 8/9 artifacts. It adds a separate
`hybrid_guarded_v1` policy and independent holdout. The historical dataset remains byte-identical at
SHA-256 `c547d61df8e9eacc1d47d46ec505e409d88cd23795abc20cbbfb4e96f67fb3f8`.

The hybrid first runs `deterministic_v1`; its 16 definitive holdout decisions bypassed AI. Only 20
abstentions were projected for Nemotron. The projection omitted labels, provenance, benchmark
reasons, case IDs, baseline results, metrics, private data, and secrets. It made no search or web
request. The model used prompt `1.0.0`, temperature 0, a 2,800-token output ceiling, and the forced
strict `submit_guarded_recall_match_evaluation` tool. Client retries were disabled so the hybrid
orchestrator was the only retry authority.

The model can propose controlled claims but cannot directly authorize a confirmation. A local
verifier resolves each claim back to the supplied owned field and official scope/raw-evidence field,
then checks exact identifiers, safe prefixes/ranges, identity support, source association, criteria,
and date semantics. Names or brand alone, copied values without a real comparison, ambiguous
associations, and purchase-date substitution cannot confirm. AI rejection is advisory. Every
failure or unsafe/unverifiable result returns `needs_review`.

The 24-case development set and 36-case holdout use 8 and 12 separate official CPSC recall records,
respectively, and are disjoint from each other and the historical 12-source set. No paid model run
was performed during development: there were zero model-backed prompt variants and one
policy/prompt version was frozen. After freezing the policy, the holdout SHA-256 was
`3dd19b7075cc7f865816f7217984d1e98f6fd83e1aea2cba6ebbc4554502e608`; the manifest also pins the
development set, historical artifacts, and policy implementation hashes.

The one authorized holdout run completed on 2026-09-14:

| Metric                     | `deterministic_v1` | `hybrid_guarded_v1` |
| -------------------------- | -----------------: | ------------------: |
| Exact three-class accuracy |              77.8% |               88.9% |
| MATCH TP / FP / FN / TN    |     8 / 0 / 4 / 24 |     12 / 0 / 0 / 24 |
| MATCH precision            |             100.0% |              100.0% |
| Strict MATCH recall        |              66.7% |              100.0% |
| False-positive rate        |               0.0% |                0.0% |
| Needs-review rate          |              55.6% |               44.4% |
| Decision coverage          |              44.4% |               55.6% |

The hybrid confusion-matrix rows `[match, no_match, needs_review]` are `[12, 0, 0]`, `[0, 8, 4]`,
and `[0, 0, 12]`. Four deterministic positive abstentions became locally verified confirmations;
there were no worsened cases, false positives, or unresolved expected positives.

The 20 escalations used 24 inference requests. Four primary responses had schema violations and
used their one allowed retry; all four retries succeeded. There were no provider-failure attempts,
no second retries, and primary structured-output success was 16/20 (80.0%). Final success after
retry was 20/20 (100.0%), or 20 valid outputs across 24 attempts. Escalated latency was 135.608
seconds total, 6.780 seconds average, 6.494 seconds p50, and 10.342 seconds p95. Overall hybrid
latency was 135.613 seconds total, 3.767 seconds average, 2.854 seconds p50, and 10.342 seconds p95.
Provider usage was 50,334 input tokens plus 31,895 output tokens, 82,229 total. Reasoning-token
counts were unavailable and remain null. Live metadata reported USD 0.30/M input and USD 0.90/M
output; actual calculated cost was USD 0.0438057.

Machine-readable Phase 9.1 evidence is stored in:

- `benchmarks/recall-matching/phase-9-1/results/deterministic-holdout-v1.json`
- `benchmarks/recall-matching/phase-9-1/results/hybrid-holdout-v1.json`
- `benchmarks/recall-matching/phase-9-1/results/holdout-comparison.json`

The result is evidence for the guarded architecture on this small controlled holdout only. Phase
9.1 itself adds no production endpoint, persistence, monitoring, or alert policy.

## Phase 10 production boundary

Phase 10 provides a POST-only administrative Edge Function protected by `RECALL_MATCHING_KEY`. The
Expo app contains no provider dependency or call path. The function pins the same model identifier
and exact `https://api.tokenfactory.us-central1.nebius.com/v1/` base URL, reads the API key only from
server secrets, and configures the transport with `maxRetries: 0`.

The production orchestrator always runs `deterministic_v1` first. Definitive deterministic results
do not initialize a provider client. Only `needs_review` enters `hybrid_guarded_v1`, subject to a
per-run attempt budget. The existing one eligible structured-output retry remains inside that
budget. Missing configuration, provider errors, invalid output, unverifiable evidence, and budget
exhaustion fail to `needs_review` and cannot create an alert.

Phase 10 deliberately narrows the production model projection to owned-product fields and
normalized authoritative notice/scopes. It sets `rawEvidence` to `null`, so preserved raw CPSC
payloads are used for provenance and canonical change detection but not sent as new model evidence.
This means some cases that depended on Phase 9.1 benchmark-only raw-evidence claims will remain for
review; the production implementation does not weaken the verifier to gain coverage.

No paid production E2E inference was sent during Phase 10 implementation. The deterministic path
can be verified with `maxNebiusCalls: 0`. Any future E2E that may call Nebius must stop first,
disclose the targeted candidate/attempt limits, estimate the cost from current provider pricing,
and obtain explicit approval. See [automatic-recall-loop.md](automatic-recall-loop.md).
