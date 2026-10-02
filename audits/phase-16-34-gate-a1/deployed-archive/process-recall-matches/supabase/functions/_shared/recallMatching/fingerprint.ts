import {
  DETERMINISTIC_MATCH_METHOD,
  GUARDED_NEMOTRON_PROMPT_VERSION,
  HYBRID_GUARDED_MATCH_METHOD,
  MATCH_EVALUATION_SCHEMA_VERSION,
  type JsonObject,
  type JsonValue,
  type OfficialRecallEvidence,
  type OwnedProductEvidence,
} from '../matching/types.ts';

export const PRODUCTION_MATCHING_POLICY_VERSION = 'phase_10_guarded_v1';

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

function jsonObject(value: unknown): JsonObject {
  return value as JsonObject;
}

export async function buildEvidenceFingerprint(input: {
  ownedProduct: OwnedProductEvidence;
  officialRecall: OfficialRecallEvidence;
  rawPayload: JsonObject;
  modelId: string;
}): Promise<string> {
  const rawPayloadHash = await sha256(canonicalJson(input.rawPayload));
  const stableRecall = {
    source: input.officialRecall.source,
    title: input.officialRecall.title,
    description: input.officialRecall.description,
    hazard: input.officialRecall.hazard,
    remedy: input.officialRecall.remedy,
    recallDate: input.officialRecall.recallDate,
    scopes: [...input.officialRecall.scopes]
      .map((scope) => jsonObject(scope))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  };
  const fingerprintDocument = jsonObject({
    ownedProduct: input.ownedProduct,
    officialRecall: stableRecall,
    rawPayloadSha256: rawPayloadHash,
    policy: {
      deterministicMatcher: DETERMINISTIC_MATCH_METHOD,
      hybridMatcher: HYBRID_GUARDED_MATCH_METHOD,
      schemaVersion: MATCH_EVALUATION_SCHEMA_VERSION,
      guardedPromptVersion: GUARDED_NEMOTRON_PROMPT_VERSION,
      productionPolicyVersion: PRODUCTION_MATCHING_POLICY_VERSION,
      modelId: input.modelId,
    },
  });
  return sha256(canonicalJson(fingerprintDocument));
}
