// Phase 16.33, LOCAL ONLY. Drives the real v1 matcher (processRecallMatches),
// the real automation orchestrator and the real child-response parser against
// the local Supabase database, with page-ledger notice touches injected from
// separate sessions. Proves that a stale or busy pair is never acknowledged,
// is retried, and ends matched exactly once or explicitly unresolved.
// It also replays the Phase 12 (HEAD) orchestrator to reproduce the defect.
// Requires a disposable local database: run `supabase db reset --local` after.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

import { processRecallMatches } from '../supabase/functions/_shared/recallMatching/orchestrator.ts';
import { runRecallAutomation } from '../supabase/functions/_shared/automation/orchestrator.ts';
import { RecallAutomationChildren } from '../supabase/functions/run-recall-automation/children.ts';

// Local Supabase's documented development credentials; never a remote host.
const LOCAL_DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';
const PREFIX = '16339';
const id = (suffix) => `${PREFIX}000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const admin = postgres(LOCAL_DB, { max: 1, onnotice: () => {} });
const results = [];
const check = (name, condition, detail) => {
  results.push({ name, ok: Boolean(condition), ...(detail ? { detail } : {}) });
  assert.ok(condition, `${name}${detail ? `: ${JSON.stringify(detail)}` : ''}`);
};

// A v1 store identical in RPC use to process-recall-matches/store.ts, run as
// service_role on its own connection pool, with test hooks.
function matchingStore(hooks = {}) {
  const sql = postgres(LOCAL_DB, { max: 2, onnotice: () => {} });
  const rpc = (text, params) =>
    sql.begin(async (tx) => {
      await tx.unsafe('set local role service_role');
      return tx.unsafe(text, params);
    });
  return {
    close: () => sql.end({ timeout: 1 }),
    async listAuthoritativeRecalls(input) {
      // Timestamps travel as text, exactly as PostgREST serializes them, so no
      // microseconds are lost before the optimistic revision comparison.
      const rows = await rpc(
        `select b.*, b.recall_notice_updated_at::text as revision,
          b.recall_date::text as recall_day
        from public.get_recall_matching_batch($1, $2, $3) b`,
        [input.afterRecallId, input.limit, input.recallNoticeIds],
      );
      const mapped = rows.map((row) => ({
        recall_notice_id: row.recall_notice_id,
        recall_notice_updated_at: row.revision,
        source_authority: row.authority,
        source_external_id: row.external_id,
        source_official_url: row.official_url,
        source_is_authoritative: true,
        title: row.title,
        description: row.description,
        hazard: row.hazard,
        remedy: row.remedy,
        recall_date: row.recall_day,
        raw_payload: row.raw_payload,
        scopes: row.scopes,
      }));
      await hooks.afterList?.(mapped);
      return mapped;
    },
    async listRecallCandidateProducts(input) {
      const rows = await rpc(
        `select c.*, c.owned_product_updated_at::text as revision,
          c.purchase_date::text as purchase_day
        from public.get_recall_candidates($1, $2, $3, $4) c`,
        [input.recallNoticeId, input.afterExactRank, input.afterProductId, input.limit],
      );
      return rows.map(({ revision, purchase_day, ...row }) => ({
        ...row,
        owned_product_updated_at: revision,
        purchase_date: purchase_day,
      }));
    },
    async claimPair(input) {
      await hooks.beforeClaim?.(input);
      const [row] = await rpc(
        // Text casts keep microseconds: postgres.js would round-trip a
        // timestamptz parameter through Date.
        `select * from public.claim_recall_match_evaluation($1, $2, $3, $4::text::timestamptz,
          $5::text::timestamptz, $6)`,
        [
          input.ownedProductId,
          input.recallNoticeId,
          input.evidenceFingerprint,
          input.expectedProductUpdatedAt,
          input.expectedRecallUpdatedAt,
          input.leaseSeconds,
        ],
      );
      const claim =
        row.status === 'claimed'
          ? { status: 'claimed', leaseToken: row.lease_token }
          : { status: row.status };
      await hooks.afterClaim?.(input, claim);
      return claim;
    },
    async finalizePair(input) {
      const [row] = await rpc(
        `select * from public.finalize_recall_match_evaluation($1, $2, $3, $4::text::timestamptz,
          $5::text::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          input.ownedProductId,
          input.recallNoticeId,
          input.evidenceFingerprint,
          input.expectedProductUpdatedAt,
          input.expectedRecallUpdatedAt,
          input.leaseToken,
          input.status,
          input.confidence,
          input.matchMethod,
          input.matchedIdentifiers,
          input.reasoningSummary,
          input.aiProvider,
          input.aiModel,
          input.schemaVersion,
        ],
      );
      return {
        status: row.status,
        recallMatchId: row.recall_match_id,
        alertId: row.alert_id,
        alertOutcome: row.alert_outcome,
      };
    },
  };
}

// The automation store, identical in RPC use to run-recall-automation/store.ts
// (16.33) or, for the replay, to its Phase 12 (HEAD) predecessor.
function automationStore({ phase12 = false } = {}) {
  const sql = postgres(LOCAL_DB, { max: 1, onnotice: () => {} });
  const rpc = (text, params) =>
    sql.begin(async (tx) => {
      await tx.unsafe('set local role service_role');
      return tx.unsafe(text, params);
    });
  return {
    close: () => sql.end({ timeout: 1 }),
    async claimRun(input) {
      const [row] = await rpc(
        `select c.*, c.window_start::text as window_start, c.window_end::text as window_end
          from public.claim_recall_automation_run($1, $2, $3, $4, $5, $6) c`,
        [
          input.trigger,
          input.verificationMode,
          input.maxRecalls,
          input.maxCandidatePairs,
          input.maxAiEscalations,
          input.notificationBatchSize,
        ],
      );
      if (row.claim_status !== 'claimed') return { status: row.claim_status, runId: row.run_id };
      return {
        status: 'claimed',
        runId: row.run_id,
        leaseToken: row.lease_token,
        windowStart: String(row.window_start),
        windowEnd: String(row.window_end),
        maxRecalls: row.max_recalls,
        maxCandidatePairs: row.max_candidate_pairs,
        maxAiEscalations: row.max_ai_escalations,
        notificationBatchSize: row.notification_batch_size,
        aiEnabled: row.ai_enabled,
        pushEnabled: row.push_enabled,
      };
    },
    async recordIngestion(input) {
      await rpc('select public.record_recall_automation_ingestion($1, $2, $3, $4, $5, $6, $7)', [
        input.runId,
        input.leaseToken,
        input.summary.fetched,
        input.summary.inserted,
        input.summary.updated,
        input.summary.unchanged,
        input.summary.affectedRecallIds,
      ]);
    },
    async listPendingRecalls(input) {
      const rows = await rpc(
        'select * from public.get_recall_automation_pending_recalls($1, $2, $3)',
        [input.runId, input.leaseToken, input.limit],
      );
      return rows.map((row) => row.recall_notice_id);
    },
    async recordMatching(input) {
      const s = input.summary;
      const metrics = [
        s.candidatePairs,
        s.deterministicResolved,
        s.confirmed,
        s.rejected,
        s.needsReview,
        s.nemotronEscalated,
        s.providerFailures,
        s.alertsCreated,
      ];
      if (phase12) {
        await rpc(
          `select public.record_recall_automation_matching($1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12)`,
          [input.runId, input.leaseToken, input.recallNoticeIds, input.complete, ...metrics],
        );
        return;
      }
      await rpc(
        `select public.record_recall_automation_matching_outcome($1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12)`,
        [
          input.runId,
          input.leaseToken,
          input.resolvedRecallIds,
          sql.json(input.unresolvedRecalls),
          ...metrics,
        ],
      );
    },
    async completeRun(input) {
      await rpc('select public.complete_recall_automation_run($1, $2, $3, 0, 0, 0, $4, $5)', [
        input.runId,
        input.leaseToken,
        input.status,
        input.errorStep,
        input.errorCode,
      ]);
    },
  };
}

// The child call goes through the real response parser (children.ts) by
// serving the legacyRun JSON body through a stubbed fetch.
async function matchThroughChildParser(summary) {
  const body = JSON.stringify({
    recallsProcessed: summary.recallsProcessed,
    candidatePairs: summary.candidatePairs,
    deterministicResolved: summary.deterministicResolved,
    nemotronEscalated: summary.nemotronEscalated,
    confirmed: summary.confirmed,
    rejected: summary.rejected,
    needsReview: summary.needsReview,
    alertsCreated: summary.alertsCreated,
    alertsExisting: summary.alertsExisting,
    failures: summary.failures,
    retries: summary.retries,
    duration: summary.duration,
    unchangedSkipped: summary.unchangedSkipped,
    busySkipped: summary.busySkipped,
    staleSkipped: summary.staleSkipped,
    providerFailures: summary.providerFailures,
    limitsReached: summary.limitsReached,
    usage: summary.usage,
    resolvedRecallIds: summary.resolvedRecallIds,
    unresolvedRecalls: summary.unresolvedRecalls,
    pushDelivery: null,
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status: 200 });
  try {
    return await new RecallAutomationChildren('http://local.invalid/functions/v1', {
      ingestion: 'x',
      matching: 'x',
      push: 'x',
    }).match({ recallNoticeIds: [], maxRecalls: 1, maxCandidatePairs: 1, maxAiEscalations: 0 });
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function automationCycle({
  affected,
  hooks = {},
  orchestrator = runRecallAutomation,
  phase12 = false,
  crashAfterMatching = false,
} = {}) {
  const store = automationStore({ phase12 });
  const matcherStore = matchingStore(hooks);
  let matchingSummary = null;
  try {
    const dependencies = {
      store,
      async ingest() {
        return {
          fetched: affected.length,
          inserted: 0,
          updated: affected.length,
          unchanged: 0,
          rejected: 0,
          affectedRecallIds: affected,
          sourceFailures: 0,
          successfulSources: 1,
          sources: [{ sourceKey: 'cpsc', status: 'success' }],
        };
      },
      async match(input) {
        matchingSummary = await processRecallMatches(
          {
            maxRecalls: input.maxRecalls,
            maxCandidatePairs: input.maxCandidatePairs,
            maxNebiusCalls: 0,
            recallNoticeIds: input.recallNoticeIds,
          },
          {
            store: matcherStore,
            modelId: MODEL_ID,
            createNemotronEvaluator() {
              throw new Error('AI is never used here');
            },
          },
        );
        if (crashAfterMatching)
          throw Object.assign(new Error('terminated'), { code: 'terminated' });
        return phase12 ? matchingSummary : matchThroughChildParser(matchingSummary);
      },
      async push() {
        return { claimed: 0, accepted: 0, failed: 0, invalidDevices: 0, transientFailures: 0 };
      },
      pushDeliveryGateEnabled: false,
    };
    if (crashAfterMatching) {
      // A terminated process never records its matching or completes its run.
      const claim = await store.claimRun({
        trigger: 'manual',
        verificationMode: false,
        maxRecalls: 20,
        maxCandidatePairs: 200,
        maxAiEscalations: 0,
        notificationBatchSize: 10,
      });
      await store.recordIngestion({
        runId: claim.runId,
        leaseToken: claim.leaseToken,
        summary: await dependencies.ingest(),
      });
      const pending = await store.listPendingRecalls({
        runId: claim.runId,
        leaseToken: claim.leaseToken,
        limit: 20,
      });
      await dependencies
        .match({ recallNoticeIds: pending, maxRecalls: pending.length, maxCandidatePairs: 200 })
        .catch(() => {});
      return { status: 'terminated', runId: claim.runId, matching: matchingSummary };
    }
    const result = await orchestrator(
      {
        trigger: 'manual',
        verificationMode: false,
        maxRecalls: 20,
        maxCandidatePairs: 200,
        maxAiEscalations: 0,
        notificationBatchSize: 10,
      },
      dependencies,
    );
    return { ...result, matching: matchingSummary };
  } finally {
    await store.close();
    await matcherStore.close();
  }
}

// A page-ledger touch from its own session: the real 16.13 function.
async function pageLedgerTouch(identity) {
  const sql = postgres(LOCAL_DB, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql`select private.cpsc_touch_identity_notices(${identity}::uuid) as n`;
    return row.n;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

const pending = async () =>
  (
    await admin`select n.external_id, p.unresolved_attempts, p.last_unresolved_reason,
      p.exhausted_at is not null as exhausted
    from private.recall_automation_pending_recalls p
    join public.recall_notices n on n.id = p.recall_notice_id
    where n.external_id like 'cpsc:9339%' order by n.external_id`
  ).map((row) => ({ ...row }));
const matchesFor = async (recall) =>
  (
    await admin`select m.owned_product_id, m.status, (select count(*) from public.alerts a
      where a.recall_match_id = m.id)::int as alerts
    from public.recall_matches m where m.recall_notice_id = ${recall}::uuid
      and m.status = 'confirmed'
    order by m.owned_product_id`
  ).map((row) => ({ ...row }));
const upc = (body) => {
  const digits = body.split('').map(Number);
  const sum = digits.reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return body + String((10 - (sum % 10)) % 10);
};

async function setup() {
  await admin`update private.recall_automation_control
    set enabled = true, ai_enabled = false, push_enabled = false, updated_at = now() where singleton`;
  await admin`delete from private.recall_automation_lease`;
  const [{ source }] = await admin`select public.ensure_cpsc_recall_source() as source`;
  const recalls = ['93391', '93392', '93393', '93394', '93395', '93396'];
  for (const [index, number] of recalls.entries()) {
    const gtin = upc(`09${number}0000`);
    await admin`insert into public.recall_notices (id, source_id, external_id, title, description,
        hazard, remedy, recall_date, official_url, retrieved_at, raw_payload)
      values (${id(`10${number}`)}, ${source}, ${`cpsc:${number}`}, ${`Zq${number}`},
        'Official description.', 'Hazard.', 'Stop use.', '2026-09-20',
        ${`https://www.cpsc.gov/Recalls/2026/P1633-Harness-${number}`}, now(),
        ${admin.json({ RecallNumber: number })})`;
    // 93396 has no candidate product at all (an unrelated recall).
    await admin`insert into public.recall_scopes (recall_notice_id, brand, product_name, gtin,
        additional_criteria)
      values (${id(`10${number}`)}, ${`Brandq${number}`}, ${`Zq${number}`},
        ${number === '93396' ? upc('09999999999') : gtin}, ${admin.json({ evidence_level: 'product' })})`;
    await admin`insert into private.cpsc_source_identities (id, source_id, official_recall_number,
        canonical_url, canonical_notice_id, identity_status)
      values (${id(`30${number}`)}, ${source}, ${number},
        ${`https://www.cpsc.gov/Recalls/2026/P1633-Harness-${number}`}, ${id(`10${number}`)},
        'reconciled')`;
    await admin`insert into private.cpsc_notice_identity_links (notice_id, identity_id, provenance)
      values (${id(`10${number}`)}, ${id(`30${number}`)}, 'Phase 16.33 harness')`;
    for (const owner of [1, 2]) {
      if (number === '93396') continue;
      const userId = id(`9${index}${owner}`);
      await admin`insert into auth.users (id, aud, role, email, encrypted_password,
          email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        values (${userId}, 'authenticated', 'authenticated',
          ${`p1633-harness-${index}-${owner}@example.invalid`}, '', now(), '{}', '{}', now(), now())
        on conflict do nothing`;
      await admin`insert into public.owned_products (id, user_id, brand, product_name, category,
          gtin, identification_method)
        values (${id(`5${index}${owner}`)}, ${userId}, ${`Brandq${number}`}, ${`Zq${number}`},
          'Stroller', ${gtin}, 'barcode')`;
    }
  }
  // Non-matching products keep the inventory realistic.
  await admin`insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values (${id('999')}, 'authenticated', 'authenticated', 'p1633-harness-other@example.invalid',
      '', now(), '{}', '{}', now(), now())`;
  for (let n = 0; n < 5; n += 1) {
    await admin`insert into public.owned_products (id, user_id, brand, product_name, gtin)
      values (${id(`70${n}`)}, ${id('999')}, 'Otherq', ${`Unrelatedq${n}`}, ${upc(`0123456789${n}`)})`;
  }
  return Object.fromEntries(recalls.map((number) => [number, id(`10${number}`)]));
}

async function main() {
  const [{ migrations }] = await admin`select count(*)::int as migrations
    from supabase_migrations.schema_migrations`;
  const R = await setup();
  const [{ products }] = await admin`select count(*)::int as products from public.owned_products`;
  check('non-empty product inventory', products >= 15, { products });

  // ---- Defect reproduction with the Phase 12 (HEAD) orchestrator ----------
  const headDir = mkdtempSync(join(tmpdir(), 'p1633-head-'));
  for (const file of ['orchestrator.ts', 'types.ts']) {
    const path = join(headDir, 'automation', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      execFileSync('git', ['show', `HEAD:supabase/functions/_shared/automation/${file}`]),
    );
  }
  const { runRecallAutomation: runPhase12 } = await import(
    pathToFileURL(join(headDir, 'automation', 'orchestrator.ts')).href
  );
  const touchOnce = (recall, identity) => {
    let done = false;
    return {
      async afterClaim(input, claim) {
        if (!done && claim.status === 'claimed' && input.recallNoticeId === recall) {
          done = true;
          await pageLedgerTouch(identity);
        }
      },
    };
  };
  const head = await automationCycle({
    affected: [R['93391']],
    orchestrator: runPhase12,
    phase12: true,
    hooks: touchOnce(R['93391'], id('3093391')),
  });
  const headPending = await pending();
  const headMatches = await matchesFor(R['93391']);
  check(
    'DEFECT reproduced: Phase 12 acknowledges a run with a stale pair as success',
    head.status === 'success' && head.matching.staleSkipped === 2,
    {
      status: head.status,
      staleSkipped: head.matching.staleSkipped,
    },
  );
  check(
    'DEFECT reproduced: the recall left pending while both legitimate matches are missing',
    headPending.length === 0 && headMatches.length === 0,
    { headPending, headMatches },
  );

  // ---- Corrected path ------------------------------------------------------
  // 1. Recall updated during matching (page ledger from another session).
  const c1 = await automationCycle({
    affected: [R['93391'], R['93392']],
    hooks: touchOnce(R['93392'], id('3093392')),
  });
  check(
    'recall updated during matching: the run is not acknowledged as complete',
    c1.status === 'partial_success' && c1.errorCode === 'matching_retry_pending',
    {
      status: c1.status,
      errorCode: c1.errorCode,
    },
  );
  check(
    'stale pair keeps its recall pending with an observable reason',
    JSON.stringify(await pending()) ===
      JSON.stringify([
        {
          external_id: 'cpsc:93392',
          unresolved_attempts: 1,
          last_unresolved_reason: 'stale',
          exhausted: false,
        },
      ]),
    await pending(),
  );
  check(
    'the lost Phase 12 pair is matched once its recall is affected again',
    (await matchesFor(R['93391'])).length === 2,
    await matchesFor(R['93391']),
  );

  // 2. Stale pair followed by successful retry.
  const c2 = await automationCycle({ affected: [] });
  check(
    'stale pair followed by successful retry',
    c2.status === 'success' &&
      (await pending()).length === 0 &&
      (await matchesFor(R['93392'])).length === 2,
    {
      status: c2.status,
      matches: await matchesFor(R['93392']),
    },
  );

  // 3. Multiple updates to the same recall across cycles.
  const touchEvery = (recall, identity) => ({
    async afterClaim(input, claim) {
      if (claim.status === 'claimed' && input.recallNoticeId === recall)
        await pageLedgerTouch(identity);
    },
  });
  await automationCycle({ affected: [R['93393']], hooks: touchEvery(R['93393'], id('3093393')) });
  await automationCycle({ affected: [], hooks: touchEvery(R['93393'], id('3093393')) });
  check(
    'multiple updates to the same recall keep it pending with a growing count',
    (await pending())[0]?.unresolved_attempts === 2 && (await matchesFor(R['93393'])).length === 0,
    await pending(),
  );
  await automationCycle({ affected: [] });
  check(
    'after the updates stop, every legitimate match is confirmed',
    (await pending()).length === 0 && (await matchesFor(R['93393'])).length === 2,
    await matchesFor(R['93393']),
  );

  // 4. Process termination before retry.
  const crash = await automationCycle({
    affected: [R['93394']],
    crashAfterMatching: true,
    hooks: touchOnce(R['93394'], id('3093394')),
  });
  check(
    'a terminated run leaves its work pending',
    crash.status === 'terminated' &&
      (await pending()).some((row) => row.external_id === 'cpsc:93394'),
    await pending(),
  );
  // Time simulation: the dead run's lease expires.
  await admin`update private.recall_automation_lease
    set claimed_at = now() - interval '2 hours', expires_at = now() - interval '1 second'`;
  const recovered = await automationCycle({ affected: [] });
  check(
    "the next cycle recovers the terminated run's work",
    recovered.status === 'success' && (await matchesFor(R['93394'])).length === 2,
    {
      status: recovered.status,
      matches: await matchesFor(R['93394']),
    },
  );

  // 5. Concurrent matching executions and duplicate delivery. Execution A holds
  // a pair while execution B (a manual run of the same recall) meets it busy.
  let bResult = null;
  const hookA = {
    async afterClaim(input, claim) {
      if (claim.status === 'claimed' && input.recallNoticeId === R['93395'] && !bResult) {
        const storeB = matchingStore();
        try {
          bResult = await processRecallMatches(
            {
              maxRecalls: 1,
              maxCandidatePairs: 50,
              maxNebiusCalls: 0,
              recallNoticeIds: [R['93395']],
            },
            {
              store: storeB,
              modelId: MODEL_ID,
              createNemotronEvaluator() {
                throw new Error('no AI');
              },
            },
          );
        } finally {
          await storeB.close();
        }
      }
    },
  };
  const cA = await automationCycle({ affected: [R['93395']], hooks: hookA });
  check(
    'concurrent executions: B meets a busy pair and reports the recall unresolved',
    bResult !== null &&
      bResult.busySkipped >= 1 &&
      bResult.unresolvedRecalls.some((u) => u.reason === 'busy'),
    {
      busy: bResult.busySkipped,
      unresolved: bResult.unresolvedRecalls,
    },
  );
  check(
    'concurrent executions: A finalizes; every pair matched exactly once',
    cA.status === 'success' &&
      (await matchesFor(R['93395'])).length === 2 &&
      (await matchesFor(R['93395'])).every((m) => m.alerts === 1),
    {
      status: cA.status,
      matches: await matchesFor(R['93395']),
    },
  );
  const again = await automationCycle({ affected: [R['93395']] });
  check(
    'duplicate delivery of the same work is unchanged and creates nothing',
    again.status === 'success' &&
      again.matching.unchangedSkipped === 2 &&
      again.matching.alertsCreated === 0 &&
      (await matchesFor(R['93395'])).length === 2,
    {
      unchanged: again.matching.unchangedSkipped,
      alerts: again.matching.alertsCreated,
    },
  );

  // 6. Unrelated and unchanged recalls resolve without work.
  const quiet = await automationCycle({ affected: [R['93396'], R['93392']] });
  check(
    'an unrelated recall (no candidates) and an unchanged recall both resolve',
    quiet.status === 'success' &&
      quiet.matching.resolvedRecallIds.length === 2 &&
      quiet.matching.candidatePairs === 2 &&
      quiet.matching.unchangedSkipped === 2 &&
      (await pending()).length === 0,
    {
      resolved: quiet.matching.resolvedRecallIds,
      pairs: quiet.matching.candidatePairs,
    },
  );

  // 7. Retry exhaustion: the recall is touched during every cycle.
  await admin`update public.recall_notices set title = title || ' (exhaustion)'
    where id = ${R['93391']}::uuid`;
  let cycles = 0;
  for (; cycles < 8; cycles += 1) {
    await automationCycle({
      affected: cycles === 0 ? [R['93391']] : [],
      hooks: touchEvery(R['93391'], id('3093391')),
    });
  }
  const exhausted = await pending();
  check(
    'retry exhaustion becomes an explicit, observable state after 8 cycles',
    exhausted.length === 1 && exhausted[0].exhausted && exhausted[0].unresolved_attempts === 8,
    exhausted,
  );
  const skipped = await automationCycle({ affected: [] });
  check(
    'an exhausted recall is not retried again the same day',
    skipped.matching === null && (await pending())[0].unresolved_attempts === 8,
    { matching: skipped.matching },
  );
  await admin`update private.recall_automation_pending_recalls
    set last_attempted_at = now() - interval '25 hours'`;
  const daily = await automationCycle({ affected: [] });
  check(
    'after 24 hours the exhausted recall is retried and resolves',
    daily.status === 'success' && (await pending()).length === 0,
    { status: daily.status },
  );

  // Final invariant: no silent loss. Every designed match exists exactly once
  // with one alert, or its recall is explicitly pending.
  const designed = await admin`select p.id as product, r.id as recall
    from public.owned_products p join public.recall_scopes s on s.gtin = p.gtin
    join public.recall_notices r on r.id = s.recall_notice_id
    where r.external_id like 'cpsc:9339%'`;
  const lost = [];
  for (const pair of designed) {
    const [row] = await admin`select count(*)::int as matches,
        (select count(*)::int from public.alerts a join public.recall_matches m2
          on m2.id = a.recall_match_id where m2.owned_product_id = ${pair.product}::uuid
          and m2.recall_notice_id = ${pair.recall}::uuid) as alerts,
        exists (select 1 from private.recall_automation_pending_recalls
          where recall_notice_id = ${pair.recall}::uuid) as pending
      from public.recall_matches where owned_product_id = ${pair.product}::uuid
        and recall_notice_id = ${pair.recall}::uuid`;
    if (!(row.matches === 1 && row.alerts === 1) && !row.pending) lost.push({ ...pair, ...row });
  }
  check(
    'no silent loss: every legitimate match is confirmed once or explicitly pending',
    designed.length === 10 && lost.length === 0,
    { designed: designed.length, lost },
  );
  const [{ dupes }] = await admin`select count(*)::int as dupes from (select owned_product_id,
    recall_notice_id from public.recall_matches group by 1, 2 having count(*) > 1) d`;
  check('no duplicated matches anywhere', dupes === 0, { dupes });
  const [{ outcomes }] = await admin`select jsonb_object_agg(outcome, n) as outcomes from (
    select outcome, count(*)::int n from private.recall_automation_matching_outcomes group by 1) o`;
  process.stdout.write(
    `${JSON.stringify(
      {
        migrations,
        checks: results.length,
        passed: results.filter((r) => r.ok).length,
        outcomes,
        results,
      },
      null,
      2,
    )}\n`,
  );
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(() => admin.end({ timeout: 1 }));
