import {
  isValidGtin,
  normalizeIdentifier,
} from '../../supabase/functions/_shared/matching/normalization.ts';
import type {
  OfficialRecallEvidence,
  OwnedProductEvidence,
} from '../../supabase/functions/_shared/matching/types.ts';

export type BenchmarkExpected = 'match' | 'no_match' | 'needs_review';
export type LabelProvenance =
  'official_exact_evidence' | 'controlled_counterfactual' | 'source_ambiguity' | 'human_reviewed';

export type BenchmarkCase = {
  caseId: string;
  officialRecallExternalId: string;
  ownedProduct: OwnedProductEvidence;
  expected: BenchmarkExpected;
  labelProvenance: LabelProvenance;
  reason: string;
  notes: string;
};

export type BenchmarkDataset = {
  datasetVersion: '1';
  createdAt: string;
  sourceRetrievalDate: string;
  sourceAuthority: string;
  recalls: OfficialRecallEvidence[];
  cases: BenchmarkCase[];
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const expectedValues = new Set<BenchmarkExpected>(['match', 'no_match', 'needs_review']);
const provenanceValues = new Set<LabelProvenance>([
  'official_exact_evidence',
  'controlled_counterfactual',
  'source_ambiguity',
  'human_reviewed',
]);
const privateKeyPattern = /^(?:auth|email|imagePath|ocr|userId|user_id|uuid)$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDateOnly(value: string): boolean {
  if (!datePattern.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function matchesJsonType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === type;
}

function resolveSchemaReference(
  rootSchema: Record<string, unknown>,
  reference: string,
): Record<string, unknown> | null {
  if (!reference.startsWith('#/')) return null;
  let current: unknown = rootSchema;
  for (const segment of reference.slice(2).split('/')) {
    if (!isRecord(current)) return null;
    current = current[segment.replace(/~1/gu, '/').replace(/~0/gu, '~')];
  }
  return isRecord(current) ? current : null;
}

function validateSchemaNode(
  value: unknown,
  schema: Record<string, unknown>,
  rootSchema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (typeof schema.$ref === 'string') {
    const referenced = resolveSchemaReference(rootSchema, schema.$ref);
    if (!referenced) {
      errors.push(`${path} uses an unresolved schema reference ${schema.$ref}.`);
      return;
    }
    validateSchemaNode(value, referenced, rootSchema, path, errors);
    return;
  }

  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path} does not equal the schema constant.`);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))
  ) {
    errors.push(`${path} is not an allowed enum value.`);
  }

  const allowedTypes =
    typeof schema.type === 'string'
      ? [schema.type]
      : Array.isArray(schema.type)
        ? schema.type.filter((type): type is string => typeof type === 'string')
        : [];
  if (allowedTypes.length && !allowedTypes.some((type) => matchesJsonType(value, type))) {
    errors.push(`${path} has the wrong JSON type.`);
    return;
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path} is shorter than the schema minimum.`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${path} does not match the schema pattern.`);
    }
    if (schema.format === 'date' && !isDateOnly(value)) {
      errors.push(`${path} is not a valid calendar date.`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path} has fewer items than allowed.`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path} has more items than allowed.`);
    }
    if (isRecord(schema.items)) {
      value.forEach((item, index) =>
        validateSchemaNode(
          item,
          schema.items as Record<string, unknown>,
          rootSchema,
          `${path}[${index}]`,
          errors,
        ),
      );
    }
  }

  if (isRecord(value)) {
    if (
      typeof schema.minProperties === 'number' &&
      Object.keys(value).length < schema.minProperties
    ) {
      errors.push(`${path} has fewer properties than allowed.`);
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const required of schema.required) {
        if (typeof required === 'string' && !(required in value)) {
          errors.push(`${path}.${required} is required by the schema.`);
        }
      }
    }
    for (const [key, nested] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (isRecord(propertySchema)) {
        validateSchemaNode(nested, propertySchema, rootSchema, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed by the schema.`);
      }
    }
  }
}

/** Applies the dependency-free JSON Schema subset used by benchmark.schema.json. */
export function validateBenchmarkJsonSchema(value: unknown, schema: unknown): string[] {
  if (!isRecord(schema)) {
    return ['Benchmark schema must be a JSON object.'];
  }
  const errors: string[] = [];
  validateSchemaNode(value, schema, schema, '$', errors);
  return errors;
}

function collectPrivateKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectPrivateKeys(item, `${path}[${index}]`));
  }
  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, nested]) => [
    ...(privateKeyPattern.test(key) ? [`${path}.${key}`] : []),
    ...collectPrivateKeys(nested, `${path}.${key}`),
  ]);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function hasExactOfficialSourceEvidence(
  ownedProduct: Record<string, unknown> | null,
  officialRecall: Record<string, unknown> | undefined,
): boolean {
  if (!ownedProduct || !officialRecall || !isRecord(officialRecall.rawEvidence)) {
    return false;
  }
  const rawEvidence = officialRecall.rawEvidence;
  const ownedModel =
    typeof ownedProduct.modelNumber === 'string'
      ? normalizeIdentifier(ownedProduct.modelNumber)
      : null;
  const models = stringArray(rawEvidence.explicitModelNumbers).map(normalizeIdentifier);
  if (!ownedModel || !models.includes(ownedModel)) {
    return false;
  }

  const lots = stringArray(rawEvidence.explicitLotNumbers).map(normalizeIdentifier);
  const ownedLot =
    typeof ownedProduct.lotNumber === 'string' ? normalizeIdentifier(ownedProduct.lotNumber) : null;
  if (lots.length && (!ownedLot || !lots.includes(ownedLot))) {
    return false;
  }

  const serialPrefixes = stringArray(rawEvidence.explicitSerialPrefixes).map(normalizeIdentifier);
  const ownedSerial =
    typeof ownedProduct.serialNumber === 'string'
      ? normalizeIdentifier(ownedProduct.serialNumber)
      : null;
  if (
    serialPrefixes.length &&
    (!ownedSerial || !serialPrefixes.some((prefix) => prefix && ownedSerial.startsWith(prefix)))
  ) {
    return false;
  }

  return true;
}

export function validateBenchmarkDataset(value: unknown, schema: unknown): string[] {
  const errors: string[] = validateBenchmarkJsonSchema(value, schema);
  if (!isRecord(value)) {
    return ['Dataset must be a JSON object.'];
  }
  if (value.datasetVersion !== '1') {
    errors.push('datasetVersion must be "1".');
  }
  if (typeof value.createdAt !== 'string' || !isDateOnly(value.createdAt)) {
    errors.push('createdAt must be a YYYY-MM-DD date.');
  }
  if (typeof value.sourceRetrievalDate !== 'string' || !isDateOnly(value.sourceRetrievalDate)) {
    errors.push('sourceRetrievalDate must be a YYYY-MM-DD date.');
  }
  if (!Array.isArray(value.recalls) || !value.recalls.length) {
    errors.push('recalls must be a non-empty array.');
  }
  if (!Array.isArray(value.cases) || value.cases.length < 20 || value.cases.length > 50) {
    errors.push('cases must contain between 20 and 50 cases.');
  }

  const recallIds = new Set<string>();
  const recallById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(value.recalls)) {
    for (const [index, recall] of value.recalls.entries()) {
      if (!isRecord(recall) || !isRecord(recall.source)) {
        errors.push(`recalls[${index}] must contain a source object.`);
        continue;
      }
      const externalId = recall.source.externalId;
      if (typeof externalId !== 'string' || !externalId) {
        errors.push(`recalls[${index}] is missing source.externalId.`);
      } else if (recallIds.has(externalId)) {
        errors.push(`Duplicate recall external ID: ${externalId}.`);
      } else {
        recallIds.add(externalId);
        recallById.set(externalId, recall);
      }
      if (recall.source.authority !== 'CPSC') {
        errors.push(`recalls[${index}] authority must be CPSC.`);
      }
      if (
        typeof recall.source.officialUrl !== 'string' ||
        !recall.source.officialUrl.startsWith('https://www.cpsc.gov/Recalls/')
      ) {
        errors.push(`recalls[${index}] must have an official CPSC recall URL.`);
      }
      if (!Array.isArray(recall.scopes)) {
        errors.push(`recalls[${index}].scopes must be an array.`);
      } else {
        for (const [scopeIndex, scope] of recall.scopes.entries()) {
          if (!isRecord(scope)) {
            errors.push(`recalls[${index}].scopes[${scopeIndex}] must be an object.`);
          } else if (typeof scope.gtin === 'string' && !isValidGtin(scope.gtin)) {
            errors.push(`recalls[${index}].scopes[${scopeIndex}] contains an invalid GTIN.`);
          }
        }
      }
    }
  }

  const caseIds = new Set<string>();
  if (Array.isArray(value.cases)) {
    for (const [index, benchmarkCase] of value.cases.entries()) {
      if (!isRecord(benchmarkCase)) {
        errors.push(`cases[${index}] must be an object.`);
        continue;
      }
      const caseId = benchmarkCase.caseId;
      if (typeof caseId !== 'string' || !caseId) {
        errors.push(`cases[${index}] is missing caseId.`);
      } else if (caseIds.has(caseId)) {
        errors.push(`Duplicate caseId: ${caseId}.`);
      } else {
        caseIds.add(caseId);
      }
      if (
        typeof benchmarkCase.officialRecallExternalId !== 'string' ||
        !recallIds.has(benchmarkCase.officialRecallExternalId)
      ) {
        errors.push(`cases[${index}] references an unknown recall.`);
      }
      if (!expectedValues.has(benchmarkCase.expected as BenchmarkExpected)) {
        errors.push(`cases[${index}] has an invalid expected label.`);
      }
      if (!provenanceValues.has(benchmarkCase.labelProvenance as LabelProvenance)) {
        errors.push(`cases[${index}] has invalid label provenance.`);
      }
      if (benchmarkCase.labelProvenance === 'human_reviewed') {
        errors.push(`cases[${index}] falsely claims human review; Phase 8 forbids this label.`);
      }
      const requiredProvenance: Record<BenchmarkExpected, LabelProvenance> = {
        match: 'official_exact_evidence',
        no_match: 'controlled_counterfactual',
        needs_review: 'source_ambiguity',
      };
      if (
        expectedValues.has(benchmarkCase.expected as BenchmarkExpected) &&
        benchmarkCase.labelProvenance !==
          requiredProvenance[benchmarkCase.expected as BenchmarkExpected]
      ) {
        errors.push(`cases[${index}] label and provenance are incompatible for dataset v1.`);
      }
      if (typeof benchmarkCase.reason !== 'string' || !benchmarkCase.reason.trim()) {
        errors.push(`cases[${index}] requires a label reason.`);
      }

      const officialRecall =
        typeof benchmarkCase.officialRecallExternalId === 'string'
          ? recallById.get(benchmarkCase.officialRecallExternalId)
          : undefined;
      const ownedProduct = isRecord(benchmarkCase.ownedProduct) ? benchmarkCase.ownedProduct : null;
      const ownedGtin = typeof ownedProduct?.gtin === 'string' ? ownedProduct.gtin : null;
      const officialGtins = Array.isArray(officialRecall?.scopes)
        ? officialRecall.scopes.flatMap((scope) =>
            isRecord(scope) && typeof scope.gtin === 'string' ? [scope.gtin] : [],
          )
        : [];
      const exactGtinMatch = Boolean(
        ownedGtin && isValidGtin(ownedGtin) && officialGtins.includes(ownedGtin),
      );
      const exactOfficialSourceEvidence = hasExactOfficialSourceEvidence(
        ownedProduct,
        officialRecall,
      );
      if (benchmarkCase.expected === 'match' && !exactGtinMatch && !exactOfficialSourceEvidence) {
        errors.push(`cases[${index}] positive control lacks exact official source evidence.`);
      }
      if (
        benchmarkCase.expected === 'no_match' &&
        (!ownedGtin ||
          !isValidGtin(ownedGtin) ||
          !officialGtins.length ||
          officialGtins.includes(ownedGtin))
      ) {
        errors.push(
          `cases[${index}] counterfactual lacks an objective official GTIN contradiction.`,
        );
      }
      if (
        benchmarkCase.expected === 'needs_review' &&
        (exactGtinMatch || exactOfficialSourceEvidence)
      ) {
        errors.push(`cases[${index}] ambiguous control contains resolving exact source evidence.`);
      }
    }
  }

  for (const path of collectPrivateKeys(value)) {
    errors.push(`Private-data-shaped field is forbidden in the benchmark: ${path}.`);
  }

  return errors;
}

export function asBenchmarkDataset(value: unknown, schema: unknown): BenchmarkDataset {
  const errors = validateBenchmarkDataset(value, schema);
  if (errors.length) {
    throw new Error(
      `Invalid benchmark dataset:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    );
  }
  return value as BenchmarkDataset;
}

export function recallForCase(
  dataset: BenchmarkDataset,
  benchmarkCase: BenchmarkCase,
): OfficialRecallEvidence {
  const recall = dataset.recalls.find(
    (candidate) => candidate.source.externalId === benchmarkCase.officialRecallExternalId,
  );
  if (!recall) {
    throw new Error(`Missing recall ${benchmarkCase.officialRecallExternalId}.`);
  }
  return recall;
}
