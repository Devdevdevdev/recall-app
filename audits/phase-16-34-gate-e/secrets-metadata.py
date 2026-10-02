#!/usr/bin/env python3
"""Phase 16.34 Gate E: hosted-secret METADATA check. Never prints a secret value or an individual digest.

Usage (user only; the agent's permission classifier blocks secret listing):
  npx supabase secrets list --project-ref cnftnulgtsraurtusnpb -o json | python3 audits/phase-16-34-gate-e/secrets-metadata.py

secret_set_fingerprint uses the same formula as the user's existing check
(sha256 of "\n".join(name + "\0" + digest) over items sorted by name), so at E0 it must
print 38aa0e25589c46b7a553cf9349b0f2cd76805e5b0f96689029fddaec4b024cb4.
others_fingerprint is the same formula over every secret EXCEPT RECALL_AUTOMATION_KEY.
recall_automation_key_marker is the first 16 hex characters of the same formula over
RECALL_AUTOMATION_KEY alone: it changes if and only if that secret's digest changes.
"""
import hashlib
import json
import sys

TARGET = "RECALL_AUTOMATION_KEY"


def fingerprint(items):
    return hashlib.sha256("\n".join(name + "\0" + digest for name, digest in items).encode()).hexdigest()


data = json.load(sys.stdin)
items = sorted((entry["name"], entry.get("value") or entry.get("digest") or "") for entry in data)
if any(not digest for _, digest in items):
    sys.exit("refusing: a secret has no digest in the listing")
if len({name for name, _ in items}) != len(items):
    sys.exit("refusing: duplicate secret names in the listing")

target = [item for item in items if item[0] == TARGET]
print("secret_count:", len(items))
print("secret_names:")
for name, _ in items:
    print(" -", name)
print("secret_set_fingerprint:", fingerprint(items))
print("others_fingerprint:", fingerprint([item for item in items if item[0] != TARGET]))
print("recall_automation_key_present:", len(target) == 1)
print("recall_automation_key_marker:", fingerprint(target)[:16] if target else "absent")
