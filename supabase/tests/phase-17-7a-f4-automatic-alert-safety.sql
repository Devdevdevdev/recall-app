-- Phase 17.7a F-4: an automatic alert requires a server-derived proof that the
-- official scope is complete for this product. The positive case uses the real
-- Phase 16 review path (worker proposal, MFA human review, materialization,
-- coverage ledger, outside-census attestation); nothing is stubbed here.
begin;
set local role postgres;
set local search_path = extensions, public, auth;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

-- ---------------------------------------------------------------------------
-- Privilege boundary
-- ---------------------------------------------------------------------------
select extensions.ok(not has_function_privilege(r, f, 'EXECUTE'), format('%s cannot execute %s', r, f))
from unnest(array['anon', 'authenticated', 'service_role']) r,
  unnest(array[
    'private.automatic_alert_identifier(text)',
    'private.automatic_alert_jurisdiction(text,jsonb)',
    'private.automatic_alert_eligibility(uuid,uuid)',
    'private.require_safe_v1_alert()',
    'private.require_safe_v2_eligibility()',
    'private.require_safe_v2_alert_snapshot()',
    'private.require_safe_confirmation()',
    'private.automatic_alert_rule_set_valid(jsonb,text,text,text)',
    'private.automatic_alert_classification(boolean,text,text,text,text,text,jsonb,jsonb)',
    'private.neutralize_unsafe_automatic_alerts(boolean)']) f;
select extensions.ok(
  has_function_privilege('service_role', 'public.finalize_recall_match_evaluation(uuid,uuid,text,timestamptz,timestamptz,uuid,public.recall_match_status,numeric,text,jsonb,text,text,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.finalize_recall_match_evaluation(uuid,uuid,text,timestamptz,timestamptz,uuid,public.recall_match_status,numeric,text,jsonb,text,text,text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.finalize_recall_match_evaluation(uuid,uuid,text,timestamptz,timestamptz,uuid,public.recall_match_status,numeric,text,jsonb,text,text,text,text)', 'EXECUTE'),
  'the recreated v1 finalizer keeps its service_role-only grant');
select extensions.is(
  (select count(*)::integer from pg_trigger where not tgisinternal and tgname in (
    'alerts_require_safe_scope', 'recall_alert_eligibility_v2_require_safe_scope',
    'recall_alert_snapshots_v2_require_safe_scope', 'recall_matches_require_safe_confirmation',
    'recall_match_evaluations_v2_require_safe_confirmation')),
  5, 'every automatic alert, eligibility, and confirmation write is guarded');
select extensions.ok(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prokind = 'f'
      and pg_get_functiondef(p.oid) ~* '(bypass|skip|force)_?(safety|proof|gate)|automatic_alert_override')
  and (select provolatile from pg_proc where oid = 'private.automatic_alert_classification(boolean,text,text,text,text,text,jsonb,jsonb)'::regprocedure) = 'i'
  and (select prosecdef from pg_proc where oid = 'private.automatic_alert_eligibility(uuid,uuid)'::regprocedure)
  and (select proconfig from pg_proc where oid = 'private.automatic_alert_eligibility(uuid,uuid)'::regprocedure) = array['search_path=""'],
  'no bypass routine exists; the proof is definer with an empty search_path and a pure classifier');

-- ---------------------------------------------------------------------------
-- Parity with the TypeScript gate (the Node suite reads these same rows).
-- ---------------------------------------------------------------------------
-- jurisdiction-parity-cases:start
select extensions.is(private.automatic_alert_jurisdiction(c.country, c.jurisdictions::jsonb), c.expected,
  'jurisdiction parity: ' || c.label)
from (values
  ('us-us', 'US', '[{"type":"country","code":"US"}]', 'compatible'),
  ('us-ca', 'CA', '[{"type":"country","code":"US"}]', 'jurisdiction_mismatch'),
  ('ca-ca', 'CA', '[{"type":"country","code":"CA"}]', 'compatible'),
  ('ca-us', 'US', '[{"type":"country","code":"CA"}]', 'jurisdiction_mismatch'),
  ('unknown-us', NULL, '[{"type":"country","code":"US"}]', 'incomplete_evidence'),
  ('unknown-global', NULL, '[{"type":"global","code":"GLOBAL"}]', 'compatible'),
  ('multi-country', 'CA', '[{"type":"country","code":"US"},{"type":"country","code":"CA"}]', 'compatible'),
  ('region-only', 'FR', '[{"type":"region","code":"EU"}]', 'human_review_required'),
  ('none', 'US', '[]', 'unsupported_scope'),
  ('malformed-row', 'US', '[{"type":"country","code":"usa"}]', 'human_review_required'),
  ('malformed-country', 'usa', '[{"type":"country","code":"US"}]', 'human_review_required')
) c(label, country, jurisdictions, expected);
-- jurisdiction-parity-cases:end

-- identifier-parity-cases:start
select extensions.is(private.automatic_alert_identifier(c.input), c.expected,
  'identifier normalization: ' || c.label)
from (values
  ('trim-collapse-upper', '  ak396h-mbk  /  v1.2 ', 'AK396H-MBK / V1.2'),
  ('fullwidth-nfkc', 'ＭＯＤＥＬ－１', 'MODEL-1'),
  ('date-code', '2501', '2501'),
  ('tab-newline', E'model\t-\n1', 'MODEL - 1'),
  ('non-ascii-never-matches', 'café', NULL),
  ('blank', '   ', NULL)
) c(label, input, expected);
-- identifier-parity-cases:end

-- gate-parity-cases:start (generated by scripts/generate-phase-17-7a-f4-parity-cases.mjs;
-- tests/phase-17-7a-f4-safety.test.mjs runs the same cases through the TypeScript path)
select extensions.is(private.automatic_alert_classification((c->>'authoritative')::boolean,
    c->>'authority', c->>'url', c->>'country', c->>'model', c->>'dateCode',
    c->'jurisdictions', c->'scopes'), c->>'expected', 'gate parity: ' || (c->>'label'))
from jsonb_array_elements($cases$[{"label":"non_official_source","authoritative":false,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001020","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/2","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001021","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/2","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-2","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001020","17a4f000-0000-4000-8000-000000001021"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002020","17a4f000-0000-4000-8000-000000002021"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["2222222222222222222222222222222222222222222222222222222222222222","3333333333333333333333333333333333333333333333333333333333333333"],"ruleSetFingerprint":"6785363ab15316149583491226890ff3af75e50e5f4ab451b9d832af4451f86d"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"unsupported_scope"},{"label":"coverage_incomplete","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001030","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/3","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001031","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/3","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-3","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001030","17a4f000-0000-4000-8000-000000001031"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002030","17a4f000-0000-4000-8000-000000002031"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["3333333333333333333333333333333333333333333333333333333333333333","4444444444444444444444444444444444444444444444444444444444444444"],"ruleSetFingerprint":"765de7caaa05af9d1aa3163e3eb55de64604decf7e92830185af793d7d6abf59"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":false,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"unsupported_scope"},{"label":"negative_evidence_not_eligible","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001040","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/4","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001041","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/4","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-4","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001040","17a4f000-0000-4000-8000-000000001041"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002040","17a4f000-0000-4000-8000-000000002041"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["4444444444444444444444444444444444444444444444444444444444444444","5555555555555555555555555555555555555555555555555555555555555555"],"ruleSetFingerprint":"41205075ac327500f7d3614f8654c21406fff7d96a99f9b9f13f56d69a43ac59"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":false}}}}],"expected":"unsupported_scope"},{"label":"ambiguous_rule_set_only","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"ambiguous","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001050","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/5","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001051","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/5","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-5","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001050","17a4f000-0000-4000-8000-000000001051"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002050","17a4f000-0000-4000-8000-000000002051"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["5555555555555555555555555555555555555555555555555555555555555555","6666666666666666666666666666666666666666666666666666666666666666"],"ruleSetFingerprint":"a61c5719d8918be338da52518899ac92f07c489b5376eda0d390ba7bce49ae4a"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":0,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"unsupported_scope"},{"label":"ambiguous_next_to_valid","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001010","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/1","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001011","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/1","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001010","17a4f000-0000-4000-8000-000000001011"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002010","17a4f000-0000-4000-8000-000000002011"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["1111111111111111111111111111111111111111111111111111111111111111","2222222222222222222222222222222222222222222222222222222222222222"],"ruleSetFingerprint":"f85e600bafb5e84fa64ca9bd711c001d772bd63ab70b25e407f45e3bdf81ad95"}},{"semantics":"ambiguous","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001060","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/6","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-6","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001060"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002060"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["6666666666666666666666666666666666666666666666666666666666666666"],"ruleSetFingerprint":"dd072776ce748811216a472504d5f8d9e83faa08983b243082470cf98e076adc"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":2,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"human_review_required"},{"label":"unsupported_criterion_kind","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001070","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/7","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001071","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/7","normalizationRule":"identifier_v2"},"kind":"lot_number","operator":"equals","value":"1500"}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-7","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001070","17a4f000-0000-4000-8000-000000001071"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002070","17a4f000-0000-4000-8000-000000002071"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["7777777777777777777777777777777777777777777777777777777777777777","8888888888888888888888888888888888888888888888888888888888888888"],"ruleSetFingerprint":"a48908715d6a93d198aaea1dd0acec2f3c5b3704b326606d650847f79774361d"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":0,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"unsupported_scope"},{"label":"no_model_anchor","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001080","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/8","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-8","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001080"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002080"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["8888888888888888888888888888888888888888888888888888888888888888"],"ruleSetFingerprint":"3175a9f924f5607280a48b37cfa037f81914aed1e67d052668c50ca5447ae38a"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":0,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"unsupported_scope"},{"label":"stale_review_not_served","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":null}],"expected":"unsupported_scope"},{"label":"model_matched","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":null,"jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001090","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/9","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-9","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001090"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002090"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["9999999999999999999999999999999999999999999999999999999999999999"],"ruleSetFingerprint":"e6307fc2efd60c5958938a36729f4c1845a15cf93ab4b40bc6e87e6175a1d538"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"eligible"},{"label":"model_and_date_code_matched","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2502","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001100","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/10","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001101","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/10","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-10","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001100","17a4f000-0000-4000-8000-000000001101"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002100","17a4f000-0000-4000-8000-000000002101"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["0000000000000000000000000000000000000000000000000000000000000000","1111111111111111111111111111111111111111111111111111111111111111"],"ruleSetFingerprint":"128e9540dabc125aed749fe5597cc4c89035c7aaa4979314be2ee86735d6e36d"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"eligible"},{"label":"fullwidth_model_normalized","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"ＭＯＤＥＬ－１","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001110","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/11","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001111","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/11","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-11","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001110","17a4f000-0000-4000-8000-000000001111"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002110","17a4f000-0000-4000-8000-000000002111"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["1111111111111111111111111111111111111111111111111111111111111111","2222222222222222222222222222222222222222222222222222222222222222"],"ruleSetFingerprint":"d2afb8e7e4a45db34603a91af0e3c3ec7590f93f0f1ae401f41a87643abc8fca"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"eligible"},{"label":"date_code_mismatch","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2599","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001120","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/12","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001121","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/12","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-12","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001120","17a4f000-0000-4000-8000-000000001121"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002120","17a4f000-0000-4000-8000-000000002121"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["2222222222222222222222222222222222222222222222222222222222222222","3333333333333333333333333333333333333333333333333333333333333333"],"ruleSetFingerprint":"f9599cf781a311a92f1f12d1bd3a4e7c0d1b9baa4bb7cebd928623175bbaf0a1"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"criteria_not_satisfied"},{"label":"missing_required_date_code","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":null,"jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001130","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/13","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001131","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/13","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-13","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001130","17a4f000-0000-4000-8000-000000001131"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002130","17a4f000-0000-4000-8000-000000002131"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["3333333333333333333333333333333333333333333333333333333333333333","4444444444444444444444444444444444444444444444444444444444444444"],"ruleSetFingerprint":"6a3cb5e2d3679680de76d8af4dd2fb30447a0c4cb71eed27453f9d8b90512357"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"criteria_not_satisfied"},{"label":"wrong_model","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-9","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001140","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/14","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001141","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/14","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-14","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001140","17a4f000-0000-4000-8000-000000001141"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002140","17a4f000-0000-4000-8000-000000002141"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["4444444444444444444444444444444444444444444444444444444444444444","5555555555555555555555555555555555555555555555555555555555555555"],"ruleSetFingerprint":"5d9d216d4930fcb8430bb18a629987acfe7895572637807d289762e99b4cbc31"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"criteria_not_satisfied"},{"label":"jurisdiction_mismatch","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"CA","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001150","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/15","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001151","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/15","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-15","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001150","17a4f000-0000-4000-8000-000000001151"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002150","17a4f000-0000-4000-8000-000000002151"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["5555555555555555555555555555555555555555555555555555555555555555","6666666666666666666666666666666666666666666666666666666666666666"],"ruleSetFingerprint":"94f7c44bf89d8d3bf5fbf2628a7a0ece0c63feb169212c329e41ef9a6c87b1ff"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"jurisdiction_mismatch"},{"label":"unknown_country_country_notice","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":null,"model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001160","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/16","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001161","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/16","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-16","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001160","17a4f000-0000-4000-8000-000000001161"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002160","17a4f000-0000-4000-8000-000000002161"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["6666666666666666666666666666666666666666666666666666666666666666","7777777777777777777777777777777777777777777777777777777777777777"],"ruleSetFingerprint":"3a3970ec81a4302a90a3f377da12d2c4ed615a1d9ada14dbd96aa072d8f96730"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"incomplete_evidence"},{"label":"global_notice_unknown_country","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":null,"model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"global","code":"GLOBAL"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001170","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/17","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001171","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/17","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-17","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001170","17a4f000-0000-4000-8000-000000001171"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002170","17a4f000-0000-4000-8000-000000002171"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["7777777777777777777777777777777777777777777777777777777777777777","8888888888888888888888888888888888888888888888888888888888888888"],"ruleSetFingerprint":"6e325b6f75d658459cfce4c9476d85e3756833679799056465b63c8f538419ba"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"eligible"},{"label":"multi_scope_matches_scope_1","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001180","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/18","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001181","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/18","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-18","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001180","17a4f000-0000-4000-8000-000000001181"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002180","17a4f000-0000-4000-8000-000000002181"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["8888888888888888888888888888888888888888888888888888888888888888","9999999999999999999999999999999999999999999999999999999999999999"],"ruleSetFingerprint":"5299d9a8af5c60106cf2c35397da3ad6befc249f72c25ffa26d9950806ecbb73"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}},{"scopeId":"17a4f000-0000-4000-8000-0000000000a2","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a2","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001190","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/19","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-2"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001191","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/19","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"equals","value":"2601"}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-19","scopeId":"17a4f000-0000-4000-8000-0000000000a2","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001190","17a4f000-0000-4000-8000-000000001191"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002190","17a4f000-0000-4000-8000-000000002191"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["9999999999999999999999999999999999999999999999999999999999999999","0000000000000000000000000000000000000000000000000000000000000000"],"ruleSetFingerprint":"ef19a05d9828abeccf33316be31cd2e7d18b14dd8df07dc20a3546f42c35544d"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"eligible"},{"label":"multi_scope_matches_scope_2","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-2","dateCode":"2601","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001200","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/20","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001201","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/20","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-20","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001200","17a4f000-0000-4000-8000-000000001201"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002200","17a4f000-0000-4000-8000-000000002201"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["0000000000000000000000000000000000000000000000000000000000000000","1111111111111111111111111111111111111111111111111111111111111111"],"ruleSetFingerprint":"8e45d55e6f05818fa88da40e1d092e6d433efc473775c21a5537ee1b6f5d375b"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}},{"scopeId":"17a4f000-0000-4000-8000-0000000000a2","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a2","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001210","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/21","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-2"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001211","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/21","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"equals","value":"2601"}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-21","scopeId":"17a4f000-0000-4000-8000-0000000000a2","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001210","17a4f000-0000-4000-8000-000000001211"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002210","17a4f000-0000-4000-8000-000000002211"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["1111111111111111111111111111111111111111111111111111111111111111","2222222222222222222222222222222222222222222222222222222222222222"],"ruleSetFingerprint":"6ad07a0ada1b250a450ec916c8c55aaabc38ca752beaea206c9608176d29e2fd"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"eligible"},{"label":"multi_scope_matches_none","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-3","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001220","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/22","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001221","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/22","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-22","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001220","17a4f000-0000-4000-8000-000000001221"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002220","17a4f000-0000-4000-8000-000000002221"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["2222222222222222222222222222222222222222222222222222222222222222","3333333333333333333333333333333333333333333333333333333333333333"],"ruleSetFingerprint":"da34bbe470911f3fbcb607374b78a8c0f276a916693a7a0a16361fc2a1df6606"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}},{"scopeId":"17a4f000-0000-4000-8000-0000000000a2","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a2","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001230","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/23","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-2"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001231","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/23","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"equals","value":"2601"}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-23","scopeId":"17a4f000-0000-4000-8000-0000000000a2","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001230","17a4f000-0000-4000-8000-000000001231"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002230","17a4f000-0000-4000-8000-000000002231"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["3333333333333333333333333333333333333333333333333333333333333333","4444444444444444444444444444444444444444444444444444444444444444"],"ruleSetFingerprint":"ffb30fff9e5f4eadadf1a8a199847d2922f3c9749dfe62658a6594832f9a1840"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"criteria_not_satisfied"},{"label":"multi_scope_mixes_two_scopes","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2601","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001240","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/24","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001241","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/24","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-24","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001240","17a4f000-0000-4000-8000-000000001241"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002240","17a4f000-0000-4000-8000-000000002241"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["4444444444444444444444444444444444444444444444444444444444444444","5555555555555555555555555555555555555555555555555555555555555555"],"ruleSetFingerprint":"8c6f36fbe1a8d62ae9a559e634de3ace87bf04129df4c5f7e894a6e6ea9403c0"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}},{"scopeId":"17a4f000-0000-4000-8000-0000000000a2","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a2","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001250","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/25","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-2"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001251","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/25","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"equals","value":"2601"}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-25","scopeId":"17a4f000-0000-4000-8000-0000000000a2","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001250","17a4f000-0000-4000-8000-000000001251"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002250","17a4f000-0000-4000-8000-000000002251"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["5555555555555555555555555555555555555555555555555555555555555555","6666666666666666666666666666666666666666666666666666666666666666"],"ruleSetFingerprint":"d8b864c5bb3723e099004a93ffa2b9216f0d906f79b1fbc23b6174d7f758fffe"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"criteria_not_satisfied"},{"label":"multi_scope_second_not_served","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001260","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/26","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001261","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/26","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-26","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001260","17a4f000-0000-4000-8000-000000001261"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002260","17a4f000-0000-4000-8000-000000002261"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["6666666666666666666666666666666666666666666666666666666666666666","7777777777777777777777777777777777777777777777777777777777777777"],"ruleSetFingerprint":"01db1e01a585239bf7a0d5fb8aa430d318c3d9d9c3399c68bef726247796cf5c"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}},{"scopeId":"17a4f000-0000-4000-8000-0000000000a2","envelope":null}],"expected":"unsupported_scope"},{"label":"multi_scope_second_incomplete","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001280","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/28","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001281","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/28","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-28","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001280","17a4f000-0000-4000-8000-000000001281"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002280","17a4f000-0000-4000-8000-000000002281"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["8888888888888888888888888888888888888888888888888888888888888888","9999999999999999999999999999999999999999999999999999999999999999"],"ruleSetFingerprint":"ab3026559d00f083d1e7b37f2a0ba2a36ecf990360b9d498e010bd9cb692816b"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}},{"scopeId":"17a4f000-0000-4000-8000-0000000000a2","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a2","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001270","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/27","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-2"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001271","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/27","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"equals","value":"2601"}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-27","scopeId":"17a4f000-0000-4000-8000-0000000000a2","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001270","17a4f000-0000-4000-8000-000000001271"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002270","17a4f000-0000-4000-8000-000000002271"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["7777777777777777777777777777777777777777777777777777777777777777","8888888888888888888888888888888888888888888888888888888888888888"],"ruleSetFingerprint":"117f4992ceabb9eb33944365aefca9ca2d4582ff6eec5870605d18327f438e14"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":false,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"unsupported_scope"},{"label":"envelope_bound_to_another_scope","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a2","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001290","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/29","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001291","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/29","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-29","scopeId":"17a4f000-0000-4000-8000-0000000000a2","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001290","17a4f000-0000-4000-8000-000000001291"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002290","17a4f000-0000-4000-8000-000000002291"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["9999999999999999999999999999999999999999999999999999999999999999","0000000000000000000000000000000000000000000000000000000000000000"],"ruleSetFingerprint":"194514443af3956a2b6c5f1ae920d584e0e427b249e144f83e53db4eeed90826"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"human_review_required"},{"label":"provenance_not_the_official_url","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001300","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/other","sourceField":"cpsc-page:description/table/0/row/30","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001301","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/other","sourceField":"cpsc-page:description/table/0/row/30","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-30","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001300","17a4f000-0000-4000-8000-000000001301"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002300","17a4f000-0000-4000-8000-000000002301"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["0000000000000000000000000000000000000000000000000000000000000000","1111111111111111111111111111111111111111111111111111111111111111"],"ruleSetFingerprint":"f514afa64e5115f6a18410de51a7fe1dce1e69e3a82f8513cb450054d4ee87d8"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":0,"unattributedRuleSets":0,"servedRuleSets":1,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"unsupported_scope"},{"label":"duplicate_rule_set","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[{"scopeId":"17a4f000-0000-4000-8000-0000000000a1","envelope":{"semantics":"any_of","schema":"recall_rule_sets_v1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","ruleSets":[{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001010","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/1","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001011","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/1","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001010","17a4f000-0000-4000-8000-000000001011"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002010","17a4f000-0000-4000-8000-000000002011"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["1111111111111111111111111111111111111111111111111111111111111111","2222222222222222222222222222222222222222222222222222222222222222"],"ruleSetFingerprint":"f85e600bafb5e84fa64ca9bd711c001d772bd63ab70b25e407f45e3bdf81ad95"}},{"semantics":"all_of","criteria":[{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001010","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/1","normalizationRule":"identifier_v2"},"kind":"model_number","operator":"equals","value":"MODEL-1"},{"id":"cpsc-ledger-17a4f000-0000-4000-8000-000000001011","required":true,"provenance":{"authority":"CPSC","officialUrl":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","sourceField":"cpsc-page:description/table/0/row/1","normalizationRule":"identifier_v2"},"kind":"date_code","operator":"one_of","values":["2501","2502"]}],"review":{"origin":"human_review_ledger","schema":"recall_rule_set_v1","revisionId":"17a4f000-0000-4000-8000-000000000500","sourceRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conjunctionGroup":"group-1","scopeId":"17a4f000-0000-4000-8000-0000000000a1","scopeFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","candidateIds":["17a4f000-0000-4000-8000-000000001010","17a4f000-0000-4000-8000-000000001011"],"reviewEventIds":["17a4f000-0000-4000-8000-000000002010","17a4f000-0000-4000-8000-000000002011"],"reviewerIds":["17a4f000-0000-4000-8000-000000003000","17a4f000-0000-4000-8000-000000003000"],"reviewedAt":"2026-10-01T00:00:00Z","identityFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scopeSemanticFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceAddressHashes":["1111111111111111111111111111111111111111111111111111111111111111","2222222222222222222222222222222222222222222222222222222222222222"],"ruleSetFingerprint":"f85e600bafb5e84fa64ca9bd711c001d772bd63ab70b25e407f45e3bdf81ad95"}}],"coverage":{"currentRevisionId":"17a4f000-0000-4000-8000-000000000500","proposedRuleSets":1,"unattributedRuleSets":0,"servedRuleSets":2,"complete":true,"sourceCoverage":{"state":"recorded","coverageStatus":"complete","positiveStatus":"independent","negativeEvidenceEligible":true}}}}],"expected":"human_review_required"},{"label":"no_scope","authoritative":true,"authority":"U.S. Consumer Product Safety Commission (CPSC)","url":"https://www.cpsc.gov/Recalls/2026/P17F4-Parity","country":"US","model":"MODEL-1","dateCode":"2501","jurisdictions":[{"type":"country","code":"US"}],"scopes":[],"expected":"unsupported_scope"}]$cases$::jsonb) c;
-- gate-parity-cases:end

-- ---------------------------------------------------------------------------
-- Fixtures: reviewer (MFA), consumer, CPSC source, helpers (Phase 16.13 path)
-- ---------------------------------------------------------------------------
insert into auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select id::uuid,'authenticated','authenticated',email,'','2099-01-01','{}','{}',now(),now()
from (values
  ('17a40000-0000-4000-8000-000000000001','p17f4-reviewer@example.invalid'),
  ('17a40000-0000-4000-8000-000000000005','p17f4-invalidator@example.invalid'),
  ('17a40000-0000-4000-8000-000000000006','p17f4-consumer@example.invalid')) u(id,email);
insert into auth.sessions (id, user_id, aal, created_at, updated_at)
select u.id, u.id, 'aal2', now(), now() from auth.users u
where u.email like 'p17f4-%@example.invalid';
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
select u.id, u.id, 'pgTAP TOTP', 'totp', 'verified', now(), now() from auth.users u
where u.email like 'p17f4-%@example.invalid';
insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
select gen_random_uuid(), u.id, 'totp', now(), now() from auth.users u
where u.email like 'p17f4-%@example.invalid';
insert into private.cpsc_reviewer_authorizations (user_id, authorized_at, reason)
values ('17a40000-0000-4000-8000-000000000001', now() - interval '1 hour', 'Phase 17.7a F-4 pgTAP reviewer');
insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason)
values ('17a40000-0000-4000-8000-000000000005', 'decision_invalidation', now() - interval '1 hour',
  'Phase 17.7a F-4 pgTAP invalidator');
select set_config('t74.source', public.ensure_cpsc_recall_source()::text, true);

create function pg_temp.act(p_role text, p_sub text default null) returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('role', p_role) ||
    case when p_sub is null then '{}'::jsonb
      else jsonb_build_object('sub', '17a40000-0000-4000-8000-0000000000' || p_sub, 'aal', 'aal2',
        'session_id', '17a40000-0000-4000-8000-0000000000' || p_sub) end)::text, true);
$$;
create function pg_temp.done() returns void language sql as $$
  select set_config('request.jwt.claims', '', true);
$$;
create function pg_temp.id(p_suffix text) returns uuid language sql immutable as $$
  select ('17a40000-0000-4000-8000-' || lpad(p_suffix, 12, '0'))::uuid;
$$;
create function pg_temp.hex(p_seed text) returns text language sql immutable as $$
  select encode(sha256(convert_to(p_seed, 'UTF8')), 'hex');
$$;
create function pg_temp.table_id(p_number text) returns text language sql immutable as $$
  select 'description/table/0/' || pg_temp.hex('p17f4-table:' || p_number);
$$;
create function pg_temp.row_id(p_number text, p_row integer) returns text language sql immutable as $$
  select pg_temp.hex('p17f4-row:' || p_number || ':' || p_row);
$$;
create function pg_temp.revision_hash(p_number text) returns text language sql immutable as $$
  select pg_temp.hex('p17f4-revision:' || p_number);
$$;

-- A reconciled CPSC recall, one scope, one current page revision with p_rows rows.
create function pg_temp.recall(p_key text, p_number text, p_rows integer, p_scopes integer default 1)
returns void language plpgsql as $$
declare v_url text := 'https://www.cpsc.gov/Recalls/2026/P17F4-' || p_key;
begin
  insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
    recall_date,official_url,retrieved_at,raw_payload)
  values (pg_temp.id('10' || p_number), current_setting('t74.source')::uuid, 'cpsc:' || p_number,
    'Recall ' || p_key, 'Desc', 'Hazard', 'Refund', '2026-09-20', v_url, now() - interval '1 day',
    jsonb_build_object('RecallNumber', p_number));
  insert into public.recall_scopes (id,recall_notice_id,product_name)
  select pg_temp.id((19 + n)::text || p_number), pg_temp.id('10' || p_number), 'Product ' || p_key || ' ' || n
  from generate_series(1, p_scopes) n;
  insert into public.recall_notice_jurisdictions (recall_notice_id, jurisdiction_type, jurisdiction_code)
  values (pg_temp.id('10' || p_number), 'country', 'US') on conflict do nothing;
  insert into private.cpsc_source_identities (id,source_id,official_recall_number,canonical_url,
    canonical_notice_id,identity_status)
  values (pg_temp.id('30' || p_number), current_setting('t74.source')::uuid, p_number, v_url,
    pg_temp.id('10' || p_number), 'reconciled');
  insert into private.cpsc_notice_identity_links (notice_id,identity_id,provenance)
  values (pg_temp.id('10' || p_number), pg_temp.id('30' || p_number), 'Phase 17.7a F-4 pgTAP');
  insert into private.cpsc_page_revisions (id,identity_id,evidence_hash,recall_number,
    canonical_url,title,section_hashes,normalized_evidence,parser_version,first_seen_at,last_seen_at,
    table_identities)
  values (pg_temp.id('40' || p_number), pg_temp.id('30' || p_number), pg_temp.revision_hash(p_number),
    p_number, v_url, 'Recall ' || p_key, '{}', jsonb_build_object('recallNumber', p_number,
      'canonicalUrl', v_url, 'title', 'Recall ' || p_key), 'phase-16.13-structured-v2',
    now() - interval '2 hours', now() - interval '2 hours',
    jsonb_build_array(jsonb_build_object(
      'identity', pg_temp.table_id(p_number),
      'rows', (select jsonb_agg(jsonb_build_object('identity', pg_temp.row_id(p_number, n),
          'evidence', jsonb_build_array('Product ' || n, 'MODEL-' || n)) order by n)
        from generate_series(1, p_rows) n))));
end $$;

-- Worker proposal of row p_row as `model MODEL-<row> AND date code 25<row>`.
create function pg_temp.propose_row(p_number text, p_row integer, p_scope text default '20')
returns void language plpgsql as $$
declare
  v_revision private.cpsc_page_revisions%rowtype;
  v_key text := pg_temp.table_id(p_number) || '/' || pg_temp.row_id(p_number, p_row);
  v_address jsonb;
begin
  select * into v_revision from private.cpsc_page_revisions where id = pg_temp.id('40' || p_number);
  v_address := jsonb_build_object('source','cpsc','recallNumber',p_number,
    'canonicalUrl',v_revision.canonical_url,'sourceSemanticRevision',v_revision.evidence_hash,
    'sectionIdentity','description','tableIdentity',pg_temp.table_id(p_number),
    'rowIdentity',pg_temp.row_id(p_number, p_row));
  perform pg_temp.act('service_role');
  perform public.propose_cpsc_candidate_criterion(v_revision.id, pg_temp.id(p_scope || p_number),
    v_address || '{"fieldIdentity":"model no"}', pg_temp.hex(v_key), 'model_exact',
    to_jsonb('MODEL-' || p_row), v_key, 'Product ' || p_row || ' | MODEL-' || p_row,
    'phase-16.13-structured-v2');
  perform public.propose_cpsc_candidate_criterion(v_revision.id, pg_temp.id(p_scope || p_number),
    v_address || '{"fieldIdentity":"date code"}', pg_temp.hex(v_key), 'date_code_exact',
    to_jsonb('25' || lpad(p_row::text, 2, '0')), v_key,
    'Product ' || p_row || ' | 25' || lpad(p_row::text, 2, '0'), 'phase-16.13-structured-v2');
  perform pg_temp.done();
end $$;

-- Human review (MFA reviewer) of both candidates, then materialization.
create function pg_temp.approve_row(p_number text, p_row integer) returns void language plpgsql as $$
declare v_ids uuid[];
begin
  select array_agg(c.id order by c.criterion_kind) into v_ids from private.cpsc_candidate_criteria c
    where c.revision_id = pg_temp.id('40' || p_number)
      and c.conjunction_key = pg_temp.table_id(p_number) || '/' || pg_temp.row_id(p_number, p_row);
  perform pg_temp.act('authenticated', '01');
  perform public.decide_cpsc_candidate(v_ids[1], 'reviewed', true, 'pgTAP');
  perform public.decide_cpsc_candidate(v_ids[2], 'reviewed', true, 'pgTAP');
  perform public.materialize_cpsc_reviewed_conjunction(v_ids[1]);
  perform pg_temp.done();
end $$;

-- Records the worker ledger (reviewable rows, failed rows), approves p_approve rows,
-- and attests the sections outside the census.
create function pg_temp.complete_coverage(p_number text, p_rows integer default 1,
  p_approve integer[] default array[1], p_failed integer[] default '{}')
returns void language plpgsql as $$
begin
  perform pg_temp.act('service_role');
  perform public.record_cpsc_page_coverage(pg_temp.id('40' || p_number), jsonb_build_object(
    'schema', 'cpsc_source_coverage_v1',
    'ledgerVersion', 'phase-16.13-coverage-v1',
    'parserVersion', 'phase-16.13-structured-v2',
    'extractorVersion', 'phase-16.11-html-v1',
    'censusVersion', 'phase-16.13-census-v1',
    'sourceSemanticRevision', pg_temp.revision_hash(p_number),
    'structures', jsonb_build_array(
      jsonb_build_object('structureId', 'description/prose', 'kind', 'prose',
        'sectionIdentity', 'description', 'tableIndex', null, 'tableIdentity', null,
        'authoritativeRecordCount', 1, 'anomalies', '[]'::jsonb,
        'records', jsonb_build_array(jsonb_build_object(
          'ordinal', 0, 'recordIdentity', pg_temp.hex('sentence:' || p_number || ':1'),
          'rowIdentity', null, 'extraction', 'extracted', 'disposition', 'ignored_non_safety',
          'effect', 'none', 'relation', null, 'reason', 'pgTAP sentence', 'cells', '[]'::jsonb))),
      jsonb_build_object('structureId', pg_temp.table_id(p_number), 'kind', 'table',
        'sectionIdentity', 'description', 'tableIndex', 0, 'tableIdentity', pg_temp.table_id(p_number),
        'authoritativeRecordCount', p_rows, 'anomalies', '[]'::jsonb,
        'records', (select jsonb_agg(case when n = any (p_failed) then jsonb_build_object(
            'ordinal', n - 1, 'recordIdentity', pg_temp.row_id(p_number, n),
            'rowIdentity', pg_temp.row_id(p_number, n), 'extraction', 'failed',
            'disposition', 'unresolved', 'effect', 'additive', 'relation', null,
            'reason', 'pgTAP failed row', 'cells', '[]'::jsonb)
          else jsonb_build_object(
            'ordinal', n - 1, 'recordIdentity', pg_temp.row_id(p_number, n),
            'rowIdentity', pg_temp.row_id(p_number, n), 'extraction', 'extracted',
            'disposition', 'parsed_reviewable', 'effect', 'none',
            'relation', pg_temp.table_id(p_number) || '/' || pg_temp.row_id(p_number, n),
            'reason', 'pgTAP row',
            'cells', jsonb_build_array(
              jsonb_build_object('column','model no','criterionClass','model','status','recognized'),
              jsonb_build_object('column','date code','criterionClass','date_code','status','recognized')))
          end order by n) from generate_series(1, p_rows) n)))));
  perform pg_temp.done();
  perform pg_temp.approve_row(p_number, n) from unnest(p_approve) n;
  perform pg_temp.act('authenticated', '01');
  perform public.attest_cpsc_outside_census(pg_temp.id('40' || p_number),
    public.get_cpsc_outside_census_packet(pg_temp.id('40' || p_number))->>'sectionsSha256',
    '[]'::jsonb, 'pgTAP: no restriction outside the description', 1);
  perform pg_temp.done();
end $$;

-- Notice A: a reviewed, complete scope "MODEL-1 AND date code 2501" (US).
select pg_temp.recall('Complete', '94001', 1);
select pg_temp.propose_row('94001', 1);
select pg_temp.complete_coverage('94001');
select extensions.ok(
  (select (reviewed_criteria->'coverage'->>'complete')::boolean
     and jsonb_array_length(reviewed_criteria->'ruleSets') = 1
   from public.get_recall_v2_scopes(pg_temp.id('1094001'))),
  'fixture: notice A serves one human-reviewed rule set with complete coverage (real path)');

-- Notices B, C, D: like production notice 8877, recall-level GTIN scopes only,
-- plus a structured lot range (C) or manufacture window (D); never reviewed.
insert into public.recall_notices (id,source_id,external_id,title,recall_date,official_url,
  retrieved_at,raw_payload)
select pg_temp.id(n.suffix), current_setting('t74.source')::uuid, 'cpsc:' || n.suffix,
  n.title, '2020-08-12', 'https://www.cpsc.gov/Recalls/2020/P17F4-' || n.suffix, now(),
  jsonb_build_object('RecallNumber', n.suffix)
from (values ('1094002', 'GTIN only'), ('1094003', 'GTIN and lot range'),
  ('1094004', 'GTIN and manufacture window')) n(suffix, title);
insert into public.recall_scopes (recall_notice_id, gtin, lot_from, lot_to, manufactured_from,
  manufactured_to, additional_criteria)
values
  (pg_temp.id('1094002'), '091021037090', null, null, null, null,
    '{"association":"recall-level","evidence_level":"recall"}'),
  (pg_temp.id('1094003'), '091021037090', '1000', '1999', null, null, null),
  (pg_temp.id('1094004'), '091021037090', null, null, '2018-05-01', '2019-09-30', null);
insert into public.recall_notice_jurisdictions (recall_notice_id, jurisdiction_type, jurisdiction_code)
select notice, 'country', 'US' from unnest(array[pg_temp.id('1094001'), pg_temp.id('1094002'),
  pg_temp.id('1094003'), pg_temp.id('1094004')]) notice
on conflict do nothing;

-- Products of the consumer.
insert into public.owned_products (id, user_id, product_name, gtin, model_number, lot_number,
  purchase_country_code, safety_attributes)
select pg_temp.id(p.suffix), '17a40000-0000-4000-8000-000000000006', p.name, p.gtin, p.model,
  p.lot, p.country, p.attributes::jsonb
from (values
  ('5001', 'Product Complete', null, 'MODEL-1', null, 'US', '{"date_code":"2501"}'),
  ('5002', 'Product Complete', null, 'MODEL-1', null, 'US', '{}'),
  ('5003', 'Product Complete', null, 'MODEL-1', null, 'US', '{"date_code":"2599"}'),
  ('5004', 'Product Complete', null, 'MODEL-1', null, 'CA', '{"date_code":"2501"}'),
  ('5005', 'Product Complete', null, 'MODEL-1', null, null, '{"date_code":"2501"}'),
  ('5006', 'Sleek stroller', '091021037090', null, '1500', 'US', '{}'),
  ('5007', 'Product Complete', null, 'ＭＯＤＥＬ－１', null, 'US', '{"date_code":"2501"}'),
  ('5008', 'Sleek stroller', '091021037090', null, '2500', 'US', '{}'),
  ('5009', 'Product Complete', null, 'MODEL-2', null, 'US', '{"date_code":"2501"}'),
  ('5011', 'Product Multi', null, 'MODEL-1', null, 'US', '{"date_code":"2501"}'),
  ('5012', 'Product Multi', null, 'MODEL-2', null, 'US', '{"date_code":"2502"}'),
  ('5013', 'Product Multi', null, 'MODEL-3', null, 'US', '{"date_code":"2501"}'),
  ('5014', 'Product Multi', null, 'MODEL-1', null, 'US', '{"date_code":"2502"}'),
  ('5021', 'Product Complete', '012345678905', 'MODEL-1', '1500', 'US', '{"date_code":"2501"}')
) p(suffix, name, gtin, model, lot, country, attributes);

-- ---------------------------------------------------------------------------
-- The proof
-- ---------------------------------------------------------------------------
select extensions.is(private.automatic_alert_eligibility(pg_temp.id(c.product), pg_temp.id(c.notice)),
  c.expected, 'proof: ' || c.label)
from (values
  ('complete reviewed scope, model and date code satisfied, US -> eligible', '5001', '1094001', 'eligible'),
  ('full-width model normalizes to the reviewed model -> eligible', '5007', '1094001', 'eligible'),
  ('required date code absent', '5002', '1094001', 'criteria_not_satisfied'),
  ('date code outside the reviewed value', '5003', '1094001', 'criteria_not_satisfied'),
  ('wrong model', '5009', '1094001', 'criteria_not_satisfied'),
  ('incompatible jurisdiction (CA purchase, US notice)', '5004', '1094001', 'jurisdiction_mismatch'),
  ('unknown purchase country', '5005', '1094001', 'incomplete_evidence'),
  ('exact GTIN, recall-level scope never reviewed (8877 shape)', '5006', '1094002', 'unsupported_scope'),
  ('exact GTIN, lot required, right lot, not reviewed', '5006', '1094003', 'unsupported_scope'),
  ('exact GTIN, lot required, wrong lot', '5008', '1094003', 'unsupported_scope'),
  ('exact GTIN, lot required, lot missing', '5001', '1094003', 'unsupported_scope'),
  ('exact GTIN, manufacture window, never reviewed', '5006', '1094004', 'unsupported_scope')
) c(label, product, notice, expected);

savepoint global_notice;
insert into public.recall_notice_jurisdictions (recall_notice_id, jurisdiction_type, jurisdiction_code)
values (pg_temp.id('1094001'), 'global', 'GLOBAL');
select extensions.is(private.automatic_alert_eligibility(pg_temp.id('5005'), pg_temp.id('1094001')),
  'eligible', 'proof: unknown purchase country is covered by an explicit GLOBAL notice');
rollback to savepoint global_notice;

-- ---------------------------------------------------------------------------
-- v1 finalizer (deterministic_v1 and hybrid_guarded_v1)
-- ---------------------------------------------------------------------------
create function pg_temp.v1(p_product text, p_notice text, p_seed text,
  p_method text default 'deterministic_v1')
returns text language plpgsql as $$
declare v_lease uuid; v_p timestamptz; v_n timestamptz; r record;
begin
  select updated_at into v_p from public.owned_products where id = pg_temp.id(p_product);
  select updated_at into v_n from public.recall_notices where id = pg_temp.id(p_notice);
  select c.lease_token into v_lease from public.claim_recall_match_evaluation(
    pg_temp.id(p_product), pg_temp.id(p_notice), pg_temp.hex(p_seed), v_p, v_n, 60) c;
  select * into r from public.finalize_recall_match_evaluation(
    pg_temp.id(p_product), pg_temp.id(p_notice), pg_temp.hex(p_seed), v_p, v_n, v_lease,
    'confirmed', 1, p_method, '{"gtin":["091021037090"]}', 'Exact valid GTIN.',
    case when p_method = 'hybrid_guarded_v1' then 'nebius' end,
    case when p_method = 'hybrid_guarded_v1' then 'nvidia/nemotron-3-super-120b-a12b' end, '1.0.0');
  return concat_ws('|', r.status, r.stored_status, coalesce(r.safety_status, '-'), r.alert_outcome);
end $$;

select extensions.is(pg_temp.v1('5006', '1094002', 'v1-gtin-only'),
  'finalized|needs_review|unsupported_scope|none',
  'v1 confirmed on an unreviewed GTIN scope is stored as needs_review, no alert');
select extensions.is(
  (select row(status, reasoning_summary like 'Automatic alert withheld (unsupported_scope)%',
      matched_identifiers)::text
    from public.recall_matches where owned_product_id = pg_temp.id('5006')
      and recall_notice_id = pg_temp.id('1094002')),
  row('needs_review'::public.recall_match_status, true, '{"gtin": ["091021037090"]}'::jsonb)::text,
  'the candidate stays observable (needs_review, matched identifiers kept, reason recorded)');
select extensions.is(pg_temp.v1('5006', '1094003', 'v1-lot-right'),
  'finalized|needs_review|unsupported_scope|none', 'v1 GTIN + right lot (unsupported kind): no alert');
select extensions.is(pg_temp.v1('5008', '1094003', 'v1-lot-wrong'),
  'finalized|needs_review|unsupported_scope|none', 'v1 GTIN + wrong lot: no alert');
select extensions.is(pg_temp.v1('5001', '1094003', 'v1-lot-missing'),
  'finalized|needs_review|unsupported_scope|none', 'v1 GTIN + missing lot: no alert');
select extensions.is(pg_temp.v1('5006', '1094004', 'v1-window'),
  'finalized|needs_review|unsupported_scope|none', 'v1 GTIN + manufacture window: no alert');
select extensions.is(pg_temp.v1('5008', '1094002', 'hybrid-gtin-only', 'hybrid_guarded_v1'),
  'finalized|needs_review|unsupported_scope|none',
  'a Nemotron/hybrid confirmation without the proof creates no alert');
select extensions.is(pg_temp.v1('5004', '1094001', 'v1-ca'),
  'finalized|needs_review|jurisdiction_mismatch|none', 'v1: incompatible jurisdiction, no alert');
select extensions.is(pg_temp.v1('5005', '1094001', 'v1-unknown'),
  'finalized|needs_review|incomplete_evidence|none', 'v1: unknown jurisdiction, no alert');
select extensions.is(pg_temp.v1('5002', '1094001', 'v1-date-missing'),
  'finalized|needs_review|criteria_not_satisfied|none', 'v1: required date code absent, no alert');
select extensions.is(pg_temp.v1('5003', '1094001', 'v1-date-outside'),
  'finalized|needs_review|criteria_not_satisfied|none', 'v1: date code outside, no alert');
select extensions.is(pg_temp.v1('5001', '1094001', 'v1-complete'),
  'finalized|confirmed|eligible|created',
  'v1 confirmed with the complete proof: one automatic alert');
select extensions.is(
  (select count(*)::integer from private.push_alert_queue q join public.alerts a on a.id = q.alert_id
    join public.recall_matches m on m.id = a.recall_match_id
    where m.owned_product_id = pg_temp.id('5001')),
  1, 'the proven alert is queued for push exactly once');
select extensions.is(pg_temp.v1('5001', '1094001', 'v1-complete-again'),
  'finalized|confirmed|eligible|existing', 'idempotent: re-confirmation reuses the alert');
select extensions.is(
  (select count(*)::integer from public.alerts),
  1, 'exactly one v1 alert exists across every case');

-- Direct writes cannot bypass the proof.
select extensions.throws_ok(
  format($$insert into public.alerts (user_id, recall_match_id)
    select user_id, %L from public.owned_products where id = %L$$,
    (select id from public.recall_matches where owned_product_id = pg_temp.id('5006')
      and recall_notice_id = pg_temp.id('1094002')), pg_temp.id('5006')),
  'automatic alert requires a proven complete official scope',
  'a needs-review match cannot receive an alert directly');
select extensions.throws_ok(
  format($$update public.recall_matches set status = 'confirmed'
    where owned_product_id = %L and recall_notice_id = %L$$, pg_temp.id('5006'), pg_temp.id('1094002')),
  'an automatic confirmation requires a proven complete official scope',
  'a match cannot be forced to confirmed without the proof');
select extensions.throws_ok(
  format($$insert into public.recall_matches (owned_product_id, recall_notice_id, status, confidence,
      match_method, reasoning_summary, schema_version)
    values (%L, %L, 'confirmed', 1, 'deterministic_v1', 'direct', '1.0.0')$$,
    pg_temp.id('5002'), pg_temp.id('1094002')),
  'an automatic confirmation requires a proven complete official scope',
  'a confirmed match cannot be inserted directly without the proof');

-- service_role (the Edge runtime credential) cannot fabricate or bypass the proof.
set local role service_role;
select pg_temp.act('service_role');
select extensions.throws_ok(
  format($$select private.automatic_alert_eligibility(%L, %L)$$, pg_temp.id('5006'), pg_temp.id('1094002')),
  '42501', null, 'service_role cannot call the proof (no private schema access)');
select extensions.throws_ok(
  format($$select private.automatic_alert_classification(true, 'x', 'x', 'US', 'M', null, '[]', '[]')$$),
  '42501', null, 'service_role cannot call the classifier');
select extensions.throws_ok(
  format($$insert into public.alerts (user_id, recall_match_id)
    select '17a40000-0000-4000-8000-000000000006', id from public.recall_matches
    where owned_product_id = %L and recall_notice_id = %L$$, pg_temp.id('5006'), pg_temp.id('1094002')),
  'automatic alert requires a proven complete official scope',
  'service_role cannot insert an alert directly for an unproven pair');
select extensions.throws_ok(
  format($$update public.recall_matches set status = 'confirmed'
    where owned_product_id = %L and recall_notice_id = %L$$, pg_temp.id('5006'), pg_temp.id('1094002')),
  'an automatic confirmation requires a proven complete official scope',
  'service_role cannot set confirmed directly');
select extensions.throws_ok(
  format($$insert into private.recall_alert_eligibility_v2 (owned_product_id, recall_notice_id, evaluation_id)
    values (%L, %L, gen_random_uuid())$$, pg_temp.id('5006'), pg_temp.id('1094002')),
  '42501', null, 'service_role has no direct access to eligibility');
select extensions.is(pg_temp.v1('5009', '1094002', 'service-role-arbitrary-ids'),
  'finalized|needs_review|unsupported_scope|none',
  'service_role passing arbitrary ids to the finalizer cannot obtain a confirmation');
select pg_temp.done();
reset role;

-- ---------------------------------------------------------------------------
-- v2 finalizer and alert writer
-- ---------------------------------------------------------------------------
create function pg_temp.v2(p_product text, p_notice text, p_seed text) returns text
language plpgsql as $$
declare v_lease uuid; v_p timestamptz; v_n timestamptz; r record;
begin
  select updated_at into v_p from public.owned_products where id = pg_temp.id(p_product);
  select updated_at into v_n from public.recall_notices where id = pg_temp.id(p_notice);
  select c.lease_token into v_lease from public.claim_recall_match_evaluation(
    pg_temp.id(p_product), pg_temp.id(p_notice), pg_temp.hex(p_seed), v_p, v_n, 60) c;
  select * into r from public.finalize_recall_match_evaluation_v2(
    pg_temp.id(p_product), pg_temp.id(p_notice), pg_temp.hex(p_seed), v_p, v_n, v_lease,
    'confirmed', 1, '{}'::jsonb, 'All mandatory criteria satisfied.');
  return r.status || '|' || r.alert_eligibility;
end $$;

select extensions.is(pg_temp.v2('5007', '1094001', 'v2-complete'), 'finalized|created',
  'v2 confirmed with the complete proof creates eligibility');
select extensions.is(
  (select status from public.create_recall_v2_alert(pg_temp.id('5007'), pg_temp.id('1094001'))),
  'created', 'and one v2 alert');
select extensions.is(pg_temp.v2('5002', '1094001', 'v2-date-missing'), 'finalized|none',
  'v2 confirmed without the proof creates no eligibility');
select extensions.is(
  (select row(status, confidence, reasoning_summary like 'Automatic alert withheld (criteria_not_satisfied)%')::text
    from private.recall_match_evaluations_v2 where owned_product_id = pg_temp.id('5002')
      and recall_notice_id = pg_temp.id('1094001')),
  row('needs_review'::public.recall_match_status, 0::numeric(5,4), true)::text,
  'the v2 evaluation is stored as needs_review with the reason');
select extensions.is(
  (select status from public.create_recall_v2_alert(pg_temp.id('5002'), pg_temp.id('1094001'))),
  'ineligible', 'no v2 alert without the proof');

-- ---------------------------------------------------------------------------
-- Historical (pre-F-4) unsafe confirmations: recovery blocked, neutralization
-- ---------------------------------------------------------------------------
-- Simulate rows written before F-4 by switching the guards off inside this
-- rolled-back transaction only.
alter table private.recall_alert_eligibility_v2 disable trigger recall_alert_eligibility_v2_require_safe_scope;
alter table public.alerts disable trigger alerts_require_safe_scope;
alter table public.recall_matches disable trigger recall_matches_require_safe_confirmation;
alter table private.recall_match_evaluations_v2 disable trigger recall_match_evaluations_v2_require_safe_confirmation;
insert into private.recall_match_evaluations_v2 (owned_product_id, recall_notice_id,
  evidence_fingerprint, status, confidence, matched_identifiers, reasoning_summary)
values (pg_temp.id('5008'), pg_temp.id('1094002'), pg_temp.hex('pre-f4-v2'), 'confirmed', 1,
  '{"gtin":["091021037090"]}', 'Pre-F-4 GTIN confirmation.');
insert into private.recall_alert_eligibility_v2 (owned_product_id, recall_notice_id, evaluation_id)
select owned_product_id, recall_notice_id, id from private.recall_match_evaluations_v2
where owned_product_id = pg_temp.id('5008') and recall_notice_id = pg_temp.id('1094002');
update public.recall_matches set status = 'confirmed', evidence_fingerprint = pg_temp.hex('pre-f4-v1')
where owned_product_id = pg_temp.id('5006') and recall_notice_id = pg_temp.id('1094002');
insert into public.alerts (user_id, recall_match_id)
select '17a40000-0000-4000-8000-000000000006', id from public.recall_matches
where owned_product_id = pg_temp.id('5006') and recall_notice_id = pg_temp.id('1094002');
alter table private.recall_alert_eligibility_v2 enable trigger recall_alert_eligibility_v2_require_safe_scope;
alter table public.alerts enable trigger alerts_require_safe_scope;
alter table public.recall_matches enable trigger recall_matches_require_safe_confirmation;
alter table private.recall_match_evaluations_v2 enable trigger recall_match_evaluations_v2_require_safe_confirmation;
-- Explicit push targeting refuses the unsafe historical alert, and queues a proven one.
select extensions.is(public.queue_recall_push_alerts(array(
    select a.id from public.alerts a join public.recall_matches m on m.id = a.recall_match_id
    where m.owned_product_id = pg_temp.id('5006') and m.recall_notice_id = pg_temp.id('1094002'))),
  0, 'push targeting refuses an unsafe historical alert');
delete from private.push_alert_queue where alert_id in (select a.id from public.alerts a
  join public.recall_matches m on m.id = a.recall_match_id where m.owned_product_id = pg_temp.id('5001'));
select extensions.is(public.queue_recall_push_alerts(array(
    select a.id from public.alerts a join public.recall_matches m on m.id = a.recall_match_id
    where m.owned_product_id = pg_temp.id('5001'))),
  1, 'push targeting still queues a proven alert');

select extensions.is(
  (select status from public.create_recall_v2_alert(pg_temp.id('5008'), pg_temp.id('1094002'))),
  'ineligible', 'a pre-F-4 unsafe eligibility cannot produce an alert (retry recovery blocked)');
select extensions.is(pg_temp.v2('5008', '1094002', 'pre-f4-v2'), 'unchanged|none',
  'a retry with the same evidence is unchanged and creates no eligibility');
select extensions.is(
  (select status from public.create_recall_v2_alert(pg_temp.id('5008'), pg_temp.id('1094002'))),
  'ineligible', 'the unchanged recovery path still cannot recreate the alert');
select extensions.throws_ok(
  format($$insert into private.recall_alert_snapshots_v2 (user_id, owned_product_id,
    recall_notice_id, evaluation_id, source_snapshot, evidence_snapshot)
    select '17a40000-0000-4000-8000-000000000006', %L, %L, id, '{}', '{}'
    from private.recall_match_evaluations_v2 where owned_product_id = %L
    order by observation_seq limit 1$$, pg_temp.id('5008'), pg_temp.id('1094002'), pg_temp.id('5008')),
  'automatic alert requires a proven complete official scope',
  'a v2 alert snapshot cannot be written without the proof');
select extensions.is(
  (select count(*)::integer from public.claim_recall_match_evaluation(pg_temp.id('5006'),
    pg_temp.id('1094002'), pg_temp.hex('pre-f4-v1'),
    (select updated_at from public.owned_products where id = pg_temp.id('5006')),
    (select updated_at from public.recall_notices where id = pg_temp.id('1094002')), 60)
    where status = 'unchanged'),
  1, 'v1 has no alert recovery: an unchanged pre-F-4 pair is skipped, never re-alerted');

select extensions.is(
  (select string_agg(kind || ':' || reason || ':' || has_alert || ':' || action, ',' order by kind)
    from private.neutralize_unsafe_automatic_alerts(false)),
  'v1_match:unsupported_scope:true:would_downgrade,v2_eligibility:unsupported_scope:false:would_revoke',
  'the dry run inventories exactly the unsafe pre-F-4 confirmations');
select extensions.is(
  (select row(m.status, (select count(*) from public.alerts a where a.recall_match_id = m.id))::text
    from public.recall_matches m where m.owned_product_id = pg_temp.id('5006')
      and m.recall_notice_id = pg_temp.id('1094002')),
  row('confirmed'::public.recall_match_status, 1::bigint)::text,
  'the dry run changes nothing');
select extensions.is(
  (select count(*)::integer from private.neutralize_unsafe_automatic_alerts(true)),
  2, 'applying neutralizes both');
select extensions.is(
  (select row(m.status, m.evidence_fingerprint is null,
      (select count(*) from public.alerts a where a.recall_match_id = m.id))::text
    from public.recall_matches m where m.owned_product_id = pg_temp.id('5006')
      and m.recall_notice_id = pg_temp.id('1094002')),
  row('needs_review'::public.recall_match_status, true, 1::bigint)::text,
  'v1: the match is withdrawn and re-evaluable; the alert is kept as history');
select extensions.is(
  (select row(e.revoked_at is not null, v.status)::text
    from private.recall_alert_eligibility_v2 e
    join private.recall_match_evaluations_v2 v on v.id = e.revoked_by_evaluation_id
    where e.owned_product_id = pg_temp.id('5008') and e.recall_notice_id = pg_temp.id('1094002')),
  row(true, 'needs_review'::public.recall_match_status)::text,
  'v2: the eligibility is revoked by an append-only needs_review evaluation');
select extensions.is(
  (select count(*)::integer from private.neutralize_unsafe_automatic_alerts(true)),
  0, 'neutralization is idempotent');
select extensions.throws_ok(
  format($$update private.recall_alert_eligibility_v2 set revoked_at = null,
    revoked_by_evaluation_id = null where owned_product_id = %L$$, pg_temp.id('5008')),
  'automatic alert eligibility requires a proven complete official scope',
  'a revoked unsafe eligibility cannot be re-armed');
select extensions.is(
  (select count(*)::integer from private.neutralize_unsafe_automatic_alerts(false)),
  0, 'the proven confirmations (v1 and v2) are never touched');
select extensions.is(pg_temp.v1('5006', '1094002', 'v1-after-neutralization'),
  'finalized|needs_review|unsupported_scope|none',
  'after neutralization a new v1 confirmation is still withheld; the old alert is not recreated');
select extensions.is(
  (select count(*)::integer from public.alerts a join public.recall_matches m on m.id = a.recall_match_id
    where m.owned_product_id = pg_temp.id('5006')),
  1, 'no duplicate alert after neutralization and retry');


-- ---------------------------------------------------------------------------
-- Multi-scope semantics (real review path): every scope must be COVERED; the
-- product needs to SATISFY only one rule set, never a mix across rule sets.
-- ---------------------------------------------------------------------------
-- 94005: scope 1 "MODEL-1 AND 2501", scope 2 "MODEL-2 AND 2502", both complete.
select pg_temp.recall('Multi', '94005', 2, 2);
select pg_temp.propose_row('94005', 1, '20');
select pg_temp.propose_row('94005', 2, '21');
select pg_temp.complete_coverage('94005', 2, array[1, 2]);
-- 94006: same structure, but scope 2 was never reviewed (not served).
select pg_temp.recall('MultiPartial', '94006', 2, 2);
select pg_temp.propose_row('94006', 1, '20');
select pg_temp.propose_row('94006', 2, '21');
select pg_temp.complete_coverage('94006', 2, array[1]);
-- 94007: one scope; row 1 reviewed, row 2 not extracted (coverage not proven).
select pg_temp.recall('Ambiguous', '94007', 2);
select pg_temp.propose_row('94007', 1);
select pg_temp.complete_coverage('94007', 2, array[1], array[2]);

select extensions.ok(
  (select bool_and((reviewed_criteria->'coverage'->>'complete')::boolean)
     and count(*) = 2
   from public.get_recall_v2_scopes(pg_temp.id('1094005'))),
  'fixture: both scopes of 94005 are served with complete coverage');
select extensions.ok(
  (select count(*) filter (where reviewed_criteria is null) = 1
   from public.get_recall_v2_scopes(pg_temp.id('1094006'))),
  'fixture: 94006 serves scope 1 only');
select extensions.ok(
  (select reviewed_criteria is not null
     and not (reviewed_criteria->'coverage'->>'complete')::boolean
   from public.get_recall_v2_scopes(pg_temp.id('1094007'))),
  'fixture: 94007 serves its reviewed row, but coverage is not complete');

select extensions.is(private.automatic_alert_eligibility(pg_temp.id(c.product), pg_temp.id(c.notice)),
  c.expected, 'multi-scope: ' || c.label)
from (values
  ('A. two complete scopes, product matches scope 1', '5011', '1094005', 'eligible'),
  ('B. two complete scopes, product matches scope 2', '5012', '1094005', 'eligible'),
  ('C. two complete scopes, product matches none', '5013', '1094005', 'criteria_not_satisfied'),
  ('C2. model of scope 1 with date code of scope 2 is never combined', '5014', '1094005', 'criteria_not_satisfied'),
  ('D. scope 1 complete, scope 2 not served', '5011', '1094006', 'unsupported_scope'),
  ('E. served rule set but unproven coverage (unextracted row)', '5011', '1094007', 'unsupported_scope')
) c(label, product, notice, expected);
select extensions.is(pg_temp.v1('5012', '1094005', 'multi-scope-2'),
  'finalized|confirmed|eligible|created', 'multi-scope B confirms with one alert');
select extensions.is(pg_temp.v1('5011', '1094006', 'multi-partial'),
  'finalized|needs_review|unsupported_scope|none', 'multi-scope D never confirms automatically');

-- ---------------------------------------------------------------------------
-- Revision semantics: a proof is never cached; a stale proof never confirms.
-- ---------------------------------------------------------------------------
select extensions.is(private.automatic_alert_eligibility(pg_temp.id('5021'), pg_temp.id('1094001')),
  'eligible', 'revision baseline: product 5021 is proven on notice A');

create function pg_temp.v1_after(p_product text, p_notice text, p_seed text, p_change text)
returns text language plpgsql as $$
declare v_lease uuid; v_p timestamptz; v_n timestamptz; r record;
begin
  -- now() is frozen inside a pgTAP transaction; age both revisions so that the
  -- edit below produces a genuinely newer revision, as it would in production.
  alter table public.owned_products disable trigger owned_products_set_updated_at;
  alter table public.recall_notices disable trigger recall_notices_set_updated_at;
  update public.owned_products set updated_at = now() - interval '1 minute' where id = pg_temp.id(p_product);
  update public.recall_notices set updated_at = now() - interval '1 minute' where id = pg_temp.id(p_notice);
  alter table public.owned_products enable trigger owned_products_set_updated_at;
  alter table public.recall_notices enable trigger recall_notices_set_updated_at;
  select updated_at into v_p from public.owned_products where id = pg_temp.id(p_product);
  select updated_at into v_n from public.recall_notices where id = pg_temp.id(p_notice);
  select c.lease_token into v_lease from public.claim_recall_match_evaluation(
    pg_temp.id(p_product), pg_temp.id(p_notice), pg_temp.hex(p_seed), v_p, v_n, 60) c;
  execute p_change;
  select * into r from public.finalize_recall_match_evaluation(
    pg_temp.id(p_product), pg_temp.id(p_notice), pg_temp.hex(p_seed), v_p, v_n, v_lease,
    'confirmed', 1, 'deterministic_v1', '{}', 'Exact identifiers.', null, null, '1.0.0');
  return concat_ws('|', r.status, coalesce(r.stored_status::text, '-'), coalesce(r.alert_outcome, '-'));
end $$;

savepoint revision_case;
select extensions.is(pg_temp.v1_after('5021', '1094001', 'rev-gtin',
  format($$update public.owned_products set gtin = '091021037090' where id = %L$$, pg_temp.id('5021'))),
  'stale|-|none', 'a GTIN edit between claim and finalization makes the result stale (no confirmation)');
rollback to savepoint revision_case;
select extensions.is(pg_temp.v1_after('5021', '1094001', 'rev-lot',
  format($$update public.owned_products set lot_number = '1600' where id = %L$$, pg_temp.id('5021'))),
  'stale|-|none', 'a lot edit between claim and finalization makes the result stale');
rollback to savepoint revision_case;
select extensions.is(pg_temp.v1_after('5021', '1094001', 'rev-notice',
  format($$update public.recall_notices set hazard = 'Hazard v2' where id = %L$$, pg_temp.id('1094001'))),
  'stale|-|none', 'a new recall revision between claim and finalization makes the result stale');
rollback to savepoint revision_case;

update public.owned_products set safety_attributes = '{"date_code":"2599"}' where id = pg_temp.id('5021');
select extensions.is(pg_temp.v1('5021', '1094001', 'rev-date'),
  'finalized|needs_review|criteria_not_satisfied|none', 'after a date-code edit the old proof no longer holds');
rollback to savepoint revision_case;
update public.owned_products set model_number = 'MODEL-9' where id = pg_temp.id('5021');
select extensions.is(pg_temp.v1('5021', '1094001', 'rev-model'),
  'finalized|needs_review|criteria_not_satisfied|none', 'after a model edit the old proof no longer holds');
rollback to savepoint revision_case;
update public.owned_products set purchase_country_code = 'CA' where id = pg_temp.id('5021');
select extensions.is(pg_temp.v1('5021', '1094001', 'rev-country'),
  'finalized|needs_review|jurisdiction_mismatch|none', 'after a country edit the old proof no longer holds');
rollback to savepoint revision_case;

insert into private.cpsc_page_revisions (id,identity_id,evidence_hash,recall_number,canonical_url,
  title,section_hashes,normalized_evidence,parser_version,first_seen_at,last_seen_at,table_identities)
select pg_temp.id('4194001'), identity_id, pg_temp.hex('p17f4-revision:94001:v2'), recall_number,
  canonical_url, title, section_hashes, normalized_evidence, parser_version, now(), now(), table_identities
from private.cpsc_page_revisions where id = pg_temp.id('4094001');
select extensions.is(private.automatic_alert_eligibility(pg_temp.id('5021'), pg_temp.id('1094001')),
  'unsupported_scope', 'a newer official page revision invalidates the reviewed proof');
rollback to savepoint revision_case;

select pg_temp.act('authenticated', '05');
select public.invalidate_cpsc_review_decision((select l.id from private.cpsc_candidate_review_ledger l
  join private.cpsc_candidate_criteria c on c.id = l.candidate_id
  where c.revision_id = pg_temp.id('4094001') and c.criterion_kind = 'date_code_exact'
  order by l.event_seq desc limit 1), 'pgTAP cause');
select pg_temp.done();
select extensions.is(private.automatic_alert_eligibility(pg_temp.id('5021'), pg_temp.id('1094001')),
  'unsupported_scope', 'revoking a review decision invalidates the proof');
select extensions.is(pg_temp.v1('5021', '1094001', 'rev-revoked'),
  'finalized|needs_review|unsupported_scope|none', 'and no confirmation follows');
rollback to savepoint revision_case;

select pg_temp.act('service_role');
select public.record_cpsc_page_coverage(pg_temp.id('4094001'), jsonb_build_object(
  'schema', 'cpsc_source_coverage_v1', 'ledgerVersion', 'phase-16.13-coverage-v1',
  'parserVersion', 'phase-16.13-structured-v2', 'extractorVersion', 'phase-16.11-html-v1',
  'censusVersion', 'phase-16.13-census-v1', 'sourceSemanticRevision', pg_temp.revision_hash('94001'),
  'structures', jsonb_build_array(
    jsonb_build_object('structureId', 'description/prose', 'kind', 'prose', 'sectionIdentity', 'description',
      'tableIndex', null, 'tableIdentity', null, 'authoritativeRecordCount', 1, 'anomalies', '[]'::jsonb,
      'records', jsonb_build_array(jsonb_build_object('ordinal', 0,
        'recordIdentity', pg_temp.hex('sentence:94001:1'), 'rowIdentity', null, 'extraction', 'extracted',
        'disposition', 'parsed_deferred', 'effect', 'additive', 'relation', null,
        'reason', 'pgTAP: a newly recognized prose condition', 'cells', '[]'::jsonb))),
    jsonb_build_object('structureId', pg_temp.table_id('94001'), 'kind', 'table',
      'sectionIdentity', 'description', 'tableIndex', 0, 'tableIdentity', pg_temp.table_id('94001'),
      'authoritativeRecordCount', 1, 'anomalies', '[]'::jsonb,
      'records', jsonb_build_array(jsonb_build_object('ordinal', 0,
        'recordIdentity', pg_temp.row_id('94001', 1), 'rowIdentity', pg_temp.row_id('94001', 1),
        'extraction', 'extracted', 'disposition', 'parsed_reviewable', 'effect', 'none',
        'relation', pg_temp.table_id('94001') || '/' || pg_temp.row_id('94001', 1), 'reason', 'pgTAP row',
        'cells', jsonb_build_array(
          jsonb_build_object('column','model no','criterionClass','model','status','recognized'),
          jsonb_build_object('column','date code','criterionClass','date_code','status','recognized'))))))));
select pg_temp.done();
select extensions.is(private.automatic_alert_eligibility(pg_temp.id('5021'), pg_temp.id('1094001')),
  'unsupported_scope', 'a newer coverage ledger that is no longer complete invalidates the proof');
rollback to savepoint revision_case;
select extensions.is(private.automatic_alert_eligibility(pg_temp.id('5021'), pg_temp.id('1094001')),
  'eligible', 'each revision case was isolated (baseline restored)');
release savepoint revision_case;

select * from extensions.finish();
rollback;
