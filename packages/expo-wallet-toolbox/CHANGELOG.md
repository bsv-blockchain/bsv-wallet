# Changelog

## Unreleased

### @bsv dependency bump (breaking for hosts)

Peer ranges move to `@bsv/sdk` ^2.8.0, `@bsv/wallet-toolbox-mobile` ^2.13.2,
`@bsv/message-box-client` ^2.5.1, `@bsv/templates` ^1.10.2,
`@bsv/btms-permission-module` ^1.2.1 and `@bsv/air-gap` ^0.1.3.

Hosts must carry this repo's `patches/` for those exact versions:
`@bsv/wallet-toolbox-mobile` 2.13 ships as one bundle whose exports map exposes
only its root, so the package now imports everything from the root, and the
toolbox patch also exports `WalletMonitorTask`, `attemptToPostReqsToNetwork`,
`parseJsonRpc`, `stringifyJsonRpc` and `verifyUnlockScripts`, which upstream
leaves internal. The Vault hooks, sendMax approval amounts and native-crypto
routing live in the same patches. `@bsv/templates` 1.10.2's CommonJS build is
broken under Node without its patch (bundlers resolve the ESM build).

- `ADMIN_ORIGINATOR` is now `internal-admin.bsv-wallet.invalid`. @bsv/sdk 2.8
  accepts only canonical hostnames as originators, so the old
  `urn:bsv-wallet:internal-admin` label rejected every internal wallet call.
  `parseExternalOrigin` refuses the whole `.invalid` TLD, and pending aborts
  queued under the old label replay under the new one
  (`LEGACY_ADMIN_ORIGINATOR`).
- `OfflineFirstChaintracks` takes an optional third `chain` argument and
  answers `getChain` from it; an unsupported subscription resolves to an inert
  id instead of throwing. The toolbox Monitor awaits both inside every
  `runOnce` since 2.13, so a throw there stopped every monitor task.
- Header validation uses the toolbox's `validateHeaderProofOfWork`, which
  checks the compact target encoding and honours its consensus exceptions.

## 0.6.0

### Handle registry (breaking)

Handle registration talks to go-message-box-server's paymail profile registry
instead of a certifier that was never deployed. A handle is now
`handle@domain`: a self-signed BRC-52 profile certificate the registry stores
and anybody can verify. Spec:
`docs/superpowers/specs/2026-09-18-handle-registry-client-design.md`.

Removed exports and configuration:

- `core/identity/handleCertificate.ts` in full — `HANDLE_CERT_TYPE`,
  `HandleCertWallet`, `isValidHandleFormat` (the 3-20 rule),
  `HandleAvailability`, `checkHandleAvailability`, `registerHandle`,
  `RegisterHandleResult`.
- `ToolboxConfig.handleCertifier`, `HandleCertifierConfig`,
  `getHandleCertifierConfig`. Neither the type nor the getter was on the
  public barrel; the config key was.

New:

- `ToolboxConfig.handleRegistry?: Partial<Record<AppChain, HandleRegistryConfig>>`
  and `getHandleRegistryConfig(chain)`, both exported from the `core` barrel.
  Fail-closed: a malformed or half-stated entry reads as no registry. `https`
  is required except for localhost and RFC 1918 hosts in development.
- `mergeContactCache` / `ContactCache` (`core/contacts/contactCache.ts`).
- `core/identity/handleRegistry/` — `rules`, `profileCert`, `resolver`,
  `client`, `registration`. Not on the barrel: the UI in this package is the
  only consumer, and the surface is still settling.

Behaviour:

- The display name is **public** when set: a plaintext field of the profile
  certificate, and the default name someone sees when they add you. The
  in-app hint says so, in all 12 languages.
- Profile shows `handle@domain`, and the registry — not
  `profile_registered_handle` — is the source of truth for which handle this
  key holds, so a restored wallet gets its handle back.
- Every write is journaled in `key_value_store` (`profile_handle_pending`) and
  replayed on the next Profile mount, so a crash, a double tap or a lost
  response settles to the same state.
- Pay's recipient search gains a registry tier between contacts and the
  overlay, and `RecipientField` shows its loading spinner as a footer instead
  of replacing the list — the local contacts tier is no longer hidden for the
  whole debounce.
- A query that is a complete `handle@domain` answers that row and nothing
  else. The registry's own search is a prefix, skeleton and substring search,
  so a typed address would otherwise be answered with its neighbours and its
  look-alikes.
- `contacts.cachedHandle` has a production writer for the first time: the
  `handle` route param on `/contact/add` (validated as a paymail — the route
  is deep-linkable), and `ContactScreen`'s background refresh, which
  distinguishes "the registry says there is none" from "the registry did not
  answer" and only clears the column for the first.
- A handle is displayed without a prepended `@` wherever it already carries
  its own domain: Profile, Contacts, a contact, and the Identifier QR screen.

## 0.5.0

### 1-of-N YubiKey vault (breaking)

The vault is rebuilt around the P-256 comb verifier: each enrolled YubiKey
signs vault inputs on the card, and the K1 sealed-seed design is gone. Spec:
`docs/superpowers/specs/2026-09-09-r1-comb-vault-design.md`.

Removed exports (`core` barrel):

- `sealing` (`SEAL_INFO`, `softwareEcdh`, `sealVaultKey`, `unsealVaultKey`);
  `vaultDerivation` (`deriveVaultSeed`, `BIP32_KEYID_PREFIX`, `bip32KeyID`,
  `indexFromKeyID`, `randomDepositStartIndex`, `deriveVaultHD`,
  `depositPrivKey`, `depositPubKeyHash`); `vaultPassphrase`
  (`VAULT_PASSPHRASE_MIN_BITS`, `RECOMMENDED_WORD_COUNT`,
  `MINIMUM_WORD_COUNT`, `generatePassphrase`, `PassphraseVerdict`,
  `PassphraseTier`, `PassphraseStrength`, `normalizeVaultPassphrase`,
  `passphraseEntropyBits`, `checkVaultPassphrase`, `crackTimeSeconds`,
  `formatCrackTime`, `passphraseStrength`); `k1` (`K1_LOCK_LEN`,
  `K1_UNLOCK_LEN`, `VaultInstructions`, `encodeVaultInstructions`,
  `decodeVaultInstructions`, `buildVaultLockingScript`).
- `SealedBlob`; the error codes `seal-corrupt`, `bad-passphrase`,
  `bad-mnemonic`, `bad-derivation-index`, `backup-required`.
- `VaultKeyHandle`, `CeremonyController.requestKey`, `requestVaultKey`;
  `CeremonyStoreView.getSeal`.
- `enrollVault`, `recoverVaultHD`, `resealToNewKey`, `PendingEnrollment`.
- `sweepVaultWithHD`; `VaultSpendResult.remainingInputs`; the `reason`
  parameter of `depositToVault`; `VaultDriver.ecdh`; `vaultStore.getSeal` /
  `setSeal` / `takeNextIndex`; meta v4 (`VaultMetaV4`).

New:

- `r1comb`: `buildLock`, `bakedCommitments`, `commitment`, `buildUnlock`,
  `verifyVaultInput`, `sighashPreimage`, `signerDigest`, `pushTxDerCheck`,
  `compressPubkey`, the exact v6 `VaultInstructions` codec, `R1C_LOCK_LEN`,
  `R1C_UNLOCK_LEN` (on-chain format: spec
  `docs/superpowers/specs/2026-09-09-r1-comb-vault-design.md` §2; codec in
  `core/services/vault/r1comb.ts`).
- `vaultStore` meta v6: wallet-and-network-scoped `VaultKeyRecord`, recovery
  adoption state, two-phase removal tombstones, enrollment drafts and
  quarantine state; `isEnrolled()` is meta-only.
- `VaultKeyService`: `enrollKey`, `finalizeEnrollment(records)`,
  `addVaultKey`, `VAULT_MIN_KEYS`, `VAULT_MAX_KEYS`, `EnrollPhase`.
- Ceremony: `VaultSigner { serial, pubkey, sign(digest, progress?), release() }`,
  `CeremonyController.requestSigner(reason, chosenSerial)`,
  `requestVaultSigner`, `VAULT_INPUTS_PER_TAP`, `CeremonyState.progress`,
  `VaultProgress.signed/total`.
- Transfers: `depositToVault(w, adminOriginator, satoshis, opts?)` needs no
  hardware; `withdrawFromVault(w, adminOriginator, amount, reason,
  chosenSerial, opts?)`; `previewVaultWithdrawal(w, adminOriginator,
  chosenSerial, amount)` — the chosen key's selectable total, capped count
  and unreachable set without reserving or tapping, for the remainder
  confirmation before the tap; `relockVault`; `estimateRelockFee`;
  `getVaultKeyCoverage`; `orphanedIfRemoved`;
  `VaultSpendResult { txid, cappedInputs, unreachable }`;
  `VaultTransferOptions.vaultEnabled` and `backupEnabled`; error codes
  `not-released`, `backup-off`, `not-enough-keys`, `key-already-enrolled`,
  `too-many-keys`, `last-keys`, `relock-required`, `key-not-committed`,
  `key-cannot-cover`, `too-small-to-relock`, `bad-version`; `VaultError.details`.
- `configureToolbox({ vaultEnabled })` and `isVaultEnabled()` — the release
  gate (default off).
- `withKeySession(driver, work, onWaiting?, { nfcMessage?, attachTimeoutMs? })`
  rejects on `session-failed`, `detached` and the attach timeout instead of
  waiting forever; `VaultDriver.start` takes an optional `message`.
- Native: `startDiscovery(message)` sets the iOS NFC alert text from JS.
- `devMock`: `setMockPresentKey`, `getMockPresentKey`, `MockPresentKey` —
  switch which of three dev keys is "held to the phone" without hardware.

Behaviour changes:

- Vault outputs and spends use transaction version 1. The exact lock is about
  45 KB and commits to every enrolled key. `VAULT_DEPOSIT_MIN` is 100,000 sat.
- Every output gets a 32-byte salt from wallet `createHmac` under
  `[2, "vault salt"]`, using counterparty `self`, the next canonical decimal
  key ID (`"1"`, `"2"`, ...), and the canonically framed ordered YubiKey
  serials as data. Authenticated current and historical scans rederive every
  claimed HMAC before its index can advance the high-water mark. Output records
  used for recovery or lifecycle mutation must also pass exact
  instructions-to-lock validation and wallet HMAC rederivation before cleanup,
  finalization, or metadata deletion. The in-process FIFO serializes simultaneous
  calls. Disconnected devices sharing a mnemonic can select the same next index;
  the same wallet/index/key set can therefore
  reproduce a script, including across networks. Such outputs remain separate
  UTXOs spendable only by their committed keys. The lock contains only
  `HASH160(salt || canonicalTable(Q))` commitments; its 71-push unlock reveals
  the salt as a final, exact 32-byte item. The salt is a privacy aid, not an
  access-control requirement, and the HMAC is one-way: it does not recover its
  serial-number input. Exact lock sizes are 45,199 bytes for one key and
  `45,175 + 25N` for two through five keys; the measured unlock maximum is
  2,539 bytes under the existing 2,560-byte declaration.
- Inventory scans consume each page as it arrives: current-output BEEF pages use
  64 outputs, script-bearing action-history pages use 8 rows, and lightweight
  action-history pages use 200 rows. A withdrawal retains full proofs only for
  its at most 32 selected inputs. Compact identity, salt and pagination sets can
  still grow with history; there is deliberately no total-history cap that can
  hide an otherwise valid Vault output.
- Vault output creation requires a configured private-backup endpoint and
  enabled encrypted backup push. This configuration gate does not prove that
  the exact new record reached the backup host; the asynchronous backup system
  exposes no per-action receipt. A deposit or output-producing spend is built
  and signed as `noSend`, its exact
  signed AtomicBEEF is revalidated, and that exact txid is then released with
  `sendWith`. A signed held action discovered after a crash is neither aborted
  nor automatically rebroadcast; it requires manual network-state
  reconciliation. The toolbox release flag still defaults off (`not-released`);
  the app's EAS production profile now enables it explicitly for TestFlight and
  production builds.
- Vault recovery ignores completed pre-release Vault action history before
  interpreting source scripts, so historical labels cannot make the newly
  enabled Vault screen fail on entry. Pending current-template actions remain
  subject to exact-script validation.
- Disabling a drained Vault reads only live actions as reservations. Storage
  restores the sources of a terminally failed action and clears their
  `spentBy`, so an aborted withdrawal or re-lock lists no inputs at all;
  requiring exact R1C sources from it reported empty history as malformed
  (`template-invalid`) and refused to disable an empty Vault for good. Exact
  source-script validation and the failed-action blocker now apply to pending
  actions and to failed actions that still list inputs — the shapes that can
  actually hide a Vault output. Completed history no longer has its inputs
  interpreted; its outputs are still authenticated. A failed disable check
  also reports its own error instead of claiming the Vault still holds funds.
- HMAC salt derivation requires the wallet root, numeric ID, and complete
  ordered serial list, and does not reconstruct an exact lock by itself.
  Clean-device recovery also needs the ordered historical P-256 YubiKey
  public-key descriptor and transaction discovery; current recovery obtains
  that data from authenticated wallet history.
- Withdrawals name a key before the tap; only outputs committed to that key
  are spent, each checked against its real lock; the card signs one digest
  per input in batches of 16 per NFC tap, resuming after a dropped tap.
- Enrollment always generates a fresh P-256 key in PIV slot `0x82`.
  `generateVaultKey` verifies the same-session pinned Yubico attestation, exact
  key and PIN-once/touch-cached policy. The enclosing enrollment flow changes a
  factory-default PIN when needed, rotates the PUK, replaces the default
  management key and proves possession. Recovery adopts a surviving card only
  after a fresh possession challenge.
- `enrollKey` refuses a serial already in the stored key list itself
  (meta ∪ `pendingSerials`), inside the card session and before the PIN is
  spent or the slot is regenerated; `finalizeEnrollment` refuses
  (`key-already-enrolled`) while a vault is already enrolled, so Finish never
  replaces a live key list.
- Vault format v6 is future-only. Earlier experimental metadata and outputs are
  rejected; there is no decoder, migration, staging reclaim or compatibility
  spend path.

### Vault UI (breaking)

- `EnrollWizard` is the sequential multi-key wizard (`mode: 'enroll' | 'add-key'`):
  intro with the acknowledgement, one card session per
  key with the PIN gathered before the tap, naming, Add another / Finish with
  two keys minimum, leave-confirm while keys are pending.
- `VaultScreen` shows the key list (`nickname · …serialTail4`), coverage badges,
  add / rename / remove (refused when a re-lock is needed first), the re-lock
  sheet, an **Export wallet data** row with its explainer, the footnote and
  disable-when-empty. Deposit runs the lazy wallet-creation path.
- `VaultTransferScreen` renders the deposit floor and fee inline, confirms the
  first deposit and a below-floor remainder, lets the user choose the key
  before a withdrawal, and reports unreachable and capped outputs as alerts.
- `VaultCeremonySheet` shows `Signed k of n` and the batch number between taps.
- New exports: `KeyChooser`, `vaultKeyLabel`, `vaultErrorCopy`,
  `RETRYABLE_VAULT_ERRORS`, `useExportWalletData`, `useVaultCoverage`.
- Removed exports: `PassphraseField`, `PhraseBackupSheet`, `VaultRecoverScreen`
  (there is no phrase path). Hosts must drop their `vault-recover` route.
- The home Vault button and the Settings Vault row render only when the host
  passes `vaultEnabled: true` to `configureToolbox`.
- i18n: the wizard, key-management, transfer-confirmation and error keys added
  in all twelve locales; the K1/passphrase-era keys removed.

### Expo SDK 57 (breaking)

Peer ranges move to Expo SDK 57 / React Native 0.86: every `expo-*` peer is
`~57.x`, `react-native` `^0.86.3`, `react-i18next` `^16.6.6` (TypeScript 6
peer range), `@react-native-community/netinfo` `^12`,
`react-native-gesture-handler` `~2.32`, `react-native-safe-area-context`
`~5.7`. New peer: `@bsv/mandala` `^0.2.0`. iOS deployment target is 16.4, the
SDK 57 minimum. `StyleSheet.absoluteFillObject` is gone in RN 0.86; this
package uses `absoluteFill`.

### Stablecoins (Mandala)

Stablecoin acceptance and transfer on top of the `@bsv/mandala` token client,
pay-first UX, recipient-submits offline settlement (specs:
`docs/superpowers/specs/2026-09-15-mandala-*`).

- **Host config.** `configureToolbox({ mandala })` takes a per-chain map of
  `MandalaEndpointConfig` (`overlayUrl`, `overlayIdentityKey` — the only key
  an admission signature may come from — and `messageBoxUrl`). The map is
  the whole policy: a chain with no entry has no runtime, no drain and no
  token asset offered; nothing is hardcoded to mainnet. `getMandalaEndpoints`,
  `isMandalaAvailable`, `isVaultAvailable` exported.
- **Storage.** Four settlement tables (`token_settlements`,
  `token_admissions`, `token_admission_edges`, `token_linkage_payloads`),
  created by `createTables`; `ensureTokenSettlementColumns`,
  `createMandalaSettlementTables`, `createSettlementStore`,
  `TokenTransactionRepair`, `findOfflineActionByTxid`, `OfflineTokenDeps`.
  Basket `p mandala` behind `MandalaTokenModule` with a one-time basket
  migration; paired apps are prompted for list, spend, credit and relinquish
  and never receive unlocking derivations.
- **Settlement.** The drain submits ancestors parents-first and broadcasts
  only after admission; three structural guards keep token transactions away
  from any plain broadcast, including the receiver's first internalize.
  `abortAction` on the published manager refuses a reference whose settlement
  row is held, handed_over, submitting, admitted or broadcast
  (`wrapAbortActionForSettlements`, `abortIsBlockedBy`); an admitted answer
  with no verifying σ_I is never `admitted`; every held coin gets a verified
  admission fetched and cached on the tick; `repairAdmittedAborted` re-attaches
  a transaction the wallet failed but the overlay admitted.
- **Rails.** Handle rail is hand-over-first: build and sign (noSend), assemble
  the admission bundle from local evidence, post the v2 MessageBox body; the
  send path never contacts the overlay. An online payer then settles at once
  (`MandalaRuntime.settleNow`); offline, the drain finishes later.
  PaymentFrame v4: `admissions[]` replaces `recipientLinkage`; the payee runs
  COVER at hand-over against its own configured overlay key and refuses frames
  naming another. Nearby token payments are denominated in the asset, labelled
  `mandala` on both sides, and a payee-first submit is resolved via
  `GET /admin/admission/:txid` instead of looping.
- **Runtime and UI.** `MandalaRuntime` is the one surface the UI reads
  (`useMandala`, `MandalaProvider`, `useTokenActivity`); nothing above it
  imports `@bsv/mandala`. New `ui` exports: `AssetAmount`, `AssetPicker`,
  `AdmissionNotice`, `tokenFormat` (`formatTokenAmount`, `parseTokenAmount`,
  …), `tokenStatus`, `tokenSeen`, `tokenEviction`, `tokenSendCopy`,
  `tokenRowTitle`. Balances read every page of the basket, not the first
  1000 outputs. Sent token rows carry a minus sign.
- **Core exports.** `./mandala/types`, `drain`, `bundle`, `createRuntime`,
  `abortGuard`, `settlementStore`; `./offline/tokenFrames`;
  `cancelParkedPayment`; `./services/externalOrigin`.

### Payments

- **Sender note** on nearby (BLE/QR), address and message-box token payments;
  the note becomes the recipient's activity description. Nearby
  `FRAME_VERSION` 4 → 5 with an optional `note`; `sendToAddress` takes a
  `note` (local only); `sendToHandle` forwards it to `transferTokens`. Token
  activity rows now show the note instead of a fixed ticker template.
- **Token requests in peerpay links**: `asset=<txid.vout>` names a token by
  genesis outpoint, `amount=` its base units; `sats=` selects BSV; mixing is
  refused. Get paid emits them for a selected token. `PeerPayRequest` exported.
- **Resend a token transfer** over the message box from the activity row,
  rebuilt from the payer's blinding journal and cached admission, journaled
  first so a failed send is retried by the drain.

### Home screen

- Coin switcher is a filled accent pill in the top bar (the title doubles as
  the control) opening a dropdown card with a tail; the bottom drawer and the
  Balances section are gone. Token holdings remain in Pay's asset picker and
  Activity. Pay form order: Recipient, Paying with, Amount, Pay.
- `useWalletStatus` / `WalletStatusSlice` exported from `core`.

### Storage

- `listOutputs` and the wallet balance count outputs of a transaction at
  `sending` (already posted, not yet `unproven`), matching what
  `allocateChangeInput` was already willing to spend; `listOutputsSql` shares
  `walletBalanceSql`'s one status list. A vault re-lock remainder no longer
  reads as 0 for a few seconds.
- Received token frames round-trip every byte field through the pending
  queue; the settlement store refuses non-byte or empty payloads and reads
  back the TEXT rows already on Android devices; `build.ts` aborts its own
  noSend action when a step after `createAction` fails.

### Vault fixes

- A key can be removed while the vault holds a balance: broadcast statuses
  (`sending`, `unproven`) no longer block `beginVaultKeyRemoval`; the re-lock
  sheet names the remaining keys.
- Enrollment names keys itself (Key 1, Key 2, …) instead of stopping on a
  naming page; rename from the vault screen. `vault_name_title` /
  `vault_name_hint` removed from all locales.
- A re-lock records `Vault relock` as its action description instead of the
  NFC prompt copy.
- Guarded in-app PIV application reset for a previously used key
  (`./services/vault/pivReset`), refused for keys mid-removal, on other
  chains, or holding an unknown vault key. The vault is mainnet-only.

### Fixes

- **Short nearby-payment notes** no longer fail internalize forever. A note
  under 5 characters (a lone 🪿) is truthy after trim, so the fixed fallback
  never applied and `internalizeAction` rejected the description on every
  retry; `processPending` now pads to 5 like `build.ts` and `handle.ts`.
- **Import wallet data** works again for files exported since the wallet
  database moved to WAL mode (`9ef35665`, 2026-09-02). Every export — the iOS
  byte copy and the Android `serializeAsync` image — carries SQLite header
  bytes 18/19 = 2 (WAL). `deserializeDatabaseAsync` loads the image under
  SQLite's memdb VFS, which has no `xShmMap`, so the pager's WAL open failed
  with SQLITE_CANTOPEN "unable to open database file", surfacing from
  `backupDatabaseAsync`. The import now runs the bytes through the new
  `prepareSqliteImageForDeserialize` (`core` barrel), which returns a copy
  with those two bytes set to rollback-journal mode; the image is already
  complete (export checkpoints first), so nothing is lost. Non-SQLite input
  passes through untouched so SQLite still reports the real error.

## 0.4.0

### Host-supplied configuration (breaking)

- Add `configureToolbox({ backupUrl, services })`, with `getBackupUrl`,
  `getServiceConfig` and `isToolboxConfigured`. The host states its backup
  endpoint and per-chain service URLs and keys once, at app entry.
- Remove `DEFAULT_BACKUP_URL` and every `process.env` read in the package.
  Expo's Babel preset does not inline `EXPO_PUBLIC_*` for files under
  `node_modules`, so those reads were `undefined` in the production bundle of
  any host that installed this package from npm — disabling backup entirely
  and leaving the WhatsOnChain/Taal key unset, while working in dev and in
  hosts that consume the package from source.
- `backupUrl` is required and takes `null` to disable backup deliberately.
  Reading configuration before `configureToolbox` runs throws, so an
  unconfigured build fails loudly instead of imitating a disabled one.
- Backup URLs are validated as bare origins: a path, query or fragment is
  rejected, since the BRC-103/104 handshake posts to the origin root.

## 0.3.1

### Wallet creation and backup

- Add `useLocalStorage().createMnemonic` for new wallets. It refuses to
  replace an existing encrypted or legacy identity, waits for migration,
  and blocks overlapping creation attempts. Identity checks propagate
  storage errors instead of treating unreadable keys as an empty wallet.
- Wallet Home waits for migration and wallet construction before offering
  creation or import. Backup reminders now require an explicit pending
  record for a newly created identity; existing wallets without historical
  backup metadata no longer receive a false warning.
- Add `backupAttestation.markPending` and `needsReminder`. Recording a
  backup clears the pending reminder, and logout clears both record types.
- Advanced Settings replaces Copy Secret Words and Print Recovery Keys
  with Backup Wallet Keys, linking to `/auth/mnemonic?flow=backup`, with
  translations in all twelve supported languages.

### Pairing

- Connections accepts both `bsv-wallet://` and `bsv-browser://` pairing
  codes. Forwarded pairing parameters retain reserved characters in
  topics, origins, protocol identifiers, and signatures.

### Host app integration

- The mnemonic backup page and native URL registration remain owned by
  the host app. Its `/auth/mnemonic?flow=backup` route must display the
  existing identity, and new-wallet creation should use `createMnemonic`.
  The confirmation delay, export actions, and back button are implemented
  in the BSV Wallet app rather than shipped in this package.
- Hosts accepting both URL schemes must register them in their native
  configuration and rebuild the app. BSV Wallet routes external pairing
  links through `app/+native-intent.ts` to `/connections`.

## 0.3.0

### Breaking

- `INBOX_DESCRIPTION` is removed from `core/pay/creditInbox` (and so from the
  `core` barrel). Inbound peer rows are now described by the sender's note or,
  failing that, the sender's abbreviated identity key, so the fixed default
  string has no remaining use.
- `internalizeIncoming` and `acceptWithRetry` in `core/pay/rails/handle` no
  longer take a positional `description`. The signatures are now
  `internalizeIncoming(wallet, client, adminOriginator, payment, repairBeef?)`
  and `acceptWithRetry(client, messageBoxUrl, payment, internalize)`, with
  `internalize: (p: IncomingPayment) => Promise<void>`. A JavaScript caller
  still passing the old fifth argument would hand `acceptWithRetry` a string
  where it expects the `internalize` function and every inbox credit would
  throw; TypeScript callers see an arity error.

### Activity

- Activity rows show a deterministic sigil avatar for the counterparty in the
  tile where the direction arrow used to sit. The face is derived from the
  counterparty's identity key when the row records one (a pubkey label on an
  outbound peer payment, or `senderIdentityKey` on an inbound one), else the
  address from a `to:`/`from:` label, else the txid, so two payments to the
  same key wear the same face. Direction stays on the tile's border tint, and
  a row with nothing to identify the other side keeps the arrow. The address
  sweep's sentinel `senderIdentityKey` (the pubkey of private key 1) is not a
  counterparty and falls through to the txid. Each face also has its own
  colour: the hue is taken from the four bytes before the shape seed
  (`counterpartyHue`), so shape and colour vary independently, and
  `sigilPalette` turns it into a per-theme symbol and tile pair (pale tile
  and deep symbol in light, deep tile and bright symbol in dark) that is
  contrast-checked to at least 4.5:1 for every hue in both themes.
- Default action descriptions are now the payment note, else the resolved
  name, else the abbreviated identity key or address, instead of a rail name.
- `listActions` rows expose `senderIdentityKey` (from
  `outputs.senderIdentityKey`) alongside `reference` and `created_at`, and
  `ActivityAction` declares it.
- Address-rail rows carry `to:` (outbound send) and `from:` (inbound sweep,
  the payer's zeroth-input P2PKH address) labels, so the address rail has a
  counterparty to show as well. The payload after the prefix is the address's
  version byte and hash160 as 42 hex characters, built by `addressLabel` and
  decoded back to base58 by `counterpartyOf`: the wallet folds every label to
  lower case before storing it (`@bsv/sdk` `validateLabel`), which a base58
  spelling does not survive but hex does.

### Amounts

- Fiat amounts follow the satoshi sign convention: a leading minus for money
  out and, where the caller asks for it, a leading plus for money in.
  Accounting parentheses are gone. The sub-cent marker keeps its form with the
  sign on the figure, e.g. `< -$0.01`.

### Trust network

- Provider icons load through `expo-image` instead of React Native's core
  `Image`, so a BRC-68 manifest that advertises an SVG icon (for example
  `https://auth.sigmaidentity.com/manifest.json`) passes validation and
  displays instead of failing with "icon image URL is invalid". `prefetch`'s
  boolean result is preserved, so an unavailable image still rejects.
  Contributed in #12 by @rohenaz. SVG icons themselves are drawn with
  react-native-svg's parser (`SvgUri`) rather than handed to the platform
  decoder: iOS's decoder ignores percentage-positioned `<text>`, which is how
  Sigma's mark is authored, and rendered it as a black square.
- The built-in certifiers now show their icons. The screen kept a local
  `Certifier` type that read `icon`, while the wallet's settings type and every
  shipped default store the URL as `iconUrl`, so the defaults always fell to
  the initial-letter placeholder. The screen now uses the settings type,
  accepts entries an older build saved under `icon`, and writes `iconUrl` back
  on save (`normaliseCertifier`).
- A certifier icon that fails to load falls back to the initial-letter tile
  instead of an empty square. Two shipped defaults point at `.ico` favicons
  the iOS decoder rejects, and any provider can move its file.
- Sigma Identity (`auth.sigmaidentity.com`) ships as a default certifier,
  below the existing three in trust order. Two stores are involved: the Trust screen's list
  is hydrated from AsyncStorage and an existing wallet keeps its saved list
  there, while the wallet's identity resolution (`discoverByIdentityKey` and
  `discoverByAttributes`) reads the toolbox's WalletSettingsManager store,
  which this app never writes, so for resolution the shipped defaults,
  Sigma included, apply to every wallet. That split predates this release.

### Peer dependencies

- New peer `@urbit/sigil-js` (^2.2.0), imported only through its `./core`
  entry. It ships CJS, so a consumer's Jest `transformIgnorePatterns` needs no
  change; see the README's Jest configuration section.
- New peer `expo-image` (~55.0.11). Its package entry is raw TypeScript that
  Jest does not transform, so the toolbox requires it lazily at render and
  call time; a consumer's Jest config needs no change.

## 0.2.2

### Fixes

- `AppLogo`'s rotation now sets `isInteraction: false`. `Animated.timing`
  registers an InteractionManager handle for the duration of the animation, and
  `Animated.loop` means that duration never ends — so the handle was held for
  as long as the component stayed mounted, and while any handle is held
  `InteractionManager.runAfterInteractions` never fires for *anyone* in the
  process. `Balance` renders `<AppLogo rotate />` whenever a balance is loading,
  so this was reachable in normal use: `PayScreen`'s deferred proof sweep never
  ran, and a host that defers real work the same way could hang indefinitely
  with no error and no timeout. Long-standing; found by the bsv-browser session,
  where a dApp's `listOutputs` hung forever behind a loading spinner.

## 0.2.1

### Payments

- The corrupt-pending-queue notice now has a body. `readUnprocessedPending`
  quarantines an unparseable `localpay_pending` blob under a timestamped
  `localpay_pending_corrupt_*` key and clears the live queue, but the card only
  rendered a title ("Damaged payment data was found on this device"), so a user
  carrying incoming payments was told nothing about what happened to them. The
  new `pay_offline_kv_corrupt_body` (all twelve locales) says the payments were
  set aside rather than deleted, and that a sender should be asked to send again
  only if their payment is still missing — a quarantined entry may already have
  been credited, and a blind re-send is the failure worth steering away from.

## 0.2.0

Released from bsv-wallet master, tag `expo-wallet-toolbox-v0.2.0`. Contains
everything merged since 0.1.3, not only the API change below.

### Breaking / API

- **`dismissTo` props are now typed `DismissTarget` (expo-router's `Href`)**
  instead of `string`, on `PayScreen`, `PaymentSuccessOverlay`, `NearbyFlow`,
  `AddressReceive`, `HandleReceive` and `UniversalSend`. A host with
  `experiments.typedRoutes` enabled narrows `Href` globally to its own route
  union, which made a `string` prop unassignable inside this package's own
  files (TS2345); `skipLibCheck` cannot suppress it, because the package ships
  raw `.ts`. Typed-routes hosts now get their route strings checked at the call
  site; hosts without it see `Href` ~ `string`. `Href` also admits the object
  form `{ pathname, params }`, so the accepted type widens — hence the minor
  bump. `DismissTarget` is exported from the `ui` barrel.
  - Note: the props still default to `'/'`. A typed-routes host with no `/`
    route must pass its own value.

### Wallet build and restore

- `WalletContext` destroys an unpublished `StorageExpoSQLite` when a backup
  restore fails, so a retry does not open a second connection to the same
  database file.
- The `SimpleWalletManager` builder rejects instead of resolving `null` on
  failure. The manager authenticates on any resolution, so a failed restore
  could previously mark a wallet built.
- A failed mnemonic build no longer falls back to a stored recovered key: only
  genuinely missing mnemonic material allows the WIF path, so a partial replay
  stays failed and retryable instead of being built over.
- `restoreFromBackup` intent is preserved across an automatic build (only an
  explicit options object now overwrites it).
- `restoreOnImport` passes the device manifest through to the restore.
- `reconcileRestoredProofs` runs after a restore, so a replayed unsent request
  cannot rebroadcast an already-completed transaction. It calls
  `storage.findProvenTxReqs` and `storage.findProvenTxs` — a real widening of
  what the `StorageExpoSQLite` argument must implement. Hosts passing a test
  double or a narrower shim through a cast will need both.
- `RemoteSyncReader` pages the backup index (the server caps a page at 500
  entries) and fails when the index ends before its advertised head, instead of
  treating a truncated wallet as a successful restore. It publishes only a
  fully verified index, advances only after both download and decryption
  succeed, and prefetches at most one small (<= 1 MiB) chunk ahead, storing
  failures as values so a stopped replay leaves no unhandled rejection.
- Backup client requests are bounded by a single deadline covering both the
  request and the body read (React Native's XHR fetch resolves before its
  Blob/FileReader conversion finishes), so a stalled transfer cannot strand the
  monitor.

### Payments

- `creditInboxOnce` rechecks the in-flight slot after each wait, so several
  manual retries queue behind one pass rather than racing.
- The peerpay outbox serializes each storage's whole read-modify-write, not
  just the final write, so a send and the background retry/prune task cannot
  overwrite each other's checkpoints and tokens. Mutations fail closed on an
  unreadable queue rather than treating it as empty, and payment IDs are chosen
  against the live queue so same-millisecond sends stay distinct.
- localpay BLE transport wraps native calls in a promise helper; socket
  transport reliability fixes.

### Storage and UI

- `getLabelsForTransactionId` and `getTagsForOutputId` resolve their
  associations in a single joined query instead of one bridge round trip per
  row.
- `ActivityRow` compares every prop when memoizing, so a retained row cannot
  invoke a previous network's handler or show a stale busy label.
- `useSpendableBalance` / `useVaultBalance` serialize reads and retain the
  latest invalidation, never read or cache a previous chain's storage during a
  network rebuild, and hide the old figure immediately on switch.

## 0.1.3 and earlier

Not recorded here; see git history.
