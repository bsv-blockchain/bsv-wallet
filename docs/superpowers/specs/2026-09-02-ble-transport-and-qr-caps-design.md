# BLE Transport Rung and Session QR Capability Flags — Design

**Date:** 2026-09-02
**Status:** Implemented (plan 2026-09-02-ble-transport-and-qr-caps.md) — hardware checklist and ITMS-90683 pre-flight pending (see docs/superpowers/2026-09-02-ble-hardware-log.md)
**Amends:** `2026-07-27-local-payments-awdl-design.md` (§"Why not BLE", "Bluetooth, in any form" non-goal), `2026-07-29-offline-transport-fixes-design.md:427`, `2026-07-31-token-payment-frame-v3-design.md` (§3 `CAP_BLE`), `docs/superpowers/plans/2026-07-27-local-payments-awdl.md:16`, `docs/superpowers/2026-08-20-morning-handoff.md:16,21`
**Amended by:** `2026-09-03-ble-reversed-role-design.md` (§2 roles, §3 message carriers, §4 `CAP_BLE_SCAN 0x08`, §6 payee dual listener) — Android as central against an iOS peripheral fails below the app; iOS is always the central in cross-OS pairs.
**Research:** eleven-agent sweep of `5fc72a7` (last BLE commit), HEAD `0ad5521`, and the 2026 RN BLE landscape; 15 load-bearing claims re-verified by an independent pass.

## Summary

Three deliverables, one flow:

1. **BLE becomes the third radio rung** behind the existing `LocalPaymentTransport` interface. It is implemented as a second native HybridObject, `LocalPayBleTransport`, inside `packages/react-native-localpay-transport`, with the same method shape as the AWDL/Nearby spec, so the JS wrapper in `core/localpay/transport/socket.ts` is reused unchanged in structure. BLE is the only radio that works iOS↔Android; today every cross-OS payment is a one-way animated-QR fountain with no ack.
2. **The payee's session QR (`bsvpay1:`) carries device-hint bits** in the existing integer `c`: internet reachable, any connectivity, Wi-Fi, Bluetooth, NFC. The payer's ladder still reads only the rung bits; the hint bits drive one line of copy on the payer's confirm screen explaining *why* the pair is on the fountain floor, and are available to future rungs. Zero bytes are added for BLE pairing itself.
3. **The QR is the BLE pairing step.** The BLE service UUID is derived from the session's PSK and instance name, so the payer scan-filters to exactly one advertiser. No counterparty list, no picking, no bonding prompt.

## Why now

BLE was removed in `ed454e9` (2026-04-21). The blocker, confirmed empirically on 2026-07-27, was that `com.apple.developer.web-browser` prohibits `NSBluetoothAlwaysUsageDescription` while ITMS-90683 demands that key whenever CoreBluetooth is linked. The web-browser entitlement, its config plugin and the http/https URL types were removed in `de13669`/`1dc1d92` (2026-08-26, wallet-first pivot). `git grep web-browser HEAD -- ios app.json plugins eas.json package.json` is empty. The plist key can now be set. Task 0 of the plan proves this with a TestFlight upload before any UI work, because ITMS-90683 fires at Deliver, not at Transporter Verify.

## Verified facts this design is built on

- `LocalPaymentTransport { readonly kind: 'awdl'|'nearby'|'qr'; receive(session, signal): Promise<ReceivedFrame>; send(session, frame, signal): Promise<Ack> }` — `core/localpay/types.ts:63-67`. `qrTransport` is a stub that rejects `QrHandoffRequired`; the QR rung is driven inside `NearbyFlow` (`core/localpay/qr.ts:8-16`).
- Both radios are `makeSocketTransport(kind)` over one cached `getLocalPayTransport()` HybridObject; `kind` is attribution, not dispatch (`core/localpay/transport/socket.ts:92-108`). Connect budgets 4 s AWDL / 10 s Nearby, whole-send 20 s (`socket.ts:13,108`). `receive()` deliberately does not `stopListening()` on success because the native side is holding the ack connection (`socket.ts:120-135`).
- Nitro spec: `isSupported()`, `startListening(instanceName, pskBase64, onFrame, onError)`, `stopListening()`, `confirmFrame(accepted, reason)`, `sendFrame(instanceName, pskBase64, frameBase64, timeoutMs, connectTimeoutMs)` (`packages/react-native-localpay-transport/src/specs/LocalPayTransport.nitro.ts:3-49`).
- Swift AWDL backend: serial `DispatchQueue` confinement, `hasAccepted` first-success-wins latch set before the ack, held `pendingAck` connection, 30 s accepted-read reaper, 60 s pending-ack reaper that tears down silently and never synthesises a negative ack (`ios/HybridLocalPayTransport.swift:22-64,225-267`).
- Kotlin Nearby backend: type-byte protocol `HELLO_A 0x01 / HELLO_B 0x02 / FRAME 0x03 / ACK 0x04`, `HMAC-SHA256(psk, instanceName ‖ roleByte)` proof each way, `boundEndpoint` set only after a verified HELLO_A, `MAX_BYTES_PAYLOAD = 32768`, idle 30 s, pending-ack 60 s (`android/.../HybridLocalPayTransport.kt:83-91,213-266,567-576`).
- Session: `CAP_AWDL 0x01`, `CAP_NEARBY 0x02`, `CAP_BLE 0x04` ("allocated for BLE transports (e.g. Blitz); this app never advertises it"), `sessionId = Random(16)`, `psk = Random(32)`, `instanceName(sessionId) = 'bsvpay-' + base32` (`core/localpay/session.ts:4-7,81-83,210-227`). Encoded as `'bsvpay1:' + base64url(JSON{v,c,s,k,i,o?,a?,t?,p,x})`; decoder tolerates unknown `c` bits and unknown keys (`session.ts:117-208`).
- `selectTransport`: AWDL if `caps & CAP_AWDL && localSupportsAwdl()`, else Nearby if `caps & CAP_NEARBY && localSupportsNearby()`, else QR (`core/localpay/transport/select.ts:38-42`). Cross-OS pairs land on QR by construction (`__tests__/localpay/transportSelect.test.ts:46-57`).
- Every rung carries **sealed** bytes: `[0x01] ‖ AES-256-GCM(psk)(encodeFrame(f))`, 49 B overhead (`core/localpay/codec.ts:207-243`). An unsealed frame is declined `decode_failed` (`socket.ts:152-166`).
- Real session QR size with two 64-char `createNonce` values: open 428 chars, amount 447, token 736 → QR v16-M / v16-M / v22-M at 288 px. `__tests__/localpay/session.test.ts:57-59` uses 2-char fixture nonces and asserts `< 300`; it understates by ~150 chars.
- Payee UI: one `radioTransport` (`supportsAwdl ? awdl : nearbyReady ? nearby : null`, `NearbyFlow.tsx:520-523`); listener effect at `:911-947`; `mintSession` at `:976-986`; settle order verify → nonce bind → `isSessionSpent` → `savePending(kind)` → `markSessionSpent` → `confirm(true)` (`:668-862`). Payer: `executeSend` radio failure falls through to the fountain without aborting; an explicit decline aborts and never offers the fountain (`:1203-1265`).
- Old BLE (`5fc72a7`): service `B5A1E000-7374-4F6E-8E2D-425356504159` (suffix = ASCII "BSVPAY"), chars `E001` write / `E002` notify (never used) / `E003` identity read (`utils/ble/constants.ts:11-20`). No ack was ever transmitted; sender declared "complete" 500 ms after the last write. No link encryption. JSON `number[]` BEEF. Android sender fixed at 17 B chunks after an auto-`requestMtu` deadlock against an iOS peripheral. iOS→Android proven; Android→iOS fixed but never confirmed. Nothing from its wire format is reused.
- Platform: iOS has no public Wi-Fi radio-power API and no Local Network permission API; instantiating any `CB*Manager` while authorization is `notDetermined` shows the privacy prompt; `CBManager.authorization` is a sync, prompt-free class property. Android `BluetoothAdapter.isEnabled()` is sync and prompt-free. iOS advertises at most `LocalName` + `ServiceUUIDs` and drops manufacturer data; a backgrounded iOS peripheral moves its UUIDs to the overflow area, invisible to Android centrals.

## Non-goals

- **L2CAP CoC.** GATT with `[length][payload]` streaming is enough for the ≤ 32 KiB frames this rung accepts. Revisit if hardware timings disappoint.
- **Background BLE.** No `UIBackgroundModes`. Foreground only: no Review 2.5.4 exposure, and Android can see us.
- **NFC as a transport.** iPhone cannot emulate a card outside the EEA-only HCE entitlement. `HINT_NFC` is advisory only.
- **Session TTL / PSK-in-QR mitigation.** Cross-rung concern, unchanged from AWDL/Nearby (noted-not-mitigated, `codec.ts:215-217`). Recorded under Deferred.
- **Wire compatibility with the `5fc72a7` BLE build.** No such build is in the field.
- **Reviving `app/local-payments.tsx`, `useBLETransfer.ts`, `chunking.ts`, the munim patch, or any third-party BLE library.** The backend is first-party CoreBluetooth / `android.bluetooth`.
- **The reply to Blitz.** Stays a deferred todo from the v3 spec; this document is what that reply will point at for the BLE profile.

## Design

### 1. Placement: a second HybridObject behind the same wrapper

`packages/react-native-localpay-transport` gains `LocalPayBleTransport`, registered alongside `LocalPayTransport` in `nitro.json` autolinking. Nitrogen's generated `registerAllNatives()` covers both; `cpp-adapter.cpp` and `LocalPayTransportPackage.kt` need no change beyond regeneration. The podspec adds `CoreBluetooth` to `s.frameworks` and the two new Swift files to `source_files`.

```ts
// packages/react-native-localpay-transport/src/specs/LocalPayBleTransport.nitro.ts
export interface LocalPayBleTransport extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /** Hardware present and not denied. Prompt-free. `notDetermined` counts as supported. */
  isSupported(): boolean
  /** 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown'. Prompt-free. */
  bluetoothState(): string
  /** NFC reader hardware available and enabled. Prompt-free. */
  nfcAvailable(): boolean
  /**
   * Instantiate the peripheral and central managers and resolve their state.
   * THE ONE CALL THAT MAY SHOW THE iOS BLUETOOTH PROMPT. Resolves the same
   * string as bluetoothState() once the managers settle or timeoutMs elapses.
   */
  prepare(timeoutMs: number): Promise<string>
  startListening(instanceName: string, pskBase64: string,
                 onFrame: (frameBase64: string) => void, onError: (message: string) => void): Promise<void>
  stopListening(): Promise<void>
  confirmFrame(accepted: boolean, reason: string): Promise<void>
  sendFrame(instanceName: string, pskBase64: string, frameBase64: string,
            timeoutMs: number, connectTimeoutMs: number): Promise<string>
}
```

The four transport methods have signatures identical to the AWDL spec so that JS treats both objects through one structural type:

```ts
// core/localpay/transport/socket.ts
export type LocalPayNative = Pick<LocalPayTransport,
  'startListening' | 'stopListening' | 'confirmFrame' | 'sendFrame'>

export function makeSocketTransport(
  kind: 'awdl' | 'nearby' | 'ble',
  native: () => LocalPayNative | null,
  connectTimeoutMs: number
): LocalPaymentTransport
```

`awdl.ts` / `nearby.ts` pass `getLocalPayTransport` with 4 000 / 10 000. New `transport/ble.ts`:

```ts
export const BLE_CONNECT_TIMEOUT_MS = 6_000   // scan + connect + MTU + discovery
export const bleTransport = makeSocketTransport('ble', getLocalPayBleTransport, BLE_CONNECT_TIMEOUT_MS)
```

`getLocalPayBleTransport()` in `RNLT/src/index.ts` mirrors `getLocalPayTransport()`: one cached `createHybridObject('LocalPayBleTransport')`, `null` on any throw. Because a `null` here silently floors to QR (the same masking that hid two shipped bugs, `84cd96e`, `0c75467`), the accessor logs once at `console.warn` in `__DEV__` when it swallows an error.

`kind` gains `'ble'` in `core/localpay/types.ts:64`, `TransportKind` in `select.ts:5`, and the `receivedVia` comment in `core/localpay/pending.ts:26`. `core/index.ts` additionally exports `bleTransport`, `localSupportsBle`, `requestBlePermissions`, `probeDeviceCaps`, `capsFromProbe`, `describeFloor`, and the types `LocalPaymentTransport`, `ReceivedFrame`, `QrHandoffRequired`, `AckError` (today only `type Ack` is exported, `core/index.ts:61`).

### 2. GATT profile `bsvpay-ble/1`

This is the reference profile a Blitz build would adopt to interoperate on the `CAP_BLE` bit.

```
service UUID   = HMAC-SHA256(psk, "bsvpay-ble-svc" ‖ utf8(instanceName))[0..16]
                 with RFC-4122 version nibble set to 4 and variant bits to 10
FRAME  char    B5A1E001-7374-4F6E-8E2D-425356504159   properties: write, writeWithoutResponse   central → peripheral
ACK    char    B5A1E002-7374-4F6E-8E2D-425356504159   properties: indicate                      peripheral → central
advertisement  serviceUUIDs: [service UUID]; localName: "BSV Pay" (advisory; iOS may drop it to fit 31 bytes)
```

- **Per-session random service UUID is the pairing mechanism.** Only a device that read the QR (and therefore holds `psk`) can compute the UUID, so the payer's scan filter matches exactly one advertiser and the payer connects to the first hit. HMAC rather than raw `sessionId` so a sniffed advertisement reveals nothing about the QR. Both ends force the RFC-4122 bits identically; Android `ScanFilter.setServiceUuid` requires an exact 128-bit match. Native derives the UUID from the `instanceName` and `pskBase64` it already receives.
- **No identity characteristic.** Identity is in the QR; the frame carries `senderIdentityKey`. The old `E003` is retired.
- **Characteristic UUIDs are fixed; only the service UUID is per-session.** Discovery by the central is therefore a single `discoverServices([sessionUuid])` followed by `discoverCharacteristics([E001, E002])`.

### 3. Messages: the Nearby protocol, plus an authenticated ack

BLE GATT without bonding has no link security, and cross-platform bonding prompts are a UX dead end, so the link is authenticated at the message layer exactly as the Kotlin Nearby backend does. Every message is one of:

| Type | Direction | Body | Authenticates |
|---|---|---|---|
| `HELLO_A 0x01` | central → peripheral, FRAME char | `HMAC-SHA256(psk, utf8(instanceName) ‖ 0x01)` | payer holds the PSK |
| `HELLO_B 0x02` | peripheral → central, ACK char | `HMAC-SHA256(psk, utf8(instanceName) ‖ 0x02)` | payee holds the PSK |
| `FRAME 0x03` | central → peripheral, FRAME char | sealed frame (AES-256-GCM under psk, `codec.ts:219-243`) | self-authenticating |
| `ACK 0x04` | peripheral → central, ACK char | `ackJson ‖ HMAC-SHA256(psk, utf8(instanceName) ‖ 0x04 ‖ ackJson)` | ack came from the PSK holder |

`ackJson` is byte-identical to AWDL/Nearby: `{"ok":true}` or `{"ok":false,"error":<reason>}` with `reason` JSON-serialized, never interpolated (Swift `declineJson`, Kotlin `jsonString`). The payer's native side verifies the HMAC in constant time, strips it, and returns `base64(ackJson)` to JS, so `parseAck` in `socket.ts:30-48` is unchanged.

**Why the ack needs an HMAC here and not on Nearby:** Nearby encrypts the link and HELLO binds the endpoint; AWDL uses TLS-PSK. On bare GATT, an attacker who passively sniffed the advertisement could advertise the same UUID, win the payer's scan, receive the sealed frame it cannot open, and return a forged `{"ok":true}`. The payer would broadcast while the real payee queued nothing. With the HMAC, a forged ack is an `AckError` at the transport layer → the existing radio-failure path → fountain QR. The same attacker connecting to the real payee and writing garbage is refused before HELLO (below), so it cannot consume the payee's listener either.

**Framing on both characteristics.** Every message is sent as `[u32 BE length][type ‖ body]`, split into chunks of `min(ATT_MTU − 3, 512)` bytes, reassembled by length. Writes on one connection are ordered and reliable; indications are ATT-acknowledged and ordered. There is no sequence number, CRC or metadata chunk: the old `chunking.ts` framing solved a problem GATT does not have, and AES-GCM already authenticates the payload. Length limit: `type ‖ body` ≤ 32 768 bytes (`MAX_BLE_FRAME_BYTES`, same ceiling as Nearby's `MAX_BYTES_PAYLOAD`); the payer's native side rejects a larger sealed frame with "frame too large for a BLE payload" so JS falls back to the fountain, which has no ceiling below 64 KiB.

**Correction, 2026-09-03 (reversed-role hardware run):** `ATT_MTU − 3` alone is not a safe chunk ceiling — Android's native Bluetooth stack (`bt_stack: BTA_GATTS_HandleValueIndication`) hard-rejects `notifyCharacteristicChanged`/indication payloads over 512 bytes regardless of the negotiated MTU, independent of any ATT-level limit. This was never hit before this amendment's reversed role, because in the standard direction here the peripheral only ever indicates small payloads (HELLO_B's proof, the ACK json) — never the multi-chunk FRAME. `BleGattProfile.chunkSize`/`chunks` on both platforms now clamp every chunk (not only indications) at `min(ATT_MTU − 3, 512)` for one uniform, defensive ceiling.

**Peripheral state machine (payee).**

1. `prepare(timeoutMs)`: create `CBPeripheralManager` + `CBCentralManager` (iOS) / obtain `BluetoothAdapter`, `BluetoothLeAdvertiser`, open `BluetoothGattServer` (Android). Resolve state when both report powered on, or on timeout. Idempotent.
2. `startListening(instanceName, pskBase64, onFrame, onError)`: self-reset (mirrors Swift `startListening` lines 126-134: cancel advert, drop connections, clear reapers, `hasAccepted = false`, `boundCentral = nil`). Derive service UUID. Add service with FRAME + ACK characteristics. Start advertising. Resolve once the OS confirms advertising (`peripheralManagerDidStartAdvertising` / `AdvertiseCallback.onStartSuccess`); reject on failure.
3. On central connect / first write: accept freely. Arm a 30 s idle reaper per connected central (`IDLE_CONNECTION_TIMEOUT_MS`), silent, disconnects a central that never completes HELLO — a stranger cannot kill a live request.
4. Reassemble on FRAME char. On `HELLO_A`: verify HMAC; on failure disconnect that central silently and keep advertising; on success set `boundCentral`, send `HELLO_B` as an indication.
5. On `FRAME`: drop unless from `boundCentral`; drop if `hasAccepted` (first-success-wins, second PSK-holder refused outright). Else `hasAccepted = true`, stop advertising, `pendingAckCentral = central`, arm the 60 s ack reaper, invoke `onFrame(base64(sealed))`.
6. `confirmFrame(accepted, reason)`: cancel the ack reaper; if no `pendingAckCentral`, resolve (idempotent). Else build `ACK`, HMAC it, send as an indication in chunks, then disconnect and tear the session down (remove service, drop other centrals). Reject only if the indication could not be queued or the central disconnected mid-ack.
7. Ack reaper expiry: disconnect silently, `onError("payee never confirmed the payment; connection released")`, never a synthesised negative ack — same reasoning as Swift lines 50-64.
8. `stopListening()`: stop advertising, remove service, disconnect every central, clear all reapers and latches. JS never calls this on the success path (existing `teardown` flag discipline in `socket.ts`).

All peripheral state is confined to one serial `DispatchQueue` (iOS, delegate callbacks dispatched to it) / the main `Handler` (Android, where `BluetoothGattServerCallback` arrives on a binder thread and is hopped onto main), the same discipline as the two shipped backends.

**Central state machine (payer, `sendFrame`).**

1. Decode inputs; reject sealed frames > `MAX_BLE_FRAME_BYTES − 1`.
2. Start scanning with the service-UUID filter. iOS: `scanForPeripherals(withServices: [uuid])`. Android: `ScanFilter.Builder().setServiceUuid(ParcelUuid(uuid))`, `SCAN_MODE_LOW_LATENCY`.
3. First result: stop scanning, connect. Android: `connectGatt(ctx, false, cb, TRANSPORT_LE)`, then `requestMtu(517)` and wait for `onMtuChanged` ≤ 2 s (proceed with the current MTU on timeout), **then** `discoverServices()`. Never interleave MTU negotiation with discovery: that ordering is the March mDeviceBusy deadlock. iOS: MTU is negotiated by the OS; read `maximumWriteValueLength(for: .withoutResponse)` after connect.
4. Discover the session service and the two characteristics; subscribe to ACK (`setNotifyValue(true)` / write CCCD `ENABLE_INDICATION_VALUE`).
5. Write `HELLO_A` with response. Await `HELLO_B`; verify HMAC or reject "peer failed the session proof".
6. Write `FRAME` chunks without response. Backpressure: iOS waits for `peripheralIsReady(toSendWriteWithoutResponse:)` when `canSendWriteWithoutResponse` is false; Android issues the next `writeCharacteristic` only after `onCharacteristicWrite` (which Android does deliver for `WRITE_TYPE_NO_RESPONSE`). No fixed pacing sleeps.
7. Await `ACK`; verify HMAC; disconnect; resolve `base64(ackJson)`.
8. `connectTimeoutMs` (6 000) fires if step 4 has not completed ("connect timeout: no route to peer" — the string the JS layer already treats as radios-off/peer-gone). `timeoutMs` (20 000) covers the whole exchange. Either timeout disconnects and rejects; a `settled` latch confined to the same queue guards double resolution, as in `sendFrame` on both existing backends.

**Expected performance.** Connect + discovery 0.5–2.5 s. Throughput ≈ 18 KB/s at MTU 185 (iOS default), ≈ 45 KB/s at 517, ≈ 2.5 KB/s at 23. A typical 3–8 KB sealed BSV frame completes in roughly 1–3 s end to end. Hardware measurements are a plan deliverable.

### 4. Session QR capability bits

`c` stays an integer in the `v:1` JSON. The low byte is **rungs the payee is listening on right now**; higher bits are **device hints**. `selectTransport` reads rungs only; hints feed copy and future rungs. A clear bit means "false or unknown"; only the one asynchronous probe gets a companion KNOWN bit.

```ts
// core/localpay/session.ts
export const CAP_AWDL   = 0x01
export const CAP_NEARBY = 0x02
export const CAP_BLE    = 0x04   // now advertised by this app: payee is advertising bsvpay-ble/1
// 0x08..0x80 reserved for future rungs (L2CAP, NFC, Wi-Fi Aware)
export const HINT_ONLINE       = 0x0100 // internet reachable
export const HINT_ONLINE_KNOWN = 0x0200 // HINT_ONLINE is meaningful (probe answered in budget)
export const HINT_NET          = 0x0400 // any connectivity
export const HINT_WIFI         = 0x0800 // Android: Wi-Fi radio on. iOS: associated with a Wi-Fi network (no radio API)
export const HINT_BT           = 0x1000 // Bluetooth authorized and powered on
export const HINT_NFC          = 0x2000 // NFC reader available
export const RUNG_MASK         = 0x00ff
```

`mintSession` gains `supportsBle?: boolean` and `hints?: number` (already masked to `~RUNG_MASK`). `caps = rungs | (hints & ~RUNG_MASK)`. `decodeSession` is unchanged: it already accepts any number.

**Probing (`core/localpay/deviceCaps.ts`).**

```ts
export interface DeviceProbe {
  online: boolean | null          // NetInfo isInternetReachable, null = unknown in budget
  connected: boolean | null       // NetInfo isConnected
  wifi: boolean                   // Android isWifiEnabled; iOS type === 'wifi'
  bluetooth: 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown'
  nfc: boolean
}
export function capsFromProbe(p: DeviceProbe): number          // pure, unit-tested
export async function probeDeviceCaps(opts: { netBudgetMs: number }): Promise<DeviceProbe>
```

`probeDeviceCaps` races `NetInfo.fetch()` against `netBudgetMs` (800 ms); a timeout yields `online: null`, `connected: null`. It reads `bluetoothState()` and `nfcAvailable()` from the BLE HybridObject (both prompt-free), `Platform.OS` for the Wi-Fi asymmetry. It never calls `getOnline()` from `core/net/online.ts`, which deliberately collapses `null` to online — correct for the home-screen banner, wrong for a wire flag.

**Payee minting sequence (`NearbyFlow` `startRequest`).** `receive_minting` now runs, in parallel: `getPublicKey`, two `createNonce`, `probeDeviceCaps`, and — only if `localSupportsBle()` — `ble.prepare(1500)`. Then `mintSession({ …, supportsAwdl, supportsNearby: nearbyReady, supportsBle: bleState === 'poweredOn', hints: capsFromProbe(probe), os })`. The iOS Bluetooth privacy prompt therefore appears once, at the moment the user has asked to receive a nearby payment — the same moment the Local Network prompt already can. Total added latency to minting is bounded by the 1.5 s BLE prepare and 0.8 s net budget, both concurrent with the wallet calls.

**Size.** `c` ≤ `0x3FFF` = 5 JSON characters. Measured session QR stays v16-M for open/amount requests (428–450 chars) and v22-M for token requests at 288 px. `session.test.ts:57-59` is corrected to mint with 64-char nonces and assert the real size class rather than `< 300`.

### 5. Selection ladder and the payer's copy

```ts
// core/localpay/transport/select.ts
export type TransportKind = 'awdl' | 'nearby' | 'ble' | 'qr'
export function localSupportsBle(): boolean   // prompt-free: getLocalPayBleTransport()?.isSupported() ?? false
export function selectTransport(session: Session): TransportKind {
  if ((session.caps & CAP_AWDL)   !== 0 && localSupportsAwdl())   return 'awdl'
  if ((session.caps & CAP_NEARBY) !== 0 && localSupportsNearby()) return 'nearby'
  if ((session.caps & CAP_BLE)    !== 0 && localSupportsBle())    return 'ble'
  return 'qr'
}
```

Ladder rationale: same-OS pairs keep the higher-throughput radio they have today; cross-OS pairs land on BLE because the peer's AWDL/Nearby bits can never match local ability. `session.os` remains metadata (spec `session.ts:40-46`) and is not read for dispatch. New `transportSelect.test.ts` CASES rows: `[CAP_BLE,'ios',…,'ble']`, `[CAP_BLE,'android',…,'ble']`, `[CAP_AWDL|CAP_BLE,'android',…,'ble']`, `[CAP_NEARBY|CAP_BLE,'ios',…,'ble']`, `[CAP_AWDL|CAP_NEARBY|CAP_BLE,'ios',…,'awdl']`, plus BLE-unsupported-locally → `'qr'`.

**`describeFloor(session, local)`** (pure, in `select.ts`) returns why a payer is on QR, evaluated only when `selectTransport` returned `'qr'`:

| Reason | Condition |
|---|---|
| `peer_no_radio` | `session.caps & RUNG_MASK` is 0 |
| `peer_bt_off` | peer has no `CAP_BLE`, `HINT_BT` clear, and no same-OS rung is usable locally |
| `local_ble_denied` | peer has `CAP_BLE`, local `bluetoothState()` is `unauthorized` |
| `local_bt_off` | peer has `CAP_BLE`, local `bluetoothState()` is `poweredOff` |
| `cross_os_no_ble` | peer OS hint differs from local, peer lacks `CAP_BLE`, `HINT_BT` set (peer BT on but app could not advertise) |
| `none` | everything else |

`send_confirm` renders one sentence keyed by the reason (`local_pay_floor_peer_bt_off`, `local_pay_floor_local_bt_off`, `local_pay_floor_local_ble_denied` with an Open Settings affordance, `local_pay_floor_cross_os`, `local_pay_floor_peer_no_radio`). This is the immediate, user-visible payoff of the hint bits: the person paying is told what to ask the other person to switch on, instead of watching a slow fountain in silence.

### 6. Payee multi-listener

`radioTransport` (`NearbyFlow.tsx:520-523`) becomes `radioTransports: LocalPaymentTransport[]`: the platform socket transport when ready, plus `bleTransport` when `bleState === 'poweredOn'`. The listener effect (`:911-947`) creates one `AbortController` per transport, starts every `receive()`, and on the first resolution aborts the other controllers **before** calling `settleReceived`. Aborting a loser runs its own native `stopListening()` — a separate HybridObject, so the winner's held ack connection is untouched. `savePending` receives the winner's `kind`. A loser's rejection is non-terminal, exactly as a radio failure is today; `nearbyError` becomes per-kind so the presence row can still say "waiting" while one radio is alive. `radioActive` is true while any listener is live.

`PresenceRow` gains an optional `medium?: 'wifi' | 'bluetooth'` prop selecting the `ready`/`waiting` icon (`wifi` vs `bluetooth`); the payee passes `'bluetooth'` when BLE is the only live listener, the payer when `sendKind === 'ble'`.

### 7. Permissions and prompts

**Android.** `requestBlePermissions()` in `core/localpay/blePermissions.ts`: API ≥ 31 `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `BLUETOOTH_ADVERTISE`; API ≤ 30 `ACCESS_FINE_LOCATION`. `requestNearbyPermissions()` is unchanged (it also asks `NEARBY_WIFI_DEVICES` on 33+). Payee: at flow entry, request Nearby permissions if GMS is present, else BLE permissions; `bleReady = granted && localSupportsBle()`. Payer: request BLE permissions lazily inside `executeSend` when `sendKind === 'ble'`; a denial falls to the fountain with `local_pay_radio_fallback`, mirroring a radio failure.

**iOS.** Payee: prompt inside `prepare()` at `receive_minting` (see §4). Payer: the central manager is instantiated inside `sendFrame`, so the prompt appears at `send_working` only when BLE was selected; a payer who lands on QR is never prompted. `localSupportsBle()` treats `notDetermined` as supported so the ladder can pick BLE and let the prompt follow. `denied`/`restricted` → unsupported → QR with `local_ble_denied` copy.

### 8. Native configuration

- `app.json` → `ios.infoPlist.NSBluetoothAlwaysUsageDescription`: "BSV Wallet uses Bluetooth to send and receive payments directly between nearby devices." Also `NSBluetoothPeripheralUsageDescription` with the same text (harmless; only read below iOS 13).
- No `UIBackgroundModes`, no entitlement. `plugins/` unchanged.
- `LocalPayTransport.podspec`: `s.frameworks = 'Network', 'Security', 'CoreBluetooth'`; add `ios/HybridLocalPayBleTransport.swift`, `ios/BleGattProfile.swift`.
- `nitro.json` autolinking gains `LocalPayBleTransport` with `HybridLocalPayBleTransport` on both platforms; run `nitrogen`.
- Android manifest: permissions already declared (`RNLT/android/src/main/AndroidManifest.xml:6-15`, `app.json:89-91`); add `<uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />`.
- `ios/` is committed and EAS uses the generic workflow: run `npx expo prebuild --clean --platform ios`, commit the regenerated `ios/`.

### 9. Money-safety invariants (unchanged, restated for the new rung)

1. A positive ack is sent only after `savePending` resolves (`NearbyFlow.tsx` step 3a). BLE adds nothing between the JS `confirm(true)` and the wire except an HMAC.
2. A negative ack is sent only where provably nothing was queued (`decode_failed` inside the transport, `session_mismatch`, `already_paid`, `save_failed` from settle).
3. Reaper expiry never synthesises an ack.
4. First-success-wins is a native latch, set before the ack is sent, so a second PSK-holder reaching FRAME is refused, not raced.
5. Radio failure (connect timeout, proof failure, lost ack, oversize) falls to the fountain **without** aborting the built action; an explicit decline aborts and never offers the fountain (`executeSend`, `:1203-1265`).
6. A forged ack is impossible without the PSK; a stranger cannot consume the payee's listener without the PSK.

## Compatibility

No builds with BLE are in the field. Older `bsvpay1:` decoders (the current app) ignore `CAP_BLE` and the hint bits (`session.ts:172,198`) and floor to QR exactly as today. A Blitz session that sets `0x04` will be selected for BLE by a new payer and must therefore implement `bsvpay-ble/1`; this document is the profile the deferred Blitz reply points at.

## Testing

**Jest (pure and mocked).**
- `deviceCaps.test.ts`: `capsFromProbe` truth table including unknown → clear and `HINT_ONLINE_KNOWN` semantics; `probeDeviceCaps` budget timeout with a stalled `NetInfo.fetch` mock.
- `transportSelect.test.ts`: the new CASES rows; `describeFloor` table; `localSupportsBle` with a mocked accessor returning `null`.
- `transportBle.test.ts`: `makeSocketTransport('ble', …)` over a mocked native object — abort before/after frame, single-ack latch, `decode_failed` decline on unseal failure, connect-timeout rejection string, oversize rejection propagates as a radio failure.
- `session.test.ts`: real-length nonces; rung/hint masking in `mintSession`; round-trip of `c` with all bits set.
- `blePermissions.test.ts`: API-level permission sets, same shape as the existing `requestNearbyPermissions` tests.
- NearbyFlow: extend the existing listener-effect tests (if present) or add a hook-level test that two transports start, the first resolution aborts the second, and `savePending` receives the winner's kind.

**Native (manual, recorded in the plan as a checklist with measured numbers).** Four pairings — Android→iOS first, since it was never confirmed — each logging negotiated MTU, connect time, transfer time, ack round trip. Plus: radios off on each side (expect `connect timeout` within 6 s and the fountain), screen lock on the payee mid-wait (expect the payer to fall to the fountain), a second device holding the same QR (expect `already_paid` decline), stranger with a sniffed UUID (expect silent disconnect on the payee, proof failure on the payer).

**Store gate.** Task 0: a TestFlight upload of a build linking CoreBluetooth with the plist key and no UI, to prove ITMS-90683 is clear.

## Rollout order (for the plan)

0. TestFlight pre-flight with CoreBluetooth linked.
1. Nitro spec + registration + config; JS accessor; `session.ts` bits; `select.ts` ladder; tests (no native behaviour yet, `isSupported()` returns false).
2. Swift backend; iOS↔iOS on hardware.
3. Kotlin backend; Android↔Android, then Android→iOS and iOS→Android.
4. `deviceCaps`, `blePermissions`, `describeFloor`, `NearbyFlow` wiring (multi-listener, prepare at minting, floor copy, presence medium), i18n keys.
5. Docs amendments listed under **Amends**.

## Resolved questions (product owner, 2026-09-02)

1. Placement → native backend behind the existing Nitro spec shape (not a JS transport over `munim-bluetooth`).
2. `CAP_BLE` → reuse `0x04`; this profile is the reference Blitz adopts.
3. Ladder → AWDL/Nearby → BLE → QR.
4. Flag encoding → extend the integer `c`, stay `v:1`.
5. HELLO handshake → kept (approved with the full design), because it is what stops a non-PSK holder consuming the payee's listener.

## Deferred (recorded todos)

- Session TTL and the PSK-in-QR exposure (cross-rung; `codec.ts:215-217`).
- ACK/HELLO_B replay to a second payer of the same QR: the `proof`/`ackMac` inputs carry no payer nonce, so a recorder in radio range can re-advertise the session UUID and replay a MAC-valid `{"ok":true}` to a second payer of an already-paid QR. Narrow (same QR paid twice, attacker in range) and adjacent to the session-TTL item; fix after the hardware run by carrying a payer nonce in HELLO_A and binding it into `proof(0x02)` and `ackMac`.
- L2CAP CoC if hardware timings for > 16 KiB frames disappoint.
- BLE background advertising (would need `UIBackgroundModes bluetooth-peripheral`; invisible to Android centrals anyway).
- Reply to Blitz (from the v3 spec's deferred list), now pointing at §2–§3 here.
- Re-evaluating ladder order if the iOS 26 AWDL P2P regression on cellular iPhones (Apple forum 808917) is confirmed in the field.
