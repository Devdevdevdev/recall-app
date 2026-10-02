# Phase 16.17 stop report — forward-only watermarks and remote regression coverage

**Status:** prepared and validated; stopped for review. The migration was **not applied** to
production. No Edge Function was deployed, cron was not paused or triggered, no CPSC identity was
reconciled, no v2 policy was activated, and nothing was committed or pushed.

## 1. Worktree handoff

The checkout stayed on `main` in `/Users/stephaneds/Projects/RECALL`. At handoff, 35 tracked files
were modified and the extensive Phase 16 migrations, tests, scripts, benchmarks, and reports were
untracked. `git diff --stat`, the full diff of the two ingestion functions, and the untracked file
list were inspected before editing. No inherited file was reset, cleaned, or discarded. The earlier
16.16C report describes the same inherited dirty tree. There is no independent pre-handoff hash
snapshot, so byte-for-byte absence of intervening changes cannot be proven.

## 2. Read-only production preflight

At 12:4x UTC the `Recall` project was healthy. Cron job 2,
`recall-automation-every-6h`, remained `17 */6 * * *`, `active=true`. The latest automation run
was the naturally scheduled `add1e6fe` at 12:17 UTC, `success`. Automation and matching leases,
running automation, pending recalls, owned products, matches, alerts, push queue, and push deliveries
were all zero. CPSC and Health Canada source states were both `success` at `2026-09-27`;
automation watermark was `2026-09-27`. `private.cpsc_watermark_safety()` returned `safe=true`,
9 quarantined, 9 retained, 0 hash-only. Reviewed criteria, review ledger, reconciliations, and
checked v2 tables were zero. Production migration history ended at `20260926210000`.

Function versions were unchanged: `ingest-cpsc-recalls` 16, `ingest-recall-source` 4,
`ingest-recall-sources` 1, `run-recall-automation` 3, `process-recall-matches` 11,
`send-recall-notifications` 6, and inactive-path `process-recall-matches-v2-cohort` 1.
The production matching policy remains the handed-off `phase_10_guarded_v1` state; this phase did
not inspect or change function environment variables.

## 3. Complete watermark write graph

| State                                                       | Normal writer                                           | Caller / route                                                                                                                                  | Other write paths                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `private.recall_source_sync_state.watermark`                | `public.record_recall_source_sync_result` in Phase 14   | `ingest-recall-source` direct POST; `ingest-recall-sources` calls that POST for each active source; `run-recall-automation` calls the aggregate | Phase 14 migration bootstrap from the automation watermark; an owner could directly edit the table; Phase 16.16 `cpsc_guard_watermark_advance` checks CPSC retention; Phase 16.17 adds `guard_recall_source_watermark_forward`. No backfill/reconciler code writes this column. |
| `private.recall_automation_state.last_successful_watermark` | `public.record_recall_automation_ingestion` in Phase 12 | `run-recall-automation/store.ts` after aggregate ingestion                                                                                      | Phase 12 initial row and an owner direct edit; Phase 14 reads it for initial CPSC state; Phase 16.17 adds `guard_recall_automation_watermark_forward`. No other Edge Function writes it.                                                                                        |

The legacy `ingest-cpsc-recalls` function writes notices but not either watermark. The source
aggregate reads a typed source cursor to calculate its bounded overlap window; its child function
is the actual source-state writer. A source `failed` result calls the same RPC with no committed new
cursor. Tests and rollback-only fixtures call these RPCs inside transactions; they are not normal
production writers.

## 4. Current cursor semantics and comparison

Each source adapter returns `{kind, value: request.endDate}` after a successful complete run, even
when the official window is empty. CPSC uses `last_publish_date`; Health Canada uses
`last_updated_date`. Values are canonical `YYYY-MM-DD` strings serialized into JSONB. The names
describe the source window axis; the value is the **successful requested end date**, not the
maximum date seen among returned records. The old Phase 14 RPC replaced a successful cursor
unconditionally, so a manual earlier `endDate` could regress it.

The new database guard checks exactly two keys, the source's expected kind, a string value, a
calendar-valid ISO date, and date ordering. `2026-09-27` is accepted; a timestamp, another date
format, an extra key, a missing value, or another source kind fails closed rather than comparing
lexicographically. Both old and proposed non-null cursors are validated. A null prior cursor may
bootstrap from a valid typed date. Once established, null cannot clear it through normal ingestion.
Unexpected future source keys require an explicit comparison policy in a later migration.

## 5. Forward-only contract and DB design

Normal source ingestion accepts `new > old` and `new = old`, and raises SQLSTATE `23514` for
`new < old`. It does not rewrite the requested date. The Edge child validates the window and
state before fetching, returning HTTP 409 with `watermark_regression` or `watermark_invalid` for a
stale or malformed existing cursor. A concurrent race is still stopped by the table trigger;
recognized trigger errors return HTTP 409. The aggregate also checks stored kind and date before
calculating its overlap. Source row identity changes are rejected.

`private.recall_automation_state.last_successful_watermark` is a **date window** cursor, not the
maximum of differently typed source cursors. The Phase 12 writer retains its
`greatest(old, run.window_end)` rule. A new table trigger enforces the same monotonic rule against
direct or future writers, including null clearing. It does not couple CPSC and HC semantic kinds.

The additive migration creates two private trigger functions and two table triggers; it changes no
grants except revoking default execution on those private trigger functions. The existing CPSC
retention guard stays in place. Normal workers have no direct table grant and no bypass.

For a future intentional backward reset, use a **separate reviewed operator migration** with an
explicit reason and audit row recording operator, source, old/new cursor, and time. An owner-only
transaction can temporarily replace the guard, perform the reset, restore the guard, and commit
with the audit record. Do not expose that operation to `service_role` or make it a worker option.
No reset path was created or used in 16.17.

## 6. Backward, same, forward, failure and retention tests

The focused local pgTAP suite tested bootstrap, direct database update, both source kinds,
backward/same/forward dates, malformed objects, invalid calendar dates, attempted null clearing,
failed-run no-advance, and automation monotonicity (24 assertions). The full prior Phase 16.16
suite still tests durable retention and row accounting. `sourceRunComplete` requires every fetched
row to be processed, unchanged, quarantined, or unresolved with confirmed retention; `failed`
blocks advancement. The existing `cpsc_guard_watermark_advance` still rejects a hash-only
quarantine. The new guard does not weaken this gate.

Real **local** HTTP with a 2026-09-27 cursor confirmed for both CPSC and HC: missing ingestion key
401; 2026-09-17 request 409 `watermark_regression` and unchanged cursor; same date 200; next
date 200 and forward cursor. The same/forward windows were empty (fetched 0, rejected 0), so they
verify cursor behavior on a successfully completed empty ingestion, not a populated fetch.
The script rejects any non-loopback Supabase URL. Local HC was activated only in the disposable
local database. pgTAP additionally verifies service-role and reviewer/reconciler boundaries.

## 7. Permanent remote pgTAP coverage

`supabase/tests/remote/phase-16-17-watermark-and-retention.sql` is a standalone
`BEGIN … ROLLBACK` suite with 34 assertions and transaction-only fixtures. It checks the durable
payload and DB-computed hash, duplicate-sighting dedupe, changed-payload revision preservation,
worker-only writer, worker reconciliation denial, criterion reviewer denial, authorized reconciler
packet and hash verification, retained-quarantine safety, hash-only block, failed-run no-advance,
both sources' backward/same/forward cursors, kind rejection, and automation rollback prevention.
The existing remote compatibility suite remains separately runnable. The runner now accepts an
exact migration file for a rollback-only compatibility rehearsal and verifies that pgTAP, triggers,
and migration history match their prior state afterward.

## 8. Legacy RPC, aggregate visibility, sequence gaps, HC refresh

The old nine-argument `public.record_cpsc_identity_observation` still has a `service_role` grant.
All seven deployed Edge Function bundles were inspected: none directly calls it; the two live
ingestion paths use the retained ten-argument wrapper. **One deployed database caller remains:**
`private.cpsc_backfill_apply`, reachable through the owner-only historical backfill workflow.
Local historical rehearsal scripts and pgTAP also call the old RPC. It is not part of the cron
path, but the grant and function were intentionally left intact. Retirement requires a separate
backfill decision and a proved caller migration or deprecation.

`ingest-recall-sources` v1 omits quarantined/unresolved from top-level aggregate metrics; its
per-source response is authoritative. The local index includes the small count change. The
deployed index equals repository `HEAD`, but the local bundle also differs in CPSC validation,
the new cursor validator, and Health Canada adapter/client. Deploying the local bundle would
therefore ship more than the aggregate count fix. This remains a later deployment decision.

`observation_seq` is used for ordering/latest-revision selection and ordered evidence output,
never to assert completeness, continuity, or an exact event count. At final read-only inspection
there were 109 stored observations with max row sequence 429 and 37 payload revisions with max
row sequence 40. Rollback-only fixture inserts advance PostgreSQL identity sequences despite row
rollback: the final test moved sequence heads from 437 to 442 and 47 to 51. No rows were
persisted. Gaps are harmless for the current ordering contract; no historical rows were
renumbered.

On an unchanged Health Canada notice, Phase 14 still updates `retrieved_at`, which also refreshes
`updated_at` through the existing notice timestamp behavior. Content, scopes, and jurisdictions
stay the same. A future content fingerprint must exclude transport/retrieval timestamps and
compare semantic notice fields or the ingestion outcome. This phase did not change that behavior.

## 9. Migration, local gates, and production rehearsal

- Migration: `supabase/migrations/20260927124132_phase_16_17_forward_only_watermarks.sql`
- SHA-256: `dc2e58e30f1b6aef6e814390e32a9a0a5b7d3f55bdf080ee59f346482a908e3b`
- Objects: `private.guard_recall_source_watermark_forward()` and
  `private.guard_recall_automation_watermark_forward()` plus one trigger on each state table.
- Rollback implication: if deployed, a reviewed rollback would remove the two triggers and
  functions, restoring the old ability to regress a cursor. The migration itself was not deployed.

A clean local `supabase db reset --local --yes` applied the entire migration chain with no manual
patch. Final `supabase test db`: **16 files, 1,320 assertions, all PASS**. Final local DB lint:
no findings. Deno checked all seven Edge Function entrypoints. `git diff --check` and a targeted
new-file secret scan were clean. Typecheck and lint passed. The Phase 9.1, Phase 15, Phase 16,
and v2.1 safety/freeze gates passed, with **0 unsafe confirmations** and no provider calls.
`npm run check` itself stopped at the inherited `.claude/settings.local.json` Prettier warning,
which the 16.16C report also recorded and which was left untouched. Every remaining command in
`check` was run separately; the one historical test that assumed no migration could follow 16.16
was scoped to the 16.16 interval and then passed. All other commands passed. Prettier checks of
the edited Phase 16.17 code passed.

After those gates, the exact migration body and new remote suite ran in a single production
transaction with temporary pgTAP and a final `ROLLBACK`: **34/34 PASS**, psql exit 0. pgTAP was
absent before/after, no session remained idle in a transaction, both new triggers remained absent,
and migration history stayed absent. This was a compatibility rehearsal, not deployment.

## 10. Final production state, risks, and Phase 16.18

Source-state, observations, retained payloads, CPSC identities, notices, and alerts had identical
before/after MD5 fingerprints. Both source watermarks stayed at 2026-09-27. Cron stayed active,
the same deployed versions remained, CPSC safety stayed true with 9/9 retained, and the new
migration, triggers, and pgTAP remained absent. The only sequence-state change was the expected
nontransactional consumption described above. No naturally scheduled cron cycle occurred during
this phase; the next 18:17 UTC tick was outside the observed interval. The latest observed run
remains the successful 12:17 UTC cycle.

Remaining risks: the forward-only guard is only prepared until a later deployment gate; the
legacy nine-argument RPC remains available; aggregate visibility remains undeployed; nine CPSC
identities still await separate human reconciliation; and live CPSC page evidence is absent from
the scheduled production path. Do not activate deterministic v2 or call the system v2-ready.

**Recommendation for Phase 16.18:** review and apply the single forward-only migration in a
separate controlled deployment, then deploy the compatible Edge validation with a reviewed bundle
diff. Retest a manual stale window and a naturally scheduled cron cycle read-only. Keep aggregate
visibility and legacy RPC retirement as separate decisions, and retain the live-page-evidence
blocker before any v2 production cohort.
