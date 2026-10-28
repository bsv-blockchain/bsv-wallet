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

## S2 to S7

Not run yet.
