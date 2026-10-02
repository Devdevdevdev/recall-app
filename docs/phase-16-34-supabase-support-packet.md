# Support request: restrict PUBLIC privileges on `pg_net` objects

**Project ref:** `cnftnulgtsraurtusnpb` · **Postgres:** 17.6 · **pg_net:** 0.20.4 · **Evidence captured:** 2026-09-30 (read-only catalog queries)

## Request

We need an officially supported way to remove the PUBLIC privileges on the `net` schema objects below, so that only `postgres` (the owner of our `pg_cron` jobs) can enqueue, read or change `pg_net` requests and responses.

Specifically:

1. Revoke PUBLIC's table privileges on `net.http_request_queue` and `net._http_response`, and PUBLIC's sequence privileges on `net.http_request_queue_id_seq`.
2. Revoke PUBLIC's EXECUTE on `net.http_post`, `net.http_get`, `net.http_delete`, `net.worker_restart` and `net.wake`.
3. Keep these privileges for `postgres`. Please tell us which platform roles must also keep them.

If this can't be done for our project, please tell us:

- Whether dropping and recreating the extension (`create extension pg_net schema extensions;`) produces restricted grants on our image.
- Whether doing so is safe while a `pg_cron` job depends on `net.http_post`.
- Which Supabase-supported alternative you recommend for scheduled Edge Function invocation that does not pass request headers through a table readable by every database role.

## Evidence

**Ownership and ACLs.** Every object is owned by `supabase_admin` with no row-level security:

| Object                                                                               | Persistence | ACL                                                                                                                |
| ------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `net.http_request_queue`                                                             | unlogged    | `{supabase_admin=arwdDxtm/supabase_admin,=arwdDxtm/supabase_admin}`                                                |
| `net._http_response`                                                                 | unlogged    | `{supabase_admin=arwdDxtm/supabase_admin,=arwdDxtm/supabase_admin}`                                                |
| `net.http_request_queue_id_seq`                                                      | —           | `{supabase_admin=rwU/supabase_admin,=rwU/supabase_admin}`                                                          |
| `net.http_post`, `net.http_get`, `net.http_delete`, `net.worker_restart`, `net.wake` | —           | `NULL` (default PUBLIC EXECUTE)                                                                                    |
| schema `net`                                                                         | —           | `{supabase_admin=UC/…,=U/…,supabase_functions_admin=U/…,postgres=U/…,anon=U/…,authenticated=U/…,service_role=U/…}` |

Extension `pg_net` 0.20.4 is owned by `supabase_admin` and recorded in schema `public`. Settings: `pg_net.ttl = 6 hours`, `pg_net.batch_size = 200`, `pg_net.username = postgres`.

**Effective privileges** (`has_table_privilege` / `has_function_privilege`): `anon`, `authenticated`, `service_role`, and our dedicated login role `cpsc_page_worker` can all do the following:

- `SELECT`, `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` on `net.http_request_queue`
- `SELECT` and `DELETE` on `net._http_response`
- EXECUTE on `net.http_post`, `net.http_get`, `net.worker_restart` and `net.wake`

The same holds for every other role, including platform login roles.

**Why our project migrations cannot fix this.** The grants were made by `supabase_admin`, and our `postgres` role holds no grant option on these objects. Running `revoke all on net.http_request_queue from public` as `postgres` returns `WARNING: no privileges could be revoked for "http_request_queue"`, and the privileges remain. We reproduced this on the local Supabase image with the identical table ACL.

We have not dropped or recreated the extension, because:

- a production `pg_cron` job depends on it
- we could not verify the resulting grants beforehand

**Security implications:**

- **No Data API exposure.** We found none: `net` is not an exposed API schema, and no API-exposed function wraps `net.*`.
- **Queued request contents.** Any database login, such as a dedicated low-privilege worker role, can read queued request headers and bodies during the short interval before the `pg_net` worker sends them.
- **Tampering and disruption.** Any database login can also:
  - redirect or change queued requests
  - delete queued requests (suppressing scheduled invocations)
  - read responses kept for 6 h
  - restart the `pg_net` worker
  - make arbitrary outbound HTTP requests from the database

**Our interim mitigation.** We are removing long-lived credentials from queued requests. Each scheduled request will carry a random single-use ticket that expires in 120 s and is stored only as a hash. This does not address request integrity, deletion, worker restarts or outbound HTTP from the database, which is why we need the privilege change.

No secret values, request headers or request bodies were read or included in this packet.
