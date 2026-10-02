# Phase 16.16A stop report: durable quarantine payloads and watermark safety

Status: **all local gates pass; stopped for review.** One forward-only migration is written and
proven locally. It is **not applied to production**. The rollback-only production validation (§20)
was **not run**: the session's permission classifier denied the remote command. Production was
only read, and it is byte-for-byte unchanged.

Not done in this phase:

- no migration applied to production
- no function deployed
- no ingestion run
- no watermark change
- no cron change (`active = false`)
- no reconciliation or review
- no v2 activity
- no Nebius call
- no commit or push

## 1. Worktree state

Nothing changed between the Phase 16.16 stop and the start of this gate. No file was newer than
`docs/phase-16-16-watermark-safety-stop-report.md`.

**Added (untracked):**

| File                                                                              | Purpose                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------- |
| `supabase/migrations/20260926210000_phase_16_16_quarantine_payload_retention.sql` | The migration                                     |
| `supabase/tests/phase-16-16-quarantine-payload-retention.sql`                     | pgTAP suite, 170 assertions                       |
| `supabase/functions/_shared/cpsc/sourceOutcome.ts`                                | Row-outcome classifier and run accounting         |
| `scripts/build-phase-16-16a-payload-attachment.mjs`                               | Builds the six-payload attachment input           |
| `docs/phase-16-16a-payload-attachment-manifest.json`                              | The six-payload attachment input                  |
| `scripts/build-phase-16-16a-rollback-validation.mjs`                              | Generates the production rollback-only suite      |
| `supabase/test-fixtures/phase-16-16a-rollback-validation.sql`                     | The rollback-only suite (generated; not auto-run) |
| `scripts/verify-phase-16-16a-local.mjs`                                           | Real-data local proof over HTTP                   |
| `tests/phase-16-16a-retention.test.mjs`                                           | Unit tests, 7                                     |

**Modified (local only, not deployed):**

- `_shared/cpsc/ingestionGate.ts` and `_shared/cpsc/types.ts`
- `ingest-recall-source/index.ts`, `ingest-recall-sources/index.ts` and `ingest-cpsc-recalls/index.ts`
- The gate mocks in `tests/phase-16-11-cpsc.test.mjs` and `tests/phase-16-12-rule-sets.test.mjs`
  (RPC name and retention echo only).
- `package.json`: 3 scripts added, and `test:phase-16-16a` added to `check`.

`npm run check` also rewrites `generatedAt` in the already-modified
`benchmarks/recall-matching/phase-15/audit.json`. That is a validator side effect.

## 2. Current quarantine-storage audit (before this migration)

| Item               | Finding                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observations       | `private.cpsc_identity_observations` (16.10). Append-only trigger (16.11). Identity, provenance and `payload_hash` columns, but **no payload**. `resolution ∈ {resolved, quarantined}` plus `decision_class`. |
| Quarantine state   | A quarantined observation row, plus `private.cpsc_identity_reconciliations`. Unique terminal decision per observation; `leave_unresolved` is repeatable.                                                      |
| Unique constraints | Observations: PK only, so every sighting appends. Reconciliations: one terminal decision per observation.                                                                                                     |
| Payload hash       | Worker `sourcePayloadSha256`, i.e. recursively key-sorted compact JSON. Caller-supplied and **never verified**.                                                                                               |
| Insert RPC         | `public.record_cpsc_identity_observation`, 9 arguments, 16.11 decision matrix, `service_role` only.                                                                                                           |
| Reviewer packet    | `private.cpsc_quarantine_evidence`, served by `get_cpsc_quarantine_packet` (needs the `identity_reconciliation` capability, 16.12). **No payload in it.**                                                     |
| Run aggregation    | `ingest-recall-source` throws on quarantine, so the record is rejected, the run is `failed` and the watermark is held.                                                                                        |
| Production         | 78 observations, 6 quarantined (`D_api_id_reuse`, all hash-only). Re-hashing the captured payloads reproduces all six recorded hashes.                                                                        |

## 3. Migration

- **File:** `supabase/migrations/20260926210000_phase_16_16_quarantine_payload_retention.sql`
  (516 lines)
- **SHA-256:** `33706d5006de9f9d7e900b51296598ba76638da3105acac594f26d1fa0834bc2`

**Added:**

- **Tables:**
  - `private.cpsc_observation_payloads`
  - `private.cpsc_observation_sightings`
- **View:** `private.cpsc_observation_payload_retention` (`security_invoker`)
- **Functions:**
  - `private.cpsc_canonical_json_v1`
  - `private.cpsc_payload_sha256_v1` (both immutable)
  - `private.cpsc_guard_sighting_update`
  - `private.cpsc_watermark_safety`
  - `private.cpsc_guard_watermark_advance`
  - `private.cpsc_attach_captured_payloads`
  - `public.record_cpsc_retained_observation`
- **Triggers:**
  - append-only and no-truncate on payloads
  - forward-only and no-truncate on sightings
  - `cpsc_guard_watermark_advance` on `private.recall_source_sync_state`
- **Indexes:**
  - payload lineage (`upstream_api_id`, `official_recall_number`, `revision_seq`)
  - `cpsc_identity_observations(payload_hash)`

**Replaced:** `private.cpsc_quarantine_evidence`. The 16.11 keys are unchanged; payload fields are
added. Its ACL is preserved.

**Grants:**

- `execute` on `record_cpsc_retained_observation` goes to `service_role` only.
- Everything else is revoked from `public`, `anon`, `authenticated` and `service_role`.
- RLS is on for both tables, with no policies.

**Unchanged:**

- the 9-argument gate: body (md5 verified) and grants
- every earlier migration file
- every existing row: no update, backfill or rewrite

**Rollback implications.** The migration is forward-only.

- **Before any payload is stored**, a reversal is lossless. Drop the watermark trigger, the new
  RPC, the view, both tables and the two indexes, then restore the 16.12 body of
  `cpsc_quarantine_evidence`.
- **After payloads are stored**, dropping the table destroys evidence. Disable instead: revoke the
  RPC and drop the trigger.

## 4. Durable payload schema

`private.cpsc_observation_payloads` holds one row per distinct authoritative CPSC API record.

**Generated columns** (a caller cannot supply them):

- `canonical_payload_sha256`, the **primary key**
- `upstream_api_id`, from `RecallID`
- `official_recall_number`, the normalized `RecallNumber`
- `canonical_payload_bytes`

**Stored columns:**

- `payload jsonb`, the complete record
- `revision_seq`, the lineage order
- `hash_contract`, `payload_contract`, `recorded_via`, `provenance` and `recorded_at`

**Checks:**

- the payload is an object
- canonical size is at most 256 KiB
- `RecallID` has 1–18 digits
- the recall number has 5 digits
- `URL` is on the CPSC recall host
- `Title` is not blank
- `RecallDate` is an ISO date

**Joins.** Everything else is joined, not copied, from the observation row:

- identity: API ID, recall number, observed and canonical URL
- observation timestamp
- the identity resolution (`decision_class`, `identity_id`)
- the reason and provenance

It holds public CPSC data only: no user, owned-product or credential data.

## 5. DB-verifiable hash contract: `cpsc-canonical-json-sha256/v1`

The hash is SHA-256 over the UTF-8 bytes of canonical JSON:

- keys sorted by code point (C collation) at every depth
- arrays in order
- no whitespace
- PostgreSQL JSON string escaping
- numbers as jsonb text

The contract uses **option A**: the payload is stored as canonical JSONB, and the database computes
the hash in a **generated stored column**.

**How forgery is blocked:**

- The RPC recomputes the hash and rejects a caller hash that differs (22023).
- A direct insert that names the hash column fails (428C9).
- The packet re-verifies the stored hash on every read (`hashVerified`).

**There is no raw-byte hash.** The CPSC API returns one array per window, so a single record has no
stable transport byte range to hash. There is therefore one hash concept, explicitly named.

**Equivalence evidence:**

- The v1 hash equals the worker's `sourcePayloadSha256` and the 16.12 SQL hash on **665/665**
  payloads (65 captured, 600 randomized). The randomized ones cover escapes, control characters,
  U+2028, BOM, CJK, emoji values and nesting.
- A fixed test vector is pinned in pgTAP.

**Caveat.** JavaScript orders keys by UTF-16 unit and SQL orders them by code point. They could
differ only for non-BMP characters in object **keys**. Such a payload fails closed on hash mismatch;
it is never stored inconsistently. CPSC keys are ASCII.

## 6. Immutability

- **Payload rows** reject `UPDATE`, `DELETE` and `TRUNCATE` (42501).
- **The key is the content hash**, so the same content can never have two rows, and changed
  content always gets a new row.
- **Observations stay append-only**, and the migration adds no column to them.
- **Sightings** reject delete and truncate. `first_seen_at` is immutable, and `seen_count` and
  `last_seen_at` only move forward.

## 7. Repeat-sighting dedupe

`record_cpsc_retained_observation` works in this order:

1. It validates, hashes and stores the payload (`on conflict do nothing`).
2. It calls the **unchanged 9-argument gate** inside a subtransaction. There is still one
   decision matrix.
3. If the result is `quarantined`, it looks for an earlier quarantined observation with the same:
   - payload hash
   - API ID and recall number
   - observed and canonical URL
   - title and date
   - decision class and reason
4. If one is found, it rolls back the duplicate insert and upserts
   `cpsc_observation_sightings`, which increments `seen_count`. It returns the **existing**
   `observationId` with `replayed: true`.

A replay creates no new observation, review item or payload row. A legacy hash-only quarantine seen
again by the worker is deduplicated onto the same row, and it gains its payload. Resolved
observations keep their pre-existing append behavior; their payload is content-addressed, so it is
not duplicated.

A changed decision class for the same payload counts as new review evidence, so it gets a new
observation but shares the stored payload.

**Cosmetic side effect:** a replay consumes one `observation_seq` value, leaving a gap.

## 8. Changed-payload revision behavior

Sequence tested: A, A, B, B, A.

- **pgTAP (synthetic data):** A and B each have one observation, a distinct verified hash and a
  retained payload. A is never overwritten, and lineage is ordered by `revision_seq` (A before B).
- **Real CPSC payload (recall 26756, local HTTP):**
  - revision B is `b7be9dc4…`, separate from A (`a3009284…`)
  - replaying A after B returns the original observation with `seenCount` 4
  - both packets list the lineage A then B, with `thisObservation` marking which revision each
    observation saw

## 9. Watermark-safety proof

**Rule:** the CPSC watermark may advance only if **every quarantined observation has a retained
payload**.

"Retained" is derived, never asserted. It means a stored payload with the same database-computed
hash, API ID and recall number exists. Resolved rows are accounted for by canonical state. `failed`
rows never allow success. A hash-only quarantine is never safe, whatever path created it and whether
or not it was reconciled.

**Two layers enforce the rule:**

1. **The worker.** A run succeeds only if `failed = 0` **and**
   `processed + unchanged + quarantined + unresolved + failed = fetched`.
2. **The database.** A trigger on `private.recall_source_sync_state` refuses any CPSC watermark
   change (23514) while `private.cpsc_watermark_safety()` reports `safe = false`. This holds even
   against the deployed v3 worker or a buggy caller.

Consequence: once the migration is applied, the **six legacy quarantines block the CPSC watermark
until they are attached (§15)**. That is intended, and harmless while the cron is off.

## 10. Six-collision results (local, real 16.15 manifest, production hashes)

The local database was rebuilt from the 41-notice snapshot and the 16.15 manifest: 78 observations
and 6 quarantines, with hashes identical to production.

| Recall | API ID | Payload hash   | Reused original row | Seen count after 2 replays |
| ------ | ------ | -------------- | :-----------------: | :------------------------: |
| 26749  | 10969  | `1316efd47ec3` |         yes         |           2 → 3            |
| 26753  | 10965  | `316823508cb7` |         yes         |           2 → 3            |
| 26754  | 10967  | `5af2405f874e` |         yes         |           2 → 3            |
| 26756  | 10968  | `a300928462e2` |         yes         |           2 → 3            |
| 26763  | 10966  | `2ead4847dfed` |         yes         |           2 → 3            |
| 26766  | 10970  | `b4a8d7501f9a` |         yes         |           2 → 3            |

These runs went through the real `ingestCpscRecallIdentity` against local PostgREST. For each of
the six:

- the payload was stored durably and its hash validated in the database
- the quarantine identity was unchanged
- the reused API ID alias still belongs to its historical recall (no hijack)
- the reconciler read the exact payload
- 12 replays added no observation, payload, alias, identity, notice or review row
- every outcome was classified `quarantined`, and a run of the six is `complete`

## 11. Reviewer payload packet

`get_cpsc_quarantine_packet` keeps its `identity_reconciliation` capability gate and all 16.11
keys. It adds:

- `payloadRetention` (`retained` or `legacy_hash_only`)
- `sourceRevision`:
  - `payloadSha256` and `hashVerified`
  - `hashContract` and `payloadContract`
  - `revisionSeq`, `recordedVia`, `recordedAt` and `provenance`
  - `payloadBytes`
  - the complete `payload`
- `sightings`: first seen, last seen and count
- `sourceRevisionLineage`: every stored revision for the API ID and recall number, with the
  quarantined observation IDs

It still carries the conflicting-identity evidence (`currentIdentity`, `conflictingAliases`,
`historicalNotices`, `priorDecisions`). Reconciliation snapshots now capture the payload too. The
packet holds no user or owned-product data.

## 12. RLS / ACL results

**pgTAP:**

- `anon`, `authenticated` and `service_role` have no `SELECT`/`INSERT`/`UPDATE`/`DELETE` on either
  table or on the view.
- RLS is on, with no policies.
- The new RPC is callable by the worker only.
- All private helpers are revoked.
- The worker is denied: packet, reconcile, `decide_cpsc_candidate`,
  `invalidate_cpsc_review_decision`, the attachment, and direct table reads and writes.
- `anon` and the consumer are denied both the RPC and the packet.
- A criterion reviewer without the capability is denied the packet.
- The reconciler receives the packet.

**Real local HTTP (GoTrue JWTs and PostgREST):**

- Denied the RPC: anon (legacy key), anon (publishable key), consumer, criterion reviewer and
  reconciler.
- Denied the packet: anon, consumer, criterion reviewer and worker.
- The worker cannot reconcile, review or attach, and cannot read the table over REST.
- The worker cannot store a payload under a forged hash.

**Earlier HTTP suites still pass:** 16.11 36/36, 16.12 65/65 and 16.13 38/38.

## 13. Payload size and security bounds

- The canonical payload must be **at most 262,144 bytes**. That is the same bound as the existing
  notice RPCs, and 58× the largest captured CPSC record (4.5 KB).
- A cheap `pg_column_size` bound of 1 MiB is checked before canonicalizing.

**Rejected with 22023:** oversized, non-object or missing payloads, and a hash mismatch.

**Rejected as "payload does not match its observation":** any mismatch in `RecallID`,
`RecallNumber`, `URL` or `RecallDate` versus the arguments, or a title not contained in the
payload.

A 200 KB record is accepted.

## 14. Legacy hash-only treatment

No row is rewritten and no payload is fabricated. Existing and 9-argument observations appear as
`legacy_hash_only` in the view and packet, with `sourceRevision: null`. They are counted as
**unaccounted** by the watermark rule.

A row becomes `retained` only when a payload whose **database-computed** hash equals its recorded
hash is stored. That happens either through the worker re-seeing it or through §15. A hash-only row
with no recoverable preimage (tested with a fabricated hash) can never be attached, and it keeps the
watermark blocked.

## 15. Planned bounded payload attachment for the six

- **Input file:** `docs/phase-16-16a-payload-attachment-manifest.json`, SHA-256
  `02117fdab48cb77c95c7c642ee0be59c89672e29c0e3ee3eeffa8d02c6f21da0`.
- **Deterministic:** it is rebuilt from the 16.14 capture (`c4b43808…`), the 16.15 manifest and
  the 16.15 execution artifact.
- **Cross-checked:** all six hashes match production read-only.

**Operation:** owner-only `private.cpsc_attach_captured_payloads(p_attachment, p_execute)`.

**Checks it enforces:**

- fixed `attachmentVersion`
- the saferproducts.gov API root
- the capture SHA-256
- 1–50 items with distinct hashes
- exactly 4 fields per item

**Per item:**

- the database recomputes the hash and requires it to equal the declared hash
- `RecallID` and the recall number must match
- a quarantined observation must already have recorded that exact hash

**Guarantees:**

- all-or-nothing, with a dry-run mode, and idempotent
- it writes only payload rows

Because every item must be the preimage of an already-recorded hash, no new content can enter
reconciled or unreconciled history.

**Local proof** (real data): the dry run would attach 6, run 1 attached 6, and run 2 reported 6
already retained.

## 16. Complete local pgTAP

Run from a clean `db reset` with the full chain, including the new migration and no manual patches:

- **14 files, 1262 assertions, all pass.** That is the 1092 baseline plus 170 new.
- The existing 13 files also passed unmodified on top of the migration.

## 17. DB lint

`db lint --local` on `public`, `private` and `extensions` gives **0 errors**.

The only warnings are the 5 known "unused parameter" notes on the retired
`approve_cpsc_product_model_criterion_v2` stub.

An initial IMMUTABLE-versus-STABLE warning on `cpsc_canonical_json_v1` was fixed:
`to_json(text)` was replaced with the immutable `jsonb_path_query(… '$.keyvalue()')`, and the
equivalence was re-verified on the 665 payloads.

## 18. HTTP and local ingestion tests

**`scripts/verify-phase-16-16a-local.mjs`: 48/48.**

| Area                   | What it proves                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Six collisions         | §10                                                                                         |
| Identical replay       | Deduplicated onto the existing row                                                          |
| Changed payload        | §8                                                                                          |
| Reviewer packet        | Exact payload returned                                                                      |
| Watermark accounting   | Refused over HTTP while the six are hash-only; accepted once all 7 quarantines are retained |
| Outcome classification | Correct                                                                                     |
| Authorization          | §12                                                                                         |
| Payload size           | Oversize is rejected over HTTP                                                              |

**Unit tests (`test:phase-16-16a`): 7/7.**

- The gate sends the payload and requires the database to confirm retention of its exact hash.
- Classifier and run completeness.
- The handlers no longer throw on quarantine.
- The attachment is deterministic.
- Static migration invariants.
- The rollback suite embeds the exact migration body.

**Not exercised:** the Edge handlers running inside `functions serve`. That needs live CPSC
retrieval. The gate was exercised over real PostgREST, and the handler logic is unit-tested.

## 19. Freeze results

All run inside `npm run check`, every step past format.

| Check                    | Result                                                            |
| ------------------------ | ----------------------------------------------------------------- |
| Phase 9.1 freeze         | `frozen: true`                                                    |
| Phase 15 freeze          | `frozen: true`                                                    |
| Phase 16 freeze          | `frozen: true`, `unsafeConfirmations: 0`                          |
| Historical matcher tests | Pass (21 test files, 0 failures)                                  |
| v2.1 on 200 cases        | **0 unsafe confirmations**, 0 changed decisions, 0 provider calls |

**Other checks:**

- `tsc` and `expo lint` are clean.
- `deno check` on all 7 Edge entrypoints passes (Deno 2.9.6 via npx, which may differ from the
  Edge runtime).
- `git diff --check` is clean.
- The secret scan found 0 matches.
- Prettier flags only `.claude/settings.local.json`, which was left unedited as instructed.

The matcher is untouched, so there is no change in matching behavior.

## 20. Rollback-only production validation: **not run**

**Prepared:** `supabase/test-fixtures/phase-16-16a-rollback-validation.sql`, SHA-256
`dc49883b306cfaaafadebddb620f40e7b0c27b159a65da2c192eecd49cf7a6f0`.

**Structure:**

- `BEGIN`
- the exact migration body, guarded by a unit test
- 50 assertions against real production rows, covering:
  - the migration rewrites no row
  - the v1 hash equals the 16.12 hash on every production notice
  - the six hashes are unaccounted
  - the watermark is refused
  - the attachment would attach 6
  - the packets carry the exact payloads
- `ROLLBACK`

**Deliberately excluded:** observation inserts, because an `observation_seq` advance survives
`ROLLBACK`.

**Local rehearsal** on a pre-migration, production-shaped database: **50/50**, rolled back. The
payload table, the trigger and pgTAP were all absent afterwards.

**Why it did not run.** The production run
(`npm run test:remote-pgtap -- --file supabase/test-fixtures/phase-16-16a-rollback-validation.sql`)
was **denied by the session's auto-mode permission classifier**, so it never executed. It was not
retried by any other route.

## 21. Proof production remained unchanged

Read-only snapshots were taken before (twice) and after, using psql with
`default_transaction_read_only=on`. They show **zero differences** in every field:

- **Cron:** job 2 `17 */6 * * *` with **`active = false`**; the last run was 2026-09-26 06:17 UTC.
- **Migrations:** 22, the last being `20260926150000`; no 16.16 row.
- **New objects:** `cpsc_observation_payloads` and the sightings table are absent.
- **pgTAP:** not installed.
- **Sessions:** 0 idle in transaction.
- **Row fingerprints (count:md5):**
  - observations `78:802af1ab…` (6 quarantined)
  - identities, aliases, API revisions, notices, scopes and sync state
- **Unchanged schema and sequences:** all sequences, the CPSC function-body md5 and the private
  relation set.
- **Watermarks:** CPSC and Health Canada at `2026-09-26`.
- **Function versions:** `ingest-cpsc-recalls` 15, `ingest-recall-source` 3,
  `ingest-recall-sources` 1, `run-recall-automation` 3, `process-recall-matches` 11,
  `send-recall-notifications` 6, v2 cohort 1.

**All zero:**

- reconciliations
- reviewed criteria, rule sets and the review ledger
- v2 rows
- matches, alerts, push queue and deliveries
- owned products
- leases

## 22. Recommendation

Apply the migration and resume Phase 16.16 in this order, with the cron **off** throughout:

1. **Review and approve** migration `33706d50…` and attachment `02117fda…`.
2. **Optional but recommended:** allow or run the rollback-only suite (§20) via the transient-pgTAP
   wrapper. Expect 50/50, then re-check the §21 snapshot.
3. **Apply the migration.** The deployed v3 workers stay compatible, because the 9-argument gate is
   unchanged. The CPSC watermark is now DB-blocked until step 4.
4. **Attach the six payloads:**
   - dry run with `private.cpsc_attach_captured_payloads(<manifest>, false)`; expect
     `wouldAttach = 6`
   - execute with `true`; expect `attached = 6`
   - confirm `private.cpsc_watermark_safety()->>'safe' = 'true'`
5. **Deploy** `ingest-recall-source`, `ingest-recall-sources` and `ingest-cpsc-recalls`.
   Automation, matcher and push are unchanged.
6. **Resume Phase 16.16 at step 6** (bounded dry runs, then the reactivation gate).
7. **Follow-up:** revoke the legacy 9-argument RPC from `service_role` once the new workers are
   verified in production. The watermark trigger already makes this non-critical.

**Remaining risks:**

- `unresolved` is a reserved outcome that no database decision produces yet (26777 resolves as a
  known alias, so `unchanged`).
- Replay dedupe leaves `observation_seq` gaps.
- The watermark rule is global: any future hash-only quarantine pauses CPSC until it is attached.
- The page-evidence debt from 16.15 is unchanged. It still blocks any v2 production cohort.
