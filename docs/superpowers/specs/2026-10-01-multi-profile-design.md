# Multiple Wallet Profiles — Design

Date: 2026-10-01
Status: Approved in conversation, pending written-spec review

## Goal

One mnemonic, many wallets. A user backs up a single seed (mnemonic + 2-of-3 recovery shares) and gets any number of independent wallet *profiles*, each with its own identity key, balance, history, contacts, handle and network. Switching profiles feels like switching between separate wallets. Nothing about the backup ceremony changes.

Secondary goal (user-requested): profiles double as a fast way to swap networks — e.g. profile1 on mainnet, profile2 on testnet — because network and endpoint settings live on the profile.

## Non-goals

- No migration or backward compatibility. The app has no users yet; existing derivations may change.
- No push delivery for inactive profiles in this iteration (added by `2026-10-01-multi-profile-followups-design.md` §4).
- No new UI for build-time service endpoints (WhatsOnChain, overlay, handle registry, backup server). Those stay per-chain from `configureToolbox` and follow the profile's network automatically.
- No profile rename, reorder or delete in this iteration. Labels are fixed `profile1`, `profile2`, …
- WIF-recovered wallets (no mnemonic) do not get profiles.

## Key derivation

Profile index `n` (0-based; displayed as `profile{n+1}`):

| Key | Path | Notes |
|---|---|---|
| Primary key (identity) | `m/0'/n'` | Feeds `KeyDeriver`, storage identity, backup pseudonym, handle cert subject, MessageBox auth. Profile 0 = `m/0'/0'`, unchanged. |
| Privileged key | `m/1'/n'` | Given to `PrivilegedKeyManager`. **Changes for profile 0** — today it is the BIP32 master `m`. Applied to every profile so no two profiles share key material. |

Implementation: `generateMnemonicWallet` / `recoverMnemonicWallet` in `packages/expo-wallet-toolbox/core/mnemonicWallet.ts` take a `profileIndex` (default 0) and return `{ primaryKey, privilegedKey, identityKey }` for that profile. The BIP32 master is no longer returned to callers.

Call-site classification for the existing hard-coded `m/0'/0'` uses:

- **Wallet-level, unchanged (profile 0 / seed-only):** `core/recovery/shares.ts`, `core/recovery/secret.ts`, `core/recovery/backupMaterial.ts`, `ui/printRecoveryShares.ts`. Shares back up seed entropy; the identity printed with them is profile 0's.
- **Creation sites, always profile 0:** `core/recovery/createWallet.ts`, `core/recovery/useRecoveryDeps.ts`, `WalletHomeScreen.tsx` create path, `VaultScreen.tsx` create path.
- **Profile-level, must use the active index:** `WalletContext.buildWalletFromMnemonic`, `rebuildWallet`, `switchNetwork`, the auto-build effect, `restoreOnImport` callers, and `WalletConfigScreen` remote-backup erase.

The WIF path (`buildWalletFromRecoveredKey`) is untouched: the WIF is both primary and privileged key, and the wallet has exactly one implicit profile.

## Profile store

New module `core/profiles/profileStore.ts`. One AsyncStorage key, readable before any wallet DB opens:

```ts
// AsyncStorage key: 'wallet_profiles_v1'
interface ProfilesState {
  active: number               // index of the active profile
  profiles: ProfileRecord[]    // dense, index 0..count-1, ordered by index
}
interface ProfileRecord {
  index: number
  network: AppChain            // 'main' | 'test' | 'teratest'
  arcUrl?: string              // per-profile override; absent = build default for network
  messageBoxUrl?: string       // per-profile override; absent = build default
  autoApproveThreshold?: number
  needsRestore?: boolean       // set by restore discovery; cleared after first build's restore runs
}
```

Defaults: missing or corrupt key → `{ active: 0, profiles: [{ index: 0, network: DEFAULT_CHAIN }] }`. New profiles default to `network: 'main'`.

The ARC API token (SecureStore, today via `getArcApiToken(network)`) is keyed by profile index as well as network.

`finalConfig.network` stops being the source of truth for the network; the active profile's `network` is. `finalConfig` keeps its other fields.

## Per-profile vs shared state

**Per profile, automatically** (already keyed by identity key or DB file):
wallet SQLite DB (contacts, handle cache, display name, local-pay / PeerPay queues, address watchlist, `key_value_store`), vault meta SecureStore records, backup attestation, remote backup account and cursors.

**Per profile, by this change** (AsyncStorage keys gain an identity-key suffix, or move into `ProfileRecord`):

| State | Today | After |
|---|---|---|
| Network | `finalConfig.network` | `ProfileRecord.network` |
| ARC URL | `arc_custom_url_<chain>` | `ProfileRecord.arcUrl` |
| ARC token | SecureStore per chain | SecureStore per profile + chain |
| MessageBox URL | `message_box_url` | `ProfileRecord.messageBoxUrl` |
| Auto-approve threshold | `autoApproveThreshold` | `ProfileRecord.autoApproveThreshold` |
| Auto-approve ledger | `auto_approve_ledger` | `auto_approve_ledger_<identityKey>` |
| Cached balance | `cached_wallet_balance_<network>*` | `cached_wallet_balance_<identityKey>_<network>*` |
| Avatar | `wallet_user_avatar_icon` | `wallet_user_avatar_icon_<identityKey>` |
| Paired connections | `connections` | `connections_<identityKey>` |
| Seen-token markers | `mandala_seen_assets`, `mandala_seen_evictions` | suffixed `_<identityKey>` |
| Push registration marker | `push_registration_v1` (single slot) | not profile-scoped: a map from identity key to the host and token registered, one entry per profile (see Push and `2026-10-01-multi-profile-followups-design.md` §4) |
| Remote-backup preference | `backupPushEnabled` | `profileScopedKey`: profile 0 keeps the bare key, profile n uses `backupPushEnabled__p<n>`. Absence still means ON. |

**Shared across profiles:** `walletSettings` (display currency, theme, etc.), one-time advisories (`nearby_advisory_shown_v1`, `push_advisory_shown_v1`), `backupDeviceId`, handle key pins (`handleRegistry.keyPins.v1`), mnemonic and recovery secrets.

`backupPushEnabled` is per profile, not shared: each profile pushes to its own server account, so one profile's opt-out (or erasing its server copy) must not stop another profile's backup. See `2026-10-01-multi-profile-followups-design.md` §1.

**Profile 0 only:** YubiKey / Vault, including `vault_enrolled_serial_registry_v1`.

## Switching profiles

New `WalletContext` method `switchProfile(n: number): Promise<void>`:

1. No-op if `n === active`.
2. Same teardown as `rebuildWallet` / `switchNetwork`: bump build generation, clear vault scope, cancel vault ceremony, detach push, stop and drain monitor, clear offline chaintracks / header store, destroy storage, clear mandala, forget session PSKs, clear managers and built flags. This teardown is factored into one shared helper used by all three paths.
3. Write `active = n` to the profile store.
4. Set `selectedNetwork` from the profile record and trigger the build, which derives keys for index `n`.
5. If the record has `needsRestore`, run `restoreOnImport` during that build, then clear the flag.

`switchNetwork(network)` keeps its signature but now updates the active profile's `network` before rebuilding.

`addProfile()`: append `{ index: count, network: 'main', needsRestore: true }` and `switchProfile(count)`. Because `needsRestore` is set, adding an index that already has a remote backup restores it — the safety net for restore discovery.

Disabled for WIF wallets (no mnemonic): the context exposes `profilesSupported: false`.

## Restore discovery

Runs once after a mnemonic **import** (not after creating a new wallet), after profile 0's build finishes:

```
for n = 1, 2, 3, …:
  primaryKey = deriveProfileKeys(mnemonic, n).primaryKey
  found = []
  for chain in BACKUP_CHAINS ('main', 'test', 'teratest'):
    if (await listBackups({ primaryKey, chain, client })).length > 0: found.push(chain)
  if found is empty: stop
  register { index: n, network: found.includes('main') ? 'main' : found[0], needsRestore: true }
```

- Only the probe runs eagerly; data replay waits until the user first switches to that profile.
- Skipped when the backup server is not configured.
- Network errors stop discovery without registering a partial result for the failing index; profiles already found stay registered.
- Known gap: a profile with no backup (never used, or backup opted out) ends discovery and hides any higher profile. Adding a profile again restores it (see `addProfile`).

## UI

**ProfileButton** (`ui/components/wallet/ProfileButton.tsx`): when `profilesSupported`, pressing opens a popover anchored to the button instead of navigating to `/profile`. Otherwise it keeps today's `router.push('/profile')`.

**ProfileSwitcherPopover** (new, `ui/components/wallet/ProfileSwitcherPopover.tsx`):

- One row per profile: avatar, label `profile{n+1}`, a network badge when the profile isn't on mainnet, and a check on the active row.
- Tapping the active row closes the popover and opens `/profile`.
- Tapping another row closes the popover and calls `switchProfile(n)`. Home shows its normal building state until the switch finishes.
- Below the list, an "Add profile" button calls `addProfile()`.
- Follows the visual language of the existing popovers (e.g. `AssetSwitcherDropdown`). All strings are i18n keys.

**Settings:** the network selector, ARC URL/token, MessageBox URL and auto-approve threshold controls read and write the active profile's values. Labels say they apply to the current profile.

## Vault gating

New helper `isVaultAvailableForProfile(chain, activeProfile)`. It is true when `activeProfile === 0` and `isVaultAvailable(chain)`.

Applied at:
- Home Vault button (`WalletHomeScreen.tsx`). The gate becomes `activeProfile === 0 && (isVaultAvailable(chain) || hasVaultMeta)`.
- Settings Vault row (`SettingsScreen.tsx`), same gate.
- `VaultScreen` and `VaultTransferScreen` show their existing inert state when the gate is false. This covers deep links and the back stack after a switch.
- Vault transfer guard (`core/services/vault/transfers.ts`).
- YubiKey enrollment entry points.

## Push

Superseded by `2026-10-01-multi-profile-followups-design.md` §4: every live profile registers the device's token under its own identity, and a push for a profile that is not open switches to it when tapped. As first built, only the active profile was registered: `switchProfile` detached push (step 2), and the new build registered the new identity under a single-slot marker.

## Delete Wallet (logout)

`logout()` must clear every profile, not only the active one. For each index in the profile store:

- derive its identity key
- purge its registered DB files on every chain
- clear its suffixed AsyncStorage keys and its backup attestation
- clear its ARC token

Then delete the profile store, mnemonic and secrets as today. Afterwards the app is in a first-run state equivalent to `{ active: 0, profiles: [index 0] }`.

## Error handling

- Corrupt or unparseable profile store: fall back to the default record and log. Never block startup.
- Active index out of range: clamp to 0.
- `switchProfile` failure mid-build: the existing build-failure surface applies. The store already points at the new profile, so the user can retry or switch back from the popover.
- Concurrent switch taps: the popover disables its rows while a switch or build is in flight, and the build-generation bump discards any stale build.

## Testing

Unit tests (jest, toolbox package):
- `deriveProfileKeys`. Using a fixed test mnemonic, profile 0's identity equals `m/0'/0'`. Profile 1's equals `m/0'/1'`. Privileged keys equal `m/1'/n'`. Privileged and primary keys differ, and different profiles' keys differ.
- Profile store: defaults, corrupt-JSON fallback, add, set active, clamping, per-profile field updates.
- Restore discovery with an injected `BackupClient` fake:
  - stops at the first miss
  - picks the network (main preferred)
  - skips when not configured
  - stops on error while keeping the profiles already found
- Vault gate: hidden for profile ≥1 and for profile 0 off mainnet. Shown for profile 0 on mainnet.
- Scoped storage keys: per-identity key builders produce distinct keys for distinct identities.
- `logout` clears every profile's DB registry and suffixed keys (with mocked storage).

Manual (simulator):
- Popover open and close. Tapping the active row opens `/profile`.
- Add profile gives an empty wallet with a new identity.
- Switching back shows the original balance.
- Network per profile: profile2 on testnet, then switch to profile1 and the app is back on mainnet.
- Vault button hidden on profile2.
- Import the mnemonic on a fresh install and check that discovery registers the backed-up profiles.

## Open follow-ups

- ~~Push delivery for inactive profiles.~~ Done: followups spec §4.
- Initial marker backup on `addProfile`, to close the discovery gap.
- Profile rename and delete.
- Storing profile settings (URLs, threshold) in the remote backup so a restore brings back more than the network.
