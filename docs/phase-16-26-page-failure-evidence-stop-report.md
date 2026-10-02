# Phase 16.26 — first live page failure and terminal evidence

**Disposition:** Local repair candidate complete. No production page request, migration, function deployment, schedule, secret rotation, review decision, v2 run, provider call, commit, or push occurred in this phase. Stop for Phase 16.27 review.

## 1. Production failed-attempt confirmation

The one Phase 16.25 attempt, `0bf98d4e-9c4b-42ce-a430-d20bfe97ac84`, still belongs to identity `4c5f90a1-26ea-4468-a926-4f5e077ddabf` / recall `20162`. It remains `claimed`, with `completed_at`, `error_code`, raw link, revision link, and fetch link all null. Its lease expired at `2026-09-28 15:31:05 UTC`. The work-state still points to it and has `attempt_count=1`. This production record was not repaired or reclaimed.

## 2. Exact coverage rejection root cause

`private.cpsc_check_coverage_binding(uuid,jsonb)` in the Phase 16.13 migration raises **“CPSC coverage ledger does not account for every stored table”** when the number or identity of ledger table structures differs from the selected revision's `table_identities`. For this identity, production has one frozen `phase-16.9-v1` revision (`864c8b7a-2939-4aa9-a90d-8bf50804dd47`) with semantic hash `5be0f8816455971b19ba48ded825133baa5ae53013a65041adcbe37b769cbeed`, one table in `normalized_evidence`, and **zero** `table_identities`. Recomputing the current parser revision from that normalized evidence yields the **same** semantic hash and one table identity. The revision recorder therefore reuses the historical revision, whose empty structural metadata conflicts with a one-table ledger. The locally rehearsed Intertex backfill reproduced the exact error before the additive fix and accepted the same ledger after the fix, inside a transaction that was rolled back.

The Phase 16.25 raw bytes and attempted ledger were rolled back, so byte-for-byte equivalence to the live 15:30 UTC fetch remains unprovable. A fresh direct CPSC fetch was attempted locally but DNS was unavailable; no substitute HTML was represented as the live page.

## 3. Parser and table census comparison

The deterministic Intertex manifest and production normalized revision both contain one model table. Current parser and database hash computation independently agree on `description/table/0/6f3697c62ebe05214054ed28ba707b7c88532805fc54be5af0dcda93d8ec22b7`. The synthetic census of that frozen normalized fixture has one authoritative table structure and 13 authoritative/accounted records: 0 reviewable, 0 deferred, 1 unresolved, 8 unsupported, and 4 ignored non-safety. It yields `coverageStatus=unresolved`, `positiveStatus=blocked`, and zero candidates. This census is a local reconstruction from normalized evidence, not the missing live DOM census.

## 4. Historical revision compatibility

Historical `phase-16.9-v1` revisions were not rewritten. The new versioned structural snapshot is attached only when current parser, extractor, census, normalized evidence, semantic hash, and independently recomputed table/row identities agree. Semantic equality alone cannot attach live coverage. An incompatible parse rejects the semantic transaction. Owner-only historical replay retains the original binding path, preserving earlier test and backfill behavior.

## 5. Canonical census design

The worker computes one `semanticCpscRevision` object and passes it to `buildCpscSourceCoverage` / `interpretCpscPage`. Both revision metadata and ledger table identities now use that same object; the independent DOM census still determines authoritative row counts and anomalies. The database independently recomputes table identities from immutable normalized evidence before admitting a versioned snapshot. Its existing coverage validator remains fail-closed.

## 6. Terminal attempt contract

The worker uses existing `temporary_failure`, `identity_redirect`, `permanent_unsupported`, and `unresolved_structure` outcomes plus additive `evidence_rejected`, `database_timeout`, and `internal_failure`. Every post-claim branch attempts `finish_cpsc_page_attempt` in a separate statement. Failure codes are stable identifiers such as `semantic_commit_rejected`, `database_timeout`, `claim_inactive`, and `worker_exception`; raw SQL messages and SQLSTATE values are not public responses. Complete database unavailability remains an unavoidable exception to durable finalization.

## 7. Retry policy

`evidence_rejected` releases the claim, sets `manual_review_required=true`, and places `next_attempt_at` 100 years ahead. The claim RPC excludes that work-state until an audited owner action in a future phase. Database timeouts back off one hour, unexpected internal failures one day, unresolved structure seven days, and transient transport errors keep the existing bounded exponential backoff. No deterministic coverage rejection can hot-loop.

## 8. Raw transport evidence

The dedicated worker now calls `retain_cpsc_page_transport` immediately after validated official transport and exact final-URL identity, before parsing. This separate bounded statement verifies HTTP 200, canonical URL, HTML type, redirect chain, UTF-8, the 1 MB limit, and SHA-256; inserts or deduplicates immutable bytes; and links the claimed attempt to its SHA, final URL, status, type, redirect chain, and fetch time. It creates no semantic fetch. The prior raw table's immutable triggers, content-address check, and worker table-grant denial remain intact.

## 9. Semantic atomicity

`commit_cpsc_page_evidence_verified` requires the already-retained payload/hash and checks transport metadata again. Its revision, accepted fetch, structural snapshot, candidate, coverage, and success-state writes remain one transaction. A late coverage rejection rolls those semantic writes back while the earlier transport row and attempt link survive. Local pgTAP verifies zero partial revision, accepted fetch, ledger, or candidate after rejection.

## 10. Offline replay proof

The local failure test replays retained fixture bytes without a network call and reproduces the attempted semantic hash and coverage ledger exactly. Database pgTAP independently proves failed-attempt bytes remain byte-identical to the content-addressed payload. A production replay of the Phase 16.25 page is impossible because its bytes were never retained.

## 11. Public failure response

The candidate handler returns HTTP 502 when a page fails, with aggregate `claimed`, `completed`, `failed`, and stable `errorCategories`/`outcomes`. A one-page coverage rejection would report `claimed=1`, `completed=0`, `failed=1`, `evidence_rejected`. It does not return SQL errors, SQLSTATE, trigger/function names, schema details, or secrets. Local unauthenticated HTTP checks returned GET 405 and POST 401.

## 12. Expired claim recovery

The additive migration drops the old partial unique index on all `claimed` attempts. The identity lock and one work-state row serialize the current lease; a unique nonnull work-state `claim_id` index protects the active claim pointer. Recovery changes that pointer and inserts a new attempt **without changing the expired historical attempt**. Local pgTAP proves distinct old/new IDs and exactly one active work-state claim. A late worker may terminalize its own superseded attempt without altering the newer claim.

## 13. Existing production attempt policy

The Phase 16.25 attempt remains a `claimed` plus expired historical artifact, with no one-time administrative annotation proposed. Once this migration is separately approved and installed, a later explicitly authorized claim can proceed while the old row remains intact. Active attempts must be identified through the work-state `claim_id` and unexpired lease, not by `outcome='claimed'` alone.

## 14. Local credential incident mitigation

No production secret was exposed by the prior local `supabase status` output, and no production credential was rotated here. `scripts/safe-local-supabase-status.mjs` reports only Docker container names/health. The two operational scripts exercised in this phase now use the fixed local Docker database container and do not call or print `supabase status`. The disposable dedicated local worker password was generated for the timeout test, revoked to null, and then cleared by the final no-seed reset. Earlier exposed local-development keys are treated as non-private; they were not printed again. Other legacy scripts that capture `supabase status -o json` internally were not invoked here and should use the safe helper before future operational use.

## 15. Migration artifact

`supabase/migrations/20260928155514_phase_16_26_page_failure_evidence_and_coverage_compatibility.sql` — SHA-256 `e7f1da30ce3314b99f39d40e76190bf91c1285eacf8e7a290c900836c55bbae2`. It adds three transport columns and outcomes to `private.cpsc_page_attempts`, `manual_review_required` to `private.cpsc_page_work_state`, and append-only `private.cpsc_page_structural_snapshots` with RLS and no API policy. It creates the snapshot immutability triggers and current-claim index, removes the obsolete attempt-wide claimed index, adds canonical-table/snapshot/transport functions, and replaces the binding, claim, finish, atomic commit, and verified commit functions. Only `cpsc_page_worker` gains EXECUTE on the new transport RPC; direct table privileges and reconciliation/review/matcher/watermark capabilities are not broadened. Phase 16.23 and 16.24 migration files are unchanged. This migration was applied locally only.

## 16. Worker candidate

The nine-file ordered worker source-set hash is `3434b294c555348ad939a20f242c267e6a3eb6cf0dce11adb516c50b1d9a2c44`, computed as SHA-256 of sorted repository-relative `path<TAB>file-sha256<LF>` records for the Edge entry point and eight imported shared CPSC modules. The candidate adds canonical revision sharing, transport-first retention, stable terminalization, and aggregate public failure reporting. It was not deployed.

## 17. Authorization and role matrix

Local catalog and pgTAP checks confirm the dedicated worker can execute only claim, finish, verified commit, and the new transport-retention RPC. It cannot execute legacy direct revision writes, identity reconciliation, candidate review/materialization, matcher finalization, alert creation, or source watermark writes. Anonymous, authenticated, and service roles cannot invoke the new transport RPC. The worker has no direct raw-payload or structural-snapshot table privileges; both tables have RLS without API policies.

## 18. Clean local rebuild

`supabase db reset --local --no-seed` applied **28 migrations**. Final local state has zero recall notices, page work rows, attempts, raw payloads, and structural snapshots; the disposable page-worker login password is null.

## 19. Full pgTAP

**1,509/1,509 PASS across 19 files** on the clean local rebuild. The new Phase 16.26 file contributes 47 assertions. The pre-phase suite remeasures at 1,462 rather than the earlier reported 1,461; no inherited assertion was removed. A separate local timeout probe confirmed four-second PostgreSQL cancellation (`57014`), rollback, credential revocation, and expired-history-preserving recovery.

## 20. Intertex reproduction

The frozen Phase 16.13 manifest was rehearsed locally (26/26 checks; 89/89 compatibility assertions). Its rebuilt Intertex historical revision has one normalized table, zero stored table identities, and the production semantic hash. A rollback-only test using the current parser ledger reproduced the exact old coverage error, inserted the versioned structural snapshot, then passed binding validation. The transaction rolled back. The actual live HTML was unavailable and no claim was sent to production.

## 21. Worker regression tests

The full Node suite passed **385/385**. The focused page-worker file passed 14/14, including normal page, redirects, wrong recall, unsupported structure, 429/500 and transport failures, timeout, size/type/UTF-8 boundaries, page budget/concurrency, coverage rejection, database timeout, claim-inactive classification, terminalization, raw retention, and offline replay. Char-Broil, AGA, and Friedrich fixtures remain covered by the existing parser/coverage tests.

## 22. Historical and v2 safety gates

Phase 9.1, Phase 15, and Phase 16 freeze guards passed. The Phase 9.1 holdout replay had zero false positives. The deterministic v2 replay covered 200 cases with zero unsafe confirmations, and v2.1 safety covered 200 cases with zero unsafe confirmations, 66 needs-review cases preserved, and zero provider calls. The frozen Phase 16 result file was restored to its exact pre-run SHA-256 `be1961c323b5c9cd690ac1181804a9b289f8f1fda32d7d1a7335b7b8041e37c1` after the replay command refreshed its timestamp; the freeze guard passed again. No frozen historical evidence was intentionally changed.

## 23. Other quality gates

Database lint: zero errors. Deno checks: passed for the changed worker and shared modules. Expo TypeScript check: passed. Prettier and `git diff --check`: passed. Local HTTP method/auth checks: 405/401. Targeted credential-pattern scan: zero findings across 13 changed/new operational artifacts. No raw CPSC HTML or generated credential was committed.

## 24. Final read-only production state

Read-only checks at `2026-09-28 21:00 UTC` showed exactly one page work row and one attempt, both the inherited failed claim; 27 historical page revisions and 27 fetches; zero raw payloads, coverage, candidates, review entries, reviewed criteria, v2 evaluations/eligibility, matches, alerts, or push work. Production still has 27 migrations and no Phase 16.26 structural-snapshot table. No page cron exists. The original v1 cron remains active at `17 */6 * * *`; its normal 18:17 UTC run succeeded, watermarks remain `2026-09-28`, and CPSC safety remains true with 9/9 quarantine payloads retained. The deployed page worker remains version 2 with unchanged bundle SHA-256 `e6170ed62766b22d5630e9a1028834552147dabbca5413bdbe22b3a8c316d50f`. No second page attempt was made.

## 25. Phase 16.27 readiness recommendation

The local candidate is ready for an independent review of the migration, privilege boundary, and worker failure flow. Production migration, inactive deployment, and any new bounded page invocation require a separate authorized phase with a fresh preflight. Keep page evidence unscheduled, v1 active, and v2 inactive. The missing Phase 16.25 raw bytes remain the principal replay limit; the first future page run should verify the new transport-first and terminal-attempt contracts before any scheduling decision.
