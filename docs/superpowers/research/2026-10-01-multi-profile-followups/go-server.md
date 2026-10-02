# Go MessageBox server: can one FCM token be registered for several identity keys?

Repo: `/Users/personal/git/go/go-message-box-server`, branch `main`, HEAD `4179cd4` (merge of PR #22). Local `main` equals `origin/main` as of the last fetch. The only unmerged branch, `feat/permission-uniqueness`, touches no device or FCM code (its diff contains no "device" or "fcm" matches).

## Verdict: CANNOT

One FCM token maps to exactly one identity at a time. Registering a token for identity B overwrites the owner on the existing row. Identity A silently stops receiving pushes for that token. B's registration returns success and nothing tells A.

I also replayed the exact upsert SQL against an in-memory sqlite 3.54 (scratchpad only, no repo files touched):
- After registering token T for A and then for B, the table still has 1 row, owned by B.
- The `listDevices` query (the one the push path uses, with `active = TRUE`) returns nothing for A and `1|B|T` for B.

## 1. Data model and register handler

**SQL backends (sqlite and postgres)**
- The token column is unique in both: `fcm_token TEXT NOT NULL UNIQUE` at `pkg/storage/sqlstore/sqlstore.go:201` (sqlite) and `:276` (postgres).
- The only other indexes are non-unique: `idx_device_registrations_identity (identity_key)` at `sqlstore.go:151` and `(identity_key, active)` at `:152`.
- There is no `(identity_key, fcm_token)` key and no unique constraint on `device_id`.
- `RegisterDevice` is an upsert keyed on the token alone (`pkg/storage/sqlstore/queries.go:423-426`): `INSERT … ON CONFLICT(fcm_token) DO UPDATE SET identity_key = ?, device_id = ?, platform = ?, updated_at = ?, active = TRUE, last_used = ? RETURNING id`.
- That `DO UPDATE` overwrites `identity_key` and has no `WHERE` clause guarding the previous owner, so the token moves to the new identity and is reactivated.

**Mongo backend**
- The token is the document `_id` (`pkg/storage/mongostore/mongostore.go:421`).
- `RegisterDevice` runs `FindOneAndUpdate` filtered on `_id: d.FCMToken` (`:459-476`). It does `$set identityKey` plus deviceId, platform, active, updatedAt and lastUsed, and `$setOnInsert` only for createdAt and registrationId.
- The only secondary index is non-unique `{identityKey, updatedAt, active}` (`:98`).
- Same semantics as SQL by construction.
- I could not confirm which backend production runs. It does not matter, because both reassign.

**Interface contract**
- `pkg/storage/storage.go:106-109` states "RegisterDevice upserts on d.FCMToken, reactivating the device".

**Handler** (`pkg/handlers/devices.go:34-70`)
- The only validation is a non-empty `fcmToken` (`:41-44`) and an optional platform in {ios, android, web} (`:46-50`).
- It builds `NewDevice{IdentityKey, FCMToken, DeviceID, Platform}` (`:52-57`) and calls `Store.RegisterDevice` (`:58`).
- It never checks whether the token already belongs to another identity, never refuses, and never reports the takeover.

**Maintainers know this behaviour**
- `pkg/storage/mongostore/injection_test.go:184-185` says a structural token match "would land on the real device and hand it to another identity". That test guards against operator-injection payloads matching structurally, so a literal match reassigning ownership is the intended design.
- I found no conformance test that pins cross-identity re-registration either way. In `pkg/storage/storagetest/storagetest.go:1006-1008`, alice and bob always use distinct tokens. The behaviour follows from the SQL and Mongo code above.

**PR #22 (`fix/register-device-id`, merge `4179cd4`; feature commit `cd6c0a1`, test commit `b6a4621`)**
- It changed only the return value: `RegisterDevice` now returns an int64 registration id (`storage.go:106-110`; `queries.go:416-430` uses `RETURNING id`; Mongo adds a `registrationId` set only on insert, `mongostore.go:432, 473`).
- `/registerDevice` now returns that id as `deviceId`, and `/devices` returns it as `id`.
- The id is stable per token, so if B takes A's token, B receives the same id A had.
- It did not touch ownership semantics. The diff of `queries.go` shows the `ON CONFLICT(fcm_token)` upsert unchanged, plus `RETURNING id`.
- The upsert has been token-keyed since the original implementation (commits `33239d9` and `54251a1` via `git log -S`).

## 2. FCM delivery path

**Trigger**
- Only `pkg/handlers/send_message.go:281-292` calls `SendFCMNotification` (no other caller found by grep).
- After `InsertMessage` succeeds for each recipient, if `pushTitle(boxType)` is true it starts a detached goroutine calling `firebase.SendFCMNotification(writeCtx, s.Store, recipient, FCMPayload{Title, MessageID})`.

**Which boxes push** (`pkg/handlers/policy.go:34-43`)

| Box | Title |
|---|---|
| `notifications` | "New Message" |
| `payment_inbox`, `mandala-payments` | "Payment received" |
| anything else | no push |

**Token selection**
- `ListActiveDevices(ctx, recipient)` (`internal/firebase/send_fmc_notification.go:49-50`) selects by recipient identity: `WHERE identity_key = ? AND active = TRUE` (`queries.go:435-438`), or the Mongo equivalent filter (`mongostore.go:500-504`).
- It then sends one FCM message per active row (`send_fmc_notification.go:66-71`), so all active tokens for the recipient get a push.
- A token owned by another identity is invisible to this lookup, which is why a taken-over token stops receiving the loser's pushes.

**Exact payload** (`send_fmc_notification.go:118-156`)
- Notification title is the box title above. Body is the constant `"Open the app to view it."` (`:118`).
- Android: `Priority "high"` and `Data {messageId, originator}` (`:128-134`).
- iOS: `apns-push-type: alert`, `apns-priority: 10`, `MutableContent: true`, an alert with the same title and body, and custom data `{messageId, originator}` (`:136-153`).
- `Originator` is never set. The handler passes only `Title` and `MessageID` (`send_message.go:287-290`), so `originator` is always `""`.
- The payload carries no recipient identity key and no messageBox. Even with multi-row registration, the app could not tell from a push which profile it was for. It would have to look up the `messageId` in each profile's inbox. `listMessages` supports a `messageId` filter (`pkg/handlers/list_messages.go:60, 91, 103`), so that fan-out is possible, but it needs a session as each profile.

## 3. List, unregister, limits, cleanup

- **Routes** (`cmd/server/main.go:147-155`): only `POST /registerDevice` and `GET /devices` exist for devices. There is no unregister or delete endpoint (grep for unregister, deregister, DeleteDevice, RemoveDevice and `DELETE FROM device` found nothing outside tests).
- **`GET /devices`** (`devices.go:92-129`): lists only the caller's own rows (`identity_key = ?`). Tokens are masked to `"..." + last 10 chars` (`:102-105`), so a client cannot read its full token back.
- **After a takeover**: A's `/devices` no longer lists the token, but A's local "registered" marker (`push_registration_v1`) would still say it is registered.
- **Limits and dedupe**: I found no cap on devices per identity or per token, and no dedupe beyond the token-unique upsert.
- **Invalid-token cleanup** (`send_fmc_notification.go:77-89, 158-160`): if FCM returns Unregistered or InvalidArgument, the server calls `DeactivateDevice(token)`.
  - It is keyed by token only (`queries.go:487-491`; `mongostore.go:556-562`) and sets `active = FALSE`. It never deletes rows.
  - With one row per token, this deactivates the single current owner.
  - If the schema ever allowed several rows per token, this would deactivate all of them, which would be correct, since a dead token is dead for everyone.
  - Re-registering the token later sets `active = TRUE` again.
- **Per-send bookkeeping**: `UpdateDeviceLastUsed(token)` is also keyed by token only (`queries.go:477-483`).

## 4. Authentication

- The whole mux, including `/registerDevice` and `/devices`, is wrapped by `middleware.NewAuth(w).HTTPHandler(...)` (`cmd/server/main.go:163, 194-196`), with no options.
- `AllowUnauthenticated` defaults to false (`go-bsv-middleware@v0.16.0/pkg/internal/authentication/middleware.go:75`). A request with no auth headers is rejected (`request_handler.go:192-200`).
- The handler's identity is the BRC-104 authenticated peer identity (`request_handler.go:105` puts it in the context; `pkg/handlers/helpers.go:127-133` reads it via `ShouldGetAuthenticatedIdentity` and returns `""`, giving a 401, if absent). The body cannot override it.
- Uncertainty: I did not trace the go-sdk `auth.Peer` signature verification. The middleware only calls the next handler if peer processing succeeds (`request_handler.go:111-123`).
- Consequence: registering for profile n needs a BRC-104 session signed by profile n's key, so that profile's wallet must be built.
- **No token-ownership proof**: any authenticated identity can claim any token string. If it knows or guesses another identity's token, it can take that identity's pushes (see the injection-test comment above). The server does not validate the token with FCM at registration.

## 5. What would be needed for multi-identity pushes

These are conclusions about changes, not existing code.

**Server side**
- Replace `UNIQUE(fcm_token)` with `UNIQUE(identity_key, fcm_token)` and key the upsert on that pair in both SQL and Mongo. Mongo's `_id` is currently the token alone.
- Add the recipient identity key (and ideally the messageBox) to the FCM data payload (`buildMessage`) so the app can route a push to the right profile.

**Client side, with no server change**
- Keep the single-slot registration and re-register on every profile switch. That takes the token back for the active profile, but pushes then reach only the active profile.
- Registering all profiles in a loop would leave only the last one registered.
- Also, an app that only builds the active profile's wallet cannot open a session as the other profiles to register them.