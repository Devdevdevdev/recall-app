# Phase 16.15 stop report: manifest provenance fix, production backfill, inactive ingestion deployment

Status: **complete; stop for review.** The historical backfill ran once in production and was
proven idempotent by a second run. Two ingestion functions were redeployed with the cron still
paused (`active = false`, schedule `17 */6 * * *` unchanged). There was no migration, no human
review or reconciliation, no reviewed criteria, no v2 activation, no Nebius call, no commit, and
no push.

## 1. Worktree

- Nothing was reset or discarded. The only changed tracked file is `package.json` (two scripts
  added, and `test:phase-16-15` added to `check`).
- New files: `scripts/lib/cpscBackfillManifest.mjs`, `scripts/run-remote-pgtap.mjs`,
  `tests/phase-16-15-manifest-provenance.test.mjs` and seven `docs/phase-16-15-*.json` artifacts.
- Edited untracked scripts: `scripts/build-phase-16-13-backfill-manifest.mjs`,
  `scripts/capture-phase-16-13-cpsc-fresh.mjs` and `scripts/rehearse-phase-16-13-backfill.py`.
- The 16.9–16.13 migration files are byte-identical to their accepted hashes:
  `615c88ca…5b7`, `89a96abc…0540`, `4e8589be…c0ce`, `45da9c3a…4651`, `2fc1030a…02bc`.
- No migration was needed.

## 2. Manifest-script provenance fix

- The builder logic moved to `scripts/lib/cpscBackfillManifest.mjs`. The CLI requires all five of
  `--notices`, `--capture`, `--pages-from`, `--out` and `--diff-out`. There is no default and no
  inferred phase path.
- The manifest records each input path exactly as given, with the SHA-256 of the bytes read. The
  new `noticeSnapshot` and `pagesSource` blocks sit alongside `freshCapture`.
- The builder refuses a capture that does not cover every stored recall number. It also refuses to
  let an output path overwrite an input.
- The capture script requires `--notices`, `--pages-from` and `--out`. The rehearsal script
  requires the manifest path.
- `tests/phase-16-15-manifest-provenance.test.mjs` has 9 tests:
  - 16.14 capture input produces a 16.14 reference, never the 16.13 path.
  - The recorded path always names the bytes that were hashed.
  - The CLI fails without explicit paths.
  - The older 16.13 capture is refused for the 16.14 snapshot.
  - The refactored builder reproduces the frozen 16.13 manifest.
  - The fix leaves the 16.14 operational content unchanged.
  - The pgTAP wrapper is tested too.

## 3. Remote pgTAP harness

`npm run test:remote-pgtap` runs `scripts/run-remote-pgtap.mjs`. It injects
`create extension pgtap with schema extensions;` directly after the suite's own `begin;`. The
suite file itself is unchanged; the only difference is that one injected line, which the tests
verify.

The wrapper refuses a suite that:

- lacks `BEGIN` or `ROLLBACK`
- contains `COMMIT`
- manages extensions itself

It also refuses to run if pgTAP is already installed. It passes only when:

- the complete plan runs
- the extension was created inside the transaction
- `ROLLBACK` completed
- pgTAP is absent afterwards
- no session is left idle in a transaction

## 4. Production baseline recheck (read-only)

| Check                                  | Value                                                       |
| -------------------------------------- | ----------------------------------------------------------- |
| Notices / CPSC / Health Canada         | 79 / 41 / 38                                                |
| Scopes                                 | 92                                                          |
| CPSC snapshot md5                      | `20f258cd29950287c34f91803a35f4a1`, same as 16.14           |
| Notice / scope fingerprints            | `1364c126…` / `afe33045…`, unchanged                        |
| Historical-rows digest                 | `5cae8111…`                                                 |
| Cron                                   | job 2, `17 */6 * * *`, `active = false`; last run 06:17 UTC |
| Reviewed criteria / v2 / alerts / push | all 0                                                       |
| CPSC infrastructure tables             | all 0                                                       |

- The snapshot was re-exported read-only and is **byte-identical** to
  `docs/phase-16-14-cpsc-notice-snapshot.json` (`f61c8168…`).
- A read-only re-capture of the CPSC API and pages (19:09 UTC) matched the frozen 16.14 capture on
  every consumed field:
  - recall numbers, API IDs, URLs, titles, dates, UPCs and payload hashes
  - identity statuses
  - page canonical and final URLs, semantic-evidence hashes and coverage fingerprints
- Only raw HTML byte hashes differed, on 16 pages. That is dynamic markup, and the manifest does
  not consume those hashes.
- Evidence: `docs/phase-16-15-capture-currency-check.json`. The 16.14 capture was therefore reused.

## 5. Corrected manifest

| Item                | Value                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| Manifest            | `docs/phase-16-15-backfill-manifest.json`                                 |
| File SHA-256        | `e3ab192c397fa1a50ac5e34595358a7fe02a873e26c8891197d46c659487d9ed`        |
| Canonical / DB hash | `a8bce170402bc3470d73b4a338ea9f6da5df01e16d76429f8142496b6c273c3c`        |
| Fresh capture       | `docs/phase-16-14-cpsc-fresh-capture.json`, `c4b43808…4bea`, 09:06:13 UTC |
| Snapshot            | `docs/phase-16-14-cpsc-notice-snapshot.json`, `f61c8168…6540`             |
| Page source         | `docs/phase-16-12-backfill-manifest.json`, `b3d119ca…8501`                |

- The local canonical hash equals the DB's `manifestSha256`. The same check on the old manifest
  gives `6dddac41…`, which matches the 16.14 preview.
- The manifest was generated only by the fixed script, and regeneration is byte-identical.

## 6. Manifest semantic diff (`docs/phase-16-15-manifest-provenance-diff.json`)

- **Changed:**
  - `freshCapture.file` (`phase-16-13-…` → `phase-16-14-…`)
  - `manifestGeneration`
  - `source`
- **Added:** `noticeSnapshot` and `pagesSource`.
- **Unchanged:**
  - `freshCapture.sha256` and `capturedAtUtc`
  - every operational field, with operational-view hash `9461516b…` on both sides
- Counts: 38 identities, 41 notices, 27 pages, 37 current observations, 11 exercised drift rows,
  6 collisions, 1 unresolved (26777/10987).

## 7–8. Corrected previews

- Both previews were identical to each other.
- Each was identical to the 16.14 preview except for `manifestSha256` (`a8bce170…`).
- Structure: 38 identities / 41 links / 82 aliases / 41 API revisions / 27 page revisions /
  27 fetches, 256 new rows, 0 conflicts.
- Observations: 41 historical + 37 current = 78; 6 quarantines.
- Production state was identical across all four snapshots taken around the previews.
- Artifact: `docs/phase-16-15-backfill-preview.json`.

## 9–11. Real backfill #1 (table by table)

The per-table expectations were derived read-only and frozen **before** execution in
`docs/phase-16-15-backfill-expected.json`. The observation gate writes its own aliases and API
revisions, so the table totals exceed the preview's structural counts.

| Table                   | Before | Expected | After |
| ----------------------- | -----: | -------: | ----: |
| source identities       |      0 |       38 |    38 |
| notice identity links   |      0 |       41 |    41 |
| source aliases          |      0 |      226 |   226 |
| API revisions           |      0 |       48 |    48 |
| page revisions          |      0 |       27 |    27 |
| page fetches            |      0 |       27 |    27 |
| identity observations   |      0 |       78 |    78 |
| backfill runs           |      0 |        2 |     2 |
| backfill items          |      0 |      334 |   334 |
| all 8 other CPSC tables |      0 |        0 |     0 |

- Aliases: 82 structural + 82 historical-observation + 62 current-observation.
- API revisions: 41 structural + 7 new current payloads.
- Items per stage match exactly.
- The execute report equals the preview apart from mode, persisted and run IDs.
- Canonical identity digest `41708282…` matches the preview.
- UUID-free lineage digest: `09511692…ccac0`.
- Artifact: `docs/phase-16-15-backfill-execution.json`.

## 12. Business integrity

All consumer counts and the notice, scope, match, alert, product and push fingerprints are
unchanged. The historical-rows digest and the snapshot md5 are unchanged. Reviewed criteria,
v2 evaluations, eligibility, snapshots and corrections are all 0.

## 13. Quarantine

Six `D_api_id_reuse` observations are quarantined:

| API ID | Recall |
| ------ | ------ |
| 10965  | 26753  |
| 10966  | 26763  |
| 10967  | 26754  |
| 10968  | 26756  |
| 10969  | 26749  |
| 10970  | 26766  |

There are 0 reconciliations and 0 reconciled aliases.

## 14. 26777 remains unresolved

- **Stored structure only:**
  - the identity keeps its `…-Hazard-0` canonical URL
  - 2 links
  - 2 historical stored-notice observations (API 10990, API 10987)
  - 1 historical page revision
- **Withheld:** its current capture observation (API 10987).
- **Not created:** any `…-Hazard` alias or reconciliation.
- **Evidence kept:**
  - API ID 10987 and API URL `https://cpsc.gov/…-Hazard-0`
  - HTTP 301 to `https://www.cpsc.gov/…-Hazard`, re-verified today
  - payload `7c7daf62…` (unchanged)
  - raw page hashes `5c86331e…` (16.14) and `16a7a1a7…` (today)

## 15. Real backfill #2 (idempotency)

- 0 new rows in both stages: everything is reported as reused, and 78 observations as already
  recorded.
- Full-row fingerprints of all 8 data tables are identical, so there were no updates.
- Digests and the lineage digest are unchanged.
- The only additions are 2 run-audit rows (run seq 11/12), which each call records by design.

## 16–17. Remote lint and pgTAP

- **Lint:** 0 errors. The only warnings are the known unused parameters on the retired approval stub.
- **pgTAP:** `npm run test:remote-pgtap` gave 89/89, with the extension created in the transaction
  and rolled back. pgTAP is absent before and after, no session is left idle, and there are no
  fixture leftovers.

## 18–20. Ingestion deployment

The call chain is cron → `run-recall-automation` → `ingest-recall-sources` → `ingest-recall-source`
(per source). `ingest-cpsc-recalls` is a manual endpoint.

| Function               | Old → new | ezbr SHA-256    | Local runtime source-set SHA-256 | Reason                                                                         |
| ---------------------- | --------- | --------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| `ingest-cpsc-recalls`  | 14 → 15   | `00849ced…0b6b` | `bb966162…abd5`                  | v14 called `ingest_cpsc_recall`, which is revoked from `service_role`          |
| `ingest-recall-source` | 2 → 3     | `e338d781…d7f4` | `f8bb8441…67e6`                  | v2 sent CPSC to `ingest_authoritative_recall`, which now raises 42501 for CPSC |

- **Not redeployed:**
  - `ingest-recall-sources` v1: its entry point and contract are identical, and its only
    differences are shared modules it never runs.
  - `run-recall-automation` v3: identical to local.
  - `process-recall-matches` v11, the v2 cohort v1 and `send-recall-notifications` v6.
- **Authorization:** `verify_jwt = false` (as before) plus `x-recall-ingestion-key`. Database
  calls run as `service_role`, and every RPC used is `service_role`-only.
- **Deployed code check:** the downloaded bundles match local code after type erasure. They contain
  no retired RPC (`ingest_cpsc_recall`, `get_cpsc_recall_notice_id`,
  `approve_cpsc_product_model_criterion_v2`) and no Nebius code. Matcher and Nebius imports are
  type-only.
- **Trust chain:** official recall number and canonical URL, then observation and alias handling
  (numeric API ID is an alias only), then collision quarantine, then a notice revision for an
  existing notice or an identity-bound notice insert.
- **Gap:** the chain does **not** include live page evidence. The CPSC page worker has no reviewed
  entry point and stays undeployed, per the 16.13 plan.

## 21. Smoke

- **HTTP:** both functions return 405 for GET and 401 without a key or with a wrong key.
- **Rolled-back SQL as `service_role`:**
  - Recall 26798 resolves as `A_known_alias`, with the canonical notice equal to the stored notice.
  - The notice revision returns `unchanged`.
  - API 10965 is quarantined as `D_api_id_reuse`.
  - The generic CPSC path and legacy `ingest_cpsc_recall` both return 42501.
  - `authenticated` and `anon` are denied.
- State and row fingerprints are identical afterwards.
- No authorized HTTP call was made, because that would need the ingestion key.

## 22. Health Canada

- In `ingest-recall-source`, the only semantic change is the `sourceKey === 'cpsc'` branch. The
  Health Canada modules are identical to v2.
- The RPC guard blocks only CPSC.
- A read-only live adapter run normalized 11 of 11 records for 2026-09-24..26.
- Health Canada data was not touched.

## 23. Policy and v2

- `RECALL_MATCHING_POLICY` is not set, so the selector defaults to `phase_10_guarded_v1`.
- `process-recall-matches` is unchanged (v11, `81f96b1d…`).
- No v2 cohort, v2 read or v2 push. v2 tables are 0.
- No matcher invocation appears in the edge logs; those logs are incomplete, as noted in §25.

## 24. Final production snapshot (19:26 UTC)

- Cron: job 2, `17 */6 * * *`, `active = false`, still present.
- Sources: CPSC 41 and Health Canada 38, both last `success` at 06:17 UTC.
- Business counts and fingerprints are unchanged from the baseline. The only change is the
  canonical-identity digest (empty → `41708282…`).
- CPSC tables are as in §9–11, plus `backfill_runs` = 4.
- Leases: 0 active. pgTAP: 0. Idle transactions: 0.

## 25. Local quality gates

- Every `npm run check` sub-script passes: typecheck, lint, all test suites, benchmark validation,
  and the Phase 9.1, 15 and 16 freeze checks.
- The only `format:check` warning is the git-ignored `.claude/settings.local.json`, which was left
  unmodified.
- Deno check passes for all Edge Functions.
- `git diff --check` is clean.
- Trailing whitespace exists only in the frozen, hash-verified CPSC HTML fixtures from earlier
  phases.
- The secret scan found no matches.

## 26. Remaining risks

1. **No live page evidence.** New CPSC notices ingested after cron resumes will get identity,
   observation and revision lineage but no page revision, so they stay fail-closed for v2.
2. **26777.** The live API still reports `…-Hazard-0`, the identity's canonical URL, so the live
   gate will resolve new 10987 observations as known aliases. The page move stays unreconciled
   until a human decides it.
3. **Recurring quarantines.** If CPSC republishes any of the six reused-ID recalls inside a sync
   window, each run appends a quarantined observation and counts a CPSC rejection, which marks the
   CPSC source run failed.
4. **Hygiene only.** The `ingest-recall-sources` v1 bundle still carries older, unused shared-module
   copies.
5. **Authorized path untested over HTTP.** The authorized HTTP path has not run in production
   (no secret was used). Its first real exercise will be a 16.16 dry run or cron run.
6. **Cosmetic.** The run-sequence counter has gaps (previews consume sequence values), and the
   edge-log evidence is incomplete.

## 27. Phase 16.16 cron-reactivation plan (not started)

1. **Read-only preflight.** Confirm:
   - the notice and scope fingerprints, snapshot md5 `20f258cd…` and lineage `09511692…`
   - the function versions (cpsc 15, source 3, sources 1, automation 3, matches 11)
   - the cron job is present and inactive, with no active leases
2. **Decisions needed:**
   - accept risks 1–3, or first build and review the CPSC page worker
   - confirm 26777 stays unreconciled
3. **Bounded dry runs** (write nothing, because the handlers skip the DB client when
   `dryRun` is true). With the user-held ingestion key, POST
   `ingest-recall-source {"sourceKey":"cpsc","dryRun":true,…}` for the next watermark window
   (from 2026-09-24), then the same for `health_canada`.
4. **Predict the first run's writes:** observations and aliases under provenance
   `Phase 16.11 CPSC worker observation`, first notice revisions, new identities and notices only
   for new recall numbers, and quarantines only for reused IDs.
5. **Reactivate:** `select cron.alter_job(2, active := true);` with the schedule unchanged.
6. **Watch the first run** at the next `:17` slot:
   - automation run `success`, both sources `success`
   - CPSC rejections and quarantines as predicted
   - historical-rows digest unchanged
   - 0 v2 rows and a `phase_10_guarded_v1` policy
   - matches and alerts consistent with 0 owned products
7. **Rollback:** `select cron.alter_job(2, active := false);`. Backfill structure runs can be
   retracted with `private.cpsc_backfill_retract` only while nothing depends on them.
