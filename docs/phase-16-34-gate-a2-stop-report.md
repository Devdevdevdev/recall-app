# Phase 16.34 — Gate A2 stop report (`process-recall-matches` deploy)

Continuation of the [Gate A1 stop report](phase-16-34-gate-a1-stop-report.md) (A1 PASS). The reviewer authorized A2 for **`process-recall-matches` only**, from `releases/phase-16-34-gate-a`, if and only if every preflight passed.

**Gate A2: PASS.**

- **Deployed:** `process-recall-matches` v18 → **v19** at 2026-09-30 19:18:47.905 UTC.
- **Verification:** `{"files":39,"expected":39,"extra":[],"mismatch":[]}`, and every file is byte-identical to the release tree.
- **Unchanged:** the other 7 functions, Cron, the secret baseline, the page stage and the database.

**Stopped after A2.** No automation deploy, Cron change, secret rotation, ticket cutover, page scheduling, page POST, human authorization, v2 activity, or commit or push. Gate A3 is not started.

---

## 1. Timeline (UTC)

| When         | Event                                                                                                     | Actor  |
| ------------ | --------------------------------------------------------------------------------------------------------- | ------ |
| 18:33        | Waited for the approved window (19:00–23:30)                                                              | Claude |
| 19:00:38     | Read-only DB preflight; function listing                                                                  | Claude |
| 19:00–19:01  | Fresh download of all 8 functions; release rebuild; matcher delta check                                   | Claude |
| 19:0x        | Edge-secret metadata check (count, names, set fingerprint; no values or digests)                          | user   |
| 19:09:33     | Final DB and bundle recheck; release-tree recheck                                                         | Claude |
| 19:09        | Claude's deploy command **refused by the agent's permission classifier** (production deploy); not retried | —      |
| 19:18:47.905 | **`process-recall-matches` deployed** with the reviewed command (§3)                                      | user   |
| after 19:18  | Edge-secret metadata recheck                                                                              | user   |
| 19:20–19:21  | Post-deploy verification (§4)                                                                             | Claude |

## 2. Preflight (all passed)

| Check                           | Result                                                                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window                          | 19:00–19:09, inside 19:00–23:30; the last run was 18:17 and the next is 00:17 ✔                                                                                                                                 |
| Migrations                      | `31 f8be9553280b05ab2d26ca5d89fdb8b9` ✔                                                                                                                                                                         |
| Job 2                           | the only job, `17 */6 * * *`, active, MD5 `07549bf985a3034a5ef9c645692097b6` ✔                                                                                                                                  |
| Cron executions                 | last start 18:17:00.248 `succeeded`; 0 unfinished ✔                                                                                                                                                             |
| Automation lease / pg_net queue | 0 / 0; last response id 60 (18:17) ✔                                                                                                                                                                            |
| Runs                            | `60 a251b274`; 0 `running`; last run `success` ✔                                                                                                                                                                |
| Page stage                      | `never_started`; 0 control events, ticks and tickets; no page Cron ✔                                                                                                                                            |
| Page activity                   | attempts `8 ac113605`, work `8 4a536bb2`, revisions `27 7a34be4a`, ledgers `7 a27e8b73`, 34 fetches, 7 raw, 7 snapshots: unchanged ✔                                                                            |
| Humans, candidates, holds       | 0 capabilities, reviewers, reconciliations, review ledger and audit; candidates `18 dc2b3a0f`; holds `1 a19900c3` ✔                                                                                             |
| 8 function bundles              | unchanged from A1 §9; matcher v18 `81f96b1d…308d6b` ✔                                                                                                                                                           |
| Fresh archive                   | `audits/phase-16-34-gate-a2/pre-deploy-archive/`, hash list `8a8c51d1…6923`, **byte-identical** to both A1 archives ✔                                                                                           |
| Release rebuild                 | `releaseSha256 20fc07f08dc92c95b00c609e69e6aadc1d4d514708cb278dc09c053f2a31cec0`; identical to `releases/phase-16-34-gate-a` (`diff -r`); manifest `0f3ae1d0…d7b5` ✔                                            |
| A2 delta                        | 39 files in both, no extra file; exactly `recallMatching/index.ts`, `recallMatching/orchestrator.ts` and `process-recall-matches/legacyRun.ts` differ (the reviewed edits); every other deployed byte is kept ✔ |
| Edge secrets (user)             | 17, the baseline names, set fingerprint `38aa0e25589c46b7a553cf9349b0f2cd76805e5b0f96689029fddaec4b024cb4` = A1 baseline ✔                                                                                      |
| Release config                  | `[functions.process-recall-matches] verify_jwt = false`; the tree holds only `config.toml` and `functions/` ✔                                                                                                   |

## 3. Deployment

**Command** (the reviewed procedure, run by the user from the repository root):

```sh
npx supabase functions deploy process-recall-matches \
  --project-ref cnftnulgtsraurtusnpb \
  --workdir releases/phase-16-34-gate-a \
  --use-api
```

- The function name was given; there was no `--prune` and no `--no-verify-jwt`.
- The CLI output was not pasted into the agent session. The deploy is evidenced by the function listing (§4).

## 4. Post-deploy verification (read-only, 19:20–19:21 UTC)

**Function listing:**

| Function                           | Before                     | After                                                                                                                  |
| ---------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `process-recall-matches`           | v18 `81f96b1d…308d6b`      | **v19 `0b83d930901394050cc559b38777f5cc60433302f77b9cb804d1ea52c81501c8`**, updated 19:18:47.905, `verify_jwt=false` ✔ |
| `run-recall-automation`            | v10 `29aa1681…ef6c`        | unchanged ✔                                                                                                            |
| `process-cpsc-page-evidence`       | v9 `c15d6623…f533`, jwt on | unchanged ✔                                                                                                            |
| `ingest-cpsc-recalls`              | v23 `2b0774c5…0dc3`        | unchanged ✔                                                                                                            |
| `ingest-recall-source`             | v12 `ba394992…869d`        | unchanged ✔                                                                                                            |
| `ingest-recall-sources`            | v9 `c41cb92e…aae6`         | unchanged ✔                                                                                                            |
| `send-recall-notifications`        | v13 `58b6945b…11f5`        | unchanged ✔                                                                                                            |
| `process-recall-matches-v2-cohort` | v8 `682308bd…1f1e`         | unchanged ✔                                                                                                            |

Only `process-recall-matches` changed version.

**Deployed matcher bytes.** The matcher was downloaded again (`--use-api`) into `audits/phase-16-34-gate-a2/post-deploy/process-recall-matches/`, with hash list `5799fe69…5854`.

- **Manifest check:**

  ```
  {"files":39,"expected":39,"extra":[],"mismatch":[]}
  ```

- **Direct comparison:** `cmp` of every downloaded file against `releases/phase-16-34-gate-a` found no difference.

**Automation and page worker bytes.** Both were downloaded again, and each is **byte-identical** to its pre-deploy archive (`diff -r`).

**Database, 19:20:57:**

| Check              | Result                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Migrations         | `31 f8be9553…fdb8b9` ✔                                                                                                         |
| Cron               | job 2 only, MD5 `07549bf9…97b6`, active; no execution since 18:17; 0 unfinished ✔                                              |
| pg_net             | queue 0; last response 60 ✔                                                                                                    |
| Leases             | automation 0, matching 0 ✔                                                                                                     |
| Runs               | `60 a251b274` (no new run) ✔                                                                                                   |
| Page stage         | `never_started`; 0 control events, ticks and tickets ✔                                                                         |
| No page POST       | attempts `8 ac113605`, work `8 4a536bb2`, revisions `27 7a34be4a`, ledgers `7 a27e8b73`, 34 fetches, 7 raw, 7 snapshots ✔      |
| v2                 | all 8 `*_v2` tables 0 rows ✔                                                                                                   |
| Humans             | 0 capabilities, reviewer authorizations, reconciliations, review ledger, invalidations, authorization audit and attestations ✔ |
| Candidates / holds | `18 dc2b3a0f` / `1 a19900c3`, 0 resolutions ✔                                                                                  |
| Business           | 0 pending, 0 outcomes, 0 matches, 0 alerts, 0 push deliveries; notices `90 2eae2c8a` ✔                                         |
| Vault              | same names and timestamps (2026-09-16) ✔                                                                                       |

**Edge secrets (user, after the deploy):** 17, the same names, set fingerprint `38aa0e25…4cb4` = baseline ✔.

## 5. State after A2

This is plan rehearsal state **S3a**:

- the new matcher (v19) with the old automation (v10)
- the old automation ignores the matcher's new response fields
- v1 keeps its current key-based authentication

The v1 silent-loss correction is **not yet active**. It needs the release `run-recall-automation`, which is a separate gate.

**Rollback** (only if the next natural run regresses):

```sh
npx supabase functions deploy process-recall-matches \
  --project-ref cnftnulgtsraurtusnpb \
  --workdir audits/phase-16-34-gate-a2/pre-deploy-archive/process-recall-matches \
  --use-api --no-verify-jwt
```

`--no-verify-jwt` is required because the archive has no `config.toml`.

**Recommended next observation (read-only, not part of this gate):** the natural run at 00:17 UTC on 2026-10-01, which is the first to exercise v19. Expected:

- Cron `succeeded`, with pg_net 200
- run `success`, or `partial_success` / `source_partial_failure` only if a source is down
- source watermarks ≥ `2026-09-30`
- lease released
- 0 `recall_automation_matching_outcomes`, because the old automation doesn't call the new RPC
- no matches, alerts or push unless there are real alerts
- the page stage still stopped

## 6. Production access this gate

- **Write:** the one user-run deploy of `process-recall-matches`.
- **Agent, read-only:** `SELECT`s, function listings, and per-function source downloads (all 8 before the deploy; the matcher, automation and worker after).
- **Not read:** no secret value or digest; edge-secret metadata was handled by the user only.
- **Local files added:** `audits/phase-16-34-gate-a2/pre-deploy-archive/` (+ `.sha256`), `audits/phase-16-34-gate-a2/post-deploy/` (+ matcher `.sha256`), and this report.
