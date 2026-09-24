# Changelog

## 0.8.0

### Wallet recovery and creation module

Everything the host's mnemonic and scan-shares screens used to decide inline
— classify the import, store the secret, drop the other secret kind, build
or rebuild, read the backup-replay outcome, attest — now lives in
`core/recovery/` as plain functions over an injected deps object, unit-tested
without rendering a screen. The screens keep only rendering, haptics,
navigation and the small state machine that picks which view is shown; they
supply prompts and translate outcome codes.

New `core` exports (all re-exported from the package root, and, for the
share primitives, still reachable through `ui/backupShares.ts`):

- `secret.ts` — `WalletSecret` (`{kind:'mnemonic', mnemonic, identityKey}` or
  `{kind:'wif', wif, identityKey}`), `classifyImportInput(text)` (64-hex →
  wif, valid BIP39 phrase → mnemonic, anything else → `null`), and
  `secretFromShares(shareStrings)` (recombines shares into a `WalletSecret`,
  throwing exactly when the underlying Shamir recombination does).
- `restoreWallet.ts` — `RestoreWalletDeps`, `RestoreHistory`,
  `RestoreOutcome` and `restoreWallet(deps, secret, opts)`: one attempt at
  storing a secret, dropping the other kind, building or rebuilding, and
  attesting. Never throws — anything a dep throws comes back as
  `{kind:'failed'}`.
- `recoverWallet.ts` — `RestorePrompts`, `RecoveryOutcome` and
  `recoverWallet(deps, secret, opts)`: the retry/skip policy around
  `restoreWallet` (a refused biometric retries or cancels; a failed backup
  replay returns control to the caller's input or, on skip, re-attempts
  without asking for history replay).
- `createWallet.ts` — `CreateWalletDeps`, `CreateOutcome` and
  `createNewWallet(deps, opts?)`: the "generate a brand new wallet" path,
  guarding first against an already-built wallet or already-stored identity
  (`{kind:'exists'}`) before generating anything.
- `backupMaterial.ts` — `BackupMaterial` and `readBackupMaterial(deps)`, what
  the "view/export my recovery material" screen shows (mnemonic wins over a
  stored WIF; throws if neither is present).
- `useRecoveryDeps.ts` — the React hook (`useRecoveryDeps()`) wiring the
  above to `useWallet()`, `useLocalStorage()` and `backupAttestation`.
- `shares.ts` gains `ShareCompatibilityIssue` and
  `checkShareCompatibility(newShare, existing)`, returning a code
  (`'threshold-mismatch' | 'integrity-mismatch' | 'duplicate'`) instead of
  English prose; `shareCollector.ts` is a new pure reducer
  (`collectShare(collection, raw)`) for the scan screen's
  accumulate/dedupe/threshold logic, unit-testable without a camera.

`core/context/WalletContext.tsx`'s `WalletContextValue` gains
`getWalletBuilt(): boolean`, a ref-backed twin of `walletBuilt` for callers
that await a build across `recoverWallet`'s retry loop, where a captured
React state snapshot would go stale.

`ui/` gains `recoveryPrompts.ts` — `restorePrompts(t): RestorePrompts`, the
one copy of the biometric-refused and backup-replay-failed dialogs, exported
from the `ui` barrel next to `showAlert`.

### Share primitives moved to `core/` (deprecates `validateShareCompatibility`)

`ui/backupShares.ts`'s framing/padding/classification/split/recombine logic
(everything except `generatePrintHTML`, which stays in `ui/` as
presentation) moved to `core/recovery/shares.ts`, so the headless recovery
module can reach it without crossing the `core` → `ui` boundary (`core`
still never imports `ui/`). `ui/backupShares.ts` is now a re-export shim
(`export * from '../core/recovery/shares'`) plus `generatePrintHTML`, so
existing `@bsv/expo-wallet-toolbox/ui` consumers of the moved names are
unaffected. `validateShareCompatibility(newShare, existing)` is kept for
compatibility but **deprecated** in favour of `checkShareCompatibility`,
which returns a code the caller translates instead of English prose.

### Deep links: `resolveNativeIntent` and a wider `legacyRedirectTarget`

`core/pay/rails/nativeIntent.ts` adds `resolveNativeIntent(path, opts)`,
moved out of the host's `+native-intent` route resolution: it recognises the
toolbox's own `peerpay:` scheme and the host's own custom URL schemes, now
passed in as `opts.walletSchemes` instead of hard-coded, so a second wallet
app can reuse it with its own scheme names. `legacyRedirectTarget`'s `params`
widen from `Record<string, string | undefined>` to
`Record<string, string | string[] | undefined>`, so the three retired pay
routes can forward `useLocalSearchParams` straight through instead of
flattening array-valued query params themselves.

### `NativeHandlers.onDownloadFile` optional

`UserContext`'s `NativeHandlers.onDownloadFile` is now optional, backed by a
new `mergeNativeHandlers(partial?)` helper that fills in the no-op default
per field. A host that omits it no longer has to supply an all-or-nothing
`nativeHandlers` override just to skip that one handler.

### Copy and translations

- 8 new keys, in all 12 languages: `scan_shares_threshold_mismatch`,
  `scan_shares_integrity_mismatch`, `scan_shares_duplicate` (the
  `checkShareCompatibility` issue codes, translated by the scan screen),
  `import_invalid_input_title`, `import_invalid_input_message`,
  `import_setup_failed`, `create_wallet_refused`, `create_wallet_failed`
  (the mnemonic screen's import/generate failure copy). Non-English copy is
  machine-drafted and awaits native-speaker review, same as every previous
  translation batch in this changelog.

### Behaviour changes (breaking for hosts that relied on the old behaviour)

- Recovering or importing over an already-built wallet (e.g. onboarding's
  auto-created wallet) now **rebuilds** the wallet instead of silently
  no-op'ing. Previously `buildWalletFromMnemonic`/`buildWalletFromRecoveredKey`
  no-op when a wallet is already built, so recovering over one looked like a
  success while nothing changed; `restoreWallet` now calls `rebuildWallet`
  in that case.
- Storing one secret kind now **deletes the other**: after a successful
  restore, exactly one of the mnemonic or the WIF survives in storage.
  Previously, importing a WIF while a mnemonic was already stored left the
  mnemonic in place, and an auto-rebuild's "mnemonic wins" fallback would
  build from the stale mnemonic instead of the key just imported.
- A failed backup replay's "skip" now works for **hex (WIF) imports**, not
  only phrase imports — the old skip path was phrase-only, so a failed
  restore on a hex import previously left the user with no way forward.
- Attestation failure after an already-successful build is now
  **non-fatal**: a throw from `attest` is caught and reported as
  `attested: false` rather than turning the whole recovery attempt into a
  failure. The wallet is already built and usable at that point; the only
  consequence of an unrecorded attestation is that the backup reminder nags
  again later.
- Retrying after a failed backup replay now **returns to the input screen**
  on both the mnemonic and scan-shares screens, rather than looping on the
  same restore attempt — a server-side failure does not get better by
  retrying it in a tight loop in place.

### Nearby/QR payment verification (breaking: `DerivingWallet` gains `getServices`)

`core/localpay/verify.ts`'s `verifyFramePayment` BSV branch checked only that
the named output pays this device's derived key and carries a usable
satoshi value — never that the transaction's (or its ancestors') unlocking
scripts are valid, or that `sum(inputs) >= sum(outputs)`.
`internalizeAction`'s own gate is a pure AtomicBEEF-structure/SPV check with
no script interpreter, so a payer could spend a real mined UTXO it does not
own, with a garbage `unlockingScript`, into an output that locks to the
payee, for any amount, and have it credited offline. `verifyFramePayment`
now calls `tx.verify(chainTracker)` — the SDK's own end-to-end verifier —
against the same chain tracker `internalizeAction` itself consults
(`wallet.getServices().getChainTracker()`). It fails closed: an ancestor
present only as a txid throws rather than being silently skipped.

The `DerivingWallet` interface this module accepts gains a required
`getServices(): { getChainTracker(): Promise<ChainTracker> | ChainTracker }`.
The real `Wallet`/`WalletStorageManager` object `NearbyFlow` already passes
in satisfies this, so the app's own wiring needed no change — but **a host
that built its own object against the old, narrower `DerivingWallet` shape
(just `getPublicKey`) must add `getServices` or its build will fail to
typecheck.**

### Offline drain: an invalid foreign ancestor now cascades, not stalls forever

`core/offline/plan.ts`'s `outcomeOfForeignPost` only ever classified a
foreign-ancestor post as `'success'`, `'doubleSpend'` or `'serviceError'` —
never `'invalidTx'` — so an ancestor the network explicitly rejects as
invalid stalled the outbox drain forever instead of cascading the rejection
to the descendant that credited off of it. `PostedTxidResult` gains an
optional `serviceError` field (already set by the ARC adapter: exactly
`false` for an INVALID/MALFORMED/REJECTED verdict, `true` for a
transport/rate-limit/timeout issue), and `outcomeOfForeignPost` now returns
`'invalidTx'` exactly when `status==='error' && doubleSpend!==true &&
serviceError===false`. Absent or `true` — including a provider that never
sets the field — stays retryable, so the fix fails closed. `'invalidTx'` was
already a valid `PostOutcome` used by the owned-post path; this is what
makes a foreign ancestor reach it too, wiring up the existing
cascade-to-descendant handling rather than adding new machinery.

### Declined-payment watch and a safer parked cancel

Two related fixes in the local-pay/offline path, both detect-and-warn, never
block:

- `finalizeDelivery` (`core/localpay/build.ts`) treated a negative ack as
  trustworthy and unconditionally released the payer's inputs — true even
  when the decline happened offline, since the existing mandala abort guard
  only blocks an abort once the payer's own settlement row has already
  advanced to handed-over, which never happens on a decline. It now accepts
  an optional `watchDeclinedAbort?: (entry: { txid: string; reference:
  string }) => Promise<void>` dependency, called after every decline (BSV or
  token) it has a txid for, whether or not the abort itself succeeded.
  `core/localpay/pendingAborts.ts` gains a durable watch list
  (`queueDeclinedAbortWatch` / `verifyDeclinedAborts`, backed by a new
  `DECLINED_ABORT_WATCH_KEY` entry): it asks the network the same question
  `processOfflineActions.ts`'s `networkAlreadyHas` already asks, surfaces
  (and drops) a watched txid that reaches the chain anyway, and gives up
  unsurfaced after 7 days. `WalletContext` runs `verifyDeclinedAborts` at
  build time and on every reconnect, alongside the existing
  `replayPendingAborts`, and raises a background notice
  (`local_pay_decline_broadcast_title` / `_body`) if anything surfaces —
  never blocking.
- `cancelParkedPayment` (`core/offline/cancelParked.ts`) refused a parked
  cancel only via a token-only settlement-row check, so a parked BSV
  payment — or a token txid with no settlement row yet — could be cancelled
  and its inputs respent while the payee's own scanned copy might already
  be in flight. It now runs a chain-status check independent of any
  settlement row: online+known refuses as `'already-sent'`, online+unknown
  proceeds to `'cancelled'`, and genuinely offline refuses with a new
  `'unverifiable-offline'` outcome unless the caller passes
  `acknowledgedUnverifiable: true`. A new `runCancelParkedFlow` helper
  drives the confirm-and-retry UX, wired into `WalletHomeScreen`'s cancel
  action with the new `local_pay_cancel_unverifiable_*` keys and a
  destructive confirm.

`CancelParkedOutcome` gains a fourth member — **a host matching
exhaustively over the previous `'cancelled' | 'already-sent' | 'not-found'`
should add `'unverifiable-offline'`.**

### Received-payment overlay: a `verification` prop gates the green claim

`NearbyFlow` set the payee's success overlay to its green "Added to your
wallet" state as soon as the payment was durably queued, before
`internalizeAction` had necessarily run — if internalization later failed,
the overlay never retracted or recoloured, claiming a credit the device
could not back yet. `PaymentSuccessOverlay` gains an optional
`verification?: 'pending' | 'verified' | 'not-credited'` prop, defaulting to
`'verified'` so every existing caller is unaffected. The overlay's *timing*
is unchanged — still shown the instant the payment is durably queued; only
the claim is gated: `'pending'` shows a neutral "Confirming with your
wallet…" (`local_pay_received_confirming`) the moment it appears, resolving
to today's unchanged green copy on a genuine credit or a neutral "Not added
to your wallet yet" (`local_pay_received_not_credited`) otherwise. Ignored
on the payer side, where there is nothing left to confirm.

### Recovery: confirm before replacing an existing wallet (breaking)

Defense in depth against a deep link, or any other entry point, silently
overwriting a wallet whose phrase may be unsaved: `recoverWallet` now asks a
new `confirmReplace` prompt once, before the first `restoreWallet` attempt,
whenever `deps.hasStoredIdentity()` reports an existing secret already on
the device. Declining returns `{kind:'cancelled'}` before anything is
written; a biometric retry within the same call never re-prompts. This also
means the onboarding "replace an auto-created wallet" path sees the same
confirm, deliberately — any caller reaching this point already has a stored
identity to protect, in-app or not.

`RestoreWalletDeps` gains a required `hasStoredIdentity(): Promise<boolean>`,
and `RestorePrompts` gains a required `confirmReplace(): Promise<'replace' |
'keep'>`. **A host supplying its own `RestoreWalletDeps`, or building its
own `RestorePrompts` instead of using `ui/recoveryPrompts.ts`'s
`restorePrompts(t)`, must implement both** — the toolbox's own
`restorePrompts(t)` already does, wired to the new
`recovery_replace_wallet_title` / `_body` / `_confirm` keys, and treats a
dismissal as `'keep'` (never `'replace'`), matching the existing
dismiss-is-always-safe convention the biometric-refused and
backup-replay-failed prompts already follow.

Also in this pass: `createNewWallet` accepts an optional
`opts.cancelled?: () => boolean`, re-checked right after the identity guard
so a caller whose screen state changed mid-await (e.g. its route flipped to
the backup flow) does not generate or store anything against stale state;
`CreateOutcome` gains a `{kind:'cancelled'}` member for when it fires.
`classifyImportInput`'s hex branch now catches an SDK parse failure and
returns `null` instead of throwing, matching the mnemonic branch's existing
behaviour.

### Deep links: destructive recovery routes refused, pairing now requires approval

`resolveNativeIntent` (`core/pay/rails/nativeIntent.ts`) closes two related
gaps:

- An external `bsv-wallet://auth/scan-shares` or
  `bsv-wallet://auth/mnemonic?flow=import` link redirected straight into the
  destructive import screens with no confirmation. Both now redirect to `/`
  instead of passing through; `flow=backup` and every other route are
  unaffected. This is layer 1 of two — layer 2 is the confirm-replace guard
  above, which also refuses an in-app entry point.
- An external `pair` link used to be rewritten to `/connections`, whose own
  deep-link effect called straight into `connect()` with no user gesture in
  between. It is no longer rewritten: it now passes straight through to
  `/pair` (`PairScreen`), which already renders the same origin/permissions
  Approve/Reject card a scanned or pasted URI gets. `ConnectionsScreen`'s
  corresponding auto-connect `useEffect` was deleted — that screen now only
  ever connects from its own explicit scan/paste buttons.

No API surface changed, but **a host relying on an external pairing link
auto-connecting from Connections needs to account for it now landing on
`/pair` and requiring an explicit approval tap instead.**

### Secrets: a sentinel read failure no longer re-provisions the KEK

`putSecret` used a `null` sentinel read as its sole signal that no wallet
was ever stored, taking that straight into `provisionKek()`, which
unconditionally deletes both KEK keychain items before minting a new one —
so a transient sentinel read failure on an otherwise-existing sentinel could
orphan an already-sealed backup envelope beyond recovery. `readSentinel`
gains an `options?: { strict?: boolean }` parameter that rethrows instead of
swallowing to `null`; `putSecret` now reads it strictly and refuses the
write (returns `false` — the same externally-visible shape as a declined
biometric prompt) rather than re-provisioning on a thrown read. A genuinely
missing sentinel still provisions normally.

### Headers: the validated window is authoritative over a remote answer

`HeaderStore.rootForHeight` let a remote chaintracks answer permanently
overwrite an already PoW-validated window root on any disagreement —
reachable by a MITM absent TLS pinning, not only a compromised chaintracks
deployment. `HeaderStore` gains `isWindowBody(height)` and now treats the
window's own root as authoritative for its validated body
(`[baseHeight, tipHeight-6]`), ignoring any `extra`-cache entry there
outright. `OfflineFirstChaintracks.isValidRootForHeight` refuses a
body-covered mismatch outright — no remote lookup, no caching. The last-6
reorg tail, and any height outside the window entirely, are unchanged: a
mismatch there still falls through to the remote self-heal path exactly as
before.

### Wallet context: bounded auto-approve, private callback token, corroborated checks

Three fixes sharing `WalletContext.tsx`'s wiring:

- **Auto-approve** was a single global cooldown with no cumulative cap, so
  multiple paired origins could accidentally throttle each other while a
  single origin alone could still auto-approve up to the per-request
  threshold every cooldown window, forever. `core/services/autoApprovePolicy.ts`
  (`createAutoApprovePolicy`) replaces it: the cooldown is now keyed **per
  originator**, plus a global rolling 24h cumulative cap across every
  originator combined, `AUTO_APPROVE_DAILY_CAP_SATS` — **provisional**, set
  to 10x the default per-request threshold (1,000,000 sats at the shipped
  defaults) purely so it cannot bind in ordinary single-payment use, pending
  product sign-off on the real number. The ledger is persisted best-effort
  to `AsyncStorage` so an app restart does not reset the cap.
- **Broadcast callback token**: the Arcade `X-CallbackToken` was
  `keyDeriver.identityKey.substring(0, 32)` — the first 32 hex chars of the
  wallet's own *public* identity key, a value any past counterparty already
  has. `core/services/callbackToken.ts`'s `deriveCallbackToken` derives it
  from a BRC-42 *private* key instead (fixed protocol/keyID, counterparty
  `'self'`, then hashed) — deterministic per wallet, but only this wallet's
  root key can compute it. The token is recomputed on every wallet build and
  used for both the Arcade broadcast service and the Monitor's
  `callbackToken` option, so an existing server-side SSE subscription keyed
  to the old, public-key-derived value re-registers under the new one
  automatically the next time the wallet builds — no separate migration
  step, but it is a genuine value change a host should be aware of if it
  reads or reproduces this token itself.
- **Wallet check**: a coin used to be marked permanently unspendable off a
  single WhatsOnChain "spent" response — WoC can be wrong, stale, or
  answering for the wrong network, and this path never writes `spentBy`, so
  nothing could ever undo a wrong call. `core/walletRepair/shouldMarkUnspendable.ts`
  now requires the toolbox's own configured `getUtxoStatus` provider to
  *also* report the output as no longer a UTXO before committing to
  `spendable: false`; either way, the claimed spender is now recorded in
  `outputs.spendingDescription` as a paper trail (a free-text column
  nothing else in this app reads or writes).

### Exchange rate: one fetch, one fallback, and a live refresh within the session

`ExchangeRateContext` used to run its own independent fetch/cache/fallback
logic that disagreed with `core/services/exchangeRate.ts`'s (16 vs 16.75)
while sharing the same `AsyncStorage` cache key. `FALLBACK_RATE`/`CACHE_KEY`
are now exported from `exchangeRate.ts`, and `ExchangeRateContext` calls its
single timeout-guarded `getExchangeRate()` instead of re-implementing an
untimed fetch and its own cache/fallback.

Separately, that background refresh used to be fire-and-forget — its result
only ever reached the UI on the *next* cold start, so a session that opened
with a stale cached/fallback rate stayed stale until closed and reopened.
`getExchangeRate()` now returns an additional `refreshed: Promise<number |
undefined>` field (never rejects — every failure mode is still caught and
reported as `undefined`) alongside the existing `rate`; a caller that
ignores it (the wallet-build seed) sees no change at all, but
`ExchangeRateContext` awaits it and raises the displayed rate once the live
fetch actually lands, within the same session.

### Pay: cross-network address warning, an honest foreign-domain trust badge

`core/pay/rails/index.ts` gains `addressNetwork(address): 'main' | 'test' |
undefined`, reading a base58check address's version byte, and
`classifyRecipientInput` / `classifyScan` / `PayTarget`'s address variant
carry an optional `network` field alongside it. `UniversalSend` now shows a
non-blocking `pay_address_network_mismatch` note when the recipient's
detected network disagrees with the wallet's currently selected one — a
warning, not a refusal, since the same key redeems on either chain.

Separately, a handle-registry search hit from a foreign domain used to get
the same "Registered" badge as a match from the wallet's own pinned
registry, overstating its trust level — a foreign domain's is only
paymail-equivalent (its own DNS+TLS), not the pinned registry's actual
vetting. A foreign-domain match now gets `pay_trust_handle_domain_attested`
("Verified by {{domain}}") instead of `pay_trust_handle_attested`.

### Vault: interrupted-deposit recovery, a safer preview, stale-meta supersession

- **Interrupted deposit.** A crash between `signAction` and the `sendWith`
  release of a Vault deposit used to freeze every subsequent vault
  operation behind `reconcileHeldVaultDeposits`'s `action-pending` refusal,
  with no in-app way to resolve it. `core/services/vault/transfers.ts` gains
  `resolveHeldVaultDeposit(w, adminOriginator, meta, scopeToken?)`: it asks
  the network for the held txid's status first (`already-known` if the
  network already has it, otherwise re-broadcasts the *exact*
  already-signed bytes via the same `sendWith` call the normal release
  uses — never a second transaction, never `abortAction`). `VaultScreen`
  shows a "Finish the interrupted deposit" notice and button
  (`vault_resolve_held_deposit_action` / `_done` / `_failed`) whenever a
  relock or key-removal call surfaces `action-pending`.
- **Preview mutex.** `previewVaultWithdrawal` could call `abortAction` on a
  live, in-flight unsigned reservation through `selectVaultInputs`'s
  automatic stale-reservation repair — a read-only preview must not do
  that. `selectVaultInputs` gains a `repair` parameter (default `true`);
  `previewVaultWithdrawal` now passes `repair: false` and runs inside the
  vault mutation mutex, failing closed with `action-pending` instead.
  `withdrawFromVault` / `relockVault` keep `repair: true`, so a genuinely
  stale reservation from a past crash is still cleaned up.
- **Stale local meta.** `recoverVaultMetaFromOutputs` used to trust an
  existing local record unconditionally, so a stale post-reinstall
  SecureStore snapshot could permanently hide a newer on-chain revision. It
  now always runs the authenticated on-chain output scan and keeps the
  existing record only when it is not superseded by the scan (a strictly
  higher revision, or a same-revision strict key-set superset) — a one-way
  ratchet, never a merge or an overwrite by a same-revision disagreement.
- **Allocation-gate scope.** `reconcileHeldVaultDeposits`'s gate now runs
  only for the sub-cases that actually allocate a new salt index — a
  deposit, a partial withdrawal's re-vaulted remainder, and `relockVault` —
  so a full-balance withdrawal and `beginVaultKeyRemoval` (neither of which
  creates a new vault output) no longer block on an unrelated held deposit.
- **Reachable while funded.** `VaultContext` gains a device-local
  `hasVaultMeta` flag, backed by the existing `vaultStore.isEnrolled()`
  read (no new network call). `WalletHomeScreen` and `SettingsScreen` now
  show their Vault entry point when `isVaultAvailable(selectedNetwork) ||
  hasVaultMeta`, so an already-funded vault stays reachable even with
  `EXPO_PUBLIC_VAULT_ENABLED` off or the network switched away from
  mainnet. `VaultScreen`'s own withdraw/deposit gating is unchanged.
- **Vendored patch.** The `@bsv+wallet-toolbox-mobile+2.14.0.patch` funding
  plan's UTXO-pool-growth/surplus-shaping/migration-input exemptions were
  keyed off a `'vault-deposit'` label, so a vault withdrawal or re-lock was
  not exempted and could have extra migration inputs folded in, which
  `validateSignableVaultPlan`'s strict input-count check then rejected
  outright — spuriously failing an otherwise-legitimate withdraw or relock.
  Re-keyed to the already-computed `vargs.__bsvVaultAdminAuthorized ===
  true` flag, which covers deposit, withdraw and relock alike.

### Mandala: a handle-rail token is held before it is internalized

`@bsv/mandala`'s own `receiveTokens` calls `wallet.internalizeAction()`
*before* it calls the settle hook that finally writes a `token_settlements`
row — on a handle-rail token's first credit, that row does not exist yet, so
`StorageExpoSQLite.attemptToPostReqsToNetwork`'s guard (which looks up
exactly that row) finds nothing and lets an unmediated broadcast through
before the issuer's overlay ever got to admit or refuse the transfer.
`core/mandala/inboxPrehold.ts` adds a pre-hold pass, wired into
`createRuntime.ts`'s `receiveFromInbox` ahead of the real `receiveTokens`
call: it lists the inbox first, decodes each v2 hand-over message using only
the mechanical shape of the library's own unexported decoder, and — for
every message the library's own `cover()` verdict accepts — writes its
settlement row through the same `settleThroughDrain` hook the real receive
already uses. No trust logic is reimplemented; the verdict is entirely
`cover()`'s own. A message whose pre-hold write fails is excluded from that
one `receiveTokens` call and un-excluded immediately after, so it retries
whole on the next drain tick instead of being credited with no guard row. A
failure of the whole pre-hold pass skips the entire receive rather than
running `receiveTokens` unguarded. One documented, inherent gap: this lists
the inbox once and `receiveTokens` lists it again moments later — a message
arriving in that narrow window is credited with the library's original,
unguarded ordering, exactly as before this pass existed.

### Backup: a sealed generation, and a verified snapshot preferred on restore

Restore target selection had no notion of "complete" — a manifest carries no
completeness flag, so a restore landing mid-rotation could pass the
existing contiguity check and silently report success on a partial
snapshot. `core/backup/codec.ts` gains a distinct completion-marker
plaintext shape (`encodeMarker` / `decodeEntry`, `{kind:'chunk'|'marker'}`);
`decodeChunk` is now a thin wrapper over `decodeEntry` with byte-identical
behaviour for old-format ciphertext, so nothing about an existing backup log
changes. `push.ts`'s `pushOnce` now appends a one-shot completion marker
once a generation's window closes — immediately, as a dedicated pass, for
any pre-existing cursor whose window had already closed under an older
build (`cursor.ts`'s `PushCursor` gains an optional `sealedGeneration`,
undefined on every pre-existing serialized cursor, which is exactly what
triggers this back-fill). The marker is never encoded as an empty
`SyncChunk`, since the upstream `processSyncChunk` treats an all-empty chunk
as the done sentinel and would truncate or hard-fail a later replay.

`RemoteSyncReader` now decodes every entry via `decodeEntry` and silently
swallows marker entries — never yielded as a `SyncChunk`, never counted in
`length` — and exposes a cheap `verifiedComplete()` that decodes only the
newest entry, reporting true only when it is a marker whose `chunkCount`
matches the real-entry count before it. `restore.ts`'s `pickTarget` now
ranks every candidate by `updatedAt` and picks the first one whose reader
reports `verifiedComplete` — an older but sealed generation beats a newer
one still mid-rotation — falling back to the previous newest-only heuristic
(`verified: false`) only when nothing in the manifest is marked, so a fully
legacy manifest still restores exactly as before. `RestoreResult` /
`RestoreOnImportResult` gain a `verified: boolean` field;
`restoreOnImport.ts`'s own ad hoc `newestTarget()` was dropped in favour of
the same shared `pickTarget`. `WalletContext` logs a `[backup]`
console.warn when an import-time restore completed but could not be
verified, without blocking the import.

An **older app build** reading a log a newer writer has started sealing
does not throw on the marker entry itself: its old `decodeChunk` decrypts
the `{chain, marker}` envelope, finds no `chunk` field (the chain label
still matches, so the one check that function makes still passes), and
hands back `undefined` in place of a `SyncChunk` — which then reaches
whatever consumes `getSyncChunk`'s result expecting a real chunk, and is
very likely to throw downstream rather than replay silently-wrong data. It
is a new envelope shape, not a wire-compatible extension: any host running
more than one app build against the same backup account should upgrade
every reader to a toolbox version that understands `decodeEntry` before any
writer on that account starts emitting completion markers.

### Monitor: no overlapping outbox drains, and long-gap skips are recorded

- `TaskDrainOutbox` had no dedup guard: a `MonitorSupervisor` watchdog
  restart can leave an old generation's in-flight `runOnce()` executing
  concurrently with a newly-started generation's own `runOnce()` (the old
  call is not cancelled, only stopped from looping again once it resolves),
  which could retry the same outbox entry twice. It gains a static
  `running` flag, set at the top of `runTask` and cleared in a `finally` so
  a throw cannot wedge it; a concurrent call now returns `''` immediately
  without draining.
- `reviewProvenTxsStartHeight` jumps ahead to the last 100 eligible heights
  when last-reviewed falls further behind the tip than that — an
  intentional tradeoff against an unbounded chain-crawl — but nothing
  recorded which heights were permanently skipped, so a rare missed reorg
  in that range could never be surfaced. `core/walletMonitor.ts` exports a
  new `skippedReviewRanges: { fromHeight: number; toHeight: number }[]`
  array (and `resetSkippedReviewRanges()`), pushed to and `console.warn`'d
  with a tagged `[walletMonitor]` line whenever a skip actually happens, so
  diagnostics or a future slow background sweep can read it.

### `AmountInput` accepts the locale's own decimal separator

Fiat-mode input hardcoded `.` as the decimal separator in both the input
mask and `parseDisplayToSatoshis`, so a comma-decimal locale (e.g. de-DE)
could not type a fractional fiat amount at all — every comma keystroke
failed the mask and was silently dropped, and `parseFloat` only ever
recognises `.` besides. `core/amountFormatHelpers.ts` gains
`decimalSeparator()` (re-exported from the package root), derived from
`Intl.NumberFormat(locale).formatToParts(1.1)` rather than hardcoded;
`AmountInput`'s input mask and `parseDisplayToSatoshis` both use it to build
the allowed pattern and to normalize typed text to `.` before `parseFloat`.
BSV's integer mode (`fractionDigits === 0`) is untouched — it has no decimal
point to begin with.

### `setMockDriver` refuses outside `__DEV__`

`setMockDriver` had no gate of its own — only its `devMock.ts` wrapper
checked `__DEV__` before calling it — so any code with JS execution in a
nominally-production bundle could call it directly and make
`getVaultDriver()` prefer a software mock over real hardware, skipping all
native attestation. It is now a no-op outside `__DEV__`. `jest-expo` sets
`__DEV__=true`, so the existing mock-driver test suites are unaffected.

### `LocalStorageAdapter` removed (breaking)

`core/storage/LocalStorageAdapter.ts` and its `core/index.ts` exports —
`initializeLocalStorage`, `isLocalStorage`, `getStorageDisplayName`, and the
`LocalStorageConfig` type — are deleted. It never passed `identityKey` into
the `StorageExpoSQLite` constructor it wrapped, so every identity would have
collided on `wallet-default-<chain>net.db` had it ever been used, and a
repo-wide search found no real caller: the live `WalletContext` path already
passes both `identityKey` and an explicit `databaseName` directly to
`StorageExpoSQLite`. **Breaking only for a host that imported these names
directly** — nothing in this app's own code depended on them.

### New i18n keys, and a corrected export explainer

15 new keys, in all 12 languages: `local_pay_received_confirming`,
`local_pay_received_not_credited`, `local_pay_decline_broadcast_title`,
`local_pay_decline_broadcast_body`, `local_pay_cancel_unverifiable_title`,
`local_pay_cancel_unverifiable_body`, `local_pay_cancel_unverifiable_confirm`,
`recovery_replace_wallet_title`, `recovery_replace_wallet_body`,
`recovery_replace_wallet_confirm`, `pay_address_network_mismatch`,
`pay_trust_handle_domain_attested`, `vault_resolve_held_deposit_action`,
`vault_resolve_held_deposit_done`, `vault_resolve_held_deposit_failed`.
Non-English copy is machine-drafted and awaits native-speaker review, same
as every previous translation batch in this changelog.

`vault_export_explainer` is also corrected in all 12 locales: it claimed the
vault salt lives in the locking script, which is false (the script commits
only to `HASH160(salt||table)`; the salt itself is witness-only) and
directly contradicted `vault_first_deposit_body` five keys later in the same
file.

### App-side notes for a host

- `app.json`'s `expo.android.allowBackup` is now explicitly `false`. Expo's
  own default (`true`) let Android's Auto-Backup-for-Apps copy the
  plaintext SQLite database — which holds every vault output's salt in
  `customInstructions` — off-device on an OS-initiated backup with no user
  action. The app's own encrypted backup system is unaffected by this; a
  host forking this `app.json` should carry the same setting.
- The vendored `patches/@bsv+wallet-toolbox-mobile+2.14.0.patch` changed
  (see the Vault section above): three funding-plan exemption conditions in
  `makeFundingParams` moved from a `'vault-deposit'` label check to
  `vargs.__bsvVaultAdminAuthorized === true`. `npm install` picks up the
  regenerated patch automatically via `patch-package` for anyone installing
  this package fresh; a host that vendors its own copy of this patch
  outside the normal install path needs to regenerate it the same way.

## 0.7.0

0.6.0 was tagged in this file but never published to npm. Hosts upgrading from
0.5.0 should read both sections.

### @bsv dependency bump (breaking for hosts)

Peer ranges move to `@bsv/sdk` ^2.8.2, `@bsv/wallet-toolbox-mobile` ^2.14.0,
`@bsv/message-box-client` ^2.5.3, `@bsv/templates` ^1.10.3,
`@bsv/btms-permission-module` ^1.2.1 and `@bsv/air-gap` ^0.1.3.

`@bsv/wallet-toolbox-mobile` now ships as one bundle whose exports map exposes
only its root, so this package imports everything from the root. Types the
toolbox exports only under its `sdk` namespace come through
`core/toolboxTypes.ts`. From 2.14.0 the toolbox exports `WalletMonitorTask`,
`attemptToPostReqsToNetwork`, `parseJsonRpc`, `stringifyJsonRpc` and
`verifyUnlockScripts` itself, and ships the permissions-manager sendMax fix,
the relinquish and internalize basket checks and best-effort Monitor
subscriptions, so none of that is patched any more.

Hosts must carry this repo's two remaining `patches/` for those exact
versions: `@bsv+sdk+2.8.2.patch` (native secp256k1 and transaction-engine
routing) and `@bsv+wallet-toolbox-mobile+2.14.0.patch` (the Vault authorization
hooks, the Vault deposit funding plan, batched native key derivation and shadow
engine verification). The `@bsv/message-box-client` and `@bsv/templates`
patches are gone: 2.5.3 reports a send failure as
`Message Box send failed with HTTP 400 (ERR_DUPLICATE_MESSAGE).`, which
`isDuplicateMessageError` recognises, and both packages' CommonJS builds load
under Node again.

- `ADMIN_ORIGINATOR` is now `internal-admin.bsv-wallet.invalid`. @bsv/sdk 2.8
  accepts only canonical hostnames as originators, so the old
  `urn:bsv-wallet:internal-admin` label rejected every internal wallet call.
  `parseExternalOrigin` refuses the whole `.invalid` TLD, and pending aborts
  queued under the old label replay under the new one
  (`LEGACY_ADMIN_ORIGINATOR`).
- `OfflineFirstChaintracks` takes an optional third `chain` argument and
  answers `getChain` from it, and forwards the remote's `supportsReorgEvents`,
  so the toolbox Monitor does not subscribe through the HTTP client at all. A
  subscription that fails anyway resolves to an inert id instead of throwing,
  so the Monitor's subscriptions settle once instead of failing, and fetching
  the chain over the network, on every tick while offline.
- Header validation uses the toolbox's `validateHeaderProofOfWork`, which
  checks the compact target encoding and honours its consensus exceptions.

### Transaction detail and activity words (breaking for direct callers)

- Tapping an activity row opens a full-screen transaction detail view, pushed
  in from the right, instead of expanding the row in place. The utilities that
  used to unfold under a row live in the view's overflow menu. New `ui`
  exports: `TransactionDetailScreen` (default) with its `TransactionDetailParams`
  and `TransactionAction` types, and `SlideOverFromRight` (default, props
  `{ visible, onClosed?, children }`). `ActivityRow` takes an optional
  `onOpen?: (action: ActivityAction) => void`; when given, a tap calls it and
  the old inline expansion is not rendered. Its `token` prop gains an optional
  `status?: TxStatusView`.
- The detail view's headline is the exact satoshi count the transaction moved,
  never shortened or converted to BSV. When the display currency is fiat, the
  fiat amount is a separate line beneath it. A `Block` row shows the block
  height from local storage (one-row query, no network); an unproven
  transaction reads "Waiting for a block." `StorageExpoSQLite` gains
  `getProvenTxHeight(txid): Promise<number | null>`.
- A BSV row says what it did from the moment it is handed to the network:
  `completed`, `unproven` and `sending` all read "Sent" or "Received" instead
  of "Confirmed", "Accepted" and "Broadcasting". An outgoing action that no
  Pay / Get paid rail made (no `peerpay`, `localpay`, `legacy` or `mandala`
  label: a connected app or the wallet itself) reads "Spent". Vault deposits,
  withdrawals and relocks read "Transferred" in either direction.
- `txStatusView(status, offlineStatus?, incoming?, labels?)` takes two new
  optional arguments. **A host calling it directly must pass `incoming` (and
  `labels`)**: without them, `completed`, `unproven` and `sending` now resolve
  to "Spent". New exports from `ui/txStatus.ts`: `activityKind(incoming,
  labels)`, the one place a row's word is decided, returning the new
  `ActivityKind` (`'sent' | 'received' | 'spent' | 'transferred'`), and
  `isPaymentAction(labels)`.
- Token (Mandala) rows use the same words: "Sent" or "Received" once settled,
  "Pending" while settling. Only `refused`, `reversed` and `stuck` keep their
  own word. New `ui` export `tokenRowStatusView(status, incoming)`.
- A row shows its status dot only when its tone is not the quiet settled one
  (in flight, needs attention, failed), so a normal history is no longer a
  column of dots.

### Activity filter and search

- A filter button beside Export opens a search field with All / Sent /
  Received / Spent / Transferred chips; the list narrows as the user types or
  picks a chip. Search matches every typed word, in any order, case- and
  accent-insensitive, against the row's note (or the name recorded at send)
  and a saved contact's name and handle for its counterparty. It is local only:
  no network lookups, so a non-contact's handle is found only if the note says
  it. A leading `@` is ignored. While a filter is active the list pages into
  older history, and "No matching activity" shows only once history is
  exhausted. Closing the panel clears the search and resets to All.
- The Export button reads "Export" (`tx_export`); its accessibility label is
  still `tx_export_csv`. CSV export ignores the filter and writes the full
  history.

### Amounts

- New `core` exports: `formatSatoshisExact(satoshis, showPlus?)`, the exact
  satoshi count for the detail view; `splitAmountFraction(value)`, which splits
  a formatted amount so its minor units can be drawn smaller; and
  `getNumberLocale()`, the device locale every amount formatter prints through.
- `AmountFormatOptions` gains an optional `compact`, and `formatSatoshisAsBsv`
  and `formatSatoshisAsFiat` gain a trailing `compact = false` parameter. With
  it, large figures shorten to k / M / B (`$1.2k`, `1.5M BSV`), and a value
  that rounds to 1000 of a unit promotes to the next one. Only activity rows
  pass it. `abbreviate` still shortens only the unit word ("sats"), as in
  0.6.0, so existing calls are unchanged.
- Currency symbols come from the toolbox's own table (`$` for USD, AUD, CAD and
  NZD; `£`, `¥`, `₹`, `₽`, `zł`, `R$`, `Rp`) with `narrowSymbol`, not from
  whatever the device language implies: a device that printed "US$" or "NZ$"
  now prints `$`. Where `Intl.NumberFormat` throws (seen on Hermes), the
  fallback prints that symbol before locale-formatted digits instead of the ISO
  code ("USD 3.45"). Hosts with snapshot tests on formatted currency should
  expect the symbol change.

### Home screen

- The balance stays on one line at any length: its type shrinks to fit the
  available width, down to a 12pt floor, and grows back when a shorter value
  follows. This replaces `adjustsFontSizeToFit`, which on iOS Fabric ignores
  `minimumFontScale` and bottoms out at 4pt.
- Its minor units are drawn smaller and raised, price-tag style. Abbreviated
  figures and whole amounts render as one run.
- Tapping the balance to switch currency has a descriptive accessibility label
  naming the destination unit (`wallet_balance_show_in`, e.g. "Show in USD").
- Pay and Get paid show their icon beside the label, in pill-shaped buttons.
  The import-from-backup card's icon sits in a filled circle, with corners
  concentric with the screen's.

### Profile picture

- The user can pick an icon as their profile picture; Home's profile button
  shows it, falling back to the previous person glyph when none is chosen.
  New `core` exports: `getUserAvatarIcon`, `setUserAvatarIcon`,
  `loadUserAvatarIcon`, `subscribeUserAvatar`, `useUserAvatarIcon`, and the
  `AvatarIcon` / `AvatarIconFamily` types. New `ui` exports: `UserAvatar`
  (default), `AvatarGlyph`, `AVATAR_ICON_GROUPS` with the `AvatarIconOption` /
  `AvatarIconGroup` types, `IconPickerSheet` (default, props
  `{ visible, onClose }`) and `EditPictureSheet` (default, props
  `{ visible, options: EditPictureOption[], onClose }`) with
  `EditPictureOption`.

### Handle registry fixes

- A typed `handle@domain` whose domain is complete in its own right resolves
  as that domain: `alice@deggen.co` is no longer answered as a prefix of
  `deggen.com`, which returned every `*@deggen.com` neighbour for an address
  on someone else's registry.
- A half-typed prefix of the pinned domain that matches nothing returns an
  empty result instead of the "search unavailable" banner.
- Registry search results are capped at 10 rows (`MAX_SEARCH_RESULTS`) before
  any certificate is verified, so an uncapped response from a foreign registry
  cannot freeze recipient search.
- A handle arriving through a deep-linked `/contact/add?handle=…` is checked
  against the registry for the key it claims before it is written to
  `cachedHandle`; an unproven one is left blank for the background refresh.
- Registry requests bound the response body by the same ~8s deadline as the
  headers. Writes are serialized, so a stalled body used to block every later
  write for the life of the process.
- An outstanding registration journal takes priority at every entry point
  (`registerHandle`, `updateProfile`, `changeHandle`), not only on resume, so a
  retried claim and release can no longer leave the user holding neither
  handle.
- A rollback that finishes on a later launch still names the handle the user
  tried to claim (`attemptedPaymail` in the pending journal).
- Failed writes carry a `code` (`invalid_handle`, `wrong_domain`,
  `same_handle`, `clock_ahead`). Profile shows `clock_ahead` and `wrong_domain`
  in the user's language; the other two still show the diagnostic message.
- A contact's screen tracks its avatar refresh and registry refresh
  separately, so a registry lookup no longer suppresses the avatar refresh.
- In Pay, a registry display name that contains `@` is not shown as the
  recipient's name (it falls back to the handle); the review card shows the
  recipient's `handle@domain` rather than an abbreviated key; identity-search
  and registry-search errors share one dismissible banner.

### Copy and translations

- 17 new keys, in all 12 languages, none removed: `tx_status_received`,
  `tx_status_sent`, `tx_status_spent`, `tx_status_transferred`,
  `tx_status_pending`, `tx_export`, `activity_filter`, `activity_filter_all`,
  `activity_search_placeholder`, `activity_search_clear`,
  `activity_filter_no_match`, `wallet_balance_show_in`, `tx_detail_block`,
  `tx_detail_block_pending`, `profile_handle_clock_ahead`,
  `profile_handle_wrong_registry`, `profile_display_name_publish_failed`.
  `tx_status_confirmed`, `tx_status_accepted` and `tx_status_broadcasting` are
  kept but no longer used by default.
- `biometric_advisory_body` is shorter in every language: "Protect your assets
  with Face ID or your fingerprint".

### Fixes

- `TransactionDetailScreen` loads Ionicons lazily, like the rest of the
  package, so importing the `ui` barrel under Jest no longer fails on
  expo-font's ESM.

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
