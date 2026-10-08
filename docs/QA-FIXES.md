# Website bug fixes and validation

The fixes address the eleven findings from the October 8 website review:

- Failed catalog loading keeps the saved restock list for Retry.
- Product deletion and category renaming commit related keys together, with
  rollback and a recovery journal for interrupted saves.
- Delivery history, stock increments and draft clearing commit together under a
  shared cross-tab lock. Failed saves retain the receipt for retry; a previously
  saved receipt cannot increment stock twice.
- Stock steppers read the latest saved counts and coordinate through Web Locks,
  with an IndexedDB transaction fallback for older Safari.
- Failed product/category/shelf saves keep the prior state and errors. A product
  saved without its photo retains that warning.
- Signed-out edit handlers require a role. Login and sheets make background UI
  inert, contain keyboard focus and restore the shelf picker opener after redraw.
- Quantity input updates retain the original Add button, so its first tap works.
- Photo conversion blocks submission, and superseded conversions are ignored.
- Carton imports require an integer pack size from 2 through 999.
- Stock actions wrap within 320px screens.

Existing storage keys are retained; no reset of inventory or photos is needed.
The service-worker cache version is bumped and includes the new storage helper.
The same fixes are included in the native iPad asset build.

## Checks

`npm test` runs native bridge, GS1 parser and persistence recovery tests.
`npm run test:web` runs Chromium browser regressions, including selective save
failures, actual localStorage quota exhaustion, Web Locks/IndexedDB cross-tab
edits, first-tap quantities, delayed photo conversion, dialog focus, all 84
panel/width/color-scheme combinations, and a service-worker offline reload.
`npm run ios:sync` and `npm run check:native` stage and verify the iPad bundle.

Cloud validation on October 8 passed 39 unit tests, 22 browser regression tests,
all 84 layout combinations, the original core role/clipboard/share smoke checks,
and the complete offline automatic scanner path using the real vendored WASM
decoder and a synthetic local camera stream. Native sync and bundle checks passed.

Chromium tests do not establish physical iPad/Safari compatibility or a signed
Xcode build. The Linux environment cannot compile/sign iOS. Production HTTPS
verification is currently blocked by this cloud environment's domain access;
a GitHub push alone does not establish that the hosting deployment succeeded.
