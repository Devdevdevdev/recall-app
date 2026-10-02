# Phase 16.21 continuation stop report — B and C applied

**Disposition (2026-09-27):** B deployed as `ingest-recall-sources` v2. C applied as the single reviewed privilege migration. A remains deployed as `ingest-recall-source` v5 with its authenticated live stale-watermark validation deferred by the accepted key limitation. Stop for review; do not continue automatically. No commit or push was made.

## 1. A handoff and production baseline

A was **not** redeployed. Its v5 bundle remained `ba3949921003fdc94e0f9ecd16fe088ba24b515b7b0fd69df16319f2084d869d`. Its local contract had passed 10/10 focused tests and its unauthenticated live GET/POST behavior had passed 405/401. The authenticated live stale path remains untested; the database forward-only trigger remains the final authority. No ingestion key was requested or exposed.

Before B, the production aggregate was still v1 with deployed bundle SHA-256 `640d8a47490c217c7320f6d1df6ee20df15334728ef4968cee4dc4b9479424f3`. Cron job 2 was active at `17 */6 * * *`; run 43 and the latest automation succeeded. CPSC and Health Canada states were successful with typed watermarks at `2026-09-27`. CPSC safety was true with nine retained quarantines, zero hash-only, and no unaccounted observations. Reviewed criteria, v2 evaluations, matches, alerts, and push work were zero. C was absent from the 24 production migrations.

## 2. B exact diff, accounting, and deployment

The reviewed deployed-v1 entry point SHA-256 was `d2ce90d46de484bdbfd1eebc604ca983b59ff9ed0d75afa3e6358c46bb07ad02`. Its runtime source-set SHA-256 was `f347472a52a51ffbb648c0b39d9f9ef96819a2d8cfebf064d0e0e48a8ab43bce`. The candidate entry point was `3b0265491c3c6a43b3011b1d99dda27b9056f0b8ac640aa06f116b3ff646a251`; candidate runtime source-set was `52583b3ebc279a979b2ef290c3546f20e6246f92e1fc48dba598234bc84d25bb`. These matched the Phase 16.20 manifest. The live v1 bundle hash still matched the verified baseline at deployment time.

The exact semantic diff changes only `ingest-recall-sources/index.ts`: it initializes `accountedRecords` and the five `outcomes` counters; validates each successful child's five-way sum equals child `fetched`, `processed=inserted+updated`, `unchanged=unchanged`, and `failed=rejected`; then sums those counters and adds the same per-source fields. Existing response fields, scalar aggregate `fetched` (accepted records), source order, source failure behavior, and child invocation request are preserved. Every one of the 11 shared runtime files remained byte-identical to the v1 baseline. No unrelated Health Canada, validator, registry, or dirty local import entered the deployable runtime graph. The read-back v2 bundle contained exactly the 12 expected runtime files, all byte-identical to candidate B.

The focused candidate suite passed **10/10**, including all-unchanged, processed/unchanged, quarantine/unchanged, unresolved/processed, failed mixed two-source, and inconsistent-accounting cases. Quarantine is not counted as failure; failed rows remain visible. B deployed from **v1 to v2** with `ezbr_sha256` `c41cb92edc42ffa42b154561f6c6fbee780e832e6488d18d21c12a0ca6daaae6` and candidate source-set hash `52583b3ebc279a979b2ef290c3546f20e6246f92e1fc48dba598234bc84d25bb`. No child worker was deployed. Post-deploy unauthenticated GET returned 405 and POST returned 401. The authorized live dry-run and top-level response schema were not exercised because the ingestion secret is unavailable here; local candidate tests and exact deployed source bytes provide the outcome-schema evidence. No source ingestion was triggered for metrics.

## 3. C test update, caller audit, and migration

The obsolete Phase 16.11/12/13 loopback HTTP smoke scripts now assert that direct `service_role` calls to the nine-argument RPC are denied. They use a local-only owner SQL fixture helper with the existing hash and manifest inputs to preserve downstream historical fixtures; owner execution is not weakened. The affected suites passed **37/37**, **66/66**, and **41/41** checks respectively. These scripts committed local fixtures to the existing disposable local stack, which was preserved without reset.

Immediately before migration, every deployed Edge bundle was downloaded and searched: zero files in all seven functions referenced `record_cpsc_identity_observation`. The deployed child uses `record_cpsc_retained_observation`. Database catalog/source inspection confirmed that `public.record_cpsc_retained_observation` and `private.cpsc_backfill_apply` are `postgres`-owned `SECURITY DEFINER` functions that call the nine-argument RPC internally. The owner-run `private.cpsc_historical_backfill` still invokes the apply helper. Historical test, rehearsal, and migration references remain known and were not rewritten.

The exact migration was `supabase/migrations/20260927190041_phase_16_20_restrict_legacy_cpsc_observation_rpc.sql`, SHA-256 `c7329a6b652cbf6a7bcd62d5c9d3aeae3b2516003c59f2c41ad6f586d0997136`. `supabase db push --linked --dry-run --skip-vault` showed **only that file** pending. The linked push applied that single file; production migration count became 25. Its sole semantic change revokes direct `service_role` EXECUTE on `public.record_cpsc_identity_observation(text,text,text,text,text,date,text,timestamptz,text)`.

An immediate rollback-only direct-call probe confirmed actual calls by `service_role`, `anon`, and `authenticated` are denied. Catalog privileges were `service_role=false`, `anon=false`, `authenticated=false`, `postgres=true`. The function and owner path remain present.

## 4. Historical compatibility and remote pgTAP

A production rollback-only historical rehearsal used the exact frozen Phase 16.13 manifest. Inside one transaction, it temporarily marked one existing `A_known_alias` historical backfill item retracted and called `private.cpsc_historical_backfill(..., 'observations', true, ..., 1)`. The result recorded one historical observation through `private.cpsc_backfill_apply`, returned `decisionClasses={A_known_alias:1}`, preserved the historical rows digest `5cae811185873566a0edb06afa83b7652e5cdea1e20ec7e7f053db0c4b82e3c4`, and returned canonical manifest SHA-256 `a9a696f6cbdf8df4d22ae11d67bae6ce4c01f57ccb6c3191d13ffc1f34d5bbfd`. It reported zero historical rewrites, reconciliations, reviewed criteria, conflicts, and quarantines. `complete=false` is expected with the deliberate one-row limit and remaining candidate rows. The transaction rolled back. A follow-up read-only check found the original four backfill runs, 334 items, and 109 observations, with safety still true. No payload was fabricated or row persisted. An initial stricter assertion incorrectly required `complete=true`; diagnostic replay established the bounded result above, also under rollback.

The production-safe compatibility pgTAP suite passed **89/89** and the watermark/retention suite passed **34/34**. Each created pgTAP temporarily within a transaction and rolled back. The runner confirmed pgTAP absent afterward, zero idle transactions, unchanged forward guards and migration history, and no fixture residue.

## 5. Cross-compatibility and final production state

A remained v5 independently of B. B v2's runtime graph contains no direct legacy RPC call, nor does any other deployed function. The cron chain remains structurally intact. The deployed matcher v11 defaults to `phase_10_guarded_v1`; a read-only secret-name check found no `RECALL_MATCHING_POLICY` override. No deterministic v2 cohort was invoked or activated.

Final Edge versions and bundle SHA-256 values:

| Function                           | Version | Bundle SHA-256                                                     |
| ---------------------------------- | ------: | ------------------------------------------------------------------ |
| `ingest-cpsc-recalls`              |      16 | `2b0774c51d752cb9a5b3e83e741e2513cc4b9930fd7f918791408760edcc0dc3` |
| `ingest-recall-source`             |       5 | `ba3949921003fdc94e0f9ecd16fe088ba24b515b7b0fd69df16319f2084d869d` |
| `ingest-recall-sources`            |       2 | `c41cb92edc42ffa42b154561f6c6fbee780e832e6488d18d21c12a0ca6daaae6` |
| `run-recall-automation`            |       3 | `29aa16817f966e20021235d42a92d37b82c19d763b13b0df0bc281445c1cef6c` |
| `process-recall-matches`           |      11 | `81f96b1d69c5b2f0df47a20ae2cb70b834254ae977fd368abe14d3722e308d6b` |
| `send-recall-notifications`        |       6 | `58b6945b6213c79d1b78eb12c8fac25f37ebb2951ecdee8ea01b64a0157211f5` |
| `process-recall-matches-v2-cohort` |       1 | `682308bdfe9657c66408c58b1cf25d6be8bd26cff4f929d7ac21ee7b41201f1e` |

Final read-only state: cron job 2 active at `17 */6 * * *`; run 43 still latest and successful, so no natural cycle occurred during this continuation. Latest automation remains successful. CPSC and Health Canada source states are successful without error, and their typed watermarks plus automation watermark remain `2026-09-27`. CPSC safety remains `safe=true`, with nine quarantines and nine retained payloads, zero hash-only and unaccounted. Production has 87 notices, 100 scopes, 109 observations, 27 page revisions, 27 page fetches, zero reconciliations, zero reviewed criteria, zero v2 evaluations, zero matches, zero alerts, zero push queue/deliveries, and zero leases. pgTAP is absent and there is no idle transaction. Only the aggregate Edge version and the one intended migration changed during this continuation; no cron, child, matcher, push, CPSC worker, or cohort deployment changed.

## 6. Local quality gates and limits

`npm run check` passed TypeScript and Expo lint, then stopped only at inherited `.claude/settings.local.json` formatting. Independent `npm run typecheck` and `npm run lint` passed. All **25** core/phase unit test scripts and **9** matcher/freeze/holdout/safety benchmark commands passed separately. The three affected HTTP smoke suites and focused candidate suite passed as above. Deno 2.9.6 checked the exact A and B candidate entry points. `git diff --check` passed; a targeted scan of six relevant report/script files found zero secret-pattern matches.

The full **local** DB pgTAP run failed on the existing fixture-populated local stack: the Phase 16.12 suite encountered a duplicate `cpsc` source, and other suites encountered hash-only quarantines. The worktree and local DB were not reset or cleaned. Full local DB lint flagged pgTAP-extension functions; application-schema lint (`private,public`, error level) passed with zero results. The production rollback-only pgTAP suites passed as recorded above.

## 7. Remaining risk and next phase

A's authenticated live stale-watermark response and B's authenticated live top-level metrics remain deferred because this session has no ingestion secret. The full local DB pgTAP suite needs an isolated clean test database in a later, separately scoped phase; this phase preserved the current local stack as instructed. A future natural cron cycle should be observed read-only for CPSC, Health Canada, matching, and push health without manually triggering it. Scheduled live CPSC page evidence still does not exist, so deterministic v2 remains blocked.

**Recommendation:** Treat A/B/C as applied with the stated validation gaps, observe the next natural cron run, and plan a clean isolated DB test and a protected, non-destructive authenticated smoke mechanism. Do not activate v2, reconcile identities, or infer page-evidence readiness from this gate.

**Stop for review. Do not continue automatically.**
