# Multiple Wallet Profiles — Follow-ups Design

Date: 2026-10-01
Status: Decisions approved in conversation (all recommended options)
Extends: `docs/superpowers/specs/2026-10-01-multi-profile-design.md`
Research (file:line evidence): `docs/superpowers/research/2026-10-01-multi-profile-followups/`

This covers four follow-ups to the multi-profile feature: a per-profile backup preference, renaming profiles, removing profiles, and push notifications for every profile. The base spec listed rename/delete and multi-profile push as non-goals or follow-ups; this document supersedes those lines.

## 1. Per-profile remote-backup preference

Today `backupPushEnabled` (core/backup/preference.ts) is one global AsyncStorage key. Erasing one profile's backup (core/backup/erase.ts step 1) therefore turns backup off for every profile.

Change: the key goes through `profileScopedKey`. Profile 0 keeps the bare `backupPushEnabled` and profile n uses `backupPushEnabled__p<n>`. Absence still means ON.

- `isBackupPushEnabled(profileIndex?)` and `setBackupPushEnabled(enabled, profileIndex?)` take an optional explicit index. Without one they use the active profile.
- Call sites that hold a specific profile's key pass the index explicitly:
  - `pushOnce`, via a new optional `PushDeps.profileIndex`, passed from WalletContext's build-scoped `profileIndex`;
  - `eraseRemoteBackup`, via a new optional `EraseDeps.profileIndex`, passed `activeProfile` from WalletConfigScreen.
- Vault reads are unaffected. The vault exists only on profile 0, and so does its read.
- WalletConfigScreen re-reads the toggle when `activeProfile` changes.
- Delete Wallet also removes the bare profile-0 key, so the next wallet starts ON. Profiles 1+ are already swept by `__p<n>`.
- `backupDeviceId` stays device-wide. Server rows are keyed by (pseudonym, deviceId, …), so it cannot collide across profiles.

## 2. Rename

- `ProfileRecord.name?: string` is a private label stored only on the device.
  - Trimmed, at most 24 characters. An empty name is dropped.
  - Kept separate from `profile_display_name`, which is public once a handle exists and lives in a database that is closed while the profile is inactive.
- `profileLabel(record, t)` returns `record.name` if set, else `t('profile_label', { number: index + 1 })`. It is used in:
  - the popover rows, including their accessibility labels;
  - the switch cover;
  - the WalletConfigScreen scope note;
  - the `profile_switch_failed` toast.
- UI: a "Profile name" field (PencilEditField) at the top of the Profile screen for the active profile. Its hint says it is private and stays on this device.
- Names are not backed up, so a reinstall shows `profileN` again.

## 3. Remove a profile

A profile is a pure function of the seed (`m/0'/n'`), so it can never be destroyed. Remove means: forget it on this device and withdraw its public handle.

Eligibility:
- Only the active profile, and never profile 0.
- Only while no profile switch is in flight, and only while online.

The zero-balance proof is `assertProfileEmpty`. It runs on the open storage, fails closed on any error, and blocks removal if any of these is true:
- any `outputs` row for the user with `spendable = 1`, in any basket (this covers tokens);
- any `transactions` row whose status is not `completed` or `failed`;
- any `offline_actions` row in `queued`, `posting`, `parked` or `import_hold`;
- any non-terminal `token_settlements` row (terminal: `broadcast`, `admitted`, `refused`, `orphaned`), or mandala balances not both zero;
- any `localpay_pending` entry, including stuck or corrupt ones;
- any `peerpay_outbox` entry not `sent`;
- an outstanding handle journal (`profile_handle_pending`);
- a pending inbox, where one forced CreditInbox pass before the check must succeed.

The rule is strict on every network.

Steps, in order. Everything before step 5 aborts cleanly:
1. Guards and `assertProfileEmpty`.
2. Release the handle, if the registry for the profile's network reports one for this identity. A new `releaseHandle` journals and PUTs a `released: true` certificate signed by the live wallet. If the lookup or release fails, the whole removal aborts. The confirm copy warns about the 30-day cooldown.
3. Keep the remote backup. A removed profile can reappear after a reinstall and seed import; it is empty and can be removed again.
4. Disconnect the paired session.
5. Switch to profile 0 using the normal switch, with its cover. If that switch fails, abort; nothing has been purged.
6. After the switch succeeds:
   - mark the profile removed (`deleted: true`, keeping `identityKey`);
   - purge its databases on every network (`purgeIdentityDbFiles`);
   - clear its ARC token;
   - remove the AsyncStorage keys ending exactly in `__p<n>`;
   - unregister its push registration (section 4).
7. On every startup, purge again for each tombstoned record. This is idempotent and covers a crash between the tombstone and the purge.

Store semantics:
- The array stays dense, and tombstones keep their index.
- An index is never reused. `appendProfile` already uses `profiles.length`, and a reused index would bring back the same identity.
- `active` never points at a tombstone. Parse clamps it to the nearest live profile, and `setActiveProfile` and `switchProfile` refuse a tombstone.
- The popover hides tombstones.
- Discovery leaves tombstoned indices as they are. On a fresh device there are no tombstones, which is decision (b): keep backups.

UI: the Profile screen gets a "Remove profile" destructive row for the active profile when it isn't profile 0.
- The row first runs the check. If it fails, it explains why (funds, pending activity, offline).
- If it passes, a confirm dialog says what happens and mentions the handle cooldown when relevant.

## 4. Push for every profile

### Server (go-message-box-server; production runs MongoDB)

Device rows become unique per (identity key, FCM token) instead of per token.
- SQL (sqlite and postgres): migrate the table to `UNIQUE(identity_key, fcm_token)`. The upsert becomes `ON CONFLICT(identity_key, fcm_token)`.
- Mongo:
  - Documents gain an explicit `fcmToken` field, backfilled from the legacy `_id`.
  - A unique index covers `{identityKey, fcmToken}`.
  - New documents use a compound string `_id` such as `identityKey|token`. Legacy documents keep their `_id`.
  - The upsert filters on `{identityKey, fcmToken}`.
  - Token-keyed operations (`DeactivateDevice`, `UpdateDeviceLastUsed`) apply to every row for that token.

`ListActiveDevices(recipient)` is unchanged, since it is already per identity.

The FCM data payload gains `recipient` (the recipient identity key, compressed hex) and `messageBox` (the box name). The title and body are unchanged.

New authenticated endpoint `POST /unregisterDevice {fcmToken}`. It deactivates or deletes only the caller identity's row for that token.

Tests cover:
- two identities on one token both receiving pushes;
- re-registration staying idempotent;
- legacy Mongo document migration;
- the unregister scope;
- the payload fields.

### App

- At build time, `buildWalletFromMnemonic` has the mnemonic. It derives every live, non-tombstoned profile's primary key from one HD root and hands them to the push sync.
- Registration uses a `ProtoWallet` built from the profile's primary key (enough for BRC-103 auth). It goes to that profile's MessageBox host, read with an explicit index. It never calls `init()` or `anointHost()`.
- The marker becomes per identity: `push_registration_v1` holds a map from identity to `host|token`.
- Order: inactive profiles first, the active profile last. Against today's server this means the active profile still ends up owning the token.
- After a push is opened, the app reads `data.recipient`:
  - if it matches a non-active live profile's `identityKey`, it switches to that profile, then opens Activity;
  - if it is missing (old server), the behaviour is unchanged.
- Foreground pushes for an inactive profile do not trigger the active profile's inbox pass.
- Removing a profile calls `/unregisterDevice` for it, best-effort, because it only works once the server change is live. Delete Wallet does the same for every profile.

### App: what the implementation settled

- **Old servers.** The app must not depend on the server change being live. A server that keeps one identity per token hands the token to whichever identity registered last, so besides the per-identity marker the device records which identity registered last (`push_registration_owner_v1`) and the active profile registers again whenever it is not that identity. After a switch the new profile's own marker is intact, so without this it would never register and the token would stay with the profile just left. Against a server with per-(identity, token) rows that re-registration is an idempotent upsert, one request per switch, as before.
- **Unregister works from the marker.** `unregisterPushIdentity` reads the host and token the device recorded for that identity, not the current host setting or the current token, so a removed profile (whose settings the purge has just swept), a host changed since, or a rotated token still get the right request. An identity with no marker was never registered from this device and is skipped. `404`, `405` and `501` (a server without the endpoint) are reported as unsupported and are not failures. Each request is bounded to 8 seconds.
- **A failed unregister is retried.** The marker is the record of what is still registered, so it is dropped only once nothing is: on a successful or unsupported answer, and when the identity was never registered from this device. On a failure (offline, a timeout, an error answer) it stays. At the next build, `buildWalletFromMnemonic` derives the key of every tombstoned profile that still has a marker, and `createProfilePush.sync` asks again to withdraw it (the profile is never registered or routed to). A marker whose host the client would refuse is dropped, since no retry could use it. Delete Wallet sweeps the markers whatever happened: after it there is no seed to retry with.
- **A registration in flight when its profile is removed.** The sync asks again whether the profile is still wanted when the answer comes back, in the same step that records the marker, which the unregister also reads through. A removed profile's late registration is withdrawn at once (and kept for the retry if that fails too); a replaced build or a deleted wallet records nothing.
- **Recipient routing acts only on a positive match.** `data.recipient` that names a live profile other than the open one switches to it on a tap and skips the open profile's inbox pass on a foreground message. A missing recipient, the open profile's own, or an identity this device does not know leaves today's behaviour unchanged, so a formatting mismatch can never silence the open profile.
- **Delete Wallet** starts unregistering every profile first, before teardown, and waits for it (bounded) before sweeping the markers it works from. The markers are not profile-scoped and are swept explicitly.
- **Key material.** The keys of the profiles that are not open are derived from one HD root at build time, only when push is wired and more than one profile is live, and are held (as ProtoWallets) by that build's push handle until it is torn down. The privileged key is never derived for this, and the mnemonic is not retained.

## Testing

- Unit tests for:
  - the scoped preference;
  - store name, tombstone, clamping and never-reuse;
  - `profileLabel`;
  - every blocker in `assertProfileEmpty`;
  - the `releaseHandle` journal;
  - the removal ordering and abort paths;
  - the push sync (order, markers, ProtoWallet identity);
  - tap routing.
- Go tests for the server change.
- Manual simulator checks: rename, remove a zero-balance profile, switch to an inactive profile from a push (needs the server change deployed).
