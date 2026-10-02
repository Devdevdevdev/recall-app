import { canonicalCpscUrl, normalizeCpscNumber } from './identity.ts';

export const CPSC_PAGE_PARSER_VERSION = 'phase-16.13-structured-v2';
export type StructuredCpscPage = {
  recallNumber: string;
  canonicalUrl: string;
  title: string;
  publicationDate: string;
  description: string;
  recallDetails: Record<string, string>;
  tables: string[][][];
};

export type CpscProposal = {
  status: 'unreviewed';
  kind: 'model_exact' | 'model_set' | 'date_code_exact' | 'date_code_set';
  operator: 'exact' | 'in';
  value: string | string[];
  conjunctionKey: string;
  sourceAddress: Record<string, string>;
  authoritativeExcerpt: string;
};

function norm(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Reads every code in a list such as "2510 (Oct-2025), 2511 (Nov-2025) and 2512 (Dec-2025)".
 * Any token outside that grammar yields null, so an amended list can never lose a code.
 */
function listedDateCodes(list: string): string[] | null {
  const items = list.split(/\s*,\s*(?:and\s+)?|\s+and\s+/u);
  const codes: string[] = [];
  for (const item of items) {
    const match = /^(\d{4})(?: \([A-Z][a-z]{2}-\d{4}\))?$/u.exec(item);
    if (!match) return null;
    codes.push(match[1]!);
  }
  return new Set(codes).size === codes.length ? codes : null;
}

export function normalizeCpscPage(page: StructuredCpscPage): StructuredCpscPage {
  return {
    recallNumber: normalizeCpscNumber(page.recallNumber),
    canonicalUrl: canonicalCpscUrl(page.canonicalUrl),
    title: norm(page.title),
    publicationDate: page.publicationDate,
    description: norm(page.description),
    recallDetails: Object.fromEntries(
      Object.entries(page.recallDetails)
        .map(([key, value]) => [norm(key).toLowerCase(), norm(value)] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    tables: page.tables.map((table) => table.map((row) => row.map(norm))),
  };
}

export async function semanticCpscRevision(page: StructuredCpscPage) {
  const normalized = normalizeCpscPage(page);
  const semanticHash = await hash(canonical(normalized));
  const sections = {
    title: await hash(normalized.title),
    description: await hash(normalized.description),
    recallDetails: await hash(canonical(normalized.recallDetails)),
  };
  const tableIdentities = await Promise.all(
    normalized.tables.map(async (table, index) => ({
      identity: `description/table/${index}/${await hash(canonical(table[0] ?? []))}`,
      rows: await Promise.all(
        table.slice(1).map(async (row) => ({
          identity: await hash(canonical(row)),
          evidence: row,
        })),
      ),
    })),
  );
  return {
    normalized,
    semanticHash,
    sections,
    tableIdentities,
    parserVersion: CPSC_PAGE_PARSER_VERSION,
  };
}

type Column = 'model' | 'date_code' | 'descriptive' | 'deferred' | 'unknown';

const MODEL_HEADERS = new Set(['model', 'model no', 'model number', 'model #']);
const DATE_CODE_HEADERS = new Set(['date code', 'date codes']);
const DESCRIPTIVE_HEADERS = new Set([
  'model description',
  'description',
  'product',
  'product name',
  'product description',
  'name',
  'color',
  'colour',
]);
// Criterion classes outside the current human-review contract. A table that
// carries one is preserved as evidence but never yields a partial proposal.
const DEFERRED_HEADERS = new Map([
  ['production date range', 'production_date_range'],
  ['production date', 'production_date_range'],
  ['manufacture date', 'production_date_range'],
  ['manufacturing date', 'production_date_range'],
  ['serial number', 'serial_number'],
  ['serial numbers', 'serial_number'],
  ['serial number range', 'serial_number'],
  ['lot number', 'lot_number'],
  ['lot code', 'lot_number'],
  ['upc', 'gtin'],
  ['upc code', 'gtin'],
]);
const IDENTIFIER = /^[A-Z0-9][A-Z0-9./-]{0,63}$/u;
// Words that restrict which units of a listed product are recalled.
const RESTRICTION =
  /\b(?:only|some|certain|manufactured (?:between|from|in|on|before|after|during)|produced (?:between|from|in|on|during)|production dates?|date codes?|serial numbers?|lot (?:numbers?|codes?)|batch (?:numbers?|codes?)|sold (?:between|from|during))\b/iu;
// Sentences that say where an identifier is printed do not restrict eligibility.
const LOCATION = /\b(?:is|are) (?:located|printed|found|stamped|molded|embossed)\b/iu;
const DATE_CODE_RESTRICTION =
  /^Only (.+?) with (?:manufacturing )?date codes? (?:of )?(.+?) (?:are|is) included in (?:this|the) recall\.$/u;

function headerKey(cell: string): string {
  return norm(cell).toLowerCase().replace(/\.$/u, '');
}

function columnKind(cell: string): Column {
  const key = headerKey(cell);
  if (MODEL_HEADERS.has(key)) return 'model';
  if (DATE_CODE_HEADERS.has(key)) return 'date_code';
  if (DESCRIPTIVE_HEADERS.has(key)) return 'descriptive';
  if (DEFERRED_HEADERS.has(key)) return 'deferred';
  return 'unknown';
}

/** The description split into sentence records; joined by one space they rebuild it. */
export function cpscDescriptionSentences(text: string): string[] {
  return sentences(text);
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z“"(])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

type Restriction = { sentence: string; dateCodes: string[] | null };

/** Every restriction sentence must be understood, or the page yields nothing. */
function restrictionsOf(description: string): Restriction[] {
  return sentences(description)
    .filter((sentence) => RESTRICTION.test(sentence) && !LOCATION.test(sentence))
    .map((sentence) => {
      const match = DATE_CODE_RESTRICTION.exec(sentence);
      return { sentence, dateCodes: match ? listedDateCodes(match[2]!) : null };
    });
}

function identifierList(cell: string): string[] | null {
  const values = cell.split(/\s*,\s*/u);
  if (!values.every((value) => IDENTIFIER.test(value)) || values.join(', ') !== cell) return null;
  return new Set(values).size === values.length ? values : null;
}

export type CpscDisposition =
  'parsed_reviewable' | 'parsed_deferred' | 'unresolved' | 'unsupported' | 'ignored_non_safety';

/**
 * What an unaccounted record could do to the rule universe. `additive` records
 * can only add alternatives (they block a negative conclusion); `restrictive`
 * records could narrow other rules (they also block every positive proposal).
 */
export type CpscRecordEffect = 'none' | 'additive' | 'restrictive';

export type CpscCellInterpretation = {
  column: string;
  criterionClass: string;
  status: 'recognized' | 'deferred' | 'unsupported' | 'invalid' | 'descriptive';
};

export type CpscParsedRecord = {
  ordinal: number;
  recordIdentity: string;
  rowIdentity: string | null;
  disposition: CpscDisposition;
  effect: CpscRecordEffect;
  relation: string | null;
  reason: string;
  cells: CpscCellInterpretation[];
};

export type CpscParsedStructure = {
  structureId: string;
  kind: 'prose' | 'table';
  tableIndex: number | null;
  tableIdentity: string | null;
  header: string[];
  records: CpscParsedRecord[];
};

export type CpscPageInterpretation = {
  semanticHash: string;
  structures: CpscParsedStructure[];
  candidates: CpscProposal[];
  unresolved: string[];
};

const PROSE_IDENTIFIER_CONTEXT =
  /\b(?:models?|model (?:numbers?|nos?\.?)|items? (?:numbers?|nos?\.?)|sku|style (?:numbers?|nos?\.?)|part (?:numbers?|nos?\.?)|catalog (?:numbers?|nos?\.?)|upcs?|serial (?:numbers?|nos?\.?)|lot (?:numbers?|codes?))\b/iu;
const PROSE_IDENTIFIER_TOKEN =
  /(?<![A-Za-z0-9])(?=[A-Z0-9./-]*[0-9])[A-Z0-9][A-Z0-9./-]{2,}(?![A-Za-z0-9])/u;

function proseRecord(
  ordinal: number,
  recordIdentity: string,
  disposition: CpscDisposition,
  effect: CpscRecordEffect,
  reason: string,
  relation: string | null = null,
): CpscParsedRecord {
  return {
    ordinal,
    recordIdentity,
    rowIdentity: null,
    disposition,
    effect,
    relation,
    reason,
    cells: [],
  };
}

/**
 * Gives every description sentence and every extracted table row exactly one
 * disposition. Proposals come only from explicit document structure: a model
 * column paired row-by-row with a date-code column, or a model table governed by
 * exactly one parsed "Only ... with date codes of ... are included" sentence.
 * Each table row is one conjunction. Anything else is recorded, never guessed.
 */
export async function interpretCpscPage(
  page: StructuredCpscPage,
  revision?: Awaited<ReturnType<typeof semanticCpscRevision>>,
): Promise<CpscPageInterpretation> {
  const { normalized, semanticHash, tableIdentities } =
    revision ?? (await semanticCpscRevision(page));
  const candidates: CpscProposal[] = [];
  const unresolved: string[] = [];
  const restrictions = restrictionsOf(normalized.description);
  const unsupported = restrictions.filter((item) => !item.dateCodes);
  const dateRestrictions = restrictions.filter((item) => item.dateCodes);
  for (const item of unsupported) unresolved.push(`unsupported restriction: ${item.sentence}`);
  if (dateRestrictions.length > 1) unresolved.push('multiple date-code restrictions');

  type TableClass =
    | { kind: 'empty' }
    | { kind: 'plan'; model: number; dateCode: number | null }
    | { kind: 'deferred'; model: number | null; deferred: string[] }
    | { kind: 'unsupported'; effect: CpscRecordEffect; reason: string };
  const classes: TableClass[] = [];
  const plans: { tableIndex: number; model: number; dateCode: number | null }[] = [];
  for (const [tableIndex, table] of normalized.tables.entries()) {
    const header = table[0];
    if (!header) {
      classes.push({ kind: 'empty' });
      continue;
    }
    const kinds = header.map(columnKind);
    const deferred = header
      .map((cell) => DEFERRED_HEADERS.get(headerKey(cell)))
      .filter((value): value is string => Boolean(value));
    const models = kinds.flatMap((kind, index) => (kind === 'model' ? [index] : []));
    const dateCodes = kinds.flatMap((kind, index) => (kind === 'date_code' ? [index] : []));
    if (deferred.length) {
      unresolved.push(
        `${[...new Set(deferred)].join('+')} deferred: ${table.length - 1} paired rows`,
      );
      classes.push({
        kind: 'deferred',
        model: models.length === 1 && !kinds.includes('unknown') ? models[0]! : null,
        deferred: [...new Set(deferred)],
      });
      continue;
    }
    if (!models.length) {
      // Phase 16.13: a table without a model column is never skipped silently.
      unresolved.push('table without a reviewable model column');
      classes.push(
        dateCodes.length || kinds.includes('unknown')
          ? { kind: 'unsupported', effect: 'restrictive', reason: 'unrecognized table columns' }
          : {
              kind: 'unsupported',
              effect: 'additive',
              reason: 'product listing without a reviewable identifier',
            },
      );
      continue;
    }
    if (models.length !== 1 || dateCodes.length > 1 || kinds.includes('unknown')) {
      unresolved.push('unsupported model table columns');
      classes.push({
        kind: 'unsupported',
        effect: 'restrictive',
        reason: 'unsupported model table columns',
      });
      continue;
    }
    const plan = { tableIndex, model: models[0]!, dateCode: dateCodes[0] ?? null };
    plans.push(plan);
    classes.push({ kind: 'plan', model: plan.model, dateCode: plan.dateCode });
  }
  const restriction = dateRestrictions.length === 1 ? dateRestrictions[0]! : null;
  const restrictedTables = plans.filter((plan) => plan.dateCode === null);
  const restrictionGoverns =
    restriction && plans.length === 1 && restrictedTables.length === 1
      ? tableIdentities[restrictedTables[0]!.tableIndex]!.identity
      : null;
  if (restriction && !restrictionGoverns) {
    unresolved.push('date-code restriction does not identify exactly one model table');
  }
  for (const plan of plans) {
    if (plan.dateCode === null && !restriction) {
      unresolved.push('model table without explicit restriction semantics');
    }
  }

  // Description prose: every sentence is one record.
  const proseRecords: CpscParsedRecord[] = [];
  for (const [ordinal, sentence] of sentences(normalized.description).entries()) {
    const identity = await hash(canonical(['description/prose', sentence]));
    const restricting = RESTRICTION.test(sentence) && !LOCATION.test(sentence);
    if (restricting) {
      const parsed = dateRestrictions.find((item) => item.sentence === sentence);
      if (!parsed) {
        proseRecords.push(
          proseRecord(ordinal, identity, 'unsupported', 'restrictive', 'unsupported restriction'),
        );
      } else if (parsed === restriction && restrictionGoverns) {
        proseRecords.push(
          proseRecord(
            ordinal,
            identity,
            'parsed_reviewable',
            'none',
            'date-code restriction governing one model table',
            `governs:${restrictionGoverns}`,
          ),
        );
      } else {
        proseRecords.push(
          proseRecord(
            ordinal,
            identity,
            'unresolved',
            'restrictive',
            'date-code restriction without exactly one governed model table',
          ),
        );
      }
    } else if (PROSE_IDENTIFIER_CONTEXT.test(sentence) && PROSE_IDENTIFIER_TOKEN.test(sentence)) {
      unresolved.push(`identifier prose not parsed: ${sentence}`);
      proseRecords.push(
        proseRecord(ordinal, identity, 'unresolved', 'additive', 'identifier-bearing prose'),
      );
    } else {
      proseRecords.push(
        proseRecord(ordinal, identity, 'ignored_non_safety', 'none', 'no eligibility content'),
      );
    }
  }
  const structures: CpscParsedStructure[] = [
    {
      structureId: 'description/prose',
      kind: 'prose',
      tableIndex: null,
      tableIdentity: null,
      header: [],
      records: proseRecords,
    },
  ];

  for (const [tableIndex, table] of normalized.tables.entries()) {
    const tableClass = classes[tableIndex]!;
    const tableIdentity = tableIdentities[tableIndex]!.identity;
    const header = table[0] ?? [];
    const records: CpscParsedRecord[] = [];
    const seen = new Set<string>();
    for (const [rowIndex, row] of table.slice(1).entries()) {
      const rowIdentity = tableIdentities[tableIndex]!.rows[rowIndex]!.identity;
      const conjunctionKey = `${tableIdentity}/${rowIdentity}`;
      const base = { ordinal: rowIndex, recordIdentity: rowIdentity, rowIdentity };
      const cellsOf = (status: (index: number) => CpscCellInterpretation['status']) =>
        header.map((column, index) => ({
          column: headerKey(column),
          criterionClass:
            columnKind(column) === 'deferred'
              ? DEFERRED_HEADERS.get(headerKey(column))!
              : columnKind(column),
          status: status(index),
        }));
      const reject = (
        disposition: CpscDisposition,
        effect: CpscRecordEffect,
        reason: string,
        cells: CpscCellInterpretation[] = [],
      ) => records.push({ ...base, disposition, effect, relation: null, reason, cells });
      const ambiguous = () => {
        if (tableClass.kind === 'plan') {
          unresolved.push(
            tableClass.dateCode === null ? 'ambiguous model row' : 'ambiguous model/date-code row',
          );
        }
      };
      if (row.length !== header.length) {
        ambiguous();
        reject('unresolved', 'additive', 'row width differs from the header');
        continue;
      }
      if (row.every((cell) => cell === '')) {
        ambiguous();
        reject('unresolved', 'none', 'blank row');
        continue;
      }
      if (seen.has(rowIdentity)) {
        reject('unresolved', 'none', 'duplicate row');
        continue;
      }
      seen.add(rowIdentity);
      if (tableClass.kind === 'unsupported') {
        reject(
          'unsupported',
          tableClass.effect,
          tableClass.reason,
          cellsOf(() => 'unsupported'),
        );
        continue;
      }
      if (tableClass.kind === 'deferred') {
        const modelOk =
          tableClass.model !== null && identifierList(row[tableClass.model] ?? '') !== null;
        const cells = cellsOf((index) => {
          const kind = columnKind(header[index]!);
          if (kind === 'deferred') return 'deferred';
          if (kind === 'model')
            return index === tableClass.model && modelOk ? 'recognized' : 'invalid';
          return kind === 'descriptive' ? 'descriptive' : 'unsupported';
        });
        records.push({
          ...base,
          disposition: 'parsed_deferred',
          // A deferred table with its own model column only adds alternatives.
          effect: tableClass.model === null ? 'restrictive' : 'additive',
          relation: null,
          reason: `${tableClass.deferred.join('+')} criterion deferred`,
          cells,
        });
        continue;
      }
      if (tableClass.kind !== 'plan') continue;
      const plan = tableClass;
      if (plan.dateCode === null && !restriction) {
        reject(
          'unsupported',
          'additive',
          'model table without explicit restriction semantics',
          cellsOf(() => 'unsupported'),
        );
        continue;
      }
      if (plan.dateCode === null && !restrictionGoverns) {
        reject('unresolved', 'restrictive', 'ambiguous restriction governance');
        continue;
      }
      const models = identifierList(row[plan.model] ?? '');
      const dateCodes =
        plan.dateCode === null ? restriction!.dateCodes : identifierList(row[plan.dateCode] ?? '');
      const cells = cellsOf((index) => {
        if (index === plan.model) return models ? 'recognized' : 'invalid';
        if (index === plan.dateCode) return dateCodes ? 'recognized' : 'invalid';
        return 'descriptive';
      });
      if (!models || !dateCodes) {
        unresolved.push(
          plan.dateCode === null ? 'ambiguous model row' : 'ambiguous model/date-code row',
        );
        reject('unresolved', 'additive', 'ambiguous identifier cell', cells);
        continue;
      }
      records.push({
        ...base,
        disposition: 'parsed_reviewable',
        effect: 'none',
        relation: conjunctionKey,
        reason: 'model conjunction',
        cells,
      });
      const excerpt = row.join(' | ');
      const evidenceFingerprint = await hash(
        canonical(plan.dateCode === null ? [row, restriction!.sentence] : row),
      );
      const address = (fieldIdentity: string) => ({
        source: 'cpsc',
        recallNumber: normalized.recallNumber,
        canonicalUrl: normalized.canonicalUrl,
        sourceSemanticRevision: semanticHash,
        sectionIdentity: 'description',
        tableIdentity,
        fieldIdentity,
        rowIdentity,
        evidenceFingerprint,
      });
      candidates.push({
        status: 'unreviewed',
        kind: models.length === 1 ? 'model_exact' : 'model_set',
        operator: models.length === 1 ? 'exact' : 'in',
        value: models.length === 1 ? models[0]! : models,
        conjunctionKey,
        sourceAddress: address(headerKey(header[plan.model]!)),
        authoritativeExcerpt: excerpt,
      });
      candidates.push({
        status: 'unreviewed',
        kind: plan.dateCode === null || dateCodes.length > 1 ? 'date_code_set' : 'date_code_exact',
        operator: plan.dateCode === null || dateCodes.length > 1 ? 'in' : 'exact',
        value: plan.dateCode === null || dateCodes.length > 1 ? dateCodes : dateCodes[0]!,
        conjunctionKey,
        sourceAddress: address(
          plan.dateCode === null ? 'date codes' : headerKey(header[plan.dateCode]!),
        ),
        authoritativeExcerpt: plan.dateCode === null ? restriction!.sentence : excerpt,
      });
    }
    structures.push({
      structureId: tableIdentity,
      kind: 'table',
      tableIndex,
      tableIdentity,
      header,
      records,
    });
  }
  return { semanticHash, structures, candidates, unresolved };
}

/** Records that could narrow another rule. Any of them blocks every positive proposal. */
export function restrictiveBlockers(structures: readonly CpscParsedStructure[]): string[] {
  return structures.flatMap((structure) =>
    structure.records
      .filter(
        (record) =>
          record.effect === 'restrictive' &&
          record.disposition !== 'parsed_reviewable' &&
          record.disposition !== 'ignored_non_safety',
      )
      .map((record) => `${structure.structureId}#${record.ordinal}`),
  );
}

/**
 * Unreviewed proposals for one page. A proposal is emitted only when nothing
 * unresolved on the page could restrict it (positive independence).
 */
export async function proposeCpscTableCriteria(page: StructuredCpscPage): Promise<{
  candidates: CpscProposal[];
  unresolved: string[];
}> {
  const interpretation = await interpretCpscPage(page);
  return {
    candidates: restrictiveBlockers(interpretation.structures).length
      ? []
      : interpretation.candidates,
    unresolved: interpretation.unresolved,
  };
}
