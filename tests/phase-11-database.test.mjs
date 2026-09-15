import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(
  new URL('../supabase/migrations/20260915100000_phase_11_push_notifications.sql', import.meta.url),
  'utf8',
);
const targetedQueueMigration = await readFile(
  new URL(
    '../supabase/migrations/20260915103000_phase_11_targeted_push_queue.sql',
    import.meta.url,
  ),
  'utf8',
);

test('push token and delivery storage is private with RLS and explicit revokes', () => {
  for (const table of ['push_devices', 'push_alert_queue', 'push_deliveries']) {
    assert.match(migration, new RegExp(`create table private\\.${table}`));
    assert.match(migration, new RegExp(`alter table private\\.${table} enable row level security`));
    assert.match(
      migration,
      new RegExp(
        `revoke all on table private\\.${table} from public, anon, authenticated, service_role`,
      ),
    );
  }
  assert.match(migration, /enabled_at timestamptz not null default now\(\)/i);
});

test('devices enabled after an alert was queued cannot receive that older alert', () => {
  assert.match(migration, /push_device\.enabled_at <= push_queue\.queued_at/i);
});

test('authenticated clients use narrow owner-derived registration RPCs', () => {
  assert.match(migration, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(
    migration,
    /grant execute on function public\.register_push_device\(text, text\) to authenticated/,
  );
  assert.match(
    migration,
    /grant execute on function public\.unregister_push_device\(text\) to authenticated/,
  );
  assert.doesNotMatch(
    migration,
    /grant (?:select|insert|update|delete).*push_devices.*authenticated/i,
  );
});

test('one token is unique and registration atomically reassigns account ownership', () => {
  assert.match(migration, /expo_push_token text not null unique/);
  assert.match(migration, /on conflict \(expo_push_token\) do nothing/);
  assert.match(migration, /set\s+user_id = v_user_id,[\s\S]*enabled = true/);
  assert.match(migration, /account_reassigned/);
});

test('delivery is unique by alert and device and retries are capped at three', () => {
  assert.match(migration, /unique \(alert_id, push_device_id\)/);
  assert.match(migration, /on conflict on constraint push_deliveries_alert_device_key do nothing/);
  assert.match(migration, /attempt_count < 3/);
  assert.match(migration, /case when v_attempt_count < 3 then 'pending' else 'failed' end/);
});

test('historical alerts are not backfilled by the migration', () => {
  assert.match(
    migration,
    /create trigger alerts_enqueue_confirmed_push\s+after insert on public\.alerts/,
  );
  assert.doesNotMatch(migration, /insert into private\.push_alert_queue \(alert_id\)\s+select/i);
});

test('only currently confirmed matches can create or claim deliveries', () => {
  const confirmedChecks = migration.match(/recall_match\.status = 'confirmed'/g) ?? [];
  assert.ok(confirmedChecks.length >= 2);
});

test('delivery and receipt RPCs are service-role-only', () => {
  for (const name of [
    'claim_recall_push_deliveries',
    'record_recall_push_ticket',
    'claim_recall_push_receipts',
    'record_recall_push_receipt',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}`));
  }
});

test('historical replay requires a bounded service-role-only targeted RPC', () => {
  assert.match(targetedQueueMigration, /cardinality\(p_alert_ids\) > 50/);
  assert.match(targetedQueueMigration, /recall_match\.status = 'confirmed'/);
  assert.match(
    targetedQueueMigration,
    /revoke all on function public\.queue_recall_push_alerts\(uuid\[\]\)[\s\S]*authenticated/,
  );
  assert.match(
    targetedQueueMigration,
    /grant execute on function public\.queue_recall_push_alerts\(uuid\[\]\)[\s\S]*service_role/,
  );
});
