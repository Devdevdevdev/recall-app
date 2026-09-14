# CPSC parser fixture

`cpsc-real-records.json` contains field-reduced copies of two public records returned by the
official CPSC Recall Retrieval REST service on 2026-09-14 using
`https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallTitle=stroller`.

The records retain the fields used by the parser, including the CPSC collection shapes. They are
test fixtures only; production ingestion preserves each complete API object in
`recall_notices.raw_payload` without reduction or transformation.
