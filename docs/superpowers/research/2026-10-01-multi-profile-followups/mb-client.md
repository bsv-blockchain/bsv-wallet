# Report: `@bsv/message-box-client` device registration, and what it means for non-active profiles

Path shorthand:
- `LIB` = `/Users/personal/git/bsv-wallet/node_modules/@bsv/message-box-client/dist/src`
- `SDK` = `/Users/personal/git/bsv-wallet/node_modules/@bsv/sdk/dist/esm/src`
- `CORE` = `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/core`
- `GO` = `/Users/personal/git/go/go-message-box-server`

## 0. Headline: the client side is feasible, but the server rules out "register every profile"

1. **The Go server stores one identity per FCM token.**
   - The column is `fcm_token TEXT NOT NULL UNIQUE` (`GO/pkg/storage/sqlstore/sqlstore.go:201`, Postgres twin at `:276`).
   - Registration upserts with `ON CONFLICT(fcm_token) DO UPDATE SET identity_key = ?, ... active = TRUE` (`GO/pkg/storage/sqlstore/queries.go:425`).
   - The Mongo store keys the document on `_id: d.FCMToken` (`GO/pkg/storage/mongostore/mongostore.go:459`).
   - So registering profile n's identity with the device's token takes the token away from whichever identity held it.
   - Push delivery then looks up `ListActiveDevices(recipient)` (`GO/internal/firebase/send_fmc_notification.go:50`). The previous identity gets nothing.
   - Registering all profiles on one device needs a server schema change (for example `UNIQUE(identity_key, fcm_token)`). I found no client-side workaround.

2. **Today's app already has this regression for profile switches.**
   - `PUSH_REGISTRATION_KEY` is the bare key `push_registration_v1` (`CORE/push/registration.ts:4`). It is not wrapped in `profileScopedKey`.
   - The marker is `${host}|${identityKey}|${token}` (`CORE/push/registration.ts:36`).
   - Each wallet build wires `syncPush` (`CORE/context/WalletContext.tsx:2436-2452`). After a switch the identity differs, the marker mismatches, and `registerDevice` fires (`registration.ts:38`).
   - The server upsert then silently moves push from the profile you just left to the new one.
   - Switching 0, then 1, then 0 re-registers each time.

3. **The push payload carries no recipient identity.**
   - `sendMessage` passes only `Title` and `MessageID` to FCM (`GO/pkg/handlers/send_message.go:287-289`).
   - The FCM data is only `messageId` and `originator` (`GO/internal/firebase/send_fmc_notification.go:131-132`, APNS copy at `:150-151`).
   - Push is sent only for the `notifications`, `payment_inbox` and `mandala-payments` boxes (`GO/pkg/handlers/policy.go:34-43`).
   - On the app side, `attachPushHandlers` just calls `requestInboxPass` and `openActivity` for whichever build is active (`CORE/push/events.ts:53-60`, `:78`).
   - Even with the schema fixed, the app cannot tell which profile a push was for.

## 1. Installed versions

- **Library:** `@bsv/message-box-client` is 2.5.3 (`.../message-box-client/package.json`). It has a single runtime dependency, `@bsv/authsocket-client` 2.1.7, and a peer dependency on `@bsv/sdk` ^2.8.0.
- **SDK:** `@bsv/sdk` is 2.8.2, hoisted. `message-box-client` has no nested `node_modules`.
- **Patch:** `patches/@bsv+sdk+2.8.2.patch` only touches `primitives/*`, `script/templates/P2PKH.js` and `transaction/Transaction.js`. That comes from its `^diff` headers, which I checked. So it does not alter the auth or ProtoWallet logic.
- **Source:** the shipped `dist/src/*.js.map` files embed `../../src/MessageBoxClient.ts` with `sourcesContent`.

## 2. Device API

**`registerDevice(params, overrideHost?)`** — `LIB/MessageBoxClient.js:2484-2520`, types in `LIB/types.d.ts:191-199`.
- Params are `{ fcmToken: string, deviceId?: string, platform?: 'ios'|'android'|'web' }`.
- Validation:
  - `fcmToken` must be non-empty and at most 500 UTF-8 bytes.
  - `deviceId` is at most 255 UTF-8 bytes.
  - `platform` must be one of the three values.
- Request: `POST ${host}/registerDevice` with `Content-Type: application/json` and body `{fcmToken, deviceId, platform}` (`:2497-2504`).
  - The URL comes from `messageBoxEndpoint` (`LIB/host.js`), which requires HTTPS except on loopback.
  - The wallet passes no `deviceId`, so the server stores null (`CORE/push/registration.ts:38`).
- Response: `{status:'success', message, deviceId:number}`, strictly validated (`:2513`). Non-2xx throws `Failed to register device: HTTP <status> - <description>`.
- **It does not call `assertInitialized()` or `init()`.** Host is `overrideHost ?? this.host` (`:2492`). There is no `resolveHostForRecipient`, no `LookupResolver.query`, and no WebSocket.

**`listRegisteredDevices(overrideHost?, {limit?, offset?})`** — `LIB/MessageBoxClient.js:2540-2563`.
- Request: `GET ${host}/devices[?limit=&offset=]`.
- Returns `RegisteredDevice[]` (`types.d.ts:212-221`): `{id, deviceId|null, platform|null, fcmToken, active, createdAt, updatedAt, lastUsed}`.
- `fcmToken` is a masked token of at most 64 characters (`LIB/MessageBoxClient.js:283`).
  - The Go handler returns `"..." + last 10 chars` (`GO/pkg/handlers/devices.go:103-104`).
  - You can match only on the last 10 characters, never the full token.
- The Go `ListDevices` handler ignores `limit` and `offset`: it never reads the query string (`GO/pkg/handlers/devices.go:93`).

**`unregisterDevice` or any delete or deactivate call does not exist.**
- No `unregister`, `deregister`, `deleteDevice` or `removeDevice` appears in `dist/src/MessageBoxClient.js`, `dist/mod.js`, or `dist/umd/bundle.js`.
- The README lists only `/registerDevice` and `/devices` (`README.md:387-388`).
- The Go server routes are only `POST /registerDevice` and `GET /devices` (`GO/cmd/server/main.go:150-151`).
- The server only deactivates a token internally when FCM reports it invalid (`GO/internal/firebase/send_fmc_notification.go:79-84`).
- A device-removal flow is therefore not possible with the current library or server.

**Authenticated identity.**
- Both calls go through `authenticatedFetch` (`LIB/MessageBoxClient.js:687-695`), which wraps `AuthFetch.fetch`, so the identity is the wallet's BRC-103 identity key.
- The Go handler takes the identity from the handshake, not the body. `getIdentityKey(r)` returns `middleware.ShouldGetAuthenticatedIdentity(...).ToDERHex()` (`GO/pkg/handlers/helpers.go:127-133`), and the handlers return 401 if it is empty (`devices.go:25-27`, `:83-85`).
- The request body carries no identity. Whichever key signs the handshake owns the registration.
- The client also requires the server's reply to carry `x-bsv-auth-identity-key`. It pins that server identity per origin for the life of the client instance, and a later change throws (`LIB/MessageBoxClient.js:687-703`).

## 3. How a `MessageBoxClient` is constructed and what it needs

**Constructor** — `LIB/MessageBoxClient.js:583-600`, options in `LIB/types.d.ts:25-58`.
- Options are `{host?, walletClient?: WalletInterface, enableLogging?, networkPreset?, originator?, socketOptions?, serverIdentityKeysByHost?}`.
- Default host is `https://message-box-us-1.bsvb.tech` (`:38`). The wallet's own default is `https://messagebox.bsvblockchain.tech` (`CORE/pay/rails/handle.ts:29`). The wallet always passes a host, so the library default never applies on these paths.
- **Always pass `walletClient`.** If omitted, the constructor does `new WalletClient("auto", originator)` (`:595`).
- It builds `new AuthFetch(this.walletClient, undefined, undefined, originator)` (`:596`) and `new LookupResolver({networkPreset})` (`:598`).
- The `LookupResolver` constructor does no network I/O. It only validates config and creates caches (`SDK/overlay-tools/LookupResolver.js:828-868`).
- The constructor itself has no network or wallet side effects.

**`init()`** — `LIB/MessageBoxClient.js:625-639`.
- It validates the host and calls `getIdentityKey()`, which is one `wallet.getPublicKey({identityKey:true}, originator)` (`:672-684`).
- It does **not** advertise or anoint a host. The doc comment says so, and the code confirms it.
- `anointHost(host)` is explicit-only (`:1534`). It queries the overlay, lists the `overlay advertisements` basket, and creates and broadcasts a transaction.
- Nothing in `CORE` calls `anointHost` (grep over `*.ts` and `*.tsx`, excluding `node_modules` and worktrees).
- Overlay lookups (read-only `LookupResolver.query`) happen only on other paths:
  - `resolveHostForRecipient` (`:878`)
  - `queryAdvertisements` (`:894`)
  - `resolveMessageHosts` (`:1733`), used by `listMessages` (`:1688`)
  - `acknowledgeMessage` when no host is given (`:2000`)
- The device calls do not touch any of these when `overrideHost` is passed. The wallet always passes it (`registration.ts:38`).

**Which wallet methods the `registerDevice` path calls.** `AuthFetch` and `Peer` call these on the wallet:

| Method | Where |
|---|---|
| `getPublicKey({identityKey:true}, originator)` | `SDK/auth/Peer.js:983` |
| `createSignature` (protocol `[2,'auth message signature']`, counterparty = server key) | `SDK/auth/Peer.js:129`, `:306`, `:642`, `:825` |
| `verifySignature` | `SDK/auth/Peer.js:685`, `:778`, `:869`, `:931` |
| `createHmac` (via `createNonce`) | `SDK/auth/utils/createNonce.js:18`, called from `Peer.js:453`, `:613` |
| `verifyHmac` (via `verifyNonce`) | `SDK/auth/utils/verifyNonce.js:31`, called from `Peer.js:669`, `:769`, `:859`, `:922` |

These are called only conditionally:
- `listCertificates` and `proveCertificate` run only if the server requests certificates (`SDK/auth/utils/getVerifiableCertificates.js:40`, `:56`).
- `getPublicKey` and `createAction` for payment run only on an HTTP 402 (`SDK/auth/clients/AuthFetch.js:230`, `:601-633`).
- Both conditions are false for the Go server in this checkout:
  - It calls `middleware.NewAuth(w)` with no `WithAuthCertificatesToRequest` (`GO/cmd/server/main.go:163`).
  - Its payment calculator returns 0 (`GO/cmd/server/main.go:166-168`).
  - This holds only for this checkout. See section 6.

**Does a bare `ProtoWallet` suffice? Yes, for this path.**
- `ProtoWallet` implements `getPublicKey`, `createHmac`, `verifyHmac`, `createSignature` and `verifySignature` (`SDK/wallet/ProtoWallet.js:89`, `:184`, `:193`, `:210`, `:231`).
- Its constructor takes a `PrivateKey` and wraps it in a `CachedKeyDeriver` (`ProtoWallet.js:83-87`).
- `Peer` and `createNonce` pass an `originator` as a second argument. `ProtoWallet` methods take only `args`, so JS drops the extra argument. This is harmless.
- It is not a full `WalletInterface` at the type level (`message-box-client`'s `types.d.ts:30` wants `WalletInterface`). It needs a cast such as `as never`, which the app already does at `CORE/context/WalletContext.tsx:2110`.
- The identity is the same as the real wallet's.
  - The real `Wallet` builds `this.proto = new ProtoWallet(args.keyDeriver)` in its constructor (`@bsv/wallet-toolbox-mobile/out/index.mobile.mjs:12693+`).
  - Its non-privileged `getPublicKey`, `createSignature` and the other crypto calls delegate straight to `this.proto` (`index.mobile.mjs:12794-12800`, `:12843-12849`).
  - The app builds `keyDeriver = new KeyDeriver(new PrivateKey(primaryKey))` (`CORE/context/WalletContext.tsx:1335`).
  - So `new ProtoWallet(new PrivateKey(primaryKey))` yields the same identity key and the same handshake signatures as profile n's real wallet.
  - `deriveProfileKeys(...).identityKey` is exactly `primary.toPublicKey()` (`CORE/mnemonicWallet.ts:46-54`).
  - The privileged key (`m/1'/n'`) is not used for auth.
- A bare `ProtoWallet` bypasses the `WalletPermissionsManager` and `guardVaultAccess` wrappers. That is desirable here, since the vault guard refuses unoriginated calls (comment at `CORE/context/WalletContext.tsx:1941-1942`).

## 4. How the wallet builds the client today

**Push registration** — `CORE/context/WalletContext.tsx:2436-2450`:
```ts
makeClient: h => new MessageBoxClient({ host: h, walletClient: permissionsManager as never, originator: adminOriginator })
```
- It is wired once per build, after the supersession check (`:2436-2452`).
- `host` comes from `readMessageBoxHost()` (`:2004-2012`): `AsyncStorage.getItem(profileScopedKey(MESSAGE_BOX_URL_KEY))`.
  - `noMessageBox` gives `undefined`.
  - Empty, or the legacy URL, gives `DEFAULT_MESSAGE_BOX_URL`.
  - `profileScopedKey` defaults to the active profile (`CORE/profiles/profileStore.ts:198`), so each profile can have its own host.
- `identityKey` is `permissionsManager.getPublicKey({identityKey:true}, adminOriginator)` (`:2428-2436`).
- `originator` is `ADMIN_ORIGINATOR = 'internal-admin.bsv-wallet.invalid'` (`CORE/config.tsx:54`).
- `syncPushRegistration` (`CORE/push/registration.ts:21-52`):
  - It is idempotent via the single-slot marker described in section 0.
  - It never throws.
  - On failure it logs the message with the token, identity key and host redacted.
- It re-runs on:
  - the initial build (`WalletContext.tsx:2452`)
  - token refresh (`:2460`)
  - foreground resume (`:3388`)
- `teardownBuiltWallet` clears the push refs (`:2816-2818`).

**Other construction sites in `CORE`:**
- `PeerPayClient` for `TaskCreditInbox`: `{messageBoxHost, walletClient: permissionsManager as never, originator: adminOriginator}` (`WalletContext.tsx:2105-2111`).
- `PeerPayClient` for the outbox drain (`:2162-2166`).
- `makePeerPayClient`, a helper with the same shape (`CORE/pay/rails/handle.ts:40-56`).
- A lazy Mandala `MessageBoxClient`: `{host: mandalaEndpoints.messageBoxUrl, walletClient: bindOriginator(permissionsManager, adminOriginator), enableLogging:false}`, with no `originator` option (`WalletContext.tsx:1938-1946`).

All of them use the active profile's `permissionsManager` and the admin originator. None build a client from a raw key.

## 5. Recipe: authenticate and register as a non-active profile (client-feasible, not shippable as-is)

1. Derive at a point where the mnemonic is already in hand.
   - `getMnemonic()` calls `ensureUnlocked()` and may prompt for biometrics (`CORE/context/LocalStorageProvider.tsx:158-163`, perf comment at `WalletContext.tsx:2627-2629`).
   - The existing build path already holds it (`WalletContext.tsx:2631`).
   - Do not add a second prompt.
   - Build the root once with `hdFromMnemonic(mnemonic)`. PBKDF2 is the expensive step (`CORE/mnemonicWallet.ts:40`).
   - Then call `deriveProfileKeys(hd, n)` for each profile. `profiles/discovery.ts:39-42` already derives other profiles' `primaryKey` this way without building them.
2. Read the host with an explicit index: `AsyncStorage.getItem(profileScopedKey(MESSAGE_BOX_URL_KEY, n))`, then apply the same `NO_MESSAGE_BOX` and legacy-URL mapping as `readMessageBoxHost`.
3. Build and register:
   ```ts
   const proto = new ProtoWallet(new PrivateKey(primaryKey))
   const mb = new MessageBoxClient({ host, walletClient: proto as never })
   await mb.registerDevice({ fcmToken: token, platform }, host)
   ```
   - Passing `host` as `overrideHost` avoids any overlay lookup.
   - Do not call `init()` or `anointHost()`.
   - Use a fresh client each time. Each `AuthFetch` has its own session manager, so every registration does a full handshake to `${origin}/.well-known/auth` (`SDK/auth/transports/SimplifiedFetchTransport.js:88`) before the request.
4. Drop the key material afterwards.

**Why not to ship this as-is:** per section 0, this call would steal the token from the active profile. Any marker for it would need `profileScopedKey` plus an identity component. The server schema and the push payload would also need to change before multi-profile push can work.

## 6. Uncertainties

- I cannot confirm that the deployed `messagebox.bsvblockchain.tech` matches the `GO` checkout. The checkout is at HEAD `4179cd4` on `main`, clean, and includes the `RETURNING id` change.
- The "no certificate request, no 402" conclusions hold only for the server config in this checkout (`GO/cmd/server/main.go:163-168`). A server that requested certificates would hit `listCertificates`, which `ProtoWallet` lacks. I did not trace how `AuthFetch` fails in that case. It may hang until its timeout.
- I did not run any code. Everything is from reading source and dist.
- `@bsv/wallet-toolbox-mobile` line numbers refer to the bundled `index.mobile.mjs`, not original TypeScript.