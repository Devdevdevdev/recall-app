# Phase 16.34 — Gate F (revoke obsolete paths): prepared, NOT executed

**Plan:** `docs/phase-16-34-controlled-installation-plan.md` §17, Gate F (also §8, §10, §11).

**Up to four separate production writes, all run by the user, each with its own approval and STOP:**

| Step   | Write                                                      | Plan status |
| ------ | ---------------------------------------------------------- | ----------- |
| **F1** | migration `20261001090000`: retire the key-based installer | required    |
| **F2** | `secrets unset RECALL_AUTOMATION_KEY`                      | required    |
| **F3** | `secrets unset CPSC_PAGE_WORKER_KEY`                       | optional    |
| **F4** | `alter role cpsc_page_worker password null;`               | recommended |

**Plan step 5** (revoking PUBLIC on `net.*`) is not possible for us; it is with Supabase support (§3).

**Excluded:** no tick, no `private.install_recall_automation_cron()` (before or after F1), no deploy, no other migration, no other secret, no page worker or v2 run, no Cron change, no commit or push.

## Order and timing

1. **F0:** read-only preflight.
2. **F1:** migration, then its post-check.
3. **F2:** unset, then the secret metadata check.
4. **F3** (if approved): unset, then the secret metadata check.
5. **F4** (if approved): guarded SQL.
6. **F5:** observe the next natural ticket run.

**Timing:** every write must be outside ±30 min of a :17 run. To observe 12:17 with `f5-…sql` as written, finish all approved writes between **06:50 and 11:45 UTC**. Otherwise use 12:50–17:45 and a re-dated F5 for 18:17.

## Why each step is safe

**F1** only changes what `private.install_recall_automation_cron()` would do **if it were ever run**:

- It recreates the ticket command, inactive, instead of the static-key command.
- It does not run the installer. Job 2 (jobid 2, active, `aae24c40…`) is not touched.
- Owner, `SECURITY DEFINER`, `search_path` and ACL stay the same.
- Today the installer is the **only** database function that references the static key, and it already fails closed (S6), because Vault no longer holds the key.

**F2.** `run-recall-automation` v11 (the release bytes, bundle `42d8a0dc…`) reads `RECALL_AUTOMATION_KEY` **only** on the static-header path. With the variable unset, `authorized()` returns false and that path gives 401.

- **Ticket path:** independent of that variable. `consume_recall_automation_ticket` uses the service key.
- **Children:** they use `RECALL_INGESTION_KEY`, `RECALL_MATCHING_KEY` and `RECALL_PUSH_DELIVERY_KEY`, which are not touched.
- **Other readers:** no other function reads `RECALL_AUTOMATION_KEY`.
- **Rehearsal:** S7 (ticket run OK with the key unset; static call 401).

**F3.** Only the deployed page worker v9 reads `CPSC_PAGE_WORKER_KEY`, for its static path. With it unset, every static call gets 401.

- The page stage is `never_started` and no page ticket exists, so nothing currently uses it.
- Re-enabling page work later needs a **new** key; that is a separate gate.

**F4.** `cpsc_page_worker` is the most realistic reader of the pg_net queue (§7, §11). It has 0 sessions, and page work is dormant.

- Only the password is removed. The role, its grants and `LOGIN` are kept.
- The page worker's `CPSC_PAGE_DB_URL` then holds a dead password. That is harmless, and it is not changed here.
- Re-enabling the role needs a new password and a new `CPSC_PAGE_DB_URL` (separate gate).

**Recovery is forward-only** (§10): no retired credential is ever restored.

## Files

| File                                                                                                       | Kind                                                                                                         |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `f0-preflight.sql`                                                                                         | read-only, 27 checks. The agent ran it at 2026-10-02 06:29:53 UTC: 27/27, `all_pass=true`.                   |
| `f1-postcheck.sql`                                                                                         | read-only, 27 checks. Validated read-only at 06:30:12: exactly the 4 F1 checks false, as expected before F1. |
| `secrets-metadata.py`                                                                                      | user only. Prints names and fingerprints, never a value or an individual digest.                             |
| `f4-lock-page-worker.sql`                                                                                  | **write**, guarded, user only. Rehearsed in PGlite.                                                          |
| `f5-natural-run-after-gate-f.sql`                                                                          | read-only, 39 checks, derived from E3.                                                                       |
| staged migration `supabase/gated-migrations/20261001090000_phase_16_34_gate_f_retire_v1_key_installer.sql` | **write** (F1), SHA-256 `227c6cd2…3886`                                                                      |

**`f4-lock-page-worker.sql` rehearsal results:**

- The nominal run commits: password null, `LOGIN` kept.
- These are refused with nothing changed: a second run, a page stage that is not dormant, an existing page ticket, work in flight, and a role without `LOGIN`.

The SHA-256 values are listed in the agent's report; recompute them before use.

## F0 (agent, read-only; user optional)

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-f/f0-preflight.sql
```

**Pass:** `all_pass: true`, `failed: []`.

**Secret metadata (user, before F2):**

```sh
npx supabase secrets list --project-ref cnftnulgtsraurtusnpb -o json | python3 audits/phase-16-34-gate-f/secrets-metadata.py RECALL_AUTOMATION_KEY CPSC_PAGE_WORKER_KEY
```

**Must show:**

- 17 names
- `secret_set_fingerprint` equal to the post-E1 canonical baseline
- both targets present

**Record:**

- **A** = `fingerprint_without_RECALL_AUTOMATION_KEY`
- **P** = `fingerprint_without_CPSC_PAGE_WORKER_KEY`
- **B** = `fingerprint_without_all_targets`

## F1 (user): retire the key-based installer

```sh
cp -n supabase/gated-migrations/20261001090000_phase_16_34_gate_f_retire_v1_key_installer.sql supabase/migrations/
shasum -a 256 supabase/migrations/20261001090000_phase_16_34_gate_f_retire_v1_key_installer.sql
#   must be 227c6cd26ab50af5398b4357dd2ab1849db0c4c0bfb37ba8cbb0ebed0ae83886
cat supabase/.temp/project-ref
#   must be cnftnulgtsraurtusnpb
npx supabase db push --dry-run --linked
#   must list exactly ONE migration: 20261001090000_phase_16_34_gate_f_retire_v1_key_installer.sql
npx supabase db push --linked
```

**Never run the installer afterwards:** it would unschedule job 2 and recreate it inactive under a new jobid.

**Post-F1:**

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-f/f1-postcheck.sql
```

**Pass:** 27/27, including:

- `installer_retired`: prosrc MD5 `c9ee5f44b93baa66a79d622eb538a21c`, the body of the staged file, confirmed in PGlite
- `no_function_references_static_key`
- `migrations_32`: `32 6b985817894f081ab0b31e85af51b3a1`
- `job2_ticket_command`: unchanged, which proves the installer was not executed

## F2 (user): remove the static path

```sh
npx supabase secrets unset RECALL_AUTOMATION_KEY --project-ref cnftnulgtsraurtusnpb
```

**Always pass the name.** `secrets unset` takes optional names. Answer the confirmation prompt; never add `--yes` without the name.

**Post-F2** (same `secrets-metadata.py` command as F0):

- 16 names: the 17 minus `RECALL_AUTOMATION_KEY`
- `RECALL_AUTOMATION_KEY_present: False`
- **`secret_set_fingerprint` = A**, which proves only that secret was removed
- `CPSC_PAGE_WORKER_KEY_present: True`

**Function listing:** the 8 bundles stay unchanged. Versions may each move up by 1, which was seen after E1's `secrets set` with identical bundles and `updated_at`.

## F3 (user, optional): page-worker invocation key

```sh
npx supabase secrets unset CPSC_PAGE_WORKER_KEY --project-ref cnftnulgtsraurtusnpb
```

**Post-F3:**

- 15 names
- `CPSC_PAGE_WORKER_KEY_present: False`
- `secret_set_fingerprint` = **B** if F2 was done first, or **P** if F3 was done alone

## F4 (user, recommended): lock the page-worker login

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-f/f4-lock-page-worker.sql
```

**The only write** is `alter role cpsc_page_worker password null;`, inside one transaction.

**Pre-assertions:**

- the role is login, not superuser, not `CREATEROLE`, not `BYPASSRLS`
- the password is set
- 0 sessions
- the page stage is dormant
- no work is in flight

**Post-assertions:**

- password null
- the other attributes are unchanged

The output shows `before` and `after` rows with `password_is_null` false, then true. **No hash is read.**

## F5 (agent, read-only): next natural run (12:17 UTC)

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-f/f5-natural-run-after-gate-f.sql
```

Run it at or after 12:19 UTC.

**Pass:** 39/39. It covers everything E3 checks, plus:

- `no_event_since_e3`
- `migrations_32`
- `installer_retired`
- `no_function_references_static_key`

`page_worker_password_is_null` is reported outside the checks; it must be true if F4 was applied. A `partial_success` run is accepted only with `source_partial_failure` and a source that really failed. CPSC returned a 502 at 06:17.

**Outside SQL:**

- **Edge logs, 12:16–12:47:** one `run-recall-automation` 200, no 401, no page or v2 request.
- **Function listing:** bundles unchanged.
- **Secret metadata (user):** the post-F2/F3 baseline.

## If any check fails

STOP and report. Don't tick, don't run the installer, and don't change anything without a new explicit authorization.

## Local follow-up (not production)

After F1 the repo has 32 migrations. The local pgTAP files that call the installer still create a Vault URL first, so they should keep passing:

- `phase-16-32 …:531`
- `phase-16-33 …:562`, which then converts job 2 anyway

This was not re-run, because Docker is down. Re-run the local suite before the next commit.
