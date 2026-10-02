import { sourcePayloadSha256 } from '../recallMatching/reviewedCriteriaV2.ts';
import { canonicalCpscUrl, normalizeCpscNumber } from './identity.ts';
import type { JsonObject, JsonValue } from './types.ts';

export type CpscObservationResult =
  | {
      status: 'resolved' | 'created';
      observationId: string;
      identityId: string;
      canonicalNoticeId: string | null;
      decisionClass: string;
      revisionFlags: string[];
    }
  | {
      status: 'quarantined';
      observationId: string;
      reason: string;
      decisionClass: string;
      /** True when an identical source revision reused its existing review item. */
      replayed: boolean;
      seenCount: number;
      /** Database-verified hash of the retained payload (equals the worker's own hash). */
      payloadSha256: string;
    };

export type CpscNoticeRevisionResult = {
  status: 'created' | 'unchanged';
  revisionId: string;
  changedFields: string[];
  identifierChanged: boolean;
};

export type CpscIngestionOutcome =
  | {
      status: 'inserted' | 'unchanged';
      noticeId: string;
      observation: CpscObservationResult;
      noticeRevision?: CpscNoticeRevisionResult;
    }
  | { status: 'quarantined'; reason: string; observation: CpscObservationResult };

type ObservationDatabase = {
  rpc: (
    name: string,
    parameters: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

type CpscRecord = {
  externalId: string;
  title: string;
  description?: string | null;
  hazard?: string | null;
  remedy?: string | null;
  recallDate: string;
  officialUrl: string;
  rawPayload: JsonObject;
  scopes?: readonly unknown[];
};

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Additive observation gate. It never invokes numeric-ID based notice mutation.
 * Phase 16.16A: the complete payload is sent with the observation. The database
 * recomputes its hash and stores it, so every observation (a quarantine included)
 * stays reviewable without a CPSC refetch. A result that does not confirm
 * retention of exactly this payload fails closed.
 */
export async function recordCpscIngestionObservation(
  database: ObservationDatabase,
  record: CpscRecord,
): Promise<CpscObservationResult> {
  const recallNumber = normalizeCpscNumber(record.rawPayload.RecallNumber);
  const payloadHash = await sourcePayloadSha256(record.rawPayload);
  const { data, error } = await database.rpc('record_cpsc_retained_observation', {
    p_api_id: record.externalId,
    p_recall_number: recallNumber,
    p_observed_url: record.officialUrl,
    p_canonical_url: canonicalCpscUrl(record.officialUrl),
    p_title: record.title,
    p_publication_date: record.recallDate,
    p_payload_hash: payloadHash,
    p_observed_at: new Date().toISOString(),
    p_provenance: 'Phase 16.16A CPSC worker observation',
    p_raw_payload: record.rawPayload,
  });
  if (error || !data || typeof data !== 'object') {
    throw new Error('CPSC identity observation failed closed.');
  }
  const result = data as Record<string, unknown>;
  if (result.payloadRetention !== 'retained' || result.payloadSha256 !== payloadHash) {
    throw new Error('CPSC source payload retention was not confirmed.');
  }
  if (
    result.status === 'quarantined' &&
    text(result.reason) &&
    text(result.observationId) &&
    text(result.decisionClass) &&
    typeof result.replayed === 'boolean' &&
    Number.isInteger(result.seenCount) &&
    Number(result.seenCount) >= 1
  ) {
    return {
      status: 'quarantined',
      observationId: result.observationId,
      reason: result.reason,
      decisionClass: result.decisionClass,
      replayed: result.replayed,
      seenCount: Number(result.seenCount),
      payloadSha256: payloadHash,
    };
  }
  if (
    (result.status === 'resolved' || result.status === 'created') &&
    text(result.observationId) &&
    text(result.identityId) &&
    (result.canonicalNoticeId === null || text(result.canonicalNoticeId)) &&
    text(result.decisionClass) &&
    Array.isArray(result.revisionFlags) &&
    result.revisionFlags.every(text)
  ) {
    return {
      status: result.status,
      observationId: result.observationId,
      identityId: result.identityId,
      canonicalNoticeId: result.canonicalNoticeId as string | null,
      decisionClass: result.decisionClass,
      revisionFlags: result.revisionFlags as string[],
    };
  }
  throw new Error('CPSC identity observation returned an invalid result.');
}

/**
 * Appends a notice revision for an existing canonical notice when its
 * revisionable content (title, text, date, manufacturers, identifiers) changed.
 * The historical notice row is never rewritten.
 */
export async function recordCpscNoticeRevision(
  database: ObservationDatabase,
  observationId: string,
  record: CpscRecord,
): Promise<CpscNoticeRevisionResult> {
  const { data, error } = await database.rpc('record_cpsc_notice_revision', {
    p_observation_id: observationId,
    p_description: record.description ?? null,
    p_hazard: record.hazard ?? null,
    p_remedy: record.remedy ?? null,
    p_raw_payload: record.rawPayload,
  });
  const result = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  if (
    error ||
    !result ||
    (result.status !== 'created' && result.status !== 'unchanged') ||
    !text(result.revisionId)
  ) {
    throw new Error('CPSC notice revision failed closed.');
  }
  const changedFields = Array.isArray(result.changedFields)
    ? result.changedFields.filter(text)
    : [];
  return {
    status: result.status,
    revisionId: result.revisionId,
    changedFields,
    identifierChanged: result.identifierChanged === true,
  };
}

/**
 * Identity-first CPSC ingestion. A resolved or newly created identity without a
 * notice receives one through the identity-bound RPC; an identity that already
 * has a notice is never rewritten here (a content change becomes a revision). Quarantine is returned, not thrown, so
 * the caller can report it without treating it as a transport failure.
 */
export async function ingestCpscRecallIdentity(
  database: ObservationDatabase,
  record: CpscRecord,
): Promise<CpscIngestionOutcome> {
  const observation = await recordCpscIngestionObservation(database, record);
  if (observation.status === 'quarantined') {
    return { status: 'quarantined', reason: observation.reason, observation };
  }
  if (observation.canonicalNoticeId) {
    const noticeRevision = await recordCpscNoticeRevision(
      database,
      observation.observationId,
      record,
    );
    return {
      status: 'unchanged',
      noticeId: observation.canonicalNoticeId,
      observation,
      noticeRevision,
    };
  }
  const { data, error } = await database.rpc('ingest_cpsc_identity_notice', {
    p_observation_id: observation.observationId,
    p_description: record.description ?? null,
    p_hazard: record.hazard ?? null,
    p_remedy: record.remedy ?? null,
    p_retrieved_at: new Date().toISOString(),
    p_raw_payload: record.rawPayload,
    p_scopes: (record.scopes ?? []) as JsonValue[],
  });
  const result = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  if (
    error ||
    !result ||
    (result.status !== 'inserted' && result.status !== 'unchanged') ||
    !text(result.noticeId)
  ) {
    throw new Error('CPSC identity notice ingestion failed closed.');
  }
  return { status: result.status, noticeId: result.noticeId, observation };
}
