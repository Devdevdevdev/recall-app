# Phase 16.34 — post-A2 natural run verification and Gate A3 plan

Continuation of the [Gate A2 stop report](phase-16-34-gate-a2-stop-report.md) (A2 PASS: `process-recall-matches` v19).

**Post-A2 natural run: CLEAN.** Run 61 (2026-10-01 00:17 UTC) was the first natural run on matcher v19. It completed `success`, and nothing unexpected happened.

**Gate A3 (`run-recall-automation`): plan prepared, NOT executed.** It needs separate approval.

**Not done:** no deploy, Cron change, secret rotation, ticket cutover, page scheduling, human authorization, v2 activity, or commit or push.

---

## 1. Run 61 against the A2 baseline (read-only, 00:21–00:24 UTC)

| Check                              | A2 baseline (19:21)               | After run 61                                                                                                                                                         | Verdict                        |
| ---------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Cron job 2                         | 18:17 `succeeded`                 | 00:17:00.265 → 00:17:00.369 `succeeded` ("1 row"); 0 unfinished                                                                                                      | ✔                              |
| pg_net                             | last response 60; queue 0         | response **61: 200**, not timed out, no error; queue 0                                                                                                               | ✔                              |
| Run                                | 60 runs `60 a251b274`             | run 61 `3517c975…`, `cron`, **`success`**, 00:17:01.670 → 00:17:08.882; `error_code` null. The first 60 runs are still `60 a251b274`                                 | ✔                              |
| CPSC source                        | `success`, watermark `2026-09-30` | `success` 00:17:03.357; fetched 0; no errors; watermark **`2026-10-01`**                                                                                             | ✔ monotonic                    |
| Health Canada source               | `success`, watermark `2026-09-30` | `success` 00:17:07.141; fetched 8, **inserted 3**, unchanged 5, 0 rejected, quarantined or unresolved; watermark **`2026-10-01`**                                    | ✔ monotonic                    |
| Automation watermark               | `2026-09-30`                      | `2026-10-01`                                                                                                                                                         | ✔ monotonic                    |
| Leases                             | 0 / 0                             | automation 0, matching 0                                                                                                                                             | ✔ released                     |
| Pending recalls                    | 0                                 | 0; `pending_status` `{pending:0, retrying:0, exhausted:0}`                                                                                                           | ✔ (see §2)                     |
| Matching outcomes                  | 0                                 | 0                                                                                                                                                                    | ✔ expected with automation v10 |
| Matches / alerts / push deliveries | 0 / 0 / 0                         | 0 / 0 / 0; run `alerts_created` 0, push 0/0/0                                                                                                                        | ✔ no duplicate                 |
| Page stage                         | `never_started`                   | `never_started`, `running=false`; 0 control events                                                                                                                   | ✔                              |
| Page Cron                          | none                              | none; job 2 is the only job, MD5 `07549bf985a3034a5ef9c645692097b6`, active                                                                                          | ✔                              |
| Page POST / activity               | attempts `8 ac113605`             | attempts `8 ac113605`, work `8 4a536bb2`, revisions `27 7a34be4a`, ledgers `7 a27e8b73`, 34 fetches, 7 raw, 7 snapshots; **no page-worker request** in the edge logs | ✔                              |
| Page tickets                       | 0 ticks, 0 tickets                | 0 ticks, 0 tickets                                                                                                                                                   | ✔                              |
| 26777                              | hold `1 a19900c3`, 0 resolutions  | hold `1 a19900c3` (`backfill_manifest_unresolved_identity`, recall `26777`), 0 resolutions                                                                           | ✔ held                         |
| 18 candidates                      | `18 dc2b3a0f` (all unreviewed)    | `18 dc2b3a0f`; review ledger 0                                                                                                                                       | ✔ unreviewed                   |
| v2                                 | all 8 `*_v2` tables 0             | all 0; no `process-recall-matches-v2-cohort` request                                                                                                                 | ✔ inactive                     |
| Humans                             | all 0                             | 0 capabilities, reviewer authorizations, reconciliations, review ledger, invalidations, authorization audit and attestations                                         | ✔                              |
| Migrations / Vault                 | `31 f8be9553…`; Vault 2026-09-16  | unchanged                                                                                                                                                            | ✔                              |
| Functions                          | automation v10, matcher v19       | `run-recall-automation` **v10** `29aa1681…ef6c`; `process-recall-matches` **v19** `0b83d930…01c8`; the other 6 bundles unchanged (MCP listing)                       | ✔                              |

**Edge logs, 19:15 → 00:25.** Only the v1 chain ran, at 00:17, and every request returned 200:

| Function                           | Requests | Status | Time             |
| ---------------------------------- | -------- | ------ | ---------------- |
| `ingest-recall-source`             | 2        | 200    | 1262 ms, 3648 ms |
| `ingest-recall-sources`            | 1        | 200    | 5358 ms          |
| **`process-recall-matches` (v19)** | 1        | 200    | 1164 ms          |
| `send-recall-notifications`        | 1        | 200    | 308 ms           |
| `run-recall-automation`            | 1        | 200    | 8168 ms          |

There were no other function requests.

**Mutation sweep since 19:21:** every `public`/`private` base table with a creation, update, claim or completion timestamp was checked. Only v1 ingestion and run bookkeeping wrote:

| Table                                | Rows                                                                         | Explanation                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `public.recall_notices`              | 8, **all `health_canada`**: 3 new (00:17:06.7–07.0) and 5 `updated_at` bumps | the 3 inserts in the run counters; the known unchanged-notice bump |
| `public.recall_scopes`               | 3, all for the 3 new notices                                                 | ingestion                                                          |
| `public.recall_notice_jurisdictions` | 3, all for the 3 new notices                                                 | ingestion                                                          |
| `private.recall_source_sync_state`   | 2 (both sources)                                                             | ✔                                                                  |
| `private.recall_automation_runs`     | 1 (run 61)                                                                   | ✔                                                                  |
| `private.recall_automation_state`    | 1 (watermark)                                                                | ✔                                                                  |

All other swept tables have 0 rows changed.

**New baselines:**

- runs `61` (first 60 `60 a251b274`)
- notices `93 c8f62980`, content excluding `updated_at` `93 8d96fa16`
- all three watermarks `2026-10-01`

## 2. Note: 3 affected recalls on the old automation

- **What happened:** run 61 is the first run since A1 with affected recalls (3 new Health Canada notices). It ran matcher v19 (A2) with automation **v10**.
- **The expected plan behavior** (rehearsal S2/S3a) followed:
  - the old automation acknowledged the batch, leaving 0 pending
  - it wrote **no** `recall_automation_matching_outcomes` rows, because v10 doesn't call the new RPC
- **Matcher work:** production has 0 owned products, so there were **0 candidate pairs**. Nothing was left to match, and nothing was lost.
- **Why this matters for A3:** this is the code path A3 replaces. Under v10, a batch with unresolved pairs would still be acknowledged (the 16.33 defect). The correction becomes active only with the release automation.

## 3. A3 scope and readiness

**Scope:** deploy **only** `run-recall-automation` from `releases/phase-16-34-gate-a`.

**Does not change:**

- job 2 stays on the static key (`x-recall-automation-key`), which the release automation still accepts
- no ticket cutover (Gate C); no secret, Cron, migration or page change
- the matcher stays v19

**What A3 activates:**

- the per-recall outcome RPC (`record_recall_automation_matching_outcome`)
- retained or retried pending work with explicit exhaustion
- ticket acceptance (`consume_recall_automation_ticket`), unused until Gate C because job 2 sends no ticket

**Readiness evidence (read-only):**

- **RPCs:** all six used by the release automation exist in production. Each is `SECURITY DEFINER` and executable by `service_role` only (no `anon` or `authenticated`):
  - `claim_recall_automation_run`
  - `record_recall_automation_ingestion`
  - `get_recall_automation_pending_recalls`
  - `record_recall_automation_matching_outcome`
  - `complete_recall_automation_run`
  - `consume_recall_automation_ticket`
- **Matcher:** v19 is deployed. The release automation reads its new response fields; the old matcher would only fall back to keeping the batch pending.
- **Delta:**
  - the release set is the same **6 files** v10 bundles
  - exactly **5** differ, all reviewed 16.33 edits (build script `EDITS`)
  - `_shared/automation/request.ts` keeps its deployed bytes
  - `_shared/automation/types.ts` is imported only as types in both v10 and the release, so it's erased at bundle time and isn't in the uploaded set

| File                                 | Deployed v10 (pre-16.33) | Release (reviewed 16.33) |
| ------------------------------------ | ------------------------ | ------------------------ |
| `_shared/automation/index.ts`        | `199364b2…6fe7`          | `f7b8c785…11e7`          |
| `_shared/automation/orchestrator.ts` | `492bfb74…d301`          | `05133c73…0222`          |
| `run-recall-automation/children.ts`  | `42684f7a…a5c5`          | `70933ae6…1f03`          |
| `run-recall-automation/index.ts`     | `427a0fda…b7c3`          | `ffda65ef…fc11`          |
| `run-recall-automation/store.ts`     | `500dd427…d1f9`          | `22a222e8…102e`          |

**Operational note:** at 00:21 the agent's Supabase CLI reported `Access token not provided`, so function listing and download fail from the agent shell. The MCP listing was used for this report.

- **The A3 byte checks need CLI downloads.** Before A3, the user runs `npx supabase login` in the shell the agent uses, or confirms the token is available.
- **The user's own deploy shell** needs a valid login as well.

## 4. Gate A3 procedure (NOT executed; separate approval)

**Window:** job 2 runs at :17 every 6 h. Deploy at least 30 min after a run completes and at least 45 min before the next. That gives the next windows (UTC):

- **00:50–05:30**
- **06:50–11:30**
- **12:50–17:30**
- **18:50–23:30**

**Step 1: preflight (read-only; any difference → STOP and report).**

- **Window:** inside the approved window.
- **Migrations:** `31 f8be9553280b05ab2d26ca5d89fdb8b9`.
- **Cron:** job 2 is the only job, `17 */6 * * *`, active, MD5 `07549bf985a3034a5ef9c645692097b6`. No unfinished execution. The last run is `success`.
- **Queues and leases:** `net.http_request_queue` 0; automation lease 0; matching leases 0; no `running` run.
- **Page stage:** `never_started`; 0 control events, ticks and tickets; no page Cron; page fingerprints as in §1.
- **26777 and candidates:** hold `1 a19900c3` with 0 resolutions; candidates `18 dc2b3a0f`; humans all 0; v2 all 0.
- **Functions:** `run-recall-automation` v10 `29aa16817f966e20021235d42a92d37b82c19d763b13b0df0bc281445c1cef6c`; `process-recall-matches` v19 `0b83d930901394050cc559b38777f5cc60433302f77b9cb804d1ea52c81501c8`; the other 6 bundles as in the A2 report §4.
- **RPC grants:** the six RPCs above exist and are executable by `service_role` only.
- **Edge secrets (user only; no values or digests):** 17, the baseline names, set fingerprint `38aa0e25589c46b7a553cf9349b0f2cd76805e5b0f96689029fddaec4b024cb4`.

**Step 2: re-download and rebuild (read-only plus local).** Same procedure as A2, in a new directory:

```sh
A=audits/phase-16-34-gate-a3/pre-deploy-archive
for s in ingest-cpsc-recalls process-recall-matches send-recall-notifications run-recall-automation ingest-recall-source ingest-recall-sources process-recall-matches-v2-cohort process-cpsc-page-evidence; do
  mkdir -p $A/$s && npx supabase functions download $s --project-ref cnftnulgtsraurtusnpb --use-api --workdir $A/$s
done
```

**Step 2a: check the non-matcher archive against the A2 baseline.** The matcher is now v19, so the A2 archive hash list no longer applies as a whole. Instead:

- the 7 non-matcher functions must be byte-identical to `audits/phase-16-34-gate-a2/pre-deploy-archive/`
- the matcher must equal `audits/phase-16-34-gate-a2/post-deploy/process-recall-matches/`

**Step 2b: rebuild.**

- **Expected refusal:** the build script refuses when a deployed copy of an edited file isn't the reviewed pre-16.33 source. The matcher's 3 files are now the post-16.33 versions, so `node scripts/build-phase-16-34-release.mjs $A …` is **expected to refuse**. This was confirmed locally at 00:2x by simulating the A2 archive with the v19 matcher download: `Error: supabase/functions/_shared/recallMatching/index.ts: deployed bytes are not the reviewed pre-16.33 source`.
- **Use the A2 archive instead**, which step 2a has just proven byte-identical to production for all 7 other functions:

```sh
OUT="$(mktemp -d)/release"
node scripts/build-phase-16-34-release.mjs audits/phase-16-34-gate-a2/pre-deploy-archive "$OUT"
diff -r "$OUT" releases/phase-16-34-gate-a && echo "release tree identical"
shasum -a 256 releases/phase-16-34-gate-a/MANIFEST.json
```

- **Required:** `releaseSha256 20fc07f08dc92c95b00c609e69e6aadc1d4d514708cb278dc09c053f2a31cec0`, an identical tree, and manifest `0f3ae1d0a0ea84e17beaae8a04d883f8047f9956436dfb1f3b1072ad0abfed67`.
- **Matcher cross-check:** the v19 download must still give `{"files":39,"expected":39,"extra":[],"mismatch":[]}`.

**Step 3: automation delta check.** Against the fresh automation download, the manifest check (the A2 snippet with `"run-recall-automation"` in place of `"process-recall-matches"`) must give `{"files":6,"expected":6,"extra":[],"mismatch":[<exactly the 5 files above>]}`.

**Step 4: deploy (the user runs this explicitly).**

```sh
npx supabase functions deploy run-recall-automation \
  --project-ref cnftnulgtsraurtusnpb \
  --workdir releases/phase-16-34-gate-a \
  --use-api
```

- **The function name is mandatory.** Without it, the CLI deploys every function in the tree, including the matcher.
- **Never pass `--prune` or `--no-verify-jwt`.** The release `config.toml` sets `[functions.run-recall-automation] verify_jwt = false`.

**Step 5: post-deploy verification (read-only).**

1. **Function listing:**
   - only `run-recall-automation` changes version (v10 → v11 or higher), with a new bundle and `verify_jwt=false`
   - matcher v19 `0b83d930…` and the other 6 bundles unchanged
2. **Download the automation again.** The manifest check must give **`{"files":6,"expected":6,"extra":[],"mismatch":[]}`**, and `cmp` against the release tree must show no difference.
3. **Download the matcher and page worker again:** byte-identical to their pre-A3 archives.
4. **Database unchanged by the deploy:**
   - migrations, job 2 MD5, queue 0, leases 0
   - stage `never_started`, 0 tickets
   - every §1 fingerprint
   - 0 outcomes, 0 matches and alerts
5. **Edge secrets (user):** 17, the same names, `38aa0e25…4cb4`.

**Step 6: STOP.** Then, as a separate read-only observation, watch the next natural run, which will be the first on automation v11 with the static key.

- **Ordinary checks:**
  - Cron `succeeded` with pg_net 200
  - run `success`, or `partial_success` / `source_partial_failure` only if a source is down
  - watermarks ≥ `2026-10-01`
  - lease released
- **What's new with v11:**
  - if the run has affected recalls, `recall_automation_matching_outcomes` has **exactly one row per pending recall**, and resolved pending rows are gone
  - unresolved ones stay with `retrying` status and a reason
  - nothing is `exhausted` on the first cycle
- **Tickets:** 0 rows, with `rejected_attempts` 0 (job 2 still sends the static key).
- **Push:** no matches, alerts or push unless there's a real alert (0 owned products).
- **Unchanged:** page stage, 26777, candidates, v2 and humans.

**Rollback** (only if step 5 or the observation fails):

```sh
npx supabase functions deploy run-recall-automation \
  --project-ref cnftnulgtsraurtusnpb \
  --workdir audits/phase-16-34-gate-a2/pre-deploy-archive/run-recall-automation \
  --use-api --no-verify-jwt
```

- **`--no-verify-jwt` is required** because the archive has no `config.toml`. Without it, Cron's key-authenticated call is rejected at the gateway.
- **Why the old automation still works** (rehearsal S2): v10 uses the old RPC, which is still installed.
- **Rows already written are harmless:** outcome rows written by v11 are append-only history and don't affect v10.
- **Failure mode if v11 breaks at runtime:** the next :17 run records `failed` and keeps the pending work, because the run fails before it acknowledges. That is detectable in `recall_automation_runs` and `cron.job_run_details`, and rollback takes minutes.

## 5. Production access in this step

- **Read-only only:** `SELECT`s, the MCP function listing, and edge-log queries.
- **No downloads:** the CLI token was unavailable.
- **No writes of any kind.**
- **Local file added:** this report.
