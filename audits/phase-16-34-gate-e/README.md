# Phase 16.34 — Gate E (retire the exposed static key): prepared, NOT executed

**Plan:** `docs/phase-16-34-controlled-installation-plan.md` §17, Gate E.

**Two separate production writes, both run by the user:**

- **E1:** rotate the Edge secret `RECALL_AUTOMATION_KEY`
- **E2:** delete Vault `recall_automation_key`

**Excluded:** no tick, no `install_recall_automation_cron()`, no Gate F, no `secrets unset`, no deploy, no migration, nothing on page or v2.

## Order and timing

1. **E0** read-only preflight: SQL, plus the user's secret metadata.
2. **E1:** rotation.
3. **Post-E1 checks:** secret metadata.
4. **E2:** Vault delete.
5. **Post-E2:** read-only SQL.
6. **E3:** observe the next natural ticket run.

**Timing:** E1 and E2 must both be done outside ±30 min of a :17 run, so **before 05:45 UTC** for E3 at 06:17. Otherwise use 06:50–11:45 and observe 12:17 with a re-dated copy of E3.

## Why the order is safe

- **Ticket runs don't depend on either key.** v11 authenticates `x-recall-automation-ticket` through `consume_recall_automation_ticket` and never reads `RECALL_AUTOMATION_KEY` on that path. The tick reads only Vault `recall_automation_url`.
- **After E1, the static path is dead.** The Vault key no longer equals the Edge key, so the static-key command would get 401. That means `audits/phase-16-34-gate-c/cr-rollback.sql` **no longer restores a working path** after E1.
- **Recovery after E1 is fix-forward only** (plan §10): no retired credential is ever restored.
- **Only the Phase 12 installer reads Vault `recall_automation_key`.** After E2 it fails closed (S6). Don't run it.

## Files

| File                                      | Kind                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `e0-preflight.sql`                        | read-only (agent ran it at 2026-10-02 04:19:30 UTC: 19/19, `all_pass=true`)                    |
| `secrets-metadata.py`                     | user-only metadata check; prints names and fingerprints, never a value or an individual digest |
| `e1-rotate-edge-secret.sh`                | **write** (Edge secret), user only                                                             |
| `e2-delete-vault-key.sql`                 | **write** (one Vault row), guarded, user only                                                  |
| `e2-postcheck.sql`                        | read-only                                                                                      |
| `e3-natural-run-after-key-retirement.sql` | read-only, derived from D1                                                                     |

The SHA-256 values are listed in the agent's report; recompute them before use.

## E0: secret metadata (user, before E1)

```sh
npx supabase secrets list --project-ref cnftnulgtsraurtusnpb -o json | python3 audits/phase-16-34-gate-e/secrets-metadata.py
```

**Must show:**

- `secret_count: 17` and the 17 baseline names
- `secret_set_fingerprint: 38aa0e25589c46b7a553cf9349b0f2cd76805e5b0f96689029fddaec4b024cb4`, which proves the script reproduces the user's formula
- `recall_automation_key_present: True`

**Record:** `others_fingerprint` (call it **O**) and `recall_automation_key_marker` (call it **M**).

**If the full fingerprint differs from `38aa0e25…`,** the field layout differs from the user's script: STOP before E1.

## E1 (user)

```sh
bash audits/phase-16-34-gate-e/e1-rotate-edge-secret.sh
```

**The script runs the plan's command:**

```sh
npx supabase secrets set --project-ref cnftnulgtsraurtusnpb --env-file <(printf 'RECALL_AUTOMATION_KEY=%s\n' "$NEW_KEY")
```

**How the value is handled:**

- generated in memory with `openssl rand -hex 32`
- checked to be 64 hex characters **before** use, so an `openssl` failure can't set an empty key
- passed through a process-substitution pipe, never written to disk and never printed
- unset afterwards

## Post-E1 checks (user metadata, then agent)

**Run the same metadata command. It must show:**

- `secret_count: 17`, with the same 17 names
- `others_fingerprint` == **O**, so no other secret changed
- `recall_automation_key_present: True`
- `recall_automation_key_marker` != **M**, so the key was rotated
- `secret_set_fingerprint` != `38aa0e25…`; the new value becomes the **canonical baseline**

**The agent then checks, read-only:**

- the function listing is unchanged (8 bundles; `secrets set` deploys nothing)
- Vault still holds `{recall_automation_key, recall_automation_url}`, since E2 hasn't run yet
- job 2, queue 0 and leases 0 are unchanged

**Any mismatch:** STOP. Don't run E2. There's no rollback of E1, by design.

## E2 (user)

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-e/e2-delete-vault-key.sql
```

**The only mutation:**

```sql
delete from vault.secrets where name = 'recall_automation_key';
```

**The checks around it, in one transaction:**

- **Pre-assertions:**
  - Vault is exactly `{recall_automation_key, recall_automation_url}` with their recorded timestamps
  - job 2 is the only job, on the ticket command (MD5 `aae24c40…`)
  - queue 0, both leases 0, nothing running
- **Row count:** exactly **1** row deleted.
- **Post-assertion:** Vault is exactly `{recall_automation_url}` with its unchanged timestamp.

**If any assertion fails,** nothing is committed.

**Rehearsed** with an in-memory PGlite copy of the relevant tables (Docker was unavailable for the local stack):

- nominal: 1 row deleted, committed, Vault = `{recall_automation_url}`
- a second E2: refused (pre-state)
- an unexpected Vault row: refused
- work in flight: refused

## Post-E2 (agent, read-only)

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-e/e2-postcheck.sql
```

**Must show:** `all_pass: true`, 17/17 checks. They cover:

- `recall_automation_key` absent, `recall_automation_url` present with an unchanged timestamp, URL pinned
- job 2 on tickets
- queue 0, leases 0, nothing running
- runs `66 68ed14ac` and tickets `3 7fe6a0c5` unchanged (valid before 06:17)
- page, v2, humans, 26777 and the candidates unchanged
- migrations unchanged

**Validated read-only on production at 04:22:49, before E2:** the only failure was `vault_key_absent_url_only`, as expected.

## E3: observe the 06:17 natural run (agent, read-only, at or after 06:19)

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-e/e3-natural-run-after-key-retirement.sql
```

**D1's checks, re-dated and adjusted:**

- window 06:16–06:47
- history `66 68ed14ac` / `3 7fe6a0c5`
- `no_event_since_d2`
- `vault_static_key_absent`
- watermarks ≥ `2026-10-02`

**Must show:** `all_pass: true`. It covers:

- ticket consumed once by `run-recall-automation`, `rejected_attempts` 0
- HTTP 200, no timeout, no 401
- run `success` (or only the plan's `partial_success` / `source_partial_failure` with a real source failure)
- theft query empty
- queue 0, leases 0
- outcomes for affected recalls
- invariants unchanged

**Expected sequence gap:** the next ticket is seq 5, because the D3 probe consumed seq 4 and rolled back.

**Outside SQL:**

- **Edge logs, 06:16–06:47:** one `POST run-recall-automation` v11 with 200; v1 children only; no 401; no page worker or v2 call.
- **Function listing:** unchanged.
- **Secret metadata (user):** equal to the **post-E1** baseline.

## On failure

STOP and report. No tick, no installer, no restore of a retired key, no improvised change.
