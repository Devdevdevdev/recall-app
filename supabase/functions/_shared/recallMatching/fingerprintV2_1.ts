import type { JsonObject, JsonValue } from '../matching/types.ts';
import {
  DETERMINISTIC_MATCH_METHOD_V2,
  MATCH_EVALUATION_SCHEMA_VERSION_V2,
} from '../matching/typesV2.ts';
import type { OwnedProductEvidenceV2 } from '../matching/typesV2.ts';
import {
  HYBRID_GUARDED_MATCH_METHOD_V2_1,
  MATCH_FINGERPRINT_POLICY_V2_1,
  MATCH_FINGERPRINT_VERSION_V2_1,
  VERIFIER_VERSION_V2_1,
  type OfficialRecallEvidenceV2_1,
} from '../matching/typesV2_1.ts';

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Fingerprint evidence contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(',')}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildEvidenceFingerprintV2_1(input: {
  ownedProduct: OwnedProductEvidenceV2;
  officialRecall: OfficialRecallEvidenceV2_1;
  rawPayload: JsonObject;
  modelId: string;
}): Promise<string> {
  const document = {
    ownedProduct: input.ownedProduct,
    officialRecall: input.officialRecall,
    rawPayloadSha256: await sha256(canonicalJson(input.rawPayload)),
    policy: {
      deterministicMatcher: DETERMINISTIC_MATCH_METHOD_V2,
      hybridMatcher: HYBRID_GUARDED_MATCH_METHOD_V2_1,
      evaluationSchemaVersion: MATCH_EVALUATION_SCHEMA_VERSION_V2,
      verifierVersion: VERIFIER_VERSION_V2_1,
      fingerprintVersion: MATCH_FINGERPRINT_VERSION_V2_1,
      policyVersion: MATCH_FINGERPRINT_POLICY_V2_1,
      modelId: input.modelId,
    },
  } as unknown as JsonObject;
  return sha256(canonicalJson(document));
}
