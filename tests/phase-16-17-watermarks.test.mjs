import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertForwardSourceWatermark,
  SourceWatermarkError,
} from '../supabase/functions/_shared/recallSources/validation.ts';
import { wrapRemoteSuite } from '../scripts/run-remote-pgtap.mjs';

const old = { kind: 'last_publish_date', value: '2026-09-27' };

test('source cursor permits bootstrap, same date, and forward date', () => {
  assert.doesNotThrow(() => assertForwardSourceWatermark(null, old.kind, '2026-09-27'));
  assert.doesNotThrow(() => assertForwardSourceWatermark(old, old.kind, '2026-09-27'));
  assert.doesNotThrow(() => assertForwardSourceWatermark(old, old.kind, '2026-09-28'));
});

test('source cursor rejects a stale manual window with a distinct outcome', () => {
  assert.throws(
    () => assertForwardSourceWatermark(old, old.kind, '2026-09-17'),
    (error) => error instanceof SourceWatermarkError && error.code === 'watermark_regression',
  );
});

test('source cursor fails closed for incompatible kinds and malformed dates', () => {
  for (const previous of [
    { kind: 'last_updated_date', value: '2026-09-27' },
    { kind: old.kind, value: '2026-02-30' },
    { kind: old.kind, value: '2026-09-27T00:00:00Z' },
    { ...old, extra: true },
    {},
  ]) {
    assert.throws(
      () => assertForwardSourceWatermark(previous, old.kind, '2026-09-28'),
      (error) => error instanceof SourceWatermarkError && error.code === 'watermark_invalid',
    );
  }
});

test('remote rehearsal embeds the exact migration body inside the rollback', () => {
  const wrapped = wrapRemoteSuite(
    'begin;\nselect extensions.plan(1);\nselect extensions.ok(true);\nselect * from extensions.finish();\nrollback;',
    '-- reviewed migration\nbegin;\ncreate function private.test_guard() returns integer language sql as $$ select 1 $$;\ncommit;',
  );
  assert.ok(wrapped.indexOf('create extension pgtap') < wrapped.indexOf('create function'));
  assert.ok(wrapped.indexOf('create function') < wrapped.indexOf('extensions.plan'));
  assert.match(wrapped, /rollback;\s*$/u);
  assert.doesNotMatch(wrapped, /commit;/u);
  assert.throws(() => wrapRemoteSuite('begin;\nrollback;', 'select 1;'), /must have its own BEGIN/);
});
