# Browser ↔ wallet bridge: feasibility (2026-10-27)

Input: `~/Downloads/BSV-Browser-Wallet-Bridge.md` (Safari Web Extension + native messaging on iOS,
MWA-style intent + local WebSocket on Android). Method: five research agents (iOS mechanics, iOS
in-Safari approvals, Android, page/SDK side, toolbox integration), each checked by an adversarial
verifier against primary sources (Apple/WebKit docs and source, Chromium release notes and source,
Android docs, the Solana reference repos, our own code). Raw output: 10 agents, ~800 tool calls.

## Bottom line

| Area | Verdict |
| --- | --- |
| Page discovers and picks one of several wallets | **Feasible, already specified.** BRC-185 (Ty Everett + Deggen, merged 2026-10-13) defines the events, handle, signed descriptors, neutral chooser and per-origin memory. Nothing implements it yet. |
| iOS Safari extension as transport | **Feasible.** The extension can announce a provider, take a browser-attested origin, stage requests and show an in-Safari summary. |
| Approve a spend/signature **inside Safari** with this wallet | **Not feasible** without a second wallet. The wallet (SQLite, permission tokens, KEK, guard) lives in the app's RN runtime; nothing in iOS lets the extension reach or wake it. |
| Android Chrome to wallet app | **Feasible with caveats.** Needs Chrome's loopback-network permission (Chrome 142+, WebSockets since 147), a gesture per launch, and an unattested-origin policy. The "modal" ceiling is a bottom sheet over Chrome (an app switch that looks like a modal). |
| Approve **inside Chrome** on Android | **Not feasible.** Chrome for Android has no extensions. |
| Library code in the toolbox | **Feasible.** The request processor is mostly reuse; native parts belong in a sibling package. |

The input doc contradicts itself ("no full app switch" vs "detection + handoff router"). For this
wallet only the handoff-router reading holds.

## What already exists

- **BRC-185** *Wallet Substrate Discovery, Selection, and Encrypted Mobile Connections*
  (`bsv-blockchain/BRCs/wallet/0185.md`, status "proposed; draft"). Relevant parts:
  - §2: discovery, chooser and storage live **outside** the core SDK. The SDK gets only a narrow
    delegation hook, `globalThis[Symbol.for('brc185.connection-provider.v1')]`, consulted by
    `WalletClient('auto')`. So "add it to WalletClient" becomes: hook in `@bsv/sdk` + separate
    controller/chooser package.
  - §4.2: extensions announce on `brc185:request-provider` / `brc185:announce-provider`, with a
    handle exposing `describe(origin, challenge)`, `connect(origin, epoch, onClose)`,
    `disconnect(epoch)`. Providers must **not** fight over `window.CWI`. `describe` is
    non-interactive and signed with a per-application-context Ed25519 continuity key.
  - §4.1: localhost profile with ascending ports from 3301/3321/2121 and signed
    `GET /.well-known/brc-wallet` discovery, epoch-bound RPC routes.
  - §5: neutral chooser, remembered choice per full origin.
  - §8–10: encrypted mobile relay (Noise `NNpsk0`, record layer, relay server, `brc-wallet://pair#…`
    or verified https app link, `returnUrl`). Mandatory independent security review before
    production (§11).
- **BRC-325**: what a page must do before Chrome's loopback prompt (read permission state first,
  exhaust prompt-free adapters, show a primer).
- **BRC-219**: a permission-pending request may wait indefinitely, but the wallet must be visibly
  asking. No client timeouts.
- **Toolbox relay (mobile side)**: `core/context/WalletConnectionContext.tsx`, `ui/screens/PairScreen.tsx`.
  It dispatches through `new WalletClient(capWalletArgs(guardVaultAccess(pm, ADMIN_ORIGINATOR)), originator)`.
  Its method allowlist covers only 16 of 28 methods (no `getVersion`, `waitForAuthentication`,
  `abortAction`, …), so it is not a template for method coverage. This is legacy, not BRC-185 v1.
- **bsv-browser** (`~/git/ts/bsv-browser`): a 28-method dispatcher, `walletEnvelope` error codes and a
  `window.CWI` document-start shim. This is the best source to port for the extension page script.
- **402-extension** (`~/git/ts/402-extension`): a desktop Chrome MV3 extension that pays BRC-121 402s via
  `WalletClient('auto')`. It relies on `webRequest`, which iOS Safari lacks.

## iOS findings

Verified against primary sources:

- Only background scripts and extension pages can call `browser.runtime.sendNativeMessage`, not
  content scripts. Safari ignores the application id: each extension reaches only its own appex.
  Path: page → MAIN-world script → content script → background/popup → native handler.
- No direct IPC exists between an appex and its containing app. `NSExtensionContext.open` is
  Today/iMessage only. Darwin notifications do not wake a suspended app. App Group files are
  passive.
- The Solana reference avoids an app switch only by keeping an **unencrypted key in shared
  UserDefaults** and signing in Swift. Its main app is never contacted. Shipped iOS Safari wallets
  (1inch, Dawn) hand off to the app for signing.
- Opening the app from the extension: DTS (forum 776365, Mar 2025) says to render an `<a href>` and
  let the user tap it. A custom scheme from the popup gives an "Open in <App>?" prompt. Universal
  links in the popup open the web page, not the app. Subframes cannot launch apps. **Unverified on
  device.**
- Gestures: page and content-script gestures do **not** propagate to extension pages (WebKit
  source). Only popup taps count. `action.openPopup` is listed for Safari 16 in MDN BCD and used by
  Solana. Whether it works without a gesture on iOS 18/26 is untested.
- The background must be non-persistent and is unloaded after about 30 s idle. Message size, handler
  time and appex memory limits are undocumented. Forum reports say the native-message callback
  sometimes never fires. Every step must be durable and idempotent (request id, expiry, App Group
  file state).
- Users must enable the extension and grant per-site access before content scripts run, and enable
  it again separately for Private Browsing. **Chrome for iOS and in-app browsers cannot run Safari
  extensions**, so on iPhone "Safari/Chrome" collapses to Safari only.
- App Store 4.4.2: request the minimum host permissions. A Safari update that widens host
  permissions disables the extension for existing users (Safari 16.4).
- Expo: `@bacons/apple-targets` supports a `safari` target type. It is experimental and needs a
  CNG + EAS proof.

Why in-Safari *approval* fails for this wallet:

- Permission grants are PushDrop tokens in the app's SQLite, with fields encrypted under the wallet
  key. Minting one is a `createAction`.
- `waitForAuthentication` can raise the grouped-permission sheet. So the first call of almost every
  site session needs the wallet process, not just spends.
- Sharing the SQLite through an App Group invites 0xdead10cc terminations. Two writers would cause
  `SQLITE_BUSY_SNAPSHOT` and double change allocation.
- Putting key-only methods in the extension with a shared key would bypass
  `seekProtocolPermissionsForSigning`, the BRC-29 ask-every-signature policy and the guard denylists.
  **Rejected.**

iOS options:

| Option | What the user gets | Cost and risk |
| --- | --- | --- |
| **0: no extension** (BRC-185 relay pairing or a link with return, plus existing push) | Works in every iOS browser. App switch for approvals. Origin is a claim, checked by code comparison. | A BRC-185 v1 relay does not exist yet. Needs a relay server and a security review. |
| **A: extension as detector + handoff router** (recommended) | Automatic detection on the page (BRC-185 announce), **browser-attested origin**, an in-Safari summary of the pending request. Approval happens in the wallet app (tap → app → approve → "◀ Safari" back). Warm path: when the app is already awake it can serve without a visible switch. | An App Group shared only between the app and its own appex, holding a request queue only (no keys, no DB). A unique per-wallet scheme or link. Return path unproven. |
| **E: separate capped "browser wallet" inside the extension** | True in-Safari approvals. | A second hot wallet with its own funds, backup and security review. Diverges from the app's balance and permissions. |

## Android findings

- Since **Chrome 142** (Android included), an https page reaching `127.0.0.1` needs the
  user-granted **loopback-network** permission ("wants to access other apps and services on this
  device"). **Chrome 147** extended this to WebSockets. Loopback is still not mixed content, so it
  works once granted. A denial is per-origin and sticky. Current stable is 156.
- **Regression found in passing (separate issue):** `WalletClient('auto')` probes 3301/3321/2121
  on every first visit. Chromium raises the prompt when the request is constructed, whether or not
  anything is listening. The 1000 ms deadline cannot outlive the prompt. This affects BSV Desktop
  users on any public https dApp today.
- MWA pattern: a gesture-launched intent opens a dialog-themed wallet Activity over Chrome. Chrome
  stays visible behind it, paused. The Activity hosts a session-scoped loopback server, so no
  foreground service and no SYSTEM_ALERT_WINDOW are needed. Solana had to add a
  permission-query → explainer → second-click flow because the LNA prompt must resolve before the
  intent fires.
- Background approvals: Android 10+ blocks activity starts from the background, so a wallet that is
  not in front needs a notification tap. A bottom sheet over Chrome is the realistic ceiling for an
  "in-browser" look.
- **Origin is unattested.** Chrome shares no launcher identity. `getReferrer` and `EXTRA_REFERRER`
  are spoofable. Apps cannot look up a peer's UID. Any native app can forge `Origin` on loopback.
  Toolbox grants (spending authorizations, auto-approve) are keyed by originator, so a rogue app
  could inherit a site's grants. Android sessions must be treated as unattested: no persisted
  auto-approve, a per-launch secret in a package-targeted intent. MWA's own attestation flow is
  unimplemented, even in its reference wallet.
- Multi-wallet: a shared custom scheme gives the OS chooser (and "Always" locks the user in). Use
  package-targeted `intent:` URIs or per-wallet verified App Links (MWA's `associationURLBase`
  precedent).
- Fixed ports (3321/3301/2121) do not suit multiple wallets. BRC-185 §4.1 ascending ports with
  signed discovery does.
- Brave Android has its own localhost gate (default deny). Firefox Android add-ons cannot use
  `nativeMessaging`. Samsung Internet is unverified.

## Page side / SDK findings

- An extension injecting a `window.CWI`-compatible object from a MAIN-world script already works with
  existing dApps (SDK ≥ 2.x). It must use accessor-style properties (a frozen object breaks the
  SDK's Proxy), all 28 methods, and a local `getVersion` within 1 s returning 7–30 bytes. Two
  extensions racing for `window.CWI` means first writer wins, with no user choice. BRC-185 forbids
  that for new providers.
- XDM is not an extension channel: at top level any page script can forge the reply.
- Version skew: the hook would land in `@bsv/sdk` 4.x, while the toolbox and apps pin `^2.8.11`. The
  controller package must also work by handing apps an explicit `WalletInterface`
  (`new WalletClient(connection.wallet, originator)`).
- ts-stack rule: AGENTS.md requires a BotBoard Discussion and Lockfile before an agent edits the repo
  (maintainer work). The GitHub MCP is down in this session; `gh` works.
- Approval UI must never render in page DOM, where it can be overlaid or spoofed. Only the wallet
  picker and status may live in the page.

## Toolbox / app integration findings

- External calls already get the right protection by building
  `new WalletClient(capWalletArgs(guardVaultAccess(pm, ADMIN_ORIGINATOR)), originator)` per call.
  PermissionSheet and usePermissionQueue need no changes. BTMS and Mandala prompts resolve outside
  the permissions manager, which matters for any serialised prompt.
- **Scheme collision:** bitcoin-sv-wallet and bsv-browser both register `bsv-wallet` and
  `bsv-browser`. On iOS the target app is undefined; Android shows a chooser. Bridge handoff needs a
  unique scheme or link per wallet.
- **App Group ban:** bitcoin-sv-wallet `__tests__/isolation.test.js` allows only `aps-environment`
  and `associated-domains`. Its stated reason: sharing entitlements "would expose wallet storage to
  other apps". Option A needs an App Group shared only with the app's own appex, holding only the
  request queue. **This is an owner decision.**
- Origin formats differ: `parseExternalOrigin` gives https-only host[:port]; bsv-browser's
  `walletFrameIdentityFromUrl` gives hostname and allows http. BRC-185 says the originator is the
  ASCII hostname, with the full origin used for connection memory. Pick one canonical form shared
  with the relay.
- Packaging: no sibling package ships a config plugin yet. The root bsv-wallet app and bsv-browser
  commit `ios/`; bitcoin-sv-wallet and point-of-sale are CNG. Recommendation: TS processor in the
  toolbox, native parts (Safari target, Swift handler, Android sheet Activity + loopback server) in
  a new sibling package such as `packages/react-native-browser-bridge`.

## Origin attestation by transport

| Transport | Who vouches for the origin | Consequence |
| --- | --- | --- |
| iOS Safari extension | Safari (`sender.url` / `sender.origin` in the background; normalise; 26.0 lowercased it, fixed in 26.2) | Can use normal grants, provided the App Group queue is only writable by our appex and the handoff URL carries only an opaque id. |
| Android loopback (MWA-style or BRC-185 §4.1) | `Origin` header, forgeable by any native app | Unattested: no persisted auto-approve, ask for every spend, show "unverified". |
| BRC-185 relay pairing | Claimed in the offer, bound by the Noise prologue | User compares an 8-digit code on both surfaces. Show as a claim. |
| Custom-scheme deep link with payload | Nobody | Never carry the request or origin in the URL. |

## Projects (independent, in suggested order)

1. **Toolbox bridge processor (TS only).** Transport-agnostic, with all 28 methods, BRC-185
   epoch/descriptor handling, provenance-aware grant policy (attested vs unattested), guard + cap
   per call, envelope/error mapping ported from bsv-browser, and logout/profile-switch teardown.
   Testable in jest with no device.
2. **iOS Safari extension kit.** Extension JS (MAIN-world BRC-185 provider, content relay,
   background, popup), Swift handler, App Group queue, Expo config plugin, app-side queue reader,
   handoff and return. Gated on device spikes.
3. **ts-stack page side.** The `@bsv/sdk` BRC-185 hook, plus a controller/chooser package with
   adapters: extension announce, legacy `window.CWI`, BRC-325-gated loopback, and later mobile
   pairing. Requires BotBoard.
4. **Android.** A loopback session server + sheet Activity (BRC-185 §4.1 shape or MWA-style
   association), or the BRC-185 §8 relay. The relay is a bigger cross-repo project (Noise, relay
   server, security review).

## Device spikes needed before the iOS spec

1. From the popup, a tap on `<a href="<scheme>://…">`: does it launch the app on iOS 18.6 and 26/27,
   what prompt appears, and does "◀ Safari" return to the same tab?
2. Does `action.openPopup()` work from the background without a gesture? How is the sheet
   presented, and what happens when the background is unloaded?
3. Is `world: "MAIN"` `document_start` injection on time after site permission is granted? Does it
   work under a strict-CSP page?
4. Native-message round trip, payload sizes (1 KB / 100 KB / 1 MB), App Group file latency, and
   behaviour when the background unloads mid-request.
5. `@bacons/apple-targets` `safari` target under CNG + EAS build with an App Group.
6. Optional: a local notification posted by the appex, and whether tapping it opens the app.

Android equivalents (Pixel, Chrome 156): the prompt with nothing listening, `getReferrer` and extras
from Chrome, WebSocket/fetch survival with the sheet up for 2/5/10 min, and LNA persistence.

## Key sources

- Apple: Messaging between app and JS in a Safari web extension; App Extension Programming Guide
  (no direct communication; `open` is Today/iMessage only); forum threads 684693, 776365, 835330.
- WebKit `WebExtensionAPIRuntime.idl`, `WebExtensionContextAPIRuntimeCocoa.mm` (native messaging,
  gesture propagation).
- Chrome release notes 142 (LNA) and 147 (LNA for WebSockets); Chromium `url_loader.cc`, `websocket.cc`.
- Solana: SolanaSafariWalletExtension (Swift handler signs with a shared key); MWA spec
  (association, security considerations); wallet-standard-mobile PRs #1375 and #1737 (LNA flow).
- BRC-185, BRC-325, BRC-219, BRC-6, BRC-100 (`bsv-blockchain/BRCs`).
