# Spike outcomes

Later tasks read this file for which fallback is in effect.

## Baseline

Recorded 2026-10-28.

| Check | Result |
| --- | --- |
| WT `npx tsc --noEmit -p .` | 0 errors (`TSC` must stay at 0) |
| WT `npx jest --ci packages/expo-wallet-toolbox/__tests__/bridge` | 22 suites, 475 tests passed |
| HOST `npx tsc --noEmit` | 3 errors, all pre-existing: `purchase` not in the handle-change type (`__tests__/handleChange.test.ts` 36 and 54, `src/handles/claim.ts` 119) |
| HOST `npx jest --ci` | 25 suites, 178 passed, 2 failed (`__tests__/handleChange.test.ts`: "sends the purchase with the claim only", "takes the old handle back when the new one is refused"), same cause as the tsc errors |

### Workspace setup

- WT `node_modules`: directory of per-entry symlinks to `/Users/personal/git/bsv-wallet/node_modules` (including `.bin`), with `@bsv/` a real directory of per-entry symlinks whose `expo-wallet-toolbox` points at `../../packages/expo-wallet-toolbox`. `packages/*/node_modules` added to the `tsconfig.json` `exclude`. The kit's own `esbuild` and `@bacons/apple-targets` are installed in `PKG/node_modules` only (`npm install --legacy-peer-deps`, lockfile committed). `@bsv/expo-safari-wallet-bridge` is not linked into WT `node_modules/@bsv` yet (the package has no source; add the `../../packages/expo-safari-wallet-bridge` entry when Task 11 first imports it).
- HOST worktree `.claude/worktrees/safari-bridge`: symlinks, not `npm ci`. Per-entry symlinks to `/Users/personal/git/ts/bitcoin-sv-wallet/node_modules`, `@bsv/` a real directory of per-entry symlinks, and `react-native-engine-native`, `react-native-secp-native` and `react-native-yubikey` pointing at the worktree's own `../packages/...`. Native builds work with this layout (full `pod install` and `xcodebuild` succeeded).
- Two gitignored build artifacts had to be copied from the main HOST checkout, because the podspecs' `sync-xcframework.sh` needs a `native-engine-ffi` tree that does not exist: `cp -R <main>/packages/react-native-engine-native/ios/. <HOST>/packages/react-native-engine-native/ios/` and the same for `react-native-secp-native` (`EngineNative.xcframework`, `SecpNative.xcframework`, `uniffi/`).
- `scripts/link-kit.sh <host-dir>` deviates from the plan text: it packs the toolbox and the kit with the `0.0.0-dev.<epoch>` suffix (version edited in a temp copy) and unpacks the tarballs straight into `<host>/node_modules/@bsv/<name>` instead of `npm install --no-save`. With a symlinked `node_modules`, npm would write through the links into the other checkout. Tested against a scratch host.

## S1 (build plumbing)

Result: the defaults `S1.root`, `S1.kc` and `S1.pod` all pass; `S1.targets`, `S1.kcfile`, `S1.fileref` and `S1.bespoke` were not needed. No fallback branch is in effect. `S1.pod` passes by a different route than the plan implies (see below); later tasks must use that route.

Experiment: HOST app.config.js plus a scratch plugin (`PKG/.scratch/withBridgeSpike.js`, uncommitted) that writes a `safari` target into the git-ignored `HOST/.expo/safari-bridge/SafariBridge/` and then calls `@bacons/apple-targets` with `{ root: '.expo/safari-bridge', appleTeamId: 'SV8SWTHA2H' }`. The stub pod (`PKG/swift/BsvBridgeQueue`) was linked from both the app and the target. HOST edits were reverted afterwards (`git status` clean, `targets/` never created).

| Criterion | Result | Evidence |
| --- | --- | --- |
| 1. Target named for the extension, bundle id `org.bsvblockchain.wallet.safari`, embedded in the app, HOST `targets/` untouched | pass | `xcodebuild` output has `BitcoinSVWallet.app/PlugIns/SafariBridge.appex`; its `CFBundleIdentifier` is `org.bsvblockchain.wallet.safari`; `NSExtensionPointIdentifier` `com.apple.Safari.web-extension`; `PBXNativeTarget "SafariBridge"` has an "Embed Foundation Extensions" build file in the app target; `ls HOST/targets` does not exist |
| 2. Target `.entitlements` has `keychain-access-groups` and the App Group | pass | `ios/.targets/SafariBridge/generated.entitlements` (generated under the gitignored `ios/`, `CODE_SIGN_ENTITLEMENTS = .targets/SafariBridge/generated.entitlements`) contains `com.apple.security.application-groups: group.org.bsvblockchain.wallet` and `keychain-access-groups: $(AppIdentifierPrefix)org.bsvblockchain.wallet.bridge` |
| 3. Build succeeds under static frameworks; stub symbol in the appex binary | pass | `** BUILD SUCCEEDED **` (iPhone 18 Pro, `Debug-iphonesimulator`); `nm SafariBridge.appex/SafariBridge.debug.dylib` shows `T _$s14BsvBridgeQueue03bsvbC4StubSiyF`. The pod is built once as `BsvBridgeQueue.framework`-style static pod and linked into `Pods_BitcoinSVWallet.framework` and `Pods_SafariBridge.framework`; the app binary has no stub symbol only because nothing in the app references it yet (dead strip), not because the pod is unlinked |
| 4. `expo config --json` shows the appExtensions entry | pass | `extra.eas.build.experimental.ios.appExtensions = [{ bundleIdentifier: 'org.bsvblockchain.wallet.safari', targetName: 'SafariBridge', entitlements: { application-groups, keychain-access-groups } }]` |

### Facts later tasks must use (Task 11, 12, 20)

- `root` works: apple-targets globs `${root}/*/expo-target.config.@(json|js)` relative to the project root; the plugin generates the target directory (`expo-target.config.js`, `Info.plist`, Swift sources, `Resources/`) under `<projectRoot>/.expo/safari-bridge/<TargetName>/`. `.expo/` is already gitignored in the host, so no host `targets/` directory and no committed files.
- `require('@bacons/apple-targets')` throws (`expo is not defined`, `ExtensionStorage.js` needs the Expo runtime global). Always load the plugin as `require('@bacons/apple-targets/app.plugin')` (what `app.plugin.js` re-exports).
- apple-targets reads `appleTeamId` from its own option or `config.ios.appleTeamId`; the host config currently has no `ios.appleTeamId`. Task 20 must add `ios.appleTeamId: 'SV8SWTHA2H'` (or pass the option). Without it the plugin only warns and signing fails later.
- The target's `cwd` is computed with `path.resolve(props.directory)` against the process cwd, so prebuild must run from the project root (as `npx expo prebuild` does).
- Pod sharing does NOT use apple-targets' `pods.rb` loader on a custom root: the loader the plugin appends to the Podfile globs the hard-coded `<ios>/../targets/**/pods.rb`, which never sees a custom `root`. The working route is a `withPodfile` mod in our plugin that (a) adds `pod 'BsvBridgeQueue', :path => ...` inside `target '<App>' do` (in Task 11 this comes from the Expo module's podspec dependency instead) and (b) appends a top-level block for the extension target:

  ```ruby
  target 'SafariBridge' do
    use_frameworks! :linkage => podfile_properties['ios.useFrameworks'].to_sym if podfile_properties['ios.useFrameworks']
    pod 'BsvBridgeQueue', :path => '<abs path to PKG/swift/BsvBridgeQueue>'
  end
  ```

  The `use_frameworks!` line is required: without it CocoaPods fails `pod install` with "BitcoinSVWallet (true) and SafariBridge (false) do not both set use_frameworks!". The append must be idempotent (check for `BsvBridgeQueue` before adding).
- Entitlements must be passed as the target config's `entitlements` object (apple-targets writes them to `ios/.targets/<Name>/generated.entitlements`); a hand-written `*.entitlements` in the target dir is ignored when the object is present. Arbitrary keys such as `keychain-access-groups` pass through even though apple-targets' TypeScript type does not list them.
- The generated `Info.plist` for type `safari` sets `NSExtensionPrincipalClass = $(PRODUCT_MODULE_NAME).SafariWebExtensionHandler`; the Swift class must be named that (Task 10/12). Files under `Resources/` are bundled into the appex (`manifest.json`, `bg.js` appeared in the built appex).
- `esbuild` pinned `0.28.2` (published 2026-08-08, older than two weeks) and `@bacons/apple-targets` `5.0.0` are both devDependencies as the plan says; but the plugin needs apple-targets at the host's prebuild, so Task 12 must make it a runtime `dependency` of the kit (or the host adds it). Left for Task 12; not changed here.
- Existing HOST comment in `app.config.js` says never to add `keychain-access-groups` / `application-groups` to the app, and `__tests__/isolation.test.js` pins it. Task 20 must update both (the kit needs them by design, spec 6.2).

## S6 (shared sealing key and keychain upgrade)

Result: the default `S6.group` passes (explicit bridge keychain group, host group listed first). `S6.appgroup` was not needed. Run 2026-10-28 on the iPhone 18 Pro Simulator (iOS 27.0), HOST worktree `safari-bridge`, Debug configuration.

### Method (differs from the plan text in two places)

- Baseline: HOST built without the kit (`prebuild --clean`, `pod install`, `xcodebuild`) and installed. The Simulator keychain outlives an uninstall and the app rebuilds its wallet from it, so the baseline was reached by uninstall, install, launch (no onboarding screen appeared; the wallet came up on first launch). It is an upgrade test over a wallet whose keychain items already existed, which is what the criterion needs. Identity key `03cdf55ea3b67109430aadd35d78ed438a8ace846148c4c0aec2e9f994d09f1408`, wallet DB `wallet-d09f1408-mainnet-1793197266.db`, five secure-store/Vault-state items in agrp `SV8SWTHA2H.org.bsvblockchain.wallet` (acct hex prefixes `17E385DF`, `4BD2488A`, `6991606`, `9F148F73`, `A4FE4C89`, data lengths 2776, 2130, 2386, 2223, 2073).
- The Vault (mainnet only, needs a YubiKey) cannot be exercised on the Simulator. It stays a device gate (Task 22).
- Upgrade: the same app rebuilt with the scratch plugin (`.scratch/withBridgeS6.js`: Safari target, app entitlements `keychain-access-groups = [$(AppIdentifierPrefix)org.bsvblockchain.wallet, ...wallet.bridge]` plus `group.org.bsvblockchain.wallet`, `ios.appleTeamId`), a throwaway Expo module `spike-module` (symlinked into HOST `modules/`), and the throwaway `spikeKeyWrite` / `spikeKeyHash` in `Stub.swift`. `simctl install` over the existing install (no uninstall), launched through the dev-client URL. HOST `app.config.js`, `app/_layout.tsx`, `metro.config.js` edits and the `modules/` symlink were reverted afterwards (`git status` clean); `Stub.swift` restored.

### Criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| 1. Same wallet, same identity key, no re-onboarding | pass | After install-over the app opened on Home (dragon avatar, 0.00 balance, no Welcome); `users.identityKey` is unchanged; `Documents/SQLite` still holds only `wallet-d09f1408-mainnet-1793197266.db` |
| 2. New secure-store item in host group; old items unchanged | pass | `keychain-2-debug.db`: the five original rows keep agrp `SV8SWTHA2H.org.bsvblockchain.wallet`, identical acct hex and data length. After the upgrade there are two new rows in that same agrp (the `expo-secure-store` probe `bsv-bridge-s6-ss` and the `bsv-bridge-s6-probe` item that `spikePrefix()` writes with no explicit group, which also corroborates that the default group is the host group) |
| 3. Appex reads what the app wrote under the bridge group | pass | App (module, `NSLog`) wrote a 32-byte generic password, `AfterFirstUnlockThisDeviceOnly`, not synchronised, explicit group `SV8SWTHA2H.org.bsvblockchain.wallet.bridge`; SHA-256 `8cfdc01181d1ad7909d2fc7cc85f0da03c21dfd2ddc9a1de7f2df66f7d467c5c`. The Safari popup of the appex (native message, handler calls `spikeKeyHash`) printed `S6 reply: {"hash":"SV8SWTHA2H.org.bsvblockchain.wallet.bridge\|8cfdc011...467c5c"}`, the same hash. The item's agrp ends `.bridge`. Screenshot `docs/superpowers/evidence/ios-kit/01-s6-popup.png` |

Keychain rows after the run, by group: host group 7 rows (5 original + 2 new), bridge group 2 rows (the sealing-key stand-in `bsv-bridge-s6-spike` and a second `bsv-bridge-s6-probe`). The second probe row is the extension's own `spikePrefix()` lookup, which adds an item with no explicit group; it lands in the appex's first (and only) group, `...bridge`. It is a spike artefact, not a leak: the real appex never writes keys (spec 6.2), so Task 10 must not use the add-then-read prefix trick (read the team prefix from the Info.plist `BSVBridgeKeychainGroup` value instead, which the plugin writes already resolved).

Simulator caveats: the Simulator does not enforce access groups faithfully, so group isolation, the real signing check and the upgrade over real Vault items remain device gates (Task 22).

### Facts later tasks must use

- The live Simulator keychain database is `~/Library/Developer/CoreSimulator/Devices/<udid>/data/Library/Keychains/keychain-2-debug.db` (table `genp`, columns `agrp`, `svce`, `acct`, `data`; `svce` is hashed on this iOS). `keychain-2.db`, which the plan names, is a 0-byte file on iOS 27.0 and gives `no such table`.
- Metro cannot start from a HOST that lives under `.claude/worktrees/`: the host `metro.config.js` blocks the regex `/\/\.claude\/worktrees\/.*/`, which matches the HOST project root itself and makes every module unresolvable (`Unable to resolve module ./index`). The experiment used a working-tree-only change (not committed) that anchors the pattern to `<projectRoot>/.claude/worktrees` and `<projectRoot>/.worktrees`. Tasks 13, 20, 21 and 22 need the same edit while HOST is a worktree; revert it before committing in HOST (or commit the anchored form deliberately).
- Dev-client launch: the app's own scheme `bsv-wallet://` opens the app but does not point it at Metro; use `xcrun simctl openurl <udid> "exp+bsv-wallet://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082"` (Metro on 8082) once the app is running. The first `openurl` after an install-over can time out (code 60); start the app by tapping it, then retry.
- Enabling the extension in the Simulator: Settings > Apps > Safari > Extensions rendered blank; use Safari's page menu > Manage Extensions (scroll the menu with `touch_path`, a `swipe` taps rows) > toggle the extension, then the page menu entry (first use asks for site access) opens the popup.
- apple-targets entitlements and `keychain-access-groups` pass-through as in S1; the generated app entitlements put the host group first and `.bridge` second, matching the spec.
- A full Debug build of HOST from a clean `ios/` takes about 15 minutes; `prebuild --clean` deletes `ios/build` (DerivedData lives there), so avoid `--clean` unless needed.

## Task 13 walking skeleton (HOST build) and spikes S2, S3, S4, S5, S7

Run 2026-10-28 on the iPhone 18 Pro Simulator (iOS 27.0, Safari 27.0), HOST worktree `safari-bridge`, Debug, development profile, extension JS from the spike-probe commit (reverted afterwards; the probe code, an `echo` op in the Swift handler and `demo/serve.mjs` with a `/log` endpoint, is in git history only). No fallback branch is in effect: `S1.root`, `S1.kc`, `S1.pod`, `S6.group` held, and S3 passed with the MAIN-world entry (the `web_accessible_resources` fallback was not needed).

### HBUILD and the walking skeleton

- `prebuild --clean`, `pod install` and a full Debug `xcodebuild` succeed (about 15 minutes, `BUILD SUCCEEDED`). This is the first real compile of `BsvBridgeModule.swift` against ExpoModulesCore: it compiles, autolinks, and `init` runs (`BSVBRIDGE init {"scheme":"org.bsvblockchain.wallet","bootId":...}` in Metro) and creates the sealing key in the bridge group.
- Post-build gate (Info.plist expansion, which Task 12 deferred to here): both `BitcoinSVWallet.app/Info.plist` and `PlugIns/SafariBridge.appex/Info.plist` carry `BSVBridgeKeychainGroup = SV8SWTHA2H.org.bsvblockchain.wallet.bridge` (`$(AppIdentifierPrefix)` is expanded), `BSVBridgeAppGroup = group.org.bsvblockchain.wallet`, `BSVBridgeScheme = org.bsvblockchain.wallet`; the app has the second URL type `org.bsvblockchain.wallet.bridge`; the appex is embedded (`org.bsvblockchain.wallet.safari`, point `com.apple.Safari.web-extension`); `nm` on the appex shows `handleBridgeMessage`. A `native sign` and the `echo` op round-trip against the real keychain key, so the group works end to end.
- The Simulator offers the extension in Safari's page menu as soon as the app is installed (no Settings detour). First use asks for site access: "Allow for One Day" or "Always Allow..." (then "Always Allow on This Website"). Granting access while the page is open injects the content scripts into that page at once (no reload) and restarts the background; a reload is only needed for the MAIN-world global to precede page scripts.
- The popup shows "Bitcoin SV Wallet is on" (`docs/superpowers/evidence/ios-kit/02-ping.png`).

### Workspace and tooling facts (new in this task)

- HOST `node_modules` needs per-entry symlinks to the kit's own `PKG/node_modules` for the two plugin dependencies, because `link-kit.sh` unpacks only the tarball: `node_modules/@bacons/apple-targets`, `node_modules/esbuild` and `node_modules/@esbuild/darwin-arm64` (apple-targets' own dependencies resolve from its real path in `PKG/node_modules`). Never `npm install` in HOST (it would write through the symlinks).
- `scripts/link-kit.sh` now versions the dev packs `0.0.<epoch>`, not `0.0.0-dev.<epoch>`: CocoaPods does not resolve a prerelease podspec version, so `pod install` failed with "could not find compatible versions for pod BsvBridge".
- HOST working-tree edits left in place (never to be committed; Task 20 makes the real change): `package.json` (kit `0.0.0` and `@bacons/apple-targets` `5.0.0`), `app.config.js` (plugin entry with `appleTeamId: 'SV8SWTHA2H'`, `extensionName: 'Bitcoin SV Wallet'`, `profile: 'development'`), `metro.config.js` (worktree block regex anchored to `<projectRoot>/.(claude/)?worktrees`, needed while HOST is a worktree). The spike `init` call in `app/_layout.tsx` was reverted: until Task 18 lands nothing in the app calls the kit, so the sealing key is absent and every native op answers `KEY_MISSING`.
- Several simulators are booted at once on this machine (iPhone 17, iPad Pro 13, iPhone 18 Pro). `xcrun simctl ... booted` and the Simulator control tool without `device` pick an arbitrary one: always pass the UDID. (One `simctl install booted` of this build landed on the iPhone 17 before this was noticed; the app there was replaced by the same build.)
- Iterating extension JS without a full rebuild: build with `node extension/build.mjs <dir> development`, copy the files over the ones inside `ios/build/.../BitcoinSVWallet.app/PlugIns/SafariBridge.appex/`, `simctl terminate` Safari and `simctl install` the `.app` again. Keychain, App Group and the granted site access survive. Each `simctl openurl` opens a new Safari tab, and old tabs keep running their timers, so tag probe pages with an id.
- Safari's tab switcher "Private" first shows a Locked Private Browsing prompt ("Not Now" declines it); screenshots from the control tool lag one action behind, take a second one.

### S2 (native-messaging payload and latency)

Result: pass, nothing limits the size on the Simulator. `echo` of raw sizes 1 KiB, 16, 32, 48, 64, 96, 128, 256, 512 KiB, 1, 2 and 5 MiB (base64 on the wire, 4/3 larger) all returned the identical string, 10 of 10 runs each; no callback failed to fire and nothing timed out. Latency (warm, per call): 6 to 8 ms up to 128 KiB, 12 ms at 256 KiB, 17 ms at 512 KiB, 22 ms at 1 MiB, 34 ms at 2 MiB, 70 ms at 5 MiB (about 9 MB/s, almost all of it JSON and base64 handling).

Decision: `STAGE_CHUNK_BYTES` stays at the 48 KiB default (the plan caps it there; the Simulator found no smaller reliable limit), and so does the Swift `defaultMaxPartBytes` for `results` parts. The Simulator does not model a device's memory pressure on the appex, so the size the real channel tolerates is a device gate (Task 22 repeats the 48 KiB and 1 MiB rows on the iPhone).

Cold appex: the first native call after the extension (re)started took 1.9 s (the first `echo`), and `sign` right after Safari was killed and relaunched took 1.66, 1.76, 1.76, 1.79 and 1.95 s over 5 runs (the appex process launch plus Keychain read; the background wake adds another 0 to 1.8 s before the call is even sent, so the page sees 2.3 to 3.7 s). Warm `sign` is 14 ms. This is over the 1 s budget, so, per the spec, a `describe` that times out answers `CONFIGURATION_ERROR` and Task 14 must not shorten `NATIVE_TIMEOUT_MS` (5000 ms covers the cold start with margin; the 3 attempts stay).

### S3 (MAIN-world entry at `document_start`)

Result: pass on iOS 27.0. The second content entry with `"world": "MAIN"` and `run_at: document_start` defines its global before the page's first inline script (`readyState` `loading`, 15 ms after navigation start), and a page served with `Content-Security-Policy: script-src 'self'` (external script only) sees the global too (`04-s3-csp.png`). So the primary design stands; the `web_accessible_resources` fallback is not built. Late grant: access granted while the page was open injected the isolated-world scripts into that page at once; after a reload the MAIN global precedes page scripts. iOS 18.6: the runtime is installed but has only iPad simulators (shut down); not run, so the 18.6 behaviour of `"world": "MAIN"` is unverified (Task 22 or a device).

### S4 (background lifetime)

- `storage.session` survives a background unload and restart: a marker written by one boot was read by two later boots.
- A background with no open port unloads when idle: a boot that last worked at +0 s was replaced by a new one within 20 s on one run, and within 45 s on another. `runtime.sendMessage` from a content script wakes it, and so does `tabs.onRemoved` (closing a tab on a dead background logged a new boot and the removed tab id).
- An open `runtime.connect` port from the content script keeps the background alive: same boot after 45, 120 and 187 s idle. The port never disconnected, so whether a port `onDisconnect` reports an unload is unobserved.
- A native request in flight keeps the background alive for at least 28 s (28 s echo completed on the same boot), but a 40 s request was lost: no reply, no error, and the page's `sendMessage` promise never settled (tested twice). Design consequence for Task 15/16: anything that can exceed about 30 s must be restartable from the page side (poll and resend), never a single awaited native call; the spec's 5 s native timeout is far inside this.

### S5 (handoff)

- `browser.tabs.update(tabId, { url: '<scheme>://bridge?v=1&n=...' })` from the background, with no user gesture, works: Safari shows "Open this page in "Bitcoin SV Wallet"?" with Cancel and Open (`03-s5-handoff-prompt.png`); Open foregrounds the app. The promise resolves in 4 to 34 ms.
- A second `tabs.update` while the prompt is up (tested 1.5 s after the first) resolves without error and leaves a single prompt on screen. So `HANDOFF_COALESCE_MS = 3000` is workable: at most one prompt per burst, and a repeat inside the window is harmless.
- Handoff from a subframe works: the background receives the message with `sender.frameId` non-zero, and `tabs.update(sender.tab.id, ...)` navigates the top tab and raises the prompt (isolated from the top frame). The fallback (top frame sets `location.href`) is not needed.

### S7 (lifecycle, timers, sender facts)

- Leaving Safari for the app (handoff Open) or the home screen: `visibilitychange` (hidden) and `blur` fire in the same millisecond; no `pagehide` or `freeze`. Coming back by the "◀ Safari" chip, by a manual switch, or by relaunching Safari: `focus` and `visibilitychange` (visible) fire, `focus` first and `visibilitychange` last; `pageshow` does not fire (the page was not unloaded). Visibility and focus are therefore the signals to poll on, not `pageshow`.
- Timers while hidden: a 1 s `setInterval` kept running at one tick per 2 s for at least 20 s after the home button (for 19 s it was throttled, never stopped); it returns to 1 s on return. This is Simulator behaviour and a device may suspend sooner, so the poll must stay idempotent and restartable on `visibilitychange`.
- `sender.origin` is `http://localhost:3000` (lowercase; Safari normalises the host before the extension sees it, `LocalHost` was typed). `sender.tab.incognito` was a boolean `false` in all normal tabs (about 20 samples). A private tab was not measured: the extension must be enabled for Private Browsing first (a Safari setting) and typing into the Simulator's private address bar did not navigate reliably. The spec's rule (non-boolean means private) is unaffected.
- `sender.tab.id` is stable per tab; `frameId` is `0` for the top frame and a large integer for subframes.

## Task 9 note: XC scheme name

Adding the `bridge-race-helper` executable target makes SwiftPM's auto scheme `BsvBridgeQueue` lose its test action. `XC` must use `-scheme BsvBridgeQueue-Package` (51 tests on the Simulator; `SW` runs 55 with the 4 macOS-only `RaceTests`).

## Task 11 notes (native module)

- `ios/BsvBridge.podspec` depends on the `BsvBridgeQueue` pod (default `S1.pod`). CocoaPods cannot find that pod from the dependency alone: Task 12's `withPodfile` mod must still add `pod 'BsvBridgeQueue', :path => <PKG>/swift/BsvBridgeQueue` (and the appex target block). The `S1.fileref` delta is a comment in the podspec.
- `BsvBridgeModule.swift` was checked with `swiftc -parse` and the Expo DSL signatures were read from `expo-modules-core` 57.0.23; it could not be type-checked here (the prebuilt ExpoModulesCore is built by a different Swift compiler than the installed one). `BsvBridgeQueue` itself type-checks for the iOS Simulator and `swift test` passes (73). Task 13's `HBUILD` is the real compile.
- Added `Nudge.swift` to the Swift package (`BridgeNudge.name/post/observe`, Darwin notification `<appGroup>.bridge.nudge`) so the extension handler (Task 12 `nudge: () -> Void`) and the module agree on one name.
- Native rejections carry `error.code`: `ERR_NOT_FOUND`, `ERR_KEY_MISSING`, `ERR_RESET`, `ERR_UNAVAILABLE`. The adapter maps only `ERR_NOT_FOUND` to contract return values.
- `FakeNative.restart()` models a restart whose `init` already ran (the contract harness's `restart()` is synchronous); `initSync()` exists for the same reason.

## Task 12 notes (config plugin and extension build)

- Defaults in effect (`S1.root`, `S1.kc`, `S1.pod`, `S6.group`); no fallback code paths were needed. The plugin writes the target into `<projectRoot>/.expo/safari-bridge/SafariBridge/` (host `targets/` is never created; `hostUntouched.test.js` pins it) and calls `@bacons/apple-targets/app.plugin` with `root`.
- `@bacons/apple-targets` and `esbuild` moved from devDependencies to dependencies of the kit, as the S1 notes required (the host's prebuild needs both).
- The extension JS is built synchronously (`esbuild.buildSync`) because apple-targets globs the target directory while the plugin function runs; the bundle exists before `withSafariBridge` returns. Bundle format is IIFE, target `safari16`, unminified.
- apple-targets writes its own `Info.plist` only when none exists, so the plugin ships `extension/templates/Info.plist` (display name, the three `BSVBridge*` keys, `NSExtension` with principal class `$(PRODUCT_MODULE_NAME).SafariWebExtensionHandler`). `$(AppIdentifierPrefix)` in the Info.plist values is expanded by Xcode at build; the real expansion is proven in Task 13's `HBUILD`.
- `expo-target.config.js` is a static template that reads `bridge-target.json` (written by the plugin); this keeps the config file free of string templating.
- The extension deployment target follows an `expo-build-properties` `ios.deploymentTarget` entry, else the `deploymentTarget` plugin option, else 16.0.
- The Podfile mod follows S1: `pod 'BsvBridgeQueue', :path => <relative path from ios/>` in the app target and a top-level `target 'SafariBridge'` block with the matching `use_frameworks!` line; idempotent; a missing `target '<App>' do` anchor throws `SafariBridge: anchor ... not found`.
- `SafariWebExtensionHandler.swift` type-checks against the built `BsvBridgeQueue` module (`swiftc -typecheck -application-extension`, iOS 16 Simulator target). It never creates the sealing key (`createIfMissing: false`).
- The page-world entry is `provider-main.js` (content entry with `"world": "MAIN"`); `content.ts` and `provider-main.ts` are empty placeholders until Task 16.
