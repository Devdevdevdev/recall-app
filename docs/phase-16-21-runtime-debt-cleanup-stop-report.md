# Phase 16.21 stop report — A deployed; A smoke gate incomplete

**Disposition (2026-09-27 19:30 UTC):** Stop for review. Candidate A was deployed as `ingest-recall-source` v5. Its authenticated production smoke checks could not be completed with the credentials available in this workspace. Candidate B was not deployed and migration C was not applied. No commit or push was made.

## 1. Worktree and candidate provenance

The existing `main` worktree was preserved: 36 tracked modified files and 142 untracked paths before this report, with `git diff --stat` showing 993 insertions and 239 deletions. No reset, cleanup, historical migration rewrite, identity reconciliation, v2 activation, manual automation, manual source ingestion, or Nebius call occurred. This report is the only repository file created in Phase 16.21.

The Phase 16.20 candidate manifest was rechecked. A's candidate entry point SHA-256 is `1a7e80b2fe2876015eef963feaed2f319b515619c31b3489e0061398706c53bc`; its complete runtime source graph is `98e692acf99a135e1cc76ec1396934ca2bd5b11877388c1ef8ec68c2a2adcc3f`. B's entry point is `3b0265491c3c6a43b3011b1d99dda27b9056f0b8ac640aa06f116b3ff646a251`; its runtime source graph is `52583b3ebc279a979b2ef290c3546f20e6246f92e1fc48dba598234bc84d25bb`. All four match the Phase 16.20 manifest. C's migration SHA-256 matches `c7329a6b652cbf6a7bcd62d5c9d3aeae3b2516003c59f2c41ad6f586d0997136`.

## 2. Production preflight

Project `cnftnulgtsraurtusnpb` was healthy. Cron job 2 was active at `17 */6 * * *`; latest natural cron run 43 succeeded. Latest automation `29a364b7-7de3-47cc-ac26-4c36998fc01d` succeeded with zero candidate pairs, alerts, provider failures, and push work. Both CPSC and Health Canada source states were successful without error. Their typed watermarks and the automation watermark were `2026-09-27`.

`private.cpsc_watermark_safety()` returned `safe=true`: nine quarantines, nine retained payloads, zero legacy hash-only, and no unaccounted observation. Reviewed criteria, v2 evaluations, matches, alerts, push queue, push deliveries, and leases were zero. Production had 24 migrations; C was absent. Direct `service_role` EXECUTE on the legacy nine-argument RPC was still true; `anon` and `authenticated` were denied; owner `postgres` retained EXECUTE.

All seven preflight Edge versions and bundle hashes matched Phase 16.20. In particular, child v4 was `0a78e498551c9ff33142827dfaae899cc46119be92e959dcf80cfab2caab1f8e` and aggregate v1 was `640d8a47490c217c7320f6d1df6ee20df15334728ef4968cee4dc4b9479424f3`.

## 3. A: exact deploy diff, tests, version, and smoke

The isolated candidate A graph was deployed. Compared with the preserved, byte-verified v4 entry point, the runtime diff adds one import of the dedicated watermark DB-error classifier and replaces only the `record_recall_source_sync_result` error response. The new helper recognizes SQLSTATE `23514` plus the exact backward-watermark guard message as `409 watermark_regression`, and the exact wrong-kind messages as `409 watermark_invalid`. Other DB failures retain a generic 500 response. No registry, Health Canada, validator, source definition, or unrelated dirty local runtime file was included. The 35 typecheck-only dependencies are not runtime imports.

Focused candidate tests passed **10/10**, including backward/same/forward watermark behavior, wrong kind, unrelated DB error, sanitization, and the B arithmetic cases. The tested backward case leaves the mocked persisted cursor unchanged. The database trigger remains the production authority for a live regression.

`ingest-recall-source` deployed from v4 to **v5**. New `ezbr_sha256`: `ba3949921003fdc94e0f9ecd16fe088ba24b515b7b0fd69df16319f2084d869d`. Candidate runtime source graph: `98e692acf99a135e1cc76ec1396934ca2bd5b11877388c1ef8ec68c2a2adcc3f`.

Post-deploy unauthenticated HTTP checks reached the live function: GET returned `405 {"error":"Only POST is allowed."}` and POST returned `401 {"error":"Unauthorized."}`. The workspace has no `RECALL_INGESTION_KEY`, so an authenticated normal dry-run could not be sent. A live stale-watermark request could process source records before the final DB guard rejects the cursor, contrary to the bounded, non-destructive smoke requirement. Thus the live 409 response and unchanged persisted watermark were **not** directly verified. This incomplete A smoke gate is the reason for stopping here.

## 4. B: prepared but not deployed

The exact Phase 16.20 B candidate and its graph hash were reverified. Its isolated entry-point patch adds `stats.outcomes` with processed, unchanged, quarantined, unresolved, and failed, plus `accountedRecords` at aggregate and per-source level. It preserves the legacy `fetched` meaning and child request contract. The six aggregate scenarios and inconsistent-accounting guard passed within the 10 focused tests. The production aggregate remained v1; no B HTTP behavior was tested against production.

## 5. C: prepared but not applied

The reviewed file is `supabase/migrations/20260927190041_phase_16_20_restrict_legacy_cpsc_observation_rpc.sql`, SHA-256 `c7329a6b652cbf6a7bcd62d5c9d3aeae3b2516003c59f2c41ad6f586d0997136`. It only revokes direct `service_role` EXECUTE on `public.record_cpsc_identity_observation(text,text,text,text,text,date,text,timestamptz,text)`; no migration was applied in this phase.

The Phase 16.20 caller audit remains the last completed audit: no deployed Edge entry point calls the nine-argument RPC directly; the retained-payload wrapper and owner-run historical backfill still call it internally. The obsolete Phase 16.11/12/13 local HTTP smoke scripts still expect direct worker execution and were not updated because this phase stopped at A. No linked DB push dry-run, immediate privilege check, production historical rollback-only validation, or remote pgTAP ran. The final production grants remain the preflight grants: direct `service_role` and owner EXECUTE true, `anon`/`authenticated` false.

## 6. Final production state and quality

Only `ingest-recall-source` changed (v4 to v5). The other function versions remained: `ingest-cpsc-recalls` 16, `ingest-recall-sources` 1, `run-recall-automation` 3, `process-recall-matches` 11, `send-recall-notifications` 6, `process-recall-matches-v2-cohort` 1. Their bundle hashes were unchanged in the final listing. Production migration count remained 24.

Final read-only checks showed cron active on the expected schedule, run 43 still latest and successful, automation successful, source and automation watermarks unchanged at `2026-09-27`, CPSC `safe=true` with nine retained quarantines, zero reviewed criteria, zero v2 evaluations, and zero matches, alerts, or push work. No natural cron cycle occurred during this work window. The matching policy was not changed; no v2 cohort was invoked. No unrelated production function or schema change was observed.

Local checks this phase: focused candidate tests **10/10 PASS** and `git diff --check` **PASS**. The broader `npm run check`, separate TypeScript/unit/freeze/safety/Deno/DB gates, remote pgTAP, database lint, and secret scan were not rerun after the A smoke gate remained incomplete. Phase 16.20 records their prior results, including the inherited `.claude/settings.local.json` formatting warning.

## 7. Remaining risk and Phase 16.22 recommendation

The deployed A response mapping is covered by simulated HTTP tests but lacks an authenticated production dry-run and a safe live proof of the 409 response. Arrange a narrowly scoped, authorized smoke mechanism that can exercise the guarded response without writing arbitrary source records, then verify the source watermark stays unchanged. Recheck the live A version, cron, and safety state before that check. Once A's gate closes, review B's exact bundle and C's obsolete smoke-test expectations and caller graph independently. Keep cron active and production matching at `phase_10_guarded_v1`; scheduled live CPSC page evidence still does not support v2 activation.

**Stop for review. Do not continue automatically.**
