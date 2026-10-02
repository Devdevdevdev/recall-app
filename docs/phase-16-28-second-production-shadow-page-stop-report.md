# Phase 16.28 — second authorized production shadow page — stop report

**Classification: GREEN (path A — semantic success).** Exactly one production POST was sent. The worker naturally claimed the predicted target, recall 20163. It retained validated raw bytes and reused the frozen legacy semantic revision (`fetched_unchanged`). Through the Phase 16.26 path it recorded a structural snapshot and a coverage ledger. The attempt terminalized and 0 candidates were proposed. The worker remains unscheduled. Stop for review.

## Timeline (UTC, 2026-09-29)

| When         | Event                                                                                           | Actor       |
| ------------ | ----------------------------------------------------------------------------------------------- | ----------- |
| 09:28–09:32  | First read-only preflight, prediction, and baseline                                             | Claude      |
| ≈09:33       | Claude's `CPSC_PAGE_WORKER_KEY` rotation denied by the auto-mode permission gate; phase stopped | Claude gate |
| before 09:4x | Manual rotation of `CPSC_PAGE_WORKER_KEY` (see §2 for two version bumps)                        | User        |
| 09:51:17     | Refreshed read-only preflight, prediction, safety gate, and 51-table baseline                   | Claude      |
| 09:51:52.552 | **The one authorized POST**                                                                     | Claude      |
| 09:51:54.487 | HTTP 200 received; the key file was deleted immediately after                                   | Claude      |
| 09:52–10:0x  | Post-call audit, offline replay, local gates, and scans                                         | Claude      |

No deploy, migration, schedule, review, reconciliation, v2 run, provider call, commit, or push occurred.

## 1. Secret rotation (no value disclosed)

- **Performed by the user.** Claude's own attempt was blocked by the permission gate before execution, and nothing ran.
- **Checks (boolean comparison only):**
  - 17 secret names, name set unchanged
  - `CPSC_PAGE_WORKER_KEY` present and its value changed against the 09:29 baseline
- **Key format:** 64 characters, consistent with 256-bit hex, as the user reported.
- **Limitation:** the pre-rotation baseline recorded only a whole-set fingerprint. The other 16 secrets are not individually proven unchanged from digests; that rests on the user's statement.
- **Database role:** `cpsc_page_worker` was not altered by Claude.

## 2. Function version / hash audit

| Function                           | 09:29 (pre) | 09:4x (post-rotation) | 09:5x (post-call) | Bundle SHA-256                                                       |
| ---------------------------------- | ----------- | --------------------- | ----------------- | -------------------------------------------------------------------- |
| `process-cpsc-page-evidence`       | 3           | 4                     | 5                 | `0194da286210fa990a613e81e272adad273041ec7fee66fda6230a1772d2e41f` ✔ |
| `ingest-cpsc-recalls`              | 18          | 19                    | 20                | `2b0774c5…0dc3` ✔                                                    |
| `process-recall-matches`           | 13          | 14                    | 15                | `81f96b1d…d6b` ✔                                                     |
| `send-recall-notifications`        | 8           | 9                     | 10                | `58b6945b…11f5` ✔                                                    |
| `run-recall-automation`            | 5           | 6                     | 7                 | `29aa1681…ef6c` ✔                                                    |
| `ingest-recall-source`             | 7           | 8                     | 9                 | `ba394992…869d` ✔                                                    |
| `ingest-recall-sources`            | 4           | 5                     | 6                 | `c41cb92e…aae6` ✔                                                    |
| `process-recall-matches-v2-cohort` | 3           | 4                     | 5                 | `682308bd…1f1e` ✔                                                    |

**Two platform version bumps** occurred on all eight functions:

- The first came before Claude's post-rotation check.
- The second came between that check and the call. The edge log shows the call ran on **version 5**.
- This is consistent with `secrets set` having run twice. A second 0600 key file, `/tmp/recall-cpsc-page-worker-key.Wy0a3t` (65 bytes, created 09:40 UTC), remains on disk.
- Claude did not read, use, or delete it. The live key is the one in the supplied file, `…M4z1cF`, which the worker accepted.

`updated_at` and every bundle SHA are unchanged across all bumps, so no code change occurred.

## 3. Refreshed preflight (09:51:17 UTC)

Every check passed:

- **Migrations:** 28, with `20260928155514` (16.26) present exactly once.
- **Worker:** `0194da28…` with `verify_jwt=true`, unscheduled.
- **Cron:** only job 2, `17 */6 * * *`, active, command MD5 `07549bf985a3034a5ef9c645692097b6`, no page reference. Last runs at 06:17 and 00:17 succeeded; the 12:17 run had not yet happened.
- **Latest v1 run:** 06:17 cron `success`, no error.
- **Sources:** CPSC `last_publish_date=2026-09-29` success; Health Canada `last_updated_date=2026-09-29` success.
- **Automation:** watermark `2026-09-29`; 0 automation leases; 0 matching leases.
- **CPSC safety:** `safe=true`, quarantined 9 / retained 9, `unaccounted=[]`, `legacyHashOnly=0`. Quarantine ID-set MD5 `21a70604b31b50ddb67ee7e9f8bc4050`.
- **Page state:** 1 attempt, 1 work-state, 0 raw payloads, ledgers, candidates, and snapshots; 27 revisions and 27 fetches.
- **Zero-count tables:** reviewed criteria, rule sets, v2 evaluations / eligibility / snapshots / corrections, matches, alerts, push queue, push deliveries, review ledger, and reconciliations are all 0.
- **Full snapshot:** the 51-table fingerprint snapshot is **byte-identical to 09:28**, so no page activity occurred between the two stops.

## 4. Refreshed natural claim prediction

A read-only replica of `claim_cpsc_page_evidence` (same filters and ORDER BY, no lock, no RPC) gave:

1. **20163**, `4c082234-f8cc-4153-81b2-5d460b742717`, `https://www.cpsc.gov/Recalls/2020/CPSC-and-Crown-Darts-UK-Warn-Consumers-to-Stop-Using-and-Dispose-of-Banned-Lawn-Dart-Sets-Recalling-Firm-is-Unable-to-Conduct-Recall`
2. 20164
3. 20165

**Due-time inputs for 20163:**

- no work-state, so `next_attempt_at` is `-infinity`
- `first_seen_at` is 2026-09-26 19:14:08.209996, tied with its peers
- the tie is broken by recall-number text order

Intertex 20162 has `next_attempt_at` 2026-09-28 and sorts after every never-attempted identity.

## 5. Target safety gate (20163): PASS

| Check                                                  | Value                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| identity_status                                        | `reconciled`                                                                          |
| canonical URL official `https://www.cpsc.gov/Recalls/` | yes; `cpsc_canonical_url(url)=url`                                                    |
| canonical notice                                       | `fba00000…` (external_id 8876), `official_url` equal                                  |
| links                                                  | identity → 1 notice; notice → 1 identity                                              |
| observations                                           | 2, both `resolved` / `A_known_alias`; 0 unresolved                                    |
| quarantined                                            | no (not in the nine)                                                                  |
| alias collisions with other identities                 | 0 (6 aliases, api_id 8876 plus the official URL)                                      |
| reconciliation rows                                    | 0                                                                                     |
| prior page state                                       | legacy revision `e20b2c5c…` (`phase-16.9-v1`, `table_identities=[]`), one 09-24 fetch |
| is 26777                                               | no                                                                                    |

## 6. Forensic baseline

The baseline is a count plus a row-hash fingerprint for all 51 `public` / `private` tables:

- **Method:** `md5(string_agg(md5(row::text) order by …))`.
- **When:** captured at 09:51 UTC, immediately before the call.
- **Old attempt:** `0bf98d4e…` row MD5 `7f248918a8ea01403126710604bff7f6`.
- **Old work-state row MD5:** `acefbe90000cca4fad03727e845a3676`.
- **20163 legacy revision row MD5:** `344fd4dee61c63bb2b5bf7fcbdbc07de`.
- **26777 identity row MD5:** `465c32809b5b50ce29d4c36a8177fe80`.

## 7. The single call

**Caller:**

- **Headers:** a one-shot Node caller sent the publishable key as `apikey` plus `Authorization: Bearer`. This is the exact shape 16.27's smoke used; edge logs show the gateway minted a compatibility JWT for it. It also sent `x-cpsc-page-worker-key`, read internally from the 0600 file.
- **Body:** `{"maxPages":1,"timeBudgetMs":20000}`.
- **Safeguards:**
  - no service_role, and no URL, identity, recall, or queue override
  - a "sent" sentinel was written before the request, so the caller refused to run a second time
  - headers, environment, and key were never printed

**Result:**

| Field          | Value                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| request start  | 2026-09-29T09:51:52.552Z                                                                                                               |
| response       | 2026-09-29T09:51:54.487Z                                                                                                               |
| duration       | 1935 ms client-side; edge `execution_time_ms` 1728                                                                                     |
| HTTP status    | **200**                                                                                                                                |
| body           | `{"dryRun":false,"claimed":1,"completed":1,"failed":0,"errorCategories":[],"outcomes":["fetched_unchanged"],"stoppedBy":"page_limit"}` |
| error category | none                                                                                                                                   |

- The edge log for 09:28–10:00 contains exactly **one** function request: this POST. There was no retry.
- 20 s is the worker's cycle budget, not a proven hard total response deadline.

## 8. Predicted vs actual claim

The actual claim was identity `4c082234-f8cc-4153-81b2-5d460b742717`, recall 20163. It **matches the prediction**.

## 9. New attempt (terminal)

| Field              | Value                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------- |
| attempt ID         | `78c7f3b8-f0c1-4d2f-87d1-045e79ce6d47`                                                 |
| identity / recall  | `4c082234…` / 20163                                                                    |
| claimed_at         | 2026-09-29 09:51:53.658643Z                                                            |
| completed_at       | 2026-09-29 09:51:54.298768Z                                                            |
| outcome            | **`fetched_unchanged`** (terminal)                                                     |
| error_code         | null                                                                                   |
| http_status        | 200                                                                                    |
| final_url          | the canonical URL (§4)                                                                 |
| raw_payload_sha256 | `646b42409a5dfa8eb9d136e0bbe77f633d85ca3cea53b9d862e3649c869eed1e` (= `raw_page_hash`) |
| revision_id        | `e20b2c5c-7074-45b0-b9e1-7ff38bb3903e` (reused)                                        |
| fetch_id           | `c8a37c17-6226-4661-860f-f99ae2361723`                                                 |
| transport          | content type `text/html; charset=UTF-8`, redirect chain `[]`, fetched_at 09:51:54.027  |

After the call, the only `claimed` attempt in production is the historical one.

## 10. Claim / lease / retry state (20163 work-state)

| Field                  | Value                                        |
| ---------------------- | -------------------------------------------- |
| claim_id               | null (released)                              |
| claim_expires_at       | null                                         |
| next_attempt_at        | 2026-09-30 09:51:54.298768Z (success +1 day) |
| attempt_count          | 1                                            |
| consecutive_failures   | 0                                            |
| last_outcome           | `fetched_unchanged`                          |
| last_success_at        | 2026-09-29 09:51:54.298768Z                  |
| manual_review_required | false                                        |

Production has 0 active leases. The retry state matches the success semantics.

## 11. Transport and fetch-security evidence

- **Final URL:** the canonical URL, via HTTPS on host `www.cpsc.gov` under `/Recalls/`.
- **Redirects:** 0, chain `[]`. The DB-side retain validated canonical URL equality and every redirect element.
- **Content type:** `text/html; charset=UTF-8`, which the DB check constraint and the retain RPC both accept.
- **Encoding:** valid UTF-8. The DB checked `convert_from`, and the offline replay used a fatal decoder.
- **Size:** 79,724 bytes, under the 1,000,000-byte limit.
- **Timing:** the fetch completed about 0.4 s after the claim. The 10 s timeout contract is enforced in code and was not exercised.
- **Conditional-GET metadata:** `etag` `"1790648494"`, `Last-Modified` Tue, 29 Sep 2026 02:21:34 GMT.

## 12. Raw payload

The stored `sha256`, the SHA-256 the DB recomputed over the stored `raw_bytes`, the content-address key, the attempt's `raw_payload_sha256`, and the worker's `rawPageHash` all equal `646b42409a5dfa8eb9d136e0bbe77f633d85ca3cea53b9d862e3649c869eed1e`.

- **Size:** `byte_length` equals `octet_length`, 79,724.
- **Retained at:** 09:51:54.054718, before the semantic commit, so transport-first ordering is observed.
- The HTML was not printed.

## 13. Offline replay of the exact stored bytes

The stored bytes were exported read-only to scratch; their local SHA-256 is identical. They were replayed with Deno `--deny-net`, no DB, through the real modules: `extractCpscPageStructure`, then `semanticCpscRevision`, then `buildCpscSourceCoverage`.

| Comparison                                         | Result                                                                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| recall number                                      | 20163                                                                                                                                                                                                  |
| semantic hash vs stored revision                   | equal (`db375bbc470baddc2fe9e8a23eea7e09012059b56b1a7ca1d87f9b4a15be124a`)                                                                                                                             |
| normalized evidence vs stored revision             | deep-equal                                                                                                                                                                                             |
| table identities vs revision / structural snapshot | `[]` = `[]` = `[]`                                                                                                                                                                                     |
| census description tables                          | 0                                                                                                                                                                                                      |
| full coverage ledger vs stored ledger              | deep-equal                                                                                                                                                                                             |
| summary / coverage FP / interpretation FP          | equal (`ae87afd9…9d93` / `be02286c…f4c6`)                                                                                                                                                              |
| candidates proposed vs stored                      | 0 / 0                                                                                                                                                                                                  |
| section hashes vs stored revision                  | **differ, as expected.** The reused revision keeps its frozen `phase-16.9-v1` five-key section layout; the 16.13 parser produces a three-key layout. Section hashes are not part of the semantic hash. |

## 14. Structural-compatibility (Phase 16.26) result

- **Path taken:** the frozen legacy revision (`phase-16.9-v1`, `table_identities=[]`) was reused. The verified commit then recorded `private.cpsc_page_structural_snapshots`:
  - revision `e20b2c5c…`, parser `phase-16.13-structured-v2`, extractor `phase-16.11-html-v1`, census `phase-16.13-census-v1`
  - semantic hash equal to the revision's
  - `table_identities=[]`
- **Agreement:** `cpsc_expected_page_tables(normalized)`, the revision identities, and the snapshot identities are all `[]` and equal. Coverage binding used the snapshot, and there is no ledger without a matching snapshot.
- **Frozen revision:** changed only `last_seen_at`, from 2026-09-24 05:34:58.966188 to 09:51:54.298768. This is proven by reconstructing both the row MD5 and the pre-call table fingerprint.
- **Limit:** this page has **zero description tables**, so the legacy empty identity list was already correct. The drift case that failed for Intertex (legacy `[]` while the page actually has tables) was **not** exercised live. It remains proven only by the rollback fixtures from 16.26 and 16.27.

## 15. Semantic result

`fetched_unchanged`: the semantic hash equals the existing revision's. No duplicate revision was created, and the revision count stays at 27.

## 16. Fetch / revision linkage

- New fetch `c8a37c17…` links identity `4c082234…` to revision `e20b2c5c…`. It has `raw_page_hash` `646b4240…`, the canonical final URL, and redirect chain `[]`.
- The attempt's `fetch_id` and `revision_id` match it.
- The 27 prior fetches are unchanged, fingerprint equal to baseline.

## 17. Coverage ledger

Ledger `1898099e-2d66-4688-9aee-6e49002437d8`, version `phase-16.13-coverage-v1`, on revision `e20b2c5c…`:

| Metric                     | Value         |
| -------------------------- | ------------- |
| authoritative_records      | 4             |
| accounted_records          | 4             |
| reviewable_relations       | `{}`          |
| parsed_reviewable          | 0             |
| parsed_deferred            | 0             |
| unresolved                 | 0             |
| unsupported                | 0             |
| ignored_non_safety         | 4             |
| structural_status          | `complete`    |
| criterion_status           | `unresolved`  |
| coverage_status            | `unresolved`  |
| positive_status            | `independent` |
| negative_evidence_eligible | **false**     |
| blockers                   | `[]`          |

- **Structure:** one prose structure with 4 records and 0 anomalies, and no tables.
- **Scope of the claim:** the records are fully accounted. Criterion and coverage completeness are **unresolved**, and no negative evidence may be derived.
- **Sequence gap:** `recorded_seq=7` for the first production ledger. The 16.27 rollback-only fixtures consumed the sequence, which is non-transactional. This is not a hidden row; the ledger count is 1.

## 18. Candidates and review

- 0 candidates proposed or persisted.
- 0 review-ledger rows, reviewer authorizations, reviewed criteria, and rule sets.
- Nothing reaches the pending human-review path, and no review decision was made.

## 19. Identity mutations

None. The identities (38), aliases (282), links (41), observations (109), sightings, payloads, and reconciliations (0) all have fingerprints identical to baseline. There was no merge, alias reassignment, or canonical ownership rewrite.

## 20. 26777: state and pre-scheduling note

- **Identity:** `d3d6654d-cf54-4edf-a095-ff82cd5a15cc`, `reconciled`.
- **URL:** `…/Hayward-Industries-Recalls-Universal-Pool-Heaters-…-Poisoning-Hazard-0`.
- **Fingerprint:** `05137337…5cc7`; last seen 2026-09-27 05:43:30Z.
- **Unchanged:** row MD5 unchanged, with 0 work-state, attempts, reconciliation rows, and candidates.
- **Observations:** all `resolved` / `A_known_alias`.

> **Pre-scheduling review item:** 26777 is page-claim-eligible at **natural position 16** out of 38.
>
> Its `reconciled` status comes from the historical backfill; there are **0 human reconciliation rows**. Earlier phases treated 26777 as a human-only identity case: the `-Hazard-0` URL, 2 notice links, and 10 aliases.
>
> An unattended schedule would fetch it within a few cycles. Whether that is acceptable must be decided before any scheduling. This phase did not decide it.

## 21. Original Intertex attempt

`0bf98d4e-9c4b-42ce-a430-d20bfe97ac84` is unchanged:

- still `claimed`, with `completed_at` null and all transport columns null
- row MD5 `7f248918…` unchanged
- its work-state row MD5 `acefbe90…` unchanged

It was not repurposed or terminalized.

## 22. Watermarks

The CPSC source watermark, Health Canada watermark, and automation watermark are unchanged. Their row fingerprints for `recall_source_sync_state` and `recall_automation_state` equal the baseline. No cron run occurred between the baseline and the audit.

## 23. v1 isolation

Owned products, matches, alerts, push queue, push deliveries, push devices, matching leases, automation lease, runs, and pending recalls are unchanged.

**One designed side effect, fully explained:**

- `public.recall_notices` row `fba00000…` (20163's canonical notice) changed **only** `updated_at`, from 2026-09-15 05:12:22.095037 to 09:51:54.298768.
- **Cause:** `record_cpsc_page_coverage` calls `private.cpsc_touch_identity_notices` (Phase 16.13 contract), so that in-flight v2 evaluations of the notice finalize as stale.
- **Proof:** substituting the old `updated_at` reproduces the exact pre-call table fingerprint `ad8952229d3ccbee13a5e7878f080cfa`.
- **v1 impact:** v1 uses `recall_notice_updated_at` only as an optimistic-concurrency token when finalizing, not to select work. Pending recalls come only from ingestion. With 0 owned products, there is no v1 effect.

## 24. v2 / provider isolation

- **Policy:** `RECALL_MATCHING_POLICY` is absent from the secret names, so the default `phase_10_guarded_v1` applies.
- **v2 activity:** 0 v2 evaluations, eligibility, snapshots, corrections, criteria, and rule sets. There was no cohort invocation; the only edge request in the window was the page POST.
- **Provider calls:** none. The worker bundle has no provider reference (16.27 source audit, unchanged bundle).

## 25. DB integrity

All checks returned 0:

- attempt without identity
- attempt without raw payload
- attempt without matching fetch (identity, revision, and hash)
- fetch without revision
- snapshot without a revision with an equal hash
- ledger without a revision with an equal `sourceSemanticRevision`
- ledger without a matching structural snapshot
- unreferenced raw payload
- work-state without identity

## 26. Exact persistent production diff (DB)

| Table                                    | Change                                                   |
| ---------------------------------------- | -------------------------------------------------------- |
| `private.cpsc_page_attempts`             | +1 (`78c7f3b8…`, terminal `fetched_unchanged`)           |
| `private.cpsc_page_work_state`           | +1 (20163, released, next +1 day)                        |
| `private.cpsc_page_raw_payloads`         | +1 (`646b4240…`, 79,724 B)                               |
| `private.cpsc_page_fetches`              | +1 (`c8a37c17…`)                                         |
| `private.cpsc_page_structural_snapshots` | +1 (revision `e20b2c5c…`, `[]`)                          |
| `private.cpsc_page_coverage_ledgers`     | +1 (`1898099e…`)                                         |
| `private.cpsc_page_revisions`            | `e20b2c5c…` `last_seen_at` only                          |
| `public.recall_notices`                  | `fba00000…` `updated_at` only (designed staleness touch) |
| all other 43 tables                      | identical fingerprints                                   |

**Non-DB changes:** the user's `CPSC_PAGE_WORKER_KEY` rotation, and function version metadata +2 on all eight functions (bundles unchanged). All new evidence is retained as audit history.

## 27. Local quality gates (after a clean reset)

| Gate                                              | Result                          |
| ------------------------------------------------- | ------------------------------- |
| `supabase db reset --local --no-seed`             | 28 migrations, 0 identities     |
| Full pgTAP (including the remote suites)          | **1681 / 1681**, 20 files, PASS |
| Full Node suite                                   | **385 / 385**                   |
| Targeted worker tests (`phase-16-23-page-worker`) | 14 / 14                         |
| Deno check (all functions + `_shared/cpsc`)       | exit 0                          |
| Expo `tsc --noEmit`                               | exit 0                          |
| DB lint `--level error`                           | 0 results                       |
| Freeze guards 9.1 / 15 / 16                       | `frozen=true` ×3                |
| `git diff --check`                                | clean                           |

- The backfill rehearsal was not run, so there was no residue hazard.
- The worktree is unchanged apart from this report: 196 entries before this file, and no commit.

## 28. Credential cleanup

- **Deleted:** the supplied key file `/tmp/recall-cpsc-page-worker-key.M4z1cF`, the caller script, and the sentinel. No variables persisted, and shell tracing stayed off.
- **Not deleted:** the second key file `/tmp/recall-cpsc-page-worker-key.Wy0a3t` (see §2). The user should delete it.
- **Exact live-key scan:** every token of 32+ characters in 180 files was SHA-256-compared against the live secret's digest, with **0 matches**. The files covered the scratchpad, this session's transcript and tool outputs, the `git diff`, and all untracked docs, scripts, tests, and supabase files.
- **Pattern scan:** 0 `sb_secret_`, 0 JWTs, 0 Postgres URLs with passwords, and 0 worker headers with values.
- The DB URL and publishable key were read internally and never printed.

## 29. Classification

**GREEN, path A.**

- The claim was the natural, predicted, safety-gated target.
- Transport was validated and the raw bytes are retained with every SHA equal.
- The attempt is terminal and the lease is released, with correct retry state.
- The frozen legacy revision was reused without rewrite. The 16.26 structural snapshot and the census agree.
- The coverage ledger is valid and replay-identical. There are 0 candidates, no review, and no identity mutation.
- Watermarks and v1 are isolated; the notice touch is designed and proven `updated_at`-only.
- v2 and providers are inactive. There was exactly one POST and no credential exposure.

## 30. Remaining risks

1. **Intertex-style drift case not exercised live.** This page has no tables, so a legacy revision with `[]` identities on a page that does have tables is still proven only by fixtures.
2. **26777 is page-eligible at position 16** with backfill-only reconciliation (§20). Resolve this before scheduling.
3. **Second worker-key file and a second version bump** (§2). Which rotation produced the live key is inferred only from the accepted call; delete `…Wy0a3t`.
4. **Legacy section hashes.** The reused revision keeps them; the new parser's section hashes are not persisted anywhere. This is an observability gap, not a safety one.
5. **Designed notice `updated_at` touch.** Every successful coverage write will bump the canonical notice's `updated_at`. That is harmless now, but at schedule scale it will churn `updated_at` for every page-processed notice, which would affect any future consumer that treats `updated_at` as "content changed".
6. **Untested failure paths.** The DB-timeout, semantic-rejection, and identity-redirect paths remain unexercised in production.
7. **Historical attempt.** It stays `claimed` and expired by design. Tooling must detect active claims through the work-state lease.
8. **Permission gate.** The auto-mode gate blocks Claude from secret writes; key rotation remains a manual operator step.

## 31. Phase 16.29 recommendation

1. **Review and decide 26777** (and any other backfill-only-reconciled identity with multi-link or alias history) before any scheduling. Options include marking such identities `manual_review_required`, or excluding them from the claim set through a reviewed migration.
2. **Plan one more authorized single-page shadow call on a table-bearing legacy page.** The purpose is to exercise the live 16.26 drift path. Either wait for one to reach the natural queue head, or run a separately reviewed targeting decision (not a manual work-state edit).
3. **Decide whether to persist new-parser section hashes** in the structural snapshot, and whether the notice `updated_at` touch should be limited to changed coverage.
4. **Operator hygiene:** delete `/tmp/recall-cpsc-page-worker-key.Wy0a3t`, and record the rotation procedure so it produces a single `secrets set`.
5. **Scheduling:** keep scheduling, automation integration, review, v2, and Nebius out of scope until items 1 and 2 are GREEN.
