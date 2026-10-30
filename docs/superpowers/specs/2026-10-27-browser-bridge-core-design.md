# Browser wallet bridge — core (project 1 of 4)

Date: 2026-10-27. Status: design, revision 5. Revision 2 followed a builder check and three
adversarial reviews. Revision 3 added manifest checks for unverified origins (two source-checked
reviews). Revision 4 remembered unverified approvals like Safari's (one review). Revision 5 folds in
the agent review on issue #54 (GPT-6 and Grok 4.7) and the owner's answers to it: a reconnect token
with a clean slate, a separate unverified permissions manager configured by a permission policy
object, probes that never prompt, a wallet revision, sealed queue data, and five design defects
fixed.
Feasibility study: `docs/superpowers/research/2026-10-27-browser-wallet-bridge-feasibility.md`.
Governing standards: BRC-185 (wallet discovery, selection, connections), BRC-219 (prompt
liveness), BRC-100, BRC-5 (HTTP JSON).

## 1. Intent

Web pages in Safari and Chrome on the user's phone should be able to use the BSV wallet app as
their BRC-100 wallet, and pick which installed wallet a site uses (BRC-185). The work is four
projects:

1. **Core (this document).** A transport-agnostic, wallet-side engine in `@bsv/expo-wallet-toolbox`.
   It takes a request ("this origin, on this binding, wants method M with arguments A") and either
   makes a safe call on the wallet or refuses with a typed reason, producing an encodable outcome.
2. iOS Safari extension kit: an extension that announces the wallet to pages, stages requests in an
   App Group queue, then hands the user off to the app.
3. ts-stack page side: the BRC-185 hook in `@bsv/sdk` plus a controller/chooser package.
4. Android: a BRC-185 §4.1 loopback server with a bottom sheet over Chrome.

Projects 2 and 4 are thin transports over this core. Building the core first means both transports,
and later the in-app WebView browser (bsv-browser), dispatch the same way. They share one origin
rule, one site-consent model, one permission policy, one error codec and full method coverage.
Today each surface does this differently. The relay allowlists 16 of 28 methods and flattens errors
to 4001/500. bsv-browser has an untested 28-case switch, drops structured errors, and imposes a
60-second timeout.

## 2. Decisions made by the product owner (2026-10-27)

- **iOS.** The Safari extension detects the wallet, attests the origin and stages requests. The
  user approves **in the wallet app** (handoff). There is no second wallet inside the extension.
- **App Group.** Allowed, shared only between each wallet app and its own Safari extension, for the
  request queue only. It holds no keys and no wallet database. (The change to bitcoin-sv-wallet's
  `isolation.test.js` belongs to project 2.)
- **Android.** Uses the BRC-185 §4.1 loopback profile.
- **Build order.** Core, then the iOS kit, then the ts-stack page side, with Android after.
- **Site consent.** A site must be connected once in the wallet ("Connect example.com?") before
  any of its requests run. The approval is remembered per site until the user revokes it. Requests
  queued by a site that is not connected are not processed.
- **Auto-approve.** Connected sites follow the user's existing auto-approve threshold for small
  spends, exactly as sites do in the in-app browser.
- **Manifests for unverified origins.** Once the user approves a domain, the wallet checks that
  domain's `manifest.json` even when it cannot prove which website is asking (Android). The rules
  that make this safe are in 6.5.
- **Unverified approvals are remembered like Safari's, behind a reconnect token** (revised after
  the review on #54). An Android approval is remembered per site, and the permissions granted to
  such a site last as Safari's do. But a silent reconnect needs a secret the wallet gave the
  approved page, kept in that site's own browser storage. Without it the user sees the connect
  sheet again, and approving it starts from a clean slate: the site's earlier unverified
  permissions no longer apply (6.4, 6.5).
- **Permission prompts come from a setup object.** The permissions managers take their `seek*`
  settings from a policy object with a verified set and an unverified set. For now only defaults
  ship: the verified set is today's configuration, and the unverified set also asks before basket
  listing, insertion and removal. A user who wants granular control can turn on a prompt for every
  request (6.5).
- **Other browsers: not now.** This plan has no transport for iOS Chrome, Firefox, Edge or in-app
  browsers.
- **Device spike:** the iOS handoff-link spike runs alongside project 1 (12).

## 3. Goals

G1. **All 28 BRC-100 methods.** No allowlist subset and no stubs (BRC-185 §1). Each call gets SDK
argument validation before it runs and SDK result validation after, with byte fields normalised
by the SDK's helpers.

G2. **One origin rule.** Turn a transport-attested web origin into two values: the full
application origin, kept for bindings, consent and memory, and the BRC-100 originator, which is the
ASCII hostname with no scheme or port. Refuse anything that could become admin or reserved, and
refuse anything the permissions manager would reject.

G3. **Site consent.** Before any method runs, the wallet asks once per site and remembers the
answer (2). Unattested origins (6.3) are remembered the same way, in a separate record: approving
one never connects the other. A remembered unattested site reconnects silently only with its
reconnect token (6.4).

G4. **Unattested origins never share authority with the verified site, never reconnect silently
without the site's own secret, and never spend wallet funds silently.** An unattested origin is
one asserted by a channel that can be forged, such as an Android loopback `Origin` header. These
calls run through their own permissions manager, under their own permission namespace, where:
- grants are ordinary permission tokens lasting like Safari's (2), under an originator that changes
  with every new approval. So they never satisfy the verified hostname, the verified hostname's
  never satisfy them, and a fresh approval never inherits an earlier one. Ask-every-time signing
  (BRC-29) is still asked every time;
- prompts follow the unverified half of the permission policy, which can only be stricter than the
  verified half;
- spending is never auto-approved, no spending allowance is ever granted, and a manifest's
  spending allowance is ignored;
- the site's manifest is read from the real domain over HTTPS, and only after the user has
  connected the site;
- the BTMS and Mandala token modules are refused.

G5. **BRC-185 protocol primitives as pure TypeScript.** This covers:
- a strict JSON parser and JCS (RFC 8785);
- canonical base64url;
- descriptor validation;
- describe and connect proofs, signed and verified with strict Ed25519;
- `ConnectionError`;
- a `ContinuityStore` interface.

The module must bundle into a Safari extension, so it has no React Native, Expo or toolbox-context
imports.

G6. **Bindings.**
- Every request is validated against a binding: epoch, provider identity, origin and account
  context.
- Bindings close with BRC-185's reasons (`account-changed`, `revoked`, `lost`).
- A closed epoch never revives. Closes reach transports in process, and reach the extension
  through an events outbox.

G7. **Durable inbox** for transports where the app is not running when the page asks (iOS):
- each request is dispatched at most once;
- a request never shown to the user expires as `not-sent`;
- once the app has accepted a request, it has no deadline (BRC-219);
- a crash after claim is reported as `unknown`;
- results survive an app restart.

Storage is injected. A contract test suite applies to every storage adapter.

G8. **One error codec** for wallet errors and BRC-185 `ConnectionError`s, with a fixed table of
codes and delivery certainty for every failure the core can produce.

G9. **Host wiring.**
- The host opts in by mounting a provider.
- The core reads the live wallet lazily, waits for readiness and re-checks the account context
  synchronously right before every call.
- It tears down on any wallet replacement: logout, profile switch, network switch, and wallet
  rebuild or import, including a rebuild of the same wallet.
- When it tears down, it withdraws the departed wallet's pending prompts.
- It asks transports for user attention whenever a request is waiting on the user (BRC-219).

G10. **Probes never prompt (BRC-219).** `getVersion` and `isAuthenticated` are answered without
consent and without waiting for the wallet, and a request with `seekPermission: false` from a site
that is not connected is refused without a sheet.

## 4. Non-goals (this project)

- No native code, no extension JavaScript, no App Group adapter, no loopback server and no
  deep-link route. These belong to projects 2 and 4. P1 adds only the **site connection sheet**
  (6.4), because both transports need it. The "Browser connections" management screen is part of
  project 2.
- The relay (`WalletConnectionContext`, `IMPLEMENTED_METHODS`, pairing wire) does not change. The
  only exception: its logout/profile-switch hook moves onto the shared teardown registry with the
  same behaviour. The relay staying alive across a network switch or rebuild is existing behaviour
  and is proposed as a separate follow-up.
- No `@bsv/sdk` change and no page-side code (project 3).
- No BRC-185 §8 relay or Noise profile, and no desktop transport.
- No approval UI rendered in a browser. All approvals stay in the app's PermissionSheet.
- No SecureStore implementation of `ContinuityStore`. Only the interface ships, plus the pure
  sign/verify functions. The iOS extension holds its own continuity key (project 2). Android
  supplies an implementation in project 4.
- No support for non-web "asserted" contexts (`Originator`/`BRC-185-Context` headers without a
  browser origin). These are refused with a typed error and recorded as a conformance limitation.
- No legacy epoch-less routes (`POST /<methodName>`). Project 4 decides. The core leaves room for
  a "legacy" binding kind, which would always be unattested.
- No transport for browsers that have neither an extension nor loopback (iOS Chrome, Firefox,
  Edge, in-app browsers): owner decision, not now.
- No settings screen for the permission policy. P1 ships the policy object, its defaults and a
  core API; the screen comes later (12).
- P1 does not ship a release on its own. It merges to master and ships in the release that carries
  project 2's transport.

## 5. Anti-goals: if any of these happen, the project failed

- An originator supplied by a page, header or request body reaches the wallet unchecked, or any
  path gives a caller `ADMIN_ORIGINATOR` behaviour.
- A site's requests run before the user has connected that site.
- A forged origin reuses a grant that the real site earned through an attested channel, or leaves
  behind a grant that the real site later inherits.
- A remembered unverified site reconnects without its reconnect token, or a fresh unverified
  approval inherits an earlier approval's permissions.
- `getVersion`, `isAuthenticated` or a `seekPermission: false` request raises a prompt.
- An unverified origin spends wallet funds (a createAction with net spend above zero) without a
  prompt, or holds any spending allowance.
- An unverified origin reuses one approval for more than one ask-every-time signature.
- A call moves to another account's wallet: it is checked under one profile or network and runs
  under another.
- The core or a client puts a deadline on a call that has been accepted and may be waiting for the
  user. (Pre-existing exceptions are listed in 9.)
- A request whose dispatch may already have happened is re-dispatched (no replay after a crash or
  retry), or a request that may have taken effect is reported as a clean failure.
- Behaviour changes for existing attested callers in the in-app, relay and WebView paths: their
  prompts, auto-approve and grants. The verified permission policy defaults to today's
  configuration exactly. The deliberate exceptions are the teardown fix in 6.9, which withdraws
  prompts belonging to a wallet that no longer exists, and the sheet answering each queue item by
  identity on the manager that raised it (6.9), which is behaviour-preserving.
- Key material or permission tokens leave the app process through the core.

## 6. Design

### 6.1 Module layout (builder may refine names)

```
core/bridge/
  protocol/        pure TS (no RN/Expo/context/toolbox-mobile imports); bundle-safe for Safari
    methods.ts         28 names, readiness class, mutating flag; test vs SDK WalletInterface keys
    origin.ts          canonicalizeBridgeOrigin, assertCanonicalOriginator, unverified namespace
    json.ts            strict JSON parse (duplicate keys, lone surrogates, non-finite) + JCS
    base64url.ts       canonical-only codec
    descriptor.ts      descriptor validator, describe/connect proofs (strict Ed25519)
    continuity.ts      ContinuityStore interface
    connectionError.ts BRC-185 §6 type, codes, delivery, cause; outcome table (6.11)
    errorCodec.ts      thrown value -> wire error; wire error -> Error (page/extension side)
    envelopes.ts       inbox records, results, events; brc185:* envelope shapes
    limits.ts
  consent.ts       connected-sites store (per profile, HMAC-authenticated), reconnect tokens,
                   grant tags, approval queue
  bindings.ts      binding registry, tombstones, admission horizon, wallet revision, close fan-out
  policy.ts        attestation -> originator; site-consent gate; probe rules; unattested rules
  permissionPolicy.ts  verified/unverified seek flags, defaults, effective unverified set,
                   persistence
  unverifiedManager.ts  builds the unverified permissions manager (wrapper stack, module stubs,
                   manifest override)
  dispatcher.ts    the pipeline in 6.6
  inbox.ts         durable queue processor over an injected InboxStore
  runtime.ts       module-level runtime: transports register here; wallet getter; readiness; attention
  BrowserBridgeProvider.tsx  host-mounted adapter: wires runtime to WalletContext
  index.ts
```

`protocol/` may import pure `@bsv/sdk` subpaths (byte helpers, validators) and
`@noble/curves/ed25519.js`. If it imports `@noble/hashes` directly, add that package to the
peerDependencies. `dispatcher.ts` may import toolbox modules such as `TaskBackupPush`. `protocol/`
must not.

### 6.2 Transports and attestation

A transport registers once with the runtime:

```
registerTransport({ id, attestation: 'browser' | 'unattested', bindingMode: 'implicit' | 'explicit',
  requestAttention(reason, binding), onClosed?(event),
  deliverReconnectToken?(binding, token) }) -> handle
```

- `attestation` is a property of the registered transport, fixed at registration. It never comes
  from a call, a record or stored data. Requests that claim a different attestation than their
  transport are refused (`PROTOCOL_ERROR`, `not-sent`).
- `browser` means the browser itself vouched for the origin: the Safari extension's sender frame
  origin, or a native WebView frame origin. `unattested` means anything a local process could forge.
- `attestation: 'unattested'` with `bindingMode: 'implicit'` is refused at registration
  (`CONFIGURATION_ERROR`). The unattested policy, including the per-connection launch proof
  (6.4), is defined for the loopback transport only, which binds explicitly (9). A future legacy
  kind must be specified before it may be unattested.
- `deliverReconnectToken` is mandatory for an `unattested` transport and absent otherwise. The core
  calls it once when the user approves the site on that binding (6.4). Project 4 decides how the
  token reaches the page; the page stores it in its own origin's storage (project 3).
- `requestAttention` is mandatory (BRC-219). The core calls it when a request is parked:
  - waiting for site consent;
  - waiting for the wallet to be ready;
  - waiting on a permission prompt while the app is not in the foreground.

  The transport decides how to get the user's attention: project 2 uses a local notification,
  project 4 brings the sheet forward.

### 6.3 Origin → originator (`canonicalizeBridgeOrigin`)

Input: `{ origin: string, attestation }`, where `attestation` is taken from the transport.

1. **Strict ASCII grammar first.** Do not trust `URL` serialisation: the code runs on Node in jest,
   on WebKit in the extension, and on Hermes with Expo's `whatwg-url-minimum` in the app.
   - The scheme is literally `https://`.
   - The host is lowercase LDH labels, 1–63 characters each, at most 253 characters, with no
     trailing dot and no IP literal. Non-ASCII hosts are refused: callers must pass punycode.
   - The optional port is 1–65535 with no leading zero, and the default port 443 is refused as
     non-canonical.
   - Nothing else is allowed.
   - `URL` is used only as a cross-check, and any disagreement refuses the origin.
2. **Development exception.** `http://localhost:<port>` only, and only when the host has set
   `configureToolbox({ browserBridge: { allowLocalhostHttp: true } })`, which the host should gate
   on `__DEV__`. No other loopback form is accepted, because the permissions manager refuses IP
   originators.
3. **Refusals.** The `invalid` TLD; any host whose normalised form equals `ADMIN_ORIGINATOR` or
   `LEGACY_ADMIN_ORIGINATOR`; anything `Validation.validateOriginator` rejects. Origins are at most
   2048 bytes.
4. **Output.** `{ applicationOrigin, hostname, originator, attestation }`.
   - For `browser`, `originator = hostname`.
   - For `unattested`, `originator = <hostname>.<grantTag>.unverified.invalid`, where `grantTag` is
     `g` followed by 10 lowercase base32 characters, minted at each new approval and kept on the
     site's consent record (6.4). The originator is therefore completed when consent resolves;
     before that, no wallet call runs. Refuse hostnames that would make it exceed 250 bytes (over
     219 bytes).
5. **Final check.** `assertCanonicalOriginator(originator)` runs again immediately before every
   wallet call. It requires a hostname shape, no `:` or `@`, not admin after normalisation, and
   `.invalid` only in the exact `<grantTag>.unverified.invalid` form.

If a transport carries an originator frame or header, it must equal the derived originator.
Otherwise the request is refused with `PROTOCOL_ERROR`, `not-sent`; the core never silently
ignores a mismatch.

The hostname-only originator follows BRC-185 §1. One consequence, recorded deliberately: different
ports of one host share one permission identity. Consent and bindings still use the full origin.

The existing `parseExternalOrigin` (https only, `host:port`) is unchanged for the relay.

### 6.4 Site consent (`consent.ts`)

- **Gate.** Before dispatching an interactive method (6.6), the core checks the connected-sites
  store. If the binding's site is not connected under the current profile **with the binding's
  attestation** (for an unattested binding: with a valid reconnect token, below), the request parks
  and the core enqueues one consent request per origin and attestation into a new PermissionSheet
  kind, `connection`.
  - **Probes never reach the gate** (BRC-219, G10). `getVersion` and `isAuthenticated` are answered
    without it (6.6). A request with `seekPermission: false` from a site that is not connected is
    refused with a permission-denied wallet error, `not-sent`, and no sheet.
  - The sheet is raised by the first interactive request, which for a BRC-185 page follows its
    deliberate `connect`.
- **What the sheet shows**, in this order:
  - the title: the raw origin, in a monospaced face, with "Verified by Safari" or an "Unverified"
    badge, and the transport;
  - what connecting allows, written by the wallet, never by the site. It is derived from the
    effective permission policy for that attestation (6.5): each `seek*` flag that is off maps to a
    phrase of what the site can do without asking, and each flag that is on maps to an "asks first"
    clause. With today's defaults the verified text reads: "see your identity key and the public
    keys it derives, encrypt and decrypt data, make and check HMACs, sign in to the site, read your
    transaction history and outputs, read your certificates, obtain new ones, show their fields to
    other parties and delete them, reveal key links to a verifier, look up identities, keep or
    remove outputs in app baskets, and ask you to approve payments. Other signing is asked first."
    The unverified default moves basket changes into the "asks first" part. ("Sign in" is the
    prompt-free BRC-103/104 auth signature, which is why the last clause says "other".) A test maps
    every flag to its phrase and fails when a flag is added without one.
  - payments: for a verified site, "Payments under your auto-approve limit go through
    automatically"; for an unverified site, "Payments from your balance will ask you first";
  - anything the site says about itself (a manifest name, icon or description, when one is shown)
    in a clearly quoted "This website says" block, after the wallet's own text. A forging app can
    make this text appear on demand, so it is never the title;
  - for a verified site: "The wallet remembers this site, and what you allow it." For an unverified
    site: "The wallet remembers this site in this browser. If the browser forgets it, you'll be
    asked again and earlier permissions won't carry over." When the unverified origin was approved
    before on this device but the request carries no valid reconnect token, the sheet adds: "This
    site was connected before. Approving starts fresh."
- **Answers:**
  - **Approve:** records the site and releases its parked requests in order.
  - **Decline:** answers every parked request from that origin with `USER_CANCELLED`, `not-sent`,
    and records nothing. An existing record (for a token-less re-approval) is left as it was, so
    the real page's token keeps working.
- **Remembered per profile until revoked**, for both attestations. Records are
  `{ applicationOrigin, originator, attestation, transport, approvedAt, grantTag?, reconnectHash?,
  tag }`, keyed by `applicationOrigin` and `attestation`. A verified approval of `example.com` never
  connects an unverified `example.com`, and the reverse. `tag` is an HMAC over the whole record,
  computed with the admin-scoped wallet under a new reserved guard namespace (`bridge site
  authority`). This follows the XR-027 / `connectionAuthority.ts` pattern. A record whose tag fails
  verification is treated as not connected. The store key is swept at logout and Delete Wallet,
  including profile 0's bare key.
- **Reconnect token (unattested only).** A forging local app can claim any origin and pass the
  launch proof (9), so a remembered unverified site must prove it is the browser context the user
  approved.
  - On Approve, the core mints a 32-byte random token, stores only `reconnectHash` (SHA-256) on the
    record, and hands the token to the transport once, through `deliverReconnectToken` (6.2). It is
    never logged, never put in a URL, and compared in constant time.
  - The page keeps the token in its own origin's storage, keyed by the wallet's continuity key, and
    presents it at `connect` (6.7). A forging app has no access to `https://example.com`'s storage
    inside the browser. The page must verify the wallet's continuity key (the BRC-185 connect
    proof) **before** sending the token, or a local app squatting a loopback port could harvest it
    (project 3 and 4 contract).
  - A binding whose token matches the record is connected silently. A binding with no token, or a
    wrong one, is treated as not connected: its first interactive request raises the sheet.
  - The token is stable for the life of the approval. A new approval mints a new token and replaces
    the hash, so any older token stops working.
- **Clean slate (unattested only).** Every new approval, whether first, after a site removal, or
  token-less, mints a fresh `grantTag`, so the site's originator changes (6.3). Permission tokens
  minted under the previous originator never match it again, so a user fooled into approving a
  forging app's sheet gives it an empty grant set, not the real site's. No on-chain action is
  needed for this. Revoking the previous originator's tokens on-chain is a best-effort cleanup
  afterwards (`revokeAllForOriginator`); safety never depends on it. Earlier unbasketed outputs and
  held `sendWith` transactions of the previous originator also become unreachable (6.5 Known
  coupling).
- **Unattested connections also need a launch proof every time.** The transport verifies project
  4's per-launch secret itself and passes `launchProofVerified` to `connect` (6.7); it is never
  read from the page's request bytes. An unattested connect without it is refused
  (`CONFIGURATION_ERROR`, `not-sent`): no binding is created, no limit slot is taken and no sheet
  is shown. The proof ties a connection to a launch of this wallet's own Activity in front of the
  user. It does not authenticate the website: any installed app can launch that Activity with a
  secret it chose (9).
- **One sheet slot per transport, and a decline backoff.** Each transport holds at most one
  `connection` request at a time, showing or waiting. A request that would raise a sheet while its
  transport's slot is held by a different request gets `RESOURCE_LIMIT`, `not-sent`, and no sheet.
  After a Decline, the same origin and attestation gets no new sheet for 30 seconds; a request in
  that window gets `RESOURCE_LIMIT`, `not-sent`. A connected site never takes the slot, is never
  blocked by it and never counts toward the backoff, but it still counts toward the binding and
  in-flight limits (6.6, 6.7). An unanswered sheet keeps the slot, with no deadline (BRC-219), until
  it is answered or every binding behind it closes.
- **Consent request identity and lifetime.** A `connection` request is core-owned (`consent.ts`),
  not one of the five manager-backed permission queues (protocol, basket, certificate, spending,
  group) or the module-backed BTMS and Mandala queues, so none of the manager rules reach it on
  their own.
  - It has an opaque `requestId`, and captures the wallet revision and profile when enqueued (6.9),
    plus the bindings parked behind it. It is keyed by origin and attestation.
  - It is removed, and its sheet closed, on any wallet replacement or teardown, and as soon as
    every binding parked behind it has closed (6.7). Removal settles nothing extra: the close
    already settled the parked requests.
  - `answerConsent(requestId, approve)` does nothing if the id is no longer pending, or if the
    captured wallet revision or profile differs from the current one. Approve first awaits the tag
    from the admin-scoped wallet. Then, in one synchronous turn with no `await`, it re-checks the
    id, the wallet revision and the profile, and issues the store write. If the runtime leaves
    `ready` while the tag is computed, the re-check fails and nothing is written. A stale Approve
    never writes to the connected-sites store.
  - The sheet's 400 ms confirm window follows the identity rule in 6.9: it passes the snapshot's
    `requestId` and drops the answer if the request is gone.
- **Tap protection.** The sheet's approve button is inactive for 700 ms whenever a `connection` or
  unverified prompt becomes the head of the queue. Other prompt kinds behave as today.
- **Management.** `listConnectedSites()` (each entry carries its attestation) and
  `revokeSite(origin, attestation)` are core APIs. Revoking closes that origin's live bindings of
  that attestation with `revoked` and deletes the record. For an unverified site, the next approval
  starts fresh (clean slate). For a verified site, permission tokens stay in place, as for in-app
  sites; a "Remove connection and permissions" action is a project 2 decision (12). The screen
  comes in project 2.

### 6.5 Unattested policy

The only per-call datum that reaches token tags, cache keys, P-module caches, action labels,
callbacks and the sheet is the originator string. Unattested calls therefore get their own
originator namespace, and their own permissions manager so that their prompt settings can differ.

- **Permission policy (owner decision, 2).** The manager's `seek*` settings become a setup object:
  `PermissionPolicy = { verified: SeekFlags, unverified: SeekFlags }`, where `SeekFlags` holds
  exactly the `seek*` keys the manager takes today.
  - **Defaults.** `verified` is today's `WalletContext.tsx` literal, moved unchanged into an
    exported constant, so attested behaviour does not change. `unverified` is the same with
    `seekBasketInsertionPermissions`, `seekBasketListingPermissions` and
    `seekBasketRemovalPermissions` turned on.
  - **Effective unverified set** = `verified[f] || unverified[f]` for every flag `f`, so the
    unverified set can only be stricter. `seekSpendingPermissions`,
    `seekProtocolPermissionsForSigning` and `seekGroupedPermission` are forced on for it, and
    `differentiatePrivilegedOperations` stays on for both.
  - **Who sets it.** The host can supply defaults through `configureToolbox({ permissionPolicy })`.
    The user's own choice is stored per profile, HMAC-tagged like consent records, through a core
    API (`getPermissionPolicy`, `setPermissionPolicy`). Turning every flag on gives a prompt for
    every request. A change applies from the next wallet build; the settings screen that offers
    "apply now" comes later (12).
- **Two managers.** The wallet build creates the attested `SigningPolicyPermissionsManager` from
  `policy.verified`, exactly as today, and a second one from the effective unverified set, whenever
  a transport with `attestation: 'unattested'` is registered. The dispatcher routes by
  `binding.attestation` (6.6). Each manager is plain configuration of the same class:
  - the unverified manager gets the same wrapper stack as the attested one:
    `conformWalletResults`, `wrapCreateActionForTokenInputs`, `wrapAbortActionForSettlements` and
    `guardVaultAccess` with the `phoneStorage` lookup. Without
    `wrapCreateActionForTokenInputs`, a createAction naming Mandala token outpoints as inputs would
    never reach the token-module refusal below;
  - both share the same prompt callbacks and queues; each queue item records the manager that
    raised it, and the sheet answers that manager (6.9);
  - they are built, replaced, retired and withdrawn together (6.9);
  - the attested manager gets no unattested patches at all. Revision 4's manifest and token-module
    patches on it are gone, and so is its shared manifest cache with the namespace: each manager
    keeps its own.
- **Namespace.** `<hostname>.<grantTag>.unverified.invalid` (6.3). External input can never produce
  it, because every boundary refuses `.invalid`. Permission tokens, permission caches, action
  labels and spend accounting are therefore disjoint from the real hostname's, and from every
  earlier approval of the same site. Basket contents are not (see Known coupling).
  `isUnattestedOriginator` matches exactly this form; it is one shared predicate, exported from a
  dependency-free core module, and used by the manifest override, `autoApprovePolicy`, the
  dispatcher's pre-scan and the sheet.
- **Grants last like Safari's (owner decision, 2).** On the unverified manager an approval mints
  the normal on-chain permission token under the namespace originator. A grouped approval from the
  manifest mints its tokens the same way, so a site that reconnects with its token is not asked
  again. The sheet mints every token with expiry 0 (`PermissionSheet.tsx` passes none; the manager
  stores `params.expiry || 0` and treats 0 as never), so in practice a grant lasts until the clean
  slate (6.4) moves the site to a new originator. This wallet has no screen that revokes permission
  tokens today, as for in-app sites (12).
- **Ask-every-time** (`ASK_EVERY_TIME_PROTOCOLS`, BRC-29 today) needs nothing new. The existing
  patches in `SigningPolicyPermissionsManager` key on the protocol, not the originator, so every
  BRC-29 signature from the namespace prompts, exactly as for a verified site.
- **Spending always asks.** "Spend" means the manager's net spend: requested outputs plus fee minus
  the value of inputs the caller names. The manager prompts only when it is above zero. A forging
  local app must not be able to spend wallet funds silently, so the namespace never holds spending
  authority:
  - `autoApprovePolicy.shouldAutoApprove` returns `{ approve: false, reason: 'unattested' }` for
    the namespace, and `record()` ignores it. This is done in the pure, already-tested module; the
    spending callback needs no namespace branch for it, because a refused decision already falls
    through to the queue. The callback's separate stale-request guard is in 6.9;
  - the manifest's `spendingAuthorization` is removed (Manifest, below), so a grouped approval
    cannot create a monthly allowance;
  - the sheet already grants single spends with `ephemeral: true`, so no spending token is ever
    minted for the namespace.
- **Manifest** (unverified manager only). The manager builds the manifest URL from the originator
  (`https://${originator}/manifest.json`), which for the namespace would fetch a `.invalid` host,
  fail, and cache nulls. So the unverified manager's `fetchManifestPermissions` strips the
  `.<grantTag>.unverified.invalid` suffix and delegates to the original method with the real
  hostname. Its cache is its own, so nothing it caches, failures included, reaches the attested
  manager.
  - **Fetch limits kept:** HTTPS only, the fixed path `/manifest.json` on port 443, IP-literal hosts
    refused, redirects refused, 256 KiB cap, 10-second timeout.
  - **Not kept on the device:** the SDK's check that DNS answers are public addresses runs only
    where `process.getBuiltinModule` exists (Node, so jest). On Hermes it does not run, so a
    hostname that resolves to a private address is fetched. The fetch is still bounded by TLS (a
    valid certificate for the claimed name), the fixed URL, and a body that is only JSON-parsed and
    never returned to the page. Every connected origin already has the same primitive through
    `acquireCertificate`'s certifier URL (9).
  - **Hosts never read:** `localhost`, a single-label host, an all-numeric last label, or a name
    ending in `.localhost`, `.local`, `.internal`, `.lan`, `.home.arpa`, `.test`, `.example` or
    `.onion` give nulls without a fetch. On a phone, `http://localhost` is served by whatever local
    process holds the port, so its manifest proves nothing; the other names are special-use and
    should never be fetched on an attacker's say-so. This lives in the override, not in 6.3, so
    consent and bindings for such origins are unaffected.
  - **Filtering.** The result is filtered: the existing ask-every-time filter applies;
    `spendingAuthorization` is removed; protocol entries whose name (`protocolID[1]`) and basket
    entries whose `basket` start with `p ` and whose scheme (the second space-separated token, as
    the manager's `split(' ')[1]`) is `btms` or `mandala` are removed, because the stubs refuse
    them. The filter builds fresh `groupPermissions` and `counterpartyPermissions` objects by
    shallow copy, unconditionally, and never edits what the delegate returned.
  - **Only after consent.** The dispatcher parks every interactive request from a site that is not
    connected (6.4), and the manager reads the manifest only inside a wallet call.
  - **Counterparty pacts** stay inert: the wallet registers no `onCounterpartyPermissionRequested`
    handler, so `maybeRequestPact` returns before prompting.
- **Token modules.** The unverified manager's `permissionModules` give `btms` and `mandala` stub
  entries whose `onRequest` throws a permission-denied wallet error. The built-in `nosend` entry
  stays (call 12). Every route to a token module (a `p ` basket, a `p ` protocol name, a
  `p <scheme> …` label, and the `p mandala token-spend` label that `wrapCreateActionForTokenInputs`
  injects) runs `onRequest` first, so each is refused before anything happens.
  - Why refuse: these modules move tokens and keep their own 60-second approval sessions per
    originator. A forging app on a remembered domain could ride a session the real page just
    opened.
  - **Pre-scan for case and whitespace variants.** The manager routes on a raw, exact-case
    `startsWith('p ')`, while the wallet trims and lowercases those names. So for unattested
    bindings the dispatcher refuses, before the call (6.6), any basket, label or protocol name in
    the arguments whose trimmed, lowercased form starts with `p btms` or `p mandala` but whose raw
    form does not route there. Attested behaviour is unchanged (9).
- **Presentation.**
  - `ActivePermission` gains `unverified: boolean`. It is set once, where the originator is derived
    in `deriveActive` (seven assignment sites, including the grouped `group` kind), and the
    `.<grantTag>.unverified.invalid` suffix is stripped there. Every unverified prompt, the grouped
    sheet included, carries the badge and the 700 ms tap protection.
  - Each prompt's title is the raw origin in a monospaced face. Text from a manifest sits in the
    quoted "This website says" block, after the wallet's own description, as on the connection
    sheet (6.4). The line "This request came through a channel that can't prove which website sent
    it." accompanies the badge. All strings get i18n keys in all 12 locales (parity test).
  - PermissionSheet imports the helper by relative path, so the existing barrel mock in
    `PermissionSheet.test.tsx` keeps working.
  - Any host screen that lists permission tokens by originator (none in the toolbox today) uses the
    same helper to strip the suffix and show the badge.
- **Known coupling (recorded).** The vault guard treats an output as admin state when it has no
  basket and was created by a transaction labelled with another originator, and it refuses
  `sendWith` of another originator's transactions (`vaultGuardSql.ts`, `IS_ADMIN_OUTPUT` and
  `adminTransactionsSql`). So `example.com`, `example.com.<tag1>.unverified.invalid` and
  `example.com.<tag2>.unverified.invalid` cannot spend, relinquish or internalize each other's
  unbasketed outputs, and cannot `sendWith` each other's held transactions. A clean slate therefore
  also leaves the earlier approval's unbasketed outputs and held transactions behind. Outputs in
  ordinary baskets are **not** coupled. Basket listing, insertion and removal ask for unverified
  sites by default, but once granted, each namespace can list and spend another's basketed
  outputs, as any two connected sites can. A createAction that names such outputs as inputs and
  pays out no more than they carry minus the fee has a net spend of zero or less, so it raises no
  spending prompt. Covered by tests (8).

Attested (`browser`) calls use the plain hostname and the attested manager, unchanged apart from
the 6.9 changes (retired managers, queue answers by identity on the raising manager).

### 6.6 Dispatch pipeline

`dispatch({ transport, request })`, where
`request = { epoch, instanceId, continuityKey, origin, accountContext?, method, args, sizeBytes }`,
returns an `Outcome` (6.11). In order:

1. **Transport bounds**, applied by the transport before parsing and re-checked here:
   - a request is at most `MAX_BRIDGE_REQUEST_BYTES` = 5 MiB (the relay's measured limit);
   - arguments are JSON-shaped, so byte fields are `number[]` and typed arrays are refused at the
     boundary;
   - at most 4 calls in flight per binding and 16 in total;
   - at most 5 MiB of in-flight request bytes in total.

   Exceeding any of these gives `RESOURCE_LIMIT`, `not-sent`. A response over 5 MiB gives
   `RESOURCE_LIMIT`, `unknown`. BRC-185 §9's 64 MiB applies to its relay profile only. These lower
   limits are documented resource refusals (BRC-185 §1).
2. **Binding.** Call `bindings.resolve(transport, request)`, which checks epoch, `instanceId`,
   `continuityKey`, origin equality, the wallet revision and account context (6.7). If resolution
   fails, the request gets the reason from the table in 6.11.
3. **Method.** It must be an own property of the 28-entry table. Otherwise the result is
   `PROTOCOL_ERROR`, `not-sent`. (Legacy-envelope transports instead map an unknown method to wallet
   code 2.)
4. **Probes** (BRC-219, G10). Answered here, with no consent gate, no wallet call and no wait:
   - `getVersion`: the static base version string;
   - `isAuthenticated`: `{ authenticated: readiness === 'ready' }`. The SDK 2.8 client rejects
     `false` (project 3), but BRC-100 permits it.
5. **Arguments.** `args ?? {}`, then:
   - `normalizeBRC100WalletByteFields`;
   - `checkWalletArgs` size limits (also fix `capWalletArgs`'s `arrayBytes` to count
     `ArrayBuffer` views, and add `acquireCertificate` to the capped set);
   - `validateWalletArgs`;
   - for an unattested binding, the token-module pre-scan (6.5), which refuses with a
     permission-denied wallet error, `not-sent`;
   - `snapshotWalletResultRequest(method, args)`, **before** the call.

   Any validation failure gives wallet code 6 with `parameter`, `not-sent`. The wallet receives the
   byte-normalised original arguments. Validating before consent reveals nothing a site could not
   learn from the SDK's own validators.
6. **Wallet state, then consent.** The connected-sites store is authenticated with the
   admin-scoped wallet (6.4), which exists only when the runtime is `ready`. So:
   - `none` fails `CONFIGURATION_ERROR`, `not-sent`, at once;
   - `building` and `blocked` (biometric cancelled, key unavailable) park, with attention
     requested, until `ready`. A runtime that is not `ready` is never treated as "not connected"
     and never enqueues a `connection` request;
   - then the consent gate (6.4): a connected site continues; a site that is not connected gets a
     permission-denied wallet error, `not-sent`, when `args.seekPermission === false`, and
     otherwise parks behind the sheet.
7. **Readiness.** If the runtime left `ready` after step 6, the request parks again (`building`,
   `blocked`) with attention requested, or fails `CONFIGURATION_ERROR`, `not-sent` (`none`).
8. **Synchronous re-check.** After the last `await` (for an inbox record, after its claim, 6.8) and
   immediately before the call, with no `await` between them:
   - the binding is still live;
   - `binding.walletRevision === runtime.walletRevision` and
     `binding.accountContext === runtime.accountContext`;
   - the manager for the binding's attestation exists and was built for that revision;
   - `assertCanonicalOriginator` still passes.

   If any check fails, the request gets `PROVIDER_CHANGED`, `not-sent`, cause `account-changed`.
9. **Call.** Pick the manager by `binding.attestation`: the attested manager for `browser`, the
   unverified manager for `unattested` (6.5). Build the wallet with
   `capWalletArgs(<that manager's guarded wrapper stack>)` (read fresh, never cached across builds),
   then `await wallet[method](args, binding.originator)`. The originator always comes from the
   binding.
10. **After the call.**
   - For mutating methods (createAction, signAction, abortAction, internalizeAction,
     relinquishOutput, acquireCertificate, relinquishCertificate), call
     `TaskBackupPush.noteChanged()` on every outcome except a pre-dispatch refusal. That includes
     errors such as code 5, which are raised after the database has changed.
   - Validate the result with `validateWalletResult(method, result, snapshot)` and return the
     validated **copy**. `getVersion` uses a BRC-205-aware check instead: a 7–30-byte base, at most
     2048 ASCII bytes in total. P1 emits no attributes.
   - If the result fails validation: mutating methods get `PROTOCOL_ERROR`, delivery `unknown`,
     cause `invalid-result`, with the `txid` kept when present. Read-only methods get wallet code 1.
   - If the binding closed while the call was in flight and the call throws, the outcome is
     `CONNECTION_CLOSED`, `unknown`, not a wallet error.

The builder may build each call on `new WalletClient(guarded, originator)`, which already
validates arguments, snapshots and validates results for all 28 methods. Doing so must still meet
every rule above, including distinguishing a result-validation failure from a wallet error.

Parked requests count toward the in-flight limits. Within an epoch, requests are started in
arrival order without waiting for earlier ones to complete. Closing a binding never aborts pending
signable actions and never claims effects were undone. Only the page can call `abortAction` for
references it holds (BRC-185 §6).

### 6.7 Bindings (`bindings.ts`)

`Binding = { epoch, transportId, applicationOrigin, originator?, attestation, instanceId,
continuityKey, accountContext, walletRevision, boundAt, createdAt, state: 'live' | 'closed',
closeReason?, launchProofVerified?, consented }`. For an unattested binding, `originator` is set
when consent resolves (6.3), and `consented` is true once the reconnect token matched or the user
approved. `launchProofVerified: true` is present on every unattested binding and
absent on `browser` bindings. Consent lives in the connected-sites store, not on the binding (6.4).

- **Explicit mode** (Android, project 4).
  - `connect({ epoch, origin, challenge, instanceId, continuityKey, launchProofVerified,
    reconnectToken? })` checks
    the claimed identity against the transport's `ContinuityStore` entry for that application
    context. A mismatch gives `PROVIDER_CHANGED`, which maps to HTTP 412.
  - For an `unattested` transport, a connect without `launchProofVerified === true` is refused
    with `CONFIGURATION_ERROR`, `not-sent`: no binding, no limit slot (6.4). The flag is fixed at
    connect; the transport cannot set or clear it later. A transport that loses the launch session
    reports `lost`.
  - On success it returns the BRC-185 connect proof.
  - `disconnect` takes the same tuple and origin.
  - Bindings live in memory only.
  - The transport must report `lost` once it can no longer serve a binding. For loopback this
    includes the end of the session-scoped server or Activity, so stale bindings do not hold the
    per-origin limit. Any heartbeat or idle rule belongs to project 4, and it must never count a
    binding as idle while it has parked or in-flight requests (BRC-219; the deadline anti-goal in
    5). The core adds no idle timer.
- **Implicit mode** (iOS queue, project 2).
  - The extension signs describe and connect itself, so the page is bound before the app sees
    anything.
  - Every inbox record therefore carries the full tuple plus the `accountContext` and
    `walletRevision` the extension read from the mirrored snapshot, and the `boundAt` time, all
    stamped when it connected (6.9).
  - On the first record for an unknown epoch, the core creates the binding only if the epoch is
    not tombstoned, its `walletRevision` and `accountContext` equal the current ones, and its
    `boundAt` passes the admission horizon below. A revision or context mismatch tombstones it with
    `account-changed`; a horizon failure tombstones it with `lost`, and the page reconnects.
  - **No live bindings are persisted.** An app restart loses nothing for a recent epoch, because
    the next record recreates the binding.
  - **Admission horizon.** Tombstones are bounded (below), so an old closed epoch must never be
    re-admitted after its tombstone is gone. The core refuses an epoch with no live binding when
    its `boundAt` is older than 24 hours, or not later than the ring's persisted `evictedThrough`
    watermark (the latest close time of any entry evicted by count). A long-lived tab older than 24
    hours therefore reconnects after an app restart.
- **Tombstones.** Every close records the epoch with its reason and cause in an install-wide
  ring: at most 1024 entries and 24 hours, persisted, never per profile, with the `evictedThrough`
  watermark above. A tombstoned epoch never binds again, and the wallet revision (6.9) means
  closed epochs cannot revive after a profile switch A→B→A either.
- **Close reasons:**
  - wallet replacement (a wallet-revision change, 6.9) → `account-changed`;
  - wallet-UI revoke or site revoke → `revoked`;
  - transport loss, process death or WebView navigation → `lost`;
  - a page-initiated `disconnect` → `disconnected`, an internal value never sent to the page. It
    takes the same close path as any other close (tombstone, close event, the consent-request rule
    below). Only the `onClosed` / `brc185:closed` notice to the page that asked is suppressed.
- **On every close.** The `connection` request that the closing binding was parked behind is
  dropped once no parked binding remains behind it (6.4).
- **Fan-out.** Closes are emitted in memory synchronously, through `onClosed` to registered
  transports. They are also written to the inbox store's events outbox as epoch-specific close
  events with a monotonic `closeSeq`, so the extension can emit `brc185:closed` for exactly those
  epochs. Closes run synchronously, before any request on a replacement binding is
  admitted.
- **Limits.** At most 8 live bindings per origin and 64 overall. Exceeding either gives
  `RESOURCE_LIMIT`.

**Account context.** `HMAC-SHA256(installSecret, "bsv-bridge-account-context-v1" || identityKeyHex || network)`.

- `installSecret` is 32 random bytes in SecureStore. It is deleted at logout and Delete Wallet,
  which rotates the account context.
- The identity key comes from the newly built wallet,
  `getPublicKey({ identityKey: true }, ADMIN_ORIGINATOR)`, keyed on the manager's object identity
  (the stale-wallet guard pattern from `DirectPayProvider`).
- The context is recomputed whenever `walletBuilt` turns true. It is the cross-process freshness
  tag for the extension. What closes bindings is the wallet revision (6.9), because rebuilding the
  same wallet leaves the context unchanged.
- It is opaque and stays local to the app process. It is mirrored only into the queue store for the
  extension, and never reaches a page, descriptor, envelope or version string.

### 6.8 Durable inbox (`inbox.ts`)

**Record:**
`{ v:1, id (UUIDv4), kind: 'invoke' | 'disconnect', epoch, instanceId, continuityKey, origin,
accountContext, walletRevision, boundAt, method?, args?, createdAt, notAfter }`. There is no `attestation` field: trust
comes from the registered transport (6.2).

**Store adapter contract** (P1 ships an in-memory adapter and a contract test suite; project 2's
App Group adapter must pass it):

- `stat(id)` returns the size. Records over `MAX_BRIDGE_REQUEST_BYTES` are refused **before** they
  are read.
- `read(id)` returns the record's immutable bytes (after `stat`) without changing its state.
  Records are immutable once created, and an id is create-exclusive across every state, so a
  record id can never be re-staged or rewritten.
- `accept(id)` marks a pending record accepted. `claim(id, digest)` is an atomic move from
  accepted to `claimed`, at dispatch time; it succeeds for exactly one caller, and only if the
  stored bytes still hash to `digest`.
- **Sealed at rest.** Arguments, results and close events are stored sealed (AEAD) under a key the
  adapter keeps in a keychain access group shared only by the app and its own extension
  (`ThisDeviceOnly`, available after first unlock). The container directory is excluded from
  backup. The contract suite exposes an adapter's raw stored bytes and asserts no plaintext
  marker appears in them.
- Id tombstones are kept for at least the maximum `notAfter` window plus 5 minutes, whether or not
  a result was acknowledged. Acknowledging deletes the payload, never the tombstone.
- Results can be written, read and acknowledged.
- An events outbox (closes) can be written and read.
- A boot id is stamped on each claim.

**States:** `pending → accepted → claimed → done`.

- **Accepted** means the app process is in the foreground and has taken responsibility for the
  record. This includes showing it behind a consent sheet or a readiness wait. Acceptance happens
  in `createdAt` order per epoch.
- `notAfter` applies only while a record is `pending`. If it has passed before acceptance, the
  result is `CONNECTION_CLOSED`, `not-sent`. The core clamps `notAfter - createdAt` to at most
  15 minutes and refuses `createdAt` in the future (allowing 5 minutes of skew). An expiry sweep
  runs on a timer and on transport nudges, and does not need readiness.
- **Read and accepted** happen first: the core reads the immutable record to resolve the binding,
  consent and readiness (6.6 steps 2–7).
- **Claimed** happens at dispatch, after those steps. Claiming is the at-most-once point. Because
  the claim is awaited, the synchronous re-check (6.6 step 8) runs after it, immediately before the
  wallet call. A claimed record whose re-check fails gets `PROVIDER_CHANGED`, `not-sent`: it was
  never handed to the wallet.
- **Done:** the result is written. Arguments are deleted at claim. Results are deleted on
  acknowledgement. Unacknowledged results are purged after 15 minutes, and a later read is answered
  with `CONNECTION_CLOSED`, `unknown`.

**Crash recovery.** A record claimed under a different boot id with no result gets
`CONNECTION_CLOSED`, `unknown` and is never re-dispatched. Records that were only accepted return
to pending (they were never dispatched).

**Records that cannot become ready.** When the runtime state is `none`, the record is answered
`CONFIGURATION_ERROR`, `not-sent` by 6.6 step 6, before any consent check.

**Data at rest** (revised after review; see 10): everything in the App Group container is sealed
(above). Exposure is also kept short: arguments are deleted at claim, results are deleted on
acknowledgement, and nothing is kept longer than 15 minutes. Project 2 also applies a
data-protection class to the queue directory.

### 6.9 Host runtime, readiness, teardown

- **`BrowserBridgeProvider`**, mounted by the host inside `WalletContextProvider` (opt-in),
  publishes to the runtime:
  - the attested permissions manager and, when an unattested transport is registered, the
    unverified one (6.5);
  - readiness: `ready | building | blocked | none`. `ready` means `walletBuilt`, a manager present
    and the account context computed. This follows the `DirectPayProvider` template. `blocked`
    comes from the unlock state subscription.
  - the account context;
  - the snapshot.

  If no provider is mounted, every request fails `CONFIGURATION_ERROR`, `not-sent`.
- **Teardown registry.** Replace the single `disconnectActivePairedSession` slot with
  `registerSessionTeardown(reasons, fn) → unregister` and `runSessionTeardown(reason)`.
  - Running it is synchronous and idempotent, and each registered function is isolated in
    try/catch.
  - `disconnectActivePairedSession` stays as a shim. The relay registers for `logout` and `profile`
    only, so its behaviour is unchanged.
  - WalletContext calls `runSessionTeardown` at:
    - logout, at the existing synchronous site;
    - profile switch, at the existing site;
    - network switch, which is new and placed after the no-op early return.
  - Re-entry from the network-switch revert path is harmless.
- **Wallet revision.** Teardown hooks cannot cover every wallet replacement, such as
  `rebuildWallet` after a database import or restore, or the mid-build "configuration changed"
  rebuild, and rebuilding the same wallet leaves the account context unchanged. So the runtime
  keeps `walletRevision`, a persisted, install-wide counter. It is bumped whenever a built
  wallet's managers are replaced within a process (not on the first build after launch), detected
  by the managers' object identity at each `walletBuilt` rising edge. A bump closes every binding
  with `account-changed`, runs `withdrawPrompts` on the old managers, and recomputes the account
  context.
- **Withdraw departed prompts (bug fix, attested callers included).** On every wallet replacement,
  `withdrawPrompts(oldManagers)`, for the attested manager and the unverified one alike:
  - **retires** the old managers first, synchronously, so a call still parked inside them cannot
    raise a manager prompt or a token-module prompt later. The runtime keeps a reference to the previous manager for this,
    including on the rising-edge path. (Calls already inside the old manager stay alive: one
    waiting on a manifest fetch, one queued on the per-originator grouped lock, one between its
    token lookup and its prompt. Without retirement they would raise a prompt after the sweep.)
  - denies every active request on the old manager. This goes through a public method on
    `SigningPolicyPermissionsManager`, using the existing internals access, and swallows "Request ID
    not found";
  - clears the seven permission queues and their modal flags, clears the BTMS and Mandala queues
    and resolves their items `false`, and removes every pending `connection` request (6.4);
  - releases focus;
  - settles the bridge's in-flight calls. A call that was provably never handed to the wallet gets
    `not-sent`; otherwise `unknown`.

  Today a stale prompt survives a profile switch, and answering it throws "Request ID not found"
  on the new manager. WalletContext exposes `withdrawPrompts`, and `BrowserBridgeProvider`
  registers it with the runtime.
- **Retired managers.** `SigningPolicyPermissionsManager.retire()` sets a one-way flag, and
  `callEvent` is overridden. While the flag is set, the override does not call the handlers for a
  prompt event; it calls `denyActiveRequest(requestID)` and returns. Today all four `callEvent`
  call sites carry prompt events with a `requestID` (six event kinds: protocol, basket,
  certificate and spending through `callPermissionEvent`; grouped through
  `joinOrCreateGroupedRequest` and the inline `waitForAuthentication` path; counterparty through
  `joinOrCreatePactRequest`). Each registers its `activeRequests` entry, then
  reaches `callEvent` with no `await` in between, so the deny settles the waiting call. A future
  non-prompt event passes through.
  - Deny, never throw. A throw would not itself hold the grouped lock, because
    `withGroupedPermissionFlowLock` releases in a `finally`. The damage is a leaked entry:
    `joinOrCreateGroupedRequest`, `joinOrCreatePactRequest` and the inline `waitForAuthentication`
    path register their entry, then await `callEvent` with no catch. A throw leaves an entry whose
    waiter never settles; the next caller joins it and hangs, and for `group:` it hangs inside the
    lock, which then never releases. (`enqueueAndFireEvent` does catch, so the per-item paths
    would survive a throw.)
  - `retire()` is called only on a manager that has been replaced, never on the one just
    published.
  - **Token-module prompts** do not pass through `callEvent`. BTMS and Mandala prompt through the
    `promptHandler` / `requestTokenAccess` functions passed at construction (`WalletContext.tsx`
    ~1977, ~2040), which enqueue straight into their queues after lookups inside `onRequest`. The
    build that creates the modules wraps both handlers with a build-scoped `retired` flag, set in
    the same synchronous step as `retire()`. Once set, the wrapper resolves `false` without
    enqueueing, and a module call mid-lookup fails with its usual denial without reaching the
    wallet. (A check in the `guarded(module).onRequest` wrapper is not enough: a call already
    inside `module.onRequest` has passed it.)
- **The spending handler's gap.** `spendingAuthorizationCallback` (`WalletContext.tsx` ~1264)
  awaits an AsyncStorage read before it enqueues, so a withdrawal in that window finds nothing to
  remove. After that `await`, and before the auto-approve ledger `record`, the auto-grant or the
  enqueue, the handler checks that the manager that raised the request still holds `requestID`,
  and returns silently if not. `SigningPolicyPermissionsManager` gains a public
  `hasActiveRequest(requestID)`. The manager is the one the callback was bound to, passed in at the
  bind site; the handler must not read `managersRef.current`, because a replacement manager
  restarts its `spend:…:request:N` counter. That includes the auto-grant's `grantPermission` call,
  which must target the bound manager.
- **Queue items carry their manager.** Each prompt callback is bound per manager, so each queue
  item records the manager that raised it, and the sheet answers that manager, never
  `managers.permissionsManager`. This routes unverified prompts to the unverified manager, and a
  stale answer to a retired manager throws "Request ID not found" (caught) instead of reaching a
  new one.
- **Queue answers by identity.** The sheet confirms Allow with a 400 ms animation and then calls
  `executeGrant`, which calls `advance*Queue()`. `advance` drops whatever is at the head. If a
  profile switch clears the queues inside that window and the new manager raises a prompt, the
  deferred grant would drop that new prompt, whose call then hangs, and its `grantPermission` to
  the new manager would throw uncaught. So:
  - for the five manager-backed kinds (protocol, basket, certificate, spending, group),
    `advance*Queue(requestID)` removes that item only if it is still queued, and otherwise does
    nothing. `executeGrant` and `handleDeny` pass the snapshot's `requestID`;
  - if the snapshot's request is no longer queued, the sheet drops the pending grant without
    calling the manager;
  - every sheet call into the manager (`grantPermission`, `denyPermission`,
    `grantGroupedPermission`, `dismissGroupedPermission`) is caught, so a stale answer cannot raise
    an unhandled rejection;
  - BTMS and Mandala keep positional `advance`: they use the sentinel `requestID` `''` and are only
    ever cleared whole;
  - `connection` answers are by `requestId` too, checked as 6.4 describes.

  For attested callers this preserves behaviour. Separately, `executeGrant` and `handleDeny`
  already close the modal flag unconditionally, which can strand a queued request of the same kind
  today. That is recorded as pre-existing (9), not changed here.
- **Snapshot.** `getBridgeSnapshot()` returns
  `{ schema: 1, baseVersion, network, accountContext, walletRevision, readiness, closeSeq }`, with
  change events, so project 2 can mirror it into the App Group. The extension reconciles in two
  ways before answering anything locally: every epoch it bound under an older `walletRevision` is
  closed; and it reads the close events after its own `closeSeq` cursor and closes exactly those
  epochs. Closing tab A therefore never closes tabs B and C.
- **Attention (BRC-219).** The existing focus seam is a no-op in hosts. The core therefore calls
  the transport's `requestAttention` instead (6.2).

### 6.10 BRC-185 primitives (`protocol/`)

- **Strict JSON parse:** rejects duplicate keys, lone surrogates and non-finite numbers. JCS
  follows RFC 8785 and is tested against the RFC appendix vectors.
- **Base64url:** canonical only. No padding or whitespace, the right alphabet, and zero trailing
  bits.
- **Ed25519:** strict RFC 8032, using `@noble/curves` with `zip215: false`. Small-order public keys
  are rejected.
- **Describe proof:** signs `UTF8("BRC-185 descriptor v1\n") || JCS({origin, challenge, descriptor})`.
  `verifyDescribeProof(resp, { origin, challenge })` checks four things:
  - the exact echoed challenge;
  - a valid descriptor;
  - a signature under the descriptor's `continuityKey`;
  - a response of at most 16 384 bytes.
- **Connect proof:** the same, with `"BRC-185 connect v1\n"` over `{origin, epoch, challenge, descriptor}`.
  `verifyConnectProof(resp, { origin, epoch, challenge, expectedIdentity })` checks the same and
  that the identity is the expected one.
- **Descriptor validator** (§3, §3.1):
  - `version` 1;
  - a lowercase UUIDv4 `instanceId`;
  - `name` of 1–80 bytes and `instanceLabel` of 0–80 bytes, both plain text;
  - `vendor` as a lowercase reverse-domain of 1–253 ASCII bytes;
  - `continuityKey` as 32-byte canonical base64url;
  - 1–32 endpoints with unique `[A-Za-z0-9._-]{1,64}` ids, a known type or an absolute HTTPS URI,
    and an address. HTTP types need a loopback serialised origin; `https-json` needs `https`.
  - `icon` is optional: an HTTPS URL, a `uhrp://` Base58Check with the `ce00` prefix, or `chirp://`,
    at most 256 bytes. An invalid icon is treated as absent, while the signature is still verified
    over the exact signed bytes.
  - Optional fields are absent rather than null. Unknown fields are refused.
  - `assertAdvertisesResponder(descriptor, endpoint)` is for project 4.
- **`ContinuityStore` interface:**
  - `getOrCreate(applicationContext) → { instanceId, continuityKey, sign(preimage) }`;
  - `reset(applicationContext | 'all')`.

  It must be readable while the wallet is locked, because describe is non-interactive and under
  1 s. A reset closes that context's bindings with `lost`.
- **Vectors:** use the published `0185-vectors.json` verbatim. Add our own versioned vectors as
  JSON fixtures that the ts-stack side (project 3) must reproduce: connect proof, inbox record and
  result, `brc185:*` envelopes, and the error-codec objects for codes 5, 6 and 7 and for
  `ConnectionError`.

### 6.11 Outcome and error table

Each wallet error maps to a wire error object `{ isError: true, code, name, message, ...fields }`,
plus `data: { originalName, originalCode }`:

| Thrown | Wire |
| --- | --- |
| `WERR_REVIEW_ACTIONS` | 5, with `reviewActionResults, sendWithResults, txid?, tx?, noSendChange?` |
| `WERR_INVALID_PARAMETER`, `VaultAccessDenied`, `WalletArgTooLarge` | 6, with `parameter` (supplied when absent, because SDK clients require it) |
| `WERR_INSUFFICIENT_FUNDS` | 7, with `totalSatoshisNeeded, moreSatoshisNeeded` |
| Invalid HMAC / signature (string code) | 3 / 4 |
| `WERR_INVALID_MERKLE_ROOT` (stamps 8) | 1 |
| User denial and anything else | 1, with its message (≤ 4096 bytes); never a stack |

Mapping rules:
- Map by `instanceof` for SDK classes, by numeric `code`, by toolbox `name`, and by string code for
  3/4.
- Never map by the truthiness of `code`: toolbox errors expose `code` as a string getter.
- A refused `abortAction` returns `{ aborted: false }` and is not an error.

| Situation | ConnectionError code | Delivery |
| --- | --- | --- |
| No provider mounted; no wallet exists; unattested connect without launch proof | `CONFIGURATION_ERROR` | not-sent |
| Origin refused; attestation mismatch; originator frame mismatch; unknown method on an epoch transport; asserted context | `PROTOCOL_ERROR` | not-sent |
| Unknown, retired or mismatched binding; account changed before the call | `PROVIDER_CHANGED` (+ `cause: 'account-changed'` when known) | not-sent |
| User declined site consent | `USER_CANCELLED` | not-sent |
| Over size or concurrency on the request; the transport's sheet slot is held; inside the decline backoff | `RESOURCE_LIMIT` | not-sent |
| Response over the limit | `RESOURCE_LIMIT` | unknown |
| Inbox record expired before acceptance; implicit epoch outside the admission horizon | `CONNECTION_CLOSED` | not-sent |
| `seekPermission: false` from a site that is not connected; unattested token-module name | wallet error 1, permission denied | not-sent |
| Claimed, then crash; in flight, then binding closed or teardown | `CONNECTION_CLOSED` | unknown |
| Mutating call whose result failed validation | `PROTOCOL_ERROR` (`cause: 'invalid-result'`) | unknown |

`ConnectionError = { domain: 'brc185', code, message, delivery, epoch?, cause? }`. A real wallet
error always stays a wallet error. Project 4's HTTP mapping is: wallet error → 400 with the JSON
body; `PROVIDER_CHANGED` → 412; other ConnectionErrors → a status defined in project 4.

The legacy CWI envelope `{ status: 'error', code, description, name? }` stays available. A decoder
for page and extension use rebuilds the SDK `WalletError` / `WERR_*` classes with the SDK's bounds.

## 7. Constraints

- The package ships raw TS. No `process.env`; host settings go through
  `configureToolbox({ browserBridge })`.
- Core must not import ui. Native modules may only be required lazily.
- Prettier: no semicolons, single quotes, no trailing commas, `arrowParens: avoid`, width 120. Run
  it on touched files only.
- Verify with `npx tsc --noEmit -p .` (baseline: 0 errors) and
  `npx jest --ci packages/expo-wallet-toolbox/` from the worktree root. Run jest without
  `--forceExit`.
- Other sessions edit `core/index.ts` and `WalletContext.tsx` in the main checkout. Work stays in
  the `feat/browser-bridge-core` worktree. The teardown registry and its shim land first as a
  small separate commit, together with `withdrawPrompts`, `retire()` and the identity-based queue
  answers (6.9).

## 8. Testing

**Protocol**
- JCS against the RFC 8785 vectors; strict-parse cases.
- Canonical base64url tamper cases.
- The BRC-185 descriptor vector.
- Connect-proof round trip and tamper cases, including small-order keys and `zip215`.
- Descriptor validator boundaries: `icon`, `vendor`, endpoints, empty `instanceLabel`.
- Origin tables, run under both Node `URL` and `whatwg-url-minimum`:
  - admin case and port variants;
  - `.invalid`;
  - IP literals;
  - `localhost` with and without the flag;
  - punycode and non-ASCII;
  - trailing dot;
  - default port.
- The method table equals the SDK `WalletInterface` keys.

**Policy, against the real manager** (in the style of `signingPermissionPolicy.test.ts`)

Jest runs on Node, where the SDK's DNS check for private addresses runs; on the device it does not
(6.5). Manifest tests therefore replace the fetch and assert the URL, not the network result. The
HTTPS branch calls `createPublicHTTPSFetch(expectedOrigin)` from `@bsv/sdk`, which on Node never
uses `globalThis.fetch` (it resolves DNS and opens `node:https` itself). So tests mock
`createPublicHTTPSFetch` and have its stub record the origin and `/manifest.json` URL. They stub
`globalThis.fetch` only for the `localhost` http branch. Cases that need no URL seed
`manifestCache` directly, as `signingPermissionPolicy.test.ts` does.

- **Permission policy.** The verified defaults equal today's literal exactly. The effective
  unverified set is never looser than the verified one, whatever the stored policy says. With the
  defaults, an unverified `listOutputs` on an ordinary basket prompts once, and an attested one does
  not. With every flag on, each request kind prompts. A stored policy whose tag fails is ignored.
- **Namespace isolation.** A token minted for `example.com` never satisfies
  `example.com.<tag>.unverified.invalid`, a token minted under one grant tag never satisfies
  another, and a namespace token never satisfies `example.com`, for protocol, basket and
  certificate checks alike.
- **Grants last.** A grouped grant for the namespace mints the manager's normal tokens, tagged with
  the namespace originator. A new binding for the same remembered site, after the first has
  closed, is not asked again. A non-ephemeral `grantPermission` behaves the same.
- **Spending always asks.** An `example.com` DSAP does not auto-pass for the namespace;
  `autoApprovePolicy` returns the `unattested` reason; a grouped approval whose manifest declared a
  `spendingAuthorization` mints no spending token; every namespace createAction with net spend
  above zero prompts. Pinned accepted behaviour: a net-zero createAction naming the other
  namespace's basketed, non-change output raises no spending prompt.
- **Ask-every-time.** Two BRC-29 `createSignature` calls under the namespace, with the same
  counterparty and different key IDs, each raise their own prompt, exactly as for an attested
  originator.
- **Manifest.**
  - It is fetched from the real hostname, never from a `.invalid` URL. Its spending allowance and
    ask-every-time entries are removed, and so are a `p btms <assetId>` basket, a bare `p mandala`
    basket, a `[0, 'p btms']` protocol and a `[2, 'p mandala token']` protocol. Kept: an ordinary
    basket whose name merely contains "btms" (`btms-notes`, `pbtms`) and a `p ` entry whose
    scheme is neither. A manifest with `spendingAuthorization` but no `protocolPermissions` (the
    aliasing case) leaves the cached object untouched.
  - `localhost`, a single-label host, an all-numeric last label and each listed special-use suffix
    give nulls, with neither the mocked `createPublicHTTPSFetch` nor the stubbed `globalThis.fetch`
    called.
  - No fetch happens while the site is not connected.
  - Separate caches: a namespace read of a failing host leaves the attested manager's manifest
    for that hostname untouched, and the filter never mutates the delegate's objects.
- **Token modules**, table-driven over every routing site: the nine `delegateToPModuleIfNeeded`
  routes, plus createAction, listActions and internalizeAction by `p ` label or basket. On the
  unverified manager each is refused with permission-denied by the stub, with no prompt and no
  module session entry. On the attested manager each still reaches the real module. Named cases:
  createAction with only a `p mandala token-spend` label; createAction spending a known Mandala
  outpoint through the injection wrapper; a label-routed BTMS issuance. A `p nosend` label is not
  refused for the namespace and its spend still prompts.
- **Cross-namespace guard coupling** (verified versus unverified, and between two grant tags). An
  unbasketed output from the other namespace is refused for
  createAction input, relinquishOutput and internalizeAction, while the namespace's own is allowed.
  A `sendWith` of the other namespace's held txid is refused, while its own is allowed. A
  positive control: an ordinary-basket output of the other namespace is allowed.
- **Retired managers.** After `retire()`, every prompt event is denied for every originator, the
  grouped lock is released, and `activeRequests` ends empty. A spending callback whose
  AsyncStorage read is released after a profile switch enqueues nothing and records nothing in the
  auto-approve ledger. A retired build's call parked in a deferred Mandala
  `resolveAssetMetadata` / `listTokenOutpoints` lookup, and one in a BTMS metadata lookup: after
  release nothing is enqueued in the BTMS or Mandala queue, the module's prompt resolves `false`,
  and the call rejects without calling the underlying wallet.
- An explicit "attested unchanged" regression test: the attested manager is built from the same
  configuration as today and carries no unattested patch.

**Presentation**
- `ActivePermission.unverified` is set on all seven `deriveActive` kinds, including `group`. The
  badge and caveat line render, the title is the raw origin, manifest text sits in the quoted
  block, and the 700 ms tap protection applies to the grouped sheet.
- The connection sheet shows the unverified payment line instead of the auto-approve line, the
  matching "remembers this site" line, and "connected before" for a token-less re-approval.
- The `seek*` disclosure table: every `false` flag maps to a phrase on the connection sheet and
  every `true` flag to an "asked first" clause; changing a flag without the table fails.

**Consent**
- Parked until approved; decline answers parked requests with `USER_CANCELLED`, and a later
  request asks again.
- Remembered per profile for both attestations; a tag failure counts as not connected.
- Records are keyed by origin and attestation: approving verified `example.com` leaves unverified
  `example.com` unconnected, and the reverse.
- `revokeSite(origin, attestation)` closes only that attestation's bindings and deletes only that
  record; the next unverified approval gets a new grant tag.
- Swept at logout and Delete Wallet.
- A second new-site request on the same transport while one sheet is pending gets
  `RESOURCE_LIMIT`, `not-sent`, and no sheet; a remembered site is neither blocked by the pending
  sheet nor counted by the backoff; a Decline starts the 30-second backoff for that origin and
  attestation only.
- With the runtime `building` or `blocked`, an interactive request from a site that is not
  connected parks and enqueues no `connection` request until `ready`; with `none` it fails at once.
- With a `connection` sheet open, a profile switch, a network switch, and a rebuild or import each
  remove it and settle its parked requests. A late Approve with the old `requestId` writes nothing
  to the connected-sites store.
- When every binding parked behind a `connection` request closes, the request goes; an answer
  inside the 400 ms window writes nothing.
- An unattested connect without a launch proof creates no binding, takes no limit slot and shows
  no sheet, for a remembered site as for a new one. A remembered unattested site whose connect
  carries the proof runs with no connection sheet. The flag cannot be set on a binding later.
- `registerTransport` refuses `unattested` with `implicit`.

**Dispatcher**
- A table over all 28 methods with golden args and results (optional fields, a large byte array),
  where the originator always comes from the binding and there is no per-method allowlist.
- A typed-array argument is refused; a 3 MB inputBEEF is refused before allocation.
- A snapshot failure gives code 6, `not-sent`.
- A mutating result that fails validation gives `unknown`.
- `getVersion` accepts a BRC-205 extended string.
- **A call parked on readiness, then a profile switch, never reaches the new wallet's mock.**
- No timeout while a prompt is pending (a fake wallet that resolves only when released).
- Probes: from a site that is not connected, with the runtime `none`, `building`, `blocked` and
  `ready`, `getVersion` and `isAuthenticated` answer at once and enqueue no `connection` request.
  A `seekPermission: false` request from a site that is not connected gets permission-denied with
  no sheet.
- Routing: an unattested binding's call reaches the unverified manager, an attested one the
  attested manager, and the two never cross.
- Pre-scan: for an unattested binding, `P Mandala`, ` p btms x` and `p  btms` style names in
  baskets, labels and protocol names are refused before the call; an attested binding is not
  pre-scanned.

**Bindings**
- Implicit creation, and a revision or context mismatch tombstones the epoch.
- A→B→A cannot revive an epoch.
- `rebuildWallet` and an import close bindings, including a rebuild of the same wallet (context
  unchanged, revision bumped), which also retires the old managers.
- Admission horizon: an epoch with `boundAt` older than 24 hours, or not later than
  `evictedThrough` after 1 025 closes, is refused with `lost` once its tombstone is gone.
- Closing epoch A writes one close event; epochs B and C stay open for an extension that
  reconciles by `closeSeq`.
- Reconnect token: a remembered unattested site with the matching token connects with no sheet; no
  token or a wrong one raises the sheet with the "connected before" line; Approve mints a new grant
  tag and token, after which the old token fails and a permission token minted under the old
  originator no longer satisfies any check; Decline leaves the old record and token working.
- Limits.
- Close fan-out to the outbox happens before any replacement admission.
- Page disconnect takes the full close path (tombstone, close event, consent-request rule)
  with no notice to the page that asked.

**Inbox, through the shared contract suite**
- Concurrent claim, re-stage after acknowledgement, rename-over.
- Size checked before read.
- Expiry only while pending; `notAfter` clamped.
- Boot-id crash recovery.
- Accepted records return to pending after a restart.
- Purge after 15 minutes, then a late read.
- Read and accept do not claim; claim succeeds once, only on matching bytes; a re-check failure
  after the claim gives `PROVIDER_CHANGED`, `not-sent`, with no wallet call.
- Raw stored bytes contain no plaintext marker from arguments, results or close events.

**Teardown**
- Existing relay tests (`walletConnectionLogout`) pass unchanged through the shim.
- The bridge closes for all reasons.
- Departed prompts are withdrawn and their calls settled, for both managers.
- A queue item answered after its manager was replaced goes to the retired manager and is caught;
  the new manager receives nothing.
- Retirement: an attested originator has one call holding the grouped sheet, a second queued on
  the grouped lock, a third parked on a deferred manifest fetch, and a fourth parked before
  `findProtocolToken`. A profile switch runs. After it, and after the fetch is released, no prompt
  is enqueued, the seven queues are empty, `activeRequests` on the old manager is empty and the
  grouped lock is released. Repeat for a namespace originator that is connected on the new
  account before the fetch is released.
- The user taps Allow on prompt R1 and a profile switch runs inside the 400 ms window; the new
  manager raises R2 of the same kind. R2 is neither dropped nor left without a sheet, nothing is
  sent to the new manager for R1, and there is no unhandled rejection. Repeat for a `group`
  request.

**Conformance report**
- A generated, versioned JSON report listing each method's coverage, refusals and the known
  deviations in 9.

## 9. Known deviations and limits (recorded, not hidden)

- `waitForAuthentication` can raise the grouped-permission sheet for any connected origin. For
  attested origins this is existing manager behaviour, left alone so attested callers are
  unchanged. For unverified origins it follows from the manifest check in 2, and it is how a
  manifest's `groupPermissions` become the site's permission tokens (6.5). It conflicts with
  BRC-219's "probes must not prompt", but only after the user has connected the site. Merging the
  connect sheet and the grouped sheet into one approval is a project 2 UX goal (12).
- The vault guard's 30-second deadline and shared 16-slot queue apply to external `listActions`.
  This is pre-existing behaviour and conflicts with "no deadline" for that method only. Both
  reviewers asked to fix it rather than keep it as an exception; it is a high-priority follow-up
  (12).
- SDK 2.8 HTTP JSON clients keep the message only for codes 5, 6 and 7, and reject
  `isAuthenticated: false` (project 3).
- Unattested originators are rewritten into the `.<grantTag>.unverified.invalid` namespace. This
  is wallet-side BRC-116 policy, and it applies only to loopback (project 4), never to a future
  BRC-185 §8 mobile profile.
- Request and response caps are 5 MiB, not 64 MiB.
- Non-web asserted contexts and legacy epoch-less routes are not supported in P1.
- **What an approved forging app gets (unverified).** The reconnect token stops a forging local app
  from reconnecting silently. What remains:
  - a user who approves a forging app's sheet gives it a fresh, empty grant set, plus everything
    the effective unverified policy leaves prompt-free. With the defaults that includes signing in
    with the BRC-103/104 auth signature (so it can authenticate to the real site's backend as the
    user), the identity key and derived public keys, encrypt and **decrypt for any protocol**
    (keys never depend on the originator, so it can decrypt what the real site encrypted),
    certificate listing and disclosure, key-link revelation and identity lookups. Basket changes,
    wallet-funded spending, BRC-29 signing and any other signing ask; token modules are refused.
    A user who wants more prompts can turn the unverified flags on (6.5);
  - the sheet's text from a manifest can be made to appear on demand. It is shown only in a quoted
    "This website says" block under a wallet-written description and a raw-origin title;
  - a script injected into the real site can read the token, but it already controls that site's
    live session;
  - the launch proof does not authenticate the website: any installed app can launch the wallet's
    Activity with a secret it chose. It only ties a connection to a visible launch of the wallet.
  Verifying Android Chrome origins (MWA-style iframe attestation) would remove most of this; it is
  a project 4 research item, not run now (12).
- **An unanswered connection sheet holds its transport's single slot** until answered or until its
  bindings close, so a second new site on that transport is refused with `RESOURCE_LIMIT`
  meanwhile. There is no deadline (BRC-219).
- **Basket contents are not isolated** between a site's verified and unverified identities, or
  between any two connected sites, once basket access is granted. Only unbasketed outputs and held
  `sendWith` transactions are coupled to their originator (6.5 Known coupling).
- **Manifest fetch on the device.** The SDK's private-address DNS check runs only on Node. On
  Hermes an unverified site's claimed hostname that resolves to a private address is fetched,
  bounded by TLS, the fixed URL and port, and the special-use host list (6.5). Closing this needs a
  resolver for Hermes or a check in the manager's fetch: a toolbox/SDK follow-up, not project 4.
- **Token-module routing is exact-case for attested callers (pre-existing).** The manager routes
  on a raw `startsWith('p ')`, while the wallet trims and lowercases the same names, so variants
  such as `P mandala` reach no module hook. Unverified bindings are covered by the dispatcher's
  pre-scan (6.5); attested behaviour is unchanged here. Follow-up: normalise names before the
  manager's routing test, for all originators (12).
- **Pre-existing sheet behaviour.** `executeGrant` and `handleDeny` close the kind's modal flag
  unconditionally after answering, which can strand a queued request of the same kind. Recorded,
  not changed here, because changing it alters attested prompts.

## 10. Calls I made (please check)

1. Site consent prompts use a new PermissionSheet kind in P1, owned by the core and withdrawn on
   wallet replacement and binding closes like the other prompts (6.4). The management screen comes
   in project 2.
2. Bindings for the iOS queue are rebuilt from each record and not persisted. Only tombstones, the
   eviction watermark and the wallet revision persist.
3. A network switch, a database import or restore, and a wallet rebuild, of the same wallet too,
   all count as a wallet replacement and close bindings (6.9).
4. **Reversed after review:** everything in the App Group container is sealed under a key in a
   keychain access group, excluded from backup, and kept at most 15 minutes (6.8). Revision 4
   kept results as plaintext for up to an hour.
5. Teardown now withdraws stale prompts for every caller, as a bug fix. The old managers, and the
   token-module prompt handlers of their build, are retired first, so a call still parked inside
   them cannot raise a prompt after the sweep.
6. Unverified origins get their own permissions manager, whose BTMS and Mandala entries are
   refusing stubs, plus a dispatcher pre-scan for case and whitespace variants of those names. The
   attested manager carries no unattested patch at all.
7. Limits: 5 MiB per request, 4 calls in flight per binding, 16 in total.
8. **Reversed after review:** `getVersion` and `isAuthenticated` answer at once, with no consent and
   no wait (BRC-219). Revision 4's review had made them wait for a ready wallet and consent.
9. `waitForAuthentication` keeps its grouped-permission sheet for attested origins. For
   unverified origins the sheet is the intended result of the manifest check in 2.
10. For unverified origins, the manifest comes from the real domain through the unverified
    manager's own cache. Its spending allowance and token-module entries are dropped, and
    `localhost`, single-label and special-use hosts are never read. (The manifest check itself is
    the owner's decision in 2; these limits are mine.)
11. The owner decided on remembered approvals with a reconnect token and a clean slate, and on a
    permission setup object (2). My calls within that:
    - the clean slate is a fresh random grant tag in the originator, not an on-chain revoke, so
      safety never waits on the network; revoking the old tag's tokens is best-effort cleanup;
    - the token is 32 random bytes, stable for the approval's life, stored only as a hash;
    - the unverified permission set can only be stricter than the verified one;
    - consent records stay separate per attestation;
    - spending still always asks for unverified sites, with no auto-approve and no allowance;
    - token modules stay refused;
    - every unverified connection still needs the launch proof, even though it does not
      authenticate the website;
    - a policy change applies from the next wallet build.
12. The built-in `nosend` module (BRC-177) is not refused for unverified origins. It holds no
    session, and every spend under it still prompts.
13. The permission sheet answers each queue item by `requestID` on the manager that raised it
    (6.9), so a profile switch inside the 400 ms confirm window cannot drop the new account's
    prompt. Behaviour-preserving for attested callers.
14. Each transport holds one `connection` sheet at a time, and a Decline blocks a new sheet for
    the same origin and attestation for 30 seconds. Connected sites bypass both (6.4).
15. Implicit epochs older than 24 hours are not re-admitted after an app restart (6.7): a tab open
    that long reconnects.
16. The settings screen for the permission policy is deferred; P1 ships the object, defaults and
    a core API (12).

## 11. Left to the builder

File and function names; internal data structures; constants not stated here; whether to build on
`WalletClient` (6.6); test file split; i18n wording beyond the meaning given.

## 12. Open items for later projects

- **Alongside project 1:** the iOS handoff-link device spike (owner decision). Does a custom
  scheme from the extension trigger "Open in App?"; does a universal link from the extension popup
  open the app or the website; and a "Back to Safari" button after approval, tested after a cold
  start with Face ID.
- **Project 2:**
  - which methods the extension answers from the snapshot (it must reconcile `walletRevision` and
    `closeSeq` first);
  - handoff and return UX, informed by the spike: a short in-Safari summary with a real `<a href>`
    the user taps, and a return button after approval;
  - merging the connect sheet and the grouped-permission sheet into one approval;
  - a unique scheme or universal link per wallet;
  - the App Group adapter, including the sealing key in a keychain access group;
  - the isolation-test update;
  - the "Browser connections" screen, showing each record's attestation and revoking per record;
    and whether to offer "Remove connection and permissions" for verified sites, which would also
    remove the in-app browser's grants for the same hostname;
  - a settings screen for the permission policy, with "apply now";
  - the local-notification attention handler;
  - the extension handle contract: frame origin; the page's origin argument must equal the frame
    origin or be refused; a lazy bind failure surfaces as `PROVIDER_CHANGED` on the first invoke.
- **Project 3:**
  - the SDK hook; whether messages survive for codes outside 5/6/7; accepting
    `isAuthenticated: false`;
  - the reconnect token on the page side: stored in the site's own storage, keyed by the wallet's
    continuity key, and sent only after the connect proof verifies that key;
  - **a shipping prerequisite:** gate `WalletClient('auto')`'s loopback probes behind a
    BRC-325 primer, because today they raise Chrome's local-network prompt on every https dApp and
    a denial sticks.
- **Project 4:**
  - the `ContinuityStore` implementation;
  - the launch-proof format, presented at connect, binding protocol version, wallet identity,
    epoch, the exact claimed origin, a session key, an expiry and a single-use nonce. It prevents
    substitution and replay; it does not authenticate the origin;
  - how the reconnect token reaches the page (`deliverReconnectToken`);
  - encrypting the loopback association, as MWA does, so other local apps that can connect to the
    port cannot read it;
  - the Chrome local-network primer, then the system prompt, then the intent;
  - research: MWA-style iframe origin attestation (a wallet-hosted page bound by Digital Asset
    Links signs the browser-set `event.origin`). If it holds up under partitioned storage, private
    browsing and forged native callers, Android Chrome origins could become verified;
  - HTTP status table;
  - whether legacy routes are served;
  - the loopback liveness signal: when the transport reports `lost` (6.7), so stale bindings do
    not hold the per-origin limit.
- **Not now (owner decision):** a transport for browsers with neither an extension nor loopback
  (iOS Chrome, Firefox, Edge, in-app browsers). Both reviewers proposed an app-link transport,
  possibly with an encrypted relay to carry results back.
- **Follow-ups outside these projects:**
  - the guard's `listActions` deadline under BRC-219 (high priority);
  - the relay staying alive across a network switch or rebuild;
  - a private-address check for the manager's manifest and certifier fetches on Hermes (9);
  - normalising basket, label and protocol names before the manager's token-module routing test,
    for all originators (9).
