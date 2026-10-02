# Phase 16.33 — security and v1 matching correctness — stop report

Continuation of [Phase 16.32](phase-16-32-pre-scheduling-readiness-stop-report.md) (YELLOW-safe), read in full.

**Classification: YELLOW-safe.** Every local GREEN criterion is met:

- **pg_net:** the threat model is established from production catalog evidence.
- **Mitigation:** a replacement for static keys in the pg_net queue is implemented and verified end to end on the local stack (single-use, hashed database tickets).
- **v1 defect:** the silent-loss defect is reproduced and corrected, with durable, bounded retries.
- **Negative evidence:** it now needs a human attestation over the sections the census does not read.
- **Tests:** all regression gates pass.
- **Production:** unchanged.

**Why YELLOW and not GREEN:** the pg_net grants themselves, which the reviewer did not accept, are owned by `supabase_admin`. The project owner provably cannot revoke them (§3). Tickets remove every credential from the queue, but these capabilities remain for any database login until Supabase acts or the reviewer accepts the ticket design as sufficient:

- tampering with or deleting queued requests
- outbound HTTP from the database

That is an external action.

**Not done:** no production migration, deploy, Cron change, page POST, secret creation or rotation, capability grant, reconciliation, criterion decision, v2 activity, provider call, or commit or push. Stop for review.

---

## 1. Worktree audit

- **Branch:** `main`. Nothing was reset, cleaned, committed or pushed, and all inherited work is preserved.
- **Status:** 209 entries at the start (36 tracked modifications, 173 untracked) and 224 now, plus this report.
  - 9 tracked files were modified. All were clean against `HEAD` at the start.
  - 6 new untracked entries.
  - The install check sits in the already-untracked `supabase/remote-install-checks/`.

**Reviewed artifacts at phase start** (all byte-identical to the values recorded in 16.32):

| Artifact                                                             | SHA-256                                                                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 16.32 report                                                         | `24a0cf64…275e`                                                                                                      |
| migration `20260930120000_phase_16_32_…`                             | `dd3a40e1…9cdd` (unchanged at the end)                                                                               |
| migration `20260929110000_phase_16_29_…`                             | `154b96b0…3c4c`                                                                                                      |
| manifest `docs/phase-16-15-backfill-manifest.json`                   | `e3ab192c…d9ed`                                                                                                      |
| worker source set (9 files, 16.27 method)                            | `9e6e318e…4a02`                                                                                                      |
| inherited suites 16.23 / 16.24 / 16.26 / 16.29 / 16.32, remote 16.26 | `f1ce35e4…`, `0d67a938…`, `64703267…`, `8f61a441…`, `d2eeb8ab…`, `a2095fb7…` (all equal to the 16.32 "after" values) |
| timeout harness, `tsconfig.json`                                     | `336d48ba…`, `9b87b309…`                                                                                             |

**Audit of the existing mechanisms:**

| Mechanism              | Finding                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| v1 matching            | `processRecallMatches` claims and finalizes each pair with an optimistic `updated_at` check (Phase 10 RPCs).                                                                                                                               |
| v1 completion          | The automation acknowledges the whole batch through `record_recall_automation_matching(p_complete)` (Phase 12).                                                                                                                            |
| Page → notice updates  | Seven writers touch `recall_notices.updated_at` without changing v1 content. The page coverage ledger is one (`cpsc_touch_identity_notices`, 16.13).                                                                                       |
| pg_net graph           | v1 job 2 posts `x-recall-automation-key` (Vault) to `run-recall-automation`. The 16.32 tick (not installed) would post `x-cpsc-page-worker-key` (Vault). Child functions call each other directly with edge secrets, never through pg_net. |
| Reviewer capabilities  | Two chokepoints: `cpsc_has_capability` and `cpsc_is_human_reviewer`.                                                                                                                                                                       |
| Negative-evidence gate | `cpsc_scope_rule_set_coverage.complete`, consumed by `validateLiveRuleSetEnvelopeV2`.                                                                                                                                                      |

## 2. Production baseline (read-only MCP, 2026-09-30 08:23–08:25 UTC)

| Check           | Value                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Migrations      | 29; last `20260929110000`; no 16.32 or 16.33 object                                                                   |
| Cron            | job 2 only, `17 */6 * * *`, active, MD5 `07549bf9…097b6`; pg_net queue 0; 1 response (06:17:00)                       |
| v1              | 58 runs; last 06:17 `success`; 0 leases; 0 pending; control enabled, AI enabled, push enabled; watermark `2026-09-30` |
| Page state      | 8 attempts, 8 work states, 34 fetches, 7 raw, 27 revisions, 7 snapshots, 7 ledgers; last claim 07:02:58.929           |
| Candidates      | 18, all `unreviewed`                                                                                                  |
| Holds           | 1 (26777), 0 resolutions                                                                                              |
| Humans          | 0 capabilities, 0 reviewer authorizations, 0 reconciliations, 0 review-ledger rows, 0 invalidations                   |
| Business and v2 | notices 90, scopes 103; owned products, matches, alerts, v2 evaluations, v2 rule sets and push queue all 0            |

Fingerprints (`count md5(to_jsonb rows)`, this phase's method):

| Object      | Fingerprint   |
| ----------- | ------------- |
| attempts    | `8 ac113605`  |
| work states | `8 4a536bb2`  |
| revisions   | `27 7a34be4a` |
| ledgers     | `7 a27e8b73`  |
| candidates  | `18 dc2b3a0f` |
| holds       | `1 a19900c3`  |
| identities  | `38 43120649` |
| runs        | `58 8293cbc3` |
| notices     | `90 bb3ac8e9` |

All counts equal the 16.32 end state.

## 3. pg_net privilege evidence (production catalog, read-only)

No stored credential, queued header or body was read.

| Object                                     | Owner            | ACL / effective privilege                                                                   | RLS |
| ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------- | --- |
| `net.http_request_queue`                   | `supabase_admin` | `=arwdDxtm/supabase_admin`: **PUBLIC has every table privilege**                            | off |
| `net._http_response`                       | `supabase_admin` | `=arwdDxtm/supabase_admin`                                                                  | off |
| schema `net`                               | `supabase_admin` | `=U` (PUBLIC USAGE) plus named API roles                                                    | —   |
| `net.http_post(...)`                       | `supabase_admin` | ACL **NULL = PUBLIC EXECUTE** in production                                                 | —   |
| `vault.secrets`, `vault.decrypted_secrets` | `supabase_admin` | `postgres=r*d*D*x*`, `service_role=rd`; USAGE on `vault` for postgres and service_role only | off |
| extension `pg_net` 0.20.4                  | `supabase_admin` | recorded in `public` (advisor lint `extension_in_public`)                                   | —   |

**Local image differs on one point:** `net.http_post` locally grants EXECUTE to named roles only, so `cpsc_page_worker` cannot call it there. In production the NULL ACL grants it to every role. The table grants are identical in both.

**Effective privileges** (`has_*_privilege`, production):

- **Every role** can SELECT, UPDATE and DELETE the queue, read responses, and call `http_post`. That includes `anon`, `authenticated`, `authenticator`, `cpsc_page_worker`, `pgbouncer`, `dashboard_user` and every `supabase_*` role.
- **`vault.decrypted_secrets` is readable by** `postgres`, `service_role`, `pg_read_all_data` members (`supabase_read_only_user`, `supabase_etl_admin`) and `supabase_admin`.

**Settings:**

- `pg_net.ttl = 6 hours`, `pg_net.batch_size = 200`, and pg_net runs as `postgres`.
- `log_statement = ddl`.
- `cron.log_statement = on`, which logs command text only. The Vault read happens inside the command, so the value is not logged.

**Can the project owner restrict it? No (proven locally on the identical ACL):**

- `revoke all on net.http_request_queue from public` run as `postgres` returns `WARNING: no privileges could be revoked`, and the privilege remains (16.33 pgTAP).
- Only `supabase_admin` holds the grant option.
- The Supabase guidance for this extension is to drop and recreate it (`drop extension pg_net; create extension pg_net schema extensions;`) or to contact support. Dropping pg_net would stop v1 job 2 and the new grants cannot be verified beforehand, so **no unsupported workaround was attempted**.

## 4. Actual exposure assessment

| Surface                                                      | Reachable by                                                | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data API (PostgREST, GraphQL)                                | internet with the publishable key                           | **No path found.** `net` is not in the exposed schemas (the local `config.toml` `[api] schemas` holds `public`, `graphql_public`). No advisor flags `net`. The only function referencing pg_net or `decrypted_secrets` is `private.install_recall_automation_cron` (production query), which is not API-exposed and not executable by anon or authenticated. The anon and authenticated grants on `net` are **latent, not exploitable** through the API as configured. |
| Dedicated worker login `cpsc_page_worker`                    | whoever holds its password (edge secret `CPSC_PAGE_DB_URL`) | **The real path.** This login has no table rights by design, yet through PUBLIC it can read queued v1 requests, which carry `x-recall-automation-key` during the milliseconds before pg_net sends them. It can also rewrite a queued URL, delete queued requests, and send arbitrary HTTP from the database.                                                                                                                                                           |
| Platform logins (`authenticator`, `pgbouncer`, `supabase_*`) | Supabase-managed credentials                                | Platform trust boundary. `authenticator` switches role and cannot run arbitrary SQL.                                                                                                                                                                                                                                                                                                                                                                                   |
| `postgres`, `service_role`                                   | project owner; server-side secret key holders               | Can already read Vault directly. The queue adds nothing for them.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Extension ownership                                          | `supabase_admin`                                            | Grants are platform-managed and unchanged by project migrations.                                                                                                                                                                                                                                                                                                                                                                                                       |

**What an attacker actually gains with a stolen v1 automation key:**

- They can call `run-recall-automation` with any bounded body. `parseAutomationRunRequest` allows up to 100 recalls, 1000 pairs, **5 AI escalations** and push batch 50. That means cost, CPSC API load and lease contention.
- They get no data: responses are aggregate counts.
- They get no other secret.

**No exploit is claimed.** No evidence of misuse exists:

- all 53 cron runs started at minute :17
- the 5 manual runs date from 2026-09-16 to 09-19 (activation phases)

However, queue reads leave no audit trail, so misuse cannot be excluded.

## 5. v1 credential assessment

| Credential                                                                | Where it is stored                                                         | In pg_net?                                                                     | Who could read it there                                                                                     | How long                                          | Rotation after mitigation                                                        |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `x-recall-automation-key` (`RECALL_AUTOMATION_KEY`)                       | edge secret on `run-recall-automation`, plus Vault `recall_automation_key` | **Yes.** Every 6 h since Phase 12 (the job 2 command reads Vault)              | every DB login (PUBLIC), until the pg_net worker dequeues it (sub-second; the batch is picked up at commit) | The response row (no request headers) is kept 6 h | **Required**, after job 2 runs on tickets (§7)                                   |
| Vault `recall_automation_url`                                             | Vault                                                                      | URL only                                                                       | same                                                                                                        | same                                              | none (not secret)                                                                |
| `RECALL_INGESTION_KEY`, `RECALL_MATCHING_KEY`, `RECALL_PUSH_DELIVERY_KEY` | edge secrets                                                               | **No** (direct edge-to-edge fetch)                                             | —                                                                                                           | —                                                 | none implied                                                                     |
| service or secret keys, `NEBIUS_API_KEY`, `EXPO_ACCESS_TOKEN`             | edge secrets                                                               | No                                                                             | —                                                                                                           | —                                                 | none implied                                                                     |
| `CPSC_PAGE_WORKER_KEY`                                                    | edge secret (supervised manual runs)                                       | No: 0 `cpsc_page_worker%` Vault secrets in production; 16.32 never provisioned | —                                                                                                           | —                                                 | none implied; no longer needed for scheduling                                    |
| `cpsc_page_worker` password                                               | edge secret `CPSC_PAGE_DB_URL`                                             | No                                                                             | —                                                                                                           | —                                                 | hygiene: keep the password null while the page stage is not operating (16.32 L4) |

Production v1 was not disrupted.

## 6. Recommended security mitigation

**Recommended architecture: database-issued single-use invocation tickets over pg_cron and pg_net, plus a Supabase support request to restrict the `net` grants.** It is implemented and verified locally.

1. **A tick** (`private.cpsc_page_stage_tick`, and the new `private.recall_automation_tick`) creates 32 random bytes. It stores **only the SHA-256** in `private.scheduler_invocation_tickets` along with the job, the parameters and the pg_net request id. It sends the plaintext once in `x-cpsc-page-ticket` or `x-recall-automation-ticket`.
   - **No static key is read or sent.** The page tick's Vault now holds only the pinned URL and the publishable key, and a `sb_secret_…` value is refused.
2. **The receiving function consumes the ticket atomically** through the database:
   - the page worker through its own login (`consume_cpsc_page_stage_ticket`)
   - v1 through service_role (`consume_recall_automation_ticket`)

   A ticket is accepted only if it is **single use**, **120 s**, **bound to one job**, and (for the page stage) **the stage is still running**.

3. **The run's bounds come from the ticket row, never from the request body.** v1 always runs `trigger: 'cron'` with the stored control limits.
4. **The static keys remain only for supervised manual runs** sent from an operator's machine, never through pg_net.

**Requirement coverage:**

| Requirement                                   | How it is met                                                                                                                                                                           | Proof                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Server-side credential custody                | No invocation credential exists at rest; the edge functions keep their own server secrets                                                                                               | pgTAP: tick and ticket rows hold no plaintext                                          |
| Least-privilege invocation                    | A ticket can only trigger the one bounded cycle the DB already decided to run                                                                                                           | pgTAP: bounds come from the DB; a v1 ticket fails on the page consumer and the reverse |
| No queue secret accessible to unrelated roles | The queue holds no reusable credential. A captured ticket can only deliver the same cycle once within 120 s; the legitimate request then gets 401, which shows up as a rejected attempt | pgTAP, e2e                                                                             |
| Rotation                                      | Nothing long-lived to rotate: every tick is a new credential                                                                                                                            | —                                                                                      |
| Revocation                                    | Kill switch or stop: a ticket issued before a stop is consumed but authorizes nothing (`stage_not_running`); uninstalling the job issues none                                           | pgTAP, e2e                                                                             |
| Request authentication                        | Hash lookup under row lock; malformed tickets are refused before database access                                                                                                        | pgTAP, Deno                                                                            |
| Replay protection                             | Single use (`replayed`), 120 s expiry (`expired`), wrong job (`wrong_job`); every rejection is counted                                                                                  | pgTAP                                                                                  |
| Audit logging                                 | Append-style ticket ledger (issued, consumed, consumer, rejected attempts) with a guard trigger that forbids delete, re-arm or rewrite; `private.scheduler_invocation_status`           | pgTAP                                                                                  |
| Operational kill switch                       | 16.32 L1–L4 unchanged; a stop wins over an issued ticket                                                                                                                                | pgTAP, e2e                                                                             |

**External scheduler, evaluated and not recommended now:**

- **What it would give:** GitHub Actions OIDC or Cloud Scheduler OIDC tokens verified against the issuer's JWKS remove the queue entirely and would later allow dropping pg_net.
- **Why not now:**
  - it adds a third party to the trust boundary, plus provisioning outside this repository
  - scheduled workflows can be delayed or dropped, which matters for 6-hourly safety ingestion
  - it cannot be verified end to end locally
- **When to revisit:** if Supabase will not restrict the `net` grants and the reviewer does not accept the residual (§17).

**Residual after tickets (platform, external action):** any database login can still delete or alter queued requests and send HTTP from the database.

- **Deletion:** detectable as expired unconsumed tickets.
- **Alteration:** can only misdirect a single-use ticket.
- **Resolution:** requires Supabase support to revoke PUBLIC on `net.*`, or acceptance.

## 7. Credential rotation implications

**Now:** no rotation (as instructed).

**After installation:**

- **The v1 key stays exposed at every :17 run** until job 2 is converted to tickets. Rotating it earlier is pointless: the new key would pass through the queue at the next run.
- **Required order:**
  1. deploy `run-recall-automation` with ticket support
  2. `private.convert_recall_automation_cron_to_tickets()` (owner; changes only the command; pgTAP proves that name, schedule and the active flag are kept)
  3. observe one natural run consuming a ticket
  4. rotate `RECALL_AUTOMATION_KEY`
  5. delete Vault `recall_automation_key`
- **Everything else:** no other credential was in pg_net, so no other rotation is implied.

## 8. v1 staleness root cause (reconstructed)

**Transaction boundaries (each RPC is its own transaction):**

1. **Claim the run:** `claim_recall_automation_run` takes the singleton lease.
2. **Ingest:** the child upserts notices, then `record_recall_automation_ingestion` inserts the pending rows **and advances the watermark in the same transaction**.
3. **List:** `get_recall_automation_pending_recalls`.
4. **Match**, in the child, for each recall:
   - `get_recall_matching_batch` reads `updated_at` = R₀
   - `get_recall_candidates`
   - for each pair, `claim_recall_match_evaluation` compares the product and recall `updated_at` to the values read, twice, and inserts a lease
   - evaluation runs in memory
   - `finalize_recall_match_evaluation` checks the lease, takes `FOR SHARE` on the product and notice rows, re-compares, upserts the match and alert, and releases the lease
5. **Page evidence (independent):** `commit_cpsc_page_evidence_verified` → `record_cpsc_page_coverage` → `cpsc_touch_identity_notices` sets `updated_at = now()` in the worker's transaction. Other writers:
   - `cpsc_touch_candidate_notices`, rule materialization (16.12)
   - revision and observation paths (16.10 and 16.11)
   - the v2 read model (16.x)
6. **Acknowledge:** `record_recall_automation_matching(p_complete)` with `p_complete = not (failures or providerFailures or limitsReached)`. **`staleSkipped` and `busySkipped` are not counted**, so `true` deletes the pending row of **every** listed recall.

**Reproduced exactly**, in pgTAP with the real RPCs and in the Node harness with the real orchestrators:

1. An owned product matches recall R.
2. Matching reads R and claims the pair.
3. The page ledger commits `cpsc_touch_identity_notices` from another session.
4. Finalization returns `stale`, and the next pair's claim is also `stale`.
5. `staleSkipped = 2` and the Phase 12 run ends `success`.
6. R leaves pending, the watermark has passed it, and **both legitimate matches are missing** (harness replay of the `HEAD` orchestrator).

**Exact conditions for a silent miss:**

- (a) R has at least one candidate pair.
- (b) An `updated_at` writer commits between the batch read and a pair's finalize share lock. A writer that commits after the lock waits, and is harmless because v1 content is unchanged.
- (c) Nothing else in the run is incomplete.
- (d) The pair has no match with the same fingerprint.
- (e) CPSC does not revise R later, since that would re-affect it.

The same loss follows a `busy` pair whose concurrent holder later fails.

**Production impact:** none possible so far. There were 0 owned products and 0 matches ever, and every run shows 0 candidate pairs.

## 9. Durable correction

**Smallest change that follows the architecture.** Stale-version detection is not suppressed.

**Matcher (`recallMatching/orchestrator.ts`, bookkeeping only):**

- The decisions, fingerprints, claims and finalizations are unchanged.
- It reports `resolvedRecallIds` and `unresolvedRecalls[{recallNoticeId, reason}]`.
- A recall is **resolved only** when its candidate list was fully enumerated and every pair ended `finalized`, `unchanged` or `missing`. A vanished product or recall leaves no work.
- The reasons are `stale`, `busy`, `failure`, `provider_failure`, `limit` and `not_reached`.
- A requested recall absent from a fully exhausted listing is no longer matchable, so it is resolved. Otherwise it is `not_reached`.
- `legacyRun` returns both fields.

**Automation (`automation/orchestrator.ts`, `children.ts`, `store.ts`):**

- `incompleteMatching` also counts stale and busy.
- It partitions the requested recalls using the matcher's report. **Anything unaccounted for stays pending.**
- Counters that contradict an all-resolved report fail closed (`inconsistent_summary`).
- A pre-16.33 matcher response makes the whole batch stay pending.
- The run is `partial_success` with `errorCode` set to `matching_retry_pending` for stale or busy only, and `matching_incomplete` otherwise. Push deferral is unchanged from Phase 12.

**Database (migration 16.33):**

- **`record_recall_automation_matching_outcome`** (service_role; replaces the batch call):
  - deletes only resolved recalls
  - for unresolved ones, increments `unresolved_attempts`, records the reason and time, and **recreates a missing row**
  - validates reasons, exclusivity, lease and metrics
  - writes one append-only row per recall per run to `recall_automation_matching_outcomes`
- **Bounded retries:**
  - the 8th unresolved cycle (48 h) sets `exhausted_at`, an explicit durable state that is never a deletion
  - `get_recall_automation_pending_recalls` (same signature and order while nothing is exhausted) lists exhausted recalls last and **at most once per 24 h**
  - new authoritative work re-arms the row (trigger on `last_affected_at`)
  - `private.recall_automation_pending_status` exposes pending, retrying, exhausted, reasons and outcomes
- **Idempotency:** the existing unique match per pair, the unique alert per match, and fingerprint `unchanged`.

**Watermark:** it still advances in the same transaction that makes the work pending. Pending work is now removed only on per-recall resolution, so the watermark can no longer discard unresolved work.

**Compatibility:** the Phase 12 RPC and its grant stay for the deployed function (install check). Either deployment order is safe. The new automation with the old matcher falls back to keeping the batch pending.

## 10. Concurrency test results

Everything below ran on a non-empty inventory (15 products across 11 users).

- **pgTAP (16.33 suite):** the real RPCs and the real page touch.
- **Node harness** `scripts/verify-phase-16-33-v1-concurrency.mjs`, **20/20**. It drives the real `processRecallMatches`, the real `runRecallAutomation` and the real `children.ts` parser against the local database, with touches and executions from **separate sessions**.

| Required case                       | Result                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Recall updated during matching      | run `partial_success` / `matching_retry_pending`; recall pending, `stale`, attempt 1                                           |
| Page ledger written during matching | `cpsc_touch_identity_notices` from another session makes the pair stale; the recall is kept                                    |
| Multiple updates to the same recall | 2 cycles touched: attempts 2, no match; 3rd cycle confirms both pairs                                                          |
| Stale pair, then successful retry   | next cycle confirms 2/2 with 1 alert each; the pending row is removed                                                          |
| Process termination before retry    | the dead run records nothing; after lease expiry the next run lists and confirms the work                                      |
| Concurrent matching executions      | B meets A's pair `busy` and reports it unresolved; A finalizes; every pair matched once                                        |
| Duplicate work delivery             | second delivery: `unchanged` = 2, 0 alerts; a duplicate outcome record in one run is rejected (pgTAP)                          |
| Retry exhaustion                    | 8 touched cycles set `exhausted`; not retried the same day; retried after 24 h and resolved; re-armed by new ingestion (pgTAP) |
| Unrelated recall                    | no candidates → resolved                                                                                                       |
| Unchanged recall                    | `unchanged` pairs → resolved; no duplicate                                                                                     |
| Phase 12 replay (`HEAD`)            | the defect reproduces: `success` with 2 stale pairs, 0 matches, nothing pending                                                |

**Invariant:** all 10 designed pairs are confirmed exactly once with exactly one alert, or their recall is explicitly pending. Final: 0 lost and 0 duplicate matches.

## 11. Negative-evidence safety

**Relationship before 16.33:**

- `negative_evidence_eligible` is a ledger property over **description** prose and tables only.
- `complete` = one current revision, every proposal attributed and served, the ledger negative-eligible, and relations equal to groups.
- `validateLiveRuleSetEnvelopeV2` rejects only when `complete` and the ledger fields hold.
- **Gap:** a restriction written only in the remedy, "sold at" or a linked document leaves the ledger eligible (16.32 characterization), so a fully reviewed universe could have served rejections.

**Local serving gate added (DB, no TS change):**

- `complete` additionally requires a **current human attestation** (`private.cpsc_outside_census_attestations`) from a criterion reviewer with MFA. The attestation is bound to:
  - the revision and its semantic hash
  - the SHA-256 of the exact non-description `recallDetails` text
  - the external references read (https only)
  - an expiry of at most 30 days
- It is withdrawn by:
  - any change of text (a new revision)
  - expiry
  - a reviewer not authorized at the time of attesting
- **Forgery is refused:** an owner insert carrying a real reviewer id fails.
- **Reviewer reads:**
  - `get_cpsc_outside_census_packet` (sections, hash, current state)
  - `attest_cpsc_outside_census` (the hash must equal what was read)
- The state is visible as `sourceCoverage.outsideCensus`.
- **Nothing is inferred from documents automatically.**

**Tests (16.33 pgTAP)**, each on a fully reviewed, ledger-complete universe:

| Case                          | Result                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Remedy-only restriction       | the ledger reports `negativeEvidenceEligible = true`, yet **`complete = false`**; the positive rule set still serves |
| "Sold at" restriction         | `complete = false`                                                                                                   |
| Linked document in the remedy | `complete = false` until attested with the reference                                                                 |
| Attested                      | `complete = true`                                                                                                    |
| Attestation expired           | withdrawn                                                                                                            |
| Revision changed              | withdrawn                                                                                                            |

- **Description restrictions** remain censused (16.13 and 16.32 tests unchanged).
- **Inherited suites** (16.12, 16.13, remote compatibility) now attest before asserting `complete = true`. Their assertion counts are unchanged.

## 12. Human authorization preparation

**Capability model** (existing; nothing duplicated; distinct and audited in 16.32):

| Prompt name               | Implementation                  |
| ------------------------- | ------------------------------- |
| `scheduler_control`       | `operational_scheduler_control` |
| `identity_reconciliation` | `identity_reconciliation`       |
| `criterion_review`        | `cpsc_reviewer_authorizations`  |

**Server-verified MFA** is enforced at both chokepoints (`cpsc_has_capability`, `cpsc_is_human_reviewer`), so every capability-gated RPC inherits it. A human counts only if **all** of the following hold:

- the JWT is `authenticated` with `aal = aal2` and a `session_id`
- **the `auth.sessions` row exists** for that user with `aal2` and has not expired, so signing out ends the authority at once
- the user holds a **verified** factor
- the session's MFA step (`auth.mfa_amr_claims`: `totp`, `mfa/totp`, `mfa/phone` or `mfa/webauthn`) is **at most 12 h old** (step-up)
- the grant window covers now

**Tests (16.33 pgTAP):**

- **Refused:** aal1, no session, another user's session, an aal1 session row, an expired session, an MFA step older than 12 h, an unverified factor, a signed-out session, anon, service_role.
- **Separation:** no capability implies another.

The grant history and one-way revocation from 16.32 are unchanged. The owner remains the grantor (T9). The owner can also forge Auth rows, which is the same trust level as granting.

**No capability was granted. The 18 candidates for 26773 were not approved. 26777's hold was not cleared.**

**Enrollment and authentication for a real operator (next phase):**

1. **Enable TOTP** in the hosted project's Auth MFA settings (dashboard). This is an external action; local `config.toml` has TOTP disabled.
2. **Create the account.** The owner creates the person's Auth account (invite). The person signs in (aal1) and enrolls TOTP from a trusted client (`auth.mfa.enroll` → scan the secret → `auth.mfa.challenge` → `auth.mfa.verify`), which yields an aal2 session.
3. **Grant.** The owner grants exactly one capability by SQL, with `authorized_by` and a reason (audit row).
4. **Act.** The person calls the RPC through PostgREST with the aal2 access token. After 12 h they re-verify TOTP (`challenge` / `verify`).
5. **End.** Signing out, deleting the factor, or revoking the grant ends the authority immediately.

## 13. Scheduler migration review

**The 16.32 migration is unchanged** (`dd3a40e1…9cdd`), and no applied migration was modified. Installing 16.32 + 16.33 was proven by clean reset (31 migrations) and by the new **production-safe, rollback-only install check** `supabase/remote-install-checks/phase-16-33-install.sql` (22/22 local rehearsal; the runner accepts its shape):

| Property                | Evidence                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Page stage stopped      | control state `never_started`; 0 control events; the worker claims 0 rows                     |
| No active scheduled job | 0 `cpsc-page-evidence-shadow` jobs; v1 job 2 not converted                                    |
| No worker invoked       | the tick probe skips; the pg_net queue is unchanged; 0 attempts or work states added          |
| No production secret    | 0 `cpsc_page_worker%` Vault secrets; the migration creates none                               |
| No human capability     | 0 capabilities or reviewer authorizations; an unknown aal2 session holds nothing              |
| v1 unaffected           | the deployed v1 RPCs and grants are present; 0 runs or pending rows changed; 0 v2 evaluations |

**Changes needed in light of §3** (made in 16.33, forward-only):

- **The tick no longer reads or sends `cpsc_page_worker_key`.** Its blocker is renamed `invocation_endpoint_unavailable`.
- `install_cpsc_page_stage_cron` requires only the URL and the publishable key.
- **The 16.32 plan to provision a Vault key is withdrawn.**
- The worker adds a ticket path; the static-key path stays for supervised runs. The worker's executable security-definer set gains exactly `consume_cpsc_page_stage_ticket`.

## 14. Migration and source hashes

**New:**

| File                                                                             | SHA-256                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `supabase/migrations/20260930200000_phase_16_33_security_and_v1_correctness.sql` | `774166807cc143071fd86306b88921198e4ccab50afd5a5f5a9eafffe46da018` |
| `supabase/tests/phase-16-33-security-and-v1-correctness.sql` (237 assertions)    | `d11dda954dabb23dd782bdb3219a7f2638e71e3e6804ccb036c149a18ecffe51` |
| `supabase/remote-install-checks/phase-16-33-install.sql` (22)                    | `54b7fedf12f6171248ef5c41103cb84d6a3b8be8cda7f20876b5bdc3859fec29` |
| `scripts/verify-phase-16-33-v1-concurrency.mjs` (20 checks)                      | `cc0bae7beeb14eb5b97b740b9eb6f69f35222a76a968d98bafc7ed49c1a8482d` |
| `scripts/verify-phase-16-33-local-tickets.mjs` (10 checks)                       | `7e53d5a57b1cf73f9c4b181f01d1669c1d0dd733ce042c41cf248fa867b1b29f` |
| `tests/phase-16-33-v1-correctness.test.mjs` (13)                                 | `c1f89e4681097bfed8166df08a67d59e4b6d81a0548e18b4d987ed50618f4d34` |
| `tests/phase-16-33-ticket-invocation.test.ts` (Deno, 4)                          | `868f520d345926ff8d2007baa1483790cfc3584fd777f1f9183092d95ece8fa8` |

**Edited source** (before = `HEAD`, or a reconstruction verified against a recorded hash):

| File                                     | Before → after                                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_shared/recallMatching/orchestrator.ts` | `415dd080…8854` → `8b044008eedabdc2c3885c559867dd8cfabc5657ca9188a8da816d5cdfbf9a4c`                                                                                                |
| `_shared/recallMatching/index.ts`        | `4ea4aab9…606c` → `f22b4db701db5496cac9f5295d21eec912708805eac58310330c322ed7909704`                                                                                                |
| `process-recall-matches/legacyRun.ts`    | `78b20cb2…1dbd` → `f1a8d0476a8e5f8b4c6e32bfe740eaa9629614992e7786de7742008f0a5b8e5a`                                                                                                |
| `_shared/automation/orchestrator.ts`     | `492bfb74…d301` → `05133c737b07f93621fdfacd7ceb289ddb0de3ec1d43d703b79be197fa360222`                                                                                                |
| `_shared/automation/types.ts`            | `3351000a…5845` → `b0d231c5077f5eb95d0eb503281a64f1447951853ca66fb528ba0e3f5a22efc4`                                                                                                |
| `_shared/automation/index.ts`            | `199364b2…4fe7` → `f7b8c7855380acf73e7050f9240e58c5979a7ba9088021198c8c0640c11211e7`                                                                                                |
| `run-recall-automation/children.ts`      | `42684f7a…64c5` → `70933ae64435581bbff83d3c30487f30fa52407596370ea09d73b267fad31f03`                                                                                                |
| `run-recall-automation/store.ts`         | `500dd427…d1f9` → `22a222e8647f2eee7231a04caf5428016bbd3074460a7ff8d462d119835f102e`                                                                                                |
| `run-recall-automation/index.ts`         | `427a0fda…b7c3` → `ffda65effa45acf589c6f78bb9c4b1a9d2171d84edfdfbdcf0df8ecd03e8fc11`                                                                                                |
| `process-cpsc-page-evidence/index.ts`    | `eb3ef31e…7055` → `526a5d8a9d32513b69ec5b249c647dcf428b8dc27b877d8eef59d368c74b6793`                                                                                                |
| worker source set (9 files)              | `9e6e318e…4a02` → `276d90f9fc671750043764414622f92e8d0d7b574f5e42722b247e181682db91` (only `index.ts` changed; the reconstructed pre-edit entry reproduces `9e6e318e…4a02` exactly) |
| `tsconfig.json` (1 exclude)              | `9b87b309…41ee` → `bdae52c82d42c7d94a324527dfa7f87a3f258ff430b39c34cf3cf6b4ac87bcb4`                                                                                                |

**Edited tests and harnesses (setup only; every assertion count is unchanged):**

- **MFA fixtures:**
  - a session, verified factor and fresh TOTP claim per fixture user (filtered to fixture emails created in the transaction)
  - `aal2` plus `session_id` claims
- **Attestation fixtures** before `complete = true` checks.
- **Ticket semantics** in the 16.32 tick section: 7 assertions rewritten 1:1.
- **Worker RPC set** plus the ticket consumer.

| File                                                                               | Before → after                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 16.10                                                                              | `d58c251f…9daa` → `f8ccfdedca3412da4c8f7f2e64749b6f516c49a806a25dbdb7cab5b255590f80` |
| 16.11                                                                              | `08a93606…d3d7` → `421084f8e52afdda27b5460d70fb40913d987e4eda90dc8ae1d4d496f3d3c9b0` |
| 16.12                                                                              | `b978dfb1…d8f3` → `7012d7cc2c5df664e899f6604adf982aa6b9cf044302f2abc694b023026a526c` |
| 16.13                                                                              | `56abbc25…7b1b` → `5fca2d201ae870ea261fe837e492755fc2586f067616ea21c9416b0804fad229` |
| 16.16                                                                              | `f326f965…d81f` → `13d7b710b93bdb435ea1492693cf3640b1ac257617432e96a98050e590b5d980` |
| 16.23                                                                              | `f1ce35e4…4f91` → `4f8c9753b498bcc4e21458f1ca1cf55d4ae13713ab793f915fca9d5cf24c868b` |
| 16.24                                                                              | `0d67a938…2b48` → `575809be45027eee8c281fcc94f766264723b45f70ac36ba0462aadd354c6542` |
| 16.26                                                                              | `64703267…8979` → `046c353e793bae0810e184480f299522221987d5a88cbb6fc7c14d323e1443eb` |
| 16.29                                                                              | `8f61a441…152a` → `e81bd7ab5bd5bf556422d0a5f0435ce92a50f01805147de075432cdda23869da` |
| 16.32                                                                              | `d2eeb8ab…f732` → `bcea3ed5b1b6f7ed72b20acc30be2e5a4a2bde52150746ad9f18a5c81780ca2a` |
| remote 16.17                                                                       | `6c70c145…6684` → `4279260aa4f9352d38dd6a15680c96b48d3f09d5f0323df5a8528727dd2c655a` |
| remote 16.26                                                                       | `a2095fb7…f862` → `fb6645c07eb75d2cc58f92b819f3a107d404209fca090b73664f29ac6638429c` |
| remote compatibility                                                               | `d285a0be…ca17` → `f814a407c2e2325427443916eb8ba1b1d434a7ea735f456c184071872d2df11e` |
| `tests/phase-12-automation.test.mjs` (2 assertions now read the per-recall record) | `6af2f650…3f05` → `d6a10c5e641c4f04098a27830707a36c0c3fa0defbba6ef2b0cee8eed2ead6b1` |
| `scripts/verify-phase-16-24-db-timeout.py`                                         | `336d48ba…f747` → `0b27fae3dc2f7611438d487a493f958d539f7e8db9eb0e39072e8c96964c2c09` |

**The remote suites now assume 16.32 + 16.33 are installed.** This is the same convention 16.32 used for remote 16.26.

## 15. Complete local test results (clean reset, 31 migrations)

| Gate                                                          | Result                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `supabase db reset --local --no-seed`                         | 31 migrations; 0 identities, 0 control events, 0 Cron jobs, 0 tickets; worker password null                                                                                                                                                                                                                  |
| Full pgTAP (`supabase test db`)                               | **2383 / 2383, 23 files, PASS**: 2145 inherited + 237 new + 1 (the 16.11 `cpsc_*` RLS census gains the attestation table)                                                                                                                                                                                    |
| Remote suites rehearsed locally (inside the full run)         | 16.17: 34; 16.26: 172; production compatibility: 89                                                                                                                                                                                                                                                          |
| Install check rehearsal                                       | 22 / 22                                                                                                                                                                                                                                                                                                      |
| Node full suite                                               | **410 / 410** (397 + 13)                                                                                                                                                                                                                                                                                     |
| Worker tests                                                  | inside Node (16.23 worker 15/15, 16.32 replay)                                                                                                                                                                                                                                                               |
| Deno                                                          | `deno check` on every function entrypoint, `_shared/{cpsc,automation,recallMatching}` and both Deno tests: exit 0; `deno test` 6/6                                                                                                                                                                           |
| Expo `tsc --noEmit`                                           | exit 0                                                                                                                                                                                                                                                                                                       |
| DB lint `--level error`                                       | 0 results. The pgTAP extension that `supabase test db` leaves installed was dropped first; its own functions are what lint reports otherwise.                                                                                                                                                                |
| Backfill rehearsal (frozen 16.13 manifest)                    | **26 / 26**; digests `ea00243e…133f` / `1406161a…a909` (equal to 16.32); remote-safe 89/89; live gate correct                                                                                                                                                                                                |
| Freeze guards 9.1 / 15 / 16                                   | `frozen=true` ×3                                                                                                                                                                                                                                                                                             |
| Deterministic v2                                              | **0 unsafe confirmations / 200** (development, holdout and stress all 0)                                                                                                                                                                                                                                     |
| v2.1 safety                                                   | 0 unsafe, 66 needs-review preserved, **0 provider calls**                                                                                                                                                                                                                                                    |
| DB timeout and credential harness                             | 4 s cancellation `57014`, rollback 0 rows, lease recovered, revoked login denied                                                                                                                                                                                                                             |
| v1 concurrency harness                                        | **20 / 20**                                                                                                                                                                                                                                                                                                  |
| Ticket end to end (real pg_net → gateway → `functions serve`) | **10 / 10**: tick dispatches; the worker consumes and runs a DB-bounded cycle (`queue_empty`); v1 consumes and stops at disabled control; forged tickets get 401 with no run or attempt; a stopped stage issues no ticket; responses hold no ticket                                                          |
| Benchmark churn                                               | the deterministic runner rewrote `deterministic-v2-all.json`; restored; 16/16 files equal the phase start                                                                                                                                                                                                    |
| Prettier, `git diff --check`, whitespace                      | clean (33 files scanned)                                                                                                                                                                                                                                                                                     |
| Secret scan                                                   | 0 JWTs, `sb_secret_` or `sb_publishable_` values, or private keys. The only connection string is Supabase's documented local-dev default on `127.0.0.1`. The 64-hex strings are pre-existing content hashes. The e2e generates the worker password at random, uses it only locally and sets it back to null. |

**Environment notes:**

- `children.ts` uses constructor parameter properties, so the harness runs with Node `--experimental-transform-types`.
- postgres.js re-serializes timestamptz parameters through `Date`, so the harness passes timestamps as text to keep microseconds.
- Neither affects production code.

## 16. Production final comparison (read-only, 09:11–09:12 UTC)

- **No new migration:** still 29, last `20260929110000`; no 16.32 or 16.33 object.
- **No deployment:** all 8 functions have the same versions and bundles (worker v9 `c15d6623…`).
- **Worker unscheduled:** Cron is job 2 only (`07549bf9…`); pg_net queue 0; 0 page Vault secrets.
- **No page POST:** edge logs from 07:03:30 to 09:12:30 show **0 requests**. The last claim is still 07:02:58.929.
- **Byte-identical to the 08:23 baseline:**
  - attempts `8 ac113605`, work states `8 4a536bb2`, revisions `27 7a34be4a`, ledgers `7 a27e8b73`
  - fetches 34, raw 7, snapshots 7
  - identities `38 43120649`, notices `90 bb3ac8e9`, scopes 103, runs `58 8293cbc3`
  - automation state unchanged
- **26777 hold unchanged:** `1 a19900c3`, 0 resolutions.
- **18 candidates `unreviewed`:** `18 dc2b3a0f`; review ledger 0; reviewed criteria 0.
- **No human approval:** 0 capabilities, reviewer authorizations, reconciliations and invalidations.
- **No v2 activation:** v2 evaluations and rule sets 0; matches, alerts, push and owned products 0.
- **v1:** no natural activity during this phase (last run 06:17; next 12:17).
- **Production access:** only `SELECT` queries, the catalog, advisors, the function list and edge-log reads.

## 17. Classification: **YELLOW-safe**

**GREEN criteria met locally:**

- the threat model (§3–§5)
- a verified mitigation (§6, e2e 10/10)
- the silent-loss correction (§9)
- durable retry tests (§10)
- negative evidence stricter than before (§11)
- all regressions (§15)
- production unchanged (§16)

**YELLOW because platform-level mitigation needs external action:**

- The pg_net PUBLIC grants cannot be changed by this project. Tickets make them irrelevant to credential custody but not to queue integrity or database egress.
- A Supabase support request, or explicit reviewer acceptance of that residual, is required before unattended scheduling.

**Not RED:**

- no matching work is lost (0 lost pairs, a durable exhausted state)
- no evidence requirement is weakened (the new gate only tightens)
- no secret was exposed or read
- production v1 is untouched

## 18. Remaining blockers

| ID     | Blocker                                                                                                                                                 | Owner               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| B1     | No human holds a capability; hosted TOTP MFA must be enabled first                                                                                      | project owner       |
| B3′    | PUBLIC on `net.*`: request revocation from Supabase support, or accept the residual                                                                     | external / reviewer |
| B7     | **The v1 static key is still sent through the queue every 6 h in production** until 16.33 is installed, job 2 is converted, and the key is rotated (§7) | next phases         |
| B2     | Resolved locally; production needs the migration plus deployment of the two v1 functions                                                                | next phase          |
| B5     | Closed locally by the attestation gate                                                                                                                  | —                   |
| B4     | 26777 relocation design deferred (hold unchanged)                                                                                                       | reviewer            |
| B6     | Hold-clearance disputes and two-person rule                                                                                                             | design decision     |
| D5, D7 | Scheduling parameters and raw retention (from 16.32)                                                                                                    | reviewer            |

## 19. Exact next-phase installation plan (Phase 16.34, supervised; no scheduling)

1. **Re-verify hashes:**
   - migrations `dd3a40e1…9cdd` and `77416680…a018`
   - the v1 source files in §14
   - worker set `276d90f9…db91`
   - install check `54b7fedf…ec29`
2. **Read-only preflight** as in §2. Also confirm no v1 run within ±10 min and healthy CPSC.
3. **Dry run:** `supabase db push --dry-run --linked` must list exactly the 16.32 and 16.33 migrations.
4. **The user runs** `supabase db push --linked`.
5. **The user runs** (`npm run test:remote-pgtap -- --file …`):
   - the install check (22)
   - the production compatibility suite (89)
   - remote 16.26 (172)
   - remote 16.17 (34)
6. **Deploy `process-recall-matches`, then `run-recall-automation`** (v1 correction). The worker and scheduling are **not** deployed in this phase.
7. **Observe the next natural v1 run:**
   - `recall_automation_matching_outcomes` rows appear
   - pending semantics hold
   - the watermark only moves forward
   - 0 page effects
8. **Separately authorized (16.35):**
   1. `private.convert_recall_automation_cron_to_tickets()`
   2. observe one ticket consumed by a natural run
   3. rotate `RECALL_AUTOMATION_KEY` and delete Vault `recall_automation_key` (B7)
9. **External actions, in parallel:**
   - the Supabase support request for `net.*` grants (B3′)
   - enable hosted TOTP
   - name the operator, reconciler and reviewer (B1)
10. **Out of scope** until B1 and B3′ are decided:
    - worker deployment
    - page Vault endpoint
    - capability grants
    - `start_cpsc_page_stage`
    - page Cron installation
    - any page call
    - reconciliation or review
    - v2 or Nebius
    - commit or push
