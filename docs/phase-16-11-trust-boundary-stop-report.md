# Phase 16.11 stop report: CPSC trust boundary and identity-aware ingestion

Status: implemented and verified locally only. Nothing was applied to production, nothing was
deployed, no Nebius call, no commit, no push. deterministic_v2 stays inactive.

## 1. Worktree handoff

- Same worktree as Phase 16.10. Nothing was reset or discarded; the untracked Phase 16 files and the
  modified tracked files match the 16.10 handoff.
- Hashes before any change: 16.9 `615c88ca…5b7`, 16.10 `89a96abc…0540` (both match the handoff).
  Both files are byte-for-byte unchanged at the end of the phase.

## 2. Criterion write-path graph (`private.recall_scope_criteria_v2`)

Before 16.11:

| Path                                                | Kind                                                                                                             | Who                                                                              | Effect                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `approve_cpsc_product_model_criterion_v2` (16.4)    | SECURITY DEFINER RPC                                                                                             | `service_role` EXECUTE, free-text `p_reviewer_id`                                | UPSERT of a matcher criterion. **This was the bypass.** |
| Direct table DML                                    | grants                                                                                                           | none for anon/authenticated/service_role; service_role has no USAGE on `private` | only the table owner                                    |
| Triggers on the table                               | none                                                                                                             | n/a                                                                              | n/a                                                     |
| `get_recall_v2_scopes`                              | reader                                                                                                           | service_role                                                                     | served **any** row whose `source_url` matched           |
| `capture_evaluation_evidence_v2`                    | reader (trigger)                                                                                                 | internal                                                                         | evidence snapshot only                                  |
| `orchestratorV2` → `validateLiveReviewedCriteriaV2` | TS consumer                                                                                                      | worker                                                                           | accepted any non-empty `reviewerId` string              |
| Deployed workers                                    | none call the approval RPC                                                                                       | n/a                                                                              | n/a                                                     |
| Tests                                               | `phase-16-4-full-path.sql`, remote compatibility test, 16.3 gate template, `phase-16-4-production-path.test.mjs` | owner / fixtures                                                                 | exercised the legacy path                               |

After 16.11 there is exactly one path to a matcher-consumable criterion:

```
human reviewer (authenticated + current authorization)
  → decide_cpsc_candidate            (ledger event, attested)
  → materialize_cpsc_reviewed_conjunction
      → private.cpsc_reviewed_conjunction_criteria(revision, group)   (single builder)
      → INSERT/UPDATE guarded by trigger cpsc_guard_reviewed_binding (re-runs the builder)
  → get_recall_v2_scopes              (re-runs the builder on every read; else NULL)
  → validateLiveReviewedCriteriaV2    (accepts only origin = human_review_ledger)
```

## 3. Legacy approval bypass remediation

- `approve_cpsc_product_model_criterion_v2`: EXECUTE revoked from public, anon, authenticated and
  service_role; body replaced with `raise … 42501 'Retired…'`. The signature is kept so the applied
  Phase 16.4 history and its grants still resolve. It now fails even for the table owner.
- Defense in depth: a BEFORE INSERT/UPDATE trigger on `recall_scope_criteria_v2` rejects any row that
  is not byte-equal to the ledger builder output for a current, fully reviewed conjunction. Legacy
  rows (`origin = 'legacy_phase_16_4'`, production count 0) are never served.
- The TS validator rejects the retired free-text shape.

## 4. Ledger → matcher materialization

The builder returns a criterion set only if all of these hold, and returns NULL otherwise:

- Every conjunction member's latest ledger event (by the new monotonic `event_seq`) is `reviewed`
  with mandatory attestation and non-empty attestation text.
- The reviewer held an authorization at decision time (`authorized_at ≤ decided_at` and not revoked
  before it).
- The source revision is current, and the event's revision hash equals it.
- The candidate is unchanged: criterion value, operator, evidence address, conjunction key and
  scope all equal what was reviewed.
- Every member of the group is usable and attests the same scope. There is no flattening.
- At least one model criterion is present. A date-code-only conjunction would widen eligibility.
- The scope's notice is linked to the revision's identity, and its canonical URL equals the
  revision's.

The output embeds `origin`, revision id and hash, group, scope id, a scope fingerprint, candidate
ids, review-event ids, reviewer ids and `reviewedAt`. Because reads re-run the builder, these all
make a served criterion NULL immediately: staleness, rejection, a later revision, a scope edit, or
an official-URL edit.

## 5. Final service_role privilege boundary

| Object                                                                                    | service_role after 16.11                                                                                                               |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| all `private.cpsc_*` tables, `recall_scope_criteria_v2`                                   | no privileges (16.9/16.10 grants revoked; they were unusable anyway without schema USAGE)                                              |
| `public.recall_notices`, `recall_scopes`, `recall_notice_jurisdictions`, `recall_sources` | SELECT only (INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER revoked; also from anon/authenticated)                                   |
| worker RPCs (6)                                                                           | EXECUTE; each also checks the service role internally                                                                                  |
| human RPCs (decide, packet, materialize, quarantine packet, reconcile)                    | no EXECUTE                                                                                                                             |
| retired approval                                                                          | no EXECUTE                                                                                                                             |
| `public.recall_matches`, `public.alerts`, other v1 tables                                 | unchanged broad grants: **legacy compatibility debt** (v1 uses definer RPCs; not touched to avoid destabilizing `phase_10_guarded_v1`) |

A code search found no edge function, app, or script that writes the four revoked tables
directly. Every writer is a SECURITY DEFINER RPC. pgTAP phases 10–14 still pass.

## 6. New-recall identity creation

`record_cpsc_identity_observation` (same signature, now worker-only) creates a canonical identity
when the recall number is unknown and none of the following hold:

- another identity owns the URL (canonical or a human-confirmed URL alias);
- the API ID is held by any identity alias or any historical notice;
- any historical CPSC notice carries the recall number (payload `RecallNumber`) or canonical URL.

The last check prevents duplicating unbackfilled history.

The worker then calls `ingest_cpsc_identity_notice(observation_id, …)`. It takes the title, date and
URL from the resolved observation, verifies the payload `RecallID`/`RecallNumber`, and inserts the
notice with `external_id = 'cpsc:<recall number>'`. The numeric API ID stays an alias and is never
the key. It links the notice, marks the identity reconciled, and returns the notice id so the v1
automation receives it as an affected recall. It is idempotent and never rewrites an existing notice.

## 7. Identity decision matrix (all branches tested)

| Case | Input                                        | Result                                                          |
| ---- | -------------------------------------------- | --------------------------------------------------------------- |
| A    | known recall + known API alias               | `resolved`, `A_known_alias`                                     |
| B    | known recall + new non-conflicting API ID    | `resolved`, `B_new_alias` (alias attached)                      |
| C    | new number, consistent URL, no history       | `created`, `C_new_identity`                                     |
| D    | API ID held by another recall                | `quarantined`, `D_api_id_reuse`                                 |
| E    | number conflicts with another recall's URL   | `quarantined`, `E_number_url_conflict`                          |
| F    | title changed                                | `resolved` + flag `title_revised`                               |
| G    | publication date changed                     | `resolved` + flag `publication_date_revised`                    |
| H    | equivalent URL spelling (host, slash, query) | `resolved` + flag `url_spelling_alias`                          |
| H′   | non-equivalent URL change for a known number | `quarantined`, `E_url_changed` (human may confirm as URL alias) |
| X    | unknown number but history carries it        | `quarantined`, `X_unlinked_history`                             |
| R    | reused API ID after human confirmation       | `resolved`, `R_reconciled_alias`                                |

## 8. Title and metadata semantics

- Identity-defining: source `cpsc` + official recall number.
- Identity-corroborating: canonical URL. Contradiction quarantines; an equivalent spelling resolves.
- Revisional metadata: title, publication date, API payload (`payload_revised`), URL host spelling.
  These are recorded as observation flags and API revisions. They never quarantine and never
  create an identity.
- Decision on G: the date is revisional when number and URL agree. The number encodes the recall,
  and CPSC corrections do not change it. The flag keeps the change visible for review.
- Existing notices are not rewritten by any automated path. The correction lives in the
  observation or revision lineage.

## 9. Quarantine reconciliation

- `get_cpsc_quarantine_packet` is human-only. It shows the incoming API ID, number, observed and
  canonical URL, title, date, payload hash, provenance, reason and class. It also shows the current
  identity with its linked notices, the conflicting aliases (owner, provenance, human-confirmed
  flag), the historical notices carrying the API ID, number or URL, and prior decisions.
- `reconcile_cpsc_quarantined_observation(obs, decision, rationale)` is human-only and requires a
  rationale. The decisions are:
  - `confirm_alias`: target is the identity for the observation's number. It refuses if the URL
    belongs to another recall, so a reconciliation can never merge two recalls.
  - `confirm_new_identity`: refuses if the number already has an identity.
  - `reject_observation`.
  - `leave_unresolved`: repeatable.
- One terminal decision per observation. Reconciliations, observations, ledger and candidates have
  append-only triggers (UPDATE/DELETE raise).
- Confirmation adds aliases tagged with `reconciliation_id`. Historical aliases, notice links and
  notices are never modified.

## 10. Six known collisions

All six ran through the real RPCs in the local simulation (not a whitelist):

- First pass: 24 resolved and 6 `D_api_id_reuse`.
- Each quarantine packet exposed the conflicting historical alias or notice.
- A human `confirm_alias` was recorded for each, with the reviewer id and rationale.
- Replaying the 30 current observations twice resolved all 30 identically: 24 `A_known_alias`
  and 6 `R_reconciled_alias`.
- Historical notices, links and 16.8 aliases are byte-identical before and after.

## 11. Worker persistence RPCs (service role only, validated, bounded, idempotent)

| RPC                                | Guarantees                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `record_cpsc_identity_observation` | matrix above; ≤1000-char title, ≤2048-char URL, ≤200-char provenance; no future timestamps; one global identity-decision lock                                               |
| `ingest_cpsc_identity_notice`      | resolved observation only; payload ≤256 KB; ≤200 scopes; texts ≤20 000 chars; never rewrites                                                                                |
| `get_cpsc_page_fetch_targets`      | limit 1–50; reconciled identities only; URLs come from identity rows; `sole_scope_id` only when the notice has exactly one scope                                            |
| `record_cpsc_page_revision`        | evidence must name the identity's own number and URL, else a contradiction error; server clock sets `current_since`; `created`/`unchanged`/`reverted`; ≤512 KB              |
| `record_cpsc_page_fetch`           | canonical CPSC URL; a 200 must bind a revision of the same identity; redirect chain ≤3; fetch time within a bounded window; idempotent unique key                           |
| `propose_cpsc_candidate_criterion` | only the 4 reviewable classes; operator derived from class; identifier grammar; address bound to the current revision; scope must belong to the recall; always `unreviewed` |

None of them can write the ledger, a reconciliation, or a matcher criterion.

## 12. TypeScript/Deno HTML extractor

`_shared/cpsc/htmlExtractor.ts` is a faithful port of the prototype's `html.parser` tree:

- raw text for script/style/xmp/iframe/noembed/noframes, and RCDATA for title/textarea;
- Python's exact whitespace set;
- `html.unescape` semantics, with a generated HTML5 entity table (`htmlEntities.ts`, from
  `scripts/generate-cpsc-html-entities.py`; dev-time only).

Identity checks inside the document: the canonical link must match, and the displayed recall number
must be exactly one. Missing sections, undecodable references, and node, depth or span limits all
throw.

Results against the frozen fixtures:

- All seven fields are exactly equal to the frozen Python dataset for all three pages.
- AGA: six rows preserved; `production_date_range deferred: 6 paired rows`; its prose manufacturing
  window is also reported; 0 proposals.
- Char-Broil: 18 unreviewed candidates, 9 conjunctions of (model AND date codes 2510/2511/2512), no
  cross product.
- Friedrich: no tables; the "Only some serial numbers…" restriction is unresolved; 0 proposals.
- Cosmetic DOM edits leave the semantic hash unchanged. Row and date-code edits change it.

## 13. No recall-ID hardcoding

The `26773` branch was removed, along with the "Bistro Pro" phrase and the `253021xx` model pattern.
Proposals now come from document semantics only:

- header-typed columns (model, date code, descriptive, deferred, unknown);
- row-paired model/date-code tables;
- a model table governed by exactly one parsed "Only … with date codes of … are included in this
  recall." sentence.

Any other restriction sentence blocks all proposals for the page. Location sentences ("is located",
"printed") are ignored. A test scans every production CPSC module for benchmark numbers and names.

## 14. Fetcher timeout and SSRF

- The deadline covers every hop and the body. It aborts the signal and independently rejects via
  `Promise.race`, so a transport or stream that ignores abort still cannot exceed it.
- New tests cover: a transport that ignores the signal, a signal-honoring transport, a stalled body,
  timeout bounds, and a typed HTTP status on failure.
- Resolved-IP validation is not implemented, deliberately. Deno's `fetch` resolves on its own, and
  Edge Runtime offers no way to pin the connection to a pre-validated address. A separate
  `Deno.resolveDns` check would be time-of-check/time-of-use pseudo-protection.
- The actual controls:
  - exact host allowlist (`cpsc.gov`, `www.cpsc.gov`) checked before URL parsing;
  - HTTPS only, with certificate validation. A DNS answer pointing at 169.254.169.254, loopback or
    RFC 1918 cannot present a valid `cpsc.gov` certificate;
  - no userinfo or ports; `/Recalls/` only; manual redirects re-validated per hop; maximum 3;
  - text/html only, ≤1 MB, strict UTF-8, 10 s deadline;
  - URLs come only from identity rows whose CHECK constraint enforces `https://www.cpsc.gov/Recalls/`,
    via `get_cpsc_page_fetch_targets`. There is no caller-supplied URL path.

## 15. Review authorization over real HTTP

`scripts/verify-phase-16-11-http-auth.mjs` (`npm run test:phase-16-11:http`) ran 36/36 checks. It uses
real GoTrue users and JWTs against local PostgREST and refuses non-loopback URLs.

- Denied: anon; the consumer JWT; the `service_role` JWT and the `sb_secret` key (decide,
  materialize, retired approval, reconcile); the revoked reviewer.
- A reviewer cannot run worker RPCs.
- Allowed: the authorized reviewer (packet, decide, materialize, reconcile); the worker (observation,
  notice creation, revision, proposals).
- The criterion served by PostgREST passed the TS validator. deterministic_v2 confirms
  model AND matching date code, and does not confirm a wrong date code.

## 16. Conjunction safety (pgTAP, permanent)

- MODEL reviewed + DATE CODE reviewed: materializes and is served.
- MODEL reviewed + DATE CODE rejected / unreviewed / stale: unusable.
- MODEL stale + DATE CODE reviewed: unusable. The still-reviewed sibling never survives alone.
- Two complete groups materialize independently.
- A second complete group on an occupied scope fails closed.
- A date-code-only group is never materialized.
- A ledger row by a never-authorized or already-revoked reviewer is unusable. Revocation after the
  decision keeps the decision.

## 17. Stale invalidation

- A cosmetic transport refetch creates no stale event.
- A material revision stales all 12 reviewed members and serves nothing.
- An A→B→A revert returns `reverted`: A is current again, B's reviews go stale, and nothing silently
  revives.
- Scope edits and official-URL edits make the criterion unusable; restoring them restores it.
- A page naming another recall raises an identity contradiction and records no revision.
- A title correction is a flagged revision.

## 18. Local production-shaped simulation (rolled back)

`python3 scripts/simulate-phase-16-11-ingestion.py` passed 19/19 checks:

- 31 notices (30 preserved + 1 new) and 44 scopes;
- 28 identities (27 + new) and 27 canonical pages preserved;
- 31 links; 3 duplicate groups linked, not merged;
- first pass: 22 A, 3 B, 1 C, 6 D, 1 E. The title correction resolved with `title_revised`;
- 6 reconciliations; replay: 24 A, 6 R, deterministic;
- 0 misassociations and 0 historical rewrites;
- 0 criteria and 0 v2 rows.

A post-run check found 0 rows persisted.

## 19. Matcher isolation

Unreviewed, rejected, stale, and partial conjunctions yield `reviewed_criteria = NULL` from
`get_recall_v2_scopes`. A full, current, human-reviewed conjunction is served. The TS contract test
and the HTTP test confirm deterministic_v2 consumes it. No evaluation, eligibility or alert row is
created. The selector is still `phase_10_guarded_v1`.

## 20. Migrations (apply strictly in this order)

| Order | File                                                       | SHA-256                                                            |
| ----- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| 1     | `20260924060002_phase_16_9_cpsc_authoritative_source.sql`  | `615c88ca277e1a2dedbdcc0b48d3a1eef02c41d17c2766a0fca2229f135ef5b7` |
| 2     | `20260924065448_phase_16_10_cpsc_identity_review_gate.sql` | `89a96abc5dd693237ea87535cb8ccf4b00f7fc097250b19384bbd83900540058` |
| 3     | `20260925061100_phase_16_11_cpsc_trust_boundary.sql`       | `4e8589be70da26a86f24b5398c213db73438745e313c6b8842235c4cce23c0ce` |

16.11 is forward-only. It replaces 16.10 functions and views in place with `create or replace`.

## 21. pgTAP

`npx supabase db reset --local --yes` then `npx supabase test db`: **746/746 PASS** across 11 files.

- The previous suite is now 484: the 16.4 full-path file gained one `throws_ok` for the retired path.
- The new file `phase-16-11-cpsc-trust-boundary.sql` adds 262.

Prior assertions superseded by the 16.11 contract (edited, not deleted):

- 16.9 and 16.10 checks for worker INSERT on `cpsc_page_fetches`/`cpsc_candidate_criteria` now
  assert EXECUTE on the replacement RPCs.
- The 16.10 title, date, and unknown-number quarantine rows now assert a revision, a revision, and
  identity creation.
- 16.10 observation calls run with a service-role claim.
- The 16.4 full path now asserts that the retired approval throws.

## 22. Database lint

`supabase db lint --local`: **0 errors.** The only notes are "warning extra" unused parameters on the
retired approval stub, which is intentional.

## 23. Deno, npm and freezes

- `deno 2.9.6` (`npx -y deno@2 check`): all 13 production-path files pass. These include the
  identity, fetcher, evidence, gate, extractor, entities, page-ingestion and validator modules, the
  orchestrator, both ingestion functions, `process-recall-matches`, and the v2 cohort.
- `npm run check` exits 0. It covers typecheck, eslint, prettier, every phase suite (new
  `test:phase-16-11` 17/17; matcher 27/27; frozen CPSC HTML verified), the Phase 9.1, 15 and 16
  freeze guards (`frozen: true`), the v2.1 holdout audit, and v2.1 safety (0 unsafe confirmations,
  0 provider calls).
- `git diff --check` is clean.
- Secret scan of every file touched in 16.11: no matches.

## 24. Read-only production audit

**Not performed.** No Supabase MCP is connected in this session, and the phase rules forbid
substituting a direct database connection. Pending: migration status for 16.9, 16.10 and 16.11;
function versions; reviewed criteria, v2 evaluations, eligibility, snapshots, corrections and push
queue counts.

## 25. Unresolved risks

1. The production audit (above) is outstanding.
2. `supabase/tests/remote/phase-16-production-compatibility.sql` and the 16.3 gate template still
   exercise the retired approval. They describe pre-16.11 production and must be revised before 16.11
   is applied, because the remote test's DO block would raise there.
3. deterministic_v2 is one `all_of` per scope. Per-row alternative conjunctions (Char-Broil's nine)
   on a single notice scope cannot all materialize: the first succeeds and the rest fail closed.
4. Existing notices are never refreshed by the identity-aware path. Corrections to title or remedy
   are lineage only, and v1 keeps matching historical content.
5. If 16.9–16.11 are applied without the historical backfill, observations of existing recalls
   quarantine as `X_unlinked_history`. This is safe, but blocks their lineage. New recalls work.
6. Reviewers rely on worker-extracted packets. A compromised worker cannot approve, but could
   mislead a reviewer who skips checking the official page.
7. Revocation is decision-time: a compromised reviewer's past decisions stay valid until a source
   revision stales them. There is no revoke-for-cause yet.
8. After A→B→A, A's previously reviewed candidates stay stale. The candidate uniqueness key excludes
   parser version, so re-review needs a new proposal generation.
9. The database owner or a superuser can still disable triggers. The read path still re-verifies,
   but forging the ledger and authorization rows is possible at that privilege level.
10. `ingest_cpsc_identity_notice` binds identity fields, not a full payload hash: TS canonical JSON
    is not reproducible byte-exactly in SQL.
11. Broad service_role grants remain on `recall_matches`, `alerts` and other v1 tables.
12. The unlinked-history scan and the global identity lock are fine at current volume but need
    indexes and sharding at scale.
13. The frozen fixture HTML contains trailing whitespace (byte-frozen, intentionally untouched).

## 26. Recommendation for Phase 16.12

1. Connect the Supabase MCP and complete the read-only production audit before anything else.
2. Rewrite the remote compatibility test and the 16.3 gate template for post-16.11 semantics.
3. Write an audited, admin-run production backfill plan for the historical CPSC identities. The
   16.11 simulation is the rehearsal.
4. Decide how alternative conjunctions are represented: reviewed per-row scopes, or an `any_of`
   matcher revision with a new benchmark freeze.
5. Design a reviewed notice-revision path for corrections to existing notices, and add
   revoke-for-cause reviewer semantics.
6. Only then consider applying 16.9 → 16.10 → 16.11 to production, still inactive.
