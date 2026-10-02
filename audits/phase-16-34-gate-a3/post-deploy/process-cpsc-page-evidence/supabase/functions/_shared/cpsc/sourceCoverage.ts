import {
  CPSC_HTML_EXTRACTOR_VERSION,
  CPSC_STRUCTURE_CENSUS_VERSION,
  type CpscCensusTable,
  type CpscStructureCensus,
} from './htmlExtractor.ts';
import {
  CPSC_PAGE_PARSER_VERSION,
  cpscDescriptionSentences,
  interpretCpscPage,
  normalizeCpscPage,
  semanticCpscRevision,
  restrictiveBlockers,
  type CpscCellInterpretation,
  type CpscDisposition,
  type CpscParsedRecord,
  type CpscParsedStructure,
  type CpscProposal,
  type CpscRecordEffect,
  type StructuredCpscPage,
} from './pageEvidence.ts';

/**
 * Phase 16.13 source-coverage ledger. Every authoritative record of the evidence
 * region (each description sentence, each DOM table row, any content outside
 * those structures) receives exactly one disposition, and the record count per
 * structure comes from the independent DOM census, not from the parser. A
 * negative conclusion is allowed only when the ledger proves the rule universe
 * is complete; a positive proposal only when nothing unresolved could restrict it.
 */
export const CPSC_COVERAGE_SCHEMA_V1 = 'cpsc_source_coverage_v1';
export const CPSC_COVERAGE_LEDGER_VERSION = 'phase-16.13-coverage-v1';

export type CpscCoverageStatus = 'complete' | 'partial' | 'unresolved';

export type CpscLedgerRecord = Omit<CpscParsedRecord, 'cells'> & {
  extraction: 'extracted' | 'failed';
  cells: CpscCellInterpretation[];
};

export type CpscLedgerStructure = {
  structureId: string;
  kind: 'prose' | 'table' | 'region';
  sectionIdentity: 'description' | 'recall-details';
  tableIndex: number | null;
  tableIdentity: string | null;
  authoritativeRecordCount: number;
  anomalies: string[];
  records: CpscLedgerRecord[];
};

export type CpscCoverageLedger = {
  schema: typeof CPSC_COVERAGE_SCHEMA_V1;
  ledgerVersion: string;
  parserVersion: string;
  extractorVersion: string;
  censusVersion: string;
  sourceSemanticRevision: string;
  structures: CpscLedgerStructure[];
};

export type CpscCoverageSummary = {
  structuralStatus: CpscCoverageStatus;
  criterionStatus: CpscCoverageStatus;
  coverageStatus: CpscCoverageStatus;
  positiveStatus: 'independent' | 'blocked';
  negativeEvidenceEligible: boolean;
  authoritativeRecords: number;
  accountedRecords: number;
  dispositionCounts: Record<CpscDisposition, number>;
  reviewableRelations: string[];
  blockers: string[];
  interpretationFingerprint: string;
  coverageFingerprint: string;
};

export const CPSC_DISPOSITIONS: readonly CpscDisposition[] = [
  'parsed_reviewable',
  'parsed_deferred',
  'unresolved',
  'unsupported',
  'ignored_non_safety',
];

/** Anomalies that mean the parser's rows cannot be mapped one-to-one onto the document. */
export const CPSC_ACCOUNTING_ANOMALIES: readonly string[] = [
  'row_count_mismatch',
  'empty_header_row',
  'prose_reconstruction_mismatch',
  'table_count_mismatch',
];

const encoder = new TextEncoder();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort(utf8Compare)
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Byte-wise UTF-8 order, identical to PostgreSQL `collate "C"`. */
function utf8Compare(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function failed(
  record: Pick<CpscLedgerRecord, 'ordinal' | 'recordIdentity' | 'rowIdentity'>,
  reason: string,
  effect: CpscRecordEffect = 'restrictive',
): CpscLedgerRecord {
  return {
    ...record,
    extraction: 'failed',
    disposition: 'unresolved',
    effect,
    relation: null,
    reason,
    cells: [],
  };
}

function extracted(record: CpscParsedRecord): CpscLedgerRecord {
  return { ...record, extraction: 'extracted' };
}

/** Table-level structure problems found by the census. */
function tableAnomalies(census: CpscCensusTable, extractedRows: number): string[] {
  const anomalies = new Set<string>();
  const rows = census.rows;
  if (census.nestedTables > 0) anomalies.add('nested_table');
  const withCells = rows.filter((row) => row.cells > 0).length;
  if (withCells !== extractedRows) anomalies.add('row_count_mismatch');
  if (rows.length && rows[0]!.cells === 0) anomalies.add('empty_header_row');
  if (rows.filter((row) => row.inHead).length > 1) anomalies.add('multiple_header_rows');
  if (rows.slice(1).some((row) => row.inHead || row.headerCells > 0)) {
    anomalies.add('header_cells_in_body');
  }
  if (rows.length && rows[0]!.colspanCells > 0) anomalies.add('merged_header_cells');
  rows.forEach((row, index) => {
    if (row.rowspans.some((span) => index + span > rows.length)) anomalies.add('rowspan_overflow');
  });
  return [...anomalies].sort(utf8Compare);
}

function tableStructure(
  parsed: CpscParsedStructure,
  census: CpscCensusTable | undefined,
  extractedRows: number,
): CpscLedgerStructure {
  const base = {
    structureId: parsed.structureId,
    kind: 'table' as const,
    sectionIdentity: 'description' as const,
    tableIndex: parsed.tableIndex,
    tableIdentity: parsed.tableIdentity,
  };
  if (!census) {
    return {
      ...base,
      authoritativeRecordCount: parsed.records.length,
      anomalies: ['table_count_mismatch'],
      records: parsed.records.map((record) => failed(record, 'table missing from the census')),
    };
  }
  const domRows = census.rows;
  const authoritativeRecordCount = Math.max(domRows.length - 1, 0);
  const anomalies = tableAnomalies(census, extractedRows);
  const records: CpscLedgerRecord[] = [];
  if (anomalies.length) {
    // The rows cannot be trusted as a complete, correctly shaped set.
    const parsedByOrdinal = parsed.records;
    for (let ordinal = 0; ordinal < authoritativeRecordCount; ordinal += 1) {
      const counterpart = parsedByOrdinal[ordinal];
      records.push(
        failed(
          {
            ordinal,
            recordIdentity: counterpart?.recordIdentity ?? `dom-row:${ordinal}`,
            rowIdentity: counterpart?.rowIdentity ?? null,
          },
          `table structure anomaly: ${anomalies.join(', ')}`,
        ),
      );
    }
    return { ...base, authoritativeRecordCount, anomalies, records };
  }
  let next = 0;
  domRows.slice(1).forEach((row, ordinal) => {
    if (row.cells === 0) {
      records.push(
        failed(
          { ordinal, recordIdentity: `dom-row:${ordinal}`, rowIdentity: null },
          'row has no cells',
          'none',
        ),
      );
      return;
    }
    const counterpart = parsed.records[next++]!;
    const record = extracted({ ...counterpart, ordinal });
    if (row.colspanCells > 0 && record.disposition !== 'ignored_non_safety') {
      records.push({
        ...record,
        disposition: 'unresolved',
        effect: 'additive',
        relation: null,
        reason: 'merged cells across columns',
      });
      return;
    }
    records.push(record);
  });
  return { ...base, authoritativeRecordCount, anomalies, records };
}

/** Pure, deterministic status computation shared by the worker and the database. */
export async function summarizeCpscCoverageLedger(
  ledger: CpscCoverageLedger,
): Promise<CpscCoverageSummary> {
  const records = ledger.structures.flatMap((structure) => structure.records);
  const dispositionCounts = Object.fromEntries(
    CPSC_DISPOSITIONS.map((disposition) => [
      disposition,
      records.filter((record) => record.disposition === disposition).length,
    ]),
  ) as Record<CpscDisposition, number>;
  const authoritativeRecords = ledger.structures.reduce(
    (sum, structure) => sum + structure.authoritativeRecordCount,
    0,
  );
  const accounted = ledger.structures.every(
    (structure) =>
      structure.records.length === structure.authoritativeRecordCount &&
      !structure.anomalies.some((anomaly) => CPSC_ACCOUNTING_ANOMALIES.includes(anomaly)),
  );
  const structuralStatus: CpscCoverageStatus = !accounted
    ? 'unresolved'
    : ledger.structures.some((structure) => structure.anomalies.length) ||
        records.some((record) => record.extraction === 'failed')
      ? 'partial'
      : 'complete';
  const blocking = records.filter((record) =>
    ['parsed_deferred', 'unresolved', 'unsupported'].includes(record.disposition),
  );
  const reviewableRows = ledger.structures
    .filter((structure) => structure.kind === 'table')
    .flatMap((structure) => structure.records)
    .filter((record) => record.disposition === 'parsed_reviewable');
  const criterionStatus: CpscCoverageStatus = !reviewableRows.length
    ? 'unresolved'
    : blocking.length
      ? 'partial'
      : 'complete';
  const coverageStatus: CpscCoverageStatus =
    structuralStatus === 'complete' && criterionStatus === 'complete'
      ? 'complete'
      : structuralStatus === 'unresolved' || criterionStatus === 'unresolved'
        ? 'unresolved'
        : 'partial';
  const blockers = ledger.structures.flatMap((structure) =>
    structure.records
      .filter(
        (record) =>
          record.effect === 'restrictive' &&
          ['parsed_deferred', 'unresolved', 'unsupported'].includes(record.disposition),
      )
      .map((record) => `${structure.structureId}#${record.ordinal}`),
  );
  const positiveStatus =
    blockers.length || structuralStatus === 'unresolved' ? 'blocked' : 'independent';
  const interpretationFingerprint = await cpscCoverageInterpretationFingerprint(ledger);
  const coverageFingerprint = await sha256(
    canonical({
      schema: CPSC_COVERAGE_SCHEMA_V1,
      ledgerVersion: ledger.ledgerVersion,
      parserVersion: ledger.parserVersion,
      extractorVersion: ledger.extractorVersion,
      censusVersion: ledger.censusVersion,
      interpretationFingerprint,
    }),
  );
  return {
    structuralStatus,
    criterionStatus,
    coverageStatus,
    positiveStatus,
    negativeEvidenceEligible: coverageStatus === 'complete' && positiveStatus === 'independent',
    authoritativeRecords,
    accountedRecords: records.length,
    dispositionCounts,
    reviewableRelations: reviewableRows
      .map((record) => record.relation!)
      .filter(Boolean)
      .sort(utf8Compare),
    blockers,
    interpretationFingerprint,
    coverageFingerprint,
  };
}

/**
 * Semantic identity of the interpretation: source revision, structures, record
 * identities, dispositions, effects, and rule-set relations. Free-text reasons,
 * timestamps, database ids, and reviewer identity are never inputs.
 */
export async function cpscCoverageInterpretationFingerprint(
  ledger: CpscCoverageLedger,
): Promise<string> {
  return sha256(
    canonical({
      schema: 'cpsc_source_coverage_interpretation_v1',
      sourceSemanticRevision: ledger.sourceSemanticRevision,
      structures: ledger.structures.map((structure) => ({
        ...structure,
        records: structure.records.map(({ reason: _reason, ...record }) => record),
      })),
    }),
  );
}

export type CpscSourceCoverageResult = {
  ledger: CpscCoverageLedger;
  summary: CpscCoverageSummary;
  /** Proposals that survive the census; empty when positives are blocked. */
  candidates: CpscProposal[];
  unresolved: string[];
};

/**
 * Builds the ledger for one extracted page against its structural census. The
 * census, not the parser, fixes how many records each structure must account for.
 */
export async function buildCpscSourceCoverage(
  page: StructuredCpscPage,
  census: CpscStructureCensus,
  revision?: Awaited<ReturnType<typeof semanticCpscRevision>>,
): Promise<CpscSourceCoverageResult> {
  const interpretation = await interpretCpscPage(page, revision);
  const normalized = normalizeCpscPage(page);
  const unresolved = [...interpretation.unresolved];
  const structures: CpscLedgerStructure[] = [];

  const prose = interpretation.structures.find((structure) => structure.kind === 'prose')!;
  const rebuilt = cpscDescriptionSentences(normalized.description).join(' ');
  const proseAnomalies =
    rebuilt === normalized.description ? [] : ['prose_reconstruction_mismatch'];
  structures.push({
    structureId: prose.structureId,
    kind: 'prose',
    sectionIdentity: 'description',
    tableIndex: null,
    tableIdentity: null,
    authoritativeRecordCount: prose.records.length,
    anomalies: proseAnomalies,
    records: proseAnomalies.length
      ? prose.records.map((record) => failed(record, 'description text not fully accounted'))
      : prose.records.map(extracted),
  });

  const tables = interpretation.structures.filter((structure) => structure.kind === 'table');
  for (const parsed of tables) {
    const index = parsed.tableIndex!;
    structures.push(
      tableStructure(parsed, census.descriptionTables[index], normalized.tables[index]!.length),
    );
  }
  for (let index = tables.length; index < census.descriptionTables.length; index += 1) {
    structures.push({
      structureId: `description/census-table/${index}`,
      kind: 'table',
      sectionIdentity: 'description',
      tableIndex: index,
      tableIdentity: null,
      authoritativeRecordCount: 1,
      anomalies: ['table_count_mismatch'],
      records: [
        failed(
          { ordinal: 0, recordIdentity: `census-table:${index}`, rowIdentity: null },
          'table not extracted',
        ),
      ],
    });
  }
  if (census.descriptionUnaccountedText) {
    unresolved.push('description content outside paragraphs and tables');
    structures.push({
      structureId: 'description/unaccounted',
      kind: 'region',
      sectionIdentity: 'description',
      tableIndex: null,
      tableIdentity: null,
      authoritativeRecordCount: 1,
      anomalies: [],
      records: [
        failed(
          {
            ordinal: 0,
            recordIdentity: await sha256(
              canonical(['description/unaccounted', census.descriptionUnaccountedText]),
            ),
            rowIdentity: null,
          },
          'content outside paragraphs and tables',
        ),
      ],
    });
  }
  if (census.detailTablesOutsideDescription > 0) {
    unresolved.push('recall-details tables outside the description');
    structures.push({
      structureId: 'recall-details/tables',
      kind: 'region',
      sectionIdentity: 'recall-details',
      tableIndex: null,
      tableIdentity: null,
      authoritativeRecordCount: census.detailTablesOutsideDescription,
      anomalies: [],
      records: Array.from({ length: census.detailTablesOutsideDescription }, (_, ordinal) =>
        failed(
          { ordinal, recordIdentity: `recall-details-table:${ordinal}`, rowIdentity: null },
          'table outside the description is not parsed',
        ),
      ),
    });
  }

  const ledger: CpscCoverageLedger = {
    schema: CPSC_COVERAGE_SCHEMA_V1,
    ledgerVersion: CPSC_COVERAGE_LEDGER_VERSION,
    parserVersion: CPSC_PAGE_PARSER_VERSION,
    extractorVersion: CPSC_HTML_EXTRACTOR_VERSION,
    censusVersion: CPSC_STRUCTURE_CENSUS_VERSION,
    sourceSemanticRevision: interpretation.semanticHash,
    structures,
  };
  const provisional = await summarizeCpscCoverageLedger(ledger);
  if (provisional.positiveStatus === 'blocked') {
    // No proposal may survive: every would-be conjunction becomes unresolved.
    for (const structure of ledger.structures) {
      structure.records = structure.records.map((record) =>
        record.disposition === 'parsed_reviewable'
          ? {
              ...record,
              disposition: 'unresolved',
              relation: null,
              reason: 'blocked by an unresolved restriction on the page',
            }
          : record,
      );
    }
  }
  const summary = await summarizeCpscCoverageLedger(ledger);
  const served = new Set(summary.reviewableRelations);
  const candidates =
    summary.positiveStatus === 'blocked' || restrictiveBlockers(interpretation.structures).length
      ? []
      : interpretation.candidates.filter((candidate) => served.has(candidate.conjunctionKey));
  return { ledger, summary, candidates, unresolved };
}
