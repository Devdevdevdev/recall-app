# Phase 16.2 — AI necessity audit

Date: 2026-09-23. Status: offline analysis and deterministic probe. The proposed Phase 16 v2.1
holdout is rejected, remains proposed and unchanged, and is not a source of valid accuracy metrics.
No model inference or production action was run for this audit.

## Decision

**No material AI value was found for automatic association selection under the current v2.1
contract.** A valid v2.1 confirmation is a deterministic predicate over supplied structured
criteria, supplied owned values, and a supplied association. When exactly one association satisfies
that predicate, enumeration can select it. When none do, neither AI nor enumeration can safely
confirm. When several do, the requested safe selector abstains; the current verifier does not check
global uniqueness and can accept a model's arbitrary choice of one.

This conclusion concerns `hybrid_guarded_v2_1`, not every possible AI role in Recall. Retrieval,
source extraction, and review assistance remain unmeasured hypotheses under separate safety
boundaries. They do not justify a new paid confirmation holdout today.

## 1. Exact information boundary

The deterministic v2 and verifier functions receive the same `ownedProduct` and `officialRecall`
objects passed to the v2.1 hybrid. The model projection is a narrower copy of those objects. The
table distinguishes **received** from **used for confirmation**; access to a field does not make it
eligible evidence. `OwnedProductEvidenceV2`, `OfficialRecallEvidenceV2_1`, the projection, and the
verifier are the source of truth for this matrix.

| Field/class                                                                                                                                                        | deterministic_v2                                              | Nemotron v2.1 projection                          | local verifier v2.1                                                                                                  | Form / trust                                                                                                    | May confirm?                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Owned `gtin`, `modelNumber`, `serialNumber`, `lotNumber`                                                                                                           | Receives; criterion evaluator compares                        | Sees values                                       | Receives; recomputes the same comparisons                                                                            | Structured owned evidence; manual/OCR supplied, not official authority                                          | Yes, only against a mandatory official criterion with its fixed kind/operator |
| Owned attributes: `variant`, `color`, `size`, `capacity`, `battery_model`, `charging_port_type`, `screw_state`, `date_code`, `manufacture_date`, `production_date` | Receives; compares `key`/`value`                              | Sees `key`, `value`, `valueType`, `captureSource` | Receives; compares `key`/`value`                                                                                     | Structured owned evidence; capture source is metadata, not proof of truth                                       | Yes, only when the source makes that attribute a mandatory criterion          |
| Owned product name and brand                                                                                                                                       | Receives; v2 criterion evaluator does not use                 | Sees                                              | Receives; not permitted claim addresses                                                                              | Structured owned description, weak identity context                                                             | No                                                                            |
| Owned category, purchase date, identification method                                                                                                               | Receives; v2 criterion evaluator does not use                 | Omitted                                           | Receives; not permitted claim addresses                                                                              | Structured owned context                                                                                        | No; purchase date cannot replace manufacture/production date                  |
| Scan date                                                                                                                                                          | Not in this matcher input                                     | Omitted                                           | Not in this verifier input                                                                                           | Separate workflow metadata                                                                                      | No                                                                            |
| Recall source `authority`, `externalId`, `officialUrl`                                                                                                             | Receives; does not independently authenticate                 | Sees                                              | Receives; association authority and URL must match the supplied recall                                               | Structured claimed official-source metadata; URL identity is checked, live source contents are not fetched here | Only as association provenance gate, never as eligibility by itself           |
| Recall title and date                                                                                                                                              | Receives; does not use for v2 criterion decision              | Sees                                              | Receives; not claim evidence                                                                                         | Structured official context                                                                                     | No                                                                            |
| Recall description, hazard, remedy, raw payload                                                                                                                    | Receives; ignored by v2 criterion evaluator                   | Omitted                                           | Receives; ignored for confirmation                                                                                   | Official prose/raw evidence if ingestion is valid                                                               | No under v2.1                                                                 |
| Legacy scope fields (`gtin`, model, serial/lot bounds, `additionalCriteria`)                                                                                       | Receives; v2 criterion evaluator ignores                      | Omitted except scope product name/brand           | Receives; verifier ignores for claim recomputation                                                                   | Mixed normalized source data                                                                                    | No through this v2.1 claim path                                               |
| Scope index, product name, brand                                                                                                                                   | Index is generated during v2 traversal; names not decisive    | Sees index/name/brand                             | Receives index; resolves selected scope                                                                              | Structured address plus descriptive text                                                                        | Scope index addresses evidence; names/brand cannot confirm                    |
| Criterion semantics, IDs, kinds, required flags, operators, values/lists/ranges                                                                                    | Receives; `all_of` evaluates; `ambiguous` abstains            | Sees the same structured criteria                 | Receives; checks mandatory coverage/operator and recomputes each comparison                                          | Structured normalized authoritative criteria, subject to correctness of extraction                              | Yes, only with complete and matched mandatory evidence                        |
| Criterion provenance (`authority`, URL, source field, normalization rule)                                                                                          | Receives but does not validate                                | Sees                                              | Receives, but current verifier does **not** independently validate each criterion's provenance                       | Structured provenance assertion                                                                                 | Not an independent confirmation; upstream source validation remains necessary |
| Association ID, criterion IDs, provenance                                                                                                                          | Present in the runtime recall object but ignored by frozen v2 | Sees all associations                             | Receives; checks selected association exists, covers every mandatory scope criterion, and authority/URL match recall | Structured normalized authoritative relationship, subject to upstream validation                                | Yes, as selection address only; selection adds no new fact                    |
| Model decision, claims, reasoning summary                                                                                                                          | Not supplied to v2                                            | Model emits                                       | Receives; reasoning text ignored                                                                                     | Untrusted AI output                                                                                             | Claims are accepted only after local recomputation; text never confirms       |
| Benchmark labels, split, case IDs, rationales, prior results                                                                                                       | Not matcher input                                             | Omitted                                           | Not verifier input                                                                                                   | Evaluation metadata                                                                                             | No                                                                            |

Thus the model does not possess a structured association or eligibility fact unavailable to the
deterministic caller. Frozen `deterministic_v2` ignores associations by implementation choice. The
model projection also omits the prose that might contain a yet unextracted relationship.

The existing verifier checks association authority and URL equality to the supplied recall, but
does not fetch the official page, authenticate criterion provenance, validate criterion IDs for
uniqueness, or check whether another association also matches. These are limits of the current
implementation, not a reason to relax it or an AI advantage.

## 2. Redundancy proof and contract limits

Let `A` be the finite set of supplied associations over the supplied scopes. Let `P(a, x, r)` mean:

1. `a` belongs to a supplied scope; its authority and URL equal the supplied recall's source;
2. its criterion IDs equal every required criterion ID in that scope exactly once, with at least
   one required criterion;
3. for each criterion, the prescribed owned field is present and the frozen local evaluator returns
   `matched` using the unchanged authoritative operator and value.

For an ambiguous scope, a well formed AI confirmation is accepted by the present verifier exactly
when it names an `a` for which `P(a, x, r)` holds and repeats all required claims with valid field
addresses. Claim construction is mechanical from the criterion kinds and operators. The prose
reasoning has no role in `P`. Therefore `S = { a in A : P(a, x, r) }` is enumerable without AI.
An offline selector can confirm when `|S| = 1` and abstain when `|S| = 0` or `|S| > 1`.

There are two qualifications:

- The current v2.1 verifier **does not** require `|S| = 1`: it looks up only the selected
  association, checks that association, and never counts other safe associations. Thus it would
  accept one selected association even if two were fully satisfied. The offline selector
  deliberately returns `needs_review` in that case. This follows directly from the verifier code;
  no fake competing association was added to a benchmark.
- A v2.1 association must equal _all_ mandatory IDs in its scope. Alternatives represented as
  subsets of one scope's criteria cannot pass. Real alternatives need separate scopes, each with
  its own complete conjunction, or a different reviewed contract. Clear source conjunctions must
  retain `all_of` semantics and already work in deterministic v2.

The proof assumes correct, complete authoritative normalization and true owned evidence. AI cannot
repair false source semantics, absent owned values, or a missing relationship under this contract.

The offline implementation is
[`deterministicAssociationSelectorV2_1Probe.ts`](../benchmarks/recall-matching/phase-16/deterministicAssociationSelectorV2_1Probe.ts).
It has no production import, provider, persistence, or alert path. It adds criterion provenance
completeness and ID uniqueness checks that the current verifier lacks. For clear `all_of` scopes it
also enumerates associations for comparison, although v2.1 itself would not escalate them.

## 3. Authoritative source structures examined

The review stopped after two representative new official families, one CPSC model/range table and
one Health Canada same-product/same-DIN row table. Both offer a real relationship that could be
lost by flattening columns, but neither requires AI once official rows are preserved. The probe
fixture contains representative controlled owned products, not a new holdout or an exhaustive
source inventory.

| Family / official ID                                                                                                                                                                                            | Actual products and associations                                                                                                                                                                  | Exact official fields and relationship                                                                                                                                                                                | Ambiguity and deterministic result                                                                                                                                                                                                                                                                                                         | AI-only permitted information                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| [CPSC BowFlex adjustable dumbbells, 25-311](https://www.cpsc.gov/Recalls/2025/Johnson-Health-Tech-Trading-Recalls-BowFlex-Adjustable-Dumbbells-Due-to-Impact-Hazard-Including-3-7-Million-Sold-by-Nautilus-Inc) | 2 model products, 552 and 1090; the table lists 14 serial entries/ranges for 552 (including one singleton) and 2 ranges for 1090. The probe represents 3 of these as 3 scopes and 3 associations. | `Model Number` row binds the model to the `Serial Number Range` in that row. Example: 552 + `00182M243902233–00182M243902592`; another 552 range is `X00748MAG233003670–X00748MAG233003672`; 1090 has its own ranges. | Repeated 552 model ID requires choosing a matching serial range, but the table supplies the row binding. Row enumeration resolves an in-range owned serial. A range comparison with incompatible width stays unresolved. No competing fully satisfied association was found.                                                               | None. If the row binding were missing from normalized scopes, the v2.1 model projection would not see the source table prose either. |
| [Health Canada Omnitrope, RA-82295](https://recalls-rappels.canada.ca/en/alert-recall/two-lots-omnitrope-injectable-human-growth-hormone-recalled-due-cracked-cartridges)                                       | 2 package rows, 2 scopes and 2 associations; both share DIN `02325063`.                                                                                                                           | `Product`, `DIN`, `Lot`, `UPC`, `Expiry`: box of 1 = `PR7350` + `057513215742`; box of 5 = `PR7351` + `057513215759`; both expiry `2027-04-30`.                                                                       | Flattening UPC and lot into separate lists would create a false cross-row pairing. Preserving each row as an `all_of` scope resolves it deterministically. The probe uses UPC/lot; expiry is not a v2 criterion kind and is not silently promoted. This medical product is a structural research example, not a production coverage claim. | None. The structured row binding suffices; expiry cannot be claimed under the current schema.                                        |

The four rejected proposed families were also rechecked against official CPSC pages:

| Official ID                                                                                                                                                                                                                                                     | Actual scope structure                                                                                                                                                  | Consequence for proposed cases                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [26-444 Thermos](https://www.cpsc.gov/Recalls/2026/Thermos-Recalls-8-2-Million-Stainless-King-Food-Jars-and-Bottles-Due-to-Serious-Impact-Injury-and-Laceration-Hazards)                                                                                        | `SK3000` and `SK3020` require manufacture before July 2023; `SK3010` is all units. Product/model/date relationships are explicit conjunctions.                          | The proposed SK3000 match is deterministic when manufacture date is supplied.                                                                                                                                             |
| [26-499 Orb Funkee](https://www.cpsc.gov/Recalls/2026/Orb-Funkee-Squeeze-Toys-Recalled-Due-to-Risk-of-Serious-Injury-or-Death-from-Asbestos-Exposure-Imported-by-The-Orb-Factory)                                                                               | Models `17451` and `41929` with date code `3102491A`; color variants are descriptive.                                                                                   | The proposed model/date-code match is deterministic.                                                                                                                                                                      |
| [26-663 Seeday](https://www.cpsc.gov/Recalls/2026/Winston-Porter-and-Seeday-3-Drawer-4-Drawer-and-5-Drawer-Dressers-Recalled-Due-to-Risk-of-Serious-Injury-or-Death-from-Tip-Over-and-Entrapment-Hazards-Violate-Mandatory-Standard-for-Clothing-Storage-Units) | Six listed model numbers across 3-, 4-, and 5-drawer dressers; parenthesized white/black maps model descriptions. It does not impose a separate color eligibility test. | `p16-ai-dresser-no-match` and `p16-ai-dresser-review` have incorrect labels. Model `DG-PB-0007` is listed; reported black or absent color cannot by itself remove the recall. Do not relabel/freeze the rejected dataset. |
| [26-780 Melissa & Doug](https://www.cpsc.gov/Recalls/2026/Melissa-and-Doug-Recalls-Fire-Truck-Activity-Board-Toys-Due-to-Risk-of-Serious-Injury-from-Choking-Hazard-Sold-Exclusively-at-Target)                                                                 | The source gives three packaging date codes and also affected manufacture-date wheel combinations. The proposed fixture tests only the supplied packaging-code path.    | Its proposed packaging-code match is deterministic. Missing packaging code may require review if the separate wheel evidence is unavailable.                                                                              |

The source pages are authoritative evidence. The fixture mapping from their tables into scopes is
our transparent research normalization, not a claim that CPSC or Health Canada publishes a native
`RecallAssociationV2_1` object. No source semantics were changed in the new fixtures: clear rows
are `all_of`.

## 4. Offline redundancy probe

Run command: `npm run benchmark:phase-16:ai-necessity:probe`. Result:
[`deterministic-association-selector-v2-1-probe.json`](../benchmarks/recall-matching/phase-16/results/deterministic-association-selector-v2-1-probe.json).

| Corpus                                 | Cases | frozen deterministic_v2         | offline selector                | Interpretation                                                                                                                                                                               |
| -------------------------------------- | ----: | ------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rejected proposed v2.1 data, unchanged |    12 | 12 `needs_review`               | 4 `confirmed`, 8 `needs_review` | All four intended confirmations are recoverable by enumeration on the supplied structure; the two Seeday negative/review labels remain invalid and make this unsuitable for accuracy claims. |
| CPSC BowFlex representative row cases  |     2 | 1 `confirmed`, 1 `needs_review` | 1 `confirmed`, 1 `needs_review` | Clear row conjunction already gives v2 the positive; unmatched/incomparable range abstains.                                                                                                  |
| Health Canada Omnitrope row cases      |     2 | 1 `confirmed`, 1 `rejected`     | 1 `confirmed`, 1 `needs_review` | Both avoid a false cross-row confirmation. The probe intentionally has only `confirmed`/`needs_review` outputs; v2 can issue the stronger safe rejection.                                    |

The proposed fixture's `ambiguous` flags do not establish real ambiguity. The probe results are a
counterexample to AI necessity under the stored structure, not validation of those labels or
normalizations. The four positives each have just one supplied association, so they do not test
selection among competing authoritative associations.

## 5. Possible AI roles

"Potential" means a task worth investigating, not demonstrated material value. No row below
authorizes an automatic alert from an unverified AI statement.

| Role                           | Material product value now                                                                                                                 | Safety boundary / independent verification                                                                                                                     | Automatic alert?                                                   | Deterministic substitute                                                                                          | Measurable benchmark if pursued                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Final confirmation          | **No demonstrated value under v2.1.** All accepted claims are locally recomputable; frozen v2 abstention is driven by an `ambiguous` flag. | Existing criterion recomputation and provenance checks; do not weaken.                                                                                         | Only after local proof, but the model is redundant for this proof. | Enumerate supplied complete associations.                                                                         | Source-reviewed, truly ambiguous cases with independent labels, compared to enumeration; none found here, so no holdout yet.                                                  |
| B. Association selection       | **No demonstrated value.** The proposed four positives have one association apiece; real tables have explicit rows.                        | Preserve source rows, require complete criteria and uniqueness; review multiple safe rows.                                                                     | No independent AI authority.                                       | Row/scoped association enumeration.                                                                               | Only if a real source has competing authoritative structured relationships that a deterministic enumerator cannot resolve, with a documented extra model input. None found.   |
| C. Candidate retrieval/ranking | Plausible operational value in recall discovery, unmeasured here. This is outside the v2.1 confirmation contract.                          | AI may rank already ingested official recalls; a candidate is never an alert. Recall identity and final eligibility stay official and deterministic.           | No.                                                                | Exact identifiers, lexical search, and rules are baselines and may suffice.                                       | Blind source-family split; compare recall@K/precision@K, missed-recall rate, latency, cost, and safety of final downstream decisions against current retrieval.               |
| D. Structured extraction       | Plausible workload value for turning official HTML tables/prose into proposed scopes; unmeasured here and outside v2.1 confirmation.       | Treat proposals as nonauthoritative until independent row/field validation against the official page; preserve source text and review uncertain relationships. | No before independent validation.                                  | HTML table parser, schema extraction, and deterministic rules are primary baselines.                              | Official-page corpus with human-reviewed row associations; measure exact association precision, omission, false mandatory criteria, provenance accuracy, review effort, cost. |
| E. Review assistance           | Plausible user clarity, unmeasured; no evidence it materially outperforms templates.                                                       | AI may explain a `needs_review` state, but may not fill missing identifiers or invent eligibility. Check every cited field against the criterion trace.        | No.                                                                | Deterministic criterion outcomes already identify missing/conflicting fields; templated explanations may suffice. | Blinded user task: locate the required field correctly and time to resolve, comparing AI with deterministic trace/template; score unsupported claims.                         |

No current-contract automatic matching role survives as measured, material AI value. C and D are
the only plausible distinct model tasks because they operate before normalized matching; E may
help communication. None is yet established by data, so a new holdout is premature. If one is
pursued later, define and benchmark that precise task first.

## 6. Hackathon materiality and decision gate

The running production policy is the Phase 10 `deterministic_v1` / `hybrid_guarded_v1` path with
`phase_10_guarded_v1` fingerprint policy. Nemotron is technically present as a bounded abstention
escalation in that path. The frozen Phase 15 controlled 200-case result, however, shows the guarded
hybrid made **no additional true confirmations over deterministic_v1** (both have 57 true
positives), while consuming 101 AI requests. Standalone Nemotron improved strict recall but had
more unsafe confirmations (7 versus 3). The older Phase 9.1 small holdout showed guarded gains,
but does not establish necessity under the new complete-structured-evidence contract.

Consequently, "AI is necessary for safety matching" is unsupported. A future claim that AI
assists retrieval, extraction, or review would require task-specific measurements and would still
say that deterministic evidence controls automatic alerts. This document does not draft submission
language. **No new paid v2.1 holdout is justified. Stop at this gate.**

## 7. Production and quality gates

The probe and its controlled source fixtures are isolated under `benchmarks/recall-matching/phase-16`
and a dedicated test. Frozen `deterministic_v2`, the proposed holdout, Phase 15 data, production
orchestration, and the production policy constant were not edited by this audit. The local
production selector remains `phase_10_guarded_v1`; no remote production state was changed or
re-queried in this turn.

| Gate                                                           | Result                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                                | PASS. This includes typecheck, lint, formatting, historical tests, historical freeze guards, Phase 15 freeze guard, Phase 16 frozen verification, v2.1 tests, and the new audit tests.                                                                   |
| `npm run test:phase-16`                                        | 34/34 PASS.                                                                                                                                                                                                                                              |
| `npm run test:phase-16-v2-1`                                   | 19/19 PASS. Its old "proposed holdout" structural test does not validate label semantics; the independent review still rejects that dataset.                                                                                                             |
| `npm run test:phase-16-ai-necessity`                           | 2/2 PASS.                                                                                                                                                                                                                                                |
| Phase 9.1, Phase 15, and Phase 16 freeze guards run separately | PASS, PASS, PASS.                                                                                                                                                                                                                                        |
| Deno 2.9.6 check                                               | PASS for the new probe, v2/v2.1 server modules, production orchestrator, and both Edge entry points. This only typechecked code; no Edge Function ran.                                                                                                   |
| `git diff --check`                                             | PASS.                                                                                                                                                                                                                                                    |
| Local secret-pattern scan                                      | No credential/private-key pattern found in the new audit files or the wider non-environment repo scan. One pre-existing documentation command assigning `NEBIUS_API_KEY` was inspected with its value redacted and classified as an example placeholder. |

`npm run check` incidentally regenerated `benchmarks/recall-matching/phase-15/audit.json` with a
new timestamp and different formatting. That unrelated tracked diff was restored exactly; the
Phase 15 freeze artifact remains byte-clean. No deployment, migration, provider call, paid run,
shadow run, alert, commit, or push occurred.

## 8. Self-evaluation

| Axis          | Score | Evidence / gap                                                                                                                                                                 |
| ------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accuracy      |   4/5 | Claims are tied to source pages, code paths, and a reproducible probe. The new source fixtures sample BowFlex rows rather than exhaustively normalizing all 16 entries.        |
| Completeness  |   4/5 | All requested decision classes and quality gates are covered. Retrieval, extraction, and review utility remain unmeasured by design, so no claim of their materiality is made. |
| Clarity       |   4/5 | The information matrix, finite-set proof, and case results distinguish input availability from evidence use; the long matrix is necessarily dense.                             |
| Actionability |   5/5 | The stop decision, safe future benchmark conditions, code, fixtures, and exact commands are recorded.                                                                          |
| Conciseness   |   4/5 | The report is long because the requested field-by-field boundary and five-role audit require detail; the summary decision is stated first.                                     |

Overall: **4.2/5**. Highest-impact next improvement, if this work is resumed under a new scope:
independently normalize and audit a broader set of official table rows before measuring a distinct
retrieval or extraction task. This is not a recommendation to create a v2.1 paid holdout now.
