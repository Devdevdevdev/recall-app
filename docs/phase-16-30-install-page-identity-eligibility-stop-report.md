# Phase 16.30 — install page-identity eligibility gate + hash-checked manifest import — stop report

**Classification: GREEN.** Production now runs the Phase 16.29 page-eligibility gate:

- The reviewed migration and the reviewed worker are installed.
- The installed rule failed closed before the import, with all 38 identities blocked.
- One hash-verified manifest import then left exactly the rehearsed state:
  - 31 identities eligible
  - 26777 held for human page reconciliation
  - 6 identities blocked by unresolved quarantine

There was no page call, no valid worker-key use, no schedule, no reconciliation, no hold clearance, no v2 activity, no provider call, and no commit or push. The worker remains unscheduled. Stop for review.

## Status timeline (2026-09-29, UTC)

| #   | When        | Event                                                                                         | Actor           | Verified result                                        |
| --- | ----------- | --------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------ |
| 1   | ≈11:32      | Read-only production preflight through `psql` was denied by the auto-mode gate                | permission gate | nothing ran                                            |
| 2   | 11:36–11:42 | Preflight and fingerprints completed through read-only MCP (after user authorization)         | Claude          | all baselines match (§4–5)                             |
| 3   | ≈11:43      | `supabase db push --dry-run --linked`                                                         | Claude          | exactly one pending migration (§6)                     |
| 4   | ≈11:43      | `supabase db push --linked` denied by the auto-mode gate                                      | permission gate | not applied                                            |
| 5   | 11:44–11:46 | Manual `supabase db push --linked --skip-vault`                                               | user            | 29 migrations, 16.29 present once (§7)                 |
| 6   | 11:47–11:55 | Post-migration verification (read-only MCP)                                                   | Claude          | fail-closed, catalog equals reviewed build (§9–10)     |
| 7   | 11:56–12:00 | Rollback-only production suites (16.30 install suite, 16.26 regression)                       | user            | 215 / 215 and 172 / 172, rolled back, no residue (§11) |
| 8   | ≈12:01      | `npx supabase functions deploy process-cpsc-page-evidence --project-ref cnftnulgtsraurtusnpb` | Claude          | worker v5 → v6, byte-identical to candidate (§12–13)   |
| 9   | 12:01–12:03 | Unauthorized smoke; zero-processing and unscheduled proofs                                    | Claude          | all rejected; nothing processed (§14–15)               |
| 10  | 12:08:09    | Hash-gated manifest import, run once                                                          | user            | 1 hold (26777), runs 9–12 (§18)                        |
| 11  | 12:08–12:14 | Post-import verification (read-only MCP) and final local gates                                | Claude          | rehearsed state reproduced; all gates pass (§19–31)    |

Claude made **one** production mutation: the authorized worker deploy. The migration, the rollback-only suites and the manifest import were run by the user.

## 1. Worktree handoff

- Branch `main`. Nothing was reset, cleaned, committed or pushed, and all inherited work is preserved.
- Status went from 200 to 202 entries: this report plus `supabase/remote-install-checks/`. There are still 36 tracked modifications.
- The 16.29 report (`e1f9e09a…36ef`) and 16.28 report (`0f5bbd30…1e1f`) are unchanged.
- New in this phase:
  - this report
  - `supabase/remote-install-checks/phase-16-30-page-identity-eligibility-install.sql`, the production-safe rollback-only suite. It is deliberately outside `supabase/tests/` because it needs the real production manifest state and would fail on a clean reset.
- The local DB was left on a clean 29-migration reset.

## 2. Local artifact hashes (all exact full matches)

| Artifact                                                                        | SHA-256                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| migration `20260929110000_phase_16_29_page_identity_eligibility_provenance.sql` | `154b96b0bb4abfc6664ab0ecb17bbda0456cc34aef6fce843d0e48634eae3c4c` |
| `supabase/tests/phase-16-29-page-identity-eligibility.sql`                      | `5e23aae6f0691b56ae5fddad2fe2df9a768b316229684816f1e6e8299b48f87b` |
| `supabase/functions/_shared/cpsc/scheduledPageWorker.ts`                        | `6f8eeb9c8c57f9d9e9796a3e345ce15ee5b3bbcd78c7f285597f4a7ea9cce782` |
| `tests/phase-16-23-page-worker.test.mjs`                                        | `bdeb27e9ea6c9280d608c9a8f32f030994a83a68ad486ae399300bfa35aa6418` |
| `supabase/tests/phase-16-23-page-evidence-foundation.sql` (inherited edit)      | `9b92b4c0b9d4ad4159a87596bddf19db091c197d4128d51a38f98a27113c0218` |
| worker source set (9 files, 16.27 method)                                       | `9e6e318efc140a104d72c12bbc314ef98a4a2ebca1f29b723fc4942caaf54a02` |
| manifest `docs/phase-16-15-backfill-manifest.json`, file bytes                  | `e3ab192c397fa1a50ac5e34595358a7fe02a873e26c8891197d46c659487d9ed` |
| manifest canonical hash (`private.cpsc_canonical_json_sha256`)                  | `a8bce170402bc3470d73b4a338ea9f6da5df01e16d76429f8142496b6c273c3c` |

The worker source-set hash was rechecked immediately before the deploy. The migration's header comment still reads "local candidate … do not apply in production". It is part of the reviewed bytes and was deliberately not edited.

## 3. Local pre-install gates (clean reset, 29 migrations)

| Gate                                          | Result                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Full pgTAP                                    | **1893 / 1893**, 21 files                                                                                                          |
| Node                                          | **386 / 386**                                                                                                                      |
| Worker tests                                  | 15 / 15 (incl. the canonical-link → identity case)                                                                                 |
| Deno check (all entrypoints + `_shared/cpsc`) | exit 0                                                                                                                             |
| Expo `tsc --noEmit`                           | exit 0                                                                                                                             |
| DB lint `--level error`                       | 0 results                                                                                                                          |
| Freeze guards 9.1 / 15 / 16                   | all `frozen=true`                                                                                                                  |
| Backfill rehearsal (frozen 16.13 manifest)    | 26 / 26, digests `ea00243e…133f` / `1406161a…a909`                                                                                 |
| Deterministic v2                              | 0 unsafe of 200                                                                                                                    |
| v2.1                                          | 0 unsafe, 66 needs-review preserved, 0 provider calls                                                                              |
| 20163 exact raw replay (`--deny-net`)         | semantic hash, normalized, ledger, summary, both fingerprints equal; 0 candidates; section hashes differ as documented since 16.28 |
| `git diff --check`; secret scan               | clean; 0 hits                                                                                                                      |

- Page-fetch, claim-eligibility, hold, redirect, reconciliation-authorization, 26777, Intertex, Char-Broil, AGA and Friedrich coverage all sit inside these suites, as in 16.29.
- The deterministic runner rewrote `phase-16/results/deterministic-v2-all.json` (formatting and `generatedAt` only). It was restored byte-for-byte after each run, so all 19 result files are unchanged.

## 4. Production preflight (read-only MCP, 11:36 UTC)

| Check                  | Value                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Migrations             | 28, latest `20260928155514`; 16.29 absent; no 16.29 objects                                                                          |
| Worker                 | `process-cpsc-page-evidence` v5, bundle `0194da28…e41f`, `verify_jwt=true`                                                           |
| Cron                   | job 2 only, `17 */6 * * *`, active, command MD5 `07549bf9…097b6`, no page reference                                                  |
| v1                     | latest run 06:17 cron `success`; 0 automation leases                                                                                 |
| Sources                | CPSC `last_publish_date=2026-09-29` success; Health Canada `last_updated_date=2026-09-29` success; automation watermark `2026-09-29` |
| CPSC safety            | `safe=true`, quarantined 9 / retained 9, `unaccounted=[]`, `legacyHashOnly=0`; quarantine-set MD5 `21a70604…4050`                    |
| Page state             | 2 attempts, 2 work states, 1 raw payload, 1 ledger, 1 snapshot, 0 candidates, 27 revisions, 28 fetches; last claim 09:51:53          |
| Identity layer         | 38 identities (all `reconciled`), 282 aliases, 109 observations, 0 reconciliations, 0 capabilities, 0 reviewer authorizations        |
| Backfill provenance    | runs 9–12, all finished and unretracted, manifest `a8bce170…3c3c`                                                                    |
| v2 / review / business | rule sets, criteria, evaluations, eligibility, snapshots, corrections, evidence, matches, alerts, push queue and deliveries all 0    |

There was no unexpected page activity.

## 5. Production safety fingerprints

A deterministic read-only fingerprint covered:

- row count + MD5 over sorted row text for 53 tables: migrations, sources, notices, scopes, jurisdictions, matches, alerts, push, all v2 tables, automation and watermark state, and every `cpsc_*` table
- `cron.job`
- 10 catalog fingerprints: functions (definition + ACL + security definer + config), function ACLs, relations (kind + ACL + RLS), columns, constraints, indexes, triggers, policies, roles, schema usage
- the 26777 and 20163 identity, alias, observation and link rows
- the Intertex attempt, both work states, and the raw payload SHA

Key pre-install values:

- 26777 identity `465c3280…`
- 20163 identity `b93c26f8…`
- Intertex attempt `7f248918…`, work states `acefbe90…` / `76778f2c…`
- raw payload `646b4240…ed1e` (equal to the 20163 replay bytes)
- identities table `38 5a22365b…`
- attempts `2 9d04c73a…`

**Catalog proof:** production's pre-install catalog equals the local 28-migration build on all 10 catalog fingerprints.

## 6. Migration dry run

`supabase db push --dry-run --skip-vault --linked` listed exactly `20260929110000_phase_16_29_page_identity_eligibility_provenance.sql`, with `seeds=[]` and `roles=[]`.

## 7. Migration install result

- **Who ran it:** Claude's push was denied by the auto-mode gate; the user ran it manually.
- **Recorded once:** version `20260929110000`, name `phase_16_29_page_identity_eligibility_provenance`, present exactly once.
- **Exact artifact proof:** the stored statement array (40 statements, MD5 `0c53815c…2462`) is identical to the local record the same CLI parsed from the file hashing `154b96b0…3c4c`.
- **Prior migrations:** the 28 prior rows are byte-identical to the pre-install snapshot (`28 73db42cb…`).
- **No side effects:** no identity was reconciled, and no page attempt or fetch occurred.

## 8. Final migration count

**29.**

## 9. Pre-import fail-closed eligibility state (critical checkpoint)

| Blockers                                                       | Identities                                   |
| -------------------------------------------------------------- | -------------------------------------------- |
| `{backfill_page_provenance_unverified}`                        | 32                                           |
| `{unresolved_quarantine, backfill_page_provenance_unverified}` | 6 (26749, 26753, 26754, 26756, 26763, 26766) |
| eligible                                                       | **0**                                        |

This is the intended fail-closed state, not a defect. At that point there were 0 holds, 0 resolutions and 0 imports; identities were byte-identical, and page state was unchanged.

## 10. Schema / ACL verification

- **Catalog:** production equals the local 29-migration build on all 10 catalog fingerprints. The counts went from 131 to 141 functions, 194 to 210 relations, 47 to 56 triggers, 132 to 142 indexes, 389 to 412 constraints and 510 to 540 columns.
- **Worker:** executes exactly `claim_cpsc_page_evidence`, `commit_cpsc_page_evidence_verified`, `finish_cpsc_page_attempt` and `retain_cpsc_page_transport` among non-trigger security-definer functions. It has no direct table write privilege.
- **`anon` / `authenticated` / `service_role`:** cannot execute claim or verified commit.
- **`authenticated`:** can reach `resolve_cpsc_page_identity_hold` and `get_cpsc_page_identity_hold_packet`, both capability-gated inside. `anon`, `service_role` and the worker cannot.
- **Internals:** no API role or worker can execute the import, blockers, eligible, evidence or decision-authorized functions.
- **New tables and view:** `cpsc_page_identity_holds`, `cpsc_page_identity_hold_resolutions`, `cpsc_backfill_page_hold_imports` and the `cpsc_page_identity_eligibility` view grant no privileges to any API role or the worker. The tables have RLS on and 0 policies.
- **`private` schema:** no usage for anon, authenticated, service_role or the worker.
- **Triggers:** all 9 new triggers are enabled:
  - append-only update/delete and no-truncate on the 3 tables
  - hold preparation
  - resolution guard
  - `cpsc_hold_page_identity_redirect` on attempts
- **Ownership:** new functions are owned by `postgres`, with `search_path=''`.
- **Unchanged:** role attributes and schema ACLs are unchanged, so there is no privilege broadening.

## 11. Rollback-only production tests

The user ran both suites through `scripts/run-remote-pgtap.mjs` (transient pgTAP, final ROLLBACK):

| Suite                                                                              | Result                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `supabase/remote-install-checks/phase-16-30-page-identity-eligibility-install.sql` | **215 / 215**, `passed`, `rolledBack`, pgTAP after 0, idle-in-transaction 0, guards and migration history unchanged |
| `supabase/tests/remote/phase-16-26-page-failure-evidence.sql` (regression)         | **172 / 172**, same safety flags                                                                                    |

**What the 16.30 suite covers, all inside one rolled-back transaction:**

- **Catalog, RLS and ACL matrix.**
- **Pre-import fail-closed state:** a real worker `claim(10)` returned 0 rows.
- **Rehearsal of the real import:**
  - file SHA and canonical hash checked
  - service_role, authenticated, worker and a tampered manifest all refused
  - one-shot import, with DB-hashed hold evidence
- **Post-import reason accounting**, computed independently of the blocker function.
- **Fixture cases (numbers 29101–29107, sorting ahead of production):**
  - ordinary safe identity
  - notice inconsistency and unknown identity
  - `D_api_id_reuse` quarantine through the real gate, with the alias owner not over-blocked
  - `E_url_changed` URL conflict and linked-notice lineage conflict
  - free-text "human reconciliation" alias
- **Identity-changing redirect:** `identity_redirect` / `canonical_link_mismatch` becomes a bound hold, and a due held identity is not re-claimed.
- **Claim fairness:** earlier-sorting ineligible fixtures are skipped and the next eligible one is claimed, so there is no starvation.
- **Commit re-check:** the final semantic commit re-checks eligibility after a mid-claim flag.
- **Refused clearances:** an owner-forged resolution, service_role clearance or reconciliation, anon, a consumer, a criterion reviewer, and the worker were all refused.
- **Authorized path:** an `identity_reconciliation` holder can keep, clear (once only) and reconcile quarantines, on fixtures only; clearance changes no work state.
- **Append-only enforcement.**
- **Isolation, asserted before the rollback:**
  - the real 26777 hold was never resolved
  - no production attempt, work state, identity, alias, observation, link, reconciliation, fetch, ledger, candidate, match, alert, push, v2 or watermark change

**Before production:** the suite was rehearsed through the same harness on a production-shaped local DB (the 41 production notices plus the real 16.15 backfill), passing 215 / 215. The 16.26 suite passed 172 / 172 there too.

**Afterwards (12:00 UTC):** 0 fixture users or identities, 0 holds, 0 imports, pgTAP absent, and attempt and work-state MD5s unchanged, so there is no residue.

## 12. Worker deployment

|        | Version | Bundle SHA-256                                                     | verify_jwt |
| ------ | ------- | ------------------------------------------------------------------ | ---------- |
| Before | 5       | `0194da286210fa990a613e81e272adad273041ec7fee66fda6230a1772d2e41f` | true       |
| After  | **6**   | `c15d66238fef35bb425709b847593c2e6bc9f560b9f82d4ee784f2a60aa6f533` | true       |

- The deploy was `npx supabase functions deploy process-cpsc-page-evidence --project-ref cnftnulgtsraurtusnpb` (script 116 kB), and it was not blocked.
- No other function was deployed, and no secret was set or rotated.

## 13. Deployed-vs-reviewed proof

- **Before:** the deployed v5 source was downloaded before the deploy. It has the same nine files; eight are byte-identical to the candidate. `scheduledPageWorker.ts` was `d581ba00…` (the recorded pre-edit hash). The diff is exactly the reviewed catch branch: "canonical link contradicts" now ends as `identity_redirect` / `canonical_link_mismatch` instead of `unresolved_structure`.
- **After:** the deployed v6 source has 9 files, each **byte-identical** to the local candidate, and its deployed source-set hash is `9e6e318e…4a02`.
- **Environment reads:** only `CPSC_PAGE_DB_URL` and `CPSC_PAGE_WORKER_KEY`. There are no service-role, shared-DB-URL or provider references.

## 14. Unauthorized smoke

| Request                                   | Status | Body                                  |
| ----------------------------------------- | ------ | ------------------------------------- |
| GET, no auth                              | 401    | gateway `UNAUTHORIZED_NO_AUTH_HEADER` |
| POST, no auth                             | 401    | gateway `UNAUTHORIZED_NO_AUTH_HEADER` |
| GET, public client key                    | 405    | `Only POST is allowed.`               |
| POST, public key, no worker key           | 401    | `Unauthorized.`                       |
| POST, public key, random wrong worker key | 401    | `Unauthorized.`                       |
| PUT, public key, wrong worker key         | 405    | `Only POST is allowed.`               |

- The valid worker key was never known or used.
- The method and key checks precede any DB access.
- The public key was read from `.env.local` and never printed.

## 15. Proof of zero page processing

At 12:02 (after the deploy and smoke) and again at 12:08 (after the import):

- 2 attempts, 2 work states, 1 raw payload, 1 ledger, 1 snapshot, 0 candidates, 27 revisions, 28 fetches
- last claim 09:51:53
- attempt MD5 `9d04c73a…` and work-state MD5 `9c4e2f4d…`, identical to pre-install
- 0 worker holds (the only hold is the manifest hold)

The one non-null `claim_id` is the historical expired Intertex lease, and its row is unchanged.

**The worker remains unscheduled:**

- **Cron:** only job 2, command MD5 unchanged, no page reference.
- **DB side:** no DB function references the worker, and the pg_net queue is empty.
- **Deployed callers:** the deployed source of `run-recall-automation`, `ingest-recall-sources`, `ingest-recall-source` and `ingest-cpsc-recalls` was read in full. The automation calls only `ingest-recall-sources`, `process-recall-matches` and `send-recall-notifications`. `ingest-recall-sources` calls only `ingest-recall-source`. The other two make no function calls, and none references the page worker.

## 16. Manifest exact hash verification

- **File bytes:** `e3ab192c397fa1a50ac5e34595358a7fe02a873e26c8891197d46c659487d9ed`, checked locally and by the user before the import. It equals the 16.15 record.
- **Canonical hash:** `a8bce170402bc3470d73b4a338ea9f6da5df01e16d76429f8142496b6c273c3c`. It was recomputed by the DB function locally, asserted inside the production rehearsal, and gated the import transaction itself.
- **Three-way match:** this equals the production provenance hash of runs 9–12 and the 16.29 report.
- **Unmodified:** the manifest was not edited or regenerated.

## 17. Manifest import preview

This was the rollback-only rehearsal inside the 215 / 215 production suite, plus the same run on the production-shaped local DB.

- **Import report:** `unresolvedCount=1`, `holdsCreated=1`, `heldRecallNumbers=["26777"]`, `withoutIdentity=[]`.
- **After import:** 31 eligible; 26777 `{human_reconciliation_required}`; 26749, 26753, 26754, 26756, 26763, 26766 `{unresolved_quarantine}`.
- **Natural order:** led by 20164, with 26773 at 6.

## 18. Exactly-one import result

The user ran it once at **12:08:09 UTC** as a hash-gated transaction. The script checks the canonical hash, then either commits the import or rolls back.

```
{"holdsCreated": 1, "manifestSha256": "a8bce170402bc3470d73b4a338ea9f6da5df01e16d76429f8142496b6c273c3c",
 "backfillRunSeqs": [9, 10, 11, 12], "unresolvedCount": 1, "withoutIdentity": [], "heldRecallNumbers": ["26777"]}
COMMIT
```

- **Clean result:** unambiguous, with no retry.
- **Stray shell messages:** the `shasum: #: No such file…` lines in the user's terminal come from zsh not treating `#` as a comment, so the comment words were passed to `shasum` as filenames. They are harmless; the real hash line printed first and matched.
- **Persisted rows:** 1 import row (`manifest_sha256=a8bce170…`, `unresolved_count=1`, `holds_created=1`) and 1 hold:
  - id `2c89d188-695a-4031-8a29-dd16eeb14ba5`
  - identity `d3d6654d…`, number 26777
  - class `backfill_manifest_unresolved_identity`
  - `origin_manifest_sha256=a8bce170…`, evidence runs `[9,10,11,12]`
  - DB-recomputed evidence hash verified
- **No other effects:** no page was fetched, no identity was reconciled, no hold was cleared, no criterion was reviewed, and v2, watermarks, matches and alerts were untouched.

## 19. Post-import eligibility (computed from production)

| Blockers                          | Identities                               |
| --------------------------------- | ---------------------------------------- |
| `{}` (eligible)                   | **31**                                   |
| `{human_reconciliation_required}` | 26777                                    |
| `{unresolved_quarantine}`         | 26749, 26753, 26754, 26756, 26763, 26766 |

- **Hold consistency:** every identity with `human_reconciliation_required` is exactly one whose number carries a hold.
- **Quarantine consistency:** every identity with `unresolved_quarantine` is exactly one with a quarantined observation (by identity, number or URL) lacking any reconciliation.
- **No leftover provenance blockers:** 0 identities still show `backfill_page_provenance_unverified`.

Both consistency checks were computed independently of the blocker function, and the state matches the 16.29 rehearsal exactly. Nothing unexpected is blocked or claimable.

## 20. 26777 state

- **Unchanged rows:** identity `d3d6654d-cf54-4edf-a095-ff82cd5a15cc`, row MD5 `465c3280…`; 10 aliases `e1b8ab39…`; 3 observations `b88a44d8…`; 2 links `ece2490f…`. All are identical to pre-install.
- **No human action:** 0 reconciliations, 0 hold resolutions.
- **Not claimable:** it is excluded from the claim predicate by `human_reconciliation_required`.
- **Auditable:** its hold keeps the manifest entry, including the `-Hazard-0` → `-Hazard` redirect evidence and `requiredAction`.

## 21. Normal safe identity state

- **20163:** eligible (`{}`), with identity, aliases, observations, link and work state (`76778f2c…`) unchanged. It is not due until 2026-09-30 09:51:54 (normal retry timing), and no attempt was created.
- **Also eligible:** 20162 (Intertex), 26773 and the duplicate-group identities.

## 22. Natural queue order (read-only, at 12:10 UTC)

`1:20164 2:20165 3:26748 4:26755 5:26761 6:26773 7:26774 8:26775 9:26776 10:26778 11:26779 12:26780 13:26781 14:26782 15:26783 16:26784 17:26785 18:26786 19:26788 20:26789 21:26790 22:26791 23:26792 24:26793 25:26794 26:26796 27:26797 28:26798 29:26799 30:20162 31:20163`

- **Counts:** 31 eligible, 30 claimable now (20163 is not yet due).
- **Exclusions:** 0 blocked identities appear in the order.
- **Ordering:** ORDER BY is unchanged from 16.26, so there is no starvation.

## 23. Table-bearing target position

**26773 is still the first known table-bearing legacy target, at natural position 6** (6th claimable). The five ahead of it (20164, 20165, 26748, 26755, 26761) are zero-table pages. 26783 is at 15 and 26784 at 16. 26756 and 26766 stay excluded by quarantine.

## 24. Redirect-hold regression

- **Deployed worker (v6, byte-identical to candidate):** the local worker test "a page declaring another canonical URL is an identity question, not structure" passes (15 / 15).
- **DB, in production (rolled back):** a claimed fixture finished as `identity_redirect` / `canonical_link_mismatch` became a `worker_identity_redirect` hold bound to the attempt, with a DB-computed evidence hash. The identity stayed unclaimable while due, until an authorized human cleared it.
- There was no live page call.

## 25. 20163 state

- **16.28 evidence unchanged:** revision, fetch, ledger `00a1deaa…`, snapshot `d337206c…`, raw payload `646b4240…ed1e` and work state are all identical to pre-install.
- **Offline replay:** the exact retained 79,724 bytes under `--deny-net` reproduced the semantic hash `db375bbc…124a`, normalized evidence, ledger, summary, coverage FP `ae87afd9…9d93` and interpretation FP `be02286c…f4c6`, with 0 candidates.
- There was no new fetch.

## 26. Intertex state

Attempt `0bf98d4e-9c4b-42ce-a430-d20bfe97ac84` (row MD5 `7f248918…`) and its work state (`acefbe90…`) are unchanged. The attempt was not terminalized or repaired.

## 27. Watermarks / v1 state

- **Unchanged from pre-install through 12:08:** CPSC and Health Canada sync-state rows (`ba02e87e…`), automation state (`0821de41…`), automation runs (`54 e1fdebee…`), automation control, cron job (`77ffe3a0…`), notices, scopes, matches, alerts and push.
- **No natural cron activity overlapped** the install, deploy or import (06:17 → 12:17).
- **First natural run after install:** see the addendum below.

## 28. v2 / review / provider state

- **v2 and review:** rule sets, criteria, evaluations, eligibility, snapshots, corrections, evidence and legacy snapshots all 0; candidate criteria and the review ledger 0; reviewer authorizations 0; capabilities 0.
- **Providers:** no provider call anywhere. The worker bundle has no provider reference, and v2.1 safety made 0 provider calls.
- **Matching policy:** secret names were not listed in this phase because read authorization was MCP-SQL only. The effective policy is therefore not re-verified by secret listing. v2 remains inactive by every data measure, and `process-recall-matches` and `process-recall-matches-v2-cohort` are unchanged (bundles `81f96b1d…`, `682308bd…`). As of 16.28 the default `phase_10_guarded_v1` applied.

## 29. Full function hash audit

| Function                           | Version (before → after) | Bundle SHA-256            | Changed            |
| ---------------------------------- | ------------------------ | ------------------------- | ------------------ |
| `process-cpsc-page-evidence`       | 5 → **6**                | `0194da28…` → `c15d6623…` | **yes (reviewed)** |
| `ingest-cpsc-recalls`              | 20 → 20                  | `2b0774c5…0dc3`           | no                 |
| `process-recall-matches`           | 15 → 15                  | `81f96b1d…308d6b`         | no                 |
| `send-recall-notifications`        | 10 → 10                  | `58b6945b…11f5`           | no                 |
| `run-recall-automation`            | 7 → 7                    | `29aa1681…ef6c`           | no                 |
| `ingest-recall-source`             | 9 → 9                    | `ba394992…869d`           | no                 |
| `ingest-recall-sources`            | 6 → 6                    | `c41cb92e…aae6`           | no                 |
| `process-recall-matches-v2-cohort` | 5 → 5                    | `682308bd…1f1e`           | no                 |

There were no metadata-only version bumps in this phase.

## 30. Final production fingerprint

Diffing post-import against pre-install over the whole fingerprint set in §5, the only differences are the intended ones:

- **Catalog:** the 16.29 objects, equal to the local 29-migration build.
- **`schema_migrations`:** 28 → 29.
- **Holds and imports:** `cpsc_page_identity_holds` absent → 1 row; `cpsc_page_identity_hold_resolutions` absent → 0 rows; `cpsc_backfill_page_hold_imports` absent → 1 row.
- **Worker deployment:** code and metadata, as in §12–13.

**Everything else is byte-identical:** page attempts, raw payloads, coverage, snapshots, revisions, fetches, candidates, the review ledger, identities, aliases, observations, links, notices, scopes, reconciliations, capabilities, reviewer authorizations, matches, alerts, push, all v2 tables, source and automation watermarks, automation runs, and cron.

## 31. Final local quality gates (clean reset, 29 migrations)

| Gate                                      | Result                                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Full pgTAP                                | **1893 / 1893**, 21 files                                                                                                        |
| Node                                      | **386 / 386**; worker 15 / 15                                                                                                    |
| Deno / Expo tsc / DB lint                 | exit 0 / exit 0 / 0 results                                                                                                      |
| Freeze guards 9.1 / 15 / 16               | `frozen=true`                                                                                                                    |
| Historical backfill rehearsal             | 26 / 26, frozen digests equal                                                                                                    |
| Deterministic v2 / v2.1                   | 0 unsafe of 200 / 0 unsafe, 66 needs-review, 0 provider calls                                                                    |
| `git diff --check`                        | clean                                                                                                                            |
| Secret scan (diff, untracked, scratchpad) | 0 JWTs, keys, `sb_secret_`/`sb_publishable_` values, service-role assignments, worker-key values, or credentialed remote DB URLs |
| Benchmark churn                           | restored; all 19 result files equal the phase-start SHA list                                                                     |

The local DB was left clean-reset (29 migrations, 0 identities).

## 32. Classification: **GREEN**

- The exact migration is installed (statement-level proof), and the catalog equals the reviewed build.
- The exact worker is deployed (byte-identical, source set `9e6e318e…`).
- The installed rule failed closed before the import.
- The manifest was hash-verified three ways and imported exactly once.
- 26777 is blocked by the general rule, with its API identity untouched.
- Normal safe identities, including 20163, remain eligible, and the queue is fair.
- No page was processed, the worker is unscheduled, and the ACL and provenance boundaries hold in production (215 / 215).
- v1 is unchanged and v2 inactive, with no credential exposure.

## 33. Remaining risks

1. **No human can clear holds yet.** There are 0 `identity_reconciliation` capabilities. Worker `identity_redirect` outcomes will now accumulate holds; granting a capability is an owner action.
2. **26777 cannot succeed by clearance alone** while CPSC 301-redirects `-Hazard-0` → `-Hazard`. It needs a separately reviewed design for human-accepted redirect targets (16.29 risk 4).
3. **Quarantine scope** blocks two table-bearing pages (26756, 26766) whose URLs are not contested (16.29 risk 2).
4. **Spelling-only redirect hops** end as `internal_failure` with a 1-day retry. This fails closed but is noisy (16.29 §13).
5. **Unindexed eligibility scans** by number or URL in the per-row eligibility function: fine at 38 identities, but add indexes before large catalogs.
6. **Stale migration header:** the migration file still says "local candidate … do not apply in production". It is part of the reviewed hash; a follow-up can only document this, not edit the file.
7. **Matching policy not re-verified** by secret listing (§28).
8. **Tooling debt:**
   - the stale 16.24 replay harness
   - benchmark runners write in place
   - the new install suite is single-use by design: it refuses a post-import database
9. **Rollback:** the migration is forward-only. Reverting the claim and commit bodies re-opens 26777; the holds and the import are append-only audit records.

## 34. Phase 16.31 recommendation

Run **one separately authorized production shadow page through the NATURAL queue**, aimed at eventually reaching and validating a table-bearing legacy revision.

1. Recompute the queue read-only first. As of 12:10 UTC, 26773 is 6th (behind 20164, 20165, 26748, 26755 and 26761, all zero-table pages).
2. Decide separately, in that phase and not here, between:
   - **A.** processing natural pages one at a time over several reviewed phases, or
   - **B.** designing an explicitly reviewed one-shot safe-target override.
3. Keep out of scope: scheduling, v2, any reconciliation or hold clearance, and any capability grant.

## Addendum — first natural v1 cron after install

Checked read-only at 12:19 UTC. This is the first natural v1 run with 16.29 installed, the v6 worker deployed and the manifest imported.

**Run results:**

- **Cron:** job 2 fired at 12:17:00 and `succeeded`.
- **Automation run:** `success`, trigger `cron`, 12:17:03 → 12:17:09, window `2026-09-27`–`2026-09-29`, no error.
- **Run counters:** 0 seen, 0 inserted, 0 updated, 0 rejected, 0 candidate pairs, 0 alerts, 0 AI escalations, 0 provider failures.
- **Sources:**
  - CPSC `last_publish_date=2026-09-29`, `success` at 12:17:06, 0 fetched, all outcome counts 0.
  - Health Canada `last_updated_date=2026-09-29`, `success` at 12:17:08.
- **Automation:** watermark `2026-09-29`, 0 leases.
- **CPSC safety:** `safe=true`, 9 / 9, quarantine-set MD5 `21a70604…4050` unchanged.

**Natural v1 changes, isolated by timestamp:** automation runs 54 → 55; the two sync-state rows and the automation state row updated at 12:17. Watermark values are unchanged.

**Unchanged by the run:**

- identities (`38 5a22365b…`), observations (`109 a4ffb5a5…`), aliases (`282 6fb65ecb…`), notices (87)
- page attempts 2, work states 2, raw 1, ledgers 1, fetches 28, holds 1
- matches, alerts, push and v2 evaluations all 0
- eligibility still 31, with 26777 `{human_reconciliation_required}`

**v1 remains healthy after install.**
