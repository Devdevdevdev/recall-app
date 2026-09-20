import { mkdir, readFile, writeFile } from 'node:fs/promises';

const apiPath = process.argv[2] ?? '/private/tmp/cpsc-recalls.json';
const apiRecalls = JSON.parse(await readFile(apiPath, 'utf8'));
const apiById = new Map(apiRecalls.map((recall) => [String(recall.RecallID), recall]));
const outputDirectory = new URL('./', import.meta.url);
const referenceDate = '2026-09-20';

const gtinFamilies = [
  ['10889', ['805253435117'], 'World Class Fireworks'],
  ['10729', ['885490244963'], "Lil' Buddies"],
  ['10695', ['860007168901', '860007168994', '860010126417'], null],
  ['10585', ['850022858529', '850022858536'], null],
  ['10532', ['860006498115'], 'Mamisan'],
  ['10468', ['196633883742'], 'Kirkland Signature'],
  ['10421', ['070257522266'], 'Scripto'],
  ['10406', ['628078800836'], 'Arizer'],
  ['10403', ['1922343012788', '1922346316838'], null],
  ['10381', ['051751143171', '051751143188'], 'Werner'],
  ['10220', ['089301008588'], 'DEWALT'],
  ['10221', ['1922340368444'], 'Room2Room'],
  ['10213', ['884920250697', '884920365797', '884920365834'], 'Cra-Z-Art'],
  ['10207', ['062338727240'], 'Woolite'],
  ['10191', ['849398065631', '849398065648', '849398065655'], 'Auto World'],
  ['10144', ['698904871507'], 'Pearhead'],
  ['10080', ['196710005616', '196710008709'], 'Dreamgro'],
  ['10077', ['193175443663'], 'Bauer'],
  ['10043', ['799403302902'], null],
  ['10040', ['840056145528', '840056145535', '840056145542'], 'HALO'],
  ['9965', ['854460001073'], 'FURminator'],
  ['9961', ['885911843430'], 'CRAFTSMAN'],
  ['9959', ['850039376139'], 'ADIOS!'],
  ['9909', ['626192021991'], 'Excalibur'],
  ['9910', ['050875828407', '050875828391', '050875828384'], 'BLACK+DECKER'],
  ['9851', ['047362324665', '099143020020', '099143020044'], 'Char-Broil'],
];

const criterion = (field, operator, options) => ({ field, operator, ...options });
const product = (overrides = {}) => ({
  productName: null,
  brand: null,
  category: 'consumer_product',
  gtin: null,
  modelNumber: null,
  serialNumber: null,
  lotNumber: null,
  purchaseDate: null,
  identificationMethod: 'controlled_benchmark_fixture',
  ...overrides,
});

function validSiblingGtin(gtin, step = 1) {
  const digits = [...gtin].map(Number);
  const body = digits.slice(0, -1);
  const index = Math.max(0, body.length - 2);
  body[index] = (body[index] + step) % 10;
  const sum = [...body]
    .reverse()
    .reduce((total, digit, bodyIndex) => total + digit * (bodyIndex % 2 === 0 ? 3 : 1), 0);
  return `${body.join('')}${(10 - (sum % 10)) % 10}`;
}

function apiMetadata(id) {
  const api = apiById.get(id);
  if (!api) throw new Error(`Official CPSC API snapshot is missing recall ${id}.`);
  return {
    authority: 'CPSC',
    sourceKey: `cpsc:${id}`,
    externalRecallId: id,
    recallNumber: String(api.RecallNumber),
    officialUrl: String(api.URL).replace('https://cpsc.gov/', 'https://www.cpsc.gov/'),
    referenceDate,
    recallDate: String(api.RecallDate).slice(0, 10),
    title: api.Title,
    productName: api.Products?.[0]?.Name ?? api.Title,
  };
}

const structured = [
  {
    id: '10986',
    brand: 'Char-Broil',
    dimensions: ['manufacture_date', 'variant'],
    criteria: [criterion('attributes.dateCode', 'one_of', { values: ['2510', '2511', '2512'] })],
    baseAttributes: { dateCode: '2511', variant: 'Bistro Pro Electric Grill & Griddle + Charcoal' },
    negative: {
      container: 'attributes',
      field: 'dateCode',
      value: '2509',
      perturbation: 'date_just_outside_scope',
      boundary: true,
    },
    ambiguityField: { container: 'attributes', field: 'dateCode' },
  },
  {
    id: '10975',
    brand: 'JKMAX',
    dimensions: ['model', 'variant'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'one_of', {
        values: ['JKMAX-002', 'JKMAX-7284B', 'JKMAX-6284B', 'JKMAX-10090B', 'JKMAX-8490B'],
      }),
    ],
    baseProduct: { modelNumber: 'JKMAX-7284B' },
    negative: {
      container: 'ownedProduct',
      field: 'modelNumber',
      value: 'JKMAX-7285B',
      perturbation: 'sibling_model',
    },
    ambiguityField: { container: 'ownedProduct', field: 'modelNumber' },
  },
  {
    id: '10978',
    brand: 'Basecamp',
    dimensions: ['model', 'variant', 'size', 'color', 'multi_condition'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'equals', { value: 'HT-10' }),
      criterion('attributes.size', 'equals', { value: 'M/L' }),
      criterion('attributes.color', 'one_of', { values: ['green', 'black'] }),
    ],
    baseProduct: { modelNumber: 'HT-10' },
    baseAttributes: { size: 'M/L', color: 'green' },
    negative: { container: 'attributes', field: 'size', value: 'S', perturbation: 'size_mismatch' },
    ambiguityField: { container: 'attributes', field: 'size' },
  },
  {
    id: '10966',
    brand: 'Triumph',
    dimensions: ['model', 'serial_range', 'multi_condition'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'one_of', {
        values: ['TF450-C', 'TF450-E', 'TF450-X', 'TF450RC Edition'],
      }),
      criterion('ownedProduct.serialNumber', 'fixed_width_range', {
        from: 'XXXXXXXXXXXCD4981',
        to: 'XXXXXXXXXXXCP1597',
      }),
    ],
    baseProduct: { modelNumber: 'TF450-E', serialNumber: 'XXXXXXXXXXXCE0000' },
    negative: {
      container: 'ownedProduct',
      field: 'modelNumber',
      value: 'TF450-R',
      perturbation: 'sibling_model',
    },
    ambiguityField: { container: 'ownedProduct', field: 'modelNumber' },
  },
  {
    id: '10969',
    brand: 'Victgoal',
    dimensions: ['model', 'lot', 'manufacture_date', 'variant', 'size', 'color', 'multi_condition'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'equals', { value: 'HT-006' }),
      criterion('ownedProduct.lotNumber', 'equals', { value: '2025A1101' }),
      criterion('attributes.manufactureMonth', 'equals', { value: '2025-11' }),
      criterion('attributes.size', 'equals', { value: 'S' }),
      criterion('attributes.color', 'equals', { value: 'red' }),
    ],
    baseProduct: { modelNumber: 'HT-006', lotNumber: '2025A1101' },
    baseAttributes: { manufactureMonth: '2025-11', size: 'S', color: 'red' },
    negative: {
      container: 'attributes',
      field: 'manufactureMonth',
      value: '2025-12',
      perturbation: 'date_just_outside_scope',
      boundary: true,
    },
    ambiguityField: { container: 'ownedProduct', field: 'lotNumber' },
  },
  {
    id: '10895',
    brand: 'OCOOPA',
    dimensions: ['model'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'one_of', {
        values: ['UT3053', 'UT3056', 'ZLS-118', 'ZLS-118S', 'ZLS-118D', 'H01', 'H01(PD)'],
      }),
    ],
    baseProduct: { modelNumber: 'ZLS-118S' },
    baseAttributes: { batchFormat: 'three-digit' },
    negative: {
      container: 'ownedProduct',
      field: 'modelNumber',
      value: 'ZLS-119S',
      perturbation: 'sibling_model',
    },
    ambiguityField: { container: 'ownedProduct', field: 'modelNumber' },
  },
  {
    id: '10894',
    brand: 'Woodure',
    dimensions: ['model'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'one_of', { values: ['WD1764', 'WD1357', 'WD1720'] }),
    ],
    baseProduct: { modelNumber: 'WD1764' },
    negative: {
      container: 'ownedProduct',
      field: 'modelNumber',
      value: 'WD1765',
      perturbation: 'sibling_model',
    },
    ambiguityField: { container: 'ownedProduct', field: 'modelNumber' },
  },
  {
    id: '10873',
    brand: 'MNIENT',
    dimensions: ['model'],
    criteria: [criterion('ownedProduct.modelNumber', 'equals', { value: 'LQX-110055' })],
    baseProduct: { modelNumber: 'LQX-110055' },
    negative: {
      container: 'ownedProduct',
      field: 'modelNumber',
      value: 'LQX-110056',
      perturbation: 'sibling_model',
    },
    ambiguityField: { container: 'ownedProduct', field: 'modelNumber' },
  },
  {
    id: '10861',
    brand: 'Panasonic',
    dimensions: ['model'],
    criteria: [criterion('ownedProduct.modelNumber', 'equals', { value: 'NB-G200' })],
    baseProduct: { modelNumber: 'NB-G200' },
    negative: {
      container: 'ownedProduct',
      field: 'modelNumber',
      value: 'NB-G201',
      perturbation: 'sibling_model',
    },
    ambiguityField: { container: 'ownedProduct', field: 'modelNumber' },
  },
  {
    id: '10871',
    brand: 'SDADI',
    dimensions: ['model', 'color'],
    criteria: [criterion('ownedProduct.modelNumber', 'one_of', { values: ['LT05', 'LT01'] })],
    baseProduct: { modelNumber: 'LT05' },
    baseAttributes: { color: 'gray' },
    negative: {
      container: 'ownedProduct',
      field: 'modelNumber',
      value: 'LT06',
      perturbation: 'sibling_model',
    },
    ambiguityField: { container: 'ownedProduct', field: 'modelNumber' },
  },
  {
    id: '10854',
    brand: 'Insignia',
    dimensions: ['model'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'one_of', { values: ['NS-RGFGSS1', 'NS-RGFCGS2'] }),
    ],
    baseProduct: { modelNumber: 'NS-RGFGSS1' },
    negative: {
      container: 'ownedProduct',
      field: 'modelNumber',
      value: 'NS-RGFGSS2',
      perturbation: 'sibling_model',
    },
    ambiguityField: { container: 'ownedProduct', field: 'modelNumber' },
  },
  {
    id: '10859',
    brand: 'Kobalt',
    dimensions: ['model', 'capacity', 'variant', 'multi_condition'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'one_of', {
        values: ['KB 424-06', 'KB 524-06', 'KB 624-06', 'KXB 824-06', 'KB 324-06'],
      }),
      criterion('attributes.chargingPort', 'equals', { value: 'USB-C' }),
      criterion('attributes.capacity', 'one_of', {
        values: ['3.0Ah', '4.0Ah', '5.0Ah', '6.0Ah', '8.0Ah'],
      }),
    ],
    baseProduct: { modelNumber: 'KB 624-06' },
    baseAttributes: { chargingPort: 'USB-C', capacity: '6.0Ah' },
    negative: {
      container: 'attributes',
      field: 'chargingPort',
      value: 'barrel',
      perturbation: 'variant_mismatch',
    },
    ambiguityField: { container: 'attributes', field: 'chargingPort' },
  },
  {
    id: '10857',
    brand: 'WonderStone',
    dimensions: ['model', 'color'],
    criteria: [criterion('ownedProduct.modelNumber', 'one_of', { values: ['616', '616-1'] })],
    baseProduct: { modelNumber: '616-1' },
    baseAttributes: { color: 'pink' },
    negative: {
      container: 'ownedProduct',
      field: 'modelNumber',
      value: '616-2',
      perturbation: 'sibling_model',
    },
    ambiguityField: { container: 'ownedProduct', field: 'modelNumber' },
  },
  {
    id: '10852',
    brand: 'Hometown',
    dimensions: ['model', 'color'],
    criteria: [criterion('ownedProduct.modelNumber', 'equals', { value: 'RCLR-W8012' })],
    baseProduct: { modelNumber: 'RCLR-W8012' },
    baseAttributes: { color: 'red/white/blue' },
    negative: {
      container: 'ownedProduct',
      field: 'modelNumber',
      value: 'RCLR-W8013',
      perturbation: 'sibling_model',
    },
    ambiguityField: { container: 'ownedProduct', field: 'modelNumber' },
  },
  {
    id: '10839',
    brand: 'Amana',
    dimensions: ['model', 'model_family'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'one_of', {
        values: [
          'PBH113J35AA',
          'PBH093J35AA',
          'PBH073J35AA',
          'PBE123J35AA',
          'PBE093J35AA',
          'AH183J35AA',
          'AH123J35AA',
          'AH093J35AA',
          'AE183J35AA',
          'AE123J35AA',
          'AE093J35AA',
        ],
      }),
    ],
    baseProduct: { modelNumber: 'PBH113J35AA' },
    negative: {
      container: 'ownedProduct',
      field: 'modelNumber',
      value: 'PBH114J35AA',
      perturbation: 'model_family_near_miss',
    },
    ambiguityField: { container: 'ownedProduct', field: 'modelNumber' },
  },
  {
    id: '10834',
    brand: 'Lomi',
    dimensions: ['model', 'model_family'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'one_of', { values: ['LOMB2003PK', 'LOMB2004PK'] }),
    ],
    baseProduct: { modelNumber: 'LOMB2003PK' },
    negative: {
      container: 'ownedProduct',
      field: 'modelNumber',
      value: 'LOMB2005PK',
      perturbation: 'model_family_near_miss',
    },
    ambiguityField: { container: 'ownedProduct', field: 'modelNumber' },
  },
];

const stressStructured = [
  {
    id: '10837',
    brand: 'Small Fish',
    dimensions: ['model', 'adversarial'],
    criteria: [criterion('ownedProduct.modelNumber', 'equals', { value: '2512JX02' })],
    baseProduct: { modelNumber: '2512JX02' },
    negative: {
      container: 'ownedProduct',
      field: 'modelNumber',
      value: '2512JX03',
      perturbation: 'single_character_model_mutation',
    },
    ambiguityField: { container: 'ownedProduct', field: 'modelNumber' },
  },
  {
    id: '10849',
    brand: 'Junpower',
    dimensions: ['model', 'adversarial'],
    criteria: [criterion('ownedProduct.modelNumber', 'equals', { value: '2023-V3' })],
    baseProduct: { modelNumber: '2023-V3' },
    negative: {
      container: 'ownedProduct',
      field: 'modelNumber',
      value: '2032-V3',
      perturbation: 'transposed_digits',
    },
    ambiguityField: { container: 'ownedProduct', field: 'modelNumber' },
  },
  {
    id: '10855',
    brand: 'BBRKIN',
    dimensions: ['model', 'serial_range', 'multi_condition', 'adversarial'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'equals', { value: 'QHXP029B' }),
      criterion('ownedProduct.serialNumber', 'fixed_width_range', {
        from: 'SQC200034980',
        to: 'SQC202319171',
      }),
    ],
    baseProduct: { modelNumber: 'QHXP029B', serialNumber: 'SQC200034980' },
    negative: {
      container: 'ownedProduct',
      field: 'serialNumber',
      value: 'SQC200034979',
      perturbation: 'serial_just_outside_range',
      boundary: true,
    },
    ambiguityField: { container: 'ownedProduct', field: 'serialNumber' },
  },
  {
    id: '10846',
    brand: 'AMASKY',
    dimensions: ['model', 'lot', 'batch', 'multi_condition', 'adversarial'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'one_of', {
        values: ['BXP99', 'BXP93', 'BXP94', 'BXP96', 'BXP97'],
      }),
      criterion('ownedProduct.lotNumber', 'equals', { value: '202506001' }),
    ],
    baseProduct: { modelNumber: 'BXP99', lotNumber: '202506001' },
    negative: {
      container: 'ownedProduct',
      field: 'lotNumber',
      value: '202506002',
      perturbation: 'lot_near_miss',
      boundary: true,
    },
    ambiguityField: { container: 'ownedProduct', field: 'lotNumber' },
  },
  {
    id: '10885',
    brand: 'Galanz',
    dimensions: ['model', 'manufacture_date', 'multi_condition', 'adversarial'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'one_of', {
        values: ['BCD-215V-62H', 'GLR76TRDER', 'GLR76TBKER', 'GLR76TBEER', 'GLR76TWEER'],
      }),
      criterion('attributes.manufactureMonth', 'date_range', {
        from: '2018-12',
        to: '2020-12',
      }),
    ],
    baseProduct: { modelNumber: 'BCD-215V-62H' },
    baseAttributes: { manufactureMonth: '2020-12' },
    negative: {
      container: 'attributes',
      field: 'manufactureMonth',
      value: '2021-01',
      perturbation: 'boundary_date',
      boundary: true,
    },
    ambiguityField: {
      container: 'attributes',
      field: 'manufactureMonth',
      purchaseDate: '2020-12-15',
      perturbation: 'purchase_date_as_manufacture_date',
    },
  },
  {
    id: '10864',
    brand: 'Currey & Company',
    dimensions: ['model', 'variant', 'multi_condition', 'adversarial'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'one_of', {
        values: ['9000-1129', '9000-1130', '9000-1254', '9000-1255', '9000-1314'],
      }),
      criterion('attributes.visibleTopCapScrew', 'equals', { value: 'no' }),
    ],
    baseProduct: { modelNumber: '9000-1129' },
    baseAttributes: { visibleTopCapScrew: 'no' },
    negative: {
      container: 'attributes',
      field: 'visibleTopCapScrew',
      value: 'yes',
      perturbation: 'variant_mismatch',
    },
    ambiguityField: { container: 'attributes', field: 'visibleTopCapScrew' },
  },
  {
    id: '10845',
    brand: 'Rowenta',
    dimensions: ['model', 'date', 'variant', 'multi_condition', 'adversarial'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'one_of', { values: ['RH99A2U1', 'RH99F2U1'] }),
      criterion('attributes.batteryModel', 'equals', { value: 'ZR0097U2' }),
      criterion('attributes.dateCodePrefix', 'prefix_one_of', { values: ['23', '24'] }),
    ],
    baseProduct: { modelNumber: 'RH99A2U1' },
    baseAttributes: { batteryModel: 'ZR0097U2', dateCodePrefix: '24-155' },
    negative: {
      container: 'attributes',
      field: 'batteryModel',
      value: 'ZR0097U3',
      perturbation: 'conflicting_identifiers',
    },
    ambiguityField: { container: 'attributes', field: 'dateCodePrefix' },
  },
  {
    id: '10851',
    brand: 'Unity',
    dimensions: ['model', 'production_date', 'multi_condition', 'adversarial'],
    criteria: [
      criterion('ownedProduct.modelNumber', 'equals', { value: 'MEF6096' }),
      criterion('attributes.productionDate', 'date_range', {
        from: '2026-03-16',
        to: '2026-05-18',
      }),
    ],
    baseProduct: { modelNumber: 'MEF6096' },
    baseAttributes: { productionDate: '2026-05-18' },
    negative: {
      container: 'attributes',
      field: 'productionDate',
      value: '2026-05-19',
      perturbation: 'boundary_date',
      boundary: true,
    },
    ambiguityField: { container: 'attributes', field: 'productionDate' },
  },
];

function gtinConfig([id, gtins, brand]) {
  return {
    id,
    brand,
    dimensions: ['gtin'],
    criteria: [criterion('ownedProduct.gtin', 'one_of', { values: gtins })],
    baseProduct: { gtin: gtins[0] },
    negative: {
      container: 'ownedProduct',
      field: 'gtin',
      value: validSiblingGtin(gtins[0]),
      secondValue: validSiblingGtin(gtins[0], 2),
      perturbation: 'valid_gtin_near_miss',
    },
    ambiguityField: { container: 'ownedProduct', field: 'gtin' },
    gtins,
  };
}

const configs = [...gtinFamilies.map(gtinConfig), ...structured, ...stressStructured];
if (configs.length !== 50) throw new Error(`Expected 50 recall families, got ${configs.length}.`);

function applyChange(targetProduct, targetAttributes, change, alternate = false) {
  const outputProduct = { ...targetProduct };
  const outputAttributes = { ...targetAttributes };
  const target = change.container === 'attributes' ? outputAttributes : outputProduct;
  target[change.field] = alternate && change.secondValue ? change.secondValue : change.value;
  return { ownedProduct: outputProduct, attributes: outputAttributes };
}

function buildCase(config, metadata, split, familyIndex, ordinal, kind, options = {}) {
  const baseProduct = product({
    productName: metadata.productName,
    brand: config.brand ?? null,
    ...config.baseProduct,
  });
  const baseAttributes = { ...(config.baseAttributes ?? {}) };
  let controlled = { ownedProduct: baseProduct, attributes: baseAttributes };
  let expected = kind;
  let perturbationType = null;
  let hardNegative = false;
  if (kind === 'no_match') {
    controlled = applyChange(baseProduct, baseAttributes, config.negative, options.alternate);
    perturbationType = config.negative.perturbation;
    hardNegative = true;
  } else if (kind === 'needs_review') {
    controlled = applyChange(baseProduct, baseAttributes, {
      ...config.ambiguityField,
      value: null,
    });
    if (config.ambiguityField.purchaseDate) {
      controlled.ownedProduct.purchaseDate = config.ambiguityField.purchaseDate;
    }
    perturbationType = config.ambiguityField.perturbation ?? 'missing_required_identifier';
  }
  if (options.aliasName) {
    controlled.ownedProduct.productName = `${controlled.ownedProduct.productName} — label transcription`;
  }
  if (options.brandOnly) {
    controlled.ownedProduct.productName = null;
  }
  const combination = config.criteria.length > 1;
  const provenance =
    expected === 'match'
      ? combination
        ? 'official_scope_combination'
        : 'official_exact_evidence'
      : expected === 'no_match'
        ? config.negative.boundary
          ? 'controlled_boundary_counterfactual'
          : 'controlled_identifier_counterfactual'
        : 'source_ambiguity';
  return {
    caseId: `p15-${split.slice(0, 3)}-${String(familyIndex + 1).padStart(2, '0')}-${ordinal}`,
    authority: metadata.authority,
    sourceKey: metadata.sourceKey,
    externalRecallId: metadata.externalRecallId,
    officialUrl: metadata.officialUrl,
    referenceDate,
    recallFamilyId: `cpsc-family-${config.id}`,
    split,
    expected,
    labelProvenance: provenance,
    evidenceDimensions: config.dimensions,
    perturbationType,
    pairGroupId: ordinal <= 2 ? `p15-pair-${config.id}` : null,
    hardNegative,
    ...controlled,
    reason:
      expected === 'match'
        ? 'All explicit authoritative scope conditions represented in this controlled product are satisfied.'
        : expected === 'no_match'
          ? 'A minimal controlled change crosses an explicit authoritative scope boundary.'
          : 'Required authoritative identifying evidence is absent; the safe outcome is abstention.',
    notes: 'Controlled benchmark object only; contains no user inventory or personal data.',
  };
}

const sources = [];
const splitCases = { development: [], holdout: [], stress: [] };
for (const [index, config] of configs.entries()) {
  const split = index < 12 ? 'development' : index < 42 ? 'holdout' : 'stress';
  const metadata = apiMetadata(config.id);
  const matcherScopes = [];
  const firstCriterion = config.criteria[0];
  const values = firstCriterion.values ?? [firstCriterion.value].filter(Boolean);
  if (firstCriterion.field === 'ownedProduct.gtin') {
    for (const gtin of values)
      matcherScopes.push({ productName: metadata.productName, brand: config.brand ?? null, gtin });
  } else if (firstCriterion.field === 'ownedProduct.modelNumber') {
    for (const modelNumber of values) {
      const scope = { productName: metadata.productName, brand: config.brand ?? null, modelNumber };
      const serialCriterion = config.criteria.find(
        (item) => item.field === 'ownedProduct.serialNumber',
      );
      const lotCriterion = config.criteria.find((item) => item.field === 'ownedProduct.lotNumber');
      if (serialCriterion?.operator === 'fixed_width_range') {
        scope.serialFrom = serialCriterion.from;
        scope.serialTo = serialCriterion.to;
      }
      if (lotCriterion?.operator === 'equals') scope.lotNumber = lotCriterion.value;
      if (config.criteria.some((item) => item.field.startsWith('attributes.'))) {
        scope.additionalCriteria = {
          controlledScopeFields: config.criteria
            .filter((item) => item.field.startsWith('attributes.'))
            .map((item) => item.field),
        };
      }
      matcherScopes.push(scope);
    }
  } else {
    matcherScopes.push({
      productName: metadata.productName,
      brand: config.brand ?? null,
      additionalCriteria: { controlledScopeFields: config.criteria.map((item) => item.field) },
    });
  }
  sources.push({
    ...metadata,
    recallFamilyId: `cpsc-family-${config.id}`,
    retrievalMethod: 'CPSC Recall Retrieval Web Services JSON API',
    scopeEvidence: {
      summary:
        'Field-reduced controlled transcription of explicit identifiers and scope boundaries in the official notice.',
      evidenceDimensions: config.dimensions,
      exhaustiveForControlledFields: true,
    },
    scopeRules: [{ criteria: config.criteria }],
    matcherScopes,
  });
  const cases = [
    buildCase(config, metadata, split, index, 1, 'match'),
    buildCase(config, metadata, split, index, 2, 'no_match'),
    buildCase(config, metadata, split, index, 3, 'needs_review'),
  ];
  const extraKind = index % 3 === 0 ? 'match' : index % 3 === 1 ? 'no_match' : 'needs_review';
  cases.push(
    buildCase(config, metadata, split, index, 4, extraKind, {
      aliasName: extraKind !== 'needs_review',
      alternate: extraKind === 'no_match',
      brandOnly: extraKind === 'needs_review',
    }),
  );
  splitCases[split].push(...cases);
}

await mkdir(outputDirectory, { recursive: true });
await writeFile(
  new URL('./sources.normalized.json', import.meta.url),
  `${JSON.stringify({ snapshotVersion: '2.0.0', retrievedAt: referenceDate, authorities: ['CPSC'], sources }, null, 2)}\n`,
);
for (const [split, cases] of Object.entries(splitCases)) {
  await writeFile(
    new URL(`./${split}.v2.json`, import.meta.url),
    `${JSON.stringify(
      {
        benchmarkVersion: 'recall_safety_benchmark_v2',
        datasetVersion: '2.0.0',
        policyVersion: 'phase_15_safety_policy_v1',
        sourceSnapshotVersion: '2.0.0',
        split,
        createdAt: referenceDate,
        cases,
      },
      null,
      2,
    )}\n`,
  );
}
console.log(
  JSON.stringify({
    sources: sources.length,
    splits: Object.fromEntries(
      Object.entries(splitCases).map(([name, cases]) => [name, cases.length]),
    ),
  }),
);
