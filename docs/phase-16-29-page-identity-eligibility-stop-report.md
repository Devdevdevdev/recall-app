# Phase 16.29 — page-claim eligibility provenance + pre-scheduling identity gate — stop report

**Classification: GREEN.** 26777 is claimable today because the page claim equates API `reconciled` with page-safe. Its `reconciled` status is proven to come from **deterministic historical backfill Stage A**, not from any human decision. The manifest's "human reconciliation required before page ingestion" disposition never reached the database except through its hash.

This phase adds a general, provenance-based, fail-closed page-eligibility rule. It is one additive migration plus a one-branch worker change, both local only. Under production-equivalent state the rule gives:

- 26777: `human_reconciliation_required`
- 6 more identities: `unresolved_quarantine`
- 20163 and 30 others: eligible

Queue order is otherwise preserved. Production was read only: no page call, migration, deploy, schedule, reconciliation, v2, provider call, commit, or push. Stop for review.

## 1. Worktree handoff

- Branch `main`. All inherited work is preserved; there was no reset, clean, commit, or push. `git status` went from 197 to 199 entries plus this report, and there are still 36 tracked modifications.
- Byte-identical to recorded hashes:
  - 16.26 migration `e7f1da30…bae2`
  - 16.26 report `50ae8dda…732f`
  - remote 16.26 suite `9a04ad69…715e`
- The 16.28 report is unchanged since the start of this phase (`0f5bbd30…1e1f`).
- **Changed or new in this phase:**

| File                                                                                      | Kind                                              | SHA-256                                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| `supabase/migrations/20260929110000_phase_16_29_page_identity_eligibility_provenance.sql` | new                                               | `154b96b0bb4abfc6664ab0ecb17bbda0456cc34aef6fce843d0e48634eae3c4c` |
| `supabase/tests/phase-16-29-page-identity-eligibility.sql`                                | new (208 assertions)                              | `5e23aae6f0691b56ae5fddad2fe2df9a768b316229684816f1e6e8299b48f87b` |
| `supabase/functions/_shared/cpsc/scheduledPageWorker.ts`                                  | edited (one catch branch)                         | `6f8eeb9c8c57f9d9e9796a3e345ce15ee5b3bbcd78c7f285597f4a7ea9cce782` |
| `tests/phase-16-23-page-worker.test.mjs`                                                  | +1 test                                           | `bdeb27e9ea6c9280d608c9a8f32f030994a83a68ad486ae399300bfa35aa6418` |
| `supabase/tests/phase-16-23-page-evidence-foundation.sql`                                 | **inherited test edited**, +1 assertion (see §20) | `9b92b4c0b9d4ad4159a87596bddf19db091c197d4128d51a38f98a27113c0218` |

## 2. Temporary-key cleanup

- `/tmp/recall-cpsc-page-worker-key.Wy0a3t` is **absent**, and there is no `/tmp/recall-cpsc-page-worker-key.*` match. It was not read.
- **Credential-pattern scan:** `git diff`, all untracked repo files, and this session's scratchpad.
  - 0 JWTs, 0 private keys, 0 service-role assignments, 0 worker headers with values.
  - One `sb_secret_` hit is the literal prefix inside the 16.28 report's own scan description (0 characters follow it).
  - One Postgres URL is the local Supabase default (`127.0.0.1:54322`) in a scratch script.
- No live secret value was known to or used in this session.

## 3. Production baseline (read only, 10:22 UTC)

- **Migrations:** 28, latest 16.26.
- **Worker:** `process-cpsc-page-evidence` v5, bundle `0194da28…e41f`, `verify_jwt=true`, unscheduled. All 8 bundle SHAs match 16.28.
- **Cron:** only job 2, `17 */6 * * *`, MD5 `07549bf9…097b6`, no page reference. Last run 06:17 succeeded; the latest v1 automation run (06:17 cron) was `success`.
- **Sources:** CPSC `2026-09-29` success; Health Canada `2026-09-29` success. Automation watermark `2026-09-29`; 0 leases.
- **CPSC safety:** `safe=true`, 9 quarantined / 9 retained, `legacyHashOnly=0`, quarantine-set MD5 `21a70604…4050` (unchanged).
- **Zero counts:** reviewed criteria/rule sets 0, v2 evaluations 0, matches 0, alerts 0, push queue 0, deliveries 0, reconciliations 0, capabilities 0, reviewer authorizations 0.
- **Page state exactly as expected:** 2 attempts, 2 work states, 1 raw payload, 1 ledger, 1 structural snapshot, 0 candidates, 27 revisions, 28 fetches. The last claim was 09:51:53 (the 16.28 call), and there has been no new page processing.

## 4. Exact page-claim graph

- **Call path:**
  1. `POST process-cpsc-page-evidence` → `runCpscPageWorker`.
  2. `claim_cpsc_page_evidence(1)` (security definer, `cpsc_is_worker()`, `cpsc_page_worker` grant only).
  3. `fetchCpscOfficialPage(canonical_url)`.
  4. Final-URL check.
  5. `retain_cpsc_page_transport`.
  6. `extractCpscPageStructure` (canonical link + displayed recall number).
  7. Recall-number check.
  8. `commit_cpsc_page_evidence_verified` → `commit_cpsc_page_evidence` → revision, snapshot, fetch, candidates, coverage.
  9. Any failure goes to `finish_cpsc_page_attempt`.
- **16.26 claim predicate** (the only gate before a fetch):
  - `identity_status = 'reconciled'`
  - `cpsc_canonical_url(canonical_url) = canonical_url`
  - `not manual_review_required`
  - `coalesce(next_attempt_at, -infinity) <= now()`
  - lease free or expired
- **Ordering and locking:** ORDER BY `next_attempt_at`, then `coalesce(last_success_at, last_attempt_at, first_seen_at)`, then `official_recall_number`; `FOR UPDATE OF i SKIP LOCKED`.
- **Sources read:** `cpsc_source_identities`, `cpsc_page_work_state`, `recall_scopes`. **Never read:** observations, quarantines, reconciliations, aliases, notice links, notices, or backfill provenance.
- **Retry:** set only by `finish_cpsc_page_attempt`:

| Outcome                                       | Retry                | `manual_review_required` |
| --------------------------------------------- | -------------------- | ------------------------ |
| `temporary_failure`                           | 5 min × 2ⁿ (≤ 1 day) | no                       |
| `database_timeout`                            | 1 h                  | no                       |
| `internal_failure`                            | 1 day                | no                       |
| `unresolved_structure`                        | 7 days               | no                       |
| `identity_redirect` / `permanent_unsupported` | 30 days              | no                       |
| `evidence_rejected`                           | 100 years            | **yes**                  |

- **URL predicates:** the claim checks only canonical _form_. Retain and commit additionally require `finalUrl = canonical_url` and every redirect hop in canonical form.
- **The assumption:** `retain` and `commit` also re-check only `identity_status = 'reconciled'`. The page path treats `reconciled` as page-safe everywhere.

## 5. Why 26777 is eligible

Identity `d3d6654d-cf54-4edf-a095-ff82cd5a15cc` passes every predicate:

- status `reconciled`
- canonical `…Poisoning-Hazard-0` is canonical form
- no work state, so it is due at `-infinity`
- no lease
- tie on `first_seen_at` 2026-09-26 19:14:08.209996, broken by number

That places it at **position 16 of 37** due identities; 20163 is not due until 2026-09-30.

**Provenance, proven row by row:**

| Item                  | Value                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| canonical identity    | `reconciled`; canonical notice `776fdc2d…` (API 10987, URL `https://cpsc.gov/…-Hazard-0`)                                                                                                                                                         |
| notice links          | 2 (10987 canonical, 10990 `https://www.cpsc.gov/…-Hazard-0`), provenance `Phase 16.12 historical backfill`                                                                                                                                        |
| aliases               | 10, all `reconciliation_id = null` (backfill, backfill stored notice, 16.16A worker observation)                                                                                                                                                  |
| observations          | 3, all `resolved/A_known_alias`; flags `url_spelling_alias`, `title_revised`, `payload_revised`; 0 quarantined                                                                                                                                    |
| page lineage          | 1 revision `b2c466c0…` (`phase-16.9-v1`, 0 tables); 1 fetch `f15fd399…` with final URL `…-Hazard-0`, redirect chain `[]` (the 16.8 capture predates the move)                                                                                     |
| redirect evidence     | **not in the DB.** It exists only in the manifest `unresolvedIdentities` entry: API URL `…-Hazard-0` → 301 → `…-Hazard`; the declared canonical is `…-Hazard`; `requiredAction`: "Human identity reconciliation … before any live page ingestion" |
| quarantine history    | none for 26777                                                                                                                                                                                                                                    |
| reconciliation ledger | 0 rows; 0 identity-reconciliation capabilities; 0 reviewer authorizations                                                                                                                                                                         |
| backfill source       | run 9 (structure), item `A:26777`, `A_identity`, target `d3d6654d…`, manifest `a8bce170…`                                                                                                                                                         |

## 6. Provenance source of `reconciled`: **B — deterministic historical backfill**

- **What Stage A does:** `private.cpsc_backfill_apply` Stage A inserts `identity_status = 'reconciled'` whenever every historical notice for a recall number canonicalizes to one URL. For 26777, the `cpsc.gov` and `www` spellings of `-Hazard-0` collapse to one URL.
- **Not A (human):** 0 reconciliation rows and 0 capabilities exist.
- **Not C (canonical API establishment):** that path, `ingest_cpsc_identity_notice`, would write link provenance `Phase 16.11 identity-aware ingestion…`. Both links instead say `Phase 16.12 historical backfill`.
- **Not D.**
- **Root cause (two parts):**
  1. The backfill persists only `manifest_sha256`, not the manifest's `unresolvedIdentities` dispositions.
  2. The claim treats the API-level `reconciled` flag as page provenance.
- **Hash binding:** the local `docs/phase-16-15-backfill-manifest.json` hashes (via `private.cpsc_canonical_json_sha256`) to `a8bce170402bc3470d73b4a338ea9f6da5df01e16d76429f8142496b6c273c3c`. That equals production runs 9–12, so its dispositions are durable, hash-bound provenance.

## 7. API identity resolution vs unattended page eligibility

|          | API identity resolution                                               | Unattended page eligibility (new)                                                                                    |
| -------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Question | May authoritative API observations and notices attach to this recall? | May a worker fetch and semantically bind the official page with no human?                                            |
| Gate     | `identity_status = 'reconciled'` (unchanged)                          | `private.cpsc_page_identity_blockers(id) = '{}'`                                                                     |
| Sources  | observation gate, backfill Stage A, notice ingestion                  | identity + notice + links + aliases + observations + reconciliations + backfill provenance + page holds + work state |

API ingestion code and semantics are untouched: `record_cpsc_identity_observation`, `ingest_cpsc_identity_notice`, and backfill are not modified. The live gate still resolves stored IDs and quarantines reused IDs (§24).

## 8. General eligibility rule (no recall-number literal anywhere)

`private.cpsc_page_identity_blockers(identity_id) → text[]` returns blockers in a stable order; an empty array means eligible. A read model, `private.cpsc_page_identity_eligibility`, exposes it to the owner only.

| Blocker                               | Fails when                                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity_missing`                    | no identity                                                                                                                                           |
| `identity_unresolved`                 | not `reconciled`, or no canonical notice                                                                                                              |
| `canonical_url_invalid`               | canonical URL not in canonical form                                                                                                                   |
| `canonical_notice_inconsistent`       | canonical notice not linked, or its payload recall number or canonical URL differs                                                                    |
| `unresolved_quarantine`               | a quarantined observation for this identity, number, or URL lacks an authorized terminal reconciliation                                               |
| `url_lineage_conflict`                | a linked notice, a non-human `official_url` alias, or an observation canonicalizes to a different URL; or another identity holds this URL as an alias |
| `backfill_page_provenance_unverified` | an unretracted backfill item for this identity or number comes from a manifest whose page dispositions were not imported                              |
| `human_reconciliation_required`       | an open page-identity hold (by identity **or** recall number)                                                                                         |
| `manual_review_required`              | work-state flag                                                                                                                                       |

- **Where it applies:** the claim adds `and private.cpsc_page_identity_eligible(i.id)` with ORDER BY unchanged. `commit_cpsc_page_evidence_verified` re-checks eligibility, so a hold or flag landing mid-claim blocks semantic binding.
- **Hold sources (tighten only):**
  - the owner-only `private.cpsc_import_backfill_page_holds(manifest)`, one-shot, which requires a manifest hash equal to an executed, unretracted backfill run
  - an `AFTER UPDATE` trigger turning each `claimed → identity_redirect` attempt into a `worker_identity_redirect` hold with its transport evidence

## 9. Human provenance definition

- **What counts:** only rows written through capability-gated RPCs count:
  - `reconcile_cpsc_quarantined_observation` (existing 16.12)
  - `resolve_cpsc_page_identity_hold` (new)
- **Who counts:** both require `cpsc_has_capability('identity_reconciliation')`, meaning an authenticated JWT whose `auth.uid()` has an active capability row granted by the DB owner.
- **Read-side check:** a decision counts only if `private.cpsc_identity_decision_authorized(reviewer, decided_at)` shows the capability window covered the decision time. Revocation is prospective, as in 16.11.
- **Write-side guard:** the resolution table has a `BEFORE INSERT` guard requiring the caller to be that authenticated capability holder. Even an owner insert with a real reviewer UUID is rejected (tested).
- **Never counts:**
  - a free-text reviewer ID
  - a `provenance` string such as "human reconciliation …"
  - a backfill marker or the generic `reconciled` flag
  - a criterion-reviewer authorization
  - service_role, the worker, a parser, or a model
- **Resolution records:** each binds hold, decision (`clear_page_hold` or `keep_page_hold`), reviewer, rationale (≤ 2000), a full evidence packet, and its DB-recomputed SHA-256. The table is append-only, each hold can be cleared at most once, and resolutions touch no identity, alias, observation, notice, or work state.

## 10. 26777 under the new rule

| State                                                | Result                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| After migration, before import                       | `{backfill_page_provenance_unverified}`; nothing in production is claimable |
| After importing manifest `a8bce170…`                 | `{human_reconciliation_required}`                                           |
| Claim                                                | never returned; 0 attempts, 0 work state                                    |
| Canonical API identity, links, aliases, observations | fingerprint unchanged (pgTAP)                                               |

The rule was evaluated three ways, all giving the same result:

1. Production read-only inline evaluation.
2. A local rollback-only rehearsal loading the 41 production notices and running the real 16.15 manifest through the real backfill, import, and claim.
3. A pgTAP fixture of the same shape: two notices, `cpsc.gov`/`www` spellings of `-Hazard-0`, run through the real backfill.

## 11. Ordinary safe identities

- **Post-import:** 31 of 38 production identities are eligible, including **20163**, 20162 (Intertex), 26773, 26776 (duplicate groups, which are not over-blocked), and 26788–26799 (no page revision yet).
- **Fixture coverage:**
  - a plain directly created identity is eligible
  - the alias owner of a reused API ID (29001) is **not** blocked
  - pre-existing page fixtures in 16.23, 16.24, 16.26, and the remote suites keep claiming

## 12. Similar identities (production, read only)

Condition: claimable today, historically requiring a human identity/page decision, and no decision exists. Result: **7 identities.**

| Recall                                   | Why                                                                                                                                      | New state                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 26777                                    | manifest `unresolvedIdentities`: page moved (`-Hazard-0` 301 → `-Hazard`)                                                                | `human_reconciliation_required` |
| 26749, 26753, 26754, 26756, 26763, 26766 | unresolved `D_api_id_reuse` quarantines (API 10969, 10965, 10967, 10968, 10966, 10970) attributed to these identities; 0 reconciliations | `unresolved_quarantine`         |

- **Not currently claimable:** 26750, 26752, and 26764 hold quarantined `D_api_id_reuse` observations but have no identity. A later identity for those numbers would be blocked by the same rule.
- **No other conflicts:** there are 0 URL-lineage conflicts, 0 notice inconsistencies, and 0 manual-review flags.

## 13. Redirect classification

The fetch security checks are unchanged: every hop must be `https://(www.)cpsc.gov/Recalls/…`, with ≤ 3 hops, 10 s whole-exchange deadline, 1 MB cap, HTML only, fatal UTF-8. The DB re-validates the final URL and every hop.

| Class                         | Example                                                                                                                                                                                                                                                                                          | Handling (16.29 candidate)                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted automatically        | no redirect; or all hops canonicalize to the identity URL **and** are stored in canonical form                                                                                                                                                                                                   | normal evidence path                                                                                                                                       |
| Human reconciliation required | final URL ≠ identity URL (`-Hazard-0` → `-Hazard`); displayed recall-number mismatch; declared canonical link contradicts the identity (**new: the worker maps this to `identity_redirect`/`canonical_link_mismatch` instead of `unresolved_structure`**); off-authority or unsafe hop; > 3 hops | `identity_redirect`, which now creates a durable hold. It is ineligible until an authorized `clear_page_hold`; previously it retried blindly every 30 days |
| Permanent (not identity)      | 4xx, non-HTML, oversize, invalid UTF-8                                                                                                                                                                                                                                                           | `permanent_unsupported` (30 days), unchanged                                                                                                               |
| Retryable                     | 429, 5xx on any hop, timeout, transport error                                                                                                                                                                                                                                                    | `temporary_failure` backoff, unchanged                                                                                                                     |

- **Found, not changed:** a pure host-spelling or trailing-slash hop is pushed to the chain literally. `retain_cpsc_page_transport` then rejects it as a non-canonical hop, so the attempt ends `internal_failure` with a 1-day retry. This fails closed but is noisy, and CPSC has not been observed doing it (20163's chain was `[]`).
- **Recommendation:** in a later phase, record hops in canonical form or accept same-identity spelling hops explicitly.

## 14. 20163 replay (exact production bytes, current code, `--deny-net`)

- **Bytes:** the 16.28-retained 79,724 bytes, SHA-256 `646b4240…ed1e`, which equals the production `raw_payloads` digest re-read now.
- **Expectations:** `db.json` was re-verified against production today: ledger canonical SHA `83ebd6ba…657d`, summary `1a9c6a57…8847`, normalized `db375bbc…124a`.
- **Result:**
  - semantic hash `db375bbc…124a` equal
  - normalized evidence equal
  - table identities `[]` equal to both revision and snapshot
  - ledger and summary deep-equal
  - coverage FP `ae87afd9…9d93` and interpretation FP `be02286c…f4c6` equal
  - 4 records, all `ignored_non_safety`; 0 candidates
- **Section hashes:** differ, as in 16.28 (frozen 5-key legacy layout).
- **Scope:** the parser modules are unchanged (SHA equal to 16.27), so semantic parsing is unaffected.

## 15. Table-bearing legacy target candidates

Every production revision is legacy `phase-16.9-v1` with `table_identities=[]`. The drift signature is stored `normalized_evidence.tables` = 1 and `cpsc_expected_page_tables` = 1, versus 0 stored identities.

| Recall       | Table (stored evidence)                                                                                               | Blockers after 16.29    | Natural position after import |
| ------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------- |
| **26773**    | `Model Description \| Model No.`, 10 rows; 2 linked notices (duplicate group, linked not merged)                      | none                    | **6**                         |
| 26783        | `Recalled Model Numbers \| Range of Recalled Serial Numbers`, 8 rows                                                  | none                    | 15                            |
| 26784        | `BRAND \| SERIES \| MODEL`, 27 rows                                                                                   | none                    | 16                            |
| 20162        | Intertex `MODEL \| BRAND \| DESCRIPTION \| MSRP`, 9 rows (the original failing case; historical claimed attempt kept) | none                    | 30 (due since 09-28)          |
| 26756, 26766 | 1 table each                                                                                                          | `unresolved_quarantine` | excluded                      |

- **Evidence used:** stored evidence only, from production revisions and the hash-bound manifest.
- **Not fetched:** no external page, so current live table presence is strongly expected rather than proven. 16.13's fresh corroboration parsed all of these pages, and 26773's fresh ledger was `complete`.

## 16. Natural vs targeted future test

- **After install and import (A):** a suitable target will come up naturally. 26773 is sixth, behind 20164, 20165, 26748, 26755, and 26761 (all zero-table pages). There are two natural paths, each needing separate authorization:
  - five more single-page shadow calls, then the 26773 call
  - one call with `maxPages=6`
- **Before install:** in today's order 26773 sits at 12th, _behind_ the six quarantined identities, so the queue should not be driven before 16.29 is installed.
- **Targeted override (B):** not needed and not implemented.

## 17. Migration

`20260929110000_phase_16_29_page_identity_eligibility_provenance.sql`, SHA-256 `154b96b0bb4abfc6664ab0ecb17bbda0456cc34aef6fce843d0e48634eae3c4c`. It is additive; no prior migration was changed.

- **Tables** (RLS on, no policies, all privileges revoked from `anon`, `authenticated`, `service_role`, and `cpsc_page_worker`):
  - `private.cpsc_page_identity_holds`
  - `private.cpsc_page_identity_hold_resolutions`
  - `private.cpsc_backfill_page_hold_imports`
- **View:** `private.cpsc_page_identity_eligibility` (security invoker, owner only).
- **Functions, private:** `cpsc_page_identity_blockers`, `cpsc_page_identity_eligible`, `cpsc_page_identity_evidence`, `cpsc_identity_decision_authorized`, `cpsc_import_backfill_page_holds` (owner only), plus trigger functions `cpsc_prepare_page_identity_hold`, `cpsc_guard_page_hold_resolution`, `cpsc_hold_page_identity_redirect`.
- **Functions, public:** `get_cpsc_page_identity_hold_packet(uuid)` and `resolve_cpsc_page_identity_hold(uuid, text, text)`. These are `authenticated` only and gated on the capability inside.
- **Replaced (same signatures, grants restated to `cpsc_page_worker` only):** `claim_cpsc_page_evidence(integer)` and `commit_cpsc_page_evidence_verified(…)`.
- **Triggers:**
  - append-only update/delete + truncate on all three tables
  - hold preparation (identity match; worker holds must bind a real `identity_redirect` attempt; DB-recomputed evidence SHA)
  - resolution guard
  - `after update of outcome on cpsc_page_attempts when claimed → identity_redirect`
- **Indexes:** holds unique `(recall_number, manifest)` and unique `(attempt)` (both partial), plus `(identity_id)` and `(official_recall_number)`; resolutions unique `(hold_id) where clear`.
- **Design choice:** holds store `origin_attempt_id` _validated_, not as an FK, so 16.24's truncate test and semantics are unaffected.
- **Rollback considerations:** the migration is forward-only.
  - Reverting the claim and commit to the 16.26 bodies and dropping the attempts trigger restores old behaviour, which **re-opens 26777**.
  - Holds and resolutions are append-only audit records; keep them even if the functions are reverted.
  - **Consequence of install:** until the owner runs the import, **0** production identities are claimable (fail closed).

## 18. Worker / claim source

- **Change:** one catch branch in `scheduledPageWorker.ts`. `canonical link contradicts` now yields `identity_redirect` / `canonical_link_mismatch`, carrying the retained raw bytes' hash. It reaches no commit.
- **Source set** (16.27 method: SHA-256 over sorted `path<TAB>sha<LF>`, same 9 files):
  - deployed `3434b294…2c44`; the reconstructed pre-edit file equals the recorded `d581ba00…2da4`
  - **candidate `9e6e318efc140a104d72c12bbc314ef98a4a2ebca1f29b723fc4942caaf54a02`**; only `scheduledPageWorker.ts` differs
- **Compatibility:** the deployed bundle works against the new DB, because RPC signatures and result columns are unchanged. A commit refused for eligibility ends `evidence_rejected` + `manual_review_required`.

## 19. Role / authorization matrix (all asserted in pgTAP)

| Actor                                       | Claim               | Read holds / eligibility | Import holds                   | Clear hold                                     | Reconcile quarantine   | Aliases / identities / watermarks / matches / alerts |
| ------------------------------------------- | ------------------- | ------------------------ | ------------------------------ | ---------------------------------------------- | ---------------------- | ---------------------------------------------------- |
| `cpsc_page_worker`                          | yes (eligible only) | no (no private schema)   | no                             | no (42501)                                     | no                     | no                                                   |
| `service_role`                              | no                  | no                       | no (42501)                     | no (42501)                                     | no (42501)             | unchanged 16.x grants only                           |
| `authenticated` consumer                    | no                  | no                       | no (42501)                     | no (42501)                                     | no                     | no                                                   |
| criterion reviewer (no identity capability) | no                  | no                       | no                             | no (42501)                                     | no                     | no                                                   |
| `identity_reconciliation` holder            | no                  | own packet via RPC       | no                             | **yes** (RPC)                                  | **yes** (existing RPC) | no                                                   |
| DB owner                                    | —                   | yes                      | **yes** (one-shot, hash-bound) | **no**; direct insert is rejected by the guard | —                      | —                                                    |
| parser / model                              | no DB path          | —                        | —                              | —                                              | —                      | —                                                    |

The worker's executable security-definer set is still exactly the 16.26 list (asserted by the remote 16.26 suite).

## 20. pgTAP additions

**`phase-16-29-page-identity-eligibility.sql` (208 assertions):**

- privileges and RLS
- real backfill of 20163- and 26777-shaped fixtures, with backfill-only `reconciled` rejected
- owner-only, hash-bound, one-shot import
- ordinary identity eligible; 20163 fixture eligible
- 26777 fixture ineligible, with its API identity fingerprint unchanged
- unresolved quarantine ineligible, cleared only by an authorized reconciliation
- URL-change observation conflict ineligible, cleared by authorized `confirm_alias`
- linked-notice URL conflict ineligible; notice recall-number mismatch ineligible
- a free-text "human reconciliation" alias is not provenance and adds a conflict
- owner-forged resolution rejected; service_role, consumer, criterion reviewer, and worker all rejected
- claim skips earlier-sorting ineligible identities and takes the next eligible one (no starvation)
- `keep_page_hold` stays blocked; `clear_page_hold` unblocks without touching work state; double clear refused
- a later identity for a held number stays held
- worker `identity_redirect` becomes a bound hold and a due identity is still unclaimable; human clearance restores it
- worker-class hold must bind a real redirect attempt
- commit re-check blocks a mid-claim flag
- append-only enforcement

**Inherited edit:** `phase-16-23-page-evidence-foundation.sql` (+1 assertion). After its `identity_redirect` step, the identity is now held, which is the intended semantic change. The test now asserts the hold, then clears it through the real capability path before its unchanged success-path section.

## 21. Clean local migration count

`supabase db reset --local --no-seed` gives **29 migrations**, 0 identities, 0 notices, 0 backfill runs, and 0 holds. The worker password is null. Reset was repeated after every data-committing harness.

## 22. Full pgTAP

**1893 / 1893, 21 files, PASS**, on a clean reset.

- **Reconciliation to the 1681 baseline:** 1617 unchanged files, plus 16.23 at 64 → 65, plus 16.11 at 274 → 277, plus the new 208.
- **Where the 16.11 +3 comes from:** the 16.11 suite asserts RLS for every `private.cpsc_*` table, and 16.29 adds three. Measured by re-running per-file counts on a 28-migration reset.

## 23. Node / worker regressions

| Check                                                                | Result                                                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Full Node suite                                                      | **386 / 386** (385 + 1)                                                                                    |
| Worker tests (`phase-16-23-page-worker`)                             | 15 / 15, including the new canonical-link case                                                             |
| Page fetcher, page evidence, coverage, identity (16.10–16.13, 16.20) | in the Node suite, pass                                                                                    |
| Char-Broil, AGA, Friedrich                                           | frozen HTML: 3 hashes; AGA 6 pairs; Char-Broil 9 pairs; cosmetic stable; row edit detected                 |
| 26777 identity regression                                            | Node (wrong recall → `identity_redirect`) + pgTAP (backfilled 26777 shape) pass                            |
| Intertex fixtures                                                    | 16.26 local + remote suites pass (legacy `[]` + table drift → snapshot binding)                            |
| Claim race / lease expiry / exact bytes / dedupe                     | pass (see note)                                                                                            |
| DB timeout harness                                                   | 4 s cancel `57014`, rollback 0 rows, lease recovered, revoked login denied                                 |
| 20163 exact raw replay                                               | identical (§14)                                                                                            |
| Production-equivalent claim order                                    | local real claim (post-import): 30 due identities, same order as the production replica; 0 blocked claimed |

**Note on the 16.24 harness:** `scripts/verify-phase-16-24-replay.ts` is **stale**. It has no adapter for the 16.26 `retain_cpsc_page_transport` step, so it fails identically with **and without** 16.29 (proven on a 28-migration reset). A scratch copy adding only that adapter branch passed on 29 migrations. The repo script was left unchanged.

## 24. Historical / freeze / v2 safety

- **Freeze guards:** 9.1, 15, and 16 all `frozen=true`.
- **Backfill rehearsal (frozen 16.13 manifest):** **26 / 26** checks.
  - canonical digest `ea00243e…133f` and lineage digest `1406161a…a909`, both equal to the frozen 16.20 values
  - remote-safe 89 / 89; second run adds 0 rows
  - live gate: stored ID → `A_known_alias`, reused ID → quarantined
  - Pairing the script with the 16.15 manifest gives the documented 24/26 pinned-manifest mismatch (as in 16.20/16.24).
- **Production-equivalent backfill:** the real 16.15 manifest through the real backfill (rollback only) reproduced production: 38 reconciled identities, the same 6 quarantines, and 0 reconciliations.
- **Deterministic v2:** **0 unsafe confirmations**, 200 cases.
- **v2.1 safety:** **0 unsafe**, 66 needs-review preserved, 0 provider calls.
- **Baselines:** historical v1 keeps its known 3 unsafe confirmations. The 9.1 deterministic runner refuses to overwrite its write-once result, as in 16.27.
- **Incident, corrected:** running the 15 and 16 deterministic benchmarks rewrote 5 result files.
  - 4 tracked `phase-15/results/deterministic-v1-*.json` files were clean at start and were restored with `git checkout`.
  - 1 untracked `phase-16/results/deterministic-v2-all.json` differed only in `generatedAt`. It was restored from the 16.27 backup, whose SHA equals the 16.27 baseline.
  - Now **86 / 86** benchmark files equal the 16.27 SHA list.

## 25. Quality gates

| Gate                                                   | Result                                |
| ------------------------------------------------------ | ------------------------------------- |
| Deno check (all function entrypoints + `_shared/cpsc`) | exit 0                                |
| Expo `tsc --noEmit`                                    | exit 0                                |
| DB lint `--level error`                                | 0 results                             |
| Prettier (changed TS/JS)                               | clean                                 |
| `git diff --check` + untracked new files               | clean (0 trailing whitespace, 0 tabs) |
| Secret scan                                            | clean (§2)                            |

## 26. Production remained read only (final check, 10:53 UTC)

- **Migrations and objects:** 28 migrations; no 16.29 objects (`to_regclass('private.cpsc_page_identity_holds') is null`).
- **Page state:** attempts 2, work states 2, raw payloads 1, ledgers 1, snapshots 1, candidates 0, revisions 27, fetches 28. The last claim is still 09:51:53 and there are 0 active leases.
- **Row MD5s equal 16.28:** old Intertex attempt `7f248918…`, its work state `acefbe90…`, 26777 identity `465c3280…`.
- **Identity layer unchanged:** 282 aliases, 109 observations, 0 reconciliations, 0 capabilities.
- **Deploy and schedule:** all 8 function bundles and versions unchanged (worker v5 `0194da28…`, `verify_jwt=true`), and the worker is unscheduled. Cron is unchanged, with no run since 06:17.
- **v1 and v2:** the latest v1 run is `success`; watermarks and quarantine-set MD5 are unchanged. v2 evaluations, rule sets, matches, alerts, and push counts are all 0.
- **How production was used:** only `SELECT`s through the Supabase MCP. No write, DDL, RPC, page call, deploy, or secret operation.

## 27. Classification: **GREEN**

- The precise root cause is identified (§5–6).
- A general, provenance-based rule is implemented and tested locally, with no recall-specific literal.
- 26777 is excluded in both the pre- and post-import states.
- Ordinary safe identities, including 20163, remain eligible, with fair ordering and no starvation.
- API ingestion is unchanged and all local suites pass.
- Production is untouched.

## 28. Remaining risks

1. **Install is fail-closed until import.** Every production identity is backfill-created, so after the migration nothing is claimable until the owner runs the hash-bound import. That import is a production write needing its own authorization.
2. **Quarantine policy scope.** Blocking the 6 `D_api_id_reuse` identities follows the brief, including two table-bearing pages. Their page URLs are not contested, so a reviewer may later narrow this to URL-bearing quarantine classes.
3. **No human can clear anything in production yet.** There are 0 `identity_reconciliation` capabilities. `identity_redirect` now accumulates holds instead of retrying blindly, and a capability grant is an owner action.
4. **26777 cannot succeed by clearing alone.** While CPSC 301-redirects `-Hazard-0` → `-Hazard`, a cleared 26777 would fetch, fail the final-URL check, and be re-held. Actual 26777 page evidence needs a separately reviewed design for human-accepted redirect targets. Changing its canonical URL would amount to an identity rewrite, which is out of bounds.
5. **Spelling-only redirect hops** fail as `internal_failure` (§13). This is not a safety issue.
6. **Deployed worker behaviour until redeploy.** The deployed worker still maps canonical-link contradictions to `unresolved_structure`, so the DB hold covers only true `identity_redirect` outcomes until the candidate is deployed.
7. **Scale.** The per-row eligibility function in the claim scans observations by number or URL, which have no index. That is fine at 38 identities; add indexes before large catalogs.
8. **Tooling debt:** the stale 16.24 harness (§23); the inherited 16.23 test was edited (§20); benchmark runners write in place (redirect outputs next time).
9. Other sessions' scratchpads under `/private/tmp/claude-501/…` still hold operational files. They were not read, beyond the 20163 replay bytes and expectations.

## 29. Phase 16.30 recommendation — install the eligibility fix, inactive only

1. Re-verify SHAs: migration `154b96b0…3c4c` and worker source set `9e6e318e…4a02`.
2. Apply the one migration to production; no page call.
3. Deploy the worker candidate (unscheduled, `verify_jwt=true`), or defer it explicitly. The DB gate works with the deployed bundle.
4. As a separately authorized owner write, run `private.cpsc_import_backfill_page_holds` with `docs/phase-16-15-backfill-manifest.json` after confirming its canonical hash is `a8bce170…`.
5. Verify read-only:
   - 26777 `human_reconciliation_required`
   - 26749/26753/26754/26756/26763/26766 `unresolved_quarantine`
   - 31 eligible including 20163
   - natural order led by 20164, with 26773 at 6
   - remote pgTAP passes
   - 0 page attempts added
6. Keep out of scope: no schedule, no page call, no reconciliation or capability grant, no v2, no Nebius.
7. **Then Phase 16.31:** a separately authorized table-bearing shadow test through the natural queue (§16), with no override.
