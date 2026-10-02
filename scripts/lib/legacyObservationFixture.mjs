// Local-only fixture setup after service_role lost direct EXECUTE on the
// legacy nine-argument RPC. The owner path is still needed by historical jobs.
const argumentsInSignatureOrder = [
  'p_api_id',
  'p_recall_number',
  'p_observed_url',
  'p_canonical_url',
  'p_title',
  'p_publication_date',
  'p_payload_hash',
  'p_observed_at',
  'p_provenance',
];

const literal = (value) => (value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`);

export function ownerLegacyObservationFixture(sql, parameters) {
  const values = argumentsInSignatureOrder.map((name) => literal(parameters[name])).join(', ');
  const output = sql(`begin;
set local request.jwt.claim.role = 'service_role';
select public.record_cpsc_identity_observation(${values});
commit;`);
  const json = output.split('\n').find((line) => line.startsWith('{'));
  if (!json) throw new Error('Owner legacy observation fixture returned no JSON result.');
  return { data: JSON.parse(json) };
}
