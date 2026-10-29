# @bsv/expo-android-wallet-bridge

Lets a page in Android Chrome use an Expo app as its BRC-100 wallet over BRC-185's loopback HTTP transport. A Kotlin
loopback server, a launch trampoline, a foreground service and an Expo module form the transport; a TypeScript
controller wires them to `@bsv/expo-wallet-toolbox`'s `core/bridge` (consent, dispatcher, Connect sheet) and a config
plugin does the manifest work. `private: true`, version `0.0.0`: milestone 1 (foreground mode) only. The sheet over
Chrome (overlay, M2) is not built.

Design: `docs/superpowers/specs/2026-10-28-browser-bridge-android-design.md` (revision 3). BRC-185 profile choices and
what is not claimed: `CONFORMANCE.md`. Spike results, emulator evidence, device gates and release gates: `SPIKES.md`.

## How it works, in one paragraph

The page shows an `intent://launch?...` link. Chrome hands it to the app's exported trampoline, which stores the launch
secret in process memory and raises the wallet; the foreground service keeps the process. JS opens the loopback server
(`127.0.0.1` and `[::1]`, ports 3321 up to 3384) only for that session. The page finds the port, reads a signed
descriptor, proves it holds the launch secret in the connect, and the wallet shows its Connect sheet. Every Android site
is "Unverified" (the origin is not attested). The server closes when the last binding ends.

## What the host does

Requires Chrome 142 or newer on the phone (the loopback permission), and an Android-only entry.

1. **Plugin entry** in `app.config.js`:

   ```js
   ;['@bsv/expo-android-wallet-bridge', { scheme: 'bsv-wallet-bridge' }]
   ```

   `android.package` must be set. `scheme` defaults to `<android.package>.bridge`; it must be lowercase RFC 3986 syntax,
   not `http`, `https`, `intent`, `file`, `content`, `javascript` or `data`, and not a scheme the host or another
   activity already handles (the prebuild fails with a named `AndroidWalletBridge:` error). The plugin adds one exported
   `LaunchTrampolineActivity` with a single `VIEW`/`DEFAULT`/`BROWSABLE` filter on `<scheme>://launch`. It warns when the host
   declares `SYSTEM_ALERT_WINDOW` (the kit draws no overlay; block it) or `allowBackup` is true.

2. **Entry file** (`index.js`): after the native crypto bootstrap and before `expo-router/entry`, on Android only:

   ```js
   require('@bsv/expo-android-wallet-bridge').setupAndroidBridge({
     appName: 'Bitcoin SV Wallet', // shown to the page as the descriptor's instance label (never the device name)
     vendor: 'org.bsvblockchain.wallet',
     allowLocalhostHttp: __DEV__ // can only switch the feature off, see below
   })
   ```

   It must run before the wallet is first built: the unverified permissions manager exists only if an unattested
   transport was registered at build time, and a late registration makes every Android dispatch fail `PROVIDER_CHANGED`.
   It registers the `android-loopback` transport, drains the launch record of a cold start, and opens no port.

3. **Mount** `<AndroidBridgeHost />` beside `<PermissionSheet />` inside `BrowserBridgeProvider`. It feeds the
   wallet-in-front signal, asks for `POST_NOTIFICATIONS` once at the first accepted launch, asks native to go back to the browser
   after the last pending item clears, and renders the notices (notifications off, ports exhausted, wallet not ready). It
   renders nothing off Android or before setup.
4. **`app/+native-intent.ts`**: `redirectSystemPath` returns `'/'` for any URL beginning with the bridge scheme. The
   launch never reaches the router (the trampoline consumes it); this is defence in depth.
5. **Plain-HTTP origins in development.** The host states `configureToolbox({ browserBridge: { allowLocalhostHttp: __DEV__ } })`
   itself; the kit never calls `configureToolbox` (it would replace the host's whole toolbox configuration). The router
   asks the same flag at request time, so `setupAndroidBridge`'s option can only switch the feature off.
6. **R8**: the kit's `android/consumer-rules.pro` keeps the module, the trampoline and the service; the host's
   `CodedException` rule covers the error classes. Verify a release build with `dexdump` (see `SPIKES.md`, release gates).
7. **Play Console**: a `specialUse` foreground-service declaration and a data-safety line (release gate).
8. `package.json` gets the dependency when a release is cut; until then `scripts/link-kit.sh <host-dir>` packs this
   package and the toolbox into the host's `node_modules`.

Public API: `setupAndroidBridge`, `AndroidBridgeHost`, `AndroidBridgeNotices`, `resetAndroidBridge`, `getAndroidBridge`,
`getBsvAndroidBridge`, `createSecureStoreContinuity`, `ANDROID_TRANSPORT_ID` (`'android-loopback'`). `createLoopbackPageClient`
(`src/testing`) is the stand-in page client.

## What the user sees, and the way back

The wallet comes forward on the page's launch click, shows the Connect sheet, and returns to Chrome by itself 600 ms after
the last pending item clears, when the bridge raised it. If Chrome is in front when a later request needs approval, a
private notification ("A website wants to continue. Tap to review.", no site named) is posted; with notifications denied
the request waits and the wallet shows a notice when opened. When the wallet was opened by the user, the way back is
the system Back gesture or the app switcher; the kit never forces it. Disconnect is an action on the service notification.

## Limits

- Chrome only, 142 or newer; other browsers are untested. Incognito tabs do not launch (Chrome does not hand `intent://`
  to an app from Incognito).
- A launch on every connect, even for a returning site. Sessions live only while `MainActivity`'s React tree is mounted.
- Process death drops every binding; a request in flight is `unknown` to the page. Bindings idle for 30 minutes are closed.
- No port is open outside a session. At most 4 parked connects, 32 connections, 32 live launch records.
- No overlay over Chrome (M2 is gated on a spike). See `CONFORMANCE.md` and spec section 12 for the full list.

## The two test paths

1. **Stand-in demo page** (never shipped): `NODE_PATH=<dir with esbuild> node demo/build.mjs`, then `node demo/serve.mjs 3001`,
   `adb reverse tcp:3001 tcp:3001`, open `http://localhost:3001` in Chrome on the emulator or a USB-connected phone. A debug host
   build with `allowLocalhostHttp` accepts that origin without a Chrome prompt (BRC-325 exempt). The page has the fast.brc.dev
   BRC-100 conformance panel (vendored, see the iOS kit's `demo/conformance/SOURCE.md`); spending cards are never part of Run all.
2. **Emulator end-to-end driver**: `node scripts/e2e/run.mjs [--only 1,4] [--keep-chrome]` drives 17 cases on the
   Pixel_9 AVD with Chrome over CDP, uiautomator and adb. Preconditions and results: `SPIKES.md` (Task 24); evidence in
   `docs/superpowers/evidence/android-kit/`. The https path (`https://deggen.ngrok.app`) needs its own tunnel and a Chrome
   permission prompt: a device gate.

## Developing

- Toolbox pure modules: `packages/expo-wallet-toolbox/core/bridge/loopback/`, tests in `__tests__/bridge/loopback`.
- Kit tests: `npx jest --ci packages/expo-android-wallet-bridge` from the repo root (no `--forceExit`).
- Kotlin pure-JVM suite: `android/jvmtest` (`check-pure.sh` first, then Gradle 9.3.1 `test`; recipe in `SPIKES.md`). Kotlin that
  needs Android (module, service, trampoline, server threads) is compiled by the host build and exercised on the emulator.
- Never log `k`, the epoch, the launch URI, proofs, acks, binding secrets, tokens, bodies or the `BRC-185-Key` and
  `BRC-185-Android-Binding` headers.
