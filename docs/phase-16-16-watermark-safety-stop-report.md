# Phase 16.16 stop report: watermark safety is not provable, so quarantine stays fatal

Status: **stopped at step 5.** Watermark safety for quarantined CPSC observations cannot be
proven with the current schema, and a fix needs a database migration. The phase rules require
stopping in both cases.

- No code was changed.
- No function was deployed.
- No migration was written into `supabase/migrations/` or applied.
- No HTTP dry run or live ingestion was made.
- The cron was not touched and is still `active = false`.
- Production was only read. A read-only snapshot diff before and after this work shows no change
  apart from the timestamp.

Steps 6–23 were not executed.

## 1. Worktree and production preflight

**Worktree.** It is exactly as Phase 16.15 left it: 33 tracked files modified (+836/−233), plus
the untracked Phase 16 files. The only file added is this report.

**Production.** Read-only via `psql` with `default_transaction_read_only=on`, 2026-09-26 20:13 UTC.

| Check                                            | Value                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| Cron                                             | job 2 `recall-automation-every-6h`, `17 */6 * * *`, **`active = false`** |
| Last cron run                                    | 06:17 UTC, succeeded; automation run `success`, 16 unchanged             |
| `ingest-cpsc-recalls`                            | v15, `00849ced…0b6b`                                                     |
| `ingest-recall-source`                           | v3, `e338d781…d7f4`                                                      |
| `ingest-recall-sources`                          | v1, `640d8a47…24f3`                                                      |
| `run-recall-automation`                          | v3, `29aa1681…ef6c`                                                      |
| `process-recall-matches`                         | v11, `81f96b1d…8d6b`                                                     |
| `send-recall-notifications`                      | v6                                                                       |
| v2 cohort                                        | v1                                                                       |
| Automation / matching leases                     | 0 / 0                                                                    |
| Reviewed criteria / rule sets / all v2 tables    | 0                                                                        |
| Owned products / matches / alerts                | 0 / 0 / 0                                                                |
| Push queue / deliveries                          | 0 / 0                                                                    |
| Notices / scopes                                 | CPSC 41 + Health Canada 38 / 92                                          |
| CPSC identities / aliases / observations         | 38 / 226 / 78 (6 quarantined)                                            |
| Reconciliations / human-confirmed aliases        | 0 / 0                                                                    |
| Duplicate identity numbers / multi-owner API IDs | 0 / 0                                                                    |
| CPSC watermark                                   | `last_publish_date` 2026-09-26, last run `success`                       |
| Health Canada watermark                          | `last_updated_date` 2026-09-26, last run `success`                       |

## 2. Root cause: why a quarantine fails the whole CPSC source run

The path for one CPSC record under cron, as deployed today:

1. **`ingest-recall-sources`** (v1) reads the CPSC watermark and derives the window:
   `startDate = max(endDate − 30 days, watermark − 2 days)`. It then calls `ingest-recall-source`
   with `maxRecords = 50`, which is 100 split between two sources.
2. **`ingest-recall-source`** (v3) calls `ingestCpscRecallIdentity` for each record. That calls
   the RPC `record_cpsc_identity_observation`.
3. **The RPC** always inserts a row into `private.cpsc_identity_observations`, an append-only
   table. In the `D_api_id_reuse` case it records `resolution = 'quarantined'` and returns
   `{status: 'quarantined'}`. It writes no alias and no API revision.
4. **`ingestionGate.ts`** returns the quarantine as a value, and does not throw.
5. **The handler then turns that into an exception.**
   `supabase/functions/ingest-recall-source/index.ts:134-136` does
   `if (outcome.status === 'quarantined') throw new Error('CPSC identity quarantined: …')`.
   The shared `catch` counts the error as `stats.rejected += 1`, the same bucket used for
   database and parser failures.
6. **Source-run aggregation.** `complete = stats.rejected === 0`, so the handler calls
   `record_recall_source_sync_result` with status `failed`, error `record_rejected`,
   `p_watermark = null`. The SQL function then keeps the old watermark.
7. **`ingest-recall-sources`** marks CPSC `failed` because `rejected > 0`, and increments
   `sourceFailures`. Its `totals.rejected` is never incremented, so it always reports 0.
8. **`runRecallAutomation`** still records ingestion, and the automation-level watermark
   advances. Because `hasSourceFailure` is set, it completes the run as `partial_success` with
   error `source_partial_failure`, **after matching and before push**. Push is skipped for every
   source, not only CPSC.

The root cause is in step 5: a safely isolated identity outcome is re-thrown as a generic row
error. From that point, a quarantine is indistinguishable from a technical failure. The manual
endpoint `ingest-cpsc-recalls/index.ts:137-138` does the same.

Three secondary findings:

- **The held watermark does not preserve anything either.** It only widens the CPSC window, up
  to 31 days, after which the record slides out anyway. CPSC published 11 records in the 3-day
  window 2026-09-24..26. A window held for about two weeks is therefore likely to exceed the
  50-record cap, and `cpscRecallSourceAdapter.retrieve` throws when it does. Under today's
  semantics, a recurring quarantine would degrade into a full CPSC `retrieval_failed` outage.
- **Replaying a quarantine is not idempotent.** Each re-sighting of the same collision inserts
  another quarantined observation row, so the human queue grows every 6 hours. Canonical state
  (identities, aliases, notices) is unaffected.
- **None of the six collisions is due next cycle.** All six, and 26777, have `LastPublishDate`
  2026-09-10 or 2026-09-17, outside the next window (from 2026-09-24). They would recur only if
  CPSC republishes them.

## 3–4. Outcome semantics (designed, **not implemented**)

Each record would get exactly one outcome.

| Outcome       | Meaning                                                                        | Fatal to the run? |
| ------------- | ------------------------------------------------------------------------------ | :---------------: |
| `processed`   | New notice inserted, or a notice revision created                              |        no         |
| `unchanged`   | Resolved to a known identity; revision `unchanged`                             |        no         |
| `quarantined` | The gate returned `quarantined` **and its payload is durably stored** (see §5) |        no         |
| `unresolved`  | Identity is known; page or redirect evidence is unresolved (for example 26777) |        no         |
| `failed`      | Any of the cases below                                                         |      **yes**      |

A record is `failed` on any of the following:

- a database error
- an invalid RPC result
- a malformed authoritative identity (`normalizeCpscNumber`, `canonicalCpscUrl`, or a 22023 or
  "Invalid CPSC observation" error)
- a 42501 authorization error
- a parser or runtime exception
- a quarantine whose payload persistence could not be confirmed

The run would succeed if and only if `failed = 0` **and** every fetched record is accounted for:

`fetched = processed + unchanged + quarantined + unresolved + failed`

The metrics would carry a separate `quarantined` count, and the per-source summary in
`ingest-recall-sources` would carry it too, so success-with-quarantine is visible and never
silent. `inserted`, `updated`, `unchanged` and `rejected` keep their current meaning. The
automation and `recordIngestion` invariants would then hold unchanged, and
`run-recall-automation` would need no redeploy.

## 5. Watermark safety: **NOT PROVEN**

The step 5 requirements, checked against production:

| Requirement                                                         | Holds? | Evidence                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | :----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The raw or current observation is persisted, or durably represented | **no** | The observation row stores API ID, recall number, observed and canonical URL, title, publication date, `payload_hash`, provenance and decision class. **It does not store the payload body.** No other table does: `recall_notices.raw_payload` and `cpsc_notice_revisions.raw_payload` are written only for **resolved** observations, and `cpsc_backfill_items.detail` holds no payload bodies (checked). |
| Canonical and source provenance retained                            |  yes   | The observation row keeps `provenance`, `observed_at`, `decision_class` and `reason`.                                                                                                                                                                                                                                                                                                                       |
| Replay is idempotent                                                | **no** | Every replay inserts a new quarantined row (append-only). Canonical state is idempotent.                                                                                                                                                                                                                                                                                                                    |
| Reconciliation does not need a refetch                              | partly | The identity **decision** does not need one: `cpsc_quarantine_evidence` builds its packet from stored rows. Applying the observation's **content** would need a refetch.                                                                                                                                                                                                                                    |

**Proof that content would be lost.** I hashed the stored canonical notice payloads with the
production `sourcePayloadSha256` and compared them with the six quarantined observations.

- All six observation hashes equal the captured current payloads.
- **None** equals its stored notice.
- The current CPSC payloads carry revised content that exists **nowhere in production**:

| Recall | Fields that differ from the stored notice                                  |
| ------ | -------------------------------------------------------------------------- |
| 26749  | `Description`, `Remedies`, `RemedyOptions`, `Images`                       |
| 26753  | `RecallID` only, plus `URL` host spelling                                  |
| 26754  | `Distributors` added                                                       |
| 26756  | `Description`, `Remedies`, `RemedyOptions`, `Retailers`, `ConsumerContact` |
| 26763  | `Description`, `ConsumerContact`                                           |
| 26766  | `Description`                                                              |

The only copy of those bodies is the local, untracked `docs/phase-16-14-cpsc-fresh-capture.json`.

**Conclusion.** Suppose a successful run with a quarantine advanced the watermark past a record,
and CPSC later edits or withdraws that record. The quarantined revision would then survive only
as a hash, and no refetch could be verified against it. That is exactly the "silently lost behind
the watermark" case, so quarantine stays fatal.

Today's fatal behavior does not protect the observation either (§2). It only delays the loss by
up to 31 days, while suppressing push on every cycle.

## 6. Proposed migration: drafted in this report only, **not written or applied**

`phase_16_16_cpsc_quarantine_payload_retention`. It is additive only.

1. **New table `private.cpsc_observation_payloads`**, content-addressed:
   - `payload_hash text primary key` (hex64)
   - `raw_payload jsonb not null` (an object, at most 256 KiB, the same bound as
     `ingest_cpsc_identity_notice`)
   - `first_recorded_at`
   - an append-only trigger, RLS enabled, and no grants to `anon` or `authenticated`
2. **`record_cpsc_identity_observation` gets a new parameter, `p_raw_payload jsonb`.**
   - The existing 9-argument signature stays for the backfill and is revoked from the worker path.
   - The payload is required whenever the result is `quarantined`.
   - The RPC checks `RecallID = p_api_id` and the normalized `RecallNumber = p_recall_number`
     (the existing `ingest_cpsc_identity_notice` rule).
   - It recomputes the canonical SHA-256 in SQL: sorted keys, JSON.stringify-compatible scalars,
     `pgcrypto` `digest`. It raises on a mismatch with `p_payload_hash`.
   - It then inserts the payload with `on conflict do nothing`.
3. **Idempotent quarantine replay.** An identical unresolved quarantine (same API ID, recall
   number, canonical URL, `payload_hash` and decision class, with no terminal reconciliation)
   returns the existing `observationId` with `replayed: true` instead of inserting another row.
   Resolved observations keep their current append behavior.
4. **Include the stored payload in the quarantine packet**, so reconciliation needs no refetch.
5. **pgTAP coverage:**
   - hash mismatch rejected
   - RecallID or number mismatch rejected
   - replay produces no new row
   - no path from payload to identity, alias, notice, scope, reviewed criterion or v2 row
   - `anon`, `authenticated` and `service_role` direct-table access denied

After that, the code changes are:

- `ingestionGate.ts` passes the payload.
- `ingest-recall-source` gets the outcome classes and the success-with-quarantine rule from §3–4.
- `ingest-recall-sources` passes the per-source `quarantined` count through.
- `ingest-cpsc-recalls` gets the same outcome handling.

The functions to redeploy would be `ingest-recall-source`, `ingest-recall-sources` and
`ingest-cpsc-recalls`. The automation, matcher and push functions stay unchanged. Steps 6–23
would then run as written.

## 7. Items kept unchanged, as instructed

- 26777 is not reconciled, has no `…-Hazard` alias and no page evidence.
- The six collisions are not reconciled.
- No reviewer roles, criteria or page-evidence approval were created.
- `phase_10_guarded_v1` is still the matching policy.
- No Nebius call was made.
- No commit or push.

**Page-evidence debt (unchanged).** Live CPSC page-evidence ingestion is not implemented in the
scheduled production path. This is a hard blocker for any v2 production cohort, any
`deterministic_v2` activation and any automatic v2 confirmation. Phase 16 is not v2
production-ready.

## 8. Decision needed

1. **Recommended: approve the §6 migration.** I would then write it to `supabase/migrations/`,
   rehearse it locally with pgTAP, and run the remote rollback-only pgTAP. I would stop again
   before applying it to production, then continue 16.16 from step 6 with the cron still off.
2. **Or explicitly accept hash-only retention.** Quarantine becomes non-fatal with no migration.
   Reconciliation would refetch by recall number, and any upstream edit made meanwhile would be
   unrecoverable. This contradicts the step 5 requirement as written, so it needs your explicit
   override.
3. **Or keep the cron paused** until 1 is done. This is the current state.
