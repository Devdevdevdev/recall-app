# Phase 16.34 — Gate A1 stop report (controlled production migration installation)

Continuation of the [Phase 16.34 installation plan](phase-16-34-controlled-installation-plan.md). The reviewer approved **Gate A1 only**: install exactly the reviewed 16.32 and 16.33 migrations. No function deployment or other production mutation was authorized.

**Gate A1: PASS (closed).** The secret metadata baseline is established (§8), and historical digest equality is explicitly **not** claimed.

- **Installed:** `20260930120000` (16.32) and `20260930200000` (16.33), by the user at about 15:10 UTC with `npx supabase db push --linked`.
- **Preflight (§2):** completed manually by the user before the install, and passed. This is confirmed by the reviewer. _(Corrected: the first version of this report said the preflight had not been run.)_
- **Verified:** 31 migrations, each new version recorded once; the installed schema is identical to the reviewed local schema; the page stage is `never_started`; there's no page Cron; job 2 is unchanged; no Vault secret, capability, function or page state changed.
- **Reviewer's independent confirmation:** 31 production migrations, both new migrations present, all eight Edge Functions unchanged.
- **Edge secrets (§8):**
  - The user's metadata check found the expected historical count of **17**, with no unexpected name.
  - The historical digest evidence is insufficient to prove byte-identical values across A1.
  - Set fingerprint `38aa0e25…4cb4` is now the canonical baseline for every later Phase 16.34 gate.
- **First natural run after install (§13):** 18:17 run 60 `success`, both sources healthy, and only the expected v1 writes.
- **Release tree (§14):** reconfirmed at 18:2x UTC. A2 instructions for `process-recall-matches` are in §15.

**A1 closure — accepted evidence:**

- the manual pre-install preflight
- the dry run listing exactly M32 and M33
- 31 migrations
- production schema = reviewed local schema
- page stage `never_started`
- no page Cron
- v1 Cron unchanged
- the natural 18:17 run clean
- no page activity
- no human capability, review or reconciliation
- function bundles unchanged
- the secret metadata baseline established

**Stopped after A1.** No function deploy, Cron change, secret change, scheduling, page POST, human authorization, v2 activity, or commit or push.

---

## 1. Pre-install checks (15:02–15:05 UTC)

| Check                                 | Result                                                                                                                                                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan re-read                          | done. A1 = plan §16 steps 1–6. Steps 7–8 (function deploys) are excluded.                                                                                                                                                                                         |
| M32 full SHA-256                      | `dd3a40e1af8ffeb06cf3af1fe3014e07fa305e643c5747b351ad5f12f2449cdd` = the 16.32 report (§ file record) ✔                                                                                                                                                           |
| M33 full SHA-256                      | `774166807cc143071fd86306b88921198e4ccab50afd5a5f5a9eafffe46da018` = the 16.33 report (§14 record) ✔                                                                                                                                                              |
| Release manifest                      | `0f3ae1d0a0ea84e17beaae8a04d883f8047f9956436dfb1f3b1072ad0abfed67` ✔                                                                                                                                                                                              |
| Archive of the 8 deployed functions   | `supabase functions download <slug> --use-api`, one clean workdir each, in `audits/phase-16-34-gate-a1/deployed-archive/`. 130 files; hash list `deployed-archive.sha256` = `8a8c51d1…6923`                                                                       |
| Release rebuild from production bytes | `releaseSha256 20fc07f08dc92c95b00c609e69e6aadc1d4d514708cb278dc09c053f2a31cec0` ✔ (50 files, 8 edits; `orchestratorV2.ts` and `reviewedCriteriaV2.ts` kept at deployed bytes). The rebuilt tree is byte-identical to `releases/phase-16-34-gate-a/` (`diff -r`). |
| Function versions and bundles         | automation v10, matcher v18, worker v9; all 8 `ezbr_sha256` equal the values recorded as unchanged in 16.31–16.33 ✔                                                                                                                                               |
| Gate F placement                      | only in `supabase/gated-migrations/`; 31 local migration files (29 + M32 + M33) ✔                                                                                                                                                                                 |
| Window                                | 15:02 UTC: the 12:17 run was done and the next is 18:17 (plan window 13:00–17:30) ✔                                                                                                                                                                               |

## 2. Production preflight (user, manual; correction)

**Correction:** the first version of this report said the pre-install baseline and dry run were not run. That was wrong. Only the **agent's** attempt was blocked (its permission classifier refused production SQL reads at 15:02, and the agent stopped without giving the install command). **The user then completed the preflight manually before installing**, as the reviewer confirmed.

**User-run preflight, all passed:**

| Check                                     | User result                                         |
| ----------------------------------------- | --------------------------------------------------- |
| Production SQL checks                     | 7, all successful                                   |
| Migration-history fingerprint (29)        | expected value (`55e234ef8df694953c659c6297afa1b9`) |
| Job 2 command fingerprint                 | expected value (`07549bf985a3034a5ef9c645692097b6`) |
| `net.http_request_queue`                  | empty                                               |
| Running Cron job                          | none                                                |
| Automation lease                          | none                                                |
| `npx supabase db push --dry-run --linked` | exactly `20260930120000` and `20260930200000`       |

The raw outputs were given to the reviewer, not pasted into the agent session. They're recorded here as user-provided and reviewer-confirmed.

**The install itself:** `npx supabase db push --linked`. Its confirmation prompt listed exactly the same two migrations and nothing else:

```
• 20260930120000_phase_16_32_page_stage_operational_control.sql
• 20260930200000_phase_16_33_security_and_v1_correctness.sql
```

**Agent's independent post-install corroboration:**

- The first 29 history rows still give `55e234ef8df694953c659c6297afa1b9`.
- Cron has no execution between 12:17:00.34 and 18:17, and pg_net has no request between response 59 (12:17) and response 60 (18:17).
- Runs stayed at `59 0e63541b` and page attempts at `8 ac113605` through the install.
- Lease 0, no `running` run, no unfinished Cron execution.

So the install overlapped no automation, lease or queued request.

## 3. Migration history (read-only, 15:13–15:18 UTC)

| Check                                 | Result                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Total                                 | **31**, 31 distinct versions ✔                                                                                        |
| `20260930120000`                      | recorded **once**, name `phase_16_32_page_stage_operational_control`, 47 statements, statements MD5 `77727bc7…c440` ✔ |
| `20260930200000`                      | recorded **once**, name `phase_16_33_security_and_v1_correctness`, 46 statements, statements MD5 `d3ba272b…5f61` ✔    |
| Statements versus local (same method) | identical for both versions ✔                                                                                         |
| First 29 rows                         | `55e234ef8df694953c659c6297afa1b9`, the pre-install fingerprint, so no applied migration was altered ✔                |
| New 31-row fingerprint                | `f8be9553280b05ab2d26ca5d89fdb8b9`, identical locally ✔                                                               |

**Fingerprint method (now recorded):** `md5(string_agg(version||name, ',' order by version))`.

## 4. Schema integrity: installed versus reviewed local

The same catalog query (`audits/phase-16-34-gate-a1/schema-catalog-fingerprint.sql`) ran on production and on the local database (clean 31-migration state).

- **Scope:** schemas `public` and `private`, excluding extension members.
- **Definitions:** function bodies (`pg_get_functiondef`); table and view columns, types, nullability, defaults, RLS and force-RLS; constraints; indexes; triggers; policies.
- **ACLs:** for functions and relations.

| Kind        | Count | Definitions fingerprint | ACL fingerprint | Production = local |
| ----------- | ----- | ----------------------- | --------------- | ------------------ |
| functions   | 174   | `a35f5f4b…359d`         | `0cefad02…c530` | ✔                  |
| relations   | 62    | `4eb831d0…842f`         | `a11d9957…1750` | ✔                  |
| constraints | 457   | `ed11cebc…d98b`         | —               | ✔                  |
| indexes     | 154   | `1365d8a8…b7cb5d4`      | —               | ✔                  |
| triggers    | 77    | `aeb69a2e…dada`         | —               | ✔                  |
| policies    | 12    | `feee127d…46e7`         | —               | ✔                  |

**New public RPC grants** (a subset of the ACL fingerprint): every one is `SECURITY DEFINER`, with no `anon` and no PUBLIC grant.

| RPC                                                                                                         | Granted to                                               |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `consume_recall_automation_ticket`, `record_recall_automation_matching_outcome`                             | `service_role`                                           |
| `consume_cpsc_page_stage_ticket`                                                                            | `cpsc_page_worker`                                       |
| `start_cpsc_page_stage`, `stop_cpsc_page_stage`, `get_cpsc_page_stage_status`, `attest_cpsc_outside_census` | `authenticated`, gated internally by capability plus MFA |

There are 0 capabilities, so no caller can start the stage.

## 5. Page stage and scheduler isolation

| Check                           | Result                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cpsc_page_stage_control_state` | `{"state":"never_started","running":false}` ✔                                                                                                                                             |
| Control events / page ticks     | 0 / 0 ✔                                                                                                                                                                                   |
| Scheduler tickets               | 0; `scheduler_invocation_status` = `{}` ✔                                                                                                                                                 |
| Page Cron                       | none (no job name or command containing `page`) ✔                                                                                                                                         |
| Page processing                 | attempts `8 ac113605`, last claim 07:02:58.929602; work `8 4a536bb2`, 0 active leases; 34 fetches, 7 raw, revisions `27 7a34be4a`, 7 snapshots, ledgers `7 a27e8b73`: **all unchanged** ✔ |
| Worker                          | `process-cpsc-page-evidence` v9, bundle `c15d6623…f533`, `verify_jwt=true`, not redeployed ✔                                                                                              |

## 6. v1 Cron and automation

| Check                  | Result                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| Cron jobs              | exactly one: job 2 `recall-automation-every-6h`, `17 */6 * * *`, active ✔                                     |
| Job 2 command MD5      | `07549bf985a3034a5ef9c645692097b6`, unchanged: **not converted to tickets** ✔                                 |
| Executions             | last three `succeeded` (12:17, 06:17, 00:17); none after 12:30; none unfinished ✔                             |
| pg_net                 | queue 0; one response (id 59, 200, 12:17:00) ✔                                                                |
| Runs                   | `59 0e63541b` (unchanged); 0 `running`; lease 0 ✔                                                             |
| Pending / new outcomes | 0 pending; `pending_status` `{pending:0, retrying:0, exhausted:0}`; `recall_automation_matching_outcomes` 0 ✔ |
| Control                | enabled, AI on, push on, limits unchanged (`updated_at` 2026-09-16 06:16) ✔                                   |

The v1 correction is **not active yet**. It needs the release `run-recall-automation`, which A1 does not deploy. Until then, v1 runs exactly as before the install (plan §6, rehearsal S2).

## 7. Humans, review and business state

| Check                                                          | Result                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Admin capabilities / reviewer authorizations                   | 0 / 0 ✔                                                                              |
| Authorization audit / outside-census attestations (new tables) | 0 / 0 ✔                                                                              |
| Reconciliations / review ledger / decision invalidations       | 0 / 0 / 0 ✔                                                                          |
| Candidates                                                     | `18 dc2b3a0f`, unchanged ✔                                                           |
| Holds / hold resolutions (26777)                               | `1 a19900c3` / 0 ✔                                                                   |
| Observations / identities                                      | `109 34768a9f` / `38 43120649` ✔                                                     |
| Roles                                                          | 33; `cpsc_page_worker` login unchanged; `anon`/`authenticated` no login, no bypass ✔ |

## 8. Secrets

- **Vault:** names `{recall_automation_key, recall_automation_url}`. `created_at` = `updated_at` = 2026-09-16 (06:03:21 and 06:03:35). **Unchanged, and no new secret** ✔. Values were not read.
- **Edge secrets: the agent can't list them.** `supabase secrets list` returns value digests, and the agent's permission classifier blocks it as credential materialization. `db push` has no path to edge secrets.

**User's secret-metadata check (completed; reported through the reviewer).** No secret value and no individual digest was displayed.

- **Count:** 17
- **Names:** `CPSC_PAGE_DB_URL`, `CPSC_PAGE_WORKER_KEY`, `NEBIUS_API_KEY`, `NEBIUS_BASE_URL`, `NEBIUS_MODEL_ID`, `RECALL_AUTOMATION_KEY`, `RECALL_INGESTION_KEY`, `RECALL_MATCHING_KEY`, `RECALL_PUSH_DELIVERY_ENABLED`, `RECALL_PUSH_DELIVERY_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SUPABASE_JWKS`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`
- **Set fingerprint:** `38aa0e25589c46b7a553cf9349b0f2cd76805e5b0f96689029fddaec4b024cb4`

**What this establishes, and what it doesn't:**

- A1 found the expected historical count of **17**.
- **No unexpected name** is present. Every name is an application key referenced in earlier reports or a Supabase platform default, and `RECALL_MATCHING_POLICY` is absent, so the default `phase_10_guarded_v1` still applies.
- **There isn't enough historical digest evidence to prove byte-identical secret values across A1.** No earlier full-set fingerprint or per-secret digest is available (table below). A1 is **not** claimed to have left every secret value unchanged. The only historical comparison possible is the count.
- `38aa0e25…4cb4` is the **canonical baseline for every later Phase 16.34 gate**. Later checks must recompute it with the identical command the user used; the §8 command is the reference form.

| Evidence                                                                        | Status                                                                                        |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Verified historical:** secret **name count** 17                               | recorded in 16.27 (§4) and 16.28 (§1, "name set unchanged")                                   |
| **Verified historical:** `CPSC_PAGE_WORKER_KEY` digest changed at each rotation | 16.28 (09:29 baseline, boolean comparison) and 16.31 (second rotation, before 16:5x on 09-29) |
| **Missing:** the full list of secret names                                      | never written into any report (only the count and a few names in prose)                       |
| **Missing:** per-secret digests                                                 | never recorded; 16.28 §1 states that only a whole-set fingerprint existed                     |
| **Missing:** the 16.27 whole-set fingerprint value                              | the report says it was recorded, but the value isn't in the repository                        |
| **Missing:** any baseline after the 16.31 rotation                              | 16.30 and 16.32–16.34 did not list secrets                                                    |

**Baseline command** (reference form; it prints only the count, the names and one set fingerprint, never a digest):

```sh
npx supabase secrets list --project-ref cnftnulgtsraurtusnpb -o json | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
const a=JSON.parse(s).sort((x,y)=>x.name<y.name?-1:1);
const h=require("crypto").createHash("sha256");a.forEach(x=>h.update(x.name+"="+x.value+"\n"));
console.log(a.length,"names:",a.map(x=>x.name).join(","));console.log("set-fingerprint",h.digest("hex"))})'
```

**Expected from now on:** the same 17 names and set fingerprint `38aa0e25589c46b7a553cf9349b0f2cd76805e5b0f96689029fddaec4b024cb4`.

## 9. Edge functions (no deployment)

| Function                           | Version | Bundle            | Last update (UTC) |
| ---------------------------------- | ------- | ----------------- | ----------------- |
| `ingest-cpsc-recalls`              | 23      | `2b0774c5…0dc3`   | 09-27 05:36       |
| `process-recall-matches`           | 18      | `81f96b1d…308d6b` | 09-24 05:17       |
| `send-recall-notifications`        | 13      | `58b6945b…11f5`   | 09-15 10:38       |
| `run-recall-automation`            | 10      | `29aa1681…ef6c`   | 09-19 07:07       |
| `ingest-recall-source`             | 12      | `ba394992…869d`   | 09-27 19:28       |
| `ingest-recall-sources`            | 9       | `c41cb92e…aae6`   | 09-27 19:40       |
| `process-recall-matches-v2-cohort` | 8       | `682308bd…1f1e`   | 09-24 05:17       |
| `process-cpsc-page-evidence`       | 9       | `c15d6623…f533`   | 09-29 12:00       |

All are identical to the pre-install listing ✔.

## 10. Fingerprint method note: `recall_notices`

- **The difference:** the 16.34 plan recorded notices `25c937fe`. The method that reproduces every other 16.33/16.34 fingerprint (`count || left(md5(string_agg(to_jsonb(t)::text, ',' order by pk)), 8)`) gives **`90 543d1eff`**.
- **No notice changed:**
  - `max(updated_at)` = 12:17:06.33 (the 5 Health Canada bumps from run 59, already documented in 16.34 §2)
  - `max(created_at)` = 00:17:23
  - 0 rows updated after 12:30
  - neither migration alters `recall_notices`
- **Conclusion:** the plan's notice value used a different method. **New baseline for this method:** `90 543d1eff`.

## 11. Production access this gate

**The only write:** the user's `db push` (the two migrations).

**Everything else was read-only:**

- `SELECT`s (catalog, state, Vault names and timestamps)
- the function list
- per-function source downloads (15:05, and again after the 18:17 run)
- the post-run observation `SELECT`s (18:20–18:25), including a table sweep through `query_to_xml` (`count(*)` only)

No secret value, header, body or queued request was read.

**Local files added:**

| Path                                                        | Contents                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `audits/phase-16-34-gate-a1/deployed-archive/`              | the 8 archived functions, plus `deployed-archive.sha256`                  |
| `audits/phase-16-34-gate-a1/post-install-state.sql`         | the read-only verification queries (`4fac74fa…1a82`)                      |
| `audits/phase-16-34-gate-a1/schema-catalog-fingerprint.sql` | the catalog comparison (`92d72cdb…6e`)                                    |
| `audits/phase-16-34-gate-a1/deployed-archive-post-run/`     | second archive of the 8 functions after the 18:17 run, plus its `.sha256` |
| this report                                                 |                                                                           |

## 12. State after A1

**Production is in plan state "M32 + M33 with old functions" (plan §4).** It's a documented safe state, rehearsed as S2:

- the page stage is stopped
- v1 runs on the static key, with its Phase 12 semantics unchanged
- the new RPCs are present but unused

## 13. First natural v1 run after install (18:17 UTC, read-only at 18:20)

This was the deployed (old) automation v10 and matcher v18 running on the new schema.

| Check                | Result                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cron                 | job 2 18:17:00.248 → 18:17:00.357 `succeeded` ("1 row"); 0 unfinished executions ✔                                                                                                                              |
| pg_net               | response 60: `200`, not timed out, no error; queue 0 ✔                                                                                                                                                          |
| Run                  | run 60 `84dc2bc0…`, `trigger=cron`, **`success`**, 18:17:02.116 → 18:17:05.028; window 2026-09-28 → 2026-09-30 ✔                                                                                                |
| Run counters         | ingestion seen 5, unchanged 5, inserted / updated / rejected 0; affected recalls 0; candidate pairs 0; AI escalations 0; provider failures 0; alerts 0; push claimed / accepted / failed 0; `error_code` null ✔ |
| CPSC source          | `success` 18:17:03.401, fetched 0, no errors; watermark `last_publish_date` `2026-09-30` (= before, monotonic) ✔                                                                                                |
| Health Canada source | `success` 18:17:04.419, fetched 5, unchanged 5, no errors, 0 quarantined; watermark `last_updated_date` `2026-09-30` (= before, monotonic) ✔                                                                    |
| Automation watermark | `last_successful_watermark` `2026-09-30` (= before) ✔                                                                                                                                                           |
| Leases               | automation lease 0; page work 0 active leases ✔                                                                                                                                                                 |
| Pending / outcomes   | 0 pending; 0 matching outcomes (expected with the old automation and 0 affected recalls) ✔                                                                                                                      |
| Earlier runs         | the first 59 runs are still `59 0e63541b`, so history wasn't rewritten ✔                                                                                                                                        |

**Mutation sweep:** every `public`/`private` base table with a creation, update or claim timestamp was checked for rows at or after 18:00. Only four tables changed, all expected v1 writers:

| Table                              | Rows changed                       | Expected                                                 |
| ---------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| `private.recall_automation_runs`   | 1 (run 60)                         | ✔                                                        |
| `private.recall_source_sync_state` | 2 (both sources)                   | ✔                                                        |
| `private.recall_automation_state`  | 1 (watermark row)                  | ✔                                                        |
| `public.recall_notices`            | 5, **all `health_canada`** (of 49) | ✔ the known unchanged-notice `updated_at` bump (plan §2) |

- **Zero changes elsewhere:** page tables, holds, candidates, push, matches, alerts, owned products, scopes, v2 tables, leases, tickets, control events, authorization audit and attestations.
- **Notices:** `90 543d1eff` → `90 2eae2c8a`, from `updated_at` alone. `max(created_at)` is still 00:17:23.
- **New content baseline:** fingerprint excluding `updated_at` = `90 a136d5c9`. This is recorded for the next run, since no pre-run content-only value exists.

**Unchanged at 18:20:**

- attempts `8 ac113605`, work `8 4a536bb2`, revisions `27 7a34be4a`, ledgers `7 a27e8b73`
- holds `1 a19900c3`, observations `109 34768a9f`, identities `38 43120649`, candidates `18 dc2b3a0f`
- 34 fetches, 7 raw, 7 snapshots
- 0 capabilities, reviewer authorizations, reconciliations, review ledger and hold resolutions
- Vault names and timestamps
- migrations `31 f8be9553…`

**Page scheduler: still disabled.** State `never_started` / `running=false`, 0 control events, 0 page ticks, 0 tickets. The only Cron job is job 2, MD5 `07549bf9…97b6`, active.

## 14. Release-tree reconfirmation (after the 18:17 run)

- **Fresh archive:** all 8 functions were downloaded again (`--use-api`, clean per-function workdirs) into `audits/phase-16-34-gate-a1/deployed-archive-post-run/`. The hash list `8a8c51d1…6923` is **byte-identical** to the 15:05 archive.
- **Rebuild:** `node scripts/build-phase-16-34-release.mjs` prints **`releaseSha256 20fc07f08dc92c95b00c609e69e6aadc1d4d514708cb278dc09c053f2a31cec0`** (50 files, 8 edits).
- **Stored tree:** the rebuild is identical to `releases/phase-16-34-gate-a/` (`diff -r`). `MANIFEST.json` is `0f3ae1d0…d7b5`.
- **Function listing at 18:2x:** all 8 bundles unchanged. The matcher is still v18 `81f96b1d…308d6b`, `verify_jwt=false`.

**What A2 changes in the matcher.** Its release set is the same **39 files** that production bundles today. Exactly **3** differ, and each pre → post pair is in the build script's reviewed `EDITS` table:

| File                                     | Deployed (pre-16.33) | Release (reviewed 16.33) |
| ---------------------------------------- | -------------------- | ------------------------ |
| `_shared/recallMatching/orchestrator.ts` | `415dd080…8854`      | `8b044008…9a4c`          |
| `_shared/recallMatching/index.ts`        | `4ea4aab9…606c`      | `f22b4db7…9704`          |
| `process-recall-matches/legacyRun.ts`    | `78b20cb2…1dbd`      | `f1a8d047…8e5a`          |

- **Unchanged:** the other 36 files keep their deployed bytes, including `orchestratorV2.ts` and `reviewedCriteriaV2.ts`.
- **Compatibility:** the old automation v10 ignores the new response fields (rehearsal S3a).

## 15. A2 instructions: `process-recall-matches` only (NOT executed; separate approval required)

**Scope:** one function, `process-recall-matches`, from the reviewed release tree only. `run-recall-automation` is **not** part of this step. There's no Cron, secret, migration or page change.

**Window:** between natural runs. The next run is at 00:17 UTC on 2026-10-01, so run A2 between **19:00 and 23:30 UTC**, or in a later equivalent window: at least 30 min after a :17 run and at least 45 min before the next.

**Step 1: preflight (read-only; all must pass).**

- Migrations `31 f8be9553280b05ab2d26ca5d89fdb8b9`.
- Job 2 is the only job, MD5 `07549bf985a3034a5ef9c645692097b6`, active.
- `net.http_request_queue` 0; no unfinished `cron.job_run_details`; `recall_automation_lease` 0; no `running` run; the last run is `success`.
- Stage `never_started`; 0 tickets.
- Function list: matcher **v18 `81f96b1d…308d6b`**, automation v10 `29aa1681…ef6c`, worker v9 `c15d6623…f533`; all 8 bundles as in §9.
- Edge secrets (user-run, §8 command): 17, same names, set fingerprint `38aa0e25…4cb4`. No values or digests are displayed.

**Step 2: re-verify the release tree (local plus read-only download).** Download all 8 functions into a new directory:

```sh
A=audits/phase-16-34-gate-a2/pre-deploy-archive
for s in ingest-cpsc-recalls process-recall-matches send-recall-notifications run-recall-automation ingest-recall-source ingest-recall-sources process-recall-matches-v2-cohort process-cpsc-page-evidence; do
  mkdir -p $A/$s && npx supabase functions download $s --project-ref cnftnulgtsraurtusnpb --use-api --workdir $A/$s
done
OUT="$(mktemp -d)/release"
node scripts/build-phase-16-34-release.mjs $A "$OUT"
diff -r "$OUT" releases/phase-16-34-gate-a && echo "release tree identical"
shasum -a 256 releases/phase-16-34-gate-a/MANIFEST.json
```

It must print `releaseSha256 20fc07f08dc92c95b00c609e69e6aadc1d4d514708cb278dc09c053f2a31cec0`, the tree must be identical, and the manifest must be `0f3ae1d0…d7b5`. Otherwise **STOP**.

**Step 3: deploy (the user runs this explicitly).**

```sh
npx supabase functions deploy process-recall-matches \
  --project-ref cnftnulgtsraurtusnpb \
  --workdir releases/phase-16-34-gate-a \
  --use-api
```

- **The function name is mandatory.** Without it, the CLI deploys **every** function in the workdir, including `run-recall-automation`.
- **Never pass `--prune`, and never pass `--no-verify-jwt`.** `releases/phase-16-34-gate-a/supabase/config.toml` already sets `[functions.process-recall-matches] verify_jwt = false`.
- **`--workdir` is used exactly as given** (CLI 2.118.0: "no ancestor directory search"), so nothing is read from the worktree's `supabase/functions`.

**Step 4: post-deploy verification (read-only).**

1. **Function listing:**
   - `process-recall-matches` version incremented, **new** `ezbr_sha256`, `verify_jwt=false`
   - the other **7** functions keep their versions' bundles exactly as in §9 (the platform has been seen to bump version metadata, so bundles are authoritative)
2. **Download the deployed matcher and compare it with the manifest:**

   ```sh
   V=audits/phase-16-34-gate-a2/post-deploy/process-recall-matches
   mkdir -p $V && npx supabase functions download process-recall-matches --project-ref cnftnulgtsraurtusnpb --use-api --workdir $V
   node -e 'const fs=require("fs"),c=require("crypto"),m=require("./releases/phase-16-34-gate-a/MANIFEST.json");const V=process.argv[1];const want=m.functions["process-recall-matches"];let bad=[];for(const f of want){const h=c.createHash("sha256").update(fs.readFileSync(V+"/"+f)).digest("hex");if(h!==m.files[f].sha256)bad.push(f)}const got=require("child_process").execSync("cd "+V+" && find supabase/functions -type f").toString().trim().split("\n").sort();const extra=got.filter(f=>!want.includes(f));console.log(JSON.stringify({files:got.length,expected:want.length,extra,mismatch:bad}))' $V
   ```

   **Required output:** `{"files":39,"expected":39,"extra":[],"mismatch":[]}`. Run against today's deployed matcher, this snippet prints exactly the 3 files in §14, as tested at 18:2x.

3. **Database unchanged by the deploy:** same migrations, job 2 MD5, queue 0, lease 0, stage `never_started`, 0 tickets, and every §13 fingerprint.
4. **Edge secrets:** 17, same names, set fingerprint `38aa0e25…4cb4` (user-run, §8).

**Step 5: observe the next natural run (00:17), read-only.** This is the new matcher with the old automation v10 (S3a).

- `cron.job_run_details` shows `succeeded`, with pg_net 200
- run `success`, or `partial_success` / `source_partial_failure` only if a source is down
- both source watermarks ≥ before
- lease released; pending 0 unless recalls were affected
- no `push_deliveries`, alerts or matches unless there are real alerts
- the page stage is still stopped
- no row in `recall_automation_matching_outcomes`, because the old automation doesn't call the new RPC

**Rollback (only if steps 4–5 fail).** Redeploy the archived v18 bytes:

```sh
npx supabase functions deploy process-recall-matches \
  --project-ref cnftnulgtsraurtusnpb \
  --workdir audits/phase-16-34-gate-a1/deployed-archive-post-run/process-recall-matches \
  --use-api --no-verify-jwt
```

- **`--no-verify-jwt` is required here** because the archive has no `config.toml`. Without it, the function comes back with JWT verification on and rejects the automation's key-authenticated calls.
- After the rollback, the downloaded files must equal the archive (`deployed-archive-post-run.sha256`, matcher entries).
- The old matcher is compatible with the installed schema (S2).

**STOP after step 5. Deploying `run-recall-automation` is a separate gate.**
