PKG = /Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox. All paths below are relative to PKG. Branch feat/multi-profile, read-only, nothing modified.

## 1. Preference inventory

**Storage and defaults (core/backup/preference.ts)**
- The key is the global bare string `backupPushEnabled` (`BACKUP_PUSH_ENABLED_KEY`, :19), in AsyncStorage. It has no profile scoping.
- The read is `!== 'false'`, so a missing key, an unrecognised value or a thrown read all mean ON (:22-29).
- The write stores `'true'` or `'false'` explicitly (:31-33). The module doc (:1-16) says absence must never mean off.
- There is no module-level cache; every read hits AsyncStorage.
- It is exported through core/index.ts:366. The key is not referenced anywhere in native code, app/, utils/, hooks/ or components/ (full-repo grep, excluding node_modules, worktrees and .claude).
- docs/superpowers/specs/2026-10-01-multi-profile-design.md:86 and docs/superpowers/plans/2026-10-01-multi-profile.md:19 list `backupPushEnabled` as shared across profiles. This change reverses that decision.

**Read sites**

| # | Site | What it does |
|---|---|---|
| R1 | core/backup/push.ts:83 | First statement of `pushOnce`. When off it returns `optedOut` before touching the DB or cursor (:79-85). |
| R2 | core/backup/status.ts:30 | `getBackupUploadState(chain, pseudonym)` reads `enabled`. Called from ui/screens/WalletCheckScreen.tsx:151 with `getBackupPseudonym(selectedNetwork)`. |
| R3 | ui/screens/WalletConfigScreen.tsx:219-221 | Mount effect with `[]` deps; sets `backupPushOn` state. |
| R4 | ui/screens/VaultScreen.tsx:466-473 (read at :469) | `privateBackupEnabled`, injected as `backupEnabled` at :555. |
| R5 | ui/screens/VaultTransferScreen.tsx:163-170 (read at :166) | Same callback; used at :326, :346, :400. |
| R6 | core/services/vault/transfers.ts:2101-2107 (read at :2103) | `defaultPrivateBackupEnabled`, used by `requirePrivateBackup` (:2111-2116). Callers are :2270, :3119 and :3218, each preceded by `requireReleased` (:2264, :3118, :3215). `requireReleased` throws unless `scopeToken.profileIndex` is 0 (:2093-2095). |

**Write sites**

| # | Site | What it does |
|---|---|---|
| W1 | ui/screens/WalletConfigScreen.tsx:245 | Toggle. The off path first awaits a confirm alert (:234-242). Handler deps are `[backupPushOn, t]` (:249). |
| W2 | core/backup/erase.ts:50 | `eraseRemoteBackup` writes `false` as step 1, before the server delete. |

- The erase caller loops all three chains for the active profile (WalletConfigScreen.tsx:293-295). It derives `primaryKey` for `activeProfile` at :279-283, so the server account is already per profile. Only the flag is global.
- Real bug today: erasing profile N's backup (W2) turns off pushing for every profile, because every profile's R1 reads the same flag. Likewise an opt-out on profile 0 silently stops profile 1's backup, which preference.ts:4-8 says must never happen.

**Checked, not read or write sites**
- Restore flows: preference.ts:10-11 says `restoreOnImport` never consults it. The restore block at WalletContext.tsx:1573-1666 has no reference.
- Discovery: core/profiles/discovery.ts does not import it. It only probes manifests (:62-64).
- core/recovery/*: no reference (grep).
- Backup attestation (core/services/vault/backupAttestation.ts): a different flag (phrase or shares acknowledged).
  - It is already keyed by identity key (`scopeKey` :33), so it is per profile by construction.
  - It is swept by prefix in `clearAll` (:71-75).
  - It is called at WalletContext.tsx:3605.
- Onboarding and backup reminder (ui/screens/WalletHomeScreen.tsx:374, :442): these use `backupAttestation` only.
- Vault enrollment: gated by `isBackupPushEnabled` only via R4-R6.
- The `isBackupPushEnabled: async () => true` lines in `__tests__/ui/walletHome*.test.tsx` and similar are barrel-mock boilerplate. WalletHomeScreen does not read it.

## 2. Built versus pre-profile reads

- No read happens at import time. Every reader runs inside an async function: a monitor task, a user action or a screen effect.
- None runs before `loadProfiles()` (WalletContext.tsx:1261), with one exception to check. R1 is only registered at WalletContext.tsx:2193-2207, after a build. R2, R4, R5 and R6 run on user action.
- **Uncertain:** R3 is a mount-time read. I did not verify whether WalletConfigScreen can mount before `loadProfiles()` resolves (for example a cold-start deep link), or stay mounted across a switch. The switcher lives on the Home avatar (commit e6a42b60). Add `activeProfile` to the effect deps regardless; it is cheap and covers both cases.
- If profileStore's `state` is read before `loadProfiles`, it is still `defaultProfilesState()`, so `profileScopedKey` returns the bare key (profileStore.ts:91, :198-200). That would be wrong only for a persisted active profile other than 0. No current reader hits that window.
- Switch ordering is correct. `switchProfileImpl` runs `teardownBuiltWallet` (:2956), which runs `stopMonitorAndDrain` (:32-45). Only then does it call `setActiveProfile(n)` (:2958) and `reloadProfileCaches()` (:2959). `pushOnce` reads the flag as its first await, so a draining pass reads the departing profile's flag.
- **Residual risk:** the drain is bounded at 7s (:40). `stopTasks` only stops the loop between passes, and monitor tasks run sequentially (core/monitor/TaskBackupPush.ts:8-9). If another task ahead of BackupPush hangs past 7s, `runTask` could start after the active index flips (:2958) and read the new profile's flag against the old profile's storage and key.
- Whether that pass could still read data is unverified. The old storage is destroyed right after the drain, at :2837-2840. Passing an explicit index into `pushOnce` closes it regardless.

## 3. In-memory copies and `reloadProfileCaches`

- There is no module cache of the preference, so `reloadProfileCaches` (WalletContext.tsx:1239-1252) needs no change.
- The only component copy is `backupPushOn` state in WalletConfigScreen (:219-221, set at :246, :296, :305). Fix it with the effect deps above.
- `TaskBackupPush` statics (core/monitor/TaskBackupPush.ts:38-57) are process-global by design (:7-13) and do not hold the preference. They do carry `nextDueAt`, `backoffMs`, `hasChanges` and `checkNow` across a profile switch.
  - After an opted-out pass, `noteRan` sets `nextDueAt` 60s ahead (:140-143).
  - So the first push after switching from an OFF profile to an ON profile can wait up to 60s, or up to 15 min if the previous profile was backing off.
  - Optional: call `TaskBackupPush.requestNow()` next to `noteChanged()` at WalletContext.tsx:2206.
  - `TaskBackupPush.reset()` has no caller in core/ or ui/, although its comment (:93) says it is used on sign-out.
- `cachedClient` (push.ts:252-264) is keyed by baseUrl plus pseudonym, so it is already per profile. The `getDeviceId` cache (core/backup/deviceId.ts:12) is intentionally device-wide.

## 4. `backupDeviceId`: safe to keep device-wide

- It is read only by `getDeviceId` (deviceId.ts:15-28, key `DEVICE_ID_KEY` at core/backup/constants.ts:107). The only production caller is push.ts:89.
- Cursor key is `backupCursor-${chain}-${pseudonym}-${deviceId}` (constants.ts:114-117). The pseudonym derives from the profile's `primaryKey` plus chain (core/backup/derive.ts:44-46), so each profile gets its own cursor. Both status.ts:33 and `clearCursorsForPseudonym` (cursor.ts:163-167) scope by the pseudonym prefix.
- `resyncFromServer` filters the pseudonym's own manifest by deviceId (push.ts:355-358).
- Server side, the primary key is `(pseudonym, device_id, generation, seq)` (go-private-backup-cache/internal/blobstore/postgres.go:44; memory.go:40). A shared device id cannot collide across profiles.
- Privacy only, not correctness: the server sees the same device id under every profile's pseudonym. It already sees it under the three per-chain pseudonyms today. Per-profile device ids (`profileScopedKey(DEVICE_ID_KEY)`, with the cache keyed by index) are optional hardening. Profile 0 would keep the bare key.

## 5. Change list

**Rule applied:** where the call site holds an explicit `primaryKey`, pass the index explicitly. Where the read means "what the user currently sees", use the default (`profileScopedKey` falls back to the active index when the argument is `undefined`).

**Implementation changes**

1. **core/backup/preference.ts:19-33**
   - Keep `BACKUP_PUSH_ENABLED_KEY = 'backupPushEnabled'` as the base key. Profile 0 stays bare, so there is nothing to migrate (plan:15 says pre-launch, no migration). Profiles 1+ use `backupPushEnabled__p<n>`.
   - Change the signatures to `isBackupPushEnabled(profileIndex?: number)` and `setBackupPushEnabled(enabled, profileIndex?: number)`, each using `profileScopedKey(BACKUP_PUSH_ENABLED_KEY, profileIndex)`.
   - Keep the fail-towards-ON semantics.
   - Import from `../profiles/profileStore`. This is verified clean: core/config.tsx, which profileStore imports (:21), has zero imports, so there is no cycle. Precedent: userAvatar.ts:17, ConnectionStore.ts:3, arcTokenStorage.ts:4.
   - Update the module doc at :13-16.
2. **core/backup/push.ts:38-54 and :83**
   - Add `profileIndex?: number` to `PushDeps`, and change the gate to `isBackupPushEnabled(deps.profileIndex)`.
   - Optional rather than required so push.test.ts needs no edits.
3. **core/context/WalletContext.tsx:2196-2202**
   - Pass `profileIndex` into `pushOnce`. It is already captured at :1315 and used the same way at :2535 for `vaultStore.configureScope`.
4. **core/backup/erase.ts:31-39 and :50**
   - Add `profileIndex?: number` to `EraseDeps`, and call `setBackupPushEnabled(false, deps.profileIndex)`.
   - Note this is the primitive a delete-profile flow could reuse. It is already keyed per profile by `primaryKey` (erase.ts:46-59).
5. **ui/screens/WalletConfigScreen.tsx:294**
   - Pass `profileIndex: activeProfile` to `eraseRemoteBackup`. `activeProfile` is already in scope (:153, :280, deps at :309).
6. **ui/screens/WalletConfigScreen.tsx:219-221 and :231-249**
   - Change the effect deps to `[activeProfile]`.
   - Add `activeProfile` to the toggle handler deps (:249).
   - Optionally capture `const profile = activeProfile` before the `await showAlert` at :234 and write with `setBackupPushEnabled(next, profile)`.
7. **core/backup/status.ts:30** and **ui/screens/WalletCheckScreen.tsx:151**
   - Default is correct, because the pseudonym already comes from the active build.
   - Optional: add `profileIndex?` to `getBackupUploadState` and pass `activeProfile` for explicitness.
8. **ui/screens/VaultScreen.tsx:469, ui/screens/VaultTransferScreen.tsx:166, core/services/vault/transfers.ts:2103**
   - No change required. The vault is profile-0 only (VaultScreen.tsx:197 and :1086; transfers.ts:2093).
   - The vault gate then reads profile 0's flag, which is correct. A profile-1 opt-out no longer blocks vault deposits.
   - Optional: pin `isBackupPushEnabled(0)` in transfers.ts:2103 so a switch mid-await cannot change the read. `assertVaultScope` at :2271 already aborts on a switch.
   - Do not import any new symbol from preference.ts into transfers.ts; see the mocked-module note under Tests.
9. **Logout sweep, WalletContext.tsx:3568-3574** (decision point)
   - The `PROFILE_KEY_SUFFIX_RE` sweep (:3570) will automatically clear `backupPushEnabled__p1+`.
   - The bare profile-0 key is swept nowhere, and today the global opt-out already survives Delete Wallet.
   - After this change, profiles 1+ reset to ON on Delete Wallet but profile 0 keeps its opt-out, which is inconsistent.
   - Either add `AsyncStorage.removeItem(BACKUP_PUSH_ENABLED_KEY)` to the sweep, or document the asymmetry.
   - Leaving it contradicts preference.ts:4-8: the next wallet's profile 0 would inherit an opt-out.
   - Against clearing it: re-importing the same seed recreates the same pseudonym and resumes pushing.
10. **Docs**
    - Update spec :86 and plan :19 to move `backupPushEnabled` from shared to per-profile.
    - If a new string is added, for example a profile note on the Private backup section (WalletConfigScreen.tsx:954-982), all 12 locales are needed (`__tests__/i18n/translationParity.test.ts`). The existing `profile_settings_scope_note` (:607-610, translations.tsx:1126) footers the Configuration section only.

**Tests to update or add** (under PKG/__tests__)
- **backup/preference.test.ts**
  - The key assertions at :54, :56 and :69 stay valid for profile 0.
  - Add `__resetProfilesForTests()` to `beforeEach`.
  - Add cases: profile 1 defaults ON; setting profile 1 false writes `backupPushEnabled__p1` and leaves profile 0 ON; an explicit index overrides the active one.
  - Use the `appendProfile()` and `setActiveProfile` setup from profiles/scopedState.test.ts:19-23.
- **profiles/scopedState.test.ts**: add a "backup push preference is per profile" case beside :25-71.
- **backup/push.test.ts**
  - Cases at :702-736 stay valid for the default index.
  - Add a cross-profile case: opted out on profile 1 with `deps.profileIndex = 1` returns `optedOut` and does not call `getSyncChunk`, while profile 0 still pushes.
  - Add a case where an explicit index wins over the active one.
- **backup/erase.test.ts**: cases at :66-80, :126 and :130 stay valid. Add: erasing with `profileIndex: 1` leaves profile 0 ON.
- **backup/status.test.ts**: :66 stays valid; add one case for an explicit or active profile.
- **context/deleteWalletVerifiedErasure.test.tsx**: add a `backupPushEnabled__p1` assertion next to :252-267. Add a bare-key assertion only if the logout change (item 9) is taken.
- **Mocked-module vault tests:** these replace the module with `{ isBackupPushEnabled: jest.fn(async () => true) }`, so they keep passing only if production code imports nothing new from it.
  - vault/transfers.test.ts:89-93
  - vault/proofBar.cleanDeviceRecovery.test.ts:67-69
  - vault/xq016VaultAbortRealVendorInteraction.test.ts:141-143
  - vault/abortAccounting.test.ts:61-63
  - vault/proofBar.exclusionMatrix.test.ts:67-69
- **No change needed (barrel stubs ignore arguments and none pin the key)**
  - ui/walletConfigArc.test.tsx:54
  - ui/walletConfigDeleteWallet.test.tsx:57
  - ui/walletHomeBackup.test.tsx:58
  - ui/walletHomeVaultGate.test.tsx:61
  - ui/walletHomeImportHold.test.tsx:80
  - ui/walletHomeImportHoldNotQueued.test.tsx:92
  - ui/walletHomeFilter.test.tsx:56
  - ui/walletHomeTokens.test.tsx:65
  - vault/proofBar.noProductionMock.test.ts:80
  - ui/vaultScreen.test.tsx:42, :72, :248
  - ui/vaultTransferScreen.test.tsx:22, :50, :157, :242, :259, :296, :310, :436 (call-count assertions only)
- No existing test presses the Settings toggle (grep for `backup_push` in tests found only erase and push tests).
- Optional: a test that the monitor closure passes `profileIndex`. I did not check whether context/switchProfile.test.tsx can observe `pushOnce`.

## 6. Consequences to be aware of

- **Discovery gap becomes user-triggerable.** core/profiles/discovery.ts:11-13 stops at the first profile with no backup on any chain. A per-profile opt-out means opting profile 2 out can make profile 3+ undiscoverable after a re-import. `addProfile` still restores a profile at the next index via `needsRestore` (WalletContext.tsx:3024).
- **Not-checked items.** I did not run jest or tsc. The "Residual risk" and "Uncertain" notes in section 2 are unverified.