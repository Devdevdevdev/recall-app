# Phase 16.34 — Gate A3 stop report (`run-recall-automation` deploy)

Continuation of the [post-A2 run report and A3 plan](phase-16-34-post-a2-run-and-a3-plan.md). The reviewer conditionally approved A3: deploy **only** `run-recall-automation` from `releases/phase-16-34-gate-a`, if and only if every preflight passed.

**Gate A3: PASS.**

- **Deployed:** `run-recall-automation` v10 → **v11** at 2026-10-01 04:43:33.092 UTC.
- **Verification:** `{"files":6,"expected":6,"extra":[],"mismatch":[]}`, and every file is byte-identical to the release tree.
- **Unchanged:** the matcher (v19), the page worker, the other functions, Cron, the database, and the secret baseline.

**Stopped after A3.** No Gate C, ticket cutover, Cron change, secret rotation, page scheduling, page POST, human authorization, v2 activity, or commit or push.

---

## 1. Timeline (UTC)

| When         | Event                                                                                                 | Actor  |
| ------------ | ----------------------------------------------------------------------------------------------------- | ------ |
| 04:40:53     | Window check (00:50–05:30, next run 06:17); CLI authentication restored                               | Claude |
| 04:41:18     | Read-only DB preflight                                                                                | Claude |
| 04:41–04:42  | Function listing; fresh download of all 8 functions; archive comparison; release rebuild; delta check | Claude |
| ≈04:42       | Hosted-secret metadata check (count, names, set fingerprint; no values or digests)                    | user   |
| 04:43:33.092 | **`run-recall-automation` deployed** with the reviewed command (§3)                                   | user   |
| 04:44–04:45  | Post-deploy verification (§4)                                                                         | Claude |

## 2. Preflight (all passed)

| Check                 | Result                                                                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window                | 04:41, inside 00:50–05:30 ✔                                                                                                                                                                                                                                 |
| Migrations            | `31 f8be9553280b05ab2d26ca5d89fdb8b9` ✔                                                                                                                                                                                                                     |
| Functions             | `process-recall-matches` **v19** `0b83d930…01c8`; `run-recall-automation` **v10** `29aa1681…ef6c`; the other 6 bundles as in the A2 report ✔                                                                                                                |
| Job 2                 | the only job, `17 */6 * * *`, active, MD5 `07549bf985a3034a5ef9c645692097b6`; last execution 00:17 `succeeded`; 0 unfinished ✔                                                                                                                              |
| Queue and leases      | pg_net queue 0 (last response 61); automation lease 0; matching leases 0 ✔                                                                                                                                                                                  |
| Runs                  | `61 5c3c0926`; 0 `running`; last `success`; 0 pending; 0 outcomes ✔                                                                                                                                                                                         |
| Page                  | stage `never_started`; 0 control events, ticks and tickets; no page Cron; attempts `8 ac113605`, work `8 4a536bb2`, revisions `27 7a34be4a`, ledgers `7 a27e8b73`, 34 fetches, 7 raw, 7 snapshots ✔                                                         |
| v2 / humans           | v2 tables 0 in total; all 7 human tables 0 ✔                                                                                                                                                                                                                |
| 26777 / candidates    | hold `1 a19900c3`, 0 resolutions; candidates `18 dc2b3a0f` ✔                                                                                                                                                                                                |
| Hosted secrets (user) | **17**, the baseline names, fingerprint `38aa0e25589c46b7a553cf9349b0f2cd76805e5b0f96689029fddaec4b024cb4` ✔                                                                                                                                                |
| Archives              | fresh downloads in `audits/phase-16-34-gate-a3/pre-deploy-archive/`: the 7 non-matcher functions are byte-identical to `audits/phase-16-34-gate-a2/pre-deploy-archive/`; the matcher is byte-identical to `audits/phase-16-34-gate-a2/post-deploy/` (v19) ✔ |
| Release rebuild       | from the verified A2 archive: `releaseSha256 20fc07f08dc92c95b00c609e69e6aadc1d4d514708cb278dc09c053f2a31cec0` ✔; tree identical; manifest `0f3ae1d0…d7b5` ✔                                                                                                |
| A3 delta              | automation `{"files":6,"expected":6,"extra":[],"mismatch":[<the 5 reviewed files>]}`; `request.ts` kept at its deployed bytes ✔                                                                                                                             |
| Matcher vs release    | `{"files":39,"expected":39,"extra":[],"mismatch":[]}` ✔                                                                                                                                                                                                     |
| Release config        | `[functions.run-recall-automation] verify_jwt = false` ✔                                                                                                                                                                                                    |

**Release-tree note: `supabase/.temp/` (benign).**

- **What it is:** the user's A2 deploy created `releases/phase-16-34-gate-a/supabase/.temp/` at 19:18 UTC on 09-30.
- **Contents:** two CLI metadata files, `cli-latest` (`v2.118.0`) and `linked-project.json` (project ref, name and organization id). There's no code and no secret.
- **Why it doesn't matter:** neither file is in the manifest or the release SHA. Excluding it, the tree is byte-identical to the rebuild.

## 3. Deployment

**Command** (the reviewed procedure, run by the user from the repository root):

```sh
npx supabase functions deploy run-recall-automation \
  --project-ref cnftnulgtsraurtusnpb \
  --workdir releases/phase-16-34-gate-a \
  --use-api
```

- The function name was given; there was no `--prune` and no `--no-verify-jwt`.
- **CLI output:** 7 assets uploaded (`run-recall-automation/index.ts`, `store.ts` and `children.ts`; `_shared/automation/index.ts`, `types.ts`, `request.ts` and `orchestrator.ts`), then `Deployed Functions on project cnftnulgtsraurtusnpb: run-recall-automation`.
- **`types.ts`:** the CLI uploaded it, but it's imported only as types, so the deployed bundle contains the expected 6 files (§4).

## 4. Post-deploy verification (read-only, 04:44–04:45 UTC)

**Function listing:**

| Function                           | Before              | After                                                                                                          |
| ---------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `run-recall-automation`            | v10 `29aa1681…ef6c` | **v11 `42d8a0dceaff3f2c09be2604c94a8f12d2108331af27189f2469653bffb659b5`**, 04:43:33.092, `verify_jwt=false` ✔ |
| `process-recall-matches`           | v19 `0b83d930…01c8` | unchanged ✔                                                                                                    |
| `process-cpsc-page-evidence`       | v9 `c15d6623…f533`  | unchanged, `verify_jwt=true` ✔                                                                                 |
| `ingest-cpsc-recalls`              | v23 `2b0774c5…0dc3` | unchanged ✔                                                                                                    |
| `ingest-recall-source`             | v12 `ba394992…869d` | unchanged ✔                                                                                                    |
| `ingest-recall-sources`            | v9 `c41cb92e…aae6`  | unchanged ✔                                                                                                    |
| `send-recall-notifications`        | v13 `58b6945b…11f5` | unchanged ✔                                                                                                    |
| `process-recall-matches-v2-cohort` | v8 `682308bd…1f1e`  | unchanged ✔                                                                                                    |

Only `run-recall-automation` changed version.

**Byte verification** (fresh downloads in `audits/phase-16-34-gate-a3/post-deploy/`):

- **Automation manifest check:**

  ```
  {"files":6,"expected":6,"extra":[],"mismatch":[]}
  ```

- **Direct comparison:** `cmp` of all 6 files against `releases/phase-16-34-gate-a` found them identical.
- **Matcher and page worker:** both byte-identical to their pre-A3 downloads.

**Database, 04:44:34:**

| Check             | Result                                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations        | `31 f8be9553…fdb8b9` ✔                                                                                                                                                                 |
| Cron job 2        | unchanged (MD5 `07549bf9…97b6`, active); no execution since 00:17; 0 unfinished ✔                                                                                                      |
| pg_net            | queue 0; last response 61 ✔                                                                                                                                                            |
| Leases            | automation 0, matching 0 ✔                                                                                                                                                             |
| Runs              | `61 5c3c0926` (no run since 00:17); 0 pending; 0 outcomes ✔                                                                                                                            |
| Page stage / Cron | `never_started`; no page Cron ✔                                                                                                                                                        |
| No page POST      | attempts `8 ac113605`, work `8 4a536bb2`, revisions `27 7a34be4a`, ledgers `7 a27e8b73`, 34 fetches, 7 raw, 7 snapshots; **no function request at all** in the edge logs 00:25–04:45 ✔ |
| No page ticket    | 0 ticks, 0 tickets, 0 control events ✔                                                                                                                                                 |
| v2                | 0 ✔                                                                                                                                                                                    |
| 26777             | hold `1 a19900c3`, 0 resolutions ✔                                                                                                                                                     |
| Candidates        | `18 dc2b3a0f` (all unreviewed); review ledger 0 ✔                                                                                                                                      |
| Human tables      | all 0 ✔                                                                                                                                                                                |
| Business          | notices `93 c8f62980`; 0 matches, alerts and push deliveries ✔                                                                                                                         |
| Vault             | same names and timestamps ✔                                                                                                                                                            |

**Hosted secrets:** confirmed by the user just before the deploy (17, `38aa0e25…4cb4`). A function deploy has no write path to secrets. A post-A3 user recheck wasn't requested by the authorization; it's recommended at the start of the next gate.

## 5. State after A3

**Plan state "Gate A done" (rehearsal S3b):**

- matcher v19 and automation v11, both the reviewed release
- job 2 still invokes the automation with the **static key**, which v11 still accepts
- tickets are accepted by v11 but unused, because no cutover was done

**The v1 correction is now active.** When a run has affected recalls, v11 records one `recall_automation_matching_outcomes` row per pending recall. It keeps unresolved work pending with retry state, instead of acknowledging the batch.

**Next natural run:** 06:17 UTC, the first on v11. Expected (read-only observation, not part of this gate):

- **Ordinary checks:**
  - Cron `succeeded` with pg_net 200
  - run `success`, or `partial_success` / `source_partial_failure` only if a source is down
  - watermarks ≥ `2026-10-01`
  - leases released
- **New with v11:** if recalls are affected, exactly one outcome row per pending recall; resolved pending rows removed; unresolved ones `retrying` with a reason; nothing `exhausted` on the first cycle.
- **Tickets:** 0 tickets, `rejected_attempts` 0.
- **Push:** no matches, alerts or push without real alerts (0 owned products).
- **Unchanged:** page stage, 26777, candidates, v2 and humans.

**Rollback** (only if that run regresses):

```sh
npx supabase functions deploy run-recall-automation \
  --project-ref cnftnulgtsraurtusnpb \
  --workdir audits/phase-16-34-gate-a3/pre-deploy-archive/run-recall-automation \
  --use-api --no-verify-jwt
```

- **`--no-verify-jwt` is required:** the archive has no `config.toml`.
- **v10 remains compatible** with the installed schema (rehearsal S2).
- **Rows already written are harmless:** outcome rows written by v11 are append-only history.

## 6. Production access this gate

- **Write:** the one user-run deploy of `run-recall-automation`.
- **Agent, read-only:**
  - `SELECT`s
  - function listings
  - per-function downloads (all 8 before the deploy; the automation, matcher and worker after)
  - an edge-log query
- **Not read:** no secret value or digest; hosted-secret metadata was handled by the user only.
- **Local files added:** `audits/phase-16-34-gate-a3/pre-deploy-archive/`, `audits/phase-16-34-gate-a3/post-deploy/`, and this report.
