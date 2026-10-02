import type {
  OfficialRecallEvidence,
  OwnedProductEvidence,
} from '../../../supabase/functions/_shared/matching/types.ts';
import type {
  OfficialRecallEvidenceV2,
  OwnedProductAttribute,
  OwnedProductEvidenceV2,
  ProductAttributeKey,
  RecallCriterion,
  RecallCriterionKind,
  RecallCriterionOperator,
} from '../../../supabase/functions/_shared/matching/typesV2.ts';

type ControlledCriterion = {
  field: string;
  operator: string;
  value?: string;
  values?: string[];
  from?: string;
  to?: string;
};

type Phase15Source = {
  recallFamilyId: string;
  sourceKey: string;
  authority: string;
  externalRecallId: string;
  officialUrl: string;
  referenceDate: string;
  title: string;
  productName: string;
  recallDate: string;
  matcherScopes: Array<Record<string, unknown>>;
  scopeRules: Array<{ criteria: ControlledCriterion[] }>;
};

type Phase15Case = {
  ownedProduct: OwnedProductEvidence;
  attributes: Record<string, unknown>;
};

const FIELD_KIND: Record<string, RecallCriterionKind> = {
  'ownedProduct.gtin': 'gtin',
  'ownedProduct.modelNumber': 'model_number',
  'ownedProduct.serialNumber': 'serial_number',
  'ownedProduct.lotNumber': 'lot_number',
  'attributes.batteryModel': 'battery_model',
  'attributes.capacity': 'capacity',
  'attributes.chargingPort': 'charging_port_type',
  'attributes.color': 'color',
  'attributes.dateCode': 'date_code',
  'attributes.dateCodePrefix': 'date_code_prefix',
  'attributes.manufactureMonth': 'manufacture_date',
  'attributes.productionDate': 'production_date',
  'attributes.size': 'size',
  'attributes.visibleTopCapScrew': 'screw_state',
};

const ATTRIBUTE_KEY: Record<string, ProductAttributeKey> = {
  batteryModel: 'battery_model',
  capacity: 'capacity',
  chargingPort: 'charging_port_type',
  color: 'color',
  dateCode: 'date_code',
  dateCodePrefix: 'date_code',
  manufactureMonth: 'manufacture_date',
  productionDate: 'production_date',
  size: 'size',
  variant: 'variant',
  visibleTopCapScrew: 'screw_state',
};

function lastDayOfMonth(month: string): string {
  const match = /^(\d{4})-(\d{2})$/u.exec(month);
  if (!match) return month;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const day = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

function criterionValue(field: string, value: string, end = false): string {
  if (field === 'attributes.manufactureMonth' && /^\d{4}-\d{2}$/u.test(value)) {
    return end ? lastDayOfMonth(value) : `${value}-01`;
  }
  return value;
}

function operator(value: string): RecallCriterionOperator {
  if (value === 'fixed_width_range') return 'range';
  if (value === 'prefix_one_of') return 'prefix';
  if (['equals', 'one_of', 'date_range'].includes(value)) {
    return value as RecallCriterionOperator;
  }
  throw new Error(`Unsupported controlled Phase 15 operator: ${value}`);
}

function projectCriterion(
  source: Phase15Source,
  ruleIndex: number,
  criterionIndex: number,
  controlled: ControlledCriterion,
): RecallCriterion {
  const kind = FIELD_KIND[controlled.field];
  if (!kind) throw new Error(`Unsupported controlled Phase 15 field: ${controlled.field}`);
  return {
    id: `${source.recallFamilyId}:rule-${ruleIndex}:criterion-${criterionIndex}`,
    kind,
    operator: operator(controlled.operator),
    required: true,
    ...(controlled.value ? { value: criterionValue(controlled.field, controlled.value) } : {}),
    ...(controlled.values
      ? { values: controlled.values.map((value) => criterionValue(controlled.field, value)) }
      : {}),
    ...(controlled.from && controlled.to
      ? {
          range: {
            from: criterionValue(controlled.field, controlled.from),
            to: criterionValue(controlled.field, controlled.to, true),
          },
        }
      : {}),
    provenance: {
      authority: source.authority,
      officialUrl: source.officialUrl,
      sourceField: controlled.field,
      normalizationRule: `phase_15_frozen_scope_rule:${controlled.operator}`,
    },
  };
}

export function projectPhase15OwnedProductV2(benchmarkCase: Phase15Case): OwnedProductEvidenceV2 {
  const attributes: OwnedProductAttribute[] = [];
  for (const [sourceKey, rawValue] of Object.entries(benchmarkCase.attributes)) {
    const key = ATTRIBUTE_KEY[sourceKey];
    if (!key || typeof rawValue !== 'string' || !rawValue.trim()) continue;
    attributes.push({
      key,
      value:
        sourceKey === 'manufactureMonth' && /^\d{4}-\d{2}$/u.test(rawValue)
          ? `${rawValue}-01`
          : rawValue,
      valueType: key === 'manufacture_date' || key === 'production_date' ? 'date' : 'text',
      captureSource: 'manual',
    });
  }
  return { ...benchmarkCase.ownedProduct, attributes };
}

export function projectPhase15RecallV2(source: Phase15Source): OfficialRecallEvidenceV2 {
  const context = source.matcherScopes[0] ?? {};
  return {
    recallNoticeId: source.sourceKey,
    source: {
      authority: source.authority,
      externalId: source.externalRecallId,
      officialUrl: source.officialUrl,
      retrievedAt: source.referenceDate,
    },
    title: source.title,
    description: source.productName,
    hazard: null,
    remedy: null,
    recallDate: source.recallDate,
    scopes: source.scopeRules.map((rule, ruleIndex) => ({
      productName:
        typeof context.productName === 'string' ? context.productName : source.productName,
      brand: typeof context.brand === 'string' ? context.brand : null,
      criteria: {
        semantics: 'all_of',
        criteria: rule.criteria.map((item, criterionIndex) =>
          projectCriterion(source, ruleIndex, criterionIndex, item),
        ),
      },
    })),
    rawEvidence: null,
  };
}

export function projectPhase15RecallV1(source: Phase15Source): OfficialRecallEvidence {
  return {
    recallNoticeId: source.sourceKey,
    source: {
      authority: source.authority,
      externalId: source.externalRecallId,
      officialUrl: source.officialUrl,
      retrievedAt: source.referenceDate,
    },
    title: source.title,
    description: source.productName,
    hazard: null,
    remedy: null,
    recallDate: source.recallDate,
    scopes: source.matcherScopes,
    rawEvidence: null,
  } as OfficialRecallEvidence;
}
