# Phase 16.31b — natural table-bearing shadow completion — stop report

Continuation of [Phase 16.31](phase-16-31-natural-shadow-batch-stop-report.md) (YELLOW-safe).

> **Final classification: GREEN (2026-09-30).** After CPSC recovered, the one authorized POST processed 26761 and 26773 naturally. The table-bearing legacy compatibility case passed on real production bytes, and Phase 16.31 is closed. See [Phase 16.31b result](#phase-1631b-result--the-one-post-2026-09-30) below. The sections that follow first record the earlier attempts: the first attempt (2026-09-29), which stopped without a call, and the resume preflight.

**First-attempt classification (2026-09-29): STOPPED BEFORE CALL — YELLOW-safe (preflight gate).**

- **Why it stopped:** the §3 gate "CPSC healthy" failed. The natural v1 cron at 18:17 UTC recorded the CPSC source as `failed` / `source_http_502` against `https://www.cpsc.gov`, the same host the page worker fetches from.
- **Every other gate passed**, with N = 2 (26761, 26773).
- **Reviewer decision:** stop and delete the key file. The key file was deleted unused.
- **Not done:** no POST, no claim, no retry, no deploy, no migration, no schedule, no reconciliation, no review, no v2, and no commit or push. The 16.31b single-POST authorization is **unused**.

## 1. Key file

- The user gave the directory `/tmp/`. Listing names only (no contents) found exactly one candidate: `recall-cpsc-page-worker-key.xrWKrS`, created 18:33:44 UTC.
- **Metadata check:** regular file, not a symlink, owner `stephaneds`, mode `600`, 65 bytes, 1 link, real path under `/private/tmp` (outside the repo).
- **Never used:** the value was never read, and no request was made with it.
- **Deleted:** removed at the reviewer's direction after the gate failed. Its absence is verified, and 0 `recall-cpsc-page-worker-key.*` files remain.

## 2. Function audit (after the rotation)

| Function                           | 16.31 end → now | Bundle SHA-256 unchanged                    |
| ---------------------------------- | --------------- | ------------------------------------------- |
| `process-cpsc-page-evidence`       | 7 → 8           | `c15d66238fef…a6f533` ✔ (`verify_jwt=true`) |
| `ingest-cpsc-recalls`              | 21 → 22         | `2b0774c5…0dc3` ✔                           |
| `process-recall-matches`           | 16 → 17         | `81f96b1d…308d6b` ✔                         |
| `send-recall-notifications`        | 11 → 12         | `58b6945b…11f5` ✔                           |
| `run-recall-automation`            | 8 → 9           | `29aa1681…ef6c` ✔                           |
| `ingest-recall-source`             | 10 → 11         | `ba394992…869d` ✔                           |
| `ingest-recall-sources`            | 7 → 8           | `c41cb92e…aae6` ✔                           |
| `process-recall-matches-v2-cohort` | 6 → 7           | `682308bd…1f1e` ✔                           |

All eight went up exactly +1, consistent with one `secrets set`. There was no code change.

## 3. Preflight (read-only, 18:35:21 UTC)

| Check                     | Result                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations                | 29; 16.29 exactly once ✔                                                                                                                                                                    |
| Worker                    | exact bundle, unscheduled; cron job 2 only, MD5 `07549bf9…`, no page reference; pg_net queue 0 ✔                                                                                            |
| **v1 18:17 run**          | cron `succeeded`; automation run **`partial_success`**, `error_code=source_partial_failure`; 0 seen / 0 affected / 0 alerts / 0 AI                                                          |
| **CPSC source**           | **`failed`, `source_http_502`**, attempted 18:17:20, `fetched=0`; last success 12:17:06 ✘                                                                                                   |
| Health Canada             | `success` 18:17:21 ✔                                                                                                                                                                        |
| Watermarks                | CPSC `last_publish_date=2026-09-29`, automation `2026-09-29`: **held** (the forward-only guard worked) ✔                                                                                    |
| CPSC safety               | `safe=true`, 9 / 9, `unaccounted=[]` ✔                                                                                                                                                      |
| Holds / imports           | 1 hold (26777, 0 resolutions); 1 import; 0 capabilities; 0 reconciliations ✔                                                                                                                |
| Page activity since 16.31 | none. There are 6 attempts: Intertex `7f248918…` still `claimed` (historical), 20163 `b7179df8…`, and the four 16.31 attempts all `fetched_unchanged`. No notice was touched after 16:56. ✔ |
| v2 / business             | 0 / 0 ✔                                                                                                                                                                                     |

The 18:17 run changed only v1 run and sync state (run row 56, CPSC failure status, HC success, automation `updated_at`). No watermark value moved.

## 4. Eligibility

- 31 of 38 eligible.
- 26777 `{human_reconciliation_required}`.
- 26749, 26753, 26754, 26756, 26763, 26766 `{unresolved_quarantine}`.
- No hold resolved.

## 5. Natural queue (exact claim predicate and ORDER BY, read-only)

| Pos | Recall    | Identity                               | Legacy revision                                                       |
| --- | --------- | -------------------------------------- | --------------------------------------------------------------------- |
| 1   | 26761     | `c32fd3aa-e397-4c37-805c-285b8860df99` | `be46b5f8…`, 16.9-v1, `[]`, 0 tables, MD5 `7df35ca1…`                 |
| 2   | **26773** | `0e0906a3-36d5-4a10-8440-f5f29a15d31c` | `c7919ccf…`, 16.9-v1, **`[]`, 1 table**, 0 snapshots, MD5 `8b6f2199…` |
| 3   | 26774     | `eaa1a48a-…`                           | `[]`, 0                                                               |
| 4   | 26775     | `968d3825-…`                           | `[]`, 0                                                               |
| 5   | 26776     | `09ac311e-…`                           | `[]`, 0                                                               |
| 6   | 26778     | `202428e8-…`                           | `[]`, 0                                                               |
| 7   | 26779     | `32129859-…`                           | `[]`, 0                                                               |
| 8   | 26780     | `36e2b68a-…`                           | `[]`, 0                                                               |
| 9   | 26781     | `8c547a91-…`                           | `[]`, 0                                                               |
| 10  | 26782     | `4ed27ed8-…`                           | `[]`, 0                                                               |

## 6. Target, N and per-page safety

- **Target:** 26773. Its legacy revision holds 1 normalized table with empty `table_identities` and no snapshot, which is the Phase 16.26 compatibility case. This is backed by the 16.14 `corroborated` capture and the `char-broil.html` fixture (1 table).
- **N = 2**, so the call would have been `maxPages=2`.
- **Positions 1–2:** each is eligible, with 0 holds, observations `resolved`, 0 shared aliases, and an official canonical URL. The last known redirect chain is `[]`.

## 7. Why no call

- **Explicit gate:** §3 requires CPSC to be healthy.
- **Real risk:** the 502 came from the same `www.cpsc.gov` host. A page fetch that returns 5xx ends safely as `temporary_failure` (5-minute backoff), but it would likely spend the only authorization without validating 26773.
- **Reviewer choice:** of wait, stop-and-delete, and waive, the reviewer chose **stop and delete the key file**.

## 8. Production diff caused by this phase

**None.** Every query was a read-only transaction or a log read. The edge logs for 17:55–18:45 contain **no** request to `process-cpsc-page-evidence`.

**Changes outside this phase:**

- the user's secret rotation (function versions +1)
- the natural 18:17 v1 run (run row, sync and automation-state timestamps, CPSC failure status)

## 9. Quality and secret gates

- **Source tree:** unchanged. No code, schema or test edits were made; this report is the only new file.
- **Scratchpad:** the 16.31 sentinel is still present, so the 16.31 caller stays locked. No 16.31b caller or sentinel was created.
- **Secret:** the key value never entered any output or file.
- **Formatting:** `git diff --check` is clean, and the report is formatted with Prettier.

## 10. Recommendation: re-run 16.31b unchanged once CPSC is healthy

1. **Wait for recovery:** wait for a natural v1 run that shows the CPSC source `success`. The next is 00:17 UTC on 2026-09-30.
   - 26761 and 26773 have no work state, so they sort as `-infinity` and stay ahead of every identity that has a real `next_attempt_at`. That includes 20164, 20165, 26748 and 26755 after they fall due again at about 16:55 UTC on 2026-09-30.
   - N should therefore stay 2 until 26761 or 26773 is processed. Recompute it anyway.
2. **Provision a new key:** rotate `CPSC_PAGE_WORKER_KEY` once, write it to a new 0600 file, and pass the **full file path**.
3. **Unchanged terms:** one POST, `maxPages = N ≤ 2`, `timeBudgetMs=20000`, no retry, and the full §3–§9 preflight repeated right before the call.

**Unchanged for 16.32:** the budget and admission policy (use the timings observed in 16.31), an `identity_reconciliation` operator, the hold workflow, schedule bounds, backpressure, observability, a kill switch, cron isolation, key custody, and rollout criteria. It should also cover **upstream-outage behaviour**, since this phase shows a CPSC 502 is a real operational condition.

---

## Resume preflight after CPSC recovery (2026-09-30, 06:21 UTC, read-only)

**Result: all gates pass, N = 2, so this is paused for manual key provisioning.** There was no POST, and no key file exists. The single-POST authorization is still unused.

| Check                  | Result                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source recovery        | 00:17 run `partial_success` (`source_partial_failure`; 5 seen, 3 inserted, 2 updated, 0 alerts). **06:17 run `success`**, completed 06:17:07, `error_code=null` |
| CPSC                   | `success` 06:17:04, `last_error_code=null`, watermark `2026-09-30`, fetched 0                                                                                   |
| Health Canada          | `success` 06:17:05, `last_error_code=null`, watermark `2026-09-30`                                                                                              |
| Automation watermark   | `2026-09-30`; 0 leases; CPSC safety `safe=true` 9 / 9, `unaccounted=[]`                                                                                         |
| Migrations / cron      | 29, 16.29 once; job 2 only (MD5 `07549bf9…`), no page reference; pg_net queue 0                                                                                 |
| Functions              | versions unchanged since 18:34 (worker **v8**); all 8 bundles unchanged, worker `c15d66238fef…a6f533`, `verify_jwt=true`                                        |
| Page state             | 6 attempts with unchanged row MD5s (Intertex `7f248918…` still historical `claimed`; 20163 and the four 16.31 attempts terminal); no page activity since 16.31  |
| Identity layer         | 38 identities; 0 new identities or observations since 18:00; 0 reconciliations; 0 capabilities                                                                  |
| Holds                  | 1 (26777, 0 resolutions); 1 import                                                                                                                              |
| Eligibility            | 31 / 38; 26777 `{human_reconciliation_required}`; 26749, 26753, 26754, 26756, 26763, 26766 `{unresolved_quarantine}`                                            |
| 26777                  | row MD5 `465c3280…` unchanged; 0 work state; 0 attempts; aliases `10 08df249d…`; observations `3 2c627396…`                                                     |
| Notices                | 87 → 90 (3 inserted at 00:17). The 5 touched at 06:17 are all Health Canada with 0 CPSC identity links, so they do not affect the page queue                    |
| v2 / review / business | 0 / 0 / 0                                                                                                                                                       |

**Natural queue (exact claim predicate and order):** `1:26761 2:26773 3:26774 4:26775 5:26776 6:26778 7:26779 8:26780 9:26781 10:26782` (26 due now).

- **Target:** 26773. Its revision `c7919ccf…` is `phase-16.9-v1` with 1 normalized table, `table_identities=[]`, 0 snapshots and row MD5 `8b6f2199…`, all unchanged.
- **N = 2**, so `maxPages=2`.
- **Positions 1–2 (26761, 26773):** blockers `{}`, 0 holds, observations `resolved`, 0 shared aliases, and an official canonical URL. The last known redirect chain is `[]`. Revision MD5s are unchanged (`7df35ca1…`, `8b6f2199…`).

**Next:** the user rotates `CPSC_PAGE_WORKER_KEY` once, writes it to a mode-0600 file outside the repo, and supplies the **full absolute file path**. Then:

1. revalidate
2. re-audit the bundles
3. make one POST (`maxPages=2`, `timeBudgetMs=20000`, no retry)
4. delete the key file
5. run the post-run verification

---

## Phase 16.31b result — the one POST (2026-09-30)

**Classification: GREEN.**

- The table-bearing legacy target **26773 was reached through the natural queue**.
- The Phase 16.26 structural-compatibility path handled real production bytes correctly.
- An offline replay of the retained bytes is deterministic.
- Coverage is internally consistent.
- All attempts are terminal.
- There was no identity, review, v1, v2 or secret violation.
- **Phase 16.31 is closed.**

### 1. Function version / hash audit (after the second rotation)

- **Key file:** the user again gave the directory `/tmp/`. Listing names only found exactly one fresh candidate, `/private/tmp/recall-cpsc-page-worker-key.TKmpjV` (created 07:01:50 UTC). It is a regular file, not a symlink, owned by `stephaneds`, mode `600`, 65 bytes, 1 link, and outside the repo.
- **Versions:** all eight functions went up exactly +1 (worker **8 → 9**; the others 22→23, 17→18, 12→13, 9→10, 11→12, 8→9, 7→8).
- **Bundles:** all unchanged. The worker is still `c15d66238fef35bb425709b847593c2e6bc9f560b9f82d4ee784f2a60aa6f533` with `verify_jwt=true`.

### 2–6. Final pre-call gates (07:02:46 UTC, read-only)

- **Unchanged since 06:21:** 29 migrations with 16.29 once; cron job 2 only; v1 06:17 `success`; CPSC and HC `success` with no error; watermarks `2026-09-30`; `safe=true`; 1 hold, unresolved; the six quarantines; 31 eligible.
- **Page activity:** the last claim was 2026-09-29 16:55:03, so there was none since.
- **Queue:** `26761, 26773, 26774, 26775`, so the **target is 26773 and N = 2**.
- **Both targets:** blockers `{}`, 0 holds, 0 shared aliases, and an official canonical URL.

### 7. Forensic baseline (07:02:46)

| Table / row                         | Pre-call                                           |
| ----------------------------------- | -------------------------------------------------- |
| attempts / work states              | `6 c5cad457…` / `6 25d1655c…`                      |
| raw / fetches                       | `5 e1a8d0eb…` / `32 e4224a96…`                     |
| revisions / snapshots / ledgers     | `27 e3ad5f00…` / `5 47be9414…` / `5 caa85559…`     |
| candidates / review ledger          | 0 / 0                                              |
| identities / aliases / observations | `38 2f842e3a…` / `282 b4329ba8…` / `109 e84d35ad…` |
| holds / reconciliations             | `1 fe3a1b54…` / 0                                  |
| notices / scopes                    | `90 181e6ca9…` / `103 72642ee0…`                   |
| sync / automation state / runs      | `2 fe359eaf…` / `1 3f4b0e71…` / `58 2a0ad375…`     |
| matches, alerts, push, v2           | all 0                                              |

**Row fingerprints:**

| Row      | Identity    | Aliases        | Observations  | Other                  |
| -------- | ----------- | -------------- | ------------- | ---------------------- |
| 26761    | `256d4753…` | `8 56736442…`  | `3 0b76b5d3…` | revision `7df35ca1…`   |
| 26773    | `866e2d08…` | `12 d79fc6ad…` | `4 6dc55b2c…` | revision `8b6f2199…`   |
| 26777    | `465c3280…` | `10 08df249d…` | `3 2c627396…` | —                      |
| 20163    | `b93c26f8…` | —              | —             | work state `76778f2c…` |
| Intertex | —           | —              | —             | attempt `7f248918…`    |

### 8. The one POST

- **Request:** `{"maxPages":2,"timeBudgetMs":20000}`, with no identity, number, URL or override.
- **Caller:** the same no-secret one-shot caller, with a new `wx` sentinel, `phase-16-31b-post.sent`.

| Field    | Value                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| start    | 2026-09-30T07:02:57.614Z                                                                                                                                   |
| response | 2026-09-30T07:02:59.474Z                                                                                                                                   |
| duration | 1860 ms                                                                                                                                                    |
| status   | **200**                                                                                                                                                    |
| body     | `{"dryRun":false,"claimed":2,"completed":2,"failed":0,"errorCategories":[],"outcomes":["fetched_unchanged","fetched_unchanged"],"stoppedBy":"page_limit"}` |

**Exactly one request:** the edge logs for 2026-09-29 18:40 → 2026-09-30 07:10 contain exactly one worker request, `POST | 200` at 07:02:59.503. There was **no retry**.

### 9. Actual claim order

**26761 → 26773**, which equals the prediction.

### 10. Attempt terminality

| Recall | Attempt ID                             | Claimed         | Completed       | Outcome             | Error | Next attempt            | Claim    |
| ------ | -------------------------------------- | --------------- | --------------- | ------------------- | ----- | ----------------------- | -------- |
| 26761  | `a8c32835-e973-4ed1-bcbc-052a75b43e83` | 07:02:58.677167 | 07:02:59.337113 | `fetched_unchanged` | null  | 2026-10-01 07:02:59.337 | released |
| 26773  | `b40e7dcb-ce06-4975-8acb-46217a7b5dad` | 07:02:58.929602 | 07:02:59.354797 | `fetched_unchanged` | null  | 2026-10-01 07:02:59.355 | released |

- **Work state (both):** `attempt_count=1`, `consecutive_failures=0`, `manual_review_required=false`.
- **Open claims:** the only `claimed` row in production is the historical Intertex attempt.

### 11. Raw evidence

| Recall | SHA-256 (stored = DB-recomputed = attempt = fetch = local export)  | Bytes  | `<table>` | UTF-8 | Type                       | Final URL = canonical | Redirects | Retained        |
| ------ | ------------------------------------------------------------------ | ------ | --------- | ----- | -------------------------- | --------------------- | --------- | --------------- |
| 26761  | `a5db1f8d73689b7b4a2a8dff230bccf7851e0461a26dce70765c5212152aa406` | 78,993 | 0         | ✔     | `text/html; charset=UTF-8` | ✔                     | `[]`      | 07:02:59.173599 |
| 26773  | `0a684ae6e734a9752574ae1090349ca4c3a1c8cfafc99401aad25109a8601c8c` | 85,592 | **1**     | ✔     | same                       | ✔                     | `[]`      | 07:02:59.150841 |

Each payload is under 1 MB, on `www.cpsc.gov/Recalls/`, with HTTP 200, and retained before its semantic commit. The HTML was not printed.

### 12. Offline replay (Deno `--deny-net`, exact exported bytes)

**How it ran:** the bytes were exported read-only with `supabase db query --linked` straight to the scratchpad. The real modules ran: `extractCpscPageStructure`, then `semanticCpscRevision`, then `buildCpscSourceCoverage`.

**Result: both pages `ok`.**

- **Page checks:** raw SHA and recall number.
- **Semantic hash:** equal to the revision `evidence_hash` and to the snapshot.
- **Normalized evidence:** deep-equal.
- **Table identities:** equal to the snapshot **and** to the DB's `cpsc_expected_page_tables(legacy normalized_evidence)`.
- **Coverage:** full ledger and summary deep-equal; coverage and interpretation fingerprints equal.
- **Candidates:** all 18 candidates of 26773 equal as a multiset (fingerprint, kind, value, conjunction key, excerpt and full source address), and all are `unreviewed`.

A first comparison sorted candidates by evidence fingerprint alone. That sort is ambiguous because rows share fingerprints, so it reported a false mismatch. The field-by-field check and the corrected multiset comparison both agree exactly. Scratch copies were deleted.

### 13. 26773 table-bearing proof (§16 A–I)

| #   | Requirement                                 | Evidence                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Retained HTML has ≥1 relevant table         | 1 `<table>` in the stored bytes. The census yields table `description/table/0/93cf7095…` with 9 rows (model description and model number, `25302145`–`25302163`).                                                                                                                                                                                         |
| B   | Legacy revision has incomplete metadata     | revision `c7919ccf…`, `phase-16.9-v1`, `table_identities=[]`, 1 normalized table, no snapshot before the call                                                                                                                                                                                                                                             |
| C   | Phase 16.26 compatibility handles it        | the verified commit accepted it as `fetched_unchanged` (semantic hash `d37c79b3…` equals the legacy hash) and bound coverage to a new structural snapshot                                                                                                                                                                                                 |
| D   | Canonical snapshot correct                  | snapshot for `c7919ccf…`: parser `phase-16.13-structured-v2`, extractor `phase-16.11-html-v1`, census `phase-16.13-census-v1`, semantic hash `d37c79b3…`, 1 table / 9 row identities                                                                                                                                                                      |
| E   | Same canonical census                       | snapshot identities = `cpsc_expected_page_tables(revision.normalized_evidence)` = offline census identities (exact equality). All 9 ledger reviewable relations are `description/table/0/93cf7095…/<row>` for exactly those 9 row identities                                                                                                              |
| F   | No destructive rewrite                      | still 1 revision for the identity. Setting `last_seen_at` back reproduces the pre-call row MD5 `8b6f2199…` and the whole table fingerprint `27 e3ad5f00…`, and `table_identities` stays `[]`                                                                                                                                                              |
| G   | Every table record accounted                | ledger 14 authoritative = 14 accounted: 10 `parsed_reviewable`, 4 `ignored_non_safety`, 0 unresolved, 0 unsupported, 0 deferred                                                                                                                                                                                                                           |
| H   | No unsupported negative inference is usable | the ledger shows `negative_evidence_eligible=true` (the rule universe is structurally complete), but serving requires reviewed rule sets. `cpsc_scope_rule_set_coverage(scope 4b09222d…)` gives `complete=false` with served 0 of 9 proposed; `cpsc_scope_rule_set_envelope` gives **null**. There are 0 reviewed criteria and 0 v2 rule sets or criteria |
| I   | Candidates unreviewed                       | 18 candidates (9 `model_exact` + 9 `date_code_set`, one pair per row relation), all `status=unreviewed`; review ledger 0; decision invalidations 0; reviewer authorizations 0                                                                                                                                                                             |

### 14. Structural compatibility details (26773)

| Item                                   | Value                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| previous semantic revision             | `c7919ccf-aace-407e-b9b9-70601f50843d` (`phase-16.9-v1`)                                               |
| reused or new                          | **reused** (`fetched_unchanged`)                                                                       |
| old table identity state               | `[]` (legacy), unchanged                                                                               |
| new structural snapshot                | 1 snapshot, 1 table, 9 row identities                                                                  |
| canonical table count / identifier     | 1 / `description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978`             |
| authoritative / accounted / missing    | 14 / 14 / **0**                                                                                        |
| dispositions                           | parsed_reviewable 10, parsed_deferred 0, unresolved 0, unsupported 0, ignored_non_safety 4             |
| criterion / coverage / positive status | `complete` / `complete` / `independent`                                                                |
| negative_evidence_eligible             | `true` (not servable; see H)                                                                           |
| ledger                                 | `4a7ec80a-6935-43a2-9580-244609671a23`, seq 14, coverage FP `faea74e5…`, interpretation FP `38d9006c…` |

**26761 (zero-table):** revision `be46b5f8…` reused and snapshot `[]`. Ledger `cee969a2…` (seq 13) has 3 authoritative / 3 accounted records, all `ignored_non_safety`; criterion and coverage `unresolved`, positive `independent`, negative evidence `false`, 0 candidates.

### 15–16. Coverage, candidates and review

- **Coverage:** as in §13–14.
- **Candidates:** 18 new, all `unreviewed`, each linked to revision `c7919ccf…`, with the sole scope `4b09222d…` proposed.
- **Review:** 0 reviewed criteria, 0 review-ledger rows, and nothing served to v1 or v2.

### 17. Redirects / holds

There were no redirects (both chains `[]`, final URL canonical) and no `identity_redirect`. Holds are still exactly 1 (26777, `origin_attempt` null, 0 resolutions), so **no new hold**.

### 18. 26777

- Never claimed: 0 work state, 0 attempts.
- Blocker `human_reconciliation_required`; hold unresolved; 0 reconciliations.
- Identity `465c3280…`, aliases `10 08df249d…` and observations `3 2c627396…` all unchanged.

### 19. Previous-history regression

- Intertex attempt `7f248918…` unchanged (historical `claimed`).
- 20163: identity `b93c26f8…`, work state `76778f2c…` and attempt `b7179df8…` unchanged.
- The four 16.31 attempts are unchanged (`7877ee4c…`, `9db23122…`, `2e7eda0c…`, `cd5a0b65…`).
- The revisions table differs from before the call only by the two `last_seen_at` values (reconstruction proof in F).

### 20. v1 / watermarks

- **Unchanged:** sync state `2 fe359eaf…`, automation state `1 3f4b0e71…`, runs `58 2a0ad375…`, notice jurisdictions and scopes. Matches, alerts, push and owned products are all 0.
- **No overlapping cron:** there was no natural cron activity between 06:17 and 07:04.
- **`recall_notices` (designed Phase 16.13 touch, identified explicitly):** exactly 3 rows changed `updated_at` only, each equal to its attempt's completion time through `cpsc_touch_identity_notices`:
  - notices 10986 and 10989, linked to 26773 (its two-notice duplicate group), at 07:02:59.354797
  - notice 10967, linked to 26761, at 07:02:59.337113

### 21. v2 / provider

- All v2 tables are 0: evaluations, eligibility, snapshots, corrections, evidence, rule sets, criteria and legacy snapshots.
- The v2-cohort bundle is unchanged, with only the rotation version bump.
- There was no provider or Nebius call; the worker bundle has no provider reference.
- **Matching policy:** not readable from the DB, so it rests on 16.28's listing (default `phase_10_guarded_v1`) plus the all-zero v2 state.

### 22. DB integrity

**Zero orphans across all 6 checks:**

- fetch without revision
- ledger without snapshot
- unreferenced raw payload
- successful attempt missing links
- candidate without revision
- candidate without ledger

**Linkage for each new page:** work state → attempt → raw payload (by SHA) → fetch → reused revision → structural snapshot (same semantic hash) → coverage ledger → candidates (26773 only).

### 23. Exact persistent production diff (07:02:46 → 07:04:06)

| Table                            | Before         | After          | Explanation                                         |
| -------------------------------- | -------------- | -------------- | --------------------------------------------------- |
| `cpsc_page_attempts`             | 6              | 8              | 2 terminal attempts                                 |
| `cpsc_page_work_state`           | 6              | 8              | 2 rows                                              |
| `cpsc_page_raw_payloads`         | 5              | 7              | 2 payloads                                          |
| `cpsc_page_fetches`              | 32             | 34             | 2 fetches                                           |
| `cpsc_page_structural_snapshots` | 5              | 7              | 2 snapshots (26773 carries 1 table / 9 rows)        |
| `cpsc_page_coverage_ledgers`     | 5              | 7              | 2 ledgers (seq 13, 14)                              |
| `cpsc_candidate_criteria`        | 0              | 18             | 26773 proposals, all `unreviewed`                   |
| `cpsc_page_revisions`            | `27 e3ad5f00…` | `27 7988c46d…` | `last_seen_at` on 2 reused revisions only (proof F) |
| `public.recall_notices`          | `90 181e6ca9…` | `90 81cef330…` | `updated_at` on 3 linked notices (§20)              |
| all other 44 tables              | —              | byte-identical | —                                                   |

**Outside the application tables:**

- the user's secret rotation (function versions +1)
- the replay export's `supabase db query --linked`, which refreshed the platform-managed `cli_login_postgres` short-lived login (same mechanism as 16.31)

### 24. Key cleanup

- `/private/tmp/recall-cpsc-page-worker-key.TKmpjV` was deleted in the same shell step right after the POST. Its absence is verified, and 0 `recall-cpsc-page-worker-key.*` files remain.
- The value was never printed.
- The scratchpad holds only:
  - the no-secret caller
  - two timestamp sentinels
  - `replay.ts`

### 25. Quality / secret gates

- **No source modification:**
  - worker source set `9e6e318e…4a02` unchanged
  - 29 migrations
  - 36 tracked modifications, as before
  - no code, schema or test edits; only this report changed (204 status entries)
- **Hygiene:** `git diff --check` is clean. The secret-pattern scan (JWTs, `sb_*` key values, credentialed Postgres URLs) over the scratchpad, this report and the diff found **0**, and there are 0 64-hex tokens in the caller or sentinels.
- **Formatting:** the report is formatted with Prettier.
- **Offline replay:** deterministic (§12).
- **Test suites:** not re-run, since no code changed and no defect was found.

### 26. Classification: **GREEN**

**Every GREEN criterion is met:**

- 26773 was reached naturally.
- The table-bearing HTML is confirmed from the retained bytes.
- Structural compatibility works on real production bytes.
- Coverage is internally consistent (14 / 14, same census).
- The replay is deterministic.
- Both attempts are terminal.
- There were no identity, review or security violations; 26777 stays blocked; v1 is unaffected; v2 and providers are inactive; nothing secret was exposed.

**Phase 16.31 is closed.** The worker remains **unscheduled**.

### 27. Phase 16.32 recommendation: pre-scheduling readiness (no schedule in 16.32 without separate approval)

1. **Human operator capability:** grant `identity_reconciliation` to a named human (0 holders today), with a hold-review workflow for `worker_identity_redirect` and manifest holds, starting with 26777.
2. **Candidate review readiness:** 26773 now has 18 unreviewed candidates and a structurally complete ledger with `negative_evidence_eligible=true`. Before any reviewer is authorized, define the review workflow, the reviewer authorization, and the rule that nothing is served until reviewed rule sets exist (verified: envelope null, coverage incomplete).
3. **Admission budget, using observed timings:**
   - 16.31: 4 pages in about 1.6 s of claims, then admission closed at about 2 s.
   - 16.31b: 2 pages, 0.43–0.66 s each; the first claim came about 1.06 s after the client request.
   - Choose the interval, batch size (`maxPages`), concurrency and reserve constants from these.
4. **Upstream-outage behaviour:** the CPSC 502 on 2026-09-29 18:17 (v1 `partial_success`). Define backoff and circuit-breaking so page cycles pause when the v1 CPSC source is failing.
5. **Operations:** backpressure, observability (attempt outcomes, holds, ledger status), a kill switch, and a page cron job independent from v1 job 2.
6. **Key custody:** replace rotate-per-call manual provisioning with a durable scheduler-held credential design.
7. **Rollout and rollback criteria:** include what to do with the 18 unreviewed candidates and the append-only evidence if scheduling is paused or rolled back.
