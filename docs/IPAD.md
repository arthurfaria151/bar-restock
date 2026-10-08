# Bar Restock for iPad

This repository includes a native iPad application project built with Capacitor
8.5.2. The Xcode project is `ios/App/App.xcodeproj`, and its app scheme is `App`.
The application bundles the interface, its catalog of 87 products, product
images, GS1 parser, and ZXing barcode decoder inside the app, so opening it
does not require a website or Safari. Its interface runs in Apple's WKWebView;
clipboard access, the iPad share sheet, mail handoff, and barcode-link JSON
file exports use native Capacitor plugins.

The target supports iPads running iPadOS 15 or later, in portrait and landscape.
Stock counts, minimum stock levels, restock selections, custom products and
categories, shelf layouts, barcode links, delivery drafts and history, and
product photos are saved locally on that iPad. Admin manages products,
categories, minimum stock, shelf layouts, and barcode links. Bartender can
count stock, receive deliveries, update restock lists, and view Shelves.

Receive accepts camera scans or typed codes, lets you confirm unit/carton
quantities, and adds a completed delivery to stock. Supported GS1 labels can
provide contained product codes, carton counts, best-before/use-by dates, and
batch numbers. Finished deliveries remain in History, and recorded dates
appear on the Stock screen when they are approaching or recently expired.

There is no account service or inventory sync between devices. Safari and
Home Screen web-app data live in separate storage and are **not automatically
imported** into this app. Deleting the app can remove its local data.

## Barcode scanning and sharing

`receive.js` loads the decoder from `vendor/zxing-wasm/zxing-reader.iife.js`
and its companion `zxing_reader.wasm`; it overrides the decoder's default CDN
location with the bundled file. Both files and their license notices are
copied into the native app. The decoder is zxing-wasm 3.1.5 (MIT), containing
zxing-cpp (Apache-2.0). See
[the vendored decoder notes](../vendor/zxing-wasm/README.md) for versions,
checksums, and license files. The native bundle can load the decoder offline
without a service worker or network download.

The camera starts after tapping **Start camera**, requests camera permission,
and stops on leaving Receive, changing its view, signing out, finishing a
delivery, or putting the interface in the background. The scanner requests
video only, so it does not need microphone access. Typed codes remain
available when camera permission is denied. Torch controls appear only if
the selected camera supports them.

Admin can use **Receive → Barcodes → Export JSON** to create a temporary
JSON file in the app's cache and open the native share sheet. Choose **Save to
Files** or another available destination. **Import JSON** opens the iPad file
picker. Import merges valid barcode links and replaces matching links with
the file's version after confirmation; links to products absent from that
device are skipped.

A barcode export contains mappings to product IDs, unit/carton information,
and pack sizes. It does not transfer stock counts, custom products, categories,
photos, shelf layouts, or delivery history. Both devices must already have the
products referenced by the exported mappings. Safari's barcode exports can
be imported this way, but the rest of its saved data stays separate.

The app privacy manifest declares the file timestamp API reason `C617.1`
for its own temporary export files. Exporting explicitly hands the JSON file
to the destination selected in the share sheet. The app does not upload the
catalog, camera frames, or inventory to a server.

## Prepare the project

Use Node.js 22 or later. From the repository root:

```sh
npm ci
npm run ios:sync
npm run check:native
npm test
```

`ios:sync` builds the bundled interface into `www/` and copies it into the iOS
project, then updates Swift Package Manager dependencies. Run it after changing
the interface, catalog, images, native bridge, or Capacitor configuration.
Generated web bundles and installed npm dependencies are excluded from Git.
Commit the source files, npm lockfile, and native project when sharing changes.

These commands can prepare and check the project on Linux. Compiling the iOS
application, running an iPad simulator, and signing a device build require a
Mac with **Xcode 26.0 or later**, its command line tools, and an installed iOS
SDK. Swift Package Manager is used; CocoaPods is not required. Xcode resolves
Capacitor from GitHub and the plugin packages from the local `node_modules`
directory, so run `npm ci` before opening the project on another machine.

Capacitor's documented requirements are available in its
[iOS support guide](https://capacitorjs.com/docs/ios) and
[environment setup guide](https://capacitorjs.com/docs/getting-started/environment-setup).

## Run on an iPad

1. On your Mac, run the preparation commands above, then `npm run ios:open`.
2. Connect the iPad to the Mac, trust the Mac on the iPad, and enable Developer
   Mode when iPadOS requests it.
3. In Xcode, select the `App` project, then the `App` target. Under **Signing &
   Capabilities**, leave **Automatically manage signing** enabled and choose
   your Apple development team.
4. The initial bundle identifier is `com.barrestock.app`. If your team cannot
   register it, choose a unique identifier in `capacitor.config.json` and in the
   Xcode target's **Bundle Identifier** setting for both Debug and Release.
   Run `npm run ios:sync` after changing the configuration. Keep those settings
   aligned; syncing does not rename an existing Xcode target's bundle identifier.
5. Select the `App` scheme and your connected iPad as the run destination, then
   press **Run**. Xcode builds, signs, and installs the app. Launch it from its
   Home Screen icon after installation.

A free Apple personal team can sign a development build for your own connected
device, subject to Apple's provisioning limits and expiration. **TestFlight
and App Store distribution require paid Apple Developer Program membership**
and an App Store Connect app record using your registered bundle identifier.
Development signing is separate from store distribution.

To prepare a distribution build, select an iOS device destination in Xcode,
use **Product → Archive**, then **Distribute App → App Store Connect** from
Organizer. Supply the signing team, app metadata, privacy answers, and required
iPad screenshots through Apple's tools. Increment the build number for each
uploaded build. The app does not send inventory or photos to a server, but
sharing, exporting barcode links, or preparing an email explicitly hands
selected text or a JSON file to another app.
A reminder opens a mail composer; it does not send mail in the background.

## Check the Mac build without device signing

After `npm ci` and `npm run ios:sync`, this command compiles a simulator build
without a signing identity:

```sh
xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/bar-restock-ios-build \
  CODE_SIGNING_ALLOWED=NO \
  build
```

To use the app interactively, select an installed iPad simulator in Xcode and
press **Run**. A simulator build does not produce a signed app that can be
installed on a physical iPad.

The `.github/workflows/ipad.yml` workflow runs the JavaScript tests, prepares
and checks the native bundle, and compiles an unsigned simulator app on macOS
for pull requests, pushes to `main`, or a manual run. A successful run publishes
the `BarRestock-Simulator` artifact. It is a simulator build, not a device IPA
or a TestFlight upload; those still need Apple signing and distribution setup.

## Validate on the device

Browser checks and JavaScript tests can validate delivery logic and the
bundled decoder. Live WKWebView camera capture, permission prompts, scanner
performance, native file sharing, and file selection must still be checked
on a physical iPad. Use this checklist:

- Sign in as Admin and Bartender and verify their available tabs and editing
  controls. Count stock, set minimum stock as Admin, add a product with a photo,
  create and rename a custom category, and edit shelf placement and facings.
  Confirm Bartender can view Shelves and receive deliveries.
- Link an EAN/UPC product code as a unit. Scan it, confirm the pending line,
  finish the delivery, and check that stock increased by the confirmed count
  and the delivery appears in History. Compare scanning with typing the code.
- Scan a GS1-128 (Code 128) carton label and, if available, GS1 DataMatrix or QR
  labels. Check contained product lookup, carton/pack counts, best-before or
  use-by dates, and batch numbers. For a carton link with pack size 12, confirm
  that two cartons add 24 units. Check recorded dates on Stock and in History.
- Turn network access off before starting the scanner and verify that its
  bundled JavaScript and WASM load and a barcode can still be decoded. The
  catalog, saved delivery draft, and inventory should remain available.
- Test first camera consent, permission denial, and subsequent retry after
  enabling permission in Settings. With access denied, verify typed codes
  still work. Check a torch control only on hardware that offers one.
- With scanning active, leave Receive, switch to History or Barcodes,
  sign out, and background the app. Verify capture stops and returning requires
  tapping Start again. Rotate the iPad while scanning and check the preview
  and controls. Close and reopen the app to verify drafts and history persist.
- As Admin, export barcode links through the native share sheet, dismiss the
  sheet without saving, and export again to Files. Import a saved JSON file and
  confirm that valid mappings merge, conflicting links require confirmation,
  and unknown-product or invalid entries are skipped. Check that inventory and
  delivery history are unaffected by a barcode-link import.
- Copy and share a restock list, dismiss the share sheet, and prepare a reminder
  in an installed mail app. Check the rest of the interface in portrait and
  landscape. Sharing destinations and email delivery may need their own
  network connection.

Admin access uses the existing PIN configured in `app.js`, and Bartender access
needs no PIN. The PIN is embedded in the interface and controls the visible
workflow; it is not secure authentication. Native packaging preserves this
existing behavior.

JavaScript bridge tests and project/bundle checks do not execute UIKit or
WKWebView on iPadOS. A successful Xcode compile, simulator run, device test,
signed archive, and TestFlight upload must each be validated in an Apple build
environment before claiming those steps are complete.
