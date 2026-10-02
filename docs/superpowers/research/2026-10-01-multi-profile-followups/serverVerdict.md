AGREE with the verdict: CANNOT. One FCM token belongs to exactly one identity at a time, and re-registering it under a second identity silently takes it from the first. I read the code independently and could not refute this. All paths are in `/Users/personal/git/go/go-message-box-server`, on `main` at `4179cd4`, and `origin/main` points at the same commit after a fetch.

## Evidence that a token has one owner

- **SQL schema.** `fcm_token TEXT NOT NULL UNIQUE` is at `pkg/storage/sqlstore/sqlstore.go:201` (sqlite) and `:276` (postgres). The only other indexes on the table are non-unique, at `:151-152`. Those migrations are all `CREATE INDEX IF NOT EXISTS`.
- **No migration relaxes the constraint.** A grep for `ALTER TABLE`, `DROP INDEX`, `DROP TABLE` and `DROP CONSTRAINT` returned nothing in non-test code.
- **SQL register query.** `pkg/storage/sqlstore/queries.go:422-426` is `INSERT … ON CONFLICT(fcm_token) DO UPDATE SET identity_key = ?, device_id = ?, platform = ?, updated_at = ?, active = TRUE, last_used = ? RETURNING id`. It keys on the token alone and has no guard on the current owner. A second identity registering the same token takes the existing row.
- **Mongo.** `bson:"_id"` is the token (`pkg/storage/mongostore/mongostore.go:421`). `RegisterDevice` runs `FindOneAndUpdate` on `_id: d.FCMToken` (`:459-476`) and `$set`s `identityKey`, so ownership transfers there too.
- **Handler.** `pkg/handlers/devices.go:34-70` only checks that the token is non-empty and the platform is valid. It never looks at who currently owns the token. It returns `status: success` to the new owner.
- **Delivery.** `ListActiveDevices(recipient)` is called at `internal/firebase/send_fmc_notification.go:50`, and the query is `WHERE identity_key = ? AND active = TRUE` (`queries.go:471-473`). After a takeover the old identity's lookup returns nothing, so it gets no push for that token.
- **Replay.** I ran the exact upsert shape in the sqlite CLI (`INSERT … ON CONFLICT(fcm_token) DO UPDATE SET identity_key=…, active=TRUE RETURNING id`). After A then B registered token T there was 1 row, with active count A=0 and B=1. Both registrations returned id 1.

## Caveats the earlier report missed or understated

1. **Stale worktree.** `.claude/worktrees/pr-17-changes-bac25e/` holds an older copy of the server where `RegisterDevice` returns only `error` and queries.go line numbers differ. A grep run without excluding it gives misleading line numbers. The same unique-token and token-keyed semantics apply there.
2. **`deviceId` is not a key.** The client's optional `deviceId` is stored in a plain nullable column, `device_id TEXT` (`sqlstore.go:202`), and is never part of the conflict target. Different `deviceId` values for the same token do not create a second row. The wallet does not send one anyway (`packages/expo-wallet-toolbox/core/push/registration.ts:38` sends only `fcmToken` and `platform`).
3. **The "id" the client sees is per token, not per identity.** The response `deviceId` is the row id (`devices.go:65`). The client requires a positive safe integer (`message-box-client/dist/src/MessageBoxClient.js:2515`). When B takes A's token, B gets the same id A had.
4. **Invalid-token cleanup deactivates by token only.** `DeactivateDevice` is `UPDATE … SET active = FALSE … WHERE fcm_token = ?` (`queries.go:486-491`; Mongo `mongostore.go:555-562`). It is triggered by `IsUnregistered` or `IsInvalidArgument` (`send_fmc_notification.go:77-80,157-159`). It never deletes rows and sets `active = FALSE` on the single owner row. Re-registering the token sets `active = TRUE` again. An FCM error on one identity's push therefore cannot hit another identity's row today. Under a future multi-row schema, a dead token would deactivate all rows for that token, which is correct.
5. **Takeover is silent.**
   - The old identity's `/devices` stops listing the token. The old identity is not told (`devices.go:92-129`).
   - The wallet's local `push_registration_v1` marker would still say registered, so the client would think it is still registered while receiving nothing.
6. **No ownership proof and no unregister.**
   - Any authenticated identity can claim any token string. The server does not validate the token with FCM at registration.
   - Only `POST /registerDevice` and `GET /devices` exist (`cmd/server/main.go:150-151`). The client has no unregister method (grep found none in the client's `MessageBoxClient.js`), so the only way to release a token is for another identity to take it.
7. **No rate limit or payment on device routes.**
   - The only rate limiter in the repo wraps the public paymail lookup (`cmd/server/lookup.go:62`).
   - The payment middleware prices every request at 0 (`cmd/server/main.go:136-138`).
   - Auth is required (the mux is under `authMiddleware.HTTPHandler` at `main.go:194-196`). I did not trace go-sdk BRC-104 signature verification, so that part is unverified.
   - I found no cap on devices per identity, but registering all profiles in a loop is not blocked by any limit. It just ends with only the last profile owning the token.
8. **The push payload has no routing information.**
   - Only `messageId` and an always-empty `originator` go out (`send_fmc_notification.go:118-156`; `send_message.go:287-290`).
   - The title is box-based: "New Message" for `notifications`, "Payment received" for `payment_inbox` or `mandala-payments` (`pkg/handlers/policy.go:34-43`).
   - Even with multi-row registration, the app could not tell which profile a push is for without a payload change.
9. **Cannot rotate tokens per identity.** A fresh FCM token for the same app install invalidates the old one on FCM's side, so giving each profile its own token on one device does not work. Different `deviceId` or platform strings change nothing, and altered token strings would just be invalid at FCM. This is my inference from FCM behaviour, not from this repo.
10. **Maintainer intent.** `pkg/storage/storage.go:106-109` documents "upserts on d.FCMToken". The `storagetest` conformance suite always uses distinct tokens per identity (`storagetest.go:1078-1080`), so cross-identity re-registration is neither pinned nor forbidden by tests. The behaviour follows from the SQL and Mongo code alone.
11. **Unconfirmed items.** The production backend (sqlite, postgres or Mongo) and the deployed server version are not confirmed from this repo, but all three backends reassign ownership. `origin/feat/permission-uniqueness` has zero device or fcm lines in `git diff main...origin/feat/permission-uniqueness`.

## Server change needed for multi-identity pushes

1. **SQL.** Replace `UNIQUE(fcm_token)` with `UNIQUE(identity_key, fcm_token)` and change the upsert to `ON CONFLICT(identity_key, fcm_token)`. The unique constraint is inline in `CREATE TABLE IF NOT EXISTS`, so existing databases need a new migration step. SQLite cannot drop an inline UNIQUE without rebuilding the table. Postgres needs `DROP CONSTRAINT device_registrations_fcm_token_key` plus a `CREATE UNIQUE INDEX`.
2. **Mongo.** `_id` is the token (`mongostore.go:421`). Use a compound `_id` or a unique `(identityKey, fcmToken)` index and filter the upsert on both fields. Existing documents need a backfill, because `deviceDoc` has no separate token field yet.
3. **`/devices` and DeactivateDevice.** Keep `DeactivateDevice` and `UpdateDeviceLastUsed` keyed by token. Their `UPDATE … WHERE fcm_token = ?` already updates all rows for that token. `ListActiveDevices` already filters by identity. Check that the id stability test (`storagetest.go:1078-1090`) still holds per `(identity, token)`.
4. **Payload routing.** Add the recipient identity key and messageBox to the FCM data payload in `buildMessage`, with the `Recipient` passed from `send_message.go:287-290` (the identity key is already in scope as `fr.recipient`). Without it the app can only match `messageId` against each profile's inbox.
5. **Optional.** Add an unregister endpoint, and a server-side notification or ownership proof, so the client can release a token and takeover is no longer silent.

## Without a server change

- Re-register the active profile's identity on every profile switch (and on token refresh). The token then follows the active profile, so only the active profile gets pushes.
- Registering profiles in a loop leaves only the last one registered.
- Only the active profile's wallet is built, so the app cannot create a BRC-104 session as the other profiles to register them at all.
- On a profile switch, reset or re-check the local `push_registration_v1` marker. It is a single slot, so it should record which identity currently owns the token, not just that a registration exists.