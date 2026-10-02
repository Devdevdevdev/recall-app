# Phase 16.19 stop report — first natural post-guard cron cycle

**Status:** The first natural scheduled cycle after the Phase 16.18 watermark migration succeeded. Read-only production checks found no stop condition. This phase made no production change, manual invocation, deployment, migration, cron edit, reconciliation, policy activation, Nebius call, commit, or push. Stop for review.

## 1. Worktree handoff

The same `main` worktree remained dirty. Initial `git status`, `git diff --stat`, `git diff`, and untracked paths were inspected; 36 tracked files were already modified, with the inherited Phase 16 artifacts untracked. No reset, clean, or discard occurred. This phase added the local aggregate review patch and this report, and sanitized one local fallback response in `supabase/functions/ingest-recall-source/index.ts`. Phase 15 `audit.json` refreshed `generatedAt` during benchmark validation (13:48:26 UTC); benchmark counts, labels, and fingerprints did not change.

The Phase 16.18 migration file still hashes to `dc2e58e30f1b6aef6e814390e32a9a0a5b7d3f55bdf080ee59f346482a908e3b`.

## 2. Production preflight

Before the eligible run, production history contained 24 migrations and `20260927124132` exactly once. Cron job 2, `recall-automation-every-6h`, remained active at `17 */6 * * *`. Function versions were CPSC 16, source child 4, source aggregate 1, automation 3, matcher 11, push 6, and inactive v2 cohort 1. There were no automation or matching leases.

CPSC had `last_publish_date=2026-09-27`; Health Canada had `last_updated_date=2026-09-27`; the automation date watermark was `2026-09-27`. Both source states were successful without error. `private.cpsc_watermark_safety()` returned `safe=true`, nine quarantined, nine retained, zero hash-only, and no unaccounted item. Baseline counts: 87 notices, 100 scopes, zero owned products, pending recalls, matches, alerts, push queue/deliveries, reviewed criteria, v2 evaluations/eligibility/snapshots/corrections, and reconciliations. There were 109 CPSC observations. No unexpected pending work was found.

## 3. First eligible natural run and automation

The successful 12:17 UTC run, ID `add1e6fe-1566-4d65-b754-75a5cf9d0c44`, preceded the migration and was excluded. The first later cron execution was pg_cron run **43**, from **18:17:00.240638 to 18:17:00.325356 UTC** on 2026-09-27, status `succeeded`.

Its automation run was **`29a364b7-7de3-47cc-ac26-4c36998fc01d`**, trigger `cron`, started **18:17:01.807918**, completed **18:17:07.019764 UTC**, status `success`, duration **5.211846 seconds**. `error_step` and `error_code` were null. The automation window was **2026-09-25 through 2026-09-27**.

## 4. CPSC source stage

The requested source window was 2026-09-25 through 2026-09-27 (automation window and deployed aggregate window calculation). Fetched 0; processed 0; unchanged 0; quarantined 0; unresolved 0; failed/rejected 0. The source watermark stayed `last_publish_date=2026-09-27`; `last_status=success`, `last_error_code=null`. The source success timestamp advanced from 12:17:03.997670 to 18:17:04.447570 UTC. Safety remained true, with zero hash-only quarantine. The live same-date cursor write succeeded. No CPSC row was replayed in this cycle.

## 5. Health Canada source stage

The requested window was 2026-09-25 through 2026-09-27. Fetched 5; inserted 0; updated 0; unchanged 5; failed/rejected 0. The watermark stayed `last_updated_date=2026-09-27`; `last_status=success`, `last_error_code=null`. The source success timestamp advanced from 12:17:08.134734 to 18:17:06.428381 UTC. The same-date write succeeded under the new DB guard.

## 6. Matching and push stages

Affected recalls 0; pending notices consumed 0 (zero before and after); candidate pairs 0; deterministic resolved 0; confirmed 0; rejected 0; needs review 0; AI escalations 0; provider failures 0; alerts created 0. The deployed matcher selector defaults to `phase_10_guarded_v1`, and a read-only secret-name check found no `RECALL_MATCHING_POLICY` override; no v2 state appeared. With zero candidate pairs and zero AI escalations, this cycle did not invoke Nebius through the matching path.

Push claimed 0, accepted 0, failed 0. Zero notifications is the expected success outcome because no alert was eligible.

## 7. Post-run watermark and safety proof

| Cursor        | Before     | After      | Kind                |
| ------------- | ---------- | ---------- | ------------------- |
| CPSC          | 2026-09-27 | 2026-09-27 | `last_publish_date` |
| Health Canada | 2026-09-27 | 2026-09-27 | `last_updated_date` |
| Automation    | 2026-09-27 | 2026-09-27 | date                |

The automation watermark `updated_at` advanced to 18:17:06.543503 UTC. No cursor regressed or changed kind. CPSC safety remained `safe=true`, 9/9 retained, zero hash-only and zero unaccounted.

## 8. Business-data diff

After the run: 87 notices, 100 scopes, zero owned products, pending matching work, matches, alerts, push queue/deliveries, reviewed criteria, all four v2 state classes, reconciliations, and leases. CPSC observations remained 109. Digests for semantic notice fields, scopes, CPSC identities, aliases, observations, retained payloads, sightings, matches, and alerts matched preflight exactly.

The **full** notice digest changed only because Health Canada refreshed `retrieved_at` and `updated_at` on five unchanged notices: external IDs **82681, 82682, 82683, 82686, 82689**. Each retained one scope. The notice digest excluding those two retrieval timestamps stayed `6fcd9478e6824676d9e8906734defd36`; no semantic content change was detected. Source sync timestamps and the automation run/state rows changed as expected for the natural cycle.

## 9. Identity, quarantine, and recall 26777

The nine known quarantines — **26749, 26750, 26752, 26753, 26754, 26756, 26763, 26764, 26766** — still each have one review item, a retained payload, and a database-verified payload hash. Their observation IDs and sighting counts were unchanged; the identity, alias, observation, payload, and sighting digests also matched preflight. Thus there was no canonical hijack, alias reassignment, duplicate review item, or reconciliation. Because CPSC fetched zero rows, this run did **not** exercise a quarantine replay; retained-payload reuse on a new replay remains unobserved in this cycle.

Recall **26777** kept identity `d3d6654d-cf54-4edf-a095-ff82cd5a15cc`, the existing canonical `Hazard-0` URL and notice ID, one unchanged page revision (hash `b2c466c0902b7910ca6c90ad625d3f576bbe1939fc198a057cfaf77d9b35586b`), and one existing page fetch. There was no page alias approval, page-derived reviewed criterion, or reconciliation. Its page redirect remains fail-closed evidence.

## 10. Friendly stale-watermark Edge audit and local proof

The deployed `ingest-recall-source` v4 still returns generic persistence failure for a stale request. The local proposal changes `supabase/functions/_shared/recallSources/validation.ts` and `supabase/functions/ingest-recall-source/index.ts`. This phase amended the latter's DB-error fallback so it returns **409** with stable `watermark_regression` or `watermark_invalid` and generic text, never the SQL error message. Preflight stale windows return **409 `watermark_regression`** before fetching. The DB trigger remains the final authority for races and wrong kinds; it was not weakened.

The local-only HTTP proof passed **10/10** checks across CPSC and Health Canada: missing key 401, stale date 409/`watermark_regression` with unchanged cursor, same-date 200, and forward-date 200. Those successful local requests fetched zero rows, so they prove the response and cursor persistence path, not content ingestion. Local unit tests reject a wrong cursor kind with `watermark_invalid`; the prior 34/34 rollback-only remote suite proved the DB rejects wrong kinds and backward movement while accepting same/forward values. The local Edge worker was stopped afterward.

In the deployed aggregate, a child 409 becomes a failed source and is recorded as such. A direct child preflight 409 does not itself persist a failed source attempt. Repeating a stale request stays fail-closed; a corrected same/forward request succeeds. For a persistence race after row processing, the guard blocks cursor regression, while CPSC replay deduplication and source idempotency support retry; the SQL fallback does not expose implementation details.

## 11. Aggregate visibility and minimal deployment candidate

Deployed `ingest-recall-sources` v1 has bundle hash `640d8a47490c217c7320f6d1df6ee20df15334728ef4968cee4dc4b9479424f3`. Its top-level `stats` lacks a complete five-way row outcome summary. The current repository bundle also changes date validation, watermark checks, and historical Health Canada adapter/client code; deploying it would ship unrelated behavior.

An isolated candidate at `/private/tmp/phase-16-19-aggregate-candidate` copies the deployed runtime bundle and changes only its aggregate entry point. The exact review patch is `audits/phase-16-19/aggregate-visibility.patch`. It adds `stats.outcomes={processed,unchanged,quarantined,unresolved,failed}`, validates each child outcome partition against `fetched`, and sums the five counters. Existing scalar counters, source status behavior, and all deployed runtime dependencies remain unchanged. Three type-only files omitted from the deployed bundle were supplied solely for local Deno checking. The candidate passed `deno check`. **It was not deployed.**

## 12. Legacy nine-argument RPC and historical backfill

Production `EXECUTE` on `public.record_cpsc_identity_observation(text,text,text,text,text,date,text,timestamptz,text)`: `service_role=true`, `anon=false`, `authenticated=false`, owner `postgres=true`. None of the seven deployed Edge bundles calls it. Local historical rehearsal scripts and pgTAP tests call it; the deployed owner-only `private.cpsc_backfill_apply(uuid,jsonb,text,integer)` calls it twice, for stored historical notices and frozen captured current API observations. That backfill function is executable by the owner, not `service_role`.

The smallest future permission reduction is **B: revoke direct `service_role` EXECUTE while keeping owner/internal execution**, after a separately reviewed migration and test updates. This does not retire the historical wrapper itself. A direct replacement with the retained-payload RPC is not a safe mechanical edit: stored notices have `raw_payload`, but frozen `currentObservations` carry hashes rather than full payloads. Reconstructing payloads or changing hash contracts could alter frozen manifest semantics, historical hashes, observation identities, idempotency, and audit reproducibility. Keep the compatibility function for historical runs until a separately versioned, hash-verified backfill path is proven. No grant or SQL changed here.

`observation_seq` is used in code for ordering, latest-observation selection, and ordered evidence output. Tests use `seen_count` for repeated sightings. Neither code nor tests treat sequence values as completeness, continuity, or exact sighting counts; rollback and deduplication gaps remain harmless. Nothing was renumbered.

## 13. Remote regression coverage

The production-safe Phase 16.17 rollback-only suite passed **34/34** in Phase 16.18. Review confirms explicit checks for retained payload reuse, DB hash verification, quarantine safety and hash-only blocking, backward rejection, same-value acceptance, forward acceptance, and both cursor-kind rejections. It also covers the automation watermark. No new remote test or production transaction was run solely to raise the assertion count; no coverage gap in the requested list requires local pgTAP additions now.

## 14. Local quality gates

`npm run check` passed TypeScript and Expo lint, then stopped only at the inherited `.claude/settings.local.json` Prettier warning; that file was not edited. All remaining unit/matcher and Phase 9.1/15/16 test, freeze, validation, and v2.1 safety scripts ran separately and passed. The v2.1 safety run reported 200 cases, zero unsafe confirmations, and zero provider calls. Separate TypeScript, all seven Edge Deno checks, candidate Deno check, and `git diff --check` passed. A targeted filename-only secret scan found no match. No paid benchmark or Nebius test was run.

## 15. Production mutation proof, remaining risks, and Phase 16.20

Every database query from this phase used `PGOPTIONS='-c default_transaction_read_only=on'`; function list/get calls and CLI list were read-only. Production history remained 24 migrations, the guard migration exactly once, cron active with the same schedule, and all seven function versions and bundle hashes unchanged after the cycle. The only production writes observed were those of the natural cron cycle: run/state timestamps and five Health Canada retrieval timestamps.

Remaining limits: live CPSC fetched zero records, so a fresh quarantine replay and a natural **forward** cursor were not exercised; forward behavior is covered by the prior rollback-only DB suite. The deployed child still lacks the friendly stale response; deployed aggregate visibility is incomplete; the legacy service-role grant remains; nine identities await human review; 26777 page evidence remains blocked; scheduled live CPSC page evidence is absent. Production matching stays `phase_10_guarded_v1`; deterministic v2 remains inactive.

**Phase 16.20 recommendation:** separately review a source-child-only friendly response bundle and the isolated aggregate visibility patch against deployed bytes, then decide whether either should be deployed. Plan an owner-only historical backfill compatibility test before any legacy grant reduction. Keep cron and v1 policy as-is; build and independently validate scheduled page evidence before considering v2 activation. Do not continue automatically.
