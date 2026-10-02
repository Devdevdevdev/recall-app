// Local-only replay through the real parser and the dedicated Postgres role.
// Run after a clean local reset; reset again after this fixture run.
import postgres from 'npm:postgres@3.4.7';

import { processCpscPageClaim } from '../supabase/functions/_shared/cpsc/scheduledPageWorker.ts';
import { extractCpscPageStructure } from '../supabase/functions/_shared/cpsc/htmlExtractor.ts';
import { semanticCpscRevision } from '../supabase/functions/_shared/cpsc/pageEvidence.ts';
import { buildCpscSourceCoverage } from '../supabase/functions/_shared/cpsc/sourceCoverage.ts';

const canonical =
  'https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock';
const fixture = await Deno.readFile(
  new URL('../tests/fixtures/cpsc-pages/char-broil.html', import.meta.url),
);
const password = [...crypto.getRandomValues(new Uint8Array(32))]
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');
const statusCommand = new Deno.Command('npx', {
  args: ['supabase', 'status', '-o', 'json'],
  stdout: 'piped',
  stderr: 'null',
});
const statusResult = await statusCommand.output();
if (!statusResult.success) throw new Error('Local Supabase status unavailable.');
const localDbUrl: string = JSON.parse(new TextDecoder().decode(statusResult.stdout)).DB_URL;
if (!['127.0.0.1', 'localhost'].includes(new URL(localDbUrl).hostname)) {
  throw new Error('Local database only.');
}
const admin = postgres(localDbUrl, {
  max: 1,
  prepare: false,
});
await admin.unsafe(`alter role cpsc_page_worker password '${password}'`);
const workerUrl = new URL(localDbUrl);
workerUrl.username = 'cpsc_page_worker';
workerUrl.password = password;
const worker = postgres(workerUrl.toString(), {
  max: 2,
  prepare: false,
  connect_timeout: 2,
});
let lastDatabaseError: { code?: string } | null = null;

const database = {
  async rpc(name: string, parameters: Record<string, unknown>) {
    try {
      if (name === 'claim_cpsc_page_evidence') {
        const data = await worker`select * from public.claim_cpsc_page_evidence(1)`;
        return { data, error: null };
      }
      if (name === 'finish_cpsc_page_attempt') {
        const rows = await worker`select public.finish_cpsc_page_attempt(
          ${String(parameters.p_claim_id)}::uuid,${String(parameters.p_outcome)}::text,
          ${parameters.p_http_status === null ? null : Number(parameters.p_http_status)}::integer,
          ${parameters.p_final_url === null ? null : String(parameters.p_final_url)}::text,
          ${parameters.p_raw_page_hash === null ? null : String(parameters.p_raw_page_hash)}::text,
          ${parameters.p_error_code === null ? null : String(parameters.p_error_code)}::text
        ) as result`;
        return { data: rows[0]?.result, error: null };
      }
      if (name === 'commit_cpsc_page_evidence_verified') {
        const rawHex = String(parameters.p_raw_page_hex);
        const rawBytes = Uint8Array.fromHex(rawHex);
        const localHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', rawBytes))]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (localHash !== (parameters.p_snapshot as { rawPageHash: string }).rawPageHash) {
          throw new Error(`worker byte/hash mismatch ${localHash}`);
        }
        const dbHash = (
          await admin`
          select encode(extensions.digest(decode(${rawHex}::text,'hex'),'sha256'),'hex') as hash
        `
        )[0]?.hash;
        if (dbHash !== localHash) throw new Error(`DB byte/hash mismatch ${dbHash}`);
        const snapshotJson = worker.json(
          parameters.p_snapshot as Parameters<typeof worker.json>[0],
        );
        const dbSnapshotHash = (
          await admin`
          select ${admin.json(parameters.p_snapshot as Parameters<typeof admin.json>[0])}::jsonb->>'rawPageHash' as hash
        `
        )[0]?.hash;
        if (dbSnapshotHash !== dbHash) {
          throw new Error(`DB snapshot/hash mismatch ${dbSnapshotHash} vs ${dbHash}`);
        }
        const rows = await worker`select public.commit_cpsc_page_evidence_verified(
          ${String(parameters.p_claim_id)}::uuid,
          ${snapshotJson}::jsonb,
          ${worker.json(parameters.p_revision as Parameters<typeof worker.json>[0])}::jsonb,
          ${worker.json(parameters.p_candidates as Parameters<typeof worker.json>[0])}::jsonb,
          ${worker.json(parameters.p_ledger as Parameters<typeof worker.json>[0])}::jsonb,
          decode(${rawHex}::text,'hex')) as result`;
        return { data: rows[0]?.result, error: null };
      }
      throw new Error('unexpected database operation');
    } catch (error) {
      if (error instanceof Error) {
        lastDatabaseError = {
          code: 'code' in error ? String(error.code) : undefined,
        };
      }
      return { data: null, error };
    }
  },
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

try {
  let identity = (
    await admin`
    select id from private.cpsc_source_identities
    where official_recall_number='26773' and canonical_url=${canonical}
  `
  )[0]?.id;
  if (!identity) {
    const source = (await admin`select public.ensure_cpsc_recall_source() as id`)[0]?.id;
    if (!source) throw new Error('CPSC source fixture unavailable');
    const notice = (
      await admin`
      insert into public.recall_notices(source_id,external_id,title,description,
        hazard,remedy,recall_date,official_url,retrieved_at,raw_payload)
      values (${source}::uuid,'cpsc:26773','Char-Broil fixture','Description',
        'Hazard','Repair','2026-09-20',${canonical},now(),
        '{"RecallNumber":"26773"}'::jsonb) returning id
    `
    )[0]?.id;
    if (!notice) throw new Error('notice fixture unavailable');
    identity = (
      await admin`
      insert into private.cpsc_source_identities(source_id,official_recall_number,
        canonical_url,canonical_notice_id,identity_status)
      values (${source}::uuid,'26773',${canonical},${notice}::uuid,'reconciled')
      returning id
    `
    )[0]?.id;
    if (!identity) throw new Error('identity fixture unavailable');
    await admin`
      insert into private.cpsc_notice_identity_links(notice_id,identity_id,provenance)
      values (${notice}::uuid,${identity}::uuid,'Phase 16.24 local replay')
    `;
  } else {
    await admin`
      update private.cpsc_page_work_state set claim_expires_at=now()-interval '1 second'
      where identity_id=${identity}::uuid and claim_id is not null
    `;
  }
  await admin`
    update private.cpsc_page_work_state set next_attempt_at=now()-interval '1 second'
    where identity_id=${identity}::uuid
  `;
  const [raceA, raceB] = await Promise.all([
    worker`select * from public.claim_cpsc_page_evidence(1)`,
    worker`select * from public.claim_cpsc_page_evidence(1)`,
  ]);
  if (raceA.length + raceB.length !== 1) {
    throw new Error('two-session claim race did not produce exactly one claim');
  }
  const claim = raceA[0] ?? raceB[0];
  if (!claim || claim.identity_id !== identity) throw new Error('fixture claim missing');
  let outcome: string;
  try {
    outcome = await processCpscPageClaim(
      database,
      claim as unknown as Parameters<typeof processCpscPageClaim>[1],
      async () =>
        new Response(fixture, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    );
  } catch {
    const details = lastDatabaseError as { code?: string } | null;
    throw new Error(`verified local commit failed: ${details?.code ?? 'unknown'}`);
  }
  if (!['fetched_changed', 'fetched_unchanged'].includes(outcome)) {
    throw new Error(`unexpected outcome: ${outcome}`);
  }
  const stored = (
    await admin`
    select p.raw_bytes,p.sha256,p.byte_length,r.evidence_hash,
      c.coverage_fingerprint,c.ledger
    from private.cpsc_page_attempts a
    join private.cpsc_page_raw_payloads p on p.sha256=a.raw_payload_sha256
    join private.cpsc_page_revisions r on r.id=a.revision_id
    join private.cpsc_page_coverage_ledgers c on c.revision_id=r.id
    where a.id=${claim.claim_id}::uuid
  `
  )[0];
  if (!stored) throw new Error('retained evidence missing');
  const bytes = new Uint8Array(stored.raw_bytes);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (hash !== stored.sha256 || bytes.byteLength !== stored.byte_length) {
    throw new Error('retained byte hash or length mismatch');
  }
  const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const { page, census } = extractCpscPageStructure(html, canonical);
  const revision = await semanticCpscRevision(page);
  const coverage = await buildCpscSourceCoverage(page, census);
  if (
    revision.semanticHash !== stored.evidence_hash ||
    coverage.summary.coverageFingerprint !== stored.coverage_fingerprint ||
    canonicalJson(coverage.ledger) !== canonicalJson(stored.ledger)
  ) {
    throw new Error('independent replay did not reproduce semantic/coverage evidence');
  }
  await admin`
    update private.cpsc_page_work_state set next_attempt_at=now()-interval '1 second'
    where identity_id=${identity}::uuid
  `;
  const sameClaim = (await worker`select * from public.claim_cpsc_page_evidence(1)`)[0];
  if (
    !sameClaim ||
    (await processCpscPageClaim(
      database,
      sameClaim as unknown as Parameters<typeof processCpscPageClaim>[1],
      async () =>
        new Response(fixture, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    )) !== 'fetched_unchanged'
  )
    throw new Error('same-byte replay failed');
  const onePayload = (
    await admin`
    select count(*)::integer as count from private.cpsc_page_raw_payloads
  `
  )[0]?.count;
  if (onePayload !== 1) throw new Error('same bytes were not deduplicated');
  await admin`
    update private.cpsc_page_work_state set next_attempt_at=now()-interval '1 second'
    where identity_id=${identity}::uuid
  `;
  const differentClaim = (await worker`select * from public.claim_cpsc_page_evidence(1)`)[0];
  const cosmeticBytes = new Uint8Array([
    ...fixture,
    ...new TextEncoder().encode('\n<!-- Phase 16.24 byte-only change -->'),
  ]);
  if (
    !differentClaim ||
    (await processCpscPageClaim(
      database,
      differentClaim as unknown as Parameters<typeof processCpscPageClaim>[1],
      async () =>
        new Response(cosmeticBytes, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    )) !== 'fetched_unchanged'
  )
    throw new Error('byte-only change should retain semantic revision');
  const twoPayloads = (
    await admin`
    select count(*)::integer as count from private.cpsc_page_raw_payloads
  `
  )[0]?.count;
  if (twoPayloads !== 2) throw new Error('different bytes did not create a new payload');
  console.log('stored exact bytes → parser → semantic hash and coverage: PASS');
  console.log(`payload bytes: ${bytes.byteLength}; SHA-256 agreement: PASS`);
  console.log('same bytes deduplicated; different bytes retained separately: PASS');
  console.log('two-session claim race: one claim, zero duplicates');
} finally {
  await worker.end({ timeout: 1 });
  await admin.unsafe('alter role cpsc_page_worker password null');
  await admin.end({ timeout: 1 });
}
