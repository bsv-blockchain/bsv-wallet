# Push-notification client map (read-only; branch `feat/multi-profile`, working tree clean at start)

Path roots:
- **T** = `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox`
- **APP** = `/Users/personal/git/bsv-wallet`
- **GO** = `/Users/personal/git/go/go-message-box-server` (branch `main`)
- **MBC** = `APP/node_modules/@bsv/message-box-client/dist/src/MessageBoxClient.js` (v2.5.3)
- **WC** = `T/core/context/WalletContext.tsx`

## 1. Registration

**Where it is wired**
- Inside `buildWallet`, at WC:2403-2461.
  - It runs after the supersession check at WC:2396.
  - It is wrapped in `if (phoneStorage)` at WC:2424.
  - Both refs are cleared by every teardown, so a superseded build cannot leave its refs behind (WC:2415-2418).
- `pushDetachRef` and `pushSyncRef` are declared at WC:760-761.

**Which identity**
- The identity is the active profile's primary-key public key, read at WC:2431 via `permissionsManager.getPublicKey({ identityKey: true }, adminOriginator)`.
- This is the same value as `KeyDeriver(new PrivateKey(primaryKey)).identityKey` (WC:1335).
- It is also the value stored in `ProfileRecord.identityKey` (WC:2538, `profileStore.ts:34-35`).

**Which client**
- A fresh `MessageBoxClient` per sync run, built at WC:2442-2447 with `{ host, walletClient: permissionsManager, originator: adminOriginator }`.
  - `permissionsManager` is the raw `WalletPermissionsManager` (WC:1828), not the `guardVaultAccess` wrapper (WC:1904).
- It never calls `init()` and sets no `serverIdentityKeysByHost` pin. The server identity is pinned per origin per instance only (MBC:687-700).
- The call is `registerDevice({ fcmToken, platform }, host)` at `T/core/push/registration.ts:38`. No `deviceId` is sent.

**Auth**
- BRC-103 mutual auth through `AuthFetch` (MBC:596, 687-695).
- The response must carry `x-bsv-auth-identity-key`.
- The signing wallet is the active profile's wallet.

**Which host**
- `readMessageBoxHost` (WC:2004-2011) reads `profileScopedKey(MESSAGE_BOX_URL_KEY)`.
  - `NO_MESSAGE_BOX` gives `undefined`, which makes sync return `skipped`.
  - An unset or legacy value falls back to `https://messagebox.bsvblockchain.tech` (`T/core/pay/rails/handle.ts:28-34`).
- `profileScopedKey`'s default index is `state.active`, evaluated at call time (`profileStore.ts:198`). The host lookup is therefore implicitly "the active profile".
- It does not read the Mandala `messageBoxUrl`. All hosts in `eas.json` are currently identical, so this is latent.

**`syncPushRegistration` (`registration.ts:21-53`)**
1. It returns `skipped` if the adapter, host or identity is missing.
2. It returns `skipped` unless `adapter.getPermission() === 'granted'` (line 33). Nothing registers before the user grants permission.
3. It returns `skipped` if `getToken()` gives null.
4. The marker is `` `${host}|${identityKey}|${token}` ``. If it equals the stored value, the result is `unchanged` with no network call.
5. Otherwise it calls `registerDevice`, then writes the marker.
6. On failure it logs a redacted message and returns `failed`. The marker is left untouched, so the next trigger retries.

**The marker**
- Key `push_registration_v1` (`registration.ts:4`) is a single slot.
- It is not profile-scoped and holds the FCM token, identity key and host in clear AsyncStorage.
- The only code that references it is `registration.ts` (repo grep). Logout's AsyncStorage sweeps match only these patterns (WC:3548-3580):
  - `cached_wallet_balance_*`
  - `/__p\d+$/`
  - `backupCursor-*`
- So the marker survives Delete Wallet. This is functionally harmless: a new identity differs from the marker and re-registers.
- `docs/superpowers/specs/2026-10-01-multi-profile-design.md:84,152` describes the single slot and re-register-on-switch as intended.

**When it re-runs**
1. At the end of every build: `void syncPush()` at WC:2452. That means every profile switch, network switch and rebuild.
2. On token refresh: `adapter.onTokenRefresh` → `syncPush` (`events.ts:80`, WC:2460).
3. On return to foreground from `inactive` or `background`: `void pushSyncRef.current?.()` at WC:3388, inside the `wasBackground && isNowForeground` branch (WC:3365).
4. Granting permission does not itself trigger a sync. PayScreen (`T/ui/screens/PayScreen.tsx:643-648`) and SettingsScreen (`T/ui/screens/SettingsScreen.tsx:157-168`) only call `requestPermission` and update their own state.
   - A grant therefore lands only via trigger 3 or the next build.
   - Whether the OS permission dialog moves AppState through `inactive`/`background` on each platform is **unverified**.

**Serialisation**
- `coalesceRuns` (`events.ts:118-141`) never runs two syncs at once. It folds overlapping calls into one rerun and gives up on a run after `PUSH_SYNC_TIMEOUT_MS` = 30 s (`events.ts:90-107`).
- It is created per build, and a run cannot be cancelled. Teardown clears the refs at WC:2816-2818, WC:3432-3434 and WC:3469-3471, but cannot stop a run already in flight.

**Does it ever unregister? No.**
- The client library has only `registerDevice` (MBC:2484) and `listRegisteredDevices` (MBC:2540). A grep for unregister/delete found nothing.
- The server routes are only `POST /registerDevice` and `GET /devices` (`GO/cmd/server/main.go:150-151`).
- The server deactivates a row only when FCM reports an invalid token (`GO/internal/firebase/send_fmc_notification.go:77-89, 158-160`). The next `registerDevice` re-activates it (`GO/pkg/storage/sqlstore/queries.go:425`, `active = TRUE`).
- `PushAdapter` has no `deleteToken` (`T/core/push/types.ts:16-31`).
- Logout and Delete Wallet therefore leave the token bound to the departed identity until another identity registers the same token.

**Enablement**
- `APP/app/_layout.tsx:143` wires `firebasePushAdapter` only if `EXPO_PUBLIC_PUSH_ENABLED === 'true'`.
- Per `APP/eas.json`:
  - `development` (line 18), `dev-physical` (line 38) and `production` (line 61) are true.
  - `production-apk` extends `production` (line 88).
  - `preview-apk` has none.
- The comment at `_layout.tsx:66-71` still says production does not enable push. It is stale against `eas.json:61`.
- `T/core/push/pushAdvisory.ts` is a global, device-level "advisory shown" flag only.

## 2. Host push adapter

**Adapter** (`APP/utils/push/firebasePushAdapter.ts`, `@react-native-firebase/messaging` 26.4.0, modular API)
- Token: `getToken(getMessaging())` (lines 43-49), returning null on any throw. One FCM token per install.
- Permission:
  - iOS maps `AUTHORIZED` and `PROVISIONAL` to `granted` (lines 18-22, 37-42).
  - Android below API 33 is always `granted`.
  - Android 33 and above uses `POST_NOTIFICATIONS` through `PermissionsAndroid` (lines 24-31).
- `onTokenRefresh` is line 50, `onNotificationOpenedApp` is line 51, `getInitialNotification` is line 52, `onMessage` is line 53.
- `toEvent` stringifies every `data` value (lines 15-16).

**Background and killed**
- `APP/index.js:127-137` registers a no-op `setBackgroundMessageHandler(getMessaging(), async () => {})`.
- Its comment says the server sends notification+data messages, the OS displays them, and "crediting happens when the user opens the app".
- There is no background crediting.

**Foreground**
- `events.ts:77-79` runs only `requestInboxPass`, which calls `TaskCreditInbox.requestNow()` (a static flag, `T/core/monitor/TaskCreditInbox.ts:56-60`).
- iOS suppresses the banner while foregrounded:
  - `APP/firebase.json:3` sets `messaging_ios_foreground_presentation_options: []`.
  - RNFB's native default is `None` (`RNFBMessaging+UNUserNotificationCenter.m:86-90`).
- Android foreground and background tray behaviour for notification+data messages is **not verified in this repo's source**.

**Tap**
- `events.ts:58-61` `opened()` runs two things:
  - `requestInboxPass`, which is `TaskCreditInbox.requestNow()` (WC:2458).
  - `openActivity`, which is `router.push('/transactions')` (WC:2459).
- `getInitialNotification` is read once per JS process, guarded by the module-global `initialConsumed` (`events.ts:3, 62-74`). iOS native also clears its copy on read (`RNFBMessaging+UNUserNotificationCenter.m:63-71`).
- Handlers attach only inside a completed build, so a cold-start tap is acted on only after the biometric unlock and build finish.
- Listeners are detached at teardown and re-attached at the next build (WC:2454-2461). A tap or foreground message during a profile-switch window is therefore dropped (my inference from the code; not tested).

**Platform config**
- `app.json`: `UIBackgroundModes: remote-notification`, and `aps-environment: development` in the iOS entitlements.
- No Notification Service Extension target exists in `ios/BSVWallet.xcodeproj/project.pbxproj` (grep for `NotificationService` returned nothing).

## 3. A push arrives for an identity that is not the active profile

**Can it arrive at all?**
- On the server, one FCM token maps to exactly one identity (see section 4). A successful switch re-registers the token under the new identity, because the marker mismatches (`registration.ts:36-37`).
- Pushes for the previous profile then stop being sent to this device. The design doc's "notifications for it are ignored" (spec line 152) is slightly off: they are not delivered at all.
- An inactive-profile push arrives only when the post-switch sync was `skipped` or `failed`:
  - permission not granted
  - offline
  - the 30 s timeout
  - the in-flight race described under Risks

**What the OS shows**
- Both the Android and APNs messages carry a notification/alert block, so the OS displays it with no app code (`GO/internal/firebase/send_fmc_notification.go:120-155`).
- The title is "Payment received" for `payment_inbox` and `mandala-payments`, and "New Message" for `notifications` (`GO/pkg/handlers/policy.go:34-42`). The body is always "Open the app to view it." (line 118).
- Nothing in the text names a profile.

**Payload fields**
- The data payload is `messageId` and `originator` (`send_fmc_notification.go:130-133, 149-152`).
- The sender builds `FCMPayload{Title, MessageID}` only (`GO/pkg/handlers/send_message.go:287-290`), so `originator` always arrives empty.
- There is no recipient and no box name in the payload.
- **The app reads zero payload fields.** `opened()` and the foreground callback ignore their argument (`events.ts:58-61, 78`), even though `types.ts:3-6` documents `data`.

**Active-wallet assumptions** (two, both implicit)
- `TaskCreditInbox.requestNow()` drives the monitor's inbox pass, which reads the active wallet's MessageBox via `PeerPayClient` with the active `permissionsManager` (WC:2100-2112).
- `router.push('/transactions')` shows the active profile's Activity.
- `onTokenRefresh` closes over that build's `syncPush`, so it follows the active profile too.
- Nothing maps a push to a profile or switches profile. Payments to an inactive profile stay in its MessageBox until the user switches to that profile and the next build's pessimistic `noteEnqueued` pass drains them (WC:2152).

## 4. Registering all profiles' identities under one device token

**Headline: the blocker is server-side, not client-side.**
- `GO/pkg/storage/sqlstore/queries.go:421-430` uses `ON CONFLICT(fcm_token) DO UPDATE SET identity_key = ?`.
- `GO/pkg/storage/sqlstore/sqlstore.go:201, 276` declares `fcm_token TEXT NOT NULL UNIQUE`.
- `GO/pkg/storage/mongostore/mongostore.go:459` keys the document by `_id: d.FCMToken`, and its `$set` overwrites `identityKey` (lines 462-472).
- So a token belongs to one identity. Registering N profiles under the same token is last-writer-wins, and only the final identity receives pushes.
- Client work alone cannot deliver all-profile push. It needs a server schema change to unique on `(identity_key, fcm_token)`.
  - `ListActiveDevices(recipient)` is already per recipient (`send_fmc_notification.go:50`), so fan-out would then work naturally.
  - `DeactivateDevice` and `UpdateDeviceLastUsed` are keyed by token only (`queries.go:480, 489`) and would need review.
- The routing gap from section 3 remains even after that fix. A tap cannot choose a profile unless the server adds the recipient identity key to the payload, which is feasible because `fr.recipient` is in scope at `send_message.go:287`. The client would then read `data.recipient` and map it to a profile through `ProfileRecord.identityKey`.

**Can the client register an inactive profile without building its wallet? Yes in principle.**
- `AuthFetch` and `Peer` need only `getPublicKey`, `createSignature`, `verifySignature`, `createHmac` and `verifyHmac` (my grep of `@bsv/sdk` 2.8.2 `auth/`).
  - `ProtoWallet` implements all five (`ProtoWallet.js:94-236`).
  - `createAction` is used only on the 402 payment path.
  - `listCertificates` and `proveCertificate` are used only if the server requests certificates.
- The Go server's auth is `middleware.NewAuth(w)` with no options (`GO/cmd/server/main.go:163`). Certificates are opt-in via `WithAuthCertificatesToRequest` (go-bsv-middleware v0.16.0 `pkg/middleware/auth-middleware.go:60-64`), so none are configured.
  - I did not verify the library's default config exhaustively.
- Identity match: `CompletedProtoWallet({identityKey:true})` returns the root public key (`@bsv/sdk .../auth/certificates/__tests/CompletedProtoWallet.js`). That equals the real wallet's identity for the same `primaryKey`.
- Precedents in this repo:
  - `T/core/backup/derive.ts:27-29` and `client.ts:58-62` already authenticate a server with a standalone `CompletedProtoWallet`.
  - `T/core/profiles/discovery.ts:38-47` derives other profiles' keys from the mnemonic without building their wallets.

**Mnemonic**
- Key derivation helpers:
  - `hdFromMnemonic` (one PBKDF2) and `deriveProfileKeys` (`T/core/mnemonicWallet.ts:41-54`) give the primary key and identity key for any index.
  - `profileScopedKey(base, n)` accepts an explicit index (`profileStore.ts:198`).
  - `readMessageBoxHost` would need an index parameter.
  - The marker would need to be per `(host, identity)`, not one slot.
- Where it is available:
  - `buildWalletFromMnemonic` has `mnemonic` in scope (WC:2631) and already hands it to `discoverProfilesRef` (WC:2724).
  - `buildWallet`, where push is wired, does not receive it.
- Source of `getMnemonic()`:
  - It comes from `useLocalStorage()` (WC:962, `T/core/context/LocalStorageProvider.tsx:158-163`).
  - It requires an unlocked KEK. The first unlock per process prompts biometrics via `autoUnlockKek` (`T/core/services/secrets/kek.ts:217-222`).
  - After that the KEK is cached in memory (`kek.ts:48-50`) and reads are prompt-free (`secrets/store.ts:47-49`).
  - `lockKek()` has no production caller (`\blockKek\(` grep, excluding tests), so the cache lasts until the process dies.
  - If the user cancels the initial prompt, `autoUnlockSpent` latches (`kek.ts:217-221`). `getMnemonic` returns null, no wallet builds, and nothing can register.
- Recovered-key (WIF) wallets have no seed. They get a single profile (WC:2756-2759), so this question does not apply to them.
- `ProfileRecord.identityKey` is set only after a profile's first build (`profileStore.ts:34-35`). A discovered-but-never-opened profile has none, but its identity is derivable from the mnemonic.
- Other costs:
  - The PBKDF2 and BIP32 cost on the JS thread is not measured here (see the `[perf]` breadcrumbs at WC:2627-2634).
  - Each unmarked identity costs a BRC-103 handshake plus a request.

## Risks/unknowns
1. **One token to one identity (hard server constraint).** Multi-registration is impossible without a server schema change. Moot until then: the client ProtoWallet, mnemonic access and per-identity marker work.
2. **No unregister anywhere.** There is no client method, no server route, and no `deleteToken` in the adapter. This matters for the relayed per-profile delete idea (delete only at zero balance). A deleted profile's identity would stay bound to the token, and the device would keep receiving "Payment received" for an identity the app no longer shows. Delete Wallet has the same property today.
3. **Payload cannot route to a profile.** There is no recipient and no box name, and `originator` is never set. Tap routing needs a server-side payload addition (`send_message.go:287`) plus a client handler change. `PushOpenedEvent.data` already carries arbitrary string fields, so the adapter needs no change.
4. **Stale-run race (plausible, not tested).**
   - `readMessageBoxHost` reads the host override for whichever profile is active at call time (WC:2428 → `profileStore.ts:198`).
   - An old build's in-flight `syncPush` cannot be cancelled, and `coalesceRuns` is per build.
   - So a slow run could register profile A's identity at profile B's host override, or land after B's registration while the marker says B.
   - It self-heals on the next trigger.
5. **Permission-grant gap.** Nothing syncs on grant. It relies on the foreground transition or the next build, and the platform-specific AppState behaviour is unverified.
6. **Android tray and foreground behaviour for notification+data is not verified in source.** The iOS foreground banner is suppressed.
7. **`aps-environment: development`** in the `app.json` entitlements versus EAS production signing is unverified. The server sets `MutableContent: true` "for NSE", but no NSE target exists.
8. **Marker hygiene.** The bare, unscoped key holds the token and identity key in clear text and survives Delete Wallet. Harmless today, but it needs rethinking for a per-identity marker.
9. **Mandala host.** Registration uses `readMessageBoxHost` only. If `mandalaEndpoints.messageBoxUrl` ever differs from it, `mandala-payments` pushes would have no registration there.
10. **`initialConsumed` is module-global.** After a switch, `attachPushHandlers` skips `getInitialNotification`. This is correct (the native side clears it too), but worth knowing.
11. **Certificate behaviour.** Not configured at `GO/cmd/server/main.go:163`. The library default was not exhaustively checked, and I did not run a live ProtoWallet handshake against the Go server.
12. **Doc drift.** `APP/app/_layout.tsx:66-71` contradicts `eas.json:61`. Spec line 152 ("ignored") contradicts the server behaviour above.