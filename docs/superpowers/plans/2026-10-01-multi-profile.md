# Multiple Wallet Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one mnemonic drive many independent wallet profiles (identity key `m/0'/n'`, privileged key `m/1'/n'`). Users switch profiles from a popover on the Home avatar.

**Architecture:** A small profile store (`core/profiles/profileStore.ts`) is the source of truth for which profile is active and which network each profile uses. It is held in memory, persisted to AsyncStorage, and readable synchronously. `WalletContext` reads it before every build and derives that profile's keys. Per-profile AsyncStorage keys go through `profileScopedKey(base)`. Profile 0 keeps the bare key; profile n≥1 appends `__p<n>`. Profile switches reuse the existing teardown/rebuild machinery. The vault is gated on `profileIndex === 0`.

**Tech Stack:** Expo / React Native, TypeScript, @bsv/sdk (`HD`, `Mnemonic`), @bsv/wallet-toolbox-mobile, AsyncStorage, jest-expo + @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-10-01-multi-profile-design.md`

## Global Constraints

- No migration or backward compatibility. Pre-launch app.
- Primary key `m/0'/n'`. Privileged key `m/1'/n'` for every profile, including 0. The BIP32 master is never handed to the `PrivilegedKeyManager`.
- Labels `profile{n+1}`, the same literal in every locale.
- Vault and YubiKey only when the active profile index is 0 AND the chain is `main`.
- Shared across profiles: `walletSettings`, one-time advisories, `backupDeviceId`, `backupPushEnabled`, handle key pins, `vault_enrolled_serial_registry_v1`, and the secrets.
- Per profile: network, ARC URL + token, MessageBox URL, auto-approve threshold + ledger, balance cache, avatar, connections, seen-token markers, and the wallet DB.
- Every new user-facing string goes into all 12 locales in `core/i18n/translations.tsx`, because `translationParity.test.ts` enforces parity.
- Run jest from the repo root (`/Users/personal/git/bsv-wallet`) with `npx jest <path>`. Typecheck with `npx tsc --noEmit -p .` from the root.
- Prettier only on the files you touched. Never `npm run fix`.

**Spec deviations (deliberate, simpler, same behaviour):**
1. Per-profile AsyncStorage keys use a profile-index suffix rather than an identity-key suffix. The index is known synchronously before any build, and logout sweeps every suffix.
2. ARC URL, MessageBox URL and auto-approve threshold keep their existing keys through `profileScopedKey`, instead of moving into `ProfileRecord`. Only `network` (needed before build), `identityKey` (needed for logout purge) and `needsRestore` live on the record.

## Review Focus

1. **A switch while a build is in flight.** The new profile must win, and the old build must never publish. Covered by the existing `buildGenRef` bump in the shared teardown. Verify that `switchProfile` bumps it before its first await.
2. **Logout with profiles never built on this device** (discovered, `identityKey` undefined). Must not throw, and must still clear the store. Test in Task 6.
3. **A corrupt `wallet_profiles_v1` JSON, or `active` out of range.** Falls back to the default or clamps, and the app still starts. Test in Task 2.
4. **A profile switch where both profiles share a network.** Home's vault-button memo must still recompute, so `activeProfile` must be in its deps. Covered in Task 5 by passing `activeProfile` explicitly.
5. **A WIF-recovered wallet.** The popover must not open and the avatar keeps navigating to `/profile`. Test in Task 7.

---

### Task 1: Per-profile key derivation

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/mnemonicWallet.ts`
- Modify: `packages/expo-wallet-toolbox/core/context/WalletContext.tsx` (buildWalletFromMnemonic, ~:2529-2539)
- Modify mocks: `__tests__/context/deleteWalletVerifiedErasure.test.tsx:68-72`, `__tests__/context/walletBuildRestore.test.tsx:67-71`, `__tests__/context/refreshProofImportHold.test.tsx:73-77` (rename `rootKey` to `privilegedKey`)
- Test: `packages/expo-wallet-toolbox/__tests__/profiles/derivation.test.ts`

**Interfaces produced:**
```ts
export interface MnemonicWalletResult {
  mnemonic: string
  privilegedKey: PrivateKey   // m/1'/n'
  primaryKey: number[]        // m/0'/n'
  identityKey: string         // pubkey hex of m/0'/n'
}
export interface MnemonicWalletConfig { mnemonic?: string; passphrase?: string; language?: ...; profileIndex?: number }
export function recoverMnemonicWallet(mnemonic: string, passphrase?: string, profileIndex?: number): MnemonicWalletResult
export function profilePaths(n: number): { primary: string; privileged: string }
```

- [ ] Step 1: Write the test. Use a fixed mnemonic and compare against `HD.fromSeed(seed).derive(path)`. Index 0 matches `m/0'/0'`. Index 1 matches `m/0'/1'`. Privileged keys match `m/1'/n'`. Primary and privileged differ. Profile 0 and profile 1 differ. A negative or non-integer index throws.
- [ ] Step 2: Run `npx jest packages/expo-wallet-toolbox/__tests__/profiles/derivation.test.ts`. Expect FAIL.
- [ ] Step 3: Implement `profilePaths` and the `profileIndex` option. Remove `rootKey`.
- [ ] Step 4: In `WalletContext`, change the call to `recoverMnemonicWallet(mnemonic, '', activeIndex)` (index from Task 2's `getActiveProfileIndex()`; use 0 until Task 2 lands). Change the PKM to `new PrivilegedKeyManager(async () => privilegedKey, VAULT_RETENTION_MS)`, and update the comment.
- [ ] Step 5: Update the three test mocks, then run the derivation test plus `__tests__/recovery` and `__tests__/context`. Expect PASS.
- [ ] Step 6: Commit `feat(profiles): derive primary m/0'/n' and privileged m/1'/n' keys`.

### Task 2: Profile store

**Files:**
- Create: `packages/expo-wallet-toolbox/core/profiles/profileStore.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/profiles/profileStore.test.ts`

**Interfaces produced:**
```ts
export const PROFILES_STORAGE_KEY = 'wallet_profiles_v1'
export interface ProfileRecord { index: number; network: AppChain; identityKey?: string; needsRestore?: boolean }
export interface ProfilesState { active: number; profiles: ProfileRecord[] }
export function defaultProfilesState(): ProfilesState            // { active: 0, profiles: [{ index: 0, network: DEFAULT_CHAIN }] }
export function parseProfilesState(raw: string | null): ProfilesState   // tolerant: corrupt → default, clamp active, dense indices
export async function loadProfiles(): Promise<ProfilesState>    // reads AsyncStorage into memory, notifies
export function getProfilesState(): ProfilesState               // sync snapshot
export function getActiveProfileIndex(): number
export function getActiveProfile(): ProfileRecord
export async function setActiveProfile(n: number): Promise<void>
export async function appendProfile(network?: AppChain, opts?: { needsRestore?: boolean }): Promise<ProfileRecord>
export async function updateProfile(n: number, patch: Partial<Omit<ProfileRecord, 'index'>>): Promise<void>
export async function resetProfiles(): Promise<void>            // removes the key, memory → default
export function subscribeProfiles(l: () => void): () => void
export function useProfiles(): ProfilesState                    // useSyncExternalStore
export function useActiveProfileIndex(): number
export function profileScopedKey(base: string, index?: number): string  // index ?? active; 0 → base; n → `${base}__p${n}`
export const PROFILE_KEY_SUFFIX_RE: RegExp                     // /__p\d+$/
```
Writes update memory synchronously (listeners fire), then persist with a best-effort AsyncStorage write.

- [ ] Step 1: Write the tests:
  - default when empty
  - corrupt JSON returns the default
  - an out-of-range `active` clamps to 0
  - a non-dense or duplicate profile list is normalised and sorted
  - an unknown network falls back to `DEFAULT_CHAIN`
  - append numbers sequentially
  - `setActiveProfile` rejects an unknown index
  - `profileScopedKey` returns the bare key for profile 0 and the suffixed key otherwise
  - persistence round-trips through `loadProfiles`
  - `resetProfiles` clears
- [ ] Step 2: Run and confirm FAIL.
- [ ] Step 3: Implement. Use the `core/userAvatar.ts` listener pattern.
- [ ] Step 4: Run and confirm PASS. Export the module from `core/index.ts`.
- [ ] Step 5: Commit `feat(profiles): profile store with scoped storage keys`.

### Task 3: Scope per-profile device state

**Files (each read and write goes through `profileScopedKey`):**
- `core/services/arcTokenStorage.ts`: the key becomes `profileScopedKey(arcApiTokenStorageKey(network))`. Add `clearArcApiTokensForProfile(index)` covering every chain.
- `core/context/WalletContext.tsx`:
  - `arc_custom_url_${chain}` (:1267)
  - `MESSAGE_BOX_URL_KEY` (:1922)
  - `AUTO_APPROVE_STORAGE_KEY` (:912, :1094)
  - `AUTO_APPROVE_LEDGER_STORAGE_KEY` (:293, :303). Replace `loadAutoApproveLedgerOnce` with `reloadAutoApproveLedger()`, which reads the scoped key and calls `autoApprovePolicy.loadLedger(parsed ?? [])`.
- `ui/screens/WalletConfigScreen.tsx`: the `AUTO_APPROVE_STORAGE_KEY` and `arcUrlStorageKey(...)` sites.
- `ui/screens/PairScreen.tsx:81`: `AUTO_APPROVE_STORAGE_KEY`.
- MessageBox URL readers: `ui/screens/WalletHomeScreen.tsx:131`, `ui/screens/WalletCheckScreen.tsx:191`, `ui/hooks/useOfflineNoticeActions.ts:17`, `ui/components/pay/MessageBoxConfig.tsx` (every site).
- Balance cache: `ui/screens/WalletHomeScreen.tsx:454`, `ui/screens/SettingsScreen.tsx:51-52`, `ui/hooks/useSpendableBalance.ts:18`, `ui/components/wallet/Balance.tsx`. In components, compute the key from `useActiveProfileIndex()`, so a switch re-keys it and effects re-run.
- `core/userAvatar.ts`: `loadUserAvatarIcon` reads the scoped key and resets `icon` to `null` when nothing is stored. `setUserAvatarIcon` writes the scoped key.
- `core/stores/ConnectionStore.ts`: save and load use the scoped key. Make `load()` public as `reload()`, and replace the list even when empty.
- `ui/tokenSeen.ts`: `readSeen`/`markSeen` take the base key and scope it internally. `useSeenSet` adds `useActiveProfileIndex()` to its effect deps.
- Test: `__tests__/profiles/scopedState.test.ts`. With the active profile at 1, writes through `setUserAvatarIcon`, `markSeen`, `connectionStore.add` and `setArcApiToken` land on the `__p1` keys. Switching back to 0 and reloading reads the bare keys.

- [ ] Step 1: Write `scopedState.test.ts`. Run and confirm FAIL.
- [ ] Step 2: Apply the edits above.
- [ ] Step 3: Run the new test plus `__tests__/ui/messageBoxConfig.test.tsx`, `__tests__/ui/Balance.test.tsx`, `__tests__/stores` and `__tests__/pay/handleRail.test.ts`. Expect PASS, because profile 0 still uses the bare keys.
- [ ] Step 4: Commit `feat(profiles): scope per-profile device state`.

### Task 4: WalletContext profile lifecycle

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/context/WalletContext.tsx`
- Test: `packages/expo-wallet-toolbox/__tests__/context/switchProfile.test.tsx`. Model it on `walletBuildRestore.test.tsx`'s harness.

**Interfaces produced (added to the WalletContext value type):**
```ts
activeProfile: number
profiles: ProfileRecord[]
profilesSupported: boolean          // true once a mnemonic build succeeded
switchProfile: (n: number) => Promise<void>
addProfile: () => Promise<void>
```

Changes:
1. Startup config effect (:1181): `await loadProfiles()` first. Then call `finalizeConfig({...config, network: getActiveProfile().network})`. If `finalConfig` had a network and the store was just defaulted, seed profile 0's network from it.
2. Extract the shared teardown from `rebuildWallet` as `teardownBuiltWallet()`. It covers vault scope clear, ceremony cancel, push detach, monitor drain, chaintracks/header refs, storage destroy, mandala and PSK clear, managers and flags. `rebuildWallet`, `switchNetwork` and `switchProfile` all call it after bumping `buildGenRef`.
3. `buildWalletFromMnemonic`:
   - read `const profileIndex = getActiveProfileIndex()`
   - capture `const wantedRestore = restoreIntentRef.current` after the opts arming
   - on success: `updateProfile(profileIndex, { identityKey, needsRestore: false })` and `setProfilesSupported(true)`
   - if `wantedRestore && profileIndex === 0`: fire-and-forget `discoverProfiles` (Task 6)
4. `buildWalletFromRecoveredKey` success sets `setProfilesSupported(false)`.
5. `switchProfile(n)`:
   - return early if `n === getActiveProfileIndex()` or `!profilesSupported`
   - `token = buildGenRef.current.bump()`
   - `await setActiveProfile(n)`
   - arm `restoreIntentRef.current = !!record.needsRestore`
   - `await teardownBuiltWallet()`
   - `reloadAutoApproveLedger()`, `loadUserAvatarIcon()`, `connectionStore.reload()`, `disconnectActivePairedSession()`
   - `pendingAutoBuildRef.current = true`, then `finalizeConfig({ wabUrl: 'noWAB', method: 'mnemonic', network: record.network, storageUrl: 'local' })`
   - `await waitForRebuild(token)`
6. `addProfile()`: `const rec = await appendProfile('main', { needsRestore: true })`, then `await switchProfile(rec.index)`.
7. `switchNetwork(network)`: also `await updateProfile(getActiveProfileIndex(), { network })`.

- [ ] Step 1: Write `switchProfile.test.tsx`:
  - after build, `profilesSupported` is true
  - `addProfile` builds with `recoverMnemonicWallet` called with index 1
  - `switchProfile(0)` rebuilds with index 0
  - the second switch's build replays the backup only when `needsRestore` is set

  Run and confirm FAIL.
- [ ] Step 2: Implement items 1–7.
- [ ] Step 3: Run the new test plus the whole `__tests__/context` directory. Expect PASS.
- [ ] Step 4: Commit `feat(profiles): switchProfile/addProfile in WalletContext`.

### Task 5: Vault only on profile 0

**Files:**
- `core/toolboxConfig.ts`: `isVaultAvailable(chain: AppChain, profileIndex: number): boolean` returns `isVaultEnabled() && chain === 'main' && profileIndex === 0`. The parameter is required.
- Callers pass `useActiveProfileIndex()`, and each one gates the whole expression including `hasVaultMeta`:
  - `ui/screens/WalletHomeScreen.tsx:1797`: `activeProfile === 0 && (isVaultAvailable(selectedNetwork, activeProfile) || hasVaultMeta)`. Add `activeProfile` to the memo deps.
  - `ui/screens/SettingsScreen.tsx:44-49`
  - `ui/screens/VaultScreen.tsx:196`. `enabled` false blocks enrolment and deposit. Also gate the chain-restore and withdraw doors: when `activeProfile !== 0`, render only the inert notice `vault_profile_only_default`.
  - `ui/screens/VaultTransferScreen.tsx:150`, plus the same early inert render when `activeProfile !== 0`
- `core/services/vault/transfers.ts:2088`: `isVaultAvailable(scopeToken.chain, getActiveProfileIndex())`
- i18n: `vault_profile_only_default`, e.g. "Vault is only available on profile1.", in all 12 locales.
- Test: extend `__tests__/toolboxConfig.test.ts`. Profile 1 on mainnet is false. Profile 0 on mainnet is true. Profile 0 on testnet is false. Update any other test that calls `isVaultAvailable`.

- [ ] Step 1: Add the tests. Run and confirm FAIL.
- [ ] Step 2: Implement it, then run `npx tsc --noEmit -p .` to find every caller.
- [ ] Step 3: Run `__tests__/toolboxConfig.test.ts`, `__tests__/vault` and `__tests__/i18n`. Expect PASS.
- [ ] Step 4: Commit `feat(profiles): vault only on the default profile`.

### Task 6: Restore discovery and delete-all-profiles

**Files:**
- Create: `core/profiles/discovery.ts`
```ts
export type ProfileProbe = (primaryKey: number[], chain: BackupChain) => Promise<boolean>
export async function discoverProfiles(deps: {
  mnemonic: string
  probe: ProfileProbe
  register: (index: number, network: AppChain) => Promise<void>
  startIndex?: number   // default 1
  maxProfiles?: number  // hard stop, default 50
}): Promise<number>      // count registered
export function backupProbe(baseUrl: string): ProfileProbe   // listBackups({ primaryKey, chain, baseUrl }).length > 0
```
  For each index n: derive with `recoverMnemonicWallet(mnemonic, '', n)`, probe every `BACKUP_CHAINS` entry, and pick `main` if found, else the first hit. Stop at the first index with no hits. A probe error stops discovery and keeps the profiles already registered.
- WalletContext wiring (Task 4 item 3):
  - `register` is `appendProfile(network, { needsRestore: true })`, but only if `index === getProfilesState().profiles.length`, so it is idempotent.
  - Skip when `getBackupUrl()` is empty.
- Modify `core/walletDbRegistry.ts`: add `purgeIdentityDbFiles(keySuffix: string, deleteFile): Promise<void>`. It covers every chain in `['main','test','teratest']`, deletes and unregisters each registered file, and is best-effort.
- Modify `logout()` in WalletContext. After the existing active-DB purge:
  - for every profile record with an `identityKey`, call `purgeIdentityDbFiles(identityKey.slice(-8), SQLite.deleteDatabaseAsync)`
  - for every index, call `clearArcApiTokensForProfile(index)`
  - remove every AsyncStorage key matching `PROFILE_KEY_SUFFIX_RE`
  - `await resetProfiles()`, then `setProfilesSupported(false)`
- Tests:
  - `__tests__/profiles/discovery.test.ts` (fake probe):
    - stops at the first miss
    - prefers main
    - picks test when only test has a backup
    - stops on a probe error and keeps the earlier profiles
    - respects `maxProfiles`
  - `__tests__/walletDbRegistry.test.ts`: `purgeIdentityDbFiles` removes every chain's files and registry entries for that suffix, and leaves other suffixes alone.
  - Logout test in `deleteWalletVerifiedErasure.test.tsx`:
    - seed a profiles state with a second profile that has an `identityKey` and a discovered third profile without one
    - after logout, `wallet_profiles_v1` is gone, the `__p1` keys are gone, and `deleteDatabaseAsync` was called for profile 1's registered file

- [ ] Step 1: Write the tests. Run and confirm FAIL.
- [ ] Step 2: Implement.
- [ ] Step 3: Run the tests above plus `__tests__/context`. Expect PASS.
- [ ] Step 4: Commit `feat(profiles): restore discovery and delete-all-profiles`.

### Task 7: Profile switcher popover

**Files:**
- Create: `packages/expo-wallet-toolbox/ui/components/wallet/ProfileSwitcherPopover.tsx`
  - React Native `Modal`, transparent, `animationType="fade"`. A full-screen `Pressable` backdrop closes it.
  - A card anchored top-left at `insets.top + 52` and `left: spacing.lg`, with width `min(280, screen - 2*spacing.lg)`. Card styling (radius 20, hairline border, `surfaceRaised`, shadow) copies `AssetSwitcherDropdown`.
  - Rows: an `AvatarGlyph` disc for the active row (using the user avatar), a person-outline glyph for the others, the label `t('profile_label', { number: n + 1 })`, a network caption when the profile isn't on `main` (`t(network)`), and a checkmark on the active row. Rows set `accessibilityRole="button"` and `accessibilityState={{ selected }}`.
  - Rows are disabled while `walletBuilding`.
  - The footer button `t('profile_add')` has an `add-circle-outline` icon.
  - Props: `{ visible, onClose, profiles, active, busy, onSelect(n), onOpenProfile(), onAdd() }`.
- Modify `ui/components/wallet/ProfileButton.tsx`:
  - when `profilesSupported`, press toggles the popover
  - otherwise, `router.push('/profile')`
  - an active-row tap runs `onClose` then `router.push('/profile')`
  - another row runs `onClose` then `switchProfile(n)`
  - add runs `onClose` then `addProfile()`
- Modify `ui/screens/WalletConfigScreen.tsx:277`: use `recoverMnemonicWallet(mnemonic, '', getActiveProfileIndex()).primaryKey`. Add a caption `t('profile_settings_scope_note', { profile: t('profile_label', { number: active + 1 }) })` under the network section header.
- i18n, all 12 locales:
  - `profile_label`: `'profile{{number}}'`, allowed untranslated `'*'`
  - `profile_add`: "Add profile"
  - `profile_switcher_a11y`: "Switch profile"
  - `profile_settings_scope_note`: "Network and connection settings apply to {{profile}} only."
- Test: `__tests__/ui/profileSwitcherPopover.test.tsx`:
  - renders `profile1` and `profile2`
  - the selected state sits on the active row
  - tapping the active row calls `onOpenProfile`
  - tapping another row calls `onSelect(1)`
  - Add calls `onAdd`
  - while busy, rows don't fire

  Add a ProfileButton test: with `profilesSupported` false, a press calls `router.push('/profile')`.

- [ ] Step 1: Write the tests. Run and confirm FAIL.
- [ ] Step 2: Implement.
- [ ] Step 3: Run the new tests plus `__tests__/i18n`. Expect PASS.
- [ ] Step 4: Commit `feat(profiles): profile switcher popover on the Home avatar`.

### Task 8: Verification

- [ ] `npx jest packages/expo-wallet-toolbox` from the root: all green, apart from the known baseline noise noted in memory.
- [ ] `npx tsc --noEmit -p .`: no new errors.
- [ ] Simulator check:
  - open the popover
  - Add profile gives an empty wallet
  - switch back and the balance is back
  - the vault button is hidden on profile2
  - set profile2's network to testnet, then switch to profile1 and the app is on mainnet
- [ ] Commit any fixes. Push the branch only when the user asks.
