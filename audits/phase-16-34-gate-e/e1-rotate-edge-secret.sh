#!/usr/bin/env bash
# Phase 16.34 Gate E — E1: rotate the hosted Edge secret RECALL_AUTOMATION_KEY ONLY (plan §17, Gate E step 1).
# The new value is generated in memory, validated (64 lowercase hex), passed to the CLI through a
# process-substitution pipe (never a file on disk), never printed, and unset afterwards.
# Difference from the plan's one-liner: the value is checked BEFORE use, so a failing `openssl`
# can never set an empty key. No other secret is touched; Vault is NOT touched (that is E2).
# Run once, by the user, from the repository root:  bash audits/phase-16-34-gate-e/e1-rotate-edge-secret.sh
set -euo pipefail
set +x
command -v openssl >/dev/null || { echo "E1 refused: openssl not found" >&2; exit 1; }
NEW_KEY="$(openssl rand -hex 32)"
[[ "$NEW_KEY" =~ ^[0-9a-f]{64}$ ]] || { unset NEW_KEY; echo "E1 refused: generated value is not 64 hex characters" >&2; exit 1; }
npx supabase secrets set --project-ref cnftnulgtsraurtusnpb --env-file <(printf 'RECALL_AUTOMATION_KEY=%s\n' "$NEW_KEY")
unset NEW_KEY
echo "E1: supabase secrets set returned 0 for RECALL_AUTOMATION_KEY (value not displayed)."
