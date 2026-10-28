# Browser Bridge iOS Safari Kit (Project 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@bsv/expo-safari-wallet-bridge`: a Safari Web Extension, a sealed App Group request queue, an Expo native module and JS adapter, the app runtime and UI, and an Expo config plugin, so a page in iOS Safari can use Bitcoin SV Wallet as its BRC-100 wallet through the P1 core.

**Architecture:** One pure Swift package (`BsvBridgeQueue`) is the sealed queue, continuity key and native-message router, linked into both the app (through an Expo module) and the Safari appex. The extension JS (pure `lib/` modules plus thin entry scripts) speaks BRC-185 to the page and stages records through the appex; the app drains them through P1's inbox processor and mirrors its state back as one sealed file. Small P1 changes land first (exports, store contract, merged Connect sheet). The host adopts the kit with one plugin entry and a short list of edits.

**Tech Stack:** TypeScript, React Native/Expo SDK 57, Swift (CryptoKit, XCTest, SwiftPM), Safari Web Extension MV3, `@bacons/apple-targets` 5.0.0, esbuild, jest, `@bsv/sdk` 2.8, P1 core in `@bsv/expo-wallet-toolbox`.

**Spec:** `docs/superpowers/specs/2026-10-28-browser-bridge-ios-kit-design.md` (revision 2, approved 2026-10-28, synchronous logout reset kept). Section numbers below (6.4, 12 item 4…) refer to it. Read the spec section named in each task before starting. Also read: P1 plan `docs/superpowers/plans/2026-10-27-browser-bridge-core.md`, BRC-185 `/Users/personal/git/docs/BRCs/wallet/0185.md`, spike `/Users/personal/git/bsv-wallet/.claude/worktrees/agent-a08d7f8c35a456bad/spikes/ios-handoff-links/FINDINGS.md`.

## Global Constraints

**Repos and names**
- `WT` = `/Users/personal/git/bsv-wallet/.claude/worktrees/browser-bridge-ios`, repo bsv-wallet, branch `feat/browser-bridge-ios`. `TB` = `WT/packages/expo-wallet-toolbox`. `PKG` = `WT/packages/expo-safari-wallet-bridge`. Never touch `master`.
- `HOST` = `/Users/personal/git/ts/bitcoin-sv-wallet`, repo bitcoin-sv-wallet, branch `feat/safari-wallet-bridge` (create from `main` in Task 1 if absent). Never commit to `main`. Host tasks say "Repo: HOST".
- Every task names its repo. A task never edits both repos in one commit.

**Spike branches (Tasks 1 and 2 record the outcome in `PKG/SPIKES.md`; later tasks assume the default and list the delta for the fallback)**
- S1 sub-results: `S1.root` ok / `S1.targets` (fallback: plugin writes `targets/safari-bridge/`); `S1.kc` keychain key passes through / `S1.kcfile` (fallback: plugin writes the appex entitlements file); `S1.pod` shared pod / `S1.fileref` (fallback: same Swift files compiled into both targets by file reference); `S1.bespoke` (fallback if apple-targets is unusable: own `withXcodeProject` target creator).
- S6 sub-results: `S6.group` explicit bridge keychain group (default) / `S6.appgroup` (fallback: App Group id used as keychain group, no `keychain-access-groups` entitlement). If no shared key is possible at all: STOP and return to the owner.
- Default assumed everywhere: `S1.root`, `S1.kc`, `S1.pod`, `S6.group`.

**Identifiers (spec 6.2, derived from `ios.bundleIdentifier` = `B`, never typed)**
- URL scheme `B` (lowercased); handoff URL `<B>://bridge?v=1&n=<nonce>`. Extension bundle id `B.safari`. App Group `group.B`. Bridge keychain group `$(AppIdentifierPrefix)B.bridge`; host group `$(AppIdentifierPrefix)B` listed first in the app's `keychain-access-groups`. Transport id `safari-extension` (must start with `safari`). Team id from `ios.appleTeamId` (`SV8SWTHA2H` for the host). Plugin writes `BSVBridgeAppGroup`, `BSVBridgeKeychainGroup`, `BSVBridgeScheme` into both Info.plists; Swift never hard-codes them.

**Values (verbatim from the spec)**
- Sealing: AES-256-GCM (CryptoKit), fresh random 96-bit nonce per file, stored `nonce ‖ ciphertext ‖ tag`, AAD `"bsv-bridge/v1|" + kind + "|" + id`, `kind` in `record | result | event | mirror | chunk:<n>`. Key: generic-password, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synchronised, explicit `kSecAttrAccessGroup`; the app creates it, the extension never does. Protection class `completeUntilFirstUserAuthentication` and `isExcludedFromBackup` set at every launch of either process on the directory and every file.
- Layout `<AppGroup>/bridge/`: `tmp/ ids/ pending/ accepted/ claimed/ withdrawn/ results/ events/ meta/(key-check, boot, mirror.sealed) stage/<id>/<n>`. State is where the file is; transitions are `rename(2)`; ids are create-exclusive via `link(2)`.
- Lifetimes: `notAfter = createdAt + 15 min`; result purge 15 min from creation; id tombstones 40 min; stage chunks 15 min; events at most 1024 and 24 h; epoch horizon 24 h; closing grace 5 s; native op timeout 5 s, 3 attempts; `STAGE_CHUNK_BYTES` default 48 KiB (Task 13 sets it); `HANDOFF_COALESCE_MS` 3000; poll steps 1 s, 2 s, 5 s (cap 5 s, off when hidden); `sweepExpired` every 60 s while active.
- Extension in-flight caps across all tabs (in `storage.session`): 4 per epoch, 16 total, 5 MiB total; binding caps 8 per origin, 64 overall; `MAX_BRIDGE_REQUEST_BYTES = 5 * 1024 * 1024`. Violations are `RESOURCE_LIMIT` / `not-sent`, local, before staging.
- Continuity: Ed25519 per context `safari` / `safari-private` (from `sender.tab.incognito`; non-boolean means private); native `sign` accepts only a preimage starting with `BRC-185 descriptor v1\n` and at most 16 KiB; describe response at most 16384 bytes.
- Manifest: MV3, non-persistent background (`"scripts"`), permissions exactly `nativeMessaging`, `storage`, `tabs` (a larger list makes Safari disable the extension), `host_permissions` and content-script matches `https://*/*` (plus `http://localhost/*` only in the plugin's `development` profile, which sets build constant `allowLocalhostHttp`), `all_frames: true`, `run_at: document_start`, page-world script as a second entry with `"world": "MAIN"`.
- Extension `lib/` and its bundle import only P1's pure `core/bridge/protocol/*` modules (no `__DEV__`, no `../../config`, never `errorCodec`; `InboxResult.error` is relayed raw).
- Swift builds with `APPLICATION_EXTENSION_API_ONLY`, never touches `UIApplication`, Xcode default formatting.
- No `process.env` in `PKG`; host settings are plugin options and props. Raw sources shipped, no build output committed. Prettier (no semicolons, single quotes, no trailing commas, `arrowParens: avoid`, width 120) only on files you touched, never `prettier --write .`.
- i18n: every new string is a key in `TB/core/i18n/translations.tsx` in all 12 locales (`en es zh hi fr ar pt bn ru id ja pl`); `__tests__/i18n/translationParity.test.ts` must pass. The glyph "◀ Safari" is never translated.
- Commit messages are conventional (`feat(safari-bridge): …`) and end with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never bare `git stash`.

**Verification commands (each task uses the ones it names)**
- `TSC`: from `WT`, `npx tsc --noEmit -p .` must equal the baseline error count recorded in `PKG/SPIKES.md` (Task 1).
- `TBJ <paths>`: from `WT`, `npx jest --ci` with each path prefixed `packages/expo-wallet-toolbox/` (so `TBJ __tests__/bridge __tests__/services` runs both directories). `KJ [paths]`: the same for `packages/expo-safari-wallet-bridge/` (`KJ __tests__/ext` runs `PKG/__tests__/ext`; bare `KJ` runs the whole kit). Never `--forceExit`. Root jest (`preset jest-expo`, `testMatch **/__tests__/**/*.test.[jt]s?(x)`) already collects both packages, `.js` plugin tests included.
- `SW`: `swift test --package-path PKG/swift/BsvBridgeQueue` (macOS host; runs everything). `XC`: from `PKG/swift/BsvBridgeQueue`, `xcodebuild test -scheme BsvBridgeQueue -destination 'platform=iOS Simulator,id=1FD448B1-95C8-40AA-AEAB-8E3D15484313'` (iPhone 18 Pro, iOS 27.0, booted); it runs the suite minus the cross-process `RaceTests`, which are `#if os(macOS)` because iOS has no `Process`.
- `HJ [path]`: from `HOST`, `npx jest --ci [path]`; `HTSC`: from `HOST`, `npx tsc --noEmit`, baseline recorded in Task 1.
- `HBUILD`: from `HOST`, `npx expo prebuild --platform ios --no-install` then `xcodebuild -workspace ios/BitcoinSVWallet.xcworkspace -scheme BitcoinSVWallet -destination 'platform=iOS Simulator,id=1FD448B1-95C8-40AA-AEAB-8E3D15484313' build` (set `LANG=en_US.UTF-8`; Metro on port 8082).
- `E2E`: the Simulator runs Safari against the demo page (Task 21) on `http://localhost:3000` (development profile) or `https://deggen.ngrok.app` (tunnels to localhost:3000; start `ngrok http --url=deggen.ngrok.app 3000` if not running). Evidence screenshots: `xcrun simctl io booted screenshot WT/docs/superpowers/evidence/ios-kit/<NN>-<name>.png`.
- Jest tests for pure TS use fake `browser` APIs and the fake native module; Swift and Safari behaviour is only proven by `SW`/`XC`/`E2E`.

## Review Focus

Failure modes the spec implies that no spec test list names; each has a test in the named task.
1. Wake before first unlock (or key missing): the appex must answer a typed `CONFIGURATION_ERROR` / `not-sent` for every op, never hang and never crash (Task 10 `unreadable key replies KEY_MISSING`, Task 14 `describe with unavailable key rejects CONFIGURATION_ERROR`).
2. A torn, truncated or foreign-key mirror file must read as `absent` (no announce, no local answers, epochs closed `lost`), never a stale answer (Task 9 `corrupt mirror syncs as absent`, Task 14 `corrupt mirror behaves as absent`).
3. The page repeats an invoke id after the background reloaded (session storage intact) between stage and reply: no second record (Task 15 `repeat invoke after background reload does not stage twice`).
4. A call staged and in flight when the container disappears (logout, Delete Wallet): the page's promise must reject `CONNECTION_CLOSED` with delivery `unknown`, not hang and not claim `not-sent` (Task 15 `in-flight call when mirror becomes absent rejects unknown`).
5. A result that arrives again for an id the page already resolved (ack failed, second poll) is ignored and re-acked, not delivered twice (Task 15 `second result for a resolved id is ignored and re-acked`).

---

### Task 1: Spike S1 (build plumbing, gating) and workspace setup

**Repo:** WT for setup and `SPIKES.md`; HOST for the throwaway prebuild. **Assumes:** nothing.

**Files:**
- Create: `PKG/package.json` (name `@bsv/expo-safari-wallet-bridge`, `private: true` until release, peer `@bsv/expo-wallet-toolbox`, devDeps `@bacons/apple-targets@5.0.0`, `esbuild` at the newest version at least two weeks old, both pinned exactly), `PKG/.gitignore` (`node_modules/`, `.scratch/`), `PKG/SPIKES.md`
- Modify: `WT/tsconfig.json` (`exclude` gains `packages/*/node_modules`, so the kit's own installed dependencies are not type-checked by `TSC`)
- Create: `PKG/swift/BsvBridgeQueue/{Package.swift,BsvBridgeQueue.podspec,Sources/BsvBridgeQueue/Stub.swift}` (one public function; replaced in Task 8), `PKG/scripts/link-kit.sh`
- Modify (HOST, throwaway working-tree edits, not committed): `app.config.js`, `package.json`

**Interfaces:**
- Produces: `PKG/SPIKES.md` with sections `Baseline` (tsc error count in WT and HOST, jest status), `S1` (each sub-result with evidence), later `S2`…`S7`. The dev-link recipe `link-kit.sh` described below.

- [ ] Step 1: workspace setup. WT has no `node_modules`: create it as a directory of per-entry symlinks to `/Users/personal/git/bsv-wallet/node_modules` entries (including `.bin`), with `@bsv/` a real directory whose `expo-wallet-toolbox` entry points at `../../packages/expo-wallet-toolbox` and whose `expo-safari-wallet-bridge` entry points at `../../packages/expo-safari-wallet-bridge` (see memory note worktree-jest-package-link; baseline tsc has a few pre-existing errors). Install `esbuild` and `@bacons/apple-targets` into `PKG/node_modules` only (`npm install --legacy-peer-deps` run inside `PKG`), never into the symlinked tree. Record Baseline in `SPIKES.md`: `npx tsc --noEmit -p .` error count, `npx jest --ci packages/expo-wallet-toolbox/__tests__/bridge` pass count, and the same for HOST (`HTSC`, `HJ`).
- [ ] Step 2: HOST branch and dev-link recipe. `git -C HOST switch -c feat/safari-wallet-bridge` (or switch if it exists). Write `PKG/scripts/link-kit.sh`: `npm pack` the toolbox and the kit with a unique prerelease version suffix per run (`0.0.0-dev.<epoch>`, version edited in a temp copy, to dodge the npm `file:` tarball cache) and `npm install --no-save` both tarballs into HOST. Every host task re-runs it after changing WT packages.
- [ ] Step 3: run the S1 experiment in HOST: add `@bacons/apple-targets@5.0.0`; a scratch plugin (in `PKG/.scratch/`, uncommitted) that adds a `safari` target (bundle suffix `.safari`, frameworks `SafariServices`) with apple-targets' `root` option pointing at a git-ignored directory; the stub pod linked from the app and from the target's `pods.rb`.
- [ ] Step 4: pass criteria, all must hold: (1) `HBUILD`'s prebuild creates a target named for the extension with bundle id `org.bsvblockchain.wallet.safari`, embedded in the app, and HOST `targets/` is untouched; (2) the target's `.entitlements` contains `keychain-access-groups` with `$(AppIdentifierPrefix)org.bsvblockchain.wallet.bridge` and the App Group; (3) `xcodebuild … build` succeeds under the host's static frameworks and `nm` on the appex binary shows the stub symbol (pod shared, not duplicated into the app only); (4) `npx expo config --json` shows `extra.eas.build.experimental.ios.appExtensions` with the extension bundle id and its entitlements. Record each as pass/fail with the command output.
- [ ] Step 5: for each failed criterion apply its fallback and re-run until the criterion passes: (1) `S1.targets`; (2) `S1.kcfile`; (3) `S1.fileref`; if the target cannot be created at all, `S1.bespoke`. Record the branch taken and the exact plugin option or file that made it work. Discard only the HOST files you edited (`git -C HOST checkout -- app.config.js package.json package-lock.json`; delete `targets/` only if it did not exist before the run; leave the gitignored `ios/` in place, prebuild regenerates it); never `git checkout -- .`, never commit there.
- [ ] Step 6: commit in WT `chore(safari-bridge): package skeleton, S1 result`. Deltas for later tasks: `S1.targets` changes only `plugin/target.js` (Task 12); `S1.kcfile` only `plugin/entitlements.js`; `S1.fileref` changes `plugin/target.js` and the podspec dependency in Task 11; `S1.bespoke` replaces `plugin/target.js` wholesale.

### Task 2: Spike S6 (shared sealing key, keychain upgrade, gating)

**Repo:** WT for `SPIKES.md`; HOST for the experiment. **Assumes:** S1 recorded; default `S1.root/kc/pod` (apply recorded deltas).

**Files:**
- Modify: `PKG/SPIKES.md` (section `S6`); `PKG/swift/BsvBridgeQueue/Sources/BsvBridgeQueue/Stub.swift` (throwaway `spikeKeyWrite()` / `spikeKeyHash()`, removed at the end)

**Interfaces:**
- Produces: the recorded `S6.group` or `S6.appgroup` branch that Tasks 8, 10, 11, 12 and 20 assume.

- [ ] Step 1: with the S1 setup, build HOST **without** the kit first (`HBUILD` on `feat/safari-wallet-bridge` before any kit edit, which equals `main`), install on the Simulator, create a new wallet through the UI, and note its identity key and that secure-store items exist. Query the Simulator keychain (`sqlite3 ~/Library/Developer/CoreSimulator/Devices/1FD448B1-95C8-40AA-AEAB-8E3D15484313/data/Library/Keychains/keychain-2.db "select agrp, svce from genp"`) and record the `agrp` values. If the Vault cannot be exercised (it is mainnet-only), say so in `SPIKES.md`; it stays a device gate (Task 22).
- [ ] Step 2: build HOST with the kit plugin scratch (entitlements from Task 1 output, host group first) and `simctl install` over the existing install. Pass criteria: (1) the app opens as the same wallet with the same identity key and no re-onboarding; (2) a new `expo-secure-store` item written after the upgrade has an `agrp` ending `org.bsvblockchain.wallet` (host group), and the old items are unchanged; (3) a throwaway Expo module in `PKG/.scratch/spike-module` (uncommitted; exposes `spikeKeyWrite()` and `spikeKeyHash()` over the stub pod, called once from a throwaway `useEffect` in HOST `app/_layout.tsx`) writes a 32-byte generic-password with explicit group `…bridge`, `AfterFirstUnlockThisDeviceOnly`, and the appex handler (stub) reads it and returns the SHA-256 of the bytes in a native message reply that the popup prints (screenshot `01-s6-popup.png`); the app logs the same hash; the `agrp` of that item ends `.bridge`.
- [ ] Step 3: if (3) fails because iOS rejects the group, switch to `S6.appgroup` (use `group.org.bsvblockchain.wallet` as the keychain group, no `keychain-access-groups` entitlement) and repeat criteria (1) to (3). If neither works: STOP, record, and return to the owner without starting any later task.
- [ ] Step 4: record in `SPIKES.md`: branch taken, evidence, and the explicit note that the Simulator does not enforce access groups faithfully so the real-signing check and the upgrade over real Vault items stay device gates (listed in Task 22). Remove the throwaway functions; commit `docs(safari-bridge): S6 result`.

### Task 3: P1 exports, bundle-safe constants, revision and cold-start pins

**Repo:** WT. **Assumes:** nothing from the spikes. Spec 6.15 items 1, 2, 4, 8, 9; 6.8 Bundle safety.

**Files:**
- Create: `TB/core/bridge/protocol/constants.ts` (pure: `ADMIN_ORIGINATOR` and `LEGACY_ADMIN_ORIGINATOR`, values moved verbatim from `TB/core/config.tsx:58,61`; `unverifiedOriginator.ts` imports only `protocol/limits` and is already pure)
- Modify: `TB/core/config.tsx` (re-exports the two constants from the pure module, so existing importers are unchanged), `TB/core/bridge/protocol/origin.ts:8`, `TB/core/bridge/permissionPolicy.ts:14` (import the pure module), `TB/core/bridge/index.ts` (exports), `TB/core/bridge/runtime.ts` (only if the cold-start test fails)
- Test: `TB/__tests__/bridge/exports.test.ts`, `TB/__tests__/bridge/protocol/bundleSafe.test.ts`, extend `TB/__tests__/bridge/runtime.test.ts`

**Interfaces:**
- Produces, all from `@bsv/expo-wallet-toolbox/core/bridge`: `createInboxProcessor, InboxStore, InboxProcessor, type Dispatcher, type Outcome, inboxDigest, resolveInboxResult, createMemoryInboxStore, dispatch, getTransport, onBindingClosed, isBridgeHostAttached, initBridgeRuntime, getBindingRegistry, registerSessionTeardown, type TeardownReason` (the teardown pair is re-exported from `../context/sessionTeardown`; plan decision), plus the `protocol/*` pure modules the extension bundles (`canonicalizeBridgeOrigin`, `descriptor` functions, `connectionError` builders, `envelopes` types and guards, `limits`, `base64url`, `json`, `methods`).

- [ ] Step 1: tests `exports.test.ts` (each name above is exported and defined), `bundleSafe.test.ts` (static import-graph walk from every `core/bridge/protocol/*.ts`: no `config`, `react-native`, `expo-*`, `core/context`, `@bsv/wallet-toolbox-mobile`, `__DEV__`, `process.env`; and `permissionPolicy.ts` has no `../config`), `runtime.test.ts`: `walletRevision bumps on profile, network and rebuild manager replacement` (item 8), `attach on an install with a wallet is building from attach until first publish, never none` (item 9).
- [ ] Step 2: run, expect FAIL for exports, bundleSafe and (possibly) the cold-start test.
- [ ] Step 3: implement. If the cold-start test fails, change `attachBridgeHost`/`initBridgeRuntime` minimally so that, for an install with a wallet, the snapshot is `building` between attach and the first publish (hook field `hasWallet` supplied by the provider if needed), and say so in the commit body.
- [ ] Step 4: `TBJ __tests__/bridge` and `TBJ __tests__/context` PASS; `TSC` at baseline.
- [ ] Step 5: commit `feat(bridge): export the transport API, bundle-safe origin constants`.

### Task 4: P1 store contract: events retention and gap, rawBytes to the harness, flushEvents

**Repo:** WT. Spec 6.15 items 6 and 7; 6.4 events; 6.6.

**Files:**
- Modify: `TB/core/bridge/inbox.ts:65-70` (contract) and the processor (`flushEvents`), `TB/core/bridge/memoryInboxStore.ts` (retention options, `evictedThrough`, drop `rawBytes` from the store), `TB/__tests__/bridge/inboxContract.ts`, `TB/__tests__/bridge/inbox.test.ts` (`.events` at the `readEventsAfter` call sites)
- Test: the contract runner itself, run by the memory-store test

**Interfaces:**
- Produces: `readEventsAfter(seq: number): Promise<{ events: InboxCloseEvent[]; gap: boolean }>` (`gap` true when `seq < evictedThrough`); `InboxProcessor#flushEvents(): Promise<void>` (resolves when every close event raised so far is durable); `createMemoryInboxStore(opts?: { maxEvents?: number; maxEventAgeMs?: number; now?: () => number })` defaults 1024 and 24 h; `interface StoreHarness { store: InboxStore; restart(): InboxStore; rawBytes?: () => Uint8Array[] }` (today's harness plus the optional `rawBytes`) and the unchanged `runInboxStoreContract(name: string, makeStore: (clock: Clock) => StoreHarness)`.

- [ ] Step 1: contract tests (added to `inboxContract.ts`): `gap is true after trimming past the cursor`, `no gap at the boundary (seq equals evictedThrough)`, `retention by count (1025th event trims the first)`, `retention by age (24 h)`, `plaintext marker test calls harness.rawBytes and fails loudly if the harness omits it`; `inbox.test.ts`: `flushEvents resolves only after every raised close event is written`, `flushEvents resolves immediately when none pending`.
- [ ] Step 2: run, FAIL. Step 3: implement; the memory harness supplies its own `rawBytes`. Step 4: `TBJ __tests__/bridge` PASS, `TSC` baseline.
- [ ] Step 5: commit `feat(bridge): events gap and retention, flushEvents, harness-owned rawBytes`.

### Task 5: P1 onPromptRaised

**Repo:** WT. Spec 6.15 item 5; 6.7 receipts.

**Files:**
- Modify: `TB/core/bridge/runtime.ts` (`TransportRegistration`, `notifyPromptRaised` at ~375), `TB/core/context/WalletContext.tsx` (only if a queue lacks `onEnqueue`)
- Test: extend `TB/__tests__/bridge/runtime.test.ts`; `TB/__tests__/context/promptEnqueue.test.tsx`

**Interfaces:**
- Produces: `TransportRegistration.onPromptRaised?(binding: Binding): void`, called for every live binding of the originator before the active-app gate; `requestAttention('prompt')` stays behind the gate.

- [ ] Step 1: tests `onPromptRaised fires in the foreground`, `fires only for bindings of that originator`, `requestAttention prompt still skipped when active`, `a throwing onPromptRaised does not stop the others`, and `basket, certificate, protocol and spending queues each call notifyPromptRaised on enqueue` (drive each queue's `onEnqueue`).
- [ ] Step 2–4: FAIL, implement, `TBJ __tests__/bridge/runtime.test.ts __tests__/context` PASS. Step 5: commit `feat(bridge): onPromptRaised transport hook`.

### Task 6: Merged Connect sheet, core plumbing (peek and mint)

**Repo:** WT. Spec 6.12 (Merged Connect sheet), 6.15 item 3, 5 anti-goals on Connect and Don't connect.

**Files:**
- Modify: `TB/core/services/signingPermissionPolicy.ts` (two public methods), `TB/core/bridge/dispatcher.ts` (~365, `previewGroup` dep, awaited under `untilClosed` with a short timeout before `requestConsent`), `TB/core/bridge/consent.ts` (`groupPermissions` on the request and `PendingConsent`; mint after recording), `TB/core/bridge/runtime.ts` and `BrowserBridgeProvider.tsx` (wire `previewGroup` and `mint` to the build's managers: the attested manager for `browser`, the unverified manager for `unattested`)
- Test: extend `TB/__tests__/bridge/{consent,dispatcher,integration}.test.ts`, `TB/__tests__/services/signingPermissionPolicy.test.ts`

**Interfaces:**
- Produces: `SigningPolicyPermissionsManager#peekGroupPermissions(originator: string): Promise<GroupPermissions | null>` (through the same `fetchManifestPermissions` and its 5-minute cache that the later check reads; ask-every-time protocols already filtered); `#mintGroupedPermissions(originator: string, group: GroupPermissions): Promise<void>` (the per-item grant path `grantGroupedPermission` uses for a granted item; items that already hold a token are skipped; find the seam in `@bsv/wallet-toolbox-mobile`'s `WalletPermissionsManager` and mirror it); `ConsentRequestInput.groupPermissions?: GroupPermissions | null`; `PendingConsent.groupPermissions?`; `ConsentStoreDeps.mint?: (originator: string, group: GroupPermissions) => Promise<void>`; `DispatcherDeps.previewGroup?: (binding: Binding) => Promise<GroupPermissions | null>` (timeout 2000 ms; failure, timeout or empty manifest resolve to `null`, giving the plain sheet).

- [ ] Step 1: tests against the real manager: `peek uses the same cached fetch the later check reads` (one network fetch for peek plus check), `peek failure, timeout and empty manifest give null`, `mint creates a token for every listed item and skips items already holding one`, `after mint the group check raises no sheet`, `verified: spending authorization is minted with its amount; unattested: spending is already stripped`, `mint failure after consent is recorded keeps the connection and the later group check falls back to today's group sheet`, `Don't connect (decline) mints and records nothing` (spec anti-goal), `mint lists exactly what the sheet showed` (compare `PendingConsent.groupPermissions` to minted set), `already connected sites skip the sheet`, `in-app browser path unchanged`.
- [ ] Step 2–4: FAIL, implement, `TBJ __tests__/bridge __tests__/services` PASS, `TSC` baseline. Step 5: commit `feat(bridge): peek and mint the manifest group at connect`.

### Task 7: Merged Connect sheet, rendering and copy

**Repo:** WT. **Consumes:** Task 6 (`PendingConsent.groupPermissions`). Spec 6.12.

**Files:**
- Modify: `TB/ui/components/ui/PermissionSheet.tsx` (connection kind), the existing grouped-permission section renderer (extract a read-only variant), `TB/core/i18n/translations.tsx` (12 locales)
- Test: extend `TB/__tests__/ui/PermissionSheet.test.tsx`, `TB/__tests__/bridge/consentSheetSource.test.ts`, snapshot under `TB/__tests__/bridge/__snapshots__/`, extend `TB/__tests__/i18n/bridgeConnectionWording.test.ts`

**Interfaces:**
- Produces: keys `bridge_connect`, `bridge_dont_connect` (connection kind's own buttons; shared `authorize` and `reject` untouched). The sheet renders the P1 connect information, then the listed permissions read-only in the existing sections (spending with amount, protocols, baskets, certificates), no checkbox, no switch; buttons **Connect** (consent plus mint) and **Don't connect** (decline, `USER_CANCELLED`, P1's 30 s backoff).

- [ ] Step 1: tests `no switch or checkbox is rendered for any listed group`, `lists spending with its amount for browser attestation and omits it for unattested`, `plain sheet when groupPermissions is null`, `buttons are Connect and Don't connect`, `Don't connect answers decline and starts the 30 s backoff`, `the in-app browser sheet is unchanged` (existing snapshot), `waitForAuthentication after connect no longer prompts on this path` (P1 conformance note changes deliberately; update `conformance.ts` text and its snapshot), wording test for both keys in all 12 locales.
- [ ] Step 2–4: FAIL, implement, `TBJ __tests__/ui __tests__/bridge __tests__/i18n` PASS. Step 5: commit `feat(bridge): merged Connect sheet`.

### Task 8: Swift queue core: layout, sealing, key provider, state machine

**Repo:** WT. **Assumes:** S1 and S6 recorded (hard gate: do not start before both). `S6.group` default; under `S6.appgroup` only `KeychainKeyProvider`'s group source changes. Spec 6.4.

**Files:**
- Create: `PKG/swift/BsvBridgeQueue/Sources/BsvBridgeQueue/{Layout,Sealing,KeyProvider,Clock,BridgeStore}.swift`; replace `Stub.swift` (delete)
- Test: `PKG/swift/BsvBridgeQueue/Tests/BsvBridgeQueueTests/{ContractTests,SealingTests,MarkerTests}.swift`

**Interfaces:**
- Produces (all `public`, no React Native, no `UIApplication`): `protocol KeyProvider { func sealingKey() throws -> SymmetricKey }` with `InMemoryKeyProvider` (tests) and `KeychainKeyProvider(group: String, createIfMissing: Bool)`; `protocol Clock { var nowMs: Int64 { get } }`; `final class BridgeStore { init(root: URL, keys: KeyProvider, protection: ProtectionClass = .untilFirstUserAuthentication) throws; func create(id: String, bytes: Data, nowMs: Int64) throws -> Bool; stat(id:) -> StatResult?; read(id:) -> Data?; accept(id:) -> Bool; release(id:) -> Bool; claim(id:digest:bootId:nowMs:) -> ClaimOutcome; writeResult(id:bytes:nowMs:) -> Bool; readResult(id:nowMs:) -> ResultRead; ack(id:); list(_ state: State, nowMs:) -> [String] }`. Header fields `v, id, size, digest (hex SHA-256 of plaintext), createdAt, notAfter, claimBootId` (createdAt/notAfter read from the record JSON, defaults `nowMs` and `nowMs + 15 min`). `ClaimOutcome` is `claimed | digestMismatch | notAccepted`. A test-only `faultAfter: ((String) -> Void)?` hook throws to simulate a crash after a named step (`linked`, `renamedPending`, `renamedClaimed`, `resultLinked`).

- [ ] Step 1: XCTest port of the 12 behavioural `it` cases of `inboxContract.ts` that exist today (`ContractTests`, same names; the 13th, `raw stored bytes contain no plaintext marker`, becomes `MarkerTests`; the gap and retention cases added by Task 4 are ported in Task 9) plus `SealingTests`: `wrong id fails to open`, `wrong kind fails to open`, `tampered byte fails`, `truncated file fails`, `nonce is fresh per file`, `AAD is exactly "bsv-bridge/v1|record|<id>"`; `MarkerTests`: `no file under the container contains the plaintext marker (every state)`; crash tests `crash between link and rename leaves an unusable tombstone and no record`, `crash between claim rename and rewrite is recovered as other-boot with arguments stripped`, `crash between result link and payload delete reports done`.
- [ ] Step 2: `SW` FAIL (types missing). Step 3: implement per 6.4 (create via `O_EXCL` tmp + `link(2)` into `ids/`; transitions by `rename`; claim rewrites header-only through `tmp`; `writeResult` allowed from pending/accepted/claimed, once, via `link`; directory and file attributes set on every open). Step 4: `SW` PASS and `XC` PASS (same suite on the Simulator).
- [ ] Step 5: commit `feat(safari-bridge): sealed queue core`.

### Task 9: Swift queue: events, mirror, stage, withdraw, sweeps, reset

**Repo:** WT. **Consumes:** Task 8. Spec 6.4 (events, sweeps, reset, bootId), 6.5 (mirror file), 6.11 (stage, withdraw, chunking).

**Files:**
- Create: `…/Sources/BsvBridgeQueue/{Events,MirrorFile,Staging,Sweeps}.swift`; extend `BridgeStore`
- Test: `…/Tests/BsvBridgeQueueTests/{EventsTests,MirrorTests,StagingTests,SweepTests,ResetTests,RaceTests}.swift`; helper executable target `bridge-race-helper` in `Package.swift`

**Interfaces:**
- Produces on `BridgeStore`: `writeEvent(seq: Int, bytes: Data, nowMs: Int64) throws`; `readEventsAfter(seq: Int, nowMs: Int64) -> (events: [Data], gap: Bool)` (retention 1024 and 24 h, `evictedThrough` persisted in `meta/`); `writeMirror(_ bytes: Data) throws`; `readMirror() -> MirrorRead` (`.ok(Data) | .absent | .corrupt`); `stage(id:bytes:nowMs:) throws -> StageStatus` (`.created | .exists`; same id different digest throws `StageError.existsDifferent`); `stageBegin(id:parts:size:digest:)`, `stageChunk(id:n:bytes:)` (idempotent by `(id,n)`, sealed on arrival), `stageEnd(id:nowMs:) throws -> StageStatus` (unseal, join, check length and digest, re-seal as record, `create`); `withdraw(id:) -> Bool` (`pending → withdrawn`); `sweep(nowMs:)` (result purge 15 min, tombstones 40 min, stage chunks 15 min, orphan tombstones, events retention); `reset()` (delete container; final until the next `init`; later writes throw `BridgeError.resetFinal`); `bootId` generation persisted in `meta/boot`; `evictedThrough`.

- [ ] Step 1: tests `gap true when cursor older than evictedThrough`, `events listed sorted by seq`, `corrupt mirror syncs as absent` (Review Focus 2: truncated file, file sealed under another key, garbage), `mirror replace is atomic under a concurrent reader`, `chunked stage of 3 chunks equals one stage`, `repeat chunk is idempotent`, `stageEnd with a bad digest throws and leaves nothing pending`, `repeat stage same digest is exists, other digest throws`, `withdraw loses to a prior accept and wins against a pending record`, `sweep purges results at 15 min but keeps tombstone until 40 min`, `reset removes everything and later writes throw resetFinal`, `a fresh init after reset creates a new key and old files are unreadable noise`; cross-process `RaceTests` (`#if os(macOS)`, so `XC` skips them) spawn helper processes racing `create` of one id (exactly one wins), `claim` of one record, `accept` vs `withdraw`, `ack` vs purge.
- [ ] Step 2–4: FAIL, implement, `SW` and `XC` PASS (`SW` includes `RaceTests`). Step 5: commit `feat(safari-bridge): events, mirror, staging, sweeps, reset`.

### Task 10: Swift continuity key and native-message router

**Repo:** WT. **Consumes:** Tasks 8 and 9. Spec 6.9 (key, sign rule), 6.11 (operation table). Branch: `S6.group`.

**Files:**
- Create: `…/Sources/BsvBridgeQueue/{Continuity,MessageHandler}.swift`
- Test: `…/Tests/BsvBridgeQueueTests/{ContinuityTests,MessageHandlerTests}.swift`

**Interfaces:**
- Produces: `public final class Continuity { init(keychainGroup: String, keys: ContinuityKeyStore); identity(context: String) throws -> (instanceId: String, publicKey: Data); sign(context: String, preimage: Data) throws -> Data; resetAll() }` (Ed25519 via `Curve25519.Signing`, private bytes never leave Swift, key and UUIDv4 `instanceId` created on first `identity`, stored `AfterFirstUnlockThisDeviceOnly`; public key checked with the strong-key rule of P1's `isStrongEd25519Key` (reject small-order and identity points) before first use; `sign` rejects any preimage not starting with `BRC-185 descriptor v1\n` or over 16 KiB with `BAD_PREIMAGE`). `public func handleBridgeMessage(_ request: [String: Any], env: BridgeEnv) -> [String: Any]` where `BridgeEnv` holds store, continuity, clock, `nudge: () -> Void`. Request/reply JSON (every reply `{ok:true,…}` or `{ok:false, code, message}`, `code` one of `KEY_MISSING, UNAVAILABLE, EXISTS_DIFFERENT, BAD_REQUEST, BAD_PREIMAGE`):
  - `{op:'sync', cursor, nowMs}` → `{mirrorState:'ok'|'absent'|'corrupt', mirror?: object, events: object[], gap}`
  - `{op:'identity', context}` → `{instanceId, continuityKey}` (base64url, unpadded)
  - `{op:'sign', context, preimage}` (base64) → `{signature}` (base64url)
  - `{op:'stage', id, bytes, nowMs}` | `{op:'stageBegin', id, parts, size, digest}` | `{op:'stageChunk', id, n, bytes}` | `{op:'stageEnd', id, nowMs}` → `{status:'created'|'exists'}`
  - `{op:'withdraw', id}` → `{won:boolean}`; `{op:'results', ids:[{id, part}], nowMs, maxPartBytes}` → `{results:[{id, state:'none'|'result'|'purged', part, parts, bytes?}]}`; `{op:'ack', ids}` → `{}`; `{op:'nudge'}` → `{}`.

- [ ] Step 1: tests `identity is stable across handler instances and context-separated`, `private bytes never appear in any reply`, `sign rejects a connect-prefix preimage, an unprefixed preimage and 16385 bytes`, `signature verifies with the returned public key`, `a small-order public key is refused before first use`, `unreadable key replies KEY_MISSING for every op including identity` (Review Focus 1; `InMemoryKeyProvider` that throws), `unknown op replies BAD_REQUEST`, `results of a 200 KiB payload return in parts that rejoin`, `sync after reset replies absent`.
- [ ] Step 2–4: FAIL, implement, `SW` and `XC` PASS. Step 5: commit `feat(safari-bridge): continuity key and message router`.

### Task 11: Expo native module, JS adapter, fake native, shared types

**Repo:** WT. **Consumes:** Tasks 8 to 10; Task 3 (exports); Task 4 (`StoreHarness.rawBytes`, `readEventsAfter` shape). Spec 6.6, 6.1. Delta `S1.fileref`: podspec compiles the same Swift files instead of depending on the pod.

**Files:**
- Create: `PKG/expo-module.config.json`, `PKG/ios/{BsvBridgeModule.swift,BsvBridge.podspec}`, `PKG/shared/{constants.ts,mirror.ts,native.ts}`, `PKG/src/{index.ts,nativeStore.ts}`, `PKG/src/testing/fakeNative.ts`
- Test: `PKG/__tests__/{nativeStore.contract.test.ts,nativeStore.adapter.test.ts,fakeNative.test.ts}`

**Interfaces:**
- Produces: `shared/constants.ts`: `STAGE_CHUNK_BYTES = 48 * 1024`, `HANDOFF_COALESCE_MS = 3000`, `NATIVE_TIMEOUT_MS = 5000`, `NATIVE_RETRIES = 3`, `CLOSING_GRACE_MS = 5000`, `EPOCH_HORIZON_MS = 24 * 60 * 60 * 1000`, `POLL_STEPS_MS = [1000, 2000, 5000]`, `UNRESOLVED_CAPS = { perEpoch: MAX_IN_FLIGHT_PER_BINDING, total: MAX_IN_FLIGHT_TOTAL, bytes: MAX_IN_FLIGHT_BYTES }` (imported from P1 `core/bridge/protocol/limits`, values 4, 16, 5 MiB; likewise the 8 and 64 binding caps), `TRANSPORT_ID = 'safari-extension'`. `shared/mirror.ts`: `interface Mirror { v: 1; writerBootId: string; writtenAt: number; snapshot: { schema: 1; baseVersion: string; network: string; accountContext: string; walletRevision: string; readiness: BridgeReadiness; closeSeq: number }; identityKey: string | null; identityKeyPrompts: boolean; connected: string[] }` and `connectedHash(origin: string): string` (hex SHA-256 of `"bsv-bridge/connected/v1|" + origin`, via `@bsv/sdk` `Hash.sha256`). `shared/native.ts`: TS types for the Task 10 request/reply JSON. `BsvBridgeNative`: `init({nowMs}): Promise<{bootId: string; scheme: string}>`, the store calls 1:1 (time-dependent ones take `nowMs` last), `writeEvent`, `readEventsAfter`, `writeMirror(bytesB64)`, `sweep({nowMs})`, `reset(): void` (synchronous), `subscribeNudge(cb): () => void`, `rawBytes()` (debug builds only). `createNativeInboxStore(native: BsvBridgeNative, opts: { now: () => number; bootId: string }): InboxStore` (synchronous members cached at init; no `rawBytes`). `createFakeNative(opts?: { now?: () => number }): FakeNative` with `restart()`, `rawBytesSync()`, and the Swift semantics (in-memory port).

- [ ] Step 1: tests `nativeStore.contract.test.ts` imports P1's `runInboxStoreContract` from `../../expo-wallet-toolbox/__tests__/bridge/inboxContract` and calls it with `makeStore: clock => { const fake = createFakeNative({ now: clock.now }); return { store: createNativeInboxStore(fake, { now: clock.now, bootId: … }), restart: () => fake.restart() …, rawBytes: fake.rawBytesSync } }` (the adapter is built after `await fake.init()` in a `beforeEach`; `restart()` returns a new adapter over the same fake state); adapter: `bootId and sync members come from init`, `adapter has no rawBytes`, `native failures map to contract return values (missing file is undefined)`, `real failures rethrow so the processor's warning path runs`, `writes after reset reject until init`; `fakeNative`: `injected clock drives the 15 minute purge`.
- [ ] Step 2: FAIL. Step 3: implement; Expo module is plain `Module` definition with async functions except `reset`; binary values cross as base64. Step 4: `KJ` PASS; `TSC` baseline; module compile is proven in Task 13's `HBUILD`.
- [ ] Step 5: commit `feat(safari-bridge): native module, adapter and fake native`.

### Task 12: Config plugin and extension build

**Repo:** WT. **Consumes:** Tasks 1, 2, 3 (pure protocol modules to bundle), 10, 11. Spec 6.2, 6.3; defaults `S1.root/kc/pod`, `S6.group`; apply recorded deltas (`S1.targets`: `plugin/target.js` writes `targets/safari-bridge/`; `S1.kcfile`: `plugin/entitlements.js` writes the appex entitlements file; `S6.appgroup`: `ids.js` returns the App Group id as keychain group and `entitlements.js` omits `keychain-access-groups`; `S1.bespoke`: `target.js` is a `withXcodeProject` creator).

**Files:**
- Create: `PKG/app.plugin.js`, `PKG/plugin/{index,ids,entitlements,infoPlist,target,buildExtension,validate}.js`, `PKG/extension/templates/{manifest.json,Info.plist,SafariWebExtensionHandler.swift,expo-target.config.js}`, `PKG/extension/build.mjs`, minimal `PKG/extension/src/{background.ts,content.ts,provider-main.ts,popup/popup.html,popup/popup.ts}` (a `ping` answer only; replaced in Tasks 14 to 16)
- Test: `PKG/__tests__/plugin/{ids,validate,snapshot,hostUntouched,buildExtension}.test.js`

**Interfaces:**
- Produces: `withSafariBridge(config, options: { appleTeamId?: string; extensionName: string; profile?: 'development' | 'release'; overrides?: Partial<Ids> })`; `deriveIds(bundleId: string, opts?): { scheme, extensionBundleId, appGroup, bridgeKeychainGroup, hostKeychainGroup, transportId }`; `validate(config, options)` throws named errors (`SafariBridge: ios.bundleIdentifier is required`, `…appleTeamId…`, `…Expo SDK…`, `…@bacons/apple-targets…`, `…anchor …`); `buildExtension({ outDir, profile, allowLocalhostHttp, ids, extensionName })` runs esbuild (bundles the entry scripts with the P1 pure protocol modules, `define`s the build constants `allowLocalhostHttp`, `BRIDGE_SCHEME` (the handoff scheme), `BRIDGE_NAME` (`extensionName`, the descriptor `name`) and `BRIDGE_VENDOR` (lowercase reverse-domain of the bundle id), which the extension `lib/` reads instead of any plist), writes `Resources/` and the manifest from the template. Order of the plugin (6.3): validate, app entitlements (merge, host group first), Info.plist (second `CFBundleURLTypes` entry named `B.bridge`, the three `BSVBridge*` keys), target, extension entitlements (bridge group only, plus the default-data-protection key `NSFileProtectionCompleteUntilFirstUserAuthentication`), bundle, podfile wiring. The handler template calls `handleBridgeMessage` and posts the reply.

- [ ] Step 1: tests `ids derives every value for org.bsvblockchain.wallet and two different bundle ids never collide`, `override is checked against the same constraints`, `validate fails loudly for missing bundle id, team id, wrong SDK, missing apple-targets and an extensionName outside 1 to 80 UTF-8 bytes`, `snapshot of app entitlements, appex entitlements, Info.plist, target settings, EAS appExtensions`, `app keychain groups are exactly [host, host.bridge] in that order`, `app groups merge and never replace an existing value`, `the plugin changes nothing about the host's existing entitlements, URL types and other plugins' output` (fixture config with the NFC entitlement and the three existing schemes), `manifest permissions equal exactly nativeMessaging, storage, tabs`, `development profile adds http://localhost/* and sets allowLocalhostHttp; release does not`, `no process.env in plugin/`, `built Resources contain the three scripts, the MAIN-world content entry and no @bsv/expo-wallet-toolbox app import` (bundle scan for `react-native`).
- [ ] Step 2–4: FAIL, implement, `KJ __tests__/plugin` PASS. Step 5: commit `feat(safari-bridge): config plugin and extension build`.

### Task 13: Walking skeleton on the Simulator and spikes S2, S3, S4, S5, S7

**Repo:** WT for results; HOST for the run. **Consumes:** Task 12. Spec 11 (non-gating spikes), 6.11 constants, 6.8 injection.

**Files:**
- Modify: `PKG/SPIKES.md`, `PKG/shared/constants.ts` (measured values), HOST `app.config.js` and `package.json` (plugin entry; kit and `@bacons/apple-targets@5.0.0`; working-tree edits only, never committed in HOST, Task 20 makes the real change), HOST `app/+native-intent.ts` is left alone until Task 20
- Spike-only code (an `echo` op, timing logs, a probe page served by `PKG/demo/serve.mjs` stub) lives in one WT commit (`wip(safari-bridge): spike probes`, made at the end of Step 1 and extended as spikes need) that Step 5 reverts

**Interfaces:**
- Produces: a HOST build with the appex embedded, extension enabled in Safari, a `ping` round trip; measured constants committed to `shared/constants.ts`; `SPIKES.md` sections S2, S3, S4, S5, S7.

- [ ] Step 1: wire HOST (`link-kit.sh`, plugin entry with `appleTeamId: 'SV8SWTHA2H'`, `profile: 'development'`), `HBUILD` succeeds, app launches. Enable the extension in Settings → Apps → Safari → Extensions and choose Always Allow for localhost; the popup shows `ping` ok (screenshot `02-ping.png`).
- [ ] Step 2: S2: round trip of 1 KB, 100 KB, 1 MB, 5 MiB through the `echo` op, plus cold-appex latency of `sign` (kill Safari, relaunch, first call). Pass: every size round-trips or the largest working size is found; set `STAGE_CHUNK_BYTES` to the largest size that completes reliably across 10 runs, at most 48 KiB default (smaller if smaller is the reliable limit); record `sign` cold latency (budget 1 s; if over, the answer to describe in Task 14 stays `CONFIGURATION_ERROR` on timeout, per spec). Also record whether any callback failed to fire.
- [ ] Step 3: S3: page-world `"world": "MAIN"` at `document_start` against a page with and without a strict CSP (`script-src 'self'`), site access granted late (grant after load, reload). Pass: the handle global from the MAIN entry exists before page scripts run. Fallback (build and test both in Task 16): `<script src>` from `web_accessible_resources`, which fails under strict CSP; record which Safari versions available (iOS 27.0 and the 18.6 runtime) behave how.
- [ ] Step 4: S4: unload the background mid-request (wait over 30 s), then record whether a port, `tabs.onRemoved` and `storage.session` survive and wake it. S5: a second `tabs.update` while the prompt is up; handoff from a subframe (fallback: ask the top frame's content script to set `location.href`); confirm 3000 ms coalescing is workable. S7: which of `visibilitychange`, `pageshow`, `focus` fire after the ◀ Safari chip and after a manual app switch; timers while hidden; `sender.origin` casing and `tab.incognito` reliability. Record all with screenshots (`03-…`).
- [ ] Step 5: revert the spike-only commit (`git revert --no-edit <sha>`; `SPIKES.md` is committed separately from it), then set the measured values in `shared/constants.ts` and commit `docs(safari-bridge): spikes S2 to S7 and measured constants`.

### Task 14: Extension lib I: attestation, describe, connect, reconcile, local answers

**Repo:** WT. **Consumes:** Tasks 3, 10, 11, 13. Spec 6.8 (Attestation, wire), 6.9, 6.10, 7.

**Files:**
- Create: `PKG/extension/src/browser.d.ts` (minimal typed declaration of the `browser` WebExtension namespace the kit uses, so root `TSC` stays at baseline), `PKG/extension/src/lib/{attest,errors,ids,bindings,nativeClient,describeConnect,reconcile,localAnswers}.ts`
- Test: `PKG/__tests__/ext/{attest,describeConnect,reconcile,localAnswers}.test.ts`, shared fake: `PKG/__tests__/ext/fakeBrowser.ts` (fake `browser` API with in-memory `storage.session`, `tabs`, `runtime`)

**Interfaces:**
- Produces: `attestFrame(sender: Sender, opts: { allowLocalhostHttp: boolean }): AttestedFrame | undefined` (`{ origin: string; tabId: number; frameId: number; context: 'safari' | 'safari-private' }`; prefers `sender.origin`, re-reads the frame URL each call, undefined for opaque, `about:blank`, `srcdoc`); `createNativeClient(send: (m: NativeRequest) => Promise<NativeReply>, opts?: { timeoutMs: number; retries: number }): NativeClient` (typed methods per op; each op times out at 5 s and retries up to 3 times; errors map to P1 `connectionError`); `describe(deps, { frame, origin, challenge }): Promise<DescribeResponse>` (frame rule, challenge validated as canonical unpadded base64url of 32 bytes, descriptor built with P1 `descriptor.ts` from `BRIDGE_NAME` and `BRIDGE_VENDOR` (Task 12 build constants), native `identity` then `sign`, `signDescribe`); `connect(deps, { frame, origin, epoch }): Promise<void>` (reconcile, refuse with `CONFIGURATION_ERROR` / `not-sent` when mirror is absent, `none`, or has no `accountContext`; stamp and save `EpochBinding { instanceId, epoch, tabId, frameId, origin, continuityKey, accountContext, walletRevision, boundAt }` keyed by `(instanceId, epoch)`; enforce 8 per origin and 64 overall); `reconcile(deps): Promise<ReconcileState>` (`'absent' | 'none' | 'present'`, applying the six steps of 6.10 and returning closed epochs with reasons `account-changed | revoked | lost`); `localAnswer(method, args, epochBinding, mirror, origin): { answer: unknown } | undefined` (undefined means stage).

- [ ] Step 1: tests `attest`: `https origin accepted, uppercase host refused not normalised`, `http://localhost:3000 only with allowLocalhostHttp`, `opaque, about:blank and srcdoc frames give undefined`, `frame navigation with the same frameId is re-read`, `cross-origin iframe never gets the top origin`, `incognito true or non-boolean gives safari-private`. `describeConnect`: `page origin differing from the attested origin is PROTOCOL_ERROR not-sent`, `describe preimage and response verify against the BRC-185 vectors (P1 fixture)`, `describe works with mirror absent and with readiness none`, `describe with unavailable key rejects CONFIGURATION_ERROR` (Review Focus 1), `describe response over 16384 bytes is refused`, `connect refused while building (no accountContext)`, `connect returns no proof`, `binding caps 8 and 64`. `reconcile`: each of the six steps, `absent closes every held epoch lost`, `corrupt mirror behaves as absent` (Review Focus 2), `revision change closes every epoch of that revision, context change only when ready`, `events apply per (instanceId, epoch) and never close another tab's epoch`, `notifyPage false is not echoed`, `gap closes all lost`, `a lost cursor restarts at 0 and the replayed events close idempotently`, `cursor is the highest event read, not the mirror's`, `epoch older than 24 h closes lost`. `localAnswers`: one test per identity-key condition 1 to 6 failing independently (`counterparty present`, `epoch closed`, `revision differs`, `account context differs`, `site not in connected`, `identityKeyPrompts true`, `identityKey null`) and the passing case; `getVersion` and `isAuthenticated` answer only when mirror present and not `none`; every other of the 28 methods returns undefined.
- [ ] Step 2–4: FAIL, implement, `KJ __tests__/ext` PASS. Step 5: commit `feat(safari-bridge): extension attestation, describe, connect, reconcile`.

### Task 15: Extension lib II: staging, limits, handoff, pickup, tab lifecycle

**Repo:** WT. **Consumes:** Task 14. Spec 6.11, 7, 12 items 2 and 3.

**Files:**
- Create: `PKG/extension/src/lib/{stage,limits,handoff,pickup,tabs}.ts`
- Test: `PKG/__tests__/ext/{stage,limits,handoff,pickup,tabs}.test.ts`

**Interfaces:**
- Produces: `stageInvoke(deps, { frame, binding, invokeId, method, params }): Promise<StageOutcome>` (`{ kind: 'staged'; recordId: string } | { kind: 'error'; error: ConnectionError }`; record id is a UUIDv4 minted here, mapping `(instanceId, epoch, invokeId) → recordId` kept in `storage.session`; request over 5 MiB or malformed envelope is `PROTOCOL_ERROR` / `not-sent` before staging; bytes above `STAGE_CHUNK_BYTES` travel as `stageBegin/stageChunk/stageEnd`; all attempts failing calls `withdraw`: won gives `CONFIGURATION_ERROR` / `not-sent`, lost keeps waiting, unconfirmed gives `CONNECTION_CLOSED` / `unknown` and keeps the id in `closing`); `checkLimits(state, binding, sizeBytes): ConnectionError | undefined` (4 per epoch, 16 total, 5 MiB total across tabs, `RESOURCE_LIMIT`/`not-sent`); `triggerHandoff(deps, tabId): Promise<void>` (scheme from the `BRIDGE_SCHEME` build constant) (`tabs.update(tabId, { url: '<BRIDGE_SCHEME>://bridge?v=1&n=<random>' })`, coalesced within `HANDOFF_COALESCE_MS` per tab; from a subframe, per the S5 result); `pickup(deps, ids: string[]): Promise<PickupItem[]>` (`results`, reassemble parts, `ack`; `ok` becomes `{ id, kind: 'result', result }`, errors `{ id, kind: 'error', error }` raw and unchanged; purged becomes `CONNECTION_CLOSED` / `unknown` "The result is no longer available"; mirror `absent` for a held id becomes `CONNECTION_CLOSED` / `unknown`); `closeTracking`: `markClosing(epochKey)`, `flushDisconnects(deps, now)` writes `kind:'disconnect'` records (full tuple, no method or args, no handoff) for epochs that staged something and were not re-registered within `CLOSING_GRACE_MS`.

- [ ] Step 1: tests `record ids are extension-minted and never the page's invoke id`, `repeat invoke id reuses the mapping and does not stage again`, `repeat invoke after background reload does not stage twice` (Review Focus 3; session storage intact between stage and reply), `idempotent retry: same id same digest is exists, other digest is an error`, `withdraw wins: not-sent CONFIGURATION_ERROR`, `withdraw loses: keeps waiting`, `withdraw unconfirmed: CONNECTION_CLOSED unknown and id kept in closing`, `chunking at STAGE_CHUNK_BYTES boundary (n-1, n, n+1) rejoins to the same digest`, `a batch of 16 across 4 tabs never produces RESOURCE_LIMIT from the app side while a 17th, a 5th in one epoch and a request over 5 MiB total are refused locally`, `coalescing: three records in 3 s share one handoff, the fourth after the window re-triggers`, `handoff url carries no id, origin or payload`, `result conversion ok, wallet error and ConnectionError unchanged`, `purged result converts to unknown`, `in-flight call when mirror becomes absent rejects unknown` (Review Focus 4), `second result for a resolved id is ignored and re-acked` (Review Focus 5), `tab close, frame unload, bfcache re-register within 5 s writes no disconnect`, `disconnect written after grace only for epochs that staged`, `no handoff for disconnects`, `a tab closed while the background was unloaded is detected by tabs.query at next wake`.
- [ ] Step 2–4: FAIL, implement, `KJ __tests__/ext` PASS. Step 5: commit `feat(safari-bridge): extension staging, pickup and tab lifecycle`.

### Task 16: Extension entry points, BRC-185 page wire, stand-in client

**Repo:** WT. **Consumes:** Tasks 14 and 15, S3 result (default `world: MAIN`; build the `<script src>` fallback too). Spec 6.8, 6.16 (client), 10.

**Files:**
- Modify (replace Task 12 stubs): `PKG/extension/src/{background,content,provider-main}.ts`, `PKG/extension/src/popup/*`
- Create: `PKG/src/testing/pageClient.ts`, `PKG/extension/src/inject-fallback.ts`
- Test: `PKG/__tests__/ext/{wire,provider,content,background,popup}.test.ts`

**Interfaces:**
- Produces: `createProviderMain(win: Window): void` (frozen handle `{ describe(origin, challenge), connect(origin, epoch, onClose): Promise<WalletInterface>, disconnect(epoch): Promise<void> }`; answers each `brc185:request-provider {version:1, requestId}` once per `requestId` with `brc185:announce-provider {version:1, requestId, handle}`; no unsolicited announce; never touches `window.CWI`; hands the content script one `MessagePort`); `createContentRelay(deps)` (per-frame port relay, pending-invoke table `recordId → resolve`, poll triggers `visibilitychange`, `pageshow`, `focus`, timer `POLL_STEPS_MS` while pending and visible, and the next call; long-lived port to background); `createBackground(deps)` returning the message router and top-level `tabs.onRemoved`/`tabs.onUpdated` listeners; endpoint record `{ id: 'window', type: 'window', address: 'safari-extension' }`; envelopes `brc185:invoke {version:1, instanceId, epoch, id, method, params}` → `brc185:result` | `brc185:error` (mutually exclusive), `brc185:closed {…, reason}`; `disconnect(epoch)` is not echoed. `createPageClient(win, opts?): PageClient` (BRC-185 §4.2 controller: request event, 200 ms collection, `describe` under a 1000 ms deadline with the real origin and a fresh 32-byte challenge, signature and challenge verification, `connect` with a fresh UUIDv4 epoch, `invoke`, `onClose`, `ConnectionError`).

- [ ] Step 1: tests (jest with `jsdom`-style window fake, fake browser, `createPageClient` against the real lib): `event names and detail shapes`, `answers once per requestId`, `no unsolicited announce`, `answers with mirror absent`, `opaque, about:blank and srcdoc frames do not announce`, `handle is frozen and has exactly describe, connect, disconnect`, `a forged window.postMessage reaches only its own content script`, `routing fields mismatch, unknown method and invoke before connect are PROTOCOL_ERROR not-sent before staging`, `onClose reasons account-changed, revoked, lost reach the page`, `profile-switch refusal`, `all 28 methods carried with unchanged JSON shapes (table from BRIDGE_METHODS)`, `promise rejects with ConnectionError (domain brc185) or wallet error unchanged`, `popup shows steps and ping status`, `no network request is made by any extension module` (scan for `fetch`/`XMLHttpRequest`/`WebSocket`), and the fallback entry produces the same handle behaviour.
- [ ] Step 2–4: FAIL, implement, `KJ` PASS; `HBUILD` still succeeds with the real bundle. Step 5: commit `feat(safari-bridge): extension entry points and page client`.

### Task 17: App mirror writer

**Repo:** WT. **Consumes:** Tasks 3, 4, 11. Spec 6.5.

**Files:**
- Create: `PKG/src/mirror.ts`
- Modify: `TB/core/bridge/runtime.ts` (`ActiveConsent.store` Pick gains `'onChange'`; add `onConnectedSitesChange(fn: () => void): () => void`, which forwards the active store's `ConsentStore.onChange` and re-subscribes when `setActiveConsent` swaps the store) and `TB/core/bridge/index.ts` (export it); `BrowserBridgeProvider.tsx` already passes the whole store
- Test: `PKG/__tests__/mirror.test.ts`, extend `TB/__tests__/bridge/runtime.test.ts`: `onConnectedSitesChange fires on connect and revoke and follows a swapped store`

**Interfaces:**
- Produces: `createMirrorWriter(deps: { native: Pick<BsvBridgeNative, 'writeMirror'>; processor: Pick<InboxProcessor, 'flushEvents'>; getSnapshot: () => BridgeSnapshot; onSnapshotChange: typeof onSnapshotChange; isBridgeHostAttached: () => boolean; listConnectedSites: typeof listConnectedSites; onConsentChange: typeof onConnectedSitesChange; getPermissionPolicy: typeof getPermissionPolicy; getIdentityKey: () => Promise<string | null>; bootId: string; now: () => number }): MirrorWriter` with `start(): void`, `stop(): void`, `disable(): void` (synchronous, drops queued writes, final until a new writer), `writeNow(): Promise<void>`. Writes `Mirror` (Task 11) as sealed JSON via `writeMirror`: never before `isBridgeHostAttached()`; every snapshot after attach including a real `none`; `identityKey` null unless `readiness === 'ready'`; `identityKeyPrompts` from the verified policy flag `seekPermissionsForIdentityKeyRevelation`; `connected` is the sorted `connectedHash` list over `listConnectedSites()` filtered to `attestation === 'browser'`, hashing `applicationOrigin`; awaits `processor.flushEvents()` before every write on the ordinary path; re-checks attachment and the disabled flag immediately before each file write. In `__DEV__` it logs the connected count on each write (E2E uses it).

- [ ] Step 1: tests `never writes the pre-init snapshot (revision 0, closeSeq 0)`, `identityKey is null when not ready`, `connected equals listConnectedSites filtered to browser, hashed, and equals what consent.lookup would skip` (driven through the real consent store), `identityKey equals getPublicKey({identityKey:true}) through the P1 dispatcher` (parity), `writes on snapshot change, consent change, policy change and app active`, `ordinary write awaits flushEvents so a mirror with closeSeq N is never durable before event N`, `a detach-induced none is not written while a real none is`, `logout order: P1 teardown sets none, the writer callback fires, the kit hook disables synchronously, the pending write re-checks disabled and writes nothing` (pins the order in 6.5), `late write after disable rejects and is swallowed`, `unverified sites are never listed`.
- [ ] Step 2–4: FAIL, implement, `KJ __tests__/mirror.test.ts` PASS. Step 5: commit `feat(safari-bridge): mirror writer`.

### Task 18: App runtime: SafariBridgeHost, scheme handler, drain, reset

**Repo:** WT. **Consumes:** Tasks 3 to 5, 11, 17. Spec 6.7 (startup order, drain, requestAttention), 6.4 Reset. Receipts, `DoneScreen` and `Toast` are Task 19: here the host dispatches with P1's `dispatch` directly and renders `null`.

**Files:**
- Create: `PKG/src/{SafariBridgeHost.tsx,handoffUrl.ts}`, `PKG/src/index.ts` exports
- Test: `PKG/__tests__/{handoffUrl,host}.test.tsx`

**Interfaces:**
- Produces: `parseHandoffUrl(url: string, scheme: string): boolean` (accepts only scheme equal to `BSVBridgeScheme`, host `bridge`, `v=1`; ignores every other part including the nonce); `<SafariBridgeHost native={BsvBridgeNative} getIdentityKey={() => Promise<string | null>} />` (renders `null` until Task 19 adds the done screen and toast); `resetSafariBridge(): void`. Startup order, each step awaits the previous: `native.init({nowMs})`; adapter; wait for `isBridgeHostAttached()`; `registerTransport({ id: 'safari-extension', attestation: 'browser', bindingMode: 'implicit', requestAttention, onPromptRaised })` (no `deliverReconnectToken`; handle kept, `unregister()` on unmount); `createInboxProcessor({ store, dispatch, bindings: getBindingRegistry(), now, transport })` then `await processor.recover()`; mirror writer; `registerSessionTeardown(['logout'], hook)` where the hook synchronously disables the writer then calls `native.reset()`; first `drain()`. `drain()` runs `sweepExpired()` and un-awaited `processPending()`. Triggers: `Linking` url events and `getInitialURL()`, `AppState` active, native nudge while active, startup, 60 s `sweepExpired` timer while active. `requestAttention` is a no-op here (Task 19 makes it mark the drain). On unmount: `unregister()`, `processor.dispose()`, writer `stop()`, unsubscribe triggers. Singleton guard for Fast Refresh.

- [ ] Step 1: tests `registration precedes the processor and unregisters on remount (duplicate id never throws)`, `deliverReconnectToken is never passed`, `a wake while building or blocked parks with no deadline and no CONFIGURATION_ERROR; only none fails`, `a wake before attach waits`, `url handler nudges and never awaits processPending`, URL table (`wrong scheme, wrong host, v missing, v=2, extra params with nonce ignored`), `singleton processor under Fast Refresh and recover() runs once`, `logout hook disables the writer then reset() synchronously with no await`, `Delete Wallet reaches the hook once` (a stub `logout()` calling `runSessionTeardown('logout')` yields exactly one `reset()`), `late writeEvent and writeResult after reset reject and are swallowed`, `no mirror or key recreated until the next init`, `cold start into a scheme wake drains after attach`.
- [ ] Step 2–4: FAIL, implement, `KJ` PASS, `TSC` baseline. Step 5: commit `feat(safari-bridge): app runtime host`.

### Task 19: Receipts, done screen, toast, setup guide, copy

**Repo:** WT. **Consumes:** Tasks 5, 18 (`SafariBridgeHost`, which this task completes). Spec 6.12 (done screen, toast, onboarding), 6.7 receipts.

**Files:**
- Create: `PKG/src/{receipts.ts,ui/DoneScreen.tsx,ui/Toast.tsx,ui/SafariSetupGuide.tsx}`
- Modify: `PKG/src/SafariBridgeHost.tsx` (pass `createReceiptDispatch(dispatch, tracker)` to the processor, feed the tracker from `requestAttention` and `onPromptRaised`, render `DoneScreen` and `Toast`), `PKG/src/index.ts` (export `SafariSetupGuide`), `TB/core/i18n/translations.tsx` (12 locales), `TB/ui/components/ui/PermissionSheet.tsx` (export a `usePermissionSheetBusy(): boolean` from the existing queues, plan decision for "no sheet open or queued")
- Test: `PKG/__tests__/{receipts,ui}.test.tsx`, `TB/__tests__/i18n/bridgeDoneWording.test.ts`

**Interfaces:**
- Produces: `createReceiptDispatch(dispatch: Dispatcher['dispatch'], tracker: { neededApproval(epoch: string): boolean }): Dispatcher['dispatch']`; `interface Receipt { origin: string; method: string; summary: ReceiptSummary; ok: boolean; neededApproval: boolean; epoch: string }`; `summarize(method: string, args: unknown, format: (sats: number) => string): ReceiptSummary` (`createAction`/`signAction` with net spend → payment with the exact amount from the request's outputs in the user's display format; other `createAction` → action; signatures, HMACs, encryption, key linkage → signed / encrypted / approved; certificate calls → certificate; else approved); `aggregate(receipts: Receipt[]): DoneModel` (one receipt: that receipt; one site several: "{n} requests approved"; several sites: "Sent to {n} sites"). `neededApproval` is true if `requestAttention('consent' | 'wallet-not-ready')` or `onPromptRaised` fired for the binding while the call was in flight. `DoneScreen` shows when a receipt has `ok` and `neededApproval`, the app is active and `usePermissionSheetBusy()` is false; a later sheet replaces it; dismissed by tap or backgrounding, no timer, no button. `Toast`: 2.5 s, "Done · ◀ Safari" for a bounce that needed no approval, "Not completed · ◀ Safari" when `ok` is false. Keys: `bridge_done_sent_to`, `bridge_done_payment`, `bridge_done_action`, `bridge_done_signed`, `bridge_done_certificate`, `bridge_done_approved`, `bridge_done_n_requests`, `bridge_done_n_sites`, `bridge_done_back_hint`, `bridge_toast_done`, `bridge_toast_failed`, `bridge_setup_title`, `bridge_setup_step_extension`, `bridge_setup_step_allow`, `bridge_setup_why`.

- [ ] Step 1: tests `neededApproval with consent, with wallet-not-ready and with a foreground prompt`, `not set for an auto-approved call`, summary table (one case per row incl. `BSV, sats and fiat display formats exact`), `a first-ever call still summarises as the method`, aggregation (1 receipt; 3 receipts one site; receipts for 2 sites), `done screen hidden while a sheet is open or queued and replaced by a later sheet`, `dismiss by tap and by backgrounding, no timer`, `toast shows failed copy when ok false`, `setup guide renders both Always Allow routes and has no button`, host: `a dispatched call that raised a consent attention shows the done screen`, i18n: `all 12 locales for every key`, `{{site}}/{{amount}} placeholders kept`, `◀ Safari untranslated`, `bridge_done_back_hint names the top-left chip`.
- [ ] Step 2–4: FAIL, implement, `KJ` and `TBJ __tests__/i18n __tests__/ui` PASS. Step 5: commit `feat(safari-bridge): receipts, done screen, toast, setup guide`.

### Task 20: Host adoption in bitcoin-sv-wallet

**Repo:** HOST (branch `feat/safari-wallet-bridge`). **Consumes:** Tasks 12, 18, 19. Spec 6.13. Re-run `link-kit.sh` first. Defaults `S6.group`; under `S6.appgroup` the keychain-group assertions in `isolation.test.js` expect no `keychain-access-groups` entry.

**Files:**
- Modify: `app.config.js` (plugin entry with `appleTeamId: 'SV8SWTHA2H'`; rewrite the header comment, lines 11-13, to "only the bridge groups, shared with the app's own extension, never with other apps"), `__tests__/isolation.test.js`, `app/+native-intent.ts`, `app/_layout.tsx` (mount `BrowserBridgeProvider`, then `SafariBridgeHost` inside `WalletContextProvider` next to `PermissionSheet`), onboarding and Settings screens (place `SafariSetupGuide`), `package.json` (only the jest `transformIgnorePatterns` allow-list gains `@bsv/expo-safari-wallet-bridge`, as it has `@bsv/expo-wallet-toolbox`, so `HJ` can import the raw sources; the kit dependency line itself is added at release, `link-kit.sh` supplies it until then), `docs/2026-10-09-now-app-handover.md` (line 19) and `…-now-app-matrix.md` (lines 30-31) addenda, `__tests__/nativeIntent.test.ts`
- Test: `__tests__/isolation.test.js` (rewritten), `__tests__/nativeIntent.test.ts`, `__tests__/safariBridgeHost.test.tsx`, `__tests__/appGroupContents.test.js`

**Interfaces:**
- Consumes: `SafariBridgeHost` props `native` and `getIdentityKey` (the host passes the active profile's identity key the way it already reads it from the wallet context).

- [ ] Step 1: tests `isolation`: reads the resolved config after plugins run; `app groups equal exactly ["group.org.bsvblockchain.wallet"]`; `keychain groups equal exactly the host group then …wallet.bridge`; `no entitlement names any other bundle id`; `aps-environment and associated domains still present`; the same exact assertions for the extension target's entitlements; `registers exactly the existing URL schemes plus the bridge scheme as a named exception`; `the link adapter resolves every wallet scheme except the bridge doorbell`; `appGroupContents`: the App Group holds only the queue layout in 6.4 (no SQLite or wallet database file names anywhere in `ios/` group references). `nativeIntent`: `redirectSystemPath` returns `/` for `org.bsvblockchain.wallet://bridge?v=1&n=x`. `safariBridgeHost`: `Delete Wallet reaches the reset hook once`.
- [ ] Step 2: run `HJ`, expect FAIL. Step 3: implement. Step 4: `HJ` and `HTSC` (baseline) PASS; `HBUILD` succeeds; app launches on the Simulator with the guide visible in Settings (screenshot `04-guide.png`).
- [ ] Step 5: commit in HOST `feat(safari-bridge): adopt the Safari bridge kit`. Note in the message that the kit dependency line and lockfile changes from `link-kit.sh` are not committed and are set at release; stage only the files listed above.

### Task 21: Demo page and Simulator harness

**Repo:** WT. **Consumes:** Task 16 (`createPageClient`). Spec 6.16.

**Files:**
- Create: `PKG/demo/{index.html,demo.ts,serve.mjs,build.mjs}` (not in package `files`, not in the extension bundle or host)
- Test: `PKG/__tests__/demo.test.ts`

**Interfaces:**
- Produces: `node PKG/demo/serve.mjs` serving the built page on `http://localhost:3000` with buttons: describe, connect, `getVersion`, `isAuthenticated`, `getPublicKey({identityKey:true})`, `createAction` (accepts description and a marker string), disconnect; a log of results and errors; a `?csp=strict` variant sending `script-src 'self'`.

- [ ] Step 1: tests `demo wires every button to the page client`, `demo bundle is excluded from package.json files, the extension Resources and the host`, `createAction button sends the marker in the description`.
- [ ] Step 2–4: FAIL, implement, `KJ __tests__/demo.test.ts` PASS; serve locally and open `http://localhost:3000` and `https://deggen.ngrok.app` in the Simulator's Safari (screenshot `05-demo.png`). Step 5: commit `feat(safari-bridge): demo page`.

### Task 22: Integration on the Simulator, conformance notes, CHANGELOGs, README

**Repo:** WT for docs and evidence; HOST for the builds. **Consumes:** everything. Spec 10 (Simulator list), 6.14, 12, 6.8 (a to f).

**Files:**
- Create: `PKG/README.md` (host adoption: plugin options, host edits from 6.13, `SafariBridgeHost` props, onboarding guidance, what the app cannot detect), `PKG/CONFORMANCE.md` (BRC-185 profile choices 6.8 a to f, how each vector/test pins them, the deviations in spec 12 and the tests that exercise them), `PKG/CHANGELOG.md`, `docs/superpowers/evidence/ios-kit/*.png`, device checklist section in `PKG/SPIKES.md`
- Modify: `TB/CHANGELOG.md` (Unreleased: exports, events gap and retention, `flushEvents`, `onPromptRaised`, merged Connect sheet and its copy, `usePermissionSheetBusy`)

**Interfaces:**
- Produces: evidence for every Simulator-only item below; the owner device checklist.

- [ ] Step 1: full suites green: `TSC` baseline, `TBJ` (whole package), `KJ`, `SW`, `XC`, `HJ`, `HTSC`.
- [ ] Step 2: `E2E` on iPhone 18 Pro (iOS 27.0), one evidence screenshot each, with the pass condition stated: (1) describe and connect from `http://localhost:3000` without opening the app; (2) `getVersion`, `isAuthenticated` answer without any prompt; (3) `createAction` from the demo: Safari's "Open in BSV Wallet?" appears, Open shows the Connect sheet with the manifest groups listed and no toggles, Connect then the payment sheet, Approve, done screen with "Sent to localhost" and "Payment approved · …", ◀ Safari returns, page shows success; (4) second `createAction` from the now-connected site shows no connect sheet; (5) `getPublicKey({identityKey:true})` for the connected site answers with no app wake and equals the app's identity key, for an unconnected site goes through the sheet; (6) Don't connect leaves no grant (the `__DEV__` mirror log shows the connected count unchanged and no permission token exists for the site); (7) cold start: terminate the app, trigger from the page, the app drains after attach; (8) wallet locked: request parks, unlock, completes, no `CONFIGURATION_ERROR`; (9) tab close writes a disconnect and the page on reopen reconnects; (10) Cancel on Safari's prompt then a second call re-triggers; (11) `?csp=strict` page still announces (or the S3 fallback outcome is documented); (12) Logout/Delete Wallet: extension sees `absent`, pages' epochs close `lost`, pending call rejects `unknown`; (13) plaintext marker: send `createAction` with marker `BRIDGE-MARKER-<random>`, then `grep -r` the App Group container (`xcrun simctl get_app_container 1FD448B1-95C8-40AA-AEAB-8E3D15484313 org.bsvblockchain.wallet groups`) and the extension storage: zero hits, plus the debug `rawBytes()` check; (14) the same on an iOS 18.6 Simulator for items 1 to 3 (`xcrun simctl list runtimes`; create the device with `simctl create` if the runtime is installed, otherwise record it as a device gate).
- [ ] Step 3: two kit builds on one Simulator: build a second HOST variant with a different `ios.bundleIdentifier` and plugin `extensionName` (scratch `app.config` override, not committed), enable both extensions, load the demo page, confirm two announcements (distinguishable by `continuityKey`), pick each in turn through the stand-in client, and confirm requests reach only the chosen wallet and no file is shared between the two App Groups.
- [ ] Step 4: write `CONFORMANCE.md`, `README.md`, `CHANGELOG.md` entries (`PKG` 0.1.0 and `TB` Unreleased). `SPIKES.md` gets a "Device gates for the owner" list: keychain access-group sharing under real signing; data-protection class (readable after first unlock, not before); the keychain upgrade over real Vault and secure-store items (6.13 item 9, release blocker); real "Always Allow" flows on iOS 17, 18 and current; Private Browsing; Face ID with a wake from a locked phone; cold-appex `sign` latency against 1 s; EAS signing of the extension plus registering `org.bsvblockchain.wallet.safari` and the App Group capability for both identifiers; a TestFlight build.
- [ ] Step 5: prettier on touched files only; commit WT `docs(safari-bridge): conformance, README, changelogs, evidence`.
