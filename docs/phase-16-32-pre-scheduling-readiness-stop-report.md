# Phase 16.32 — pre-scheduling operational readiness — stop report

Continuation of [Phase 16.31b](phase-16-31b-table-bearing-continuation-stop-report.md) (GREEN). Phases [16.29](phase-16-29-page-identity-eligibility-stop-report.md), [16.30](phase-16-30-install-page-identity-eligibility-stop-report.md) and [16.31](phase-16-31-natural-shadow-batch-stop-report.md) were read in full.

**Classification: YELLOW-safe.** The operational design is complete, implemented locally and tested:

- **Local implementation:** one additive migration, one new pgTAP suite, 11 Node tests and 2 Deno tests.
- **Tests:** full pgTAP 2145/2145, Node 397/397, and every other gate passes.
- **Production:** read only throughout. Nothing was mutated.

**Why not GREEN:** four essential decisions belong to the project owner, and none can be settled from the code (§25–26):

- who the human operator is, and whether operators must use MFA
- whether to accept the platform's pg_net credential exposure
- whether to harden a v1 retry gap that a concurrent page commit could trigger
- how 26777's moved page may be reconciled

**Not done:** no production migration, deploy, cron change, page POST, schedule, capability grant, review decision, reconciliation, v2 activity, provider call, or commit or push. Stop for review.

---

## 1. Worktree audit

- **Branch:** `main`. Nothing was reset, cleaned, committed or pushed, and all inherited work is preserved.
- **Status:** 204 entries at the start, 208 now plus this report. There are still 36 tracked modifications; `tsconfig.json` was already one of them.
- **Reviewed artifacts:** byte-identical to their recorded hashes.

| Artifact                                           | SHA-256                  | Recorded in  |
| -------------------------------------------------- | ------------------------ | ------------ |
| migration `20260929110000_phase_16_29_…`           | `154b96b0…3c4c` ✔        | 16.29/16.30  |
| manifest `docs/phase-16-15-backfill-manifest.json` | `e3ab192c…d9ed` ✔        | 16.15/16.30  |
| worker source set (9 files, 16.27 method)          | `9e6e318e…4a02` ✔        | 16.29–16.31b |
| 16.29 report                                       | `e1f9e09a…36ef` ✔        | 16.30        |
| remote 16.26 suite (before this phase's edit, §21) | `9a04ad69…715e` ✔        | 16.29        |
| production worker bundle                           | `c15d6623…a6f533` ✔ (v9) | 16.31b       |

The worker source set was recomputed as the index plus 8 `_shared/cpsc` files: `htmlEntities`, `htmlExtractor`, `identity`, `pageEvidence`, `pageFetcher`, `scheduledPageWorker`, `sourceCoverage` and `validation`. **No worker code changed in this phase.**

## 2. Production baseline (read-only MCP, 2026-09-30 07:13 UTC)

| Check          | Value                                                                                                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations     | 29; 16.29 once; no 16.32 object (`to_regclass('private.cpsc_page_stage_control_events')` is null)                                                                                                               |
| Functions      | all 8 versions and bundles as at the end of 16.31b; worker v9 `c15d6623…`, `verify_jwt=true`                                                                                                                    |
| Cron           | job 2 only, `17 */6 * * *`, active, MD5 `07549bf9…097b6`, no page reference; last runs 06:17, 00:17, 18:17 and 12:17 all `succeeded`; pg_net queue 0                                                            |
| v1             | 06:17 run `success` (5 seen, 0 affected); 00:17 and 18:17 `partial_success` (`source_partial_failure`); 0 leases; automation `enabled`                                                                          |
| Sources        | CPSC `success` 06:17:04, watermark `2026-09-30`; Health Canada `success` 06:17:05                                                                                                                               |
| Page state     | 8 attempts, 8 work states, 7 raw, 34 fetches, 27 revisions (`7988c46d…`), 7 snapshots, 7 ledgers, 18 candidates (all `unreviewed`); last claim 07:02:58.929 (16.31b); 1 lease row = historical expired Intertex |
| Identity layer | identities `38 2f842e3a…`, aliases `282 b4329ba8…`, observations `109 e84d35ad…`, links `41 0543bfa2…`                                                                                                          |
| Holds          | 1 (`2c89d188…`, 26777, `fe3a1b54…`); 0 resolutions; 1 import (`457a983d…`)                                                                                                                                      |
| Humans         | 0 admin capabilities, 0 reviewer authorizations, 0 reconciliations, 0 review-ledger rows, 0 invalidations                                                                                                       |
| Eligibility    | 31 eligible; 26777 `{human_reconciliation_required}`; 26749, 26753, 26754, 26756, 26763, 26766 `{unresolved_quarantine}`                                                                                        |
| Queue          | 24 due now: 23 never-fetched plus 20162 (Intertex). Head is `26774, 26775, 26776, 26778…`; 20163 is due 09:51, the 16.31 four at 16:55, and 26761 and 26773 on 10-01 07:02                                      |
| v2 / business  | matches, alerts, push queue and deliveries, owned products, and every v2 table are 0; `cpsc_current_reviewed_criteria` is 0                                                                                     |
| Notices / v1   | notices `90 81cef330…`, scopes `103 72642ee0…`, sync `fe359eaf…`, automation state `3f4b0e71…`, runs `58 2a0ad375…`                                                                                             |

Every value equals the end of 16.31b. **No unexpected deviation.**

## 3. Operational architecture

```
v1 cron (job 2, :17 every 6 h) ── ingest-recall-sources ── CPSC API / Health Canada
        │ writes recall_source_sync_state (source health), notices, watermarks
        ▼
[16.32] page Cron tick (:47 hourly, not installed) ── private.cpsc_page_stage_tick()
        │ reads: control state · CPSC source health · v1 lease · page failure history · caps
        │ skipped → durable tick row with blockers      dispatched → pg_net POST (Vault key)
        ▼
process-cpsc-page-evidence (edge; header key; verify_jwt) ── runCpscPageWorker (≤2 lanes, 20 s)
        │ claim_cpsc_page_evidence  [16.32: kill switch · 2 global leases · hour/day caps]
        │   └ 16.29 eligibility: provenance · holds · quarantines · lineage · manual review
        │ fetchCpscOfficialPage (official host only, ≤3 hops, 10 s, 1 MB, HTML, UTF-8)
        │ final URL = identity URL, else identity_redirect → worker hold (16.29)
        │ retain_cpsc_page_transport  (raw bytes durable before parsing)
        │ extract → semantic revision → structural snapshot → census → coverage ledger → candidates
        │ commit_cpsc_page_evidence_verified (re-checks eligibility; one transaction)
        ▼
candidate criteria (unreviewed) ── human criterion review (16.10–16.13 RPCs) ── materialized rule sets
        ▼
v2 envelope (served only if every proposed rule set is reviewed and the ledger proves completeness)
        ▼
deterministic_v2 matching — INACTIVE (production policy phase_10_guarded_v1)
```

**Trust boundaries:**

| #   | Boundary                  | Decided by                                                                | Status                     |
| --- | ------------------------- | ------------------------------------------------------------------------- | -------------------------- |
| T1  | source health             | v1 recorder (automated, read by page stage)                               | implemented (16.32 policy) |
| T2  | page eligibility          | DB rule from provenance (automated, fail-closed)                          | implemented (16.29)        |
| T3  | page stage running        | **human operator** (`operational_scheduler_control`); owner may only stop | implemented locally        |
| T4  | fetch / URL / redirect    | worker + DB re-validation (automated)                                     | implemented                |
| T5  | identity holds            | **human** (`identity_reconciliation`)                                     | implemented; 0 holders     |
| T6  | criterion approval        | **human** (`cpsc_reviewer_authorizations`)                                | implemented; 0 holders     |
| T7  | revoke for cause          | **human** (`decision_invalidation`)                                       | implemented; 0 holders     |
| T8  | serving negative evidence | DB (complete reviewed universe) + v2 activation                           | v2 inactive                |
| T9  | capability grants         | **database owner** only                                                   | implemented; now audited   |

**Planned, not implemented:**

- scheduled operation (the Cron job is never installed by the migration)
- operator accounts
- accepted page relocation (26777, §6)
- hold-clearance disputes (§5)
- census of recall-detail prose (§9)
- an alert transport (§15)

## 4. Remaining safety blockers

| ID  | Blocker                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Blocks                                | Owner                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ---------------------- |
| B1  | No human holds any capability (0 operators, reconcilers or reviewers).                                                                                                                                                                                                                                                                                                                                                                                       | stage D onward; all holds; all review | project owner          |
| B2  | **v1 interference window.** A page ledger touches linked `recall_notices.updated_at`. v1 matching compares `updated_at` optimistically and counts a mismatch as `staleSkipped`, which `incompleteMatching` does **not** treat as incomplete. The recall then leaves `pending_recalls` and the pair is not retried. Latent today (0 owned products).                                                                                                          | concurrent page and v1 execution      | decision (§14)         |
| B3  | **pg_net queue exposure.** `net.http_request_queue` and `_http_response` grant **ALL to PUBLIC** with no RLS; PUBLIC also has USAGE on `net` and EXECUTE on `net.http_post`. Any DB login, including `cpsc_page_worker`, can read, alter or delete queued requests (v1's `x-recall-automation-key` at :17) and make outbound HTTP. These are platform defaults owned by `supabase_admin`, so no project migration can revoke them. Pre-existing since 16.24. | credential-custody acceptance (§13)   | decision               |
| B4  | 26777 cannot be served by clearing its hold. A redirect re-holds it (proven). It needs an accepted-relocation design with worker changes (§6).                                                                                                                                                                                                                                                                                                               | 26777 page evidence only              | decision + later phase |
| B5  | The coverage census excludes recall-detail prose. Negative evidence must not be served without census extension or explicit reviewer attestation (§9).                                                                                                                                                                                                                                                                                                       | v2 negative serving (not scheduling)  | later phase            |
| B6  | No invalidation path for a disputed hold clearance; no two-person rule (§5).                                                                                                                                                                                                                                                                                                                                                                                 | reliance on clearances                | design decision        |

None of these is weakened by this phase. B1–B3 must be decided before stage E.

## 5. Human reconciliation workflow

**Audit of `identity_reconciliation` (16.12 and 16.29):**

| Question       | Finding                                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authorization  | A row in `private.cpsc_admin_capabilities`. `cpsc_has_capability` requires `auth.role()='authenticated'`, `auth.uid()` and an unrevoked, started window.                                                                                                                                   |
| Grantor        | Only the database owner. No RPC grants; all API roles and the worker are denied (pgTAP).                                                                                                                                                                                                   |
| Authentication | A Supabase Auth JWT through PostgREST. **Gap:** no assurance level is required. A password-only session counts; there is no `aal2`/MFA check.                                                                                                                                              |
| Revocation     | The owner sets `revoked_at`. This is prospective: earlier decisions stay authorized through `cpsc_identity_decision_authorized(reviewer, decided_at)`.                                                                                                                                     |
| Audit          | Resolutions and reconciliations are append-only with a DB-hashed evidence snapshot. **Gap, closed locally in 16.32:** grants and revocations were ordinary mutable rows. An owner `UPDATE` of `authorized_at` could retroactively authorize past decisions, and a `DELETE` erased history. |
| Disputes       | Criterion decisions can be invalidated for cause (`decision_invalidation`). **Hold clearances cannot.** A cleared hold stays cleared even if the clearance is later disputed, except that a new worker redirect re-holds.                                                                  |

**16.32 local hardening:**

- **Guard triggers on both capability tables:** no delete and no truncate. The only permitted update is a one-way `revoked_at` null → value ≥ `authorized_at`; every other column is immutable.
- **Append-only `private.cpsc_authorization_audit`:** records each grant, revocation and re-grant with session user, current role and `auth.uid()`.
- **Re-grants:** `unique(user_id, capability)` is replaced by a partial unique index on open grants, so a re-grant is a new row and never widens an old window.
- **Limit:** criterion reviewers (`cpsc_reviewer_authorizations`, primary key `user_id`) are guarded and audited the same way, but cannot be re-granted after revocation without a schema change.

**Minimum-privilege operational workflow for a hold:**

1. **Grant.** The owner grants `identity_reconciliation` to a named person's Auth account, with `authorized_by` and a reason (audited).
   - This should be a different person from the scheduler operator and the criterion reviewer, where staffing allows.
   - Sign-in should require MFA (decision D2).
2. **Read the packet.** The reconciler opens `get_cpsc_page_identity_hold_packet(hold_id)`. It includes the hold evidence (manifest entry or worker attempt transport), identity, canonical notice, linked notices with provenance, aliases, observations, reconciliations, holds and resolutions, page fetches and attempts (final URL, redirect chain, raw hash), and backfill provenance.
3. **Verify independently against authoritative sources:**
   - the SaferProducts API record for the recall number
   - both official page URLs
   - the displayed recall number and the declared canonical link
   - the redirect chain

   The reconciler records their own capture hashes in the rationale.

4. **Decide.** `resolve_cpsc_page_identity_hold(hold_id, 'keep_page_hold' | 'clear_page_hold', rationale)`.
   - The resolution is append-only and DB-hashed, with at most one clearance per hold.
   - It touches no identity, alias, notice or work state.
5. **After a clearance, the worker re-proves identity at the next natural claim.** If the redirect persists, a new hold is created (§6).
6. **Disputes (design, B6).** Add an operator-placed dispute hold class, which only tightens eligibility, plus a rule that a clearance of a disputed hold must come from a different reviewer. This is not implemented.

A coding agent, parser or model cannot act as the reviewer. The resolution guard requires the authenticated capability holder's own `auth.uid()`, and an owner insert that carries a real reviewer UUID is rejected (16.29 pgTAP).

## 6. 26777 evidence and resolution design

**Evidence packet (production read-only, plus local hash-bound captures):**

| Item                     | Value                                                                                                                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                 | `d3d6654d-cf54-4edf-a095-ff82cd5a15cc`, `reconciled` (backfill Stage A, run 9), row MD5 `465c3280…`                                                                                                                                                      |
| Canonical URL (identity) | `https://www.cpsc.gov/Recalls/2026/Hayward-Industries-Recalls-Universal-Pool-Heaters-Due-to-Risk-of-Serious-Injury-or-Death-from-Carbon-Monoxide-Poisoning-Hazard-0`                                                                                     |
| API records              | IDs 10987 (URL on `cpsc.gov`) and 10990 (URL on `www`), both `…-Hazard-0`; canonical notice `776fdc2d…` (10987). 400,000 BTU Universal-HC Series pool heaters, model HDFS400, recall date 2026-09-17                                                     |
| Aliases / observations   | 10 aliases, all `reconciliation_id = null`; 3 observations `resolved` / `A_known_alias` (flags `url_spelling_alias`, `title_revised`, `payload_revised`)                                                                                                 |
| Page history             | 2026-09-24: `…-Hazard-0` served **200 directly** (fetch `f15fd399…`, raw `c7f98294…`, revision `b2c466c0…`, 0 tables, redirect chain `[]`)                                                                                                               |
| Redirect evidence        | 2026-09-26, two independent captures (16.13 at 06:59, 16.14 at 09:06): `…-Hazard-0` **301** → `…-Hazard`. The final page raw was `5c86331e…` in **both** captures, it displays recall number **26777**, and its declared canonical is `…-Hazard`         |
| Destination collisions   | 0 identities, 0 aliases, 0 notices, 0 observations and 0 fetches reference `…-Hazard` (read-only)                                                                                                                                                        |
| Hold                     | `2c89d188…`, `backfill_manifest_unresolved_identity`, manifest `a8bce170…` (runs 9–12), evidence SHA `fae76ebc…`, 0 resolutions; `requiredAction`: human identity reconciliation of the URL change before any live page ingestion, review or observation |
| Work state / attempts    | none; never claimed                                                                                                                                                                                                                                      |

**Clearing does not solve the redirect (proven locally).** In the 16.32 pgTAP suite:

- a fixture's live redirect creates a hold
- an authorized clearance makes it eligible
- the next claim hits the same redirect and creates a **second** hold
- the identity URL is never replaced
- `resolve_cpsc_page_identity_hold` accepts no URL argument

**Required design ("accepted page location"), for a separately reviewed phase:**

1. **Record type.** A new append-only record: identity, from-URL, to-URL, source hold, destination raw SHA, displayed recall number, declared canonical, reviewer, rationale and DB-hashed evidence.
   - It is written only by an `identity_reconciliation` holder.
   - The RPC takes the **hold id and the expected destination raw hash, never a URL**.
   - The destination comes from DB-held evidence (the hold's `officialPageFinalUrl` or the worker attempt's `final_url`). It must equal the declared canonical, be in canonical CPSC `/Recalls/` form, and belong to no other identity, alias or notice.
2. **One active location per identity.** A new location supersedes by appending; it is revocable by appending.
3. **Claim and worker.** The claim returns the accepted destination. The worker accepts a final URL equal to the destination only when the redirect chain is exactly `[destination]`, the displayed number matches, and the declared canonical equals the destination. Anything else becomes a new hold.
4. **Retain and commit.** These accept the destination as `finalUrl` only through that record. The semantic revision's `normalized.canonicalUrl` must become "page location", while identity, aliases and notices stay unchanged (no identity merge).

**Why it was not implemented here:** it changes the claim result shape, the deployed worker, the retain and commit URL checks, and the meaning of a revision's canonical URL. That needs a redeploy and a parser-identity review, so it is **documented as blocker B4**. The production hold is unchanged.

## 7. Criterion-review workflow (26773, 18 candidates)

**Audit:** 18 production candidates, 9 `model_exact` plus 9 `date_code_set`, all `unreviewed` and `mandatory_candidate`.

- **Source:** revision `c7919ccf…` (legacy `phase-16.9-v1`, `table_identities=[]`), sole proposed scope `4b09222d…`.
- **Parser:** `phase-16.13-structured-v2`.
- **Ledger:** `4a7ec80a…` (seq 14).

**Gaps in the existing 16.12 packet:**

- `get_cpsc_candidate_review_packet` orders rule sets from `revision.table_identities`, which is **empty for legacy revisions**, so the row order is lost.
- It shows no coverage ledger or limits.
- It does not disclose that the date-code conjunct comes from a governing prose sentence. Its evidence address carries the table row and `fieldIdentity "date codes"`, although the table has no date-code column.

**16.32 local addition:** `get_cpsc_candidate_review_context(candidate)`, for criterion reviewers only. It returns:

- the revision fingerprint and whether the revision is current
- the structural snapshot's table and row identities in document order
- the latest coverage ledger (summary plus every record's disposition, reason and relation) with an explicit limitation note
- each conjunct's `sourceKind` (`table_cell` or `governing_prose`, derived from the stored table header) and its excerpt
- every recall-detail section outside the census, as full text marked `censused:false`
- the serving state

It writes nothing.

**Reviewer packet for 26773** (canonical `https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock`, semantic revision `d37c79b3…`, table `description/table/0/93cf7095…`):

| Rule set | Model (table cell) | Model description (table cell)                             | Row identity | Evidence FP | Date codes (governing prose)    |
| -------- | ------------------ | ---------------------------------------------------------- | ------------ | ----------- | ------------------------------- |
| 1        | 25302145           | Bistro Pro™ Electric Grill & Griddle + Charcoal Mode Black | `94493055…`  | `66b72dc2…` | 2510, 2511, 2512 (one sentence) |
| 2        | 25302146           | … Griddle + Charcoal Mode Red                              | `e61218ab…`  | `751c305a…` | same                            |
| 3        | 25302147           | Bistro Pro™ Electric Grill + Charcoal Mode Blackout        | `94245b2e…`  | `00db0489…` | same                            |
| 4        | 25302148           | … Grill + Charcoal Mode Black                              | `ed70e1c8…`  | `32bf5509…` | same                            |
| 5        | 25302149           | Bistro Pro™ Tabletop Electric Grill Black                  | `4a6cc5be…`  | `58bf7e57…` | same                            |
| 6        | 25302150           | … Tabletop Electric Grill Red                              | `5f832aaf…`  | `5c7fbbcd…` | same                            |
| 7        | 25302151           | … Griddle + Charcoal Mode Black with Cover                 | `6eaad3c9…`  | `cb3489b0…` | same                            |
| 8        | 25302159           | … Griddle + Charcoal Mode Red with cover                   | `6427cf1e…`  | `a6e096ab…` | same                            |
| 9        | 25302163           | … Griddle + Charcoal Mode Emerald with cover               | `ef15f29f…`  | `e8b9985d…` | same                            |

- **Supporting passage for the date codes:** "Only Bistro Pro Electric Grills with date codes of 2510 (Oct-2025), 2511 (Nov-2025) and 2512 (Dec-2025) are included in this recall." This is prose record 4, `parsed_reviewable`, relation `governs:<table>`.
- **Date-code location:** "a four-digit manufacturing date code in year and month (YYMM) format" on the product label, found on the bottom shelf (full-size) or the side bar (tabletop).
- **Coverage:** 14 authoritative records, all accounted: 10 reviewable and 4 ignored as non-safety.
- **Limits:**
  - The recall-detail sections are **not censused**: remedy (repair kit, "a label to affix to the grill after repair"), "sold at" (Oct 2025–Jun 2026, $150–$250), importer, and manufactured in.
  - 26773 has a two-notice duplicate group (10986, 10989), and proposals are attributed only to the canonical notice's sole scope.
- **Extraction uncertainty:** the legacy revision has no stored table identities. The snapshot provides them, and the 16.26 compatibility path proved snapshot = DB recomputation = offline census.

**Workflow:**

1. `list_cpsc_pending_review_candidates` (queue).
2. `get_cpsc_candidate_review_packet` (OR between rule sets, AND inside each; all conjuncts).
3. `get_cpsc_candidate_review_context` (the provenance and limits above).
4. The reviewer compares each row against the live official page. They must attest that the governing sentence applies to every model row, and that no recall-detail or external text narrows or widens the scope.
5. `decide_cpsc_candidate` per member (mandatory-eligibility attestation), then `materialize_cpsc_reviewed_conjunction`.

**Every candidate remains `unreviewed`. No review was performed or simulated in production.**

## 8. 26773 rule-relationship audit

- **What the source supports:** a two-column table (`Model Description | Model No.`, 9 rows), plus **one** prose sentence restricting all "Bistro Pro Electric Grills" to date codes 2510–2512.
- **The date codes are not per-row data.** The parser copies the one page-level restriction into each row's conjunction. The "9 date-code sets" are nine identical copies (`2510,2511,2512`) of a single restriction.
- **The supported representation:** OR across 9 row rule sets, each `model_exact(row model) AND date_code_set{2510,2511,2512}`. It is equivalent to `model ∈ {9 models} AND date ∈ {2510,2511,2512}` because the date restriction is page-wide.
- **No association is invented.** There is no cross product (9 model/date pairs, not 81), and no pairing across rows.
- **If rows ever carried different date codes,** members of different rule sets would never combine.

**Tests, local (Node; the fixture reproduces production exactly at the semantic level):**

- **Production equivalence:** the fixture's raw SHA is `77d31796…` versus production `0a684ae6…`, yet its semantic hash (`d37c79b3…`), table identity, 9 row identities, 9 evidence fingerprints, coverage FP (`faea74e5…`) and interpretation FP (`38d9006c…`) equal the production values.
- **Relationships:** exactly 9 groups of `{model_exact, date_code_set}`. Both conjuncts address the same row, and each group's key is that row. There are 9 distinct pairs. No table cell has a date-code class, and exactly one prose record governs the table.
- **Cross-row safety:** in a counterfactual where one row carries its own date set, a model from row A with row B's date set is never confirmed.

The rules are not approved.

## 9. Negative-evidence safety audit

**What `negative_evidence_eligible=true` means.** It is a page-ledger property: every **description** structure (prose sentences and table rows) is accounted for, no restrictive blocker exists, and positives are independent. It does **not** authorize any rule.

| Claim                                                            | Proof                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page-level coverage does not authorize unreviewed rules          | Production: envelope `null`; `cpsc_scope_rule_set_coverage` `complete=false` (served 0 of 9, 16.31b); 0 reviewed criteria; 0 v2 rows. Node: with 0 reviewed groups nothing is confirmed or rejected                                                           |
| The 18 candidates cannot become active automatically             | Only `decide_cpsc_candidate` (human reviewer JWT) and `materialize_…` change state (16.10–16.13 pgTAP). Nothing in the worker, the 16.32 functions, service_role or the owner writes the review ledger (16.32 pgTAP: reading the context records no decision) |
| An incomplete reviewed scope produces no authoritative rejection | Node: with 8 of 9 reviewed, the unreviewed row's model, an unlisted model and a wrong date code are never `rejected`. Only the complete 9-of-9 universe rejects `25302145/2509`                                                                               |
| An omitted safety restriction prevents a negative                | Node: a listed model with no date code is neither `confirmed` nor `rejected`. Census `unsupported`/`unresolved` records block positives or negatives (20164, 20165, 26755 are `blocked` in production)                                                        |
| Source revisions invalidate stale approvals                      | `cpsc_current_reviewed_criteria` requires `source_revision_hash` = the current revision and `cpsc_revision_is_current` (16.11/16.12 pgTAP). Node: a date-code edit changes the semantic revision in every candidate address                                   |
| Unsupported restrictions remain unresolved                       | 16.13 dispositions; Friedrich serial subset and AGA production-date class stay unresolved or deferred (existing tests)                                                                                                                                        |

**Outside the parsed description (explicit assessment):**

- **Recall-detail prose is not censused.** Node characterization: adding "Only grills sold at Walmart are included." to the Remedy text changes the semantic revision, yet the ledger gains no record and `negativeEvidenceEligible` stays `true`. A restriction written only there would be invisible to the negative-eligibility computation.
- **For 26773 specifically:** the "sold at" window (Oct 2025–Jun 2026) is consistent with date codes 2510–2512 and does not narrow the model or date scope. The remedy's repair label marks repaired units, not units outside the recall. **This is a human reading, not a machine proof.**
- **External documents are not ingested:** the manufacturer page `charbroil.com/BistroProFix`, product-label imagery, and a possible Health Canada joint notice. They could restrict scope, and the system cannot know.
- **Rule (not relaxed here):** negative evidence must not be served until the census covers recall-detail prose **or** the reviewer's attestation explicitly covers those sections and external references. The new review context surfaces the sections (B5). The meaning of "complete coverage" is unchanged.

## 10. Authorization matrix (local, all asserted in pgTAP)

| Actor                           | Start stage    | Stop stage                               | Stage status  | Claim (worker)             | Clear hold | Reconcile quarantine | Review criterion | Review context | Grant capability                     |
| ------------------------------- | -------------- | ---------------------------------------- | ------------- | -------------------------- | ---------- | -------------------- | ---------------- | -------------- | ------------------------------------ |
| `operational_scheduler_control` | **yes**        | **yes**                                  | **yes**       | —                          | no         | no                   | no               | no             | no                                   |
| `identity_reconciliation`       | no             | no                                       | no            | —                          | **yes**    | **yes**              | no               | no             | no                                   |
| criterion reviewer              | no             | no                                       | no            | —                          | no         | no                   | **yes**          | **yes**        | no                                   |
| `decision_invalidation`         | no             | no                                       | no            | —                          | no         | no                   | invalidate only  | no             | no                                   |
| authenticated consumer          | no             | no                                       | no            | no                         | no         | no                   | no               | no             | no                                   |
| `service_role`                  | no (42501)     | no                                       | no            | no                         | no         | no                   | no               | no             | no                                   |
| `cpsc_page_worker`              | no             | no                                       | no            | **yes, only when running** | no         | no                   | no               | no             | no                                   |
| database owner                  | **no** (guard) | **yes** (emergency, attributed to owner) | yes (private) | no (42501)                 | no (guard) | no                   | no               | no             | **yes** (audited, immutable history) |
| parser / model / coding agent   | —              | —                                        | —             | —                          | —          | —                    | —                | —              | —                                    |

- **No inheritance:** one capability never implies another (tests: an operator cannot resolve holds, decide candidates or read review context; a reconciler cannot start or stop the stage).
- **Forgery is rejected:** an owner insert of an operator start carrying a real operator UUID fails (42501).
- **The worker gains nothing:** its executable security-definer set is still exactly `claim`, `retain`, `commit_verified` and `finish`.

## 11. Actual timing measurements

| Phase (date)   | Request      | Client ms | Edge exec ms | Pages | Stop               | Per page (claim → complete, ms)                                                                      |
| -------------- | ------------ | --------- | ------------ | ----- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| 16.25 (09-28)  | 1 page       | —         | —            | 1     | —                  | claim 15:30:35.228; never terminalized (pre-16.26 worker); lease expired 15:31:05; no bytes retained |
| 16.28 (09-29)  | `maxPages=1` | 1935      | 1728         | 1     | `page_limit`       | 640                                                                                                  |
| 16.31 (09-29)  | `maxPages=6` | 3419      | 3228         | 4     | `admission_budget` | 1475, 834, 452, 442                                                                                  |
| 16.31b (09-30) | `maxPages=2` | 1860      | 1658         | 2     | `page_limit`       | 660, 425                                                                                             |

**Phase split** (claim→fetched, fetched→retained, retained→commit; DB timestamps, with the fetch timestamp taken after the body was read):

- 20163: 368 / 28 / 244
- 20164: **1133** / 175 / 167
- 20165: 583 / 30 / 221
- 26748: 348 / 28 / 76
- 26755: 296 / 26 / 119
- 26761: 352 / 145 / 164
- 26773: 191 / 30 / 204

Fetch plus claim round trip dominates. The DB retain takes 26–175 ms, and parse plus commit takes 76–244 ms.

**Time from sending the request to the first claim:** about 1.31 s (16.31) and about 1.06 s (16.31b). This covers the gateway, cold start and DB connect.

**Why 6 gave 4 and 2 gave 2:**

- **The admission rule.** A claim is admitted only while `remaining ≥ 18 000 ms` of the 20 000 ms budget, so admission is open only during the **first 2.0 s after the worker starts**. With two lanes:
  - the first two claims start immediately (+0 ms and +372 ms)
  - lanes freed at +1206 ms and +1475 ms admitted the 3rd and 4th claims (+1368 ms, +1614 ms)
  - the next lane freed at +1820 ms after the first claim, which is past 2.0 s from the worker's start, so admission closed
- **16.31b** simply reached `maxPages=2`.
- **Replay:** both runs are reproduced exactly by a Node test that feeds the production timestamps into the real `runCpscPageWorker`.

**Idle time:** there is none. The worker returns as soon as its lanes drain. The roughly 17 s gap between about 1.7–3.2 s of execution and the 20 s budget is reserve, not waiting.

**Safety purpose of the constants (kept unchanged):**

- **Page reserve 16 s:** 10 s whole-exchange fetch timeout + 4 s statement timeout + 2 s parse and cleanup.
- **Claim reserve 18 s:** the page reserve plus the claim.
- **Lease:** a page admitted by claim time c finishes by c + 10 (fetch) + 4 (retain) + 4 (commit) + 4 (finish, only after a failure) = **c + 22 s**, inside the 30 s lease. Every commit re-checks the lease.
- **Other limits:** the worst-case cycle is about 2 s + 22 s + cold start, under the pg_net 30 s timeout and the edge wall-clock limit.
- **Why not change them:** raising `maxPages` does not raise throughput. It only converts `page_limit` stops into `admission_budget` stops.

## 12. Proposed scheduling parameters (initial shadow, stage E)

| Parameter              | Proposal                                                                                                                                                          | Justification                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Frequency              | hourly at **:47** (`47 * * * *`)                                                                                                                                  | 30 min from v1's :17 starts (v1 runs observed ≤ 23 s); a cycle is about 2–3 s |
| Batch (`maxPages`)     | **2**                                                                                                                                                             | deterministic `page_limit` stop (16.31b); 4 fits only by timing luck          |
| Concurrency            | 2 (worker) + DB backstop of 2 active leases across all callers                                                                                                    | unchanged reviewed value; overlapping invocations cannot exceed it (pgTAP)    |
| Admission budget       | 20 s / 18 s claim reserve / 16 s page reserve (unchanged)                                                                                                         | §11                                                                           |
| Per-request timeout    | fetch 10 s (unchanged); pg_net 30 s                                                                                                                               | §11                                                                           |
| Lease                  | 30 s (unchanged)                                                                                                                                                  | worst-case page is 22 s after claim                                           |
| Retry backoff          | unchanged 16.26 table (temporary 5 min × 2ⁿ ≤ 1 day; DB timeout 1 h; internal 1 day; structure 7 days; redirect or unsupported 30 days; rejected → manual review) | proven terminal paths                                                         |
| Hourly cap             | **4** claims                                                                                                                                                      | one cycle plus one supervised re-run                                          |
| Daily cap              | **48** claims                                                                                                                                                     | steady state needs 31 per day (31 eligible, success means +1 day)             |
| Source request limit   | ≤ 2 page requests per hour to `www.cpsc.gov` (≤ 3 redirect hops each), ≤ 48 per day                                                                               | negligible load; the v1 API is separate                                       |
| Authorization validity | start valid **168 h**, renewed by the operator                                                                                                                    | fail-closed expiry (bound 1–336 h)                                            |
| Failure thresholds     | see §13                                                                                                                                                           |                                                                               |
| Queue fairness         | unchanged ORDER BY (next attempt, then last activity, then number); success means +1 day                                                                          | round robin; 24 due now are cleared in about 12 h                             |

## 13. Upstream-outage handling

**Reproduced locally through the real v1 recorder, with no falsified rows.** In pgTAP, `record_recall_source_sync_result('cpsc', 'failed', …, 'source_http_502')` makes the policy report `source_unhealthy`. The tick then **skips** with a durable blocker row and no request. A later v1 `success` clears the pause automatically.

| Condition                       | Rule (policy blocker)                                                                     | Resume                          |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------- |
| No CPSC health yet              | `source_health_unknown`                                                                   | first v1 record                 |
| v1's latest CPSC attempt failed | `source_unhealthy` (e.g. `source_http_502`)                                               | next v1 success (≤ 6 h cadence) |
| Stale health                    | `source_health_stale`: last success older than **7 h** (one missed v1 run tolerated)      | fresh v1 success                |
| v1 running                      | `v1_run_active` (unexpired v1 automation lease)                                           | lease released                  |
| Page 429                        | `upstream_rate_limited` for **6 h** after any `http_429`                                  | automatic after the window      |
| Page 5xx / timeout / transport  | `upstream_failures`: **≥ 2** in the last hour                                             | automatic after the window      |
| DB pressure                     | `database_pressure`: ≥ 2 `database_timeout` in the last hour                              | automatic                       |
| Code or semantic defect         | `defect_circuit_open`: ≥ 2 `evidence_rejected`/`internal_failure` since the current start | **operator restart only**       |
| Overlap                         | `claim_in_flight` (the tick never stacks); claim backstop of 2 leases                     | automatic                       |
| Caps                            | `hourly_cap_reached`, `daily_cap_reached`                                                 | automatic                       |

**Isolation:** Health Canada and v1 are read-only inputs. The policy reads only `recall_source_sync_state` (the CPSC row) and `recall_automation_lease`. A pgTAP fingerprint over v1 control, state, runs, lease, sync state and the v1 Cron job is unchanged across every page-stage operation.

## 14. Durable credential design

**Verified platform support:** v1 already uses the pattern (`install_recall_automation_cron`): pg_cron plus pg_net, with URL and key read from `vault.decrypted_secrets` by name.

**Design (implemented locally, not provisioned):**

- **Storage:**
  - Edge secret `CPSC_PAGE_WORKER_KEY` (runtime verification, unchanged).
  - Vault secrets `cpsc_page_worker_key`, `cpsc_page_worker_url` and `cpsc_page_worker_apikey` (the publishable key for the `verify_jwt` gateway).
- **Cron command:** `select private.cpsc_page_stage_tick();`. It holds **no credential, URL, Vault reference or parameters** (pgTAP).
- **The tick:**
  - It dispatches only after the policy passes.
  - It refuses a Vault key that isn't 64 hex characters.
  - It refuses any URL other than `https://<20-char ref>.supabase.co/functions/v1/process-cpsc-page-evidence` (or the local gateway), so a tampered Vault URL can never receive the key (pgTAP).
  - Its durable record holds no header or key (pgTAP). `cron.job_run_details` stores only the command text, and `net._http_response` stores only the response.
- **Narrow invocation:** the key only triggers one bounded, DB-gated cycle. The DB still decides whether anything is claimed, and a stopped stage claims nothing.

**Privilege boundaries (production, read-only):**

- **Vault:** `postgres` and `service_role` (which has `bypassrls`) can read `vault.decrypted_secrets`, so storing the key there makes it readable by service_role. The key confers less than the `cpsc_page_worker` DB credential, and less than service_role already has. There is no evidence or review privilege expansion.
- **pg_net:** see B3. While a request is queued (milliseconds to seconds), any DB login can read its headers. That was already true for v1's key.

**Rotation (proposed script, next phase):**

1. Stop the stage.
2. Generate the key in memory.
3. Set the edge secret through `supabase secrets set --env-file` fed from a pipe. The CLI supports `--env-file`, which keeps the value out of argv.
4. Update the Vault secret through `vault.update_secret` over psql stdin.
5. Verify one supervised tick.
6. Restart.

No human sees the value, and no plaintext is written to disk or logs.

**Revocation:**

- set the Vault key to an invalid value, so ticks skip with `invocation_credential_unavailable` (pgTAP)
- rotate or unset the edge secret, so the handler returns 401 before any DB access (Deno test)
- optionally, `alter role cpsc_page_worker password null`, which denies DB login (16.24 harness)

**Decision needed (D3):** accept B3 and service_role Vault readability as documented, or require mitigation first. One option is to keep the page stage stopped and the page DB login password null whenever not operating.

## 15. Scheduler isolation

- **Separate objects:** a separate Cron job name (`cpsc-page-evidence-shadow`) and separate owner-only functions (`install`, `set_active`, `uninstall`). They never read or alter job 2 by name. Installation is **always inactive**.
- **The migration installs nothing:** after a reset there are 0 Cron jobs and 0 control events.
- **Explicit enable/disable:** the operator start or stop (DB) and the Cron activate or deactivate (owner). **Default: disabled (never started).**
- **No delay to v1:** the page stage never writes v1 tables (pgTAP code scan and fingerprint), and it cannot delay canonical API ingestion, matching or notifications. It does not touch watermarks, and it cannot activate v2.
- **The one coupling (B2):** the 16.13 notice touch can make a v1 pair `stale`.
  - **Mitigations in the design:** the :47 offset and the `v1_run_active` policy.
  - **Residual:** a manual v1 run started inside the ≤ 22 s window after a page admission.
  - **D4:** either (a) accept this with an operator rule that there are no manual v1 runs while the stage is running, or (b) separately review a v1 change so `staleSkipped` keeps the recall pending.

## 16. Monitoring and alerting

**Read model:** `get_cpsc_page_stage_status()` (operator) and `private.cpsc_page_stage_status(now)` (owner). It exposes no credential, header, consumer or owned-product data.

| Signal                               | Field                                                                              | Alert threshold (proposed)                         |
| ------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| Source health                        | `policy.sourceHealth`, blockers                                                    | `source_unhealthy` or stale > 12 h → warn          |
| Eligible queue depth                 | `queue.eligible`, `queue.eligibleDue`                                              | due > 40 → warn                                    |
| Oldest eligible page                 | `queue.oldestDueSince`                                                             | > 48 h → warn                                      |
| Batch duration / claims / completion | `lastTick.response.{durationMs, claimed, completed, failed}`                       | non-200 or timed out on 2 consecutive ticks → warn |
| Failures                             | `last24h.outcomes`, `errorCodes`                                                   | any `evidence_rejected` → page the operator        |
| Admission-budget stops               | `lastTick.response.stoppedBy`                                                      | `admission_budget` at `maxPages=2` → info          |
| Raw retention failures               | `last24h.transportNotRetained`                                                     | > 0 → page                                         |
| Semantic failures                    | `last24h.semanticFailures`                                                         | ≥ 1 per day → warn                                 |
| Identity redirects / holds           | `last24h.identityRedirects`, `holds.createdLast24h`, `holds.unresolved`            | new hold → notify the reconciler                   |
| Leases                               | `leases.active`, `expiredUnreleased`, `orphanedClaimedAttempts`                    | orphans > 1 (baseline: Intertex) → warn            |
| Ticks                                | `last24h.ticks.{dispatched, skipped}`, `lastTick.blockers`                         | 0 dispatched in 24 h while running → warn          |
| Review backlog / stale criteria      | `review.{unreviewedCandidates, pendingRuleSets, reviewedCriteriaOnStaleRevisions}` | stale > 0 → reviewer action                        |

pg_net keeps responses for about 6 h, and tick rows are permanent. **There is no alert transport yet:** the operator polls. A push or email channel is a later decision.

## 17. Kill switch

| Level | Action                                                                                       | Effect                                                                                       |
| ----- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| L1    | `stop_cpsc_page_stage(reason)` (operator) or `private.stop_cpsc_page_stage_as_owner(reason)` | **no new claim** from any caller: scheduled, manual or leaked key (DB-enforced in the claim) |
| L1a   | automatic: expiry, operator revocation, re-grant (no revival), circuits                      | claim returns 0 rows, or the tick skips                                                      |
| L2    | `private.set_cpsc_page_stage_cron_active(false)` or `uninstall_…`                            | no more ticks                                                                                |
| L3    | invalidate the Vault key; rotate or unset the edge secret                                    | tick skips; the handler returns 401 before the DB                                            |
| L4    | `alter role cpsc_page_worker password null`                                                  | no DB login                                                                                  |

- **In-flight requests:** `retain`, `commit` and `finish` never read the control state (pgTAP code check). A claim admitted before the stop retains its bytes and terminalizes afterwards (pgTAP), so valid evidence is never discarded. At most 2 pages, finishing within 22 s.
- **v1 safety:** no kill-switch level touches a v1 object. The pgTAP fingerprint is unchanged, and the default state is disabled.

## 18. Capacity and retention

**Measured:**

- **Payloads:** 7 production payloads of 77,862–85,592 bytes (mean about 81 KB).
- **Cycle time:** 1.7–3.2 s per cycle; per page 0.43–1.48 s.
- **Queue:** 31 eligible, 24 due now.
- **Byte churn:** unchanged pages produce **new raw bytes**. For example, the 26773 fixture `77d31796…` and production `0a684ae6…` have equal semantics, so content addressing does not deduplicate.

**Assumptions (not measured):**

- every successful fetch adds 1 attempt, 1 fetch, and at most 1 ledger (about 5–10 KB of JSON)
- TOAST compression of HTML about 3–4 ×

| Quantity               | Estimate                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Page requests per day  | about 31 (steady state); cap 48                                                                                            |
| Bandwidth              | about 2.5 MB per day, about 75 MB per month (CPSC → edge; the same into the DB)                                            |
| Raw evidence growth    | about 2.5 MB per day logical, about 0.9 GB per year logical (about 0.25–0.3 GB compressed)                                 |
| Other rows             | about 31 attempts plus 31 fetches plus ≤ 31 ledgers per day                                                                |
| Queue catch-up         | 24 due at 2 per hour → about 12 h                                                                                          |
| Retry amplification    | ≤ 2 failed requests per hour in an outage (circuit), ≤ 48 per day; v1 health usually pauses sooner                         |
| Upstream outage impact | page evidence is delayed; v1, alerts and notifications are unaffected; backlog clears at 2 per hour                        |
| Retention              | everything is append-only (by design). **Decision D7:** a raw-payload retention policy before the table reaches about 1 GB |

## 19. Rollout plan (no automatic progression)

| Stage | Content                                                                                                                                                                                       | Exit criterion (human review)                                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A     | local scheduler and authorization tests                                                                                                                                                       | **done here** (§23)                                                                                           |
| B     | install the 16.32 migration in production; stage never started; no Cron, no Vault secrets                                                                                                     | 30 migrations; the claim returns 0 for all callers; remote suites pass; v1 unaffected at the next natural run |
| C     | named people get Auth accounts (MFA decision); the owner grants `operational_scheduler_control` (and separately the reconciliation and review capabilities); key provisioning by script (§14) | audit rows present; no stage start yet                                                                        |
| D     | supervised shadow: the operator starts (1 h, caps 2/2/2); the owner runs **one** `select private.cpsc_page_stage_tick()`; post-run forensic diff as in 16.31b                                 | 2 terminal attempts, replay deterministic, 0 violations                                                       |
| E     | install Cron (inactive) and activate; start valid 168 h, caps 2/4/48                                                                                                                          | ≥ 7 days of ticks reviewed; 0 `transportNotRetained`; 0 unexplained `evidence_rejected`                       |
| F     | observation and operational review                                                                                                                                                            | written review                                                                                                |
| G     | any expansion (maxPages, frequency, 26777 relocation, v2) is a separately reviewed phase                                                                                                      | —                                                                                                             |

## 20. Rollback plan

1. **Stop new claims:** operator or owner stop (L1). The effect is immediate at the next claim.
2. **Disable the page Cron:** `set_cpsc_page_stage_cron_active(false)`, then `uninstall_cpsc_page_stage_cron()` (L2).
3. **Revoke the invocation credential:** Vault key invalid, edge secret rotated (L3); optionally, the DB login password set to null (L4).
4. **Recover expired leases:** nothing to do. The next claim of that identity takes the lane. The expired attempt stays `claimed` as history, is counted as `orphanedClaimedAttempts`, and is never repaired (16.26 contract).
5. **Inspect incomplete attempts:** the status read model plus a query of attempts with `outcome='claimed'` that are not the current unexpired lease, joined to `raw_payload_sha256`.
6. **Retain evidence:** raw payloads, revisions, snapshots, ledgers, candidates, holds, ticks and control events are append-only. Nothing is deleted.
7. **Preserve v1:** no step touches v1. Job 2, the sync state and the watermarks are independent.
8. **Schema:** forward-only. Do **not** revert the claim to its 16.29 body (that removes the kill switch). Leave the stage stopped instead.

## 21. Implementation file hashes

| File                                                                                | Kind                        | SHA-256                                                                              |
| ----------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| `supabase/migrations/20260930120000_phase_16_32_page_stage_operational_control.sql` | new                         | `dd3a40e1af8ffeb06cf3af1fe3014e07fa305e643c5747b351ad5f12f2449cdd`                   |
| `supabase/tests/phase-16-32-page-stage-operational-control.sql`                     | new (249 assertions)        | `d2eeb8ab73a3aa2902bf4dfd70a5cfd3181bbba2deffe23d2a5449725aedf732`                   |
| `tests/phase-16-32-operational-readiness.test.mjs`                                  | new (11 tests)              | `749f477a1ec2213901493b95263dd5f4ec0c0af5135896c5f5847f204171d817`                   |
| `tests/phase-16-32-worker-invocation-auth.test.ts`                                  | new (Deno, 2 tests)         | `0d01c7a9a72e79907c26b1f8015191c5ac5c49b169169be3d1f0c4139c29ddd4`                   |
| `supabase/tests/phase-16-23-page-evidence-foundation.sql`                           | inherited, edited           | `9b92b4c0…0218` → `f1ce35e42f7d5dab248856af8cac6dc076a5398cd5a1d8355abc4714dd194f91` |
| `supabase/tests/phase-16-24-page-evidence-hardening.sql`                            | inherited, edited           | `57eb0c9e…4ec8` → `0d67a93848baef59714101c744f7c709a59197382dc6b0a7f55a29706b802b48` |
| `supabase/tests/phase-16-26-page-failure-evidence.sql`                              | inherited, edited           | `1b86ca77…3f02` → `6470326772739c7aa60cafb36da1133eb360fd5c42fa507035ee834db1028979` |
| `supabase/tests/phase-16-29-page-identity-eligibility.sql`                          | inherited, edited           | `5e23aae6…f87b` → `8f61a44173069c9b883904adbf9a976c5f01e756b9305476df310ec91f39152a` |
| `supabase/tests/remote/phase-16-26-page-failure-evidence.sql`                       | inherited, edited           | `9a04ad69…715e` → `a2095fb7cf7b5e29544dc0ec7932c6baa4635cbf82a2d6ff6f447ed04755f862` |
| `scripts/verify-phase-16-24-db-timeout.py`                                          | inherited, edited           | `4d68194b…c01b` → `336d48bab169805e103cf0081b7cfcac6afd560112f3a904c86a790e71f3d747` |
| `tsconfig.json`                                                                     | tracked, edited (1 exclude) | `9b87b30910e812c716306833562b8272fde5dbca75c47d29842ea633dbe041ee`                   |
| worker source set (9 files)                                                         | **unchanged**               | `9e6e318efc140a104d72c12bbc314ef98a4a2ebca1f29b723fc4942caaf54a02`                   |

**The inherited edits change setup only:**

- **All five claim-path suites** get the same rolled-back block: a fixture operator with `operational_scheduler_control` calls `start_cpsc_page_stage`. This is needed because the claim now enforces the default-stopped kill switch.
- **16.29 suite:** two lane releases (`budget_deferred`) were added before claims that previously relied on 3+ simultaneous leases. Its "no ineligible identity is ever claimed" assertion therefore still measures eligibility, not the new 2-lease backstop.
- **Timeout harness:** it starts the stage with session-scoped claims.
- **Unchanged:** every assertion count (65, 74, 47, 208, 172).
- **tsconfig:** excludes the Deno-only test from Expo `tsc`, as it already does for `scripts/verify-phase-16-24-replay.ts`.

## 22. Migration

- **File:** `20260930120000_phase_16_32_page_stage_operational_control.sql`, SHA-256 `dd3a40e1af8ffeb06cf3af1fe3014e07fa305e643c5747b351ad5f12f2449cdd`. It is additive and forward-only, and no earlier migration was modified.
- **Tables** (RLS on, 0 policies, no API or worker privilege):
  - `private.cpsc_authorization_audit`
  - `private.cpsc_page_stage_control_events`
  - `private.cpsc_page_stage_ticks`

  All three are append-only, with no truncate.

- **Constraint changes on `cpsc_admin_capabilities`:**
  - the capability check gains `operational_scheduler_control`
  - `unique(user_id, capability)` becomes the partial unique index `cpsc_admin_capabilities_one_open_grant_idx`
- **Triggers:**
  - a guard and an audit trigger, plus a no-truncate trigger, on `cpsc_admin_capabilities` and `cpsc_reviewer_authorizations`
  - a control-event guard
  - append-only triggers
- **Private functions:** `cpsc_page_stage_control_state`, `stop_cpsc_page_stage_as_owner`, `cpsc_page_stage_policy`, `cpsc_page_stage_tick`, `install_cpsc_page_stage_cron`, `set_cpsc_page_stage_cron_active`, `uninstall_cpsc_page_stage_cron` and `cpsc_page_stage_status`. All are owner-only.
- **Public functions** (`authenticated`, gated inside): `start_cpsc_page_stage`, `stop_cpsc_page_stage`, `get_cpsc_page_stage_status` and `get_cpsc_candidate_review_context`.
- **Replaced:** `claim_cpsc_page_evidence(integer)`. The signature, return shape, 16.29 eligibility, ORDER BY and worker-only grant are unchanged. It adds the advisory-locked kill switch and the backstops, so **the deployed bundle v9 is compatible.**
- **Index:** `cpsc_page_attempts_claimed_at_idx`.
- **Installation consequence:** immediately after install, **no page is claimable by anyone** until an authorized operator starts the stage (fail-closed).

## 23. Local test results (clean reset, 30 migrations)

| Gate                                                    | Result                                                                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase db reset --local --no-seed`                   | 30 migrations; 0 identities; 0 control events; 0 Cron jobs; worker password null                                                             |
| Full pgTAP (`supabase test db`)                         | **2145 / 2145, 22 files, PASS**. That is 1893 + 249 (new) + 3 (16.11's census of `private.cpsc_*` RLS gains the 3 new tables)                |
| Remote 16.26 suite, rehearsed locally (transient pgTAP) | 172 / 172                                                                                                                                    |
| Node full suite                                         | **397 / 397** (386 + 11)                                                                                                                     |
| Worker tests                                            | inside Node (16.23 worker file 15/15) plus 4 new admission and replay tests                                                                  |
| Deno                                                    | `deno check` on every function entrypoint, `_shared/cpsc` and the new test: exit 0; `deno test` 2/2                                          |
| Expo `tsc --noEmit`                                     | exit 0                                                                                                                                       |
| DB lint `--level error`                                 | 0 results                                                                                                                                    |
| Historical backfill (frozen 16.13 manifest)             | **26 / 26**; digests `ea00243e…133f` / `1406161a…a909`; remote-safe 89/89; second run 0 rows; live gate correct                              |
| Freeze guards 9.1 / 15 / 16                             | `frozen=true` ×3                                                                                                                             |
| Deterministic v2                                        | **0 unsafe confirmations / 200** (all partitions 0)                                                                                          |
| v2.1 safety                                             | 0 unsafe, 66 needs-review preserved, **0 provider calls**                                                                                    |
| DB timeout and credential harness                       | 4 s cancellation `57014`, rollback 0 rows, lease recovered, **revoked login denied**                                                         |
| 26773 replay                                            | the exact production bytes are **not available locally** (deleted by design in 16.31b); semantic-level equivalence to production proven (§8) |
| Benchmark churn                                         | the runner rewrote `phase-16/results/deterministic-v2-all.json`; restored; **86 / 86** files equal the phase start                           |
| `git diff --check`; whitespace                          | clean                                                                                                                                        |
| Secret scan (diff, all changed files, scratchpad)       | 0 JWTs, `sb_secret_`/`sb_publishable_` values, credentialed URLs or private keys; no literal 64-hex key (fixtures generate keys at runtime)  |
| Prettier                                                | changed JS/TS/JSON and this report clean                                                                                                     |

**Coverage of the required test matrix:**

| Required case                        | Where it is covered                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| valid and invalid operator           | 16.32 pgTAP                                                                     |
| capability separation                | 16.32 pgTAP                                                                     |
| fake reviewer or operator            | 16.32 pgTAP (owner forgery; owner start; service_role owner-stop impersonation) |
| 26777 hold and redirect reappearance | 16.32 pgTAP, plus 16.29 manifest hold                                           |
| 26773 row relationships              | Node                                                                            |
| unreviewed isolation                 | Node, plus pgTAP context                                                        |
| incomplete negative evidence         | Node                                                                            |
| upstream 502 and recovery            | pgTAP (v1 recorder)                                                             |
| stale source health                  | pgTAP                                                                           |
| repeated and overlapping invocations | pgTAP (global 2-lease backstop), Node replay                                    |
| admission-budget exhaustion          | Node replay of 16.31                                                            |
| lease expiry                         | pgTAP, harness                                                                  |
| kill switch                          | pgTAP                                                                           |
| credential revocation                | pgTAP (Vault), Deno (edge key), harness (DB login)                              |
| v1 isolation                         | pgTAP fingerprint and code scan                                                 |

No human approval was simulated as a production action.

## 24. Production read-only verification (final, 07:46:57 UTC)

- **Worker unscheduled:** Cron is job 2 only (`07549bf9…`), with no page job. Migrations are still 29, and no 16.32 object exists.
- **No new page activity:** the last claim is still 07:02:58.929 (16.31b). Edge logs from 07:03:30 to 07:48 show **0** worker requests. All 8 function versions and bundles are unchanged.
- **Byte-identical to the 07:13 baseline** (every fingerprint in §2):
  - attempts `8 609be86a…`, work states `8 f713791f…`, raw `7 ba71903b…`, fetches `34 478d974d…`, revisions `27 7988c46d…`, snapshots `7 be31bd14…`, ledgers `7 d7c9c45e…`, candidates `18 a51b7c75…`
  - identity layer, holds and imports
  - notices `90 81cef330…`, scopes, sync state, automation state and runs `58 2a0ad375…`
- **26777:** hold unchanged (`fe3a1b54…`, 0 resolutions); identity `465c3280…`; blockers `{human_reconciliation_required}`.
- **26773's 18 candidates:** all `unreviewed`; review ledger 0; reviewed criteria 0.
- **No human action:** 0 reconciliations, 0 capabilities, 0 reviewer authorizations.
- **v1:** healthy (06:17 `success`). **There was no natural v1 activity during this phase;** the next run is 12:17.
- **v2 and providers:** v2 tables 0; matches, alerts, push and owned products 0. There was no provider call.
- **Production access:** only `SELECT` statements through MCP, plus edge-log and function-list reads. No write, DDL, RPC call, deploy, secret operation, CLI login or page call.

## 25. Classification: **YELLOW-safe**

**Met:**

- A complete operational design exists (§3–§20).
- Known safety boundaries are preserved, and several are strengthened: an immutable grant history, a DB kill switch covering every caller, global concurrency and rate backstops, and Vault custody with URL pinning.
- The local implementation and every gate pass.
- Production was not mutated.
- The remaining human actions are listed (§26), and an installation plan is ready (§27).

**Why YELLOW and not GREEN:** essential **operator, credential and scheduling decisions remain unresolved** (D1–D4):

- there is no named operator, and no MFA policy
- the pg_net PUBLIC queue exposure and service_role Vault readability need an explicit accept-or-mitigate decision
- the v1 `staleSkipped` coupling needs a decision
- 26777 needs a design decision

**Not RED:** no identity provenance is weakened, no unauthorized human decision is possible, no incomplete negative evidence is used, v1 is untouched, and no credential is exposed by this phase.

## 26. Outstanding human decisions

| #   | Decision                                                                                                                                              | Needed before   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| D1  | Name the human operator, reconciler and criterion reviewer (separate people if possible); create their Auth accounts                                  | stage C         |
| D2  | Require MFA (`aal2`) for capability-gated RPCs? (not enforced today; would be a small additive migration)                                             | stage C         |
| D3  | Accept or mitigate B3 (pg_net PUBLIC queue; this also affects v1's key today) and service_role Vault readability                                      | stage C         |
| D4  | v1 coupling (B2): accept the :47 offset, `v1_run_active` and a no-manual-v1-while-running rule, **or** review a v1 change so stale pairs stay pending | stage E         |
| D5  | Approve the §12 parameters (hourly :47, 2 pages, caps 4/48, 168 h validity)                                                                           | stage E         |
| D6  | Approve the accepted-location design for 26777 (§6) as a future phase, or keep it held indefinitely                                                   | any time        |
| D7  | Raw-payload retention policy                                                                                                                          | about 1 GB      |
| D8  | Dispute mechanism and two-person rule for hold clearances (B6)                                                                                        | first clearance |
| D9  | Authorize the Phase 16.33 production install (§27)                                                                                                    | stage B         |

## 27. Exact next-phase installation proposal — Phase 16.33 (install inactive, no operator)

1. **Re-verify hashes:**
   - migration `dd3a40e1…9cdd`
   - worker source set `9e6e318e…4a02` (no redeploy needed)
   - edited remote suite `a2095fb7…f862`
2. **Write and rehearse a production-safe rollback-only suite:** `supabase/remote-install-checks/phase-16-33-page-stage-install.sql`.
   - The local 16.32 suite is **not** production-safe: it installs and uninstalls the v1 Cron job inside its transaction.
   - The new suite covers the catalog, ACL and RLS; the claim returning 0 for a stopped stage; fixture-only start, stop and backstops; the tick skipping without Vault secrets; the capability guards; and an unchanged v1 fingerprint.
3. **Read-only preflight:** as in 16.30 §4–5. Also confirm there is no natural v1 run within ±10 min and that CPSC is healthy.
4. **Dry run:** `supabase db push --dry-run --linked` must list exactly the one migration.
5. **The user runs** `supabase db push --linked`.
6. **Verify read-only:**
   - 30 migrations, and the catalog equals the local build
   - `cpsc_page_stage_control_state` = `never_started`
   - 0 Cron page jobs; job 2 unchanged
   - page attempts unchanged
   - eligibility still 31/1/6
7. **The user runs rollback-only suites:** the new 16.33 install check and the edited remote 16.26 suite (172).
8. **Observe the next natural v1 run** (success, watermarks forward-only, 0 page effects).
9. **Out of scope for 16.33:**
   - Vault or edge secret provisioning
   - capability grants
   - `start_cpsc_page_stage`
   - Cron install
   - any page call or tick
   - reconciliation or review
   - v2 or Nebius
   - commit or push

After 16.33 is GREEN, and once D1–D3 are decided, Phase 16.34 covers stage C–D (operator provisioning, key provisioning by script, one supervised tick). Stage E follows only after D4–D5.
