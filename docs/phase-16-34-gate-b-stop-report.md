# Phase 16.34 — Gate B stop report (post-A3 natural run and validation)

**Gate B: PASS.** The natural run was clean, all four rollback-only suites passed with their exact expected counts (**317/317**), and the hosted secret baseline is unchanged. One limit is stated plainly: the per-recall outcome path was not exercised in production by a natural run (§2).

Continuation of the [Gate A3 stop report](phase-16-34-gate-a3-stop-report.md) (A3 PASS: `run-recall-automation` v11).

**Natural run: CLEAN.** Run 62 (2026-10-01 06:17 UTC) is the first natural run on automation **v11**. It used the static-key Cron authentication and completed `success`.

- **Not exercised:** 0 recalls were affected, so `process-recall-matches` v19 was **not invoked** and the **per-recall outcome path was not exercised** (§2).
- **What it does verify:** v11's orchestration, ingestion and notification steps, and their compatibility with the installed schema, under the unchanged static-key Cron.

**Gate B validation suites: PASS (run by the user).** The agent's own production pgTAP run was refused by its permission classifier ("Modify Shared Resources") and not retried. The user then ran all four suites: 22/22, 89/89, 172/172 and 34/34 (§4). A read-only check afterwards found no trace (§7).

**Hosted secrets: unchanged** (user check: 17, `38aa0e25…4cb4`) (§5).

**Not done:** Gate C, Cron cutover, secret rotation, page scheduling, human authorization, v2 activity, or commit or push. Production was not modified: the suites' writes were all inside transactions that rolled back.

---

## 1. Run 62 (read-only, 07:04 UTC)

**Cron and HTTP:**

| Check       | Result                                                                              |
| ----------- | ----------------------------------------------------------------------------------- |
| Job 2       | natural execution 06:17:00.246 → 06:17:00.357 `succeeded` ("1 row"); 0 unfinished ✔ |
| pg_net      | response **62: 200**, not timed out, no error; queue 0 ✔                            |
| Invocations | exactly one execution since 00:17, and one response (62) ✔                          |

**Edge logs, 04:45 → 07:05:** only the v1 chain at 06:17, all `POST` with status 200:

| Function                             | Version | Status | Time    |
| ------------------------------------ | ------- | ------ | ------- |
| `ingest-recall-source` (first call)  | 12      | 200    | 527 ms  |
| `ingest-recall-source` (second call) | 12      | 200    | 1158 ms |
| `ingest-recall-sources`              | 9       | 200    | 2164 ms |
| `send-recall-notifications`          | 13      | 200    | 383 ms  |
| `run-recall-automation`              | **11**  | 200    | 4477 ms |

There was no duplicate or unexpected invocation. There was no `process-recall-matches` request (0 affected recalls), no page worker and no v2 cohort.

**Automation:**

| Check                | Result                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run                  | run 62 `8640e4c2…`, `trigger=cron`, **`success`**, 06:17:02.412 → 06:17:05.225; `error_code` and `error_step` null ✔                               |
| Counters             | seen 3, unchanged 3, inserted / updated / rejected 0; **affected recalls 0**; candidate pairs 0; AI 0; provider failures 0; alerts 0; push 0/0/0 ✔ |
| History              | the first 61 runs are still `61 5c3c0926` ✔                                                                                                        |
| Leases / in progress | automation 0, matching 0; 0 `running` ✔                                                                                                            |
| Pending work         | 0 rows; `pending_status` `{pending:0, retrying:0, exhausted:0, reasons:{}}` ✔                                                                      |
| Silent disappearance | none possible in this run: there was no pending work before (A3 preflight: 0) and none was created ✔                                               |

**Sources:**

| Source        | Status                                | Metrics                                                       | Watermark                                             |
| ------------- | ------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| CPSC          | `success` 06:17:03.386, no error code | fetched 0, no errors                                          | `last_publish_date` `2026-10-01` (= before) ✔         |
| Health Canada | `success` 06:17:04.683, no error code | fetched 3, unchanged 3, 0 inserted, quarantined or unresolved | `last_updated_date` `2026-10-01` (= before) ✔         |
| Automation    | —                                     | —                                                             | `last_successful_watermark` `2026-10-01` (= before) ✔ |

No watermark regressed.

**Matching:** v19 was **not invoked**, because there were 0 affected recalls. Outcome rows: 0 (none expected). Matches, alerts and push deliveries: 0 (0 owned products). There's no duplicate and no loss of work.

## 2. Per-recall outcome path: not independently exercised in production

- **Why:** run 62 had **no affected recalls**, so v11 had no pending batch to hand to the matcher, and no per-recall outcome row could be written.
- **What it verifies:**
  - v11 orchestration end to end: lease, ingestion children, watermark, notifications, completion
  - compatibility with the installed 16.32/16.33 schema
  - the unchanged static-key Cron authentication
- **What it does not verify:** the per-recall outcome path, meaning:
  - one `recall_automation_matching_outcomes` row per pending recall
  - unresolved work kept `retrying` with a reason
  - explicit exhaustion
- **Where that evidence comes from today:**
  - locally: the 16.33/16.34 harness 20/20, pgTAP and rehearsal S3b
  - in production: the rollback-only install check, 22/22 (§4), which exercises the installed RPCs inside a rolled-back transaction; it is not a natural run
- **Natural confirmation:** the next run with affected recalls. Health Canada published 3 new notices at 00:17, so that is likely soon.
- **No artificial recalls or products were created.**

## 3. Production safety (read-only, 07:04–07:06 UTC)

| Check                   | Result                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations              | `31 f8be9553280b05ab2d26ca5d89fdb8b9` ✔                                                                                                                                                  |
| Functions               | automation **v11** `42d8a0dc…59b5`; matcher **v19** `0b83d930…01c8`; the other six bundles unchanged (`2b0774c5`, `58b6945b`, `ba394992`, `c41cb92e`, `682308bd`, `c15d6623` jwt=true) ✔ |
| Cron                    | job 2 only, `17 */6 * * *`, active, MD5 `07549bf985a3034a5ef9c645692097b6` ✔                                                                                                             |
| pg_net queue            | 0 ✔                                                                                                                                                                                      |
| Page stage / Cron       | `never_started`, `running=false`; 0 control events; no page Cron ✔                                                                                                                       |
| No page POST            | attempts `8 ac113605`, work `8 4a536bb2`, revisions `27 7a34be4a`, ledgers `7 a27e8b73`, 34 fetches, 7 raw, 7 snapshots; no page-worker request ✔                                        |
| Page tickets            | 0 ticks, 0 tickets; `scheduler_invocation_status` `{}` ✔                                                                                                                                 |
| 26777                   | hold `1 a19900c3`, 0 resolutions ✔                                                                                                                                                       |
| 18 candidates           | `18 dc2b3a0f`, review ledger 0, so all unreviewed ✔                                                                                                                                      |
| v2                      | all `*_v2` tables 0 ✔                                                                                                                                                                    |
| Humans                  | capabilities, reviewer authorizations, reconciliations, review ledger, invalidations, authorization audit and attestations all 0 ✔                                                       |
| Matches / alerts / push | 0 / 0 / 0 ✔                                                                                                                                                                              |
| Vault                   | same names and timestamps (2026-09-16) ✔                                                                                                                                                 |

**Mutation sweep since the A3 deploy (04:43):** 37 timestamped base tables were checked. Only four changed, all expected v1 writers:

| Table                              | Rows changed                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `private.recall_automation_runs`   | 1 (run 62)                                                                                                        |
| `private.recall_automation_state`  | 1                                                                                                                 |
| `private.recall_source_sync_state` | 2                                                                                                                 |
| `public.recall_notices`            | 3, all `health_canada`, **all existing rows**: the known `updated_at` bump on the 3 notices reported as unchanged |

**New baselines:** runs `62`; notices `93 761f4162`, content excluding `updated_at` `93 b20d5ad3`.

## 4. Gate B validation suites (PASS — run by the user, ≈07:07–07:17 UTC)

**Defined by** the Phase 16.34 plan §17, Gate B. Each suite runs through `scripts/run-remote-pgtap.mjs` (`796a71ba…b053`), which:

- injects a transient `create extension pgtap` after the suite's own `BEGIN`
- requires the suite to end in `ROLLBACK` and refuses any `COMMIT`
- refuses if pgTAP is already installed
- verifies afterwards that pgTAP is absent, no session is idle in a transaction, and the migration history is unchanged

| #   | Suite                                                           | SHA-256                          | Expected assertions | Actual (`plan` / `ok` / `notOk`) |
| --- | --------------------------------------------------------------- | -------------------------------- | ------------------- | -------------------------------- |
| 1   | `supabase/remote-install-checks/phase-16-33-install.sql`        | `54b7fedf…ec29` (= 16.33 record) | **22**              | **22 / 22 / 0** ✔                |
| 2   | `supabase/tests/remote/phase-16-production-compatibility.sql`   | `f814a407…f11e`                  | **89** (`plan(89)`) | **89 / 89 / 0** ✔                |
| 3   | `supabase/tests/remote/phase-16-26-page-failure-evidence.sql`   | `fb6645c0…429c`                  | **172**             | **172 / 172 / 0** ✔              |
| 4   | `supabase/tests/remote/phase-16-17-watermark-and-retention.sql` | `4279260a…655a`                  | **34**              | **34 / 34 / 0** ✔                |

**Total: 317 expected, 317 passed, 0 failed.**

**Every summary also reported:**

- `"psqlExit": 0`, `"extensionCreated": true`, `"rolledBack": true`
- `"pgtapInstalledBefore": 0`, `"pgtapInstalledAfter": 0`, `"idleInTransactionAfter": 0`
- `"guardsUnchanged": true`, `"migrationHistoryUnchanged": true`
- `"failures": []`, `"passed": true`

**Commands run** (repository root, `SUPABASE_DB_URL` set, one at a time, inside the 06:50–11:30 window):

```sh
npm run -s test:remote-pgtap -- --file supabase/remote-install-checks/phase-16-33-install.sql
npm run -s test:remote-pgtap -- --file supabase/tests/remote/phase-16-production-compatibility.sql
npm run -s test:remote-pgtap -- --file supabase/tests/remote/phase-16-26-page-failure-evidence.sql
npm run -s test:remote-pgtap -- --file supabase/tests/remote/phase-16-17-watermark-and-retention.sql
```

**Pass criterion for each:** the JSON summary shows:

- `"plan"` = the expected count, `"ok"` = the same, `"notOk": 0`
- `"extensionCreated": true`, `"rolledBack": true`
- `"psqlExit": 0`
- `"pgtapInstalledAfter": 0`, `"idleInTransactionAfter": 0`
- `"migrationHistoryUnchanged": true`
- `"passed": true`

**Any failure** would have stopped the sequence. None occurred.

## 5. Hosted secrets (user check after the suites)

**Result:** `secret_count: 17`, the same 17 names, and `secret_set_fingerprint: 38aa0e25589c46b7a553cf9349b0f2cd76805e5b0f96689029fddaec4b024cb4`, equal to the canonical baseline ✔.

- The check used the user's existing safe command, which displays no values and no digests.
- The agent can't read secret metadata (permission classifier, credential materialization).

## 6. Production access in this step

- **Agent, read-only:** `SELECT`s, function listings and edge-log queries.
- **Not run by the agent:** the one attempted rollback-only pgTAP run was refused by the permission classifier before execution, so nothing ran.
- **User:** the four rollback-only suites; transient pgTAP, all rolled back.
- **No committed writes** of any kind.
- **Local file added:** this report.

## 7. Post-suite trace check (read-only, 07:18:45 UTC)

**Transaction cleanup:**

- pgTAP extension: 0 (absent)
- sessions idle in a transaction: 0
- `cpsc_page_worker` has **no** `USAGE` on `extensions`, so the install check's `grant usage` was rolled back

**State equal to §3:**

- migrations `31 f8be9553…`
- job 2 MD5 `07549bf9…`, active; last Cron execution 06:17; 0 unfinished
- pg_net queue 0, last response 62
- leases 0 / 0
- runs 62, the first 61 still `61 5c3c0926`, last completed 06:17:05.225
- 0 pending, 0 outcomes
- stage `never_started`, 0 control events, ticks and tickets
- attempts `8 ac113605`, work `8 4a536bb2`, revisions `27 7a34be4a`, ledgers `7 a27e8b73`, 34 fetches, 7 raw, 7 snapshots
- holds `1 a19900c3`, 0 resolutions; candidates `18 dc2b3a0f`
- observations `109 34768a9f`, identities `38 43120649`, notices `93 761f4162`
- automation watermark `2026-10-01`
- 0 matches, alerts and push deliveries; human tables all 0; v2 0
- Vault unchanged
- logins: only `cpsc_page_worker` among the four checked roles (as before)

**Schema:**

| Kind        | Count | Definitions fingerprint | ACL fingerprint |
| ----------- | ----- | ----------------------- | --------------- |
| functions   | 174   | `a35f5f4b…`             | `0cefad02…`     |
| relations   | 62    | `4eb831d0…`             | `a11d9957…`     |
| constraints | 457   | `ed11cebc…`             | —               |
| indexes     | 154   | `1365d8a8…`             | —               |
| triggers    | 77    | `aeb69a2e…`             | —               |
| policies    | 12    | `feee127d…`             | —               |

Every value is identical to the reviewed local schema and to the A1 install check. The suites left no schema trace.

**New fingerprints recorded for later gates:** runs `62 c16b7264`; source sync state `a235c903…`; automation control `a0cd0518…`.
