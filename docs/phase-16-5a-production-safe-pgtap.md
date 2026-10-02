# Phase 16.5A production-safe remote pgTAP gate

Status: **PASS; stop for review.** No v2 Edge deployment, cohort run, consumer read flag,
deliberate Nebius call, push, commit, or Git push was performed.

## Remote execution

- File: `supabase/tests/remote/phase-16-production-compatibility.sql`
- Command: `npx supabase test db --db-url "$SUPABASE_DB_URL" supabase/tests/remote/phase-16-production-compatibility.sql`
- Result: **1 file, 67 assertions, 0 failures, complete plan reached**.
- The file starts with `BEGIN`, sets transaction-local `lock_timeout = '2s'`,
  `statement_timeout = '20s'`, and `idle_in_transaction_session_timeout = '30s'`,
  and ends with `ROLLBACK`. It contains no `COMMIT`, `TRUNCATE`, production-object
  `DROP`, RLS disablement, or production-grant change. Supabase's
  [test runner](https://supabase.com/docs/reference/cli/supabase-test-db) also
  wraps each test in a transaction and rolls it back.
- The existing production `cpsc` source row was read only. The notice, users,
  products, matches, alerts, evaluations, and corrections existed only inside
  the rolled-back transaction. A fresh local reset has no `cpsc` source; only
  there, the suite inserts a UUID-backed synthetic source key.

The assertions covered seven v2 private tables with RLS, key uniqueness
constraints, RPC grants, stale revision and lease rejection, valid finalization,
pair/fingerprint replay, confirmed/review/rejected eligibility, alert snapshot
uniqueness, revocation of pending eligibility by rejection and delivered
eligibility by a newer unresolved observation, old v1/v2 alert preservation,
correction state, owner-filtered reads, non-owner and anon denial, service-role
worker calls, unchanged v1 status/fingerprint, and push isolation. Expected
permission failures were captured with `throws_ok`.

## Rollback and production state

Read-only snapshots were taken outside the fixture transaction before and after
the final remote run. The counts were identical:

| Table or queue          | Before | After |
| ----------------------- | -----: | ----: |
| Owned products          |      1 |     1 |
| V1 matches              |      0 |     0 |
| V1 alerts               |      0 |     0 |
| V2 evaluations          |      0 |     0 |
| V2 eligibility          |      0 |     0 |
| V2 alert snapshots      |      0 |     0 |
| V2 corrections          |      0 |     0 |
| Pending push deliveries |      0 |     0 |
| Push queue              |      0 |     0 |

The existing owned-product row fingerprint was
`61f7520c8d55b17ed9bfdf685242bad9` before and after. Each empty monitored
table had the same `d41d8cd98f00b204e9800998ecf8427e` fingerprint before and
after. Post-run aggregate scans found **zero** `pgtap_phase16_` fixture users,
notices, or products and zero `pgtap16_` source keys. The real `cpsc` source
count remained **1**. These snapshots, the SQL `ROLLBACK`, and the completed
pgTAP plan jointly establish that no fixture state persisted. Normal scheduled
Cron may still run independently; no count or fingerprint drift was observed
across this test window.

The two Phase 16.3/16.4 migrations are each present once in remote migration
history. Remote lint of `public`, `private`, and `extensions` after the test
reported **zero warnings and zero errors**. The deployed
`process-recall-matches` function remains version **10** with its existing v1
code; the deployed code has no v2 selector or v2 matcher import. Its effective
production path therefore remains `phase_10_guarded_v1`.
`run-recall-automation` remains version **3**. The manual
`process-recall-matches-v2-cohort` function is absent from the deployed
function list. No production v2 evaluation, alert, or push exists.

## Historical-suite classification

The dedicated remote file above is **category A: safe on a populated remote
database**. The following are **category B: local/disposable database only**;
they remain intact and continue to run in the complete local regression gate.

| Historical suite                                                 | Local-only assumption                                                                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `phase-10-recall-loop.sql`                                       | Fixed user/product/source IDs and source key, plus whole-table owner-visibility counts.                           |
| `phase-11-push-notifications.sql`                                | Fixed device tokens and IDs, fixture source key, and whole-queue counts.                                          |
| `phase-12-autonomous-monitoring.sql`                             | Inserts the globally unique literal `cpsc` source key and assumes empty automation/queue state.                   |
| `phase-13-global-product-model.sql`                              | Fixed fixture IDs, CPSC ingestion IDs, and `ensure_cpsc_recall_source()` setup intended for a reset database.     |
| `phase-14-global-recall-network.sql`                             | Uses local `postgres` role setup and updates the real `health_canada` source identity during active-source tests. |
| `phase-16-product-safety-evidence.sql`                           | Fixed users/products/source IDs and explicit local `postgres` role setup.                                         |
| `phase-16-4-full-path.sql`                                       | Inserts literal `cpsc`, uses fixed IDs, and expects global v2/private queue counts of zero.                       |
| `supabase/test-fixtures/phase-16-3-production-gate.sql.template` | Generated local gate uses fixed IDs/source key and is embedded in the local migration verifier.                   |

The earlier duplicate-CPSC failure is explained by the historical fixture
insertion of `source_key = 'cpsc'` against the already populated production
`recall_sources` table. Both the Phase 12 fixture and the Phase 16.4 full-path
fixture contain that literal insert; Phase 12 is encountered first in a
directory-order run. Production has exactly one legitimate `cpsc` row, and its
unique key constraint correctly rejected a second row. This is a fixture
collision, not evidence of an invalid production schema. The production row
was neither deleted nor modified.

## Local and repository gates

After the final suite change, `npx supabase db reset --local` passed and the
entire `supabase/tests` directory passed: **8 files, 386 assertions**. Local
lint of `public,private` passed with no schema errors. `npm run check` passed,
including Phase 16 tests, historical matcher suites, Phase 9.1/15/16 freeze
guards, and benchmark checks. Deno checked the Phase 16 matcher modules and
all relevant Edge entry points. `git diff --check` passed and the basic
credential/private-key pattern scan returned no matches. The Phase 15
validator now writes its generated audit JSON using the repository's Prettier
configuration, so repeated `npm run check` runs keep the file formatted.
This changes serialization only; benchmark and freeze semantics are unchanged.

## Remaining approvals

Any v2 Edge deployment, manual cohort run, consumer read flag activation, or
production selector change requires its own subsequent review and approval.
This gate stops before those actions.
