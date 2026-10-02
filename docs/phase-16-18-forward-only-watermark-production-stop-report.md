# Phase 16.18 stop report — production forward-only watermark guard

**Status:** the exact reviewed Phase 16.17 migration was applied to production and verified. Stop for review. No function was deployed, cron was not triggered or toggled, no administrative reset or identity reconciliation occurred, no v2 policy was activated, no Nebius call was made, and nothing was committed or pushed. Final read-only snapshot: 2026-09-27 13:26:32 UTC.

## 1. Worktree and exact artifact

The existing `main` worktree remained dirty: 36 tracked modifications plus the inherited untracked Phase 16 files. `git status`, `git diff --stat`, full `git diff`, and untracked paths were inspected. No file was reset, cleaned, or discarded. The benchmark validation command refreshed the already-modified `benchmarks/recall-matching/phase-15/audit.json` `generatedAt` value during local gates; its audit results passed. The Phase 16.17 report had no independent all-file hash snapshot, so byte-for-byte continuity of every other file cannot be proven. Its migration was read completely, and its approved SHA-256 matched before and after application:

- `supabase/migrations/20260927124132_phase_16_17_forward_only_watermarks.sql`
- `dc2e58e30f1b6aef6e814390e32a9a0a5b7d3f55bdf080ee59f346482a908e3b`

## 2. Production preflight and dry run

Before application, cron job 2 (`recall-automation-every-6h`) was active at `17 */6 * * *`; the last natural run, at 12:17 UTC, had succeeded. Both source sync states were successful and had typed `2026-09-27` cursors: CPSC `last_publish_date`, Health Canada `last_updated_date`. The automation date watermark was `2026-09-27`. `private.cpsc_watermark_safety()` returned `safe=true`, 9 quarantined, 9 retained, 0 hash-only, and no unaccounted observation. No live automation or matching lease existed. There were 0 owned products, pending recalls, matches, alerts, push queue items or deliveries, reviewed criteria, or v2 evaluation/eligibility/alert/correction rows. Production history ended at `20260926210000`; the new migration and both guards were absent. All seven deployed function versions matched the Phase 16.17 handoff.

The linked `npx supabase db push --linked --dry-run --skip-vault` listed **exactly one** pending file, `20260927124132_phase_16_17_forward_only_watermarks.sql`, with empty `seeds` and `roles`. No other migration was pending.

## 3. Application and immediate diff

`npx supabase db push --linked --skip-vault --yes` applied that one file. The history now contains version `20260927124132` exactly once; the prior 23 version identifiers are unchanged. Both table triggers are installed. The migration hash still matches.

Immediately afterward, both source watermarks and success timestamps, the automation watermark, cron state, CPSC safety, leases, criteria, v2 state, matches, alerts, and push state matched preflight. Full row fingerprints also matched for source state, automation state, notices, scopes, CPSC identities, observations, retained payloads, matches, and alerts. The notice semantic fingerprint excludes `retrieved_at` and `updated_at`; both its semantic and full fingerprints matched in this window. No business row changed merely because the schema was applied.

## 4. Remote lint and rollback-only proof

Production `db lint --linked --schema public,private --level warning --fail-on error` exited 0 with **0 errors**. It reported five existing unused-parameter warnings in `public.approve_cpsc_product_model_criterion_v2`.

The reviewed `supabase/tests/remote/phase-16-17-watermark-and-retention.sql` ran through `scripts/run-remote-pgtap.mjs` as `BEGIN` → temporary pgTAP → 34 assertions → `ROLLBACK`: **34/34 PASS**, psql exit 0. The wrapper confirmed pgTAP was absent before and after, no session remained idle in a transaction, both guards and migration history were unchanged by the test, and the transaction rolled back. Follow-up checks found the production watermarks, cron, CPSC safety, observations (109), payload revisions (37), matches, alerts, push, criteria, and v2 counts unchanged. Sequence gaps from rolled-back `nextval` remain acceptable under the Phase 16.17 ordering-only `observation_seq` conclusion.

The suite proved at the **database** boundary, inside the rollback-only transaction:

| Contract                                                | Result                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Existing CPSC cursor `D`, then `D-N`                    | SQLSTATE `23514`; backward write rejected.                                                             |
| Existing CPSC cursor `D`, then `D`                      | Accepted/idempotent.                                                                                   |
| Existing CPSC cursor `D`, then `D+1`                    | Accepted with a complete source result and retained quarantine; rolled back.                           |
| Health Canada `last_updated_date` backward/same/forward | Rejected/accepted/accepted respectively; rolled back.                                                  |
| CPSC `last_updated_date` kind                           | SQLSTATE `23514`; fail closed. The installed trigger defines Health Canada's expected kind separately. |
| Health Canada `last_publish_date` kind                  | A separate rollback-only production proof caught SQLSTATE `23514`; its cursor stayed unchanged.        |
| Failed Health Canada result                             | Did not advance its cursor.                                                                            |
| Retained quarantine with database-verified payload/hash | CPSC safety true; forward cursor allowed.                                                              |
| Hash-only quarantine without retained payload           | CPSC safety false; forward cursor rejected with SQLSTATE `23514`; cursor stayed at its prior value.    |
| Automation date rollback                                | SQLSTATE `23514`.                                                                                      |

The suite's future fixture dates were transaction-only; no real production cursor was advanced or reset. Final persisted values remained `2026-09-27`.

## 5. Administrative and runtime boundaries

`service_role` has neither direct `UPDATE` on the two private state tables nor `EXECUTE` on the new trigger functions. No reset-named function exists, and the migration creates no reset path. An intentional backward recovery remains a **separately reviewed owner-only migration** with operator/reason/old-new/time audit, temporary guard replacement inside one transaction, and guard restoration; no such operation occurred here.

The deployed workers were audited by reading their current bundles. `ingest-recall-source` v4 writes successful typed adapter cursors through `record_recall_source_sync_result`; CPSC uses `last_publish_date` and Health Canada `last_updated_date`. Its `sourceRunComplete` gate requires every fetched row accounted for with none failed. `ingest-recall-sources` v1 calls that child for each source and only writes a failed result itself on error. `run-recall-automation` v3 uses the existing automation ingestion RPC; `ingest-cpsc-recalls` v16 does not write either watermark. The new DB triggers enforce the contract for these deployed workers without a runtime change. **No function was deployed.** The deployed child still returns a generic persistence failure for a deliberately stale request; the nicer local 409 validation remains a separate bundle review.

The old nine-argument `record_cpsc_identity_observation` remains executable by `service_role`. The Phase 16.17 bundle audit found no deployed Edge caller, but production `private.cpsc_backfill_apply(uuid,jsonb,text,integer)` still calls it in the owner-only historical backfill path. It is **not retirement-ready** without a separate backfill caller decision. No grant was changed here.

`ingest-recall-sources` v1 still omits quarantined/unresolved counts from top-level aggregate metrics; per-source metrics remain authoritative. The local aggregate bundle contains other changes, so no visibility-only deployment was attempted. Unchanged Health Canada notices may still refresh `retrieved_at` and `updated_at`; semantic content comparisons exclude those timestamps.

## 6. Local gates and final snapshot

`npm run check` passed TypeScript and Expo lint, then stopped **only** on the inherited `.claude/settings.local.json` Prettier warning. That file was left untouched. Every remaining `check` script was run independently and passed: unit and matcher tests; Phase 9.1, Phase 15, and Phase 16 freeze gates; v2.1 holdout and safety gates; and benchmark checks. Separate TypeScript and seven-entrypoint Deno checks passed. `git diff --check` and a targeted filename-only secret scan passed. No new local implementation was written in this phase.

Final production history has 24 migrations, with only `20260927124132` added. The latest automation run remains the successful 12:17 UTC cycle; no natural scheduled cycle occurred during the working window. Cron remains job 2, `17 */6 * * *`, `active=true`. CPSC and Health Canada cursors and the automation cursor remain `2026-09-27`; both source states remain `success`. CPSC safety remains true with 9/9 retained and 0 hash-only. Counts match preflight: 87 notices, 100 scopes, 0 owned products, 0 pending recalls, 0 matches, 0 alerts, 0 push queue/deliveries, 0 reviewed criteria, 0 v2 rows, 0 active leases, 109 CPSC observations, 37 payload revisions, and 0 reconciliations. pgTAP is absent, no idle transaction remains, and all ten recorded business-row fingerprints match preflight. The deployed versions remain CPSC 16, source child 4, source aggregate 1, automation 3, matcher 11, push 6, and inactive v2 cohort 1.

## 7. Remaining risks and Phase 16.19 recommendation

The next natural cron cycle has not yet tested the new guard in the live worker path; observe its source, matching, and push outcomes read-only at the next scheduled tick. The deployed source child lacks the local friendly stale-window response, aggregate visibility debt remains, the legacy nine-argument RPC still serves historical backfill, nine CPSC identities await human reconciliation, and live CPSC page evidence is absent from scheduled ingestion. None of these was changed here. Keep deterministic v2 inactive.

For Phase 16.19, observe the next natural cron run and compare its cursors and business state, then separately review any Edge bundle deployment and historical RPC retirement. Do not proceed without a new phase decision.
