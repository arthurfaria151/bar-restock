# Bar Restock

The website is hosted at [topd.guarasolutions.com](https://topd.guarasolutions.com).
If an older browser session is missing Shelves, Receive, Checklist or Procedures, open
[the update page](https://topd.guarasolutions.com/update.html). It downloads and
checks the current HTML, removes this app's old worker/cache, and opens Shelves.
It preserves localStorage and sessionStorage, including stock, photos and history.
Direct links such as `/#shelves` select that page after sign-in.

Checklist includes the five supplied opening, closing and cleaning lists (139
tasks), with progress and notes saved by date, week or month on this device.
Procedures includes beer line cleaning, incident policy, induction, trivia and
pre-batching training requirements, with 15 original procedure pages available
offline. See [binder coverage and pending sources](docs/BINDER.md). Both roles
can use these pages; `/#checklist` and `/#procedures` open them directly.

Handout has a separate Raspberry Pi server for shared notes and daily archives
at 02:00 Brisbane time. See [Pi installation and connection](docs/HANDOUT-PI.md).
It requires the Pi service and a verified public HTTPS endpoint before activation.

Serve the repository root to run the website; it needs no server-side build.
`npm run build` prepares the separate native iPad bundle in `www/`.

A native iPad application project for counting stock, receiving deliveries,
setting minimum stock levels, building restock lists, and checking the shelf
layout. It includes the latest catalog of 87 products and their images.
The Capacitor iOS project bundles the interface and catalog inside the app.
Clipboard, sharing, email handoff, and barcode-link file exports use native
iPad APIs.

Shelves uses a three-tier black display with a searchable product tray below.
Admin can drag bottles onto levels, move them between levels, or reorder them.
Selecting a product and choosing “Place here” also works without dragging.
Assignments save on this device; the original two-level layout gains an empty
middle tier while retaining its products and facings.

Admin can manage custom products and categories, arrange shelf levels and
product facings, set minimum stock, and link barcodes to units or cartons.
Bartender can count stock, receive deliveries, update restock lists, and view
Shelves. Receive accepts camera scans or typed codes, confirms quantities
before adding them to stock, keeps delivery history, and shows recorded
best-before/use-by dates on Stock.

The GS1 barcode parser and ZXing WebAssembly decoder are bundled locally, so
scanning does not require a CDN. The app can interpret product codes, carton
counts, dates, and batch numbers from supported GS1 labels. The vendored
decoder and its licenses are documented in
[vendor/zxing-wasm/README.md](vendor/zxing-wasm/README.md). Live camera scanning
still needs validation on a physical iPad.

## Development

Use Node.js 22 or later:

```sh
npm ci
npm run ios:sync
npm test
npm run check:native
```

Website regression tests cover failed saves, interrupted delivery recovery,
concurrent stock edits in two tabs, signed-out controls, photo conversion,
delivery quantity entry, barcode imports, dialogs, offline reload and 84
responsive layouts:

```sh
npm ci
npm test
npx playwright install chromium
npm run test:web
```

For an existing system Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its
absolute path. The test runner starts and stops its own local static server.
GitHub Actions runs the website tests separately from the macOS iPad build.
GitHub Pages deploys the root of `main` to the production domain. After changing
runtime files, run `npm run version:web` and commit the updated `index.html`
and `sw.js`. `npm run check:web` verifies that the committed release stamp
matches the assets; CI checks this before testing. Versioned asset URLs avoid
old JavaScript, styles, images and scanner files remaining in the HTTP cache.
See [the fix validation notes](docs/QA-FIXES.md) for scope and remaining limits.

The Xcode project is `ios/App/App.xcodeproj`, with the shared `App` scheme.
Building and installing it requires macOS with Xcode 26 or later. On your Mac:

```sh
npm run ios:open
```

See [the iPad guide](docs/IPAD.md) for connected-device installation, signing,
TestFlight distribution, and device checks. The GitHub workflow builds an
unsigned simulator app; signing and physical-iPad installation are separate.

The interface source is in `index.html`, `app.js`, `receive.js`, `gs1.js`, and
`styles.css`.
`npm run ios:sync` stages only runtime files into `www/`, loads the native bridge
before the interface, and copies that bundle into the native project.

Inventory, custom categories, shelf layouts, delivery records, and photos stay
on the device. Admin can export barcode links as a JSON file through the iPad
share sheet and import a file from Files. This transfers barcode mappings;
stock counts, products, shelf layouts, photos, and delivery history are not
included. There is no full inventory sync between devices. Existing Safari or
Home Screen data is not automatically imported into the native app.
