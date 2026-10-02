# Phase 16 audit records

This directory keeps the evidence behind Phase 16 production changes. Nothing here is imported by
the app or by an Edge Function. Only `tests/phase-16-20-candidates.test.mjs` reads
`phase-16-20/`.

## Deployed Edge Function sources

Production was deployed function by function from separately verified trees, not from the shared
`supabase/functions` worktree. The worktree therefore holds newer, never-deployed code in some
shared modules (for example the inactive v2 rule sets and the ticket-based page worker), and lacks
one deployed change (`ingest-recall-sources` per-outcome accounting). Before any redeploy, start
from the exact tree below, not from the worktree.

State verified on 2026-10-02 against the production function list (latest deploy 2026-10-01
04:43 UTC, before the A3 capture):

| Function                           | Version | Deployed (UTC)   | `ezbr_sha256` | Exact source tree                                                         |
| ---------------------------------- | ------- | ---------------- | ------------- | ------------------------------------------------------------------------- |
| `ingest-cpsc-recalls`              | 26      | 2026-09-27 05:36 | `2b0774c5…`   | `phase-16-34-gate-a3/pre-deploy-archive/ingest-cpsc-recalls`              |
| `ingest-recall-source`             | 15      | 2026-09-27 19:28 | `ba394992…`   | `phase-16-20/candidate-a` (byte-identical to the A3 archive)              |
| `ingest-recall-sources`            | 12      | 2026-09-27 19:40 | `c41cb92e…`   | `phase-16-20/candidate-b` (byte-identical to the A3 archive)              |
| `process-cpsc-page-evidence`       | 12      | 2026-09-29 12:00 | `c15d6623…`   | `phase-16-34-gate-a3/post-deploy/process-cpsc-page-evidence`              |
| `process-recall-matches`           | 22      | 2026-09-30 19:18 | `0b83d930…`   | `../releases/phase-16-34-gate-a` (byte-identical to A3 post-deploy)       |
| `process-recall-matches-v2-cohort` | 11      | 2026-09-24 05:17 | `682308bd…`   | `phase-16-34-gate-a3/pre-deploy-archive/process-recall-matches-v2-cohort` |
| `run-recall-automation`            | 14      | 2026-10-01 04:43 | `42d8a0dc…`   | `../releases/phase-16-34-gate-a` (byte-identical to A3 post-deploy)       |
| `send-recall-notifications`        | 16      | 2026-09-15 10:38 | `58b6945b…`   | identical to `supabase/functions`                                         |

Files where the deployed bundle and the worktree differ:

- `run-recall-automation`, `send-recall-notifications`: none.
- `process-recall-matches`, `process-recall-matches-v2-cohort`: `recallMatching/orchestratorV2.ts`
  and `reviewedCriteriaV2.ts`. The worktree has the newer 16.12 rule-set versions, dormant while
  v2 is inactive.
- `process-cpsc-page-evidence`: `index.ts`. The deployed worker still uses a static key; the
  worktree has the 16.33 single-use ticket version. The page worker is disabled.
- `ingest-recall-source`, `ingest-recall-sources`, `ingest-cpsc-recalls`: entrypoints and shared
  `recallSources`, `cpsc` and `healthCanada` modules. The worktree carries the unshipped 16.19
  watermark proposal. Its Health Canada client matches the one deployed in `ingest-recall-source`,
  while `ingest-recall-sources` bundles an older copy. The deployed `ingest-recall-sources` carries
  per-outcome accounting that the worktree lacks.

## Contents

- `phase-16-19/`, `phase-16-20/`: runtime-debt candidates and patches. `candidate-a` and
  `candidate-b` are the deployed ingestion sources.
- `phase-16-34-gate-a1/`: pre-installation production bundles, the same after the first run,
  `post-install-state.sql` and `schema-catalog-fingerprint.sql` (read-only catalog fingerprint).
- `phase-16-34-gate-a2/`, `phase-16-34-gate-a3/`: bundles before and after each gated deploy.
- `phase-16-34-gate-c/` to `gate-f/`: the reviewed SQL and scripts run at each gate.

The bundle directories are byte-exact downloads and are excluded from Prettier and TypeScript. The
CLI's `supabase/.temp/` link metadata inside them is not committed, so the 16 `.temp` lines in each
gate A1/A2 `*.sha256` manifest have no matching file in a fresh clone; every other line verifies.
