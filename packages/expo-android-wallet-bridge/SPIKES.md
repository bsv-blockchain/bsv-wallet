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
