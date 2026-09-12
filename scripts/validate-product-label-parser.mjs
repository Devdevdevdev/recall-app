import assert from 'node:assert/strict';

import { parseProductLabel } from '../src/domain/productLabel.ts';

const positiveCases = [
  ['MODEL: HD9252/90', { modelNumber: 'HD9252/90' }],
  ['Model No. ABC-1234', { modelNumber: 'ABC-1234' }],
  ['MODÈLE XY-55', { modelNumber: 'XY-55' }],
  ['S/N: 0012345678', { serialNumber: '0012345678' }],
  ['Serial Number SN-A94-882', { serialNumber: 'SN-A94-882' }],
  ['N° Série : FR001992', { serialNumber: 'FR001992' }],
  ['LOT: 24A17', { lotNumber: '24A17' }],
  ['Batch No B-2026-09', { lotNumber: 'B-2026-09' }],
  ['REFERENCE: REF-009/2', { referenceNumber: 'REF-009/2' }],
];

for (const [sample, expected] of positiveCases) {
  assert.deepEqual(parseProductLabel(sample), expected, sample);
}

const noise = ['220-240V', '50/60Hz', '1500W', 'Made in China', 'CE', '123456789'].join('\n');
assert.deepEqual(parseProductLabel(noise), {});
assert.deepEqual(parseProductLabel('MODEL: 220-240V\nSERIAL: CE'), {});

console.log(`Product-label parser validation passed (${positiveCases.length + 2} cases).`);
