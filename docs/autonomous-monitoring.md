# Autonomous recall monitoring

Phase 12 adds a production-ready scheduled monitoring architecture. It is deliberately shipped
inactive: `private.recall_automation_control.enabled`, `ai_enabled`, and `push_enabled` all default
to `false`, the Phase 11 `RECALL_PUSH_DELIVERY_ENABLED` gate remains independent, and the Cron
installer creates its job with `active = false`. Recurring production monitoring must not be
claimed until an operator explicitly completes the activation gates.

## Architecture and schedule

```text
Supabase Cron (17 */6 * * *, UTC)
  -> pg_net POST
  -> Vault lookup: recall_automation_url + recall_automation_key
  -> run-recall-automation
       -> database run claim and expiring singleton lease
       -> ingest-cpsc-recalls
       -> persistent affected-recall queue
       -> process-recall-matches with deliverPush=false
       -> send-recall-notifications only when both push gates allow it
       -> aggregate run completion and lease release
```

The job name is `recall-automation-every-6h`. Four scheduled opportunities per UTC day occur at
minute 17. The orchestrator owns sequencing only; CPSC mapping/upsert behavior, `deterministic_v1`,
`hybrid_guarded_v1`, the safety verifier, and Expo Push delivery remain in their Phase 7-11
modules. Cron and secure manual calls use this same endpoint.

## Authentication and Vault

`run-recall-automation` is POST-only and requires the dedicated server secret
`RECALL_AUTOMATION_KEY` in `x-recall-automation-key`. It is never a mobile key and must not appear
in Git, Expo configuration, `EXPO_PUBLIC_*`, logs, or documentation with a real value.

Cron resolves its endpoint and authentication at execution time from these Vault names:

- `recall_automation_url`: the complete HTTPS URL ending in
  `/functions/v1/run-recall-automation`;
- `recall_automation_key`: the same value securely configured as the Edge Function's
  `RECALL_AUTOMATION_KEY`.

Create or update both through a private SQL session or the Supabase Dashboard Vault UI. Do not put
their values in a migration or paste them into chat. Then call
`private.install_recall_automation_cron()` from a trusted database administration session. The
installer removes any older job with the logical name, creates exactly one job, and immediately
marks it inactive. `private.set_recall_automation_cron_active(boolean)` is the explicit activation
switch after approval.

## Watermark, overlap, and catch-up

The incremental boundary is CPSC `LastPublishDate`, not `RecallDate`. State is stored privately as
the last successfully covered UTC date. The ingestion child still issues only bounded requests
using `LastPublishDateStart` and `LastPublishDateEnd`.

- No watermark: ingest seven inclusive UTC dates ending at current bounded server date.
- Existing watermark: start 48 hours before it.
- Normal operation: end at current UTC date.
- Long downtime: advance the upper boundary by at most seven uncovered days per run.

The watermark advances only after a complete authoritative ingestion response with zero rejected
records. A failed or over-limit response does not advance it. The 48-hour overlap is safe because
Phase 7 upserts by authoritative CPSC identity and compares meaningful content. Inserted or
materially updated notices are returned as a bounded affected set; unchanged notices are not
requeued.

Affected recall IDs are stored in `private.recall_automation_pending_recalls` before matching.
This prevents a successful ingestion followed by a matching outage from losing work. Entries are
removed only after a complete matching stage; incomplete work is retained and rotated by last
attempt time for a later scheduled run.

## Controls and hard limits

`private.recall_automation_control` is inaccessible to mobile roles. Initial limits are:

| Control                              | Initial value | Hard migration constraint |
| ------------------------------------ | ------------: | ------------------------: |
| maximum recalls per run              |           100 |                       100 |
| maximum candidate pairs per run      |           500 |                     1,000 |
| maximum Nemotron escalations per run |             5 |                         5 |
| notification delivery batch          |            25 |                        50 |
| bootstrap lookback                   |        7 days |                   14 days |
| catch-up advance                     |        7 days |                   14 days |
| overlap                              |      48 hours |                  72 hours |

Manual payload limits may only lower the database controls. The matcher always runs
`deterministic_v1` first. `ai_enabled = false`, verification mode, or a requested AI cap of zero
prevents Nebius initialization. Cap exhaustion and provider failure remain `needs_review`; they
never fabricate a confirmation or alert.

Push requires all of the following: successful matching, control `push_enabled = true`, and the
Phase 11 `RECALL_PUSH_DELIVERY_ENABLED=true` server gate. The orchestrator tells the matcher not to
deliver directly, then invokes the existing push worker once. Phase 11's confirmed-only queue,
device `enabled_at <= queued_at` cutoff, unique alert/device delivery, retries, and receipt checks
remain unchanged. Old alerts are not backfilled.

## Lease and failure behavior

`private.recall_automation_lease` is a singleton database lease with a random token and bounded
expiry. A healthy lease returns `skipped_already_running`. A later run can recover an expired lease
and closes the abandoned history row as `failed` / `lease_expired`. In-memory state is never the
concurrency authority.

Ordering is fail closed:

- ingestion failure: no matching, no push, no watermark advance, status `failed`;
- matching failure, provider failure, or exhausted processing bound: affected recalls stay queued,
  push is skipped, status `partial_success`;
- push failure: recall data, matches, and alerts remain committed, status `partial_success`;
- disabled control or live lease: `skipped_disabled` or `skipped_already_running`.

Child functions keep their existing bounded retry behavior. The orchestrator does not wrap them in
another retry loop; the next Cron opportunity is the retry boundary.

## Observability

`private.recall_automation_runs` stores aggregate timings, windows, limits, ingestion counts,
affected recall count, matching decisions, AI escalation/provider-failure counts, alert count,
push counters, and normalized error step/code. It does not store secrets, push tokens, emails, OCR
content, product identifiers, prompts, or raw provider responses.

Inspect from a trusted SQL session only:

```sql
select *
from private.recall_automation_runs
order by started_at desc
limit 20;

select jobid, jobname, schedule, active
from cron.job
where jobname = 'recall-automation-every-6h';

select jobid, status, start_time, end_time, return_message
from cron.job_run_details
order by start_time desc
limit 20;
```

Neither `cron` administration nor Recall automation tables are exposed to mobile roles.

## Safe verification and incident recovery

A constrained production verification may run while the global control is disabled:

```json
{
  "trigger": "manual",
  "verificationMode": true,
  "maxRecalls": 10,
  "maxCandidatePairs": 50,
  "maxAiEscalations": 0,
  "notificationBatchSize": 5
}
```

Verification mode always forces AI and push off. It performs real bounded CPSC ingestion and normal
deterministic matching; it does not simulate recalls. Invoke it only with the automation secret via
a secure environment variable, never a literal shell-history value.

To stop processing immediately, first deactivate the Cron job, then disable all controls:

```sql
select private.set_recall_automation_cron_active(false);

update private.recall_automation_control
set enabled = false,
    ai_enabled = false,
    push_enabled = false,
    updated_at = now()
where singleton;
```

Also set `RECALL_PUSH_DELIVERY_ENABLED=false` through Supabase secret management when push must be
stopped independently. Existing persisted alerts are retained. After an incident, inspect the run
history, pending recall queue, Cron history, and Edge Function logs; fix the cause, use one
zero-AI/zero-push verification run, then request fresh activation approval.

## Activation gates

Before the first AI-capable or push-capable recurring run, report schedule and runs/day, all run
limits, theoretical maximum AI calls/day, current model, expected cost exposure, device count,
pending eligible deliveries, Vault/Cron readiness, and expected first-run AI/push behavior. Obtain
separate explicit approval for recurring automation, automatic Nebius escalation, and automatic
push delivery. A safe deterministic verification does not grant those approvals.
