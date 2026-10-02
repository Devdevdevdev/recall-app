# Phase 16.12 stop report: multi-rule scopes, remote-safe tests, backfill readiness

Status: implemented and verified locally only. No production migration, backfill, deployment,
page fetch, human review, reconciliation, cohort, selector change, consumer read, push, Nebius
call, commit, or push. deterministic_v2 stays inactive.

## 1. Worktree handoff

- Same worktree. Nothing was reset or discarded; the modified tracked files and untracked Phase 16
  files match the 16.11 handoff.
- The three accepted migrations are byte-identical before and after this phase: 16.9 `615c88ca…5b7`,
  16.10 `89a96abc…0540`, 16.11 `4e8589be…c0ce`.
- New: one migration, one pgTAP file, one Node test file, two scripts (HTTP proof, backfill
  rehearsal), the manifest builder and manifest, and this report.
- Edited (superseded assertions edited, never deleted):
  - the 16.11 pgTAP file
  - the 16.11 and 16.4 Node tests
  - the 16.11 HTTP script
  - the remote-safe test
  - the 16.3 template and its verifier
  - `orchestratorV2.ts`, `ingestionGate.ts`, `package.json`

## 2. Multi-rule-set schema

- `private.recall_scope_rule_sets_v2`: one append-only row per materialized rule set.
  - Key: `(scope_id, criteria_sha256)`.
  - Columns: `rule_set_fingerprint`, `revision_id`, `conjunction_group`, `criteria`, `source_url`,
    `materialized_by`.
  - A guard trigger re-runs the builder on insert and refuses update, delete, and truncate, even
    from the owner.
- `private.cpsc_reviewed_rule_set(revision, group)` is the single builder. It wraps the 16.11
  conjunction builder and adds identity, address, and fingerprint checks.
- `get_recall_v2_scopes` keeps its signature. `reviewed_criteria` is now an envelope, or NULL when
  no rule set is served:

```
{ "semantics": "any_of", "schema": "recall_rule_sets_v1", "scopeId": …,
  "ruleSets": [ { "semantics": "all_of", "criteria": [...], "review": {…16.11 fields…,
      "schema": "recall_rule_set_v1", "ruleSetFingerprint", "identityFingerprint",
      "scopeSemanticFingerprint", "sourceAddressHashes" } }, … ],
  "coverage": { "currentRevisionId", "proposedRuleSets", "unattributedRuleSets",
      "servedRuleSets", "complete" } }
```

- Every served rule set is re-verified against the builder on every read, as in 16.11.
- `recall_scope_criteria_v2` (one binding per scope) is superseded. Its guard now refuses every
  write. Currently valid 16.11 bindings are copied into rule sets by the migration (production: 0).

## 3. Deterministic OR-of-AND semantics

- The frozen `evaluateDeterministicMatchV2` already confirms when any explicit all-of scope is
  fully satisfied. The frozen Phase 16 benchmark projects each `scopeRule` as its own scope.
- The new versioned adapter `deterministicRuleSetsV2.ts` (`deterministic_v2_rule_sets_v1`) expands
  each rule set into its own all-of unit. It then calls the frozen core unchanged: OR across rule
  sets, AND inside each. Nothing is flattened.
- It adds a per-unit trace. It also adds one safety rule: when coverage is incomplete, a
  "rejected" becomes `needs_review` (`rejectionWithheld`). Contradicting only the served rule sets
  cannot prove a product is outside the recall. This never adds a confirmation.
- The production layer `ruleSetsV2.ts` validates the envelope:
  - Each rule set passes the unchanged 16.11 ledger validator.
  - It must reproduce its semantic fingerprint.
  - Invalid rule sets are dropped individually, and any drop marks coverage incomplete.
- The orchestrator evaluates through this path. Evaluations stay `deterministic_v2` / `2.0.0`.
- Frozen files are untouched: the Phase 16 freeze covers 7 implementation files, 4 benchmark
  files, and 6 review files.

## 4. Char-Broil 9/9

The input is the frozen page, run through the production extractor and proposal code. That gives
18 unreviewed members forming 9 conjunctions: one model AND the date-code set {2510, 2511, 2512}.

| Layer                                  | Result                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| pgTAP (the real 18 proposals)          | 9 materialize on one scope; 9 served; 9 distinct fingerprints; coverage complete         |
| Node (extractor → envelope → matcher)  | 9/9 usable; each model with a listed code confirms through exactly one rule set          |
| HTTP (worker page path + JWT reviewer) | 18 proposals → 18 decisions → 9 materialized → 9/9 accepted by the TS validator (parity) |

Every served rule set is exactly `model_number equals X` AND `date_code one_of [2510, 2511, 2512]`.

## 5. Conjunction safety

| Case                                                  | Result                                                 |
| ----------------------------------------------------- | ------------------------------------------------------ |
| correct model + paired date code                      | confirmed through that rule set only                   |
| correct model + date code of another row (row-paired) | not confirmed (MODEL-A+2511, MODEL-B+2510)             |
| correct model + unlisted code (Char-Broil 2509)       | not confirmed (`rejected` under complete coverage)     |
| wrong model + valid date code                         | not confirmed                                          |
| missing model / missing date code                     | `needs_review`                                         |
| model reviewed + date code unreviewed / rejected      | not materializable; siblings still serve               |
| date code alone                                       | never a rule set                                       |
| one incomplete rule set                               | does not block the others; coverage becomes incomplete |
| tampered value or duplicated rule set in the envelope | dropped individually; coverage incomplete              |

- Char-Broil's authoritative rows all share one date-code set, so the "code from another row"
  case cannot occur on that page.
- That case is therefore proven with a row-paired table run through the same production parser,
  in pgTAP and Node.

## 6. Simple-rule backward compatibility

- The frozen Phase 15/16 benchmark was replayed through the adapter in two shapes: one scope with N
  rule sets, and N scopes with one rule set each. All 200 decisions are identical to the frozen
  deterministic_v2 results. The benchmark includes GTIN, lot, date, and multi-condition rules.
- `p15-str-45-2`, `p15-str-45-3`, and `p15-str-46-3` stay non-confirming.
- A single rule set decides exactly like the previous single all-of. This holds for model+date and
  model-only, across the confirmed, rejected, and needs_review cases.
- In the database, a single model rule and a single model+date conjunction each serve one complete
  rule set.
- GTIN is not a reviewable CPSC ledger class, so GTIN compatibility is proven by the benchmark
  replay only.

## 7. Remote-safe pgTAP rewrite

`supabase/tests/remote/phase-16-production-compatibility.sql` now has 80 assertions and follows
the post-16.11 path:

1. worker identity observation
2. identity-bound notice
3. page revision
4. unreviewed model and date-code proposals
5. transaction-only reviewer authorization, recorded exactly as the owner grants one
6. decide both members; a partial conjunction is refused
7. materialize, then the service role reads one complete rule set
8. the existing v2 claim, finalize, alert, and correction flow

Safety properties:

- It never calls `approve_cpsc_product_model_criterion_v2`; it only asserts that no role holds
  EXECUTE on it.
- It picks an unused `9xxxx` recall number, an unused numeric API ID, and a random URL.
- On production it uses the existing CPSC source read-only. It calls `ensure_cpsc_recall_source()`
  only when no source exists.
- `BEGIN … ROLLBACK` with lock, statement, and idle timeouts. No TRUNCATE, no grant or RLS change,
  no persistent fixture.
- It passed on a fresh database (the `supabase test db` suite) and on a populated one: after the
  full backfill and after the HTTP fixtures. It left 0 rows behind.

## 8. 16.3 gate template

- The template no longer writes `recall_scope_criteria_v2` directly and never touches the retired
  path.
- It builds MODEL-1 AND date code 2510 through worker evidence, human review, and materialization.
  Products with 2510, no code, and 2509 give confirmed, needs_review, and rejected.
- The verifier computes fingerprints and decisions through the rule-set adapter.
- The inline contract-migration mode was removed; the gate now requires the local chain through
  16.12.
- Result: 23/23.

## 9. Existing-notice revision model

Identity (source + recall number) never changes. Revisionable data lives in the append-only
`private.cpsc_notice_revisions`:

- title, description, hazard, remedy, recall date
- manufacturer names and the raw payload
- `content_hash` and `identifier_hash`, with changed fields recorded
- `supersedes_revision_id`, and the source observation

How revisions are recorded:

- `record_cpsc_notice_revision(observation, …)` (worker only) takes title and date from the
  resolved observation and checks the payload's `RecallID` and `RecallNumber`.
- On the first call it snapshots the historical notice as the baseline.
- It appends a revision only when the normalized content or identifiers change. The historical
  `recall_notices` row is never written.
- `get_cpsc_current_notice_revision` (worker only) returns the latest revision.
- The review packet shows the current revision.

What changes and what does not:

- Formatting (whitespace, NFC) and payload metadata outside safety content create no revision.
  They remain API-revision lineage only.
- Title and remedy corrections do not stale criteria.
- An identifier change (payload models or UPCs) conservatively stales every reviewed member of
  that identity.
- A changed pairing on the official page stales through the existing page-revision path.

Matching evidence stays traceable: every rule set names its page revision hash, review events, and
fingerprint, and all of it is inside the evaluation fingerprint.

The ingestion worker (not deployed) now records a revision after resolving a known identity.

## 10. Title and remedy correction tests

| Case                                | Result                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| identical content                   | baseline only                                                                 |
| whitespace-only / Retailers-only    | `unchanged`, no revision                                                      |
| title correction                    | same identity; new revision `["title"]`; observation flag `title_revised`     |
| remedy correction                   | new revision `["remedy"]`, superseding the title revision                     |
| any correction                      | no duplicate recall; historical row byte-identical; criteria still served     |
| same observation replayed           | idempotent (same revision id)                                                 |
| model identifier change             | revision with `identifierChanged`; 1 review staled; rule set no longer served |
| paired date-code change on the page | new page revision; both paired rule sets unusable                             |

## 11. Revoke-for-cause

- A separate capability, `decision_invalidation`, in `private.cpsc_admin_capabilities`, granted
  only by the owner.
- `invalidate_cpsc_review_decision(event, reason)` targets one specific human decision.
  `invalidate_cpsc_reviewer_decisions(reviewer, from, to, reason)` covers a reviewer window of at
  most 1000 decisions.
- A reason is mandatory. `private.cpsc_review_decision_invalidations` is append-only. The ledger
  event stays.
- An invalidated latest decision makes the member unusable. Dependent rule sets stop being served
  immediately, because every read re-runs the builder. Invalidation also advances the notice
  revision, so in-flight claims finalize as stale.
- A replacement decision must come from a different reviewer. Re-materializing restores the same
  semantic fingerprint.

Tested in pgTAP and over HTTP:

- Prospective access revocation: previous decisions stay valid.
- One decision revoked for cause: 8 of 9 stay served, and coverage becomes incomplete. The affected
  product is withheld from rejection; the others still confirm.
- Bulk revocation of one reviewer: that reviewer's rule sets become unusable; the other reviewer's
  9 remain.
- Denials: the reviewer, reconciler, consumer, service_role, and sb_secret key are all refused.

## 12. Page revert semantics

The conservative behavior is kept.

- A → B stales A's reviews. Returning to A is detected as `reverted`, and nothing revives.
- A new human decision on A is then permitted: the latest event is a stale marker and A is current.
- Re-materialization yields the same semantic fingerprint, so identity is stable across revert and
  re-review.

Tested in pgTAP.

## 13. Historical backfill design

`private.cpsc_historical_backfill(manifest, scope, execute, label, limit)` is owner-only: no API
role has EXECUTE, and the `private` schema is not exposed to PostgREST.

- Manifest: `docs/phase-16-12-backfill-manifest.json`, built by
  `scripts/build-phase-16-12-backfill-manifest.py` from the frozen 16.8/16.9 audit. It holds public
  CPSC data only: 27 page captures and 27 current-API observations.
- Stored notices are read from the database the backfill runs in.
- Structure scope: A identities, B links, C historical aliases and API revisions, E page revisions
  and fetch history.
  - The canonical notice is the lowest numeric API ID. This reproduces the audit's choice for all 3
    duplicate groups.
  - Old captures are never inserted under newer page history.
- Observations scope: D historical and current observations, then F collision quarantine. Both run
  through the real 16.11 gate, not a reimplementation.
- There is no G or H stage: reconciliation and review stay human.
- Additive: it never writes `recall_notices` or `recall_scopes`. A digest check aborts the call on
  any historical change.
- Idempotent and resumable: every created row has an item key in `cpsc_backfill_items`, so
  already-recorded work is reused. Each call is bounded by `limit` and atomic.
- Observable: the `cpsc_backfill_runs` table stores reports; each report includes a canonical
  identity digest with no UUIDs.
- Rollback:
  - Any unexpected failure aborts the call.
  - `private.cpsc_backfill_retract(run, reason)` removes a structure run's own rows, but only while
    nothing depends on them, and it records the retraction.
  - Once the observations stage runs, the structure is permanent by design.

## 14. Dry run (scope `all`, then rolled back)

Structure:

- to create: 27 identities, 30 links, 60 aliases, 30 API revisions, 27 page revisions, 27 fetches
- reused: 0
- duplicate groups: 26773, 26776, 26777
- unexpected conflicts: 0
- notices without a recall number: 0

Observations (real gate):

- A_known_alias 48, B_new_alias 3, D_api_id_reuse 6
- 12 drift rows

Afterwards, every table is unchanged and no run row persists.

## 15. Backfill idempotency (disposable local database)

| Run    | New rows | Resulting state                                                                                                       |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------- |
| first  | 258      | 27 identities; 30 links; 162 aliases; 51 API revisions; 27 page revisions; 27 fetches; 57 observations; 6 quarantined |
| second | 0        | all counts equal; 27/30/60/30/27/27 reused; 57 observations already recorded                                          |

- The canonical digest is identical across runs: `ea00243e…133f`.
- Historical rows digest: unchanged. Notices stay at 30 and scopes at 43.
- 0 reconciliations, 0 review events, 0 rule sets.

## 16. Six-collision quarantine

- After the backfill, API IDs 10965–10970 are quarantined as `D_api_id_reuse` for recalls 26753,
  26763, 26754, 26756, 26749, and 26766.
- 0 misassociations. The live gate still resolves each stored ID to its own recall and still
  quarantines each reused ID.
- The 16.11 human decisions were not reused. Reconciliation needs the `identity_reconciliation`
  capability.

## 17. Multi-rule reviewer packet

`get_cpsc_candidate_review_packet` keeps every 16.10/16.11 key and adds `ruleSetPresentation`:

- `semantics: "OR between rule sets; AND inside each rule set"`, plus an explanation that members
  are never combined across rule sets.
- `ruleSets[]`, numbered in authoritative table order (from the revision's own table and row
  identities). Each entry has:
  - `insideRuleSet: "AND"`
  - its members, with value, excerpt, address, latest decision, and whether that decision was
    invalidated
  - `containsThisCandidate`
  - `state`: `served`, `complete_not_materialized`, or `incomplete`
  - `ruleSetFingerprint`
- `currentNoticeRevision`.

For Char-Broil it shows 9 rule sets, models 25302145 … 25302163 in document order, each with
exactly one model and its date-code set.

## 18. HTTP authorization (real GoTrue JWTs, local PostgREST)

- `test:phase-16-12:http`: **65/65**.
- `test:phase-16-11:http` (updated for the envelope and the reconciler capability): **36/36**.

| Role                         | Allowed                                                                       | Denied                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| anon, consumer               | —                                                                             | decide, revoke, reconcile, rule-set read, notice revision, notice read (consumer)            |
| service_role JWT / sb_secret | observation, notice, page revision, proposals, notice revision, rule-set read | human review, materialize, revoke, bulk revoke, reconcile; the backfill is unreachable (404) |
| reviewer                     | packet, decide, materialize                                                   | revoke, reconcile, quarantine packet, worker RPCs                                            |
| reconciler                   | quarantine packet, reconcile                                                  | decide, revoke                                                                               |
| invalidator                  | revoke one decision, bulk revoke one reviewer                                 | decide, materialize, reconcile                                                               |

- The SQL rule-set fingerprint equals the TS recomputation for all 9 rule sets.
- The SQL canonical-JSON digest equals the TS payload digest on the real CPSC fixture records and a
  Unicode/escape sample.

## 19. Migration

Apply strictly in this order: 16.9 → 16.10 → 16.11 → 16.12.

| File                                                    | SHA-256                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `20260926090000_phase_16_12_multi_rule_scope_model.sql` | `45da9c3a8e226b4807b0c5c484a7466f586379b3506cb97a002ff802b8934651` |

- Forward-only.
- Replaced in place:
  - the current-reviewed view (adds the invalidation check)
  - `decide_cpsc_candidate`
  - `materialize_cpsc_reviewed_conjunction`
  - `get_recall_v2_scopes`
  - the review packet
  - the quarantine packet and reconciliation (now capability-gated)
  - the legacy binding guard

## 20. pgTAP

`npx supabase db reset --local --yes` then `npx supabase test db`: **988/988 PASS**, 12 files.

- New `phase-16-12-multi-rule-scope.sql`: 224 assertions.
- The remote-safe file grows from 67 to 80.
- The 16.11 file gains 5 from its RLS sweep over the new `private.cpsc_*` tables.

Superseded 16.11 assertions (edited):

- A reconciliation-capability fixture grant.
- "alternative conjunction fails closed" now reads "materializes as a second rule set".
- Three reads now target the envelope.
- The legacy-table copy and edit checks now target the rule-set table.
- The stale-history count moved to the rule-set table.

## 21. Database lint

`supabase db lint --local`: **0 errors**. The only notes are "warning extra" unused parameters on
the retired approval stub, which is intentional (unchanged from 16.11).

## 22. Deno, npm, and freezes

- **Deno 2.9.6** (`npx -y deno@2 check`): 15 production-path files pass. That is the 13 from 16.11
  plus `ruleSetsV2.ts` and `deterministicRuleSetsV2.ts`.
- **`npm run check`**: exit 0.

| Suite        | Result |
| ------------ | ------ |
| matcher      | 27/27  |
| phase 16     | 39/39  |
| 16.10        | 19/19  |
| 16.11        | 17/17  |
| 16.12 (new)  | 12/12  |
| 16.3         | 6/6    |
| 16.4         | 6/6    |
| v2.1         | 19/19  |
| AI necessity | 2/2    |

- Frozen CPSC HTML verified.
- Freezes: Phase 9.1, Phase 15, and Phase 16 all report `frozen: true`.
- v2.1 safety: 200 cases, 0 unsafe confirmations, 0 provider calls.
- **Other gates**:
  - 16.3 DB gate: 23/23.
  - Backfill rehearsal: 23/23 checks.
  - `git diff --check`: clean.
  - Trailing whitespace: none in any new file.
  - Secret scan of all 19 touched files: no matches.
- No Nebius call.

## 23. Read-only production audit

**Not performed.** No Supabase MCP is connected in this session, so this subsection is stopped as
instructed. Pending: migration status for 16.9, 16.10, 16.11, and 16.12; the three function
versions; and the counts of reviewed criteria, v2 evaluations, eligibility, alert snapshots,
corrections, and the push queue.

## 24. Remaining risks

1. The production audit (§23) is outstanding.
2. Coverage counts parser proposals. A parser that silently omitted a row would make coverage look
   complete, so a product of the missing row could be _rejected_. It could never be confirmed.
   Binding coverage to the page's table-row identities would close this.
3. Rejection is now withheld whenever any scope of a notice lacks complete coverage. This is
   deliberately stricter than 16.11: some former `rejected` outcomes become `needs_review`.
4. A page-revision stale does not advance `recall_notices.updated_at`. Materialization and
   revoke-for-cause do. So an in-flight evaluation can still finalize against a just-staled rule
   set. The read path is correct, and this race predates 16.12.
5. An identifier change stales every reviewed member of that identity. This is conservative and may
   cause re-review churn.
6. The backfill runs the real gate by setting service-role claims inside an owner-only function.
   After the observations stage, the structure is permanent by design.
7. The manifest reconstructs the current-API URL of non-drift rows from stored URLs, because the
   16.8 audit did not capture them. A fresh capture should replace the manifest before production
   use, or this reconstruction should be explicitly accepted.
8. Canonical-JSON parity is exact for CPSC payloads. Non-integer JSON numbers such as `1.50`
   would differ between jsonb and JavaScript.
9. There is no reviewer RPC to list pending candidates. The HTTP proof used SQL to get the first
   candidate, then the packet enumerated all 18.
10. v1 (`phase_10_guarded_v1`) still matches on historical notice content, not on notice revisions.
11. Carried over from 16.11:
    - owner/superuser trigger bypass
    - broad v1 service_role grants
    - the global identity-decision lock and per-read builder cost at scale
    - byte-frozen fixture whitespace

## 25. Recommendation for Phase 16.13

1. Connect the Supabase MCP and complete the read-only audit (§23).
2. Refresh the current-API capture used by the manifest, or explicitly accept the 16.8 capture.
   Rebuild the manifest and record its SHA-256.
3. With explicit approval, apply 16.9 → 16.10 → 16.11 → 16.12 to production, still inactive. Then
   run the remote-safe file once (rolled back) and re-audit.
4. Run `private.cpsc_historical_backfill(manifest, 'all', false, …)` in production. It is a dry run
   and persists nothing. Review the report against §14. Execute only with separate approval, then
   verify idempotency with a second execution.
5. Grant the reviewer, reconciler, and invalidator roles to named people, separately. Then
   reconcile the 6 quarantined collisions by human action.
6. Before any human criterion review: bind coverage to the page's table-row identities (risk 2),
   and add a reviewer candidate-listing RPC (risk 9).
7. Keep deterministic_v2, cohorts, consumer v2 reads, and push inactive.
