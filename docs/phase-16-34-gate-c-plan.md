# Phase 16.34 — Gate C execution plan (v1 Cron static key → single-use tickets)

Continuation of the [Gate B stop report](phase-16-34-gate-b-stop-report.md) (Gate B PASS).

**Status: PLAN ONLY. Not executed.** Production was not modified. Gate C needs separate reviewer approval.

**Scope:** one authorized production mutation, followed by one supervised invocation:

1. `select private.convert_recall_automation_cron_to_tickets();`
2. `select private.recall_automation_tick();` (once)

**Not part of Gate C:** no key rotation or Vault deletion (Gate E), no Gate D, no function deploy, no page Cron or scheduling, no secret change, no human authorization, no v2, no commit or push.

**Execution files** (`audits/phase-16-34-gate-c/`, `psql -X -v ON_ERROR_STOP=1`):

| File                     | SHA-256           | Kind                                                   |
| ------------------------ | ----------------- | ------------------------------------------------------ |
| `c0-preflight.sql`       | `34150cc4…8a60`   | read-only (`begin transaction read only` … `rollback`) |
| `c1-cutover.sql`         | `2aef8f6c…6d28`   | **write**: the cutover, guarded                        |
| `c2-supervised-tick.sql` | `f70691c1…b21e`   | **write**: one tick                                    |
| `c3-postcheck.sql`       | `49f532ee…8c6918` | read-only                                              |
| `cr-rollback.sql`        | `c445875b…e5ed`   | **write**: in-place rollback, guarded                  |

Recompute the hashes immediately before use. Any difference means STOP.

---

## 1. What the reviewed code does (M33, installed)

**`private.convert_recall_automation_cron_to_tickets()`** (owner-only, `{postgres=X/postgres}`):

- requires exactly one job named `recall-automation-every-6h`
- then runs `cron.alter_job(jobid, command := 'select private.recall_automation_tick();')`
- **changes only the command**: jobid, schedule, active flag, database and user are untouched

**`private.recall_automation_tick()`** (owner-only):

1. takes an advisory transaction lock
2. reads `recall_automation_url` from Vault and requires it to match the pinned pattern `^https://[a-z0-9]{20}\.supabase\.co/functions/v1/run-recall-automation$` (or a local host)
3. creates a random 256-bit ticket and queues **one** `net.http_post` with headers `content-type` and `x-recall-automation-ticket` only, body `{"trigger":"cron"}`, timeout 30 s
4. stores **only the ticket's SHA-256** with `job='recall_automation'`, `parameters={"trigger":"cron"}`, the `request_id`, and a 120 s expiry
5. returns `{"decision":"dispatched","requestId":n}`

**The ticket table is append-only:** no delete or truncate; a ticket can be consumed once.

**Consumption:** `public.consume_recall_automation_ticket` (`service_role` only) accepts a ticket once, for the right job, before expiry. Every other attempt increments `rejected_attempts` and returns `replayed`, `expired`, `wrong_job` or `unknown`.

**Automation v11 (deployed in A3):**

- accepts `x-recall-automation-ticket` (consumer `run-recall-automation`) **and** still accepts the static `x-recall-automation-key`
- a ticket run always uses `trigger='cron'` with the database's control limits; caller-supplied parameters are ignored

**The static-key command** that job 2 runs today (MD5 `07549bf985a3034a5ef9c645692097b6`) is byte-identical to the `$cron$…$cron$` literal inside the installed `private.install_recall_automation_cron()`. This was verified locally, and production's function definitions equal local (A1 and Gate B schema comparison). That is what makes an **in-place** rollback possible (§7).

## 2. Maintenance window

**Constraint:** job 2 runs at :17 every 6 h. Gate C must start at least 30 min after a natural run completes, and C1 must be committed no later than 45 min before the next run, so that C2, C3 and any rollback finish before it.

| Window (UTC)                                   | C1 must start by | Hard end (all done, incl. rollback) |
| ---------------------------------------------- | ---------------- | ----------------------------------- |
| **2026-10-01 12:50–17:30**                     | 17:00            | 17:30                               |
| 2026-10-01 18:50–23:30                         | 23:00            | 23:30                               |
| later days: hh:50–(hh+5):30 after each :17 run | +4:10            | +4:40                               |

**Additional rules:**

- The natural run that opens the window must have completed `success`; C0 checks this.
- Expected duration: C0 1 min, C1 under 1 min, C2 under 1 min, wait 60–90 s, C3 1 min. About 5 min in total.
- **The next natural run after Gate C is the first scheduled ticket run** (the start of Gate D observation). It needs no further action.

## 3. Preflight (C0, read-only; every check must be true)

**Run:**

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-c/c0-preflight.sql
```

**Required:** `"all_pass": true` and `"failed": []`. A `null` counts as a failure.

| Check key                                 | Condition                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `migrations_31`                           | `31 f8be9553280b05ab2d26ca5d89fdb8b9`                                                                                                                  |
| `only_job_2`                              | exactly one Cron job: jobid 2 `recall-automation-every-6h`                                                                                             |
| `job2_schedule_active`                    | `17 */6 * * *`, active                                                                                                                                 |
| `job2_static_key_cmd`                     | command MD5 `07549bf985a3034a5ef9c645692097b6`                                                                                                         |
| `no_page_cron`                            | no job name or command containing `page`                                                                                                               |
| `no_running_cron` / `last_cron_succeeded` | 0 unfinished executions; the latest `succeeded`                                                                                                        |
| `net_queue_0`                             | `net.http_request_queue` 0                                                                                                                             |
| `automation_lease_0` / `matching_lease_0` | 0 / 0                                                                                                                                                  |
| `no_run_in_progress` / `last_run_ok`      | 0 `running`; the latest run `success` or `partial_success`                                                                                             |
| `stage_never_started`                     | `{"state":"never_started","running":false}`                                                                                                            |
| `page_control_events_0` / `page_ticks_0`  | 0 / 0                                                                                                                                                  |
| `tickets_0`                               | `private.scheduler_invocation_tickets` 0 rows                                                                                                          |
| `page_unchanged`                          | attempts `8 ac113605`, work `8 4a536bb2`, revisions `27 7a34be4a`, ledgers `7 a27e8b73`, 34 fetches, 7 raw, 7 snapshots                                |
| `hold_26777`                              | holds `1 a19900c3` including recall 26777; 0 resolutions                                                                                               |
| `candidates_unreviewed`                   | `18 dc2b3a0f`; review ledger 0                                                                                                                         |
| `v2_inactive`                             | all `*_v2` tables 0                                                                                                                                    |
| `humans_0`                                | capabilities, reviewer authorizations, reconciliations, invalidations, authorization audit and attestations 0                                          |
| `vault_unchanged`                         | exactly `recall_automation_key` (updated 2026-09-16 06:03:21.458957) and `recall_automation_url` (06:03:35.819456)                                     |
| `url_pinned_to_project`                   | **boolean only:** the Vault URL matches `^https://cnftnulgtsraurtusnpb\.supabase\.co/functions/v1/run-recall-automation$`; the value is never returned |
| `rollback_text_ready`                     | the installer's `$cron$` literal has MD5 `07549bf9…97b6`                                                                                               |
| `owner_only_cutover_and_tick`             | both functions' ACL is exactly `{postgres=X/postgres}`                                                                                                 |
| `consume_rpc_service_role_only`           | `service_role` can execute `consume_recall_automation_ticket`; `anon` and `authenticated` can't                                                        |

**Outside SQL:**

- **Functions** (CLI or MCP listing):
  - `run-recall-automation` v11 `42d8a0dceaff3f2c09be2604c94a8f12d2108331af27189f2469653bffb659b5`, `verify_jwt=false`
  - `process-recall-matches` v19 `0b83d930901394050cc559b38777f5cc60433302f77b9cb804d1ea52c81501c8`
  - the page worker v9 `c15d6623…f533`
  - the other 5 bundles as in the A3 report
- **Hosted secrets (user, safe fingerprint command):** 17 names, `38aa0e25589c46b7a553cf9349b0f2cd76805e5b0f96689029fddaec4b024cb4`.
- **File hashes:** the five Gate C files equal the table above.

**Any failure → STOP. Nothing has been changed.**

## 4. Gate C change (C1)

**Run:**

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-c/c1-cutover.sql
```

**The only mutating statement:**

```sql
select private.convert_recall_automation_cron_to_tickets();
```

It runs inside one transaction, between two read-only assertion blocks:

- **Pre-assertion:**
  - exactly one job, jobid 2, `recall-automation-every-6h`, `17 */6 * * *`, active, MD5 `07549bf9…97b6`
  - no unfinished Cron execution, queue 0, both leases 0, no `running` run
  - otherwise it raises `C1 pre-state mismatch` / `C1: work in flight` and nothing changes
- **Post-assertion:**
  - exactly one job, jobid 2, same name, schedule and active flag
  - `command = 'select private.recall_automation_tick();'`
  - otherwise it raises `C1 post-state mismatch` and **nothing is committed**

**Expected before and after:**

| Field                    | Before                                                                       | After                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| jobid                    | 2                                                                            | **2**                                                                                   |
| jobname                  | `recall-automation-every-6h`                                                 | same                                                                                    |
| schedule                 | `17 */6 * * *`                                                               | same                                                                                    |
| active                   | `t`                                                                          | `t`                                                                                     |
| command                  | Phase 12 static-key `net.http_post` (MD5 `07549bf985a3034a5ef9c645692097b6`) | `select private.recall_automation_tick();` (MD5 **`aae24c409d36e91c64b4e1732d6c6651`**) |
| `converted_jobid` output | —                                                                            | `2`                                                                                     |

**Unchanged by C1:** Vault, edge secrets, functions, page objects, every other table.

**Local rehearsal:** this file and `cr-rollback.sql` were run on the local database inside one rolled-back transaction, with the local jobid substituted for 2:

- `07549bf9…` → cutover → `aae24c40…` (same jobid, schedule and active) → rollback → `07549bf9…`
- a second C1 was refused with `C1 pre-state mismatch`
- the local database was left with 0 jobs and 0 Vault secrets

## 5. Supervised ticket run (C2), immediately after C1

**Run once:**

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-c/c2-supervised-tick.sql
```

**SQL** (autocommit; pg_net sends only after commit):

```sql
select now() as tick_at, private.recall_automation_tick() as tick;
```

**Expected output:** `{"decision": "dispatched", "requestId": <n>}`. **Never run it a second time.** A second tick is a second production run.

**Note:** the supervised run is a **real** v1 cycle (`trigger='cron'`, database limits): ingestion, matching if recalls are affected, and notifications. It may legitimately ingest new notices.

## 6. Post-checks (C3, read-only, at least 60 s after C2)

**Run:**

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-c/c3-postcheck.sql
```

**Required:** `"all_pass": true` and `"failed": []`. The output also prints the ticket, response, run, outcomes, pending status, scheduler status and business counts for the report.

| Check key                                                                 | Pass criterion                                                                                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `exactly_one_ticket`                                                      | exactly **1** row in `scheduler_invocation_tickets`                                                                                       |
| `ticket_job_and_params`                                                   | `job='recall_automation'`, `parameters={"trigger":"cron"}`                                                                                |
| `ticket_consumed_once_by_automation`                                      | `consumed_at` set, `consumer='run-recall-automation'`, consumed before `expires_at` (single consumption is enforced by the guard trigger) |
| `ticket_rejected_attempts_0`                                              | `rejected_attempts = 0`                                                                                                                   |
| `http_200`                                                                | `net._http_response` for the ticket's `request_id`: `status_code=200`, not timed out, no error                                            |
| `theft_query_empty`                                                       | no consumed ticket lacks a 200 response (plan §7 detection query)                                                                         |
| `net_queue_0`                                                             | queue back to 0                                                                                                                           |
| `exactly_one_new_run`                                                     | exactly **1** automation run started since the ticket was issued, so no duplicate                                                         |
| `run_success`                                                             | `status='success'`, `trigger='cron'`, completed, `error_code` null                                                                        |
| `run_after_ticket_consumed`                                               | the run started after the consumption                                                                                                     |
| `automation_lease_0` / `matching_lease_0` / `no_run_in_progress`          | released / released / none                                                                                                                |
| `outcomes_cover_affected`                                                 | outcome rows for this run = `min(affected_recalls, max_recalls)`; 0 = 0 if nothing was affected                                           |
| `pending_equals_retained`                                                 | the remaining pending rows equal this run's non-`resolved` outcomes, so no silent loss                                                    |
| `nothing_exhausted`                                                       | 0 exhausted                                                                                                                               |
| `job2_ticket_command`                                                     | job 2 still the only job, same schedule, active, ticket command                                                                           |
| `no_page_cron`, `stage_never_started`, `no_page_ticket`, `page_unchanged` | page stage stopped; 0 control events and ticks; no `cpsc_page_stage` ticket; page fingerprints unchanged                                  |
| `hold_26777`, `candidates_unreviewed`                                     | `1 a19900c3`, 0 resolutions; `18 dc2b3a0f`, ledger 0                                                                                      |
| `v2_inactive`, `humans_0`                                                 | 0 / 0                                                                                                                                     |
| `static_key_present_unchanged`                                            | Vault names and `updated_at` exactly as in the preflight, so the static key is present and untouched                                      |
| `migrations_31`                                                           | unchanged                                                                                                                                 |

**Outside SQL:**

- **Edge logs, from the tick time to +3 min:**
  - exactly **one** `POST /functions/v1/run-recall-automation`, status 200, version 11
  - child calls only to the v1 chain (`ingest-recall-sources`, `ingest-recall-source`, `send-recall-notifications`, and `process-recall-matches` only if recalls were affected)
  - no `process-cpsc-page-evidence` or `process-recall-matches-v2-cohort`
- **Functions:** listing unchanged (no deploy).
- **Hosted secrets (user):** 17, `38aa0e25…4cb4`.

**Then STOP.** Gate C passes when C1's assertions held and C3 is `all_pass` with the outside checks above.

## 7. Rollback (restores the current static-key Cron with the still-current key)

**Primary: in-place, keeps jobid 2.**

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-c/cr-rollback.sql
```

**What it does:**

1. Requires job 2 to be the only job, and both Phase 12 Vault names to be present (names only).
2. Takes the byte-exact `$cron$…$cron$` command text from the installed `private.install_recall_automation_cron()`.
3. Applies it with `cron.alter_job(2, command := …)` **only if** its MD5 is `07549bf985a3034a5ef9c645692097b6`.
4. A post-assertion requires jobid 2, the same schedule, and MD5 `07549bf9…`; otherwise nothing is committed.

The restored command reads the **still-current** `recall_automation_key` from Vault at each run. Nothing is rotated, recreated or read.

**Expected:** `after | 2 | 17 */6 * * * | t | 07549bf985a3034a5ef9c645692097b6`.

**Fallback (only if the primary refuses because job 2 is missing or duplicated):**

```sql
select private.install_recall_automation_cron();         -- recreates the exact Phase 12 command, inactive, NEW jobid
select private.set_recall_automation_cron_active(true);
```

This was rehearsed as S2x in 16.34. Afterwards verify one job, `17 */6 * * *`, active, MD5 `07549bf9…`, and record the new jobid.

**If a Vault secret is missing, neither path can work.** STOP and escalate. No improvised command.

**When to roll back:**

| Failure                                                                               | Detection                                                                                                                     | Action                                                                                                                   |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Cutover fails** (C1 raises)                                                         | psql error `C1 …`; transaction not committed                                                                                  | **No rollback needed**: job 2 is unchanged. Re-run C0 to confirm MD5 `07549bf9…`. STOP.                                  |
| **Ticket generation fails** (C2 raises, e.g. `endpoint is unavailable or not pinned`) | psql error; no ticket row, no queued request (the tick's transaction rolled back)                                             | Run **CR** before the next :17. C0-style recheck. STOP.                                                                  |
| **HTTP non-200**                                                                      | C3 `http_200` false; response status ≠ 200, or timed out                                                                      | Run **CR**. Don't tick again. Record the ticket row, response and run state. STOP.                                       |
| **Automation returns 401**                                                            | response 401; ticket `consumed_at` null, or `rejected_attempts > 0`                                                           | Run **CR**. STOP. Investigate the v11 ticket path offline.                                                               |
| **Ticket not consumed**                                                               | C3 `ticket_consumed_once_by_automation` false after 120 s; ticket expired unconsumed                                          | Run **CR**. Check the queue and response (dropped or redirected request?). STOP.                                         |
| **Duplicate invocation**                                                              | `exactly_one_new_run` false, `rejected_attempts > 0`, more than one automation POST in the logs, or `theft_query_empty` false | Run **CR**. Treat as a possible incident (§7 of the 16.34 plan). STOP; Gate E rotation decisions belong to the reviewer. |
| **Any other C3 failure**                                                              | `all_pass` false                                                                                                              | Run **CR** if job 2's command is involved; otherwise STOP and report.                                                    |

**After any rollback:**

- **C0 must show:** job 2 static-key MD5 `07549bf9…`, queue 0, leases 0.
- **The failed ticket row stays** (append-only audit). Later gates' `tickets_0` precondition then becomes "no ticket other than the recorded failed one".
- **Next natural run:** observe it on the static key.

## 8. Execution roles

- **The agent** runs the read-only C0 and C3 and the log or listing checks where its permission classifier allows. If it's refused, the user runs the same files. **The Vault URL boolean in C0 may be refused for the agent**; the user then runs C0.
- **The user** runs every write explicitly: C1, C2 and, if needed, CR. Earlier gates showed the agent's production writes are refused by its permission classifier, so the plan doesn't depend on them.
- **The user** runs the hosted-secret check before C1 and after C3.

## 9. STOP

Gate C is **not executed**. It waits for separate reviewer approval of:

- the window
- `c1-cutover.sql`, the single `convert_recall_automation_cron_to_tickets()` mutation
- `c2-supervised-tick.sql`, one tick
- `cr-rollback.sql`, conditional

No Gate D, no key rotation or Vault deletion, no page scheduling, no commit or push.
