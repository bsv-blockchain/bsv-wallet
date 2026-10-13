# Now-mode native app: feature mapping matrix

Date: 9 October 2026. Companion to [2026-10-09-now-app-handover.md](2026-10-09-now-app-handover.md), which defines the matrix columns and boundaries. Status: research complete. All 15 decisions were resolved by the product owner on 9 October 2026 (see **Decisions**). They take precedence over the matrix rows' categories, the baseline inputs and any earlier default.

## Baselines and agreed inputs

- **Application repository:** `vincemedia/bitcoinsv-wallet`, `main`. This is an initial-commit snapshot of `bsv-blockchain/bsv-wallet` at `0bea495`.
- **Demo:** `vincemedia/bitcoinsv-wallet-proto` at `e25ea8e`. Next.js 16. The scope is the `now` items in `lib/phase.ts:39-56`.
- **Scope:** the 14 Now features, plus the explainer/tour video. The dev phase switcher (`components/dev/`) and the password gate (`app/enter`, `proxy.ts`, `gate-form`) are excluded. Every Later item is excluded: topup, swap, withdraw, attachments, insights.
- **Identity:**
  - App name: Bitcoin SV Wallet.
  - Bundle ID / package: `com.bitcoinsv.wallet`.
  - Scheme: `bitcoinsv-wallet`.
  - Links: `bitcoinsv.com`.
  - Platforms: iOS and Android.
- **Assets:** BSV plus the stablecoin(s) the shared Mandala runtime already supports.
- **Backends:** BSVA's existing services. These are the handle registry, MessageBox/push, and backup. BSVA also owns the Sync spec. Until that spec exists, Sync gets its full UI behind an interface with a clearly labelled placeholder implementation.
- **Vault:** `vaultEnabled` is true in the new app's development and preview builds only. It is false or absent in production.
- **First real journey:** onboarding and backup.
- **Explainer video:** one config entry selects the source, poster and captions, so the video can be replaced without code changes.

Path prefixes used below: **A** = this repo; **T** = `packages/expo-wallet-toolbox`; **B** = demo repo. The demo mocks all state in `B/lib/stores/wallet-store.ts`: every transaction is `completed`, the fee is fixed, and the price is frozen. Nothing in B talks to a network, the chain or a signer. B's types do not match A's schemas.

## Cross-cutting findings

1. **Do not copy `A/eas.json`.**
   - Production sets `EXPO_PUBLIC_VAULT_ENABLED` and `EXPO_PUBLIC_PUSH_ENABLED` to `"true"`. That contradicts the comments at `A/app/_layout.tsx:60-72` and the Vault decision above.
   - Production also hard-codes `EXPO_PUBLIC_HANDLE_REGISTRY_DOMAIN: deggen.com`.
   - Write the new app's profiles from scratch.
2. **Storage isolation is not blocked by existing configuration.**
   - A has no app groups, keychain access groups or associated domains. Its entitlements contain only `aps-environment` and NFC `TAG`.
   - The new app must not reuse any of A's identity values:
     - `org.bsvblockchain.wallet`
     - the schemes `bsv-wallet`, `bsv-browser` and `peerpay`
     - EAS `projectId`, owner `bsvb`, `ascAppId`
     - the Firebase project `bsv-wallet-a8f1d` plist/json
3. **Keep wire-protocol constants identical** so that the two apps can pay each other:
   - Bonjour `_bsvpay._tcp`
   - Nearby `serviceId org.bsvblockchain.bsvbrowser.localpay`
4. **Settlement copy.** The demo says "Confirmed instantly" and "settled in N seconds" throughout. A's payments are asynchronous: MessageBox delivery, `sent-settling` / `sent-settled`, and parked/queued/offline states. All such copy must become truthful pending/final states.
5. **Secret handling gaps** to close in the new UI:
   - A has no screenshot protection: no `expo-screen-capture`, no FLAG_SECURE.
   - A's mnemonic screen copies to the clipboard with no auto-clear.
   - The demo stores the Sync key in plain `localStorage`. Any key must go in secure-store.
6. **Video dependency.** Neither `expo-video` nor `expo-av` is installed in A.
7. **In-app actions use the admin originator.** None of the money-movement features raise a connected-app permission prompt. The review step is the consent point and must stay explicit.

## Matrix

Categories:
- **E**: existing operation, new presentation.
- **X**: compatible shared extension.
- **D**: protected invariant or schema conflict requiring a decision.

### Money movement

| Now feature and demo evidence | Data and existing operation (A) | Category | Dependencies | Consent, failure and interruption states | Verification |
|---|---|---|---|---|---|
| **balances**: `B/app/(wallet)/page.tsx`, `coins/[id]`. Combined total, coin toggle, hide figures. *Later items inside: balance chart, Buy/Swap, Top up/Withdraw.* | `WalletHomeScreen.refreshBalance` (`T/ui/screens/WalletHomeScreen.tsx:591`), `useSpendableBalance`, `useMandala()` (`T/ui/hooks/useMandala.ts:122`), `MandalaRuntime.balances()`, `ExchangeRateContext`, `displayCurrencies.ts` | E. A cross-asset total and a privacy toggle are X (presentation only). "USDsv" naming vs generic Mandala assets needs copy/branding sign-off. | SQLite, Mandala overlay, FX (Frankfurter) | Unknown balance (`null` ≠ 0), stale or cached figures, FX fallback, unsettled/stuck token units, offline | `ui/Balance`, `tokenBalances`, `useSpendableBalance`, `AssetSwitcherDropdown`, `availableBalance`, `context/ExchangeRateContext`, `services/usdFxRates`, `context/mandalaAvailability` |
| **send**: `B/app/(wallet)/send/page.tsx`. Recipients → amount → confirm → done. Handle, address or key. Multi-recipient split. *Later items inside: auto-swap, photos.* | `PayScreen` → `UniversalSend` (`T/ui/components/pay/UniversalSend.tsx`). `classifyRecipientInput`, `searchIdentities`, registry `search`/`createRegistryResolver`, `sendViaHandle` (`T/core/pay/rails/handle.ts:429`, outbox written first), `sendToAddress`, `runtime.sendToHandle`, `retryDelivery`, `cancelOutboxPayment`, `userFacingPayError` | E for single-recipient send. **D:** multi-recipient split; X/Google "verified via" attestations vs A's registry certificate; bare `@name` vs `name@domain`; "confirmed in seconds" | MessageBox, handle registry + DoH, identity overlay, ARC/Arcade, WhatsOnChain, Mandala, camera | Resolving or not found, registry outage, registered vs unverified recipient, insufficient funds, offline park/queue, delivery failed with retry or cancel, token refused ("nothing was sent"), paused issuer, process killed between broadcast and delivery (outbox recovery). Never retry a possibly broadcast action. | `ui/universalSend`, `payScreen`, `recipientField`, `pay/{useRecipientInput,rails,handleRail,addressRail,outbox,tokenRails}`, `ui/tokenPay`, `identity/handleRegistry/*`, `ui/offlineNotice`, `monitor/taskSendOffline`, `offline/*` |
| **receive**: `B/app/(wallet)/receive/page.tsx`. The QR is fake (`fake-qr.tsx`). Optional amount and note, share link, public `/@handle` page. | `RequestHub` → `HandleReceive` (real QR of `peerPayLinkFor`, `handle.ts:80`; auto-credit via `internalizeIncoming`/`autoAcceptInbox`), `AddressReceive` (`getPaymentAddress`, `sweepAddress`), `monitor/TaskCreditInbox.ts` | E. Showing or encoding the human `name@domain` and a hosted public pay page are X; the public page needs a web/server owner. | `react-native-qrcode-svg`, Share, clipboard, MessageBox, WhatsOnChain, registry | Live "payment arrived", credit failure with retry or discard, no message box configured, notification advisory, offline, wrong-network address | `ui/handleReceiveLive*`, `requestHub`, `payReceivedOverlay`, `messageBoxConfig`, `notificationAdvisory`, `pay/{handleInbox,addressDerivation,receiveHistory,sweeper}`, `monitor/taskCreditInbox` |
| **activity**: `B/app/(wallet)/activity/` with search, filters, day groups and export. Detail has status, WoC link, receipt links (`/r/[id]`, in-memory) and a scripted support agent. *Later items inside: swap rows, photos.* | `listActions` paging on Home, `ActivityRow`, `txStatusView` (`T/ui/txStatus.ts:55`), `useTokenActivity`, `activityFilter.ts`, `TransactionDetailScreen` (presented by Home, deliberately not a route), `exportTransactions.ts` | E for list, detail and export. **D:** making detail a standalone route (Home owns the overlay-authoritative cancel path). Receipt links and per-transaction export exclusion are X; receipts need a backend. The support agent is out of scope unless approved. | SQLite, Mandala settlement store, WhatsOnChain, receipts backend (TBD) | Paged loading, parked/queued/rejected/unsent rows with send-now/resend/cancel, token settling/stuck/refused/reversed, corrupt-pending and eviction notices | `ui/{activityFilter,activityRowParked,activityRowSigil,txStatusView,transactionDetailAmount,detailActionKeys,tokenActivity,tokenRowStatus,tokenRowTitle,homeBadges,exportTransactions}`, `offline/{cancelParked,parkedAdvance}` |
| **contacts**: `B/app/(wallet)/contacts/`. Search, favourites, soft remove with undo, rename, Pay/Request shortcuts, shared history. | `createContactsStore` (`T/core/contacts/contactsStore.ts:101`), `ContactsScreen`, `ContactScreen`, `NewContactScreen`, `getContactActivity`, `contactAddLinkFor` | E for list, detail, search, add, rename and history. Pay-from-contact via `/pay?identityKey=` is X. **D:** favourites and soft remove need new columns on the shared `contacts` table (`createTables.ts:381`). | SQLite, identity overlay, registry, camera | Search outage, lookup failed vs none, duplicate contact, handle changed or released, name vs cached-handle spoofing guard | `contacts/{contactsStore,contactActivity,contactCache}`, `ui/{contactScreen,newContactHandle,resolveIdentity}`, `identity/contactLink` |
| **request**: receive link with amount, `ShareRequestSheet` to contacts, `RequestDialog`. Each writes a fake pending "request" transaction. Remind and cancel are scripted. | Only a pull request exists: amount carried in the QR or link (`peerPayLinkFor` `sats=`/`asset=&amount=`) and prefilled on the payer side (`UniversalSend` `initialSats`) | E for the amount-in-link subset. **D:** pushing requests to contacts needs a new MessageBox message type, a persisted request entity, payment matching, and remind/cancel. | MessageBox, push, link/redirect server for `bitcoinsv.com` request links (none exists) | Delivery failed, expired, cancelled, partly or over paid, declined, offline queue | `ui/requestHub`, `pay/{peerPayUri,handleRail,nativeIntent}`, `ui/universalSend` (prefill). None yet for push requests. |

### Onboarding and recovery

| Now feature and demo evidence | Data and existing operation (A) | Category | Dependencies | Consent, failure and interruption states | Verification |
|---|---|---|---|---|---|
| **welcome**: `B/app/welcome/page.tsx` (3 "why" screens, Sign in → import), `onboarding-gate.tsx`. Free handle generated in `wallet-switcher.tsx:280-335` (`<adj><animal><nn>`, 2 rerolls); custom handle via `handle-rules.ts`. | `createNewWallet` (`T/core/recovery/createWallet.ts:61`), `registerHandle`/`resumePending` (`registration.ts:399,603`), `checkAvailability`; called today from `ProfileScreen` | E for the screens. Handle generator, auto-claim at onboarding and an app-wide `onboarded` flag are X. **D:** handle rules (B: 1–30 chars `[a-z0-9_]` with paid short handles; A: 3–32 chars `[a-z0-9._-]`, no billing) and registry domain `bitcoinsv.com` (A uses `deggen.com`). | Handle registry server (profile certificate, DoH) | Availability loading/failed/offline, pending journal resume, `rolled_back`, `clock_ahead`, cooldown, process death mid-onboarding | `identity/handleRegistry/{registration,rules,client,resolver,profileCert}`, `ui/profileScreen`, `recovery/createWallet`, `context/localStorageCreation` |
| **backup**: `B/components/backup-sheet.tsx` with phrase, slices or file, briefing, hold-to-reveal, biometric stand-in, nudge after top-up. | `readBackupMaterial`, `printRecoveryShares` (Shamir 2-of-3 QR pages), `backupAttestation` (`phrase`/`shares`), single caller `A/app/auth/mnemonic.tsx`; `BackupReminderSheet` | E for phrase reveal/confirm and printed QR shares. **D:** see the backup format table below. | `expo-print`, `expo-file-system`, `expo-clipboard`, `expo-local-authentication`, `expo-secure-store` | Biometric denied, print/share cancelled, save failed, backgrounding. The attestation must not be set before export or confirmation (process death must leave the reminder pending). Screenshot and clipboard policy. | `recovery/{shares,backupMaterial,sdkFree}`, `ui/{backupShares,printRecoveryShares,walletHomeBackup}`, `vault/backupAttestation` |
| **restore**: `B/components/import-wallet-sheet.tsx` with phrase, WIF/hex, slices (typed or scanned), file, Sync key, legacy wallet paths. Restored data is mocked. | `classifyImportInput` (64-hex key or BIP39 phrase only, `T/core/recovery/secret.ts:38`), `secretFromShares`, `recoverWallet`, `restoreWallet`, `restoreOnImport`, `collectShare`; `A/app/auth/{mnemonic,scan-shares}.tsx` | E for phrase, hex and QR shares. Typed WIF and legacy-path discovery are X (new classifier branches). **D:** file and Sync-key restore, typed slices, "add as another wallet" (A has a single seed and replaces it after `confirmReplace`). | Camera, document picker/file system, secure store + biometrics, backup server | `biometric-refused`, restore failed with retry/skip, unverified restore, no backup, share threshold/integrity/duplicate errors, offline during history replay, process death during replay, replace confirmation, secure phrase input | `recovery/{secret,restoreWallet,recoverWallet,shareCollector,useRecoveryDeps}`, `backup/{restoreOnImport,restore,restoreProofReconciliation}`, `ui/recoveryPrompts`, `context/switchProfile`, `profiles/scopedState`, `walletDbRegistry`, `vault/proofBar.cleanDeviceRecovery` |
| **sync** (BSVA spec; placeholder): `B/components/sync-setup.tsx` intro → scope → key → password → save → confirm → plan → terms → done. Paid ($1.99/mo). `lib/sync.ts` key format. | A already has a free, on-by-default encrypted backup log (`T/core/backup/`: `pushOnce`, frozen `BACKUP_PROTOCOL`, seed-derived keys, opt-out/erase in `WalletConfigScreen`) | X: full UI over a new `SyncService` interface with a placeholder implementation that never touches `core/backup/*`, the codec or the attestation schema. **D (for BSVA's spec):** separate random key vs seed-derived keys, "all" scope including keys, paid vs free default-on backup, the `sync` backup-method value. | BSVA server and billing (TBD), secure store | "Not available yet" placeholder, offline, Wi-Fi-only queued, payment failed or cancelled, how it relates to the existing backup opt-out | `backup/{codec,derive,push,client,status,preference,erase,appData,task,estimate}` (guards unchanged formats), plus new interface contract tests |
| **getting-started**: `B/components/setup-checklist.tsx` (payment method, add money, back up, tour), `home-tour.tsx` (overlay over `data-tour` targets), Settings → Take the tour. | Back-up tick maps to `backupAttestation.get/needsReminder`. No checklist or tour exists. | E for the backup tick. Checklist and tour flags are X (per-profile keys via `profileScopedKey`). Drop "Add money" (Later). "Payment method" has no Now meaning; drop it or redefine it. | None. RN measures targets with refs / `measureInWindow`. | Reduced motion, layout changes mid-tour, backgrounding, per-profile vs per-device state | `ui/walletHomeBackup`, `vault/backupAttestation`, `profiles/scopedState` |
| **explainer video**: `B/components/tour-video.tsx` (full + mini PiP, autoplay fallback, CC toggle, review prompt at end), captions overlay `tour-subtitles.tsx` from `tour-captions.json`. Assets in `B/public/videos/`. | None | X (app-local). Add `expo-video`. One config entry: `{ source, poster, captions }`. Use MP4/H.264 (iOS cannot play WebM). Port the caption overlay rather than relying on VTT. A remote URI avoids bundling 12 MB. | `expo-video` (new dependency) | Loading, failed to load or offline, muted autoplay fallback, backgrounding, reduced motion, screen-reader captions | Device check on both platforms; swap the config entry to confirm the video is replaceable |

#### Backup format conflicts (demo vs A)

| Topic | Demo | A (protected) |
|---|---|---|
| Secret per wallet | Separate 12-word phrase per wallet | One mnemonic. Profile *n* = `m/0'/n'` (`T/core/profiles/profileStore.ts`) |
| Slices | 3 slices, any 2 restore. 20-character typed codes | Shamir 2-of-3 over entropy + checksum. `base58.base58.threshold.integrity` strings printed as QR pages. Restore is by scan only. 24-word phrases are refused for shares. |
| File | Encrypted JSON (PBKDF2 310k → AES-GCM) with several wallets; handles stored in plaintext | Plaintext `.txt` of the mnemonic saved to a user-chosen folder. No encrypted file format exists. |
| Phrase check | 3-word quiz | 15 s handwriting delay, then "I've written it down" |
| Copy | "They can't be copied" | Copy-to-clipboard button exists |
| Backup record | `phrase / file / slices / sync` | `BackupMedium = 'phrase' / 'shares'`, `v:1` |

### Native and hardware

| Now feature and demo evidence | Data and existing operation (A) | Category | Dependencies | Consent, failure and interruption states | Verification |
|---|---|---|---|---|---|
| **pay** (in store): `B/app/(wallet)/pay/page.tsx`. Explainer, fake OS prompts, fake camera, hard-coded nearby merchants, instant settlement. (`B/scan` is scan-to-sign-in, not pay.) | `PayScreen` → `NearbyFlow` (`T/ui/components/pay/NearbyFlow.tsx`): `mintSession`, `buildPaymentFrame`, `selectTransport` (AWDL / Nearby / BLE / QR fountain), `finalizeDelivery`, `verifyFramePayment`, `claimAndSavePending`, `processPending`, `queuePendingAbort`, `holdSentPaymentOffline`, nearby/BLE permission helpers | E for paying after scanning the payee's QR, over radio or QR. **D:** passive discovery of nearby tills without a QR (every A session is bootstrapped by a payee-minted pairing QR with a PSK); NFC tap-to-pay (NFC is only a reserved capability bit); paying merchants directly from the vault (blocked by `guardVaultAccess`); "confirmed instantly". | `react-native-localpay-transport`, `expo-camera`, BLE/Nearby/local-network permissions, Bonjour `_bsvpay._tcp` | OS denied → Settings, BLE drop mid-send, already paid (success), declined or unsealed frame, QR fallback, offline hold, background/unmount mid-send, process death (persist-then-burn), never retry a possibly delivered build | `localpay/*` (session, build, verify, verifyFrameEndToEnd, pending, pendingAborts, pendingAbortAuthority, transportSelect, transportBle, race, blePermissions, prepareBle, settlementAck, airGap), `offline/{payerHold,hold,queueGrace}`, `pay/{nearbyRail,nativeIntent}`, `monitor/taskSendOffline`. Hardware log rows on the new bundle ID: iOS↔iOS, Android↔Android, locked screen and negative cases are still pending in `2026-09-02-ble-hardware-log.md`. |
| **notifications**: `B/lib/notify.tsx` (in-app toast + sound only), "Payment alerts" toggle (local). No push, no OS prompt. | `A/utils/push/firebasePushAdapter.ts` → `configureToolbox({push})`; `core/push/registration.ts` (`syncPushRegistrations` → MessageBox `registerDevice`), `profilePush.ts`, `events.ts` `attachPushHandlers`; in-app credit toast and sound (`WalletContext` TaskCreditInbox); Settings permission row, `NotificationAdvisoryModal` | E for the in-app toast, sound and Settings row. A demo-style rich toast (avatar + amount) is X (`onToast` is string-only). **D:** production push delivery is off until MessageBox can deliver. The demo's "Product news" toggle has no backing. | `@react-native-firebase/{app,messaging}`, a new Firebase iOS and Android app for `com.bitcoinsv.wallet`, an APNs key for the new bundle, production `aps-environment`, MessageBox credentials covering the new Firebase app | OS denied (sticky), open from killed app, push for an inactive profile, registration failure/timeout, no secrets in notification content. Confirm MessageBox routes per token, not per identity, when one identity is installed in both apps. | `push/{registration,events,identities,profilePush,pushAdvisory}`, `monitor/taskCreditInbox`, `toolboxConfig`. Device check: open a push from a killed app on the new bundle ID. |
| **vault** (dev/preview builds only): `B/app/(wallet)/vault/page.tsx` (one-key setup after a 2.2 s timer, "Open vault" as a spendable side), `vault-approval.tsx` (fake touch, no PIN), `vault-move-sheet.tsx` (move USD and BSV to any destination). | `VaultScreen`, `VaultTransferScreen`, `EnrollWizard`; `enrollKey`, `depositToVault`, `withdrawFromVault`, `relockVault`, `recoverVaultWithKey`, `requestVaultSigner`, `guardVaultAccess`, key removal; `VaultProvider`/`useVault`; gate `isVaultEnabled()` (default false) | E for enrolment, deposit, withdraw to own spending and the ceremony. **D:** one-key setup (`VAULT_MIN_KEYS = 2`); stablecoin in the vault (BSV-only, `VAULT_DEPOSIT_MIN = 100_000` sats); withdraw to other wallets or addresses (no destination parameter); vault as a spendable side; no PIN (the ceremony has `pin-entry`). | `react-native-yubikey` (YubiKit, NFC/USB-C), `withNfcReaderEntitlement` (enable NFC Tag Reading on the new App ID), ISO7816 AIDs, `react-native-secp-native`, `react-native-engine-native`, WhatsOnChain for recovery | Touch timeout, NFC lost, key removed mid-operation, relock on timeout or detach, PIN retries / PIV reset consent, partial enrolment resume, held deposit resolution, offline refusal, wallet change mid-operation (`assertVaultScope`). Physical hardware evidence is not established. | `vault/*` (ceremony, ceremonyHost, transfers, guard, r1comb, vaultKeyService, chainRecovery, restoreSalt, abortAccounting, pivReset, pivResetConsentCopy, devMock, driver, mockYubiKey, vaultStore, xq016…), all `vault/proofBar.*`, `toolboxConfig`, `packages/react-native-yubikey/tests/iosAttestationSmoke.swift`. Physical YubiKey over NFC and USB-C on the new bundle ID. |

Test paths are relative to `T/__tests__/` unless they start with `packages/`.

## Decisions

Resolved by the product owner on 9 October 2026. Where a decision differs from a matrix row above, the decision wins.

| # | Area | Decision | What it means for the build |
|---|---|---|---|
| 1 | Backup slices | Printed Shamir 2-of-3 QR shares; restore by scanning only | Existing `printRecoveryShares` / `scan-shares`. No typed slice codes. |
| 2 | Backup file | Keep the demo's file UI. Save and restore are placeholders until a spec exists. | App-local UI behind a placeholder interface. No new file format in the core. |
| 3 | Phrase | One mnemonic covers all profiles | Copy explains this. No per-wallet phrases. |
| 4 | Confirm | Demo's 3-word quiz; copy button kept; no screenshot protection | Quiz is new presentation. The backup attestation is set only after the quiz passes. |
| 5 | Restore | Phrase, hex key, QR shares; replace after confirmation | Existing `classifyImportInput` / `recoverWallet` / `confirmReplace`. |
| 6 | Sync | Free, on-by-default encrypted backup now; paid plan later | The Sync UI presents the existing `core/backup` log (preference, status, erase). Paid plan is a placeholder. No new key format. |
| 7 | Handles | 1–32 characters, A's character set (`[a-z0-9._-]`), domain `bitcoinsv.com`. Paid, time-limited registration UX with placeholder BSV/Stripe capture. | Shared extension: per-app minimum length (the existing app keeps 3). Needs registry server support (BSVA). Production profile uses `bitcoinsv.com`; registry URL TBD. Payment capture is a placeholder. |
| 8 | Send | One recipient (multi is Later). IdentityClient attestations stay. Bare `@name` means `@name@bitcoinsv.com`. | Existing single-recipient send. App-level default domain for bare names. |
| 9 | Request | The amount-in-URL request the app already ships, optionally delivered via MessageBox. Pull-money is Later, maybe never. | Existing `peerPayLinkFor` link. MessageBox delivery of the link is a compatible extension (new message type). |
| 10 | Contacts | Favourites and soft remove with undo | **Schema extension:** additive columns on the shared `contacts` table, with a migration and defaults. Existing app behaviour unchanged. |
| 11 | Activity | Detail is its own route; WhatsOnChain links; no hosted receipts. Support agent is Later. | The route must reuse Home's overlay-authoritative cancel handling for parked/outbox payments. No receipt backend. |
| 12 | Pay | Scan the payee's QR, then radio or QR fountain | Existing `NearbyFlow`. No passive discovery and no NFC tap-to-pay. |
| 13 | Notifications | Production push via MessageBox, including product updates | `EXPO_PUBLIC_PUSH_ENABLED` is true in every profile. Push wires in once this app's own Firebase registration exists. Product updates need a sender outside MessageBox (open question). |
| 14 | Vault | A's ceremony: 2+ keys, BSV only, withdraw to own spending, PIN. Dev/preview builds only. | Existing Vault operations; `vaultEnabled` false in production. |
| 15 | Copy | Demo's instant-settlement framing | Demo tone and claims ("Seconds to settle", "under a cent") in product copy. Every real payment still shows its true pending, failed or settled state, per the handover's acceptance criteria. |

### Open questions for BSVA

- The `bitcoinsv.com` handle registry host URL, and whether the server accepts 1–2 character names.
- Who sends product-update pushes (MessageBox delivers payment messages only).
- Firebase iOS/Android registrations and an APNs key for `com.bitcoinsv.wallet`, and confirmation that MessageBox can deliver production pushes to them.
- Specs for the backup file (2) and the paid Sync plan (6), and the payment provider for paid handles (7).

## Next step

Handover step 2: create the new app shell and build target with the identities above, private storage and a fresh `eas.json`. Then demonstrate side-by-side installation with the existing app on iOS and Android before starting the onboarding and backup journey.
