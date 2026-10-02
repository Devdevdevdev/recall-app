# Phase 16.34 — controlled v1 correction and credential-mitigation installation plan

Continuation of [Phase 16.33](phase-16-33-security-and-v1-correctness-stop-report.md) (accepted YELLOW-safe). The 16.32 and 16.33 reports were read in full.

**Classification: YELLOW-safe, installation-ready.**

- **Gates A–F** are specified with exact commands, preconditions, pass criteria and rollback.
- **Rehearsal:** the full sequence was rehearsed locally in its intended order, starting from a database whose migration history is byte-equivalent to production: **29/29 checks**.
- **Quality gates:** all pass.
- **Production:** unchanged.

It stays YELLOW for one reason only: the permanent fix for the `pg_net` grants belongs to Supabase. A support packet is ready (`docs/phase-16-34-supabase-support-packet.md`). Tickets are the interim mitigation; they do not fix the queue's integrity or availability.

**Recommendation:** approve **Gate A** alone.

**Not done:** no production migration, deploy, Cron change, secret change, page POST, scheduling, reconciliation, review, v2 activity, or commit or push.

---

## 1. Worktree and artifact hashes

- **Status:** 225 entries at the start (45 tracked modifications, 180 untracked), 230 now plus this report. New: two scripts, `releases/`, `supabase/gated-migrations/`, the support packet. `tsconfig.json` was edited once more.
- **Every 16.32 and 16.33 artifact** is byte-identical to its recorded hash:

| Artifact                                           | SHA-256                          |
| -------------------------------------------------- | -------------------------------- |
| migration 16.32 `20260930120000_…`                 | `dd3a40e1…9cdd`                  |
| migration 16.33 `20260930200000_…`                 | `77416680…a018`                  |
| install check `phase-16-33-install.sql`            | `54b7fedf…ec29`                  |
| worker source set (worktree, not deployed)         | `276d90f9…db91`                  |
| 16.32 and 16.33 reports                            | `24a0cf64…275e`, `abb40bd4…081e` |
| manifest `docs/phase-16-15-backfill-manifest.json` | `e3ab192c…d9ed`                  |

- **Frozen artifacts:** unchanged. Freeze guards 9.1, 15 and 16 all report `frozen=true`. The phase-16 benchmark tree is 16/16 byte-identical after the runner's known result-file churn was restored.

**Modified test suites** (all edits made in 16.33 and listed in its §14; no suite edited in 16.34):

- 16.10, 16.11, 16.12, 16.13, 16.16, 16.23, 16.24, 16.26, 16.29 and 16.32
- remote 16.17, remote 16.26, remote production compatibility
- `tests/phase-12-automation.test.mjs` and the timeout harness

**Deployed versus local (new):** each deployed function was downloaded read-only through the Management API (`supabase functions download <slug> --use-api`, one isolated workdir per function) and compared file by file:

| Function (version)                             | Result                                                                                                                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-recall-automation` (v10)                  | deployed = the **pre-16.33 source, byte for byte** (5 files); `request.ts` identical                                                                                                                                                                |
| `process-cpsc-page-evidence` (v9)              | deployed = the pre-16.33 entry (the 16.32 worker set `9e6e318e…`)                                                                                                                                                                                   |
| `process-recall-matches` (v18)                 | the 16.33 files are byte-identical to pre-16.33. **But `orchestratorV2.ts` and `reviewedCriteriaV2.ts` are older in production** than in the worktree, which holds the never-deployed 16.12 rule-set versions (dormant under `phase_10_guarded_v1`) |
| `ingest-*`, `process-recall-matches-v2-cohort` | deployed shared files differ from the worktree (inherited, not part of this installation)                                                                                                                                                           |
| `send-recall-notifications`                    | identical                                                                                                                                                                                                                                           |

**Production functions modified by this installation:** exactly `process-recall-matches` and `run-recall-automation`.

**Divergent shared copies:** deployed functions carry **different copies of the same shared modules**. For example, `ingest-recall-source` bundles a newer `healthCanada/client.ts` and `reviewedCriteriaV2.ts` than its siblings. Deploying from the shared worktree would silently change unrelated code, so each function must be deployed only from its own verified tree.

## 2. Production baseline (read-only, 2026-09-30 12:18–12:25 UTC)

| Check                 | Value                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations            | 29; last `20260929110000`; history fingerprint `md5(version‖name)` = `55e234ef…a1b9`                                                                                                        |
| Functions             | 8, versions and bundles as in 16.33                                                                                                                                                         |
| Cron                  | job 2 only, `17 */6 * * *`, active, command MD5 `07549bf9…097b6`; last 3 executions `succeeded` (12:17, 06:17, 00:17); pg_net queue 0                                                       |
| v1                    | 59 runs (`59 0e63541b`); 12:17 `success` (0 affected); 0 leases, 0 pending, 0 pair leases; control enabled, AI on, push on                                                                  |
| Sources               | CPSC `success` 12:17:04 (watermark `2026-09-30`); Health Canada `success` 12:17:06 (5 fetched, 5 unchanged; watermark `2026-09-30`)                                                         |
| Page stage            | attempts `8 ac113605` (last claim 07:02:58.929), work `8 4a536bb2`, 0 active leases; 34 fetches, 7 raw, revisions `27 7a34be4a`, 7 snapshots, ledgers `7 a27e8b73`                          |
| Holds and quarantines | holds `1 a19900c3` (26777), 0 resolutions; observations `109 34768a9f` (100 resolved, 9 quarantined); eligibility 31 eligible, 1 `human_reconciliation_required`, 6 `unresolved_quarantine` |
| Human and review      | 0 capabilities, 0 reviewer authorizations, 0 reconciliations, review ledger 0, reviewed criteria 0; candidates `18 dc2b3a0f`, all `unreviewed`                                              |
| v2 and business       | v2 evaluations, rule sets and criteria 0; owned products, matches, alerts and push deliveries 0                                                                                             |
| Vault (names only)    | `recall_automation_key`, `recall_automation_url`                                                                                                                                            |

**Natural activity since 16.33 (separated):**

- The 12:17 v1 run added run 59.
- Its Health Canada step reset `updated_at` on 5 HC notices that it reported as _unchanged_ (notices `bb3ac8e9` → `25c937fe`). That makes v1 ingestion another `updated_at` writer. It is harmless under the 16.33 correction: a stale pair is retried.

## 3. Supabase security evidence packet

**The packet:** `docs/phase-16-34-supabase-support-packet.md`. It was written for Supabase support and contains no secret, header or body.

**Reconfirmed privileges (production):**

| Role               | Login   | Queue S/I/U/D/T | Response S/D | `http_post` / `http_get` | `worker_restart` | Vault read |
| ------------------ | ------- | --------------- | ------------ | ------------------------ | ---------------- | ---------- |
| `anon`             | no      | all             | yes/yes      | yes                      | yes (PUBLIC)     | no         |
| `authenticated`    | no      | all             | yes/yes      | yes                      | yes              | no         |
| `service_role`     | no      | all             | yes/yes      | yes                      | yes              | **yes**    |
| `cpsc_page_worker` | **yes** | all             | yes/yes      | yes                      | yes              | no         |

**ACLs:**

- `net.http_request_queue` and `net._http_response`: `=arwdDxtm/supabase_admin` (PUBLIC)
- the sequence: `=rwU`
- `net.http_*`, `net.worker_restart` and `net.wake`: ACL NULL (PUBLIC EXECUTE)

**Ownership and settings:**

- pg_net 0.20.4 is owned by `supabase_admin` on Postgres 17.6.
- `ttl` 6 h, `batch_size` 200.

**Database access versus API exposure:**

- The grants give real **database** access to every role.
- **API exposure: none found.** `net` is not an exposed schema, and the only function referencing pg_net or Vault is the private, non-API installer.
- The practical path is any **database login**, chiefly `cpsc_page_worker`, or anyone who obtains a service key.

**Why migrations cannot fix it:** the grantor is `supabase_admin` and `postgres` has no grant option. `REVOKE` returns `WARNING: no privileges could be revoked` (16.33 pgTAP).

**Requested:** revoke PUBLIC on the three objects and on EXECUTE, keeping `postgres`. Or confirm that reinstalling the extension is supported and safe alongside a dependent Cron job, or recommend a supported scheduler pattern.

## 4. Migration dependency graph

```
Phase 12 (applied) ─┬─> M32  20260930120000  page-stage control (stopped by default)
                    │        └─> M33  20260930200000  v1 outcome RPC + retry columns (Phase 12 objects only)
                    │                                 tickets (replaces the M32 tick and installer)
                    │                                 MFA gate · outside-census gate
                    └──────────────> Gate F staged migration 20261001090000 (needs M33's recall_automation_tick)
```

| Dependency    | Why                                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M33 → M32     | M33 `create or replace`s `cpsc_page_stage_tick` and `install_cpsc_page_stage_cron`, and reads `cpsc_page_stage_control_state` and `cpsc_page_stage_ticks` |
| M33 (v1 part) | depends only on Phase 12 tables and RPCs                                                                                                                  |
| Gate F        | depends on M33's `private.recall_automation_tick`                                                                                                         |

**Placement:** the Gate F migration is staged **outside** `supabase/migrations` (in `supabase/gated-migrations/`), so `db push` at Gate A cannot apply it.

**Intermediate states, each safe:**

| State                        | Safety                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| M32 only                     | stage stopped; v1 untouched (rehearsal S1)                                                                       |
| M32 + M33 with old functions | old RPC and pending list keep Phase 12 semantics while nothing is exhausted, which only the new RPC can set (S2) |

## 5. Function dependency graph

| Function                                                                      | Deploy?               | Requires                                                                              | Compatible with                                                                                               |
| ----------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `process-recall-matches` (release)                                            | **Gate A**            | no new RPC                                                                            | old automation ignores the new response fields (S3a)                                                          |
| `run-recall-automation` (release)                                             | **Gate A, after M33** | `record_recall_automation_matching_outcome`, `consume_recall_automation_ticket` (M33) | old or new matcher (the old one falls back to keeping the batch pending); static key **and** tickets accepted |
| `ingest-recall-sources` → `ingest-recall-source`, `send-recall-notifications` | no                    | —                                                                                     | unchanged children                                                                                            |
| `process-cpsc-page-evidence` v9                                               | **no**                | —                                                                                     | M32 claim returns 0 while stopped, so a key holder can claim nothing                                          |
| `process-recall-matches-v2-cohort`                                            | no                    | —                                                                                     | dormant v2 code                                                                                               |

**Order:**

1. M32
2. M33
3. `process-recall-matches`
4. `run-recall-automation`
5. job 2 cutover (Gate C)
6. key retirement (Gate E)
7. installer retirement and key unset (Gate F)

**The one unsafe order:** a cutover before step 4. It fails **closed**: 401, no run (rehearsal S2x), and it is recoverable.

## 6. v1 installation procedure (smallest safe change)

**Release tree** `releases/phase-16-34-gate-a/`, built by `scripts/build-phase-16-34-release.mjs` from the per-function downloads. Release SHA `20fc07f0…ec0` (manifest `0f3ae1d0…d7b5`).

- **Contents:** 50 files, being the deployed bytes of both functions plus **exactly the 8 reviewed 16.33 edits**:
  - `recallMatching/orchestrator.ts`, `index.ts`, `legacyRun.ts`
  - `automation/orchestrator.ts`, `index.ts`
  - `run-recall-automation/children.ts`, `store.ts`, `index.ts`
- **Also included:** 4 type-only modules (runtime-inert and erased at bundle) and `config.toml` (for `verify_jwt=false`).
- **Deliberately kept at their deployed bytes:** `orchestratorV2.ts` and `reviewedCriteriaV2.ts`.
- **Refusal rules:** the script refuses to build if:
  - a deployed copy of an edited file is not the reviewed pre-16.33 source
  - a worktree edited file is not the reviewed 16.33 source
  - the two functions carry conflicting copies of a shared file
  - any reviewed edit is missing

  Every other file keeps its deployed bytes.

- **Type check:** `deno check` on both release entrypoints exits 0.

**Must be installed together:**

- M32 and M33 (one `db push`)
- then both release functions

The correction is active only once `run-recall-automation` is deployed. Between the migrations and that deploy, v1 runs exactly as today (defect included), with nothing lost relative to today.

**Guarantees** (tests from 16.33, re-run here):

| Guarantee                                                       | Evidence                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Unresolved work never disappears; stale pairs stay pending      | pgTAP 237, harness 20/20                                                      |
| Exhaustion never deletes (explicit `exhausted_at`, daily retry) | pgTAP, harness                                                                |
| Retry state survives process termination                        | harness                                                                       |
| New authoritative data re-arms                                  | pgTAP                                                                         |
| Results stay idempotent                                         | harness: `unchanged`, no duplicate match or alert                             |
| Existing matching unchanged                                     | same decisions and fingerprints; frozen benchmarks; deterministic v2 0 unsafe |

## 7. Ticket-security assessment

| Requirement                       | Status     | Evidence                                                                                                                                                                                                                                                           |
| --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 120 s expiry                      | ✔          | `expired` (pgTAP)                                                                                                                                                                                                                                                  |
| Single successful consumption     | ✔          | `replayed` (pgTAP)                                                                                                                                                                                                                                                 |
| Concurrent consumption atomic     | ✔          | two sessions race: exactly one `accepted`, one `replayed` (rehearsal S5)                                                                                                                                                                                           |
| Fixed authorized action           | ✔          | the v1 ticket always runs `trigger:'cron'` with DB control limits; **a thief's body (`manual`, `maxRecalls:7`, `maxAiEscalations:5`) was ignored** (S5)                                                                                                            |
| Fixed destination / no caller URL | ✔ at issue | the tick takes no arguments. The URL comes from Vault and must match the pinned `run-recall-automation` pattern; production's URL matches and is this project's (boolean check, value not read). **After issue, any DB login can rewrite the queued URL** (pg_net) |
| No privilege escalation           | ✔          | ticks and cutover are owner-only; consumers are service_role (v1) or the worker (page); tickets cannot be minted by other roles (pgTAP)                                                                                                                            |
| Replay rejected, and counted      | ✔          | `rejected_attempts` (pgTAP)                                                                                                                                                                                                                                        |
| Disabled stage overrides          | ✔          | page: `stage_not_running`; v1: disabled control yields `skipped_disabled` (16.33 e2e)                                                                                                                                                                              |

**Theft before legitimate consumption** (S5, simulated: a queue reader deletes the request and uses the ticket):

- The thief can trigger **only the same bounded cron run, once, within 120 s**.
- The legitimate request never arrives, or arrives later and gets 401.

**Detection query:** consumed tickets whose own `request_id` has no 200 response.

```sql
select k.id from private.scheduler_invocation_tickets k
where k.consumed_at is not null and not exists (select 1 from net._http_response r
  where r.id = k.request_id and r.status_code = 200);
```

A legitimate run that exceeds the 30 s pg_net timeout also appears here (`timed_out`, no status). Production runs take 5–23 s, so check the run row before treating a hit as theft.

**Remaining pg_net risks (not solved by tickets):**

- redirection or rewriting of queued requests
- deletion or `TRUNCATE` (missed runs; detectable as expired, unconsumed tickets)
- response reads (aggregate counts only)
- `net.worker_restart()` by any login (delays)
- arbitrary outbound HTTP from the database

**Tickets are an interim credential mitigation, not a fix for the queue permissions.**

## 8. Credential-cutover procedure (design)

| Question                                         | Answer                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which functions accept tickets                   | `run-recall-automation` (release, Gate A). The page worker is not deployed.                                                                                                                                                               |
| Which job changes                                | job 2 only, command only: `private.convert_recall_automation_cron_to_tickets()` keeps jobid, schedule and active (S4)                                                                                                                     |
| When legacy authentication can be disabled       | after Gate D (≥ 2 verified ticket runs): Gate E rotates the key, Gate F unsets it                                                                                                                                                         |
| How mixed-version failure is avoided             | cut over only after `run-recall-automation` (release) is verified deployed. The reverse order fails closed (401, no run) and is recoverable (S2x)                                                                                         |
| Detecting queued legacy requests                 | before Gate C and E: `net.http_request_queue` count 0; no running entry in `cron.job_run_details`; `recall_automation_lease` 0. Headers are never read.                                                                                   |
| In-flight requests                               | the key is checked at request start, so a run already started completes. Cut over only between runs.                                                                                                                                      |
| Recovering a failed cutover (before Gate E only) | `select private.install_recall_automation_cron(); select private.set_recall_automation_cron_active(true);` restores the **exact** Phase 12 command (MD5 `07549bf9…`, S2x). This reuses the still-current key, not a restored retired one. |
| When the old key may be rotated                  | after Gate D. Job 2 no longer reads Vault and the new key is never stored in Vault, so **no scheduled invocation can expose the replacement**.                                                                                            |

## 9. Supervised verification plan

**Read-only unless stated.**

**After Gate A (Gate B):**

- The rollback-only suites pass:
  - install check 22
  - production compatibility 89
  - remote 16.26 172
  - remote 16.17 34
- At the next natural :17 run (key-based), all of the following hold:
  - `cron.job_run_details` shows `succeeded`
  - run `success`, or `partial_success` / `source_partial_failure` if a source is down
  - the watermark is ≥ the previous value
  - both sources `success`
  - lease released
  - if any recall was affected: `recall_automation_matching_outcomes` has one row per pending recall and the pending rows are gone
  - `push_deliveries` changes only with real alerts (0 expected)

**After Gate C (Gate D):**

- The cutover's supervised tick (Gate C) and the next natural runs each show:
  - a ticket row `consumed_by=run-recall-automation` within seconds
  - `net._http_response` 200 for its request
  - run `success`
  - `rejected_attempts` = 0
  - the theft query (§7) empty
- **Rollback-only header probe** (the only production write in D; nothing is sent because pg_net only sends on commit):

```sql
begin;
select private.recall_automation_tick();   -- note requestId
select array_agg(k order by k) from net.http_request_queue q, jsonb_object_keys(q.headers) k
  where q.id = <requestId>;                -- expect {content-type,x-recall-automation-ticket}
rollback;
```

- **No test data:** no artificial products or recalls are created in production. The per-recall path is observed on natural affected recalls. Its logic is proven locally (harness 20/20).

## 10. Rollback and recovery

| Failure                               | Recovery (forward-only; never restore a retired credential)                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Migration install fails               | each migration is one transaction and a failed one rolls back. M32-only is safe (§4). Fix forward with a corrective migration; no schema rollback.                                                           |
| Function deploy fails                 | the previous version keeps serving. **Before Gate A**, archive the current deployed trees (per-function `download --use-api`, hashes recorded). To revert, redeploy the archived tree with the same command. |
| Ticket generation fails (tick raises) | `cron.job_run_details` shows `failed` and no run happens; the pending work is kept. Before Gate E: restore the Phase 12 command (§8). After: fix the Vault URL (owner) or fix forward.                       |
| Failed cutover or 401                 | §8 recovery before Gate E. After Gate E: redeploy the release automation. The static-key command no longer exists because the Vault key is gone and the installer fails closed (S6).                         |
| Unexpected authentication rejection   | check the ticket row (`rejected_attempts`, `consumer`) and the response. A theft indicator means an incident, and the page worker login is locked (Gate F4).                                                 |
| v1 matching regression                | redeploy the archived `run-recall-automation` and `process-recall-matches`. The old RPC is still present, so it works on the 16.33 schema (S2).                                                              |
| Repeated stale work                   | observable in `recall_automation_pending_status` (`retrying`, reasons). Exhaustion after 8 cycles is explicit and retried daily. Find the writer (page stage stopped; v1 HC touches).                        |
| Source outage                         | unchanged Phase 12/14 behaviour: `partial_success` / `source_partial_failure`, the watermark does not advance for the failed source, and pending work is kept.                                               |

## 11. Scheduler isolation

- **The page scheduler stays disabled.** After M32, the stage is `never_started`, so no claim is possible by anyone, even with `CPSC_PAGE_WORKER_KEY`. That is stricter than today, where production's 16.29 claim has no kill switch.
- **Not created:** no page Cron, no page Vault endpoint, no page worker deploy (v9 stays).
- **Not done:** no approval of the 18 candidates for 26773, no reconciliation of 26777.
- **Recommended additional lock (Gate F4):** `alter role cpsc_page_worker password null`. That login is the most realistic reader of the pg_net queue, and no page work is planned. It is reversible later with a new password and edge secret.

## 12. Human authorization preparation

Unchanged from 16.33 §12. No capability is assigned in any gate.

**Prerequisites:**

- a real Auth account
- **hosted TOTP enabled** (dashboard; external action)
- `auth.mfa.enroll` / `challenge` / `verify` to reach an aal2 session

**Server verification (DB):**

- the `aal2` claim
- a live `auth.sessions` row
- a verified factor
- an MFA step at most 12 h old

**Grant:** the owner runs SQL for one capability, with `authorized_by` and a reason. The audit row is automatic, and revocation is one-way:

```sql
-- template only; not executed
insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, authorized_by, reason)
values ('<user uuid>', 'operational_scheduler_control', now(), '<owner uuid>', '<reason>');
update private.cpsc_admin_capabilities set revoked_at = now()
where user_id = '<user uuid>' and capability = '<capability>' and revoked_at is null;
```

Criterion reviewers use `cpsc_reviewer_authorizations` the same way.

## 13. Negative-evidence regression

The 16.33 suite re-ran: 237/237 inside 2383.

- **Description:** restrictions are censused.
- **Remedy, sold-at, linked documents:** these keep `complete=false` until a reviewer with MFA attests to the exact section hash. Wrong hash, operator attesting, aal1 reviewer, forged owner insert and revoked reviewer are all refused.
- **Staleness fails closed:** expiry of at most 30 days, a new revision, or changed text withdraws the attestation.
- **Production:** 0 reviewed criteria and 0 attestations, so no negative evidence can be served.

## 14. Local rehearsal results

`scripts/rehearse-phase-16-34-installation.mjs` (`9bae3df7…2be`): **29/29**.

- **Deployed bytes:** it serves the _deployed_ function bytes before Gate A and the _release tree_ after.
- **Real v1 command:** it fires the real job 2 command through the real pg_net and gateway.
- **Ingestion stub:** the ingestion chain is a contract stub (§18), so it is hermetic, with no external or paid calls.

| State             | Checks                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0                | local history = production (29, fingerprint `55e234ef…`); **the Phase 12 installer reproduces production job 2's command MD5 `07549bf9…`**; deployed v1 runs                            |
| S1 (M32)          | stage `never_started`, no job; v1 unchanged                                                                                                                                             |
| S2 (M33 via CLI)  | 31 migrations; job 2 untouched; deployed v1 runs; the old path acknowledges 3 pending recalls; no outcome rows                                                                          |
| S2x               | cutover with the old automation gives **401 and no run**; recovery restores the exact command and active flag; the refused ticket stays unconsumed                                      |
| S3a               | new matcher with old automation runs                                                                                                                                                    |
| S3b (Gate A done) | release v1 on the static key records **3 per-recall outcomes**; watermark monotonic                                                                                                     |
| S4 (Gate C)       | only the command changes; the ticket run succeeds and is consumed once                                                                                                                  |
| S5 (Gate D)       | new requests carry only `content-type` and the ticket (rollback, nothing sent); concurrent consumers split 1 / 1; a stolen ticket only yields the cron-bounded run; theft is detectable |
| S6 (Gate E)       | ticket runs unaffected; the exposed key gets 401; the installer can no longer re-add a key                                                                                              |
| S7 (Gate F)       | the retired installer recreates the ticket command (inactive); ticket runs work with the key unset; every static-key call gets 401; no page attempt                                     |

**Quality gates** (clean reset, 31 migrations):

| Gate                                             | Result                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| pgTAP                                            | **2383/2383**, 23 files                                              |
| Install check (rehearsed)                        | 22/22                                                                |
| Node                                             | **410/410**                                                          |
| Deno check (worktree and release)                | exit 0                                                               |
| Deno test                                        | 6/6                                                                  |
| Expo `tsc`                                       | 0 (`releases/**` excluded, like the other Deno trees)                |
| DB lint                                          | 0                                                                    |
| v1 concurrency harness                           | **20/20**                                                            |
| Ticket e2e                                       | **10/10**                                                            |
| Backfill                                         | **26/26**, digests `ea00243e…` / `1406161a…`, remote-safe 89/89      |
| Timeout harness                                  | `57014` in 4.05 s, rollback 0, lease recovered, revoked login denied |
| Freeze guards                                    | `frozen=true` ×3                                                     |
| Deterministic v2                                 | **0 unsafe** (development, holdout, stress)                          |
| v2.1 safety                                      | 0 unsafe, 66 needs-review, **0 provider calls**                      |
| Secret, whitespace, Prettier, `git diff --check` | clean                                                                |

## 15. Final production read-only check (12:55 UTC)

- **Migrations:** 29, fingerprint `55e234ef…`, no 16.32 or 16.33 object.
- **Functions:** versions and bundles unchanged.
- **Cron:** job 2 unchanged (`07549bf9…`, active); pg_net queue 0.
- **Page worker:** unscheduled. Last claim 07:02:58.929, attempts `8 ac113605`, work `8 4a536bb2`; edge logs since 09:12:30 show **no page-worker path**.
- **26777:** hold `1 a19900c3`, 0 resolutions.
- **Candidates:** `18 dc2b3a0f`, all unreviewed.
- **Humans:** 0 capabilities, reviewers or reconciliations.
- **v2:** 0.
- **Natural v1 activity only:** the 12:17 run (runs `59 0e63541b`; its REST RPCs are the only API traffic) and 5 Health Canada `updated_at` bumps. Every other fingerprint equals the 12:18 preflight.

**Production access this phase:**

- `SELECT` queries (catalog, state, Vault **names**)
- one boolean pattern check on `recall_automation_url` (value not returned)
- function list, logs, advisors
- read-only source downloads

## 16. Exact Gate A instructions (install; no Cron change)

**Approval:** separate reviewer approval required.

**Window:** start ≥ 30 min after a :17 run completes and finish ≥ 30 min before the next (for example between 13:00 and 17:30 UTC).

1. **Freeze check (read-only):**
   - migration count 29, fingerprint `55e234ef8df694953c659c6297afa1b9`
   - job 2 MD5 `07549bf985a3034a5ef9c645692097b6`
   - `net.http_request_queue` 0, `recall_automation_lease` 0, no `running` job execution
   - function versions: automation v10, matcher v18, worker v9
2. **Archive and re-verify production code** (read-only). For each of the 8 functions:
   `npx supabase functions download <slug> --project-ref cnftnulgtsraurtusnpb --use-api --workdir <archive>/<slug>`.
   Then:
   `node scripts/build-phase-16-34-release.mjs <archive> <fresh-dir>`. It must print `releaseSha256 20fc07f08dc92c95b00c609e69e6aadc1d4d514708cb278dc09c053f2a31cec0`, which proves production has not changed since this plan.
3. **Re-verify local hashes:**
   - M32 `dd3a40e1…9cdd`, M33 `77416680…a018`
   - `releases/phase-16-34-gate-a/MANIFEST.json` `0f3ae1d0…d7b5`
   - Gate F file present **only** in `supabase/gated-migrations/`
4. **Dry run:** `npx supabase db push --dry-run --linked` must list exactly `20260930120000` and `20260930200000`.
5. **The user runs** `npx supabase db push --linked`.
6. **Read-only checks:**
   - 31 migrations
   - `cpsc_page_stage_control_state = never_started`
   - job 2 MD5 unchanged
   - no page job
   - no new Vault secret
7. **Deploy the matcher:**
   `npx supabase functions deploy process-recall-matches --project-ref cnftnulgtsraurtusnpb --workdir releases/phase-16-34-gate-a --use-api`
   - **Never pass `--prune`.**
   - Then download it again (`--use-api`) and compare every bundled file with the manifest.
8. **Deploy the automation** the same way (`run-recall-automation`) and verify it the same way.
9. **Stop.** Gate A passes when steps 4–8 match exactly. Cron is unchanged and v1 keeps running on its key.

## 17. Exact Gates B–F

**Every production write below requires its own approval. A failed gate stops the sequence.**

**Gate B — validate (rollback-only plus observation):**

- `npm run test:remote-pgtap -- --file` for each of:
  - `supabase/remote-install-checks/phase-16-33-install.sql` (22)
  - `supabase/tests/remote/phase-16-production-compatibility.sql` (89)
  - `supabase/tests/remote/phase-16-26-page-failure-evidence.sql` (172)
  - `supabase/tests/remote/phase-16-17-watermark-and-retention.sql` (34)
- Then observe one natural :17 run per §9.

**Gate C — cutover:**

- **Preconditions:**
  - Gate B passed
  - between runs (≥ 10 min after completion, ≥ 30 min before the next)
  - queue 0, lease 0
  - the boolean URL pin check is still true
- **Steps:**
  1. `select private.convert_recall_automation_cron_to_tickets();` (owner)
  2. read-only: same jobid, schedule and active flag; command `select private.recall_automation_tick();`
  3. **one supervised run:** `select private.recall_automation_tick();`
  4. verify per §9
- **On any failure:** §8 recovery. Stop.

**Gate D — verify:**

- Two consecutive natural ticket runs pass §9.
- The rollback-only header probe passes.
- The theft query is empty.
- No 401 is recorded for a scheduled request.

**Gate E — retire the exposed key:**

- **Preconditions:**
  - Gate D passed
  - job 2 on tickets for ≥ 2 runs
  - queue 0 and lease 0 at the moment of change
- **Steps:**
  1. rotate the edge secret without displaying it:
     `npx supabase secrets set --project-ref cnftnulgtsraurtusnpb --env-file <(printf 'RECALL_AUTOMATION_KEY=%s\n' "$(openssl rand -hex 32)")`
  2. `delete from vault.secrets where name = 'recall_automation_key';` (owner)
  3. read-only: Vault names = `{recall_automation_url}`; the next natural ticket run succeeds
  4. `private.install_recall_automation_cron()` must now **fail**. Do not run it in production; this was proven in S6.

**Gate F — revoke obsolete paths:**

1. **Retire the key-based installer:** copy `supabase/gated-migrations/20261001090000_phase_16_34_gate_f_retire_v1_key_installer.sql` into `supabase/migrations/`. The dry run must list only it. Then `db push`.
2. **Remove the static path entirely:** `npx supabase secrets unset RECALL_AUTOMATION_KEY --project-ref cnftnulgtsraurtusnpb`. Manual runs become owner `select private.recall_automation_tick();`.
3. **Retire the page-worker invocation key** (optional): `npx supabase secrets unset CPSC_PAGE_WORKER_KEY …`.
4. **Recommended:** `alter role cpsc_page_worker password null;` to remove the most realistic pg_net queue reader.
5. **Not possible for us:** revoking PUBLIC on `net.*` (Supabase support, §3).

## 18. Remaining risks

| Risk                                                                                     | Status                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pg_net PUBLIC grants: integrity, deletion, worker restart, outbound HTTP, response reads | **open; Supabase** (packet ready). Unattended **page** scheduling must not be enabled until resolved or explicitly accepted.                                                                                   |
| v1 static key exposed every 6 h until Gate C, and valid until Gate E                     | open, bounded by the gates                                                                                                                                                                                     |
| `service_role` can read Vault and change its URL                                         | platform grant; the URL pattern is pinned. Service keys are server-side only.                                                                                                                                  |
| Ticket theft or suppression by any DB login                                              | detectable (§7). The impact is the same bounded run or a missed run.                                                                                                                                           |
| Divergent shared copies across deployed functions                                        | process control: deploy only from per-function verified trees; never `--prune`, never deploy from the worktree                                                                                                 |
| Ingestion not rehearsed on deployed bytes                                                | ingestion is unchanged by the installation; the rehearsal used a contract stub because the deployed ingestion bundles cannot share one local runtime. Verified in production by natural runs at Gates B and D. |
| v1 ingestion bumps `updated_at` of unchanged HC notices                                  | harmless under the correction (stale pairs retried); worth a later cleanup                                                                                                                                     |
| The owner can forge Auth sessions and grants                                             | T9 trust boundary (unchanged)                                                                                                                                                                                  |
| Hosted TOTP not enabled; no named humans                                                 | blocks all human capabilities (by design)                                                                                                                                                                      |

**Alternative scheduler** (for example GitHub Actions or Cloud Scheduler with OIDC):

- **Would fix:** it removes the queue from the invocation path, and with that the redirect, deletion and theft of invocations. It would allow dropping pg_net.
- **Would leave:** third-party trust, schedule jitter, and pg_net's database egress (unless pg_net is dropped).
- **Tickets would still be needed:** tickets and a Supabase grant fix together are the lower-risk path.

## 19. Classification: **YELLOW-safe (installation-ready)**

**Met:**

- the exact plan and gates
- a verified release tree (deployed bytes plus only the reviewed edits)
- rehearsed transitions, including failure and recovery
- all regressions
- production unchanged
- 26777, the 18 candidates and the page scheduler untouched

**Not GREEN:** the permanent pg_net mitigation requires Supabase (external), and the reviewer has not accepted the current permissions.

**Not RED:** no step loses work, weakens evidence, exposes a secret or interrupts v1. The unsafe orders fail closed and were rehearsed.

## 20. Recommendation

1. **Approve Gate A now.** It fixes the v1 silent-loss defect and prepares tickets. It changes no Cron, secret or capability, and v1 keeps its current authentication.
2. **Send the support packet in parallel.**
3. **Proceed to Gates B–D after observation.** Gate E should follow Gate D promptly, because the static key's exposure ends only there.
4. **Gate F:** apply F1 and F2; F4 is recommended.
5. **Keep unattended page scheduling blocked** until Supabase resolves the `net` grants or the reviewer explicitly accepts the residual risk in §7 and §18.
