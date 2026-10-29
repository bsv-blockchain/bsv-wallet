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
