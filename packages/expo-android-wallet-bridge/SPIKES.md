# Android loopback kit: spike log

Environment: Pixel_9 AVD (android-36 google_apis_playstore arm64), JDK 17, Gradle 9.3.1 (cached wrapper dist).

## KT

Kotlin JVM test recipe: **rung 1 works** (KGP 2.2.10 on cached Gradle 9.3.1). A scratch project in `.scratch/kt`
(`settings.gradle`, `build.gradle` with KGP 2.2.10, junit 4.13.2, hamcrest-core 1.3, `kotlin { jvmToolchain(17) }`) ran
`$GRADLE -p .scratch/kt test` -> `BUILD SUCCESSFUL`, 1 test, 0 failures. junit/hamcrest downloaded fine online.
No fallback in effect: Tasks 9 to 12 use `android/jvmtest` with the same recipe.

## Baseline

WT (bsv-wallet worktree `browser-bridge-android`), after merging `feat/browser-bridge-ios` (117024ba, clean merge, no conflicts, no hand resolution):

- `npx tsc --noEmit -p .` from WT: **0 errors** (TSC baseline = 0).
- Toolbox bridge jest (`packages/expo-wallet-toolbox/__tests__/bridge`): **24 suites, 546 tests passed** (before s0Registration; with it 25 suites, 552 tests).
- WT `node_modules`: per-entry symlinks to `/Users/personal/git/bsv-wallet/node_modules` plus `@bsv/expo-wallet-toolbox` and `@bsv/expo-android-wallet-bridge` links into `packages/` (the latter dangles until Task 13 adds the package files it needs; `package.json` exists now).
- Emulator: `adb devices` -> `emulator-5554 device` (authorized). Chrome (com.android.chrome) versionName **155.0.8059.79** (>= 142, so `chromeAtLeast(142)` is true; the real loopback-permission path is testable). A second `versionName=133.0.6943.137` line in `dumpsys package com.android.chrome` is the hidden preinstalled system stub (/product/app/Chrome-Stub); the active updated package is 155.

HW (bitcoin-sv-wallet worktree `.claude/worktrees/android-bridge`, branch `feat/android-wallet-bridge`, created off `feat/safari-wallet-bridge` at e00f5fa):

- `node_modules`: per-entry symlinks to the main checkout's `node_modules`, then `packages/expo-safari-wallet-bridge/scripts/link-kit.sh <HW>` (unpacks the WT toolbox and the iOS kit as real directories, replacing the symlinks only in HW; the main checkout was not touched). Symlinks did not break jest or tsc. Native builds not yet attempted (Task 13/22).
- `HTSC` baseline: **15 errors** after link-kit (11 without link-kit, when `@bsv/expo-wallet-toolbox` resolved to the old published copy). All 15 are unrelated to the bridge: they come from the host branch expecting a newer toolbox than WT's master base (handle purchase registry `StorePurchase`/`purchase`, `keyArt` prop on EnrollWizard, `hideLogout`/`title` props on the developer screen). Files: `__tests__/handleChange.test.ts` (3), `__tests__/handlePurchaseRegistry.test.ts` (4), `app/_layout.tsx` (1), `app/developer.tsx` (1), `app/vault/keys.tsx` (1), `app/vault/manage.tsx` (1), `app/vault/setup.tsx` (1), `src/handles/claim.ts` (3). Later tasks must not add to this count.
- `HJ` baseline (`npx jest --ci`, run with the metro scratch hunk below applied): **4 suites failed, 13 tests failed, 181 passed, 1 skipped (195)**. Failing suites: `design.test.ts` (2: BalancedText copy and Nunito type ramp, toolbox drift), `handleChange.test.ts` and `handlePurchaseRegistry.test.ts` (purchase fields, toolbox drift), `isolation.test.js` (iOS entitlements/app groups: its config load cannot resolve the `@bacons/apple-targets` plugin, which is declared in the safari-bridge worktree's uncommitted `package.json` hunk but not installed in HW). `safariBridgeHost.test.tsx` and the other bridge host suites PASS.
- Uncommitted edits in the sibling worktree `safari-bridge` (not copied silently). `git diff -- metro.config.js package.json` there:

```diff
diff --git a/metro.config.js b/metro.config.js
index b873fdd..46f62ea 100644
--- a/metro.config.js
+++ b/metro.config.js
@@ -20,8 +20,7 @@ config.transformer.getTransformOptions = async (...args) => {
 const existingBlockList = config.resolver.blockList
 config.resolver.blockList = [
   ...(Array.isArray(existingBlockList) ? existingBlockList : existingBlockList ? [existingBlockList] : []),
-  /\/\.claude\/worktrees\/.*/,
-  /\/\.worktrees\/.*/,
+  new RegExp(`^${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.(claude/)?worktrees/.*`),
   /\/ios\/Pods\/.*/,
   new RegExp(`^${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(ios|android)/.*`)
 ]
diff --git a/package.json b/package.json
index becb196..af2d771 100644
--- a/package.json
+++ b/package.json
@@ -23,10 +23,12 @@
     "postinstall": "patch-package"
   },
   "dependencies": {
+    "@bacons/apple-targets": "5.0.0",
     "@bsv/air-gap": "^0.1.3",
     "@bsv/backup-cache-client": "^0.1.0",
     "@bsv/btms": "^1.2.4",
     "@bsv/btms-permission-module": "^1.2.2",
+    "@bsv/expo-safari-wallet-bridge": "0.0.0",
     "@bsv/expo-wallet-toolbox": "^0.21.0",
     "@bsv/mandala": "0.4.1",
     "@bsv/message-box-client": "^2.6.0",
```

- Is each needed in HW?
  - `metro.config.js` hunk: **needed** for Metro in any worktree under `.claude/worktrees/`. The committed blockList regex `/\/\.claude\/worktrees\/.*/` matches the HW project's own files (checked: it matches `<HW>/app/index.tsx`), blocking everything. The new anchored regex does not. Applied as a **scratch edit in HW** (working tree only, uncommitted). It belongs on the branch only if Task 23 decides so; it is a Metro-in-worktree concern, not an Android-bridge one, so by default it is discarded before Task 23 commits.
  - `package.json` hunk: not needed for jest or tsc in HW (link-kit supplies the packages). `@bacons/apple-targets` is only needed for the iOS `isolation.test.js`, so it stays an unrelated baseline failure. Task 23 adds only the `@bsv/expo-android-wallet-bridge` dependency, not these.

## S0 (P1 core accepts the android-loopback registration)

Result: **PASS** (regression test `packages/expo-wallet-toolbox/__tests__/bridge/s0Registration.test.ts`, 6 tests).

- (a) `registerTransport({id:'android-loopback', attestation:'unattested', bindingMode:'explicit', requestAttention, deliverReconnectToken})` succeeds before `initBridgeRuntime`; `hasUnattestedTransport()` flips true; `onUnattestedTransportChange` fires. PASS.
- (b) the listener fires on register (true) and unregister (false). PASS. Registration-order effect on the wallet build is pinned in Task 17.
- (c) a `ContinuityStore` keyed `android:<origin>` signs a describe response that `verifyDescribeProof` accepts. PASS (ctx is a plain string).
- (d) `connectExplicit` with `attestation:'unattested'`, `launchProofVerified:true`, `reconnectToken` creates a live binding and `takeReconnectToken` returns the token once; without `launchProofVerified` it throws `CONFIGURATION_ERROR` / `not-sent` and creates no binding. PASS.
- (e) `attachBridgeHost({hasWallet:false})` and its detach do NOT call `onSnapshotChange` while readiness stays `none`. Test asserts the current behaviour; this is the gap Task 2 closed: assertion (e) is now inverted (`hostAttached` on the snapshot makes attach and detach fire `onSnapshotChange`). No other seam is missing for S0.

Fallbacks in effect: none.

## Task 13 (Android module compile and autolink)

Result: **PASS** (compile and autolink; behaviour is exercised by Tasks 22 and 24 on the emulator).

- `scripts/link-kit.sh <HW>` (adapted from the iOS kit's) packs the toolbox and this kit into `HW/node_modules/@bsv/`. `@bsv/expo-android-wallet-bridge: 0.0.0` was added to `HW/package.json` as a scratch edit (working tree only, discarded before Task 23).
- `HW` prebuild needed a second scratch edit: `app.config.js` loses the `@bsv/expo-safari-wallet-bridge/app.plugin` entry, because that plugin requires `@bacons/apple-targets`, which is not installed in `HW` (see Baseline). Android prebuild is otherwise unchanged. Also discarded before Task 23.
- Autolinking: the project is named `bsv-expo-android-wallet-bridge` (Gradle, from the scoped package name), not `expo-android-wallet-bridge`. `:bsv-expo-android-wallet-bridge:compileDebugKotlin` -> BUILD SUCCESSFUL on the first compile; `:app:compileDebugKotlin` -> BUILD SUCCESSFUL. `org.bsv.walletbridge.BsvAndroidBridgeModule::class.java` appears in `ExpoModulesPackageList.kt`. In Expo SDK 57 that file is generated under `node_modules/expo/android/build/generated/expo/src/main/java/expo/modules/` (a build output reached through the `node_modules/expo` symlink into the main checkout), not under `app/build/generated`.
- Merged debug manifest (`:app:processDebugMainManifest`) holds the trampoline (exported, `Theme.NoDisplay`, no intent filter) and the `specialUse` service with the subtype property. `SYSTEM_ALERT_WINDOW` appears in the merged debug manifest from the React Native debug manifest, not from this library (the library manifest has none; the manifest jest test pins that).
- Whole-app `:app:assembleDebug` was not run for this task: the module and app Kotlin compile and manifest merge are the evidence; the APK is built in Task 22.
- Decision: the trampoline takes the scheme from the matched intent's own data (`intent.data.scheme`) and validates host `launch` and size with `LaunchIntent.validate`, because the library cannot know the plugin's scheme at compile time. A caller that targets the exported trampoline directly can only store an unprovable record that JS burns (the same power a web page has).
- Decision: `startServer` replaces (stops silently, events of the old generation are dropped) a server left running by a previous JS runtime, so a reload can restart.

## Task 14 (config plugin and resolver check)

Result: **PASS**. Plugin: `app.plugin.js` -> `plugin/{index,validate,manifest}.js` (`withAndroidWalletBridge`, `resolveScheme`); 13 jest tests in `__tests__/plugin` plus the 4 manifest-lint tests all pass (`KJ __tests__`).

- Scheme rules: default `<android.package>.bridge`; RFC 3986 syntax, lowercase, and not `http`, `https`, `intent`, `file`, `content`, `javascript`, `data`; refused when it equals a host scheme (Expo `scheme` string or array, `android.intentFilters` data). The manifest mod also refuses a scheme another activity or alias in the app manifest already handles. Warnings (never errors): `android.permissions` declaring `SYSTEM_ALERT_WINDOW` (blocking it, as the host does, does not warn), `allowBackup` true in config or in the manifest.
- The trampoline entry in the app manifest is `<activity android:name="org.bsv.walletbridge.LaunchTrampolineActivity" tools:node="merge">` with exactly one filter (`VIEW`, `DEFAULT`, `BROWSABLE`, scheme, host `launch`); a re-run or a changed scheme replaces the filter instead of adding one. `xmlns:tools` is set on the manifest root.
- `__tests__/plugin/fixtures/withIconAliasLinks.js` is a verbatim copy of the host's `plugins/withIconAliasLinks.js` (taken from the main bitcoin-sv-wallet checkout at Task 14). Task 23 must diff it against the real file.
- Resolver check on Pixel_9 (HW scratch: plugin entry `['@bsv/expo-android-wallet-bridge', { scheme: 'bsv-wallet-bridge' }]` added to `HW/app.config.js` in place of the removed safari entry, `link-kit.sh`, `expo prebuild`, `:app:assembleDebug` arm64-v8a in 3m41s with warm caches, `adb install -r`):
  - `cmd package resolve-activity --brief ... -d 'bsv-wallet-bridge://launch?v=1'` -> `org.bsvblockchain.wallet/org.bsv.walletbridge.LaunchTrampolineActivity`.
  - `dumpsys package` shows one `bsv-wallet-bridge` filter on the trampoline (`VIEW`, `DEFAULT`, `BROWSABLE`, authority `launch`) and no other component under that scheme.
  - `am start -W` with the shape-valid but otherwise empty URI `bsv-wallet-bridge://launch?v=1`: `Status: ok`, no FATAL or AndroidRuntime in `logcat -d`, `Theme.NoDisplay` resolves (the task was `isTopActivityNoDisplay=true`). Note: `LaunchIntent.validate` checks shape only (scheme, host `launch`, 512 B), so this URI is stored as an unprovable record and the trampoline raises the app (the dev launcher came forward, the cold start took 2.3 s); JS burns the record later (Task 16). Only a URI failing the shape check is dropped without raising the app.
- The scratch HW wiring (`app.config.js`, `package.json`, `metro.config.js`, `android/`, linked `node_modules/@bsv`) stays uncommitted; build outputs in `HW/android/app/build` are kept for Task 22.

## Task 17 decisions (controller, setup entry)

- **`allowLocalhostHttp` is not forwarded with `configureToolbox`.** The plan asked `setupAndroidBridge` to call
  `configureToolbox({ browserBridge: { allowLocalhostHttp } })`. `configureToolbox` replaces the host's whole toolbox
  configuration and throws without a `backupUrl` (toolboxConfig.ts), and the host already states the flag in its own call
  (`app/_layout.tsx`, `browserBridge: { allowLocalhostHttp: __DEV__ }`). The kit therefore never calls it. The router env asks
  `getBrowserBridgeConfig().allowLocalhostHttp === true && __DEV__` at request time, the same expression the core registry uses,
  so both agree; the `setupAndroidBridge` option can only switch the feature off (`false`). Tests: `setup.test.ts`.
- **Settle signals.** Approval settles through `deliverReconnectToken` (owner only); the reconnect-token path flips `consented`
  without calling the transport, so the controller also checks `registry.live()` after every response and on
  `onConnectedSitesChange`.
- **Snapshot wiring lives in the controller.** The controller subscribes `onSnapshotChange` and forwards `hostAttached` and
  readiness to the session (cold-start parking depends on it). Task 18's `AndroidBridgeHost` must not repeat that subscription;
  `session.onHostAttached` is idempotent in any case.
- **wallet-not-ready freshness.** "Right after a launch" is 20 s (`LAUNCH_FRESH_MS`) from the last accepted launch; nothing is
  posted inside it, a notification afterwards.

## Task 20: demo page

- **esbuild is not installed in `WT/node_modules`** and neither root `package.json` declares it (the iOS kit's `demo/build.mjs`,
  `plugin/buildExtension.js` and 7 iOS suites already needed it; they fail with `Cannot find module 'esbuild'` without it).
  Run `node demo/build.mjs`, `node demo/serve.mjs` and the iOS jest suite with
  `NODE_PATH=/Users/personal/git/ts/bitcoin-sv-wallet/.claude/worktrees/safari-bridge/node_modules` (esbuild 0.28.2, read-only use,
  nothing in that worktree is touched). With it: `node PKG/demo/build.mjs` builds `.build/demo/demo.js` (about 1.3 MB, target
  `chrome100`), and `npx jest --ci packages/expo-safari-wallet-bridge` is 34 suites / 314 tests green after the type-only edit.
- Serve the Android demo on 3001 (the iOS demo holds 3000): `node PKG/demo/serve.mjs 3001`, then `adb reverse tcp:3001 tcp:3001`;
  the page origin is then `http://localhost:3001` (BRC-325 loopback exempt in a debug build).
- The Conformance panel and `bridgeWallet.ts` are imported from the iOS kit by relative path; the iOS demo files now take
  `PageClient`, `Connection` and `isConnectionError` from the toolbox `core/bridge/testing/pageClient` (type-only edit).
- "Open wallet" starts a discovery scan right after `launch()` (as the page contract does after one click); `describe` rescans
  with the same launch. `absent` is shown as `ABSENT: no wallet answered` (the client reports it as `wallet did not open`).

## Task 22: walking skeleton on Pixel_9 and spikes S1, S2, S5, S5b, S7

Environment: Pixel_9 AVD, Chrome 155.0.8059.79 (>= 142), `http://localhost:3001` through `adb reverse tcp:3001 tcp:3001` (the iOS demo owns 3000
and the ngrok tunnel), debug dev-client build of the host (`HW`, arm64-v8a, Metro on 8082). Host wiring is scratch only (uncommitted in `HW`):
the plugin entry, `setupAndroidBridge({ appName: 'Bitcoin SV Wallet', vendor: 'org.bsvblockchain.wallet', allowLocalhostHttp: true })` in
`HW/index.js`, `<AndroidBridgeHost />` beside `<SafariBridge />` in `HW/app/_layout.tsx`. No spike commit exists in WT (nothing in the kit needed a probe;
the probes lived in `HW/index.js` and `HW/node_modules` and were removed).

### Step 1: walking skeleton

**PASS.** App installs and starts, no `FATAL EXCEPTION`, test wallet created through the uiautomator sequence (maestro not installed: device gate, not
needed), Home reached. Full path works: Open wallet -> trampoline -> wallet forward -> describe answered ("OK open", cold about 5 s end to end) -> connect ->
`getVersion` -> `createAction` (answered by the wallet; the unfunded test wallet returns `WERR_INSUFFICIENT_FUNDS`, which is the wallet's own answer) -> the
connect sheet and the protocol sheet, approved by tapping -> wallet returns to Chrome by itself after the last sheet -> `createSignature` passes.
Harness facts found on the way (fixed in `scripts/e2e`):

- `uiautomator dump` fails with `could not get idle state` while the welcome art or the Home tour card animates. Animation scales 0 during wallet creation
  fix it there (`setAnimationScale`); the scale is restored to 1 afterwards because the sheets are verified at the normal scale. On Home the dump can still fail:
  the notification shade, the Connect and Authorize buttons are tapped by coordinates (sheet buttons at about x 789, y 2248 on this 1080x2424 screen).
- `firstPage()` picked the last tab, not the foreground one, once several tabs existed; it now picks the visible tab.
- Chrome 155 `Browser.grantPermissions` takes the camelCase names `loopbackNetwork` and `localNetworkAccess`; the kebab-case Permissions API names are refused
  ("Unknown permission type"), and puppeteer's `overridePermissions` only knows its own list. `grantLoopback` now calls the CDP method directly.
- `toybox nc -l` holds a port for ONE connection: the demo page's own discovery probe consumed the holders. `sockets.mjs` uses `nc -L ... cat` (persistent).
- The page's CDP session returns nothing for a hidden (backgrounded) tab: scripts must front Chrome first.

**Defect found and fixed (blocking, commit `fix(android-bridge): sheet stays hidden ...`).** When the wallet is raised from the background to answer a
request, the permission sheet's scrim painted but the sheet itself never did (Pixel_9, Android 16, Fabric, reanimated): the shared value `translateY` read 0 from
JS while the view stayed at its hidden offset. Repro: Chrome in front, `connect`, `createAction`, tap the attention notification (100%, also with animation scales 1).
Controls: with the wallet already in front when the request arrives the sheet shows; with `animatedStyle` removed from the `Sheet` it shows. Fix: `Sheet` re-applies
its open position (0.5 then `withTiming(0, 60 ms)`) when the app becomes `active` while the sheet is visible. Verified on the device (sheet visible after the notification tap).
Not unit-testable (native view state); `PermissionSheet` jest unchanged and green. Owner note: this is a toolbox UI change, not a kit change.

### S2 (launch from Chrome, trampoline, foreground service)

- **No chooser**, the trampoline runs and the wallet comes forward on a real gesture click (`Input.dispatchMouseEvent`).
- **URI never leaks:** `adb logcat -d | grep -cE 'k=[A-Za-z0-9_-]{43}'` is 0 (a plain `grep -c "k="` returns about 42 from WindowManagerShell lines: not meaningful); the system's own
  `ActivityTaskManager: START` line prints the data as `bsv-wallet-bridge://launch/...`. A `Linking` probe in `HW/index.js` saw only the dev-client link as the initial URL (75 chars)
  and no `url` event on launches: the launch URI never reaches JS `Linking`.
- **Launch without a gesture is blocked:** a click scripted 9 s after the last real gesture (transient activation expired) produced 0 trampoline starts. A scripted `.click()` made
  right after a real click on the same page DOES start the trampoline (sticky/transient activation still valid); puppeteer `evaluate` itself counts as a gesture, so the test needs `setTimeout`.
- **Fallback URL:** with the wallet package disabled (`pm disable-user`, equivalent to uninstalled for resolution and keeps the test wallet; re-enabled afterwards), a launch with
  `?fallback=` navigated Chrome to the fallback URL.
- **Rapid second launch:** two launch intents 0.1 s apart reached the trampoline (2 `START` lines), only ONE `MainActivity` start followed (3 s throttle holds).
- **Incognito tab:** the click produced 0 trampoline starts and no visible dialog in the UI tree (incognito screens are black in `screencap`, FLAG_SECURE); the page ends `absent`. Chrome does not
  hand an `intent://` to an app from Incognito without a confirmation that was not observable here: record as "launch does not happen from Incognito". Owner device gate: check on a real phone.
- **Foreground service:** `dumpsys activity services org.bsvblockchain.wallet` lists `BridgeService`, `isForeground=true`, `types=0x40000000` (specialUse), channel `bridge-session`, `vis=PRIVATE` with a
  generic public version; started from the foreground (`Background started FGS: Allowed ... uidState: TOP`). PASS, first exercise.
- **Notifications:** the first accepted launch with the wallet in front shows the system `POST_NOTIFICATIONS` dialog (after `pm revoke` and clearing `bsv_android_bridge.xml`); granted by tapping Allow. Until it
  is granted nothing is posted when Chrome is in front and a request needs the user (no sheet reachable): expected from the design, but the ask happens once at the first launch only, so a user who dismisses it
  has no way back except the system settings and the `bridge_notifications_off` banner (which shows only inside the wallet). Record for Task 24 and the owner. The attention notification text is
  "A website wants to continue. Tap to review." (`vis=PRIVATE`, generic public version, `category=msg`, channel `bridge-attention`); it is not posted within 20 s of a launch (`LAUNCH_FRESH_MS`).
- Observation: the page's discovery sometimes logs `UNAUTHENTICATED: a responder answered without proving it holds the launch key; sent nothing` at the same millisecond as the successful `open`
  (one endpoint of the race answered `describe` before the launch record was known to JS); the scan still resolves `open`. Not blocking; look at it in Task 24 (conformance run).

### S5 (background hold) and S5b (timers)

- **S5 PASS.** `scripts/e2e/hold.mjs --minutes 30 --screen-off`: connected page, `createSignature` request left at the permission sheet, Chrome in front, screen off
  (`KEYCODE_SLEEP`) and `dumpsys deviceidle force-idle` (state `IDLE`) for 30 minutes, 60 samples at 30 s: wallet process alive in every sample, `BridgeService` listed, binding live afterwards
  (`getVersion` answered). After waking, the attention notification was still there, the protocol sheet showed and Authorize completed the call (`createSignature pass`). The page-side conformance card
  has its own 120 s no-progress watchdog, which fired when Chrome woke (its timers are frozen with the screen off): that is the page harness, not the bridge (no bridge deadline applies to an admitted request).
  `hold.mjs` was rewritten: the plan's `createAction` returns an error on an unfunded wallet before any sheet, so the request is the conformance card `conformanceCreateSignature`, started from an
  already approved connection; the connection is set up by the driver.
- **Process kill:** `am kill` does nothing to the foreground-service process; `run-as ... kill -9 <pid>` kills it. The pending request answers `The wallet did not answer`, the next call
  `CONNECTION_CLOSED (delivery not-sent): The connection is closed; open the wallet again`; the service is NOT restarted (START_NOT_STICKY).
- **MainActivity destroyed (spec 7.1):** the "Don't keep activities" developer setting did not destroy the activity on Android 16 (the record stayed paused and `getVersion` still answered): not used. Pressing BACK in
  the wallet destroys `MainActivity` (0 activity records) with the process alive: the pending request fails (`The wallet did not answer`), the binding closes, `BridgeService` stops and the listener is gone; the page
  gets `CONNECTION_CLOSED ... open the wallet again`. This matches spec 7.1.
- **S5b PASS (expected result).** With a probe in `HW/index.js`, while `AppState` was `background` (wallet stopped, process alive under the service): a JS `setInterval(1000)` stalled for 56.4 s and caught up
  only when the activity resumed; a Kotlin `setTimer('s5b-probe', 20000)` fired after 20.002 s (13213017 -> 13233019 ms elapsedRealtime) and its `onTimer` event reached JS in the background; `onRequest` events reached JS while backgrounded, about 41 ms
  after the page sent the request (page epoch ms against logcat, 5 h zone offset). Kotlin timers stay (spec decision); JS timers do pause.

### S7 (localhost family, Host check, describe latency)

- **Family:** for `http://localhost:3321/...` from the page, Chrome 155 connects over `::1` first and succeeded there (12 new `::1` TIME_WAIT entries on :3321, none new on 127.0.0.1).
- **Host check:** over `adb forward` with a spoofed `Host`: `evil.example.com` 403, `localhost:3321` 200, `127.0.0.1:3321` 200, `[::1]:3321` 200, `127.0.0.1:3322` (wrong port) 403 (each with `Origin: http://localhost:3001`; without an `Origin` header every Host gets 403).
- **Describe latency while the wallet builds (cold start from a killed app):** 4 usable runs of 5 (a script error on the fifth): first answer 3.6 to 4.7 s after the click, with each answered describe taking 0.7 to 1.9 s
  (worst 1919 ms) against the 3000 ms per-attempt timeout; attempts before the server is up are refused in under 25 ms. 10 end-to-end cold opens (launched -> `OK open`): median 5034 ms, worst 5343 ms, all succeeded. Worst
  per-attempt is under 3000 ms: the demo default stays 3000.

### Step 4b (ports exhausted, 60 s self-stop, Disconnect)

All 64 IPv4 ports 3321 to 3384 held with persistent `nc -L` listeners (64 LISTEN entries confirmed): the launch raised the wallet, `bridge_ports_exhausted` ("Another program is using the ports BSV Wallet needs")
showed in the wallet, the page found no wallet, and `BridgeService` was not listed 15 s later (the session stops the service as soon as the bind fails, which is within the 60 s the plan allows). Ports released, a normal
connect worked ("1 site connected" notification with Disconnect and Manage actions); tapping Disconnect: the page's next call got `CONNECTION_CLOSED ... The wallet did not answer`, `BridgeService` gone.

### S1 (Chrome 142+ permission path)

Chrome 155: the exempt path (`http://localhost:3001`, debug build) works end to end. `navigator.permissions.query({name: 'loopback-network'})` answers `prompt` (the name exists); no prompt appeared for the
localhost origin. The https half through `https://deggen.ngrok.app` was NOT run: that domain is the iOS demo's tunnel to 3000 (not to be stopped or re-pointed), so the Android page cannot be served there
-> **device gate (b)**: `ngrok` path for the Android demo needs its own tunnel or the iOS tunnel handed over by the owner. CDP names for granting: `loopbackNetwork`, `localNetworkAccess`
(`Browser.grantPermissions`, both accepted). S8 not run (informational).

### Device gates for the owner

- S1 and S2 on a real phone with a Chrome 142+ build: the permission prompt label, https page to loopback, mixed content, Incognito behaviour.
- OEM background-start and battery-optimisation behaviour (S5 and the foreground service on Samsung, Xiaomi, Pixel with Doze).
- ngrok https path for the Android demo in a release build with R8 (needs its own tunnel).
- Play Console `specialUse` foreground-service declaration (property subtype text).
- maestro for the host flows (`brew install maestro`, owner approval); the uiautomator sequence is used meanwhile.

## Task 23: host adoption

HW commit 810480b `feat(android-bridge): adopt the Android bridge kit` (branch `feat/android-wallet-bridge`).

- Scratch Task 22 edits were saved to the session scratchpad and discarded with `git checkout -- <file>`; `link-kit.sh` re-run.
- HTSC 15 errors and HJ 4 suites / 13 failed tests, identical to the baseline (new tests add 192 passing). The Android isolation tests run the kit's manifest mod alone, because a full config load needs `@bacons/apple-targets` (not installed in HW; the 5 iOS isolation tests fail on that, as in the baseline).
- HBUILD (with the Safari plugin entry removed and the kit dependency added as scratch edits, both reverted): `:app:assembleDebug` succeeded; the debug APK manifest holds one exported `LaunchTrampolineActivity` with a single filter (`VIEW`, `DEFAULT`, `BROWSABLE`, scheme `bsv-wallet-bridge`, host `launch`). `SYSTEM_ALERT_WINDOW` there comes from the RN debug manifest (host `blockedPermissions` strips it in release).
- `setupAndroidBridge` is placed before the startup prewarm in `index.js` (not just before `expo-router/entry`), so the transport exists before any wallet build can start.
- `withIconAliasLinks.js` fixture is identical to the host file; no refresh needed.
- Not committed: the kit dependency line in `package.json` (release), and the metro.config.js worktree hunk (saved in the scratchpad as task22-scratch.diff; reapply for Task 24 Metro runs).

## Task 24: emulator end-to-end

Run: `scripts/e2e/run.mjs`, one clean full run on Pixel_9 (android-36 google_apis_playstore arm64), Chrome 155.0.8059.79, host debug build from `HW` commit 810480b (dev client, Metro on 8082), page origin **`http://localhost:3001`** (the iOS demo holds 3000 and its ngrok tunnel; the plan's `localhost:3000` becomes `localhost:3001` everywhere), `adb reverse tcp:3001 tcp:3001`, `node demo/serve.mjs 3001`. Evidence: `docs/superpowers/evidence/android-kit/` (`results.json`, one or two screenshots per case, `06-conformance.json`, `14-logcat-check.txt`, `15-attention-notification.txt`).

Preconditions and how to repeat: emulator up and authorized; the host debug APK installed; in `HW` the scratch edits `app.config.js` (Safari plugin entry removed: `@bacons/apple-targets` is not installed there) and `metro.config.js` (anchored worktree block-list regex, `task22-scratch.diff` hunk) applied working-tree-only and reverted afterwards; Metro on 8082; `NODE_PATH=<safari-bridge worktree>/node_modules` (esbuild for the demo build and for case 11's squatter bundle); then `node packages/expo-android-wallet-bridge/scripts/e2e/run.mjs [--only 1,4] [--keep-chrome]`. A full run clears the evidence directory and the logcat buffer first. HW node_modules: the per-entry symlinks plus `link-kit.sh` (no `npm ci` needed; symlinks did not break the native build).

### Results (clean run, 17 of 17 pass)

| #   | Case                                             | Result               | Observed                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | cold launch from Chrome, process dead            | pass                 | trampoline, wallet forward, Connect sheet shows `http://localhost:3001` with the Unverified badge, Connect, page connected (`01-*.png`)                                                                                                                                           |
| 2   | `getVersion`, `isAuthenticated`                  | pass                 | `{"version":"bsv-wallet-bridge-1"}`, `{"authenticated":true}`                                                                                                                                                                                                                     |
| 3   | `getPublicKey`; request held open across a sheet | pass                 | key returned; `createAction` is answered by the wallet itself (`WERR_INSUFFICIENT_FUNDS`, unfunded test wallet, no sheet); the held-open request is the conformance card `conformanceCreateSignature`: attention notification, sheet, Approve, card passes                        |
| 4   | Don't connect                                    | pass                 | `USER_CANCELLED (delivery not-sent): The connection was declined`; an immediate retry gets `RESOURCE_LIMIT ... This site was just declined`, nothing granted                                                                                                                      |
| 5   | warm launch, silent reconnect                    | pass                 | process alive, token presented, `getPublicKey` answered with no Connect sheet                                                                                                                                                                                                     |
| 6   | conformance, Run all safe                        | pass (run completes) | 41 cards: 20 pass, 10 fail, 11 not run (spending cards keep their own Run button); 73 sheets approved. Failing cards, all recorded in `06-conformance.json`, see below                                                                                                            |
| 7   | kill the app (`kill -9`)                         | pass                 | pending call: `CONNECTION_CLOSED (delivery unknown): The wallet did not answer`; a new launch recovers (token reconnect)                                                                                                                                                          |
| 8   | MainActivity destroyed, service alive            | pass                 | via Back (see substitutions): activity records 0, process alive, `BridgeService` gone with the binding, page gets `CONNECTION_CLOSED`, new launch reconnects                                                                                                                      |
| 9   | 3321 and 3322 held on both families              | pass                 | wallet bound 127.0.0.1 and ::1 on 3323, page found it                                                                                                                                                                                                                             |
| 10  | `::1:3321` held alone                            | pass                 | `toybox nc` binds ::1; wallet moved to 3322 on both families                                                                                                                                                                                                                      |
| 11  | squatter on 3321 with the real name              | pass                 | host squatter (signed descriptor under its own key, real name and vendor, no `k`) behind `adb reverse tcp:3321`: page logs `UNAUTHENTICATED`, finds the real wallet on a higher port; the squatter saw only describe GETs and no secret header                                    |
| 12  | notifications revoked                            | pass                 | `bridge_notifications_off` shown with a request pending, no attention notification posted, the sheet is offered when the wallet is opened, Approve completes it                                                                                                                   |
| 13  | Incognito                                        | pass                 | Incognito tab opened from Chrome's menu (new-tab page "You've gone Incognito", then `localhost:3001` loaded), the Open wallet button tapped for real: 0 trampoline starts, wallet did not come forward; control with the same tap in a normal tab: 1 trampoline start. Matches S2 |
| 14  | plaintext check                                  | pass                 | logcat from the start of the run (69,691 lines, 7 epochs launched): no `k=<43>`, no `n=<22>`, no launched epoch or `e=<uuid>`, no reconnect token or binding header anywhere, system lines included                                                                               |
| 15  | later-prompt attention                           | pass                 | `bridge-attention` notification, text "A website wants to continue. Tap to review.", `vis=PRIVATE` with a public version, no origin anywhere in the record; the tap shows the sheet (`bridge-approve`)                                                                            |
| 16  | return to browser                                | pass                 | wallet raised by the trampoline: Chrome is the top resumed activity 1.4 s after the tap on the last Approve. Control: raised by the attention notification, the wallet stays in front (by design: `returnToBrowser` only when the bridge raised it)                               |
| 17  | Disconnect action                                | pass                 | page's next call `CONNECTION_CLOSED (delivery unknown)`, `BridgeService` no longer listed                                                                                                                                                                                         |

Case 6 failing cards (the wallet's own answers, forwarded intact; none is a bridge defect):

- `getVersion`: the P1 core's static answer `bsv-wallet-bridge-1` (`DEFAULT_BASE_VERSION`, `core/bridge/runtime.ts`) fails the fast.brc.dev card's "vendor-major.minor.patch within 7-30 bytes". The same string is what the iOS kit answers. **Finding F2 for the owner:** either the card or the default base should change; the host can override the base through the provider.
- `createAction`, `signAction`, `abortAction`: code 7, insufficient funds (unfunded test wallet); `proveCertificate`: needs `acquireCertificate`, which is a spending-class card not in Run all safe.
- `discoverByAttributes`: `timeout`, "no progress for 120 s (wallet not answering?)"; recorded as failed, the run continues with the next card. Not investigated further (the same card passed in an earlier partial run).
- Crypto matrix 12 of 24, Key-linkage matrix 10 of 20: every failing branch is `privileged-true` (error code 6, the wallet's own refusal of privileged keys); `listActions/options-61` and `listOutputs/options-49` fail with code 6 and the card skips the rest of its matrix (65 and 53 cases) by its own design.

### Substitutions and deviations

- **Origin** `localhost:3001` instead of 3000 (see above); the ngrok https path is a device gate (b) again.
- **Where the Connect sheet appears.** `connect` itself creates an unsettled binding and answers without any sheet. The Connect sheet (title "wants to connect to your wallet", Don't connect / Connect, ids `bridge-deny` / `bridge-approve`) is raised by the first interactive request of a token-less binding (core spec: the token-less binding's first interactive request raises the sheet). The driver therefore sends `getPublicKey` after `connect` and the page "shows connected" once that answers. `getVersion` and `isAuthenticated` never raise it.
- **Requests that need the user (cases 3, 12, 15, 16):** the unfunded test wallet answers `createAction` with an error before any sheet, so a pending request is the conformance card `conformanceCreateSignature` (protocol sheet), started from the connected page.
- **Case 8:** the "Don't keep activities" setting does not destroy the activity on Android 16 (S5); Back from the wallet destroys MainActivity with the process and service alive, the same state spec 7.1 describes.
- **Case 11:** the squatter is a real HTTP server on the host (`scripts/e2e/squatter.entry.ts`, bundled with esbuild at run time) reached through `adb reverse tcp:3321 tcp:3321`, not a `toybox nc` echo.
- **Case 13:** Chrome ignores the incognito intent extra on external intents and DevTools lists no Incognito target, so it is driven from Chrome's menu with real taps and a normal-tab control (above).
- **Animations.** uiautomator cannot reach an idle state while Home loops its tour art (`could not get idle state`), so every UI read runs with animation scales at 0 and restores 1 afterwards (`withUi`); case 6 keeps them at 0 for its whole run. The Connect and protocol sheets were observed at scale 1 in cases 1, 3 and 15 (the screenshots are taken at scale 1 except in case 6).
- **Return-to-browser timing (case 16):** the plan says "wait 1 s"; the grant has a 400 ms delay and the answer takes a moment, so the case polls and records the latency (1.4 s).
- The commit trailer follows the executing harness's attribution (`Claude Sonnet 5.5`) instead of the task text's `Claude Opus 5.5`.

### Findings

- **F1 (toolbox UI, fixed after the whole-branch review in ddbba5e1: a pending grant is answered at once when the app leaves the foreground; not yet re-run on the emulator): an Approve is parked if the user leaves the wallet within the grant delay.** `PermissionSheet.handleGrant` runs `executeGrant` from a JS `setTimeout(…, 400)`; JS timers pause while the activity is paused (S5b). Approve then switching to Chrome at once leaves the request unanswered ("1 request waiting") and the page's call stays open until the wallet is brought to the front again, when it completes (reproduced: status `running` for 20 s in Chrome, `pass` 3 s after fronting the wallet). Normal use is unaffected (the wallet returns to the browser by itself after the answer), but a user who presses Home right after Approve sees the page stall. Fix candidates: run `executeGrant` without the timer when the app state is not `active`, or use a Kotlin timer. The harness avoids it (it never fronts Chrome right after an Approve).
- **F3 (observation):** after `kill -9` of the wallet process, the first Open wallet from the page reported `ABSENT: no wallet answered in the scan window` once (attempt 1 of case 7 in the final run; the log line is in the run output); the retry (a new click) succeeded. Cold launches from a clean `force-stop` (cases 1, 4, 8, 9 to 11) never needed a retry. Cause not isolated (system restart delay after a crash is the likely one).
- **F4 (S2 re-observed):** the system's own `ActivityTaskManager START` line did not carry the key in this run (case 14 found no `k=` anywhere).

### Device gates (unchanged, non-blocking)

ngrok/https path and the Chrome permission dialog for a non-exempt origin (S1b); OEM background-start and battery behaviour (Samsung, Xiaomi, Pixel Doze) and the real-phone passes; Play Console `specialUse` declaration; maestro for the host flows (`brew install maestro` needs owner approval, the uiautomator sequence is used); Incognito on a real phone (re-observed on the emulator only).

## Task 25: suites at release-prep time, and release gates

Suites run in the final state of this branch (no `--forceExit`):

- `TSC` (`npx tsc --noEmit -p .` from WT): 0 errors (baseline 0).
- `TBJ` whole package `packages/expo-wallet-toolbox`: 402 suites passed, 1 skipped, 7048 tests passed, 9 skipped. Jest prints "A worker process has failed to exit gracefully" at the end of the run (open handle in some suite); the run still exits 0 on its own. Look at it before tagging the toolbox release.
- `KJ`: 20 suites, 159 tests passed. `KT` (`android/jvmtest`, `check-pure.sh` ok for 9 files, `cleanTest test`): 89 tests, 0 failures. iOS kit `npx jest --ci packages/expo-safari-wallet-bridge` (with `NODE_PATH` to an esbuild install, Task 20): 34 suites, 314 tests passed.
- Host (`HW`, commit 810480b): `HJ` 4 suites / 13 tests failed, 192 passed, 1 skipped; `HTSC` 15 errors. Both equal the Task 1 baseline (all unrelated to the bridge: toolbox drift and the missing `@bacons/apple-targets`).

Release gates (not build gates; none is done):

1. **Toolbox 0.22.0 release** by tag `expo-wallet-toolbox-v0.22.0` (CI publishes raw source). Run the package jest WITHOUT `--forceExit` immediately before tagging (the 0.13.0 timeout lesson). `TB/CHANGELOG.md` Unreleased holds the seams; rename it to 0.22.0 and bump `package.json` at tagging. The host then pins `@bsv/expo-wallet-toolbox ^0.22.0` and the kit dependency line is added to its `package.json` (Task 23 left it out).
2. **Play Console**: `specialUse` foreground-service declaration (property subtype text from the manifest) and the data-safety answer.
3. **R8 release build verification** as in the R8 memory note: main-checkout gradle release build, check `mapping.txt` and `dexdump` that `LaunchTrampolineActivity`, `BridgeService` and `BsvAndroidBridgeModule` survive with their members, then run the Pixel_9 pass again on the release APK (the debug-only `allowLocalhostHttp` path is then unavailable: use the https origin).
4. **Independent review** before any BRC-185 conformance claim (`CONFORMANCE.md` claims none).
5. Real-phone pass of every row of spec section 10's end-to-end list, S1b (Chrome permission dialog, https page to loopback, mixed content), Incognito, OEM background start, and the https/ngrok path in a release build with R8.
6. Owner decisions carried over: F2 (the `getVersion` base string vs the conformance card), whether milestone 2 (overlay, spike S4 first) is still wanted (spec 14, open question 1).

## Whole-branch review (after Task 25)

Five finder dimensions, each finding checked by two independent skeptics; six confirmed and fixed: re-arm when a stop overtakes an in-flight arm (f57bf4f6), ignore the echo of our own `stopServer` (5d5ac1e2), API 26 guards for minSdk 24 in `ensureService` and `AttentionPoster` (e44163a0, compiled with `:bsv-expo-android-wallet-bridge:compileDebugKotlin` in HW; not run on an API 24/25 device), F1 (ddbba5e1), the connected wallet no longer reported as rejected by `discover()` (cd36eedb, the Task 22 UNAUTHENTICATED log), e2e case 4 asserts the follow-up is not granted (6ffe1ebd, not re-run on the emulator). Refuted: Retry-After CORS exposure (spec 6.6.1 exposes no other header), e2e case 11 pass without rejection.

## Spike S4 (M2 gate): second React root

Run on the Pixel_9 emulator only (android-36, Chrome 155.0.8059.79, host debug dev-client build from `HW` commit 810480b plus scratch, Metro on 8082, demo on `http://localhost:3001`). All code is scratch and is **not** committed: the full diff (kit and host) is `spikes/s4-hello-sheet.diff`. Evidence (screenshots, uiautomator dumps, `dumpsys`, logcat excerpts, build logs) is in `/private/tmp/claude-502/-Users-personal-git-bsv-wallet/e540ec5f-8075-4a75-9892-147b56e4116a/scratchpad/s4/` (not in the repo; the names below are relative to it).

**Verdict: conditional PASS.** The second root works, and no criterion that was observed blocks M2 as an architecture. But the spec's plain default delegate **fails criterion (b)** (`onHostDestroy` fires for a live `MainActivity`). A one-method delegate guard fixes it on the emulator (variant below). M2 may proceed only with that guard, and the real-phone gate is still open. Without the guard the spec's design must be counted as failed.

### Setup

- Kit scratch: non-exported `BridgeSheetActivity` (`ReactActivity`, component `BsvBridgeSheet`, `DefaultReactActivityDelegate` on `(application as ReactApplication).reactHost`, `launchMode=singleTask`, `taskAffinity=${applicationId}.bridge`, `excludeFromRecents`, theme `Theme.BsvBridgeSheet` with parent `Theme.AppCompat.DayNight.NoActionBar`, translucent); `LaunchTrampolineActivity` starts it instead of `MainActivity` when a minimal `S4` tracker says `MainActivity` is alive (`onActivityCreated` and `onActivityResumed` of the main class, cleared in `onActivityDestroyed`, caught up from `appContext.currentActivity` in the module `OnCreate`); `S4.kt` logs (tag `BsvS4`) every Activity callback, the delegate's `onResume/onPause/onDestroy` of the sheet, and the React host events through a `ReactContext` `LifecycleEventListener` (`onHostResume/Pause/Destroy`, with `currentActivity` and `mainAlive`). The library needed `compileOnly 'com.facebook.react:react-android'` in `android/build.gradle` (it had no React classes on its classpath; no other dependency was needed, the AppCompat parent theme resolved).
- Host scratch: `AppRegistry.registerComponent('BsvBridgeSheet', ...)` in `index.js` before the router entry, rendering `bridge-sheet-root` (a scrim of 90 percent, toggleable) and a card with `hello`, `useColorScheme`, the toolbox `useTheme()` default and `WalletContext` default; `console.log` prefixed `S4` for `AppState`, `Linking` url events, `redirectSystemPath`; the same in the `AppState` listeners of `useRequests`, `NotifyPrompt` and `useVaultKeys`. Plus the usual scratch (`app.config.js` without the Safari plugin, the `metro.config.js` worktree regex, the kit dependency line) and a rebuilt APK. The wallet was an existing unlocked test wallet on Home.
- Two toggles (system properties, read by `getprop`) for the variants: `debug.bsvs4.skipdestroy` and `debug.bsvs4.back`.
- Driver: `s4.mjs` (CDP through the e2e helpers: trusted click on `#open`, a 500 ms page ticker, a 25 s held `fetch` to a local server on `adb reverse` 3002), `adb input`, `uiautomator`.
- The iOS demo on port 3000 and its ngrok tunnel were not touched.

### Criteria

| ID  | Criterion                                                            | Result                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | Warm: `hello` over Chrome, Chrome visible and running behind         | **PASS**                                                                       | `a-sheet.png`, `a-sheet-scrim30.png` (scrim toggled to 30 percent: Chrome legible behind the sheet), `a-dumpsys.txt`, `a-warm-open.log`. Tap Open wallet in Chrome: trampoline `warm=true`, sheet Task `A=...wallet.bridge` translucent above the Chrome task, Chrome shown behind (dimmed by the 90 percent scrim). Chrome's activity is `state=PAUSED`, not `STOPPED`, its task `visible=true`. The page ticker had no gap above 504 ms for the whole period (sheet up, closed, wallet fronted) and a `fetch` held for 25 s completed on time (`done after 25003`, 25 064 ms in the page) with `visibilityState` `visible`. |
| b   | `onHostDestroy` never fires for a live `MainActivity`                | **FAIL (plain delegate), PASS (guard variant)**                                | `b1-finish.log`, `b2-main-resume.log`, `d4-back-variant.log`, `d5-skipdestroy.log`, `d6-variant-cycles.log`, `f-over-main.log`. See "What failed" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| c   | `AppState` follows spec 7.4                                          | **PASS with a caveat**                                                         | all phase logs. Sheet over Chrome (Main stopped): `background` to `active` at the sheet's resume, back to `background` at its pause. Home while the sheet is up: `background`. Wallet fronted: `active`. Cold start: `active`. Caveat: on an Activity handover `AppState` is **not** continuously `active`: Main to sheet gave `background` then `active` 51 ms apart (Main `onPause` before the sheet `onResume`), and sheet to Main the same (`f-over-main.log`). Every listener sees a `background` blip. Spec 7.4's "`active` while either is resumed" holds in steady state only.                                        |
| d   | The host's `AppState` listeners behave                               | **PASS for `useRequests` and `NotifyPrompt`, NOT VERIFIED for `useVaultKeys`** | `useRequests` logged exactly one line per `AppState` change (4 changes, 4 lines in `f-over-main.log`; 5 and 5 in `d6-variant-cycles.log`), effect mounted once per process start. `NotifyPrompt` the same where it was mounted. No error, no crash (`FATAL`/`AssertionError` grep over the whole logcat is empty). The `useVaultKeys` listener is only mounted while a key removal is in the broadcast state, which could not be arranged: never exercised.                                                                                                                                                                   |
| e   | Cold start without `MainActivity`: the sheet never starts            | **PASS**                                                                       | `e-cold.log`, `e-cold.png`. `am force-stop`, then Open wallet from Chrome: `trampoline: seq=1 warm=false`, no `BridgeSheetActivity` line, `MainActivity` came forward in its own task. The tracker is created after `MainActivity.onCreate` on a cold start (module `OnCreate`, about 1.8 s later); the `currentActivity` catch-up worked in this dev-client build (`catch-up: MainActivity ... was already alive`), and `onActivityResumed` covers a miss.                                                                                                                                                                   |
| f   | The router never receives a URI                                      | **PASS**                                                                       | no `Linking` `url` event and no `redirectSystemPath` call carried the bridge scheme in any run (`S4 Linking initial url: null`, `S4 redirectSystemPath: bsv-wallet:///` for the ordinary launch, `hasK=false` everywhere); the sheet's `onNewIntent` saw `data=null`; the system's own `ActivityTaskManager START` lines print `dat=bsv-wallet-bridge://launch/...` (redacted, no `k`).                                                                                                                                                                                                                                       |
| g   | Locked then unlocked while the sheet is open                         | **N/A**                                                                        | the host has no app lock (no auto-lock, no lock screen: grep of `src`, `app` and the toolbox core finds none; spec 7.4 says the same). The only locks are the vault's YubiKey states, not arrangeable here. Re-state it when the host gains a lock.                                                                                                                                                                                                                                                                                                                                                                           |
| h   | The root can render a context-free toolbox component, light and dark | **PASS (informative)**                                                         | `a-sheet.png` (light), `h-dark.png` (dark), `h-dark-ui.xml`. `useColorScheme` and plain `Text` follow the system in both. The toolbox `useTheme()` without a provider returns a fixed light palette (`textPrimary=#15181E`, `background=#FFFFFF`): dark text on a dark card, unreadable in the dark screenshot. `useContext(WalletContext)` returns the default (`managers=0`). As expected: the relay of M2 must supply both the theme and the wallet contexts.                                                                                                                                                              |

Not run (listed in spec S4, outside the task's criteria): keyboard in the sheet, the 12 locales, the context relay itself, the double-prompt owner gate.

### What failed, what it did, and the variant (criterion b)

`ReactHostImpl.onHostDestroy(activity)` does nothing unless `activity` is the host's **current** activity; `onHostResume(activity)` sets it. When the sheet opens over Chrome, the sheet is current. When it finishes, Android resumes **Chrome**, not `MainActivity`, so the sheet is still current at its `onDestroy` and the delegate's `onHostDestroy` runs the host's destroy path with `MainActivity` alive (stopped, in its own task): `RN host.onHostDestroy currentActivity=BridgeSheetActivity ... mainAlive=true` (`b1-finish.log`, repeated in `d4-back-variant.log`). The same happens on every finish with the wallet in the background, whatever the finish trigger. It does **not** happen when the sheet is opened over a resumed `MainActivity` (`f-over-main.log`: `MainActivity` resumes before the sheet is destroyed, so the sheet is no longer current and the call is a no-op), nor on Home while the sheet is up (the sheet is only stopped).

Observed consequence on the emulator: none visible. Bringing the wallet forward afterwards gave `onHostResume`, `AppState` `active`, the Home screen, and navigation to Settings worked (`b2-main-home.png`, `b2-main-settings.png`, `d6-main-after-variant.png`); no crash. What was **not** audited: every native module that tears down in its `onHostDestroy` listener received the event while `MainActivity` stayed alive; whether any of them (NetInfo, notifications, BLE or NFC modules, reanimated) fails to come back was not checked. Treat the plain delegate as unsafe.

**Variant (guard).** The sheet's delegate overrides `onDestroy`: if `MainActivity` is alive, call only `reactDelegate.unloadApp()` (stops the sheet's surface) and skip `reactHost.onHostDestroy`; otherwise call `super`. Measured over three sheet lifecycles (Back variant): zero `onHostDestroy`; `Hello unmounted` still fires (the surface is stopped); the next sheet mounts a fresh root; `MainActivity` resumes normally (`d5-skipdestroy.log`, `d6-variant-cycles.log`). Risk the planner must handle: the host keeps `currentActivity` pointing at the destroyed sheet until `MainActivity` next resumes (a held reference to a finished Activity; harmless in this run, but check for a leak and for modules that read `currentActivity` while Chrome is in front, for example the permission and notification modules). If `MainActivity` is dead (not alive), the call must go through so the host is not left without a destroy.

### Other findings that would shape M2

1. **Hardware Back is eaten by the main tree's JS.** The sheet shares the JS runtime, and `ReactActivity.onBackPressed` goes to JS `hardwareBackPress`. With `MainActivity` on Home, Back finished the sheet. With `MainActivity` left on Settings, Back in the sheet reached `onBackPressed` natively and the sheet did **not** finish (router handlers of the main tree consumed it; it may also have navigated the main tree: unverified). `BridgeSheetActivity` must override `onBackPressed` to `finish()` without calling `super` or JS (variant `debug.bsvs4.back`: finished every time, `d4-back-variant.log`). Spec 7.4 already says Back leaves requests parked and finishes the Activity; it has to be native.
2. **A second Open wallet tap while the sheet is up did not launch anything** (no trampoline `START` in `ActivityTaskManager`; the page logged a new epoch). A second launch from `adb` (not a Chrome tap) reached `sheet.onNewIntent` and re-resumed the same root (`root#2` stayed; `c-home-return.log`). So `onNewIntent` is real, but a page cannot trigger it while the sheet covers Chrome (Chrome withholds the intent while paused, probably; the cause was not isolated).
3. **Home leaves the sheet task alive.** Home with the sheet up only stops it; bringing the wallet forward leaves the sheet task stopped in the background (`c-home-return.log`), and the next launch revives it with its old root. M2 needs a rule (finish the sheet on `onStop` when the user left, or reset its content on `onNewIntent`).
4. **Handover blips** (criterion c): the `background` to `active` blip on each Activity handover reaches every `AppState` listener; any listener that does work on `background` (none in the host today) would run.
5. **`FLAG_SECURE`, `setHideOverlayWindows` and the touch filters were not applied** in the spike (so `screencap` works). With `FLAG_SECURE` set, screenshots of the sheet and the Chrome behind it will be black: M2's e2e must read the UI by `uiautomator` and test ids (`bridge-sheet-root` and `s4-*` ids resolved as `resource-id`).
6. No oddity from the dev menu or LogBox appeared on the sheet; no splash or navigation-bar interference from Expo modules (the sheet uses the plain delegate, so none of the `MainActivity` Expo listeners run for it); translucent window did not stop Chrome. Debug dev-client build only: **release build with R8 not verified**. The `S4`/`unloadApp` guard uses `ReactActivityDelegate.getReactDelegate()` (protected) and `ReactDelegate.unloadApp()`, which R8 and RN upgrades can move.
7. `sheet.onNewIntent seq=-1` in the log is a scratch artifact (`getIntExtra` on what is probably a `Long` extra); the real sheet reads the sequence number with the matching type.
8. The 90 percent scrim (spec value) leaves Chrome only faintly visible (`a-sheet.png`); at 30 percent it is legible (`a-sheet-scrim30.png`). "Chrome visible" is evidenced by both screenshots, the dump (visible task, `PAUSED`) and the ticker.

### What still needs a real phone (owner device gate)

Everything above ran on one emulator, on a dev-client build. On a real phone: the same sequence with an OEM Chrome and a release (R8) build; the `onHostDestroy` guard under real memory pressure (process death with the sheet up); Back with the system gesture navigation (predictive back); the 700 ms tap protection, `FLAG_SECURE`, `setHideOverlayWindows` and obscured-touch filtering (S3, with an overlay test app); the keyboard in the sheet; the second-tap behaviour of Chrome; notification interplay (S6).

### Implications for the M2 plan

1. Gate result: M2 is **viable but not as the spec wrote it**: change spec 7.4's "default delegate, no Expo wrapper unless S4 shows a need" to "default delegate subclass with the destroy guard and a native Back" (both measured). Keep S3, S6 and the real-phone gate as written.
2. First M2 tasks: the guarded delegate and native Back, with a Kotlin or instrumented test of the guard's truth table (Main alive or dead, sheet current or not); then `LifecycleTracker` registered in the module `OnCreate` with the `currentActivity` catch-up **plus** `onActivityResumed` (measured necessary as a second line of defence); the audit of module teardown listed under "what was not audited".
3. The relay (`ContextRelayPublisher/Subscriber`) must cover at least the theme (the toolbox default is light-only) and `WalletContext`; criterion (h) shows the defaults are what a bare root gets.
4. The M1 controller treats the sheet as "wallet in front" (`AppState` `active`) while the main tree's `PermissionSheet` sits in a stopped `MainActivity`: a connect or prompt that arrives with the sheet up parks with nothing visible. This is exactly the `sheetOwner` gap that M2's gate and relay close; nothing in S4 contradicts it.
5. Decide the Home and singleTask behaviour (finding 3) and the handover blip (finding 4) in the M2 design rather than discovering them in the e2e.
6. The commit trailer follows the task text (`Claude Opus 5.5`), not the harness attribution reminder (`Claude Sonnet 5.5`) that Task 24 followed.
