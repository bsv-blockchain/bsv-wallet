# Changelog

## Unreleased

### Vault v7: chain-published recovery, no salt at rest (INT-01/02/03/04/06/10, XQ-012, XR-005/006)

Closes the availability and exclusion gaps the external security review's
ledger tracked under these rows: a clean device (mnemonic + one enrolled
YubiKey + its PIN) could not locate or spend an existing Vault output
without the old SQLite database or an encrypted backup, and the only copy
of a v6 output's salt lived in plaintext in that same local
`customInstructions` — a stolen DB/export/device-backup, plus a stolen
committed key and its PIN, could spend without the mnemonic.

- **v7 recovery metadata** (`r1comb.ts`): the v6 shape minus `salt` — 8
  exact fields, `v===7`, no legacy reinterpretation, structurally unable to
  carry a salt at rest. `decodeVaultInstructions` is now the union decoder
  (v6 ?? v7); the v6 decoder/encoder are unchanged and still the only path
  for existing outputs. Salt derivation itself is unchanged (same
  `createHmac`, same `[2,'vault salt']` domain, same serial framing) — for
  v7 it is re-derived in memory whenever needed and never persisted.
- **On-chain marker + descriptor**: every v7 vault output is now followed by
  two explicit outputs — a 1-sat P2PKH **marker**
  (`wallet.getPublicKey([2,'vault marker'], keyID` `` `${chain}:${k}` ``
  `, counterparty:'self')`, an ordinary indexer can answer) and a 0-sat
  `OP_FALSE OP_RETURN 'r1c7' <ciphertext>` **descriptor** carrying the exact
  v7 record, BRC-2 (AES-256-GCM) encrypted under
  `[2,'vault descriptor']` at the same chain-scoped keyID. Neither goes in
  any basket. `guard.ts`'s `VAULT_PROTOCOL_NAMES` reserves both new protocol
  names in the same change that starts creating them, so a paired
  non-admin BRC-100 caller can never derive a marker key or decrypt a
  descriptor. `validateDepositPlan` and the re-lock/withdraw-remainder path
  now pin all three outputs (vault, marker, descriptor) byte-exact, the
  same discipline the vault output alone used to get; `estimateRelockFee`
  reserves their byte cost too. Crash-recovery reconciliation
  (`isValidHeldVaultDeposit`) recognizes the new 3-4-output shape so a v7
  deposit interrupted mid-flight does not wedge every later vault
  operation behind `action-pending`.
- **`core/services/vault/chainRecovery.ts`** (new): `recoverVaultFromChain`
  scans for the marker at index `k=1,2,…`, and for every candidate
  transaction it finds, locates the `[vault, marker, descriptor]` triple by
  the marker's exact position, decrypts the descriptor, hard-requires its
  claimed index and chain match the scan position, re-derives the salt,
  rebuilds the lock byte-exactly and compares it to the real output,
  requires it unspent, and internalizes it into the `admin vault` basket —
  before finally calling the existing `recoverVaultMetaFromOutputs`
  unchanged. A found-but-unusable record at one index is reported
  distinctly and never stops the scan; an unconfirmed candidate is
  reported as pending rather than thrown. The injected `VaultChainLookup`
  interface keeps the module network-agnostic and unit-testable;
  `wocChainLookup` is the production WhatsOnChain implementation. The
  YubiKey is never needed to restore — only to spend afterward, through
  the completely unchanged withdraw path.
- **UI**: VaultScreen's not-enrolled hero gains "Restore vault from the
  blockchain", offered whenever a wallet identity exists and the vault is
  available (never gated on YubiKey support). New i18n keys in all 12
  languages; non-English copy is machine-drafted and awaits
  native-speaker review, same as every previous translation batch in this
  changelog.

**Residuals, disclosed rather than silently left open:**

- Existing v6 outputs are unaffected and still need the local DB or an
  encrypted backup until they are re-locked (which converts them to v7).
  No migration rewrites old rows, and this release adds no nudge to do so.
- Recovery claims **confirmed** deposits. `internalizeAction`'s own SPV
  gate requires a BUMP or a present raw-input ancestor chain; assembling
  arbitrary-depth unconfirmed ancestor BEEF was considered and rejected as
  open-ended complexity for a narrow confirmation-window edge case, not
  required by the availability guarantee's core promise (surviving loss of
  a *settled* deposit). An unconfirmed candidate is surfaced as "pending
  confirmation," never silently dropped.
- ARC/indexer acceptance of a transaction carrying a ~45 KB R1C lock plus a
  1-sat P2PKH plus a ~1.5 KB `OP_RETURN` in one broadcast has not been
  verified against a live network in this change; likewise `wocChainLookup`'s
  exact WhatsOnChain response-shape assumptions (history endpoint, spent-output
  endpoint) were not exercised against the live API. Both need a network
  smoke test before this is fully relied upon in production;
  `recoverVaultFromChain`'s own scan/authentication logic does not depend
  on either being exactly right and is unit-tested against an in-memory
  chain double.
- A basketless marker output is not tracked by `guard.ts`'s vault
  inventory. Read-only verification of the real `WalletPermissionsManager`
  confirms a non-admin originator can name its outpoint in `createAction`
  without any basket or protocol permission (spending it still requires a
  signature from its key, which is reserved the same way the descriptor
  key is) — financial exposure is 1 satoshi, and a stranger spending or
  reserving it does not remove the marker transaction or its address's
  history from any indexer, so it cannot defeat recovery. Accepted, not
  fixed.
- The physical-hardware run (a real, previously-enrolled YubiKey signing
  through the full chain-recovered-lock-to-withdraw path on a wiped
  device) remains the standing hardware gate this repository already
  treats as unrun for the Vault generally; it is proven here only with
  `MockYubiKey`'s real P-256 math.

### Payments and export: device report fixes (2026-09-25)

- **@bsv/wallet-toolbox-mobile 2.14.0 → 2.14.3.** 2.14.3 ships both toolbox
  fixes below upstream (bsv-blockchain/ts-stack#638), so their patch-package
  hunks are gone; the patch file is now
  `patches/@bsv+wallet-toolbox-mobile+2.14.3.patch` and carries the earlier
  hunks unchanged. Also in 2.14.1–2.14.3: `discoverByAttributes` re-filters
  overlay results the way the overlay searched them. In 2.14.0 an `any`
  search compared a certificate field literally named `any`, so ContactsScreen
  network search and the Pay recipient search never showed a network result;
  they now match whole words (stopwords ignored, no stemming), `userName`
  exactly. The exact-spend amount moved from a symbol on the createAction
  result to a shared WeakMap (no app code reads it).
- **Nearby payments failed with "generateChangeSdk error: required fee
  error 23 !== 33"** (toolbox, fixed in 2.14.3). In 2.14.0,
  `shapeSurplusChangeOutputs` split the change into outputs of exactly
  `changeInitialSatoshis` — the basket's `minimumDesiredUTXOValue`, still the
  legacy 32 in every wallet created before the bump — below the 40-sat dust
  floor at 100 sat/kB. `removeDustOutputs` then stripped them without
  returning the fee paid for their bytes, and the final check rejected the
  plan. Split outputs are now floored at the dust floor. Hit most payments
  funded from one coin with a small surplus, on every wallet-funded rail.
  Regression: `__tests__/localpay/nearbyOneCoinChangeShaping.test.ts` (real
  Wallet + StorageExpoSQLite; reproduces the exact error on 2.14.0).
- **"Cancel payment" refused with "The action reference was not issued by
  this permissions manager"** (toolbox, owner-approved; fixed in 2.14.3).
  `WalletPermissionsManager.abortAction` accepted only a reference still in
  its in-memory map, which `signAction` and every restart empty, so a signed
  noSend payment could never be cancelled, and `replayPendingAborts` could
  never release one either. The wallet's own admin originator may now abort
  any of its actions; every other originator keeps the issued-reference and
  same-originator checks. The app's token-settlement and Vault abort guards
  still run first. Regression:
  `__tests__/context/permissionsManagerAdminAbort.test.ts`.
- **Cancel only while a payment never left the device**
  (`detailActionKeys.ts`, `ActivityRow`): plain Cancel is offered only when
  there is no offline record for the payment; a parked one keeps its
  chain-checked cancel, and any recorded hand-over (queued, posting, sent,
  acknowledged, rejected, import_hold) offers none, since the payee may hold
  it.
- **"Request confirmation from recipient"** (`tx_action_request_confirmation`,
  12 languages): the transaction details menu re-delivers an outgoing
  message-box, Nearby or token payment over the message box (the existing
  `onSendPaymentDetails`, which also releases a parked payment on success).
- **Export Wallet Data hung on iOS** (`AlertCard`, `useExportWalletData`).
  Since the unencrypted-export warning (XR-086), `showAlert` resolved on the
  tap while the alert's native modal was still presented, so the share sheet
  was presented on that modal and dismissed with it, and `shareAsync` never
  settled. `showAlert` now resolves once the modal is dismissed (iOS
  `onDismiss`; after the fade on Android; a fallback timer so a modal that
  never presented cannot hold the queue), and the export spinner starts only
  after the warning is confirmed.

### Vault: replace a key by adding first; locks hold 2 to 5 keys (owner rule, 2026-09-25)

- **Remove needs three keys.** VaultScreen's key menu offers Remove only when
  the vault has more than `VAULT_MIN_KEYS` active keys and no removal is
  pending; before, it always offered Remove and refused afterwards. The
  service and store refusals (`last-keys`) are unchanged.
- **A sixth key, never locked to.** New `VAULT_MAX_ACTIVE_KEYS` = 6
  (`VaultKeyService.ts`, mirrored in `vaultStore.ts`): a full vault can add
  the replacement key before removing the key it replaces, and one re-lock at
  five covers both. `isVaultMeta`, `vaultStore.addKey` and `addVaultKey`
  accept six; a seventh is still `too-many-keys`. `VAULT_MAX_KEYS` (5, the
  R1C lock ceiling) is unchanged.
- **Nothing locks to six, or to one.** New `too-many-active-keys` error:
  `newVaultOutput` (deposit, re-lock, partial-withdrawal remainder) and
  `relockVault` (before its fee estimate) refuse unless the key list is 2..5.
  A full withdrawal creates no Vault output and stays allowed.
- **Removing a key no output commits finishes at once** (`beginVaultKeyRemoval`):
  it used to return `complete: false` whenever the vault held any output, so
  removing a key added but not yet re-locked to (the add-then-remove flow)
  opened a re-lock that could only fail with `vault-empty`. It now checks
  whether any output commits that key; if none does, the removal completes
  with no re-lock. A held deposit (which may still commit the key) makes
  that case wait with `action-pending`, and an output committing the key
  that appears between the two scans cancels the removal as before.
- **UI at six keys**: no Add; Deposit disabled with
  `vault_err_too_many_active_keys`; a partial withdrawal is refused (before
  any card tap) only when its remainder would go back into the vault, so a
  remainder under the floor still offers withdrawing everything; the
  coverage badge does not open a re-lock; the header drops "of 5" (`vault_key_section_over_limit`); after
  adding the sixth, no automatic re-lock sheet, and the wizard's done step
  says to remove the replaced key (`vault_add_key_done_over_limit`, button
  "Done"). Three new strings in 12 languages.

### Vault: key removal finishes on network acceptance (physical-device report, 2026-09-25)

- **Finalize on acceptance** (`transfers.ts`, owner decision): a key removal
  used to stay pending — deposits and withdrawals blocked, the removed key
  listed as "re-lock to finish" — until its re-lock was mined and proven
  (`completed`). `finalizeVaultKeyRemoval` now clears the tombstone once the
  re-lock is accepted by the network (`unproven`: ARC returned an accepted
  status). New `ACCEPTED_ACTION_STATUSES` = `unproven`, `completed`; any
  other Vault action status (`sending` included) still blocks, and a failed
  withdrawal or re-lock still blocks. Should an accepted re-lock still be
  dropped, its sources return as outputs committed to a key the vault no
  longer lists, and the removed-key badge offers the re-lock again.
- **Untagged broadcast write** (`transfers.ts`): `relockVault` marked a
  removal's tombstone `broadcast` without re-tagging the meta. The tag
  covers `pendingRemoval.state`, so the stored meta stopped verifying and
  every later check fell back to a full chain re-authentication (failing
  closed whenever that scan could not see the re-lock output). It is now
  tagged like every other meta write.
- **VaultScreen / VaultTransferScreen**: a removal whose re-lock is broadcast
  but not yet accepted said "Re-lock the vault first", and the removed key's
  row opened a second re-lock sheet (which would have been refused as
  `vault-empty`, since no output still commits that key). The screens now
  say the re-lock was sent and deposits and withdrawals open again once the
  network accepts it (`vault_removal_awaiting_network`,
  `vault_key_removal_awaiting_network`, 12 languages); the row is inert in
  that state. The screen re-runs `finalizeVaultKeyRemoval` every 30 s and on
  return to the foreground while it waits. Withdraw is drawn disabled when
  it is.

### Vault: forged-state, session, and chain-recovery hardening (external security review)

- **Enrollment and meta forgery (XR-001, XR-002).** A `ready` enrollment draft
  and the local `VaultMeta` record were previously trusted by shape alone — a
  SecureStore-only attacker (no YubiKey, no wallet root) could inject a forged
  draft, or inflate `VaultMeta`'s revision and key set, and have it committed
  as spend authority with zero possession or hardware check.
  `enrollKey`/`resumeEnrollmentDraft` now tag a `ready` draft with a wallet-
  root HMAC the instant they write it (`computeVaultDraftAuthorityTag`, reusing
  the `vault meta` protocol namespace `guard.ts` reserves), and
  `requireReadyEnrollmentDrafts` verifies that tag before trusting a draft as
  authority. Every meta-writing path (create, add/remove key, rename, restore)
  now tags the record with a wallet-root HMAC over the fields that confer spend
  authority, and `requireAuthenticatedMeta` re-derives the true key set from
  chain history whenever a tag is missing or invalid before any deposit, re-
  lock, or re-vaulted withdrawal remainder proceeds. `addVaultKey` additionally
  re-verifies an existing meta's own tag before appending to it, closing a
  laundering path where a forged meta could gain a valid tag merely because the
  legitimate user's next action happened to add a key. Separately,
  `EnrollWizard`'s add-key mode no longer auto-commits the first `ready` draft
  it finds on mount — it now requires an explicit, named confirmation (new keys
  `vault_resume_draft_confirm_title`/`_body`/`_use`/`_discard`) before use, and
  discards a declined draft.
- **Backup-attestation gate before enroll/deposit (XR-003).** Creating a wallet
  from the Vault entry point used to route straight to enrollment or deposit
  with no requirement that the auto-generated mnemonic was ever written down.
  `VaultScreen` and `VaultTransferScreen` now block deposit and enrollment
  behind `requireBackupAttested()`, routing to the existing backup ceremony
  first whenever the current identity has no attestation record. New keys
  `vault_seed_not_preserved_title`/`_body`/`_cta`.
- **Superseded hardware session (XR-004).** `hardwareLease.ts` now tracks a
  monotonic generation; `enrollKey` and `resetPivApplication` — the only
  `withKeySession` callers that mutate vault state from inside the session
  closure — check a `VaultSessionGuard` before writing, so a stalled native
  call that eventually resumes after a retry has already taken over the lease
  can no longer race a mutation in behind it. The existing "an abandoned call
  frees the lease for a retry" availability behavior is unchanged.
- **Slot-replacement and reset guards (XR-008, XQ-014).** Replacing an occupied
  Vault slot now also checks `vaultStore.enrolledSerialsAcrossChains` and
  `meta.pendingRemoval`, not just the current chain's key list, so an explicit
  slot-replacement consent can no longer erase a signer still live under
  another chain or mid-removal — mirroring the guard `pivReset` already
  applied. A new device-wide, non-secret `enrolledSerialRegistry.ts` (bare
  serials only, never pubkeys or keys) closes `pivReset`'s remaining cross-
  identity blind spot: a serial recorded as enrolled anywhere on the device —
  even under a different wallet identity SecureStore can't enumerate — now
  refuses a PIV reset unconditionally, with no override. The reset-consent copy
  that overclaimed "no vault on this device claims" this key is corrected to
  disclose the actual uncertainty instead.
- **Held signed withdraw/relock reconciliation (XR-006/INT-03).** The existing
  "Finish the interrupted deposit" recovery (0.8.0) only recognized a held
  deposit shape; a crash between `signAction` and `sendWith` on a withdrawal or
  re-lock instead froze every later Vault operation with no vault-specific way
  to clear it, and the resolve button treated any non-`'failed'` result —
  including "nothing held" — as success. `resolveHeldVaultDeposit` now also
  recognizes a held, signed vault-withdraw/vault-relock action and resends the
  exact already-signed bytes (never a new transaction, never `abortAction`);
  `VaultScreen` now surfaces "nothing held" as its own message rather than a
  false success toast. New key `vault_resolve_held_deposit_none`.
- **Reload reconciles on every mount, not only an empty cache
  (INT-07/XR-007).** `VaultScreen.reload()` previously called the chain-
  authenticated `recoverVaultMetaFromOutputs` only when no local record existed
  at all, so a stale-but-present cached record (e.g. surviving a reinstall)
  could permanently wedge every later Vault action. It now always reconciles,
  relying on the existing revision/key-set ratchet to keep the cache whenever
  the scan doesn't supersede it, and falls back to the last-read cache (rather
  than a hard error) when the scan itself fails or is offline.
- **`hasVaultMeta` race on cold start (INT-08).** `VaultContext` recomputed its
  device-local `hasVaultMeta` flag only on ceremony-phase transitions, which on
  a cold start settled to `false` before `WalletContext`'s async wallet-build
  chain ever configured the vault scope — hiding an already-funded vault from
  Home/Settings for the rest of the session. `vaultStore` gains an
  `onScopeChange` subscription so the check re-fires the moment the scope
  actually configures, not only at mount.
- **Chain-recovery integrity (Availability review; INT-01/INT-06/XQ-012).**
  `wocChainLookup`'s output-status check previously failed open — any response
  shape it didn't recognize, including a schema mismatch, was read as "unspent"
  rather than "unknown," and "unknown" is the one answer
  `recoverVaultFromChain` must never treat as spendable; it now requires an
  explicit `spentTxId: null` before reporting unspent. Its address-history
  lookup likewise silently mapped a rate limit, a 5xx, or a thrown exception to
  an empty "no marker here" result, which could stop a scan short of a real,
  higher-index deposit; it now throws on any non-2xx response or exception so
  the scan's own problem-reporting (not a silent miss) handles it. The scan
  loop itself had no bound on consecutive lookup/derivation failures — a
  reproducible livelock, confirmed by a hung 2+ minute run against the unfixed
  code — and is now bounded by `VAULT_RECOVERY_MAX_CONSECUTIVE_PROBLEMS`, with
  a second cap (`VAULT_RECOVERY_MAX_CANDIDATES_PER_INDEX`) limiting how many
  candidate transactions per index one scan will inspect (a marker address's
  history is public, so a stranger could otherwise force unbounded decrypt-and-
  discard work by dusting it). The bounded-scan abort now throws a
  `VaultError('chain-scan-failed', ...)` with translated copy in every locale,
  instead of a plain `Error` that fell through to generic fallback text. The
  lookup's base58check encoding now uses `@bsv/sdk`'s own public
  `Utils.toBase58Check` instead of an unaudited hand-rolled implementation.
- **RPC-boundary hardening (XR-019, XR-020, XR-102).** A non-admin (paired)
  caller's `listOutputs` had no bound at all in `guardVaultAccess`; it is now
  capped at 200 rows (25 when `includeTransactions` is set, since each such row
  carries a full BEEF) and an existing offset ceiling, refused before the call
  reaches the underlying wallet — a host whose connected app calls
  `listOutputs` with a larger limit now gets `VaultAccessDenied` instead of a
  large response. The address-rail, PeerPay, and Mandala/FT protocol namespaces
  were never reserved the way Vault's own namespaces are, so a paired origin
  could call the allowlisted `createSignature`/`getPublicKey` RPC methods
  directly against them and receive a spend-ready signature for those rails
  with no prompt at all; they are now denied the same way. A forged
  `pending_aborts` entry naming the public `ADMIN_ORIGINATOR` could ride the
  admin bypass straight past the vault-inventory check on replay; `guard.ts`
  now opts a replayed admin abort into the same inventory check a non-admin
  caller gets (`VAULT_ABORT_REPLAY_MARKER`), leaving a live interactive admin
  abort unaffected.
- **Proof bar.** Six standing regression proofs now run as a single suite:
  script acceptance for N=1..5 with an independent P-256 check, the CRT-forgery
  harness, a clean-device I1 recovery proof, the I2 exclusion matrix (mnemonic-
  only, stolen-DB-and-key, wrong PIN, unenrolled key, DB-without-mnemonic,
  external caller), an I3 rail-isolation proof against every rail with a real
  wallet/storage, and a no-production-mock proof that the mock YubiKey driver
  is unreachable outside `__DEV__` at the runtime, source, build-profile, and
  UI layers. `scripts/run-proof-bar.cjs` runs all six in order and prints a
  pass/fail summary.
- **Production build gate.** `EXPO_PUBLIC_VAULT_ENABLED` is off again in the
  production EAS build profile — Vault output creation stays disabled in
  production until a v7 lock has actually been broadcast/mined and run once
  against a physical YubiKey; development and dev-physical profiles keep it on.
  An already-funded vault is not stranded by this: the entry point stays
  visible whenever local Vault meta exists, and a full withdrawal is not gated
  by the flag — only new deposits, re-locks, and withdrawal remainders are.

- **A held Vault transaction is never reported resolved on a bare status
  claim (NEW-07).** `resolveHeldVaultDeposit` used to skip releasing a held,
  already-signed Vault transaction when a chain service answered 'mined' or
  'known', so a wrong or malicious service made the app report success while
  the signed bytes were never broadcast. It now always releases the wallet's
  own signed bytes through the existing `sendWith` path and derives success
  (and the broadcast vs already-known distinction) only from the toolbox's
  confirmed release result.

### Secrets and biometrics

- **Delete Wallet now actually erases everything, and fails closed if it can't
  verify that (XQ-008, XR-107).** "Delete Wallet" closed the SQLite connection
  but never deleted the underlying `.db` file(s) or the `walletDbRegistry`
  entry — rebuilding with the same mnemonic silently reattached the "deleted"
  wallet's full local history. `logout()` now purges every registered filename
  for the identity/chain via `walletDbRegistry.purgeRegisteredDbFiles`, and
  also sweeps the legacy plaintext secrets namespace
  (mnemonic/recoveredKey/password) that lived outside the envelope scheme. Both
  the legacy sweep's and the envelope KEK's deletions are now verified rather
  than trusted blind: `deleteAllSecrets()`/`logout()`/`WalletConfigScreen` all
  propagate a real success/failure result end to end, and a failed erasure now
  shows a dedicated alert (new keys
  `delete_wallet_failed_title`/`delete_wallet_failed_body`) and leaves the row
  enabled for retry instead of reporting a clean deletion that didn't happen.
- **KEK provisioning can no longer be silently downgraded or hijacked (XR-108,
  XR-109, XR-111, XR-116).** A self-consistent but forged `{policy:'degraded',
  kekId}` sentinel could previously ride the app's own automatic degraded-to-
  biometric upgrade and silently overwrite the real biometric KEK with an
  attacker's key; `upgradeToBiometric()` now reads the existing authenticated
  KEK first and refuses the upgrade outright if one is already there, and
  `doUnlock()` no longer treats a failed/refused mandatory upgrade as a
  successful unlock. A parseable-but-wrong-shape sentinel (a truncated write, a
  future/rolled-back version) used to read as "no wallet ever provisioned" and
  trigger a full KEK re-provision that orphans any other already-sealed secret;
  it's now treated as corrupt, not absent. `destroyKek()` and the migration's
  final legacy sweep now read back and retry a delete before reporting success,
  rather than trusting an unauthenticated SecureStore delete that iOS silently
  no-ops; `upgradeToBiometric()`'s own delete-then-trust step gets the same
  read-back-and-refuse-on-survival treatment.
- **Legacy plaintext can no longer be served after a failed migration
  (XR-112).** A cancelled or failed biometric-provisioning ceremony during
  legacy-secret migration used to fall through to reading the raw,
  unauthenticated pre-envelope mnemonic/recoveredKey directly — a fully
  signing-capable wallet built from one declined OS prompt, no cryptographic
  control involved. The migration-failure branch no longer special-cases a
  plaintext read; a failed migration now correctly reports no secret at all and
  retries on the next launch.
- **Custom ARC API token moved off plaintext storage (XR-106).** The optional
  custom ARC endpoint's bearer token — sent on every broadcast to that endpoint
  — was persisted in plain `AsyncStorage` and shown unmasked. It now lives in
  the platform SecureStore (`core/services/arcTokenStorage.ts`), with a one-
  time migration of any existing plaintext value; `WalletConfigScreen`'s token
  field is now `secureTextEntry`.
- **Degraded (non-biometric) KEK provisioning is now disclosed (XR-114).** A
  release device with no strong biometrics enrolled got an unauthenticated KEK
  with the same "Protect your assets with Face ID or your fingerprint" promise
  as a fully protected device. `BiometricAdvisoryModal` takes a `degraded` prop
  that swaps in an honest disclosure (new key
  `biometric_advisory_body_degraded`); `resolveProvisioningPolicy` is now re-
  exported from the package root so a host screen can check it without a new
  context method.
- Documented, not code-fixed: `kek.ts`'s delete-then-add rotation comment
  overclaimed a guarantee that does not hold on Android — `deleteItemImpl`
  there never calls `keyStore.deleteEntry`, so a rotation cycle silently reuses
  the existing hardware key (XQ-013). Not exploitable on its own (the KEK value
  is still fresh-random and still biometric-gated); fixing it needs a native-
  module patch, recorded as an open assurance gap rather than fixed here.

### Pairing and paired RPC

- **Superseded sockets are actually torn down (XR-018).**
  `connect()`/`reconnect()` used to overwrite the live socket reference without
  closing or detaching the one it replaced, so approving a second pairing (or
  reconnecting a saved session) while one was already live left the first
  socket's `onmessage` closure — still holding a valid `WalletClient`, topic,
  and identity — decrypting and dispatching RPC for as long as the relay kept
  it open. A `connectionGenerationRef` now gates every handler (`onopen`,
  `onmessage`, `onerror`, `onclose`) so a superseded socket's already-in-flight
  decrypt can no longer reach `handleRpc`. Disconnect and logout now actually
  tear down the live paired socket too: `WalletConnectionContext` exports
  `disconnectActivePairedSession()` so `WalletContext.logout()` (a React
  ancestor of the connection provider) can call it directly, and
  `ConnectionsScreen`'s Disconnect action calls the context's `disconnect()`
  first rather than only flipping stored status and sending a best-effort
  revoke message a non-cooperative peer can ignore.
- **Replay-watermark durability (XR-021).** The anti-replay sequence watermark
  advanced in memory immediately before dispatching a mutating RPC call, with
  its only durable write a fire-and-forget one in `disconnect()`/`onclose` — a
  crash in between let a retained relay message be replayed and re-executed on
  reconnect. The accepted sequence is now durably written and awaited before
  dispatch, with the message dropped (never dispatched) if that write itself
  fails; a follow-up serializes the check-write-advance sequence per connection
  so two concurrent messages can't each pass a stale check and land their
  durable writes out of order.
- **Origin display matches what gets approved (XR-023).** `PairScreen`'s
  approval card used to render the raw, uncanonicalized origin with default
  tail-truncation, so a long attacker-signed origin could show a trustworthy
  prefix while clipping the real registrable-domain suffix — and
  canonicalization only ran after the user had already looked and pressed
  Approve. The card now canonicalizes on mount (showing the error state instead
  of Approve/Reject if that fails) and truncates from the middle, so the domain
  suffix always survives.
- **Private-network destinations refused (XR-024).** Neither the pairing origin
  parser nor the relay-URL validator checked what class of address a hostname
  named — a self-signed pairing payload could point straight at a
  loopback/RFC1918/link-local/`.internal` address with no DNS trickery needed.
  Both now refuse via a shared `isPrivateNetworkHost` check (a floor, not a
  firewall — a public hostname that only resolves to a private address via DNS
  rebinding is not caught).
- **Bounded relay discovery reads (XR-025).** A length-less, non-streaming
  relay response could be buffered in full before its size was ever checked;
  that one specific shape (no `Content-Length`, no stream reader) now fails
  closed instead.
- **Aggregate RPC byte budget and a crypto-call size cap (XR-026).**
  `MAX_IN_FLIGHT_RPC` only bounded message count — several concurrently in-
  flight messages could each be near the 5 MiB per-message ceiling, multiplying
  peak memory. Concurrent messages on one connection now also share a
  `MAX_IN_FLIGHT_RPC_BYTES` budget equal to the existing single-message
  ceiling. Separately, `encrypt`/`decrypt`/`createHmac`/`verifyHmac`/`createSig
  nature`/`verifySignature` had no per-call size cap at all beyond the
  transport ceiling; they now share a 1 MiB `cryptoPayload` ceiling (halved on
  low-tier devices). A connected app sending an oversized crypto-call payload,
  or enough concurrent large messages to cross the shared budget, now has the
  call/message dropped or refused where it previously went through.
- **Saved-connection authenticity (XR-027).** A saved pairing record was plain,
  unauthenticated `AsyncStorage` JSON, checked only against the wallet's own
  public identity key on reconnect — insufficient to prove the record wasn't
  substituted. Approval now stages a wallet-root HMAC over the connection tuple
  (`connection authority` protocol namespace) that `add()` attaches to the
  record; reconnect verifies it and treats a missing/failed tag as "needs re-
  approval" (new key `reconnect_needs_reapproval`) rather than silently
  trusting it. A companion, more limited hardening requires an explicit
  confirmation naming the canonicalized origin before any reconnect at all (new
  keys `reconnect_confirm_title`/`reconnect_confirm_message`) — full binding
  would need an admin-scoped wallet threaded into `connect()`/`reconnect()`,
  left as a larger follow-up.
- **Auto-approve authority disclosed at pairing time (XR-028).** Approving a
  pairing silently grants that origin standing auto-spend authority (up to the
  persisted per-request threshold and the shared rolling 24h cap added in
  0.8.0). The approval card now names both before Approve is tapped; the
  underlying policy itself (a non-zero default threshold, and a cap shared
  across all origins rather than per-origin) is unchanged and still flagged as
  provisional pending product sign-off.

### Backup and restore

- **Wallet Check no longer reads a different identity's backup cursor as this
  wallet's own (XR-009).** `getBackupUploadState()` filtered by a bare,
  unscoped key prefix, so a same-device wallet swap (logout, then a new
  identity on the same install) could report the new wallet "backed up" using
  the old one's leftover cursor. It now takes `(chain, pseudonym)` and filters
  by the fully-scoped key; `logout()` sweeps `backupCursor-*` alongside the
  existing balance-cache sweep; `WalletContext` exposes a new
  `getBackupPseudonym(chain)` getter so the UI never needs the primary key
  itself.
- **LocalPay and PeerPay in-flight state now survives encrypted backup (XR-011,
  XR-012, XR-055).** `key_value_store` — and so a receiver's acknowledged-but-
  not-yet-internalized Nearby/QR payment, an outbound PeerPay delivery
  checkpoint, and every issued conventional-receive-address date — was entirely
  outside the twelve toolbox-table `CHUNK_ENTITIES` the backup codec knew
  about; a device loss before internalize/delivery completed could permanently
  strand real money even with a perfect seed-plus-backup restore of everything
  else. A new additive `appData` field on the existing per-chunk envelope
  (dropped by any reader that predates it, so mixed builds keep working) now
  carries `localpay_pending`, `peerpay_outbox`, and a new durable, count-capped
  issued-receive-date history (`core/pay/receiveHistory.ts`) through push,
  restore, and cross-device merge, applied through the same `setKeyValue` path
  — never `internalizeAction`, broadcast, or abort — so a replayed row is
  picked up by this device's own existing consumers exactly as if it had
  written it itself. `WalletCheckScreen`'s repair loop now scans every recorded
  issued-receive date instead of a fixed 30-day window, and the manual receive-
  screen stepper widens to roughly ten years. Disclosed, not fixed: an
  `appData`-only chunk can still never be sent alone (the toolbox's own sync
  protocol treats an all-empty chunk as end-of-log), so isolated
  LocalPay/PeerPay/receive-address activity in a window with no other wallet-
  entity change can still miss a push — pinned end-to-end by a new test and
  documented at each call site; `offline_actions` and `token_linkage_payloads`
  remain out of scope for this pass.
- **Restore-side resource bounds (XR-013).** Neither the remote sync index
  (`RemoteSyncReader.ensureIndex()`) nor the restore-side body reader had any
  cap beyond a server-supplied page-size hint and a time deadline. A
  `MAX_INDEX_ENTRIES` ceiling (50,000) and a `MAX_RESTORE_RESPONSE_BYTES` check
  against `Content-Length` (checked before any body reader is invoked) now
  bound both — partial, since a response that omits `Content-Length` entirely
  still can't be bounded on this platform's `fetch`.
- **A restored chunk must match its own index entry (XR-014).**
  `RemoteSyncReader.fetchAndDecode()` decrypted whatever bytes were returned
  for a sequence without checking them against that sequence's own indexed
  size/hash, so a malicious or compromised backup host could serve one
  sequence's genuinely-authentic ciphertext back under a different sequence
  number. Restore now rejects a length/sha256 mismatch. Documented as not a
  full fix: the envelope still doesn't bind device/generation/sequence into
  what it authenticates, and there's no persisted rollback checkpoint — both
  need a broader format change.
- **Every device in a multi-device manifest is now replayed on import
  (XR-015).** `restoreOnImport` used to replay only the single highest-ranked
  device's log; each device's log is an independent, non-overlapping history,
  so a second device's unique records (a change output, a BRC-29 receipt) could
  be permanently unreplayed after restore. It now replays every device present
  in the manifest into the same storage, merging by record identity exactly as
  ordinary live multi-device sync already does.
- **Clock-rollback recovery (XR-016).** An incremental push window only ever
  advances forward; a device clock moving backward could permanently orphan a
  record stamped below an already-closed window. `PushCursor` now tracks the
  highest wall-clock time ever observed and forces a full-snapshot rotation
  whenever the current time falls behind it.
- Locked, not changed: Android's `expo.android.allowBackup: false` (shipped in
  0.8.0) now has a regression test guarding it (XQ-005); the iOS backup-
  exclusion question and the malformed-but-SQLite-magic-passing import question
  remain open, needing a real device build to exercise.

### Mandala tokens

- **Legacy settlement rows can no longer hide from the abort guard (XR-033).**
  `token_settlements.reference` shipped later than the table itself, added by a
  bare nullable `ALTER` with no backfill — every pre-migration row reads
  `reference: undefined` forever, making it invisible to the abort guard's
  lookup regardless of which action is later aborted. The same migration step
  now backfills a blocked legacy row's reference from the `transactions` table
  (the same mapping `abortAction` itself matches against); anything the
  backfill can't resolve is covered by a coarser
  `hasUnresolvedLegacyBlockedRows()` check that refuses every abort while any
  such row exists, rather than risk releasing inputs a legacy row still has a
  claim on.
- **Token-abort guard fails closed (XR-034, XR-035).** A settlement-lookup
  fault or a not-yet-built runtime previously read as "no blocking row, abort
  is safe" — a transient DB error is not evidence a payment is safe to release.
  The guard now distinguishes "no Mandala endpoints configured for this chain"
  (provably no token action) from "the runtime hasn't built yet" or "a lookup
  faulted" (real rows may be unreadable), refusing in the latter two cases. The
  handle rail's settlement-journal write after a hand-over — the only durable
  evidence a transfer happened — is now retried on a transient fault
  (`upsertSettlementDurably`) rather than best-effort, closing the same root
  cause XR-035's regression test locks. `abortPeerPayNosend` also now checks
  its own `abortAction` result instead of assuming success.
- **Token-bearing offline holds aren't drainable until their journal lands
  (XR-036).** A token payment's offline-queue row used to go straight to
  `'queued'` (drainable) before its settlement journal write was confirmed; a
  process kill or transient write fault in that window let the automatic drain
  post a token transaction the overlay never admitted.
  `holdSentPaymentOffline`, `parkSentPaymentOffline`, and
  `releaseParkedPayment` now keep a token-bearing row at `'parked'` until the
  journal write is confirmed.
- **Cached admissions are scoped to the vout that actually needs them
  (XR-038).** A genuine, verified admission for any output of a multi-output
  token transaction previously stood in for the whole transaction's submission
  — a payer's own admitted change output could carry an unrelated, never-
  admitted output along with it. Admission caching now requires every vout the
  current walk actually needs to be inside the admission's own
  `outputsToAdmit`, backed by a new `TokenSettlementRow.relevantVout` column
  and the existing (previously unused) parent-vout edge data.
- **Fail closed on an unreliable token-input classification (XR-039).** A
  `listTokenOutpoints()` failure used to forward a `createAction` unchanged
  instead of forcing Mandala's own consent review — a transient listing fault
  or a basket over 10,000 outputs silently skipped the one thing that routes a
  token spend's inputs to a token-aware review. It now forces the Mandala label
  on any listing failure, and the listing itself paginates to completion
  instead of reading one capped page.
- **Every asset of a multi-asset approval is now shown (XR-040).**
  `PermissionSheet` rendered only the primary asset/amount fields of what could
  be a multi-asset `createAction`/`internalizeAction` — a connected app could
  place an innocuous asset first and an unshown transfer right behind it in the
  same approval. Every line is now rendered (numbered when more than one), and
  a malformed or oversized `lines` payload now blocks approval outright instead
  of falling back to the old primary-only view.
- **Relinquish consent now names what's being removed (XR-041).** "Wants to
  remove a Mandala token holding" named no asset, amount, or outpoint. The
  prompt now resolves the target against this device's own current basket
  listing (never the caller's claim) and names asset, amount, and outpoint —
  refusing the whole call if it can't be conclusively resolved.
- **A verified admission can't be undone by a later unsigned refusal
  (XR-042).** An overlay's positive verdicts are signature-verified; its
  negative (`refused`/`evicted`) verdicts are raw, unauthenticated HTTP — but
  both were fed to settlement state unconditionally. A row already carrying a
  verified admission for a txid is now left alone (or treated as a stall)
  rather than downgraded by a later unsigned refusal.
- **Token decimals bounded everywhere one is read (XR-043).** An extreme
  `decimals` value from a session QR or a registry entry had no upper bound;
  `formatTokenAmount(500, Number.MAX_SAFE_INTEGER)` reliably threw `RangeError:
  Invalid string length`, and the crash re-triggered on every later render
  since the metadata persists. Decode, registry resolution, formatting/parsing,
  and the input mask now all clamp or reject outside `[0, 18]` — a host calling
  `formatTokenAmount`/`parseTokenAmount` directly with an out-of-range value
  now gets `null` back instead of a thrown exception.
- **Issuer and asset fingerprint shown before send (XR-044).** Two assets
  sharing a ticker (a look-alike distributed by a malicious issuer) were
  visually indistinguishable through the whole select-to-send flow. The asset
  switcher, asset picker, and the Send review step now all show `issuerName ·
  fingerprint` alongside the ticker.
- **Real token actions now reach the consent gate (XR-037).** Two different
  constants both named `MANDALA_ACTION_LABEL` — one for home-screen
  recognition, one for the P-routed `listActions` consent gate — and only the
  former was ever applied to a nearby build or a handle-rail credit, so a real
  Mandala action's metadata (txid, satoshis, description) was visible to a
  paired caller's `listActions` with no consent prompt of any kind. Both labels
  are now applied at every write site; `guard.ts`'s external-facing
  `sanitizeAction` also now strips `customInstructions` directly as defense in
  depth, rather than relying solely on a vendored patch doing it one layer
  down.
- **Token conservation enforced before crediting a nearby tip (XR-099).**
  `verifyFramePayment`'s token branch checked ownership, asset, and ancestry-
  admission, but never that token input value covers token output value —
  Mandala's own COVER walk has no notion of amount at all. A payer could spend
  a small admitted coin into an output naming any larger amount and have it
  credited. A new `tokenConservationHolds` check sums the tip's own direct
  token inputs against its outputs for the frame's asset and refuses
  (`not_covered`) if they don't cover it.
- A held withdraw/relock now resolves cleanly for tokens too, and
  `wrapAbortActionForSettlements`/`processAction` fail the whole batch closed
  rather than report an indeterminate held/not-held classification when
  `token_settlements` can't be read for a broadcast decision (XR-045) — see
  Wallet repair, proofs, headers, and broadcast below for the shared broadcast-
  guard change.

### Nearby / LocalPay

- **Pending-abort queue integrity and authenticated replay (XR-088, XR-102).**
  A read/parse failure against the local pending-abort queue collapsed to
  "empty," so the next queue write silently erased every other durable, not-
  yet-replayed abort reference; a fault now refuses the write instead of
  overwriting. Every queued abort reference is now HMAC-tagged at write time
  (`pending abort authority` protocol namespace) and re-verified before replay
  — a forged or untagged `pending_aborts` KV entry naming a live action
  reference is now dropped rather than replayed, surfaced to the user via a new
  notice (keys `local_pay_pending_abort_dropped_title`/`_body`) pointing at
  Activity's manual per-row cancel.
- **Bounded inbound frame/ack decode (XR-090).** The shared base64-decode-then-
  AES-GCM-decrypt-then-parse layer every transport (AWDL, Nearby, BLE) funnels
  through had no size ceiling of its own. It now rejects an oversized encoded
  or decoded payload before `atob()`/decrypt/parse ever runs (reusing
  `@bsv/air-gap`'s existing 64 KiB frame ceiling; a much smaller ceiling for
  acks); the Android Nearby native receive path is mirrored for the same gap
  but is unverified without a device build.
- **Never trust the payee's QR ticker/decimals for a real, unresolved holding
  (XR-091).** A local ticker-resolution failure for a real, spendable holding
  used to fall back to the payee's own unauthenticated session ticker/decimals.
  It now fails closed to an "asset unidentified" state that disables Send,
  rather than adopting the QR's claim — a brand-new, never-before-seen offline
  asset (no local holding at all) is unaffected, since it has no known figure
  to override.
- **A malformed pending queue is quarantined, not read as empty (XR-092).** Any
  syntactically valid non-array JSON under the LocalPay pending key used to
  silently become an empty queue — and the very next save then destructively
  overwrote whatever it actually held. It now takes the same quarantine-and-
  notify path a JSON parse failure already does.
- **Settlement-ack verification is bound to the payee's own output (XR-093).**
  A verified admission for a sibling output on the same transaction (e.g. the
  payer's own change) previously counted as proof of the payee's own
  settlement. Verification now requires a matching output index too.
- **Two remaining unconditional-release paths on a decline are closed (XR-095,
  XR-103).** WalletHomeScreen's generic Activity "Abort" action could release a
  parked nearby payment's inputs with no chain-status check, bypassing the
  dedicated cancel-parked flow's gate; it now respects the same `!parked` guard
  the row's own action chip already applied. A decline whose chain status is
  genuinely unresolved — or whose txid the chain already shows — is now parked
  (or refused) rather than released, closing the remaining window where a lying
  or merely-early decline could race a real payment.
- **Ambiguous send outcomes are now parked, not dead-ended (XR-096).** A screen
  unmount mid-`radio.send()`, or a radio failure whose frame is too large to
  fall back to a QR, previously left a signed reservation with no durable
  trace. Both now park the payment (the oversized case gets a real recovery
  path too, since a message-box resend has no QR size limit).
- **Single-flight guards on Send and on session settlement (XR-097, XR-098).**
  Nearby Send lacked a synchronous re-entrancy guard, so two overlapping
  presses could each build and reserve their own noSend action with only one
  recoverable; the session claim itself (check, persist, burn) was three
  separate operations that a radio delivery could race against a QR scan for
  the same session. Both are now atomic — a single synchronous latch on Send,
  and a single locked `claimAndSavePending` for the settlement claim.
- **Overlay unreachability is no longer read as "not admitted" (XR-100).**
  `cancelParkedPayment`'s token check only special-cased a definite
  `'admitted'` verdict; a genuinely unreachable overlay fell through to the
  same-as-offline BSV check with no verification at all. It now routes an
  unreachable/unavailable overlay through the same "unverifiable" confirmation
  gate the BSV-rail check already uses, once a settlement row proves the
  payment was genuinely handed over.
- **Oversized notes can no longer strand a payment (XR-101).** A received peer
  note has no wire-level length cap; `internalizeAction`'s real 2000-byte
  description limit throws rather than truncating, so a hand-crafted oversized
  note could make every retry fail until the pending-attempts ceiling
  permanently stranded an already-accepted payment. The constructed description
  is now truncated on a UTF-8 byte boundary before `internalizeAction` is
  called (display-only; the payment itself is unaffected).
- **Overlay identity anchored to device config (XR-104).**
  `buildTokenPaymentFrame`'s exported, documented entry point read the payee's
  session-claimed overlay identity/URL directly, which could redirect this
  device's `SpecificKeyLinkage` disclosure to a verifier of the payee's
  choosing; the app's own single caller already guarded against this ad hoc,
  but the exported function itself did not. It's now read from device config,
  never the session.
- **Stale offline-queue bookkeeping is reconciled (XQ-009).** A
  `networkAlreadyHas` check trusted a bare `'mined'/'known'` status string with
  no proof — now also requires a validated Merkle proof
  (`EntityProvenTx.fromTxid`) against this device's own chain tracker before
  treating that as confirmation the network already has a transaction.
  Separately, a row legitimately marked `'sent'` had no path back to
  reconciliation if its backing request later moved to `'invalid'` (a reorg, a
  proof timeout); `reconcileStaleSentActions()` now revisits and reclassifies
  such rows.

### PeerPay / handle rail

- **Duplicate-delivery detection narrowed to the structured code (XR-046).**
  `isDuplicateMessageError` matched free prose in a thrown error's message,
  entirely attacker/host-controlled; it now requires `@bsv/message-box-
  client`'s own structured `ERR_DUPLICATE_MESSAGE` code, which the client
  validates before embedding.
- **Inbox shape-check bounded (XR-047).** An unbounded
  `transaction`/derivation-string length in a poisoned inbox message re-
  triggered a full scan on every poll and background credit pass; both are now
  capped against the existing shared `walletArgLimits` ceilings before the scan
  runs.
- **Retried entries are re-verified before broadcast (XR-048).** A retried
  outbox entry's persisted `txid` was handed to `broadcastNoSend` with no check
  that it actually corresponded to the entry's own token; a tampered store or
  restore could point it at an unrelated pending action. The txid is now re-
  derived from the entry's own token and required to match before broadcasting.
- **Abandon no longer releases inputs the recipient may already hold
  (XR-049).** Abandoning a delivered/delivering handle payment used to call
  `abortAction` whenever it happened to succeed — never safe once a signed
  token may already be with the recipient. Abandon now never calls
  `abortAction`; it only drops the local tracking row. A companion fix keeps
  the row (with the error recorded) rather than removing it unconditionally
  when an abort attempt during abandon fails or throws.
- **Broadcast confirmation requires a positive result (XR-050).** Any
  `sendWith` result shape other than an explicit matching `'failed'` entry was
  previously read as success; it now requires an explicit match with
  `'sending'`/`'unproven'` status, failing closed on
  missing/empty/unrelated/duplicate/unknown-status results.
- **Resend requests are authenticated against the recorded recipient
  (XR-051).** A `resend_request` control message from any authenticated sender
  with a guessed real txid could force the full resend workflow repeatedly,
  forever. It's now checked against the payment's actual recorded/resolved
  recipient before any work happens.
- **Retry side effects re-read the row first (XR-052).** A retry's network
  calls could complete anyway even after a concurrent user-triggered
  abandon/cancel removed the outbox row mid-flight. The row is now re-fetched
  immediately before each side-effecting call, and the retry stops cleanly if
  it's gone.
- **Overridden delivery host shown before send (XR-053).** A `peerpay:` link's
  `url` extension can silently redirect delivery to a different MessageBox host
  with no identity binding; the review screen now shows the host whenever one
  is link-supplied (new key `pay_review_delivery_host`) — the underlying trust
  gap (no signed delivery receipt) is unchanged and not claimed as closed.
- **Generic Activity abort refuses an unaccounted-for send (XR-012).** The
  Activity screen's generic Abort button had no PeerPay awareness at all; a
  restored wallet with no outbox row for an already-delivered/delivering send
  could have its inputs released on a payment the recipient may already hold. A
  new `isAbortSafe` check (also used internally by the existing cancel flow)
  now refuses it (new key `tx_abort_maybe_delivered`).

### Address rail and the Pay screen

- **Bounded sweep work (XR-054).** A dusted receive address's sweep re-fetched,
  verified, and internalized every distinct-txid UTXO on every 30-second pass
  with an O(n^2) grouping step; sweeps are now capped at 200 distinct
  transactions per pass (anything left over is picked up on the next pass —
  nothing is lost or double-credited) with the grouping made linear.
- **Sweep receipt amount comes from the verified transaction (XR-056).** The
  "Received" overlay and background notification summed the untrusted indexer
  listing's claimed value rather than the cryptographically-committed output
  amount on the already-parsed, already-verified transaction; the wallet's
  actual balance was never affected, but the displayed figure could be wrong.
  It now sums from the parsed transaction's own output.
- **`sendToAddress` rejects non-P2PKH addresses itself (XR-057).** The P2SH-
  rejection guarantee this rail relies on lived entirely inside `@bsv/sdk`'s
  internals with no repo-owned check; `sendToAddress` now rejects any non-
  mainnet/testnet-P2PKH version byte before building a locking script,
  independent of the SDK.
- **Bounded UTXO listings and BEEF/hex response sizes (XR-059).** An oversized
  indexer response could force unbounded per-txid network fanout and unbounded
  hex-decode/merge work; `getUtxosForAddress` is now capped at
  `MAX_UTXO_LISTING_ROWS` (2000) and hex bodies at `MAX_HEX_RESPONSE_CHARS`
  (8,000,000) on both the address-sweep and PeerPay reorg-repair paths, and
  later extended to `WalletContext.refreshProof`'s own merkle-BUMP and raw-tx
  hex reads.
- **Every conventional-receive date is scanned for recovery, not a fixed window
  (XR-055)** — see Backup and restore above; the address-rail side of that fix
  widens `recoveryDatesToScan` and the manual receive-screen stepper.
- **Synchronous send latches (XR-061, XR-097).** `UniversalSend.handleSend` and
  Nearby's own send path each relied only on async React state for mutual
  exclusion, so two press activations landing in the same JS turn could
  independently invoke a value-moving rail call. Both now set a synchronous
  ref-backed latch as their first statement, before any `await`.

### Wallet repair, proofs, headers, and broadcast

- **Verify the alleged spender before marking a UTXO unspendable (XR-031).**
  Wallet Check committed `spendable:false` as soon as two chain-service sources
  agreed an output was spent, before ever checking that the alleged spender's
  own inputs referenced that outpoint. It now fetches and verifies the
  spender's BEEF first and requires an actual matching input.
- **Stuck-reservation release is corroborated (XR-032).**
  `releaseStuckReservations` restored every input reserved by a locally
  `'failed'` transaction unconditionally, with no check against the safer
  `proven_tx_reqs` status set the sibling repair path already uses; it now only
  releases a reservation whose spender's proof-request rows are all in the
  safe/terminal set.
- **Header-sync and broadcast-log bounds (XR-060).** A `getHeaders` response
  could return far more than was requested with no check on the returned
  length; header sync now truncates to exactly what was asked for. Broadcast
  response bodies logged in full with no size cap; logging is now capped at
  2000 characters (classification still runs over the full body).
- **Orphan-mempool is no longer treated as a double spend (XR-062).** ARC's
  `SEEN_IN_ORPHAN_MEMPOOL` status — an ordinary propagation-timing condition,
  not a proven conflict — was classified identically to a real double-spend and
  triggered the same terminal rejection cascade for a chained/offline payment.
  It now sets a retryable service-error instead.
- **Broadcast body reads are bounded by time and size (XR-063, and the XR-060
  remainder).** The ARC/WhatsOnChain broadcast providers cleared their timeout
  as soon as headers arrived, before reading a potentially stalling or
  oversized body — hanging the whole broadcast attempt with no fallback ever
  tried. The body read is now raced against the same deadline as the
  connection, and capped at `MAX_BROADCAST_BODY_BYTES` (1,000,000 bytes).
- **Custom ARC endpoint policy (XR-064).** A custom ARC URL was persisted with
  no scheme/origin validation, and a saved API token could silently carry over
  to a newly entered, unrelated host. It now requires https (with a loopback
  dev exception, new key `arc_url_https_required`), clears a token when the
  origin changes, and requires an explicit accepted ARC status or matching txid
  before treating a broadcast response as successful (closing a bare `200 {}`
  response that previously suppressed the real HTTPS fallback chain).
- **Backup/Mandala/MessageBox origin policy (XR-065).** These three
  configurable origins had no scheme policy at all (unlike the handle
  registry's own); they now share the same https-required
  (loopback/RFC1918-dev-exception) check.
- **`taalApiKey` no longer aliases `whatsOnChainApiKey` (XR-066).** A key
  scoped to WhatsOnChain was silently sent to TAAL's own broadcast origin too.
  A host that relied on the old fallback must now set
  `EXPO_PUBLIC_TAAL_API_KEY` explicitly (README updated); no wallet funds were
  ever at risk from this, only quota/credential exposure.
- **Unknown chain string fails safe to testnet, not mainnet (XQ-011).** A
  corrupted or garbage persisted network value resolved broadcast to the live
  mainnet endpoint, the most privileged branch — every sibling consumer of the
  same value already collapsed safely. It now matches them.
- **`recordProof`'s directly-fetched raw tx is hash-checked (XR-029).** The
  BUMP/root check only proves the requested txid is confirmed; nothing checked
  that a separately-fetched raw-tx response actually hashed to that txid before
  completing a transaction on it. It now requires `doubleSha256(rawTx) ===
  txid`.
- **Only an authoritative 404 proves chain absence (XR-030).** A manual proof
  refresh treated any non-2xx response (a rate limit, a 5xx, an auth error)
  identically to a definitive 404 and released reserved inputs on a stale row;
  now only a 404 counts as proof of absence.
- **Proof-of-work required outside the validated header window (XR-068).** A
  miss or reorg-tail chaintracks answer was trusted on a bare, unauthenticated
  `merkleRoot` with no PoW/linkage check at all; it's now required to satisfy
  its own declared target before being trusted or cached (partial — no chain-
  of-custody to a trusted checkpoint yet, so a forger who could actually mine a
  low-difficulty historical header is still out of scope of this fix).
- **Token broadcast guard fails closed on a read fault (XR-045).**
  `tokenSettlementTxids()` collapsed a genuine `token_settlements` read failure
  to the same empty result as "no token requests in this batch," so a transient
  fault could let an unadmitted token request post straight past overlay
  admission. It now throws on a read failure, and the one caller that can
  actually broadcast holds the whole batch rather than deciding off an
  incomplete answer.
- **No overlapping background task passes (XR-105).** `TaskSendOffline` and
  `TaskBackupPush` had no dedup guard against a watchdog restart racing a hung
  pass, unlike two sibling tasks already protected; both now share the same in-
  flight guard.

### Database import and export

- **CSV export can no longer carry a live spreadsheet formula (XR-078).** A
  remote-supplied note beginning with `=`, `+`, `-`, `@`, a tab, or a CR became
  a live formula on open in a spreadsheet application. Untrusted free-text
  columns (description/tags/labels) are now formula-neutralized (OWASP leading-
  apostrophe mitigation); a follow-up fix scoped that neutralization away from
  the trusted, app-derived numeric/txid/status/blockHeight columns it had
  initially been applied to as well, which it had been corrupting (e.g. turning
  every outgoing amount into text).
- **Unencrypted export now warns first (XR-086).** `exportAllWalletDatabases()`
  hands a raw, unencrypted SQLite image to the OS share sheet with no
  passphrase step; a warning naming what the file contains, with a real cancel,
  now appears first (new keys
  `export_unencrypted_title`/`export_unencrypted_message`). Full at-rest
  encryption is a larger, deferred product decision (the importing device would
  need a way to get the key back).
- **Import file size ceiling (XR-087).** A picked backup was read into memory
  with no size check at all. A 256 MiB ceiling is now enforced against both the
  picker-reported size and the actual read length before any deserialization
  (new keys `import_oversized_file`/`import_oversized_file_detail`).
- **Raw database imports are authenticated before becoming active (XR-079, and
  the narrower XR-080/XR-084 variants it also closes).** Identity, chain, and
  freshness were derived purely from the picked filename, never the file's
  contents — a same-filename import could overwrite the live database, a same-
  suffix foreign database could win the next build's file selection, and the
  spendability-reconciliation pass an encrypted restore always runs was skipped
  entirely. An import now requires the deserialized image's own settings row to
  match the currently unlocked wallet's identity and chain, rejects a filename
  timestamp more than 5 minutes in the future, always synthesizes a destination
  filename distinct from every live or registered one (never reusing the picked
  name), and routes through the same `reviewSpendableOutputs` reconciliation
  pass an encrypted restore uses.
- **Imported queues and caches are quarantined at the import boundary, never
  trusted as live state (XR-081, XR-083, XR-085).** A wholesale-imported
  database could seed the live LocalPay pending queue with a frame that never
  passed ownership/session/asset verification (now stripped on import), plant a
  forged `proven_txs` row that could later let a forged proof pass as chain-
  proven (now stripped), or silently auto-rebroadcast an already-aborted
  `queued`/`posting` `offline_actions` row the instant the app goes online (now
  rewritten to a new `'import_hold'` status the automatic drain never selects,
  surfaced in Activity as "Held (imported)" — new key `tx_status_import_hold` —
  with no UI yet to promote a held row back to queued, a deliberate, disclosed
  gap). `refreshProof` and the WalletHomeScreen activity query both recognize
  `'import_hold'` so a stale imported row can't be mistaken for a failed one
  and have its inputs released via the manual Refresh action.
- **Weakened or extra schema objects are rejected, not silently kept forever
  (XR-082).** A crafted image could keep an allowed table/index's name while
  dropping a `UNIQUE`/`NOT NULL` constraint, or smuggle in an extra
  trigger/view/virtual table/table — `CREATE ... IF NOT EXISTS` never repairs
  an existing weakened definition. Import now compares each allowed object's
  actual definition (as an order-independent, whitespace-normalized
  column/constraint set, so a genuine additive migration's reordered columns
  are still tolerated) against a disposable in-memory reference schema, and
  rejects anything outside the allow-list entirely.

### Identity, registry, trust, and network destination policy

- **A shared public-destination check closes several SSRF-shaped gaps
  (XR-073).** Nothing previously bound a foreign paymail domain's advertised
  capability templates or SRV target, a user-typed trust-provider domain, a
  trust manifest's icon URL, a search-result avatar, or the identity-avatar
  resolver's http(s)/UHRP fallback to an actual public internet destination —
  each could be pointed at a loopback/RFC1918/link-local address with no DNS
  trickery needed. A shared `isPublicHttpsUrl`
  (`core/net/publicDestination.ts`) — a floor, not a firewall, since there's no
  synchronous DNS resolution on this runtime to catch rebinding — is now
  applied at all of them: handle-registry discovery, `TrustScreen`'s manifest
  fetch and icon prefetch, `searchIdentities()`'s avatar mapping, and
  `resolveAvatarURL`'s http(s)/UHRP branches.
- **Trust-manifest fetch bounded and its deadline covers the body (XR-074,
  XR-075).** The manifest fetch had no byte cap at all, and its timeout was
  disarmed as soon as headers arrived — a slow or dripping body could hang the
  loading state forever. It's now capped at 64 KiB with the same deadline
  racing the body read, not just the connection.
- **Downgraded trust-provider imports refused (XR-076).** An explicit `http://`
  domain was accepted verbatim, and a manifest fetch followed redirects with no
  origin check. Both are now refused outright — an explicit `http://` domain
  fails before any request, and the manifest fetch fails closed on any
  redirect.
- **Handle-registry bodies bounded by byte count (XR-077).** Every handle-
  registry read shared one timeout-only body reader; a foreign or compromised
  registry could pace an unbounded body just under the deadline. A 256 KiB
  ceiling now applies before any JSON parse.
- **Deep-linked identity keys are never rendered as "Your Identifier"
  (XR-070).** A crafted `bsv-wallet://identifier?identityKey=...` deep link
  could render an attacker's key as the user's own QR/copy/share target. The
  screen now always fetches and displays only the wallet's own key; a route-
  supplied key is only ever compared against it, never rendered.
- **Trust-on-first-use key pinning for paymails (XR-071).** A compromised or
  malicious registry — including the pinned one — could mint a fresh
  certificate redirecting an already-resolved paymail to a different key. The
  first key ever resolved for a paymail is now pinned; a later certificate
  under a different key for the same paymail is dropped regardless of which
  registry served it (a from-scratch resolution of a paymail never seen before
  is inherently unprotected by TOFU, and is out of scope).

### Vendored toolbox patch

- **`abortAction` fails closed on an unresolved chain status (XQ-016).**
  `@bsv/wallet-toolbox-mobile` 2.14.0's `StorageProvider.abortAction` treated a
  thrown/timed-out/non-success chain-status lookup as safe to invalidate and
  release a `nosend` action's reserved inputs — including one already handed to
  a counterparty over PeerPay or LocalPay, turning a chain-status outage into a
  payer-side double-spend race. The patch (`patches/@bsv+wallet-toolbox-
  mobile+2.14.0.patch`) now retries the chain-status check once and, if still
  unresolved, throws instead of invalidating — every in-app `abortAction`
  caller already handles a thrown result sensibly, and Vault's own abort calls
  (strictly unsigned-only) are unaffected. Verified end to end through Vault's
  own retry-heal path, not only in isolation.

### Storage schema

- **`transactions` table gains the vendor's BRC-177 `noSendExpiry*` columns
  (NEW-01).** `@bsv/wallet-toolbox-mobile` 2.14.0 reads and writes
  `noSendExpiryState`/`noSendExpiryReclaimTxid` and related columns this
  package's schema never added — every `'failed'` transition of a signed
  `nosend` transaction (an aborted action, a failed broadcast, a proof-check
  timeout, or the periodic invalid-request sweep) threw "no such column"
  instead of completing, wedging state inconsistently app-wide. A new
  idempotent `ensureTransactionsColumns` migration (called from `createTables`,
  so both a fresh and an existing database pick it up) adds the columns, and
  `findSql.ts`'s column lists are updated so a `noRawTx`-projected read doesn't
  silently drop them.

### Copy and translations

24 new keys across the sections above, in all 12 languages:
`delete_wallet_failed_title`, `delete_wallet_failed_body`,
`vault_resume_draft_confirm_title`, `vault_resume_draft_confirm_body`,
`vault_resume_draft_confirm_use`, `vault_resume_draft_confirm_discard`,
`vault_seed_not_preserved_title`, `vault_seed_not_preserved_body`,
`vault_seed_not_preserved_cta`, `vault_resolve_held_deposit_none`,
`reconnect_needs_reapproval`, `reconnect_confirm_title`,
`reconnect_confirm_message`, `arc_url_https_required`,
`export_unencrypted_title`, `export_unencrypted_message`,
`import_oversized_file`, `import_oversized_file_detail`,
`tx_abort_maybe_delivered`, `tx_status_import_hold`,
`local_pay_pending_abort_dropped_title`,
`local_pay_pending_abort_dropped_body`, `biometric_advisory_body_degraded`,
`pay_review_delivery_host`. `vault_reset_unknown_ack` is also corrected in
every locale: it previously told the user a physically-occupied, locally-
unrecognized YubiKey slot definitely belonged to no vault on this device, a
certainty SecureStore's per-identity isolation cannot actually support; it now
discloses the uncertainty instead of overclaiming it. Non-English copy is
machine-drafted and awaits native-speaker review, same as every previous
translation batch in this changelog.

### Known residuals

Full disposition of every ledger row (fixed, already-fixed, invalid, needs-
hardware-or-network, out-of-scope, or partial-with-a-recorded-blocker) and its
proof artifacts are in `docs/security/external-review-closure.md`. Residuals
surfaced above, collected here for visibility:

- The physical-hardware run (a real, previously-enrolled YubiKey through a full
  chain-recovered-lock-to-withdraw path) is still unrun for the Vault
  generally, and production keeps Vault output creation disabled until a v7
  lock has actually been broadcast, mined, and exercised on physical hardware.
- Backup's `appData` channel still can't carry an isolated, single-entity
  change on its own (an all-empty chunk is the sync protocol's own end-of-log
  signal), and `offline_actions`/`token_linkage_payloads` are still outside
  encrypted backup; the restore path still can't bound a response with no
  declared `Content-Length`, and the chunk envelope still doesn't bind
  device/generation/sequence into what it authenticates.
- Full saved-connection binding still needs an admin-scoped wallet threaded
  into `connect()`/`reconnect()`; the auto-approve default threshold and shared
  daily cap remain provisional pending product sign-off.
- PeerPay and LocalPay still have no signed delivery/non-delivery receipt
  protocol — a dishonest decline made while the payee is genuinely offline, or
  one that reaches the chain only after this device's own check runs, is
  handled by detect-and-warn, not prevention.
- Header validation outside the locally-validated window still has no chain-of-
  custody back to a trusted checkpoint, so a forger capable of mining a valid
  low-difficulty historical header is not excluded by this pass alone.
- The iOS backup-exclusion question and the malformed-but-SQLite-magic-passing
  import question both need a real device build to close; an imported,
  quarantined `'import_hold'` offline-action row still has no in-app path to be
  reviewed and re-promoted to `'queued'`.
- Android's KEK delete-then-add cycle still does not rotate the underlying
  hardware key (a vendored `expo-secure-store` limitation, not exploitable on
  its own).

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
snapshot. The fix is a **seal carried inside ordinary chunks**, never a new
kind of log entry: `PushCursor` (`cursor.ts`) gains `initialChunkCount`,
recorded the first time a generation's `since` window closes (and
back-filled in memory for a pre-existing cursor whose window had already
closed under an older build), and every chunk `pushOnce` appends from then
on carries `seal: { generation, initialChunkCount }` in the same
`{chain, chunk}` envelope (`encodeChunk`'s optional fourth argument;
`decodeEntry` returns `{kind:'chunk', chunk, seal?}`; `decodeChunk` is an
unchanged wrapper). An unsealed chunk is byte-identical to the old format,
and an **older app build** reading a sealed chunk simply ignores the extra
field — its `decodeChunk` only ever reads `envelope.chunk` — so mixed
builds against one backup account keep working. (An earlier iteration of
this fix on the branch wrote the seal as a separate marker entry; that
would have crashed older readers and was replaced before release.)

`RemoteSyncReader.verifiedComplete()` decodes only the newest entry and
reports true when its seal names this generation and `initialChunkCount`
is no larger than the number of entries present — the initial snapshot is
fully there, and later deltas keep it verified. `restore.ts`'s `pickTarget`
ranks every candidate by `updatedAt` and picks the first one whose reader
reports `verifiedComplete` — an older but sealed generation beats a newer
one still mid-rotation — falling back to the previous newest-only heuristic
(`verified: false`) only when nothing in the manifest is sealed, so a fully
legacy manifest still restores exactly as before. `RestoreResult` /
`RestoreOnImportResult` gain `verified: boolean`; `restoreOnImport.ts`'s
own `newestTarget()` was dropped in favour of the shared `pickTarget`.

The signal now reaches the user: `BackupRestoreState` gains
`verified?: boolean`, `RestoreOutcome` / `RecoveryOutcome`'s `ok` variant
gains `verified: boolean`, and `restorePrompts(t)` gains
`restoreUnverified()` — a single-button alert (new keys
`restore_backup_unverified_title` / `restore_backup_unverified_body`, all 12
locales) that the mnemonic and scan-shares screens show before celebrating
when a restore succeeded but could not be confirmed complete. An idle wallet
whose generation never received a delta after its initial window stays
unsealed until it does; that only ever costs the "may be incomplete" notice,
never a refused restore.

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
