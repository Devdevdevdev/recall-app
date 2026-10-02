export type ProductLabelCandidates = {
  lotNumber?: string;
  modelNumber?: string;
  referenceNumber?: string;
  serialNumber?: string;
  variant?: string;
  color?: string;
  size?: string;
  capacity?: string;
  batteryModel?: string;
  chargingPortType?: string;
  screwState?: string;
  dateCode?: string;
  manufactureDate?: string;
  productionDate?: string;
};

export type ProductLabelField = keyof ProductLabelCandidates;

export type ProductLabelEvidence = {
  candidates: ProductLabelCandidates;
  recognizedText: string;
};

/** Transient evidence can later carry barcode and OCR observations in one identification request. */
export type ProductScanEvidence = {
  gtin?: string;
  label?: ProductLabelEvidence;
};

type LabelPattern = {
  field: ProductLabelField;
  pattern: string;
  requiresDigit?: boolean;
};

const labelPatterns: readonly LabelPattern[] = [
  {
    field: 'serialNumber',
    pattern: 'N[°ºO.]?\\s*S[ÉE]RIE|SERIAL(?:\\s+(?:NO\\.?|NUMBER))?|S[ÉE]RIE|S\\/N|SN',
    requiresDigit: true,
  },
  { field: 'referenceNumber', pattern: 'R[ÉE]F(?:[ÉE]RENCE)?|REF(?:ERENCE)?', requiresDigit: true },
  {
    field: 'modelNumber',
    pattern: 'MODEL(?:\\s+(?:NO\\.?|NUMBER))?|MOD[ÈE]LE|MOD\\.?|TYPE',
    requiresDigit: true,
  },
  { field: 'lotNumber', pattern: 'BATCH(?:\\s+NO\\.?)?|LOT(?:\\s+NO\\.?)?', requiresDigit: true },
  { field: 'variant', pattern: 'VARIANT' },
  { field: 'color', pattern: 'COLOU?R' },
  { field: 'size', pattern: 'SIZE' },
  { field: 'capacity', pattern: 'CAPACITY' },
  { field: 'batteryModel', pattern: 'BATTERY\\s+MODEL' },
  { field: 'chargingPortType', pattern: 'CHARGING\\s+PORT(?:\\s+TYPE)?' },
  { field: 'screwState', pattern: 'SCREW\\s+STATE' },
  { field: 'dateCode', pattern: 'DATE\\s+CODE' },
  { field: 'manufactureDate', pattern: 'MANUFACTURE(?:D)?\\s+DATE' },
  { field: 'productionDate', pattern: 'PRODUCTION\\s+DATE' },
] as const;

const allowedValuePattern = /^[\p{L}\p{N}][\p{L}\p{N}./\- ]*$/u;
const electricalNoisePattern =
  /^(?:\d+(?:[.,]\d+)?(?:\s*[-/]\s*\d+(?:[.,]\d+)?)?\s*(?:V|W|A|HZ)|CE)$/iu;

function normalizeValue(value: string, requiresDigit = false): string | null {
  const normalized = value.trim().replace(/\s+/g, ' ');

  if (
    normalized.length === 0 ||
    normalized.length > 120 ||
    !allowedValuePattern.test(normalized) ||
    (requiresDigit && !/\d/u.test(normalized)) ||
    electricalNoisePattern.test(normalized)
  ) {
    return null;
  }

  return normalized;
}

function matchLabeledValue(line: string): { field: ProductLabelField; value: string } | null {
  for (const { field, pattern, requiresDigit } of labelPatterns) {
    const match = new RegExp(
      `^\\s*(?:${pattern})\\s*(?::|#|=|-(?=\\s)|\\s)\\s*(.+?)\\s*$`,
      'iu',
    ).exec(line);
    const value = match?.[1] ? normalizeValue(match[1], requiresDigit) : null;

    if (value) {
      return { field, value };
    }
  }

  return null;
}

function matchStandaloneLabel(line: string): LabelPattern | null {
  for (const item of labelPatterns) {
    const { pattern } = item;
    if (new RegExp(`^\\s*(?:${pattern})\\s*:?\\s*$`, 'iu').test(line)) {
      return item;
    }
  }

  return null;
}

/** Extracts only identifiers supported by an explicit label on the same or immediately prior line. */
export function parseProductLabel(text: string): ProductLabelCandidates {
  const lines = text.split(/\r?\n/u).map((line) => line.trim());
  const candidates: ProductLabelCandidates = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    const labeledValue = matchLabeledValue(line);
    if (labeledValue && !candidates[labeledValue.field]) {
      candidates[labeledValue.field] = labeledValue.value;
      continue;
    }

    const standaloneField = matchStandaloneLabel(line);
    const nextLine = lines[index + 1];
    const nextValue =
      standaloneField && nextLine ? normalizeValue(nextLine, standaloneField.requiresDigit) : null;
    if (standaloneField && nextValue && !candidates[standaloneField.field]) {
      candidates[standaloneField.field] = nextValue;
      index += 1;
    }
  }

  return candidates;
}
