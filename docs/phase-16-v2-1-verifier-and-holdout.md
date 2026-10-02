# Phase 16 v2.1 verifier remediation and proposed AI-value holdout

Date: 2026-09-23

Status: local review gate only. No paid runner, provider request, deployment, production shadow run,
alert, push, commit, or Git push is part of this change.

## Frozen v2 contradiction

The contradiction is preserved as historical behavior, not patched in place:

1. `hybrid_guarded_v2` escalates only when `deterministic_v2` returns `needs_review`.
2. `nemotronSafetyVerifierV2` recomputes `deterministic_v2` over the same evidence.
3. That verifier accepts a confirmation only when the recomputation returns `confirmed`.

Consequently, a case eligible for the frozen v2 AI path cannot pass the frozen v2 confirmation
verifier. The frozen matcher, verifier, deterministic result, and Phase 16 freeze manifest remain
unchanged.

## Additive v2.1 contract

The remediation is separately identified as:

- hybrid policy: `hybrid_guarded_v2_1`
- verifier: `2.1.0`
- fingerprint version: `2.1.0`
- fingerprint policy: `phase_16_guarded_v2_1_offline`

AI may select only a supplied, source-addressable association in a supplied structured recall
scope. It must return the scope index, association ID, criterion IDs, exact owned-evidence
addresses, and comparison operators. Free-text reasoning is never evidence.

An AI confirmation is accepted only when all of these checks succeed locally:

1. The deterministic v2 result was `needs_review`; confirmed and rejected decisions bypass AI.
2. The selected scope exists and is explicitly marked `ambiguous`.
3. The selected association exists and its authority/URL address the supplied official recall.
4. The association covers every mandatory scope criterion exactly once.
5. The claims cover that association exactly once and reference the selected scope/association.
6. Every criterion ID and operator equals supplied authoritative structured evidence.
7. Every owned-evidence address is the only allowed field for that criterion kind.
8. The frozen local criterion evaluator recomputes every claim as `matched`.

Any missing, conflicting, or unresolved criterion; malformed output; provider failure; invented
field; partial association; or invalid source reference leaves the result `needs_review`.
Purchase date and scan date are not representable as v2.1 claim evidence. Product name, brand,
category, recall prose, and arbitrary model prose are also excluded from the claim schema.

## Allowed ambiguity class

V2.1 may resolve exactly one narrow class: all required owned evidence and all authoritative
criteria already exist in structured form, the official criterion association is explicitly
source-addressable, frozen deterministic v2 abstains because the scope is marked `ambiguous`, and
AI merely selects the association. The verifier then recomputes every relation without trusting AI
text.

V2.1 may not extract a new identifier from prose, infer absent product evidence, repair a conflict,
substitute a date, omit a mandatory criterion, or use name/brand similarity as mandatory evidence.

This class is logically safe and makes the acceptance path reachable, but it has an important
limitation: once associations are fully structured, a future deterministic association enumerator
could often replace the model. A v2.1 paid run would therefore measure model association selection
over the frozen v2 baseline, not prove that AI is intrinsically necessary.

## Reachability and safety tests

The controlled positive demonstrates:

`deterministic_v2 = needs_review` → AI selects a real association → every mandatory comparison is
recomputed locally → `verifierAccepted = true` → `hybrid_guarded_v2_1 = confirmed`.

Negative tests reject invented serial and lot values, missing size, conflicting variant, wrong
manufacture date, purchase-date substitution, wrong scope, nonexistent criterion, partial mandatory
criteria, and an unresolved mandatory range. Additional schema tests reject product-name, brand,
purchase-date, scan-date, and prose evidence references. Leakage tests exclude labels, case IDs,
label rationales, deterministic decisions, split names, evaluation metadata, historical metrics,
purchase dates, and scan dates from the future model projection.

## Phase 15 safety role

Phase 15 remains a safety regression corpus, not an AI-value corpus. An offline advisory replay of
all 200 frozen cases preserves every decision:

- changed decisions: 0
- unsafe confirmations: 0
- expected/preserved `needs_review`: 66/66
- provider calls: 0

No Phase 15 label, dataset, result, or freeze artifact is changed.

## Proposed independent holdout

The proposed holdout contains 12 cases across 4 new CPSC families, split evenly into 4 affected
positives, 4 controlled hard negatives, and 4 genuinely insufficient `needs_review` cases. Labels
come from official evidence and controlled counterfactual construction; they are explicitly not
described as independent human-reviewed ground truth.

The four official sources are:

- CPSC 26-444, Thermos Stainless King food jars and Sportsman bottles
- CPSC 26-499, Orb Funkee squeeze toys
- CPSC 26-663, Winston Porter and Seeday dressers
- CPSC 26-780, Melissa & Doug fire truck activity boards

Every case records source, family, owned evidence, criterion references, expected decision, exact
rationale, construction type, provenance, and the reason deterministic v2 abstains. The automated
audit checks the Phase 8/9 corpus, Phase 9.1 development and holdout, and Phase 15 source inventory:

- historical family overlap: 0
- missing provenance: 0
- deterministic v2 `needs_review`: 12/12
- future AI-eligible cases: 12

The negative cases are safety probes: v2.1 does not promote AI rejection to a trusted `rejected`
decision. It accepts only locally proven confirmations, so a safe negative remains `needs_review`.
The holdout is therefore useful for confirmation safety, positive recovery, abstention, and
structured-output behavior; it is not a full three-class promotion benchmark.

Using the prior Phase 15 averages only as a planning estimate, a future 12-case run would use about
14 requests, 44,627 tokens, and $0.0218. This does not authorize a paid call. A bounded paid
evaluation is now logically meaningful after human review and an explicit freeze of this proposed
holdout and a separately reviewed runner; it is not sufficient to justify production activation or
a real-world accuracy claim.

## Production boundary

The local production policy constant remains `phase_10_guarded_v1`. A read-only linked database
query at this gate found zero persisted matches, zero non-v1 match methods, no v2 method accepted by
the production finalize RPC, and both v1 methods still enforced. V2.1 is not exported into or called
by the production orchestration path.
