# Phase 16.3 deterministic_v2 production activation design gate

**State: prepared, inactive, not approved for deployment.** The active Edge
entry point still runs `phase_10_guarded_v1`. No migration in this phase has
been applied, no Edge Function deployed, and no v2 alert or push created.

## Policy and evidence boundary

The proposed identity is `phase_16_deterministic_v2`: bounded authoritative
recall retrieval, the existing bounded `get_recall_candidates` query and local
candidate filter, reviewed structured criteria, `deterministic_v2`, immutable
evaluation, then `confirmed` / `rejected` / `needs_review`. No Nebius client,
model retry, AI escalation, or AI-derived confirmation belongs to this path.
Only a v2 `confirmed` result can become alert eligible; neither other decision
does. The existing v1 entry point is retained as the rollback selector.

The production projection in `productionPolicyV2.ts` intentionally maps no
criterion from a source title, description, `additional_criteria`, a CPSC
recall-level UPC, or Health Canada prose. It accepts a separately reviewed
`RecallCriterionSet` with explicit `all_of` or `ambiguous` semantics and field
provenance. A scope lacking that set remains `needs_review`. CPSC and Health
Canada are both authoritative sources, but the current automatic ingest does
not create these reviewed sets. Therefore the proposed policy currently has
no justified automatic confirmations from those unreviewed live records.

## Database contract audit and proposed migration

The v1 `get_recall_matching_batch` and `get_recall_candidates` RPCs retrieve
bounded authoritative notices and product candidates. The candidate RPC does
not return `safety_attributes`, and the recall batch omits stable scope IDs and
reviewed v2 criterion sets. The Phase 16 product migration adds validated
`safety_attributes` to `owned_products`, but does not change those RPCs.

The v1 `claim_recall_match_evaluation` checks a SHA-256 fingerprint, product and
notice revisions, a per-pair lease, and the current `recall_matches` fingerprint.
The v1 `finalize_recall_match_evaluation` accepts only `deterministic_v1` and
`hybrid_guarded_v1`, upserts the unique `(owned_product_id, recall_notice_id)`
row, and creates one alert per match row on confirmation. Thus reusing it for
v2 would overwrite v1 evidence and change the meaning of an existing alert.
The alert read model joins `alerts` to that mutable row and counts only rows
whose _current_ status is `confirmed`. This must be reviewed before any live
v2 alerts are enabled.

The new forward-only, **unapplied** migration
`20260923142030_phase_16_deterministic_v2_contract.sql` proposes:

- a reviewed criterion binding keyed to source scope ID; source ingestion
  replaces scope rows, so a refresh invalidates the binding;
- a service-role-only v2 scope read RPC that returns stable scope IDs and
  includes reviewed criteria only when their source URL matches the current
  official notice;
- immutable, version-separated v2 evaluation rows keyed by pair and fingerprint;
- unique per-pair v2 alert eligibility records, which are not alerts or push
  jobs and are marked revoked if later v2 evidence becomes unresolved or
  rejected; and
- a service-role-only v2 finalization RPC that validates the existing lease,
  authoritative recall and both revisions, writes once, returns `unchanged`
  on replay, and creates eligibility only for a first confirmed evaluation
  when no legacy alert exists.

The v1 finalizer and applied migrations are not edited. The proposed migration
does **not** activate alert delivery. Before activation, the v2 Edge adapter
must read the new scope RPC by scope ID, fetch candidate `safety_attributes`
from the current product revision, validate criterion provenance against the
current official source, and connect v2 eligibility to an immutable alert
snapshot/read model. A service-role function cannot independently prove a
decision from JSON arguments; only the trusted Edge evaluator may call it,
with the criterion trace retained for audit.

## Finalization and history

V2 evaluation is a new observation; it never rewrites `recall_matches` or
`alerts`. The proposed finalizer checks a live lease and unchanged product and
notice revisions. It inserts one immutable row per `(pair, fingerprint)` and
returns `finalized`; a repeated fingerprint returns `unchanged`. Confirmation
may create one eligibility marker per pair; rejection and review create none
and revoke a still-pending marker after changed evidence.
No real alert is created by this gate. An existing alert blocks duplicate v2
eligibility. This is deliberately stricter than the current v1 upsert.

V1 confirmed matches should **not** be bulk re-evaluated when v2 is enabled.
Initial cohorts should be new pairs only, restricted by recall IDs and the
existing `maxRecalls` / `maxCandidatePairs` limits. Later targeted cohorts may
include v1 review/rejected pairs after a reviewed evidence mapping exists.
Existing v1 confirmed pairs need separate manual safety review. If a targeted
v2 evaluation yields `needs_review` or `rejected` after a v1 confirmation,
record it as a contested/reversed observation, keep the original alert visible
with its original evidence, stop new pushes, and require an explicit user
visible correction path. No historical alert is silently deleted.

Rollback is a policy-selector change back to `phase_10_guarded_v1` after
disabling v2 scheduling. Keep the additive migration, v2 evaluations,
eligibility records, old matches, and old alerts. No destructive rollback SQL
or historical data rewrite is needed. A v1 run must not overwrite v2 alert
snapshots; this invariant requires the follow-up alert contract before live
activation.

## Fingerprints and re-evaluation

The prepared production fingerprint follows Phase 16's canonical SHA-256,
version-separated evidence-document approach with a production-only policy
domain. It does not call or change the frozen v2 benchmark fingerprint. It
sorts object keys, scope documents, and relevant safety attributes. It excludes
database IDs, retrieval/evaluation timestamps, purchase date, capture source,
and all safety attributes that no reviewed criterion uses. It also excludes
raw payload metadata; material changes must appear in the reviewed normalized
criteria. V1 fingerprint code and existing hashes remain unchanged.

A v2 re-evaluation occurs when the policy/schema identity, official source
identity, normalized scope/criterion evidence, candidate-relevant product
identity, or a safety attribute used by a reviewed criterion changes. A source
refresh removes its old reviewed scope binding and leaves the pair unresolved
until re-review. Cosmetic timestamps and unused attributes do not trigger v2.
The current v1 claim RPC does not compare against the v2 evaluation table, so
the v2 finalizer's unique key supplies replay idempotency. A future scheduler
should skip already-stored fingerprints before claiming to avoid extra writes.

## Activation cohort, costs, and source coverage

Start with an explicit allowlist of official recall IDs and new, never-matched
pairs. Keep the production v1 page sizes of 25 recalls and 50 candidate
products and the request cap of 100 recalls/1,000 candidate pairs. No blanket
historical backfill. Expand only after source-reviewed criteria and local
end-to-end evidence. A candidate remains only a candidate until all mandatory
criteria pass.

Expected Nebius calls and token cost for `phase_16_deterministic_v2`: **0 and
$0**. Pure matcher compute removes network inference latency and retry time;
actual latency has not been measured. Candidate volume is unchanged by design.
The separate evaluation and eligibility records add up to one evaluation
insert and one eligibility insert per new confirmed fingerprint, plus existing
claim/lease writes. Retrieving safety attributes and reviewed scopes will add
read load. No production throughput or dollar savings are claimed yet.

## Truthful hackathon language (draft only)

“Phase 15/16 testing showed that AI was not required for safe automatic
confirmation once authoritative structured evidence was modeled correctly.
Benchmarking caused Recall to move critical confirmation logic toward
deterministic evidence verification. Nemotron remains a researched component;
any future role requires separate measured evidence.”

Do not claim AI improved production safety, that Nemotron is necessary for
matching, or 100% real-world accuracy. The frozen controlled benchmark is not
independent field accuracy evidence.

## Local verification at this gate

The local database was reset only through migration `20260923040130`; the
Phase 16.3 migration-history count remains zero. The new migration and pgTAP
fixture were executed inside one transaction that ended with `ROLLBACK`.
The runner used the existing bounded candidate RPC, the actual pure v2
evaluator and production fingerprint, the existing lease claim, and the
proposed v2 finalizer. Its 21 pgTAP assertions passed: one confirmed pair
persisted and became eligible once; review and rejection persisted without
eligibility; repeat evaluation wrote no duplicate; changed unresolved evidence
revoked eligibility; an official URL change invalidated the reviewed binding;
no real alert or legacy match was written. The test does
not exercise a live alert writer because none is authorized at this gate.

`npm run check`, the new policy tests, the existing Phase 10 and Phase 16
pgTAP suites, local database lint, Deno checks, and all three historical
freeze guards passed. The Phase 10 pgTAP fixture was updated with the
current required `source_key` field; no Phase 10 runtime implementation was
changed. `npm run check` regenerated the Phase 15 audit timestamp/format;
that incidental diff was restored exactly before this report. The active
production path did not change, so mobile platform exports were not required.

## Remaining approval gates

1. Review the criterion source binding, provenance validator, and CPSC/Health
   Canada evidence coverage. Do not derive weak structured criteria from prose.
2. Complete and test the inactive v2 Edge adapter, product safety evidence
   fetch, and live alert snapshot/read model, including reversal display and
   duplicate prevention.
3. Apply the additive migration only after local reset, pgTAP, DB lint, and a
   transaction-scoped production-shaped finalization test pass.
4. Deploy the changed Edge Functions, then explicitly select
   `phase_16_deterministic_v2` for a bounded cohort with rollback monitoring.
5. Approve any broader re-evaluation cohort and truthful public claims
   separately. No paid v2.1 benchmark is proposed.
