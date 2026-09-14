import { mkdir, writeFile } from 'node:fs/promises';

const retrievedAt = '2026-09-14';
const official = (id, slug) => `https://www.cpsc.gov/Recalls/2026/${slug}`;
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
const recall = ({ id, slug, title, date, description, scopes, rawEvidence }) => ({
  recallNoticeId: `cpsc-${id}`,
  source: {
    authority: 'CPSC',
    externalId: String(id),
    officialUrl: official(id, slug),
    retrievedAt,
  },
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
  purchaseDate = null,
}) => ({
  productName,
  brand,
  category,
  gtin: null,
  modelNumber,
  serialNumber,
  lotNumber,
  purchaseDate,
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

const motorcycleModels = [
  'FE 350',
  'FE 501',
  'TE 150i',
  'TE 250i',
  'TE 300i',
  'TE 150',
  'TE 250',
  'TE 300',
  'TE 300 Heritage',
  'FX 350 Heritage',
  'FX 350',
  'FE 450',
  'FE 450 Heritage',
  'FX 450',
  'TX 300',
  'TX 300 Heritage',
  'FE 350w',
  'FE 501w',
  'EC 300',
  'EC 250',
  'EX 250',
  'EX 250F',
  'EX 300',
  'EX 350F',
  'EX 450F',
  'MC 125',
  'MC 250',
  'MC 250F',
  'MC 350F',
  'MC 450F',
  'EC 450F',
  'EW 500F',
];

const recalls = [
  recall({
    id: 10931,
    slug: 'KTM-North-America-Recalls-Off-Road-Motorcycles-Due-to-Risk-of-Serious-Injury-or-Death-from-Crash-Hazard',
    title:
      'KTM North America Recalls Off-Road Motorcycles Due to Risk of Serious Injury or Death from Crash Hazard',
    date: '2026-08-20',
    description:
      'CPSC lists specified 2021–2024 GASGAS and Husqvarna off-road motorcycle model/year combinations.',
    scopes: [{ productName: 'GASGAS and Husqvarna Off-Road Motorcycles' }],
    rawEvidence: {
      explicitCriteria: [
        rawCriterion(
          'modelNumber',
          'FE 350',
          'Husqvarna FE 350 Off-Road Motorcycle',
          'Husqvarna',
          'CPSC explicitly lists the 2022 FE 350.',
        ),
        rawCriterion(
          'modelNumber',
          'EC 300',
          'GASGAS EC 300 Off-Road Motorcycle',
          'GASGAS',
          'CPSC explicitly lists EC 300 for model years 2021 through 2024.',
        ),
      ],
      completeCriterionSets: [
        completeSet(
          'modelNumber',
          motorcycleModels,
          'GASGAS and Husqvarna Off-Road Motorcycles',
          null,
          'CPSC supplies the complete affected model table for this recall.',
        ),
      ],
    },
  }),
  recall({
    id: 10933,
    slug: 'Goal-Zero-Recalls-YETI-3000X-Power-Stations-Due-to-Serious-Risk-of-Injury-from-Fire-and-Burn-Hazards',
    title:
      'Goal Zero Recalls YETI 3000X Power Stations Due to Serious Risk of Injury from Fire and Burn Hazards',
    date: '2026-08-20',
    description: 'CPSC identifies Goal Zero YETI 3000X portable power stations.',
    scopes: [{ productName: 'Goal Zero YETI 3000X Portable Power Stations', brand: 'Goal Zero' }],
    rawEvidence: {
      explicitCriteria: [
        rawCriterion(
          'modelNumber',
          'YETI 3000X',
          'Goal Zero YETI 3000X Portable Power Station',
          'Goal Zero',
          'CPSC explicitly identifies YETI 3000X on the product nameplate.',
        ),
      ],
      completeCriterionSets: [
        completeSet(
          'modelNumber',
          ['YETI 3000X'],
          'Goal Zero YETI 3000X Portable Power Station',
          'Goal Zero',
          'The recall is limited to the YETI 3000X model.',
        ),
      ],
    },
  }),
  recall({
    id: 10935,
    slug: 'Koorlian-Mattresses-Recalled-Due-to-Risk-of-Serious-Injury-or-Death-from-Fire-Hazard-Violate-Mandatory-Standard-for-Mattress-Flammability-Sold-on-Amazon-by-Dream-Bedding-Technology',
    title: 'Koorlian Mattresses Recalled Due to Risk of Serious Injury or Death from Fire Hazard',
    date: '2026-08-20',
    description:
      'CPSC identifies 10-inch Twin XL Koorlian mattresses and a prototype ID, not a product model field.',
    scopes: [{ productName: 'Koorlian 10-inch Twin XL Mattresses', brand: 'Koorlian' }],
    rawEvidence: {
      unmodeledCriteria:
        'Prototype ID KY15Q290 and manufacture date appear on the sewn-in label; prototype ID is not normalized as a model number.',
    },
  }),
  recall({
    id: 10936,
    slug: 'Workbless-Pressure-Washers-Recalled-Due-to-Risk-of-Serious-Injury-or-Death-from-Shock-and-Electrocution-Hazards',
    title:
      'Workbless Pressure Washers Recalled Due to Risk of Serious Injury or Death from Shock and Electrocution Hazards',
    date: '2026-08-20',
    description:
      'CPSC explicitly identifies Workbless electric pressure washer models WB0301 and WB0302.',
    scopes: [{ productName: 'Workbless Electric Pressure Washers', brand: 'Workbless' }],
    rawEvidence: {
      explicitCriteria: [
        rawCriterion(
          'modelNumber',
          'WB0301',
          'Workbless Electric Pressure Washer',
          'Workbless',
          'CPSC explicitly identifies model WB0301.',
        ),
        rawCriterion(
          'modelNumber',
          'WB0302',
          'Workbless Electric Pressure Washer',
          'Workbless',
          'CPSC explicitly identifies model WB0302.',
        ),
      ],
      completeCriterionSets: [
        completeSet(
          'modelNumber',
          ['WB0301', 'WB0302'],
          'Workbless Electric Pressure Washer',
          'Workbless',
          'CPSC states that the recall involves models WB0301 and WB0302.',
        ),
      ],
    },
  }),
  recall({
    id: 10937,
    slug: 'CCM-Hockey-US-Recalls-FMHVR-Hybrid-Visors-and-ACCHVR-Replacement-Visor-Accessories-Due-to-Risk-of-Injury-from-Laceration-or-Impact-Hazards',
    title: 'CCM Hockey U.S. Recalls FMHVR Hybrid Visors and ACCHVR Replacement Visor Accessories',
    date: '2026-08-20',
    description:
      'CPSC associates serial prefixes M/L and S/M with FMHVR visors and SR with ACCHVR accessories.',
    scopes: [
      {
        productName: 'CCM FMHVR Hybrid Visors and ACCHVR Replacement Visor Accessories',
        brand: 'CCM',
      },
    ],
    rawEvidence: {
      explicitCriteria: [
        rawCriterion(
          'serialPrefix',
          'M/L',
          'CCM FMHVR Hybrid Visor',
          'CCM',
          'CPSC explicitly states that recalled FMHVR serial numbers begin with M/L.',
        ),
        rawCriterion(
          'serialPrefix',
          'S/M',
          'CCM FMHVR Hybrid Visor',
          'CCM',
          'CPSC explicitly states that recalled FMHVR serial numbers begin with S/M.',
        ),
      ],
      completeCriterionSets: [
        completeSet(
          'serialPrefix',
          ['M/L', 'S/M'],
          'CCM FMHVR Hybrid Visor',
          'CCM',
          'CPSC supplies the complete FMHVR serial-prefix list.',
        ),
      ],
    },
  }),
  recall({
    id: 10944,
    slug: 'Branch-Recalls-Ergonomic-Chairs-Due-to-Fall-Hazard',
    title: 'Branch Recalls Ergonomic Chairs Due to Fall Hazard',
    date: '2026-09-03',
    description:
      'CPSC limits affected Branch ergonomic chairs by incorrectly installed anchors and manufacture dates from 2025-09-10 through 2026-04-22.',
    scopes: [
      {
        productName: 'Branch Ergonomic Chairs',
        brand: 'Branch',
        manufacturedFrom: '2025-09-10',
        manufacturedTo: '2026-04-22',
      },
    ],
    rawEvidence: {
      unmodeledCriteria:
        'Incorrect backrest-anchor installation and manufacture date are mandatory recall criteria; purchase date cannot satisfy them.',
    },
  }),
  recall({
    id: 10949,
    slug: 'Adult-Portable-Bed-Rails-Recalled-Due-to-Risk-of-Serious-Injury-or-Death-from-Entrapment-and-Asphyxiation-Violate-Mandatory-Standard-for-Adult-Portable-Bed-Rails-Sold-on-Amazon-by-Loyoda-Direct-and-Loyoda',
    title: 'Loyoda Adult Portable Bed Rails Recalled Due to Entrapment and Asphyxiation Hazards',
    date: '2026-09-03',
    description:
      'CPSC identifies model FBL140202 but limits the recall to rails manufactured before 2025-12-15.',
    scopes: [
      {
        productName: 'Loyoda Adult Portable Bed Rails',
        brand: 'Loyoda',
        manufacturedTo: '2025-12-14',
      },
    ],
    rawEvidence: {
      completeCriterionSets: [
        completeSet(
          'modelNumber',
          ['FBL140202'],
          'Loyoda Adult Portable Bed Rail',
          'Loyoda',
          'CPSC identifies only model FBL140202; manufacture date is an additional mandatory condition.',
        ),
      ],
    },
  }),
  recall({
    id: 10955,
    slug: 'AudioLineOut-Recalls-Studio-Six-Headphone-Amplifiers-Due-to-Risk-of-Serious-Injury-or-Death-from-Electrocution-Hazard',
    title: 'AudioLineOut Recalls Studio Six Headphone Amplifiers Due to Electrocution Hazard',
    date: '2026-08-27',
    description: 'CPSC explicitly identifies Studio Six headphone amplifier model ST6.',
    scopes: [{ productName: 'Studio Six Headphone Amplifiers', brand: 'AudioLineOut' }],
    rawEvidence: {
      explicitCriteria: [
        rawCriterion(
          'modelNumber',
          'ST6',
          'Studio Six Headphone Amplifier',
          'AudioLineOut',
          'CPSC explicitly identifies model ST6.',
        ),
      ],
      completeCriterionSets: [
        completeSet(
          'modelNumber',
          ['ST6'],
          'Studio Six Headphone Amplifier',
          'AudioLineOut',
          'CPSC identifies only model ST6.',
        ),
      ],
    },
  }),
];

const cases = [
  benchmarkCase(
    'dev-10931-husqvarna-fe350-match',
    10931,
    product({
      productName: 'Husqvarna FE 350 Off-Road Motorcycle',
      brand: 'Husqvarna',
      category: 'Off-road motorcycle',
      modelNumber: 'FE 350',
    }),
    'match',
    'CPSC explicitly lists the associated Husqvarna FE 350 model.',
  ),
  benchmarkCase(
    'dev-10931-gasgas-ec300-match',
    10931,
    product({
      productName: 'GASGAS EC 300 Off-Road Motorcycle',
      brand: 'GASGAS',
      category: 'Off-road motorcycle',
      modelNumber: 'EC 300',
    }),
    'match',
    'CPSC explicitly lists the associated GASGAS EC 300 model.',
  ),
  benchmarkCase(
    'dev-10933-yeti3000x-match',
    10933,
    product({
      productName: 'Goal Zero YETI 3000X Portable Power Station',
      brand: 'Goal Zero',
      category: 'Portable power station',
      modelNumber: 'YETI 3000X',
    }),
    'match',
    'CPSC explicitly identifies the YETI 3000X model.',
  ),
  benchmarkCase(
    'dev-10936-wb0301-match',
    10936,
    product({
      productName: 'Workbless Electric Pressure Washer',
      brand: 'Workbless',
      category: 'Pressure washer',
      modelNumber: 'WB0301',
    }),
    'match',
    'CPSC explicitly identifies model WB0301.',
  ),
  benchmarkCase(
    'dev-10936-wb0302-match',
    10936,
    product({
      productName: 'Workbless Electric Pressure Washer',
      brand: 'Workbless',
      category: 'Pressure washer',
      modelNumber: 'WB0302',
    }),
    'match',
    'CPSC explicitly identifies model WB0302.',
  ),
  benchmarkCase(
    'dev-10937-ml-prefix-match',
    10937,
    product({
      productName: 'CCM FMHVR Hybrid Visor',
      brand: 'CCM',
      category: 'Hockey visor',
      serialNumber: 'M/L-28491',
    }),
    'match',
    'CPSC explicitly associates the M/L serial prefix with FMHVR visors.',
  ),
  benchmarkCase(
    'dev-10937-sm-prefix-match',
    10937,
    product({
      productName: 'CCM FMHVR Hybrid Visor',
      brand: 'CCM',
      category: 'Hockey visor',
      serialNumber: 'S/M-88420',
    }),
    'match',
    'CPSC explicitly associates the S/M serial prefix with FMHVR visors.',
  ),
  benchmarkCase(
    'dev-10955-st6-match',
    10955,
    product({
      productName: 'Studio Six Headphone Amplifier',
      brand: 'AudioLineOut',
      category: 'Audio amplifier',
      modelNumber: 'ST6',
    }),
    'match',
    'CPSC explicitly identifies model ST6.',
  ),

  benchmarkCase(
    'dev-10931-fc500-no-match',
    10931,
    product({
      productName: 'Husqvarna FC 500 Off-Road Motorcycle',
      brand: 'Husqvarna',
      category: 'Off-road motorcycle',
      modelNumber: 'FC 500',
    }),
    'no_match',
    'FC 500 is absent from the complete affected model table.',
  ),
  benchmarkCase(
    'dev-10931-fe250-no-match',
    10931,
    product({
      productName: 'Husqvarna FE 250 Off-Road Motorcycle',
      brand: 'Husqvarna',
      category: 'Off-road motorcycle',
      modelNumber: 'FE 250',
    }),
    'no_match',
    'FE 250 is absent from the complete affected model table.',
  ),
  benchmarkCase(
    'dev-10933-yeti1500x-no-match',
    10933,
    product({
      productName: 'Goal Zero YETI 1500X Portable Power Station',
      brand: 'Goal Zero',
      category: 'Portable power station',
      modelNumber: 'YETI 1500X',
    }),
    'no_match',
    'The recall is limited to YETI 3000X, not YETI 1500X.',
  ),
  benchmarkCase(
    'dev-10936-wb0303-no-match',
    10936,
    product({
      productName: 'Workbless Electric Pressure Washer',
      brand: 'Workbless',
      category: 'Pressure washer',
      modelNumber: 'WB0303',
    }),
    'no_match',
    'WB0303 is outside the complete WB0301/WB0302 model set.',
  ),
  benchmarkCase(
    'dev-10936-wb1301-no-match',
    10936,
    product({
      productName: 'Workbless Electric Pressure Washer',
      brand: 'Workbless',
      category: 'Pressure washer',
      modelNumber: 'WB1301',
    }),
    'no_match',
    'WB1301 is outside the complete WB0301/WB0302 model set.',
  ),
  benchmarkCase(
    'dev-10937-zz-prefix-no-match',
    10937,
    product({
      productName: 'CCM FMHVR Hybrid Visor',
      brand: 'CCM',
      category: 'Hockey visor',
      serialNumber: 'ZZ-28491',
    }),
    'no_match',
    'ZZ does not match either complete affected FMHVR serial prefix.',
  ),
  benchmarkCase(
    'dev-10949-wrong-model-no-match',
    10949,
    product({
      productName: 'Loyoda Adult Portable Bed Rail',
      brand: 'Loyoda',
      category: 'Adult bed rail',
      modelNumber: 'FBL140203',
    }),
    'no_match',
    'The supplied model contradicts the only model identified by CPSC.',
  ),
  benchmarkCase(
    'dev-10955-st7-no-match',
    10955,
    product({
      productName: 'Studio Six Headphone Amplifier',
      brand: 'AudioLineOut',
      category: 'Audio amplifier',
      modelNumber: 'ST7',
    }),
    'no_match',
    'The recall identifies ST6, not ST7.',
  ),

  benchmarkCase(
    'dev-10931-name-only-review',
    10931,
    product({
      productName: 'Husqvarna Off-Road Motorcycle',
      brand: 'Husqvarna',
      category: 'Off-road motorcycle',
    }),
    'needs_review',
    'Name and brand do not identify one of the many affected model/year combinations.',
  ),
  benchmarkCase(
    'dev-10933-name-only-review',
    10933,
    product({
      productName: 'Goal Zero YETI Power Station',
      brand: 'Goal Zero',
      category: 'Portable power station',
    }),
    'needs_review',
    'The YETI family name does not establish model 3000X.',
  ),
  benchmarkCase(
    'dev-10935-prototype-review',
    10935,
    product({
      productName: 'Koorlian Twin XL Mattress',
      brand: 'Koorlian',
      category: 'Mattress',
      modelNumber: 'KY15Q290',
    }),
    'needs_review',
    'CPSC calls KY15Q290 a prototype ID, which cannot be silently promoted to modelNumber.',
  ),
  benchmarkCase(
    'dev-10936-name-only-review',
    10936,
    product({
      productName: 'Workbless Electric Pressure Washer',
      brand: 'Workbless',
      category: 'Pressure washer',
    }),
    'needs_review',
    'Name and brand do not establish either affected model.',
  ),
  benchmarkCase(
    'dev-10937-name-only-review',
    10937,
    product({ productName: 'CCM FMHVR Hybrid Visor', brand: 'CCM', category: 'Hockey visor' }),
    'needs_review',
    'Product identity without an affected serial prefix remains ambiguous.',
  ),
  benchmarkCase(
    'dev-10944-purchase-date-review',
    10944,
    product({
      productName: 'Branch Ergonomic Chair',
      brand: 'Branch',
      category: 'Office chair',
      purchaseDate: '2026-01-12',
    }),
    'needs_review',
    'Purchase date cannot satisfy manufacture-date and anchor-installation criteria.',
  ),
  benchmarkCase(
    'dev-10949-purchase-date-review',
    10949,
    product({
      productName: 'Loyoda Adult Portable Bed Rail',
      brand: 'Loyoda',
      category: 'Adult bed rail',
      modelNumber: 'FBL140202',
      purchaseDate: '2025-11-01',
    }),
    'needs_review',
    'Matching model and purchase date do not prove the required manufacture date.',
  ),
  benchmarkCase(
    'dev-10955-name-only-review',
    10955,
    product({
      productName: 'Studio Six Headphone Amplifier',
      brand: 'AudioLineOut',
      category: 'Audio amplifier',
    }),
    'needs_review',
    'Name and brand alone do not prove model ST6.',
  ),
];

const dataset = {
  datasetVersion: '1',
  createdAt: retrievedAt,
  sourceRetrievalDate: retrievedAt,
  sourceAuthority: 'U.S. Consumer Product Safety Commission (CPSC)',
  recalls,
  cases,
};

const outputUrl = new URL('./development.v1.json', import.meta.url);
await mkdir(new URL('./', outputUrl), { recursive: true });
await writeFile(outputUrl, `${JSON.stringify(dataset, null, 2)}\n`, { flag: 'wx' });
console.log(
  `Created ${outputUrl.pathname} with ${cases.length} cases from ${recalls.length} recalls.`,
);
