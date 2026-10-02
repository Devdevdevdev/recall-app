# Gate D: observation of the first natural ticket run (2026-10-01 18:17 UTC)

READ-ONLY. No tick, Cron, Vault, secret, migration, deploy, page or v2 action. The header probe is **not** part of this step; it needs separate authorization.

## Files

| File                              | SHA-256                                                            | Kind                                                   |
| --------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| `d1-first-natural-ticket-run.sql` | `c434d865369b57ffb9d55e1df1a238d8e6825b659592a8dd6b769d1424783af5` | read-only (`begin transaction read only` … `rollback`) |

**Derived from** the reviewed `audits/phase-16-34-gate-c/c3-postcheck.sql` (`49f532ee…8c6918`). C3 can't be reused as-is, because it requires exactly one ticket in total and there will be two after 18:17.

**Changes from C3:**

- **Scope:** limited to the run window 18:16:00–18:47:00 UTC (the `p` CTE).
- **Added checks:**
  - exactly one Cron execution in the window, `succeeded`, on jobid 2
  - no 401 or other non-200, and no timeout, among the window's pg_net responses
  - Gate C history unchanged: runs before the window `64 04ff4582`, ticket seq 1 `1 84c3d884` (captured read-only at 14:08:47)
  - no expired, unconsumed ticket
  - both sources attempted in the window, and consistent with the run status
  - watermarks ≥ `2026-10-01` (sources and automation state)
  - alerts and push equal to what the run itself created
  - job 2 command MD5 `aae24c409d36e91c64b4e1732d6c6651`
- **Accepted run status:** `success` with no error code, or `partial_success` **only** with `error_code = 'source_partial_failure'` **and** a source whose `last_status <> 'success'`. That's plan §9 and `orchestrator.ts`; `failed` is never accepted.

**Pre-run validation:** executed read-only on production at 14:10:07 UTC, before the run:

- 36 checks evaluated, with no SQL error.
- The 13 window-dependent checks were false, as expected with no run yet.
- The other 23 were true.

## Run (at or after 18:19 UTC, before 00:17 UTC)

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-d/d1-first-natural-ticket-run.sql
```

Or run its exact body (between `begin transaction read only;` and `rollback;`) through a read-only SQL client.

**Pass:** `"all_pass": true`, `"failed": []`, all 36 checks true.

## Outside SQL (read-only)

**1. Edge logs, function requests from 18:16 to 18:47 UTC:**

- exactly **one** `POST /functions/v1/run-recall-automation`, status 200, version 11
- child calls only to the v1 chain, all 200: `ingest-recall-sources`, `ingest-recall-source`, `send-recall-notifications`, and `process-recall-matches` only if recalls were affected
- no 401 anywhere
- no `process-cpsc-page-evidence` or `process-recall-matches-v2-cohort` request

The log stream can lag; for example, one `ingest-recall-source` line was missing at C3. Treat the database's source sync state as authoritative for per-source evidence.

**2. Function listing:** the 8 bundles are unchanged:

| Function                           | Version | Bundle                 |
| ---------------------------------- | ------- | ---------------------- |
| `run-recall-automation`            | v11     | `42d8a0dc…`            |
| `process-recall-matches`           | v19     | `0b83d930…`            |
| `process-cpsc-page-evidence`       | v9      | `c15d6623…` (jwt=true) |
| `ingest-cpsc-recalls`              | v23     | `2b0774c5`             |
| `ingest-recall-source`             | v12     | `ba394992`             |
| `ingest-recall-sources`            | v9      | `c41cb92e`             |
| `send-recall-notifications`        | v13     | `58b6945b`             |
| `process-recall-matches-v2-cohort` | v8      | `682308bd`             |

**3. Hosted secrets (user, safe command):** 17 names, `38aa0e25589c46b7a553cf9349b0f2cd76805e5b0f96689029fddaec4b024cb4`.

## If any check fails

STOP and report. Don't tick, don't roll back and don't change anything without a new explicit authorization. The reviewed in-place rollback remains `audits/phase-16-34-gate-c/cr-rollback.sql`.

## Gate D remaining after this observation (not prepared here)

- **Second consecutive natural ticket run** (2026-10-02 00:17 UTC): a second observation with its own window and baselines.
- **Rollback-only header probe** (plan §9): separate authorization required.
- **Theft query empty, and no 401 on any scheduled request:** across both runs.

## D2: second natural ticket run (2026-10-02 00:17 UTC)

| File                               | SHA-256                                                            | Kind      |
| ---------------------------------- | ------------------------------------------------------------------ | --------- |
| `d2-second-natural-ticket-run.sql` | `86611600a2e1d5ef87cb5a3575bf15d6dacf196846cd9aadf580c343f39bd241` | read-only |

**Identical to D1 except:**

- **Window:** 2026-10-02 00:16–00:47 UTC.
- **`history_unchanged`** also requires the D1 window to be intact: exactly one `success` run, and one ticket consumed once by `run-recall-automation` with `rejected_attempts` 0.
- **New check, `no_event_between_d1_and_d2`:** no Cron execution, ticket, run or pg_net response between 2026-10-01 18:47 and 2026-10-02 00:16.

That gives 37 checks.

**pg_net retention:** pg_net keeps responses for about 6 h, so D1's response 65 is gone. `theft_query_empty` therefore stays scoped to the run window, as in D1.

**Executed:** 2026-10-02 04:09:06 UTC, read-only (exact body through the MCP SQL tool), with this result:

- `all_pass: true`, `failed: []`, 37/37
- ticket seq 3 / request 66, consumed 00:17:02.121 by `run-recall-automation`, `rejected_attempts` 0
- response 66: 200, not timed out
- run `516d1e5d…`: `success`, 00:17:02.258 → 00:17:07.186
- watermarks `2026-10-02` for CPSC, Health Canada and automation
