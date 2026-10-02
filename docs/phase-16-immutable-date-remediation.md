# Phase 16 immutable date-validation remediation gate

Status: **remediation applied once and post-application verification complete**.

The applied migration `20260920160000_phase_16_product_safety_evidence.sql` remains unchanged at
SHA-256 `ae0b79dc932d97336e0811d93caa9c4789a795a40f8afd381b052fea0d0711c8`.

## New migration

- Filename: `20260923040130_phase_16_fix_immutable_safety_date_validation.sql`
- SHA-256: `07fdc8e46edafb33eba99b56ff61f1885667cc21fc4461483839f05e6ce494cd`
- Object impact: `CREATE OR REPLACE` of
  `public.validate_owned_product_safety_attributes(jsonb)` only, followed by reassertion of the
  reviewed function ACL.
- No table, constraint, product, match, alert, fingerprint, or automation DML occurs.

## Validator change

The function remains `IMMUTABLE`, `STRICT`, `SECURITY INVOKER`, with an empty search path. Existing
key, JSON type, length, and control-character validation is preserved.

For manufacture and production dates it now:

1. requires `^[0-9]{4}-[0-9]{2}-[0-9]{2}$`;
2. extracts year/month/day with immutable fixed-position `pg_catalog.substr` calls;
3. converts only those digit components to integers;
4. calls immutable `pg_catalog.make_date` to prove calendar existence;
5. catches invalid calendar exceptions and returns `false`.

It contains no `to_date`, text-to-date cast, `to_char`, DateStyle-dependent parsing, locale-dependent
parsing, or timezone-dependent operation.

## Local verification

- Full `npx supabase db reset --local`: PASS; every migration replayed from zero, including the new
  remediation.
- Phase 16 pgTAP: `Files=1, Tests=44`, `Result: PASS`.
- Local lint over `public,private`: no warnings or errors.
- `pg_proc.provolatile = i`: validator is IMMUTABLE.
- Owner: `postgres`.
- ACL: PUBLIC false, anon false, authenticated true, service_role true.

Date regressions prove acceptance of `2026-01-01`, `2026-12-31`, and leap day `2028-02-29`.
They prove rejection of non-leap `2026-02-29`, `2026-04-31`, month 13, month/day zero,
two-digit-year and slash formats, padded whitespace, and timestamps.

## Production application and verification

The remediation was applied once through the linked migration workflow with Vault skipped and no
seed or external role flags. Remote migration history contains version `20260923040130` exactly
once.

Linked dry run with Vault skipped reports exactly:

```json
{
  "dryRun": true,
  "migrations": ["20260923040130_phase_16_fix_immutable_safety_date_validation.sql"],
  "seeds": [],
  "roles": []
}
```

The already-applied `20260920160000_phase_16_product_safety_evidence.sql` was not reapplied.

Post-application evidence:

- Remote lint for `public,private`: zero warnings and zero errors; the former volatility warnings
  are gone.
- Remote pgTAP: `Files=1, Tests=44`, all successful, `Result: PASS`.
- Live function: owner `postgres`, `provolatile = i`, `IMMUTABLE`.
- Live ACL: PUBLIC false, anon false, authenticated true, service_role true.
- `anon` has no SELECT/INSERT/UPDATE/DELETE grant on `owned_products`.
- Before/after state: 1 product, 0 matches, 0 alerts; product/match/alert SHA-256 fingerprints are
  unchanged.
- Existing product evidence: one empty object, zero non-empty objects; no fabricated evidence.
- No pending automation recalls, candidate matches, pushes, or active automation/matching leases.
- One normal scheduled Cron run occurred between snapshots at 06:17 UTC: success, zero candidate
  pairs, zero AI escalations, zero alerts, and zero push claims/deliveries.
- Cron remains one active `17 */6 * * *` job. Limits remain 100 recalls, 500 candidate pairs, 5 AI
  calls, and 25 notifications.
- CPSC and Health Canada remain active with `2026-09-23` watermarks.
- No v2 match, production reevaluation, shadow run, deliberate AI call, alert, or push was created
  by the remediation. Production remains `phase_10_guarded_v1`.

Quality gates:

- `npm run check`: PASS, including 34/34 Phase 16 Node tests.
- Phase 9.1, Phase 15, and revised Phase 16 freeze verification: PASS.
- Deno checks for all Phase 16 server modules and Edge entry points: PASS.
- `git diff --check`: PASS.
- Basic secret-pattern scan: no matches.
- Historical v1 artifacts remain unchanged.

Production matching remains `phase_10_guarded_v1`. No commit or Git push was performed.
