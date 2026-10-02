import { dateOnlyFromSource } from './validation.ts';

export type CpscIdentityEvidence = {
  apiId: string;
  recallNumber: string;
  officialUrl: string;
  title: string;
  publicationDate: string;
};

export type HistoricalCpscNotice = CpscIdentityEvidence & { noticeId: string };

export type CanonicalCpscIdentity = {
  key: string;
  recallNumber: string;
  canonicalUrl: string;
  title: string;
  publicationDate: string;
  noticeIds: string[];
  apiIdAliases: string[];
  urlAliases: string[];
};

export type CpscIdentityDecision =
  | { status: 'resolved'; identity: CanonicalCpscIdentity; duplicate: boolean }
  | { status: 'quarantined'; reason: string; conflictingKeys: string[] };

export function canonicalCpscUrl(value: string): string {
  // Check the literal authority before URL parsing, which otherwise normalizes some
  // misleading spellings. Query strings and fragments are transport aliases only.
  if (!/^https:\/\/(?:www\.)?cpsc\.gov\/Recalls\//iu.test(value)) {
    throw new Error('CPSC URL must use the exact HTTPS recall authority.');
  }
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !['cpsc.gov', 'www.cpsc.gov'].includes(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port ||
    !url.pathname.startsWith('/Recalls/')
  ) {
    throw new Error('CPSC URL has an unsafe authority.');
  }
  return `https://www.cpsc.gov${url.pathname.replace(/\/$/u, '')}`;
}

export function normalizeCpscNumber(value: unknown): string {
  const raw = String(value ?? '').trim();
  const match = /^(\d{2})-?(\d{3})$/u.exec(raw);
  if (!match) throw new Error('CPSC recall number must have five digits.');
  return `${match[1]}${match[2]}`;
}

export function identityKey(recallNumber: string): string {
  return `cpsc:${normalizeCpscNumber(recallNumber)}`;
}

export async function identityFingerprint(recallNumber: string): Promise<string> {
  const bytes = new TextEncoder().encode(`cpsc\0${normalizeCpscNumber(recallNumber)}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sameText(left: string, right: string): boolean {
  return (
    left.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US') ===
    right.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US')
  );
}

function checkedEvidence(evidence: CpscIdentityEvidence): CpscIdentityEvidence {
  const apiId = String(evidence.apiId).trim();
  if (!/^\d+$/u.test(apiId)) throw new Error('CPSC API ID is malformed.');
  const publicationDate = dateOnlyFromSource(evidence.publicationDate);
  if (!publicationDate || !evidence.title.trim()) throw new Error('CPSC date or title is missing.');
  return {
    apiId,
    recallNumber: normalizeCpscNumber(evidence.recallNumber),
    officialUrl: canonicalCpscUrl(evidence.officialUrl),
    title: evidence.title.trim(),
    publicationDate,
  };
}

/** A historical row is never changed by this additive in-memory index. */
export function buildCpscIdentityIndex(rows: readonly HistoricalCpscNotice[]) {
  const identities = new Map<string, CanonicalCpscIdentity>();
  const apiAliases = new Map<string, Set<string>>();
  const urlAliases = new Map<string, Set<string>>();
  for (const row of rows) {
    const item = checkedEvidence(row);
    const key = identityKey(item.recallNumber);
    let identity = identities.get(key);
    if (!identity) {
      identity = {
        key,
        recallNumber: item.recallNumber,
        canonicalUrl: item.officialUrl,
        title: item.title,
        publicationDate: item.publicationDate,
        noticeIds: [],
        apiIdAliases: [],
        urlAliases: [],
      };
      identities.set(key, identity);
    } else if (
      identity.canonicalUrl !== item.officialUrl ||
      identity.publicationDate !== item.publicationDate ||
      !sameText(identity.title, item.title)
    ) {
      throw new Error(`Historical CPSC evidence conflicts for ${key}.`);
    }
    if (identity.noticeIds.includes(row.noticeId))
      throw new Error('Repeated historical notice ID.');
    identity.noticeIds.push(row.noticeId);
    if (!identity.apiIdAliases.includes(item.apiId)) identity.apiIdAliases.push(item.apiId);
    if (!identity.urlAliases.includes(row.officialUrl)) identity.urlAliases.push(row.officialUrl);
    const idKeys = apiAliases.get(item.apiId) ?? new Set<string>();
    idKeys.add(key);
    apiAliases.set(item.apiId, idKeys);
    const urlKeys = urlAliases.get(item.officialUrl) ?? new Set<string>();
    urlKeys.add(key);
    urlAliases.set(item.officialUrl, urlKeys);
  }
  return { identities, apiAliases, urlAliases };
}

export function resolveCpscObservation(
  index: ReturnType<typeof buildCpscIdentityIndex>,
  raw: CpscIdentityEvidence,
): CpscIdentityDecision {
  let item: CpscIdentityEvidence;
  try {
    item = checkedEvidence(raw);
  } catch (error) {
    return {
      status: 'quarantined',
      reason: error instanceof Error ? error.message : 'invalid evidence',
      conflictingKeys: [],
    };
  }
  const key = identityKey(item.recallNumber);
  const identity = index.identities.get(key);
  const conflictingKeys = [...(index.apiAliases.get(item.apiId) ?? [])].filter(
    (alias) => alias !== key,
  );
  if (!identity) {
    return { status: 'quarantined', reason: 'unresolved official recall number', conflictingKeys };
  }
  if (
    identity.canonicalUrl !== item.officialUrl ||
    identity.publicationDate !== item.publicationDate ||
    !sameText(identity.title, item.title)
  ) {
    return {
      status: 'quarantined',
      reason: 'official identity evidence conflicts',
      conflictingKeys: [key, ...conflictingKeys],
    };
  }
  if (conflictingKeys.length) {
    return {
      status: 'quarantined',
      reason: 'API ID belongs to another historical recall',
      conflictingKeys,
    };
  }
  return { status: 'resolved', identity, duplicate: identity.noticeIds.length > 1 };
}
