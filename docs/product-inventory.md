# Product inventory

## Primary identity

The inventory's primary user-facing identity is `product_name`, `brand`, `scan_date`, and `gtin`.
`scan_date` is a PostgreSQL `date` transported as `YYYY-MM-DD`. Current clients set it from the
user's local calendar and let the user edit it with a platform-appropriate date field. Display uses
an unambiguous English form such as `17 Sep 2026`.

Legacy rows are backfilled from the UTC calendar date of `created_at`, because the original local
timezone was never recorded. `created_at` remains an immutable database-generated audit timestamp.
Changing `scan_date` does not change `created_at`, matching evidence, candidate retrieval, matching
fingerprints, or recall reevaluation.

Model, serial, lot, purchase date, purchase country, category and identification method remain
secondary safety-critical fields and are preserved in product detail.

## Phase 4 scope

Authenticated users can now list, create, view, edit, refresh, and delete their own inventory
records. Manual entry deliberately covers only known identifying fields; it does not scan,
recognize, upload, or look up a product.

## Data boundary and ownership

Screens depend on `OwnedProductsRepository`, never the Supabase client. The
`SupabaseOwnedProductsRepository` is the one mobile adapter that translates database `snake_case`
rows into `OwnedProduct` domain records and back into explicit write rows.

On creation, the adapter reads the current authenticated user from the normal Supabase mobile
client and supplies that ID as `user_id`. Forms, routes, and local state never accept an owner ID.
The existing `owned_products` RLS policies remain the authority for list, read, insert, update, and
delete operations; no privileged key is present in the app.

Manual products store `identification_method` as `manual`; products created through the confirmed
Phase 5 scanner handoff store `barcode_scan`; products created from accepted Phase 6 model, serial,
or lot OCR suggestions store `ocr_assisted`. Every method keeps `identification_confidence` and
`image_path` as `null`. The form trims text and converts blank optional values to `null` so the
database represents absence consistently rather than accumulating meaningless empty strings.

## Product experience

- **My Products** has loading, empty, retryable error, and pull-to-refresh states.
- **Add product** validates a required name, conservative GTIN formats (8, 12, 13, or 14 digits),
  a real non-future purchase date, and practical field lengths. Android and iOS use the platform
  date selector; web uses the browser's date input. The date remains optional and can be cleared.
- **Detail** presents only supplied identifying data, the country of purchase when known, and a
  friendly identification method. It explains the current active-source automatic-monitoring
  context without claiming that the product is safe.
- **Edit** reuses the same validated form. **Delete** requires native confirmation and returns to
  the refreshed inventory list.

## Manual test plan

1. **Empty inventory:** sign in as a user with no products. Confirm that My Products shows “No
   products yet” and its Add a product action.
2. **Create:** add `Philips Airfryer`, brand `Philips`, model `HD9252/90`. Confirm it saves and is
   listed immediately.
3. **Persistence:** close and reopen Recall. Confirm the product remains present.
4. **Detail:** open the product. Confirm its stored fields appear and the screen does not claim a
   recall result or safety status.
5. **Edit:** change its name or another field, save, and reopen it. Confirm the value persists.
6. **Delete:** delete it, approve the confirmation dialog, refresh the list, and confirm it remains
   gone.
7. **Optional fields:** create a product with only a name. Confirm creation succeeds.
8. **Validation:** try an impossible date such as `2026-02-30` and an invalid GTIN. Confirm each
   error is explained and saving is blocked.
9. **RLS user isolation:** as User A create Product A, sign out, then sign in as User B. Confirm
   Product A is not listed.
10. **Direct ownership check:** while signed in as User B, use the normal repository/client to
    request Product A's known UUID. Expect no accessible row (`null`) because RLS filters it.

## Purchase dates

`purchase_date` remains PostgreSQL's optional `date` field: no migration or timestamp field was
introduced in Phase 6.1. The form saves only canonical `YYYY-MM-DD` strings, or `null` when the
user clears the selection. `dateOnlyToLocalDate` constructs a local `new Date(year, month - 1,
day)` for display and `dateToDateOnly` reads local calendar parts for saving. It deliberately does
not parse date-only strings as UTC, which could display the prior or following calendar day in some
time zones. Future dates are rejected in validation and prevented by the picker/browser maximum.

### Purchase-date manual test plan

1. **Create:** add a product, tap **Purchase date**, choose a past date, and save. Confirm the
   friendly mobile display and persisted `YYYY-MM-DD` database value.
2. **Edit:** edit an existing product with a purchase date. Confirm it displays on the correct
   local calendar day, change it, save, and confirm the new value persists.
3. **Clear:** clear the selected date, save, and confirm `purchase_date` becomes `null`.
4. **Future date:** attempt to choose tomorrow or a later day. Confirm it cannot be selected and a
   manually supplied future web value is rejected.

## Barcode scanner handoff

The Phase 5 Scan tab validates and confirms a GTIN before navigating to this same form. The route
parameter is revalidated on arrival and the form validates again on save. The user must enter a
product name; the scanner makes no product-identification claim. Phase 6 applies the same untrusted
route validation to model, serial, and lot suggestions. A detected reference remains review-only
because the existing schema has no `reference_number` column. See
[barcode-scanning.md](barcode-scanning.md) for the supported formats, camera permissions, privacy,
and test plan, and [ocr-scanning.md](ocr-scanning.md) for label acquisition. External product
lookup, image upload, and recall matching remain deferred.
