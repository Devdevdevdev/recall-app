# Health Canada adapter fixture provenance

`health-canada-real-records.json` contains a traceable field-level excerpt from Health Canada's
English **Recalls and Safety Alerts** JSON dataset, retrieved on 18 September 2026.

- Dataset catalogue: https://open.canada.ca/data/en/dataset/d38de914-c94c-429b-8ab1-8776c31643e3
- Official JSON resource: https://recalls-rappels.canada.ca/sites/default/files/opendata-donneesouvertes/HCRSAMOpenData.json
- Official notice: https://recalls-rappels.canada.ca/en/alert-recall/simond-brand-alpinism-quickdraws-recalled-due-injury-hazard
- Stable source ID: `82616`
- Licence: Open Government Licence – Canada

The long consumer-remedy text is shortened in the fixture to keep the test asset focused. Identity,
title, URL, authority category, product, issue, update date, and archive state are preserved. Tests
do not treat the shortened remedy as evidence beyond the explicit source field.

`health-canada-2026-09-17-window.json` is a bounded field-level excerpt of the nine official rows
whose `Last updated` value was `2026-09-17`, retrieved on 19 September 2026. It retains only NID,
title, official URL, and update date because the regression verifies transport and inclusive window
selection rather than notice normalization.
