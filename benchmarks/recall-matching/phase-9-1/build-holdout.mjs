import { mkdir, writeFile } from 'node:fs/promises';

const retrievedAt = '2026-09-14';
const official = (slug) => `https://www.cpsc.gov/Recalls/2026/${slug}`;
const rawCriterion = (criterion, value, productName, brand, context) => ({
  criterion,
  value,
  productName,
  ...(brand ? { brand } : {}),
  context,
});
const completeSet = (criterion, values, productName, brand, context) => ({
  criterion,
  values,
  productName,
  ...(brand ? { brand } : {}),
  context,
});
const recall = ({ id, slug, title, date, description, scopes, rawEvidence = {} }) => ({
  recallNoticeId: `cpsc-${id}`,
  source: { authority: 'CPSC', externalId: String(id), officialUrl: official(slug), retrievedAt },
  title,
  description,
  hazard: null,
  remedy: null,
  recallDate: date,
  scopes,
  rawEvidence: { cpscRecallId: String(id), officialDescription: description, ...rawEvidence },
});
const product = ({
  productName,
  brand,
  category,
  modelNumber = null,
  serialNumber = null,
  lotNumber = null,
}) => ({
  productName,
  brand,
  category,
  gtin: null,
  modelNumber,
  serialNumber,
  lotNumber,
  purchaseDate: null,
  identificationMethod: 'controlled_public_fixture',
});
const benchmarkCase = (caseId, officialRecallExternalId, ownedProduct, expected, reason) => ({
  caseId,
  officialRecallExternalId: String(officialRecallExternalId),
  ownedProduct,
  expected,
  labelProvenance: {
    match: 'official_exact_evidence',
    no_match: 'controlled_counterfactual',
    needs_review: 'source_ambiguity',
  }[expected],
  reason,
  notes: 'Synthetic owned-product evidence; public authoritative recall evidence only.',
});

const recalls = [
  recall({
    id: 10917,
    slug: 'TooyBing-Wooden-Bead-Stacking-Toys-Recalled-Due-to-Risk-of-Serious-Injury-or-Death-from-Choking-Violate-Small-Parts-Ban',
    title: 'TooyBing Wooden Bead Stacking Toys Recalled Due to Choking Hazard',
    date: '2026-08-13',
    description: 'CPSC identifies the TooyBing Wooden Bead Stacking Toy as model TB-MZWJ.',
    scopes: [
      {
        productName: 'TooyBing Wooden Bead Stacking Toy',
        brand: 'TooyBing',
        modelNumber: 'TB-MZWJ',
      },
    ],
  }),
  recall({
    id: 10920,
    slug: 'COMMOWNER-Pressure-Washers-Recalled-Due-to-Serious-Risk-of-Injury-or-Death-from-Shock-and-Electrocution-Hazards-Imported-by-AZ-Home-Concept',
    title: 'COMMOWNER Pressure Washers Recalled Due to Shock and Electrocution Hazards',
    date: '2026-08-13',
    description:
      'CPSC identifies COMMOWNER pressure washer model HD14P-Z, also listed at purchase as HX18.',
    scopes: [
      {
        productName: 'COMMOWNER Electric Pressure Washer',
        brand: 'COMMOWNER',
        modelNumber: 'HD14P-Z',
      },
      {
        productName: 'COMMOWNER Electric Pressure Washer',
        brand: 'COMMOWNER',
        modelNumber: 'HX18',
      },
    ],
  }),
  recall({
    id: 10921,
    slug: 'Yamazuki-Recalls-Youth-All-Terrain-Vehicles-ATVs-Due-to-Risk-of-Serious-Injury-or-Death-from-Crash-Hazard-Violates-Mandatory-Standard-for-ATVs',
    title: 'Yamazuki Recalls Youth All-Terrain Vehicles Due to Crash Hazard',
    date: '2026-08-13',
    description: 'CPSC identifies QEASET- or HOVERHEART-branded youth ATV model XW-A19.',
    scopes: [{ productName: 'Yamazuki Youth All-Terrain Vehicle', modelNumber: 'XW-A19' }],
  }),
  recall({
    id: 10922,
    slug: 'GigaCloud-Technology-USA-Recalls-Merax-Murphy-Beds-Due-to-Risk-of-Serious-Injury-or-Death-from-Impact-and-Crush-Hazards',
    title: 'GigaCloud Technology USA Recalls Merax Murphy Beds Due to Impact and Crush Hazards',
    date: '2026-08-13',
    description:
      'CPSC lists Murphy bed models GX000392AAK, GX000391AAK, and GX000383AAK with associated SKU groups.',
    scopes: [{ productName: 'Merax Murphy Beds' }],
    rawEvidence: {
      explicitCriteria: [
        rawCriterion(
          'modelNumber',
          'GX000392AAK',
          'Merax Full-Size Murphy Bed',
          null,
          'CPSC explicitly associates model GX000392AAK with the full-size Murphy bed and its SKU group.',
        ),
      ],
      completeCriterionSets: [
        completeSet(
          'modelNumber',
          ['GX000392AAK', 'GX000391AAK', 'GX000383AAK'],
          'Merax Murphy Bed',
          null,
          'CPSC supplies the complete affected model-number table.',
        ),
      ],
    },
  }),
  recall({
    id: 10926,
    slug: 'CuberShop-Magnetic-Speed-Cubes-Recalled-Due-to-Risk-of-Serious-Injury-or-Death-from-Magnet-Ingestion-Violate-Mandatory-Standard-for-Toys-Imported-by-SKY-CUBE-HK',
    title: 'CuberShop Magnetic Speed Cubes Recalled Due to Magnet Ingestion Hazard',
    date: '2026-08-13',
    description: 'CPSC identifies CuberShop Magnetic Stickerless Speed Cube model YJ MGC 5×5.',
    scopes: [
      {
        productName: 'CuberShop Magnetic Stickerless Speed Cube',
        brand: 'CuberShop',
        modelNumber: 'YJ MGC 5×5',
      },
    ],
  }),
  recall({
    id: 10929,
    slug: 'Sunnyside-Corporation-Recalls-1-K-Kerosene-Heater-and-Appliance-Fuel-Containers-Due-to-Risk-of-Serious-Injury-or-Death-from-Flash-Fire-and-Burn-Hazard-Violates-Mandatory-Standards-for-Portable-Fuel-Containers',
    title: 'Sunnyside Recalls 1-K Kerosene Heater and Appliance Fuel Containers',
    date: '2026-08-13',
    description:
      'CPSC limits the recalled Sunnyside gallon 1-K kerosene containers to batch number 26082.',
    scopes: [
      {
        productName: 'Sunnyside 1-K Kerosene Heater and Appliance Fuel Container',
        brand: 'Sunnyside',
      },
    ],
    rawEvidence: {
      explicitCriteria: [
        rawCriterion(
          'lotNumber',
          '26082',
          'Sunnyside 1-K Kerosene Heater and Appliance Fuel Container',
          'Sunnyside',
          'CPSC explicitly identifies batch number 26082.',
        ),
      ],
      completeCriterionSets: [
        completeSet(
          'lotNumber',
          ['26082'],
          'Sunnyside 1-K Kerosene Heater and Appliance Fuel Container',
          'Sunnyside',
          'CPSC identifies one affected batch number: 26082.',
        ),
      ],
    },
  }),
  recall({
    id: 10939,
    slug: 'Truststone-Group-Recalls-XO-Poppy-Power-Trip-Magnetic-Wireless-Power-Banks-Due-to-Fire-and-Burn-Hazards-Sold-Exclusively-at-TJX-and-Marshalls-Stores',
    title: 'Truststone Group Recalls XO Poppy Power Trip Magnetic Wireless Power Banks',
    date: '2026-09-03',
    description: 'CPSC identifies three packaging model numbers for XO Poppy PYPBK5M power banks.',
    scopes: [
      { productName: 'XO Poppy Power Trip Magnetic Wireless Power Bank', brand: 'XO Poppy' },
    ],
    rawEvidence: {
      explicitCriteria: [
        rawCriterion(
          'modelNumber',
          'PY-PBK5M-CR2',
          'XO Poppy Power Trip Magnetic Wireless Power Bank',
          'XO Poppy',
          'CPSC explicitly associates PY-PBK5M-CR2 with the cream-colored affected power bank.',
        ),
      ],
      completeCriterionSets: [
        completeSet(
          'modelNumber',
          ['PY-PBK5M-CR2', 'PY-PBK5M-BW8', 'PY-PBK5M-TB2'],
          'XO Poppy Power Trip Magnetic Wireless Power Bank',
          'XO Poppy',
          'CPSC supplies the three specific affected packaging model numbers.',
        ),
      ],
    },
  }),
  recall({
    id: 10941,
    slug: 'Nanjing-Wu-Hai-Smart-Home-Appliance-Store-Recalls-Alanca-6-Drawer-Dressers-Due-to-Risk-of-Serious-Injury-or-Death-from-Tip-Over-and-Entrapment-Hazards-Violate-Mandatory-Standard-for-Clothing-Storage-Units',
    title: 'Alanca 6-Drawer Dressers Recalled Due to Tip-Over and Entrapment Hazards',
    date: '2026-09-03',
    description: 'CPSC identifies Alanca dresser models WH-DS02-6W and WH-DS02-6GE.',
    scopes: [
      { productName: 'Alanca 6-Drawer Wood Dresser', brand: 'Alanca', modelNumber: 'WH-DS02-6W' },
      { productName: 'Alanca 6-Drawer Wood Dresser', brand: 'Alanca', modelNumber: 'WH-DS02-6GE' },
    ],
  }),
  recall({
    id: 10942,
    slug: 'Gizoon-Direct-Recalls-Six-Drawer-Double-Dressers-Due-to-Risk-of-Serious-Injury-or-Death-from-Tip-Over-and-Entrapment-Hazards-Violates-Mandatory-Standard-for-Clothing-Storage-Units',
    title: 'Gizoon Six-Drawer Double Dressers Recalled Due to Tip-Over and Entrapment Hazards',
    date: '2026-09-03',
    description: 'CPSC identifies Gizoon dresser models AP47-W and AP47-B.',
    scopes: [
      { productName: 'Gizoon Six-Drawer Double Dresser', brand: 'Gizoon', modelNumber: 'AP47-W' },
      { productName: 'Gizoon Six-Drawer Double Dresser', brand: 'Gizoon', modelNumber: 'AP47-B' },
    ],
  }),
  recall({
    id: 10943,
    slug: 'Skip-Hop-Recalls-Baby-Sesame-Street-Elmo-Silicone-Teethers-Due-to-Risk-of-Serious-Injury-or-Death-from-Choking-Hazard',
    title: 'Skip Hop Recalls Baby Sesame Street Elmo Silicone Teethers Due to Choking Hazard',
    date: '2026-09-03',
    description:
      'CPSC identifies the Skip Hop Baby Sesame Street Elmo Silicone Teether as model 9R263210.',
    scopes: [
      {
        productName: 'Skip Hop Baby Sesame Street Elmo Silicone Teether',
        brand: 'Skip Hop',
        modelNumber: '9R263210',
      },
    ],
  }),
  recall({
    id: 10950,
    slug: 'OKK-Trading-Recalls-Rainbow-Mystery-Squishy-Bun-Toys-Due-to-Risk-of-Serious-Injury-or-Death-from-Water-Bead-Ingestion-Violate-Mandatory-Standard-for-Toys',
    title: 'OKK Trading Recalls Rainbow Mystery Squishy Bun Toys',
    date: '2026-09-03',
    description: 'CPSC identifies Rainbow Mystery Squishy Bun Toys as model D08004.',
    scopes: [{ productName: 'Rainbow Mystery Squishy Bun Toy', modelNumber: 'D08004' }],
  }),
  recall({
    id: 10956,
    slug: 'Steelite-Pressure-Washers-Recalled-Due-to-Risk-of-Serious-Injury-or-Death-from-Shock-and-Electrocution-Hazards-Sold-on-Amazon-by-Longer-3D',
    title: 'Steelite Pressure Washers Recalled Due to Shock and Electrocution Hazards',
    date: '2026-08-27',
    description: 'CPSC explicitly identifies Steelite electric pressure washer model AZ6041VC.',
    scopes: [{ productName: 'Steelite Electric Pressure Washer', brand: 'Steelite' }],
    rawEvidence: {
      explicitCriteria: [
        rawCriterion(
          'modelNumber',
          'AZ6041VC',
          'Steelite Electric Pressure Washer',
          'Steelite',
          'CPSC explicitly identifies model AZ6041VC on the rear product label.',
        ),
      ],
      completeCriterionSets: [
        completeSet(
          'modelNumber',
          ['AZ6041VC'],
          'Steelite Electric Pressure Washer',
          'Steelite',
          'CPSC identifies only model AZ6041VC.',
        ),
      ],
    },
  }),
];

const examples = [
  [10917, 'tooybing', 'TooyBing Wooden Bead Stacking Toy', 'TooyBing', 'Toy', 'TB-MZWJ', 'TB-MZWK'],
  [
    10920,
    'commowner',
    'COMMOWNER Electric Pressure Washer',
    'COMMOWNER',
    'Pressure washer',
    'HD14P-Z',
    'HD14P-Y',
  ],
  [
    10921,
    'yamazuki',
    'Yamazuki Youth All-Terrain Vehicle',
    'QEASET',
    'Youth ATV',
    'XW-A19',
    'XW-A20',
  ],
  [
    10922,
    'merax',
    'Merax Full-Size Murphy Bed',
    'Merax',
    'Murphy bed',
    'GX000392AAK',
    'GX000399AAK',
  ],
  [
    10926,
    'cubershop',
    'CuberShop Magnetic Stickerless Speed Cube',
    'CuberShop',
    'Puzzle cube',
    'YJ MGC 5×5',
    'YJ MGC 4×4',
  ],
  [
    10929,
    'sunnyside',
    'Sunnyside 1-K Kerosene Heater and Appliance Fuel Container',
    'Sunnyside',
    'Fuel container',
    null,
    null,
    '26082',
    '26083',
  ],
  [
    10939,
    'xo-poppy',
    'XO Poppy Power Trip Magnetic Wireless Power Bank',
    'XO Poppy',
    'Power bank',
    'PY-PBK5M-CR2',
    'PY-PBK5M-CR3',
  ],
  [
    10941,
    'alanca',
    'Alanca 6-Drawer Wood Dresser',
    'Alanca',
    'Dresser',
    'WH-DS02-6W',
    'WH-DS02-6BK',
  ],
  [10942, 'gizoon', 'Gizoon Six-Drawer Double Dresser', 'Gizoon', 'Dresser', 'AP47-B', 'AP48-B'],
  [
    10943,
    'skip-hop',
    'Skip Hop Baby Sesame Street Elmo Silicone Teether',
    'Skip Hop',
    'Teether',
    '9R263210',
    '9R263211',
  ],
  [10950, 'squishy-bun', 'Rainbow Mystery Squishy Bun Toy', null, 'Toy', 'D08004', 'D08005'],
  [
    10956,
    'steelite',
    'Steelite Electric Pressure Washer',
    'Steelite',
    'Pressure washer',
    'AZ6041VC',
    'AZ6041VD',
  ],
];

const cases = examples.flatMap(
  ([
    id,
    slug,
    productName,
    brand,
    category,
    exactModel,
    wrongModel,
    exactLot = null,
    wrongLot = null,
  ]) => [
    benchmarkCase(
      `holdout-${id}-${slug}-match`,
      id,
      product({ productName, brand, category, modelNumber: exactModel, lotNumber: exactLot }),
      'match',
      exactLot
        ? `CPSC explicitly identifies batch ${exactLot}.`
        : `CPSC explicitly identifies model ${exactModel}.`,
    ),
    benchmarkCase(
      `holdout-${id}-${slug}-no-match`,
      id,
      product({ productName, brand, category, modelNumber: wrongModel, lotNumber: wrongLot }),
      'no_match',
      wrongLot
        ? `${wrongLot} explicitly differs from the complete affected batch set.`
        : `${wrongModel} explicitly differs from the complete affected model set.`,
    ),
    benchmarkCase(
      `holdout-${id}-${slug}-needs-review`,
      id,
      product({ productName, brand, category }),
      'needs_review',
      'Product identity alone does not establish the exact affected model or batch.',
    ),
  ],
);

const dataset = {
  datasetVersion: '1',
  createdAt: retrievedAt,
  sourceRetrievalDate: retrievedAt,
  sourceAuthority: 'U.S. Consumer Product Safety Commission (CPSC)',
  recalls,
  cases,
};

const outputUrl = new URL('./holdout.v1.json', import.meta.url);
await mkdir(new URL('./', outputUrl), { recursive: true });
await writeFile(outputUrl, `${JSON.stringify(dataset, null, 2)}\n`, { flag: 'wx' });
console.log(
  `Created ${outputUrl.pathname} with ${cases.length} cases from ${recalls.length} recalls.`,
);
