# Phase 16.16C stop report: Health Canada matching catch-up and controlled cron reactivation

Status: **first scheduled cycle fully healthy; cron left `active = true`; stopped for review.**

The eight Phase 16.16B Health Canada notices entered the normal Phase 12 pending-recall lifecycle
and were consumed by the first scheduled run. No Step 14 pause condition fired.

Not done in this phase:

- no migration applied
- no function deployed
- no manual automation run (only the natural 12:17 UTC cron tick was observed)
- no reconciliation or review decision
- no reviewer role assigned
- no v2 activity; `RECALL_MATCHING_POLICY` still absent (`phase_10_guarded_v1`)
- no Nebius call
- no commit or push

## 1. Production preflight (Step 1, 06:45 UTC)

| Check                                                                                          | Result                                             |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| cron `recall-automation-every-6h`                                                              | jobid 2, `17 */6 * * *`, `active = false`          |
| automation lease / matching leases                                                             | 0 / 0                                              |
| CPSC watermark / Health Canada watermark                                                       | `2026-09-27` / `2026-09-27`, both `success`        |
| `private.cpsc_watermark_safety()`                                                              | `safe = true`, 9 quarantined, 9 retained, 0 legacy |
| owned_products / recall_matches / alerts                                                       | 0 / 0 / 0                                          |
| push queue / deliveries                                                                        | 0 / 0                                              |
| reviewed criteria, review ledger, invalidations, reconciliations, capabilities, authorizations | all 0                                              |
| all eight v2 tables                                                                            | all 0                                              |
| pgTAP installed / idle-in-transaction sessions                                                 | 0 / 0                                              |
| function versions and bundles                                                                  | exact match to the accepted baseline (see §9)      |

## 2. The normal matching-queue mechanism (Step 2)

- **Queue:** `private.recall_automation_pending_recalls`. Primary key `recall_notice_id`;
  `first_affected_at`, `last_affected_at`, `last_attempted_at`, `attempt_count`.
- **Producer:** `public.record_recall_automation_ingestion`, called only by the
  `run-recall-automation` orchestrator under a valid run lease. It inserts the run's
  `affectedRecallIds` (inserted + updated notices) with
  `on conflict (recall_notice_id) do update set last_affected_at = excluded.last_affected_at`.
  That is the idempotency contract: one row per notice, and re-affecting only refreshes
  `last_affected_at`.
- **Consumer:** the orchestrator reads `get_recall_automation_pending_recalls(run, lease, limit)`,
  ordered by `last_attempted_at nulls first`, and passes the IDs to `process-recall-matches`. Then
  `record_recall_automation_matching` either **deletes** the rows (`p_complete = true`) or increments
  `attempt_count` and `last_attempted_at` (incomplete: failures, provider failures or limits reached).
- **When `owned_products = 0`:** candidate retrieval returns 0 pairs. The batch is complete with no
  failures, so the rows are deleted without any match or alert.

## 3. Why the 8 HC notices were skipped

In Phase 16.16B they were ingested by direct `ingest-recall-source` POSTs (05:40–05:50 UTC logs
show no `run-recall-automation` or `ingest-recall-sources` invocation). The direct function returns
`affectedRecallIds` to its caller. Only the orchestrator persists them to the pending queue, so
nothing queued them.

## 4. HC catch-up dry run (Step 3)

8 requested → 8 resolved, all `health_canada`, 0 CPSC, 0 unresolved, 8 distinct notice IDs,
0 already pending. Expected delta **+8** (0 → 8). Candidate-pair upper bound 0 (owned_products = 0).

## 5. HC catch-up execution (Step 4, 07:20:41 UTC)

The verbatim insert statement of `record_recall_automation_ingestion` ran over exactly the 8 notice
IDs, guarded by preconditions (exactly 8 HC notices, and 0 owned products, matches, alerts and
push). Result: 8 pending rows, `attempt_count = 0`, `last_attempted_at = null`. Notice content
untouched; no match, alert or push.

## 6. Catch-up idempotency (Step 5, 07:21:02 UTC)

The identical statement was repeated: **0 new rows** (still 8 distinct). Only `last_affected_at` was
refreshed, exactly as the production conflict clause specifies.

## 7. The nine CPSC quarantines (Step 6)

| Recall | Reused API ID | Retention | Hash verified | Alias owner (unchanged) | Reconciliation |
| ------ | ------------- | --------- | :-----------: | ----------------------- | :------------: |
| 26749  | 10969         | retained  |      yes      | 26763                   |      none      |
| 26750  | 10971         | retained  |      yes      | 26756                   |      none      |
| 26752  | 10972         | retained  |      yes      | 26749                   |      none      |
| 26753  | 10965         | retained  |      yes      | historical owner        |      none      |
| 26754  | 10967         | retained  |      yes      | historical owner        |      none      |
| 26756  | 10968         | retained  |      yes      | historical owner        |      none      |
| 26763  | 10966         | retained  |      yes      | historical owner        |      none      |
| 26764  | 10973         | retained  |      yes      | historical owner        |      none      |
| 26766  | 10970         | retained  |      yes      | historical owner        |      none      |

The total is 9. No canonical identity exists for the new conflicting recall numbers. No API alias
maps to more than one identity (`api_alias_multi_identity = 0`), and watermark safety is `true`.
Nothing changed after the run (§17).

## 8. 26777 (Step 7)

Single identity, `reconciled`, canonical notice `10987`, canonical URL
`https://www.cpsc.gov/Recalls/2026/Hayward-Industries-…-Hazard-0` (unchanged). The API aliases are
`10987` and `10990`; all observations are `A_known_alias` / `resolved`. The only page fetch is
2026-09-24 (HTTP 200, final URL = canonical). Reconciliations: 0. No redirected-page alias was
approved and candidate criteria are 0, so page evidence stays fail-closed. The post-run
identity/alias/page fingerprints are unchanged, so nothing about 26777 moved.

## 9. Pre-reactivation snapshot (Step 8, 07:23:09 UTC)

The same query was re-run post-run; the full diff is in §17. Function baseline:
`ingest-cpsc-recalls` v16 (`2b0774c5…`), `ingest-recall-source` v4 (`0a78e498…`),
`ingest-recall-sources` v1, `run-recall-automation` v3, `process-recall-matches` v11,
`send-recall-notifications` v6, `process-recall-matches-v2-cohort` v1 (inactive). All were
re-verified identical at 12:32 UTC.

## 10. Cron reactivation proof (Step 9, 07:23:54 UTC)

This was done through `private.set_recall_automation_cron_active(true)`. Verified afterwards:
jobid 2, `recall-automation-every-6h`, `17 */6 * * *`, `active = true`, and command md5
`07549bf985a3034a5ef9c645692097b6` (unchanged).

## 11. First scheduled run timing

| Stage                                       | Start (UTC)  | End (UTC)    | HTTP | Duration |
| ------------------------------------------- | ------------ | ------------ | :--: | -------: |
| pg_cron tick (runid 42)                     | 12:17:00.234 | 12:17:00.349 |  —   |   115 ms |
| `run-recall-automation` v3 (run `add1e6fe`) | 12:17:02.025 | 12:17:09.407 | 200  |  8682 ms |
| → `ingest-recall-sources` v1                | ~12:17:02.1  | 12:17:08.148 | 200  |  6006 ms |
| → `ingest-recall-source` v4 (CPSC)          | ~12:17:02.5  | 12:17:04.077 | 200  |  1622 ms |
| → `ingest-recall-source` v4 (Health Canada) | ~12:17:04.1  | 12:17:08.143 | 200  |  4006 ms |
| → `process-recall-matches` v11              | ~12:17:08.3  | 12:17:08.936 | 200  |   679 ms |
| → `send-recall-notifications` v6            | ~12:17:09.0  | 12:17:09.373 | 200  |   353 ms |

The run row reports `status = success`, `error_step = null` and `error_code = null`; the orchestrator
logged `recall_automation_run_complete { status: "success" }`. The only `net._http_response` row
since reactivation is this cron call (HTTP 200).

## 12. CPSC stage

The run window was 2026-09-24 → 2026-09-27. The CPSC per-source window was **2026-09-25 →
2026-09-27**: `max(end − (maxWindowDays−1), watermark − 2 days)` in `ingest-recall-sources`, a
formula unchanged from HEAD, so deployed v1 matches.

Result: fetched 0, processed 0, unchanged 0, quarantined 0, unresolved 0, failed 0, errors [].
Status `success`; watermark `2026-09-27 → 2026-09-27`.

**Zero is correct.** I checked the public API independently at 12:3x UTC:
`LastPublishDateStart=2026-09-25&End=2026-09-27` returns `[]`. The wider `2026-09-24` window returns
exactly API IDs 10991–11001, all 11 already stored with `LastPublishDate = 2026-09-24`. Every
fetched record is accounted for. No new hash-only quarantine appeared, and the historical nine were
not in the window and were not replayed (sightings unchanged).

## 13. Health Canada stage

Per-source window 2026-09-25 → 2026-09-27. Fetched 5, inserted 0, updated 0, **unchanged 5**,
quarantined 0, failed 0, errors []. Status `success`; watermark `2026-09-27 → 2026-09-27`.

The five fetched notices were 82681, 82682, 82683, 82686 and 82689, all already known and all part
of the catch-up set. They were unchanged, so `affectedRecallIds = []` and they were not re-queued.

## 14. Matching stage

`process-recall-matches` v11 (`phase_10_guarded_v1`) logged `recallsProcessed: 8, candidatePairs: 0,
deterministicResolved: 0, nemotronEscalated: 0, confirmed/rejected/needsReview: 0, alertsCreated: 0,
failures: 0, retries: 0`.

The run row agrees: `candidate_pairs = 0`, `ai_escalations = 0`, `provider_failures = 0`,
`alerts_created = 0`. No Nebius call was made.

## 15. Push stage

`send-recall-notifications` v6 logged `claimed 0, accepted 0, failed 0, invalidDevices 0,
receiptsChecked 0` and returned HTTP 200. Zero notifications is the correct outcome with 0 alerts;
the stage completed successfully.

## 16. The 8 HC catch-up notices

The pending queue went from 8 rows (attempts 0) to **0 rows**. The orchestrator pulled all 8 through
`get_recall_automation_pending_recalls`, the matcher processed 8 with 0 candidate pairs and 0
failures, and `record_recall_automation_matching(p_complete = true)` deleted them. This is the
normal completion path, not a failure or retry.

All 8 notices still exist unchanged (46 HC notices; payloads identical, §17). They produced no
matches or alerts. Future owned products will be matched against them through the normal
product-side path.

## 17. Pre/post production diff (07:23:09 → 12:32:32 UTC)

| Category                                                    | Before                                    | After                              | Explanation                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ----------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPSC / HC notices                                           | 41 / 46                                   | 41 / 46                            | —                                                                                                                                                                                                                                                                                                                                                                                 |
| notices fingerprint                                         | `ca0e85a6…`                               | `46b06960…`                        | Only `updated_at` of HC 82681/82682/82683/82686/82689 changed. The unchanged path of `ingest_authoritative_recall` writes `retrieved_at`, and the `recall_notices_set_updated_at` trigger bumps `updated_at`. Recomputing the fingerprint with those 5 `updated_at` reset to `created_at` reproduces `ca0e85a6…` exactly, so every payload and every other row is byte-identical. |
| scopes / jurisdictions                                      | 100 (`a2ea3f25…`) / 87                    | same                               | —                                                                                                                                                                                                                                                                                                                                                                                 |
| CPSC sync state                                             | `2026-09-27`, success, 05:43:32           | `2026-09-27`, success, 12:17:03.99 | New attempt; watermark equal (monotonic)                                                                                                                                                                                                                                                                                                                                          |
| HC sync state                                               | `2026-09-27`, success, 05:45:19           | `2026-09-27`, success, 12:17:08.13 | New attempt; watermark equal (monotonic)                                                                                                                                                                                                                                                                                                                                          |
| automation `last_successful_watermark`                      | `2026-09-26`                              | `2026-09-27`                       | Forward advance by the successful run                                                                                                                                                                                                                                                                                                                                             |
| identities / dup RN                                         | 38 (`c53a2521…`) / 0                      | same                               | —                                                                                                                                                                                                                                                                                                                                                                                 |
| aliases / API-alias owners / multi-owner                    | 282 (`b0f9bb14…`) / `d725f636…` / 0       | same                               | No hijack                                                                                                                                                                                                                                                                                                                                                                         |
| observations / quarantined / quarantine fp                  | 109 / 9 / `b94c40e7…`                     | same                               | —                                                                                                                                                                                                                                                                                                                                                                                 |
| payloads / hash mismatches / retention                      | 37 (`f2e59819…`) / 0 / retained 9         | same                               | —                                                                                                                                                                                                                                                                                                                                                                                 |
| sightings                                                   | 9 rows, last 05:43                        | same                               | CPSC fetched nothing                                                                                                                                                                                                                                                                                                                                                              |
| api / page revisions, page fetches, links, notice revisions | 49 / 27 / 27 / 41 / 34                    | same                               | —                                                                                                                                                                                                                                                                                                                                                                                 |
| reconciliations                                             | 0                                         | 0                                  | —                                                                                                                                                                                                                                                                                                                                                                                 |
| pending recalls                                             | 8                                         | **0**                              | Catch-up consumed (§16)                                                                                                                                                                                                                                                                                                                                                           |
| owned products / matches / alerts                           | 0 / 0 / 0                                 | 0 / 0 / 0                          | —                                                                                                                                                                                                                                                                                                                                                                                 |
| push queue / deliveries / devices                           | 0 / 0 / 2                                 | 0 / 0 / 2                          | —                                                                                                                                                                                                                                                                                                                                                                                 |
| reviewed criteria (all 5 tables)                            | 0                                         | 0                                  | —                                                                                                                                                                                                                                                                                                                                                                                 |
| v2 (all 8 tables)                                           | 0                                         | 0                                  | —                                                                                                                                                                                                                                                                                                                                                                                 |
| automation / matching leases                                | 0 / 0                                     | 0 / 0                              | Released                                                                                                                                                                                                                                                                                                                                                                          |
| automation runs                                             | 46                                        | 47                                 | Run `add1e6fe` (cron, success)                                                                                                                                                                                                                                                                                                                                                    |
| cron run count                                              | 41                                        | 42                                 | runid 42 (succeeded)                                                                                                                                                                                                                                                                                                                                                              |
| cron active                                                 | false                                     | true                               | Step 9 reactivation                                                                                                                                                                                                                                                                                                                                                               |
| migrations / function-source md5 / pgTAP / idle-in-tx       | 23:`20260926210000` / `49503d26…` / 0 / 0 | same                               | —                                                                                                                                                                                                                                                                                                                                                                                 |
| edge function versions and bundles                          | baseline                                  | same                               | —                                                                                                                                                                                                                                                                                                                                                                                 |

## 18. Source watermarks

CPSC `last_publish_date = 2026-09-27` → `2026-09-27`; Health Canada `last_updated_date = 2026-09-27`
→ `2026-09-27`; automation watermark `2026-09-26` → `2026-09-27`. None moved backward.

## 19. Watermark safety

`{"safe": true, "contract": "cpsc-watermark-safety/v1", "quarantined": 9, "retained": 9,
"legacyHashOnly": 0, "unaccounted": []}`, both before and after the run.

## 20. Reviewed criteria / v2 / matches / alerts / push

All 0 before and after. `process-recall-matches-v2-cohort` was not invoked (no log entry).

## 21. Automatic re-pause events

**None.** I evaluated every Step 14 condition and none occurred. The run succeeded, both sources
succeeded, and there was no quarantine-driven failure. No watermark moved backward, safety stayed
true, and no hash-only quarantine appeared. There was no identity hijack, no duplicate identity and
no 26777 auto-reconciliation. Reviewed criteria, v2 activity, matches, alerts and pushes were all
absent. No lease was stuck, the queue had no duplicates, there was no DB error and there was no
Nebius call.

## 22. Final cron state

**`active = true`** (jobid 2, `17 */6 * * *`, command unchanged). The first scheduled cycle was
healthy end to end, and Step 16 says to leave it active in that case. Next tick: 18:17 UTC. It is not
being observed by this session.

## 23. Deferred technical debt (not fixed here)

- **A. Forward-only watermark guard.** Still the top priority: a manual run can still move a watermark
  backward.
- **B. Aggregate visibility.** `ingest-recall-sources` v1 aggregate totals omit
  quarantined/unresolved; per-source metrics stay authoritative. The local fix exists, undeployed.
- **C. Legacy 9-argument observation RPC.** Still granted to `service_role`; revoke once every
  deployed caller is confirmed migrated.
- **D. Remote pgTAP.** The Phase 16.16 assertions are not yet in the remote-safe suite.
- **E. Observation sequence gaps.** Documented only; not used as continuity evidence.
- **Observation (new, informational).** An unchanged re-fetch still writes `retrieved_at`, which
  bumps `recall_notices.updated_at`. This is harmless today. Any consumer that treats `updated_at` as
  a "content changed" signal should use `raw_payload` or the ingestion outcome instead.

## 24. Human reconciliation backlog

Nine quarantined CPSC observations await the explicit human reconciliation workflow. None was
reconciled here, and no reviewer role was assigned.

- **New in 16.16B (separate items):**
  - 26750 (reused API 10971, observation `88c9cb7d…`)
  - 26752 (10972, `8ebf19a8…`)
  - 26764 (10973, `c1c911d4…`)
- **Earlier:** 26749, 26753, 26754, 26756, 26763, 26766.

Until they are resolved, CPSC coverage must not be described as complete or exhaustive. Cron health
and identity resolution remain separate concerns.

## 25. Recommendation for Phase 16.17

1. Implement and deploy the **forward-only watermark guard** (debt A), with a local pgTAP proof,
   before any further manual source run.
2. Let the cron run unattended for several cycles, then do a read-only health review: runs, source
   states, safety, the pending queue drained, zero user-facing deltas.
3. Fold the Phase 16.16 assertions into the remote-safe pgTAP suite (D), then deploy the
   aggregate-visibility fix (B) and revoke the legacy RPC (C) once callers are confirmed.
4. Keep the page-evidence blocker. Live authoritative CPSC page evidence is still not part of
   scheduled ingestion, so there is no v2 cohort, no `phase_16_deterministic_v2`, and no claim of v2
   readiness. `phase_10_guarded_v1` stays active.
5. Schedule the human reconciliation of the nine quarantines as its own gated phase, with reviewer
   authorization granted explicitly by a human.

## Quality / repository (Step 20)

Run at 07:24–07:25 UTC; no worktree file has changed since then (checked at 12:3x UTC).

- `npm run check`: every step passes except `format:check`, which flags only
  `.claude/settings.local.json` (left untouched as instructed).
- Deno check: 7 entrypoints pass.
- `git diff --check`: clean (re-run after the cycle).
- Secret scan: clean.

This report is the only file added in this phase. Nothing was committed or pushed.
