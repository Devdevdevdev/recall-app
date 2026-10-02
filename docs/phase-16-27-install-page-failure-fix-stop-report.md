# Phase 16.27 — install page-failure fix (inactive) — stop report

**Classification: GREEN.** The Phase 16.26 migration and the reviewed page worker are installed in production. The worker is inactive and unscheduled, and no page was processed. Stop for review.

## Status timeline

| #   | When (UTC, 2026-09-29) | Event                                                                                         | Actor                  | Independently verified result                                               |
| --- | ---------------------- | --------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| 1   | ≈08:31                 | `supabase db push --linked` denied by the Claude Code auto-mode permission gate               | Claude permission gate | Push did not run; production unchanged                                      |
| 2   | before 08:55           | First manual push reported                                                                    | User                   | **Not reflected:** 08:55 check showed 27 migrations, no 16.26 objects       |
| 3   | 08:55–09:00            | Manual push repeated                                                                          | User                   | **Applied:** 09:00 check shows 28 migrations and 16.26 present exactly once |
| 4   | 09:00–09:05            | Migration, schema/ACL, and old-attempt verification; rollback-only production pgTAP           | Claude                 | All pass (§§6–12)                                                           |
| 5   | ≈09:08                 | `npx supabase functions deploy process-cpsc-page-evidence --project-ref cnftnulgtsraurtusnpb` | Claude                 | **Completed; not blocked.** Worker v2 → v3                                  |
| 6   | 09:08–09:15            | Deployed-source proof, unauthorized smoke, and post-deploy audits                             | Claude                 | All pass (§§13–25)                                                          |

Claude applied no migration. The only production database mutation in this phase is the user's manual push. Claude's only production code change is the one authorized worker deploy.

## 1. Worktree handoff

- Branch `main`; all inherited modified and untracked work was preserved. There was no reset, clean, clone, commit, or push.
- The Phase 16.26 report is unchanged, SHA-256 `50ae8dda7b6edefad0be40f1bd8f2005488e64194c23bf873a6d1bb758ef732f`.
- Phase 16.23 migration: `714e497ac418eece958d540cf8e822ec2f255dadb575d0f6d09f25e40404b90c`. Phase 16.24 migration: `86169916e47ac1dc1cd2ad7a5531d4be830f616b045b066efc72b453d9de987d`. Both are unchanged.
- New in this phase:
  - this report
  - `supabase/tests/remote/phase-16-26-page-failure-evidence.sql`, SHA-256 `9a04ad694c37b19bc01df9e92d86e8c036f76c1a02d6b51ae9d5815898b7715e`

## 2. Phase 16.26 artifact hashes

- **Migration** `20260928155514_phase_16_26_page_failure_evidence_and_coverage_compatibility.sql`: `e7f1da30ce3314b99f39d40e76190bf91c1285eacf8e7a290c900836c55bbae2`. Matches the report; rechecked before the push and again after it.
- **Worker source set:** `3434b294c555348ad939a20f242c267e6a3eb6cf0dce11adb516c50b1d9a2c44`. Matches the report and was rechecked right before deploy.
  - Method: SHA-256 over sorted `path<TAB>sha256<LF>` records.
  - Of all 8-module subsets of the CPSC shared modules, exactly one reproduces the reported hash. It is these nine files:

| File                                                     | SHA-256                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `supabase/functions/process-cpsc-page-evidence/index.ts` | `eb3ef31e57c36ceff98648062c69667d25e9b26123c86625ba3f1d3889677055` |
| `supabase/functions/_shared/cpsc/htmlEntities.ts`        | `e56f63a4a96f9b58e04306e0c27f1f38357e072967398e03e0bd66b6952ce4e1` |
| `supabase/functions/_shared/cpsc/htmlExtractor.ts`       | `666193bf11bf36575f4272c4ad8d43ffbfd643815a94696ba76585e7488583bd` |
| `supabase/functions/_shared/cpsc/identity.ts`            | `780bde2ef8fc9694a81ac36bf30708c9755198a55926fa378c61ed51734cc041` |
| `supabase/functions/_shared/cpsc/pageEvidence.ts`        | `513d63f55da92ec58aa1a3750027999167955a467dfc9487caf3f325b62b6d52` |
| `supabase/functions/_shared/cpsc/pageFetcher.ts`         | `93537f27dfbe144605a3146422f7e9a2cbcb46c44d441894e976f91d34eebd31` |
| `supabase/functions/_shared/cpsc/scheduledPageWorker.ts` | `d581ba00028fb20c93e31e75dc527bb9013b586ab2e9e34d0ef82d8645c12da4` |
| `supabase/functions/_shared/cpsc/sourceCoverage.ts`      | `c81621d3d6416bba4cf371d69ccb21553a2851d6fb7f3b92362c3074473fe30b` |
| `supabase/functions/_shared/cpsc/validation.ts`          | `e4da2afc0d6d02cfda97da47a2374b18b72915b5ead8865ac017b4725ce4e619` |

The wider 24-file import graph adds only files reachable through `import type` edges, which Deno erases at bundle time. The deployed file set in §14 confirms this.

## 3. Local revalidation

| Gate                                                                    | Result                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `supabase db reset --local --no-seed`                                   | 28 migrations                                                            |
| Full pgTAP (pre-existing suite)                                         | **1509 / 1509**, 19 files                                                |
| Full pgTAP including the new remote suite, clean reset                  | **1681 / 1681**, 20 files                                                |
| Full Node suite                                                         | **385 / 385**                                                            |
| Targeted worker tests                                                   | 14 / 14                                                                  |
| Deno check, all 8 functions + `_shared/cpsc/*.ts`                       | exit 0                                                                   |
| Expo `tsc --noEmit`                                                     | exit 0                                                                   |
| DB lint (`--level error`)                                               | 0 results                                                                |
| Historical backfill rehearsal (frozen 16.13 manifest)                   | 26 / 26; remote-safe 89 / 89                                             |
| Phase 9.1 / 15 / 16 freeze guards                                       | frozen=true                                                              |
| Phase 9.1 holdout replay (to scratch; the in-repo result is write-once) | 36 cases, 0 false positives                                              |
| Deterministic v2                                                        | 200 cases, 0 unsafe confirmations                                        |
| v2.1 safety                                                             | 0 unsafe confirmations; 66 / 66 needs-review preserved; 0 provider calls |
| `git diff --check`                                                      | clean                                                                    |

**Deterministic v2 replay:** it rewrites the frozen `benchmarks/recall-matching/phase-16/results/deterministic-v2-all.json`. With `generatedAt` ignored the output is deep-equal; the other differences are only formatting. The frozen bytes were restored to `be1961c323b5c9cd690ac1181804a9b289f8f1fda32d7d1a7335b7b8041e37c1`, all 86 benchmark files hash-match the pre-run snapshot, and the freeze guard passes.

**Rehearsal residue:** the backfill rehearsal leaves 27 identities in the local DB. With them present, the original local 16.26 test fails at its first claim, because the claim selects a rehearsal identity. A clean reset restores the full pass. This is a local test-ordering hazard, not a product regression.

## 4. Production preflight

Taken at 08:28 UTC, before the push. The continuation rechecks at 08:55 and 09:00 matched it except for the migration.

- **Migrations and worker:** 27 migrations, 16.26 absent. Worker v2 with bundle `e6170ed62766b22d5630e9a1028834552147dabbca5413bdbe22b3a8c316d50f`.
- **Cron:** only job 2, `recall-automation-every-6h`, `17 */6 * * *`, active, command MD5 `07549bf985a3034a5ef9c645692097b6`. No page reference.
- **v1 health:**
  - latest cron runs at 06:17 and 00:17 UTC both `success`
  - CPSC `last_publish_date=2026-09-29` and Health Canada `last_updated_date=2026-09-29`, both `success`
  - automation watermark `2026-09-29`; no automation lease; 0 matching leases
- **CPSC safety:** `safe=true`, 9 quarantined / 9 retained, 0 unaccounted, 0 legacy hash-only.
- **Record counts:**
  - 87 notices; 27 page revisions; 27 page fetches
  - 1 page work-state and 1 attempt; 0 raw payloads, coverage ledgers, and candidates
  - 0 review-ledger rows, reviewer authorizations, reviewed criteria, rule sets, and v2 rows
  - 0 matches, alerts, push queue, and push deliveries
  - 0 reconciliations; 282 aliases; 38 identities (all `reconciled`, the backfill status); 109 observations; 37 observation payloads
- **Matcher policy:** `RECALL_MATCHING_POLICY` absent, so the default `phase_10_guarded_v1` applies.
- **Secrets:** 17 secret names; the set fingerprint was recorded (digest-derived, no values).

## 5. Old failed-attempt snapshot (immutable pre-fix artifact)

**Attempt `0bf98d4e-9c4b-42ce-a430-d20bfe97ac84`**, identity `4c5f90a1-26ea-4468-a926-4f5e077ddabf` (recall 20162):

| Field                                               | Value                              |
| --------------------------------------------------- | ---------------------------------- |
| outcome                                             | `claimed`                          |
| claimed_at                                          | `2026-09-28 15:30:35.228402Z`      |
| completed_at                                        | null                               |
| error_code                                          | null                               |
| http_status / final_url / hashes / revision / fetch | all null                           |
| Original-column projection MD5                      | `b96e4683450f6ce083517d46be49c39a` |

**Work-state:**

| Field                          | Value                                   |
| ------------------------------ | --------------------------------------- |
| claim_id                       | the attempt above                       |
| claim_expires_at               | `2026-09-28 15:31:05.228402Z` (expired) |
| next_attempt_at                | `2026-09-28 15:30:35.228402Z`           |
| attempt_count                  | 1                                       |
| consecutive_failures           | 0                                       |
| last_outcome / last_success_at | null                                    |
| Projection MD5                 | `a24c1f96a3d04fb933c74d44758f9d13`      |

## 6. Migration dry run

`supabase db push --dry-run --skip-vault --linked` listed exactly `20260928155514_phase_16_26_page_failure_evidence_and_coverage_compatibility.sql`, with `seeds=[]` and `roles=[]`.

## 7. Migration application result

- **First attempt:** the auto-mode gate denied Claude's push.
- **User's manual push:** the first run was not reflected; the second applied.
- **Verification at 09:00 UTC:**
  - Version `20260928155514`, name `phase_16_26_page_failure_evidence_and_coverage_compatibility`, appears **exactly once**.
  - **Exact artifact proof:** production stores 27 statements, statement-array MD5 `150bdeb79c747c8815691231b395bbad`. That is identical to the local record the same CLI parsed from the file hashing `e7f1da30…bbae2`.
  - The Phase 16.23 (15 statements, `a2e3ee3c7e895ae141df21c5213fa2b3`) and Phase 16.24 (23 statements, `74a7323114b66a6d078b244bf43bac2a`) records are identical to local and unchanged.
  - No seed or roles change occurred.

## 8. Final production migration count

**28.**

## 9. Schema / grant diff

**Production matches the reviewed build.** Its catalog is identical to the local reviewed build of the same 28 migrations on every fingerprint:

| Fingerprint                                                   | Value                              |
| ------------------------------------------------------------- | ---------------------------------- |
| Functions (definition + ACL + SECURITY DEFINER + config), 131 | `0a3536e83776dae0c50f2cfbc5edd7ae` |
| Function ACLs                                                 | `d460978de9b3fd8d2aed1a5960da4351` |
| Relations incl. indexes (kind + ACL + RLS + force-RLS)        | `ee58e2b0d0d8c569e95a2b1fb097b2e6` |
| Relation ACL/RLS, 62                                          | `c46a05950334db32f7f50cdfa4f33353` |
| Columns                                                       | `a61a183a5f822d39c4f7ed16c7a1efba` |
| Constraints                                                   | `71502657c2f7b18f0e1709a4e134435f` |
| Triggers                                                      | `10394c4ba1e88112ba6c08fed5ac06ba` |
| RLS policies                                                  | `0f9490a164e95c6c0eff97b311116e94` |

**What changed against the pre-migration baseline:**

- Functions went from 127 to 131. The four new ones are `public.retain_cpsc_page_transport`, `private.cpsc_reject_structural_snapshot_change`, `private.cpsc_expected_page_tables`, and `private.cpsc_record_page_structural_snapshot`.
- Relations went from 61 to 62, adding `private.cpsc_page_structural_snapshots`.
- Replaced functions kept their ACLs (`create or replace`).
- **Worker EXECUTE:** before, claim, finish, and verified commit. After, those three plus `retain_cpsc_page_transport` and nothing else. Three pre-existing `private.*_v2()` trigger functions remain reachable through default PUBLIC EXECUTE; they return `trigger`, cannot be called directly, and are unchanged.
- **Worker role:** login; not superuser; no BYPASSRLS, CREATEROLE, or role memberships. Config unchanged: `statement_timeout=4s`, `lock_timeout=3s`, `idle_in_transaction_session_timeout=5s`.

## 10. Rollback-only production pgTAP

`node scripts/run-remote-pgtap.mjs --file supabase/tests/remote/phase-16-26-page-failure-evidence.sql` returned **172 / 172 ok, 0 not ok**:

- `psqlExit=0`, `extensionCreated=true`, `rolledBack=true`
- pgTAP installed before 0 / after 0; idle-in-transaction after 0
- guards and migration history unchanged

**Target check:** a read-only probe confirmed the database URL pointed at production (28 migrations, 87 notices, user `postgres`) before the run. The URL was never printed.

**How the suite stays production-safe:**

- Fixtures sort strictly ahead of every real identity: `next_attempt_at='-infinity'` and 1900 ordering timestamps, against a real minimum `first_seen_at` of 2026-09-26.
- Semantic checks are deltas against baselines captured in the same transaction.
- It asserts that no non-fixture identity received an attempt or work-state.
- It asserts that the historical attempt and work-state MD5s are unchanged.
- It was rehearsed locally with 27 unrelated identities present (172 / 172) and after a clean reset (1681 / 1681).
- The only test-only grant (`extensions` usage to the worker) rolls back.

**Residue check (read-only, afterwards):**

- pgTAP not installed
- 0 fixture identities, notices, and links
- worker has no `extensions` usage
- page counts unchanged; function catalog MD5 unchanged

**Contracts covered:**

- historical revision compatibility: a zero-identity legacy revision reproduces the old coverage failure, then accepts after an additive snapshot; its own column is not rewritten
- canonical census (exactly one recomputed table identity)
- raw transport retention; SHA mismatch and wrong-final-URL rejection
- raw payload and structural snapshot immutability (UPDATE and DELETE → 42501)
- semantic-rejection atomicity (0 revision, fetch, ledger, candidate, or snapshot delta; exactly +1 raw payload)
- terminalization with stable error codes; forged success outcomes and free-text codes rejected
- retry/backoff: +100 years with manual review, +1 hour, +1 day, +7 days, and bounded exponential 2400 s at the 4th failure
- expired-claim recovery with history preserved, superseded late finish, one active claim
- role boundaries (§22)
- no automatic review, reconciliation, alias, criteria, rule set, match, or alert

## 11. Raw-evidence rollback proof

Fixture A inside the rolled-back transaction:

1. Claim.
2. Owner-session retain rejected (42501). Mismatched hash rejected. Wrong final URL rejected.
3. Valid retain returns the byte SHA.
4. Verified commit rejected (`Invalid CPSC coverage ledger`).
5. `finish(... 'evidence_rejected' ... 'semantic_commit_rejected')` succeeds.

Result:

- The attempt keeps the transport-only link and the payload is byte-identical to the input.
- Revision, fetch, ledger, candidate, and snapshot counts are unchanged; exactly one raw payload was added.
- All of it rolled back.
- No live official page was fetched.

## 12. Terminalization rollback proof

| Case                        | Outcome                | Error code                 | Retry state                                                           |
| --------------------------- | ---------------------- | -------------------------- | --------------------------------------------------------------------- |
| Coverage/evidence rejection | `evidence_rejected`    | `semantic_commit_rejected` | claim released; `manual_review_required=true`; next = now + 100 years |
| DB timeout                  | `database_timeout`     | `database_timeout`         | next = now + 1 hour; failures 1; no manual review                     |
| Parser/internal failure     | `internal_failure`     | `worker_exception`         | next = now + 1 day                                                    |
| Unresolved structure        | `unresolved_structure` | `unresolved_structure`     | next = now + 7 days                                                   |
| Transient                   | `temporary_failure`    | `upstream_unavailable`     | next = now + 2400 s (4th consecutive failure)                         |

- Every fixture attempt ended with `completed_at` set and 0 left `claimed`, with no partial semantic data.
- A superseded late `database_timeout` finish terminalized only its own attempt.
- An actual 4-second role-timeout cancellation was not run in production; the timeout was proven locally in Phase 16.26.

## 13. Worker deployment

|        | Version | Bundle SHA-256                                                     | verify_jwt |
| ------ | ------- | ------------------------------------------------------------------ | ---------- |
| Before | 2       | `e6170ed62766b22d5630e9a1028834552147dabbca5413bdbe22b3a8c316d50f` | true       |
| After  | **3**   | `0194da286210fa990a613e81e272adad273041ec7fee66fda6230a1772d2e41f` | true       |

- The reviewed source-set hash `3434b294c555348ad939a20f242c267e6a3eb6cf0dce11adb516c50b1d9a2c44` was rechecked immediately before deploy.
- Deploy script size was 116 kB.
- No secret was set or rotated; `CPSC_PAGE_WORKER_KEY` is untouched.

## 14. Deployed-vs-reviewed source proof

The deployed source was downloaded into an isolated scratch workdir, with the repo's function sources verified untouched. It contains exactly the nine reviewed files; each is byte-identical to the local candidate, and the deployed source-set hash is `3434b294…2c44` (full value in §2).

The only environment reads are `CPSC_PAGE_DB_URL` and `CPSC_PAGE_WORKER_KEY`. There are zero service-role or shared-DB-URL references. The download was deleted afterwards.

## 15. Unauthorized smoke results

| Request                                   | Status | Body                                                                                 |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| GET, no auth                              | 401    | gateway `UNAUTHORIZED_NO_AUTH_HEADER`                                                |
| POST, no auth                             | 401    | gateway                                                                              |
| GET, public client key                    | 405    | `Only POST is allowed.`                                                              |
| POST, public key, no worker key           | 401    | `Unauthorized.`                                                                      |
| POST, public key, random wrong worker key | 401    | `Unauthorized.` (first try: curl status 000 with this body; clean rerun: HTTP/2 401) |
| PUT, public key, wrong key                | 405    | `Only POST is allowed.`                                                              |

- The valid worker key was never used.
- The key check precedes any DB access.
- The public client key was loaded from `.env.local` and not printed.

## 16. Proof no page was processed

At 09:11 UTC:

- 1 work-state and 1 attempt; 0 raw payloads, coverage ledgers, candidates, and structural snapshots
- 27 revisions and 27 fetches, both unchanged
- old attempt and work-state projections unchanged

No claim, fetch, or semantic revision came from deployment, smoke, or tests.

## 17. Worker scheduling / reference audit

- `cron.job` has only job 2, with no page reference. There were 0 cron runs between 08:25 and 09:11 UTC.
- The deployed sources of all seven other functions (`run-recall-automation`, `ingest-recall-sources`, `ingest-recall-source`, `ingest-cpsc-recalls`, `process-recall-matches`, `send-recall-notifications`, `process-recall-matches-v2-cohort`), including their bundled shared modules, contain **zero** references to any of:
  - the worker slug or `scheduledPageWorker`
  - the four page RPCs
  - `CPSC_PAGE_WORKER_KEY`, `CPSC_PAGE_DB_URL`, or `x-cpsc-page-worker-key`

## 18. v1 cron integrity

Unchanged: `17 */6 * * *`, `active=true`, command MD5 `07549bf985a3034a5ef9c645692097b6`, and no page stage.

## 19. v1 health

- latest normal runs at 06:17 and 00:17 UTC both `success` with no error
- both sources `success` at `2026-09-29`; automation watermark `2026-09-29`
- no automation lease, 0 matching leases, 0 push deliveries
- CPSC `safe=true`, 9 / 9

No natural cron run occurred during the phase; the next is 12:17 UTC.

## 20. v2 / review state

- 0 reviewed criteria, rule sets, review-ledger rows, and reviewer authorizations
- 0 v2 evaluations, eligibility, snapshots, and corrections
- `RECALL_MATCHING_POLICY` absent, so the default `phase_10_guarded_v1` applies

There was no cohort run and no human review action.

## 21. Identity / 26777 / quarantine

- 38 identities, all `reconciled` (backfill status); 0 reconciliation rows; 282 aliases; 109 observations; 37 payloads. All unchanged.
- **26777** `d3d6654d-cf54-4edf-a095-ff82cd5a15cc`:
  - `-Hazard-0` URL
  - fingerprint `05137337152ad39ad688691252a3ba1250883df8cf1df22c0ef2ef0c3a295cc7`
  - 2 links, 10 aliases, 1 revision, 3 observations
  - last seen `2026-09-27 05:43:30Z`

  All unchanged.

- **Nine quarantines:** ID-set MD5 `21a70604b31b50ddb67ee7e9f8bc4050`, identical before and after.

No natural ingestion occurred.

## 22. Authorization matrix (production, verified in-transaction and by catalog)

- **anon / authenticated:**
  - cannot execute retain, claim, finish, verified commit, the legacy unverified commit, legacy revision/fetch/propose/coverage writes, or fetch targets
  - no SELECT/INSERT/UPDATE/DELETE/TRUNCATE on snapshots, raw payloads, attempts, or work-state
- **service_role:**
  - the same denials; the legacy direct page-write bypass is not regained
  - `private.cpsc_is_worker()` still names `service_role`, but EXECUTE ACLs deny it on every page RPC
- **`cpsc_page_worker`:**
  - executes exactly `claim_cpsc_page_evidence`, `finish_cpsc_page_attempt`, `commit_cpsc_page_evidence_verified`, and `retain_cpsc_page_transport`
  - no direct table write privilege anywhere in `public` or `private`
  - cannot reconcile, review, authorize reviewers, materialize criteria, finalize matches, create alerts, write watermarks or automation state, or run the legacy page sequence

## 23. Secret hygiene

- No unsanitized `supabase status` was run.
- Secrets were listed by name only; digest fingerprint only. The secret set is unchanged (17).
- The DB URL and client key were used only through environment variables and never printed.
- **Targeted credential scan: 0 findings** across:
  - scratch logs, wrapped SQL, and downloaded sources (the downloads were then deleted)
  - the tracked `git diff`
  - the new remote suite and this report
  - all untracked `docs`, `scripts`, `tests`, and `supabase` files

## 24. Function version / hash audit

| Function                           | Version   | Bundle SHA-256                                                                       | Changed            |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------ | ------------------ |
| `process-cpsc-page-evidence`       | 2 → **3** | `e6170ed6…d50f` → `0194da286210fa990a613e81e272adad273041ec7fee66fda6230a1772d2e41f` | **yes (intended)** |
| `ingest-cpsc-recalls`              | 18        | `2b0774c51d752cb9a5b3e83e741e2513cc4b9930fd7f918791408760edcc0dc3`                   | no                 |
| `process-recall-matches`           | 13        | `81f96b1d69c5b2f0df47a20ae2cb70b834254ae977fd368abe14d3722e308d6b`                   | no                 |
| `send-recall-notifications`        | 8         | `58b6945b6213c79d1b78eb12c8fac25f37ebb2951ecdee8ea01b64a0157211f5`                   | no                 |
| `run-recall-automation`            | 5         | `29aa16817f966e20021235d42a92d37b82c19d763b13b0df0bc281445c1cef6c`                   | no                 |
| `ingest-recall-source`             | 7         | `ba3949921003fdc94e0f9ecd16fe088ba24b515b7b0fd69df16319f2084d869d`                   | no                 |
| `ingest-recall-sources`            | 4         | `c41cb92edc42ffa42b154561f6c6fbee780e832e6488d18d21c12a0ca6daaae6`                   | no                 |
| `process-recall-matches-v2-cohort` | 3         | `682308bdfe9657c66408c58b1cf25d6be8bd26cff4f929d7ac21ee7b41201f1e`                   | no                 |

No platform-side version increment occurred on the other functions.

## 25. Final production fingerprint

**Intentional persistent changes:**

- the Phase 16.26 migration record and schema objects (§§7–9)
- `manual_review_required=false` on the one existing work-state (column default)
- null transport columns on the old attempt
- worker deployment v3

**Unchanged:** every business, safety, page-processing, identity, review, v2, cron, secret, and other-function fingerprint in §§16–24. The failed Phase 16.25 attempt remains `claimed` and expired, with original-column MD5 `b96e4683…c39a` identical to the pre-migration snapshot.

## 26. Classification

**GREEN.** All of the following hold:

- the exact migration was applied (statement-level proof) and the exact worker deployed (byte-level proof)
- rollback-only production tests passed 172 / 172 with no residue
- ACLs are narrow; the worker gained only the reviewed transport RPC
- the worker is unscheduled and unreferenced
- the old attempt is preserved and no page was processed
- v1 is healthy and v2 is inactive
- no secret was exposed

## 27. Remaining risks

- The deployed worker has never processed a live page. The new transport-first and terminalization paths are proven only by fixtures.
- The old attempt stays `claimed` and expired forever by design. Tooling must find active claims through the work-state `claim_id` and an unexpired lease, not `outcome='claimed'`.
- Identity `4c5f90a1…` (recall 20162) is due and recoverable, with an expired lease and `manual_review_required=false`. It now sorts **behind** every never-attempted identity (`next_attempt_at` 2026-09-28 versus `-infinity`), so the Phase 16.25 Intertex page will not be retried first.
- The Phase 16.25 raw bytes are unrecoverable.
- The DB-timeout path was not exercised live in production.
- `private.cpsc_is_worker()` still names `service_role` internally. ACLs block it today, so any future grant to `service_role` on a page RPC would reopen that path.
- Running the backfill rehearsal before local pgTAP makes the local 16.26 test fail; reset first.
- The Claude auto-mode gate blocks production migration pushes, so future phases should plan a manual push step.

## 28. Phase 16.28 recommendation

Run a separate, explicitly authorized phase for **exactly one** production page invocation:

1. **Preflight.** Take a fresh read-only preflight against §§16–25.
   - A read-only replica of the claim ordering at 09:15 UTC (no lock, no RPC call) predicts **recall 20163** (`4c082234-f8cc-4153-81b2-5d460b742717`), then 20164 and 20165. These are never-attempted identities; recall 20162 sorts after all of them.
   - Re-run that prediction and state it before the call.
   - If retesting the Intertex failure specifically is the goal, that needs a separately reviewed, audited targeting decision. It is not a manual work-state edit.
2. **Worker key.** Obtain or reprovision `CPSC_PAGE_WORKER_KEY` through a secure path the operator controls, without echoing it. If it is rotated, record only that rotation happened.
3. **One call.** Make one POST with `maxPages=1` and a bounded time budget, with no schedule.
4. **If semantic rejection recurs:**
   - raw bytes retained and SHA-verified
   - the attempt terminal as `evidence_rejected` with a stable code
   - the work-state set to manual review with a 100-year park
   - zero semantic rows
   - the historical attempt untouched
   - offline replay of the retained bytes reproducing the rejection
5. **If the page succeeds:**
   - raw replay reproducing the semantic hash and ledger
   - a coverage ledger with a structural snapshot where legacy
   - candidates created only as proposals, with no review, reconciliation, or materialization
6. **Afterwards:** check v1 health and cron integrity. Keep scheduling, review, v2, and Nebius out of scope.
