# Browser wallet bridge — iOS Safari kit (project 2 of 4)

Date: 2026-10-28. Status: design, revision 2.
Builds on project 1 (core): `docs/superpowers/specs/2026-10-27-browser-bridge-core-design.md`
(called "P1" below; section numbers like "P1 6.8" point into it).
Feasibility study: `docs/superpowers/research/2026-10-27-browser-wallet-bridge-feasibility.md`.
Device spike: PR #56, `spikes/ios-handoff-links/FINDINGS.md` (Simulator, iOS 27).
Governing standards: BRC-185 (wallet discovery, selection, connections), BRC-219 (prompt
liveness), BRC-100.

BRC-185 text: `/Users/personal/git/docs/BRCs/wallet/0185.md` (vectors alongside). "BRC-185 §n" below points
into it. P2 implements BRC-185's extension/provider profile exactly (§3 descriptor and continuity, §4.2 events
and handle, §6 binding and errors, §1 and §11 full method set). Where BRC-185 leaves a point open, this
document defines it and project 3 conforms (6.8, 15). The XDM, React Native and mobile profiles are not P2.

## 1. Intent

A web page in Safari on the user's iPhone should be able to use the BSV wallet app as its
BRC-100 wallet, with the user approving in the wallet app. Project 2 is the iOS transport for the
P1 core. It is a reusable kit: any BSV wallet app built with Expo can add it, and Bitcoin SV
Wallet (`org.bsvblockchain.wallet`) adopts it first.

The kit has five parts:

1. **A Safari Web Extension** (MV3). It announces the wallet to pages (BRC-185), attests each
   frame's origin, answers a few requests itself, and stages everything else.
2. **A sealed request queue** in an App Group container, written by the extension and read by
   the app, implemented once in Swift and used by both sides.
3. **An Expo native module** that exposes the queue to JavaScript, and a **JS adapter** that makes
   it satisfy P1's `InboxStore` contract.
4. **App-side runtime and UI**: the scheme handler that drains the queue into P1's inbox
   processor, the merged Connect sheet, the done screen and toast, and the onboarding guidance.
5. **An Expo config plugin** that creates the extension target, entitlements, URL scheme and
   identifiers from the host's bundle id.

What the user sees: a site asks for something, Safari shows "Open in BSV Wallet?", the wallet app
opens on the usual permission sheet, the user approves, a done screen tells them to tap the
"◀ Safari" chip, and the page shows its own success state.

## 2. Decisions made by the product owner (2026-10-28)

Quoted from the owner's brainstorm decisions. These are not revisited here.

1. **Approval UX.** Approval uses the wallet's existing permission sheets (spending, protocol and
   so on), the same ones that sign off wallet-relay requests today. Approval happens in the wallet
   app: in-Safari approval is infeasible (P1 feasibility study). After Approve, the user returns
   either through the iOS "◀ Safari" status-bar chip or by switching apps. Back in Safari, the
   page shows its own success state.
2. **No forewarning.** When a request needs the app, the extension triggers the wallet's custom
   scheme straight away. Safari's own "Open in BSV Wallet?" prompt is the only thing the user
   sees. There is no in-page or popup "Approve in wallet" step first.
3. **Packaging.** A reusable kit that any BSV wallet app can drop in: a Safari Web Extension, the
   App Group queue sealed with a shared-keychain key, a native module and an Expo config plugin.
   Bitcoin SV Wallet (bundle id `org.bsvblockchain.wallet`, repo
   bsv-blockchain/bitcoin-sv-wallet, local at ~/git/ts/bitcoin-sv-wallet) adopts it first.
4. **Scope.** In: the merged connect sheet. Later: the permission-policy settings screen, and
   removing connections (the Browser connections screen with revoke, and "Remove connection and
   permissions").
5. **Snapshot answers.** The extension answers `getPublicKey` with `identityKey: true` from a
   cached copy. Every other non-probe method takes a round trip to wake the app. "That's a
   sensible line: identityKey cached, everything else does an app wake round trip."
6. **Merged sheet.** One sheet, design A: the connect information plus the manifest's requested
   permissions, listed for information only. There is no per-permission toggle, because toggles
   "will most likely just break apps". The only answers are **Connect** and **Don't connect**:
   Connect grants everything listed, Don't connect grants nothing.
7. **Done screen.** After an approval, while the wallet is in front, a done screen shows (design
   A): ✓, "Sent to example.com" and a summary line such as "Payment approved · 1,250 sats". It
   points the user at the ◀ Safari chip, and has no in-app return button. A bounce that needed no
   approval shows only a brief toast, "Done · ◀ Safari".

**Calls the owner accepted ("All good, proceed").**

- **Location.** A new package in the bsv-wallet monorepo next to the toolbox, working name
  `@bsv/expo-safari-wallet-bridge`. It holds the extension sources, the Swift queue and sealing
  code, the native module and the config plugin. The app repo only adds the plugin, sets its
  entitlements (App Group plus keychain access group) and updates `isolation.test.js`.
- **Probes.** `getVersion` and `isAuthenticated` are answered from the snapshot the app mirrors
  into the App Group. The extension reconciles `walletRevision` and `closeSeq` first (P1 6.9).
- **Trigger.** The background script calls `tabs.update(sender.tab.id, {url: '<scheme>://bridge…'})`,
  or the content script sets `location.href`. This keeps the page intact, with no stranded blank
  tab on Cancel. Cancel cannot be detected, so the request stays pending with no deadline
  (BRC-219), and the page's next call re-triggers the handoff. Project 3 lets the page cancel.
- **Batching.** One app wake drains every queued record, not just the one that triggered it.
- **Result delivery.** Results come back out of band: the extension reads them from the App Group
  when Safari returns to the foreground or the page polls. Never through a return URL.
- **Multiple wallets.** Each wallet app ships its own extension and its own scheme. The page sees
  one BRC-185 announcement per wallet; choosing between them is project 3.
- **Tab close.** Closing a tab writes a disconnect record.
- **Onboarding.** Onboarding asks the user to choose Safari's "Always Allow" for sites. Without it
  the content script does not run.
- **Notifications.** The local-notification attention handler is deferred. The handoff itself is
  the attention.
- **Silent push.** Not used, because Apple throttles silent pushes.

**Spike facts this design rests on** (PR #56): a custom scheme from the popup, background or
content script always shows Safari's "Open (this page) in <App>?" prompt, and Open fires
`onOpenURL` including on cold start. `tabs.create` with the scheme leaves a blank tab;
`tabs.update(sender.tab.id)` and a content-script `location.href` keep the page intact, also after
Cancel. Universal links from the extension load the website, not the app. Only the OS "◀ Safari"
chip returns to the originating tab. The content script does not run until the user grants site
access ("Allow for One Day" / "Always Allow"); `host_permissions` does not skip that.

## 3. Goals

G1. **A page can use the wallet on iOS Safari.** All 28 BRC-100 methods reach the P1 dispatcher
through the P1 inbox processor, with P1's origin rule, consent, policy and error codec. The
kit adds no method logic and no allowlist.

G2. **The origin is the browser's, not the page's.** Every record carries an origin that the
extension background derived from `sender` and canonicalised with P1's rule.

G3. **One wake handles everything queued**, from any tab, in any order the dispatcher accepts,
without turning a batch into spurious errors.

G4. **Nothing sensitive is readable outside the app and its own extension.** Every byte of
request, result, event and mirror is sealed. The wallet database is never in the App Group.

G5. **The extension works while the app is dead and the wallet is locked**, for the things it claims to do alone: answer discovery, describe, connect, the probes and the identity key for already connected sites. It
signs with its own continuity key within 1 second.

G6. **No silent wrong answers.** If the extension cannot be sure (stale epoch, wallet replaced,
queue unavailable, mirror not ready), the page gets a typed P1 error with the right delivery
claim (`not-sent` or `unknown`), never a guess.

G7. **One merged Connect sheet** (decision 6) with Connect and Don't connect as the only answers.

G8. **The user is told what happened and how to get back** (decision 7), with copy in all 12
locales like P1.

G9. **A wallet app adopts the kit with a plugin entry and a short list of host edits**, and the
host's existing keychain items keep working.

G10. **Two wallets with the kit can live on one phone** without sharing anything.

## 4. Non-goals (this project)

- No page-side SDK code and no `@bsv/sdk` change (project 3). P2 ships a minimal stand-in page client (tests only)
  and a demo page for Simulator end-to-end testing (6.16); neither is the SDK or a chooser. The handle the
  extension injects is BRC-185 §4.2 (6.8).
- No Android and no other browser (Chrome, Firefox, Edge, in-app browsers on iOS).
- No second wallet inside the extension. No approval UI in Safari (decision 1).
- No local-notification attention handler, no silent push, no Background App Refresh wake.
- No "Browser connections" screen, no revoke UI, no "Remove connection and permissions", no
  permission-policy settings screen (decision 4: later). P1's `revokeSite` and policy API are
  used by those screens later.
- No toggles on the Connect sheet.
- No return-URL result delivery and no universal-link handoff.
- No page-side cancel (project 3). The queue supports it (6.11, `withdraw`) so project 3 can add
  it without a format change.
- No SQLite or database in the App Group.
- No new ways for the extension to talk to the network. It makes no requests of its own.

## 5. Anti-goals: if any of these happen, the project failed

- A page-supplied origin, or any value read from the page world, reaches the queue or the signing
  key unchecked.
- The extension answers anything for a site that has not been connected, other than the two
  probes (P1 anti-goal: a site's requests run before the user connected it). This includes
  `getPublicKey`.
- Anything the user could read as "private" (arguments, results, identity key, account context,
  connected-site list) sits in the App Group, the extension storage on disk, or the native
  message log in plaintext. Only sizes, states, timestamps and random ids are visible at rest.
- Another app on the phone, or another wallet's extension, can read or write the queue or sign
  with the continuity key.
- The wallet's existing keychain items (vault state, secure store) become unreadable or move into
  the shared group after the kit is added.
- A record is dispatched twice, or a record that may have run is reported `not-sent`.
- A batch of several queued records fails with `RESOURCE_LIMIT` that would not have happened one
  at a time, because the extension staged more than the dispatcher admits.
- A record is answered `CONFIGURATION_ERROR` while readiness is `building` or `blocked`. Only readiness `none`
  (no wallet) may produce it; building and blocked records stay parked with no deadline (BRC-219).
- The extension stamps `accountContext` or `walletRevision` from a mirror that is not ready, or
  from a pre-initialisation snapshot.
- Don't connect leaves a grant behind, or Connect mints a permission token the sheet did not list.
- A second wallet's announcement or handoff reaches the first wallet.

## 6. Design

### 6.1 Package layout

```
packages/expo-safari-wallet-bridge/            @bsv/expo-safari-wallet-bridge (working name)
  package.json            raw TS + Swift + JS sources, no build output committed
  app.plugin.js           -> plugin/
  expo-module.config.json {"platforms":["apple"],"apple":{"modules":["BsvBridgeModule"]}}
  plugin/
    index.js              withSafariBridge(config, options)
    ids.js                derive scheme / groups / appex bundle id from the bundle id (6.2)
    entitlements.js       app + appex entitlements
    infoPlist.js          URL type, BSVBridge* keys
    target.js             generates the appex target; calls @bacons/apple-targets
    buildExtension.js     bundles extension/src with esbuild into the target's Resources
    validate.js           fails the prebuild loudly (team id, bundle id, anchors)
  swift/BsvBridgeQueue/   pure Swift package/pod, no React Native, APPLICATION_EXTENSION_API_ONLY
    Sources/…             Store, Sealing, KeyProvider, Mirror, Continuity, Layout, Clock
    Tests/…               XCTest port of the store contract + cross-process tests
  ios/
    BsvBridgeModule.swift Expo module (depends on ExpoModulesCore and BsvBridgeQueue)
    BsvBridge.podspec
  extension/
    templates/            manifest.json, Info.plist, SafariWebExtensionHandler.swift, expo-target.config.js
    src/
      background.ts       message router, attestation, native client, handoff, tab lifecycle
      content.ts          per-frame relay, pending-invoke table, poll triggers
      provider-main.ts    page-world: handle + announce, no authority
      popup/              status + onboarding copy only
      lib/                reconcile, bindings, localAnswers, stage, pickup, nativeClient, attest,
                          errors, ids   (pure; unit-tested under jest)
    build.mjs
  src/
    index.ts              public API
    SafariBridgeHost.tsx  mounts the runtime (6.7)
    nativeStore.ts        InboxStore adapter over the native module (6.6)
    mirror.ts             snapshot/connected-site mirror writer (6.5)
    handoffUrl.ts         scheme URL parse
    receipts.ts           dispatch wrapper that produces done-screen receipts (6.12)
    ui/DoneScreen.tsx, ui/Toast.tsx, ui/SafariSetupGuide.tsx
    testing/fakeNative.ts in-memory native module with an injectable clock and a test-only raw-bytes hook
    testing/pageClient.ts minimal BRC-185 §4.2 controller for tests and the demo (6.16)
    demo/                   static demo page using the stand-in client (6.16); not published, not bundled
  __tests__/
```

The package depends on `@bsv/expo-wallet-toolbox` as a peer dependency and on
`@bacons/apple-targets` (pinned) and `esbuild` (pinned). It ships raw sources. The extension
bundle is built by the config plugin at prebuild, from the pure P1 protocol modules plus
`extension/src`. Nothing built is committed.

### 6.2 Identifiers derived from the host's bundle id

Everything is derived, never typed, so two wallets cannot collide (G10). `B` is the host's
`ios.bundleIdentifier`, lowercased for the scheme.

| Thing | Value for `org.bsvblockchain.wallet` | Rule |
|---|---|---|
| URL scheme | `org.bsvblockchain.wallet` | `B`. Handoff URL is `<B>://bridge?v=1&n=<nonce>` |
| Extension bundle id | `org.bsvblockchain.wallet.safari` | `B + '.safari'` |
| App Group | `group.org.bsvblockchain.wallet` | `'group.' + B` |
| Bridge keychain group | `$(AppIdentifierPrefix)org.bsvblockchain.wallet.bridge` | `$(AppIdentifierPrefix) + B + '.bridge'` |
| Host's own keychain group | `$(AppIdentifierPrefix)org.bsvblockchain.wallet` | `$(AppIdentifierPrefix) + B`; listed first (6.3) |
| Transport id | `safari-extension` | constant; must start with `safari` (P1's sheet tests it to say "Verified by Safari") |
| Team id | read from `ios.appleTeamId` | the plugin refuses to run without it |

Swift code never hard-codes these. The plugin writes `BSVBridgeAppGroup`, `BSVBridgeKeychainGroup`
and `BSVBridgeScheme` into both Info.plists, and Xcode expands `$(AppIdentifierPrefix)` at build.
An option can override any value for a host that must; the plugin then checks the override against
the same constraints.

The scheme is the bundle id on purpose. It is unique per wallet, and the handoff URL carries no
data (6.11), so a rogue app claiming the same scheme learns nothing and can only fail to
answer. This is the P1 "unique scheme per wallet" item.

### 6.3 Config plugin

`withSafariBridge(config, options)` does these things, in this order, and fails the prebuild with a
named error if an anchor or a prerequisite is missing (the style of `withSharedNativePods.js`).

1. **Validate.** `ios.bundleIdentifier` and `ios.appleTeamId` are set; the host's Expo SDK matches
   the kit's range; the pinned `@bacons/apple-targets` resolves.
2. **App entitlements** (through `withEntitlementsPlist`, so plugin-added entitlements are
   possible next to the NFC entitlement plugin that already does this):
   - `com.apple.security.application-groups = [group.<B>]`, merged with, never replacing, any
     other value.
   - `keychain-access-groups = [ $(AppIdentifierPrefix)<B>, $(AppIdentifierPrefix)<B>.bridge ]`.
     **The host's own group is first.** Once the entitlement exists, items written without an
     explicit group go to the first entry, and old items stay readable only if their group is
     still listed. The host's existing keychain items (the Vault's and `expo-secure-store`'s) live
     in `$(AppIdentifierPrefix)<B>`. The bridge key is always written with an explicit
     `kSecAttrAccessGroup`, so `expo-secure-store` (unset `accessGroup`) never writes into the
     shared group.
3. **Info.plist**: a second `CFBundleURLTypes` entry for `<B>` (named `<B>.bridge`, so it does not
   touch the host's existing schemes), and the three `BSVBridge*` keys.
4. **Extension target**, through `@bacons/apple-targets` (type `safari`, bundle suffix
   `.safari`, same deployment target as the app, frameworks `SafariServices`). The plugin generates
   the target directory (Swift handler, Info.plist, built `Resources/`, `expo-target.config.js`,
   `pods.rb` linking `BsvBridgeQueue`) into a git-ignored scratch directory and points
   apple-targets at it with its `root` option, so the host's `targets/` stays clean. If `root`
   does not work as hoped (spike S1), the plugin writes `targets/safari-bridge/` instead and the
   host ignores that path. apple-targets also fills `extra.eas.build.experimental.ios.appExtensions`
   so EAS signs the extension.
5. **Extension entitlements**: the same App Group, and keychain groups containing only
   `…<B>.bridge`. The extension never sees the host's own group. `keychain-access-groups` is not a
   typed key in apple-targets 5.0.0; the plugin writes the extension's entitlements file itself if
   the key does not pass through (spike S1).
6. **Data protection**: `com.apple.developer.default-data-protection =
   NSFileProtectionCompleteUntilFirstUserAuthentication` on the extension. The app sets the class
   explicitly on the directory and on every file as well; it does not depend on inheritance.
7. **Bundle the extension JS** (`buildExtension.js`): esbuild bundles `background.ts`,
   `content.ts`, `provider-main.ts` and `popup` with the P1 pure protocol modules (6.15 item 2).
   It writes `Resources/` plus the manifest from the template. The manifest has MV3, a
   non-persistent background (`"scripts"`, as in the spike), permissions `nativeMessaging`,
   `storage` and `tabs` and nothing else, `host_permissions` and content-script matches
   `https://*/*` (plus `http://localhost/*` only when the plugin is run in a development
   profile, which also sets the build constant `allowLocalhostHttp` that the extension passes to `canonicalizeBridgeOrigin`), `all_frames: true`, `run_at: document_start`. The page-world script is a second
   content-script entry with `"world": "MAIN"` (the fallback and its test are in 6.8).
8. **Podfile.** The Expo module pod `BsvBridge` depends on the pod `BsvBridgeQueue` (local path
   inside the package); the appex links the same pod through its `pods.rb`. If sharing the pod
   with the appex does not work with the host's static frameworks (spike S1), the same Swift files
   are compiled into both targets by file reference instead.

Nothing in the plugin edits `app.config.js` of the host. The host adds one `plugins` entry.

The plugin's output is checked by a snapshot test (10): entitlements, Info.plist, target and
build settings. A second test asserts the plugin changes nothing about the host's existing
entitlements, URL types or plugins' output.

### 6.4 The sealed queue (Swift, `BsvBridgeQueue`)

One implementation, compiled for the app (through the native module) and the extension. It
implements P1's `InboxStore` contract (P1 6.8) exactly, plus the extension-only operations in 6.11.

**Container.** `<AppGroup>/bridge/` with the directory attributes set at every launch of either
process: `isExcludedFromBackup`, protection class `completeUntilFirstUserAuthentication`.

```
tmp/                 staging for every write (same volume, so rename is atomic)
ids/<id>             zero-byte tombstone; created with link(2), never changed
pending/<id>         sealed record (immutable)
accepted/<id>        the same file, moved
claimed/<id>         sealed header only (arguments deleted at claim)
withdrawn/<id>       header only (6.11)
results/<id>         sealed result; its existence means "done"
events/<seq>         sealed close events, one file per event
meta/key-check, boot, mirror.sealed
stage/<id>/<n>       sealed upload chunks (6.11)
```

State is where the file is. Every transition is `rename(2)` between sibling directories, which is
atomic, so exactly one caller wins any race.

- **Header.** Every sealed file starts with a header: `v`, `id`, `size`, `digest` (hex SHA-256 of
  the plaintext, the same `inboxDigest` the processor computes), `createdAt`, `notAfter`, and after
  claim `claimBootId`. `stat` reads only the header, never the payload, and the header survives
  deleting the payload, so `size` stays known after claim (the contract requires that).
- **`create(id, bytes)`.** Seal, write to `tmp/<random>` (`O_CREAT|O_EXCL`, `fsync`), then
  `link(tmp, ids/<id>)`. `EEXIST` means the id is taken in any state, including after the payload
  is gone, and `create` returns false. On success `rename(tmp, pending/<id>)`. If the process dies
  between the link and the rename, the tombstone exists without a record; the app removes such
  orphans after the tombstone lifetime, and the id stays unusable meanwhile, which is safe.
- **`accept`**: `pending → accepted`. **`release`**: `accepted → pending`. Both are renames that
  report whether they won.
- **`claim(id, digest)`.** Open `accepted/<id>`, unseal, hash, compare with `digest`
  (`digest-mismatch` leaves the state alone). Then `rename(accepted → claimed)`; `ENOENT` is
  `not-accepted`, so exactly one caller can win. Then rewrite the file as a header with
  `claimBootId` through `tmp` and an atomic replace, which deletes the arguments. A crash between
  the rename and the rewrite leaves a claimed file with arguments and no `claimBootId`; recovery
  treats that as "other boot" and strips the arguments.
- **`writeResult(id, bytes)`.** Allowed from `pending`, `accepted` or `claimed` (P1 writes error
  results for records that were never claimed), once only: the result is created with `link` into
  `results/<id>` (exclusive). Then the payload file is deleted. A crash between leaves `done` plus
  stale arguments; `stat` reports `done` and the next sweep deletes the arguments.
- **`readResult`**: `none`, `result`, or `purged` once the 15-minute lifetime has passed. The
  lifetime runs from the result's creation; purge deletes the file and keeps the tombstone.
- **`ack(id)`** (extension): delete `results/<id>`. Acts only if the record is done. Idempotent.
- **`writeEvent` / `readEventsAfter(seq)`.** Events are single sealed files named by `closeSeq`
  (zero-padded), written through `tmp` and renamed. `readEventsAfter` lists and sorts by seq.
  Retention (which P1 left unstated): at most 1024 events and 24 hours, whichever trims more,
  swept by the app. The store remembers the highest `closeSeq` it has trimmed (`evictedThrough`, as the P1
  tombstone ring does). `readEventsAfter(seq)` returns `{ events, gap }` with `gap` true when
  `seq < evictedThrough`; a reader that sees `gap` must close every epoch it holds (6.15 item 7).
- **`bootId()`**: a random UUID the app generates once per process start and keeps in memory and
  in `meta/boot`. The native module returns it at init so the JS adapter can serve P1's
  synchronous call.
- **`list(state)`**: directory listing; `pending` is returned oldest first by `createdAt`
  (header), because P1 accepts in `createdAt` order per epoch.
- **Sweeps** (app only, on init and on each drain): result purge at 15 minutes; id tombstones kept
  `max notAfter (15 min) + 5 min + result lifetime (15 min) + 5 min = 40 minutes` from creation
  (never less than P1's required `max notAfter + 5 min`); stage chunks older than 15 minutes;
  orphan tombstones; events retention.
- **Time.** Every time-dependent operation takes `nowMs` from the caller. The app's JS passes its
  injectable clock (so the P1 contract's 15-minute test can run), the extension passes real time.
  The Swift package has a `Clock` protocol for the XCTest port.
- **Who owns which transition.** The extension only writes `tmp`, `ids`, `pending`, `stage`,
  `withdrawn` (from `pending`), and deletes `results`. The app does everything else. The only
  shared mutation points are `link` (create-exclusive; atomic across any number of extension
  instances), the `pending → accepted` / `pending → withdrawn` race (6.11), and unlinking a result
  (idempotent), so no lock is needed. Safari may run several handler instances at once; all of
  this is safe for that.

**Sealing.** AES-256-GCM (CryptoKit), a fresh random 96-bit nonce per file, stored as
`nonce ‖ ciphertext ‖ tag`. Additional authenticated data is `"bsv-bridge/v1|" + kind + "|" + id`
(`kind` one of `record`, `result`, `event`, `mirror`, `chunk:<n>`), so a sealed file cannot be moved
to another id or role. One 32-byte key for the container.

**Key.** A generic-password keychain item with an explicit `kSecAttrAccessGroup` equal to the bridge
group, accessibility `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synchronised. The
**app creates it** during module init (add-or-read; on `errSecDuplicateItem` read again). The
extension never creates it: if it is missing, the extension returns `CONFIGURATION_ERROR`
(`not-sent`, "wallet not set up"). A `KeyProvider` protocol hides the keychain so tests can use an
in-memory key.

**Reset.** `reset()` (app): delete the key item, remove the whole container, delete the continuity
keys (6.9), write nothing. Called from the `logout` teardown hook (6.5; Delete Wallet reaches it through `logout()`), and final until the next `init()`: until then the module refuses `writeMirror` and every other write (including late `writeEvent`/`writeResult` calls from work already in flight, which reject and are swallowed by the processor's own warning path), and `init()` creates a fresh key. `reset()` is a synchronous native function (file removal and one keychain delete), because a teardown hook cannot await. Anything sealed under the old
key becomes unreadable noise even if some file survives.

### 6.5 The mirror

The extension needs the app's state while the app is not running. The app writes a **mirror**: one
sealed file, `meta/mirror.sealed`, replaced atomically. The extension only reads it. It is separate
from P1's `BridgeSnapshot` and may be extended without a P1 change.

```
{ v:1, writerBootId, writtenAt,
  snapshot: { schema, baseVersion, network, accountContext, walletRevision, readiness, closeSeq },
  identityKey,              // 33-byte compressed key as hex, or null unless readiness is 'ready'
  identityKeyPrompts,       // the policy flag seekPermissionsForIdentityKeyRevelation (verified set)
  connected }               // sorted list of connectedHash for browser-attested connected sites
```

`connectedHash(origin) = hex(SHA-256("bsv-bridge/connected/v1|" + origin))` where `origin` is the
canonical origin string. Using hashes is only to keep a plain list of visited sites out of a
structure the extension reads constantly; the file is sealed anyway.

**When it is written** (`mirror.ts`, a P2 module in the app):

- Never before the bridge runtime has loaded. The writer starts after P1's `isBridgeHostAttached()` is true.
  The pre-init snapshot (`readiness 'none'`, `walletRevision '0'`, `closeSeq 0`) is never mirrored: a
  mirrored revision `'0'` would make the extension close every epoch bound under a later revision. Once
  attached, every snapshot is mirrored, including a real `none` (no wallet, fresh install), except the
  detach-induced one and anything after a logout reset (below).
- On every `onSnapshotChange`, on every consent store change (a site connected or revoked), on
  policy change, and when the app becomes active.
- `identityKey` is the active profile's identity key, taken from the wallet the way the host
  already does, and set to null whenever `readiness` is not `ready`. A test asserts it equals what
  a connected site gets from `getPublicKey({identityKey:true})` through the P1 dispatcher.
- `connected` is the sorted `connectedHash` list built from `listConnectedSites()` filtered to
  `attestation === 'browser'` (the call returns every attestation), hashing each entry's `applicationOrigin`.
  The dispatcher's skip-sheet predicate for a verified site is `consent.lookup(origin, attestation)`
  (`consent.ts:244-251`); it has no wallet-revision term, and the browser attestation bypasses the reconnect
  check (`dispatcher.ts:357`). The mirror therefore lists exactly the sites that lookup would skip, not a
  revision-filtered subset. Unverified records are never listed.
- **Ordering with close events.** `fanOutClose` raises the snapshot's `closeSeq` synchronously,
  while the processor writes close events asynchronously. A mirror write that shows `closeSeq` N
  must not become durable before event N is. The writer awaits `processor.flushEvents()` (a small
  P1 addition, 6.15 item 6) before every write. This applies to the ordinary write path only; the logout
  path does not flush (it deletes the events). The extension still never trusts the mirror's
  `closeSeq`: its cursor is the highest event it actually read (6.10).

**Writer lifecycle and reset.** `runSessionTeardown` is synchronous and `logout()` relies on teardown having
happened before its next await (`sessionTeardown.ts:38-48`), so the hook cannot await `flushEvents` or a
mirror write. Delete Wallet is `logout()` (`WalletContext.tsx:4097`, comment at `:4264`), so it already fires the
`logout` teardown; the host adds no second call. On `logout` the hook runs, synchronously: (1) disable the
writer and drop its queued writes, (2) `reset()` (6.4), which deletes the container data and the key. The
extension therefore sees `absent` (6.10), not `none`, after a logout or Delete Wallet. The mirror never shows
`none` for this path; that is intended and costs nothing, because `absent` already means no announce, no local
answers and connect refused, and 6.10 makes it also close every epoch the extension holds (the events outbox is
deleted with the container, so close events cannot be relied on). The writer stays disabled until the next
`init()`; nothing recreates the mirror or the key in between. Profile, network and rebuild teardowns do not
reset: they only change the mirror (readiness leaves `ready`, `walletRevision` bumps). A real `none` (a fresh
install, no wallet) is still mirrored.

**Detach-induced `none` is not mirrored.** P1's host detach (`runtime.ts:344`, Fast Refresh or provider remount)
sets `readiness: 'none'` with no wallet change. The writer checks `isBridgeHostAttached()` both in the snapshot
callback and again immediately before each file write, and skips the write when it is false. The last mirror
stays, exactly as when the app is dead (12 item 4), and the next attach writes a fresh one, so the extension
never answers `CONFIGURATION_ERROR` to a connect because of a remount. (`detach` and a logout `none` are
told apart differently. P1's own logout teardown is registered at attach, before the kit's hook, and runs
first (`sessionTeardown.ts:38-48`): it closes bindings and sets `readiness: 'none'` while the host is still
attached, so the writer's snapshot callback does fire for logout. The write itself is asynchronous (it awaits
`flushEvents()` first), and the kit's hook disables the writer synchronously in the same teardown pass, so the
writer must re-check its disabled flag immediately before each file write, as it re-checks attachment. Then a
logout `none` is never written, and `reset()` leaves the container `absent`. A mirror test pins this order.)

**Profile switch.** P1 bumps `walletRevision` on any manager replacement (6.15 item 8). The extension refuses
to answer from a mirror whose `walletRevision` or `accountContext` differs from the epoch's stamped values and
closes that epoch with `account-changed` at reconcile (6.10), so a stale mirror can never answer for a new
profile.

**Staleness.** The mirror is correct while the app runs and stale when it is dead, and the extension cannot
tell which. That is accepted (12, item 4). `writerBootId` and `writtenAt` are kept for diagnostics and for a
possible freshness rule later.

### 6.6 Native module and JS adapter

**Native module `BsvBridge`** (Expo module, so no nitrogen step; the surface is small). All calls are
async except where noted. Binary values cross as base64 strings unless the Expo version in use
passes `Data` natively.

| Call | Purpose |
|---|---|
| `init({ nowMs })` → `{ bootId }` | create the key if absent, set directory attributes, run sweeps, return the boot id |
| `create / stat / read / accept / release / claim / writeResult / readResult / ack / list` | the store contract, 1:1 |
| `writeEvent / readEventsAfter` | events outbox |
| `writeMirror(bytes)` | seal and replace `meta/mirror.sealed` |
| `sweep({ nowMs })` | the sweeps in 6.4 |
| `reset()` | 6.4 |
| `subscribeNudge()` | Darwin notification from the extension, delivered only while the app is active |
| `rawBytes()` | async, debug builds only: every stored file's raw bytes, for the Simulator plaintext-marker test |

**JS adapter `nativeStore.ts`** (`createNativeInboxStore(native, { now }) → InboxStore`):

- `bootId()` and the contract's other synchronous members are served from values cached at `init`.
  The adapter is only constructed after `await native.init()`.
- The adapter has no `rawBytes`, and `rawBytes()` leaves the P1 `InboxStore` interface (6.15 item 7). The contract runner takes the raw-bytes provider separately: the harness becomes `StoreHarness { store, restart(), rawBytes?: () => Uint8Array[] }` and the plaintext-marker test calls `harness.rawBytes()`, skipping with an explicit failure message if a harness omits it. The memory adapter's harness supplies its own bytes; the native harness supplies `fakeNative.rawBytesSync()`, a test-only member. The native async `rawBytes()` is debug-only and serves the Simulator e2e plaintext-marker test (10).
- Every call maps native errors to the contract's return values (for example a missing file is
  `undefined`), and rethrows real failures so the processor's own warning path (it swallows
  `writeResult` failures) is exercised in tests.
- One adapter instance, one processor instance. Two processors would release each other's accepted
  records on `recover()`, so `SafariBridgeHost` is a singleton guarded for Fast Refresh (6.7).

### 6.7 App runtime

`SafariBridgeHost` is a component rendered once, inside the host's `BrowserBridgeProvider` (and
inside `WalletContextProvider`), next to `PermissionSheet`. It renders `DoneScreen` and `Toast`
and nothing else. All behaviour is in its effects.

**Startup order** (each step waits for the previous):

1. `await native.init()`; build the adapter.
2. Wait for P1's `isBridgeHostAttached()` (hooks attached and the runtime loaded).
   `getBridgeSnapshot().walletRevision !== '0'` is not a valid signal.
3. `registerTransport({ id: 'safari-extension', attestation: 'browser', bindingMode: 'implicit',
   requestAttention })`. Register before the processor can handle anything: admission refuses unregistered
   transports with `CONFIGURATION_ERROR`. Never pass `deliverReconnectToken`. Keep the handle and call
   `unregister()` on unmount and Fast Refresh (duplicate ids throw).
4. Create the processor: `createInboxProcessor({ store, dispatch: receiptDispatch, bindings, now, transport:
   { id, attestation } })`, where `bindings` is `getBindingRegistry()` (the dep is a `Pick` of it,
   `inbox.ts:133-138`) and `now` is the clock the adapter uses (a required dep). Then `await processor.recover()`.
5. Start the mirror writer (6.5). Register a teardown hook with `registerSessionTeardown`
   (`core/context/sessionTeardown.ts:23`; reasons `logout | profile | network | rebuild`) for `logout` only:
   it synchronously disables the writer and calls `reset()` (6.5). The hook is the single path for logout and
   Delete Wallet (`logout()` runs `runSessionTeardown('logout')`); the host calls nothing itself. The kit exports
   `resetSafariBridge()` only as the function the hook calls and for tests.
6. First `drain()`.

**No drain gate: readiness parks.** There is no `walletLoaded` prop and no grace timer. Draining relies on P1
readiness from the snapshot. While readiness is `building` or `blocked`, accepted records stay parked with no
deadline (BRC-219; P1 6.8 already does this) and the existing wallet-not-ready handling shows the unlock path.
`CONFIGURATION_ERROR` / `not-sent` only when readiness is `none` (no wallet). Cold start needs one P1
guarantee: for an install that has a wallet, the snapshot is never `none` between attach and the first build
(6.15 item 9; an early plan task checks it).

**Drain triggers.** All call one function, `drain()`, which runs `processor.sweepExpired()` and
`processor.processPending()` and never awaits the latter in a native callback (a record parked
behind a sheet keeps it open as long as the user takes).

- A bridge URL: `Linking` `url` events and `getInitialURL()` for cold start. The URL is accepted only
  if its scheme equals `BSVBridgeScheme`, its host is `bridge` and `v` is `1`. Every other part
  (including the nonce) is ignored and never trusted: the URL is a doorbell, not data, and the handler only nudges the inbox processor (`drain()` un-awaited).
- `AppState` becoming `active`. This also picks up disconnect records and covers a user who opens the
  app by hand.
- A Darwin notification nudge from the extension, honoured only while the app is active.
- Startup step 6, once.
- A timer: `sweepExpired()` every 60 seconds while the app is active (P1 has no internal timer).

`app/+native-intent.ts` in the host must return `/` for bridge URLs, as it does for
`DEV_CLIENT_LINK`, so Expo Router does not try to route them (6.13).

**`requestAttention(reason, binding)`** on iOS. The handoff already put the app in front, so it
does nothing visible for `consent`, `wallet-not-ready` or `prompt`. It does one thing: it marks the
binding's current drain as "needed the app" for the receipt (6.12). Local notifications are deferred
(decision, accepted calls). The function is synchronous and cheap, as P1 requires.

**Receipts.** `receiptDispatch(arg)` wraps P1's `dispatch`. It calls it, and when the `Outcome`
returns it builds a receipt `{ origin, method, summary, ok, neededApproval, epoch }` from the
request and the outcome. `neededApproval` is true if any of these fired for the same
binding while the call was in flight: `requestAttention('consent' | 'wallet-not-ready')`, or P1's
`onPromptRaised(binding)`, the optional transport member added in 6.15 item 5 (the existing `'prompt'` attention
is skipped when the app is active, so it cannot see foreground sheets).

### 6.8 The extension

| Piece | World | Job |
|---|---|---|
| `provider-main.js` | page | Builds the frozen handle, announces, answers `brc185:request-provider`. Holds nothing and decides nothing. |
| `content.js` | isolated, per frame | Relays between the page and the background. Owns the pending-invoke table and the poll and reconcile triggers. |
| `background.js` | non-persistent (unloaded after about 30 s idle) | The only caller of native messaging. Attests origins, reconciles, stages, hands off. Stateless apart from `storage.session`. |
| `SafariWebExtensionHandler.swift` | appex, short-lived | Stateless request handler over `BsvBridgeQueue` and the continuity key. |
| `popup` | extension page | Status and "Always Allow" guidance. No approval step. |

**Injection.** The page-world script is a manifest content script with `"world": "MAIN"` at
`document_start`. Whether Safari honours that on iOS is unproven (spike S3). The fallback is the
isolated script adding `<script src="…">` for a `web_accessible_resources` file, which fails under a
strict page CSP. Both are built; the manifest uses the first, and the kit's tests run both.

**Page to content script.** The page-world script hands the content script a `MessagePort` once,
and all traffic then rides the port. A page that forges messages to its own content script can only
affect itself. Each frame has its own content script, port and handle.

**Page wire: BRC-185 §4.2, exactly.**

- *Events.* The controller dispatches `brc185:request-provider` on `window` with detail `{version:1, requestId}`
  (UUIDv4). The page-world script answers each fresh request once, keyed by `requestId`, with
  `brc185:announce-provider` and detail `{version:1, requestId, handle}`. It announces only in answer to a
  request (no unsolicited announce at load; controllers limit those). It never touches `window.CWI`, and
  announcing or describing never raises a wallet prompt (§3, §4.2). It answers even when the mirror is absent
  or `none` (§4.2 requires an answer): describe needs no wallet, and connect then fails (6.9).
- *Handle.* A frozen object with `describe(origin, challenge)`, `connect(origin, epoch, onClose):
  Promise<WalletInterface>` and `disconnect(epoch): Promise<void>`. `epoch` is the controller's UUIDv4;
  `challenge` is 32 random bytes as canonical unpadded base64url, validated in the background (§3).
  `onClose(reason)` reasons are `account-changed`, `revoked`, `lost`. The returned interface is bound to its
  epoch and cannot be retargeted. The 200 ms collection window and 1000 ms describe deadline are the
  controller's (§4.2).
- *All 28 methods* are carried with their existing JSON shapes, no allowlist and no negotiation (§1, §11).
- *Where BRC-185 is open, P2 defines it and project 3 conforms:*
  (a) `connect` on the window handle has no challenge parameter, so P2 returns no connect proof and does not
  use `signConnect`; identity is proven by `describe` under the same origin and context before `connect` (§3).
  (b) The endpoint record is `{id:'window', type:'window', address:'safari-extension'}` (the address is an
  opaque adapter-local handle, §3).
  (c) The `WalletInterface` is a page-world proxy. Its calls travel over the internal MessagePort in the §4.3
  envelope shapes, reused so there is one shape: `brc185:invoke {version:1, instanceId, epoch, id, method,
  params}`, answered by `brc185:result {…, result}` or `brc185:error {…, error:{code, message, data?}}`
  (mutually exclusive, no stack traces), and `brc185:closed {…, reason}` toward the page. The SDK sees only
  promises and `onClose`.
  (d) A connection-layer failure rejects the promise with the §6 `ConnectionError` (`domain:'brc185'`)
  unchanged; a wallet error rejects with the wallet's `{code, message, data}` unchanged.
  (e) Routing fields must match the bound epoch; unknown methods, mismatched fields and an invoke before
  `connect` are `PROTOCOL_ERROR` / `not-sent` before staging (§4.3).
  (f) `disconnect(epoch)` closes the page's own binding and is not echoed as `brc185:closed` (6.11).

**Attestation.** The background takes the origin only from `sender` (`tab.id`, `frameId`, `url`; it
prefers `sender.origin` if present and normalises it, since Safari 26.0 lowercased sender URLs and 26.2
fixed it). It runs P1's `canonicalizeBridgeOrigin` (attestation `browser`) on it. That function refuses a non-canonical origin rather than normalising it, and the extension build has no `__DEV__`, so the build passes `allowLocalhostHttp` explicitly (true only in the plugin's development profile): `https` only, canonical host, `http://localhost:<port>` only when it is true (BRC-185 §4.2: the extension derives the origin itself). The page-supplied `origin`
argument of `describe`, `connect` and `disconnect` must equal the attested frame origin or the call is
refused with `PROTOCOL_ERROR`, `not-sent` (P1's frame rule). The comparison is in the background,
never in the page world. Frames bind under their own origin; a cross-origin iframe never gets the top
origin; frames with no usable origin (`about:blank`, `srcdoc`, opaque) do not announce. The sender
frame's URL is re-read on every call because a frame can navigate and keep its `frameId`.

**Bundle safety.** `protocol/origin.ts:8` imports `../../config` and `core/bridge/permissionPolicy.ts:14` imports `../config`,
which drags the whole app into the bundle. P1 moves the constants into a pure module (6.15 item 2). The
extension relays `InboxResult.error` raw and never imports `errorCodec`.

### 6.9 Continuity key and BRC-185 describe and connect

**Key.** An Ed25519 key per context, generated by the Swift handler (CryptoKit `Curve25519.Signing`,
RFC 8032), stored in the bridge keychain group, `AfterFirstUnlockThisDeviceOnly`, never synchronised.
Private bytes never enter JavaScript. Describe is non-interactive and works while the wallet is locked
and the app is dead, because the extension needs only the first unlock after boot. The handler
checks the public key with the same strong-key rule as P1's `isStrongEd25519Key` before first use.

**Contexts** (author call, 13 item 3). `safari` for normal tabs and `safari-private` for private
tabs, chosen from `sender.tab.incognito`; if that is not a boolean, use `safari-private`. Each context
has its own key and its own `instanceId` (UUIDv4, created with the key). Safari profiles are not
distinguished (not detectable).

**Who signs.** The background builds the preimage in JS with P1's pure `descriptor.ts` (RFC 8785 JCS, prefix
`BRC-185 descriptor v1\n`, §3) and asks native to sign it, then wraps the signature with `signDescribe`. There
is one canonicaliser, the P1 one with its vectors. The Swift `sign` operation checks only that the preimage
starts with that literal prefix and is at most 16 KiB (the connect prefix is not accepted: P2 returns no
connect proof, 6.8). The page world cannot reach `sign`: the preimage comes from a descriptor the background
built, an origin it attested and a 32-byte challenge it validated.

**Descriptor (§3).** `version 1`, `instanceId` (lowercase UUIDv4, created with the key, per context), `name`
(1 to 80 UTF-8 bytes, from the plugin), `instanceLabel` empty, optional `icon` (§3.1; not set in P2), `vendor`
(lowercase reverse-domain from the bundle id), `continuityKey` (base64url of the 32-byte Ed25519 public key)
and the single `window` endpoint of 6.8. No unknown fields. Responses are at most 16384 bytes. The key and id
persist across restarts and rotate on `reset()`, which makes a new provider (§3).

**describe(origin, challenge).** Noninteractive (§3, §4.2). Frame-rule check, canonicalise, `identity` (native, creates the key if
absent), `signDescribe`. It does not need the wallet and answers from any mirror state. Target: one
native round trip, well inside the 1-second budget (spike S2 measures the cold-appex cost; if it
cannot meet the budget the answer is `CONFIGURATION_ERROR`, never a hang).

**connect(origin, epoch, onClose).** Reconcile (6.10). If the mirror is absent, `none`, or has no
`accountContext` (written while building), refuse with `CONFIGURATION_ERROR`, `not-sent` (author call 13.4).
Otherwise stamp `{ accountContext, walletRevision, boundAt: now }` from the mirror, save the binding in
`storage.session` keyed by `(instanceId, epoch)` with `{ tabId, frameId, origin, continuityKey,
accountContext, walletRevision, boundAt }`, and return the epoch-bound interface (no connect proof, 6.8). The
24-hour admission horizon applies on the app side; the extension closes its own epochs at 24 hours with cause
`lost` so the page reconnects before it is refused.

**Connect does not wake the app. This is intended.** BRC-185 keeps discovery and connection noninteractive at
the wallet-permission layer (§3), and owner decision 2 forbids a forewarning step. The first interactive call
stages a record, hands off, and the core raises the connect sheet (P1 6.4, 6.12). Probes answer from the
mirror without a sheet (BRC-219: probes never prompt), and so does the identity key for a connected site.
A page that only connects and probes never opens the app.

**Reset.** `reset()` (6.4) deletes the continuity keys. After it, the next `identity` makes a new
provider identity, and old epochs fail P1 `resolve` with `PROVIDER_CHANGED`.

### 6.10 Reconcile and local answers

**Reconcile** runs before any local answer, describe, connect or stage. It is one native call,
`sync(cursor)`, returning `{ mirror, events, gap }`.

1. If there is no mirror: state `absent`. No announce, no local answers, connect refused. Close every epoch the
   extension holds with `lost` (the container, events included, may have been reset by a logout or Delete Wallet).
2. If the mirror is not `none`: close every epoch this extension holds whose `walletRevision` differs
   from the mirror's. If the mirror is `ready`, also close those whose `accountContext` differs.
   Reason `account-changed`.
3. Apply the events: for each event whose `(instanceId, epoch)` the extension holds, close it with the
   event's reason, and emit `brc185:closed` unless `notifyPage` is false (page-initiated disconnects
   are not echoed). Closing one tab's epoch never closes another's.
4. If `gap` is set, close every epoch with `lost`.
5. The cursor becomes the **highest event `closeSeq` actually read**, not the mirror's, and is saved in
   `storage.session`. A copy in native storage is the fallback if extension storage is wiped; if both
   are lost the cursor restarts at 0, which replays events harmlessly (closes are idempotent).
6. Drop epochs older than 24 hours with `lost`.

**Local answers.** Only these three, each requiring the epoch to be bound and the call to have passed
the origin and size checks:

| Method | Answer | Rule |
|---|---|---|
| `getVersion` | `{ version: snapshot.baseVersion }` | mirror present and not `none` |
| `isAuthenticated` | `{ authenticated: snapshot.readiness === 'ready' }` | mirror present and not `none` |
| `getPublicKey` | `{ publicKey: mirror.identityKey }` | the identity-key rule below |

The probes need no connection (P1 anti-goal: probes never prompt). Staleness is accepted (12 item 4).

**The identity-key rule** (the owner asked for the exact conditions). This is a recorded deviation from owner decision 5 (author call, 12 item 1): the answer is local only for connected sites; an unconnected site's `getPublicKey` goes to the app and through consent like any interactive call (P1 6.4). The owner's intent holds: a connected site never wakes the app for its identity key. The extension answers
`getPublicKey` locally if and only if all of these hold, evaluated after reconcile, on every call:

1. The arguments are exactly `{ identityKey: true }`: no `counterparty`, `forSelf`, `privileged`,
   `seekPermission`, `protocolID`, `keyID`, `originator` or any other key. Anything else goes to the
   app.
2. The epoch is bound here and not closed.
3. `mirror.snapshot.readiness` is `ready`, and `mirror.snapshot.walletRevision` and `accountContext`
   equal the values stamped in the epoch (so a mirror from before a profile switch, whose revision P1 bumped, never answers).
4. `connectedHash(origin)` is in `mirror.connected`. A site that is not connected always goes to the
   app, where the connect sheet appears, so the cache can never answer for a site the user has not
   connected (P1 anti-goal; also what `seekPermission: false` from an unconnected site relies on).
5. `mirror.identityKeyPrompts` is false. When the user's policy asks before revealing the identity key,
   every call goes to the app.
6. `mirror.identityKey` is a non-null 66-character hex string.

**Where the cached copy lives and when it is cleared.** The only copy is the mirror's sealed
`identityKey` field (the extension keeps no second copy of it, so there is nothing to forget). The
app clears it by rewriting the mirror whenever readiness leaves `ready`: logout, profile or network
switch, rebuild, wallet replacement, and teardown all pass through there. The `connected` list loses
the site on revoke, and the epochs close through the normal close events. The extension drops its
epochs on close, tab close and frame unload. Therefore the answer is valid exactly while the epoch is
open under the same `walletRevision` and `accountContext`, the site is still connected, readiness is
`ready`, and the policy does not ask.

If the app closes a connection in the instant before the mirror and event are durable, the extension
can answer once more for a site that was just revoked. The window is one event write (6.5, ordering)
and the answer is a public key the site already had.

Every other method (28 minus the three, including every `getPublicKey` that does not meet the rule)
is staged and handed off (6.11).

### 6.11 Staging, handoff, pickup, cancel, tab close

**Native-message operations** (one JSON request, one JSON reply, stateless handler; the application
id argument is ignored by Safari):

| Op | Does |
|---|---|
| `sync(cursor)` | mirror, events after cursor, gap flag |
| `identity(context)` / `sign(context, preimage)` | continuity key (6.9) |
| `stage(id, bytes)` or `stageBegin / stageChunk(n) / stageEnd(id)` | write a record |
| `withdraw(id)` | take back a record that is still `pending` |
| `results(ids)` | read results for those ids |
| `ack(ids)` | delete those results |
| `nudge()` | post the Darwin notification |

**Message size** is unmeasured (spike S2) and a request can be 5 MiB. So the contract includes
chunked staging from the start: records over `STAGE_CHUNK_BYTES` (default 48 KiB, to be set by the
measurement) travel as sealed chunks in `stage/<id>/<n>` (each chunk sealed on arrival, so no
plaintext touches disk), and `stageEnd` unseals, joins, checks the length and digest, re-seals the
record and runs `create`. Results use the same framing in reverse (`results` returns `{ id, part,
parts }`). Chunks are idempotent by `(id, n)`.

**Record.** `{ v:1, id, kind:'invoke', epoch, instanceId, continuityKey, origin, accountContext,
walletRevision, boundAt, method, args, createdAt, notAfter }` exactly as P1 6.8 states, with
`notAfter = createdAt + 15 min`. `id` is a UUIDv4 **minted by the extension**, never the page's
invoke id: record ids are install-wide create-exclusive, so a page could otherwise squat a known id.
The extension keeps `(instanceId, epoch, invokeId) → recordId` in `storage.session`. A repeat of the
same page invoke id reuses the mapping and does not stage again.

**Stage, then trigger.** `stage` is acknowledged by native before any handoff, so the app never wakes
to an empty queue. The extension then calls `tabs.update(sender.tab.id, { url })` with
`url = <B>://bridge?v=1&n=<random nonce>`. The URL has no id, origin or payload. The nonce keeps
repeated triggers distinct.

**Idempotent retries.** A native message can fail to call back. Each op carries its record id, has a
5-second timeout and is retried up to three times. A repeated `stage` of the same id with the same
digest returns `exists` (success); the same id with another digest is an error. If all attempts fail,
the extension calls `withdraw`. `withdraw` is `rename(pending → withdrawn)`; the app's `accept` is
`rename(pending → accepted)`. Exactly one wins. If `withdraw` wins, the request was certainly not
sent: the page gets `CONFIGURATION_ERROR`, `not-sent`. If it loses, the app has the record, so the
extension keeps waiting for its result like any other. If even `withdraw` cannot be confirmed, the
page gets `CONNECTION_CLOSED` with delivery `unknown` and the id is kept in `closing` to be withdrawn
at the next wake. This is also the hook for project 3's page-side cancel.

**Coalescing.** Records staged while a handoff for the same tab was sent within the last
`HANDOFF_COALESCE_MS` (3 seconds) share it; the wake drains them all anyway (decision). After that
window the next page call re-triggers, which is the only retrigger after a Cancel (decisions). The
value is a starting point for spike S5.

**In-flight limits (the extension stays under the dispatcher's).** `processPending` starts every
pending record at once, and the dispatcher answers `RESOURCE_LIMIT` / `not-sent` instead of queueing
when it exceeds 4 in flight per epoch, 16 in total, or 5 MiB in flight. The extension tracks
unresolved records (staged or in flight, no result yet) across **all** tabs in `storage.session` and
refuses a new invoke locally with `RESOURCE_LIMIT`, `not-sent` when it would pass 4 for the epoch, 16
overall or 5 MiB overall. It therefore never produces the error by batching (anti-goal). P1's
8-per-origin and 64-overall binding limits are respected the same way: connect past them is refused
locally.

**Pickup.** The content script owns the pending table `(recordId → resolve)`. It polls the
background with the ids it holds on: `visibilitychange` to visible, `pageshow`, `focus` (the main
trigger, because Safari is suspended while the user is in the wallet and these fire when they come
back), a timer while pending and visible (1 s, 2 s, 5 s, capped at 5 s, off when hidden), and the
page's next call. The background runs `results(ids)`, reconciles, converts each `InboxResult`, `ack`s
and replies. Conversion (6.8 page wire): `ok` becomes `brc185:result`; any error becomes `brc185:error` carrying the raw error object unchanged (a `domain:'brc185'` `ConnectionError`, or the wallet's `{code, message, data}`), and the page-world proxy rejects with it.

A pending call never times out in the extension (BRC-219). It resolves on a result, an error or a
close. If the result was purged (15 minutes unacknowledged), `readResult` says `purged` and the page
gets `CONNECTION_CLOSED`, `unknown`, "The result is no longer available" (P1's
`resolveInboxResult`). The visibility trigger exists to avoid this.

**Cancel.** The extension cannot see a Cancel on Safari's prompt. The page's next call re-triggers.
The earlier record stays queued and runs when the app next drains, as the earlier call asked
(they are two calls). If a record is never accepted, it expires after 15 minutes as
`CONNECTION_CLOSED`, `not-sent` (the only pre-acceptance deadline, P1 6.8).

**Tab close and frame unload.** Detection: a long-lived port from each content script
(`onDisconnect`), `tabs.onRemoved` (registered at top level so it wakes the background; the sender is
gone by then, so the `tabId → epochs` map in `storage.session` is used), `tabs.onUpdated` for a
top-frame navigation, and on every cold wake a `tabs.query` over the known tab ids. Each hit puts the
epoch into `closing` with a timestamp; entries older than 5 seconds that the content script has not
re-registered (a page restored from the back/forward cache re-registers) become
`kind:'disconnect'` records with the full tuple and no method or args. **No handoff** for
disconnects: the app writes the close event with `notifyPage: false` the next time it drains. If no
invoke was ever staged for the epoch, the app has no binding, so the extension just forgets the
epoch and stages nothing. Staged but unanswered records for a closed epoch stay in the queue; P1's
tombstone makes them resolve as `PROVIDER_CHANGED` or `CONNECTION_CLOSED` (P1 6.6, 6.8). If the tab
dies while the background is unloaded, the disconnect is written at the next wake; until then the
app counts the binding toward its limits, and the 24-hour horizon bounds it.

### 6.12 App-side UX

**Merged Connect sheet** (decision 6). It extends P1's connection sheet in the toolbox and applies to every
bridge connection sheet: browser-attested and unattested attestation alike. The in-app browser has no
connection sheet and is unaffected. The manifest group request only exists once a call runs inside the
permissions manager, so the core previews the group before the sheet and mints it directly on Connect. There is
no pre-approval registry and no item matching.

- **Preview.** Before showing the sheet, the core peeks the manifest group for this origin and the binding's
  attestation through the **same** `SigningPolicyPermissionsManager` that will later check it, using its
  `fetchManifestPermissions` (5-minute cache, so the later check reads the same manifest). The dispatcher awaits
  it under `untilClosed`, with a short timeout, before `requestConsent`, and passes the result in the consent
  request. Ask-every-time protocols (BRC-29 and so on) are already filtered out of the fetch and never appear.
  A failure, timeout or empty manifest gives a plain connect sheet, not an error.
- **Content.** P1's connect information (site, "Verified by Safari", what it can do, what it will ask first,
  the remember line), then the listed permissions, read-only, in the existing group sections (spending with its
  amount, protocols, baskets, certificates). Spending authorization is included, and shown with its amount, for
  verified sites when the manifest lists it; for unattested sites it is already stripped (P1 6.5). No checkbox,
  no switch. Buttons: **Connect** and **Don't connect**. `bridge_connect` and `bridge_dont_connect` are the
  connection kind's own strings (the shared `reject` and `authorize` stay with other kinds).
- **Connect** records the consent as P1 does and mints every listed item as permission tokens through the
  manager's existing per-item grant/mint path, the one `grantGroupedPermission` runs for a granted item (items
  that already hold a token are skipped). The plan finds the exact seam and may add one public manager method
  that mints a group without an active request. The sheet lists exactly what is minted. When the manager later
  checks the group the tokens exist, so no second sheet appears. If minting fails after consent is recorded, the
  connection stands and the later group check falls back to today's group sheet.
- **Don't connect.** The parked request gets P1's decline result (`USER_CANCELLED`). Nothing is recorded or
  minted, and P1's 30-second decline backoff applies. Today's group sheet differs: its Dismiss lets the site
  continue.
- **Already connected sites** skip the sheet (`consent.lookup(origin, attestation)`, 6.5). If the manifest has
  since gained items, today's standalone group sheet appears, unchanged.
- P1's conformance note about `waitForAuthentication` prompting after connect (P1 9) changes deliberately for
  this path, and its snapshot test with it.

**Done screen and toast** (decision 7; component in this package, copy in the toolbox's i18n).

- The done screen shows when a receipt has `ok` and `neededApproval`, the app is active, and no
  permission sheet is open or queued. A later sheet replaces it. Copy: ✓, "Sent to {site}", the
  summary line, and "Tap ◀ Safari in the top left to go back" (author call: wording). No button.
  It is dismissed by tapping it or by the app going to the background. It has no timer, because the
  user may take as long as they like.
- Summary line by method (author call, table kept in `receipts.ts`): `createAction` or `signAction`
  with net spend becomes "Payment approved · {amount}" (amount from the request's outputs, in the
  user's display format, exact); other `createAction` becomes "Action approved"; signatures, HMACs,
  encryption and key linkage become "Signed" / "Encrypted" / "Approved"; certificate calls become
  "Certificate shared"; anything else becomes "Approved". A first-ever call includes the connect: the
  summary is still the method's.
- A batch produces one screen. One site and one receipt: that receipt. One site, several: "{n}
  requests approved". Several sites: "Sent to {n} sites".
- The toast is a short banner, 2.5 seconds, "Done · ◀ Safari", for a bounce that needed no approval
  (for example only disconnects, a cached call that still woke the app, or a call the policy
  auto-approved). A failed or declined call (`ok` false) shows "Not completed · ◀ Safari" the same way
  (author call: the owner designed only the success cases).
- Keys, all under the `bridge_` prefix in the toolbox's `translations.tsx`, in **all 12 locales**,
  with a wording test next to `bridgeConnectionWording.test.ts`: `bridge_done_sent_to`,
  `bridge_done_payment`, `bridge_done_action`, `bridge_done_signed`, `bridge_done_certificate`,
  `bridge_done_approved`, `bridge_done_n_requests`, `bridge_done_n_sites`, `bridge_done_back_hint`,
  `bridge_toast_done`, `bridge_toast_failed`, `bridge_connect`, `bridge_dont_connect`,
  `bridge_setup_*` (6.12 below). The chip glyph "◀ Safari" is kept untranslated as iOS shows it.

**Onboarding guidance (`SafariSetupGuide`, plus the popup).** Without site access the content script
never runs and the page never sees the wallet. The app cannot detect the setting, so the guidance is
text, not a gate: a card the host places in onboarding and in Settings, with the steps (turn the
extension on in Settings → Apps → Safari → Extensions; then for sites choose "Always Allow", either
for all websites there or per site through aA → the extension → Always Allow) and why. The
extension popup, which opens even before site access is granted, shows the same steps, and whether
this tab's content script answered a ping, as the status line. iOS gives no link into the Safari
extensions page, only into the app's own Settings, so there is no button for it.

### 6.13 Adoption in bitcoin-sv-wallet

1. `app.config.js`: add the plugin with `appleTeamId` set (`SV8SWTHA2H`, from `eas.json`'s submit
   profile) and `ios.bundleIdentifier` unchanged. Rewrite the header comment (lines 11-13) that says
   never to add keychain or application groups: now "only the bridge groups, shared with the app's own
   extension, never with other apps".
2. `__tests__/isolation.test.js`:
   - the allow-list test (`no keychain access group, app group or other sharing entitlement`)
     becomes an exact-value test: app groups equal exactly `["group.org.bsvblockchain.wallet"]`;
     keychain groups equal exactly the host group followed by `…wallet.bridge`; no entitlement names
     any other bundle id; `aps-environment` and associated domains still present. It reads the
     **resolved** config after plugins run, because the plugin adds the entitlements (the current test
     reads only `config.ios.entitlements` and would pass silently).
   - the same exact assertions for the extension target's entitlements.
   - "registers exactly the URL schemes the existing app uses" and "the link adapter resolves every
     wallet scheme the config registers" gain the bridge scheme as an explicit, named exception
     (it is a doorbell and `+native-intent` does not route it).
   - a new test pins that the App Group holds no wallet database and no SQLite file (the queue
     layout in 6.4 is the only content).
3. `app/+native-intent.ts`: `redirectSystemPath` returns `/` for `<bundle id>://bridge…`.
4. `app/_layout.tsx`: mount `BrowserBridgeProvider` (not mounted yet), then `SafariBridgeHost`
   inside `WalletContextProvider`, next to `PermissionSheet`.
5. No reset call in the host: logout and Delete Wallet both run `logout()`, which fires the `logout` teardown, and `SafariBridgeHost`'s hook resets the bridge (6.5, 6.7 step 5). A host test pins that Delete Wallet reaches the hook once (`reset()` runs once, not twice).
6. Settings and onboarding place `SafariSetupGuide`.
7. EAS: register the extension bundle id and the App Group capability for both identifiers; the
   `eas.json` credentials gain the extension automatically through apple-targets.
8. Policy docs `docs/2026-10-09-now-app-handover.md` (line 19) and `…-now-app-matrix.md` (lines
   30-31) get an addendum: the new groups are shared only with the app's own extension, per P1 spec
   section 2. Their isolation claim is about two installed apps, and still holds.
9. **Upgrade gate.** The keychain default-group change is the highest-risk step for a wallet with
   real users' data. A build with the kit is installed over a build without it on a device with real
   Vault and secure-store items, and every item must still read (spike S6) before any release.

### 6.14 Multiple wallets on one phone

Each wallet ships its own extension with its own bundle id, scheme, App Group, keychain groups,
continuity key and sealing key (all derived, 6.2). Nothing is shared and nothing can be, because the
groups are named by bundle id and entitlements are enforced by signing. The page sees one
announcement per wallet, distinguishable by `continuityKey` and not by name (two builds can have the
same name). Each extension's handoff opens only its own scheme. Choosing is project 3. Test: two
differently-identified builds of the kit on one Simulator, both announcing on the same page, with
requests going only to the chosen one.

### 6.15 Changes required in project 1 (toolbox)

Must-have, small:

1. **Exports.** All of these are new exports from `core/bridge/index.ts`; none is exported today:
   `createInboxProcessor`, `InboxStore`, `InboxProcessor`, `inboxDigest`, `resolveInboxResult`,
   `createMemoryInboxStore`, `dispatch`, `getTransport`, `onBindingClosed`, `isBridgeHostAttached`,
   `initBridgeRuntime`, `getBindingRegistry`, and the pure `protocol/*` modules the extension bundles. The
   teardown registry is `registerSessionTeardown` in `core/context/sessionTeardown.ts:23`; it is not exported
   from `core/bridge`, so export it there or import it from `core/context` (the plan picks).
2. **Bundle-safe origin module.** `protocol/origin.ts:8` imports `../../config` and `core/bridge/permissionPolicy.ts:14` imports
   `../config` (both reach `ADMIN_ORIGINATOR`). Move `ADMIN_ORIGINATOR` and the unverified-originator constants into a pure module with no
   app imports so the extension can bundle `canonicalizeBridgeOrigin`. Behaviour unchanged: it refuses rather
   than normalises, and `allowLocalhostHttp` is passed by the caller.
3. **Merged connect sheet plumbing** (6.12): the preview through the manager's `fetchManifestPermissions`, a
   `previewGroup` dispatcher dependency, `groupPermissions` on the consent request and `PendingConsent`, the
   connect-time mint (one public manager method if the plan needs it), the sheet rendering, new i18n keys in 12
   locales, changed tests and snapshot. No registry and no change to `groupedPermissionCallback`.
4. **Teardown hook.** The registry exists (`registerSessionTeardown`); only the export or import in item 1 is
   needed. The sheet text needs no change because `safari-extension` already matches its `/^safari/i` test.
5. **`onPromptRaised(binding)`**, an extra optional member of `TransportRegistration`, called from the existing
   `notifyPromptRaised(originator)` (`runtime.ts:375`, exported from `core/bridge/index.ts`), which
   `WalletContext.tsx:1142` already calls from each permission queue's `onEnqueue`. The new member is called for
   every live binding of that originator before the active-app gate, so it fires in the foreground too; the
   existing `requestAttention('prompt')` stays behind the gate, so other transports are unaffected. The plan
   checks that every queue the sheets use (basket, certificate, protocol, spending) passes `onEnqueue`.
6. **`InboxProcessor.flushEvents()`**, resolving when every close event raised so far is durable.
7. **Store contract changes**: events retention (1024 or 24 hours); `readEventsAfter(seq)` returns
   `{ events: InboxCloseEvent[], gap: boolean }` (true when the cursor is older than the oldest kept event);
   `rawBytes()` leaves `InboxStore` and the contract runner takes it from the harness (6.6). Touches
   `inbox.ts:65-70`, `memoryInboxStore.ts` (retention options, default 1024 / 24 h, injectable for tests),
   `inboxContract.ts`, and the `readEventsAfter` call sites in `inbox.test.ts` (`.events`). Contract tests: gap
   after trimming, no gap at the boundary, retention by count and by age.
8. **`walletRevision` bumps on any manager replacement** (profile, network, rebuild). P2 relies on it (6.5); a P1
   test pins it if none does.
9. **Cold-start readiness.** For an install with a wallet the snapshot is `building` from attach until the first
   load result, never `none` (6.7). Verify in an early plan task; change P1 if it fails.

Worth asking, not blocking:

10. The processor holds records behind the dispatcher's in-flight caps instead of failing them with
    `RESOURCE_LIMIT`. The extension already stays under the caps (6.11), so this only improves other producers.
11. Queue a second origin waiting behind the one open connect sheet. Shipped without it (12 item 5).

### 6.16 Stand-in page client and demo page

- `src/testing/pageClient.ts` is a minimal BRC-185 §4.2 controller for tests: it dispatches
  `brc185:request-provider`, collects announcements for 200 ms, calls `describe` with the real
  `window.location.origin` and a fresh 32-byte challenge under a 1000 ms deadline, verifies the Ed25519
  signature and challenge (§3), calls `connect` with a fresh UUIDv4 epoch, invokes methods, and surfaces
  `onClose` and `ConnectionError`. It is not the SDK and not a chooser (project 3). It runs under jest against
  the extension `lib/` with a fake `browser` API, and inside the demo page.
- `demo/` is a static page built on the stand-in client, with buttons for describe, connect, the probes,
  `getPublicKey`, `createAction` and disconnect, and a log of results and errors. It is served from
  `http://localhost:3000` (needs the plugin's development profile) or `https://deggen.ngrok.app` (works with a
  release profile) and drives the Simulator end-to-end tests. It is not in the package's published files, the
  extension bundle or the host app.

## 7. Error handling

Local failures use P1's `ConnectionError` builders from `connectionError.ts` and the same delivery
claims as the core. The page cannot tell an extension-side error from an app-side one, by design.

| Situation | Code | Delivery | Notes |
|---|---|---|---|
| No mirror, mirror `none`, or not ready at connect | `CONFIGURATION_ERROR` | `not-sent` | page may retry after the user opens the app |
| Key missing, queue unavailable, native op failing for good | `CONFIGURATION_ERROR` | `not-sent` | after `withdraw` wins or nothing was staged |
| Page `origin` ≠ attested frame origin; origin does not canonicalise; envelope malformed; method unknown | `PROTOCOL_ERROR` | `not-sent` | checked in the background |
| Over 4 per epoch / 16 total / 5 MiB, or the per-origin / overall binding caps | `RESOURCE_LIMIT` | `not-sent` | local, before staging |
| Epoch older than 24 h, or events gap | `CONNECTION_CLOSED` (cause `lost`) | `not-sent` | page reconnects |
| `walletRevision` / `accountContext` changed | `PROVIDER_CHANGED` / close `account-changed` | `not-sent` | local reconcile or the app's lazy bind failure on first invoke |
| Record not accepted within 15 min | `CONNECTION_CLOSED` | `not-sent` | from the processor |
| Result purged | `CONNECTION_CLOSED` | `unknown` | "The result is no longer available" |
| Could not confirm staging or withdrawal | `CONNECTION_CLOSED` | `unknown` | id kept in `closing` |
| App-side errors (consent declined, permission denied, wallet errors) | as P1 | as P1 | relayed raw |
| Don't connect | P1 decline result | `not-sent` | 30 s backoff applies |

The extension never invents a wallet error. Raw `InboxResult` errors are relayed unchanged.

## 8. Data at rest and security analysis

**What is at rest, and where.**

| Where | Content | Protection |
|---|---|---|
| App Group `bridge/` | sealed records, results, events, mirror, stage chunks; tombstone names; the directory structure | AES-256-GCM per file with id-bound AAD; backup excluded; `CompleteUntilFirstUserAuthentication` on directory and files |
| Visible in the clear | ids (random), sizes, states, timestamps | by design (metadata) |
| Bridge keychain group | sealing key; Ed25519 continuity keys | `AfterFirstUnlockThisDeviceOnly`, not synchronised, explicit group |
| `storage.session` (memory) | tab and frame bindings, record id map, cursor, closing set, unresolved counters | extension storage, not persisted by Safari |
| Wallet database, wallet keys | never in the group | the isolation test pins this |

**Exposure time.** Arguments are deleted at claim, results at acknowledgement, nothing lives past 15
minutes except metadata (tombstones, 40 minutes). Logout and Delete Wallet remove the key and the
container.

**Threats.**

- *Malicious page.* The page world holds no authority. Origin comes from `sender`; the page's claim is
  only compared. A forged `window.postMessage` reaches only its own content script. Record ids are
  extension-minted, so a page cannot squat one. Envelopes are strictly parsed and size-capped before
  staging, and the core parses again.
- *Another app on the phone.* Cannot read the App Group or keychain group (signing). It can open the
  scheme: the URL is a doorbell with no data, so the worst case is an unwanted wake that drains
  nothing new.
- *A hostile or compromised extension background.* It can stage records for any origin it claims. The
  app still checks each against the registered transport, the binding tuple and the connect gate, so
  the blast radius is the extension's code integrity, which is Safari's signing and the App Store.
  It cannot make the Swift handler sign arbitrary bytes (prefix and size check) or read the wallet
  database.
- *Cross-site correlation.* One continuity key per context is shown to every site that calls describe,
  so colluding sites can link a user (12 item 6).
- *Identity key disclosure.* Only to connected sites, only under the rule in 6.10, never when the
  policy asks.
- *Device at rest.* Sealed content is unreadable without the keychain key, which is unavailable
  before first unlock and never leaves the device.
- *P1 anti-goal "key material leaves the app process".* The identity key in the mirror is a public key;
  no private key or permission token is mirrored.
- *Stale mirror.* Can make `isAuthenticated` report true after the app died. It cannot grant
  anything: every action goes through the app, which re-checks.

## 9. Constraints

- Raw sources, no committed build output. No `process.env` in the package; host settings are plugin
  options and props.
- Prettier for TS and JS: no semicolons, single quotes, no trailing commas, `arrowParens: avoid`, width
  120. Swift follows the Xcode default. Run formatters on touched files only.
- Extension permissions stay at `nativeMessaging`, `storage` and `tabs`. A permission increase makes
  Safari disable the extension until the user re-approves, and App Store review reads the list.
- The shared Swift builds with `APPLICATION_EXTENSION_API_ONLY` and must not touch `UIApplication`.
- The kit never edits the host's `app.config.js`, and the plugin's changes are limited to what 6.3 lists.
- Verify with `npx tsc --noEmit -p .` and `npx jest --ci` from the worktree root, without `--forceExit`
  (per the toolbox release rules); `swift test` for the queue package.

## 10. Testing

**TypeScript (jest).**
- P1's `runInboxStoreContract` against `createNativeInboxStore` over `fakeNative` (an in-memory port of the Swift semantics with an injectable clock, `restart()` and a test-only synchronous raw-bytes hook, `rawBytesSync()`, that the native harness returns as `harness.rawBytes`). It runs in jest against the fake native module and proves the adapter plumbing, not Swift. The real Swift store is covered by XCTest (the contract mirrored in Swift) and the Simulator e2e.
- Adapter: synchronous members cached at init; no `rawBytes` on the adapter; native failures map to the
  contract.
- Host runtime: registration order and unregister on remount; readiness parking (a wake while `building` or `blocked` parks with no deadline and no `CONFIGURATION_ERROR`; only `none` fails; a wake before attach); the scheme handler nudges and never awaits; URL acceptance table (wrong scheme, wrong host, `v`
  missing, extra params); singleton processor under Fast Refresh; `recover()` once.
- Mirror writer: never writes pre-init; `identityKey` null when not ready; connected set equals `listConnectedSites()` filtered to `browser`, hashed from `applicationOrigin`, and matches `consent.lookup`; logout hook order (writer disabled, then `reset()`, synchronously, with no await; late store writes after reset reject; no write until `init()`); Delete Wallet reaches the hook once; a detach-induced `none` is not written while a real `none` is; ordering with `flushEvents` on the ordinary path; parity of `identityKey` with the
  dispatcher's `getPublicKey` result.
- Receipts: `neededApproval` with consent, wallet-not-ready and foreground prompts; summary table;
  batch coalescing.
- Merged sheet: the P1 tests listed in the seams brief extended (`PermissionSheet`, `consent`,
  `consentSheetSource`, `dispatcher`, `integration`) for both attestations; the in-app browser unchanged;
  preview through the shared manager's cached fetch; Connect mints every listed item (verified: spending
  included with its amount; unattested: stripped) and the later group check raises no sheet; fetch failure or
  empty manifest gives the plain sheet; Don't connect mints and records nothing and starts the 30 s backoff.
- i18n: all 12 locales for every new key; wording test.
- Extension `lib/` under jest with a fake `browser` API and the stand-in page client (BRC-185 wire: event names, once-per-`requestId` answer, no unsolicited announce, handle shape, `onClose` reasons, invoke/result/error/closed envelopes, routing mismatches, profile-switch refusal): reconcile (the six steps, revision and context
  changes, events gap, `absent` closes every held epoch, cursor semantics, other tabs unaffected), local-answer table including every
  identity-key condition independently, staging (ids extension-minted, idempotent retry, withdraw race,
  chunking), limits (4, 16, 5 MiB across tabs), pickup conversion, tab-close grace, origin attestation
  (casing, opaque origins, frame navigation), frame rule, describe and connect preimages against P1's
  vectors.
- Plugin: snapshot of generated entitlements, Info.plist, target settings and EAS appExtensions;
  host-group-first ordering; failure on missing team id or anchor; no change to existing entitlements
  and URL types.
- Host: the rewritten `isolation.test.js`.

**Swift (`swift test`, macOS host, no entitlements needed).** An XCTest port of the 12 contract cases
against `BsvBridgeQueue` with an in-memory `KeyProvider` and an injected `Clock`; raw-byte marker test
over every file in the container; cross-process tests that spawn helper processes racing `create` of one
id, `claim` of one record, `accept` against `withdraw`, and `ack` against purge; crash-injection between
each pair of steps in 6.4; sealing tests (wrong id, wrong kind, tampered byte, truncated file).

**Only on the Simulator** (these need the real Safari and extension machinery): the handoff and Safari's
prompt, `world: MAIN` injection with and without a strict CSP, the native-message round trip and its
sizes, the content script after "Always Allow", `visibilitychange`/`pageshow`/`focus` on returning
through the ◀ Safari chip, tab close detection, coalescing and a second `tabs.update` during the
prompt, a cold start into a scheme wake with the drain gate, the done screen and toast, an end-to-end payment driven from the demo page (6.16), two kit builds on one page.

**Only on a device** (the Simulator does not enforce these faithfully): keychain access-group sharing
between the app and extension under real signing; the data-protection class (including reading after
first unlock but not before); the upgrade-install over existing real keychain items (6.13 item 9);
real "Always Allow" flows on iOS 17, 18 and current; Private Browsing; Face ID with a wake from a
locked phone; cold-appex latency for `sign` against the 1-second budget; EAS signing of the extension
and the App Group capability; a TestFlight build.

## 11. Spikes that gate the build

Each is a short, throwaway check with a documented fallback. Results are recorded in the kit's `SPIKES.md`. **S1 and S6 are the first two plan tasks and gate the Swift and plugin work**: nothing under `swift/`, `ios/` or `plugin/` starts until both have a recorded result. The implementer may adopt a documented fallback as an author change; only if no shared sealing key between app and appex is possible at all does the project go back to the owner. The other spikes do not gate.

- **S1 Build plumbing (gating).** `@bacons/apple-targets` 5.0.0 `safari` type under prebuild and EAS: `root`
  option; `keychain-access-groups` passing through; the shared pod versus file-reference sharing with
  static frameworks. Fallback: a bespoke `withXcodeProject` target creator.
- **S2 Native messaging.** Round trip at 1 KB, 100 KB, 1 MB, 5 MiB; cold-appex latency for `sign`;
  whether the callback can fail to fire. Sets `STAGE_CHUNK_BYTES`. Fallback: smaller chunks.
- **S3 Injection.** `world: MAIN` at `document_start` on iOS 17, 18 and current, with a strict CSP and
  site access granted late. Fallback: script injection.
- **S4 Background lifetime.** Unload mid-request; whether ports or `tabs.onRemoved` wake an unloaded
  background; `storage.session` surviving unload.
- **S5 Handoff.** A second `tabs.update` while the prompt is up; from a subframe (fallback: ask the top
  frame's content script to set `location.href`); the coalescing window.
- **S6 Shared sealing key and keychain upgrade (gating).** A key the app writes with an explicit group is readable by the appex; an install over an existing real wallet reads every Vault and secure-store item. Fallback: use the App Group id as the keychain group (no `keychain-access-groups`
  entitlement), if iOS accepts it. If no shared key is possible at all, back to the owner.
- **S7 Return events.** Which of `visibilitychange`, `pageshow` and `focus` fire after the ◀ Safari
  chip and after a manual switch; timers while hidden; `sender.origin` casing and `tab.incognito`
  reliability.

## 12. Known deviations and limits (recorded, not hidden)

1. **Identity key is answered locally only for connected sites** (author call, consistent with P1 consent).
   Decision 5 says cached copy; a pure cache would give the key to a site the user never connected. The mirror
   carries the connected-site set and the extension checks it (6.10). An unconnected site's `getPublicKey`
   goes through consent like any interactive call (P1 6.4). The owner's intent, no wake for connected sites,
   is kept.
2. **Pending records can expire.** BRC-219 says no deadlines on accepted calls. A record the app does not
   accept within 15 minutes is answered `CONNECTION_CLOSED`, `not-sent`, which is safe to retry. After
   acceptance there is no deadline.
3. **Results live 15 minutes** (the P1 pending window and result purge). A user who approves and returns after
   more than 15 minutes may see `unknown` for a call that completed. Not changed; the visibility trigger
   shortens the gap and the page should check its own state.
4. **Stale mirror.** `isAuthenticated: true` can outlive the app process, and survives a provider remount (the detach `none` is not mirrored, 6.5). Accepted and documented.
5. **One connection sheet per transport at a time** (P1's rule, shipped as is). A second site's connect in the
   same wake gets `RESOURCE_LIMIT`, `not-sent`; its page retries and its next call re-triggers the handoff.
6. **Cross-site linkability** of the continuity key per context (see 8).
7. **No Browser connections screen yet**, so a user can only remove a connection by other means (decision 4).
8. **Payload limits unmeasured**; chunking is in the contract to be safe (spike S2).
9. **Cancel is invisible.** A user who cancels Safari's prompt sees nothing more until the page calls again.
10. **Private browsing** behaves only if the user enables the extension there; its key context is separate.
11. **Safari profiles** are not distinguished.
12. **Connect alone never opens the app** (intended, 6.9): the connect sheet appears on the first interactive
    call.
13. **Connect is refused for a mirror written while building** (no `accountContext` to stamp). A
    connect-while-building path is a follow-up.

## 13. Author calls (not owner decisions)

1. **Scheme = bundle id**, extension id `<B>.safari`, App Group `group.<B>`, bridge keychain group
   `<B>.bridge`, all derived (6.2). The handoff URL carries no data.
2. **Identity key through a mirrored connected-site set**, answered locally only for connected sites, with the
   six conditions in 6.10 (12 item 1). The alternative is a lazily filled cache, which makes the first call per
   epoch wake the app.
3. **Continuity key contexts `safari` / `safari-private`**, one key per context for all sites; `incognito`
   unknown counts as private.
4. **Connect with a mirror that is absent, `none` or has no `accountContext` is refused**
   (`CONFIGURATION_ERROR`, `not-sent`) rather than guessed. Discovery and describe still answer (BRC-185 §4.2).
5. **Bundle the extension at prebuild** with esbuild, committing no output, and wrap `@bacons/apple-targets`
   rather than writing Xcode project edits by hand (fallback in S1).
6. **Expo module, not Nitro**, for the native module; one pure Swift package shared by app and extension.
7. **Extension-minted record ids** with a `(epoch, invokeId)` map.
8. **`withdraw` operation and chunked staging** are part of the contract from day one.
9. **The extension enforces the dispatcher's in-flight limits across all tabs** so a batch never fails by
   batching.
10. **No drain gate.** P1 readiness parks `building` and `blocked` records; only `none` fails. The scheme
    handler only nudges and never awaits `processPending` in a native callback.
11. **Disconnect records only for epochs that staged something**, flushed after a 5-second grace, never with a
    handoff.
12. **Done screen**: no timer, tap or background to dismiss, one screen per batch with the summarising rules,
    the method-to-summary table, the failed-call toast "Not completed · ◀ Safari", the hint wording. Strings
    are keys under `bridge_` in the toolbox.
13. **Merged sheet by peek and mint**: no pre-approval registry or item matching; the peek goes through the same
    manager's cached manifest fetch; Connect is consent plus minting every listed item; it applies to every
    bridge connection sheet; Don't connect is decline with P1's 30-second backoff.
14. **Mirror ordering** via `flushEvents()` (ordinary path only), events retention 1024 entries or 24 hours with `readEventsAfter` returning `{ events, gap }`, id
    tombstones kept 40 minutes.
15. **Native time is passed in** (`nowMs`) so the contract suite's clock works.
16. **The processor is a singleton**; a second instance is a bug (`recover()` would release the first's
    accepted records).
17. **Reset is final until the next `init()`**: on logout (which includes Delete Wallet) the teardown hook
    synchronously disables the writer and calls `reset()`, which removes the sealing key, container and
    continuity keys. The extension sees `absent`, never `none`, and closes every held epoch (6.5, 6.10). Chosen
    because teardown is synchronous and the alternatives either race `deleteAllWalletKeys` (fire-and-forget
    chain) or change `logout()` (await a bridge promise). The owner may prefer the latter; see 15.
18. **Keychain groups: host group first**, bridge group second, bridge key always written with an explicit
    group; upgrade-install gate before release.
19. **No use of the "unverified" path**: the transport is `browser` only, so no reconnect token or
    `deliverReconnectToken`.
20. **Popup shows status and guidance only**; no approval, no settings.
21. **BRC-185 profile choices** where the BRC is open (6.8): answer each request once and never announce
    unsolicited; always answer, even with no wallet; no connect proof on the window handle; the `window`
    endpoint record; the §4.3 envelope shapes reused on the internal port.
22. **Profile switch**: P1 bumps `walletRevision`; the extension refuses a mirror whose revision or context
    differs from the epoch's (6.5).
23. **Stand-in client and demo page** are test tools only (6.16).
24. **S1 and S6 gate the build** and are the first plan tasks; documented fallbacks may be adopted by the
    implementer as author changes (11).
25. **Accepted limits** 3 and 5 in 12 (15-minute result window, one connection sheet per transport) ship as is.

26. **Detach-induced `none` is not mirrored**: the writer checks `isBridgeHostAttached()` at callback and write
    time (6.5).
27. **`onPromptRaised` is an optional `TransportRegistration` member** called from `notifyPromptRaised` before the
    active gate; `requestAttention('prompt')` is unchanged (6.15 item 5).
28. **`readEventsAfter` returns `{ events, gap }`; `rawBytes` moves from the store to the contract harness**
    (6.6, 6.15 item 7).

## 14. Left to the builder

File and function names; the exact JSON shapes of the native-message operations; `STAGE_CHUNK_BYTES` and
timer values after the spikes; the layout of `Resources/` and the popup design; how Expo module binary
values cross the bridge; wording beyond the meaning given (English first, then the 12 locales); the
choice between Linking and an app-delegate subscriber for URL delivery if `Linking` misses events under
the host's scene-lifecycle plugin; the extension icon assets; the peek timeout and the name of the manager method that mints a group.

## 15. Open items for later projects and "later"

**Project 3 (ts-stack page side).**
- Conform to what P2 defines where BRC-185 is open (6.8): the `window` endpoint record; no connect proof on the
  window handle (identity comes from `describe`); promise rejection carries the §6 `ConnectionError` or the
  wallet error unchanged; the extension answers only requests, and always answers, even with no wallet
  (`connect` then fails `CONFIGURATION_ERROR`); probes and a connected site's identity key answer without
  waking the app, everything else may open the app.
- Page-side cancel (the queue's `withdraw` is the mechanism); a page-side re-trigger affordance.
- Whether `WalletClient('auto')` offers the wallet and how a chooser orders several announcements.
- Whether per-origin continuity keys (against cross-site correlation) fit BRC-185.

**Project 4 (Android).** Shares the done-screen idea, not the component; the merged connect sheet applies
to unattested origins differently (P1 6.5).

**Later (decision 4).** The Browser connections screen with revoke and "Remove connection and
permissions" (whether removal also drops the in-app browser's grants for the same hostname, per P1 12);
the permission-policy settings screen with "apply now"; the local-notification attention handler;
a P1 queue for the second connect sheet; processor admission queueing.

**Follow-ups.** A freshness rule for the mirror (`writtenAt`); a connect-while-building path that wakes the
app instead of refusing; extension `Resources` size budget; Mac Catalyst or iPad multi-window behaviour
of the scheme handoff.

**For the owner to confirm.** Logout and Delete Wallet reset ordering (13 item 17): shipped as a synchronous
hook that resets immediately, so the extension sees `absent`. If the owner prefers the extension to see `none`
first, the change is in P1: `logout()` awaits a bridge teardown promise before `deleteAllWalletKeys`.
