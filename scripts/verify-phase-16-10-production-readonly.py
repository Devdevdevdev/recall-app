#!/usr/bin/env python3
"""Read-only production state check through the configured Supabase pooler."""

import os
import subprocess
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

direct = urlsplit(os.environ["SUPABASE_DB_URL"])
pooler = urlsplit(Path("supabase/.temp/pooler-url").read_text().strip())
if not direct.password or not pooler.hostname or not pooler.username:
    raise SystemExit("Read-only database connection configuration is incomplete")
network_location = (
    f"{quote(pooler.username, safe='')}:{quote(direct.password, safe='')}"
    f"@{pooler.hostname}:{pooler.port or 5432}"
)
database_url = urlunsplit(("postgresql", network_location, direct.path, "", ""))
query = """
begin read only;
select
  (select count(*) from supabase_migrations.schema_migrations
    where version in ('20260924060002','20260924065448')) as new_migrations,
  (select count(*) from private.recall_scope_criteria_v2) as reviewed_bindings,
  (select count(*) from private.recall_match_evaluations_v2) as v2_evaluations,
  (select count(*) from private.recall_alert_eligibility_v2) as v2_eligibility,
  (select count(*) from private.recall_alert_snapshots_v2) as v2_snapshots,
  (select count(*) from private.recall_alert_corrections_v2) as v2_corrections;
commit;
"""
result = subprocess.run(
    ["psql", database_url, "-X", "-A", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", query],
    capture_output=True,
    text=True,
    timeout=20,
)
if result.returncode:
    # psql errors can echo a DSN. Show only a fixed status here.
    raise SystemExit("Read-only production query could not complete")
print(result.stdout)
