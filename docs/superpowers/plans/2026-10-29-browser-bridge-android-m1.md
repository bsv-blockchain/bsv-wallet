# Browser Bridge Android Loopback Kit, Milestone 1 (Project 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@bsv/expo-android-wallet-bridge` milestone 1 (foreground mode): a Kotlin loopback HTTP server, launch trampoline, foreground service and Expo module, the TypeScript protocol controller, the config plugin, a stand-in page client and demo, and the Bitcoin SV Wallet adoption, so a page in Android Chrome can use the wallet as its BRC-100 wallet through the P1 core. M2 (overlay) is a gated appendix.

**Architecture:** The pure BRC-185 §4.1 HTTP semantics (router, CORS, status table, launch proof MACs, Host check, endpoint list) live in the toolbox (`core/bridge/loopback/`) and are jest-tested. Kotlin is a dumb pipe: strict HTTP/1.1 parser, dual-family exclusive bind, hold-open responses, process-memory `LaunchStore`, Kotlin deadline timers, foreground service. A TS controller in the kit wires native events to the router and to P1 `dispatch()`, owns the session machine, the unsettled-binding gate and the token outbox. The host adopts the kit with one plugin entry and a short list of edits.

**Tech Stack:** TypeScript, React Native 0.86 / Expo SDK 57, Kotlin 2.1.20 (ExpoModulesCore), JUnit 4.13.2 (pure JVM), `@noble/curves` + `@noble/hashes`, `expo-secure-store`, esbuild, jest, Pixel_9 AVD.

**Spec:** `docs/superpowers/specs/2026-10-28-browser-bridge-android-design.md` (revision 3; "spec 7.5" = its section 7.5). Core spec: `docs/superpowers/specs/2026-10-27-browser-bridge-core-design.md` ("P1 6.5"). Prior plan mirrored: `docs/superpowers/plans/2026-10-28-browser-bridge-ios-kit.md`. Read the spec section named in each task before starting. BRC-185: `/Users/personal/git/docs/BRCs/wallet/0185.md`.

## Global Constraints

**Repos and names**
- `WT` = `/Users/personal/git/bsv-wallet/.claude/worktrees/browser-bridge-android`, branch `feat/browser-bridge-android`. `TB` = `WT/packages/expo-wallet-toolbox`. `PKG` = `WT/packages/expo-android-wallet-bridge` (new). `IOS` = `WT/packages/expo-safari-wallet-bridge`. Never touch `master`.
- `HW` = `/Users/personal/git/ts/bitcoin-sv-wallet/.claude/worktrees/android-bridge`, repo bitcoin-sv-wallet, branch `feat/android-wallet-bridge` created in Task 1 as a NEW worktree off `feat/safari-wallet-bridge` (the existing worktree `.../worktrees/safari-bridge` has uncommitted edits and belongs to another session: never switch or edit it). Never commit to `main`. Tasks say "Repo: HW" for host work. A task never edits both repos in one commit.
- Scratch host wiring (Tasks 10, 18) is working-tree-only in `HW` and is discarded before Task 19 commits.

**Spec values (verbatim)**
- Package `@bsv/expo-android-wallet-bridge`, `private: true`, version `0.0.0`, `expo-module.config.json` `{"platforms":["android"],"android":{"modules":["org.bsv.walletbridge.BsvAndroidBridgeModule"]}}`; Kotlin package `org.bsv.walletbridge`; transport id `android-loopback` (`attestation: 'unattested'`, `bindingMode: 'explicit'`, with `deliverReconnectToken` and `requestAttention`); launch scheme `bsv-wallet-bridge`, host `launch`, package `org.bsvblockchain.wallet`.
- Ports: base 3321, offset 0 to 63 (ceiling 3384), JSON profile only (`http-json`, endpoint ids `json-ipv4`, `json-ipv6`, `json-localhost`); no legacy routes, no 3301, no 2121. Bind `127.0.0.1` and `[::1]` with `setReuseAddress(true)` before bind; both families or move up; `localhost` advertised only when both are bound.
- HTTP: one request per connection, `Connection: close`; request line 2,048 B; heads 64 lines / 16,384 B; connection cap 32 (`503` + `Retry-After: 1`); head 10 s, body 30 s, write stall 30 s; connect body 4,096 B; request body `MAX_BRIDGE_REQUEST_BYTES` 5 MiB; describe body at most 16,384 B; duplicate `Origin`/`Host` `403`, other duplicate `400`; `Transfer-Encoding` `411`; `Expect` `417`.
- Paths: `GET /.well-known/brc-wallet?challenge=<b64url 32B>[&hello=<b64url 32B>]`, `POST /.well-known/brc-wallet/connect`, `DELETE /.well-known/brc-wallet/connect/<epoch>`, `POST /brc185/v1/rpc/<method>`, `OPTIONS` on each. Headers `BRC-185-Epoch`, `BRC-185-Instance`, `BRC-185-Key`, `BRC-185-Android-Binding`; responses `BRC-185-Android-Ack`, `BRC-185-Reconnect-Token`. All responses `Cache-Control: no-store`, `Vary: Origin`, `X-Content-Type-Options: nosniff`; no `Server`/`Date`; never `Access-Control-Allow-Credentials`; no `Access-Control-Max-Age`.
- Launch: `intent://launch?v=1&e=<epoch>&k=<b64url32>&n=<b64url16>#Intent;scheme=bsv-wallet-bridge;package=org.bsvblockchain.wallet;[S.browser_fallback_url=…;]end`, at most 512 B; record life 120 s (Kotlin stamp, destructive `takeLaunches()`); 32 live records, evict oldest unused unparked; epoch tombstones 10 min; trampoline starts next component at most once per 3 s. MAC labels `BRC-185 android hello v1\n`, `… describe ack v1\n`, `… launch v1\n`, `… ack v1\n`, `… binding v1\n`, HMAC-SHA-256 under `k`, JCS payloads exactly as spec 7.5.
- Session: ARMED 120 s after the last launch, 10 min chain cap; parked connects at most 4, 10-minute deadline; unsettled binding 60 s; reaper every 60 s closes bindings idle 30 min with nothing parked or in flight; return-to-browser hysteresis 600 ms; all deadline timers are Kotlin `Handler` timers. No deadline on any request admitted to a binding (BRC-219).
- Continuity: HKDF-SHA256, salt `BRC-185 android continuity v1`, info `ctx || 0x00 || gen`, L 48; `ctx = 'android:' + origin`; SecureStore key `bsv.androidBridge.continuity`, `requireAuthentication: false`; `sign` accepts only preimages starting `BRC-185 descriptor v1\n` or `BRC-185 connect v1\n` (imported from core); descriptor `instanceLabel` is the app name, never the device name; no `data:` icons.
- Notifications name no site; `VISIBILITY_PRIVATE` with a generic public version; `FLAG_IMMUTABLE` explicit-component `PendingIntent`s; channels `bridge-session` (LOW), `bridge-attention` (HIGH, `CATEGORY_MESSAGE`). Service type `specialUse`, `START_NOT_STICKY`, never started from the background.
- Never log `k`, `e`, the launch URI, proofs, acks, binding secrets, tokens, bodies, `BRC-185-Key`, `BRC-185-Android-Binding`.
- Kit has no `process.env`; host settings are `setupAndroidBridge` options and plugin options. Raw sources shipped, no build output committed. Prettier (no semicolons, single quotes, no trailing commas, `arrowParens: avoid`, width 120) only on files you touched, never `prettier --write .`.
- i18n: each new string is a key in `TB/core/i18n/translations.tsx` in all 12 locales (`en es zh hi fr ar pt bn ru id ja pl`); `__tests__/i18n/translationParity.test.ts` must pass.
- Every commit message in this plan's tasks is conventional (`feat(android-bridge): …`) and ends with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never bare `git stash`. No emojis.

**Verification commands**
- `TSC`: from `WT`, `npx tsc --noEmit -p .` equals the baseline error count recorded in `PKG/SPIKES.md` (Task 1). `TBJ <paths>`: from `WT`, `npx jest --ci` with each path prefixed `packages/expo-wallet-toolbox/`. `KJ [paths]`: same for `packages/expo-android-wallet-bridge/`. Never `--forceExit`.
- `KT`: the Kotlin JVM suite, `GRADLE=$(ls -d ~/.gradle/wrapper/dists/gradle-9.3.1-bin/*/gradle-9.3.1/bin/gradle) && $GRADLE -p <dir> test` (JDK 17). Task 1 runs it with `<dir>` = `PKG/.scratch/kt` to prove the recipe (junit 4.13.2 is not in the local Gradle cache, so that run needs network once); Task 6 onward uses `<dir>` = `PKG/android/jvmtest`. If Gradle cannot run, Task 1 records the fallback.
- `HJ [path]` / `HTSC`: from `HW`, `npx jest --ci [path]` / `npx tsc --noEmit` (baseline in Task 1). `HBUILD`: from `HW`, `LANG=en_US.UTF-8 npx expo prebuild --platform android --no-install` then `(cd android && ./gradlew :app:assembleDebug)`; Metro on port 8082.
- `EMU`: Pixel_9 AVD (android-36 google_apis_playstore arm64, JDK 17). Preflight: `adb kill-server && adb start-server && adb devices` must show `device`, not `unauthorized` (an `unauthorized` emulator: cold-boot it with `emulator -avd Pixel_9 -no-snapshot-load`). Chrome version: `adb shell dumpsys package com.android.chrome | grep versionName`; loopback permission needs 142 or newer. **Page origins on the emulator are exactly two**: `http://localhost:3000` via `adb reverse tcp:3000 tcp:3000` (BRC-325 `exempt`, needs `allowLocalhostHttp` in a debug build) and `https://deggen.ngrok.app` (real permission path, only if Chrome is 142+). `http://10.0.2.2` cannot be a page origin: `canonicalizeBridgeOrigin` refuses it and Chrome treats it as an insecure context.
- Kotlin that cannot run on the JVM (module, service, trampoline, server threads) is verified by `HBUILD` compiling it and by the Task 18 and 20 emulator runs.

## Review Focus

Inputs the spec implies but its test list does not name; each has a test in the named task.
1. A page sends `Origin: https://Example.com` (uppercase host) or `https://example.com:443`: must be `403`, empty body, no CORS headers, never normalised (Task 5 `uppercase host and explicit default port origins are refused 403 without CORS`).
2. `takeLaunches()` returns two records for one epoch, or the same URI again after a JS reload: exactly one record exists and the epoch stays tombstoned (Task 13 `duplicate epoch in one take yields one record`, `burnt epoch is not re-created by a later take`).
3. The host detaches and re-attaches while a connect is parked: the parked connect is answered `503` `CONFIGURATION_ERROR` `not-sent` at detach, its launch record stays burnt, and re-attach does not resurrect it (Task 13 `detach during a parked connect answers 503 and re-attach does not resume it`).
4. `ensureService()` returns false (Android refused the foreground service): no port opens, the session stays IDLE and the launch record is kept unburnt for one retry within its life (Task 13 `ensureService false leaves IDLE with no listener`).
5. A POST body whose UTF-8 byte length differs from its character count (multibyte JSON): Kotlin reads exactly `Content-Length` bytes and rejects a body shorter or longer than declared (Task 6 `multibyte body is read by byte length`, `short body then EOF is 400`).

---

### Task 1: Workspace, baseline, merge of the iOS branch, spike S0, Kotlin test recipe

**Repo:** WT, then HW. **Assumes:** nothing. Spec 11 (S0), 6.9, 6.14.

**Files:**
- Create: `PKG/package.json` (name, `private: true`, version `0.0.0`, `main`/`types` `src/index.ts`, peers `@bsv/expo-wallet-toolbox`, `@bsv/sdk`, `expo-modules-core`, `expo-secure-store`; deps none; `files` list `android`, `app.plugin.js`, `expo-module.config.json`, `plugin`, `src`, `!**/node_modules`, `!**/build`), `PKG/.gitignore` (`node_modules/`, `.scratch/`, `android/jvmtest/build/`, `android/jvmtest/.gradle/`, `.build/`), `PKG/SPIKES.md`
- Test: `TB/__tests__/bridge/s0Registration.test.ts` (kept as a regression test)

**Interfaces:**
- Produces: `PKG/SPIKES.md` with sections `Baseline` (WT tsc error count, toolbox bridge jest pass count, HW tsc count and jest status, Chrome version on Pixel_9, `adb devices` state), `S0`, `KT`; `HW` worktree; the merged conformance demo code.

- [ ] Step 1: `git merge --no-ff feat/browser-bridge-ios` into `feat/browser-bridge-android` (the iOS branch holds the five demo commits `223b0fd3..921c7bde` incl. `demo/conformance/*` and `demo/bridgeWallet.ts`, which this branch lacks; only two docs commits diverge here). Resolve nothing by hand; if conflicts appear stop and record them. Commit message `chore(android-bridge): merge the iOS kit branch (conformance demo)`.
- [ ] Step 2: workspace. Mirror iOS Task 1 step 1: `WT/node_modules` as per-entry symlinks to `/Users/personal/git/bsv-wallet/node_modules` (memory note worktree-jest-package-link), `@bsv/expo-wallet-toolbox` and `@bsv/expo-android-wallet-bridge` linking into `packages/`. Record Baseline numbers. `git -C /Users/personal/git/ts/bitcoin-sv-wallet worktree add .claude/worktrees/android-bridge -b feat/android-wallet-bridge feat/safari-wallet-bridge`; `HW/node_modules` per-entry symlinks to the main host `node_modules` as the safari-bridge worktree does; record `HTSC` and `HJ` baselines.
- [ ] Step 3: S0 as jest assertions in `s0Registration.test.ts`, each must PASS today or its failure names an additive seam to add to Task 2: (a) `registerTransport({id:'android-loopback', attestation:'unattested', bindingMode:'explicit', requestAttention, deliverReconnectToken})` succeeds before `initBridgeRuntime` and flips `hasUnattestedTransport()` true and `onUnattestedTransportChange` fires; (b) the registration-order pin lives in Task 14, so (b) here only asserts that `onUnattestedTransportChange` listeners fire on register and unregister (the wallet-build effect is pinned in Task 14); (c) `createMemoryContinuity`-style fake `ContinuityStore.getOrCreate('android:https://example.com')` is accepted by `signDescribe`/`verifyDescribeProof` flow (the type is plain `string`, expected pass); (d) `getBindingRegistry().connectExplicit` with `attestation:'unattested'`, `launchProofVerified:true`, `reconnectToken` creates a binding; without `launchProofVerified` throws `CONFIGURATION_ERROR` `not-sent`; (e) `onSnapshotChange` is NOT called by `attachBridgeHost({hasWallet:false})` nor by its detach function when readiness stays `none` (documents the Task 2 gap; assert the current behaviour, Task 2 inverts it).
- [ ] Step 4: `KT` recipe. Create a throwaway standalone Gradle project in `PKG/.scratch/kt/` (`build.gradle` with `buildscript` classpath `org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.20`, `apply plugin: 'org.jetbrains.kotlin.jvm'`, `testImplementation 'junit:junit:4.13.2'`, `kotlin { jvmToolchain(17) }`) with one trivial test, run it with the cached wrapper distribution (see `KT`). Pass: `BUILD SUCCESSFUL` and one test run. If dependency resolution fails offline, retry online; if Gradle cannot run at all, record the fallback "Kotlin is verified by `HBUILD` and the emulator runs, and pure-JVM tests are compiled by `HBUILD` into the module's `src/test`" and say so at the top of `SPIKES.md`.
- [ ] Step 5: record results in `PKG/SPIKES.md`; commit `chore(android-bridge): package skeleton, baseline, S0 result` (the merge commit already exists).

### Task 2: Toolbox seams: hostAttached, assertAdvertisesResponder, testing PageClient, conformance cases

**Repo:** WT. **Consumes:** Task 1 S0 results. Spec 6.14 items 2, 3, 4, 7 and the "Shared conformance cases" paragraph.

**Files:**
- Modify: `TB/core/bridge/runtime.ts` (`BridgeSnapshot`, `freshSnapshot`, attach/detach/load paths), `TB/core/bridge/protocol/descriptor.ts` (new export), `TB/core/bridge/index.ts`, `TB/CHANGELOG.md` (Unreleased), `TB/__tests__/bridge/runtime.test.ts`, `TB/__tests__/bridge/conformance.test.ts` snapshot if the snapshot shape is serialised
- Create: `TB/core/bridge/testing/pageClient.ts`, `TB/core/bridge/testing/conformanceCases.ts`, `TB/__tests__/bridge/protocol/advertises.test.ts`, `TB/__tests__/bridge/testing/conformanceCases.test.ts`
- Test: `s0Registration.test.ts` assertion (e) is inverted here

**Interfaces:**
- Produces: `BridgeSnapshot.hostAttached: boolean` (false at start, true when hooks are set AND the runtime has loaded, false again after the detach function; every change goes through `setSnapshot`, so `onSnapshotChange` fires even when readiness does not change); `assertAdvertisesResponder(descriptor: Descriptor, responder: { type: 'http-json'; address: string }): void` (throws `ProofError` unless some descriptor endpoint has `type === 'http-json'` and an `address` with the same scheme, host and port as `responder.address`, comparing parsed `URL` parts, no path); from `testing/pageClient.ts`: `PageClient`, `Connection`, `DiscoveredProvider`, `RejectedProvider`, `isConnectionError` (types copied from `IOS/src/testing/pageClient.ts` with `DiscoveredProvider.handle` typed `unknown`; the iOS copy is left as is); from `testing/conformanceCases.ts`: `export const TRANSPORT_INDEPENDENT_CASES: ReadonlyArray<{ id: string; method?: WalletMethodName; run: ... }>` built from `BRIDGE_METHODS`, `MAX_BRIDGE_REQUEST_BYTES` and the error codec (all 28 methods round-trip, wallet error to `WireError`, request cap, response cap).

- [ ] Step 1: tests. `runtime.test.ts`: `hostAttached is false until attach and runtime load`, `attach with no wallet publishes hostAttached true while readiness stays none` and `detach publishes hostAttached false while readiness stays none` (both fire `onSnapshotChange`), `hostAttached flips false on detach even when readiness was ready`, `cold start: hostAttached false does not mean no wallet`. `advertises.test.ts`: `matching scheme host and port passes`, one test each for scheme, host, port and type mismatch throwing, `127.0.0.1 does not satisfy localhost`, `path in the responder address is rejected`. `conformanceCases.test.ts`: `28 method cases derived from BRIDGE_METHODS`, `case ids are unique`.
- [ ] Step 2: run `TBJ __tests__/bridge`, expect FAIL. Step 3: implement the four items (derive `hostAttached` from `isBridgeHostAttached()` and call a `refreshHostAttached()` helper at attach, detach and when the runtime's `isLoaded` turns true); export `assertAdvertisesResponder` from the descriptor module and the barrel. Step 4: `TBJ __tests__/bridge` PASS, `TSC` baseline.
- [ ] Step 5: commit `feat(bridge): hostAttached snapshot, assertAdvertisesResponder, testing PageClient`.

### Task 3: Toolbox loopback pure modules: hostCheck, endpoints, status, cors

**Repo:** WT. Spec 6.2 (Host check), 6.2.1 (advertised list), 6.6.1, 6.6.2.

**Files:**
- Create: `TB/core/bridge/loopback/{hostCheck,endpoints,status,cors}.ts`; export from `TB/core/bridge/index.ts` under a `loopback` namespace re-export
- Test: `TB/__tests__/bridge/loopback/{hostCheck,endpoints,status,cors}.test.ts`; extend `TB/__tests__/bridge/protocol/bundleSafe.test.ts` to walk `loopback/*` (no `react-native`, `expo-*`, `__DEV__`, `process.env`)

**Interfaces:**
- Produces: `allowedHosts(b: { port: number; ipv4: boolean; ipv6: boolean }): string[]` (`127.0.0.1:p`, `[::1]:p` when ipv6, `localhost:p` only when both); `isAllowedHost(value: string | undefined, bound: {...}): boolean`; `loopbackEndpoints(b): DescriptorEndpoint[]` (ids `json-ipv4`, `json-ipv6`, `json-localhost`, type `http-json`, address `http://127.0.0.1:p` etc.); `STATUS: Readonly<Record<StatusKey, number>>` and `statusForConnectionError(e: ConnectionError, situation?: StatusKey): number` encoding the 6.6.2 table (wallet error 400, `PROTOCOL_ERROR` 400, `PROVIDER_CHANGED` 412, `CONNECTION_CLOSED` 410, `RESOURCE_LIMIT` 429, not built 503, `USER_CANCELLED` 403, launch proof 403, oversize response 502); `corsHeaders(opts: { origin: string; kind: 'public' | 'binding' }): [string,string][]`; `preflightHeaders(req: { origin: string; requestHeaders?: string; privateNetwork?: boolean }): [string,string][]` (methods `GET, POST, DELETE, OPTIONS`; allow-headers intersection of the request's list with `Content-Type, BRC-185-Epoch, BRC-185-Instance, BRC-185-Key, BRC-185-Android-Binding`; `Access-Control-Allow-Private-Network: true` only when asked; `Cache-Control: no-store`; no max-age); `BASE_HEADERS` (no-store, nosniff, `Vary: Origin`).

- [ ] Step 1: tests: `allowedHosts both families includes localhost`, `ipv4 only omits localhost and [::1]`, `host with wrong port, missing, uppercase LOCALHOST and trailing dot are refused`, `endpoints list every bound spelling and is stable across calls`, `status table row per 6.6.2` (table-driven over every row), `cors never emits credentials, wildcard or null`, `preflight intersects requested headers (unlisted header dropped)`, `preflight echoes private-network only when asked`, `no max-age`, bundleSafe covers `loopback/`.
- [ ] Step 2–4: FAIL, implement, `TBJ __tests__/bridge` PASS, `TSC` baseline. Step 5: commit `feat(bridge): loopback host check, endpoints, status table, CORS`.

### Task 4: Toolbox loopback launch proof (the MACs)

**Repo:** WT. Spec 7.5 (all of it), 6.5 step 5. `@noble/hashes` HMAC-SHA256; JCS via existing `canonicalize` in `protocol/json.ts`.

**Files:**
- Create: `TB/core/bridge/loopback/launchProof.ts`, `TB/__tests__/bridge/loopback/fixtures/launch-vectors.json`
- Test: `TB/__tests__/bridge/loopback/launchProof.test.ts`

**Interfaces:**
- Produces (pure, sync): `helloMac(k: Uint8Array, p: { origin: string; challenge: string; host: string }): string`; `describeAck(k, p: { wallet: {instanceId: string; continuityKey: string}; origin; challenge; host; nonce: string }): string`; `launchProof(k, m: LaunchMessage): string`; `connectAck(k, m): string`; `bindingSecret(k, m): string` where `LaunchMessage = { wallet: {instanceId; continuityKey}; epoch; origin; challenge; host; nonce }`; `timingSafeEqualB64u(a: string, b: string): boolean`; `parseLaunchUri(uri: string, scheme: string): { epoch: string; k: Uint8Array; n: string } | undefined` (`v` must be `1`, `e` lowercase UUIDv4, `k` canonical b64url 32 bytes, `n` 16 bytes, no unknown or duplicate params, at most 512 bytes, host `launch`); `buildLaunchUri(...)` and `buildIntentLink(opts: { scheme; packageId; epoch; k; n; fallbackUrl? }): string` (page side).

- [ ] Step 1: tests (golden vectors computed once with an independent implementation, e.g. `openssl dgst -hmac`, recorded in the fixture with the exact JCS strings): `helloMac vector`, `describeAck vector`, `launchProof vector`, `connectAck vector`, `bindingSecret vector`, `labels make the five outputs differ for one input`, `each of origin, challenge, host, epoch, nonce, wallet identity changes launchProof`, `JCS key order independent of insertion order`, `parseLaunchUri accepts the spec shape` and refuses (table): `v=2`, uppercase epoch, 31-byte k, padded k, extra param, duplicate `k`, 513 bytes, wrong host, wrong scheme; `buildIntentLink round-trips through the Android intent URI rewrite` (assert exact `intent://launch?...#Intent;scheme=bsv-wallet-bridge;package=org.bsvblockchain.wallet;end` and that `S.browser_fallback_url` is url-encoded and absent when none); `timingSafeEqualB64u false on length difference`.
- [ ] Step 2–4: FAIL, implement, `TBJ __tests__/bridge/loopback` PASS. Step 5: commit `feat(bridge): launch proof MACs and launch URI`.

### Task 5: Toolbox loopback router

**Repo:** WT. **Consumes:** Tasks 2 to 4. Spec 6.5 (steps 1 to 8, outcome mapping, hold-open), 6.6, 6.7, 7.5, 7.6 (token header), 10 router list.

**Files:**
- Create: `TB/core/bridge/loopback/router.ts`; export from the barrel
- Test: `TB/__tests__/bridge/loopback/router.test.ts` (+ `routerConformance.test.ts` running `TRANSPORT_INDEPENDENT_CASES`, + `routerVectors.test.ts` for `0185-vectors.json` `descriptorProof` and a connect proof)

**Interfaces:**
- Produces: `createLoopbackRouter(env: RouterEnv): LoopbackRouter` with `handle(req: RawRequest): Promise<RoutePlan>`, `RawRequest = { id: string; method: string; target: string; headers: [string,string][]; body: string }` (header names already lowercased, as Kotlin supplies), `RoutePlan = { kind: 'respond'; status: number; headers: [string,string][]; body: string } | { kind: 'hold'; id: string; settled: Promise<RouteResponse> }`, `RouterEnv` injects: `transportId`, `bound(): {port; ipv4; ipv6}`, `identity(origin): Promise<ContinuityHandle>` (the `ContinuityStore`), `descriptorBase: { name; vendor; icon?; instanceLabel }`, `launches: { matchHello(p): Buffer-free record or undefined; take(epoch): LaunchRecordView | undefined /* marks used */ }`, `session: { gate(origin): 'ok' | 'unsettled'; readiness(): 'park'|'none-fail'|'go'; parkConnect(...); afterConnect(...) }`, `registry: BindingRegistry`, `connectExplicit`, `snapshot()`, `dispatch`, `isGone(id)`, `tokenOutbox: { take(epoch): string | undefined }`, `bindingSecrets: Map`-like, `allowLocalhostHttp: () => boolean`. Mirrors the status/steps exactly; uses `canonicalizeBridgeOrigin`, `parseStrictJson`, `isBridgeMethod`, `signDescribe`, `signConnect`, `validateDescriptor`, `assertAdvertisesResponder`, `registry.resolve`, `dispatch`, never re-implements them.

- [ ] Step 1: tests (fake env + real `dispatch` fake as in `dispatcher.test.ts` helpers). Path/verb/origin: `legacy path /getVersion is 404 without CORS`, `known path wrong verb is 405 with Allow`, `absolute-form, percent-encoded, dot-segment and non-canonical epoch targets are refused`, `missing, null, duplicate Origin is 403 empty without CORS`, `uppercase host and explicit default port origins are refused 403 without CORS` (Review Focus 1), `Originator and BRC-185-Context headers are 400 PROTOCOL_ERROR`. Describe: `noncanonical challenge is 400`, `unknown query parameter is 400`, `describe signs with the origin's identity and works with env.snapshot absent`, `describe response is byte-identical with no hello, a non-matching hello and an expired record`, `matching hello adds BRC-185-Android-Ack and consumes nothing`, `a hello made for another host or origin gets no ack`, `describe advertises the responder (assertAdvertisesResponder passes for every spelling in Host)`. Connect: `non-JSON content type is 415 and touches no launch record`, `identity mismatch is 412 and creates no binding`, `unknown or duplicate member is 400`, `unsettled gate answers 429 Retry-After 5 before the launch proof is burnt`, `bad, reused, expired or other-origin launch proof is 403 launch proof required (one fixed message)`, `five bad proofs do not lock out a good one`, `hostAttached false parks and attached+none answers 503`, `success returns signConnect body and BRC-185-Android-Ack`, `connectExplicit receives launchProofVerified true and the reconnect token`. RPC/disconnect: `each of the four headers missing, wrong, retired answers 412 like an unknown epoch`, `wrong BRC-185-Android-Binding is indistinguishable from unknown epoch`, `unknown method is 404 PROTOCOL_ERROR`, `RPC holds the response until the Outcome`, `Outcome mapping: ok 200, walletError 400 WireError, ConnectionError per table, >5 MiB result 502 RESOURCE_LIMIT unknown`, `reconnect token header attached once on the next response and exposed`, `CORS on RPC only for the binding's origin; 412 for another origin carries none`, `DELETE closes the binding, 204, second DELETE 412`, `client gone before consent makes beforeCall reject CONNECTION_CLOSED not-sent`.
- [ ] Step 2–4: FAIL, implement, `TBJ __tests__/bridge` PASS, `TSC` baseline. Step 5: commit `feat(bridge): loopback router (BRC-185 4.1 routes)`.

### Task 6: Kotlin JVM test harness, HttpParser, HttpWriter, HostCheck

**Repo:** WT. Spec 6.2 (HTTP subset, Host check), 10 Kotlin list. Follow the `KT` recipe of Task 1.

**Files:**
- Create: `PKG/android/jvmtest/{settings.gradle,build.gradle}` (sourceSets: main from `../src/main/kotlin` with an explicit `include` list of the pure files only, test from `../src/test/kotlin`), `PKG/android/src/main/kotlin/org/bsv/walletbridge/{HttpParser,HttpWriter,HostCheck}.kt`, tests in `PKG/android/src/test/kotlin/org/bsv/walletbridge/{HttpParserTest,HttpWriterTest,HostCheckTest}.kt`
- Pure JVM: no `android.*` imports in any file in the include list.

**Interfaces:**
- Produces: `class HttpParser(limits: Limits = Limits.DEFAULT, clock: () -> Long)` with `fun readRequest(input: InputStream): ParseResult`; `sealed class ParseResult { Ok(method, target, headers: List<Pair<String,String>>, body: ByteArray) ; Reject(status: Int, reason: String, closeSilently: Boolean) }`; `object HttpWriter { fun response(status: Int, headers: List<Pair<String,String>>, body: ByteArray): ByteArray }` (adds `Content-Length`, `Connection: close`; no `Server`/`Date`); `object HostCheck { fun allowed(host: String?, port: Int, ipv4: Boolean, ipv6: Boolean): Boolean }` (mirrors `allowedHosts` of Task 3, with a parity fixture JSON shared with the jest test).

- [ ] Step 1: tests: smuggling set (`duplicate Origin is 403`, `duplicate Host is 403`, `other duplicate header is 400`, `duplicate Content-Length 400`, `non-numeric Content-Length 400`, `Transfer-Encoding 411`, `bare LF 400`, `obs-fold 400`, `Expect 417`, `pipelined extra bytes rejected`, `HTTP/1.0 answered as 1.1`), caps (`request line 2049 B 414/400`, `65 header lines`, `head over 16384`, `Content-Length over 5 MiB is 413 and the body is not read`), targets (`absolute-form, asterisk, authority-form 400`, `target never percent-decoded`), methods (`PUT 405` (Kotlin gates verbs only; the router in Task 5 is authoritative for paths, 404 and per-path 405)), body (`multibyte body is read by byte length`, `short body then EOF is 400` (Review Focus 5), `non-UTF-8 body 400`), timing (`slow-trickle head over 10 s with fake clock rejected`, `body over 30 s rejected`, `no timeout applies once handed off`), writer (`always Connection: close and exact Content-Length`, `no Server or Date`), host (`parity with the shared allowed-host fixture`).
- [ ] Step 2: `KT` FAIL. Step 3: implement. Step 4: `KT` PASS. Step 5: commit `feat(android-bridge): strict HTTP parser, writer, host check`.

### Task 7: Kotlin PortAllocator and classifyBindError

**Repo:** WT. Spec 6.2.1, 10.

**Files:**
- Create: `PKG/android/src/main/kotlin/org/bsv/walletbridge/PortAllocator.kt`, `PKG/android/src/test/kotlin/org/bsv/walletbridge/PortAllocatorTest.kt`; add to the jvmtest include list

**Interfaces:**
- Produces: `enum class BindErrorKind { IN_USE, UNAVAILABLE, OTHER }`; `fun classifyBindError(e: Throwable): BindErrorKind` (walks the cause chain; messages `EADDRINUSE`, `Address already in use`, `bind failed: EADDRINUSE (Address already in use)`, unavailable set from spec 6.2.1, `ErrnoException` matched by class name with `errno` read reflectively, 98 in use, 99 or 97 unavailable); `class BoundListener(val port: Int, val v4: ServerSocket, val v6: ServerSocket?)`; `class PortAllocator(basePort: Int = 3321, maxOffset: Int = 63) { fun bind(): BoundListener }` throwing `PortsExhausted` or `BindFailed(errnoText)`.

- [ ] Step 1: tests with real loopback sockets: `free port binds lowest 3321 on both families`, `taken v4 moves up`, `taken v6 only closes v4 and moves up` (needs `::1` on the CI host; skip with `Assume` when absent), `no ::1 interface succeeds v4 only`, `other errors surface as BindFailed and never move up`, `exhaustion throws PortsExhausted`, `every bound socket isLoopbackAddress`, `serve, close and rebind returns the same port`, `a live second listener still fails`, classifier table for Android-style, desktop-style and errno cases.
- [ ] Step 2–4: FAIL, implement (`setReuseAddress(true)` before bind), `KT` PASS. Step 5: commit `feat(android-bridge): dual-family exclusive port allocator`.

### Task 8: Kotlin LaunchIntent, LaunchStore, NotificationSpec

**Repo:** WT. Spec 6.3, 6.10, 7.5 (Platform handling), 10.

**Files:**
- Create: `PKG/android/src/main/kotlin/org/bsv/walletbridge/{LaunchIntent,LaunchStore,Attention}.kt` (only the pure `NotificationSpec` builder in `Attention.kt`), tests `{LaunchIntentTest,LaunchStoreTest,NotificationSpecTest}.kt`; add to the jvmtest include list

**Interfaces:**
- Produces: `object LaunchIntent { fun validate(uri: String?, scheme: String): String? }` (scheme match, host `launch`, at most 512 bytes; returns the URI or null; never parses secrets); `class LaunchStore(clock: () -> Long, capacity: Int = 32, ttlMs: Long = 120_000) { fun put(uri: String): Long /* seq */; fun take(): List<Taken> /* destructive, drops expired, Taken(seq, uri, ageMs) */; fun size(): Int }` (oldest unused displaced when full); `data class NotificationSpec(channelId, importance, visibility, text, publicText, immutable: Boolean)` with `NotificationSpecs.session(sites: Int, waiting: Int)`, `NotificationSpecs.attention()`.

- [ ] Step 1: tests: `validate accepts the spec URI and refuses wrong scheme, wrong host, 513 bytes, null`, `put assigns increasing sequence numbers`, `take returns every unexpired entry once and empties the store`, `entries older than 120 s are dropped on put and on take`, `ageMs is measured from the creation stamp`, `capacity 32 displaces the oldest`, `a second take is empty`, `session spec names no site and is VISIBILITY_PRIVATE with public text BSV Wallet and FLAG_IMMUTABLE`, `attention text is generic: A website wants to continue. Tap to review.`, `session text counts only`.
- [ ] Step 2–4: FAIL, implement, `KT` PASS. Step 5: commit `feat(android-bridge): launch intent, launch store, notification spec`.

### Task 9: Kotlin LoopbackServer and Timers

**Repo:** WT. **Consumes:** Tasks 6 to 8. Spec 6.2, 7.1 (Kotlin timers).

**Files:**
- Create: `PKG/android/src/main/kotlin/org/bsv/walletbridge/{LoopbackServer,Timers}.kt`, `PKG/android/src/test/kotlin/org/bsv/walletbridge/LoopbackServerTest.kt` (JVM-runnable: the server depends only on `java.net`, `Timers` takes an injected `Scheduler` interface so the Android `Handler` binding lives in the module file); add `LoopbackServer.kt` to the jvmtest include list

**Interfaces:**
- Produces: `class LoopbackServer(allocator: PortAllocator, listener: Listener)` with `fun start(): BoundListener`, `fun stop(reason: String)`, `fun respond(id: String, status: Int, headers: List<Pair<String,String>>, body: String): Boolean` (false if peer gone), `fun abort(id: String)`; `interface Listener { fun onRequest(r: RequestEvent); fun onClientGone(id: String); fun onServerStopped(reason: String) }`; 32-connection cap with `503`, Host check before `onRequest`, client-gone watcher, one thread per connection; `interface Scheduler { fun postDelayed(name: String, ms: Long, fn: () -> Unit); fun cancel(name: String) }`, `class Timers(scheduler, emit: (String) -> Unit) { fun set(name: String, ms: Long); fun clear(name: String) }`.

- [ ] Step 1: tests with a real client socket: `valid request reaches onRequest with lowercased headers`, `wrong Host never reaches onRequest and gets 403`, `held response stays open for 3 s with no timeout and completes on respond`, `client close fires onClientGone and respond returns false`, `33rd connection gets 503 Retry-After 1`, `stop closes held connections and fires onServerStopped once`, `no listener remains after stop (rebind succeeds immediately)`, `Timers: set replaces a same-named timer, clear cancels, fake scheduler fires emit(name)`.
- [ ] Step 2–4: FAIL, implement, `KT` PASS. Step 5: commit `feat(android-bridge): loopback server and timers`.

### Task 10: Android module: Expo module, service, trampoline, library manifest, R8 rules

**Repo:** WT; HW scratch wiring for the compile check. **Consumes:** Tasks 6 to 9. Spec 6.1 (layout), 6.2 (native surface), 6.3 (manifest), 6.10, 7.4 (M1 rows), 9.

**Files:**
- Create: `PKG/expo-module.config.json`, `PKG/android/{build.gradle,consumer-rules.pro}`, `PKG/android/src/main/AndroidManifest.xml`, `PKG/android/src/main/kotlin/org/bsv/walletbridge/{BsvAndroidBridgeModule,BridgeService,LaunchTrampolineActivity}.kt`
- Modify: `PKG/android/src/main/kotlin/.../Attention.kt` (Android notification posting around `NotificationSpec`)

**Interfaces:**
- Produces: `BsvAndroidBridgeModule` exposing exactly the M1 surface of spec 6.2: `startServer({basePort,maxOffset}) -> {port, ipv4, ipv6}`, `stopServer`, `respond(id,status,headers,body) -> Boolean`, `abortConnection`, sync `takeLaunches() -> {seq, uri, ageMs}[]`, sync `elapsedRealtime()`, `setTimer(name, ms)`, `clearTimer(name)`, `ensureService() -> Boolean`, `setSession({sites, waiting})`, `stopSession`, `postAttention({kind})`, `cancelAttention`, `notificationPermission`, `requestNotificationPermission`, `returnToBrowser` (`moveTaskToBack(true)` of the foreground activity only if the bridge raised it); events `onRequest`, `onClientGone`, `onServerStopped`, `onLaunch {seq}`, `onTimer {name}`; `CodedException`s `ERR_PORTS_EXHAUSTED`, `ERR_BIND_FAILED`, `ERR_NO_ACTIVITY`. Manifest per 6.3 (M1 only: permissions `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`, `INTERNET`; exported `LaunchTrampolineActivity` with `Theme.NoDisplay`, `excludeFromRecents`, `noHistory`, `taskAffinity=""` and NO intent filter (the plugin adds it); non-exported `BridgeService` `specialUse` with the subtype property). Trampoline: validate via `LaunchIntent`, `LaunchStore.put`, start `getLaunchIntentForPackage` with a sequence extra and no data at most once per 3 s, `finish()`, emit `onLaunch` if the module is alive. Service: notification from `NotificationSpec`, `START_NOT_STICKY`, 60 s no-server self-stop as a Kotlin `Handler` timer, Disconnect action. `consumer-rules.pro` keeps the module, `LaunchTrampolineActivity`, `BridgeService`.

- [ ] Step 1: no unit test (Android classes). Add a manifest-lint test in `PKG/__tests__/manifest.test.ts` that parses the manifest XML and asserts: exactly one `exported="true"` component (the trampoline), service `exported="false"` with `foregroundServiceType="specialUse"` and the `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` property, no `SYSTEM_ALERT_WINDOW`, no receiver, no `BridgeSheetActivity`.
- [ ] Step 2: `KJ __tests__/manifest.test.ts` FAIL, implement all files, PASS.
- [ ] Step 3: compile check. In `HW` (scratch, uncommitted): install the kit with a `link-kit.sh` adapted from `IOS/scripts/link-kit.sh` (create `PKG/scripts/link-kit.sh`, same unique-version tarball recipe, packing the toolbox and this kit), run `HBUILD` to `:app:assembleDebug`. Pass: the module compiles and autolinks (look for `BsvAndroidBridgeModule` in `android/app/build/generated/.../ExpoModulesPackageList.kt`). Fix compile errors until it builds. Note: the intent filter is added by the plugin (Task 11), so for this step only add the plugin entry stub if the build needs it.
- [ ] Step 4: commit `feat(android-bridge): Expo module, foreground service, launch trampoline, library manifest`.

### Task 11: Config plugin

**Repo:** WT. **Consumes:** Task 10. Spec 6.3 (plugin), 6.13 item 2, 10 Plugin list.

**Files:**
- Create: `PKG/app.plugin.js`, `PKG/plugin/{index,validate,manifest}.js`, tests `PKG/__tests__/plugin/{validate,manifest,hostUntouched}.test.js`

**Interfaces:**
- Produces: `withAndroidWalletBridge(config, options: { scheme?: string })`; `resolveScheme(config, options): string` (default `<android.package>.bridge`; RFC 3986 scheme syntax, lowercase, not equal to any scheme the host declares); a manifest mod adding to `LaunchTrampolineActivity` (`tools:node="merge"`) the one filter: action `VIEW`, categories `DEFAULT` and `BROWSABLE`, `<data android:scheme="<scheme>" android:host="launch"/>`; warnings (not errors) when `android.permissions` or `blockedPermissions` imply `SYSTEM_ALERT_WINDOW` use or `allowBackup` is `true`.

- [ ] Step 1: tests: `default scheme is the package plus .bridge`, `explicit scheme bsv-wallet-bridge is used`, `uppercase, spaced or host-colliding scheme throws a named error`, `manifest snapshot: the trampoline gets exactly one filter with the scheme and host launch`, `the trampoline is never touched by withIconAliasLinks` (run the host's `plugins/withIconAliasLinks.js` copy from `HW` or a fixture of it over the merged manifest and assert no alias copies the bridge filter), `no SYSTEM_ALERT_WINDOW, network security config, App Link, boot receiver or queries entry is added`, `allowBackup true warns`, `plugin changes nothing else in a fixture host config`, `no process.env in plugin/`.
- [ ] Step 2–4: FAIL, implement, `KJ __tests__/plugin` PASS. Step 5: commit `feat(android-bridge): config plugin`.

### Task 12: Kit native types, fake native, ContinuityStore

**Repo:** WT. **Consumes:** Tasks 2, 4, 10. Spec 6.2 (surface), 6.9, 6.12.

**Files:**
- Create: `PKG/src/{native.ts,index.ts}`, `PKG/src/testing/fakeNative.ts`, `PKG/src/continuity/secureStoreContinuity.ts`
- Test: `PKG/__tests__/{fakeNative,continuity}.test.ts`

**Interfaces:**
- Produces: `BsvAndroidBridgeNative` (the 6.2 TS surface, M1 only) and `getBsvAndroidBridge()` (lazy `requireNativeModule`); `createFakeNative(opts?: { now?: () => number }): FakeNative` with `emitRequest`, `emitGone`, `emitLaunch`, `advance(ms)` (drives named timers), `pushLaunch(uri, ageMs)`, `responses` capture, `ensureServiceResult` toggle, same destructive `takeLaunches` semantics as Kotlin; `deriveContextIdentity(master: Uint8Array, ctx: string, gen: number): { instanceId: string; seed: Uint8Array; continuityKey: string }` (the single derivation seam); `createSecureStoreContinuity(deps?: { secureStore; random }): ContinuityStore & { setTestSeed?(seed: Uint8Array): void }` (LRU 32 handles, serialised signing, `sign` prefix check importing the two prefixes from core, `reset(ctx)` bumps `gen`, `reset('all')` replaces the master and wipes the cached array; works with the wallet locked).

- [ ] Step 1: tests: `HKDF output pinned for a fixed master and two origins and the two identities differ`, `instanceId is a lowercase UUIDv4`, `descriptorProof vector from 0185-vectors.json reproduced through the store with the vector seed injected`, `sign refuses a preimage without a known prefix and accepts a real describe preimage and a real connect preimage`, `describe signing is serialised`, `second getOrCreate for one origin does not touch SecureStore`, `reset(ctx) changes that context's identity only`, `reset all changes every identity`, `requireAuthentication false is passed`, `seed and derived bytes never appear in console output`, fake native: `takeLaunches is destructive and drops entries older than 120 s`, `named timers fire in order under advance`.
- [ ] Step 2–4: FAIL, implement, `KJ` PASS, `TSC` baseline. Step 5: commit `feat(android-bridge): native types, fake native, continuity store`.

### Task 13: Controller I: launch registry, session machine, unsettled gate, token outbox

**Repo:** WT. **Consumes:** Tasks 4, 5, 12. Spec 6.7, 7.1, 7.2, 7.5 (On receipt), 7.6, 10 session list.

**Files:**
- Create: `PKG/src/controller/{launchRegistry,session,unsettledGate,tokenOutbox,redact}.ts`
- Test: `PKG/__tests__/controller/{launchRegistry,session,unsettledGate,tokenOutbox}.test.ts`

**Interfaces:**
- Produces: `createLaunchRegistry(deps: { native: Pick<Native,'takeLaunches'|'elapsedRealtime'>; scheme: string }): LaunchRegistry` with `ingest(): void` (pulls and parses via `parseLaunchUri`, stores `{epoch, k, n, expiresAt = now + 120 s - ageMs, used, parked}`, tombstones burnt epochs 10 min, capacity 32 evicting oldest unused unparked, never a parked one), `matchHello(p): LaunchRecordView | undefined` (constant-time over at most 32; consumes nothing), `take(epoch): LaunchRecordView | undefined` (marks used before returning, undefined if used, expired or unknown), `markParked(epoch, parked: boolean)`; `createSession(deps): Session` with states `IDLE | ARMED | ACTIVE`, `onLaunch()`, `onHostAttached(attached: boolean)`, `onBindingClosed`, `onConnect()`, `onServerStopped()`, timers `armed`, `chain`, `reaper`, `unsettled:<epoch>`, `parked:<id>` through `native.setTimer`; `createUnsettledGate(): { check(origin): boolean; claim(origin, epoch): void; release(epoch): void; isOwner(origin, epoch): boolean }`; `createTokenOutbox(): { put(epoch, token): void; take(epoch): string | undefined; confirmWritten(epoch): void; drop(epoch): void }`; `redact(text: string): string`.

- [ ] Step 1: tests (fake native, fake timers): registry: `duplicate epoch in one take yields one record`, `burnt epoch is not re-created by a later take` (Review Focus 2), `expiry uses the Kotlin age: a launch aged 119 s has 1 s left`, `hello matches the right one of 32 and consumes nothing`, `eviction displaces the oldest unused, never a parked one; full of parked drops the new URI`, `take marks used before anything else can fail`, `invalid URIs are dropped silently`, `k and e never appear in logs`. Session: `launch arms: ensureService then startServer(3321, 63)`, `ensureService false leaves IDLE with no listener and keeps the record unburnt` (Review Focus 4), `armed expires 120 s after the last launch`, `chain cap 10 min even with a stream of launches`, `a parked connect keeps ARMED until resolved or its 10-minute deadline`, `connect moves to ACTIVE, last binding closing with no live record returns to IDLE`, `host detach stops server and closes all lost, a live record re-arms only on re-attach`, `detach during a parked connect answers 503 and re-attach does not resume it` (Review Focus 3), `parked connects capped at 4 (fifth 429)`, `reaper closes idle 30 min only without parked or in-flight requests`, `unsettled 60 s closes lost only with nothing parked`, `server stop closes all lost`. Gate: `second same-origin connect refused before the proof is burnt`, `two bindings parked through a core fake: only the owner receives the token`, `abandoned parked connect closes disconnected and withdraws consent`. Outbox: `delivered once on the first response`, `kept after a failed write`, `dropped on close`, `never in logs`.
- [ ] Step 2–4: FAIL, implement, `KJ __tests__/controller` PASS. Step 5: commit `feat(android-bridge): launch registry, session machine, unsettled gate, token outbox`.

### Task 14: Controller II: native glue, setupAndroidBridge, AndroidBridgeHost, attention

**Repo:** WT. **Consumes:** Tasks 5, 12, 13. Spec 6.12, 6.7, 7.2, 7.4 (attention table, way back), 6.10 (notification permission).

**Files:**
- Create: `PKG/src/controller/{controller,attention}.ts`, `PKG/src/{setup.ts,AndroidBridgeHost.tsx}`; modify `PKG/src/index.ts`
- Test: `PKG/__tests__/{controller,attention,setup,host}.test.ts(x)`

**Interfaces:**
- Produces: `setupAndroidBridge(o: { appName: string; vendor: string; allowLocalhostHttp?: boolean }): void` (forwards `allowLocalhostHttp` by calling `configureToolbox({ browserBridge: { allowLocalhostHttp } })` and passes `() => getBrowserBridgeConfig().allowLocalhostHttp === true && __DEV__` to the router env, so the core and the router agree; module scope, idempotent under Fast Refresh, Android only; registers the transport BEFORE the wallet is built, creates the router with the real `dispatch`, wires `onRequest` to `router.handle` and `respond`, drains `takeLaunches()`; opens no port); `<AndroidBridgeHost />` (renders the small `AndroidBridgeNotices` banner described below, otherwise null; feeds the main-in-front signal from `AppState`, subscribes `onSnapshotChange` for `hostAttached`/readiness, requests `POST_NOTIFICATIONS` once at the first accepted launch, `setSession` counts, 600 ms hysteresis via Kotlin timer `returnToBrowser`); `resetAndroidBridge(): Promise<void>` (registered on `registerSessionTeardown(['logout'])`: `reset('all')`, stop server and session); `ANDROID_TRANSPORT_ID = 'android-loopback'`; `AndroidBridgeNotices` (rendered by `AndroidBridgeHost`, top of screen, only while relevant) shows `bridge_notifications_off` when `notificationPermission()` is not granted and a request is pending, `bridge_ports_exhausted` after `ERR_PORTS_EXHAUSTED`, and `bridge_not_ready_android` after a `503` for attached-with-no-wallet; each has a `testID` of the same name; `requestAttention` per the 7.4 table (in front: nothing; not in front: `postAttention('consent'|'prompt')`; `wallet-not-ready` after launch: nothing, later: notification); `onPromptRaised` updates the waiting count only; `deliverReconnectToken` goes to the token outbox only for the unsettled owner.

- [ ] Step 1: tests with the fake native and the real P1 dispatcher: `all 28 methods round-trip over the controller`, `wallet error is 400 WireError`, `cold start: hostAttached false parks the connect, attach with a wallet resumes, attach with none answers 503`, `connect while building parks and resumes on ready`, `client gone before consent rejects CONNECTION_CLOSED not-sent`, `unknown delivery on a response over 5 MiB`, `registration-order test: the unverified manager exists when the transport is registered at module scope and is missing when registered after the build`, `logout reset closes bindings lost and rotates identities`, `notification permission asked once at the first accepted launch and not again after denial`, `no postAttention when AppState is active`, `postAttention generic kinds only`, `returnToBrowser fires 600 ms after the last pending item and not while one is pending`, `token never reaches a non-owner binding`, `server stop reason closes all lost`, `setupAndroidBridge twice registers once`, `allowLocalhostHttp true reaches both configureToolbox and the router env and is false in a non-DEV build`, `each notice renders for its condition and not otherwise (three testIDs)`.
- [ ] Step 2–4: FAIL, implement, `KJ` PASS, `TSC` baseline. Step 5: commit `feat(android-bridge): controller, setup entry, host component`.

### Task 15: Toolbox UI: stable test ids and copy

**Repo:** WT. Spec 7.4 (stable test ids are an M1 deliverable), 6.13 item copy, 12 locales.

**Files:**
- Modify: `TB/ui/components/ui/PermissionSheet.tsx`, `TB/core/i18n/translations.tsx` (strings: `bridge_notifications_off`, `bridge_ports_exhausted`, `bridge_not_ready_android`, in all 12 locales: "Turn on notifications so BSV Wallet can tell you about later requests", "Another program is using the ports BSV Wallet needs", "Create or restore a wallet in BSV Wallet first"), `TB/CHANGELOG.md`
- Test: `TB/__tests__/ui/PermissionSheet.test.tsx`, `TB/__tests__/i18n/bridgeAndroidWording.test.ts`

**Interfaces:**
- Produces: `testID="bridge-connect-origin"` on the connection sheet's origin text, `testID="bridge-approve"` on the Approve/Connect button and `testID="bridge-deny"` on Deny/Don't connect, for the connection kind and every other kind (the ids are shared; one sheet is visible at a time); no visual change.

- [ ] Step 1: tests: `connection sheet exposes bridge-connect-origin with the full ASCII origin`, `approve and deny carry the stable ids for connection, spending, protocol and basket kinds`, `existing snapshots unchanged`, wording test over all 12 locales for the three keys with placeholders kept.
- [ ] Step 2–4: FAIL, implement, `TBJ __tests__/ui __tests__/bridge __tests__/i18n` PASS. Step 5: commit `feat(bridge): stable test ids and Android copy`.

### Task 16: Stand-in loopback page client with squatter and relay fixtures

**Repo:** WT. **Consumes:** Tasks 2, 4, 5 and 13. Spec 6.16, 7.7, 10 (squatter test, blocker-level). Every test here wires `inMemoryHttp` to the REAL router (Task 5) over the REAL launch registry (Task 13), never a fake matcher; otherwise the squatter, replay and relay tests prove nothing.

**Files:**
- Create: `PKG/src/testing/loopbackPageClient.ts`, `PKG/src/testing/inMemoryHttp.ts` (a fake `fetch` that dispatches to a router or fixture by `host:port`), `PKG/__tests__/{loopbackPageClient,squatter}.test.ts`

**Interfaces:**
- Produces: `createLoopbackPageClient(win: LoopbackWindow, opts: LoopbackOptions): LoopbackPageClient` implementing the toolbox `PageClient` plus `launch(): { epoch: string }` (builds `k`, `n`, `e` and the intent link via `buildIntentLink`; navigates `win.location.href` on a user gesture), `permission(): Promise<'granted'|'prompt'|'denied'|'exempt'|'unsupported'>` (queries `loopback-network`, retries `local-network-access`), `elicit(): Promise<void>` (one eliciting GET, no deadline); `LoopbackOptions = { scheme; packageId; fallbackUrl?; basePort?: number /*3321*/; window?: number /*64*/; attemptTimeoutMs?: number /*3000*/; roundMs?: number /*500*/; totalMs?: number /*15000*/; parallel?: number /*16*/; fetch; setTimeout; tokenStore }`. `discover()` scans ports with a fresh challenge and `hello` per attempt (host = `host:port` fetched), verifies `verifyDescribeProof`, `assertAdvertisesResponder`, then `BRC-185-Android-Ack`; stops at the first authenticated endpoint; unauthenticated responders are reported `unauthenticated` and sent nothing; `connect()` sends the launch proof to the authenticated endpoint only, verifies connect proof and ack, derives the binding secret, pins the `continuityKey` only after the ack, stores a reconnect token only from an ack-verified response, sends `BRC-185-Android-Binding` on RPC and DELETE, honours `429 Retry-After`, never retries `unknown`.

- [ ] Step 1: tests against the real router through `inMemoryHttp`: `happy path describe, connect, getVersion, getPublicKey, disconnect`, `stops scanning at the first authenticated endpoint`, `squatter on 3321 with the real name, icon and vendor and no k: refused unauthenticated, not pinned, receives no epoch, launch proof or token (fixture records every byte and the test asserts none appears), real wallet on 3322 is connected` (blocker-level), `a squatter that never answers its describe does not delay the real wallet`, `relay fixture forwarding 3321 to 3322 fails hello and proof because host is bound`, `captured connect replayed to the real wallet is refused by the burnt record`, `token is stored only after ack verification and sent only to a key-matched ack-verified endpoint`, `429 on connect surfaces Retry-After and offers a new click`, `412 on RPC means reconnect from launch, never replay`, `no legacy route is ever requested`, `permission names tried in order`, `wallet did not open after 15 s`.
- [ ] Step 2–4: FAIL, implement, `KJ` PASS, `TSC` baseline. Step 5: commit `feat(android-bridge): stand-in loopback page client`.

### Task 17: Demo page, shared conformance panel, build and serve

**Repo:** WT. **Consumes:** Task 16, the merged iOS demo (Task 1). Spec 6.16.

**Files:**
- Create: `PKG/demo/{index.html,demo.ts,main.ts,build.mjs,serve.mjs}`, `PKG/__tests__/demo.test.ts`
- Modify (type-only): `IOS/demo/bridgeWallet.ts`, `IOS/demo/conformance/controller.ts`, `IOS/demo/demo.ts` to import `PageClient`, `Connection`, `isConnectionError` types from `@bsv/expo-wallet-toolbox/core/bridge/testing/pageClient` so one panel serves both kits; iOS jest must stay green

**Interfaces:**
- Produces: `node PKG/demo/serve.mjs` on port 3000; buttons describe, connect, `getVersion`, `isAuthenticated`, `getPublicKey({identityKey:true})`, `createAction`, disconnect, **Open wallet** (user-gesture intent link), **Permission** (query result for both names), port-window field (default 3321, offsets 0 to 63), per-attempt timeout field (default 3000), log distinguishing blocked, absent, refused, unauthenticated; query overrides `?scheme=&package=&fallback=`; the Conformance panel (Run all safe, per-card Run for spending cards, Stop, results table, Copy report) imported from `IOS/demo/conformance/*` and `IOS/demo/bridgeWallet.ts` through relative paths (dev tool, both packages in one monorepo; relocating it into the toolbox is a follow-up); `build.mjs` esbuild target `chrome100`, alias for `@bsv/wallet-toolbox-client` as the iOS build does.

- [ ] Step 1: tests: `demo wires every button to the loopback client`, `Open wallet performs navigation only from a click handler with nothing awaited before it`, `query overrides change the launch target`, `createAction button sends the marker in the description`, `conformance panel mounts on #demo-root and Run all safe skips spending cards`, `demo bundle is excluded from package files`; iOS: `IOS` jest suite unchanged green after the type-only edit.
- [ ] Step 2–4: FAIL, implement, `KJ __tests__/demo.test.ts` and `KJ` and iOS `npx jest --ci packages/expo-safari-wallet-bridge` PASS; `node PKG/demo/build.mjs` succeeds. Step 5: commit `feat(android-bridge): demo page with the shared conformance panel`.

### Task 18: Walking skeleton on Pixel_9 and spikes S1, S2, S5, S5b, S7

**Repo:** WT for results; HW scratch. **Consumes:** Tasks 10, 11, 14, 17. Spec 11 (S1, S2, S5, S5b, S7; S8 for the record), 6.10.

**Files:**
- Modify: `PKG/SPIKES.md`; HW scratch wiring only (kit via `link-kit.sh`, plugin entry `['@bsv/expo-android-wallet-bridge', { scheme: 'bsv-wallet-bridge' }]`, the `setupAndroidBridge({ appName: 'Bitcoin SV Wallet', vendor: 'org.bsvblockchain.wallet', allowLocalhostHttp: true })` call in `HW/index.js` after the crypto bootstrap and before `require('expo-router/entry')`, `<AndroidBridgeHost />` beside `<PermissionSheet />` in `HW/app/_layout.tsx`)
- Spike-only code lives in one commit `wip(android-bridge): spike probes` that Step 5 reverts

- [ ] Step 1: `EMU` preflight; record Chrome version. `HBUILD`, install on Pixel_9, `adb reverse tcp:3000 tcp:3000`, serve the demo, create or restore a test wallet. Pass: app starts, `adb logcat` shows no crash.
- [ ] Step 2: S2 on the emulator: from the demo, tap Open wallet in Chrome: no chooser, trampoline runs, wallet comes forward; the URI never appears in `adb logcat -d | grep -c "k="` (0), nor reaches the router (add a temporary `Linking` listener log); a launch without a gesture is blocked; fallback URL when the package is uninstalled (`adb uninstall` then retry; reinstall); a rapid second launch; incognito tab. Record. The real-phone rows are owner device gates listed in Step 6.
- [ ] Step 3: S5 and S5b: hold a `getVersion`-style slow request (a `createAction` left at the sheet) for 30 minutes with Chrome in front, screen off, `adb shell dumpsys deviceidle force-idle`; confirm the response completes and the process lives; `adb shell am kill` the app: page sees a clean connection error; "Don't keep activities" with the service alive closes bindings per spec 7.1. S5b: with the wallet's activities finished, measure a JS `setTimeout` (expected to stall), a Kotlin timer and native-event-to-JS latency; if the JS timer does not stall, still keep Kotlin timers (spec decision), record it.
- [ ] Step 4: S7: which family Chrome tries for `localhost`; a wrong `Host` returns 403; describe latency while the wallet builds (cold launch from a killed app) against the 3000 ms per-attempt timeout, 10 runs, record median and worst; adjust the demo default only if worst exceeds 3000 and say so.
- [ ] Step 5: S1 (needs Chrome 142+): if the AVD Chrome is older, record "device gate" and run the `exempt` path only; otherwise run the https path from `https://deggen.ngrok.app` (start `ngrok http --url=deggen.ngrok.app 3000` if not running) and record `permissions.query` state, prompt label, `127.0.0.1`/`[::1]`/`localhost` reachability, mixed content. S8 recorded as not run (informational). Revert the spike commit, commit `docs(android-bridge): spikes S1 S2 S5 S5b S7`.
- [ ] Step 6: `SPIKES.md` gets "Device gates for the owner": S1 and S2 on a real phone with a Chrome 142+ build, OEM background-start behaviour, ngrok path in a release build with R8, Play Console `specialUse` declaration.

### Task 19: Host adoption in bitcoin-sv-wallet

**Repo:** HW (branch `feat/android-wallet-bridge`). **Consumes:** Tasks 11, 14, 15. Spec 6.13. Re-run `link-kit.sh` first; discard Task 18 scratch edits with explicit `git checkout -- <file>` per file.

**Files:**
- Modify: `app.config.js` (plugin entry `['@bsv/expo-android-wallet-bridge', { scheme: 'bsv-wallet-bridge' }]` beside the Safari one; the Safari entry is a plain plugin, not `legacyPlugin`, so follow that), `index.js` (call `setupAndroidBridge({ appName: 'Bitcoin SV Wallet', vendor: 'org.bsvblockchain.wallet', allowLocalhostHttp: __DEV__ })` under `Platform.OS === 'android'`, after the crypto bootstrap and before `require('expo-router/entry')`), `app/_layout.tsx` (`<AndroidBridgeHost />` inside `BrowserBridgeProvider` beside `<PermissionSheet />`), `app/+native-intent.ts` (`redirectSystemPath` returns `/` for any URL beginning with `bsv-wallet-bridge://`), `package.json` (only the jest `transformIgnorePatterns` allow-list gains `@bsv/expo-android-wallet-bridge`; the dependency line is added at release, `link-kit.sh` supplies it until then)
- Test: `__tests__/nativeIntent.test.ts`, `__tests__/isolation.test.js`, new `__tests__/androidBridgeHost.test.tsx`

- [ ] Step 1: tests: `redirectSystemPath returns / for bsv-wallet-bridge://launch?...`, `isolation: no sharedUserId, app groups or keychain access groups added by the Android kit`, `blockedPermissions still contains SYSTEM_ALERT_WINDOW and allowBackup is false`, `the resolved config contains the plugin entry and the bridge scheme is not one of the host's other schemes`, `the Android registration runs before the wallet build` (import order assertion on `index.js`), `Delete Wallet reaches resetAndroidBridge once`.
- [ ] Step 2: `HJ` FAIL. Step 3: implement. Step 4: `HJ` and `HTSC` (baseline) PASS; `HBUILD` succeeds and the manifest merge shows the single exported trampoline with the `bsv-wallet-bridge` filter (`unzip -p` the debug APK's manifest via `aapt2 dump xmltree`, or read `android/app/build/intermediates/merged_manifests`).
- [ ] Step 5: commit in HW `feat(android-bridge): adopt the Android bridge kit`. Stage only the listed files; the `link-kit.sh` lockfile changes are not committed (set at release, after the toolbox 0.22.0 release gate).

### Task 20: Emulator end-to-end

**Repo:** WT for the script and evidence; HW for the build. **Consumes:** everything. Spec 10 (Emulator end to end).

**Files:**
- Create: `PKG/scripts/e2e/{run.mjs,adb.mjs,chrome.mjs,cases.mjs}` (node, `puppeteer-core` installed in `PKG` devDependencies only; DevTools via `adb forward tcp:9222 localabstract:chrome_devtools_remote`; `Input.dispatchMouseEvent` for user gestures; `uiautomator dump` + `adb shell input tap` for the wallet using `bridge-approve`, `bridge-deny`, `bridge-connect-origin`), `docs/superpowers/evidence/android-kit/*.png`
- Chrome first-run: write `/data/local/tmp/chrome-command-line` with `chrome --disable-fre --no-default-browser-check --no-first-run` and `adb shell am set-debug-app --persistent com.android.chrome`

- [ ] Step 1: `EMU` preflight (fix `unauthorized`), install the Task 19 debug build, `adb reverse tcp:3000 tcp:3000`, `node PKG/demo/serve.mjs`, record Chrome version. If Chrome is older than 142 the https/ngrok cases are marked "device gate" and every case below runs on `http://localhost:3000`.
- [ ] Step 2: cases, each with a screenshot and a stated pass condition, run by `run.mjs` and logged as pass/fail: (1) cold launch from Chrome with the app process dead: Open wallet, wallet comes forward, unlock if needed, the Connect sheet shows `localhost:3000` Unverified, Connect, page shows connected; (2) `getVersion` and `isAuthenticated` answer; (3) `getPublicKey({identityKey:true})` and a held-open `createAction` across the sheet, Approve, page gets the result; (4) Don't connect: page gets 403 `USER_CANCELLED`, nothing granted; (5) warm launch and silent reconnect with the token (no connect sheet); (6) conformance panel Run all safe: record the pass/fail table (a failing card is recorded, not hidden); (7) kill the app mid-session (`am kill`), page recovers through a new launch; (8) "Don't keep activities" destroying MainActivity with the service alive: bindings close, page gets `412` and reconnects; (9) ports 3321 and 3322 held by a test socket: wallet takes 3323 and the page finds it; (10) `::1:3321` held alone (real Android bind messages): wallet moves up; (11) a squatter app (second test socket serving a descriptor under its own key) on 3321 with the real name: page refuses it; (12) `adb shell pm revoke org.bsvblockchain.wallet android.permission.POST_NOTIFICATIONS`: the `bridge_notifications_off` notice (testID) shows and Open wallet is offered for a pending request; (13) incognito tab; (14) plaintext check: no `k=` or epoch in `adb logcat -d` from the run, and no reconnect token in logs.
- [ ] Step 3: the Chrome permission dialog, OEM rows and the real-phone passes remain device gates in `SPIKES.md`.
- [ ] Step 4: commit `test(android-bridge): emulator end-to-end run and evidence`.

### Task 21: Docs, conformance notes, changelogs, release gates, M2 appendix

**Repo:** WT. Spec 6.12, 12, 11 (release gates), 14.

**Files:**
- Create: `PKG/README.md` (adoption: plugin option, host edits of 6.13, `setupAndroidBridge`, `AndroidBridgeHost`, the two test paths, the way back to Chrome is Back or the app switcher, Chrome 142+, limits), `PKG/CONFORMANCE.md` (profile choices, the extensions list of spec 12 verbatim, the 400/412 deviations, what is NOT claimed), `PKG/CHANGELOG.md` (0.0.0 entry)
- Modify: `TB/CHANGELOG.md` (Unreleased: `hostAttached`, `assertAdvertisesResponder`, `core/bridge/loopback/`, testing exports, test ids and copy)

- [ ] Step 1: full suites green: `TSC` baseline, `TBJ` (whole package, no `--forceExit`), `KJ`, `KT`, iOS `npx jest --ci packages/expo-safari-wallet-bridge`, `HJ`, `HTSC`.
- [ ] Step 2: write the docs; `SPIKES.md` lists the release gates (toolbox 0.22.0 release by tag `expo-wallet-toolbox-v0.22.0` with package jest run without `--forceExit`, Play Console `specialUse` declaration and data-safety line, R8 release build verification per the memory note with `dexdump` of the trampoline, service and module, independent review before any BRC-185 conformance claim).
- [ ] Step 3: prettier on touched files only; commit `docs(android-bridge): README, conformance notes, changelogs`.

---

## Appendix A: Milestone 2 (overlay), gated

Spec 6.0, 6.11, 7.4, S3, S4, S6. Not planned beyond the first task; the rest is planned only if S4 passes, and dropped if it fails. Whether the owner still wants M2 is open question 1 (spec 14).

### Task A1: Spike S4, the "hello" sheet on a second React root (hard gate)

**Repo:** WT for results; HW scratch. **Assumes:** M1 complete and Task 20 green.

- [ ] Step 1: scratch only (no committed kit code): a non-exported translucent `BridgeSheetActivity` (`ReactActivity`, component `BsvBridgeSheet`, default delegate on `(application as ReactApplication).reactHost`, theme `Theme.AppCompat.DayNight.NoActionBar` translucent, `taskAffinity=${applicationId}.bridge`) and `AppRegistry.registerComponent('BsvBridgeSheet', …)` in `HW/index.js` before the router entry, rendering a text node, started from the trampoline when a scratch flag says warm.
- [ ] Step 2: run on Pixel_9 and one real phone; pass criteria from spec 11 S4: hello renders over Chrome with Chrome visible behind; `onHostDestroy` never fires for a live `MainActivity`; `AppState` follows spec 7.4; the host's `AppState` listeners (`useRequests`, `useVaultKeys`, `NotifyPrompt`) behave; the sheet Activity never starts in the cold-start-without-MainActivity case; the router never receives a URI. Record in `SPIKES.md`.
- [ ] Step 3: pass: plan M2 (relay, owner gate, lifecycle tracker, tapjacking, overlay `returnToBrowser`, `setHostState`, S3 and S6) as a follow-up plan. Fail: record "M2 dropped", delete this appendix from the spec's open list, and ship foreground mode.
