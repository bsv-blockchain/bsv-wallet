# BLE Reversed Role: iOS Is Always the Central in Cross-OS Pairs — Design

**Date:** 2026-09-03
**Status:** approved by the product owner in conversation, 2026-09-03
**Amends:** `2026-09-02-ble-transport-and-qr-caps-design.md` (§2 profile roles, §3 message table, §4 capability bits, §5 ladder, §6 multi-listener, "Verified facts", "Deferred")

## Summary

Android (payer, GATT central) → iOS (payee, GATT peripheral) over `bsvpay-ble/1` fails on real hardware, and the failure is below both apps: the Android controller's link-layer procedure instants are applied by the iPhone controller seconds to minutes late, during which no ATT traffic crosses the link. iOS → Android works because iOS, as central, chooses the instants. The fix keeps the profile's messages byte-identical and swaps the GATT roles for that one pairing: the iOS payee scans and connects, the Android payer advertises and serves GATT. A new rung bit in the session QR tells the payer to do so.

## Evidence (2026-09-03, OSCAL TIGER 13 / Unisoc UMS9620 / Android 14 → iPhone 15 Pro / iOS 26.6.1)

Two runs, identical signature. Logs: Android `adb logcat -v threadtime` (`HybridLocalPayBleTransportSpec`, `bt_bta_gattc`, `BluetoothGatt`), iPhone `idevicesyslog -u <iPhone UDID>` (`BSVWallet`, `bluetoothd`).

- App layers correct on both sides: iOS minted `caps=0x3f05`, Android selected `'ble'`, scanned (hit at 142 ms), connected (722 ms), discovered, subscribed to ACK (5.5 s), wrote HELLO_A.
- Android's stack sent the HELLO_A Write Request (`gatt_clcb_invalidate: Invalidating clcb ... for already sent request` at teardown) and never received any ATT response (GattService never logged its write-permit release).
- iPhone `bluetoothd` forwarded exactly one XPC message to the wallet's peripheral session after the connect — the subscription. No write ever reached CoreBluetooth; the app's `didReceiveWrite` never fired.
- Link stayed up: no supervision timeout on either side in 30 s. Android's connection-parameter updates (the stack's 7.5 ms discovery boost, then the post-discovery restore) were reported complete on Android at +0.6 s and +4.8 s, and applied by the iPhone controller at +4.4 s and **+86 s** (run 1), +0.6 s and **+10.5 s** (run 2). The PHY update was logged on the iPhone as `Phy update returned status STATUS 42` (HCI 0x2A, Instant Passed) in both runs. Android's service discovery stalled for exactly the desync windows.
- Mitigations that cannot work from the app: the 7.5 ms boost and the restore are unconditional in Android's GATT client stack (`L2CA_EnableUpdateBleConnParams` around discovery); no `requestConnectionPriority` constant on this stack equals 7.5 ms (HIGH 9–12, BALANCED 24–40, DCK 24–24 units), so the post-discovery LL update is unavoidable; connecting with `PHY_LE_1M_MASK` did not stop the PHY-update "Instant Passed". Both tried; both failed with the same signature.
- Colleagues report the same Android → iOS failure from Samsung and Pixel payers. Their builds predate the 6 s → 15 s connect-budget widening (`ff3179b`), so their symptom may partly be the old budget expiring during the stalled discovery; unverified. The reversed role removes the dependency on the Android controller's instants either way.

## Non-goals

- Fixing Android-central ↔ iOS-peripheral. It stays in the code for Android-central ↔ Android-peripheral (the Android ↔ Android BLE fallback below Nearby), unchanged apart from the late-MTU adoption below.
- A second characteristic pair, a new service UUID, or any change to message bytes. `BleGattProfileTest`'s vectors remain the profile's pin.
- iOS payer advertising (iOS ↔ iOS BLE fallback). The Swift `sendFrameAdvertising` is implemented for symmetry but is not on the hardware checklist.
- Background scanning or advertising on either platform.

## Design

### 1. Capability bit and selection

`core/localpay/session.ts`:

```ts
export const CAP_BLE      = 0x04 // payee is advertising bsvpay-ble/1 (peripheral)
export const CAP_BLE_SCAN = 0x08 // payee is ALSO scanning for a payer advertising this session's service UUID (central)
// 0x10..0x80 reserved for future rungs (L2CAP, NFC, Wi-Fi Aware).
```

- `mintSession` gains `supportsBleScan?: boolean`. The bit is ORed in only when `supportsBle` is also true, so `0x08` can never appear without `0x04` — a scanner with no advertiser behind it would strand iOS payers.
- The payee sets `supportsBleScan = bleLive && Platform.OS === 'ios'`. Android payees never scan: Android-central is the broken role.
- `selectTransport` is unchanged; `'ble'` is still selected on `CAP_BLE`. New pure helper in `transport/select.ts`:

```ts
export type BleRole = 'central' | 'peripheral'
/** Which GATT role THIS device takes as payer. Peripheral only when the payee scans and this device is Android. */
export function bleRole(session: Session): BleRole {
  return (session.caps & CAP_BLE_SCAN) !== 0 && Platform.OS === 'android' ? 'peripheral' : 'central'
}
```

`Platform.OS === 'android'` here is a local-ability check in the same spirit as `localSupportsNearby()` — "this device's central role is not trusted against a scanner" — not a read of the peer's OS. `session.os` stays metadata. `describeFloor` is untouched: BLE is still selected, so no new floor copy.

Compatibility: decoders ignore unknown bits. An old Android payer against a new iOS payee still takes the Android-central path and falls to the fountain exactly as today. No builds with BLE are in the field.

### 2. Profile roles, restated

GATT mechanics do not change: the service UUID derivation, the FRAME characteristic (write, writeWithoutResponse; central → peripheral) and the ACK characteristic (indicate; peripheral → central) are as in the 09-02 spec §2. What changes is who is payer and who is payee behind those roles, and therefore who speaks first once the central has subscribed:

| Mode | Central | Peripheral | First message after subscribe |
|---|---|---|---|
| Standard (09-02 spec) | payer | payee | central writes `HELLO_A` |
| Reversed (this spec) | payee | payer | peripheral indicates `HELLO_A` |

Message bytes, HMAC domains and the ack MAC are identical in both modes (`HELLO_A 0x01` is always the payer's proof, `HELLO_B 0x02` always the payee's, `FRAME 0x03` always payer → payee, `ACK 0x04` always payee → payer). Only the GATT primitive carrying each message flips:

| Message | Standard | Reversed |
|---|---|---|
| `HELLO_A` | central write → FRAME char | peripheral indication ← ACK char |
| `HELLO_B` | peripheral indication ← ACK char | central write → FRAME char |
| `FRAME` | central writes without response → FRAME char | peripheral indications ← ACK char |
| `ACK` | peripheral indication ← ACK char | central write **with response** → FRAME char |

Chunking is unchanged: `[u32 BE length][message]`, cut to `ATT_MTU − 3` (`maxUpdateValueLength` / `maximumWriteValueLength` on iOS, `mtu − 3` on Android), reassembled by the existing `Reassembler` on the receiving side.

### 3. Native surface

Two methods are added to `LocalPayBleTransport.nitro.ts`; the existing four are untouched, so `LocalPayNative` (the Pick shared with the AWDL/Nearby object) is unaffected.

```ts
/**
 * Reversed-role payee: scan for a payer advertising this session's service UUID,
 * connect, subscribe, verify HELLO_A, write HELLO_B, receive FRAME. Runs alongside
 * startListening() on the same object; one hasAccepted latch covers both, and the
 * loser is torn down the instant a FRAME is accepted on either. confirmFrame() and
 * stopListening() are unchanged and act on whichever link holds the frame.
 * Rejects only if scanning cannot start; a scan that never hits is not an error.
 */
startScanning(instanceName: string, pskBase64: string, onFrame: (frameBase64: string) => void, onError: (message: string) => void): Promise<void>
/**
 * Reversed-role payer: advertise this session's service UUID and serve GATT; when a
 * central subscribes, indicate HELLO_A, expect HELLO_B, indicate FRAME, resolve with
 * the bare ackJson of a MAC-verified ACK write. Same budgets and rejection strings
 * as sendFrame(): "connect timeout: no route to peer" if no central has subscribed
 * within connectTimeoutMs, "timed out waiting for peer" at timeoutMs.
 */
sendFrameAdvertising(instanceName: string, pskBase64: string, frameBase64: string, timeoutMs: number, connectTimeoutMs: number): Promise<string>
```

Both platforms implement both. Nitrogen is regenerated for iOS and Android.

### 4. Android payer as peripheral (`sendFrameAdvertising`, Kotlin)

Reuses the existing payee GATT-server code (service add, advertising, `notifyChunk` with `onNotificationSent` backpressure, `Reassembler` per central, idle reaper) under a role flag; the payee (`startListening`) and payer (`sendFrameAdvertising`) never run at once on one device, so the single GATT server is shared without contention.

1. Decode psk/frame; refuse `sealed.size + 1 > MAX_BLE_FRAME_BYTES` (fountain has no ceiling below 64 KiB); refuse if radio off or grants missing (`"bluetooth unavailable"`). Requires `BLUETOOTH_ADVERTISE`; the payer's lazy `requestBlePermissions()` already asks for it.
2. Derive service UUID, add service, start advertising. Arm `connectTimer` (`connectTimeoutMs`) → `"connect timeout: no route to peer"` unless a central has subscribed to ACK. Arm `wholeTimer` (`timeoutMs`) → `"timed out waiting for peer"`.
3. On central connect: track it, arm its 30 s idle reaper, record `mtu` from `onMtuChanged` (default 23). Accept any number of connecting centrals until one is bound.
4. On CCCD write enabling indications from central C: if no central is bound yet, indicate `HELLO_A` to C (chunked at `mtu − 3`). Clear `connectTimer`.
5. On FRAME-char write from C: reassemble; `HELLO_B` → verify proof; wrong → drop C silently, keep advertising; right → bind C (`boundDevice`), stop advertising, indicate `FRAME` chunks. Once the last chunk's `onNotificationSent` succeeds, set `frameOnWire`.
6. On FRAME-char write from the bound central after `frameOnWire`: `ACK` → `verifyAck`; bad MAC → reject `"peer failed the session proof"`; good → respond to the write **before** resolving, resolve with base64(ackJson), tear down (stop advertising if still on, disconnect, remove service). Any other message after `frameOnWire` is logged and ignored (the payee may already have queued the payment). A write from an unbound central after binding is answered `GATT_INSUFFICIENT_AUTHORIZATION`.
7. Disconnect of the bound central before ACK → `"peer disconnected before acking"` (only a bad MAC or a timeout may reject once `frameOnWire`; a disconnect is treated as a timeout-class failure, and JS falls to the fountain without aborting the build, exactly as for `sendFrame`).
8. Every terminal failure logs `payer: send failed reason=<message>`; every chunk logs submit and completion, matching the central path's logging added 2026-09-03.

### 5. iOS payee as central (`startScanning`, Swift)

Reuses `OutboundSend`'s scan → connect → discover → subscribe chain, generalised into a `CentralLink` used by both `sendFrame` (payer) and the new `InboundScan` (payee), with the reversed handshake:

1. `startScanning` requires managers (`ensureManagers`, already created by `prepare()` at minting). Scan with `CBCentralManagerScanOptionAllowDuplicatesKey = false` for the session UUID; resolve the promise when scanning is on. Rejects only with `"bluetooth unavailable"` when the central manager is not powered on.
2. On discovery: stop scanning, connect, discover the session service and its two characteristics, subscribe to ACK. Per-connection 30 s idle reaper; a stranger that never sends `HELLO_A` is disconnected and scanning resumes.
3. `HELLO_A` indication: verify proof; bad → disconnect, resume scanning; good → write `HELLO_B` with response.
4. `FRAME` indications: reassemble; on a complete `FRAME`: shared `hasAccepted` latch with the peripheral listener — if already accepted (an iOS payer got there first over the advertised service), disconnect this payer without an ack (it times out to its fountain, where JS answers `already_paid`); otherwise `hasAccepted = true`, stop advertising **and** scanning, set `pendingAck` to this link, arm the 60 s ack reaper, `onFrame(base64(sealed))`.
5. `confirmFrame(accepted, reason)`: if `pendingAck` is a scan link, write `ackMessage` chunks to the FRAME char with response (≤ `maximumWriteValueLength(for: .withResponse)`), resolve on the last `didWriteValueFor` success, then disconnect. A disconnect or write error before that rejects `"peer disconnected before acking"` — the payer keeps its inputs locked (safe failure). If `pendingAck` is a peripheral-side central, behaviour is exactly the 09-02 spec.
6. `stopListening` / `resetListening` also cancel scanning and drop any scan link. JS never calls it on the success path (existing `teardown` discipline).
7. The symmetric implementations — Kotlin `startScanning` and Swift `sendFrameAdvertising` — follow the same state machines with the platforms' existing primitives. They compile and are unit-covered where pure, but are not on this checklist's hardware rows.

### 6. JS wrapper and NearbyFlow

- `transport/ble.ts` builds the BLE transport from a small adapter over `makeSocketTransport`'s pieces rather than the plain call: `receive()` starts `startListening` and, on iOS, `startScanning`, through one `ReceivedFrame` promise and one `makeConfirm` handle. A `startScanning` rejection alone is logged (`console.warn('[localpay] ble scan unavailable:')`) and is not terminal — advertising still serves iOS payers. `startListening` rejecting is terminal as today. `send()` calls `sendFrameAdvertising` when `bleRole(session) === 'peripheral'`, else `sendFrame`; same `SEND_TIMEOUT_MS` and `BLE_CONNECT_TIMEOUT_MS`.
- `NearbyFlow` mint: `supportsBleScan: bleLive && Platform.OS === 'ios'`. No UI change; presence medium remains `'bluetooth'`.
- `raceReceivers` unchanged: still one `'ble'` entry.

### 7. Money-safety invariants (restated for the new roles)

- The payer resolves `send()` only on a MAC-verified `ACK`; `{"ok":true}` still means the payee durably queued the payment, and JS's `finalizeDelivery` is unchanged.
- The payee writes `confirmFrame(true)` only after its durable write (JS discipline unchanged). Because the reversed ACK is a write with response, the payee learns whether the payer received it; a failed ACK write rejects `confirmFrame` so the payer's inputs stay locked.
- First-success-wins is one native latch per payee object, shared by the advertised and scanned links.
- After `FRAME` is on the wire the payer rejects only on bad ACK MAC or timeout.
- Nothing here changes `pending.ts`, `settleReceived`, or the fountain.

### 8. Housekeeping shipped with this change

- Kotlin central: adopt a late `onMtuChanged` (Android 14 queues the app's MTU request behind its connect-time auto-discovery) instead of dropping it; per-chunk write logging; `onPhyUpdate` logging. Already in the working tree 2026-09-03.
- Remove the two temporary `[localpay][diag]` `console.log` lines from `NearbyFlow.tsx`.
- `docs/superpowers/2026-09-02-ble-hardware-log.md`: record today's two Android → iOS failures with the desync timestamps, and add rows for the reversed role.

## Testing

- Jest: `session.test.ts` — `CAP_BLE_SCAN` round-trips; `mintSession({ supportsBle: false, supportsBleScan: true })` mints neither bit. `transportSelect.test.ts` — `bleRole` table: `[CAP_BLE|CAP_BLE_SCAN, android] → 'peripheral'`, `[CAP_BLE|CAP_BLE_SCAN, ios] → 'central'`, `[CAP_BLE, android] → 'central'`, `[CAP_BLE_SCAN only] → selectTransport 'qr'`. `transportBle.test.ts` — `receive()` starts both listeners on iOS and one on Android; a rejecting `startScanning` does not reject `receive()`; `send()` dispatches by role; the confirm handle is shared and single-shot.
- JUnit `BleGattProfileTest`: one new vector asserting `verifyAck` accepts the Swift-built ACK bytes unchanged (payer-side verification now runs on Android).
- Swift pod target and Kotlin module compile; nitrogen output committed.
- Hardware (append to the 09-02 hardware log): Android (payer) → iOS (payee) reversed, run first, expected `ok` with `payer: advertising`, `payer: central subscribed`, `payer: HELLO_B verified`, `payer: frame indicated`, `payer: ack verified` on Android and `scan hit`, `subscribed`, `hello verified`, `frame accepted`, `ack written` on iOS; iOS → Android standard regression; second payer refused; payee locked mid-wait (iOS scanning in background still finds Android adverts — record what happens).

## Rollout order (for the plan)

1. `session.ts` bit + `bleRole` + tests.
2. Nitro spec + nitrogen.
3. Kotlin `sendFrameAdvertising` (payer peripheral) + `startScanning` (symmetric).
4. Swift `startScanning` (payee central) + `sendFrameAdvertising` (symmetric).
5. `ble.ts` adapter + `NearbyFlow` mint + tests.
6. Diag removal, hardware log, spec cross-references; device run Android → iOS.

## Deferred

- iOS ↔ iOS BLE fallback via iOS payer advertising (needs the payee's scan to also accept an iOS payer; the code exists after this change, the ladder does not use it).
- Telling the payer's confirm screen that the reversed role is in use (no copy needed today).
- HCI snoop capture on the TIGER 13 to see the host → controller handoff (developer option; only adds certainty, the decision does not depend on it).
