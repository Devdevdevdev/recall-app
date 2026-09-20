# Phase 15 — Recall Safety Benchmark 2.0

This directory is a separate, frozen benchmark generation. It does not replace or rewrite the v1 or Phase 9.1 benchmark artifacts.

The benchmark contains 200 controlled product-to-recall cases across 50 official CPSC recall families:

- development: 48 cases / 12 families
- holdout: 120 cases / 30 families
- stress: 32 cases / 8 families

Ground-truth labels come from explicit normalized scope rules in `sources.normalized.json`. `match` requires every condition in at least one authoritative scope rule. `no_match` requires a controlled contradiction against every rule. Cases that cannot be resolved from the supplied controlled evidence are `needs_review`.

Normal benchmark execution is offline and never accesses a live recall site.

## Commands

```sh
npm run test:phase-15
npm run benchmark:phase-15:validate
npm run benchmark:phase-15:freeze:verify
npm run benchmark:phase-15:deterministic
npm run benchmark:phase-15:plan
npm run benchmark:phase-15:report
```

`benchmark:phase-15:build` is a construction-only command. It requires the official CPSC Recall Retrieval API response at `/private/tmp/cpsc-recalls.json` (or an explicit path passed directly to `build-dataset.mjs`) and must not be used after holdout/stress freeze without creating a new benchmark generation.

Paid execution required explicit approval and used separate guarded commands. The original stop
checkpoint and stop report are preserved; the final guarded result records the separately approved
fail-closed continuation. No normal validation, freeze, or deterministic command invokes Nebius.

See `FINAL_REPORT.md` (also mirrored to `REPORT.md`) for the human-readable evaluation and
`final-report.json` (also mirrored to `report.json`) for the machine-readable summary.
