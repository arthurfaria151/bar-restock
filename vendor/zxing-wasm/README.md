# Vendored barcode decoder

**zxing-wasm 3.1.5** — https://github.com/Sec-ant/zxing-wasm (npm `zxing-wasm@3.1.5`)
WebAssembly build of **zxing-cpp** wrapped for the browser.

| File | From the npm package | Size | SHA-256 |
| --- | --- | --- | --- |
| `zxing-reader.iife.js` | `dist/iife/reader/index.js` (unmodified; global `ZXingWASM`) | 36583 B | `228e6d8ccb841c544386eeafd5f18294d3e4aa0e7aa20419bc51a0009b9d3c17` |
| `zxing_reader.wasm` | `dist/reader/zxing_reader.wasm` (unmodified) | 966895 B | `aecc1876de036c62c8419f67a5e1a16b1698a325bcd190aa84810d516e263931` |

Licenses: zxing-wasm is MIT (`LICENSE-zxing-wasm-MIT.txt`); zxing-cpp, compiled into the
wasm, is Apache-2.0 (`LICENSE-zxing-cpp-Apache-2.0.txt`).

How it's used: `receive.js` loads the script only when the camera is started and calls
`prepareZXingModule({ overrides: { locateFile } })` so the wasm is always fetched from this
folder (the package's default is a CDN). Both files are precached by `sw.js`, so scanning
works offline. To update: replace both files from the same npm version, update this table and
bump `CACHE` in `sw.js`.
