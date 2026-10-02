# Phase 16.13 stop report: extraction completeness, fresh CPSC capture, review operations

Status: implemented and verified locally only. No production migration, backfill, deployment, live
production page ingestion, reviewer grant, review decision, reconciliation, cohort, selector
change, consumer v2 read, v2 push, Nebius call, commit, or push. Supabase MCP was used read-only
(SELECT / list calls only). deterministic_v2 stays inactive.

Two findings need a decision before Phase 16.14 (details in §12, §27, §28):

1. **Recall 26777's official page moved.** The CPSC API still reports the `…-Hazard-0` URL. That
   URL now returns HTTP 301, and the page it redirects to declares a different canonical URL. The
   entry is marked unresolved and its current observation is withheld from the manifest.
2. **Production has moved on since the manifest's baseline.**
   - It holds 41 CPSC notices, not 30: the live Phase 12 monitor has ingested 11 new recalls. All 11
     are clean (no drift, no collision).
   - Applying 16.10 cuts the deployed CPSC ingestion off (it fails closed), while the 6-hourly cron
     keeps calling it.

## 1. Worktree handoff audit

- Same worktree. Nothing was reset or discarded. The 33 modified tracked files and every untracked
  Phase 16 file from 16.12 are preserved.
- Accepted migrations are byte-identical before and after this phase:
  - 16.9 `615c88ca…5b7`
  - 16.10 `89a96abc…0540`
  - 16.11 `4e8589be…c0ce`
  - 16.12 `45da9c3a…4651`
- New files:
  - the migration and one pgTAP file
  - one Node test
  - scripts: HTTP proof, fresh capture, manifest builder, rehearsal
  - `sourceCoverage.ts`
  - three docs artifacts (capture, manifest, diff) and this report
- Edited production code: `htmlExtractor.ts` (additive census), `pageEvidence.ts`
  (interpreter + parser version), `pageIngestion.ts`, `ruleSetsV2.ts`, `package.json`.
- Edited tests. Superseded assertions were edited, never deleted:
  - the 16.12 pgTAP file
  - the remote-safe file
  - the 16.11, 16.12, and 16.4 Node tests

## 2. Extraction-completeness architecture

The problem was that coverage counted only what the parser noticed. Reading the parser against the
30 captured pages exposed more than the "N-1 rows" case. Every one of these made evidence disappear
silently:

| Silent-loss path (pre-16.13)                                           | Now                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| a table with no recognised model column was skipped (`continue`)       | every row gets `unsupported` (additive or restrictive)      |
| models listed in prose (Friedrich; also 26763, 26754, …) never counted | identifier-bearing sentences are `unresolved` (additive)    |
| description text outside `<p>` and `<table>` (e.g. `<ul>`) was dropped | census region `description/unaccounted`, restrictive        |
| `<tr>` with no cells was dropped by `tableRows`                        | census counts it; record `unresolved` (extraction `failed`) |
| nested-table rows were merged into the outer table                     | census anomaly `nested_table` / `row_count_mismatch`        |
| tables in recall details outside the description were ignored          | census region `recall-details/tables`, restrictive          |
| a restriction-only / unknown-column table did not block other tables   | restrictive blocker suppresses every positive on the page   |

The design has three layers:

1. **Independent census** (`extractCpscPageStructure` → `CpscStructureCensus`,
   `phase-16.13-census-v1`).
   - It is a separate DOM walk that never calls `tableRows`.
   - Row ownership stops at nested tables. Zero-cell rows are counted. Unclosed `<tr>` nesting is
     followed.
   - It records header cells, `thead` rows, colspan/rowspan, blank rows, the text of the description
     field outside its label, `<p>`, and `<table>`, and the tables in the details region outside the
     description.
2. **Parser dispositions** (`interpretCpscPage`). Every description sentence and every extracted
   table row receives exactly one disposition, with an effect and reason.
3. **Reconciliation** (`buildCpscSourceCoverage`).
   - The census, not the parser, fixes each structure's authoritative record count.
   - Records with no extracted counterpart become `unresolved` with extraction `failed`.
   - Statuses and fingerprints are computed, and positive proposals are gated.

`StructuredCpscPage` and the semantic revision hash are unchanged, so no page revision churns.

## 3. Source-coverage ledger design

The worker sends one ledger per page revision (`cpsc_source_coverage_v1`). Its JSON shape is:

- **Ledger:** `schema, ledgerVersion, parserVersion, extractorVersion, censusVersion,
sourceSemanticRevision, structures[]`.
- **Structure:** `structureId, kind (prose|table|region), sectionIdentity, tableIndex,
tableIdentity, authoritativeRecordCount, anomalies[], records[]`.
- **Record:** `ordinal, recordIdentity, rowIdentity, extraction (extracted|failed), disposition,
effect (none|additive|restrictive), relation, reason, cells[]`.
- **Cell:** `column, criterionClass, status (recognized|deferred|unsupported|invalid|descriptive)`.

Dispositions are `parsed_reviewable`, `parsed_deferred`, `unresolved`, `unsupported`, and
`ignored_non_safety`. For every structure, `records.length = authoritativeRecordCount`. The
authoritative count comes from the census, so a lost row appears as `unresolved` or as an accounting
anomaly, never as a smaller N.

In the database, `private.cpsc_page_coverage_ledgers` is append-only; the latest row per revision is
authoritative:

- **Written only by** `record_cpsc_page_coverage(revision, ledger)`, which is worker-only and
  requires the current revision. The worker records the ledger after its proposals.
- **Strict shape.** Unknown keys are refused, so timestamps, UUIDs, and reviewer identity cannot
  enter the ledger or its fingerprint.
- **Binding checks:**
  - every stored table is accounted for by exactly one structure
  - row identities must be the revision's own rows, in order when the table has no anomaly
  - every reviewable row is bound to its own row and to an existing proposal on the revision
- **Server recomputation.** The database recomputes every status and both fingerprints. The worker
  compares them with its own and fails closed on any difference.
- **Guard trigger.** It refuses update, delete, and truncate, and refuses owner inserts whose
  columns do not follow from the ledger.
- **In-flight claims.** A new ledger advances `recall_notices.updated_at` for the identity's
  notices, so in-flight claims finalize as stale.

## 4. complete / partial / unresolved

| Status     | structural                                                                                                                                     | criterion                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| complete   | every structure accounted; no anomaly; every record extracted                                                                                  | ≥1 reviewable row; no deferred/unresolved/unsupported |
| partial    | accounted, but an anomaly or a failed extraction                                                                                               | reviewable rows plus some blocking records            |
| unresolved | a count mismatch, or an accounting anomaly (`row_count_mismatch`, `empty_header_row`, `prose_reconstruction_mismatch`, `table_count_mismatch`) | no reviewable row                                     |

- `coverageStatus` is `complete` only when both are complete, and `unresolved` if either is.
- `positiveStatus` is `blocked` when any blocking record is restrictive or structural is
  `unresolved`.
- `negativeEvidenceEligible` requires coverage `complete` and positives `independent`.

Serving (`get_recall_v2_scopes`):

- **Coverage complete.** The 16.12 conditions still apply. In addition, the latest ledger must be
  negative-evidence eligible, and its reviewable relations must equal the revision's proposals
  exactly.
- **Blocked ledger.** A ledger whose positives are blocked serves no rule set.
- **Filtering.** When a ledger exists, only its reviewable conjunctions serve.
- **No ledger.** Coverage is `missing`: positives are served, but a rejection is never allowed.
- **TS side.** `validateLiveRuleSetEnvelopeV2` independently requires
  `sourceCoverage.state = recorded`, `complete`, `independent`, and eligible.

## 5. Positive vs negative evidence

| Situation                                                                                                                                  | Positive (confirm)                  | Negative (reject)         |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------- |
| complete ledger                                                                                                                            | reviewed rule sets confirm          | allowed                   |
| additive gap (unparsed row, prose model list, extra descriptive table)                                                                     | independent rule sets still confirm | withheld → `needs_review` |
| restrictive gap (unsupported restriction, unknown columns, nested table, content outside structures, rowspan overflow, unaccountable rows) | nothing proposed or served          | withheld                  |
| no ledger (`missing`)                                                                                                                      | served rule sets confirm            | withheld                  |

Tested in Node (Char-Broil variants), pgTAP (partial vs blocked), and HTTP (revoked row withheld,
others confirm).

## 6. Char-Broil completeness

From the frozen page:

- census: 10 DOM rows (header + 9), so the authoritative count is 9
- 9 records, all `parsed_reviewable`, with 9 distinct relations
- prose: 5 sentences (1 governing date-code restriction + 4 ignored)
- dispositions 10 + 4 = 14 of 14 records
- coverage `complete`
- the 18 candidates are byte-identical to the 16.12 proposer

The omitted-row negative test drops the parser's 25302149 row while keeping the real census:

- 9 authoritative records, anomaly `row_count_mismatch`
- structural `unresolved`, positives `blocked`, 0 candidates
- 25302149 + 2510 → `needs_review`
- Counterfactual on the same input: the 16.12 model (8 served of 8 proposed looks complete) returns
  `rejected`. This is the false negative that this phase closes.
- Additive variant (row cell `25302149 (black)`): 16 candidates. 25302145 confirms; 25302149 and an
  unlisted model return `needs_review`.

Proven at three layers:

- **pgTAP:** the real ledger is recorded on the 16.12 Char-Broil fixture. SQL recomputes the TS
  coverage fingerprint `faea74e5…a65a` exactly.
- **HTTP:** the production worker path recorded the ledger through PostgREST (SQL = TS or the worker
  throws). Result: 9 served, complete, and a safe rejection of code 2509.

## 7. AGA completeness and deferred semantics

- 6 of 6 rows are accounted for, extraction `extracted`, disposition `parsed_deferred`.
- In every row the model cell is `recognized` and the `production_date_range` cell is `deferred`.
- structural `complete`, criterion `unresolved`, coverage `unresolved`
- positives `blocked` by the unsupported "manufactured between" sentence; 0 proposals
- Structural extraction completeness is therefore reported separately from criterion support.

## 8. Friedrich unresolved semantics

- There is no table.
- The sentence "The models are KCVQ08B10A, …" is `unresolved`/additive.
- The sentence "Only some serial numbers below …" is `unsupported`/restrictive.
- Coverage is `unresolved`, positives are `blocked`, and there are 0 proposals.
- A listed model is never rejected (`needs_review`).

## 9. Parser version and fingerprints

- The parser version is now `phase-16.13-structured-v2`. Candidate output is unchanged on all 30
  captured pages (only Char-Broil proposes, with the identical 18).
- **Interpretation fingerprint:** the source revision, structures, record identities,
  dispositions, effects, relations, and cells. Free-text reasons are excluded.
- **Coverage fingerprint:** the interpretation fingerprint plus the ledger, parser, extractor, and
  census versions. Timestamps, UUIDs, reviewer identity, and HTML noise are never inputs. A
  comment, attribute, or whitespace change gives identical fingerprints.

Parser-version cases (pgTAP and Node):

| Case                                     | Result                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| new parser, same interpretation          | new coverage fingerprint, same interpretation fingerprint; `interpretationChanged = false`; 0 stale reviews; coverage stays complete |
| new parser, different criterion universe | the old proof is insufficient: coverage incomplete, and only the ledger's reviewable conjunctions serve (fail closed)                |
| a later ledger finds a restriction       | nothing serves                                                                                                                       |

## 10. Fresh CPSC API capture

`scripts/capture-phase-16-13-cpsc-fresh.mjs` does read-only GETs, then writes
`docs/phase-16-13-cpsc-fresh-capture.json` (SHA-256 `ad9c0851…f39d`), captured at
`2026-09-26T06:58:51.920Z`.

- It covers 27 recall numbers, returning 27 API records (1 per recall).
- Each record captures: API ID, official number, URL, title, recall date, last publish date,
  products, UPCs, payload hash, and the full public payload.
- The payload hash uses the production `sourcePayloadSha256`. It was verified identical to the 16.8
  audit convention on all 30 16.8 payloads.
- The payloads contain public CPSC data only (one firm contact address is part of the official
  payload); there is no owned-product data.

## 11. Fresh official-page corroboration

Each API URL is canonicalized, then fetched with the production fetcher and parsed with the
production extractor (canonical link and displayed recall number must agree).

- **26 corroborated.**
- **1 unresolved: 26777 (API 10987).**
  - The API URL `…Carbon-Monoxide-Poisoning-Hazard-0` returns 301 to `…-Hazard`.
  - That page declares `<link rel=canonical>` `…-Hazard` and displays 26-777.
  - API identity and page identity disagree. Nothing was guessed.
- The fresh ledgers for the 26 corroborated pages: 1 `complete` (26773), 25 `unresolved`; 15
  independent, 11 blocked.

## 12. Old-vs-fresh manifest diff

The full diff is in `docs/phase-16-13-manifest-diff.json`.

| Item                                     | Result                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| unchanged identities                     | 26 of 27                                                                           |
| changed API IDs / URLs / dates           | 0 / 0 / 0                                                                          |
| changed titles / payload hashes          | 26777 only: the API title gained a trailing "." (its only field change since 16.8) |
| previously reconstructed URLs            | 15, all equal to the fresh API value (the reconstruction was correct)              |
| new / disappeared recalls (manifest set) | 0 / 0                                                                              |
| unresolved identity conflicts            | 26777 (page moved, see §11)                                                        |
| drift rows                               | 12/12 reproduce from fresh API IDs (consistent)                                    |
| duplicate groups                         | 26773, 26776, 26777 (consistent)                                                   |
| numeric-ID collisions                    | 10965–10970 (consistent)                                                           |

Production has grown since the manifest's baseline (found by the §26 audit):

- It holds 41 CPSC notices, not 30. The extra 11 are external IDs 10991–11001, for new recalls
  26788–26799, ingested 24–25 Sep by the Phase 12 monitor.
- I checked all 11 read-only against the CPSC API: current ID equals stored ID, with no drift and
  no collision. The 12/3/6 structure is unaffected. The backfill scope, however, is not the 30
  rehearsed here (§27, §28).

## 13. Regenerated backfill manifest

`docs/phase-16-13-backfill-manifest.json` (SHA-256 `861948ba1e75…8bdd`):

- The schema is unchanged (`manifestVersion: phase-16.12-cpsc-backfill-v1`), so the 16.12 backfill
  SQL consumes it as-is. It also carries `manifestGeneration: phase-16.13-fresh-capture-v1` and the
  capture's SHA-256.
- `pages`: the 27 historical 16.8 captures, unchanged.
- `currentObservations`: 26 fresh, page-corroborated API values. None is reconstructed. Each
  carries its corroboration (official canonical URL, page hash, displayed number).
- `unresolvedIdentities`: 26777, withheld, with its evidence and required action.
- `expected`:

  ```
  storedNotices 30, canonicalIdentities 27, canonicalPages 27, duplicateGroups 3,
  currentObservations 26, driftRows 11 (manifest-exercised), apiDriftRows 12,
  collisions 6, unresolvedIdentities 1
  ```

- It holds public CPSC data only.
- The builder and capture accept `--notices <snapshot>` so the manifest can be rebuilt from a live
  production snapshot.

## 14. Fresh-manifest backfill preview

Local dry run, scope `all`:

- Structure to create:
  - 27 identities
  - 30 links
  - 60 aliases
  - 30 API revisions
  - 27 page revisions
  - 27 fetches
- Duplicate groups: 26773, 26776, 26777.
- Observations (real 16.11 gate): `A_known_alias` 47, `B_new_alias` 3, `D_api_id_reuse` 6.
- Drift rows exercised: 11.
- Quarantines: the 6 collisions (API 10965–10970 for recalls 26753, 26763, 26754, 26756, 26749,
  26766).
- Unresolved: 26777.
- 0 unexpected conflicts; nothing persisted.
- Compared with 16.12 there is exactly one fewer observation (26777 current withheld).

## 15. Two-run idempotency rehearsal

| Run    | New rows | State                                                                                                                 |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------- |
| first  | 257      | 27 identities, 30 links, 160 aliases, 50 API revisions, 27 page revisions, 27 fetches, 56 observations, 6 quarantined |
| second | 0        | identical counts; 0 new identities, links, aliases, or revisions; 56 observations already recorded                    |

- Canonical digest `ea00243e…133f` is identical across runs and identical to 16.12.
- Lineage digest (aliases, API and page revisions, fetches, observations; UUID-free) `1406161a…a909`
  is identical across runs.
- The historical rows digest is unchanged (notices 30, scopes 43).
- 0 reconciliations, 0 reviews, 0 rule sets, 0 coverage ledgers. Backfilled revisions stay
  fail-closed until a live fetch.
- Rehearsal checks: 26/26.

## 16. Reviewer pending-candidate API

`public.list_cpsc_pending_review_candidates(p_page_size int default 20, p_cursor text default null)`
returns `cpsc_pending_review_page_v1`.

- **One item per rule set (conjunction)** that still has a pending member. A member is pending when
  its revision is current and it has no decision, a stale latest decision, or a latest decision
  invalidated for cause.
- **Item fields:**
  - recall number, official URL, source revision, revision ID, scope ID
  - conjunction group, rule-set number and count
  - evidence location (section, table, row)
  - criterion preview
  - pending count
  - members: candidate ID, kind, operator, value, excerpt, field, parser version, pending, latest
    decision, invalidated
  - parser coverage (latest ledger or `missing`)
- **Not exposed:** owned-product data, reviewer or user identities, attestation notes, worker
  secrets, ledger internals.

## 17. Reviewer HTTP authorization (real GoTrue JWTs, local PostgREST)

`test:phase-16-13:http`: **38/38**.

| Caller                                     | list_cpsc_pending_review_candidates | record_cpsc_page_coverage |
| ------------------------------------------ | ----------------------------------- | ------------------------- |
| anon                                       | denied                              | denied                    |
| consumer                                   | denied                              | denied                    |
| service_role JWT / sb_secret               | denied (not a human reviewer)       | allowed (worker)          |
| reconciler / invalidator (capability only) | denied                              | —                         |
| authorized reviewer                        | allowed                             | denied                    |
| revoked reviewer                           | denied                              | —                         |

## 18. Pagination and bounds

- Page size must be 1–50: 0 and 51 are refused. A malformed cursor is refused.
- **Order:** deterministic `recall | document position | scope | group`, using `collate "C"`.
- **Keyset cursor:** `nextCursor` is the last sort key; `hasMore` is set; the final page returns
  `nextCursor = null`.
- **Empty state:** the empty queue, and a cursor past the end, both return `items: []`.
- **Multi-page proofs:**
  - pgTAP: 2 pages, 2 items + 1, disjoint, in document order, repeatable.
  - HTTP: a size-4 traversal gives strictly increasing keys with no duplicates, the same set as
    size 50.

## 19. Multi-rule review presentation

Char-Broil shows 9 separate items, numbered 1–9 in document order. Each item is exactly one model
AND the date-code set, for example:

```
model_number equals "25302145" AND date_code one of ["2510", "2511", "2512"]
```

Every item carries `semantics: "OR between rule sets; AND inside each rule set"` and
`insideRuleSet: "AND"`. The queue never shows a flattened bag of models. AGA and Friedrich produce
no reviewable items.

## 20. Revoke-for-cause regression

- The 16.12 pgTAP (all of it, including revoke-for-cause) passes. `test:phase-16-12:http` passes
  65/65 and `test:phase-16-11:http` passes 36/36.
- New 16.13 checks:
  - A decision invalidated for cause returns its rule set to the queue with one pending member,
    flagged invalidated.
  - The rule set stops serving; coverage becomes incomplete.
  - Over HTTP, the revoked product is withheld (`needs_review`), not rejected; the others confirm.
  - The same reviewer cannot replace the decision.
  - Reviewer and service_role cannot revoke.
  - The ledger event is retained (append-only).

## 21. Remote-safe test result

`supabase/tests/remote/phase-16-production-compatibility.sql` grows from 80 to **89** assertions and
now follows the final path:

1. proposals bound to a stored table row
2. worker records the coverage ledger (a tampered ledger is refused; a replay is idempotent)
3. the reviewer finds its own item through the queue by keyset cursor, regardless of other pending
   candidates
4. queue bounds
5. service_role denied the queue
6. complete served coverage
7. ACL checks on the new table and RPCs

It still uses `BEGIN … ROLLBACK` with timeouts, no persistent fixtures, and no retired approval RPC.
It assumes no empty database.

Results:

- 89/89 on a fresh database.
- 89/89 on the populated database after the backfill.
- 89/89 after all HTTP fixtures (38 real pending candidates, 20 rule sets, 4 ledgers present).
- Counts are identical before and after each run.

## 22. Phase 16.13 migration

| File                                                          | SHA-256                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `20260926150000_phase_16_13_source_coverage_review_queue.sql` | `2fc1030a5c42ee3cc06105096969e9b055b0d174da056247f4d7ade84e4002bc` |

- Forward-only. Depends on 16.9 → 16.10 → 16.11 → 16.12.
- **New table:** `private.cpsc_page_coverage_ledgers` (RLS, no API grants, guard and no-truncate
  triggers).
- **New functions:**
  - public: `record_cpsc_page_coverage` (service_role) and `list_cpsc_pending_review_candidates`
    (authenticated, reviewer-checked)
  - private: `cpsc_validate_coverage_ledger`, `cpsc_coverage_summary`,
    `cpsc_check_coverage_binding`, `cpsc_guard_coverage_ledger`, `cpsc_scope_current_revision`,
    `cpsc_revision_coverage`, `cpsc_touch_identity_notices`, `cpsc_criterion_preview`
- **Replaced in place (same signatures):** `private.cpsc_scope_rule_set_coverage` and
  `private.cpsc_scope_rule_set_envelope`.
- **Grants:** all private functions are revoked from `public`, `anon`, `authenticated`, and
  `service_role`.

Final order: 16.9 → 16.10 → 16.11 → 16.12 → 16.13.

## 23. pgTAP

From a clean `db reset`, all 22 migrations apply with no manual patching.
`npx supabase test db` gives **1090/1090 PASS** across 13 files:

- 988 (16.12 baseline)
- +91 new `phase-16-13-source-coverage.sql`
- +9 remote-safe
- +1 SQL/TS Char-Broil fingerprint parity
- +1 from the 16.11 RLS sweep over the new `private.cpsc_*` table

## 24. Database lint

`supabase db lint --local`: **0 errors**. The only notes are the unchanged "warning extra" unused
parameters on the retired approval stub.

## 25. Deno, npm, and freezes

- **Deno 2.9.6** (`npx -y deno@2 check`): 16 production-path files pass (the 15 from 16.12 plus
  `sourceCoverage.ts`).
- **`npm run check`**: exit 0.
- **Suites:**

  | Suite        | Result |
  | ------------ | ------ |
  | matcher      | 27/27  |
  | phase 16     | 39/39  |
  | 16.10        | 19/19  |
  | 16.11        | 17/17  |
  | 16.12        | 12/12  |
  | 16.13 (new)  | 12/12  |
  | 16.3         | 6/6    |
  | 16.4         | 6/6    |
  | v2.1         | 19/19  |
  | AI necessity | 2/2    |

- **16.3 DB gate:** 23/23. Its `rejected` case uses a declared-complete fixture; it tests
  persistence, not served coverage.
- **Freezes:** Phase 9.1, 15, and 16 all report `frozen: true`. The frozen matcher and benchmark
  files are untouched.
- **v2.1:** 200 cases, 0 unsafe confirmations, 0 provider calls. `p15-str-45-2`, `-45-3`, and
  `-46-3` still do not confirm. The 200 frozen decisions are identical through the adapter.
- **Other gates:**
  - prettier: clean
  - `git diff --check`: clean
  - no trailing whitespace in new files
  - secret scan of the 21 touched files: no keys or tokens (only pre-existing "no Nebius"
    assertions matched)
- No Nebius call.

## 26. Read-only production audit (Supabase MCP, connected)

Project `Recall` (`cnftnulgtsraurtusnpb`, ACTIVE_HEALTHY, Postgres 17.6):

- **Migrations:** the last applied is `20260923160000_phase_16_v2_alerts_and_read_model`. 16.9,
  16.10, 16.11, 16.12, and 16.13 are all **absent**. None of their objects exist.
- **Functions:**
  - `process-recall-matches` v11
  - `process-recall-matches-v2-cohort` v1
  - `run-recall-automation` v3
  - `ingest-cpsc-recalls` v14
- **Counters** (all 0): reviewed criteria, v2 evaluations, eligibility, v2 alert snapshots,
  corrections, push queue.
- **CPSC data:** 41 notices and 54 scopes (see §12).
- **Cron:** `recall-automation-every-6h` (`17 */6 * * *`) is active; its last run was
  2026-09-26 06:17 UTC and succeeded.
- **No production writes.**

## 27. Remaining unresolved risks

1. **16.10 disables the deployed CPSC ingestion.**
   - 16.10 revokes `ingest_cpsc_recall` from `service_role`, and `ingest_authoritative_recall`
     refuses CPSC for the service role.
   - The deployed `ingest-cpsc-recalls` v14 uses that RPC, and the active 6-hourly cron calls it.
     Once 16.10 is applied, every CPSC run fails closed until the identity-gated worker is deployed.
   - The new worker must not run before the backfill: without it, the gate creates identities for
     new recalls and records `X_unlinked_history` quarantines that the backfill then has to work
     around. It never creates duplicate notices.
2. **Production backfill scope differs from the rehearsal.**
   - The manifest was built from the 30-notice snapshot; production has 41 and is growing.
   - The 11 new recalls have no page capture or current observation in the manifest. They would be
     backfilled as identities without page revisions (fail-closed, coverage `missing`).
3. **26777 needs a human URL reconciliation** before any live page ingestion or review for it. The
   worker fails closed on it (`extraction_failed`), which is safe.
4. **Coverage is description-scoped.**
   - Covered: description prose and tables, plus tables elsewhere in recall details (as regions).
   - Remedy and other detail prose is not parsed for eligibility; a restriction stated only there
     would be missed.
   - Images, PDFs, and firm web pages (for example Friedrich's serial list) are outside the page.
5. **Some classifications are conservative heuristics.** These include identifier-prose detection
   (context word plus a digit-bearing token) and the header synonym lists.
   - A false `unresolved` only withholds rejections.
   - A missed identifier sentence would be an unaccounted alternative. It is mitigated because prose
     never produces proposals.
6. **A superseded interpretation is permanent for its revision.** Proposal rows are append-only, so
   a parser version that drops a conjunction leaves that revision's coverage permanently incomplete
   until a new page revision arrives (fail closed, by design).
7. **Ledger contents are worker-attested.** The database cannot see raw HTML, so the DOM census
   counts are the worker's word. The database verifies shape, binding to stored rows and proposals,
   and all derived statuses.
8. **Carried over from 16.12:**
   - owner/superuser trigger bypass
   - broad v1 service_role grants
   - the global identity-decision lock and per-read builder cost
   - page-revision stale does not touch notices (now mitigated by the ledger touch in the worker path)
   - canonical-JSON parity is integer-only
   - v1 matching uses historical notice content

## 28. Exact Phase 16.14 production deployment plan (NOT executed)

Preconditions (decisions for the user):

- **(P1)** Pause CPSC ingestion from before step C until the backfill execution is approved
  (recommended). The options are:
  - Recommended: unschedule or deactivate cron job 2 for the window.
  - Alternative: split the automation's CPSC step out.

  During the pause, new CPSC recalls are not ingested; existing v1 matching and alerts are
  unaffected.

- **(P2)** Approve the backfill scope: either regenerate the capture and manifest from a live notice
  snapshot (recommended), or accept backfilling the new recalls without pages.
- **(P3)** Accept 26777 as withheld (recommended), or reconcile it first.

A. Preflight snapshot (read-only)

1. Confirm the PITR/backup point.
2. Run `list_migrations`; the last must be `20260923160000`.
3. Run `list_edge_functions`: v11 / v1 / v3 / v14.
4. Confirm all six counters are 0.
5. Record `cron.job` state.
6. Export the CPSC notice snapshot (`external_id`, recall number, official URL, scope count;
   public fields only) and record its SHA-256.
7. Verify the SHA-256 of the five migration files against §22 and the 16.9–16.12 accepted hashes.
8. Regenerate:
   - `npm run backfill:phase-16-13:capture -- --notices <snapshot>`
   - `npm run backfill:phase-16-13:manifest -- --notices <snapshot>`
9. Stop if drift, duplicate groups, or collisions are inconsistent (the builder aborts on this).
10. Record the manifest SHA-256.
11. Rehearse the regenerated manifest locally (`db reset` with a snapshot-shaped fixture), then run
    `backfill:phase-16-13:rehearse`.

B. Migration dry run

1. `npx supabase db push --linked --dry-run`.
2. It must list exactly 16.9, 16.10, 16.11, 16.12, and 16.13, in that order, and nothing else.
3. Optional: apply to a Supabase preview branch first.

C. Apply 16.9 → 16.13 (separate explicit approval; P1 in effect)

1. `npx supabase db push --linked`. Each file is its own transaction; stop on the first error.
2. Verify `list_migrations` shows the five versions.
3. Verify the counters are still 0 and `recall_notices` is still 41+ with the historical digest
   unchanged.

D. Remote lint

1. `npx supabase db lint --linked`: 0 errors.

E. Remote-safe pgTAP

1. Run the remote-safe file once with `psql` against production. Its `create extension if not
exists pgtap` sits inside the file's `BEGIN … ROLLBACK`, so it leaves nothing.
2. Expect 89/89.
3. Re-audit: 0 identities, 0 ledgers, 0 rule sets, and every counter unchanged.

F. Deploy worker code INACTIVE

1. Deploy `process-recall-matches` (v12) and `process-recall-matches-v2-cohort` (v2). They are the
   only functions importing 16.13-changed modules. The default selector stays
   `phase_10_guarded_v1` and the cohort stays disabled.
2. Deploy the identity-gated `ingest-cpsc-recalls` and `ingest-recall-source`, but keep them
   unscheduled (P1).
3. The CPSC page worker has no function entrypoint and stays undeployed.
4. Smoke test: guarded v1 decisions are unchanged; a v2 read returns no rule sets.

G. Backfill PREVIEW only

1. As owner, run
   `select private.cpsc_historical_backfill(<manifest>, 'all', false, 'Phase 16.14 preview', 5000);`
   The dry run persists nothing.
2. Compare it with the rehearsed expectation for the snapshot: identities, links, aliases,
   revisions, 3 duplicate groups, 6 quarantines, drift rows, 0 unexpected conflicts.
3. Re-audit to prove nothing persisted.

H. STOP FOR REVIEW

1. The first backfill execution is its own later approval, followed by the second-run idempotency
   check.
2. Only after that: resume CPSC ingestion, then separately authorize named reviewers, reconcilers,
   and invalidators.
3. Still forbidden: deterministic_v2 activation, cohort, consumer v2 reads, and push.
