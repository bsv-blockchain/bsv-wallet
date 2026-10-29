# Browser Bridge Android Loopback Kit, Milestone 2 (Overlay Sheet over Chrome) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add overlay mode to `@bsv/expo-android-wallet-bridge`: when the wallet is warm and unlocked, the launch click raises a translucent `BridgeSheetActivity` over Chrome that shows the existing permission sheets on a second React root of the same React host, and finishes when the user is done.

**Architecture:** M1 (foreground mode) is built and stays the fallback for every cold, locked or unknown state. M2 adds a Kotlin `LifecycleState` (pure) behind a `LifecycleTracker` adapter, a guarded-delegate sheet Activity (S4 findings), a toolbox `ContextRelay` that feeds the second root the first root's contexts, a `sheetOwner()` store that decides which root renders `PermissionSheet`, and attention decisions that read `sheetOwner()` instead of `AppState`. The spikes S3 and S6 run first and can only weaken M2 to the behaviours spec 6.0 allows.

**Tech Stack:** Kotlin (ExpoModulesCore, `react-android` compileOnly), JUnit 4.13.2 (pure JVM), TypeScript, React Native 0.86 / Expo SDK 57, jest, Pixel_9 AVD, adb, uiautomator, puppeteer-core.

**Spec:** `docs/superpowers/specs/2026-10-28-browser-bridge-android-design.md` (revision 4; "spec 7.4" = its section 7.4). Predecessor: `docs/superpowers/plans/2026-10-29-browser-bridge-android-m1.md` (all its Global Constraints, `ENV`, `KT`, `KJ`, `TBJ`, `HBUILD`, `EMU` and conventions apply unchanged; they are not repeated). Evidence of what M1 built and S4 measured: `packages/expo-android-wallet-bridge/SPIKES.md`; scratch code: `packages/expo-android-wallet-bridge/spikes/s4-hello-sheet.diff`.

## Global Constraints

**Repos and names (as M1)**

- `WT` = `/Users/personal/git/bsv-wallet/.claude/worktrees/browser-bridge-android`, branch `feat/browser-bridge-android`. `TB` = `WT/packages/expo-wallet-toolbox`. `PKG` = `WT/packages/expo-android-wallet-bridge`. `HW` = `/Users/personal/git/ts/bitcoin-sv-wallet/.claude/worktrees/android-bridge`, branch `feat/android-wallet-bridge` (host commits only in Task 12; never `main`; never the `safari-bridge` worktree). A task never edits both repos in one commit. Never bare `git stash`.
- Scratch host wiring (Tasks 1 to 3) is working-tree-only in `HW` and is reverted before Task 12 commits. Scratch kit code in Tasks 1 to 3 is applied from the S4 diff into the working tree and is never committed; only `SPIKES.md` is.
- Page origin on the emulator is `http://localhost:3001` (`node PKG/demo/serve.mjs 3001`, `adb reverse tcp:3001 tcp:3001`), not 3000. Metro 8082. Preflight and `EMU start` as in M1; apply the `metro.config.js` worktree hunk (`task22-scratch.diff` in the scratchpad, or `SPIKES.md` Baseline) working-tree-only in `HW`.
- Real-phone items are owner device gates, listed at the end of this plan and in `SPIKES.md`. They are never tasks, and a blocked case is a device gate only under M1's Autonomous completion rule.

**Spec values (verbatim)**

- Sheet Activity `org.bsv.walletbridge.BridgeSheetActivity`: `exported="false"`, `launchMode="singleTask"`, `taskAffinity="${applicationId}.bridge"`, `excludeFromRecents`, `windowSoftInputMode="adjustResize"`, the `configChanges` list of the S4 diff, theme `@style/Theme.BsvBridgeSheet` (parent `Theme.AppCompat.DayNight.NoActionBar`, `windowIsTranslucent`, transparent `windowBackground`, `windowNoTitle`, slide-up animation, `android:enforceNavigationBarContrast=false`, no bar colours). Main component `BsvBridgeSheet`. Library gradle: `compileOnly 'com.facebook.react:react-android'`.
- Trampoline mode: overlay only when host attached and `ready` and the tracker has caught up and `MainActivity` is alive; otherwise `MainActivity` (foreground mode). The sheet gets a sequence number as its only extra (typed `Long`, as `LaunchTrampolineActivity.EXTRA_SEQ` is written); never the URI. Trampoline start throttle stays 3 s.
- Guard: sheet `onDestroy` with `MainActivity` alive calls only `unloadApp()`; not alive (or unknown) calls `super`. Back is native `finish()` (button and `OnBackInvokedCallback`), never `super`, never JS. `onUserLeaveHint` marks left, `onStop` with the mark calls `finish()`; a screen-off `onStop` without the mark does not. A launch (`onNewIntent` with a new sequence number, or a new `onCreate`) resets the root. `savedInstanceState != null` finishes immediately and re-arms nothing.
- Protections: `FLAG_SECURE` on every sheet; `Window.setHideOverlayWindows(true)` on API 31+; drop touches carrying `FLAG_WINDOW_IS_OBSCURED` or `FLAG_WINDOW_IS_PARTIALLY_OBSCURED`; root keeps `filterTouchesWhenObscured`; scrim about 90 percent; Approve tap protection `TAP_PROTECTION_MS = 700` (existing in `PermissionSheet`).
- `sheetOwner()` returns `'main' | 'overlay' | 'none'`: `'overlay'` iff the sheet is resumed and `MainActivity` is not; `'main'` iff `MainActivity` is resumed. Every attention decision and the foreground-mode `returnToBrowser` gate use it, never `AppState`. `AppState` goes `background` then `active` about 50 ms apart at each handover: nothing closes a binding, fails or answers a request, or locks on `background`; anything acting on `background` waits at least 500 ms and re-reads state.
- `RELAYED_CONTEXTS` names the toolbox `ThemeContext` (`core/theme/ThemeContext.tsx`), `WalletContext`, `ExchangeRateContext` and `UserContext` (the four `PermissionSheet.tsx` reads). Test ids: `bridge-sheet-root` (overlay root, new), `bridge-approve`, `bridge-deny`, `bridge-connect-origin` (exist since M1).
- Notifications still name no site; a notification tap targets the sheet Activity with an explicit component and `FLAG_IMMUTABLE` only in overlay mode (warm), otherwise `MainActivity`.
- i18n: any new string is a key in `TB/core/i18n/translations.tsx` in all 12 locales (`en es zh hi fr ar pt bn ru id ja pl`) and `translationParity` passes. M2 plans no new copy; Task 9 step 5 enforces that.
- Commit messages conventional (`feat(android-bridge): ...`), ending with a blank line and the attribution trailer the executing harness specifies. Prettier only on touched files. No `--forceExit`. No emojis.

**Verification commands:** `TSC`, `TBJ`, `KJ`, `KT`, `HJ`, `HTSC`, `HBUILD` exactly as M1 (baselines in `SPIKES.md` Baseline: TSC 0, `HTSC` 15, `HJ` 4 suites / 13 tests failed). New in M2: `KT` also runs the pure files added in Task 4 (add them to `ext.pureFiles` and to `check-pure.sh`). `UIDUMP`: `adb shell uiautomator dump` through `scripts/e2e/adb.mjs` `dumpUi()` (with `FLAG_SECURE` set, screenshots of the sheet are black: read the UI by `bridge-sheet-root` and `bridge-approve`, never by pixels). `SHEETLAUNCH`: with the wallet warm and unlocked, `adb shell am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d 'bsv-wallet-bridge://launch?v=1'` (a shape-valid unprovable record still reaches the trampoline, SPIKES Task 14), which raises the sheet without a page.

## Review Focus

Inputs the spec implies but its M2 test list does not name; each has a test in the named task.

1. Screen turns off while the sheet is up: `onStop` without `onUserLeaveHint` must not finish it, and waking resumes the same root with the same pending prompt (Task 4 `screen-off stop without leave mark does not finish`, Task 13 case O7).
2. OS task restore or process recreation (`savedInstanceState != null`) must finish at once and never start a server or re-arm a launch (Task 6 `restored instance finishes and arms nothing`, Task 4 `shouldFinishOnCreate`).
3. A stale `onNewIntent` (same or older sequence number than the root already shows) must not reset a root that is showing a pending prompt (Task 4 `stale sequence does not reset`).
4. The user switches light or dark while the sheet is up: the sheet re-themes through the relay without remounting (Task 8 `theme change reaches the subscriber without remount`, Task 13 case O9 `adb shell cmd uimode night yes`).
5. `returnToBrowser` after the sheet already finished (a Back race), or with no sheet and no raised main: a no-op, never `ERR_NO_ACTIVITY` to JS (Task 10 `returnToBrowser after Back is a no-op`, Task 4 `finishSheet with no sheet is a no-op`).
6. The two M1 fixes that act on `AppState` transitions (F1 `ddbba5e1`: a pending grant is answered when the app leaves the foreground; the `Sheet` re-apply of its open position on `active`) meet the 50 ms handover blip: neither may answer a prompt or hide a sheet that the user did not touch (Task 10 `handover blip does not execute a pending grant`).

---

### Task 1: Spike S3, translucent task over Chrome and the way back

**Repo:** WT for results; HW scratch. **Assumes:** M1 complete (`SPIKES.md` Task 24 green). Spec 11 S3, 7.4, 12 (second tap). Scratch: `git apply` part 1 of `spikes/s4-hello-sheet.diff` in `WT`, part 2 in `HW`, with the guard variant forced on (S4 property `debug.bsvs4.skipdestroy=1`, `debug.bsvs4.back=1` via `adb shell setprop`), plus `HBUILD` and `adb install -r`. Nothing from this task is committed except `SPIKES.md`.

**Files:**

- Modify: `PKG/SPIKES.md` (new top-level section "M2 spikes", subsection S3, and "M2 baseline": adb state, Chrome version, the SHA of the S4 diff applied)

**Interfaces:**

- Produces: for each S3 row below, `PASS`, `FAIL` or `GATE` (device gate) plus evidence, and one line "S3 verdict": `full overlay` or `launch-click sheet only` (the weaker behaviour of spec 6.0: the sheet is raised only by the launch click and any later prompt is a notification).

- [ ] Step 1: `EMU start`, preflight, record M2 baseline. Apply the scratch (above), build, install, start Metro and the demo on 3001, `createTestWallet()` or `unlockIfNeeded()`.
- [ ] Step 2: pass criteria, each recorded (spec 11 S3): (a) Chrome stays visible, `PAUSED` not `STOPPED`, behind the sheet and its page ticker and a 25 s held `fetch` keep running (`dumpsys activity activities`, the S4 `s4.mjs` ticker recipe); (b) `finish()` of the sheet returns to Chrome, not the home screen (`topResumedActivity` is `com.android.chrome`); (c) foreground-mode `moveTaskToBack` returns to Chrome; (d) both a sheet task and the main task raised (open the wallet, then launch the sheet): which task Android returns to on `finish()`, recorded as an ordered task list; (e) `excludeFromRecents` side effects (recents does not list the sheet task; after Home the sheet task is gone once Task 5's Home rule exists, so here record only what the scratch does); (f) multi-window: Chrome in split screen with the wallet, sheet launched from a click in the split pane, record where the sheet lands; (g) the second Open wallet tap while the sheet is up: reproduce (a real `Input.dispatchMouseEvent` click, no trampoline `START`), then try to isolate the cause with `adb logcat -s ActivityTaskManager`, a `window.open`-free page re-click after `Input.dispatchMouseEvent` focus, and a page `visibilitychange` log; record the cause or "not isolated"; (h) scrim: with the sheet scrim at 90 and at 30 percent, record that Chrome's `visible=true` holds.
- [ ] Step 3: tapjacking row. A tapjacking test needs an overlay from a different package (same-UID overlays do not reliably set `FLAG_WINDOW_IS_OBSCURED`). If a throwaway overlay APK with `SYSTEM_ALERT_WINDOW` can be built from the Android SDK in under an hour with the cached Gradle, build it in `PKG/.scratch/overlay` (never committed), draw a half-transparent window over the sheet's Approve button and record whether a tap reaches `bridge-approve`. Otherwise record `GATE: tapjacking overlay test needs a second package` (owner device gate); the `FLAG_WINDOW_IS_OBSCURED` filter is covered by Task 4's `TouchGuard` test and Task 7's wiring.
- [ ] Step 4: verdict. If (a) or (b) fails, or the sheet cannot be made to leave Chrome in front: verdict `launch-click sheet only` if the sheet still works at the launch click, else stop and report "M2 dropped" with evidence (foreground mode is the product). A failure in (c), (d), (e), (f) or (g) is recorded and shapes README copy, not the verdict. Mark which later task each result can change: (b) and (d) Task 10, (f) Task 13 case list, (g) Task 14 limits copy.
- [ ] Step 5: revert the scratch (`git checkout -- .` per touched file in `WT` and `HW`; `git status --short` must show only `SPIKES.md`). Commit `docs(android-bridge): spike S3, translucent task over Chrome`.

### Task 2: Spike S6, background prompt

**Repo:** WT for results; HW scratch. **Consumes:** Task 1 verdict. Spec 11 S6, 7.4 (background activity starts).

**Files:**

- Modify: `PKG/SPIKES.md` (subsection S6)

**Interfaces:**

- Produces: a verdict line `S6: background sheet works` or `S6: notification only`. **Task 11 (`showSheet`) is rewritten by this verdict**: `works` keeps `showSheet` for `'consent'` and `'prompt'` when the wallet is not in front; `notification only` makes Task 11 drop `showSheet`/`hideSheet` and keep only the notification-tap target.

- [ ] Step 1: scratch, as Task 1, plus a scratch Kotlin `Function("s6ShowSheet")` that calls `startActivity(Intent(this, BridgeSheetActivity))` from the module (no user click, no visible window). With the wallet connected and Chrome in front (`am start -n com.android.chrome/com.google.android.apps.chrome.Main`), the page calls `createSignature` (a conformance card) so a prompt is pending.
- [ ] Step 2: cases, each recorded: (a) `s6ShowSheet` from the background on Pixel_9 (android-36): does the sheet start (`dumpsys activity activities`), or does `ActivityTaskManager` log `Background activity launch blocked`; (b) the heads-up notification appears and its tap opens the wallet (M1 behaviour, regression); (c) with notifications denied (`pm revoke ... POST_NOTIFICATIONS`): what the user sees (nothing); (d) with the device locked and notifications private: the public version only (`dumpsys notification --noredact` plus `cmd statusbar expand-notifications`); (e) shortly after the wallet was last visible (within 5 s): does the background start succeed (the grace window); (f) one OEM phone is a `GATE` (owner), as are Samsung and Xiaomi rows.
- [ ] Step 3: write the verdict (works only if (a) succeeded in the within-grace case (e) AND the plain case; a start allowed only in the grace window is `notification only` plus a recorded note). Revert scratch; commit `docs(android-bridge): spike S6, background prompt`.

### Task 3: S4b items that run on the emulator

**Repo:** WT for results; HW scratch, then a release build. **Consumes:** Task 1 scratch recipe. Spec 11 S4b (items 1, 2 partly, 3, 6 partly), 7.4 (destroy guard, tracker race).

**Files:**

- Modify: `PKG/SPIKES.md` (subsection S4b: emulator rows and the module-teardown audit)

**Interfaces:**

- Produces: results for S4b items 1, 3 and the emulator part of 2; the module teardown audit (a reading); the exact R8 keep-rule list that Task 6 must ship (`-keepclassmembers` lines for `ReactActivityDelegate.getReactDelegate` and `ReactDelegate.unloadApp` as they appear in `mapping.txt`), recorded in `SPIKES.md`.

- [ ] Step 1: R8 release build of the guard. In the scratch, hard-wire the guard on (no system property) and add the draft keep rules to `PKG/android/consumer-rules.pro`: `-keep class org.bsv.walletbridge.BridgeSheetActivity { *; }`, `-keepclassmembers class com.facebook.react.ReactActivityDelegate { *** getReactDelegate(); }`, `-keepclassmembers class com.facebook.react.ReactDelegate { *** unloadApp(); }`. Follow the R8 memory-note procedure: main-checkout Gradle release build of the host with minify and shrink on, check `mapping.txt` for the three names, `dexdump` for `BridgeSheetActivity` and the delegate subclass, install the release APK. The release APK has no `allowLocalhostHttp`, so launch the sheet with `SHEETLAUNCH`; then Back three times (`adb shell input keyevent BACK`) and assert from `dumpsys activity activities` and logcat that `MainActivity` survives each time, resumes normally, no `onHostDestroy` ran (the scratch logs it), and `unloadApp` resolved (no `NoSuchMethodError` in logcat).
- [ ] Step 2: tracker race, on the debug scratch. `am force-stop`, start the app, fire `SHEETLAUNCH` at 0.5 s, 1.5 s and 2.5 s after `am start` (loop of three runs, each from a force-stop). Pass: in every run `dumpsys activity activities` never lists `BridgeSheetActivity` while the tracker has not caught up and `MainActivity` is alive, and the run ends with `MainActivity` in front (foreground mode). Because the scratch trampoline only has the S4 `mainAlive` flag, run the same loop again in Task 13 against the real tracker; this step records the window (about 1.8 s in S4) and whether any run showed the sheet.
- [ ] Step 3: leak check. After 10 sheet open and Back cycles and one `MainActivity` resume, run `adb shell am send-trim-memory org.bsvblockchain.wallet RUNNING_CRITICAL` and record `adb shell dumpsys meminfo org.bsvblockchain.wallet | grep Activities`. Pass: the count is not above the count before the cycles (a dev-client build adds the launcher activity, record the baseline first). A growing count is a FAIL that Task 6 must fix (clear every reference to the sheet in `onDestroy`).
- [ ] Step 4: module teardown audit, a reading, no run. For each of NetInfo, notifications (expo-notifications), BLE (`react-native-ble*` or the localpay transport), NFC, reanimated and `react-native-screens` in `HW/node_modules`, grep the Android sources for `onHostDestroy` and `LifecycleEventListener`/`ActivityEventListener`, and record in `SPIKES.md` what each does on host destroy and whether it can recover under a live `MainActivity` (the guard of Task 6 removes the event; the audit says what would break if the guard were bypassed). Also record which modules read `currentActivity` while Chrome is in front, as the list Task 6's fail-closed test enumerates.
- [ ] Step 5: revert the scratch; commit `docs(android-bridge): S4b emulator results and teardown audit`.

### Task 4: Pure-JVM lifecycle core: DestroyGuard, LifecycleState, TouchGuard, SheetPolicy

**Repo:** WT. **Consumes:** Task 3 (keep-rule names not needed here). Spec 7.4 (guard, tracker race, Home, new launch), 10 Kotlin M2 list. All files are pure JVM (no `android.*`) and join `ext.pureFiles` and `check-pure.sh`.

**Files:**

- Create: `PKG/android/src/main/kotlin/org/bsv/walletbridge/{DestroyGuard,LifecycleState,TouchGuard,SheetPolicy}.kt`, tests `PKG/android/src/test/kotlin/org/bsv/walletbridge/{DestroyGuardTest,LifecycleStateTest,TouchGuardTest,SheetPolicyTest}.kt`
- Modify: `PKG/android/jvmtest/build.gradle` (`ext.pureFiles`), `PKG/android/jvmtest/check-pure.sh`

**Interfaces:**

- Produces:
  - `enum class DestroyAction { UNLOAD_ONLY, SUPER }`; `object DestroyGuard { fun decide(mainAlive: Boolean?): DestroyAction }` (`UNLOAD_ONLY` only for `true`; `false` and `null` (unknown) give `SUPER`).
  - `class LifecycleState { fun onCreated(role: Role); fun onResumed(role: Role); fun onPaused(role: Role); fun onDestroyed(role: Role); fun catchUp(mainAlive: Boolean); fun registered(): Boolean; fun mainAlive(): Boolean?; fun mainResumed(): Boolean; fun sheetResumed(): Boolean; fun snapshot(): HostLifecycle }` with `enum class Role { MAIN, SHEET, OTHER }` and `data class HostLifecycle(val registered: Boolean, val mainAlive: Boolean, val mainResumed: Boolean, val sheetResumed: Boolean)`. Rules: `mainAlive()` is `null` until `catchUp` has run (the tracker is unregistered); `onResumed(MAIN)` marks main alive even if `catchUp` missed it (the backstop) and marks the tracker caught up; `onDestroyed(MAIN)` clears alive and resumed.
  - `class TouchGuard { companion { const val OBSCURED = 0x1; const val PARTIALLY_OBSCURED = 0x2 }; fun shouldDrop(flags: Int): Boolean }` (these are the values of `MotionEvent.FLAG_WINDOW_IS_OBSCURED` and `FLAG_WINDOW_IS_PARTIALLY_OBSCURED`; the Activity passes `ev.flags`; a unit test pins the numeric constants).
  - `enum class LaunchMode { OVERLAY, FOREGROUND }`; `object SheetPolicy { fun chooseMode(hostAttached: Boolean, ready: Boolean, life: HostLifecycle): LaunchMode; fun shouldFinishOnCreate(hasSavedState: Boolean): Boolean; fun shouldResetRoot(shownSeq: Long?, incomingSeq: Long): Boolean; fun shouldFinishOnStop(leftMark: Boolean): Boolean }`. `OVERLAY` iff `hostAttached && ready && life.registered && life.mainAlive`; `shouldResetRoot` is true when `shownSeq` is null or `incomingSeq > shownSeq`.

- [ ] Step 1: tests: `DestroyGuardTest`: `alive skips the host destroy`, `dead calls super`, `unknown calls super` (the full truth table of `mainAlive` times sheet current or not is exercised in Task 6's delegate, which passes `LifecycleState.mainAlive()`; here: three rows). `LifecycleStateTest`: `unregistered until catchUp and mainAlive is null`, `catchUp true marks alive`, `onActivityResumed backstop marks main alive when catchUp missed it`, `onDestroyed main clears alive and resumed`, `sheet resumed with main not resumed`, `handover main-to-sheet then sheet-to-main keeps alive true throughout`, `screen-off stop without leave mark does not finish` is in `SheetPolicyTest`. `TouchGuardTest`: `drops obscured`, `drops partially obscured`, `drops both`, `passes 0`, `constants equal the MotionEvent values 1 and 2`. `SheetPolicyTest`: `chooseMode` table (attached/ready/registered/alive each false gives FOREGROUND, all true gives OVERLAY; `registered` false with `mainAlive` true gives FOREGROUND, Review Focus 2 of spec 7.4); `restored instance finishes (shouldFinishOnCreate true)`; `stale sequence does not reset` (equal and lower give false; Review Focus 3); `screen-off stop without leave mark does not finish`, `stop with leave mark finishes` (Review Focus 1).
- [ ] Step 2: `KT` FAIL. Step 3: implement. Step 4: `check-pure.sh` ok, `KT` PASS. Step 5: commit `feat(android-bridge): lifecycle state, destroy guard, touch guard, sheet policy (pure JVM)`.

### Task 5: Native lifecycle surface: LifecycleTracker, setHostState, trampoline mode, TS types

**Repo:** WT (compile check against `HW` scratch as in M1 Task 13). **Consumes:** Task 4. Spec 6.2 (M2 surface), 6.3 (trampoline), 7.4 (launch path, tracker race).

**Files:**

- Create: `PKG/android/src/main/kotlin/org/bsv/walletbridge/LifecycleTracker.kt` (the `Application.ActivityLifecycleCallbacks` adapter around one `LifecycleState`; process-wide singleton `BridgeState.life`), `PKG/__tests__/hostLifecycle.test.ts`
- Modify: `BridgeState.kt` (`life`, `hostAttached`, `hostReady`, `sheet: WeakReference<Activity>?`), `BsvAndroidBridgeModule.kt` (register the tracker in `OnCreate` with the `appContext.currentActivity` catch-up; `setHostState`, `isMainActivityActive`, `hostLifecycle` sync getter; event `onHostLifecycle`), `LaunchTrampolineActivity.kt` (`SheetPolicy.chooseMode`), `PKG/src/native.ts`, `PKG/src/testing/fakeNative.ts`, `PKG/__tests__/fakeNative.test.ts`

**Interfaces:**

- Produces (native surface, `BsvAndroidBridgeNative` gains): `setHostState(s: { attached: boolean; ready: boolean }): void`; `isMainActivityActive(): boolean` (sync: main resumed); `hostLifecycle(): HostLifecycle` (sync, `{ registered, mainAlive, mainResumed, sheetResumed }`); event `onHostLifecycle: HostLifecycle` fired on every change of those four values; `showSheet(reason: 'launch' | 'consent' | 'prompt'): void` and `hideSheet(): void` are declared here (bodies in Tasks 6 and 11). `returnToBrowser(): void` keeps its name and gains the overlay behaviour in Task 10. The fake native gains `setHostLifecycle(l: Partial<HostLifecycle>)`, records `setHostState` calls and `showSheet`/`hideSheet` calls.
- The tracker: `onActivityCreated/Resumed/Paused/Destroyed` map the Activity class to `Role` (`MainActivity` by name suffix `.MainActivity`, `BridgeSheetActivity` by class); `raisedByBridge` is cleared in `onActivityDestroyed(MAIN)` (it moved here from the M1 module). The trampoline reads `BridgeState.hostAttached/hostReady` (written by `setHostState`) and `BridgeState.life.snapshot()`, starts `BridgeSheetActivity` (`Intent(this, BridgeSheetActivity::class.java)`, `FLAG_ACTIVITY_NEW_TASK`, `EXTRA_SEQ` as `Long`) for `OVERLAY`, else `getLaunchIntentForPackage` as M1, and sets `raisedByBridge = (mode == FOREGROUND)`.

- [ ] Step 1: tests: `hostLifecycle.test.ts`: `the fake native defaults to unregistered`, `setHostLifecycle fires onHostLifecycle once per change and not for a no-op`, `setHostState is recorded`; fakeNative: the new calls exist and never throw.
- [ ] Step 2: `KJ __tests__/hostLifecycle.test.ts __tests__/fakeNative.test.ts` FAIL. Step 3: implement TS then Kotlin (Kotlin has no unit test: `LifecycleState` and `SheetPolicy` carry the logic). Step 4: `KJ` PASS, `TSC` baseline, `HBUILD` compiles (`:bsv-expo-android-wallet-bridge:compileDebugKotlin`) and `adb install -r`; M1 `run.mjs --only 1,5` still passes (foreground mode unchanged because the sheet is not yet wired to `setHostState` from JS). Step 5: commit `feat(android-bridge): lifecycle tracker, host state, trampoline mode choice`.

### Task 6: BridgeSheetActivity: guarded delegate, native Back, Home rule, launch extras

**Repo:** WT. **Consumes:** Tasks 3, 4, 5. Spec 6.3, 6.11, 7.4 (guard, Back, Home, launch handling).

**Files:**

- Create: `PKG/android/src/main/kotlin/org/bsv/walletbridge/BridgeSheetActivity.kt`, `PKG/android/src/main/res/values/styles.xml` (theme per Global Constraints)
- Modify: `PKG/android/src/main/AndroidManifest.xml`, `PKG/android/build.gradle` (`compileOnly 'com.facebook.react:react-android'`), `PKG/android/consumer-rules.pro` (the exact lines recorded by Task 3 step 1), `BsvAndroidBridgeModule.kt` (`hideSheet`, `showSheet('launch')` body, `returnToBrowser` overlay branch lands in Task 10), `PKG/__tests__/manifest.test.ts`

**Interfaces:**

- Produces: `class BridgeSheetActivity : ReactActivity` with `getMainComponentName() = "BsvBridgeSheet"`; a delegate subclass of `DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)` whose `onDestroy` is `when (DestroyGuard.decide(BridgeState.life.mainAlive())) { UNLOAD_ONLY -> reactDelegate?.unloadApp(); SUPER -> super.onDestroy() }` and which clears `BridgeState.sheet`; `onCreate`: finish at once when `SheetPolicy.shouldFinishOnCreate(savedInstanceState != null)`, else `super.onCreate(null)` and store `BridgeState.sheet`; native Back: `onBackPressed` override `finish()` and an `OnBackInvokedCallback` (API 33+, `onBackInvokedDispatcher.registerOnBackInvokedCallback(PRIORITY_DEFAULT, ...)`) that finishes; `onUserLeaveHint` sets `left = true`; `onStop` calls `finish()` when `SheetPolicy.shouldFinishOnStop(left)`; `onNewIntent`: `setIntent(Intent())` first, read `EXTRA_SEQ` with `getLongExtra`, and when `SheetPolicy.shouldResetRoot(shownSeq, incoming)` reset the root (`reactDelegate.unloadApp()` then `loadApp(mainComponentName)`), always keeping the pending prompt state in JS untouched. `hideSheet()` and the Back race: `finishSheet()` with no live sheet is a no-op.
- Manifest test (flip M1's assertion): `has exactly two exported=false app components plus the exported trampoline`: exactly one `exported="true"` (trampoline), `BridgeSheetActivity` present, `exported="false"`, `launchMode="singleTask"`, `taskAffinity="${applicationId}.bridge"`, `excludeFromRecents="true"`, no intent filter on it, and the old `no sheet activity` assertion is removed.

- [ ] Step 1: tests: manifest test above (rewrite `has no receiver, no sheet activity (M2) and no overlay` to keep the no-receiver and no-`SYSTEM_ALERT_WINDOW` parts and assert the sheet declaration instead). Kotlin behaviour is covered by Task 4's pure tests and the device runs; the delegate member names for R8 are covered by Task 3 step 1 and re-verified in Task 13 step 5.
- [ ] Step 2: `KJ __tests__/manifest.test.ts` FAIL. Step 3: implement (guard reaches the protected `getReactDelegate()` through a `ReactActivityDelegate` method on the delegate subclass, not through reflection). Fail closed for the stale `currentActivity` (S4 finding, spec 7.4): in `onDestroy` null `BridgeState.sheet` and drop every reference the activity holds. Step 4: `KJ` PASS, `HBUILD`, install, then `SHEETLAUNCH` with JS not yet registering `BsvBridgeSheet` shows a red screen: acceptable here (Task 9 registers it); verify only that the Activity starts, Back finishes it with `MainActivity` surviving, Home followed by `onStop` finishes it (`dumpsys activity activities` has no sheet task), and a screen-off then on (`input keyevent KEYCODE_SLEEP`, `KEYCODE_WAKEUP`) does not finish it. Step 5: commit `feat(android-bridge): bridge sheet activity with the destroy guard, native back and home rule`.

### Task 7: Theme and tapjacking protections on the Activity

**Repo:** WT. **Consumes:** Tasks 4 and 6. Spec 7.4 (protections), 11 S3 tapjacking row.

**Files:**

- Modify: `BridgeSheetActivity.kt`, `PKG/__tests__/manifest.test.ts` (theme attributes via the resources XML parse), `PKG/android/src/main/res/values/styles.xml`
- Create: `PKG/__tests__/sheetStyles.test.ts`

**Interfaces:**

- Produces: in `onCreate`: `window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)`, `window.setHideOverlayWindows(true)` on `Build.VERSION.SDK_INT >= 31`, `dispatchTouchEvent` override that returns `true` (consumes, drops) when `TouchGuard.shouldDrop(ev.flags)`, root content view `filterTouchesWhenObscured = true`. The 90 percent scrim and the 700 ms Approve protection are in JS (Task 9); this task only guarantees the Activity side.

- [ ] Step 1: tests: `sheetStyles.test.ts` parses `styles.xml` and asserts the theme parent is `Theme.AppCompat.DayNight.NoActionBar`, `windowIsTranslucent` true, `windowBackground` transparent, `windowNoTitle` true, `enforceNavigationBarContrast` false, and that no `statusBarColor` or `navigationBarColor` item exists. A source-level test reads `BridgeSheetActivity.kt` and asserts it contains `FLAG_SECURE`, `setHideOverlayWindows(true)` behind a `>= 31` guard, `TouchGuard.shouldDrop` and `filterTouchesWhenObscured` (names a test that fails if a later edit drops a protection; the behaviour itself is Task 1's tapjacking row and the owner gate).
- [ ] Step 2: FAIL. Step 3: implement. Step 4: `KJ` PASS, `HBUILD`; on the emulator `SHEETLAUNCH` and confirm `FLAG_SECURE` (`adb shell screencap -p` of the sheet is black while a `dumpUi()` still finds the activity window). Step 5: commit `feat(android-bridge): sheet window protections`.

### Task 8: ContextRelay in the toolbox

**Repo:** WT. **Consumes:** nothing from Tasks 4 to 7. Spec 6.14 item 5, 7.4 (second React root), 10 (M2 `ContextRelay`).

**Files:**

- Create: `TB/ui/bridgeSheet/ContextRelay.tsx`, `TB/ui/bridgeSheet/relayedContexts.ts`, `TB/__tests__/ui/bridgeSheet/{contextRelay,relayedContexts}.test.tsx`
- Modify: `TB/ui/index.ts` (export), `TB/CHANGELOG.md` (Unreleased)

**Interfaces:**

- Produces: `RELAYED_CONTEXTS: ReadonlyArray<{ name: string; context: React.Context<any> }>` naming `ThemeContext`, `WalletContext`, `ExchangeRateContext` and `UserContext` (import the context objects from their modules; `ThemeContext` is exported there); `ContextRelayPublisher: React.FC` (reads each context's current value with `useContext` and writes it into a module-level store; renders `null`); `ContextRelaySubscriber: React.FC<{ children: React.ReactNode }>` (nests one `Provider` per entry with the live value through `useSyncExternalStore`, and renders `children` only after every entry has been published at least once, otherwise `null`); `resetContextRelay(): void` (clears the store; tests and sign-out). Translation is a module singleton (`useLanguage` reads a context with a default that works without a provider); the first step verifies this by rendering `PermissionSheet` copy under the subscriber alone and adds `LanguageContext`'s consumer `useLanguage` only if a default leak appears.

- [ ] Step 1: tests (`contextRelay.test.tsx`, light and dark, theme and wallet relayed): `PermissionSheet connection kind renders under the subscriber alone with every context relayed` (the sentinel values: a theme with `colors.background` of a unique colour, a `WalletContext` with a unique `managers` object); `a probe per RELAYED_CONTEXTS entry sees the published value, not the context default` (iterate the list, assert `!== defaultValue`); `fails when an entry is not published` (negative: skip publishing one and assert the subscriber renders null or the probe test fails, so the "no default context" test is proven real); `theme change reaches the subscriber without remount` (Review Focus 4: switch the published theme and assert the same mounted node text updates and the mount counter stays 1); `unmount of the publisher resets nothing silently: subscriber keeps the last values until resetContextRelay`. `relayedContexts.test.tsx`: `every useContext and useTheme read in PermissionSheet.tsx names a context in RELAYED_CONTEXTS` (a static scan of the source text for `useContext(X)` and `useTheme()`; a new context in the sheet fails this test until it is listed).
- [ ] Step 2: `TBJ __tests__/ui/bridgeSheet` FAIL. Step 3: implement. Step 4: `TBJ __tests__/ui __tests__/bridge` PASS, `TSC` baseline. Step 5: commit `feat(toolbox): context relay for a second React root`.

### Task 9: sheetOwner, AndroidBridgeSheetGate, BridgeSheetRoot, root registration

**Repo:** WT. **Consumes:** Tasks 5 and 8. Spec 6.11, 6.12, 7.4 (one owner at a time, locks, test id).

**Files:**

- Create: `PKG/src/ui/sheetOwner.ts`, `PKG/src/ui/AndroidBridgeSheetGate.tsx`, `PKG/src/ui/BridgeSheetRoot.tsx`, `PKG/src/ui/registerSheetRoot.ts`, tests `PKG/__tests__/ui/{sheetOwner,sheetGate,sheetRoot}.test.tsx`
- Modify: `PKG/src/index.ts` (exports), `PKG/src/AndroidBridgeHost.tsx` (mounts `ContextRelayPublisher` and mirrors host state, see below), `PKG/src/setup.ts` (`registerSheetRoot` at module scope)

**Interfaces:**

- Consumes: Task 5 `hostLifecycle()` and `onHostLifecycle`; Task 8 relay.
- Produces:
  - `sheetOwner(): 'main' | 'overlay' | 'none'` from the last `HostLifecycle` (`'overlay'` iff `sheetResumed && !mainResumed`; `'main'` iff `mainResumed`; else `'none'`); `useSheetOwner()` via `useSyncExternalStore` on `onHostLifecycle`; `setSheetOwnerSource(native: Pick<BsvAndroidBridgeNative,'hostLifecycle'|'addListener'>)`. It never reads `AppState`.
  - `<AndroidBridgeSheetGate>{children}</AndroidBridgeSheetGate>` renders children only when `useSheetOwner() !== 'overlay'`; `<BridgeSheetRoot />` renders `PermissionSheet` inside a `View testID="bridge-sheet-root"` with `filterTouchesWhenObscured`, a scrim of `rgba(0,0,0,0.9)`, and only when the owner is `'overlay'` (otherwise renders `null`), wrapped by `ContextRelaySubscriber`. `registerSheetRoot(): void` calls `AppRegistry.registerComponent('BsvBridgeSheet', () => BridgeSheetRoot)` once (idempotent under Fast Refresh).
  - `AndroidBridgeHost` (M2) additionally mounts `<ContextRelayPublisher />` and calls `native.setHostState({ attached: snapshot.hostAttached, ready: snapshot.readiness === 'ready' })` on mount and on each `onSnapshotChange`, and `setHostState({ attached: false, ready: false })` on unmount.

- [ ] Step 1: tests: `sheetOwner` truth table over the four booleans (main only, sheet only, both, neither) with `AppState.currentState` forced to `'active'` for every row (the result never changes with it); `the gate renders its child when owner is main or none and not when overlay`; `PermissionSheet exists in exactly one root at a time across a main-to-overlay-to-main handover` (render the gate and the root together over a fake native, step the lifecycle, count mounted `PermissionSheet` instances: always 1 when something is pending and the owner is not `none`); `the root testID is bridge-sheet-root and the scrim is 0.9`; `locked then unlocked: the root under a fake wallet whose readiness goes blocked then ready parks a connect then shows it` (sheet root under a fake wallet snapshot); `registerSheetRoot registers once`; `the root adds no hard-coded strings` (spec: M2 copy is the existing sheets'; scan `BridgeSheetRoot.tsx` for JSX text nodes); `host sends setHostState on attach, ready and detach`.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: `KJ __tests__/ui __tests__/host.test.tsx` PASS, `TSC` baseline. Step 5: if a test or the S6/S3 results added any new string, add its key in all 12 locales and run `TBJ __tests__/i18n`; otherwise state "no new copy" in the commit body. Step 6: commit `feat(android-bridge): sheet owner, gate and overlay root`.

### Task 10: Controller attention on sheetOwner, overlay returnToBrowser, blip rules

**Repo:** WT. **Consumes:** Tasks 5, 6, 9, Task 1 verdicts (b) and (d). Spec 7.4 (attention table, way back, handover blip), 6.2.

**Files:**

- Modify: `PKG/src/controller/attention.ts` (replace the `AppState`-fed `setMainInFront` with an owner source), `PKG/src/AndroidBridgeHost.tsx` (remove the `AppState` feed; the way-back timer stays; the `onTimer` handler re-reads `sheetOwner()` and the 500 ms debounce), `BsvAndroidBridgeModule.kt` (`returnToBrowser`), tests `PKG/__tests__/{attention,host}.test.ts*`, `PKG/__tests__/blip.test.tsx`
- Modify (toolbox, only if Review Focus 6 fails): `TB/ui/components/ui/PermissionSheet.tsx`

**Interfaces:**

- Produces: `createAttention(deps)` gains `deps.owner: () => 'main' | 'overlay' | 'none'`; `isWalletInFront()` is `owner() !== 'none'`; `setMainInFront` is removed (callers updated). Table unchanged: `'consent'`/`'prompt'` with the wallet in front: nothing; otherwise `native.postAttention` then, per Task 11, `showSheet`. `AndroidBridgeHost` calls `attention.refreshFront()` on each `onHostLifecycle` and cancels the heads-up when the owner becomes `'main'` or `'overlay'`. `returnToBrowser` native: overlay branch finishes the live sheet (`BridgeState.sheet?.finish()` on the main thread, no-op when none); foreground branch is the M1 `moveTaskToBack` of the foremost activity only when `raisedByBridge`; neither throws `ERR_NO_ACTIVITY` when no activity is alive (Review Focus 5).

- [ ] Step 1: tests (`attention.test.ts`, owner source faked, `AppState` forced `'active'` through `jest.spyOn(AppState,'currentState','get')` in every row): `owner main: no heads-up`, `owner overlay: no heads-up (the sheet itself renders the prompt)`, `owner none with AppState active: heads-up posted` (the S4-6 regression: fails on the M1 code), `wallet-not-ready rows unchanged`, `owner turns overlay cancels a posted heads-up`. `blip.test.tsx` (fake timers): `background then active 50 ms apart closes no binding, fails no request, locks nothing and starts no debounced action`, `a background that lasts 500 ms and is re-read as still background triggers the debounced action once`, `handover blip does not execute a pending grant` and `a Sheet whose open position was re-applied on active keeps its state across the blip` (Review Focus 6: render `PermissionSheet` with a pending grant, send `AppState` background then active 50 ms apart, assert the grant was not executed and the sheet is still visible; if this fails, the fix is a 500 ms debounce on the F1 background check in `PermissionSheet.tsx` and the test belongs in `TB/__tests__/ui/PermissionSheet.test.tsx`). Host: `returnToBrowser is requested 600 ms after the last pending item and only while the owner is not main`, `returnToBrowser after the sheet already finished does nothing` (fake native with no live sheet). Task 1 (b) false changes this task to "the overlay branch calls `moveTaskToBack` instead of `finish()`": use that result if S3 recorded it.
- [ ] Step 2: `KJ` FAIL. Step 3: implement. Step 4: `KJ`, `TBJ __tests__/ui`, `TSC` baseline PASS. Step 5: commit `feat(android-bridge): attention reads the sheet owner, overlay return to browser`.

### Task 11: Background prompts: showSheet and the notification tap target (per S6)

**Repo:** WT. **Consumes:** Task 2 verdict, Tasks 6, 10. Spec 7.4 (background activity starts), 6.10 (notification tap).

**Files:**

- Modify: `BsvAndroidBridgeModule.kt` (`showSheet`), `AttentionPoster.kt` / `BridgeService.kt` (notification tap `PendingIntent` target), `PKG/src/controller/attention.ts`, `PKG/__tests__/attention.test.ts`, `PKG/__tests__/manifest.test.ts`

**Interfaces:**

- Produces, if S6 verdict is `background sheet works`: `showSheet(reason)` starts `BridgeSheetActivity` only when `SheetPolicy.chooseMode` is `OVERLAY` and catches `ActivityNotFoundException`/background-start exceptions without throwing to JS; `attention.requestAttention('consent'|'prompt')` with owner `'none'` calls `native.showSheet(reason)` and then `postAttention` (always both, spec 7.4). If the verdict is `notification only`: `showSheet`/`hideSheet` remain declared in the surface as no-ops, `attention` does not call them, and the README copy in Task 14 says later prompts are a notification. In both cases the notification tap `PendingIntent` is an explicit-component `FLAG_IMMUTABLE` intent to `BridgeSheetActivity` when `SheetPolicy.chooseMode` is `OVERLAY` at tap time (decided in the receiving activity: a service-side check would be stale) and to the main activity otherwise. The mode is decided in the receiving activity, because a service-side check would be stale: the pending intent always targets `BridgeSheetActivity`, whose `onCreate` forwards to `MainActivity` and finishes when `SheetPolicy.chooseMode` says `FOREGROUND` (the pure function of Task 4).

- [ ] Step 1: tests: `owner none with prompt: showSheet then postAttention (verdict works)` or `... postAttention only (verdict notification only)` (write the one that matches the S6 verdict and delete the other from the plan run); `showSheet is never called when the owner is main or overlay`; `notification generic text unchanged`; manifest: still exactly one exported component.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: `KJ`, `KT` PASS, `HBUILD` compiles. Step 5: commit `feat(android-bridge): background sheet and notification tap target`.

### Task 12: Host adoption in bitcoin-sv-wallet

**Repo:** HW. **Consumes:** Tasks 6 to 11. Spec 6.13 items 3, 4, 6. Re-run `link-kit.sh` first; discard Tasks 1 to 3 scratch with explicit `git checkout -- <file>` per file.

**Files:**

- Modify: `index.js` (the `registerSheetRoot` call is inside `setupAndroidBridge`, so only verify the order: before `require('expo-router/entry')`), `app/_layout.tsx` (wrap the main tree's `<PermissionSheet />` in `<AndroidBridgeSheetGate>`), `__tests__/androidBridgeHost.test.tsx`

**Interfaces:**

- Consumes: `AndroidBridgeSheetGate`, `registerSheetRoot` (via `setupAndroidBridge`), `AndroidBridgeHost` (now publishing the relay and host state).

- [ ] Step 1: tests: `the main tree wraps PermissionSheet in AndroidBridgeSheetGate` (render `_layout` pieces or scan the file as the existing host tests do), `the BsvBridgeSheet component is registered before the router entry` (import-order assertion on `index.js`), `Delete Wallet still reaches resetAndroidBridge once`, `isolation and nativeIntent suites unchanged`.
- [ ] Step 2: `HJ` FAIL. Step 3: implement. Step 4: `HJ` and `HTSC` equal the baseline plus the new passing tests; `HBUILD` succeeds and the merged manifest shows the sheet Activity unexported. Step 5: commit in HW `feat(android-bridge): adopt the overlay sheet`. Stage only the listed files; no `package.json` dependency line (release).

### Task 13: Emulator end-to-end for overlay mode, release re-verification

**Repo:** WT for scripts and evidence; HW for the build. **Consumes:** everything. Spec 10 (emulator, M2 rows), 11 S4b (items 1, 3, 5 partly, 6 partly). Cases extend `PKG/scripts/e2e/cases.mjs` and `run.mjs` (`--only O1,O2` selects overlay cases); with `FLAG_SECURE` set, evidence is `dumpUi()` XML and logcat saved under `docs/superpowers/evidence/android-kit/overlay/`, not screenshots.

**Files:**

- Create: `PKG/scripts/e2e/overlay.mjs` (helpers: `sheetResumed()` and `mainResumed()` from `dumpsys activity activities`, `topResumed()`), `docs/superpowers/evidence/android-kit/overlay/*`
- Modify: `PKG/scripts/e2e/{cases.mjs,run.mjs}`, `PKG/__tests__/e2e/parse.test.ts` (new parser `parseResumedActivities(dumpsys): string[]`), `PKG/SPIKES.md`

**Interfaces:**

- Produces `parseResumedActivities(dumpsys: string): string[]` in `parse.mjs` (component names of every resumed activity, newest first), and the cases below.

- [ ] Step 1: tests: `parseResumedActivities` returns main only, sheet and none during a handover transient, and names the sheet class. `KJ __tests__/e2e` PASS.
- [ ] Step 2: cases, each with a stated pass condition and its evidence file: O1 warm, wallet unlocked: Open wallet from Chrome shows `bridge-sheet-root` and `bridge-connect-origin` with `localhost:3001` and Unverified, `topResumed` is the sheet, Chrome `PAUSED` not stopped; Connect; sheet gone and Chrome top-resumed (overlay `returnToBrowser`); O2 the same flow, held-open `createSignature` across the overlay sheet, Approve, page gets the result, exactly one `bridge-approve` node exists in the window dump (one owner); O3 cold: force-stop, launch at 0.5 s, 1.5 s, 2.5 s after `am start` with the real tracker (Task 3 step 2 again): `BridgeSheetActivity` never listed while the tracker is unregistered, foreground mode shows the Connect sheet in `MainActivity`; O4 Back in the sheet with the main tree on Settings: the sheet finishes, `MainActivity` remains on Settings, the request stays parked and the `bridge-attention` notification text appears (counts only); O5 Home with the sheet up: the sheet task is gone from `dumpsys activity activities` once `onStop` ran, a new launch creates a fresh root (`restored root count` log is 1); O6 wallet in front (main resumed) when a prompt arrives: the in-app sheet shows (`bridge-approve` under main), no overlay started, no duplicate; O7 screen off then on with the sheet up: same root and same pending prompt (Review Focus 1); O8 sheet up, a new prompt for another origin arrives: shown in the same root, never a second Activity; O9 `adb shell cmd uimode night yes` while the sheet is up: text colours change and the root is not remounted (log mount counter) (Review Focus 4); O10 stale second launch from `adb` with the same seq does not reset a showing root (Review Focus 3); O11 later prompt with Chrome in front and the wallet backgrounded: behaviour matches the S6 verdict (`showSheet` raised or notification only); O12 leak: 10 open/Back cycles then `MainActivity` resume, `meminfo` `Activities:` stable; O13 plaintext: no `k=`, epoch or token in logcat for the whole overlay run (as M1 case 14); O14 regression: M1 cases 1 to 5, 7, 15, 16, 17 still pass in foreground mode with the wallet cold and with overlay available.
- [ ] Step 3: release re-verification (spec 11 S4b item 1 against the real code): R8 release build (memory-note procedure), `mapping.txt` and `dexdump` for `BridgeSheetActivity`, the delegate subclass, `LifecycleTracker`; `SHEETLAUNCH` on the release APK; Back three times, `MainActivity` survives, no `NoSuchMethodError`. Record in `SPIKES.md`.
- [ ] Step 4: `SPIKES.md` gets an "M2 results" table (case, result, observation, any substitution), and "Device gates for the owner (M2)" as listed at the end of this plan. Failing cases are recorded, not hidden; a failure that is not a device gate is blocking.
- [ ] Step 5: commit `test(android-bridge): overlay emulator run and release verification`.

### Task 14: Docs, conformance notes, changelogs

**Repo:** WT. Spec 12 (M2 limits), 6.12, 14.

**Files:**

- Modify: `PKG/README.md` (overlay mode: when it appears, Back and Home behaviour, the second tap, the notification fallback, the S3 way-back result, `AndroidBridgeSheetGate` adoption line), `PKG/CONFORMANCE.md` (nothing claimed changes; note the overlay is not a BRC-185 surface), `PKG/CHANGELOG.md` (M2 entry), `TB/CHANGELOG.md` (Unreleased: `ContextRelay`, `RELAYED_CONTEXTS`), `docs/superpowers/specs/2026-10-28-browser-bridge-android-design.md` (status line only: S3, S6, S4b emulator results and the plan link; no design change unless a spike overturned one, in which case list it)
- Modify: `docs/superpowers/plans/2026-10-29-browser-bridge-android-m1.md` is not touched here (Appendix A was updated when this plan was written)

- [ ] Step 1: full suites green: `TSC` baseline, `TBJ` whole package (no `--forceExit`), `KJ`, `KT`, `HJ`/`HTSC` baselines, iOS `npx jest --ci packages/expo-safari-wallet-bridge` (with `NODE_PATH` per `SPIKES.md` Task 20).
- [ ] Step 2: write the docs; prettier on touched files only. Step 3: commit `docs(android-bridge): overlay mode docs and changelogs`.

---

## Owner device gates (not tasks)

Listed in `SPIKES.md` by Task 13. None blocks the plan.

1. S4b on a real phone with an OEM Chrome and an R8 release build: the guard under real memory pressure (process death with the sheet up), the module teardown behaviour of NetInfo, notifications, BLE/NFC and reanimated.
2. The tracker race at 0.5 s, 1.5 s and 2.5 s after a process start on a real phone (the timing differs from the emulator).
3. `useVaultKeys` `AppState` listener with a key removal in the broadcast state, across a handover blip.
4. Predictive back with gesture navigation on an API 34+ device; Back with the main tree on a non-Home screen.
5. The keyboard in the sheet (`adjustResize`), `FLAG_SECURE` on an OEM build, and reading the UI by test ids.
6. S3 rows that need hardware: OEM multi-window, task order on a real launcher, the tapjacking overlay test with a second package if Task 1 step 3 recorded a `GATE`.
7. S6 rows that need hardware: Samsung and Xiaomi background starts, locked-screen private notifications.
8. The second Open wallet tap on a real Chrome (cause not isolated if Task 1 step 2 (g) could not).
9. The Chrome permission dialog and the https/ngrok path with the overlay (as M1's S1b gate), and a release build with R8 on that path.

---

## Self-review

- **Spec coverage.** 6.0 (M2 scope and weaker fallbacks): Tasks 1, 2 verdicts. 6.3 and 6.11 (sheet Activity, theme, `compileOnly react-android`, keep rules, guarded delegate, native Back, Home, tracker default): Tasks 3, 4, 5, 6, 7. 6.14 item 5 and 7.4 relay with theme and `WalletContext`: Task 8. `sheetOwner()`, gate, root, `bridge-sheet-root`, locked-then-unlocked: Task 9. Attention decisions on `sheetOwner()`, overlay `returnToBrowser`, handover blip rule: Task 10. Background prompts (S6): Task 11. Host adoption 6.13 items 3, 4, 6: Task 12. Section 10 M2 tests (guard truth table: Task 4, Back and Home: Tasks 4 and 6 and case O4/O5, leak check: Task 3 and case O12, `sheetOwner` with `AppState` forced active: Tasks 9 and 10, blip: Task 10, relay light and dark: Task 8): covered. Section 11 S3, S4b (emulator parts), S6: Tasks 1 to 3, 13; real-phone parts: the gates list. Section 12 M2 limits (second tap, not a persistent surface): Task 14 README plus case O4/O5. i18n: Task 9 step 5.
- **Step scan.** Every step names a file, a signature or an assertion. Task 11 step 1 offers two alternative tests keyed on the S6 verdict by design (the executor writes the matching one); Task 10 states what a Task 1 (b) failure changes.
- **Type consistency.** `HostLifecycle`, `LifecycleState`, `SheetPolicy`, `DestroyGuard`, `TouchGuard` are defined in Task 4 and used unchanged in Tasks 5, 6, 7, 9, 11. `setHostState`, `hostLifecycle`, `onHostLifecycle`, `showSheet`, `hideSheet`, `isMainActivityActive` are defined in Task 5 and used in Tasks 9 to 11. `RELAYED_CONTEXTS` and the relay components are defined in Task 8 and used in Task 9. `EXTRA_SEQ` is read with `getLongExtra` in Task 6 (S4 finding 7).
- **Review Focus.** Each of the six lines has a named test in the owning task; none duplicates a spec M2 test.
- **Proportion.** The spec's M2 sections are about 300 lines; this plan keeps bodies out and names signatures, assertions and commands.
