// Phase 16.13 fresh, READ-ONLY capture of the authoritative CPSC sources for every
// recall in the historical backfill: the current CPSC Recall API record(s) per
// official recall number, and the current official recall page, corroborated with
// the production fetcher, extractor, identity canonicalization, payload hash, and
// source-coverage ledger. Public GET requests only; nothing is written anywhere
// except the capture file. No database, no owned-product data.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { extractCpscPageStructure } from '../supabase/functions/_shared/cpsc/htmlExtractor.ts';
import {
  canonicalCpscUrl,
  normalizeCpscNumber,
} from '../supabase/functions/_shared/cpsc/identity.ts';
import {
  semanticCpscRevision,
  CPSC_PAGE_PARSER_VERSION,
} from '../supabase/functions/_shared/cpsc/pageEvidence.ts';
import { fetchCpscOfficialPage } from '../supabase/functions/_shared/cpsc/pageFetcher.ts';
import { buildCpscSourceCoverage } from '../supabase/functions/_shared/cpsc/sourceCoverage.ts';
import { CPSC_API_ROOT } from '../supabase/functions/_shared/cpsc/validation.ts';
import { sourcePayloadSha256 } from '../supabase/functions/_shared/recallMatching/reviewedCriteriaV2.ts';

const root = new URL('../', import.meta.url);
// Phase 16.15: every path is explicit and required (no phase path is defaulted).
//   --notices     stored CPSC notices ({ external_id, recall_number, ... }[]), a read-only
//                 production snapshot
//   --pages-from  manifest whose Phase 16.8 page captures name the historical recalls
//   --out         capture file to write
const arg = (flag) => {
  const index = process.argv.indexOf(flag);
  const value = index > 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${flag} <path> is required.`);
  return value;
};
const cwdUrl = `file://${process.cwd()}/`;
const NOTICES_PATH = new URL(arg('--notices'), cwdUrl);
const PAGES_FROM = new URL(arg('--pages-from'), cwdUrl);
const OUT = new URL(arg('--out'), cwdUrl);
const outDisplay = fileURLToPath(OUT);
const previous = JSON.parse(await readFile(PAGES_FROM, 'utf8'));
const stored = JSON.parse(await readFile(NOTICES_PATH, 'utf8'));
const recallNumbers = [
  ...new Set([
    ...previous.pages.map((page) => page.recallNumber),
    ...stored.map((row) => row.recall_number),
  ]),
].sort();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function apiRecords(recallNumber) {
  const url = new URL(CPSC_API_ROOT);
  url.searchParams.set('format', 'json');
  url.searchParams.set('RecallNumber', recallNumber);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await response.arrayBuffer();
    if (!response.ok) throw new Error(`CPSC API HTTP ${response.status}`);
    if (body.byteLength > 8 * 1024 * 1024) throw new Error('CPSC API response too large');
    const parsed = JSON.parse(new TextDecoder().decode(body));
    if (!Array.isArray(parsed)) throw new Error('CPSC API response is not an array');
    return { requestUrl: url.toString(), records: parsed };
  } finally {
    clearTimeout(timer);
  }
}

const products = (payload) =>
  (payload.Products ?? []).map((product) => ({
    name: product.Name ?? null,
    model: product.Model ?? null,
    type: product.Type ?? null,
    description: product.Description ?? null,
    numberOfUnits: product.NumberOfUnits ?? null,
  }));

async function corroboratePage(recallNumber, apiUrl) {
  let canonicalUrl;
  try {
    canonicalUrl = canonicalCpscUrl(apiUrl);
  } catch (error) {
    return {
      status: 'unresolved',
      reasons: [`API URL is not an official CPSC recall URL: ${error.message}`],
    };
  }
  let snapshot;
  try {
    snapshot = await fetchCpscOfficialPage(canonicalUrl);
  } catch (error) {
    return {
      status: 'unresolved',
      canonicalUrl,
      reasons: [`official page fetch failed: ${error.message}`],
    };
  }
  try {
    const { page, census } = extractCpscPageStructure(snapshot.html, canonicalUrl);
    const reasons = [];
    if (page.recallNumber !== recallNumber) reasons.push('page displays another recall number');
    if (snapshot.finalUrl !== canonicalUrl) reasons.push('page resolved to another URL');
    const revision = await semanticCpscRevision(page);
    const coverage = await buildCpscSourceCoverage(page, census);
    return {
      status: reasons.length ? 'unresolved' : 'corroborated',
      reasons,
      canonicalUrl,
      finalUrl: snapshot.finalUrl,
      redirectChain: snapshot.redirectChain,
      fetchedAt: snapshot.fetchedAt,
      rawPageHash: snapshot.rawPageHash,
      displayedRecallNumber: page.recallNumber,
      canonicalLinkMatches: true,
      title: page.title,
      publicationDate: page.publicationDate,
      semanticEvidenceHash: revision.semanticHash,
      parserVersion: CPSC_PAGE_PARSER_VERSION,
      coverage: {
        coverageStatus: coverage.summary.coverageStatus,
        structuralStatus: coverage.summary.structuralStatus,
        criterionStatus: coverage.summary.criterionStatus,
        positiveStatus: coverage.summary.positiveStatus,
        authoritativeRecords: coverage.summary.authoritativeRecords,
        accountedRecords: coverage.summary.accountedRecords,
        coverageFingerprint: coverage.summary.coverageFingerprint,
      },
    };
  } catch (error) {
    // Evidence only (never used to resolve): what the official page itself declares.
    const declared =
      /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/u.exec(snapshot.html)?.[1] ?? null;
    return {
      status: 'unresolved',
      canonicalUrl,
      reasons: [`official page identity check failed: ${error.message}`],
      finalUrl: snapshot.finalUrl,
      redirectChain: snapshot.redirectChain,
      fetchedAt: snapshot.fetchedAt,
      rawPageHash: snapshot.rawPageHash,
      declaredCanonicalUrl: declared,
      displayedRecallNumbers: [
        ...new Set(
          [...snapshot.html.matchAll(/\b([0-9]{2})-([0-9]{3})\b/gu)]
            .map((match) => `${match[1]}${match[2]}`)
            .filter((number) => number === recallNumber),
        ),
      ],
    };
  }
}

// The payload hash convention must equal the Phase 16.8 audit's before any comparison.
const legacyApi = [];
for (const file of [
  'phase168-api-2026-09-10.json',
  'phase168-api-2026-09-17.json',
  'phase168-api-2020-08-12.json',
]) {
  try {
    legacyApi.push(...JSON.parse(await readFile(`/private/tmp/${file}`, 'utf8')));
  } catch {
    // The 16.8 raw captures are optional local evidence.
  }
}
const audit = JSON.parse(
  await readFile(new URL('docs/phase-16-8-source-manifest.json', root), 'utf8'),
);
let conventionChecked = 0;
for (const row of audit.noticeRows) {
  const payload = legacyApi.find((item) => String(item.RecallNumber) === row.cpscRecallNumber);
  if (!payload) continue;
  if ((await sourcePayloadSha256(payload)) !== row.liveApiPayloadSha256) {
    throw new Error(`Payload hash convention differs from Phase 16.8 for ${row.cpscRecallNumber}.`);
  }
  conventionChecked += 1;
}

const capturedAt = new Date().toISOString();
const recalls = [];
for (const recallNumber of recallNumbers) {
  const { requestUrl, records } = await apiRecords(recallNumber);
  const entries = [];
  for (const payload of records) {
    const reasons = [];
    let officialNumber = null;
    try {
      officialNumber = normalizeCpscNumber(payload.RecallNumber);
    } catch {
      reasons.push('API record has no valid recall number');
    }
    if (officialNumber !== recallNumber) reasons.push('API record names another recall number');
    await sleep(400);
    const page = payload.URL ? await corroboratePage(recallNumber, payload.URL) : null;
    if (!page) reasons.push('API record has no official URL');
    else if (page.status !== 'corroborated') reasons.push(...page.reasons);
    entries.push({
      identityStatus: reasons.length ? 'unresolved' : 'corroborated',
      reasons,
      api: {
        apiId: String(payload.RecallID),
        recallNumber: officialNumber,
        url: payload.URL ?? null,
        title: payload.Title ?? null,
        recallDate: payload.RecallDate ? String(payload.RecallDate).slice(0, 10) : null,
        lastPublishDate: payload.LastPublishDate
          ? String(payload.LastPublishDate).slice(0, 10)
          : null,
        products: products(payload),
        productUpcs: (payload.ProductUPCs ?? []).map((item) => item.UPC ?? item),
        payloadHash: await sourcePayloadSha256(payload),
      },
      page,
      payload,
    });
  }
  recalls.push({
    recallNumber,
    apiRequest: requestUrl,
    apiRecordCount: records.length,
    records: entries,
  });
  console.error(
    `${recallNumber}: ${records.length} API record(s); ${entries.map((e) => e.identityStatus).join(', ')}`,
  );
  await sleep(400);
}

const capture = {
  captureVersion: 'phase-16.13-cpsc-fresh-capture-v1',
  capturedAtUtc: capturedAt,
  apiRoot: CPSC_API_ROOT,
  pageAuthority: 'https://www.cpsc.gov/Recalls/',
  method:
    'Read-only GET of the CPSC Recall API by official recall number, then the official page at the ' +
    'canonicalized API URL through the production fetcher and extractor (canonical link and ' +
    'displayed recall number must agree).',
  hashAlgorithm:
    'payloadHash: SHA-256 of recursively key-sorted compact JSON (production sourcePayloadSha256, ' +
    `identical to the Phase 16.8 audit convention; verified on ${conventionChecked} captured payloads); ` +
    'rawPageHash: SHA-256 of the downloaded HTML bytes; semanticEvidenceHash: production semantic revision.',
  payloadConventionVerifiedOn: conventionChecked,
  recallNumbers,
  recalls,
};
await writeFile(OUT, `${JSON.stringify(capture, null, 2)}\n`);
spawnSync('npx', ['prettier', '--write', outDisplay], {
  cwd: new URL('.', root),
  stdio: 'ignore',
});
const flat = recalls.flatMap((recall) => recall.records);
console.log(
  JSON.stringify(
    {
      written: outDisplay,
      recallNumbers: recallNumbers.length,
      apiRecords: flat.length,
      corroborated: flat.filter((entry) => entry.identityStatus === 'corroborated').length,
      unresolved: flat.filter((entry) => entry.identityStatus === 'unresolved').length,
      conventionChecked,
    },
    null,
    2,
  ),
);
