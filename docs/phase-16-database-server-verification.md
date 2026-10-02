# Phase 16 database and server verification gate

Status: **database/server verification complete; awaiting explicit migration approval**.

No migration was applied. No matcher was activated or deployed. No Nebius call, alert, push, commit,
or Git push occurred.

## 1. Migration identity

- Filename: `20260920160000_phase_16_product_safety_evidence.sql`
- Original accepted-gate SHA-256:
  `f148a32b9becd28402164db737e2b3dc8fa3a80ed30e32ac345a0a96355a45ad`
- Current revised SHA-256:
  `ae0b79dc932d97336e0811d93caa9c4789a795a40f8afd381b052fea0d0711c8`

The first review found that validator execution had to remain available to authenticated writes.
Local runtime testing then showed that Supabase's function defaults also left an explicit
`anon=X/postgres` ACL entry after revoking `PUBLIC`. The migration now explicitly revokes the exact
function signature from both `PUBLIC` and `anon`, then grants only `authenticated` and
`service_role`. It remains `SECURITY INVOKER`.

## 2. Linked dry run

Command:

```text
npx supabase db push --linked --dry-run --skip-vault
```

Result:

```json
{
  "upToDate": false,
  "dryRun": true,
  "migrations": ["20260920160000_phase_16_product_safety_evidence.sql"],
  "seeds": [],
  "roles": [],
  "message": "Finished supabase db push."
}
```

Exactly one migration is pending. No seed or role change is included. `--skip-vault` explicitly
prevents Vault synchronization.

## 3. Database objects and validation contract

The migration is forward-only and changes:

1. `public.validate_owned_product_safety_attributes(jsonb)` — immutable, strict, invoker function
   with an empty search path.
2. Validator execution privileges — explicitly revoked from `PUBLIC` and `anon`, then granted only
   to `authenticated` and `service_role` so table constraints remain usable.
3. `public.owned_products.safety_attributes` — non-null JSONB with constant `{}` default.
4. `owned_products_safety_attributes_check` — invokes the validator.
5. A privacy-oriented column comment.

Validation requires a JSON object with at most the ten whitelisted keys naturally possible in
JSONB: variant, color, size, capacity, battery model, charging port, screw state, date code,
manufacture date, and production date. Unknown keys, arrays/scalars, nested objects, non-string
values, empty/over-120-character values, and control characters are rejected. Date fields must be
real canonical `YYYY-MM-DD` values. This bounds the matching contract to roughly ten 120-character
values; arbitrary nested or unbounded JSON cannot enter.

`scan_date` and `purchase_date` are not keys in this object and cannot satisfy manufacture or
production criteria. The existing product projection still excludes `scan_date`; v1 fingerprint
inputs remain unchanged.

## 4. RLS, legacy rows, and timestamps

- The column inherits the existing owner-only `owned_products` SELECT/INSERT/UPDATE/DELETE policies.
- No `anon` table grant or policy is introduced.
- The validator is pure and exposes no product data; granting its execution is not a credential.
- No service-role credential or secret is added to client code.
- Existing rows obtain `{}` through a constant default. There is no DML backfill or fabricated
  evidence.
- Adding the column does not fire row update triggers, so existing `created_at` and `updated_at`
  values do not churn.
- Later owner edits to safety evidence follow the existing behavior: `created_at` remains protected
  and `updated_at` advances.
- The migration contains no recall-match/alert update and no reevaluation trigger. V1 state and
  fingerprints remain untouched.

## 5. pgTAP review

The suite was expanded from 14 to **31 assertions**. It covers:

- column existence/type/not-null/default and validator existence;
- validator privileges for authenticated, service-role, and anonymous roles;
- all ten supported attributes and canonical dates;
- unknown key, non-object shape, non-string value, overlong value, non-canonical date, and invalid
  calendar date rejection;
- RLS enabled, owner read/write, cross-user read/write denial, and anonymous read/write denial;
- legacy product insertion without fabricated evidence;
- `created_at` preservation and `updated_at` advancement;
- a real `deterministic_v1` fixture remaining byte-for-byte unchanged after product evidence edits;
- no automatic reevaluation or alert creation.

The local database was recreated from zero and replayed the entire migration chain successfully.
The isolated Phase 16 suite then completed with `Files=1, Tests=31` and `Result: PASS`.

Final validator ACL after reset:

- owner `postgres`: EXECUTE;
- `PUBLIC`: no EXECUTE;
- `anon`: no EXECUTE;
- `authenticated`: EXECUTE;
- `service_role`: EXECUTE.

The local table-grant inventory contains no `anon` or `PUBLIC` privilege on `owned_products`.

## 6. Remote lint and server verification

Linked database lint command:

```text
npx supabase db lint --linked --level warning --fail-on warning
```

Result: extensions, private, and public schemas linted; **no schema errors or warnings found**.
Because the migration remains pending, this result covers the current remote schema, not the new
validator body.

Deno 2.9.6 successfully checked:

- product projection;
- deterministic v2;
- hybrid guarded v2;
- v2 local verifier and output schema;
- v2 fingerprinting;
- production recall-matching orchestrator boundary;
- `process-recall-matches` Edge Function;
- `run-recall-automation` Edge Function.

Production orchestration still imports and executes v1 only. No v2 integration switch was added.

## 7. Production impact snapshot

Captured read-only at `2026-09-22T20:03:02.017811Z`; no private product values were returned.

| State                       | Value                                                              |
| --------------------------- | ------------------------------------------------------------------ |
| Owned products              | 1                                                                  |
| Owned-product state SHA-256 | `8a2263c536dc46e51ee2cce98383d22e8b58cb494e3c5a3dfd2742a811fc7be8` |
| Recall matches              | 0                                                                  |
| Match state SHA-256         | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Alerts                      | 0                                                                  |
| Alert state SHA-256         | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Pending automation recalls  | 0                                                                  |
| Pending/processing pushes   | 0                                                                  |
| Candidate matches           | 0                                                                  |
| Active automation leases    | 0                                                                  |
| Active matching leases      | 0                                                                  |

Active authoritative sources:

- CPSC: active; watermark `last_publish_date = 2026-09-22`; last successful sync
  `2026-09-22T18:17:02.838928Z`.
- Health Canada: active; watermark `last_updated_date = 2026-09-22`; last successful sync
  `2026-09-22T18:17:03.553196Z`.

Automation:

- Exactly one active Cron job: `recall-automation-every-6h`, schedule `17 */6 * * *`.
- Automation, AI, and push controls are enabled.
- Limits: 100 recalls, 500 candidate pairs, 5 AI escalations, 25 notification deliveries, 7-day
  bootstrap/catch-up, 48-hour overlap.
- Production matcher policy remains `phase_10_guarded_v1`; no persisted matches currently exist.

## 8. Replay, benchmark, and hashes

Fresh read-only replay against frozen data:

- deterministic v1: 200/200 predictions reproduced; 0 mismatches.
- deterministic v2: 200/200 predictions reproduced; 0 mismatches.
- V2 metrics: 100% controlled accuracy; TP/FP/FN/TN = 67/0/0/133; 0 unsafe confirmations;
  100% precision and strict recall; 33% review; 67% coverage; 100% pairwise.
- `p15-str-45-2`, `p15-str-45-3`, and `p15-str-46-3` remain fixed.
- Phase 8/9 historical checks, Phase 9.1, Phase 15, and the revised Phase 16 manifest pass.
- No labels were regenerated.

## 9. Quality gate

- `npm run check`: PASS.
- Phase 16 tests: 33/33 PASS.
- CPSC validation: PASS through the aggregate check.
- Deno checks: PASS.
- Linked remote lint: PASS.
- Linked dry run: PASS.
- `git diff --check`: PASS.
- Basic secret-pattern scan: no matches.
- Android/iOS/web exports reused from the successful first gate because this gate changed only SQL,
  tests, manifests, and documentation—not mobile or native code.
- Expo Doctor not run because native dependencies/config did not change.
- Clean local database reset: PASS.
- pgTAP runtime: 31/31 PASS, `Result: PASS`.

## 10. Lock and operational impact

Production is PostgreSQL 17.6. `owned_products` currently has one row, an 8 KiB heap, and 212,992
bytes total including indexes. The constant JSONB default is metadata-only on modern PostgreSQL, but
`ALTER TABLE` still takes an `ACCESS EXCLUSIVE` lock and the immediate CHECK constraint validates
the table. With one row, execution should normally be sub-second once the lock is acquired. A
concurrent long transaction could delay acquisition.

Cron does not need pausing: v1 does not read this column, there are no pending jobs or leases, and
the operation is tiny. Apply between Cron ticks and do not deploy the updated client before the
column exists.

## Approval decision

All required local and linked verification gates now pass. The migration remains unapplied and must
not be pushed without explicit approval for the exact current SHA-256 above.
