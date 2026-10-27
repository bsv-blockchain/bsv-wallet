# Browser wallet bridge — core (project 1 of 4)

Date: 2026-10-27. Status: design, revision 2 (after builder check and three adversarial reviews).
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

## 3. Goals

G1. **All 28 BRC-100 methods.** No allowlist subset and no stubs (BRC-185 §1). Each call gets SDK
argument validation before it runs and SDK result validation after, with byte fields normalised
by the SDK's helpers.

G2. **One origin rule.** Turn a transport-attested web origin into two values: the full
application origin, kept for bindings, consent and memory, and the BRC-100 originator, which is the
ASCII hostname with no scheme or port. Refuse anything that could become admin or reserved, and
refuse anything the permissions manager would reject.

G3. **Site consent.** Before any method runs, the wallet asks once per site and remembers the
answer (2). For unattested origins (6.3) the approval is per binding and never remembered.

G4. **Unattested origins cannot inherit or create lasting authority.** An unattested origin is one
asserted by a channel that can be forged, such as an Android loopback `Origin` header. These calls
run in a separate permission namespace where:
- no grant persists;
- spending is never auto-approved;
- the group/manifest flow never runs;
- token-module routes (BTMS/Mandala) are refused.

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
- It tears down on any account-context change: logout, profile switch, network switch, and wallet
  rebuild or import.
- When it tears down, it withdraws the departed wallet's pending prompts.
- It asks transports for user attention whenever a request is waiting on the user (BRC-219).

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
- P1 does not ship a release on its own. It merges to master and ships in the release that carries
  project 2's transport.

## 5. Anti-goals: if any of these happen, the project failed

- An originator supplied by a page, header or request body reaches the wallet unchecked, or any
  path gives a caller `ADMIN_ORIGINATOR` behaviour.
- A site's requests run before the user has connected that site.
- A forged origin reuses a grant that the real site earned through an attested channel, or leaves
  behind a grant that the real site later inherits.
- A call moves to another account's wallet: it is checked under one profile or network and runs
  under another.
- The core or a client puts a deadline on a call that has been accepted and may be waiting for the
  user. (Pre-existing exceptions are listed in 9.)
- A request whose dispatch may already have happened is re-dispatched (no replay after a crash or
  retry), or a request that may have taken effect is reported as a clean failure.
- Behaviour changes for existing attested callers in the in-app, relay and WebView paths: their
  prompts, auto-approve and grants. The one deliberate exception is the teardown fix in 6.9, which
  withdraws prompts belonging to a wallet that no longer exists.
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
  consent.ts       connected-sites store (per profile, HMAC-authenticated) + approval queue
  bindings.ts      binding registry, tombstones, account-context checks, close fan-out
  policy.ts        attestation -> originator; site-consent gate; unattested rules
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
  requestAttention(reason, binding), onClosed?(event) }) -> handle
```

- `attestation` is a property of the registered transport, fixed at registration. It never comes
  from a call, a record or stored data. Requests that claim a different attestation than their
  transport are refused (`PROTOCOL_ERROR`, `not-sent`).
- `browser` means the browser itself vouched for the origin: the Safari extension's sender frame
  origin, or a native WebView frame origin. `unattested` means anything a local process could forge.
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
   - For `unattested`, `originator = <hostname>.unverified.invalid`. Refuse it if this exceeds 250
     bytes.
5. **Final check.** `assertCanonicalOriginator(originator)` runs again immediately before every
   wallet call. It requires a hostname shape, no `:` or `@`, not admin after normalisation, and
   `.invalid` only as the exact unverified suffix.

If a transport carries an originator frame or header, it must equal the derived originator.
Otherwise the request is refused with `PROTOCOL_ERROR`, `not-sent`; the core never silently
ignores a mismatch.

The hostname-only originator follows BRC-185 §1. One consequence, recorded deliberately: different
ports of one host share one permission identity. Consent and bindings still use the full origin.

The existing `parseExternalOrigin` (https only, `host:port`) is unchanged for the relay.

### 6.4 Site consent (`consent.ts`)

- **Gate.** Before dispatching any method, the core checks the connected-sites store. If the
  binding's `applicationOrigin` is not connected under the current profile, the request parks and
  the core enqueues one consent request per origin into a new PermissionSheet kind, `connection`.
- **What the sheet shows:**
  - the full origin;
  - verified or unverified;
  - the transport ("Safari");
  - what connecting allows, in plain words: "see your identity key, encrypt and decrypt data,
    sign in to the site, and ask you to approve payments. Payments under your auto-approve limit
    go through automatically."
- **Answers:**
  - **Approve:** records the site and releases its parked requests in order.
  - **Decline:** answers every parked request from that origin with `USER_CANCELLED`, `not-sent`,
    and records nothing.
- **Attested sites** are remembered per profile until revoked. Records are
  `{ applicationOrigin, originator, transport, approvedAt, tag }`, where `tag` is an HMAC computed
  with the admin-scoped wallet under a new reserved guard namespace (`bridge site authority`). This
  follows the XR-027 / `connectionAuthority.ts` pattern. A record whose tag fails verification is
  treated as not connected. The store key is swept at logout and Delete Wallet, including profile
  0's bare key.
- **Unattested bindings** are approved per binding and never remembered. Approval also requires
  `launchProofVerified: true` from the transport (project 4 binds a per-launch secret delivered in
  its package-targeted intent). Without it the request is refused (`CONFIGURATION_ERROR`,
  `not-sent`). Each transport may have at most one pending approval. Repeated connects from the same
  transport are rate-limited.
- **Tap protection.** The sheet's approve button is inactive for 700 ms whenever a `connection` or
  unverified prompt becomes the head of the queue. Other prompt kinds behave as today.
- **Management.** `listConnectedSites()` and `revokeSite(origin)` are core APIs. Revoking closes
  that origin's live bindings with `revoked`. The screen comes in project 2.

### 6.5 Unattested policy

The only per-call datum that reaches token tags, cache keys, P-module caches, action labels,
callbacks and the sheet is the originator string. The policy therefore works through that string.

- **Namespace.** `<hostname>.unverified.invalid` (6.3). External input can never produce it,
  because every boundary refuses `.invalid`. Tokens, caches, labels and spend accounting are
  therefore disjoint from the real hostname's.
- **Manager hardening.** `SigningPolicyPermissionsManager` gains an `isUnattestedOriginator`
  predicate (one shared helper, exported from a dependency-free core module). It uses the same
  patching technique as the existing BRC-29 rule and is tested against the real manager. For
  originators in the namespace:
  - `find{Protocol,Basket,Certificate,Spending}Token` returns `undefined`;
  - `fetchManifestPermissions` returns nulls (no group sheet, no outbound GET);
  - `cachePermission` and `markRecentGrant` do nothing;
  - `grantPermission` and `grantGroupedPermission` are forced to be ephemeral;
  - `createPermissionOnChain` and `renewPermissionOnChain` refuse, as a backstop.
- **Auto-approve.** `autoApprovePolicy.shouldAutoApprove` returns
  `{ approve: false, reason: 'unattested' }` for the namespace, and `record()` ignores it. This is
  done in the pure, already-tested module, and the WalletContext callback is unchanged.
- **Token modules.** Requests that route to a P-module (`p ` baskets or protocols: BTMS, Mandala)
  are refused for the namespace with a permission-denied wallet error. These modules keep 60-second
  approval sessions, which would break "nothing persists". This is a policy denial, not a stub.
- **Presentation.**
  - `ActivePermission` gains `unverified: boolean`. It is set once, where the originator is derived
    in `deriveActive` (seven assignment sites), and the suffix is stripped there.
  - The sheet shows the full origin and an "Unverified" badge with the line "This request came
    through a channel that can't prove which website sent it." All strings get i18n keys in all
    12 locales (parity test).
  - PermissionSheet imports the helper by relative path, so the existing barrel mock in
    `PermissionSheet.test.tsx` keeps working.
- **Known coupling (recorded).** The vault guard treats outputs created under another originator
  label as admin state. So `example.com` and `example.com.unverified.invalid` cannot spend or name
  each other's outputs. This is intended and covered by a test.

Attested (`browser`) calls use the plain hostname and go through the manager unchanged.

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
   `continuityKey`, origin equality and account context (6.7). If resolution fails, the request
   gets the reason from the table in 6.11.
3. **Consent.** If the site is not connected, the request parks (6.4).
4. **Method.** It must be an own property of the 28-entry table. Otherwise the result is
   `PROTOCOL_ERROR`, `not-sent`. (Legacy-envelope transports instead map an unknown method to wallet
   code 2.)
5. **Arguments.** `args ?? {}`, then:
   - `normalizeBRC100WalletByteFields`;
   - `checkWalletArgs` size limits (also fix `capWalletArgs`'s `arrayBytes` to count
     `ArrayBuffer` views, and add `acquireCertificate` to the capped set);
   - `validateWalletArgs`;
   - `snapshotWalletResultRequest(method, args)`, **before** the call.

   Any failure gives wallet code 6 with `parameter`, `not-sent`. The wallet receives the
   byte-normalised original arguments.
6. **Readiness.** By method class:
   - `getVersion` is answered without the wallet, with the static base version string.
   - `isAuthenticated` is answered from runtime state: `{ authenticated: ready }`. The SDK 2.8
     client rejects `false` (project 3), but BRC-100 permits it.
   - Every other method parks until the runtime is `ready`, with attention requested. If the state
     is `none` (no wallet has been created), the request fails `CONFIGURATION_ERROR`, `not-sent`.
     For `building` or `blocked` (biometric cancelled, key unavailable), it stays parked.
7. **Synchronous re-check.** After the last `await` and immediately before the call, with no
   `await` between them:
   - the binding is still live;
   - `binding.accountContext === runtime.accountContext`;
   - the wallet object was built for that context;
   - `assertCanonicalOriginator` still passes.

   If any check fails, the request gets `PROVIDER_CHANGED`, `not-sent`, cause `account-changed`.
8. **Call.** Build the wallet with
   `capWalletArgs(guardVaultAccess(runtime.permissionsManager, ADMIN_ORIGINATOR))` (read fresh,
   never cached across builds), then `await wallet[method](args, binding.originator)`. The
   originator always comes from the binding.
9. **After the call.**
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

`Binding = { epoch, transportId, applicationOrigin, originator, attestation, instanceId,
continuityKey, accountContext, createdAt, state: 'live' | 'closed', closeReason? }`.

- **Explicit mode** (Android, project 4).
  - `connect({ epoch, origin, challenge, instanceId, continuityKey })` checks the claimed identity
    against the transport's `ContinuityStore` entry for that application context. A mismatch gives
    `PROVIDER_CHANGED`, which maps to HTTP 412.
  - On success it returns the BRC-185 connect proof.
  - `disconnect` takes the same tuple and origin.
  - Bindings live in memory only.
- **Implicit mode** (iOS queue, project 2).
  - The extension signs describe and connect itself, so the page is bound before the app sees
    anything.
  - Every inbox record therefore carries the full tuple plus the `accountContext` the extension
    read from the mirrored snapshot when it connected (6.9).
  - On the first record for an unknown epoch, the core either creates the binding or refuses it:
    - creates it if the epoch is not tombstoned and the record's `accountContext` equals the
      current one;
    - otherwise tombstones it with `account-changed`.
  - **No live bindings are persisted.** An app restart loses nothing, because the next record
    recreates the binding.
- **Tombstones.** Every close records the epoch with its reason and cause in an install-wide
  ring: at most 1024 entries and 24 hours, persisted, never per profile. A tombstoned epoch never
  binds again, so closed epochs cannot revive after a profile switch A→B→A.
- **Close reasons:**
  - account-context change → `account-changed`;
  - wallet-UI revoke or site revoke → `revoked`;
  - transport loss, process death or WebView navigation → `lost`;
  - a page-initiated disconnect has no `onClose`.
- **Fan-out.** Closes are emitted in memory synchronously, through `onClosed` to registered
  transports. They are also written to the inbox store's events outbox, so the extension can emit
  `brc185:closed`. Both happen before any request on a replacement binding is admitted.
- **Limits.** At most 8 live bindings per origin and 64 overall. Exceeding either gives
  `RESOURCE_LIMIT`.

**Account context.** `HMAC-SHA256(installSecret, "bsv-bridge-account-context-v1" || identityKeyHex || network)`.

- `installSecret` is 32 random bytes in SecureStore. It is deleted at logout and Delete Wallet,
  which rotates the account context.
- The identity key comes from the newly built wallet,
  `getPublicKey({ identityKey: true }, ADMIN_ORIGINATOR)`, keyed on the manager's object identity
  (the stale-wallet guard pattern from `DirectPayProvider`).
- The context is recomputed whenever `walletBuilt` turns true.
- It is opaque and stays local to the app process. It is mirrored only into the queue store for the
  extension, and never reaches a page, descriptor, envelope or version string.

### 6.8 Durable inbox (`inbox.ts`)

**Record:**
`{ v:1, id (UUIDv4), kind: 'invoke' | 'disconnect', epoch, instanceId, continuityKey, origin,
accountContext, method?, args?, createdAt, notAfter }`. There is no `attestation` field: trust
comes from the registered transport (6.2).

**Store adapter contract** (P1 ships an in-memory adapter and a contract test suite; project 2's
App Group adapter must pass it):

- `stat(id)` returns the size. Records over `MAX_BRIDGE_REQUEST_BYTES` are refused **before** they
  are read.
- `claim(id)` is an atomic move to `claimed`, done before the record is read. It succeeds for
  exactly one caller. An id is create-exclusive across every state, so a record id can never be
  re-staged.
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
- **Claimed** happens only after consent, readiness and the synchronous re-check (6.6 steps 3–7).
  Claiming is the at-most-once point.
- **Done:** the result is written. Arguments are deleted at claim. Results are deleted on
  acknowledgement. Unacknowledged results are purged after 1 hour, and a later read is answered
  with `CONNECTION_CLOSED`, `unknown`.

**Crash recovery.** A record claimed under a different boot id with no result gets
`CONNECTION_CLOSED`, `unknown` and is never re-dispatched. Records that were only accepted return
to pending (they were never dispatched).

**Records that cannot become ready.** When the runtime state is `none`, the record is answered
`CONFIGURATION_ERROR`, `not-sent` at once.

**Results at rest** (my call; see 10): plaintext JSON in the App Group container. Exposure is kept
short in three ways: arguments are deleted at claim, results are deleted on acknowledgement, and
nothing older than 1 hour is kept. Project 2 must apply a data-protection class and exclude the
queue directory from backups.

### 6.9 Host runtime, readiness, teardown

- **`BrowserBridgeProvider`**, mounted by the host inside `WalletContextProvider` (opt-in),
  publishes to the runtime:
  - the permissions manager;
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
- **Rising-edge detection.** Teardown hooks cannot cover every wallet replacement, such as
  `rebuildWallet` after a database import or restore, or the mid-build "configuration changed"
  rebuild. So the provider also recomputes the account context at each `walletBuilt` rising edge.
  A different value closes every binding with `account-changed`.
- **Withdraw departed prompts (bug fix, attested callers included).** On every account-context
  change, the hook:
  - denies every active request on the **old** manager;
  - clears the seven permission queues and their modal flags;
  - releases focus;
  - settles the bridge's in-flight calls. A call that was provably never handed to the wallet gets
    `not-sent`; otherwise `unknown`.

  Today a stale prompt survives a profile switch, and answering it throws "Request ID not found"
  on the new manager.
- **Snapshot.** `getBridgeSnapshot()` returns
  `{ schema: 1, baseVersion, network, accountContext, readiness, generation }`, with change events,
  so project 2 can mirror it into the App Group. `generation` increases on every close fan-out. The
  extension must treat epochs from an older generation as closed before answering anything
  locally.
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
| No provider mounted; no wallet exists; unattested approval without launch proof | `CONFIGURATION_ERROR` | not-sent |
| Origin refused; attestation mismatch; originator frame mismatch; unknown method on an epoch transport; asserted context | `PROTOCOL_ERROR` | not-sent |
| Unknown, retired or mismatched binding; account changed before the call | `PROVIDER_CHANGED` (+ `cause: 'account-changed'` when known) | not-sent |
| User declined site consent | `USER_CANCELLED` | not-sent |
| Over size or concurrency on the request | `RESOURCE_LIMIT` | not-sent |
| Response over the limit | `RESOURCE_LIMIT` | unknown |
| Inbox record expired before acceptance | `CONNECTION_CLOSED` | not-sent |
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
  the `feat/browser-bridge-core` worktree, and the teardown registry and its shim land first as a
  small separate commit.

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
- The namespace never reuses an attested token.
- An `example.com` DSAP does not auto-pass for the namespace.
- No manifest fetch happens for the namespace.
- Forced-ephemeral grants, and the on-chain backstop.
- P-module routes are refused.
- `autoApprovePolicy` returns the `unattested` reason.
- Cross-namespace guard coupling.
- An explicit "attested unchanged" regression test around every patched method.

**Consent**
- Parked until approved; decline answers parked requests with `USER_CANCELLED`.
- Remembered per profile; a tag failure counts as not connected.
- Swept at logout and Delete Wallet.
- One pending approval per transport.
- Unattested approval needs a launch proof.

**Dispatcher**
- A table over all 28 methods with golden args and results (optional fields, a large byte array),
  where the originator always comes from the binding and there is no per-method allowlist.
- A typed-array argument is refused; a 3 MB inputBEEF is refused before allocation.
- A snapshot failure gives code 6, `not-sent`.
- A mutating result that fails validation gives `unknown`.
- `getVersion` accepts a BRC-205 extended string.
- **A call parked on readiness, then a profile switch, never reaches the new wallet's mock.**
- No timeout while a prompt is pending (a fake wallet that resolves only when released).

**Bindings**
- Implicit creation, and a context mismatch tombstones the epoch.
- A→B→A cannot revive an epoch.
- `rebuildWallet` and an import close bindings.
- Limits.
- Close fan-out to the outbox happens before any replacement admission.

**Inbox, through the shared contract suite**
- Concurrent claim, re-stage after acknowledgement, rename-over.
- Size checked before read.
- Expiry only while pending; `notAfter` clamped.
- Boot-id crash recovery.
- Accepted records return to pending after a restart.
- Purge, then a late read.

**Teardown**
- Existing relay tests (`walletConnectionLogout`) pass unchanged through the shim.
- The bridge closes for all reasons.
- Departed prompts are withdrawn and their calls settled.

**Conformance report**
- A generated, versioned JSON report listing each method's coverage, refusals and the known
  deviations in 9.

## 9. Known deviations and limits (recorded, not hidden)

- `waitForAuthentication` can raise the grouped-permission sheet for attested origins. This is
  existing manager behaviour, kept to avoid changing attested callers, and conflicts with BRC-219's
  "probes must not prompt".
- The vault guard's 30-second deadline and shared 16-slot queue apply to external `listActions`.
  This is pre-existing behaviour and conflicts with "no deadline" for that method only.
  It is proposed as a follow-up.
- SDK 2.8 HTTP JSON clients keep the message only for codes 5, 6 and 7, and reject
  `isAuthenticated: false` (project 3).
- Unattested originators are rewritten into the `.unverified.invalid` namespace. This is
  wallet-side BRC-116 policy, and it applies only to loopback (project 4), never to a future
  BRC-185 §8 mobile profile.
- Request and response caps are 5 MiB, not 64 MiB.
- Non-web asserted contexts and legacy epoch-less routes are not supported in P1.

## 10. Calls I made (please check)

1. Site consent prompts use a new PermissionSheet kind in P1. The management screen comes in
   project 2.
2. Bindings for the iOS queue are rebuilt from each record and not persisted. Only tombstones
   persist.
3. A network switch, a database import or restore, and a wallet rebuild all count as an account
   change and close bindings.
4. Results sit in the App Group container as plaintext JSON for at most 1 hour (deleted on
   acknowledgement, data-protected, excluded from backup). Sealing them to an extension key was
   considered and left out: only our app and our own extension can read the group, and the page
   receives the same data anyway.
5. Teardown now withdraws stale prompts for every caller, as a bug fix.
6. Token-module (BTMS/Mandala) routes are refused for unverified origins.
7. Limits: 5 MiB per request, 4 calls in flight per binding, 16 in total.
8. `getVersion` and `isAuthenticated` never wait for the wallet. Everything else waits until the
   wallet is ready, with no deadline.
9. `waitForAuthentication` keeps its grouped-permission sheet.

## 11. Left to the builder

File and function names; internal data structures; constants not stated here; whether to build on
`WalletClient` (6.6); test file split; i18n wording beyond the meaning given.

## 12. Open items for later projects

- **Project 2:**
  - which methods the extension answers from the snapshot (it must respect `generation`);
  - handoff and return UX;
  - a unique scheme or universal link per wallet;
  - the App Group adapter;
  - the isolation-test update;
  - the "Browser connections" screen;
  - the local-notification attention handler;
  - the extension handle contract: frame origin; the page's origin argument must equal the frame
    origin or be refused; a lazy bind failure surfaces as `PROVIDER_CHANGED` on the first invoke.
- **Project 4:**
  - the `ContinuityStore` implementation;
  - launch-proof format;
  - HTTP status table;
  - whether legacy routes are served;
  - whether unattested protocol grants may last for the epoch.
- **Project 3:** the SDK hook; whether messages survive for codes outside 5/6/7; accepting
  `isAuthenticated: false`.
- **Follow-ups outside these projects:**
  - the relay staying alive across a network switch or rebuild;
  - the guard's `listActions` deadline under BRC-219.
