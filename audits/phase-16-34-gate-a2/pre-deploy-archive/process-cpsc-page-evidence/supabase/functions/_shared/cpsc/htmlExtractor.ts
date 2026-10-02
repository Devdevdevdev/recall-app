import { HTML5_ENTITIES, INVALID_CHARREFS, INVALID_CODEPOINTS } from './htmlEntities.ts';
import { canonicalCpscUrl, normalizeCpscNumber } from './identity.ts';
import type { StructuredCpscPage } from './pageEvidence.ts';

/**
 * Deterministic CPSC recall-page extractor. It reproduces the frozen Phase 16.9
 * prototype (Python html.parser tree + field walk) so the frozen fixtures remain
 * the regression truth. It never executes scripts, follows links, or fetches.
 */

export const CPSC_HTML_EXTRACTOR_VERSION = 'phase-16.11-html-v1';

type HtmlNode = { tag: string; attrs: Record<string, string | null>; children: HtmlChild[] };
type HtmlChild = HtmlNode | string;

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
// Python 3.14 html.parser: raw text (no tags, no references) and RCDATA (references only).
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes']);
const RCDATA = new Set(['textarea', 'title']);
const MAX_DEPTH = 512;
const MAX_NODES = 200_000;

// Exactly the characters for which Python's str.isspace() (and re's \s) is true.
const WS =
  '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const WS_RUN = new RegExp(`[${WS}]+`, 'gu');
const WS_EDGE = new RegExp(`^[${WS}]+|[${WS}]+$`, 'gu');
const WS_SPLIT = new RegExp(`[${WS}]+`, 'u');

export function pythonNorm(value: string): string {
  return value.normalize('NFC').replace(WS_RUN, ' ').replace(WS_EDGE, '');
}

const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

/** Port of Python's html.unescape. */
export function unescapeHtml(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(CHARREF, (whole, reference: string) => {
    if (reference[0] === '#') {
      const hex = reference[1] === 'x' || reference[1] === 'X';
      const digits = reference.slice(hex ? 2 : 1).replace(/;$/u, '');
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (code in INVALID_CHARREFS) return INVALID_CHARREFS[code]!;
      if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return '�';
      if (INVALID_CODEPOINTS.has(code)) return '';
      return String.fromCodePoint(code);
    }
    const named = HTML5_ENTITIES[reference];
    if (named !== undefined) return named;
    for (let length = reference.length - 1; length > 1; length--) {
      const prefix = HTML5_ENTITIES[reference.slice(0, length)];
      if (prefix !== undefined) return prefix + reference.slice(length);
    }
    return whole;
  });
}

function isTagStart(html: string, index: number): boolean {
  return /[a-zA-Z]/u.test(html[index + 1] ?? '');
}

type StartTag = { tag: string; attrs: Record<string, string | null>; selfClosing: boolean };

const TAG_SPACE = /[\t\n\r\f ]/u;

/** Scans one start tag with the grammar of Python's html.parser `locatetagend`. */
function readStartTag(html: string, start: number): { tag: StartTag; end: number } | null {
  let index = start + 1;
  const nameStart = index;
  while (index < html.length && !/[\t\n\r\f />]/u.test(html[index]!)) index++;
  const tag = html.slice(nameStart, index).toLowerCase();
  const attrs: Record<string, string | null> = {};
  let slashBeforeEnd = false;
  while (index < html.length) {
    const char = html[index]!;
    if (char === '>') {
      return { tag: { tag, attrs, selfClosing: slashBeforeEnd }, end: index + 1 };
    }
    if (TAG_SPACE.test(char) || char === '/') {
      if (char === '/') slashBeforeEnd = true;
      index++;
      continue;
    }
    slashBeforeEnd = false;
    const attrStart = index;
    index++;
    while (index < html.length && !/[\t\n\r\f /=>]/u.test(html[index]!)) index++;
    const name = html.slice(attrStart, index).toLowerCase();
    let value: string | null = null;
    let lookahead = index;
    while (lookahead < html.length && TAG_SPACE.test(html[lookahead]!)) lookahead++;
    if (html[lookahead] === '=') {
      index = lookahead;
      while (html[index] === '=') index++;
      while (index < html.length && TAG_SPACE.test(html[index]!)) index++;
      const quote = html[index];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, index + 1);
        if (close < 0) return null;
        value = html.slice(index + 1, close);
        index = close + 1;
      } else {
        const valueStart = index;
        while (index < html.length && !/[>\t\n\r\f ]/u.test(html[index]!)) index++;
        value = html.slice(valueStart, index);
      }
      value = unescapeHtml(value);
    }
    attrs[name] = value;
  }
  return null;
}

export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: 'root', attrs: {}, children: [] };
  const stack: HtmlNode[] = [root];
  let nodes = 0;
  let index = 0;
  const data = (value: string) => {
    if (value) stack[stack.length - 1]!.children.push(value);
  };
  const push = (tag: StartTag) => {
    if (++nodes > MAX_NODES) throw new Error('CPSC page exceeds the node limit.');
    const node: HtmlNode = { tag: tag.tag, attrs: tag.attrs, children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!VOID.has(tag.tag)) {
      if (stack.length > MAX_DEPTH) throw new Error('CPSC page exceeds the nesting limit.');
      stack.push(node);
    }
  };
  const end = (tag: string) => {
    for (let depth = stack.length - 1; depth > 0; depth--) {
      if (stack[depth]!.tag === tag) {
        stack.length = depth;
        return;
      }
    }
  };
  while (index < html.length) {
    const next = html.indexOf('<', index);
    const textEnd = next < 0 ? html.length : next;
    if (textEnd > index) data(unescapeHtml(html.slice(index, textEnd)));
    if (next < 0) break;
    index = next;
    if (isTagStart(html, index)) {
      const parsed = readStartTag(html, index);
      if (!parsed) {
        data('<');
        index += 1;
        continue;
      }
      push(parsed.tag);
      index = parsed.end;
      if (parsed.tag.selfClosing) {
        end(parsed.tag.tag);
        continue;
      }
      if (RAW_TEXT.has(parsed.tag.tag) || RCDATA.has(parsed.tag.tag)) {
        const closer = new RegExp(`</${parsed.tag.tag}(?=[\\t\\n\\r\\f />])`, 'iu');
        const rest = html.slice(index);
        const found = closer.exec(rest);
        const raw = found ? rest.slice(0, found.index) : rest;
        data(RCDATA.has(parsed.tag.tag) ? unescapeHtml(raw) : raw);
        index += raw.length;
      }
      continue;
    }
    if (html.startsWith('</', index)) {
      const close = html.indexOf('>', index);
      if (close < 0) break;
      const name = /^<\/\s*([a-zA-Z][^\t\n\r\f />]*)/u.exec(html.slice(index, close + 1));
      if (name) end(name[1]!.toLowerCase());
      index = close + 1;
      continue;
    }
    if (html.startsWith('<!--', index)) {
      const close = html.indexOf('-->', index + 4);
      index = close < 0 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith('<?', index) || html.startsWith('<!', index)) {
      const close = html.indexOf('>', index);
      index = close < 0 ? html.length : close + 1;
      continue;
    }
    data('<');
    index += 1;
  }
  return root;
}

function nodeText(node: HtmlNode): string {
  return pythonNorm(
    node.children.map((child) => (typeof child === 'string' ? child : nodeText(child))).join(' '),
  );
}

function* descendants(node: HtmlNode, tag?: string): Generator<HtmlNode> {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (!tag || child.tag === tag) yield child;
    yield* descendants(child, tag);
  }
}

function hasClass(node: HtmlNode, name: string): boolean {
  return (node.attrs.class ?? '').split(WS_SPLIT).includes(name);
}

function fieldTitle(node: HtmlNode): HtmlNode | null {
  for (const candidate of descendants(node, 'div')) {
    if (hasClass(candidate, 'recall-product__field-title')) return candidate;
  }
  return null;
}

function labelOf(node: HtmlNode): string {
  return pythonNorm(nodeText(node)).replace(/:+$/u, '').toLowerCase();
}

function namedFields(root: HtmlNode): Map<string, HtmlNode> {
  const result = new Map<string, HtmlNode>();
  for (const row of descendants(root, 'div')) {
    if (!hasClass(row, 'view-rows')) continue;
    const label = fieldTitle(row);
    if (!label) continue;
    const key = labelOf(label);
    if (['description', 'recall number', 'recall date'].includes(key)) result.set(key, row);
  }
  return result;
}

function recallDetailSections(root: HtmlNode): Record<string, string> {
  let details: HtmlNode | null = null;
  for (const node of descendants(root, 'div')) {
    if (hasClass(node, 'recall-product__details')) {
      details = node;
      break;
    }
  }
  if (!details) throw new Error('CPSC page has no recall details section.');
  const sections: Record<string, string> = {};
  for (const wrapper of descendants(details, 'div')) {
    if (!hasClass(wrapper, 'recall-product__details-fields')) continue;
    const label = fieldTitle(wrapper);
    if (!label) continue;
    const labelText = nodeText(label);
    // Match the prototype: strip the label by its length, then normalize.
    sections[labelOf(label)] = pythonNorm(nodeText(wrapper).slice(labelText.length));
  }
  return sections;
}

/** Preserves explicit colspan/rowspan cells rather than inferring blank values. */
function tableRows(table: HtmlNode): string[][] {
  const rows: string[][] = [];
  const pending = new Map<number, { value: string; remaining: number }>();
  const drainPending = (cells: string[], column: number): number => {
    while (pending.has(column)) {
      const carry = pending.get(column)!;
      cells.push(carry.value);
      carry.remaining -= 1;
      if (carry.remaining === 0) pending.delete(column);
      column += 1;
    }
    return column;
  };
  for (const tr of descendants(table, 'tr')) {
    const cells: string[] = [];
    let column = 0;
    for (const cell of tr.children) {
      if (typeof cell === 'string' || (cell.tag !== 'td' && cell.tag !== 'th')) continue;
      column = drainPending(cells, column);
      const value = nodeText(cell);
      const colspan = spanOf(cell.attrs.colspan);
      const rowspan = spanOf(cell.attrs.rowspan);
      for (let copy = 0; copy < colspan; copy++) {
        cells.push(value);
        if (rowspan > 1) pending.set(column, { value, remaining: rowspan - 1 });
        column += 1;
      }
    }
    drainPending(cells, column);
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function spanOf(value: string | null | undefined): number {
  const raw = (value ?? '1').trim();
  if (!/^[0-9]{1,3}$/u.test(raw) || Number(raw) < 1 || Number(raw) > 50) {
    throw new Error('CPSC table span is unsupported.');
  }
  return Number(raw);
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function recallDate(fieldText: string): string {
  const match = /^Recall Date: ([A-Za-z]+) ([0-9]{1,2}), ([0-9]{4})$/u.exec(fieldText);
  const month = match ? MONTHS.indexOf(match[1]!.toLowerCase()) + 1 : 0;
  if (!match || month < 1) throw new Error('CPSC recall date is not in the official format.');
  const iso = `${match[3]}-${String(month).padStart(2, '0')}-${match[2]!.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) {
    throw new Error('CPSC recall date is invalid.');
  }
  return iso;
}

const UNDECODED_REFERENCE = /&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]{1,31});/u;

/**
 * Independent structural census of the evidence region. It walks the DOM with
 * its own rules (row ownership stops at nested tables; empty rows are counted)
 * and never reuses tableRows, so a row the extractor drops or merges shows up
 * as a count mismatch instead of silently disappearing.
 */
export const CPSC_STRUCTURE_CENSUS_VERSION = 'phase-16.13-census-v1';

export type CpscCensusRow = {
  cells: number;
  headerCells: number;
  inHead: boolean;
  colspanCells: number;
  rowspans: readonly number[];
  nestedTables: number;
  blank: boolean;
};

export type CpscCensusTable = { rows: readonly CpscCensusRow[]; nestedTables: number };

export type CpscStructureCensus = {
  version: typeof CPSC_STRUCTURE_CENSUS_VERSION;
  /** Every <table> under the description field, in the same pre-order as page.tables. */
  descriptionTables: readonly CpscCensusTable[];
  /** Normalized text of the description field outside its label, <p>, and <table>. */
  descriptionUnaccountedText: string;
  /** Tables in the recall-details region outside the description field. */
  detailTablesOutsideDescription: number;
};

function rawSpan(value: string | null | undefined): number {
  const parsed = Number.parseInt((value ?? '1').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function censusTable(table: HtmlNode): CpscCensusTable {
  const rows: CpscCensusRow[] = [];
  let nestedTables = 0;
  const cellNestedTables = (node: HtmlNode): number =>
    node.children.reduce(
      (count, child) =>
        typeof child === 'string'
          ? count
          : count + (child.tag === 'table' ? 1 : cellNestedTables(child)),
      0,
    );
  const walk = (node: HtmlNode, inHead: boolean) => {
    for (const child of node.children) {
      if (typeof child === 'string') continue;
      if (child.tag === 'table') {
        nestedTables += 1;
        continue;
      }
      if (child.tag !== 'tr') {
        walk(child, inHead || child.tag === 'thead');
        continue;
      }
      const cells = child.children.filter(
        (cell): cell is HtmlNode =>
          typeof cell !== 'string' && (cell.tag === 'td' || cell.tag === 'th'),
      );
      const nested = cells.reduce((count, cell) => count + cellNestedTables(cell), 0);
      nestedTables += nested;
      rows.push({
        cells: cells.length,
        headerCells: cells.filter((cell) => cell.tag === 'th').length,
        inHead,
        colspanCells: cells.filter((cell) => rawSpan(cell.attrs.colspan) > 1).length,
        rowspans: cells.map((cell) => rawSpan(cell.attrs.rowspan)),
        nestedTables: nested,
        blank: cells.every((cell) => nodeText(cell) === ''),
      });
      // An unclosed <tr> nests the next row inside it (html.parser keeps no implied end tags).
      walk(
        { ...child, children: child.children.filter((cell) => !cells.includes(cell as HtmlNode)) },
        inHead,
      );
    }
  };
  walk(table, false);
  return { rows, nestedTables };
}

function textOutside(node: HtmlNode, skip: (child: HtmlNode) => boolean): string {
  return pythonNorm(
    node.children
      .map((child) =>
        typeof child === 'string' ? child : skip(child) ? ' ' : textOutside(child, skip),
      )
      .join(' '),
  );
}

function containsNode(ancestor: HtmlNode, target: HtmlNode): boolean {
  for (const node of descendants(ancestor)) if (node === target) return true;
  return false;
}

function structureCensus(root: HtmlNode, descriptionField: HtmlNode): CpscStructureCensus {
  const label = fieldTitle(descriptionField);
  const descriptionTables = [...descendants(descriptionField, 'table')];
  let details: HtmlNode | null = null;
  for (const node of descendants(root, 'div')) {
    if (hasClass(node, 'recall-product__details')) {
      details = node;
      break;
    }
  }
  const detailTables = details ? [...descendants(details, 'table')] : [];
  return {
    version: CPSC_STRUCTURE_CENSUS_VERSION,
    descriptionTables: descriptionTables.map(censusTable),
    descriptionUnaccountedText: textOutside(
      descriptionField,
      (child) => child === label || child.tag === 'p' || child.tag === 'table',
    ),
    detailTablesOutsideDescription: detailTables.filter(
      (table) => !containsNode(descriptionField, table),
    ).length,
  };
}

/**
 * Extracts the authoritative evidence from one official recall page. Identity is
 * corroborated inside the document (displayed recall number, canonical link);
 * any contradiction or missing section throws, so no revision can be recorded.
 */
export function extractCpscPage(html: string, expectedCanonicalUrl: string): StructuredCpscPage {
  return extractCpscPageStructure(html, expectedCanonicalUrl).page;
}

/** The extracted page plus the independent structural census of its evidence region. */
export function extractCpscPageStructure(
  html: string,
  expectedCanonicalUrl: string,
): { page: StructuredCpscPage; census: CpscStructureCensus } {
  const canonicalUrl = canonicalCpscUrl(expectedCanonicalUrl);
  const root = parseHtml(html);
  for (const link of descendants(root, 'link')) {
    const rel = (link.attrs.rel ?? '').toLowerCase().split(WS_SPLIT);
    if (rel.includes('canonical') && canonicalCpscUrl(link.attrs.href ?? '') !== canonicalUrl) {
      throw new Error('CPSC page canonical link contradicts its identity.');
    }
  }
  let title: string | null = null;
  for (const heading of descendants(root, 'h1')) {
    if (hasClass(heading, 'page-title')) {
      title = nodeText(heading);
      break;
    }
  }
  if (!title) throw new Error('CPSC page has no title.');
  const fields = namedFields(root);
  const numberField = fields.get('recall number');
  const dateField = fields.get('recall date');
  const descriptionField = fields.get('description');
  if (!numberField || !dateField || !descriptionField) {
    throw new Error('CPSC page lacks a required recall field.');
  }
  const displayed = new Set(
    [...nodeText(numberField).matchAll(/\b([0-9]{2})-([0-9]{3})\b/gu)].map(
      (match) => `${match[1]}${match[2]}`,
    ),
  );
  if (displayed.size !== 1) throw new Error('CPSC page recall number is missing or ambiguous.');
  const page: StructuredCpscPage = {
    recallNumber: normalizeCpscNumber([...displayed][0]),
    canonicalUrl,
    title,
    publicationDate: recallDate(nodeText(dateField)),
    description: pythonNorm(
      [...descendants(descriptionField, 'p')].map((paragraph) => nodeText(paragraph)).join(' '),
    ),
    recallDetails: recallDetailSections(root),
    tables: [...descendants(descriptionField, 'table')].map(tableRows),
  };
  const evidenceText = [
    page.title,
    page.description,
    ...Object.entries(page.recallDetails).flat(),
    ...page.tables.flat(2),
  ];
  if (evidenceText.some((value) => UNDECODED_REFERENCE.test(value))) {
    throw new Error('CPSC page evidence contains an undecodable character reference.');
  }
  return { page, census: structureCensus(root, descriptionField) };
}
