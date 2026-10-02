# Research report: rename and delete (zero-balance only) for wallet profiles

All paths below are under `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/` unless they start with `docs/` or `/Users/personal/git/go/`. Nothing was modified. Items I could not verify are marked **UNCERTAIN**.

## 0. Summary of recommendations

1. **Rename:** add a private `name?: string` to `ProfileRecord` in the profile store. Do not reuse `profile_display_name`. It is public once a handle exists, and it lives in a SQLite DB that is closed for inactive profiles.
2. **Delete:** offer it only for the **active, non-zero-index** profile, from the Profile screen. The user switches to the profile first. That gives an open DB, a known user id, a working mandala runtime and a live signer for releasing the handle.
3. **Representation:** a `deleted?: true` tombstone on the dense array. Never reuse the index, because the index is the derivation path `m/0'/n'`.
4. **Four things that are easy to get wrong** (sections 2 to 4):
   - `eraseRemoteBackup` flips a global opt-out.
   - A discovered-but-never-built profile has no checkable balance.
   - Releasing a handle needs the signer, so it must happen before teardown.
   - Erasing a middle profile's backup hides later profiles on reimport.

One framing point for the user's doubt about delete. A profile is a pure function of the seed (`m/0'/n'`), so the identity can never be destroyed. "Delete" can only mean "forget locally and withdraw public claims". The zero-balance rule is what keeps that safe, since a hidden profile is no longer monitored. I recommend the button copy say "Remove" rather than "Delete".

---

## 1. RENAME

### 1.1 What the existing display name is

- **Storage:** the per-DB `key_value_store` key `profile_display_name` (`ui/screens/ProfileScreen.tsx:79`).
  - Read at `:139`, written at `:376`.
  - The schema is `core/storage/schema/createTables.ts:339-344`.
  - Reading it needs an open DB (`core/storage/StorageExpoSQLite.ts:293-299`, which calls `getDB()`).
- **Published when a handle exists:**
  - The code comment says "a PUBLIC plaintext field of the profile certificate" (`ProfileScreen.tsx:73-78`).
  - `buildProfileCertificate` writes `fields.displayName` (`core/identity/handleRegistry/profileCert.ts:86-87`).
  - `onSaveDisplayName` stores locally, then calls `updateProfile(...)` to republish, but only `if registeredPaymail` (`ProfileScreen.tsx:371-403`, publish at `:380-399`).
  - The i18n hint says "Shown publicly next to your handle. Anyone who looks you up can see it." (`core/i18n/translations.tsx:1129`).
  - Claim and change also embed the current name (`ProfileScreen.tsx:337-339`).
  - Verification returns it as `RegistryProfile.displayName` (`profileCert.ts:66,188-194`), and other users see it in recipient search (`ui/components/pay/UniversalSend.tsx:617`).
- **Local-only when no handle exists:** the early return at `ProfileScreen.tsx:380` skips publishing.
- **Not published anywhere else.** I grepped for `publiclyReveal*` in `core` and `ui` and found nothing. The identity-overlay `name` is a read-only fallback (`ProfileScreen.tsx:149-165`).
- **Not in the remote backup.** The only key_value rows that ride the backup are `localpay_pending`, `peerpay_outbox` and receive-issued dates (`core/backup/appData.ts:77-80`). The display name does not survive a restore. A registered handle and its published name come back via the registry reverse lookup (`ProfileScreen.tsx:255-289`).
- **Avatar:** per-profile AsyncStorage `wallet_user_avatar_icon` (`core/userAvatar.ts:26,43,73`). The popover shows only the active profile's avatar and a default glyph for the others (`ui/components/wallet/ProfileSwitcherPopover.tsx:56,147-152`).

### 1.2 Reuse vs separate field

**Recommendation: separate private `name` on `ProfileRecord`.**

- **Inactive profiles:** their DBs are closed. Teardown calls `storage.destroy()` (`core/context/WalletContext.tsx:2837-2841`). Reading the display name for N rows would mean opening N SQLite files whenever the popover opens.
  - expo-sqlite 57.0.3 has no read-only open flag (`node_modules/expo-sqlite/build/NativeDatabase.d.ts:29-60` lists only `enableChangeListener`, `useNewConnection`, `finalizeUnusedStatementsBeforeClosing` and `libSQLOptions`).
  - `openDatabaseAsync` creates the file if absent. That is why `probeForLegacyDb` exists and deletes what it created (`WalletContext.tsx:684-709`).
- **Privacy:** a label like "Savings" or "Work" is private. Reusing the display name would publish it whenever a handle exists.
- **Design intent:** the profile store exists so "screens read it during render" and it is "read BEFORE any database opens" (`core/profiles/profileStore.ts:8-12`). Labels are exactly that kind of state.
- **Precedent:** `network` and `identityKey` already live in the store. Discovery rebuilds records without names, so a restored device falls back to `profile{n+1}`.

**Concrete changes:**

1. `ProfileRecord.name?: string` (`profileStore.ts:31-38`).
2. `parseProfilesState` copies only whitelisted fields (`profileStore.ts:72-77`). Add `name` there, trimmed, capped at about 24 chars, and dropped if empty.
3. `updateProfile`'s no-op short-circuit compares only `network`, `identityKey` and `needsRestore` (`:156-160`). It must also compare `name` and `deleted`, or the patch is silently skipped. Also delete falsy optional keys the way `needsRestore` is handled (`:155`).
4. Add one helper, `profileLabel(record, t)`, returning `record.name ?? t('profile_label', { number: index + 1 })`.
5. Replace the four direct `profile_label` call sites:
   - `ui/components/wallet/ProfileSwitcherPopover.tsx:98` (switching cover, which only has an index, so look up `profiles[switchingTo]`)
   - `ProfileSwitcherPopover.tsx:130` (row label) and `:142` (a11y label)
   - `ui/screens/WalletConfigScreen.tsx:609` (scope note)
   - `core/context/WalletContext.tsx:2988` (`profile_switch_failed` toast, where `record` is already in scope at `:2945`)
6. UI: a new `GroupedSection` above "Display name" on the Profile screen, reusing `PencilEditField` (`ui/components/ui/PencilEditField.tsx:24-33`, which supports `maxLength`). Empty input resets to the default label. Rename touches only AsyncStorage, so it could also be offered on inactive rows (long-press) at no extra cost. Active-only on `ProfileScreen` is the minimal version.
7. i18n: new strings need all 12 locales. I counted 12 `profile_add:` entries, and `__tests__/i18n/translationParity.test.ts:11-31` enforces parity and flags untranslated strings. `profile_label` is exempt (`translationParity.test.ts:29-30`), which stays correct as the fallback.
8. Update the "Display name" hint so users see the split: label is private, display name is public.
9. Optional: disallow duplicate names among non-deleted profiles, case-insensitively.

**Limitation to state:** names are device-local and lost on reinstall or restore. The spec lists "storing profile settings in the remote backup" as an open follow-up (`docs/superpowers/specs/2026-10-01-multi-profile-design.md:199`). The spec currently says rename and delete are a non-goal (`:17`, `:198`), so the spec needs updating.

---

## 2. DELETE: what "zero" must mean, and where it can be checked

### 2.1 Restrict deletion to the ACTIVE profile (never 0)

**Why:**

- **Inactive balance is not safely readable without a build.**
  - No read-only open (above).
  - `ProfileRecord.identityKey` is optional (`profileStore.ts:35`) and set only on build attempts (`WalletContext.tsx:2667`, `:2538`).
  - A profile registered by discovery has `needsRestore: true`, no `identityKey` and no DB on this device. Its remote backup is of unknown contents, so its balance is unknowable without restoring it.
  - A profile can also have DBs on several networks, since `purgeIdentityDbFiles` loops `main`, `test` and `teratest` (`core/walletDbRegistry.ts:196-219`).
  - An all-networks inspector would need to pick the latest file per chain through `getRegisteredDbs` and `selectLatestDb` (`walletDbRegistry.ts:105-114`, `:64-78`). That is possible but fragile.
- **Funds can be invisible locally.**
  - The monitor and the MessageBox inbox poll run only for the active identity (`WalletContext.tsx:2424-2462`, spec `docs/.../design.md:152`).
  - An inactive profile may hold unread inbound payments. Active-only lets the flow force one CreditInbox pass first (`TaskCreditInbox.requestNow()` is used at `WalletContext.tsx:3384`).
- **Handle release needs a live signer** (section 3.3).
- **UX fit:** the popover's active row already opens `/profile` (`ProfileSwitcherPopover.tsx:137`, `ui/components/wallet/ProfileButton.tsx:48,104-107`).

Profile 0 must be refused in code, not only hidden in UI. It owns the vault (`core/services/vault/transfers.ts:2093`), the bare un-suffixed keys, and is the anchor for discovery ownership (`WalletContext.tsx:2590-2591`).

For a non-active row with `needsRestore` or no `identityKey`, the UI should say "switch to it first" rather than imply zero.

### 2.2 The balance sources and why the usual ones are insufficient

| Source | Reference | Problem as a deletion gate |
|---|---|---|
| `readWalletBalance` | `core/storage/methods/walletBalanceSql.ts:35-36,57-67` | `default` basket only, `spendable=1`, status in `completed`, `unproven`, `sending`, `nosend`. Excludes `unprocessed` and every other basket. Returns `null` when the basket does not exist, which is "never held anything", not a failed read. |
| `useSpendableBalance` | `ui/hooks/useSpendableBalance.ts:17-87` | Sets the AsyncStorage cache into state before the live read (`:32-38`). Never gate on it. |
| Home `refreshBalance` | `ui/screens/WalletHomeScreen.tsx:591-661` | Same two-step pattern; cache key `cached_wallet_balance_<net>__p<n>` (`:456`). |
| `mandala.balances()` | `core/mandala/createRuntime.ts:2272-2290` | `baseUnits` and `unsettledBaseUnits`. But `listTokenOutputs` swallows any error and returns `[]` (`:707-714`), so a failure reads as zero. Fail-open for a guard. |
| `readUnprocessedPending` | `core/localpay/pending.ts:376-407` | Returns `{count, stuck, corrupt}`. On corruption it returns `0, 0, corrupt:true`, so the guard must treat `corrupt` as blocking. |
| `getOutboxEntries` | `core/peerpay/outbox.ts:130-137` | Swallows errors to `[]`. `readEntries` is not exported (`:111`), so strict reading needs a new export. |

### 2.3 Recommended definition of "zero"

Run all of it on the open storage, fail closed on any error, and take a fresh live read. All of it should live in a new `assertProfileEmpty(storage, userId)`.

1. **Outputs, any basket.** No `outputs` row with `userId=?` and `spendable=1`. Schema at `createTables.ts:190-219`. Raw SQL on `storage.sqliteDb` (`StorageExpoSQLite.ts:2076`). This also catches token outputs, which are 1-sat rows in `MANDALA_BASKET` with the real value in the script (`createRuntime.ts:662-668`).
2. **Transactions.** No `transactions` row (`createTables.ts:134-152`) with a status outside `completed`/`failed`. This covers `unprocessed`, `unsigned`, `nosend`, `sending`, `nonfinal` and `unproven`.
   - This also catches the limbo case: a parked or nosend payment reserves inputs (`spendable=0`), so a spendable-only sum under-counts. See `core/offline/cancelParked.ts:1-22`.
   - **Tradeoff:** a just-sent outgoing tx stays `unproven` until mined, so deletion is blocked for a few minutes. That is intended. Deleting the DB would drop proof or rebroadcast duty. State this in the UI copy.
3. **Offline queue.** No `offline_actions` rows in `queued`, `posting`, `parked` or `import_hold` (`core/storage/methods/offlineActions.ts:24`; table at `createTables.ts:352-367`).
4. **Token settlements.** No `token_settlements` row in a non-terminal state. Terminal means `broadcast`, `admitted`, `refused`, `orphaned` (`createRuntime.ts:441,454`; states at `core/mandala/types.ts:12-21`; table at `createTables.ts:423-443`). Also require `balances()` to report zero for both fields, but never rely on it alone because of its fail-open.
5. **KV queues.**
   - `localpay_pending` count and stuck both 0, and `!corrupt` (`pending.ts:12,376-407`).
   - `peerpay_outbox` has no entry with `status !== 'sent'` (`outbox.ts:249-251`).
   - No journalled handle write (`profile_handle_pending`, `core/identity/handleRegistry/registration.ts:23`). An outstanding journal must finish first.
6. **Inbox.** Do one `TaskCreditInbox.requestNow()` pass, and require the device to be online. Unread messages stay on the server until acknowledged. UNCERTAIN: I did not check the Go server's message retention or expiry.
7. **Vault.** Not applicable, since profile 0 is never deletable.
8. **Test networks (product decision).** On `test` or `teratest`, test coins are valueless, and "profiles as a fast network swap" is an explicit goal (`docs/.../design.md:10`). I suggest mainnet blocks on any non-zero state, while test networks warn rather than block. Strictest is to block on all.

Residual risk, unavoidable: money can still arrive after deletion. See the handle release in section 3.3 and the optional "restore removed profile" in section 4.

---

## 3. DELETE: what it entails

### 3.1 Ordering (everything before the switch can abort cleanly)

Write order matters because other writers fire after teardown (balance-cache hooks and the auto-approve ledger write to `profileScopedKey(...)` at `WalletContext.tsx:315-323`).

1. Guards: not profile 0, is the active profile, no switch in flight (`runProfileTransition`, `WalletContext.tsx:2999-3009`), online, and zero proof per 2.3.
2. **Release handle** (3.3). Abort the whole delete if it cannot be confirmed.
3. **Erase remote backup** per chain (3.2).
4. `backupAttestation.clear(identityKey)` (`core/services/vault/backupAttestation.ts:33-34,66-68`).
5. `disconnectActivePairedSession()` (as at `WalletContext.tsx:2953`).
6. **Switch to profile 0**, or the previous non-deleted profile, via `switchProfileImpl` (`:2942-2994`).
   - Teardown closes the DB (`:2808-2860`).
   - If that switch fails it falls back to `from` (`:2986-2991`), which is the profile still being deleted. That is a clean abort because nothing is purged yet.
7. Only after the switch succeeded:
   - Write the tombstone (`deleted: true`, keeping `identityKey`).
   - `purgeIdentityDbFiles(identityKey.slice(-8), SQLite.deleteDatabaseAsync)` (`walletDbRegistry.ts:196-219`, as used at `WalletContext.tsx:3516`). Optionally remove the now-empty `walletDbs-<suffix>-<chain>net` keys (`walletDbRegistry.ts:98-100`).
   - `clearArcApiTokensForProfile(n)` (`core/services/arcTokenStorage.ts:57-67`). This is the only enumerable per-profile SecureStore key.
   - Clear local backup cursors per chain: `clearCursorsForPseudonym(chain, backupPseudonym(primaryKey, chain))` (`core/backup/cursor.ts:163-167`; `core/backup/derive.ts:44-46`). This needs `primaryKey` from the mnemonic, as at `ui/screens/WalletConfigScreen.tsx:277-283`.
   - Sweep AsyncStorage keys ending `__p<n>` (3.4).
8. **Retry on launch:** a startup pass that re-runs the idempotent purge for every tombstoned record. This is cheap and covers a crash between tombstone and purge. Keeping `identityKey` on the tombstone makes it possible. UNCERTAIN: no such startup hook exists today.

### 3.2 Remote backup: do not reuse `eraseRemoteBackup` as-is

- **It flips a global flag.** Step 1 is `setBackupPushEnabled(false)` (`core/backup/erase.ts:50`). That writes the single unscoped key `backupPushEnabled` (`core/backup/preference.ts:19,31-33`), which the spec lists as shared across profiles (`docs/.../design.md:86`). Calling it for profile n silently stops backups for every remaining profile, and the existing screen then shows the switch Off (`WalletConfigScreen.tsx:296,305`).
- **Recommendation:** add an option or variant that skips step 1. That is justifiable because the profile's wallet and monitor are torn down before the erase, so no push pass can append after the delete. The original ordering argument (`erase.ts:3-16`) was about a live monitor. Keep step 2 (`client.deleteAccount()`, `:53`) and step 3 (cursors, `:56`). A failed server delete must abort the whole delete, as `erase.ts` already requires.
- **Per chain:** each chain is a separate pseudonym and account. Loop `BACKUP_CHAINS` as `WalletConfigScreen.tsx:293-295` does. `primaryKey` is `recoverMnemonicWallet(mnemonic, '', n).primaryKey`.
- **Multi-device:** `DELETE /v1/account` removes all generations across devices (`erase.ts:6-10`). A second device that still has the profile will re-create the account on its next push. The profile store is per-device and unsynced, so delete is a per-device action. State this in the copy.

### 3.3 Handle registered to that identity

- **Release is protocol-supported but not exposed.**
  - The server tombstone is a PUT of a cert with `released: "true"` (spec `/Users/personal/git/go/go-message-box-server/docs/specs/2026-09-18-paymail-profile-lookup-design.md:151-153`).
  - On the client, `buildProfileCertificate({ ..., released: true })` exists (`profileCert.ts:76,88`) and is used only as step 1 of `changeHandle` (`registration.ts:518-523`).
  - There is no standalone release and no UI for it.
- **New function needed.** A `releaseHandle(deps, { paymail })` that follows the journal discipline: sign, write the journal, then `putCertificate` (`core/identity/handleRegistry/client.ts:242-261`). It needs these changes:
  - `RegistrationIntent` (`registration.ts:39`) gets `'release'`.
  - `RegistrationResult` gets a `released` kind.
  - The final mapping in `runJournal` (`:301-316`) handles the new intent. Today an unhandled intent falls through to `registered`.
  - `alreadyApplied` for a `release` step already works (`:234`).
  - A journal's cert is replayable only byte-identical (`:375-381` region), so the existing "journal outranks new intent" rule applies (`finishOutstanding`).
- **Needs the live signer, which forces active-only and pre-teardown.**
  - `buildProfileCertificate` needs a `ProfileSigner` bound to the live permissions manager (`ProfileScreen.tsx:124-127`).
  - Signing with a `ProtoWallet(primaryKey)` for an inactive profile would probably work but is **UNCERTAIN** and unverified.
- **Server semantics:**
  - A release sets `cooldownUntil = now + HANDLE_COOLDOWN_DAYS` (default 30) and `releasedBy='owner'` (spec `:151-153`, config `:47`).
  - Only the same key may reclaim during the cooldown (spec `:118-120`). Everyone else waits.
  - The client already surfaces this as "cooldown" (`client.ts:66-81`).
  - A handle that is never released stays held forever. Only the admin route can free it (`/Users/personal/git/go/go-message-box-server/cmd/server/main.go:159`; spec `:203-207`).
- **Why release is mandatory rather than optional.** A deleted identity's handle keeps resolving to a key nobody monitors, so payments would pile up unread. Releasing costs the user the name for 30 days unless they reclaim it, so the confirm dialog must say so.
- **Knowing whether a handle exists:** `profile_registered_handle` (`ProfileScreen.tsx:72`) is only an offline cache. For the active profile, ask the registry with `client.lookupProfile(identityKey)` (`client.ts:196-217`). `lookupProfile` needs no wallet, so it also works for a record's stored `identityKey`. If the registry is configured for the profile's network (`getHandleRegistryConfig(network)`, `core/toolboxConfig.ts:291-305`) and answers `failed`, block the delete. If `none`, skip release.

### 3.4 AsyncStorage and SecureStore

- **Sweep with an exact-index regex.** The logout sweep matches every index (`/__p\d+$/`, `profileStore.ts:26`, used at `WalletContext.tsx:3566-3574`). Per-profile delete needs `new RegExp('__p' + n + '$')` over `AsyncStorage.getAllKeys()`. Anchored, so `__p1` does not touch `__p10`.
- **Keys covered by the sweep** (from my `profileScopedKey` grep):
  - `wallet_user_avatar_icon` (`core/userAvatar.ts:26`)
  - `connections` (`core/stores/ConnectionStore.ts:24`)
  - `autoApproveThreshold` and `auto_approve_ledger`
  - `arc_custom_url_*`
  - `message_box_url`
  - `cached_wallet_balance_*` and `cached_wallet_balance_ts_*` (`WalletHomeScreen.tsx:456`, `ui/screens/SettingsScreen.tsx:55-56`)
  - `mandala_seen_assets` and `mandala_seen_evictions` (`ui/tokenSeen.ts:21-22`)
- **SecureStore** cannot be enumerated. Only the ARC token is per-profile (`arcTokenStorage.ts:57-67`).
- **Paired-session sequence counters:** SecureStore `wallet_pairing_lastseq_<topic>` (`core/context/WalletConnectionContext.tsx:40`) is keyed by topic, not profile. Clean it by enumerating topics from the profile's `connections` list before the sweep removes it. **UNCERTAIN / minor:** I did not trace whether Delete Wallet clears these either. I saw no such clearing in `logout`, so this is consistent with existing behavior.
- **Not touched, by design:** shared state (`backupDeviceId`, `backupPushEnabled`, handle key pins, `walletSettings`; spec `:86`).

### 3.5 Push registration

- **No client action is needed beyond the switch.** The server has no unregister route (routes are only `registerDevice` and `devices`, `main.go:150-151`). `DeactivateDevice` exists in the store interface (`pkg/storage/storage.go:121-122`) but is not mounted.
- **Why it works anyway:**
  - Registration upserts on the FCM token and rewrites `identity_key` (`pkg/storage/storage.go:106-109`, `pkg/storage/sqlstore/queries.go:425`).
  - After the switch, the next profile's `syncPushRegistration` sees a marker mismatch, because the marker is `host|identity|token` in the single slot `push_registration_v1` (`core/push/registration.ts:4,36-37`). It re-registers, which moves the token.
- **Caveats:** this is skipped when permission is denied or the host is unset (`registration.ts:30-33`). In that case the token stays bound to the old identity until a later successful sync. A push only means "look at the inbox", so the stake is low.

### 3.6 Paired connections

`disconnectActivePairedSession()` runs before teardown (`WalletContext.tsx:2953`). The persisted `connections__p<n>` list is removed by the sweep.

---

## 4. Profile store implications

### 4.1 Representation: tombstone, dense array

```ts
interface ProfileRecord {
  index: number; network: AppChain
  identityKey?: string; needsRestore?: boolean
  name?: string        // rename (section 1)
  deleted?: true       // tombstone: hidden everywhere, never reused
}
```

- **Compaction is impossible.** The index is the derivation path (`m/0'/n'`) and the AsyncStorage suffix (`profileScopedKey`, `profileStore.ts:198-200`).
- **A sparse array with a separate counter is worse.** Code indexes `state.profiles[n]` directly (`profileStore.ts:128,132,152`; `WalletContext.tsx:2945,3013,2692`). A sparse array would break all of those. Tombstoning keeps `parseProfilesState`'s dense invariant (`:79-82`) and the `profiles.length` arithmetic everywhere.
- **Parse and update:** extend the field whitelist (`profileStore.ts:72-77`) and the equality check (`:156-160`) for `name` and `deleted`.
- **Keep `identityKey` on the tombstone** so purge can be retried (3.1 step 8) and logout can still sweep leftovers. The logout loop only purges when `identityKey` is set (`WalletContext.tsx:3513-3522`). Repeating a purge is harmless.
- **Active pointer:**
  - `parseProfilesState` must clamp `active` to a non-deleted profile (today it only clamps to range, `:84-87`).
  - `setActiveProfile` (`:131-136`) and `switchProfile` (`WalletContext.tsx:3013`) must refuse a tombstone.
  - `getActiveProfile`'s fallback (`:127-129`) should skip tombstones.
- **UI filter:** the popover maps over `profiles` (`ProfileSwitcherPopover.tsx:128-169`). Filter `!deleted` there. Rename and the labels above handle the number gap (profile1, profile3).
- **Limits:** tombstones consume slots against `MAX_PROFILES = 100` (`profileStore.ts:29`) and discovery's default `maxProfiles = 50` (`discovery.ts:31,37`). Note it, no action needed at human scale.

### 4.2 `addProfile` index selection: never reuse

- `appendProfile` already uses `index = state.profiles.length` (`profileStore.ts:143`), and `ProfileButton.tsx:108` already mirrors it (`run(profiles.length, addProfile)`). With tombstones kept in the array, "never reuse" needs no change.
- **Reuse would not give a fresh profile.** Same index means the same identity key, backup pseudonym and handle subject. The user would see their "deleted" identity come back, still linked to its on-chain history and any un-erased backup.
- **Optional escape hatch:** since keys are seed-derived, a "Restore removed profile" action could clear `deleted` and set `needsRestore: true`. This also gives an undo path for funds that arrive late at a removed identity. It is only coherent if the remote backup was not erased. This is a product decision, not required.

### 4.3 Discovery and tombstones

Today discovery stops at the first index with no backup on any chain (`core/profiles/discovery.ts:54`). The spec already calls this a known gap (`discovery.ts:10-13`, `docs/.../design.md:123`). Deletion makes it worse:

- Delete profile 2 (backup erased) while profile 3 exists. A reimport finds only 0 and 1 and hides 3. The user recovers 3 only by adding profiles again (`addProfile` sets `needsRestore: true`, `WalletContext.tsx:3024`). But the first add lands on index 2, the removed identity, which defeats "never reuse" on a fresh device.
- Local tombstones do not exist on a new device. The register callback checks `index === getProfilesState().profiles.length` (`WalletContext.tsx:2595-2600`). With dense tombstones that still works.
- It never resurrects a locally tombstoned index, because the profile list persists. The problem only appears on a fresh device.

**The user must choose one of these. I am not picking for them.**

- **(a) Erase the backup and accept the gap.** Simplest, and matches "removed means gone". The cost is hidden later profiles on reimport, plus the re-add collision above.
- **(b) Do not erase the backup.** Discovery keeps working, and a removed profile resurrects on reimport, where it can be removed again. The cost is that the server keeps an encrypted log of a deleted profile. Users can still use the existing Erase backup control.
- **(c) A server-side tombstone marker in the backup account**, so discovery can continue past it. This is a wire or server change. **UNCERTAIN:** I could not verify feasibility from client code. The restore path replays chunks (`core/backup/restore.ts`), and a marker would have to be skipped by the codec and `listBackups`.
- **A client-only partial mitigation** is gap-tolerant discovery: keep probing after a miss until K consecutive misses, and register skipped indices as tombstones. It also narrows the original gap. The costs are K×3 more probes per reimport, and it would tombstone a never-backed-up live profile, which hides it. Flagging it as an option only.

---

## 5. Test and file touch list (estimate)

- **Store:** `core/profiles/profileStore.ts` (`name`, `deleted`, active clamp, update equality) and `__tests__/profiles/profileStore.test.ts`. That suite asserts exact whitelist, dense and clamp behavior (`:25-71`).
- **Discovery:** the decision in 4.3, then `core/profiles/discovery.ts` and `__tests__/profiles/discovery.test.ts` (stops at first miss, `:37`).
- **Backup:** `core/backup/erase.ts` (variant without the global flag) and tests.
- **Handle:** `core/identity/handleRegistry/registration.ts` (`release` intent, `released` result, `runJournal` mapping) and tests.
- **Context and screens:**
  - `core/context/WalletContext.tsx` (a `deleteProfile` flow plus the startup purge retry)
  - `ui/screens/ProfileScreen.tsx` (rename and remove sections)
  - `ui/components/wallet/ProfileSwitcherPopover.tsx` (filter and labels)
  - `ui/screens/WalletConfigScreen.tsx`
- **Strings:** 12 locales in `core/i18n/translations.tsx`.
- **Spec:** `docs/superpowers/specs/2026-10-01-multi-profile-design.md` (non-goal at `:17`, follow-ups at `:198`).