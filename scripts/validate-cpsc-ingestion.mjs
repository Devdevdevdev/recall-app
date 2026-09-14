import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildCpscRecallUrl } from '../supabase/functions/_shared/cpsc/client.ts';
import { mapCpscRecall, sourceIdentifier } from '../supabase/functions/_shared/cpsc/mapper.ts';
import {
  dateOnlyFromSource,
  isCpscOfficialUrl,
  isJsonObject,
  parseCpscIngestionRequest,
  validateGtin,
} from '../supabase/functions/_shared/cpsc/validation.ts';

const fixturePath = new URL(
  '../supabase/functions/_shared/cpsc/fixtures/cpsc-real-records.json',
  import.meta.url,
);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.ok(Array.isArray(fixture));
assert.ok(fixture.every(isJsonObject));

const [peony, thule] = fixture;
assert.ok(peony && thule);

const mappedPeony = mapCpscRecall(peony);
assert.equal(mappedPeony.externalId, '10880');
assert.equal(mappedPeony.recallDate, '2026-07-23');
assert.match(mappedPeony.hazard ?? '', /snap can detach/u);
assert.match(mappedPeony.remedy ?? '', /Refund/u);
assert.equal(mappedPeony.scopes[0]?.productName, 'Personalized Baby Bibs and Stroller Bags');
assert.equal(
  mappedPeony.scopes[0]?.additionalCriteria?.manufacturer_names?.[0],
  'Peony Design Co., of Howell, MI',
);

const mappedThule = mapCpscRecall(thule);
assert.equal(mappedThule.scopes.length, 3);
assert.equal(mappedThule.scopes[1]?.gtin, '091021037090');
assert.equal(mappedThule.scopes[1]?.productName, null);
assert.equal(mappedThule.scopes[1]?.additionalCriteria?.evidence_level, 'recall');
assert.equal(mappedThule.scopes[1]?.additionalCriteria?.source_upc, undefined);
assert.equal(validateGtin('091021037090'), true);
assert.equal(validateGtin('091021037091'), false);

assert.equal(sourceIdentifier(peony), '10880');
assert.equal(sourceIdentifier(peony), mapCpscRecall(peony).externalId);
assert.equal(isCpscOfficialUrl(mappedPeony.officialUrl), true);
assert.equal(isCpscOfficialUrl('https://saferproducts.gov/RestWebServices/Recall'), false);
assert.throws(
  () => mapCpscRecall({ ...peony, URL: 'https://example.com/recall' }),
  /official URL/u,
);
assert.throws(() => mapCpscRecall({ ...peony, RecallID: null, RecallNumber: '' }), /RecallID/u);
assert.throws(() => mapCpscRecall({ ...peony, Title: '   ' }), /Title/u);
assert.equal(mapCpscRecall({ ...peony, Products: [] }).scopes.length, 0);

assert.equal(dateOnlyFromSource('2026-02-29T00:00:00'), null);
assert.equal(dateOnlyFromSource('2028-02-29T00:00:00'), '2028-02-29');
assert.deepEqual(parseCpscIngestionRequest({ startDate: '2026-09-01', endDate: '2026-09-14' }), {
  startDate: '2026-09-01',
  endDate: '2026-09-14',
  dryRun: true,
});
assert.throws(
  () => parseCpscIngestionRequest({ startDate: '2026-09-14', endDate: '2026-09-01' }),
  /after/u,
);
assert.throws(
  () => parseCpscIngestionRequest({ startDate: '2026-01-01', endDate: '2026-02-01' }),
  /maximum/u,
);

const url = buildCpscRecallUrl({ startDate: '2026-09-01', endDate: '2026-09-14', dryRun: true });
assert.equal(url.searchParams.get('format'), 'json');
assert.equal(url.searchParams.get('LastPublishDateStart'), '2026-09-01');
assert.equal(url.searchParams.get('LastPublishDateEnd'), '2026-09-14');

console.log('CPSC ingestion validation passed (28 assertions).');
