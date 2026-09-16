import assert from 'node:assert/strict';
import test from 'node:test';

import { toRecallAlert } from '../src/data/alertsMappers.ts';
import {
  getAlertMatchPresentation,
  toOfficialRecallUrl,
} from '../src/features/alerts/alertPresentation.ts';

const confirmedRow = {
  id: '10000000-0000-4000-8000-000000000001',
  user_id: '10000000-0000-4000-8000-000000000002',
  recall_match_id: '10000000-0000-4000-8000-000000000003',
  status: 'unread',
  created_at: '2026-09-14T10:00:00.000Z',
  read_at: null,
  dismissed_at: null,
  recall_match: {
    id: '10000000-0000-4000-8000-000000000003',
    status: 'confirmed',
    confidence: '0.9850',
    match_method: 'deterministic_v1',
    reasoning_summary: 'The product GTIN exactly matches the official recall scope.',
    evaluated_at: '2026-09-14T09:59:00.000Z',
    owned_product: {
      id: '10000000-0000-4000-8000-000000000004',
      brand: 'Thule',
      product_name: 'Sleek stroller',
      gtin: '091021037090',
      model_number: '11000001',
      serial_number: null,
      lot_number: null,
    },
    recall_notice: {
      id: '10000000-0000-4000-8000-000000000005',
      title: 'Thule Sleek Strollers Recalled',
      hazard: 'The handlebar can detach.',
      remedy: 'Stop use and contact Thule.',
      recall_date: '2024-05-30',
      official_url: 'https://www.cpsc.gov/Recalls/2024/example',
      recall_source: {
        name: 'U.S. Consumer Product Safety Commission (CPSC)',
        source_language_code: 'en',
      },
      jurisdictions: [{ jurisdiction_type: 'country', jurisdiction_code: 'US' }],
    },
  },
};

test('maps an alert and its consumer-safe joined recall data', () => {
  assert.deepEqual(toRecallAlert(confirmedRow), {
    id: confirmedRow.id,
    userId: confirmedRow.user_id,
    recallMatchId: confirmedRow.recall_match_id,
    status: 'unread',
    createdAt: confirmedRow.created_at,
    readAt: null,
    dismissedAt: null,
    match: {
      id: confirmedRow.recall_match.id,
      status: 'confirmed',
      confidence: 0.985,
      method: 'deterministic_v1',
      reasoningSummary: confirmedRow.recall_match.reasoning_summary,
      evaluatedAt: confirmedRow.recall_match.evaluated_at,
    },
    product: {
      id: confirmedRow.recall_match.owned_product.id,
      brand: 'Thule',
      productName: 'Sleek stroller',
      gtin: '091021037090',
      modelNumber: '11000001',
      serialNumber: null,
      lotNumber: null,
    },
    notice: {
      id: confirmedRow.recall_match.recall_notice.id,
      authority: 'U.S. Consumer Product Safety Commission (CPSC)',
      title: 'Thule Sleek Strollers Recalled',
      hazard: 'The handlebar can detach.',
      remedy: 'Stop use and contact Thule.',
      recallDate: '2024-05-30',
      officialUrl: 'https://www.cpsc.gov/Recalls/2024/example',
      sourceLanguageCode: 'en',
      jurisdictions: [{ type: 'country', code: 'US' }],
    },
  });
});

test('accepts PostgREST relation arrays and preserves a reversed alert', () => {
  const reversedRow = {
    ...confirmedRow,
    recall_match: [{ ...confirmedRow.recall_match, status: 'needs_review' }],
  };

  const alert = toRecallAlert(reversedRow);

  assert.equal(alert.match.status, 'needs_review');
  assert.equal(alert.status, 'unread');
});

test('rejects a row without its required alert relationships', () => {
  assert.throws(
    () => toRecallAlert({ ...confirmedRow, recall_match: null }),
    /recall match relationship/i,
  );
});

test('labels preserved alerts as changed when their current match is no longer confirmed', () => {
  assert.deepEqual(getAlertMatchPresentation('confirmed'), {
    isConfirmed: true,
    listLabel: 'RECALL ALERT',
    statusLabel: 'Confirmed match',
  });
  assert.deepEqual(getAlertMatchPresentation('needs_review'), {
    isConfirmed: false,
    listLabel: 'EVALUATION CHANGED',
    statusLabel: 'Currently unconfirmed — evaluation changed',
  });
  assert.equal(getAlertMatchPresentation('rejected').isConfirmed, false);
  assert.equal(getAlertMatchPresentation('candidate').isConfirmed, false);
});

test('only permits HTTP(S) authoritative recall links', () => {
  assert.equal(
    toOfficialRecallUrl('https://www.cpsc.gov/Recalls/2024/example'),
    'https://www.cpsc.gov/Recalls/2024/example',
  );
  assert.equal(toOfficialRecallUrl('javascript:alert(1)'), null);
  assert.equal(toOfficialRecallUrl('not a URL'), null);
});
