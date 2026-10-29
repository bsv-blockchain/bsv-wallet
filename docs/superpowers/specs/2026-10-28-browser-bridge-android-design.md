# Browser wallet bridge — Android Chrome loopback kit (project 4 of 4)

Date: 2026-10-28. Status: design, revision 2 (written while the owner was unavailable, then revised after an adversarial review:
section 15 says what each review issue changed; section 13 lists every call made without the owner).
Builds on project 1 (core): `docs/superpowers/specs/2026-10-27-browser-bridge-core-design.md` ("P1" below; "P1 6.8"
points into it) and mirrors project 2: `docs/superpowers/specs/2026-10-28-browser-bridge-ios-kit-design.md` ("P2").
Governing standards: BRC-185 (`/Users/personal/git/docs/BRCs/wallet/0185.md`, vectors alongside; "BRC-185 §n"),
BRC-325 (loopback permission primer), BRC-219 (prompt liveness), BRC-100, BRC-5 (HTTP substrate).
Host that adopts it first: Bitcoin SV Wallet, `~/git/ts/bitcoin-sv-wallet`, Android package
`org.bsvblockchain.wallet`, schemes `bsv-wallet` and `bsv-browser`, config in `app.config.js` + `legacy-app.json`
(Continuous Native Generation: there is no checked-in `android/` directory).

## 1. Intent

A web page in Chrome on the user's Android phone should be able to use the BSV wallet app as its BRC-100 wallet, with the
user approving in the wallet. Project 4 is the Android transport for the P1 core. It is a reusable kit: any BSV wallet app
built with Expo can add it.

Android Chrome has no extension model, so the transport is the one BRC-185 §4.1 defines for this case: an HTTP server the
wallet app runs on the phone's loopback interface, which the page reaches with `fetch`. Four facts shape everything:

1. **The origin is forgeable, and so is the endpoint.** Any app on the phone can open a socket to the port and write
   `Origin: https://example.com`, and any app can bind a port before the wallet does. The transport is therefore
   `attestation: 'unattested'` for ever (P1 6.5). Safety rests on five things: a per-launch secret `k` that authenticates
   **in both directions** (the page proves a visible launch to the wallet, and the wallet proves to the page that it is the
   app the launch intent reached, 7.5); a remembered-site reconnect token; a clean slate on every new approval; a stricter
   permission set for unverified origins; and a per-binding secret derived from `k`, so that a leaked epoch alone drives
   nothing. This project supplies the launch proof, the wallet's acknowledgement, and the token plumbing.
2. **An app cannot be woken by a socket.** Nothing listens while the app is dead. The page wakes the app with an intent
   link on a user click (a visible start, so Android lets us start a foreground service), and the wallet opens its port
   afterwards.
3. **Background activity starts are blocked.** The wallet cannot raise anything over Chrome on its own while Chrome is in
   front. What the user sees is therefore decided at the launch click (below), and later prompts fall back to a
   notification (7.4).
4. **The page and Chrome do the discovery work** (project 3 and BRC-325): primer, Chrome's own loopback permission, the
   port scan, the proofs. P4 only has to answer correctly and noninteractively.

The kit has six parts:

1. **A loopback HTTP server** (Kotlin): exclusive bind on `127.0.0.1` and `::1`, a strict HTTP/1.1 parser, Host checking,
   size caps, and a hold-open response model. It knows nothing about BRC-185 beyond "serve these paths".
2. **A protocol controller** (TypeScript, in the JS runtime): routes, CORS, descriptors and proofs, explicit-mode connect,
   the launch proof and acknowledgement, the reconnect token, status mapping, session lifetime. Pure parts live in the
   toolbox (`core/bridge/loopback/`, section 6.14) so jest tests them and a future desktop host can reuse them.
3. **A launch trampoline Activity** (Kotlin, exported, no React) that validates the launch link, hands it to the module
   through process memory (never through the intent, never through React Native `Linking`) and then either brings the
   wallet app forward (**foreground mode**, M1) or raises a bottom sheet over Chrome (**overlay mode**, M2, a translucent
   non-exported Activity that shows the existing permission sheets on a second React root of the same React host).
4. **A foreground service** that keeps the process and server alive while Chrome is in front, and carries the session
   notification. Deadline-style timers live in Kotlin (7.1), because React Native pauses JS timers when no Activity is
   resumed.
5. **A `ContinuityStore`** (TypeScript, `expo-secure-store` plus HKDF-derived per-origin Ed25519 identities), readable
   while the wallet is locked.
6. **An Expo config plugin** plus a library manifest that declare the Activities, the service, the intent filter, the theme
   and the permissions.

**What the user sees, honestly: two modes.**

- **Foreground mode (M1; always available; the common first visit).** The launch click brings the wallet app itself to
  the front. This is what happens when the process is dead (every visit after a reboot or after Android reclaimed the
  app), when the wallet is locked or still building, and whenever the wallet's main screen no longer exists. The user
  unlocks in the wallet, sees the existing "Connect example.com?" sheet in the wallet, approves, and goes back to Chrome
  (the kit sends the wallet to the back after the last prompt, as a best effort; the system Back gesture and the app
  switcher are the documented way back). A cold start cannot show an overlay: there is no wallet to draw it from until the
  main screen has loaded and been unlocked.
- **Overlay mode (M2; warm only).** When the process is alive, the main screen still exists (stopped, not destroyed), the
  host is attached and the wallet is unlocked (`ready`), the launch click raises a translucent sheet over Chrome as
  "Connect example.com?", the user taps Connect, the sheet closes and Chrome is in front again. On later warm visits it
  flashes up for about a second. This is the owner's "bottom sheet over Chrome" headline, and it is the **second
  milestone**, built only after the spikes that can sink it (S3, S4, S6) pass. The first useful release is foreground mode.

On a fresh install the first connect is a foreground-mode connect (the wallet must be unlocked at least once in the
process); the owner gets the overlay only once the wallet is warm. The end-to-end tests verify the cold path first.

## 2. Decisions made by the product owner

Quoted from P1 section 2 and the owner's brainstorm decisions. They are not revisited here.

1. **Android transport.** "Android. Uses the BRC-185 §4.1 loopback profile." Task statement: "a BRC-185 §4.1 loopback
   server with a bottom sheet over Chrome."
2. **Approval UX.** Approval uses the wallet's existing permission sheets, the same ones that sign off wallet-relay
   requests today. (P2 decision 1.)
3. **Site consent.** "A site must be connected once in the wallet ('Connect example.com?') before any of its requests
   run. The approval is remembered per site until the user revokes it. Requests queued by a site that is not connected
   are not processed."
4. **Auto-approve.** "Connected sites follow the user's existing auto-approve threshold for small spends." (For an
   unverified origin this is overridden by decision 6: spending always asks.)
5. **Manifests for unverified origins.** "Once the user approves a domain, the wallet checks that domain's `manifest.json`
   even when it cannot prove which website is asking (Android). The rules that make this safe are in 6.5." (All in P1;
   nothing to build here.)
6. **Unverified approvals are remembered like Safari's, behind a reconnect token.** An Android approval is remembered per
   site. A silent reconnect needs a secret the wallet gave the approved page, kept in that site's own browser storage.
   Without it the user sees the connect sheet again, and approving starts from a clean slate: the site's earlier
   unverified permissions no longer apply (P1 6.4, 6.5).
7. **Permission prompts come from a setup object.** Unverified origins get the stricter set: spending always asks,
   basket changes ask, no auto-approve, BTMS and Mandala token modules refused (P1 6.5).
8. **Build order.** Core, iOS kit, ts-stack page side, Android after. Project 3 does not exist in ts-stack yet; P4 ships
   a stand-in page client (6.16) so the owner can test now, exactly as P2 did.
9. **App Group analogue.** No shared storage between apps. The host's `isolation.test.js` rule (never add `sharedUserId`,
   app groups or keychain access groups) stays true; this kit adds none.
10. **No users, no migration** (memory: pre-launch). New storage formats carry no compatibility code.

**Unattested-origin rules this project must honour exactly** (P1 6.4, 6.5, 6.7, 9):

- Transport registers `attestation: 'unattested'`, `bindingMode: 'explicit'`, with `deliverReconnectToken` and
  `requestAttention` (registration refuses anything else).
- A connect without `launchProofVerified === true` is refused `CONFIGURATION_ERROR`, `not-sent`: no binding, no limit
  slot, no sheet. The flag is fixed at connect and is never read from the page's bytes.
- The reconnect token is minted by the core on Approve, handed over once through `deliverReconnectToken`, never logged,
  never put in a URL.
- The page verifies the wallet's identity, including its acknowledgement of the launch secret, before it sends the token,
  sends any RPC or pins the key (the project 3 and 4 contract, 7.5, 7.7).
- The transport reports `lost` when it can no longer serve a binding. The core has no idle timer, and nothing here may
  count a binding as idle while it has a parked or in-flight request (BRC-219).

## 3. Goals

G1. **A page can use the wallet on Android Chrome.** All 28 BRC-100 methods reach the P1 dispatcher through
`dispatch()`, with P1's origin rule, consent, policy and error codec. The kit adds no method logic and no allowlist.

G2. **BRC-185 §4.1 MUSTs are all met by the server**: loopback-only bind, ascending exclusive-bind allocation, Host and
Origin validation, exact-origin CORS without credentials, `Cache-Control: no-store`, `Vary: Origin`, the 412 contract,
no redirects, no legacy routes for new-profile traffic (section 7).

G3. **Discovery is noninteractive and fast.** Describe answers without waking the UI, with the wallet locked, using only the
`ContinuityStore` (a cached handle after the first read). On a warm process that is well under 1 second; while the wallet is
still building the JS thread is busy, so the page's policy after a launch click is generous (7.7) and S7 measures it.

G4. **The wallet appears on the launch click**: as a sheet over Chrome when warm (milestone 2), otherwise the wallet app
itself in front (milestone 1, the always-works path). Chrome is in front again when the user is done, best effort (7.4).

G5. **No deadline on any request admitted to a binding** (BRC-219): not in the server, the Activity, the controller or the
service. A request waits until the user answers or the binding closes. The only bounded wait is a connect that has no
binding yet (6.7 step 4), which nobody has approved.

G6. **No silent wrong answers.** Every failure reaches the page as a typed P1 error with the right delivery claim.
`unknown` is used whenever the wallet might have acted; the page never retries it.

G7. **Minimal exposure.** No port is open unless a launch happened in the last 2 minutes (at most 10 minutes from the first
of a chain, with launches rate limited) or a binding is live (7.1). Nothing is listening on a phone where the user never used a site.

G8. **A wallet app adopts the kit with one plugin entry and a short list of host edits** (6.13), and Android's other
surfaces (alternate icons, deep links, R8) keep working.

G9. **Everything testable without a phone is tested without a phone**: parser, ports, routes, CORS, proofs, status
table, session state machine. A scripted emulator run covers the rest (section 10).

## 4. Non-goals (this project)

- No page-side SDK code and no `@bsv/sdk` change (project 3). P4 ships a stand-in loopback page client and a demo page
  (6.16). They are test tools, not the SDK or a chooser.
- No iOS, no Chrome on iOS, no Firefox, Edge, Brave, Samsung Internet, Custom Tabs, or in-app WebViews. Chromium
  browsers that send `Origin` and honour `intent:` links may work; none is tested or claimed.
- No legacy routes (`POST /<method>`), no binary profile (port 3301), no HTTPS profile (port 2121). 7.3.
- No encrypted association layer (MWA-style). Decision and reasons in 8.4.
- No verified Android origins. The MWA-style iframe attestation is research, deferred (8.5).
- No "Browser connections" screen, revoke UI or policy settings screen (P2 decision 4 applies here too). P1's
  `revokeSite`, `listConnectedSites` and policy API are used by those screens later.
- No toggles on the connect sheet (P2 decision 6): Connect and Don't connect only.
- No background scanning, no always-on listener, no boot receiver, no Play Services dependency.
- No new wallet logic. The only core changes are the small, additive ones in 6.14.

## 5. Anti-goals: if any of these happen, the project failed

- A value from the page body, query or non-browser header becomes the origin. The origin is the `Origin` header, nothing
  else, canonicalised with P1's rule; `Originator` and `BRC-185-Context` request headers are refused.
- A port is opened on any interface other than loopback, or a request from a non-loopback `Host` reaches the controller
  (DNS rebinding).
- A second wallet or service on the phone receives a request meant for this wallet because one address family was
  taken (7.1: both families or neither).
- A connect is accepted without a verified launch proof, or a launch proof is accepted twice, after expiry, for another
  origin, another epoch, or another wallet identity.
- The reconnect token is written to a log, a URL, a notification, the intent, the crash report or any response other than
  the one parked behind the approval; or is sent by the page to an endpoint whose identity it has not verified.
- A site's request runs before the site is connected, other than the two probes (P1 anti-goal).
- A timer, OS timeout or "cleanup" cancels, errors or answers a request that is waiting on the user.
- A request is answered `not-sent` after the wallet might have acted on it, or retried after an uncertain delivery.
- A wildcard or reflected-`null` `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials`, or a cacheable
  response on any route.
- The continuity private key is written outside the Keystore-wrapped store, logged, or returned to the page.
- The kit loads the wallet database, spends, or signs without going through the P1 dispatcher.
- The kit shows two copies of the same prompt (the in-app sheet and the overlay), or leaves a prompt with no way to
  reach it.
- The page accepts, pins or sends a token to an endpoint that did not prove it received the launch secret (first visit included).
- The launch URI or its secret reaches `Linking`, the router, a stored Intent, a log or a notification.
- A notification names a site taken from the `Origin` header.
- One origin's `instanceId` or `continuityKey` is shown to another origin.
- A binding is driven by the epoch alone.

## 6. Design

### 6.0 Milestones

The scope is large and several platform mechanisms are unverified, so the work is split. Each milestone is shippable.

**M1: transport, security model, foreground mode.** Everything that carries data and security: the Kotlin server and
allocator, the router and CORS in the toolbox, the launch trampoline and `LaunchStore`, the launch proof and
acknowledgement, the reconnect token, the `ContinuityStore`, the foreground service and its notification, Kotlin timers,
the heads-up notification for later prompts, the config plugin, the stand-in page client and demo, and the emulator
end-to-end run. A launch brings `MainActivity` forward (`getLaunchIntentForPackage`), where the existing `PermissionSheet`
shows the request. No second React root and no context relay exist in M1. Order inside M1: S0, the core seams of 6.14
(`hostAttached`, `assertAdvertisesResponder`, `core/bridge/loopback/`), then the Kotlin pure-JVM parts, then the rest.

**M2: overlay.** `BridgeSheetActivity`, the second React root, `ContextRelay`, the sheet owner gate, lifecycle tracking,
tapjacking protections, `returnToBrowser`. **Gated on S3, S4 and S6.** S4 is a hard gate and the first M2 task: a minimal
"hello" sheet on a second root of the shared React host, run on the Pixel_9 and one real phone, before any other M2 work.
If S4 fails, M2 is dropped and foreground mode is the product; nothing in M1 depends on M2.

### 6.1 Package layout and the choice of package

**New package `packages/expo-android-wallet-bridge`**, name `@bsv/expo-android-wallet-bridge`, `private: true`,
version `0.0.0` like P2, a sibling of `expo-safari-wallet-bridge`.

Why a separate package and not an `android` platform inside the Safari kit:

- The Safari kit's `package.json` carries `@bacons/apple-targets` and `esbuild` for the extension build, and its files list
  is Swift and WebExtension sources. An Android-only wallet would install all of it.
- The two share almost no code. What they share (origin, bindings, dispatch, proofs, limits) is already the toolbox.
  What each adds is OS-specific.
- Two release trains and two plugins evolve independently (the iOS kit is device-verified today; this one is not).
- `expo-module.config.json` per package stays trivial (`platforms: ["android"]`), and autolinking needs no cross-platform
  conditions.

What is shared goes to the toolbox, not to a third "common" package: the pure HTTP semantics and the `PageClient` test
interface (6.14).

```
packages/expo-android-wallet-bridge/
  package.json  README.md  CHANGELOG.md  CONFORMANCE.md  SPIKES.md
  expo-module.config.json        {"platforms":["android"],"android":{"modules":["org.bsv.walletbridge.BsvAndroidBridgeModule"]}}
  app.plugin.js  plugin/         config plugin (6.3) with jest tests
  android/
    build.gradle  consumer-rules.pro
    src/main/AndroidManifest.xml          static: permissions, service, trampoline, (M2) sheet Activity (6.3)
    src/main/res/values/                  (M2) Theme.BsvBridgeSheet
    src/main/kotlin/org/bsv/walletbridge/
      BsvAndroidBridgeModule.kt           Expo module: server, launches, timers, session, notifications, (M2) sheet
      LoopbackServer.kt                   listeners, connection table, hold-open, client-gone detection
      PortAllocator.kt                    dual-family exclusive bind, ascending, error classifier (pure JVM, unit-tested)
      HttpParser.kt  HttpWriter.kt        strict HTTP/1.1 subset (pure JVM, unit-tested)
      HostCheck.kt                        allowed Host values for the bound port (pure JVM)
      LaunchTrampolineActivity.kt         M1: exported, no React; validates, stores, forwards without data
      LaunchStore.kt                      process-memory launch queue with sequence numbers and a rate limit (pure JVM part tested)
      LaunchIntent.kt                     parse and size-check the launch URI (pure JVM, tested)
      Timers.kt                           named Handler timers, events to JS
      BridgeService.kt                    foreground service, notification, actions
      Attention.kt                        notification channels and specs (pure-JVM spec builder, tested)
      BridgeSheetActivity.kt              M2: non-exported translucent ReactActivity, component "BsvBridgeSheet"
      LifecycleTracker.kt                 M2: Application.ActivityLifecycleCallbacks, main-resumed state
    src/test/kotlin/...                   JUnit 4.13.2, same style as react-native-localpay-transport
  src/
    index.ts                              exports (6.12)
    setup.ts                              setupAndroidBridge(): the one call the host entry file makes
    native.ts                             BsvAndroidBridgeNative type + lazy requireNativeModule
    controller/                           transport glue, handler, session, launch registry, token outbox, unsettled gate
    continuity/secureStoreContinuity.ts   ContinuityStore implementation (6.9)
    ui/BridgeSheetRoot.tsx  ui/SheetGate.tsx   M2: the second root's component and the owner gate (7.4)
    testing/loopbackPageClient.ts         stand-in page client (6.16)
  demo/  build.mjs  demo.ts  index.html  serve.mjs
  scripts/e2e/                            emulator driver (section 10)
  __tests__/
```

Toolbox additions (6.14): `core/bridge/loopback/*`, `core/bridge/testing/pageClient.ts` (the shared `PageClient` interface),
and, for M2, `ui/bridgeSheet/ContextRelay.tsx`.

Kotlin package `org.bsv.walletbridge` (generic, not tied to a host id). Gradle follows
`react-native-localpay-transport`: `compileSdk` from the root project, `minSdk` 24, `jvmTarget` 17,
`consumerProguardFiles 'consumer-rules.pro'`, JUnit 4.13.2 under `src/test`. It is an Expo module (Kotlin, ExpoModulesCore),
not a Nitro module: nothing here needs JNI. No third-party HTTP server dependency (6.2).

### 6.2 The loopback server (Kotlin)

**Decision: a hand-written server on `java.net.ServerSocket`, no NanoHTTPD, Ktor or okhttp MockWebServer.** About
500 lines. Reasons: zero added dependencies and zero R8 reflection rules (the R8 enablement note in memory shows how much
that matters); every BRC-185 MUST is a few lines when we own the parser; Android has no `com.sun.net.httpserver`;
NanoHTTPD is unmaintained and listens on wildcard by default; Ktor adds MBs and `ServiceLoader` use. The parser is a pure
JVM class, so it is unit-tested like `BleGattProfile` is.

**Responsibilities of Kotlin (and only these):** bind, accept, parse, apply transport-level caps and the Host check,
hand a request to JS, hold the connection open until JS answers or the peer goes, write the response, close. Everything
BRC-185 specific is TypeScript (6.5 to 6.8) so there is one implementation and jest covers it.

**HTTP subset.**

- HTTP/1.1 only (1.0 requests are answered as 1.1). Methods `GET`, `POST`, `DELETE`, `OPTIONS`; others get `405`. The request
  target is origin-form only (absolute-form, `*` and authority-form are `400`), is never percent-decoded or dot-segment
  normalised, and anything that is not an exact allowed path (6.5) is `404`.
- **One request per connection; every response carries `Connection: close`.** No keep-alive, no pipelining, no
  upgrade. Chrome opens a new loopback connection per request at negligible cost. This removes the request smuggling
  and desync class entirely.
- Request line at most 2,048 bytes; headers at most 64 lines and 16,384 bytes in total; CRLF line endings only (bare LF
  rejected); no obs-fold; header names ASCII tokens; duplicate headers rejected except where the value is irrelevant
  (`Accept`, `Accept-Encoding`, `User-Agent`, which are dropped before JS sees them).
- `Transfer-Encoding` present: `411`/close (we require `Content-Length`). `Expect: 100-continue`: `417`. `Content-Length`
  duplicated or non-numeric: `400`. `Content-Length` over 5 MiB (5,242,880, P1 `MAX_BRIDGE_REQUEST_BYTES`): `413`
  immediately, body not read; the body of a request that would pass is read to exactly `Content-Length`.
- **Receive timeouts apply only to receiving a request** (slowloris defence): 10 s to finish the request head, 30 s for
  the body, per connection. They stop applying the moment the request is handed to JS. There is no timeout on a held
  response (G5).
- Response writes: a 30 s write-stall timeout (the peer stopped reading), which closes the connection; this is not a
  deadline on the wallet's work, only on a dead socket. Response bodies over 5 MiB are refused by the controller.
- Connection table: at most 32 live connections; a 33rd is answered `503` with `Retry-After: 1` and closed. Parked
  connections count (the dispatcher admits 16 in flight, so 32 leaves room for probes).
- **Host check (DNS rebinding), before JS sees anything.** Allowed `Host` values for the bound port `p`: `127.0.0.1:p`,
  `localhost:p`, `[::1]:p` (the `localhost` spelling only when both families are bound to this instance, 6.2.1). Anything
  else, or a missing or duplicated `Host`: `403`, empty body, no CORS headers.
- **Client gone detection.** After the request is read, a watcher blocks on the socket's input. EOF or reset means the peer
  left (tab closed, `AbortController`, network stack): the connection is released and JS gets `onClientGone({id})`.
  Any extra bytes after the request are a protocol violation: close.
- Strings: header values and the body are passed to JS as UTF-8 strings; a body that is not valid UTF-8 is `400`. BRC-100 JSON
  is text; byte values are `number[]` (P1 6.6). Headers are passed as an ordered array of `[lowercasedName, value]`.

**Native module surface** (`BsvAndroidBridgeNative`, all `AsyncFunction` except where noted):

```ts
startServer(o: {basePort: number, maxOffset: number}): Promise<{port: number, ipv4: boolean, ipv6: boolean}>
stopServer(): Promise<void>
respond(id: string, status: number, headers: [string,string][], body: string): Promise<boolean> // false if peer gone
abortConnection(id: string): void
// events: onRequest {id, method, target, headers, body}, onClientGone {id}, onServerStopped {reason}
takeLaunches(afterSeq: number): {seq: number, uri: string}[]   // sync; pulls from LaunchStore, rate limited in Kotlin
// event: onLaunch {seq}   (a nudge only; JS pulls)
elapsedRealtime(): number                                       // sync, monotonic ms
setTimer(name: string, ms: number): void; clearTimer(name: string): void   // Kotlin Handler timers
// event: onTimer {name}   (fires while no ReactActivity is resumed)
ensureService(): boolean                                        // false if Android refused the foreground service
setHostState(s: {attached: boolean, ready: boolean}): void      // used by the trampoline to choose a mode
setSession(s: {sites: number, waiting: number}): void           // notification counts; no site names, no secrets
stopSession(): void
postAttention(o: {kind: 'consent'|'prompt'|'wallet-not-ready'}): void   // generic text only
cancelAttention(): void
notificationPermission(): 'granted'|'denied'|'undetermined'
requestNotificationPermission(): Promise<'granted'|'denied'>
returnToBrowser(): void
// M2 only:
showSheet(reason: 'launch'|'consent'|'prompt'): void
hideSheet(): void
isMainActivityActive(): boolean
```

Errors carry `CodedException` subclasses with stable codes (`ERR_PORTS_EXHAUSTED`, `ERR_BIND_FAILED`, `ERR_NO_ACTIVITY`);
class names are kept from R8 renaming by the host's existing `CodedException` keepnames rule.

#### 6.2.1 Ports, families and collisions (BRC-185 §4.1)

- **Only the JSON HTTP profile.** Base port **3321**, ascending to **3384** (offset 63): inside the default discovery
  window a BRC-185 controller scans (0 to 63 from 3321), so a stock client finds us with no configuration. A wallet that
  needs more has no way to be found by default, so exhaustion is an error, not a wider range.
- **The bind is the allocation.** For each candidate port `p` in order: create a `ServerSocket` with
  **`setReuseAddress(true)` set before bind**, bind `127.0.0.1:p`; then bind `[::1]:p`. On Linux and Android
  `SO_REUSEADDR` does not let two sockets listen on one port (that is the Windows meaning); it only allows binding over
  sockets in TIME_WAIT. It is required here because every response carries `Connection: close` and the server closes
  first, so TIME_WAIT sockets accumulate on the port, and a stop and restart within about a minute would otherwise fail
  `EADDRINUSE` and wrongly move a lone wallet off 3321. A live listener from another app still makes the bind fail.
  Outcomes:
  - both bound: success, `ipv4 = ipv6 = true`;
  - IPv4 bound, IPv6 failed with address-in-use: **close IPv4 and move to `p + 1`** (a different wallet owns `::1:p`; if
    we kept IPv4 only, a page using `localhost` could reach that other wallet, which BRC-185 forbids);
  - IPv4 bound, IPv6 failed because the family is unavailable (no `::1` interface): success, `ipv4 = true`, `ipv6 = false`;
  - IPv4 failed with address-in-use: next port;
  - **any other bind error is surfaced** (`ERR_BIND_FAILED` with the errno text) and never treated as "port taken".
- **Error classification does not rely on one message format.** `classifyBindError(e)` is a pure function that walks the
  cause chain. *In use*: a cause whose message contains `EADDRINUSE` or `Address already in use`, or an
  `android.system.ErrnoException` (matched by class name, `errno` read reflectively so the JVM tests need no Android
  classes) with errno 98. *Unavailable*: `EADDRNOTAVAIL`, `Cannot assign requested address`, `EAFNOSUPPORT`,
  `Address family not supported`, `Protocol family unavailable`, or errno 99 or 97. Anything else is *other*. The JUnit
  table covers both the Android-style messages (`bind failed: EADDRINUSE (Address already in use)`) and the desktop JVM
  strings; an on-device e2e case (a test socket on `::1:3321` only, section 10) proves the real Android classification.
- Never probe-then-bind. Never bind a wildcard or a non-loopback address; unit tests assert `getInetAddress().isLoopbackAddress`
  for every bound socket. A test serves one request, closes, and rebinds immediately: it gets the same port. A second bind
  while the first listener is live fails.
- Exhausting 3321 to 3384: `ERR_PORTS_EXHAUSTED`; the controller answers nothing (there is no listener) and the wallet
  shows "Another program is using the ports BSV Wallet needs" (copy in 6.12).
- **The default is kept when free** (BRC-185 §12), and the allocator prefers the lowest free port, so a lone wallet is
  at 3321.
- **What is advertised** (6.5): the descriptor lists every bound spelling: `http://127.0.0.1:p` always, `http://[::1]:p`
  when `ipv6`, `http://localhost:p` only when both families are bound. Endpoint `type: 'http-json'`; ids
  `json-ipv4`, `json-ipv6`, `json-localhost`. The same list is returned on every response, so the descriptor (and its
  signature input) is stable, and each spelling the page may have used to reach us is present
  (`assertAdvertisesResponder`, 6.14).

### 6.3 Config plugin, library manifest and the launch Activities

**The static parts live in the library.** `android/src/main/AndroidManifest.xml` (merged into the app by the manifest
merger, `${applicationId}` is built in) declares everything that does not depend on the host, so the plugin cannot get it
wrong and the host manifest stays small:

- permissions `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`, `INTERNET` (the last two are
  already requested by the host; duplicates merge). `SYSTEM_ALERT_WINDOW` stays blocked by the host: nothing here uses an
  overlay window;
- **`org.bsv.walletbridge.LaunchTrampolineActivity`**: `exported="true"`, theme `@android:style/Theme.NoDisplay`,
  `excludeFromRecents`, `noHistory`, `taskAffinity=""`. It is the **only exported component**. It has no React
  Native, no ReactActivity, no JS. Its `onCreate` validates the data (scheme, host `launch`, at most 512 bytes), stores the
  URI in `LaunchStore` (process memory), starts the next component **without the URI** (an explicit intent with no data;
  only a sequence number is an extra), and calls `finish()`. It starts `MainActivity` through
  `getLaunchIntentForPackage` in M1, and in M2 starts the non-exported sheet Activity when overlay mode applies (7.4). It
  never starts a service, never touches the intent after `finish()`, and drops any launch rejected by `LaunchStore`'s rate
  limit (6.2) without a window;
- **(M2) `org.bsv.walletbridge.BridgeSheetActivity`**: `exported="false"`, `launchMode="singleTask"`,
  `taskAffinity="${applicationId}.bridge"`, `excludeFromRecents`, `windowSoftInputMode="adjustResize"`, the usual
  `configChanges` list, theme `@style/Theme.BsvBridgeSheet`. Because it is not exported, no website and no other app can
  start it; notification `PendingIntent`s target it with an explicit component and `FLAG_IMMUTABLE`;
- `<service android:name="org.bsv.walletbridge.BridgeService" android:exported="false"
  android:foregroundServiceType="specialUse">` with `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
  android:value="Loopback server that lets a web page in the phone's browser ask this wallet for approval while the browser is in front"/>`;
- (M2) style `Theme.BsvBridgeSheet` in `res/values`, parent **`Theme.AppCompat.DayNight.NoActionBar`** (named explicitly;
  `Theme.AppCompat.Translucent` is not a stock theme): `windowIsTranslucent=true`, `windowBackground` transparent,
  `windowNoTitle`, slide-up animation, `android:enforceNavigationBarContrast=false`. The status and navigation bar colours
  are not set (edge-to-edge is enforced from targetSdk 35 and they would have no effect); the sheet draws behind the bars
  with window insets.

**The plugin (`withAndroidWalletBridge`) does only what depends on the host**, with `@expo/config-plugins` mods like
`plugins/withIconAliasLinks.js` in the host:

```ts
{ scheme?: string }   // launch scheme; default `<android.package>.bridge`, i.e. "org.bsvblockchain.wallet.bridge"
```

One rule for the default (no "first host scheme": the host has two). The host sets `scheme: 'bsv-wallet-bridge'`
explicitly. The plugin validates the scheme (RFC 3986 scheme syntax, lowercase, not equal to any scheme the host already
declares, because two Activities matching one scheme could raise a chooser), then adds to the app manifest a
`tools:node="merge"` entry that gives the trampoline its one intent filter: `VIEW`, `DEFAULT`, `BROWSABLE`,
`<data android:scheme="<scheme>" android:host="launch"/>`. It also performs the host-side checks (the host must not
declare `SYSTEM_ALERT_WINDOW` usage, and `android:allowBackup` must not be `true`, because the continuity seed would be
backed up; both warn). Plugin tests pin: the manifest merge result, **the trampoline is never touched by
`withIconAliasLinks`** (which copies `MainActivity`'s non-launcher intent filters to icon aliases), option validation, and
that no `SYSTEM_ALERT_WINDOW`, network security config, App Link, boot receiver or `queries` entry is added.

**The launch never reaches React Native or the router.** Because the trampoline holds no React and starts the next
component with no data, `ReactActivityDelegate.onNewIntent` has no URL to forward to `Linking`, so expo-router, its
`redirectSystemPath`, not-found handling, analytics hooks and logs never see the URI or its secret. As defence in depth the
host's `app/+native-intent.ts` returns `'/'` for any URL beginning with the bridge scheme (6.13), and spike S2/S4 check
that the router never receives the URI and `k` never appears in JS logs. The sheet Activity (M2) also overrides
`onNewIntent` to call `setIntent(Intent())` before `super`.

`intent:` links from Chrome cannot carry `component=` (Chrome strips it), so `package=` plus the private scheme is the
addressing: `intent://launch?...#Intent;scheme=<scheme>;package=org.bsvblockchain.wallet;end`. A `S.browser_fallback_url`
is **not** the page itself (that would reload the page on failure and can loop with a click handler): the page passes a
dedicated static URL (the Play Store listing, `https://play.google.com/store/apps/details?id=<package>`, or the
integrator's own "wallet not installed" page), or none.

### 6.4 Identifiers and what the page needs to know

The page needs only: the launch scheme (`bsv-wallet-bridge`), the package id (`org.bsvblockchain.wallet`), and the
port window (3321 to 3384). The descriptor (6.5) carries name, label, icon, vendor; the launch scheme and package are
not in BRC-185 and are hard-wired in the stand-in page client. **Project 3 must learn them from somewhere**; the open
point is recorded in section 14 (a `/.well-known/` page cannot help: the wallet is not running when the page needs the
scheme). The stand-in client takes them as parameters.

### 6.5 The protocol controller: routes

Lives in TypeScript. The pure router is `core/bridge/loopback/router.ts` in the toolbox; the kit wires it to the native
events and to P1 (`dispatch`, `getBindingRegistry`, `getBridgeSnapshot`).

For each native `onRequest` the controller runs these steps, in order, and stops at the first refusal. "Refuse" means
the status in 6.6 with `Cache-Control: no-store` and, only where noted, CORS headers.

1. **Path allowlist.** Only these paths exist; anything else is `404` with no CORS headers and an empty body:
   - `GET /.well-known/brc-wallet?challenge=<b64url>`
   - `POST /.well-known/brc-wallet/connect`
   - `DELETE /.well-known/brc-wallet/connect/<epoch>`
   - `POST /brc185/v1/rpc/<methodName>`
   - `OPTIONS` on any of the above.
   Known path, wrong verb: `405` with `Allow`. No redirect is ever emitted. **No legacy epoch-less route is served** (7.3).
   Targets are matched literally (no decoding, no normalisation) and the epoch segment must be a canonical lowercase UUIDv4.
2. **Origin.** `Origin` must be present exactly once, a WHATWG-serialised origin of at most 2,048 bytes, and pass
   `canonicalizeBridgeOrigin({origin, attestation: 'unattested', allowLocalhostHttp})` (https only; `http://localhost:<port>`
   only in a `__DEV__` build that also set `configureToolbox({browserBridge:{allowLocalhostHttp:true}})`). Missing, `null`,
   duplicate or refused: `403`, empty body, **no CORS headers** (the browser reports an opaque failure; a non-browser
   local app that forgot `Origin` learns nothing). `Originator` and `BRC-185-Context` request headers: `400`
   (`PROTOCOL_ERROR`); the origin is never taken from them.
3. **CORS** (6.6.1) is attached to every response from here on, with `Access-Control-Allow-Origin` set to that exact origin.
4. **Preflight** (`OPTIONS`): answered `204`, noninteractive, nothing stateful touched (6.6.1).
5. **Describe** (`GET /.well-known/brc-wallet`): `challenge` is parsed as canonical unpadded base64url of exactly 32 bytes
   (noncanonical or missing: `400` `PROTOCOL_ERROR`). Body is `signDescribe(signer, {origin, challenge, descriptor})`
   from P1 `protocol/descriptor.ts`, where `origin` is the canonical origin from step 2 and the signer is the
   `ContinuityStore` handle for this origin (6.9). Status `200`, `Content-Type: application/json`,
   `Cache-Control: no-store`, `Vary: Origin`; body at most 16,384 bytes. **Noninteractive:** no unlock, no UI, no
   sheet, no permission check, no snapshot dependency. It works with no React tree and the wallet locked, and is rate limited (6.9).
6. **Connect** (`POST /.well-known/brc-wallet/connect`): see 6.7 and 7.2 for the flow.
   `Content-Type: application/json` is required (anything else `415`, before the launch registry or the failure counter is
   touched). Body is strict JSON (`parseStrictJson`), at most 4,096 bytes, and exactly these members:
   ```
   { epoch, challenge, instanceId, continuityKey, android: { launchProof, reconnectToken? } }
   ```
   `epoch` UUIDv4; `challenge` 32-byte canonical base64url; `instanceId` and `continuityKey` must equal the
   `ContinuityStore` entry for this origin, else **`412` `PROVIDER_CHANGED`, no binding**; `android` is the project 4 extension object
   (7.5). Unknown members, duplicates or `null`: `400`. The success response is the connect proof body plus the header
   `BRC-185-Android-Ack` (7.5).
7. **RPC** (`POST /brc185/v1/rpc/<methodName>`): headers `BRC-185-Epoch`, `BRC-185-Instance`, `BRC-185-Key` and `BRC-185-Android-Binding` (the binding secret of 7.5, compared in constant time and
   answered like an unknown epoch when wrong) are required
   and are checked against a **live binding and the request origin before anything is parsed**:
   `getBindingRegistry().resolve(transportId, {epoch, instanceId, continuityKey, origin})`. Unknown, retired,
   tombstoned or mismatched: `412` and the section 6 `ConnectionError` `{domain:'brc185', code:'PROVIDER_CHANGED',
   message, delivery:'not-sent', epoch, cause?}`. Then: `Content-Type: application/json` required; body at most 5 MiB;
   `parseStrictJson`; `sizeBytes` is the byte length; `methodName` must be an own property of the 28-entry method table
   (`isBridgeMethod`) else `PROTOCOL_ERROR` `not-sent` (`404`). The call is
   `dispatch({transport, request: {epoch, instanceId, continuityKey, origin, method, args, sizeBytes, beforeCall}})`.
   The HTTP response is **held open** until the `Outcome` arrives (G5).
8. **Disconnect** (`DELETE /.well-known/brc-wallet/connect/<epoch>`): the four binding headers, the same `resolve()`
   authorisation, then `getBindingRegistry().close(epoch, 'disconnected')`; `204`. The path epoch must equal the
   `BRC-185-Epoch` header, else `412`. A second DELETE of the same epoch is `412` (tombstoned), not `204`.

**Outcome mapping.** `{ok:true,result}` → `200`, `Content-Type: application/json`, the result as BRC-5 JSON (byte values
`number[]`). `{ok:false, walletError}` → `400` with the `WireError` body (`encodeWalletError`). `{ok:false,
connectionError}` → the status in 6.6 with the `ConnectionError` JSON as the body. A response over 5 MiB, or a result
that will not serialise: `502` with `RESOURCE_LIMIT`, `delivery: 'unknown'`. An unexpected exception inside the
controller after dispatch started: `500`, `CONFIGURATION_ERROR`, `delivery: 'unknown'`; before dispatch started:
`delivery: 'not-sent'`. Error messages are at most 4,096 bytes and never carry a stack trace or a path.

**Hold-open and client-gone.** A request is answered when its `Outcome` arrives. If `onClientGone` fires first, the
controller records the id as gone. The request itself stays parked in the core (the dispatcher has no cancel), but
`beforeCall` (awaited after consent and before the wallet is called, P1 6.6) rejects with
`CONNECTION_CLOSED`, `not-sent` when the id is gone, so **a request whose page left never reaches the wallet after the
user approves the site**. A wallet-manager prompt raised *inside* the call (a spend confirmation) cannot be cancelled
this way; if the page leaves during it and the user approves, the action runs and the result is dropped. This is the same
as a closed tab on iOS and is recorded in section 12. The sheet shows the request until it is answered, and the
controller never races the sheet.

### 6.6 CORS, caching and the status table

#### 6.6.1 CORS and Chrome's local-network gate

- `Access-Control-Allow-Origin`: the exact request origin (never `*`, never `null`); `Vary: Origin` on every response,
  including errors. `Access-Control-Allow-Credentials` is **never** sent.
- Which origins get CORS: any origin that passes step 2 for discovery, connect and preflight (discovery is public,
  signed, noninteractive and authorises nothing, BRC-185 §4.1); for RPC and DELETE, only an origin equal to the live
  binding's origin. Everything else: no CORS headers.
- Preflight `204`: `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`; `Access-Control-Allow-Headers:
  Content-Type, BRC-185-Epoch, BRC-185-Instance, BRC-185-Key, BRC-185-Android-Binding` (only the headers the request lists, intersected with
  this set); `Cache-Control: no-store`; **no `Access-Control-Max-Age`**. If the request has
  `Access-Control-Request-Private-Network: true`, also `Access-Control-Allow-Private-Network: true`. Chrome's
  loopback gate is now a permission, not a preflight, and BRC-325 says the server need not send that header; sending
  it when asked is harmless and keeps older Chrome builds working. Nothing relies on it.
- `Access-Control-Expose-Headers: BRC-185-Reconnect-Token` on RPC responses (7.6) and `BRC-185-Android-Ack` on the connect
  response (7.5). No other header is exposed.
- All responses: `Cache-Control: no-store`; `Connection: close`; `X-Content-Type-Options: nosniff`; `Content-Length`.
  `Server` and `Date` are omitted.

#### 6.6.2 Status table (the project 4 open item)

The body is always JSON. A body with `"isError": true` is a `WireError` (a wallet answer); a body with
`"domain": "brc185"` is a `ConnectionError`. Pages discriminate by body, not by status; statuses exist for logs and
for generic HTTP clients.

| Situation | Status | Body |
|---|---|---|
| Success, describe, connect | 200 | method result, or the proof object |
| Disconnect, preflight | 204 | empty |
| Wallet answered with an error (including user denial) | 400 | `WireError` |
| `PROTOCOL_ERROR` (bad JSON, bad header, unknown field, bad challenge) | 400 | `ConnectionError`, `not-sent` |
| Unknown path / unknown method on an epoch transport | 404 | none / `PROTOCOL_ERROR` |
| Host not loopback, Origin missing or refused, launch proof refused | 403 | empty / empty / `CONFIGURATION_ERROR` |
| `USER_CANCELLED` (Don't connect) | 403 | `ConnectionError`, `not-sent` |
| Wrong verb | 405 | none (`Allow`) |
| `PROVIDER_CHANGED` (RPC, connect, disconnect) | **412** | `ConnectionError`, `not-sent` |
| `CONNECTION_CLOSED`, `DISCONNECTED` | 410 | `ConnectionError` |
| `Transfer-Encoding` / no `Content-Length` | 411 | empty |
| Request body over 5 MiB | 413 | `RESOURCE_LIMIT`, `not-sent` |
| Connect with a content type other than `application/json` | 415 | empty |
| `RESOURCE_LIMIT` (bindings, in-flight, sheet slot, decline backoff, failed-proof throttle, unsettled-binding gate, parked-connect cap, describe rate limit) | 429 | `ConnectionError`, `not-sent`, `Retry-After` when known |
| Wallet not built (host attached, `readiness: none`), or a parked connect timed out | 503 | `CONFIGURATION_ERROR`, `not-sent` |
| Too many connections | 503 | empty, `Retry-After: 1` |
| Response over 5 MiB | 502 | `RESOURCE_LIMIT`, `unknown` |
| Internal error | 500 | `CONFIGURATION_ERROR`, `not-sent` or `unknown` |

`SELECTION_REQUIRED`, `DISCOVERY_BLOCKED`, `PAIRING_*` and `DISCONNECTED` after a page-initiated close are page-side
codes; the server never emits them. P1 6.11 fixed only `400` and `412`; the rest is defined here and project 3 conforms.
Recorded deviation: BRC-185 §4.1 says success and error use HTTP 200 with the original representation; the core decision
(wallet error is 400) stands and the page must read non-2xx bodies.

### 6.7 Explicit-mode connect, launch registry and the reconnect token outbox

Registration (module scope, 6.12): `registerTransport({ id: 'android-loopback', attestation: 'unattested',
bindingMode: 'explicit', requestAttention, deliverReconnectToken, onClosed, onPromptRaised })`. The id is fixed;
the host needs no prefix rule.

`connectExplicit` throws `ConnectionError`s (it does not return them), and creates the binding as its last step of
validation. So the controller does all its own checks first and the binding is created only when nothing else can fail:

1. Origin (step 2), `Content-Type: application/json` exactly (else `415`, before anything below is touched), identity
   equality with the `ContinuityStore` entry **for this origin** (6.9), epoch format, body shape.
2. **Unsettled-binding gate** (7.6): if the origin already has an unsettled binding, `429` `RESOURCE_LIMIT`,
   `Retry-After: 5`, `not-sent`. Checked here, before the launch proof is burnt, so a legitimate second tab can retry on
   the same launch.
3. Launch proof (7.5), **verified and burnt at arrival**: everything the HMAC covers (identity from the
   `ContinuityStore`, epoch, origin, challenge, nonce) is available while the wallet is locked, so this needs no readiness. A
   failure is `403` `CONFIGURATION_ERROR` and burns the launch record. A failure is **counted toward the global
   throttle only here**, after steps 1 and 2 passed, so a cross-origin "simple" request that never gets past the checks
   cannot burn records or trip the throttle.
4. Readiness (7.2): `hostAttached` false -> park (`wallet-not-ready`); attached and `none` -> `503`; `building` or `blocked`
   -> park. Parked connects: at most 4 in total (a fifth is `429`), each with a 10-minute wallet-side deadline (answered
   `503`, `CONFIGURATION_ERROR`, `not-sent`). A pre-binding connect is not a request anyone has approved, so BRC-219
   (no deadline on a request waiting for the user) does not apply to it; it applies to every request admitted to a binding.
5. The gate is **re-checked in the same synchronous turn as** `connectExplicit({epoch, transportId, applicationOrigin,
   attestation: 'unattested', instanceId, continuityKey, accountContext, walletRevision, launchProofVerified: true,
   reconnectToken})` (two cold connects that both parked reach here one after the other; the second gets `429` and must
   re-launch), with `accountContext` and `walletRevision` read from `getBridgeSnapshot()` in that turn. Errors map by 6.6.2
   (`RESOURCE_LIMIT`: 8 bindings per origin, 64 total).
6. Respond with `signConnect(signer, {origin, epoch, challenge, descriptor})` and the header
   **`BRC-185-Android-Ack: <ackMac>`** (7.5). The controller derives the binding secret and stores it with the binding;
   `k` is dropped from memory (best effort) once `ackMac` and the binding secret exist.

Per-binding bookkeeping in the controller (memory only): last activity time, parked and in-flight counts, the binding
secret, `settled` flag, the pending reconnect token (7.6), the client-gone set. Bindings die with the process, and with
the main tree (7.1).

`onClosed(CloseEvent)` is synchronous; for HTTP there is no push channel, so it only updates bookkeeping and the session
state machine (7.1). The next request on a closed epoch answers `412` through `resolve()`.

### 6.8 Why dispatch is called directly

Android does not use `inbox.ts`: the durable inbox exists because the iOS extension and the app are different
processes with no live channel. Here the server and the dispatcher are in one process with a live socket. A killed process
loses its sockets, so there is nothing to recover; the page sees a connection failure and treats it as `unknown`.
P1's `InboxStore` is not implemented for Android.

### 6.9 `ContinuityStore` on Android

`src/continuity/secureStoreContinuity.ts` implements P1's `ContinuityStore`:

```ts
getOrCreate(ctx): Promise<{instanceId, continuityKey, signDescribe(...), signConnect(...), sign(preimage)}>
reset(ctx | 'all'): Promise<void>
```

- **Application context is the origin.** BRC-185 defines `instanceId` as "stable for this provider and application
  context". Android gives the wallet no way to tell Chrome from another Chromium browser, or a normal tab from an
  incognito one, so the browser cannot be the context. The context is the canonical origin: `ctx = 'android:' + origin`.
  Each origin gets its **own pseudonymous `instanceId` and `continuityKey`**, derived from one master seed, so two
  colluding sites cannot correlate a user by comparing identities, while each page's own pinning keeps working because
  the pair is stable for that origin. Incognito versus normal is still not separated (section 12). The builder verifies
  that P1's `ContinuityStore` context type accepts this string; if it does not, an additive seam goes into 6.14.
- **Derivation.** `okm = HKDF-SHA256(ikm = master, salt = "BRC-185 android continuity v1", info = ctx || 0x00 || gen, L =
  48)`; bytes 0 to 31 are the Ed25519 seed (`continuityKey` is its public key); bytes 32 to 47 become the `instanceId`
  (UUIDv4 version and variant bits set, lowercase). `gen` is a per-context counter (0 unless `reset(ctx)` ran), which makes
  `reset(ctx)` possible without storing per-origin secrets. HKDF comes from `@noble/hashes`, which the toolbox already
  depends on. The key is independent of every wallet key.
- **Storage.** `expo-secure-store` (already a host dependency, `~57.0.4`): key `bsv.androidBridge.continuity`,
  `keychainService` unique to the kit, `requireAuthentication: false`, `{master, gen: {ctx: n}}` as JSON (master: 32 random
  bytes from `expo-crypto`/`crypto.getRandomValues`, base64url). On Android, SecureStore wraps values with a hardware-backed
  Keystore AES key and stores ciphertext in app-private preferences. **No user-authentication binding**, so describe works
  with the wallet locked and the screen off. The values never leave app-private storage and are not in the backup
  (`allowBackup` is already `false` in the host; the plugin warns otherwise, 6.3).
- **Signing and what is and is not guaranteed.** Pure Ed25519 (RFC 8032, not Ed25519ph) with `@noble/curves/ed25519`.
  The master seed is read once per process into a `Uint8Array` held by the store; that array is wiped on `reset` and on
  logout. **This is best effort, not a guarantee:** the value arrives from SecureStore as a string, and decoded JS strings
  cannot be erased, so the seed exists in the JS heap, the same trust domain that already holds the wallet's keys. A
  Keystore-held key cannot replace it (hardware Ed25519 exists only on newer API levels and not on minSdk 24). Derived
  per-origin handles are cached in memory (LRU of 32) so describe pays no SecureStore read and no HKDF after the first
  request.
- **`sign` is not a generic oracle.** The handle exposes `signDescribe` and `signConnect`, and `sign(preimage)` itself
  rejects any preimage that does not start with `"BRC-185 describe v1\n"` or `"BRC-185 connect v1\n"`. Describe is
  unauthenticated and costs an Ed25519 signature, so it has a global token bucket (10 per second, burst 30); the excess is
  answered `429` `RESOURCE_LIMIT`, `Retry-After: 1`, with CORS (the origin passed step 2).
- **Descriptor.** `version: 1`, `name` from the host's app name (set by `setupAndroidBridge({appName, ...})`),
  **`instanceLabel` a fixed string** (the app name; the device name is never read, because describe is unauthenticated and
  a site must learn nothing about the phone before the user has consented), `icon` optional (a `data:` URI at most 8 KiB
  or absent), `vendor` from the host's reverse-domain, endpoints from 6.2.1. `validateDescriptor` runs on it before every
  signature.
- **Reset.** `reset(ctx)` bumps that context's `gen`, then closes that context's bindings with `lost`; `reset('all')`
  replaces the master and closes everything. The kit resets `'all'` on logout through
  `registerSessionTeardown(['logout'], …)`, as P2 does, so one wallet's identity is never reused for the next.

Vector test: P1's `0185-vectors.json` `descriptorProof` is reproduced through this store with a vector Ed25519 seed injected
at the derivation boundary (test-only seam); a second test pins the HKDF output for a fixed master and two origins and
asserts the two origins' identities differ.

### 6.10 Session lifetime and the foreground service

See section 7.1; the service itself is thin: `BridgeService` holds a notification and the foreground priority, and owns no
sockets (the Kotlin `LoopbackServer` singleton is process-wide and started and stopped by JS). It exists so that the
process (and the JS runtime that answers requests) stays alive while Chrome is in front. **It does not keep sessions alive
when the main tree is gone** (7.1): bindings live only while the host's React tree is mounted.

- **Type: `specialUse`.** Not `dataSync` (6 hours in 24 on Android 15, then a crash unless stopped), not `connectedDevice`
  (needs a Bluetooth or NFC-class permission this is not). `specialUse` has no timeout. It needs the
  `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` text (6.3) and a Play Console declaration; that is a **release gate** (section 11),
  not a build gate.
- **Started only while the app is visibly in front.** JS calls `ensureService()` after it has accepted a launch (the
  wallet is in front in foreground mode; in M2 `BridgeSheetActivity.onCreate` starts it itself). If Android refuses
  (`ForegroundServiceStartNotAllowedException`), `ensureService()` returns false, the controller does not open a port and
  returns to IDLE; the page's rediscovery times out with "wallet did not open". The service is never started from the
  background and has no boot receiver. `START_NOT_STICKY`: if the system kills it, nothing resurrects a listener.
- **Notification** (channel `bridge-session`, importance LOW, **`VISIBILITY_PRIVATE` with a generic public version**).
  It names **no site**: text "N sites connected" or "N requests waiting. Tap to review" (a count only). The lock-screen
  public version reads just "BSV Wallet". A notification that named the site would leak the user's browsing to the shade
  and the lock screen. Actions: **Disconnect** (closes every binding `lost`, stops the server, stops the service). Tap:
  starts the app through an explicit component `PendingIntent` with `FLAG_IMMUTABLE` (M1 `MainActivity`, M2 the
  non-exported sheet Activity when warm). No secrets in the text. A pure-JVM `NotificationSpec` builder produces the
  channel, visibility, text and public version, and a JUnit test pins `VISIBILITY_PRIVATE`, the generic public text and
  `FLAG_IMMUTABLE`.
- **`POST_NOTIFICATIONS` (API 33+).** The runtime permission is asked by the kit from the visible Activity at the first
  accepted launch (`requestNotificationPermission()`, the foremost visible Activity of ours), once; a permanent denial is
  not asked again. If denied, the service still runs but the notification is hidden and later prompts have no
  fallback: the wallet's own connect screen then says "Turn on notifications so BSV Wallet can tell you about later
  requests", and the stand-in page and project 3 must show **Open wallet** again for any request pending more than a few
  seconds (7.4). The e2e list has a case with the permission revoked (`adb shell pm revoke … POST_NOTIFICATIONS`).
- If JS has not started the server within 60 seconds of the service starting, the service stops itself. This timer is
  **Kotlin** (a `Handler` in the service), not JS.

### 6.11 The sheet over Chrome (M2)

See 7.4 for behaviour. Components: `BridgeSheetActivity` (a non-exported `ReactActivity` whose main component is
`BsvBridgeSheet` on the app's existing React host, via the default delegate, 7.4), the theme (6.3), `BridgeSheetRoot` and
`SheetGate` (React), `LifecycleTracker` (Kotlin), and the toolbox `ContextRelay` (6.14). None of it exists in M1.

### 6.12 Public JS API

```ts
setupAndroidBridge(o: { appName: string, vendor: string, allowLocalhostHttp?: boolean }): void
//   Called once, at module scope, in the host's entry file, before the router loads (6.13).
//   Registers the transport (and in M2 the BsvBridgeSheet root with AppRegistry), starts the controller;
//   opens no port. Drains LaunchStore (takeLaunches(0)) so a cold start from a launch is not lost.
AndroidBridgeHost                       // React component mounted in the main tree: reports host state to Kotlin
                                        // (setHostState), and in M2 publishes the context relay and the sheet owner
AndroidBridgeSheetGate                  // M2: wraps the main tree's <PermissionSheet /> (7.4 owner gate)
getBsvAndroidBridge(): BsvAndroidBridgeNative
createLoopbackPageClient(win, opts)     // testing/ (6.16)
resetAndroidBridge(): Promise<void>
ANDROID_TRANSPORT_ID = 'android-loopback'
```

### 6.13 Adoption in bitcoin-sv-wallet

Host edits (each a small, named change; the builder verifies the entry file name against `package.json` `main`):

1. `package.json`: add `@bsv/expo-android-wallet-bridge` (file: tarball, with the same re-vendor caveat as the other local
   packages in memory) and keep `expo-secure-store`.
2. `app.config.js`: add `['@bsv/expo-android-wallet-bridge', { scheme: 'bsv-wallet-bridge' }]` to the plugins, through the
   existing `legacyPlugin` mechanism.
3. **Entry file** (a thin `index.js` that calls `setupAndroidBridge({...})` and then `import 'expo-router/entry'`, with
   `package.json` `main` pointing at it): the transport must be registered **before the wallet is first built**, because
   the second (unverified) permissions manager exists only if an unattested transport was registered at build time
   (P1 6.5; a late registration makes every Android dispatch fail `PROVIDER_CHANGED`, `account-changed`). It also lets a
   cold launch from the intent serve describe before any React tree exists. For M2 the `BsvBridgeSheet` component is
   registered here too, before expo-router registers its root. Android only (`Platform.OS`).
4. `app/_layout.tsx`: mount `<AndroidBridgeHost />` inside `BrowserBridgeProvider`, beside `<PermissionSheet />`
   (M2: wrap that `<PermissionSheet />` in `<AndroidBridgeSheetGate>`).
5. **`app/+native-intent.ts`: `redirectSystemPath` returns `'/'` for any URL that begins with the bridge scheme.** The
   launch never reaches it (6.3), so this is defence in depth only. None to `isolation.test.js`, none to
   `withIconAliasLinks`, none to `blockedPermissions`.
6. R8: the module's rules go in the package's `consumer-rules.pro` (keep `org.bsv.walletbridge.LaunchTrampolineActivity`,
   `BridgeSheetActivity`, `BridgeService`, the module class). The host's `CodedException` keepnames rule already covers the
   error classes. The builder verifies a release build as the memory note on R8 prescribes.
7. A one-time Play Console declaration for `specialUse` and a data-safety line. Release gate.

### 6.14 Changes required in project 1 (toolbox)

All additive; one toolbox release (the toolbox is at 0.21.0).

1. **`core/bridge/loopback/`** (new, pure TypeScript, no React Native imports): `router.ts` (steps 1 to 8 of 6.5 as a
   function from a parsed request and an injected environment to a response plan), `cors.ts`, `status.ts` (6.6.2 as data),
   `hostCheck.ts` (the allowed-`Host` function the Kotlin side mirrors), `launchProof.ts` (7.5: proof, ack and binding
   secret), `endpoints.ts` (`loopbackEndpoints({port, ipv4, ipv6})`). Exported from the `core` barrel. **The router calls
   the existing helpers instead of re-implementing them:** `canonicalizeBridgeOrigin`, `parseStrictJson`,
   `isBridgeMethod`, `signDescribe`, `signConnect`, `validateDescriptor`, `getBindingRegistry().resolve`, `dispatch`; only
   the HTTP framing, CORS and status mapping are new. The request target is parsed strictly: origin-form only, no
   absolute-form, no percent-decoding or dot-segment normalisation, the epoch segment matched as a canonical lowercase
   UUIDv4; the Kotlin parser enforces the same and the router re-checks it.
2. **`assertAdvertisesResponder(descriptor, endpoint)`** in `protocol/descriptor.ts`: P1 6.10 listed it for project 4 and it
   was never written. It throws unless the descriptor advertises an endpoint with the same scheme, host, port and format
   (`http-json`) as the endpoint that answered. The controller asserts it before sending a describe or connect response (a
   bug here would make every real page reject us), and project 3 uses it.
3. **`hostAttached` in the bridge snapshot (the readiness seam).** Today `freshSnapshot()` is `readiness: 'none'` until
   `BrowserBridgeProvider` mounts and `attachBridgeHost` runs; on a cold start from a launch only the trampoline runs, so
   `none` there means "no provider yet", not "no wallet". Add `hostAttached: boolean` to `BridgeSnapshot` (false until
   `attachBridgeHost`, false again after its detach function runs). The controller parks a connect when
   `hostAttached === false` and answers `503` only when the host is attached and readiness is `none`. A change to the
   readiness enum is deliberately avoided (it is read everywhere). Tested on the cold-start path with a fake native
   module.
4. **`core/bridge/testing/pageClient.ts`**: the `PageClient` interface (`discover`, `connect`, `invoke`) moves into a
   toolbox testing export; this kit imports it. Migrating the iOS kit's copy is a follow-up (P2 is device-verified and
   not touched by this project).
5. **(M2) `ui/bridgeSheet/ContextRelay.tsx`** (7.4): `ContextRelayPublisher` and `ContextRelaySubscriber`.
6. **`DispatchRequest` is unchanged.** `beforeCall` is enough for 6.5. (A real `signal` for cancellation while parked at a
   manager prompt is a follow-up, section 14.) **Optional hardening, not required:** key the core's unattested connection
   request per (origin, epoch) instead of per origin, so two same-origin bindings never merge. The kit's unsettled-binding
   gate (7.6) makes it unnecessary now.
7. The CHANGELOG notes it; nothing else in P1 changes. No `InboxStore` use.

**Shared conformance table.** `core/bridge/conformance.ts` already holds the case table for the iOS inbox path. The router
tests reuse the cases that are transport-independent (method table, error codec, size caps) so Android and iOS cannot
drift; the HTTP-only cases stay in the router tests.

### 6.15 What P1 policy means on Android (nothing to build, but visible)

Every Android binding is unattested: the originator becomes `<host>.<grantTag>.unverified.invalid`, basket changes ask, spending
always asks, BTMS and Mandala tokens are refused, a new approval is a clean slate, one connection sheet at a time per transport,
a 30 s backoff after Decline. The sheet shows the "Unverified" badge and the full ASCII origin. The kit must not paper over
any of it.

### 6.16 Stand-in page client and demo page

Project 3 does not exist (ts-stack has no BRC-185 code; `WalletClient('auto')` would probe the legacy routes and raise
Chrome's prompt unprimed). So, like P2, the kit ships `src/testing/loopbackPageClient.ts` implementing the shared
`PageClient` interface (imported from the toolbox testing export, 6.14), plus `demo/`:

- **Flow it implements** is exactly the page contract in 7.7: permission read and primer, eliciting probe, launch link,
  bounded rediscovery, describe proof, connect raced across candidates with the launch proof, **acknowledgement check**,
  connect proof, RPC with the binding header, disconnect.
- Verification uses the toolbox's `verifyDescribeProof` and `verifyConnectProof`, `assertAdvertisesResponder`, and the
  `launchProof.ts` helpers for `k`, the proof, the ack and the binding secret.
- Token store: `localStorage` keyed by the wallet's `continuityKey` and the page origin, written only from a verified
  (ack-checked) response header.
- `demo/demo.ts` reuses the iOS demo's buttons (describe, connect, getVersion, isAuthenticated, getPublicKey,
  createAction, disconnect) and adds: **Open wallet** (the user-gesture intent link), **Permission** (shows
  `navigator.permissions.query` for `loopback-network` then `local-network-access`), a **port window** field (default
  3321, offsets 0 to 63), a per-attempt **timeout** field (default 3000 ms, applies to each describe attempt during
  rediscovery; the connect after a launch has none), and a log that distinguishes *blocked*, *absent*, *refused* and
  *unauthenticated* (a responder that failed the acknowledgement). Query `?scheme=…&package=…&fallback=…` overrides the
  launch target.
- `demo/build.mjs`: esbuild, target `chrome100`; `demo/serve.mjs` as the iOS one on port 3000.
- **Two ways to test**, both documented in the README:
  1. `https://deggen.ngrok.app` tunnelled to `localhost:3000` (the iOS spike's tunnel): a normal https origin, no flag
     needed, Chrome's permission path is exercised (BRC-325 state `prompt`). Needs a real phone or an emulator with a
     recent Chrome (section 10).
  2. `http://localhost:3000` on the phone via `adb reverse tcp:3000 tcp:3000`: BRC-325 state `exempt` (no prompt), needs
     `allowLocalhostHttp` in a debug build. Fast, but it hides the permission behaviour; use only for logic.
- A **squatter fixture** (a second tiny server in the tests with a valid descriptor under its own key and no `k`) is
  part of the stand-in suite: the client must refuse it (7.5, 10).

## 7. Runtime behaviour

### 7.1 Session lifetime: when anything is listening

States of the controller's session machine (JS, one instance):

```
IDLE      no listener, no service
ARMED     a valid launch record exists, server listening, service running; no binding yet
ACTIVE    at least one live binding; server listening, service running
```

**Invariant: a session is valid only while the host's React tree is mounted.** The core's `attachBridgeHost` detach
function (provider unmount) runs `bindings.closeAll('lost')`, clears the managers and sets readiness `none`. If the user
closes the wallet's task or Android destroys `MainActivity`, every binding dies and every parked request fails, even though
the process and the loopback server may still be alive under the foreground service. The "stays connected while Chrome is
in front" story therefore holds while `MainActivity` is **stopped but not destroyed**. The controller does not rely on
`onServerStopped` for this: it subscribes to `hostAttached` (6.14 item 3) and, when it goes from true to false, stops the
server and the session (back to IDLE, unless a launch record is still live, which keeps ARMED). Pages see a refused
connection or `412` and reconnect through a new launch. Keeping `MainActivity` alive is a documented limit; moving the
providers into a tree that outlives the Activity is a much larger change and is an open question for the owner (section 14).

**Timers live in Kotlin.** React Native's Android timer module pauses when the host is paused, and the host is paused
whenever no `ReactActivity` is resumed, which is exactly the state while Chrome is in front. JS timers could therefore stall
or fire late, and the arm expiry, the reaper and the hysteresis would not run. Every deadline-style timer below is a named
Kotlin `Handler` timer (`setTimer(name, ms)` / `clearTimer(name)`, native event `onTimer {name}`, 6.2), and JS only reacts
to the event. Launch records are expired lazily against the monotonic `elapsedRealtime()` at lookup, which needs no timer.
Kotlin-to-JS events and promises still run while the host is paused; spike S5b measures that and a plain JS `setTimeout`
with Chrome in front, to confirm the choice rather than assume it.

- **IDLE → ARMED.** A launch that parses (7.5) arrives (the `onLaunch` nudge, or `takeLaunches(0)` at startup). The
  controller calls `ensureService()` and, if that returns true, `startServer({basePort: 3321, maxOffset: 63})`.
- **ARMED → ACTIVE.** A connect succeeds. That launch record is consumed.
- **ARMED → IDLE.** The `armed` timer fires 120 seconds after the *last* launch record was created, with no binding and no
  connect parked; **or** 10 minutes after the *first* launch of the chain (a hard cap, so a stream of launches cannot hold
  the port open for ever): `stopServer()`, `stopSession()`. A connect already parked (waiting for unlock) keeps ARMED until
  it resolves or its own 10-minute deadline (6.7 step 4).
- **Launch rate limit.** `LaunchStore` (Kotlin) accepts at most one launch per 3 seconds and six per 60 seconds; the
  excess is dropped before any window or sheet appears. Any local app can start the trampoline, so this bounds how fast it
  can keep re-arming the server and flashing notifications.
- **ACTIVE → IDLE.** The last binding closes for any reason and no launch record is live, or the user taps Disconnect, or the
  host detaches, or the account changes (the runtime already closes all bindings `account-changed`; then `lost` for the
  server stopping).
- **Idle binding reaper (the liveness signal).** The `reaper` timer (every 60 s) closes `lost` any binding with no accepted
  binding-authenticated request (probes included; preflights carry no binding headers and do not count) for **30
  minutes**, **and no parked or in-flight request**. It frees per-origin slots (limit 8) held by tabs that were closed
  without a DELETE. It never touches a binding that has a request waiting on the user, however long.
- **Unsettled bindings** (7.6) have a shorter rule: unsettled for 60 s with no parked request → closed `lost`. A binding
  that has not been approved by anyone is not a "request waiting on the user", so BRC-219 does not apply to it.
- **Server stop** (any reason, including `onServerStopped` from a socket error): `getBindingRegistry().closeAll('lost')`.
  Process death: bindings are gone with the process; the port is closed; the page sees a refused connection or a reset.
  A request in flight at that moment is `unknown` to the page.
- **Re-launch while ACTIVE** (a second tab, a second site): another launch record; the same listener and port serve it.
  The port does not change while the server runs, so a page that already found it does not rescan.
- **Why not "listen whenever the app is open"?** Connect needs a fresh launch proof anyway (7.5), and a listener that only
  exists after a visible launch is the smallest exposure and matches the core's "session-scoped server" wording.

**Dead app, what the page does** (the contract in 7.7 step 5): discovery finds nothing, the page shows "Open wallet", the
user taps it, Android starts the trampoline (and the process, if needed), which brings the wallet forward; JS starts, the
launch is pulled, the port opens, the page's bounded rediscovery finds it.

### 7.2 Connect flow and readiness

On a connect that has passed Origin, Content-Type, identity, body and gate checks and the launch proof (6.7 steps 1 to 3), by `getBridgeSnapshot()`:

- (The launch proof was already verified and burnt at arrival, 6.7 step 3, before any parking.)
- `hostAttached === false` (the main tree has not mounted yet: **a cold start from a launch, and the dead-app case, which
  is the most common first visit**): the connect response is **parked** and `requestAttention('wallet-not-ready')` runs
  (foreground mode). The core's `readiness` is `none` here only because no provider exists, so it is never read as "no
  wallet". Parking resumes when the host attaches and the snapshot re-evaluates.
- `hostAttached` and `ready`: continue at 6.7 step 5.
- `hostAttached` and `none` (the app is up and reports no wallet): `503` `CONFIGURATION_ERROR`, `not-sent`; parked connects
  are answered the same when the host attaches with no wallet. The wallet shows "Create or restore a wallet in BSV Wallet
  first".
- `building` or `blocked` (the wallet is loading or locked): the connect response is parked; when the snapshot becomes
  `ready` the flow continues. Expiry and single use of the launch record (7.5) were decided when the connect **arrived**, so
  unlocking takes as long as the 10-minute park deadline allows (6.7 step 4). If the page disconnects meanwhile
  (`onClientGone`), the parked connect is dropped and its launch record stays burnt.

A parked connect is the one place this kit holds a response with a deadline, and only because no one has approved it yet.
Once a binding exists and a request is admitted, nothing times it out (G5).

### 7.3 Legacy routes: not served (decision)

`POST /<method>` and the other epoch-less routes of the pre-BRC-185 desktop protocol are not served, and a request to one
is a plain `404` with no CORS headers. Reasons: they carry no epoch, instance or key, so they have no port-reuse protection
(a different wallet on the same port would be indistinguishable); the origin is forgeable on Android; and BRC-185 forbids
falling back from the new profile onto them. Consequence: `WalletClient('auto')`'s legacy probes of 3321 find nothing here,
and `HTTPWalletJSON` pointed at this port does not work. That is intended. Ports 3301 (binary) and 2121 (HTTPS) are not
served either: the binary profile adds a second codec for no gain, and an HTTPS listener needs a certificate every browser
trusts, which an app cannot provide.

### 7.4 The launch path, foreground mode, the bottom sheet over Chrome (M2), and the way back

**Launch path.** The page opens the intent link; Android delivers the URI to `LaunchTrampolineActivity` (the only exported
component, 6.3). The trampoline validates it, stores it in `LaunchStore` and starts the next component with **no data**:

| Condition (known to Kotlin through `setHostState` and `LifecycleTracker`) | Next component |
|---|---|
| M1, any state | `MainActivity` (`getLaunchIntentForPackage`) |
| M2, host attached and `ready` | `BridgeSheetActivity` (overlay mode) |
| M2, otherwise (cold process, locked, building, main tree gone) | `MainActivity` (foreground mode) |

There is no "Unlock card" in the sheet Activity: when the wallet cannot show a prompt, the user is taken straight to the
wallet, which is one tap fewer and cannot present an unusable overlay. In a process that has only just started, Kotlin
knows nothing is attached and chooses foreground mode.

**Foreground mode (M1).** The wallet app comes to the front. JS pulls the launch (`takeLaunches`), the connect arrives,
parks until the host is attached and unlocked, and the existing in-tree `PermissionSheet` shows the "Connect example.com?"
request. After the last pending prompt, the way back (below) applies. This is the always-works path and the one the e2e
tests exercise first.

**Overlay mode (M2).** `BridgeSheetActivity extends ReactActivity`, not exported, with `getMainComponentName() =
"BsvBridgeSheet"`. It uses the library's default delegate (`DefaultReactActivityDelegate` on
`(application as ReactApplication).reactHost`, no Expo wrapper unless S4 shows a need), so the Expo lifecycle listeners of
`MainActivity` (splash, orientation, navigation bar) do not run for it. Its task is its own (`taskAffinity`), directly above
Chrome's; because the window is translucent, Chrome stays visible and running behind it (the activity below is paused,
not stopped), which keeps the page's held `fetch` alive.

*Protections, because a translucent sheet over an arbitrary foreground app is a tapjacking target:*

- `Window.setHideOverlayWindows(true)` on API 31+ while the sheet is up, and Android 12's untrusted-touch blocking relied on;
- **`FLAG_SECURE` on the Activity window for every sheet** (connect, protocol, basket, certificate, spending, group), not only
  spending: all of them show attacker-influenced text and gate access;
- a **mostly opaque scrim** (about 90 percent), so the page behind cannot draw convincing fake controls around the sheet,
  with S3 checking that Chrome is still treated as visible and running behind it;
- touches are dropped when `MotionEvent` carries `FLAG_WINDOW_IS_OBSCURED` or `FLAG_WINDOW_IS_PARTIALLY_OBSCURED`
  (`dispatchTouchEvent`), and the 700 ms tap protection on Approve (P1) applies to every sheet;
- the root view keeps `filterTouchesWhenObscured`.

*Launch handling:* the sheet never reads the launch URI; it gets a sequence number as its only extra.
`BridgeSheetActivity` is created for a launch only when `savedInstanceState == null` and the extra's sequence number is new,
so an OS task restore or process recreation cannot re-arm the server (7.5).

**The sheet's content: a second React root that shares the first one's state.** The main tree is the only place the
providers live (`WalletContext`, `ExchangeRateContext`, `UserContext`, theme); `PermissionSheet` reads them with
`useContext`. Building a second wallet for a second root is out of the question. So:

- Both roots run in the same JS runtime, so every module-level singleton (the P1 runtime, consent store, binding
  registry, `AppState`) is shared for free. `AppRegistry.registerComponent('BsvBridgeSheet')` runs in the entry file
  before expo-router registers its root (6.13).
- Toolbox `ContextRelayPublisher` (mounted by `AndroidBridgeHost` inside the main tree) reads the listed contexts and
  publishes their current values to a module-level store. `ContextRelaySubscriber` (the root of `BsvBridgeSheet`) nests
  a `Context.Provider` per entry with the live value (`useSyncExternalStore`), then renders the sheets.
- The context list is data (`RELAYED_CONTEXTS`). A jest test renders `PermissionSheet` and the connect sheet under the
  subscriber **only** and fails if any `useContext` returns its default.
- **One owner at a time (no duplicate prompt, no duplicate effects).** A single selector, `sheetOwner()`, returns `'main'`,
  `'overlay'` or `'none'`: `'overlay'` iff the sheet Activity is resumed and `MainActivity` is not resumed
  (`LifecycleTracker`), `'main'` iff `MainActivity` is resumed. `AndroidBridgeSheetGate` wraps the main tree's
  `<PermissionSheet />` and renders it only when the owner is not `'overlay'`; `BridgeSheetRoot` renders `<PermissionSheet />`
  only when the owner is `'overlay'` and nothing otherwise. So the tap-protection timers, biometric prompts and response
  calls of `PermissionSheet` exist in exactly one root at a time. `LifecycleTracker` is an
  `Application.ActivityLifecycleCallbacks` registered in the Expo module's `OnCreate` with a catch-up from
  `appContext.currentActivity`; its cold-start ordering (module created after `MainActivity.onCreate`) is checked in S4.
- **React host lifecycle.** The React host tracks one current Activity, so interleaved resume/pause/destroy between
  `MainActivity` and the sheet Activity can deliver `onHostPause`/`onHostResume`/`onHostDestroy` in surprising orders.
  S4 verifies, with logging, that `onHostDestroy` never fires for a live `MainActivity`, that `AppState` follows 7.4's lock
  statement, and that the host's own `AppState` listeners (`useRequests`, `useVaultKeys`, `NotifyPrompt`) behave.
- The sheet root has **stable accessibility labels and test ids** for the e2e: `bridge-sheet-root`, `bridge-approve`,
  `bridge-deny`, and the connect card's `bridge-connect-origin`; the builder adds them to the connect sheet and
  `PermissionSheet` where absent.
- i18n comes from the shared runtime; copy goes in all 12 locales like P1 and P2.

**Lock policy and `AppState`.** The host has no lock-on-background today: every `AppState` listener under `src`
(`useVaultKeys`, `useRequests`, `NotifyPrompt`, `appIcons`, `feedback`) refreshes on `active`, none locks. The kit adds
none. `AppState` is process-wide: it is `active` while either of our Activities is resumed (the sheet task counts) and
`background` only when neither is, exactly as for an ordinary app. Rules the kit holds the host to: a lock or background
transition never closes bindings and never fails a parked request; a locked wallet parks new connects as `blocked`; a parked
connect resumes when the snapshot becomes `ready`; if the host later adds auto-lock it must not lock while the sheet is
resumed. S4 has a sub-case (locked then unlocked while the sheet is open) and a jest test renders the sheet root under a
locked-then-unlocked fake wallet.

**When an overlay or the wallet is raised (`requestAttention`).**

| Core calls | Wallet in front (`sheetOwner() === 'main'`) | Action |
|---|---|---|
| `'consent'`, `'prompt'` | yes | nothing: the in-app sheet is visible |
| `'consent'`, `'prompt'` | no | try `showSheet` (M2, may be blocked in the background) and always post the heads-up notification |
| `'wallet-not-ready'` | any | foreground mode: the wallet is already brought forward by the launch; a later one only posts the notification |

`onPromptRaised` (fires whether or not the app is active) only updates the notification's waiting count.

**Way back to Chrome.** When no connection request, no manager prompt and no wallet-not-ready state has been pending for
600 ms (hysteresis, a Kotlin timer so it fires while backgrounded), the controller calls `returnToBrowser()`:
- overlay mode: `BridgeSheetActivity.finish()`, its task disappears and Android returns to the task beneath, normally
  Chrome;
- foreground mode: `moveTaskToBack(true)` on the foremost of our Activities, only if the bridge brought it forward.
  The task order is then Chrome, wallet; `moveTaskToBack` sends the wallet to the bottom and Chrome should surface. If
  both a sheet task and the main task were raised, the result may be the home screen or the leftover task.

`ActivityManager.moveTaskToFront` for Chrome is blocked on modern Android, and relaunching Chrome by intent would navigate
arbitrarily, so neither is used. **Which task Android returns to is a device gate (S3)**; the documented fallback is the
system Back gesture or the app switcher, and the README says so.

**System Back / outside tap in the sheet.** Back leaves the requests **parked** (BRC-219: no answer is given by leaving)
and finishes the Activity; the notification then says "N requests waiting. Tap to review". An outside tap does nothing.

**Background activity starts, honestly.** Android 10+ blocks an app that has no visible window from starting an Activity;
`SYSTEM_ALERT_WINDOW` is blocked by the host, and the full-screen-intent privilege is not available to a wallet on Android 14+.
So an Activity is *guaranteed* only in the moments the page's user click launches it. For a later request while Chrome is in
front (the page calls `createAction` five minutes after connecting):

1. `showSheet` is tried (M2; it works on some OEM builds and when the app was recently visible).
2. Always, a **heads-up notification** (channel `bridge-attention`, importance HIGH, `CATEGORY_MESSAGE`,
   **`VISIBILITY_PRIVATE` with a generic public version**) is posted. Its text is generic: "A website wants to continue.
   Tap to review." **No host name appears in it:** the host comes from the forgeable `Origin` header, may be an IDN or
   look-alike, and a notification that quotes it reads as a trusted prompt. The origin is shown only inside the wallet, with
   the Unverified badge. Tapping it (explicit-component `FLAG_IMMUTABLE` `PendingIntent`) opens the wallet or sheet. It is
   cancelled when the prompt is shown or answered.
3. If notifications are denied (6.10), nothing is visible. The request stays parked. The stand-in page and project 3's page
   must offer **Open wallet** again whenever a request has been pending for more than a few seconds (a fresh launch click is
   always a visible start; its launch record connects nothing extra and the wallet simply shows the waiting prompt).

### 7.5 The launch proof and the wallet's acknowledgement (project 4 open item)

The launch secret `k` is known only to the page that built the intent and to the app Android delivered it to (Android
routes by `package=`). It is used in **both directions**: the page proves a visible launch to the wallet (`launchProof`),
and the wallet proves to the page that the endpoint it is talking to is the app the intent reached (`ackMac`). Neither
authenticates the website: any installed app can launch the trampoline with a secret of its own choosing (P1 9), and any
app can bind a port. What the pair gives is that a squatter without `k` can never be accepted as the wallet.

**Launch URI**, built by the page on a user click and opened as an `intent:` link:

```
intent://launch?v=1&o=<b64url(origin)>&e=<epoch>&k=<b64url 32 bytes>&n=<b64url 16 bytes>
  #Intent;scheme=<scheme>;package=<applicationId>;[S.browser_fallback_url=<url-encoded static URL>;]end
```

which the trampoline receives as `<scheme>://launch?v=1&o=…&e=…&k=…&n=…`. `o` is the page's `location.origin`; `e` is the
epoch the page will use in the connect; `k` is a fresh secret random per launch, kept in page memory; `n` is a fresh nonce.
The whole URI is at most 512 bytes. `e` is **also secret-like** (it is a bearer value for the page's later RPC, together
with the binding secret below): never logged.

**Platform handling of the URI.** The trampoline (Kotlin, 6.3) checks scheme, host `launch` and size, stores the URI in
`LaunchStore` under a sequence number, and starts the next component with no data. The URI therefore is **not** left in a
stored Activity Intent, a recents snapshot's intent, or `Linking`. It can still appear in the browser's own state and in
`ActivityTaskManager` logs on debug devices, which the kit cannot clean; that is why `k` and `e` are single-use and expire in
120 s. JS pulls launches with `takeLaunches(afterSeq)` (the `onLaunch {seq}` event is only a nudge), so a cold start and a
warm `singleTask` delivery race to the same queue and none is lost or doubled. A launch is created **only** by the
trampoline; nothing restores it from an Activity or `savedInstanceState`, so a task restore or process recreation cannot
re-arm the server.

**On receipt** (JS, `launchRegistry.ts`): `v` must be `1`; `o` must canonicalise (P1 rule, unattested); `e` a UUIDv4 that is
neither stored nor **tombstoned** (burnt epochs are remembered in memory for at least 10 minutes, so an evicted or
re-delivered URI cannot make a fresh unused record for the same epoch); `k` exactly 32 bytes and `n` exactly 16 bytes of
canonical base64url; unknown parameters refuse. A refused URI is dropped silently. Otherwise a record `{epoch, origin,
secret, nonce, receivedAt, expiresAt = receivedAt + 120 s, used: false}` is stored. **Memory only.** Caps: 8 live records per
claimed origin, 32 in total. When a cap is hit the oldest **unused** record of the origin currently holding the most records is
evicted (fair share); **a record whose connect is parked is never evicted**, and if nothing can be evicted the new URI is
dropped. Records are never logged, and the module redacts `k` and `e` from any error text.

**The proof in the connect body** (`android.launchProof`, 43 chars):

```
launchProof = b64url( HMAC-SHA-256( key = k,
  msg = UTF8("BRC-185 android launch v1\n") || JCS({ v: 1, wallet: { instanceId, continuityKey },
        epoch, origin, challenge, nonce: n }) ) )
```

where `origin` is the `Origin` header value, `challenge` the connect request's challenge, `n` the record's nonce (the wallet
takes `n` from the record it looks up; the page does not send it in the body), and `wallet` the identity for **this origin**
(6.9). The wallet looks the record up **by the connect's epoch**, requires `used === false` and `now < expiresAt`, requires
the record's canonical origin to equal the canonicalised `Origin` header, recomputes the HMAC and compares in constant time.
**The record is marked used before anything else can fail** (burnt on any outcome after lookup), so a proof is single use
even if the connect is then refused.

**The wallet's acknowledgement and the binding secret** (same JCS body `M` as above, new labels):

```
ackMac        = b64url( HMAC-SHA-256( k, UTF8("BRC-185 android ack v1\n")     || M ) )   // response header BRC-185-Android-Ack
bindingSecret = b64url( HMAC-SHA-256( k, UTF8("BRC-185 android binding v1\n") || M ) )   // never sent; both sides derive it
```

The wallet returns `ackMac` on the connect response only after the connect succeeded. **The page must verify `ackMac` before
it sends any RPC, before it stores or pins the `continuityKey`, and before it stores any reconnect token.** The page derives
the same `bindingSecret` locally and sends it on every RPC and DELETE as `BRC-185-Android-Binding`; the wallet compares it in
constant time with the secret stored for that epoch and answers any mismatch exactly like an unknown epoch (`412`, no
oracle). Consequences:

- A **port squatter** can serve a validly signed descriptor under its own key and copy the name, icon and vendor, but it does
  not know `k`, so it can neither produce `ackMac` nor learn the binding secret. The page refuses it (7.7 step 5). The HMAC in
  the proof binds the squatter's own claimed identity, so what the squatter received is useless against the real wallet.
- A squatter (or a log) that learns the **epoch** learns nothing that lets it drive the real wallet's binding: RPC needs the
  binding secret as well as the epoch, `instanceId` and `continuityKey` (the last two are public through describe).
- A page that is sent to the wrong endpoint first still has its launch record intact on the real wallet (the real wallet
  never saw that connect).

**Why this shape:**

- The secret `k` rides only in the intent and in the page's memory; it never crosses the loopback socket.
- The expiry is enforced by the wallet's own monotonic clock from receipt: no page clock, no skew. 120 s covers a person who
  has to answer a Chrome permission dialog; the unlock case is handled by parking a connect that has already arrived.
- A proof failure (unknown epoch, expired, used, origin mismatch, bad HMAC): `403` `CONFIGURATION_ERROR` with the fixed
  message "launch proof required", identical for every cause (no oracle). Five failures within 60 s, **counted only after the
  request passed the origin, content-type, identity and body checks** (6.7), trip a global 60 s throttle (`429`,
  `RESOURCE_LIMIT`).
- Because the proof is required **every** connect, a returning site is bounced through the wallet on every new connect (about a
  second in overlay mode, no sheet when the token matches, 7.6; a visit to the wallet in foreground mode). That is the price of
  P1's rule ("unattested connections need a launch proof every time") and is recorded in section 12. One launch authorises one
  connect (one epoch); a second tab needs its own click.

### 7.6 Reconnect token delivery, and who may receive it (project 4 open item)

The core calls `deliverReconnectToken(binding, token)` once, synchronously, on Approve, for each parked live unattested
binding of the approved origin (`consentSheetSource.ts` loops over them). Because the origin is forgeable, a local app that
launches the trampoline itself with the victim's origin gets a valid launch proof of its own, and could park its binding behind
the same consent request as the real page and receive the token the user's single Approve mints. So the kit adds a rule the
core does not have:

- **Unsettled-binding gate.** A binding is *unsettled* from creation until its origin is connected for it (the consent was
  approved, or a reconnect token matched and its first non-probe request was admitted) or it closes. **At most one unsettled
  binding per origin exists.** A second connect for an origin that has one gets `429` `RESOURCE_LIMIT`, `Retry-After: 5`,
  `not-sent`, checked before the launch proof is burnt (so a legitimate second tab can retry on the same launch) and again in
  the same synchronous turn as `connectExplicit` (two cold connects that both parked). Therefore at most one binding of an
  origin can ever be parked behind a consent request, and the core's loop over parked bindings reaches exactly that one.
- **Delivery is to the owner only.** The kit keeps `unsettledOwner[origin] = epoch` and drops the token for any binding that is
  not the owner (belt and braces, with its own test: two same-origin bindings parked, only the owner receives the token).
- **Withdrawal.** An unsettled binding with no parked request is closed `lost` after 60 s (7.1). If the page's connection goes
  away while its only request is parked behind consent (`onClientGone`), the unsettled binding is closed `disconnected`, which
  makes the core remove the consent request and the wallet withdraw the sheet when nothing else is behind it. (This also
  resolves the old limit that an abandoned connect sheet stayed up.)

Delivery contract:

- **Carried in a response header.** The controller stores the token in the binding's *token outbox* (memory) and attaches it
  as `BRC-185-Reconnect-Token: <token>` to the **next response written for that epoch**, normally the response of the very
  request that was parked behind the approval. The header is in `Access-Control-Expose-Headers`.
- **Exactly once.** The outbox clears when the response head has been written to the socket without error. If the write
  fails (the page left), the token stays for the next response on that epoch. If the binding closes first, the token is
  dropped; the stored hash then matches nothing, and the next visit simply shows the connect sheet and mints a fresh token
  (a clean slate). It is never in a URL, never logged, never in a notification, and the kit's logger redacts the header name.
- **At connect, `android.reconnectToken`** carries the stored token, and goes straight to `connectExplicit({reconnectToken})`,
  which the dispatcher consumes at the first non-probe request. A wrong or missing token is treated as not connected
  (sheet), never as an error.
- **The page's side of the contract (project 3 conforms; the stand-in client obeys it):** the page keeps the token in its own
  origin's `localStorage` keyed by the wallet's `continuityKey`, and sends it **only** to an endpoint whose describe proof
  (verified with `verifyDescribeProof` against the page's own origin and a fresh challenge, within the previous 30 seconds)
  carried a `continuityKey` equal to the stored key. A wallet identity the page has never seen is never sent a token. **A token
  is stored only from a response whose `BRC-185-Android-Ack` verified (7.5).** The token is stable for the life of the approval,
  so the page re-sends the same one every visit.
- The token proves "this is the browser origin the user approved"; it is not a login (P1 6.4).

### 7.7 The page contract (what project 3 must do; what the stand-in client does)

1. **Only on a user click.** No probing on page load.
2. Read the permission: `navigator.permissions.query({name:'loopback-network'})`, retrying `local-network-access` if the
   first name throws (BRC-325 3.1). `denied`: do not probe, report "blocked". `unsupported` or `exempt`: no primer.
3. If `prompt`: show the page's own primer (names the wallet or "a wallet on this phone", shows its own origin), then on
   the user's confirming click make **one eliciting request** (`GET http://127.0.0.1:3321/.well-known/brc-wallet?challenge=…`)
   with no deadline. Whatever it returns (almost certainly a failed fetch, the wallet is not running), the permission is
   now granted or denied. If the user answered a system prompt in between, transient activation is gone, so the page shows
   an **Open wallet** button for a second click. If the permission was already `granted`, step 4 happens on the first click.
   Incognito tabs add Chrome's own "Open in app?" confirmation before the intent runs; the page cannot see it and must
   treat a missing wallet within the step 5 window as "did not open", with Open wallet offered again.
4. **Launch.** On a click, navigate to the launch intent (7.5) with a fresh `e`, `k`, `n`. The page must not await anything
   between the click and the navigation. The optional fallback URL is a static page, never the page itself.
5. **Rediscover, bounded, tied to that click, and never "first valid describe wins".** Scan `127.0.0.1` ports 3321 to 3384 (at
   most 16 at a time, a per-attempt timeout of about 3,000 ms because the wallet's JS may be busy loading, no redirects,
   `redirect: 'error'`), repeat every 500 ms for at most 15 seconds, then report "wallet did not open". Not a background
   loop, not repeated without a new click. Check each describe response with `verifyDescribeProof` and
   `assertAdvertisesResponder`; every endpoint that passes is a **candidate**, not yet the wallet. After the window the page
   sends the connect of step 6 to the candidates (at most 4, **concurrently**, each with its own `launchProof` because the
   identity differs) and accepts **only the first response whose `BRC-185-Android-Ack` verifies under `k`**, aborting the
   others. An endpoint that answers without a valid ack is reported as "unauthenticated" and never pinned. A squatter that
   hangs its connect cannot block the real wallet because the race is concurrent. (Chrome may throttle timers while the
   wallet is in front; a loop of sequential fetches tolerates that.)
6. **Connect** `POST /.well-known/brc-wallet/connect` with `Content-Type: application/json`, `android.launchProof` and, only
   when the candidate's describe proof carried the **already pinned** `continuityKey`, `android.reconnectToken`. **No
   deadline** on this request (it can wait for unlock, up to the wallet's own 10-minute park limit). Verify the connect proof
   and the ack; only then pin the `continuityKey` and keep the connection. `429` on connect: honour `Retry-After` and offer a
   new click.
7. **RPC** with the three BRC-185 headers plus `BRC-185-Android-Binding`; `412` means the binding is gone: reconnect from step
   4, never replay. Read the `BRC-185-Reconnect-Token` header from any RPC response and store it. A non-2xx body with
   `isError` is a wallet error.
8. **Never auto-retry** a request that failed after being sent (`delivery: unknown`), and never fall back to the legacy routes.
9. Cross-origin iframes need `allow="loopback-network"`; documented for integrators.

## 8. Security analysis

### 8.1 Attackers and what stops them

| Attacker | Capability | Stopped by |
|---|---|---|
| Local app, forges `Origin` | connects to the port | launch proof (it must launch the trampoline itself, in front of the user, and the connect sheet then shows the claimed ASCII origin with the Unverified badge); reconnect token (it cannot read the real site's storage); unsettled-binding gate (it cannot park beside the real page and take the token, 7.6); clean slate (it gets an empty grant set, not the real site's); spending always asks |
| Local app, port squatter | binds a port before the wallet starts (the wallet is dead until the click, so this is easy) | **the wallet's acknowledgement (7.5):** the squatter has no `k`, so it cannot produce `BRC-185-Android-Ack` and the page refuses it, including on a first visit when nothing is pinned; the page never auto-picks the first valid describe and races the candidates; the binding secret means a leaked epoch drives nothing; exclusive bind in both families on our side; the token goes only to a key-matched, ack-verified endpoint |
| Another web page | `fetch` to the port from a malicious origin | exact-origin CORS; the origin must pass `canonicalizeBridgeOrigin`; consent per origin; Chrome's own loopback permission; `Content-Type: application/json` required on connect and RPC, so a CORS-simple request never reaches the registry or the failure counter |
| DNS rebinding | attacker host resolving to 127.0.0.1 | Host check in Kotlin before any parsing; origin differs anyway |
| Local app, availability | re-launches in a loop, parks connects, fills tables | launch rate limit (1 per 3 s, 6 per 60 s) before any window; ARMED hard cap of 10 minutes; at most 4 parked connects with a 10-minute deadline; unsettled bindings expire at 60 s; fair-share eviction of launch records that never evicts a parked one. **Accepted:** a local app can still deny service for the real site for short periods (12) |
| Local app, notification abuse | triggers heads-up notifications naming a lookalike site | notifications name no site; private visibility with a generic public version; the origin appears only inside the wallet with the Unverified badge |
| Tapjacking over the sheet | overlay on the translucent window | `setHideOverlayWindows`, `FLAG_SECURE` on every sheet, a mostly opaque scrim, obscured-touch rejection, `filterTouchesWhenObscured`, the 700 ms tap protection (P1) |
| Cross-site tracking | colluding sites compare identities | per-origin pseudonymous `instanceId` and `continuityKey` (6.9); no device name in describe |
| Cross-profile / other user | work profile, private space | out of scope; Android 17 restricts cross-profile loopback; recorded |
| Passive sniffing | read loopback traffic | not possible without root; 8.4 |

The launch proof's honest limit: a malicious app can launch the trampoline with a secret of its own and claim any origin. What the
user sees is the connect sheet naming that origin as **Unverified**. If they approve it, the app gets an *empty* grant set under
a fresh originator, every spend asks, and the real site's earlier approval and token are untouched (P1 9 documents the full
reasoning). The reconnect token stops a forging app from *silently* riding a real approval, and the unsettled-binding gate stops
it from taking the real page's token.

### 8.2 Data at rest

Nothing the user could read as private is on disk in plaintext. The continuity master seed is in Keystore-wrapped SecureStore.
Launch records, bindings, binding secrets, outbox tokens and the pending-request table exist only in memory. Notifications name no
site. No request or response body is ever logged; the Kotlin server logs counts and status codes at most, and nothing in
release builds above warnings.

### 8.3 Logging rules

Never log: `k`, `e` (the epoch, including in `DELETE` paths in server debug logs), the launch URI and its query, proofs, the
ack, binding secrets, reconnect tokens, request or response bodies, `BRC-185-Key`, `BRC-185-Android-Binding`. The kit's
`warn()` redacts those names and the Kotlin server's request-line logging replaces the epoch segment of the path. Platform logs
are outside the kit's control: the launch URI may appear in `ActivityTaskManager` on debug devices and in browser state. The
mitigations are structural: the URI is never left in an Activity Intent (6.3), `k` and `e` are single-use and expire in 120 s,
and the epoch alone cannot drive a binding without the derived binding secret (7.5).

### 8.4 Encrypted association (MWA-style): decision NO for v1

Solana's Mobile Wallet Adapter encrypts its local WebSocket with a key agreed from a dapp-held association key, because its
transport is an open port that any local app can talk to and its payloads (transactions to sign) have no other protection.
Here:

- Content secrecy against another app is not at risk: loopback traffic is not readable by unprivileged apps.
- Session hijack is blocked without encryption: an RPC needs a live epoch, the instance id and the continuity key, and the epoch
  is a random UUID the page chose and sent only over loopback to the wallet it verified. The wallet checks the origin on every
  call.
- What an encryption layer would add is authenticated *page* identity, which a key agreed over a socket cannot provide (the page
  has no key the wallet can attribute to an origin). The launch proof (7.5) already gives us the part that works: single-use,
  per-launch, identity-bound.
- It would also break BRC-185 §4.1, which defines plain JSON bodies, and any independent page implementation would need our
  extension to talk to us at all.

Revisit if sniffing becomes practical (a platform change that routes loopback through a capturable path) or if non-browser local
clients become a goal.

### 8.5 MWA-style iframe origin attestation: deferred research (decision)

A page could load an attestation page hosted by the wallet at a domain bound to the app by Digital Asset Links; the page runs in a
hidden iframe, reads the browser-set `event.origin` of its parent and returns a signed statement. If it held up, Android origins
could become `verified`. Not done now: it needs a wallet-controlled web origin and `assetlinks.json` (and a seven-day propagation
on Android 15+), a design for partitioned third-party storage and Chrome's iframe loopback permission delegation, a way to stop a
forging native app from loading the same iframe itself (it can, and read `event.origin` as itself), and a security review. The
MWA spec itself leaves open what binds the iframe to the real top-level origin. Gate for revisiting: the owner wants verified
Android origins, a wallet web origin exists, and a prototype resists a forging-app test (an app that opens the attestation page in
a WebView and relays the result). Until then the transport stays `unattested`.

## 9. Constraints

- minSdk 24 (host), compile and target SDK as the host's RN 0.86 toolchain (36). Kotlin 2.1 as in RN's catalog. Java 17.
- Android 12+ background-start rules (7.4), Android 13+ notification permission, Android 14+ FGS type permissions, Android 15
  FGS timeouts (not applicable to `specialUse`), Android 17 `ACCESS_LOCAL_NETWORK` (unknown effect on loopback; a spike, S1).
- Chrome >= 142 on Android for the loopback permission; earlier Chrome has no prompt and no gate. Chrome 145 splits the permission
  into `local-network` and `loopback-network`; the page tries both names.
- RN: no sockets in JS, hence Kotlin. The JS thread is the one place the P1 runtime lives; the server relies on the process staying
  alive and the JS runtime answering events while backgrounded (JS timers do not run then, so deadlines are Kotlin timers, 7.1).
- Bundle size and R8: no new third-party library. `consumer-rules.pro` keeps the Activity, Service and module classes.

## 10. Testing

**TypeScript, jest** (no device; the repo runs these today):

- Toolbox `core/bridge/loopback/`: router table tests for every step in 6.5 (missing, `null`, duplicate `Origin`; wrong verb;
  unknown path; legacy path `404`; `Originator` header refused; describe challenge parsing including noncanonical base64url;
  **connect with a non-JSON content type is `415` and touches neither the registry nor the failure counter**; absolute-form,
  percent-encoded and dot-segment targets refused; a non-canonical epoch segment refused; connect identity mismatch `412` with
  no binding; epoch reuse; RPC with each header missing, wrong, retired **and a missing or wrong `BRC-185-Android-Binding`
  answered exactly like an unknown epoch**; unknown method; oversized body; holding a response), CORS (exact origin, `Vary`,
  no credentials, preflight intersection including the binding header, private-network echo, no CORS on refusals), the status
  table, `hostCheck`, `endpoints` (families, `localhost` only when both), `assertAdvertisesResponder` (each field mismatch),
  and the BRC-185 vectors (`descriptorProof` and a connect proof). The transport-independent cases of
  `core/bridge/conformance.ts` run over the router too.
- Launch proof, ack and binding secret: golden vectors; single use; expiry; wrong epoch/origin/challenge/wallet identity;
  tombstoned epoch refused after eviction; fair-share eviction that never drops a parked record; no oracle in messages;
  failure throttle counted only after the earlier checks.
- **Squatter test (blocker-level):** a fake wallet on 3321 with a valid descriptor under its own key, the real name, icon and
  vendor, no `k`, and a first visit with nothing pinned. The stand-in client must refuse it (no ack), must not pin it, must not
  send it a token, must connect to the real wallet on 3322, and a squatter that never answers its connect must not delay the
  real one.
- **Unsettled gate and token ownership:** two same-origin connects, the second gets `429` and its launch record is not burnt;
  two bindings parked behind one consent through a core fake, only the owner receives the token; an abandoned parked connect
  closes the binding and withdraws the consent; unsettled bindings expire at 60 s with no parked request and never with one.
- Token outbox: delivered once on the first response; kept after a failed write; dropped on close; never in logs (log capture
  test).
- Session machine (fake native timers): IDLE/ARMED/ACTIVE transitions, 120 s arm expiry and the 10-minute chain cap, launch rate
  limit, 30 min reaper that never touches a binding with a parked request, parked-connect cap and 10-minute deadline, **host
  detach (MainActivity destroyed while the service is alive) closes every binding and returns to IDLE**, server stop closes all
  `lost`.
- Controller with a fake native module and the real P1 dispatcher: all 28 methods round-trip; wallet error → 400 `WireError`;
  **cold start: `hostAttached` false parks the connect, host attach with a wallet resumes it, attach with no wallet answers
  `503`**; connect while `building` parks and resumes; client-gone before consent → `beforeCall` rejects `CONNECTION_CLOSED`;
  `unknown` delivery on a large response; the unverified manager exists (the registration-order test fails if the transport is
  registered after the wallet build).
- `ContinuityStore`: vector; HKDF pin for two origins that must differ; reset bumps `gen` and closes that context's bindings
  `lost`; `sign` refuses a preimage without a known prefix; describe rate limit; works with a mocked locked state; seed never
  in a log.
- Plugin: manifest-merge snapshot (trampoline exported with one filter and the scheme, service type and property, sheet
  Activity not exported, permissions, no `SYSTEM_ALERT_WINDOW`), scheme default and validation, the `withIconAliasLinks`
  interaction test, the host `+native-intent.ts` rule.
- (M2) `ContextRelay`: `PermissionSheet` and the connect sheet render under the subscriber alone with no default-context
  leaks; the sheet owner gate renders `PermissionSheet` in exactly one root; the sheet root under a locked-then-unlocked fake
  wallet.
- Stand-in client against the real controller through an in-memory fake of the HTTP layer.

**Kotlin, JUnit 4.13.2, pure JVM** (the repo has plain JUnit for `react-native-localpay-transport` and no Robolectric; none is
added): `HttpParser` (smuggling set: duplicate and non-numeric `Content-Length`, `Transfer-Encoding`, bare LF, obs-fold, oversized
line and head, header count, `Expect`, pipelined bytes, request-target forms, slow-trickle with a fake clock), `PortAllocator`
(real sockets on loopback: free port, taken v4, taken v6 → move up, no `::1` → v4 only, other errors surface, exhaustion,
never a non-loopback address, **serve-close-rebind returns the same port**, a live second listener still fails),
`classifyBindError` (both message formats and errno), `HostCheck`, `LaunchIntent` size and shape, `LaunchStore` (sequence,
rate limit), `NotificationSpec` (visibility, public text, `FLAG_IMMUTABLE`).

**Emulator end to end** (`scripts/e2e/`). Requirements: an AVD with the **Google Play** system image and **Chrome 142 or newer**
(update Chrome through the Play Store, or sideload a Chrome Beta/Dev/Canary APK matching the AVD ABI); the Google APIs image
ships an older Chrome that has no loopback permission. Before the run, a `chrome-command-line` file
(`/data/local/tmp/chrome-command-line` with `chrome --disable-fre --no-default-browser-check --no-first-run`, enabled for
debugging) removes Chrome's first-run and consent screens. A node script drives Chrome through DevTools
(`adb forward tcp:9222 localabstract:chrome_devtools_remote`, `puppeteer-core`; `Input.dispatchMouseEvent` counts as a user
gesture) against the demo page, and `uiautomator`/`adb shell input` for the wallet using the stable labels of 7.4
(`bridge-approve`, `bridge-deny`, `bridge-sheet-root`). Two page sources: `adb reverse` + `http://localhost:3000` (the `exempt`
path, logic only; hides the permission) always, and the https/ngrok path (the real permission path) only where Chrome is
recent enough. Cases: **cold launch from Chrome with the process dead (foreground mode) first**, then warm; describe and
connect; `getVersion` and `getPublicKey`; the connect sheet (Connect and Don't connect); a held-open request across the sheet;
silent reconnect with the token; kill the app mid-session and see the page recover through a new launch; MainActivity
destroyed (`adb shell am kill` of nothing but the activity via "don't keep activities") with the service alive; ports 3321 and
3322 occupied by a test socket (we take 3323); `::1:3321` taken alone (real Android bind messages); a squatter app on 3321 with
the real name; `POST_NOTIFICATIONS` revoked (`pm revoke`); an incognito tab. The Chrome permission dialog and the OEM-specific
rows are manual (device gates).

**Release build run**: the R8 procedure from the memory note (main-checkout Gradle release build, mapping check, dexdump for the
trampoline, Service, module (and M2 sheet) classes, then a Pixel_9 smoke).

## 11. Spikes and device gates (owner)

**S0. Registration order (first task of the plan).** Confirm that `registerTransport` is legal before `initBridgeRuntime` and before
`BrowserBridgeProvider`/`WalletContextProvider` mount (the iOS kit registers only after `isBridgeHostAttached`, but its transport is
browser-attested and has no such constraint), and that the unverified manager is built on the first wallet build when it did. If
registration at module scope is refused or the flag is read too early, add an additive P1 seam to 6.14: a way to mark the
unattested transport as present before the build. Together with S0: the `hostAttached` seam (6.14 item 3) and whether P1's
`ContinuityStore` context type accepts `android:<origin>` (6.9).

Spikes that gate the build, in order (the builder runs them on a Chrome-capable AVD first where the AVD can, and **always on a
real phone** for S1 and S2; results go in `SPIKES.md`, like P2's). **M1 needs S0, S1, S2, S5, S5b, S7, S8; M2 additionally needs
S3, S4 and S6, and S4 comes first in M2.**

- **S1. Chrome's loopback permission on Android (real-phone gate).** From `https://deggen.ngrok.app`: does `permissions.query`
  return `prompt`; does the eliciting fetch raise a prompt; the label ("Apps on device"?); does a granted site reach
  `http://127.0.0.1:3321` and `[::1]`, and does `localhost`; does it work when the Android OS permission
  `ACCESS_LOCAL_NETWORK` is absent or denied (Android 17; BRC-325 says do not assume). Mixed content from https to
  `http://127.0.0.1`. An emulator whose Chrome predates 142 cannot answer this; the answer comes from a real phone or a
  sideloaded recent Chrome.
- **S2. Intent launch (real-phone gate).** An `intent://launch?…#Intent;scheme=…;package=…;end` link from a click: opens the
  trampoline with no chooser; without a gesture it is blocked; the optional fallback URL when the app is not installed; the URI
  arrives intact in the trampoline (cold and warm), **the router never receives the URI and `k` never appears in JS logs**;
  `ensureService()` succeeds when called from JS after a foreground-mode launch (and what happens if not); an **incognito tab**
  (Chrome's "Open in app?" confirmation) and Chrome's behaviour on a rapid second launch.
- **S3. (M2) Translucent task over Chrome, and the way back.** Chrome visible behind the sheet; the page's timers and fetch keep
  running; `finish()` returns to Chrome and not the home screen; foreground mode `moveTaskToBack` returns to Chrome; the task
  order when both a sheet task and the main task were raised; `excludeFromRecents` side effects; multi-window; the tapjacking
  protections (`setHideOverlayWindows`, obscured touches, the scrim opacity) with a test overlay app.
- **S4. (M2, hard gate, first task of M2) Second React root.** A minimal "hello" `BsvBridgeSheet` mounts on the shared host with
  the default delegate; then: the relay supplies every context; the sheet renders in light and dark, with the keyboard and 12
  locales; no double prompt and no duplicated effects (owner gate); `onHostDestroy` never fires for a live `MainActivity`;
  `AppState` in each phase; the host's `AppState` listeners behave; `LifecycleTracker` cold-start ordering; a locked-then-unlocked
  sub-case; the cold-start-without-MainActivity case (the sheet Activity must never start in that state). If this fails, M2 is
  dropped.
- **S5. Hold-open.** A fetch held 30 minutes survives Chrome in the background, the screen locking, and Doze; the FGS keeps the
  process; killed-process behaviour is a clean connection error; **MainActivity destroyed while the service lives** closes the
  session as 7.1 says.
- **S5b. Timers while backgrounded.** With the wallet's last Activity finished and Chrome in front, measure a JS `setTimeout`
  (expected to stall), a Kotlin `Handler` timer, and the delivery latency of a native event to JS; confirms that the arm
  expiry, reaper and hysteresis fire on time.
- **S6. (M2) Background prompt.** With Chrome in front and the app not visible: does `showSheet` start at all on a Pixel and one
  OEM phone; does the heads-up notification appear and open the wallet; what the user sees with notifications denied and with
  notifications private on a locked screen.
- **S7. IPv6 / `localhost`.** Which family Chrome tries first for `localhost`; dual bind; the 412/403 behaviour of a wrong Host;
  describe latency (measured during the wallet build, on the Pixel_9) against the page's per-attempt timeout.
- **S8. Work profile / private space** on Android 17.

Release gates (not build gates): Play Console `specialUse` declaration and data-safety answer; an independent review before any
BRC-185 conformance claim (BRC-185 requires interoperating implementations, a published report and an independent security
review; `CONFORMANCE.md` states what is and is not claimed); a real-phone pass of every row of section 10's end-to-end list;
the https/ngrok path in a release build with R8.

## 12. Known deviations and limits (recorded, not hidden)

- **Origin is unattested.** Every Android site is "Unverified" in the sheet, with the stricter policy (P1 6.5, 9).
- **Two modes, and overlay is warm-only.** A cold or locked wallet shows in the foreground, not as an overlay (section 1).
  Returning to Chrome is best effort.
- **A launch on every connect**, even for a returning, token-matched site (P1 rule). In overlay mode it shows for about a second
  and then closes itself; in foreground mode the wallet comes to the front and goes back.
- **BRC-185 extensions:** the connect body's `android` member, the `BRC-185-Android-Ack` response header, the
  `BRC-185-Android-Binding` request header, the `BRC-185-Reconnect-Token` response header, the launch `intent:` link, and the
  wallet-error `400`. A third-party page that implements only BRC-185 text cannot connect to this wallet. No conformance claim
  is made.
- **Later prompts may need a tap.** When Chrome is in front, a prompt raised after the launch click may appear only as a
  notification (7.4) or never (notifications denied).
- **Sessions need the main tree.** Bindings live only while `MainActivity`'s React tree is mounted (7.1); the foreground service
  does not keep them alive past its destruction.
- **Cross-site linkability is removed, cross-browser is not.** Identities are per origin (6.9), but all browsers and
  incognito tabs share one master seed and, for a given origin, one identity; the wallet cannot tell them apart.
- **Seed hygiene is best effort.** The master seed passes through the JS heap as a string that cannot be erased (6.9).
- **A page that leaves during a manager prompt** (a spend confirmation) can still have the action performed if the user approves;
  the result is dropped (6.5). A core cancel signal is a follow-up (section 14).
- **Process death** drops every binding and every held request; a request in flight is `unknown` to the page.
- **No second wallet protection** beyond exclusive bind and signature verification: two apps that both implement this kit
  allocate different ports and the page sees two wallets; the launch targets one package, so only that one acknowledges.
- **Chrome only**, from version 142. Other browsers are untested.
- **Cross-profile loopback** (work profile, private space) may not work on Android 17.
- **The guard's `listActions` deadline** (P1 follow-up, 30 s) conflicts with BRC-219 for a parked request and is not fixed here.
- **Response over 5 MiB** is `502`, `unknown`.
- **Global proof-failure throttle.** Any local app that gets past the earlier checks can trip the 5-failures-in-60-s throttle
  (7.5) and lock the real page out for a minute; a per-origin throttle is meaningless because `Origin` is forgeable. Accepted.
- **Accepted denial-of-service limits** (a local app cannot gain access, but can annoy): it can keep the port open for up to the
  10-minute chain cap and trigger the generic heads-up within the launch rate limit; it can evict the real page's launch record
  if it launches 8 times for the victim's origin within the record's 120 s life (the rate limit makes that take at least 21 s);
  it can hold the one unsettled-binding slot of an origin for up to 60 s with no parked request, or while its parked request
  waits for the user; it can fill 4 parked-connect slots for up to 10 minutes while the wallet is locked.
- **Idle reaper** at 30 minutes closes bindings of long-idle tabs; the page reconnects through a new launch.
- **Describe is public.** It reveals that a wallet exists and its (pseudonymous, per-origin) identity to any origin that passes
  Chrome's permission; it reveals nothing about the device.

## 13. Calls made while the owner was unavailable

Every decision below was made without the owner, from the research and the P1/P2 specs. Each is cheap to reverse unless noted.
They are not owner decisions. Items 31 onward came from the adversarial review (section 15).

1. **Separate package** `@bsv/expo-android-wallet-bridge`, not an Android platform added to the Safari kit (6.1).
2. **Hand-written `ServerSocket` server** over NanoHTTPD or Ktor; one request per connection, `Connection: close` (6.2).
3. **Protocol logic in TypeScript** with Kotlin as a dumb pipe, and the pure router in the toolbox (6.14), not the reverse.
4. **JSON HTTP only**, base 3321, ceiling 3384; no binary 3301, no HTTPS 2121, **no legacy routes** (7.3).
5. **Dual-family bind or move up**; advertise every bound spelling, `localhost` only when both families are ours (6.2.1).
6. **No port open outside a session**: opened by a launch, closed 120 s after an unused launch or when bindings end (7.1).
7. **Foreground service type `specialUse`**, started only while the app is visibly in front, `START_NOT_STICKY` (6.10).
8. **30-minute idle reaper** as the liveness signal; never applies to a binding with a parked or in-flight request (7.1).
9. **Launch proof design** (HMAC under a per-launch secret carried in the intent; 120 s wallet-side expiry; epoch-bound lookup;
   burn on any failure; no-oracle message; throttle) and a private launch scheme (7.5, 6.3).
10. **A launch on every connect**, no relaxation for returning sites (follows P1; a "session launch" relaxation was considered
    and not taken).
11. **Reconnect token in a response header**, delivered once on the next response of the epoch; token accepted in
    `android.reconnectToken`; the page's identity-check contract (7.6).
12. **Connect extension namespace** `android: {…}` rather than top-level members (7.2, 6.5).
13. **Connect parks while the host is not attached or the wallet is `building`/`blocked`**, with launch expiry checked at
    arrival (7.2). The snapshot cannot supply `accountContext` until `ready`; the builder verifies.
14. **HTTP status table** (6.6.2), including `403` for Don't connect and launch-proof failure, `429` for limits, `502` for an
    oversized response, `410` for closed, `415` for a wrong connect content type.
15. **Wallet errors travel as `400`** (follows P1) and pages read non-2xx bodies (a deviation from BRC-185 text).
16. **`Access-Control-Allow-Private-Network` echoed only when asked**; nothing relies on it (6.6.1).
17. **No encrypted association for v1** (8.4) and **iframe attestation deferred** (8.5).
18. **Continuity store in TypeScript on `expo-secure-store` + noble Ed25519** (6.9); superseded in part by call 38.
19. **Overlay is a second `ReactActivity` root on the shared host with a context relay**, built only as milestone 2 after S4;
    foreground mode is the fallback and the first milestone (6.0, 7.4). The alternative considered and rejected: a globally
    translucent `MainActivity` (a theme change for every user, and the launcher showing through).
20. **One sheet owner at a time** (selector plus gate), so there is never a duplicate prompt or duplicated effects (7.4).
21. **Background prompts fall back to a heads-up notification**, no `SYSTEM_ALERT_WINDOW`, no full-screen intent (7.4).
22. **600 ms hysteresis** before returning to Chrome; Back leaves requests parked; outside tap does nothing (7.4).
23. **`beforeCall` for client-gone**, no core change (6.5); a core cancel signal left as a follow-up.
24. **Request caps**: 16 KiB heads, 64 headers, 32 connections, 10 s/30 s receive timeouts, 30 s write-stall; connect body 4 KiB.
25. **Per-origin storage key for the token on the page is the wallet's `continuityKey`** (follows P1 6.4).
26. **No `InboxStore` for Android** (6.8).
27. **Stand-in client uses a shared `PageClient` interface moved into the toolbox testing export** (changed from "copied");
    the iOS kit's own copy is migrated later (6.14).
28. **Test stack**: Kotlin JUnit without Robolectric; DevTools-driven emulator e2e (section 10).
29. **Kotlin package `org.bsv.walletbridge`** and notification channel names.
30. **Toolbox release** carries the additive `core/bridge/loopback/`, `hostAttached`, the testing export and, for M2, the relay
    (6.14) before the kit's first build.
31. **The wallet authenticates itself to the page** with `BRC-185-Android-Ack` under `k`, and the page races ack-verified
    candidates instead of taking the first valid describe (7.5, 7.7). A squatter on a first visit is refused.
32. **Binding secret derived from `k`** and required as `BRC-185-Android-Binding` on RPC and DELETE, so a leaked epoch drives
    nothing (7.5). Adds one request header to the extensions list.
33. **Unsettled-binding gate** (one per origin) and owner-only token delivery, kit-only; the core's per-epoch consent keying is
    optional hardening (7.6, 6.14).
34. **Launch trampoline**: an exported, React-free Activity that never forwards the URI; the sheet Activity is not exported;
    the launch is carried in process memory with sequence numbers (6.3, 7.5). The Unlock card is dropped in favour of going
    straight to the wallet.
35. **Milestones**: M1 foreground mode and the transport, M2 overlay gated on S3/S4/S6 (6.0).
36. **`hostAttached` additive snapshot field** instead of changing the readiness enum (6.14 item 3).
37. **Deadline timers in Kotlin**, JS reacts to events; launch records expire lazily on the monotonic clock (7.1).
38. **Per-origin identities** derived with HKDF from one master seed; `instanceLabel` fixed, no device name (6.9). This reads
    BRC-185's "application context" as including the origin. Fallback if the owner disagrees: one key, no device name, record
    linkability.
39. **Notifications name no site**, are `VISIBILITY_PRIVATE` with a generic public version, use explicit immutable
    `PendingIntent`s (6.10, 7.4).
40. **Tapjacking set** for the overlay: hide-overlay-windows, `FLAG_SECURE` on every sheet, about 90 percent scrim, obscured
    touch rejection (7.4).
41. **Parked-connect and ARMED bounds**: 4 parked connects, 10-minute deadline, 10-minute chain cap, launch rate limit, fair-share
    record eviction (7.1, 7.5). Pre-binding connects are the only held responses with a deadline.
42. **Sessions are valid only while the main tree is mounted**; detach stops the server (7.1). Moving the providers above the
    Activity was not done.
43. **`setReuseAddress(true)`** and errno-and-message based bind error classification (6.2.1).
44. **Static manifest in the library**, plugin parametrises the scheme only; one default-scheme rule `<package>.bridge` (6.3).
45. **POST_NOTIFICATIONS** requested by the kit at the first accepted launch, with a denied-state message (6.10).
46. **Lock policy**: the kit adds none, never closes bindings on lock or background (7.4).
47. **Emulator requirement**: Google Play image with Chrome 142 or newer or a sideloaded recent Chrome; S1/S2 are real-phone
    gates; stable test ids for the sheet (section 10).
48. **No `S.browser_fallback_url` to the page itself**; a static URL or none (6.3).
49. **Describe rate limit** and a cached continuity handle (6.9); per-attempt page timeout about 3 s (7.7).

## 14. Left to the builder, and open items for later

**Left to the builder:** Kotlin file split inside the package; thread model (thread per connection at the 32 cap is fine; a
selector is welcome); exact notification copy and icons; which `RELAYED_CONTEXTS` the grep finds (the test enforces
completeness); precise Gradle versions; the e2e script's selectors beyond the labels fixed in 7.4; ordering of the spikes on
real hardware; whether the heads-up notification is a bubble.

**Open questions for the owner (nothing blocks M1 on them):**

1. **Per-origin identity (call 38).** Is reading BRC-185's "application context" as the origin acceptable? If not, the fallback is
   one identity for everything and recorded cross-site linkability.
2. **Overlay at all (M2).** Foreground mode is the first release. Does the owner still want M2 given that the overlay works
   only on a warm, unlocked wallet and must clear S3/S4/S6?
3. **Sessions end when the wallet's main screen is destroyed.** Acceptable, or should the providers move above the Activity
   (a much larger change)?
4. **Unverified Android origins.** Whether the core should key unattested consent per (origin, epoch) (6.14 item 6, optional).

**Open items for later:**

- **Project 3:** the SDK hook and controller on top of 7.7, including how a page learns the launch scheme and package id (BRC-185
  has no field for them; options are a descriptor-adjacent convention, a registry the controller ships, or a catalog entry
  per vendor; the wallet being absent means it cannot tell the page). The `WalletClient('auto')` primer gate (P1 follow-up).
  Honouring the 7.6 token contract, the 7.5 acknowledgement, and the 6.6.2 status table.
- Migrating the iOS kit's `PageClient` copy to the toolbox testing export.
- A core cancel signal for requests parked at a manager prompt (`DispatchRequest.signal`).
- A "Browser connections" screen and revoke UI, the policy settings screen (shared with P2).
- Verified origins on Android (8.5).
- A binary or legacy profile only if a real client needs it.
- Other Chromium browsers; Custom Tabs and WebViews.
- A Windows/desktop host reusing `core/bridge/loopback/`.
- Replacing the notification fallback if Android offers a sanctioned way to show a sheet from the background for a user-initiated
  web request.

## 15. Review notes

An adversarial review raised 27 issues against revision 1. Each was fixed in this revision (where) or rejected in part or in
full (reason). Section references are to this document.

| # | Issue | Outcome |
|---|---|---|
| 1 | Wallet never proves it is the launched app (port squatter, first visit) | **Fixed:** `BRC-185-Android-Ack` under `k`, page races ack-verified candidates, squatter test (1, 7.5, 7.7, 8.1, 10). |
| 2 | Reconnect token reaches a forging binding parked behind the same consent | **Fixed kit-only:** unsettled-binding gate, owner-only delivery, withdrawal on client-gone (7.6). Core per-epoch keying kept as optional hardening rather than a required core change (6.14 item 6). |
| 3 | Exported sheet Activity shares the ReactHost; launch URI reaches `Linking`/router | **Fixed:** exported React-free trampoline, non-exported sheet, no data forwarded, `redirectSystemPath` defence, S2/S4 checks (6.3, 6.13). |
| 4 | Local apps keep the server up, starve the real site, evict its launch record | **Fixed:** launch rate limit, ARMED chain cap, parked-connect cap and deadline, fair-share eviction that never evicts a parked record; residue accepted in 12 (7.1, 7.5). |
| 5 | Notifications carry attacker-chosen text and leak browsing | **Fixed:** no site named, `VISIBILITY_PRIVATE` with public version, immutable explicit `PendingIntent`s, spec-builder test (6.10, 7.4). Chose PRIVATE over SECRET: the user must still see "requests waiting" on an unlocked shade. |
| 6 | Describe leaks a cross-site identifier and the device name | **Fixed:** per-origin HKDF identities, fixed label (6.9). Depends on reading "application context" as origin; flagged to the owner (13 item 38, 14). |
| 7 | Tapjacking and overlay defences thin | **Fixed (M2):** hide-overlay-windows, `FLAG_SECURE` on every sheet, opaque scrim, obscured-touch rejection, S3 item (7.4, 11). |
| 8 | Connect does not require `application/json` (CORS-simple POST) | **Fixed:** `415`, strict target parsing, failure counted only after earlier checks (6.5, 6.7, 6.14). |
| 9 | Stale launch URI re-arms the server after recreation | **Fixed:** launches exist only in `LaunchStore` from the trampoline, nothing restores them; epoch tombstones for 10 minutes (7.5). Sequence-number pull replaces `getInitialLaunch`. |
| 10 | "Seed zeroed afterwards" is unachievable; `sign` is a generic oracle | **Fixed:** honest best-effort statement, cached `Uint8Array`, prefix-checked `sign`, describe rate limit (6.9). |
| 11 | Platform logs and the epoch as a bearer value | **Fixed in part:** `k` and `e` redacted everywhere the kit controls, URI never left in an Intent (8.3). The suggested fourth RPC header was **adopted** but as a binding secret derived from `k`, which adds nothing to the wire except the header (7.5); it matters because a squatter that learns the epoch (the page reuses one epoch across candidates) could otherwise drive the real wallet's binding. |
| 12 | `readiness: none` is "no provider yet" on cold start, not "no wallet" | **Fixed:** `hostAttached` seam, park instead of `503` (6.14 item 3, 7.2). |
| 13 | Provider unmount closes every binding; the service cannot keep sessions alive | **Fixed:** invariant stated, detach drives stop and IDLE, test added; moving providers up **rejected** as out of scope (larger change), asked of the owner (7.1, 14). |
| 14 | JS timers pause while backgrounded | **Fixed:** Kotlin timers, lazy monotonic expiry, S5b measures it (7.1). |
| 15 | Second React root on shared host thinly specified | **Fixed:** delegate named, lifecycle behaviour and registration order specified, single owner selector and gate, S4 as a hard first M2 gate (7.4, 11). |
| 16 | Headline UX vs cold-start path | **Fixed:** two modes described honestly, foreground first (1, 7.4). |
| 17 | `setReuseAddress(false)` | **Fixed:** `true`, with the rebind test (6.2.1). |
| 18 | Bind error classification by message text | **Fixed:** errno plus both message formats, device e2e case (6.2.1, 10). |
| 19 | Describe depends on the busy JS thread | **Fixed in part:** cached handle, 3 s per-attempt timeout, S7 measurement. A hard guarantee under JS load is **not** given (6.9, 7.7, 11). |
| 20 | Plugin and manifest inconsistencies | **Fixed:** static parts in the library, one default-scheme rule, named theme parent, no bar colours (6.3). The scheme intent filter stays plugin-supplied because manifest placeholders are resolved by the app, not the library. |
| 21 | Nothing requests `POST_NOTIFICATIONS` | **Fixed:** kit requests at first accepted launch, denied-state copy, e2e case (6.10). |
| 22 | Lock policy vs AppState | **Fixed in part:** the host was grepped, no lock-on-background exists; the kit adds none, states process-wide `AppState` and the rules it holds the host to, adds an S4 sub-case and a jest test (7.4). |
| 23 | Way back to Chrome; `isMainActivityActive` unspecified | **Fixed in part:** `LifecycleTracker` specified, per-mode return behaviour, S3 gate. Relaunching Chrome by its task id or `S.browser_fallback_url` was **rejected**: `moveTaskToFront` is blocked and relaunching Chrome navigates arbitrarily (7.4). |
| 24 | Emulator cannot test Chrome 142 features | **Fixed:** AVD requirement, command-line flags, incognito case, S1/S2 as real-phone gates, stable test ids (10, 11, 7.4). |
| 25 | Scope too large for one project | **Fixed:** milestones M1/M2 (6.0, 11). |
| 26 | Reuse and iOS mirroring gaps | **Fixed in part:** exact helpers listed, shared conformance cases, `PageClient` moved to a toolbox export imported here. Migrating the iOS kit's copy is **deferred** to avoid touching the device-verified P2 in this project (6.14, 6.16). |
| 27 | Launch intent details (fallback URL, race, incognito) | **Fixed:** static fallback URL, event-plus-pull launches, incognito documented and in S2 (6.3, 7.5, 7.7, 11). |
