# Phase 16.31 — bounded natural shadow batch to first table-bearing legacy page — stop report

**Classification: YELLOW-safe.**

**What happened**

- The one authorized worker POST was sent at 16:55:00 UTC.
- It claimed and completed the first **4** natural pages (20164, 20165, 26748, 26755), all `fetched_unchanged`.
- It then stopped at the deployed worker's reviewed `admission_budget`, before the table-bearing target **26773**, which is now **2nd** in the queue.

**What was verified**

- Every attempt is terminal.
- Raw bytes are retained and hash-verified.
- An offline `--deny-net` replay of the exact stored bytes reproduces production for all four pages.
- The reused legacy revisions changed only `last_seen_at`, proven by exact reconstruction.
- No hold, candidate, review, reconciliation, identity change, watermark change, v1 business change, or v2 or provider activity occurred.
- Edge logs show exactly one request, and the key file is deleted.

**What was not done:** there was no retry, no override, no scheduling, no redesign, and no commit or push. Stop for review.

## Timeline (2026-09-29, UTC)

| When         | Event                                                                                    | Actor  |
| ------------ | ---------------------------------------------------------------------------------------- | ------ |
| 12:30–12:37  | First pass: all read-only gates pass; key not available locally; stopped before the call | Claude |
| before 16:5x | `CPSC_PAGE_WORKER_KEY` rotated once; key written to a 0600 file                          | user   |
| 16:5x        | Key-file metadata check; function audit; fresh preflight, queue, gates, baseline         | Claude |
| 16:55:00.265 | **The single POST**                                                                      | Claude |
| 16:55:03.684 | Response 200; key file deleted immediately after                                         | Claude |
| 16:56–17:47  | Permission classifier outage (no verdicts); interim record written; no production action | —      |
| 17:48–17:54  | Post-run verification, offline replay, local gates                                       | Claude |

## 1. Key provisioning status

- **User action:** the user rotated only `CPSC_PAGE_WORKER_KEY`, once, and supplied only a path: `/tmp/recall-cpsc-page-worker-key.guCsgP`.
- **Metadata check (the value was never read out):**
  - exists; regular file; not a symlink
  - owner `stephaneds` (the current user); mode `600`; 65 bytes
  - real path `/private/tmp/…`, outside the repo
- **How the caller used it:**
  - The caller read it in-process only, stripping a trailing newline, and checked internally that it was 64 hex characters (boolean result only).
  - The key never appeared in argv, stdout, stderr, logs, or any file.
  - Shell tracing was off (`set +x`).

## 2. Function version / hash audit

| Function                           | 16.31 first pass → now | Bundle SHA-256                                                       | Code changed |
| ---------------------------------- | ---------------------- | -------------------------------------------------------------------- | ------------ |
| `process-cpsc-page-evidence`       | 6 → **7**              | `c15d66238fef35bb425709b847593c2e6bc9f560b9f82d4ee784f2a60aa6f533` ✔ | no           |
| `ingest-cpsc-recalls`              | 20 → 21                | `2b0774c5…0dc3` ✔                                                    | no           |
| `process-recall-matches`           | 15 → 16                | `81f96b1d…308d6b` ✔                                                  | no           |
| `send-recall-notifications`        | 10 → 11                | `58b6945b…11f5` ✔                                                    | no           |
| `run-recall-automation`            | 7 → 8                  | `29aa1681…ef6c` ✔                                                    | no           |
| `ingest-recall-source`             | 9 → 10                 | `ba394992…869d` ✔                                                    | no           |
| `ingest-recall-sources`            | 6 → 7                  | `c41cb92e…aae6` ✔                                                    | no           |
| `process-recall-matches-v2-cohort` | 5 → 6                  | `682308bd…1f1e` ✔                                                    | no           |

- **Version bumps:** exactly **+1** on all eight, consistent with a single `secrets set`.
- **Code and metadata:** `updated_at`, `verify_jwt` and every bundle are unchanged. These are metadata-only version increments.

## 3. Refreshed preflight (read-only MCP, 16:52:50)

| Check                | Value                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------- |
| Migrations           | 29; `20260929110000` exactly once                                                           |
| Cron                 | job 2 only, `17 */6 * * *`, active, MD5 `07549bf9…097b6`, no page reference; pg_net queue 0 |
| v1                   | last cron 12:17 `succeeded`; run `success` (0 seen / 0 affected / 0 alerts); 0 leases       |
| Sources              | CPSC `last_publish_date=2026-09-29` success; HC `last_updated_date=2026-09-29` success      |
| Automation watermark | `2026-09-29`                                                                                |
| CPSC safety          | `safe=true`, 9 / 9, `unaccounted=[]`, `legacyHashOnly=0`                                    |
| Manifest imports     | 1 (`a8bce170…3c3c`)                                                                         |
| Holds                | 1 (26777, 0 resolutions); capabilities 0; reconciliations 0                                 |
| Page processing      | last claim still 09:51:53: **no processing since the first pass**                           |
| v2 / business        | all v2 tables 0; matches, alerts, push and owned products 0                                 |

## 4. Refreshed eligibility

- 31 eligible of 38.
- 26777 `{human_reconciliation_required}`.
- 26749, 26753, 26754, 26756, 26763, 26766 `{unresolved_quarantine}`.
- No hold resolved.

## 5. Refreshed natural queue (exact installed claim predicate and ORDER BY, read-only)

| Pos | Recall    | Identity                               | Legacy revision (`phase-16.9-v1`) | Pre-call revision row MD5 |
| --- | --------- | -------------------------------------- | --------------------------------- | ------------------------- |
| 1   | 20164     | `bf758d50-44c7-4f6d-becc-2f62d4df696b` | `table_identities=[]`, 0 tables   | `d14b86d8…`               |
| 2   | 20165     | `5eea651d-5c0f-409e-a181-35ba344df76a` | `[]`, 0                           | `f80e9329…`               |
| 3   | 26748     | `a00a8a7b-36cb-4f11-b332-b277b4db59c6` | `[]`, 0                           | `89653ab3…`               |
| 4   | 26755     | `52d43eb4-5601-4f68-8f23-4eb4612dd71b` | `[]`, 0                           | `b5e24637…`               |
| 5   | 26761     | `c32fd3aa-e397-4c37-805c-285b8860df99` | `[]`, 0                           | `7df35ca1…`               |
| 6   | **26773** | `0e0906a3-36d5-4a10-8440-f5f29a15d31c` | **`[]`, 1 table**                 | `8b6f2199…`               |
| 7   | 26774     | `eaa1a48a-…`                           | `[]`, 0                           |                           |
| 8   | 26775     | `968d3825-…`                           | `[]`, 0                           |                           |
| 9   | 26776     | `09ac311e-…`                           | `[]`, 0                           |                           |
| 10  | 26778     | `202428e8-…`                           | `[]`, 0                           |                           |

All ten have no work state and 0 attempts. This is identical to the first pass.

## 6. First table-bearing target

**26773** (Char-Broil Bistro Pro).

- **Production revision:** the legacy revision has 1 normalized table, empty `table_identities` and no snapshot, so it is the Phase 16.26 compatibility case.
- **16.14 capture:** `corroborated`, with no redirect.
- **Fixture:** `tests/fixtures/cpsc-pages/char-broil.html` contains 1 `<table>`.

## 7. N

**N = 6**. Request `{"maxPages":6,"timeBudgetMs":20000}`.

## 8. Per-page safety gates (positions 1–6)

All six pass every gate:

- eligible (`blockers={}`)
- 0 holds
- observations all `resolved`
- 0 aliases shared with another identity
- canonical `https://www.cpsc.gov/Recalls/…` URL
- last known redirect chain `[]` with a matching canonical link (16.14)

No page was skipped or steered.

## 9. Forensic baseline (16:53:31)

- **Coverage:** all 53 app tables, method `count || md5(string_agg(md5(row::text) order by md5(row::text)))`.
- **Result:** byte-identical to the 12:33 first-pass baseline.
- **Page tables:** attempts `2 910c8df8…`, work state `2 d398f028…`, fetches `28 93ed8d3e…`, raw `1 634cdb56…`, revisions `27 f6662c84…`, snapshots `1 711194a6…`, ledgers `1 2f9b91bd…`.
- **Identity layer:** identities `38 2f842e3a…`, aliases `282 b4329ba8…`, observations `109 e84d35ad…`, links `41 0543bfa2…`.
- **Holds and imports:** holds `1 fe3a1b54…`, imports `1 457a983d…`.
- **v1:** sync state `2 9099ccce…`, automation state `1 fd1ca6a8…`, runs `55 b6f40dfe…`.
- **Notices:** `87 971d647d…`.
- **Everything else:** v2, review, candidates, reconciliations, capabilities, matches, alerts, push and owned products are all 0.

## 10. The one POST

- **Caller:** a one-shot Node caller in the scratchpad. It contains no secret. It wrote a `wx` sentinel before sending and refuses to run if the sentinel exists.
- **Headers:** publishable key as `apikey` + Bearer, plus `x-cpsc-page-worker-key`. No values were printed.
- **Body:** `{"maxPages":6,"timeBudgetMs":20000}`. There was no identity, recall number, URL or queue input.

| Field       | Value                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| start       | 2026-09-29T16:55:00.265Z                                                                                                                        |
| response    | 2026-09-29T16:55:03.684Z                                                                                                                        |
| duration    | 3419 ms                                                                                                                                         |
| HTTP status | **200**                                                                                                                                         |
| body        | `{"dryRun":false,"claimed":4,"completed":4,"failed":0,"errorCategories":[],"outcomes":["fetched_unchanged" ×4],"stoppedBy":"admission_budget"}` |

**Exactly one request.** The edge logs for 12:40–17:55 contain exactly one request to the worker: `POST | 200` at 16:55:03.706. **There was no retry.**

## 11. Actual claim sequence

**20164 → 20165 → 26748 → 26755**, which equals predicted positions 1–4 exactly. No other identity was claimed.

## 12. Per-attempt terminality

| Recall | Attempt ID                             | Claimed (UTC)   | Completed (UTC) | Outcome             | Error | Next attempt       |
| ------ | -------------------------------------- | --------------- | --------------- | ------------------- | ----- | ------------------ |
| 20164  | `b0ae9d11-ed3d-4967-b22e-65e81c59ad2b` | 16:55:01.577691 | 16:55:03.053082 | `fetched_unchanged` | null  | 09-30 16:55:03.053 |
| 20165  | `3d4d71d9-0e13-4511-8106-0eb8250bfd9b` | 16:55:01.949242 | 16:55:02.783559 | `fetched_unchanged` | null  | 09-30 16:55:02.784 |
| 26748  | `2e3d0cf6-5fd6-410b-b127-4620bbfbe2e1` | 16:55:02.945508 | 16:55:03.397652 | `fetched_unchanged` | null  | 09-30 16:55:03.398 |
| 26755  | `b7441d8a-e107-4afd-b903-2664d5bc9ecb` | 16:55:03.191602 | 16:55:03.633110 | `fetched_unchanged` | null  | 09-30 16:55:03.633 |

- **Work state (all four):** `claim_id` null (released), `attempt_count=1`, `consecutive_failures=0`, `manual_review_required=false`, and the retry is success +1 day.
- **Open claims:** the only `claimed` attempt in production is the historical Intertex `0bf98d4e…` (MD5 `7f248918…`, unchanged).

**Observed timing** (input for 16.32):

- The first claim came about 1.3 s after the client sent the request (gateway plus cold start).
- Claim to completion took 0.44–1.48 s per page.
- The 4th claim came 1.61 s after the 1st.
- Admission closed before a 5th claim; no `budget_deferred` attempt was created.

## 13. Raw payload metadata

| Recall | SHA-256 (stored = DB-recomputed = attempt = fetch)                 | Bytes  | UTF-8 | Content type               | Final URL = canonical | Redirects | Retained at     |
| ------ | ------------------------------------------------------------------ | ------ | ----- | -------------------------- | --------------------- | --------- | --------------- |
| 20164  | `c5b392fe7006269c567c360446dcd83628859e7723138b7e80a341e736950855` | 78,209 | ✔     | `text/html; charset=UTF-8` | ✔                     | `[]`      | 16:55:02.885840 |
| 20165  | `a14dcdde41520d50d305d1789143b519eef91f8d5bcd687afbcb9a9f2129634f` | 82,195 | ✔     | same                       | ✔                     | `[]`      | 16:55:02.562175 |
| 26748  | `7868159ec66e1a5a1412d4459c8d9110f85d1553a222aec16b1569c9675bc799` | 77,862 | ✔     | same                       | ✔                     | `[]`      | 16:55:03.321523 |
| 26755  | `f0b6b553a3678c11fabedfb00e9cd29e815bfb98bedbe1a3ed5abd39cb15175b` | 82,549 | ✔     | same                       | ✔                     | `[]`      | 16:55:03.513814 |

- **Checks:** all are under 1 MB, on host `www.cpsc.gov` under `/Recalls/`, with HTTP 200.
- **Ordering:** each payload was retained before its semantic commit and completion (transport-first).
- **Tables:** 0 `<table>` tags in any of the four.
- The HTML was not printed.

## 14. Offline replay (exact production bytes, Deno `--deny-net`, no DB)

**Export:** the bytes were exported read-only with `supabase db query --linked` (a `SELECT` only) straight to the scratchpad, never passing through the transcript. Local SHA-256 equals the stored value for all four, and each decodes under a fatal UTF-8 decoder.

**Replay:** the real modules ran in order: `extractCpscPageStructure`, then `semanticCpscRevision`, then `buildCpscSourceCoverage`.

| Check (all 4 pages)                                    | Result      |
| ------------------------------------------------------ | ----------- |
| raw SHA; displayed recall number = claimed             | equal       |
| semantic hash vs revision `evidence_hash` and snapshot | equal       |
| normalized evidence vs revision                        | deep-equal  |
| table identities vs snapshot and vs legacy revision    | `[]` = `[]` |
| full coverage ledger; summary                          | deep-equal  |
| coverage FP; interpretation FP                         | equal       |
| candidates proposed / persisted                        | 0 / 0       |

The semantic hashes are:

- 20164 `6487bb74…9c54`
- 20165 `3b4e2a5e…c4b7`
- 26748 `db43caa7…0455`
- 26755 `bd3355fe…837b`

The 20164 and 20165 hashes also equal the 16.14 fresh capture. The scratch copies were deleted afterwards; only `replay.ts` remains.

## 15. Budget-stop point (table-bearing target NOT reached)

- **Where it stopped:** after **4** completed natural pages, by the deployed worker's reviewed `admission_budget` (claim reserve of 18 s out of 20 s).
- **Unchanged:** worker behaviour was not changed, and nothing was retried.
- **Compatibility on real bytes:** 4 more legacy `phase-16.9-v1` revisions went through the 16.26 compatibility path. Each got a `phase-16.13-structured-v2` / `phase-16.11-html-v1` / `phase-16.13-census-v1` snapshot, and the revision, snapshot and census identities agreed.
- **Still unexercised:** all four are zero-table pages. The critical case (legacy `[]` while the live page has a table) is **still not exercised in production**.

**Recomputed queue (read-only, 17:49):**

`1:26761 2:26773 3:26774 4:26775 5:26776 6:26778 7:26779 8:26780`

31 are still eligible. **26773 is now at position 2.**

## 16. Coverage / candidate state

| Recall | Ledger (seq)     | Records auth / accounted | Reviewable | Deferred | Unresolved | Unsupported | Ignored | Struct.  | Criterion  | Coverage   | Positive    | Neg. eligible | Blockers                                     |
| ------ | ---------------- | ------------------------ | ---------- | -------- | ---------- | ----------- | ------- | -------- | ---------- | ---------- | ----------- | ------------- | -------------------------------------------- |
| 20164  | `932d098f…` (10) | 5 / 5                    | 0          | 0        | 1          | 2           | 2       | complete | unresolved | unresolved | blocked     | false         | `description/prose#2`, `description/prose#3` |
| 20165  | `2bc7fef9…` (9)  | 8 / 8                    | 0          | 0        | 0          | 1           | 7       | complete | unresolved | unresolved | blocked     | false         | `description/prose#7`                        |
| 26748  | `3c791b62…` (11) | 4 / 4                    | 0          | 0        | 0          | 0           | 4       | complete | unresolved | unresolved | independent | false         | —                                            |
| 26755  | `c3ad6c28…` (12) | 6 / 6                    | 0          | 0        | 0          | 1           | 5       | complete | unresolved | unresolved | blocked     | false         | `description/prose#5`                        |

- **Reviewable relations:** `[]` everywhere, and no page claims negative evidence.
- **Ledger sequence gap:** `recorded_seq` 8 was consumed by the non-transactional sequence during 16.30's rollback-only suites. There is no hidden row.
- **Review state:** candidates 0; review ledger 0; reviewer authorizations 0; reviewed criteria 0.

## 17. Holds / redirects

There were no redirects (every chain is `[]` and the final URL is canonical), no `identity_redirect` outcome, and **no new hold**. Holds are still exactly 1, with 0 resolutions.

## 18. 26777

- Never claimed: 0 work state, 0 attempts.
- Identity row MD5 `465c3280…` unchanged.
- Ineligible (`{human_reconciliation_required}`).
- Hold `2c89d188…` unresolved, and 0 reconciliations.

## 19. v1 / watermarks

- **Unchanged:** CPSC and HC sync state (`2 9099ccce…`), automation state (`1 fd1ca6a8…`), automation runs (`55 b6f40dfe…`), cron job (`07549bf9…`), matches, alerts, push queue and deliveries, owned products and scopes.
- **No overlapping cron:** there was no natural cron activity between 12:17 and 17:49. The next run is 18:17, after this verification.

**Explained `recall_notices` diff (designed, not v1):**

- **What changed:** 4 notice rows changed `updated_at` only: external ids 8877 (20164), 8878 (20165), 10965 (26748) and 10966 (26755). Each value equals its attempt's `completed_at` exactly.
- **Why:** this is `private.cpsc_touch_identity_notices`. Per 16.13, `record_cpsc_page_coverage` calls it whenever a new ledger is created. Its purpose is to advance the notice revision so that in-flight v2 evaluations finalize as stale.
- **What it can write:** the function only sets `updated_at`.
- **Precedent:** 16.28's call did the same to 20163's notice (8876 `updated_at` = 09:51:54.298768). The next v1 run (12:17) reported 0 affected recalls.
- **Note:** earlier reports did not call this out, because 16.30 had no page call.

## 20. v2 / provider

- **v2:** evaluations, eligibility, snapshots, corrections, evidence, rule sets, criteria and legacy snapshots are all 0.
- **v2-cohort function:** bundle unchanged, and its only version change is the secret-rotation bump.
- **Providers:** the worker bundle has no provider reference, and there was no Nebius or provider call.
- **Matching policy:** not re-read from secrets. It is not visible to DB/MCP-SQL, so it rests on 16.28's listing (default `phase_10_guarded_v1`) plus the all-zero v2 state.

## 21. DB integrity

- **Orphans:** 0 fetches without a revision, 0 ledgers without a snapshot, 0 unreferenced raw payloads, 0 successful attempts missing fetch/revision/raw links, and 0 attempt↔fetch mismatches (identity, revision and hash).
- **Linkage for each new page:** work state → attempt → raw payload (by SHA) → fetch → reused revision → structural snapshot (same semantic hash) → coverage ledger.
- **Candidates:** none.

## 22. Exact persistent production diff (16:53:31 → 17:49:04)

| Table                            | Before         | After          | Explanation                                                 |
| -------------------------------- | -------------- | -------------- | ----------------------------------------------------------- |
| `cpsc_page_attempts`             | 2              | 6              | 4 new terminal attempts                                     |
| `cpsc_page_work_state`           | 2              | 6              | 4 new rows                                                  |
| `cpsc_page_fetches`              | 28             | 32             | 4 new fetches                                               |
| `cpsc_page_raw_payloads`         | 1              | 5              | 4 new payloads                                              |
| `cpsc_page_structural_snapshots` | 1              | 5              | 4 new snapshots                                             |
| `cpsc_page_coverage_ledgers`     | 1              | 5              | 4 new ledgers                                               |
| `cpsc_page_revisions`            | `27 f6662c84…` | `27 e3ad5f00…` | only `last_seen_at` on the 4 reused revisions (proof below) |
| `public.recall_notices`          | `87 971d647d…` | `87 3466520d…` | `updated_at` on the 4 linked notices (§19)                  |
| all other 45 tables              | —              | byte-identical | —                                                           |

**Revision proof:** setting `last_seen_at` back to `first_seen_at` on the 4 reused rows reproduces each pre-call row MD5 (`d14b86d8`, `f80e9329`, `89653ab3`, `b5e24637`) and the whole pre-call table fingerprint `27 f6662c84d86b5d54745aac08c3c34dce`. There was no destructive rewrite.

**Outside the application tables:**

- **Secret rotation (user):** the eight functions each went up one version (§2).
- **Supabase CLI login role:** `supabase db query --linked` refreshed the platform-managed `cli_login_postgres` role's short-lived login.
  - `rolvaliduntil` = 17:57:06, now expired.
  - It has no superuser, createrole or bypassrls, and is a member of `postgres`.
  - The CLI used the same mechanism for 16.30's `db push --linked`.

## 23. Key-file cleanup

- `/tmp/recall-cpsc-page-worker-key.guCsgP` was deleted right after the POST. Its absence was verified, and no `recall-cpsc-page-worker-key.*` file remains.
- The contents were never printed.
- The scratchpad holds only:
  - the caller, which has no secret
  - the sentinel (a timestamp)
  - `replay.ts`

## 24. Quality / secret gates

- **No source modification:**
  - worker source set `9e6e318e…4a02`, migration `154b96b0…`, manifest `e3ab192c…` and 29 migration files all unchanged
  - 36 tracked modifications, as before
  - the only new file is this report (203 status entries)
- **Hygiene:** `git diff --check` is clean. The secret-pattern scan (JWTs, `sb_secret_`/`sb_publishable_` values, credentialed Postgres URLs, worker-header values) over the scratchpad, this report and the diff found **0**, and there are 0 64-hex tokens in the caller or sentinel.
- **Limit on the secret scan:** the exact-digest scan against the live key (the 16.28 method) was not possible, because the key file is deleted and the key was never hashed. The key was never read into any output.
- **Formatting:** the report is formatted with Prettier.
- **Test suites:** not re-run, since no code or schema changed. The live run exposed no defect that needs code.

## 25. Classification: **YELLOW-safe**

**Every processing and safety criterion passes:**

- natural order matched
- all attempts terminal
- raw evidence retained and replay deterministic
- no partial writes, orphans, holds, review, reconciliation or 26777 processing
- no v1, watermark, v2 or provider effect
- no credential exposure
- all mutation is accounted for

**Why not GREEN:** the table-bearing target was not reached, solely because of the deployed admission budget.

## 26. Next recommendation — Phase 16.31b

**Worker call:** one new, separately authorized natural POST.

- Use `maxPages = N`, where N is the recomputed position of 26773. It is **2** as of 17:49; recompute it before the call.
- Use `timeBudgetMs = 20000`.
- Pass no override.

**Why this should reach 26773:** with 2 lanes, positions 1 and 2 are claimed immediately at the start of the cycle. Queue head 26761 is a zero-table legacy page with a clean record.

**Key:** the rotated key file is deleted, so 16.31b needs the same manual provisioning: rotate once, write a 0600 file, pass the path only.

**Preconditions:**

- the full preflight is re-run
- the queue is recomputed
- the gates are re-applied
- the 18:17 and later v1 runs are separated by timestamp

**Acceptance:** the §18 table-bearing checks against 26773's real bytes:

- the legacy revision has 1 table and `[]` identities, and the census identities come from one canonical census
- the snapshot is written
- the revision is not rewritten
- the ledger accounts for every table record
- candidates remain unreviewed

**Deferred to 16.32 (pre-scheduling), unchanged here:**

- the budget/admission policy, using the observed timings (§12)
- an `identity_reconciliation` operator (0 holders today)
- the hold workflow, backpressure, observability, a kill switch, cron isolation and rollout criteria
- the rotate-per-call key custody, which will need a durable design before any schedule
