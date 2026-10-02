#!/usr/bin/env python3
"""Phase 16.34 Gate F: hosted-secret METADATA check. Never prints a secret value or an individual digest.

Usage (user only; the agent's permission classifier blocks secret listing):
  npx supabase secrets list --project-ref cnftnulgtsraurtusnpb -o json \
    | python3 audits/phase-16-34-gate-f/secrets-metadata.py RECALL_AUTOMATION_KEY CPSC_PAGE_WORKER_KEY

secret_set_fingerprint uses the user's formula (sha256 of "\n".join(name + "\0" + digest) over
items sorted by name), identical to audits/phase-16-34-gate-e/secrets-metadata.py.
For every NAME given as an argument it prints whether it is present and
fingerprint_without_<NAME>: the same formula over every secret except NAME. After
`secrets unset NAME`, the new secret_set_fingerprint must equal the fingerprint_without_<NAME>
recorded just before: that proves only NAME was removed and no other secret changed.
fingerprint_without_all_targets does the same for unsetting every NAME given.
"""
import hashlib
import json
import sys


def fingerprint(items):
    return hashlib.sha256("\n".join(name + "\0" + digest for name, digest in items).encode()).hexdigest()


targets = sys.argv[1:]
if not targets:
    sys.exit("usage: secrets-metadata.py NAME [NAME...]")
data = json.load(sys.stdin)
items = sorted((entry["name"], entry.get("value") or entry.get("digest") or "") for entry in data)
if any(not digest for _, digest in items):
    sys.exit("refusing: a secret has no digest in the listing")
if len({name for name, _ in items}) != len(items):
    sys.exit("refusing: duplicate secret names in the listing")

names = {name for name, _ in items}
print("secret_count:", len(items))
print("secret_names:")
for name, _ in items:
    print(" -", name)
print("secret_set_fingerprint:", fingerprint(items))
for target in targets:
    print(f"{target}_present:", target in names)
    print(f"fingerprint_without_{target}:", fingerprint([item for item in items if item[0] != target]))
print("fingerprint_without_all_targets:", fingerprint([item for item in items if item[0] not in targets]))
