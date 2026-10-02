// Phase 16.16A: build the bounded payload-attachment input for the quarantined
// CPSC collisions recorded by the Phase 16.15 backfill. Local files only; no
// network, no database. Each item carries the complete captured CPSC API payload
// whose canonical hash equals the hash the quarantine already recorded; the
// database recomputes that hash again before attaching anything
// (private.cpsc_attach_captured_payloads).
//
// Usage: npm run backfill:phase-16-16a:attachment
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { sourcePayloadSha256 } from '../supabase/functions/_shared/recallMatching/reviewedCriteriaV2.ts';

export const CAPTURE = 'docs/phase-16-14-cpsc-fresh-capture.json';
export const MANIFEST = 'docs/phase-16-15-backfill-manifest.json';
export const EXECUTION = 'docs/phase-16-15-backfill-execution.json';
export const OUTPUT = 'docs/phase-16-16a-payload-attachment-manifest.json';
export const API_ROOT = 'https://www.saferproducts.gov/RestWebServices/Recall';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function buildAttachment() {
  const captureBytes = await readFile(CAPTURE);
  const capture = JSON.parse(captureBytes.toString('utf8'));
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const execution = JSON.parse(await readFile(EXECUTION, 'utf8'));
  if (capture.apiRoot !== API_ROOT) throw new Error('Capture is not from the CPSC Recall API.');
  if (manifest.freshCapture?.sha256 !== sha256(captureBytes)) {
    throw new Error('Capture file does not match the 16.15 manifest.');
  }

  const quarantines = execution.run1?.report?.observations?.quarantines ?? [];
  if (quarantines.length !== 6 || quarantines.some((q) => q.decisionClass !== 'D_api_id_reuse')) {
    throw new Error('Expected exactly the six 16.15 API-ID reuse quarantines.');
  }
  const items = [];
  for (const quarantine of quarantines) {
    const recorded = manifest.currentObservations.filter(
      (o) => o.apiId === quarantine.apiId && o.recallNumber === quarantine.recallNumber,
    );
    const records = capture.recalls
      .filter((r) => r.recallNumber === quarantine.recallNumber)
      .flatMap((r) => r.records)
      .filter((r) => String(r.payload?.RecallID) === quarantine.apiId);
    if (recorded.length !== 1 || records.length !== 1) {
      throw new Error(`Ambiguous source for recall ${quarantine.recallNumber}.`);
    }
    const payload = records[0].payload;
    const payloadSha256 = await sourcePayloadSha256(payload);
    if (payloadSha256 !== recorded[0].payloadHash) {
      throw new Error(
        `Captured payload does not match the recorded hash for ${quarantine.recallNumber}.`,
      );
    }
    items.push({
      apiId: quarantine.apiId,
      recallNumber: quarantine.recallNumber,
      payloadSha256,
      payload,
    });
  }
  items.sort((a, b) => a.recallNumber.localeCompare(b.recallNumber));
  return {
    attachmentVersion: 'phase-16.16a-captured-payload-attachment-v1',
    apiRoot: API_ROOT,
    captureSha256: sha256(captureBytes),
    capturedAtUtc: capture.capturedAtUtc,
    derivedFrom: {
      capture: CAPTURE,
      recordedHashes: MANIFEST,
      quarantines: EXECUTION,
      hashContract: 'cpsc-canonical-json-sha256/v1',
    },
    items,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const attachment = await buildAttachment();
  await writeFile(OUTPUT, `${JSON.stringify(attachment, null, 2)}\n`);
  console.log(
    JSON.stringify({
      output: OUTPUT,
      items: attachment.items.map(
        (i) => `${i.recallNumber}/${i.apiId}/${i.payloadSha256.slice(0, 12)}`,
      ),
    }),
  );
}
