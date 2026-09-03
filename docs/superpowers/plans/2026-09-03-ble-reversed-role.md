# BLE Reversed Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make iOS the BLE GATT central whenever an Android payer pays an iOS payee, so the Android controller never chooses link-layer instants, while keeping every `bsvpay-ble/1` message byte-identical.

**Architecture:** A new rung bit `CAP_BLE_SCAN = 0x08` in the session QR says the payee is also scanning for a payer advertising the session's service UUID. Two methods are added to the existing `LocalPayBleTransport` HybridObject — `startScanning` (payee as central) and `sendFrameAdvertising` (payer as peripheral) — beside the untouched four, so the shared `LocalPayNative` Pick and the AWDL/Nearby object are unaffected. The JS `bleTransport` starts both listeners on the payee (iOS) and picks the payer method by `bleRole(session)`. GATT mechanics are unchanged (central writes the FRAME characteristic, peripheral indicates on the ACK characteristic); only the payer/payee assignment behind those roles flips, and the peripheral speaks first (`HELLO_A`) once the central subscribes.

**Tech Stack:** Expo 55 / React Native new architecture, react-native-nitro-modules ^0.35.x + nitrogen 0.35.10, CoreBluetooth + CryptoKit (Swift), android.bluetooth + javax.crypto (Kotlin), Jest (jest-expo), JUnit 4.

**Spec:** docs/superpowers/specs/2026-09-03-ble-reversed-role-design.md (amends docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md)

## Global Constraints

- Message bytes never change: `HELLO_A 0x01` is always the payer's proof, `HELLO_B 0x02` the payee's, `FRAME 0x03` payer → payee, `ACK 0x04 = ackJson ‖ HMAC` payee → payer. `BleGattProfile.swift` and `BleGattProfile.kt` are NOT modified except for one added Kotlin test vector.
- GATT mechanics never change: service UUID = `HMAC-SHA256(psk, "bsvpay-ble-svc" ‖ utf8(instanceName))[0..16]` with RFC-4122 bits; FRAME char `B5A1E001-…` (write, writeWithoutResponse; central → peripheral); ACK char `B5A1E002-…` (indicate; peripheral → central).
- Framing: `[u32 BE length][message]`, chunked to `ATT_MTU − 3` (Kotlin `BleGattProfile.chunk(bytes, mtu)`, Swift `BleGattProfile.chunks(data, size:)`), reassembled by the existing `Reassembler` types.
- `CAP_BLE_SCAN = 0x08` is minted only when `CAP_BLE` is minted; reserved comment becomes `0x10..0x80`.
- Budgets unchanged: `BLE_CONNECT_TIMEOUT_MS = 15_000`, `SEND_TIMEOUT_MS = 30_000`, idle reaper 30 s, ack reaper 60 s.
- Native error strings reused verbatim: `"connect timeout: no route to peer"`, `"timed out waiting for peer"`, `"peer failed the session proof"`, `"frame too large for a BLE payload"`, `"bluetooth unavailable"`, `"bad psk or frame"`, `"bad psk or instance name"`, `"peer disconnected before acking"`, `"payee never confirmed the payment; connection released"`.
- Log tag/category `LocalPayBle` on both platforms; every terminal failure of a send logs `payer: send failed reason=<message>` (Kotlin) / `send failed reason=…` (Swift).
- nitrogen is run from inside the package — `cd packages/react-native-localpay-transport && npx nitrogen` — never `nitro-codegen`. Generated output under `nitrogen/generated/**` is committed.
- `ios/` is committed; `android/` is gitignored and never committed.
- Test runner: `npx jest <path>` from the repo root. Toolbox typecheck: `npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep "error TS" | grep -v "core/pay/rails/handle.ts\|ui/components/pay/HandleReceive.tsx"` → expected no output. Native package typecheck: `npx tsc --noEmit -p packages/react-native-localpay-transport/tsconfig.json`.
- Kotlin compile check (no `android/` dir in the repo): `cd /Users/personal/git/bsv-wallet && npx expo prebuild --platform android --no-install >/dev/null && cd android && ./gradlew :react-native-localpay-transport:compileDebugKotlin :react-native-localpay-transport:testDebugUnitTest --console=plain 2>&1 | grep -E "BUILD|^e: |FAILED|tests completed"` → expected `BUILD SUCCESSFUL`; then `rm -rf android` (it is gitignored, but keeps the tree tidy).
- Swift compile check: `cd /Users/personal/git/bsv-wallet/ios && xcodebuild -workspace BSVWallet.xcworkspace -scheme BSVWallet -configuration Debug -sdk iphoneos -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build-for-testing 2>&1 | grep -E "error:|BUILD (SUCCEEDED|FAILED)"` — or, cheaper, `xcodebuild -project Pods/Pods.xcodeproj -target LocalPayTransport -configuration Debug -sdk iphoneos CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E "error:|BUILD (SUCCEEDED|FAILED)"` → expected `BUILD SUCCEEDED`. Run `npx pod-install` first if `Pods/` is missing.
- Device installs: Android APK must be signed with the EAS `dev-physical` keystore (build via `npm run android-dev-physical`), NOT the gradle debug key — a cert mismatch forces an uninstall that wipes the wallet DB. iOS: `npm run ios-dev-physical`, install via Finder/Apple Configurator, or `xcrun devicectl device install app --device 43EE228A-B496-5999-9932-E6235D99535B <app>`.
- Commits: conventional commits with scope `localpay|transport|ble|pay|docs`, each carrying the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Shared names every task uses verbatim: TS `CAP_BLE_SCAN`, `mintSession({ supportsBleScan? })`, `bleRole(session): BleRole`, `type BleRole = 'central' | 'peripheral'`, `makeBleTransport(native, connectTimeoutMs)`, `bleTransport`; Nitro `startScanning(instanceName, pskBase64, onFrame, onError): Promise<void>`, `sendFrameAdvertising(instanceName, pskBase64, frameBase64, timeoutMs, connectTimeoutMs): Promise<string>`; Kotlin `PayerAdvertise` (inner class), `payer` (field), `startScanning`, `sendFrameAdvertising`; Swift `InboundScan` (class), `activeScan` (field), `PayerAdvertise` (class), `activePayer` (field).

## File Structure

Paths: `RNLT` = `packages/react-native-localpay-transport`, `L` = `packages/expo-wallet-toolbox/core/localpay`, `T` = `packages/expo-wallet-toolbox/__tests__/localpay`, `UI` = `packages/expo-wallet-toolbox/ui`.

| Path | Action | Task(s) | Responsibility |
|---|---|---|---|
| `RNLT/android/.../HybridLocalPayBleTransport.kt` | Modify | 0, 4, 5 | Task 0: late-MTU adoption + chunk logging (already in the working tree). Task 4: `PayerAdvertise` + `sendFrameAdvertising`. Task 5: `startScanning` (payee as central). |
| `L/session.ts` | Modify | 1 | `CAP_BLE_SCAN`, `supportsBleScan` |
| `T/session.test.ts` | Modify | 1 | Bit tests |
| `L/transport/select.ts` | Modify | 2 | `BleRole`, `bleRole()` |
| `T/transportSelect.test.ts` | Modify | 2 | `bleRole` table |
| `RNLT/src/specs/LocalPayBleTransport.nitro.ts` | Modify | 3 | Two new methods |
| `RNLT/nitrogen/generated/**` | Regenerate | 3 | Glue for the new methods |
| `RNLT/ios/HybridLocalPayBleTransport.swift` | Modify | 3, 6, 7 | Task 3: forwarding shell + inert engine stubs. Task 6: `InboundScan`. Task 7: `PayerAdvertise`. |
| `RNLT/android/src/test/.../BleGattProfileTest.kt` | Modify | 4 | `verifyAck` accepts the Swift-built ACK bytes |
| `L/transport/socket.ts` | Modify | 8 | Export `SEND_TIMEOUT_MS`, `parseAck`, `makeConfirm`, `declineQuietly`, `toBase64`, `fromBase64` |
| `L/transport/ble.ts` | Modify | 8 | `makeBleTransport`: dual listener on receive, role dispatch on send |
| `T/transportBle.test.ts` | Modify | 8 | Dual-listener and role-dispatch tests |
| `UI/components/pay/NearbyFlow.tsx` | Modify | 8, 9 | Task 8: `supportsBleScan` at mint. Task 9: remove the two `[localpay][diag]` lines. |
| `docs/superpowers/2026-09-02-ble-hardware-log.md` | Modify | 9 | Today's two failure rows + reversed-role rows |
| `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md` | Modify | 9 | "Amended by" pointer |

---

### Task 0: Commit the Kotlin late-MTU adoption and chunk logging already in the working tree

**Files:**
- Modify (already modified, uncommitted): `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport.kt`
- Leave untouched for now: `packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx` (its two `[localpay][diag]` lines are removed in Task 9; keep them out of this commit)

**Interfaces:**
- Consumes: nothing.
- Produces: `onMtuChanged` adopts a late MTU when `writeQueue.isEmpty()`; `writeNextChunk` logs `payer: chunk write submitted bytes=… remaining=… type=… status=… at … ms`; `onCharacteristicWrite` logs `payer: chunk write confirmed status=… queued=… at … ms`; `onPhyUpdate` logs `payer: phy updated …`.

- [ ] **Step 1: Confirm the diff is exactly the three intended edits**

Run: `cd /Users/personal/git/bsv-wallet && git diff --stat && git diff packages/react-native-localpay-transport/android | grep -E "^\+" | grep -vE "^\+\+\+" | head -40`
Expected: `HybridLocalPayBleTransport.kt | 22 +++…` and `NearbyFlow.tsx | 4 ++++`; the Kotlin additions are the `onMtuChanged` block (`late mtu … using`), the `onPhyUpdate` override, the two chunk log lines, and `(mtu $mtu)` on the HELLO_A log line. No `PHY_LE_1M_MASK`, no `onConnectionUpdated`.

- [ ] **Step 2: Compile the Kotlin module**

Run the Kotlin compile check from Global Constraints.
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit only the Kotlin file**

```bash
cd /Users/personal/git/bsv-wallet
git add packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport.kt
git commit -m "fix(ble): adopt a late MTU on the Android central and log every chunk write

Android 14 queues the app's requestMtu behind its own connect-time service
discovery, so against an iOS peripheral the answer lands after the 2 s
timer started discovery and was dropped, leaving the payer chunking at 20
bytes on a 517-byte link. Adopt it whenever no message is mid-write. Per-
chunk submit/confirm and PHY-update logs make the hardware rows readable.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: `CAP_BLE_SCAN` in the session

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/localpay/session.ts` (constants block after `CAP_BLE`; `mintSession` args and caps expression)
- Test: `packages/expo-wallet-toolbox/__tests__/localpay/session.test.ts`

**Interfaces:**
- Produces: `export const CAP_BLE_SCAN = 0x08`; `mintSession` accepts `supportsBleScan?: boolean` and mints `0x08` only when `supportsBle` is true.

- [ ] **Step 1: Write the failing tests**

Add to the imports of `session.test.ts`: `CAP_BLE_SCAN`. Add inside the existing `describe` that holds the `CAP_BLE` tests (near line 72):

```ts
  it('mints the BLE scan bit only alongside the BLE rung bit', () => {
    expect(CAP_BLE_SCAN).toBe(0x08)
    expect(mintSession({ ...args, supportsBle: true, supportsBleScan: true }).caps & CAP_BLE_SCAN).toBe(CAP_BLE_SCAN)
    expect(mintSession({ ...args, supportsBle: true, supportsBleScan: false }).caps & CAP_BLE_SCAN).toBe(0)
    expect(mintSession({ ...args, supportsBle: true }).caps & CAP_BLE_SCAN).toBe(0)
    // A scanner with no advertiser behind it would strand iOS payers: refused at the mint.
    expect(mintSession({ ...args, supportsBle: false, supportsBleScan: true }).caps & (CAP_BLE | CAP_BLE_SCAN)).toBe(0)
  })

  it('round-trips the scan bit through the QR text', () => {
    const s = mintSession({ ...args, supportsBle: true, supportsBleScan: true })
    expect(decodeSession(encodeSession(s)).caps & CAP_BLE_SCAN).toBe(CAP_BLE_SCAN)
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/session.test.ts -t "scan bit"`
Expected: FAIL — `CAP_BLE_SCAN` is not exported (TypeScript/undefined).

- [ ] **Step 3: Implement**

In `session.ts`, replace

```ts
/** Payee is advertising bsvpay-ble/1 — now advertised by this app, and the profile Blitz adopts. */
export const CAP_BLE = 0x04
// 0x08..0x80 reserved for future rungs (L2CAP, NFC, Wi-Fi Aware).
```

with

```ts
/** Payee is advertising bsvpay-ble/1 — now advertised by this app, and the profile Blitz adopts. */
export const CAP_BLE = 0x04
/**
 * Payee is ALSO scanning for a payer that advertises this session's service
 * UUID (bsvpay-ble/1 reversed role, spec 2026-09-03). Never minted without
 * CAP_BLE: a scanner with no advertiser behind it would strand a payer whose
 * own central role is trusted. Set by iOS payees only — Android as central is
 * the role that fails against iOS.
 */
export const CAP_BLE_SCAN = 0x08
// 0x10..0x80 reserved for future rungs (L2CAP, NFC, Wi-Fi Aware).
```

In `mintSession`'s args, after `supportsBle?: boolean`, add:

```ts
  /** True only while a reversed-role scan listener is live for this session. Ignored unless supportsBle. */
  supportsBleScan?: boolean
```

In the `caps:` expression, after `(args.supportsBle ? CAP_BLE : 0) |` add:

```ts
      (args.supportsBle && args.supportsBleScan ? CAP_BLE_SCAN : 0) |
```

- [ ] **Step 4: Run the tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/session.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/localpay/session.ts packages/expo-wallet-toolbox/__tests__/localpay/session.test.ts
git commit -m "feat(localpay): CAP_BLE_SCAN rung bit for the reversed BLE role

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `bleRole()` in the ladder module

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/localpay/transport/select.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts`

**Interfaces:**
- Consumes: `CAP_BLE_SCAN` (Task 1).
- Produces: `export type BleRole = 'central' | 'peripheral'`; `export function bleRole(session: Session): BleRole`.

- [ ] **Step 1: Write the failing tests**

In `transportSelect.test.ts` extend the import lines to `import { bleRole, localSupportsBle, selectTransport } from '../../core/localpay/transport/select'` and `import { mintSession, CAP_AWDL, CAP_BLE, CAP_BLE_SCAN, CAP_NEARBY, type Session } from '../../core/localpay/session'`. Add a new describe at the end of the file:

```ts
describe('bleRole', () => {
  afterEach(() => {
    Platform.OS = 'ios'
  })

  it('is peripheral only when the payee scans and this device is Android', () => {
    Platform.OS = 'android'
    expect(bleRole(mintSession({ ...base, supportsAwdl: false, supportsBle: true, supportsBleScan: true }))).toBe('peripheral')
  })

  it('stays central on iOS even when the payee scans', () => {
    Platform.OS = 'ios'
    expect(bleRole(mintSession({ ...base, supportsAwdl: false, supportsBle: true, supportsBleScan: true }))).toBe('central')
  })

  it('stays central on Android when the payee does not scan', () => {
    Platform.OS = 'android'
    expect(bleRole(mintSession({ ...base, supportsAwdl: false, supportsBle: true }))).toBe('central')
  })

  it('does not select BLE at all for a session carrying only the scan bit', () => {
    Platform.OS = 'android'
    const s: Session = { ...mintSession({ ...base, supportsAwdl: false }), caps: CAP_BLE_SCAN }
    expect(selectTransport(s)).toBe('qr')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts -t bleRole`
Expected: FAIL — `bleRole` is not exported.

- [ ] **Step 3: Implement**

In `select.ts`, change the import to `import { CAP_AWDL, CAP_BLE, CAP_BLE_SCAN, CAP_NEARBY, HINT_BT, RUNG_MASK, type Session } from '../session'` and add after `selectTransport`:

```ts
/** The GATT role THIS device takes as payer once the ladder chose 'ble'. */
export type BleRole = 'central' | 'peripheral'

/**
 * Peripheral only when the payee advertised that it is scanning (CAP_BLE_SCAN)
 * AND this device is Android. Android as central against an iOS peripheral
 * fails below the app — its controller's link-layer instants are applied by
 * the iPhone seconds to minutes late (spec 2026-09-03) — so it advertises and
 * lets the iOS payee connect. The platform check is a local-ability check in
 * the spirit of localSupportsNearby(), not a read of the peer's OS:
 * `session.os` stays metadata.
 */
export function bleRole(session: Session): BleRole {
  return (session.caps & CAP_BLE_SCAN) !== 0 && Platform.OS === 'android' ? 'peripheral' : 'central'
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts packages/expo-wallet-toolbox/__tests__/localpay/describeFloor.test.ts` then the toolbox typecheck from Global Constraints.
Expected: PASS; typecheck prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/localpay/transport/select.ts packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts
git commit -m "feat(localpay): bleRole() — Android advertises when the payee scans

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Nitro surface — `startScanning` and `sendFrameAdvertising`, regenerated glue, inert native stubs

**Files:**
- Modify: `packages/react-native-localpay-transport/src/specs/LocalPayBleTransport.nitro.ts`
- Regenerate: `packages/react-native-localpay-transport/nitrogen/generated/**`
- Modify: `packages/react-native-localpay-transport/ios/HybridLocalPayBleTransport.swift` (shell class + `BleEngine` stubs)
- Modify: `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport.kt` (stubs)

**Interfaces:**
- Produces (used by Tasks 4–8):
  - `startScanning(instanceName: string, pskBase64: string, onFrame: (frameBase64: string) => void, onError: (message: string) => void): Promise<void>`
  - `sendFrameAdvertising(instanceName: string, pskBase64: string, frameBase64: string, timeoutMs: number, connectTimeoutMs: number): Promise<string>`

- [ ] **Step 1: Extend the spec**

In `LocalPayBleTransport.nitro.ts`, after the `sendFrame(...)` member, add:

```ts
  /**
   * Reversed role, payee side (spec 2026-09-03): scan for a payer advertising
   * this session's service UUID, connect, subscribe to ACK, expect the payer's
   * HELLO_A as an indication, write HELLO_B, receive FRAME indications. Runs
   * alongside startListening() on the same object: one first-success-wins
   * latch covers both links, and the loser is torn down the instant a FRAME is
   * accepted on either. confirmFrame() and stopListening() are unchanged and
   * act on whichever link holds the frame. Resolves once scanning is on;
   * rejects only if scanning cannot start ("bluetooth unavailable"). A scan
   * that never hits is not an error.
   */
  startScanning(
    instanceName: string,
    pskBase64: string,
    onFrame: (frameBase64: string) => void,
    onError: (message: string) => void
  ): Promise<void>
  /**
   * Reversed role, payer side: advertise this session's service UUID and serve
   * GATT; when a central subscribes to ACK, indicate HELLO_A, expect a HELLO_B
   * write, indicate FRAME, resolve with the bare ackJson of a MAC-verified ACK
   * write. Same budgets and rejection strings as sendFrame(): "connect timeout:
   * no route to peer" if no central subscribed within connectTimeoutMs, "timed
   * out waiting for peer" at timeoutMs.
   */
  sendFrameAdvertising(
    instanceName: string,
    pskBase64: string,
    frameBase64: string,
    timeoutMs: number,
    connectTimeoutMs: number
  ): Promise<string>
```

- [ ] **Step 2: Regenerate nitrogen**

Run: `cd /Users/personal/git/bsv-wallet/packages/react-native-localpay-transport && npx nitrogen 2>&1 | tail -5 && git status --short nitrogen | head`
Expected: nitrogen reports the two HybridObjects generated; `git status` lists modified files under `nitrogen/generated/ios/swift/HybridLocalPayBleTransportSpec*.swift`, `nitrogen/generated/android/kotlin/.../HybridLocalPayBleTransportSpec.kt`, and `nitrogen/generated/shared/c++/HybridLocalPayBleTransportSpec.*`.

- [ ] **Step 3: Swift shell + inert engine stubs**

In `HybridLocalPayBleTransport.swift`, inside `final class HybridLocalPayBleTransport`, after `sendFrame(...)`, add:

```swift
  func startScanning(
    instanceName: String,
    pskBase64: String,
    onFrame: @escaping (String) -> Void,
    onError: @escaping (String) -> Void
  ) throws -> Promise<Void> {
    engine.startScanning(instanceName: instanceName, pskBase64: pskBase64, onFrame: onFrame, onError: onError)
  }

  func sendFrameAdvertising(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ) throws -> Promise<String> {
    engine.sendFrameAdvertising(
      instanceName: instanceName, pskBase64: pskBase64, frameBase64: frameBase64,
      timeoutMs: timeoutMs, connectTimeoutMs: connectTimeoutMs
    )
  }
```

In `BleEngine`, directly after `fileprivate func finishSend(_ send: OutboundSend)`, add temporary stubs (replaced in Tasks 6 and 7):

```swift
  // MARK: Reversed role (spec 2026-09-03) — filled in by the InboundScan / PayerAdvertise tasks

  func startScanning(
    instanceName: String, pskBase64: String,
    onFrame: @escaping (String) -> Void, onError: @escaping (String) -> Void
  ) -> Promise<Void> {
    let promise = Promise<Void>()
    promise.reject(withError: BleGattProfile.error("bluetooth unavailable", code: 16))
    return promise
  }

  func sendFrameAdvertising(
    instanceName: String, pskBase64: String, frameBase64: String,
    timeoutMs: Double, connectTimeoutMs: Double
  ) -> Promise<String> {
    let promise = Promise<String>()
    promise.reject(withError: BleGattProfile.error("bluetooth unavailable", code: 16))
    return promise
  }
```

- [ ] **Step 4: Kotlin inert stubs**

In `HybridLocalPayBleTransport.kt`, directly before `// ── payer (central) ──`, add (replaced in Tasks 4 and 5):

```kotlin
  // ── reversed role (spec 2026-09-03) — filled in by the PayerAdvertise / startScanning tasks ──

  override fun startScanning(
    instanceName: String,
    pskBase64: String,
    onFrame: (String) -> Unit,
    onError: (String) -> Unit
  ): Promise<Unit> {
    val promise = Promise<Unit>()
    promise.reject(Error("bluetooth unavailable"))
    return promise
  }

  override fun sendFrameAdvertising(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ): Promise<String> {
    val promise = Promise<String>()
    promise.reject(Error("bluetooth unavailable"))
    return promise
  }
```

- [ ] **Step 5: Typecheck and compile both platforms**

Run: `npx tsc --noEmit -p packages/react-native-localpay-transport/tsconfig.json`; then the Kotlin compile check and the Swift compile check from Global Constraints (run `cd ios && npx pod-install` first so the pod picks up the regenerated Swift spec).
Expected: no TS errors; `BUILD SUCCESSFUL`; `BUILD SUCCEEDED`.

- [ ] **Step 6: Commit**

```bash
cd /Users/personal/git/bsv-wallet
git add packages/react-native-localpay-transport/src/specs/LocalPayBleTransport.nitro.ts packages/react-native-localpay-transport/nitrogen packages/react-native-localpay-transport/ios/HybridLocalPayBleTransport.swift packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport.kt ios/Podfile.lock
git commit -m "feat(transport): startScanning and sendFrameAdvertising on LocalPayBleTransport (inert)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Kotlin payer as peripheral — `PayerAdvertise` + `sendFrameAdvertising`

**Files:**
- Modify: `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport.kt`
- Test: `packages/react-native-localpay-transport/android/src/test/java/com/margelo/nitro/localpaytransport/BleGattProfileTest.kt`

**Interfaces:**
- Consumes: existing `ensureGattServer()`, `startAdvertising(uuid)`, `stopAdvertising()`, `Central`, `centrals`, `sendIndication(central, message, onDone)`, `onIndicationResult`, `service`, `ackCharacteristic`, `advertiseCallback`, `serverCallback`, `main`.
- Produces: `sendFrameAdvertising` per the Nitro contract; `private var payer: PayerAdvertise?` which every `serverCallback` branch consults first.

- [ ] **Step 1: Write the failing JUnit test**

Append to `BleGattProfileTest.kt` inside the test class:

```kotlin
  @Test
  fun verifyAck_acceptsTheAckMessageBuiltByThePeer() {
    // Reversed role: the payer (Android) now verifies an ACK the payee built.
    // Same bytes as ackMessage(), so the peripheral-side check is the existing
    // verifyAck() over a message produced by the existing builder.
    val psk = ByteArray(32) { it.toByte() }
    val name = "bsvpay-ob6nb2nqxvazcq2bx33et5ama4"
    val json = "{\"ok\":true}".toByteArray(Charsets.UTF_8)
    val message = BleGattProfile.ackMessage(psk, name, json)
    assertArrayEquals(json, BleGattProfile.verifyAck(psk, name, message))
    // One flipped MAC bit is refused.
    val tampered = message.copyOf(); tampered[tampered.size - 1] = (tampered.last().toInt() xor 1).toByte()
    assertNull(BleGattProfile.verifyAck(psk, name, tampered))
  }
```

Add `import org.junit.Assert.assertNull` if not already imported.

- [ ] **Step 2: Run to verify it passes (it pins existing behaviour) and note the count**

Run the Kotlin compile check (includes `testDebugUnitTest`).
Expected: `BUILD SUCCESSFUL`, 14 tests (13 + 1).

- [ ] **Step 3: Add the `PayerAdvertise` state and wire the server callbacks**

Add the field and inner class right after the existing `private var indicationInFlight: IndicationJob? = null` line:

```kotlin
  // ── reversed role: payer as peripheral (spec 2026-09-03 §4) — main thread only ──

  /**
   * One sendFrameAdvertising() in flight. Shares the GATT server, `centrals`,
   * the indication pump and the advertising helpers with the payee side; the
   * two roles never run at once on one device (a payer is not listening for a
   * payment while it pays), so `payer != null` simply routes every server
   * callback here first.
   */
  private inner class PayerAdvertise(
    val instanceName: String,
    val psk: ByteArray,
    val sealed: ByteArray,
    val promise: Promise<String>,
    timeoutMs: Long,
    connectTimeoutMs: Long
  ) {
    val serviceUuid: UUID = BleGattProfile.serviceUuid(psk, instanceName)
    private val t0 = SystemClock.elapsedRealtime()
    fun elapsed(): Long = SystemClock.elapsedRealtime() - t0
    private var settled = false
    /** The central that subscribed first and received HELLO_A; only its writes count. */
    var candidate: BluetoothDevice? = null
    /** Set once HELLO_B verified: FRAME goes to this central, ACK is expected from it. */
    var bound: BluetoothDevice? = null
    /** Set once the last FRAME chunk's indication was confirmed. */
    var frameOnWire = false
    private val connectTimer = Runnable {
      if (candidate == null) fail("connect timeout: no route to peer")
    }
    private val wholeTimer = Runnable { fail("timed out waiting for peer") }

    init {
      main.postDelayed(connectTimer, connectTimeoutMs)
      main.postDelayed(wholeTimer, timeoutMs)
    }

    fun settle(block: () -> Unit) {
      if (settled) return
      settled = true
      main.removeCallbacks(connectTimer)
      main.removeCallbacks(wholeTimer)
      payer = null
      resetSession(null)
      block()
    }

    fun fail(message: String) = settle {
      Log.d(TAG, "payer: send failed reason=$message")
      promise.reject(Error(message))
    }

    fun onConnected(device: BluetoothDevice) {
      if (centrals.containsKey(device.address)) return
      centrals[device.address] = Central(device)
      Log.d(TAG, "payer: central connected ${device.address} at ${elapsed()} ms")
    }

    fun onDisconnected(device: BluetoothDevice) {
      Log.d(TAG, "payer: central disconnected ${device.address} at ${elapsed()} ms")
      centrals.remove(device.address)?.subscribed = false
      failIndicationsFor(device)
      if (device.address == bound?.address || device.address == candidate?.address) {
        fail(if (frameOnWire || bound != null) "peer disconnected before acking" else "connect failed: central left")
      }
    }

    fun onMtu(device: BluetoothDevice, mtu: Int) {
      centrals[device.address]?.mtu = mtu
      Log.d(TAG, "payer: mtu $mtu for ${device.address}")
    }

    /** CCCD enable on ACK from `device`: the first subscriber becomes the candidate and gets HELLO_A. */
    fun onSubscribed(device: BluetoothDevice, subscribed: Boolean) {
      val central = centrals[device.address] ?: Central(device).also { centrals[device.address] = it }
      central.subscribed = subscribed
      if (!subscribed || candidate != null || settled) return
      candidate = device
      main.removeCallbacks(connectTimer)
      Log.d(TAG, "payer: central subscribed ${device.address} at ${elapsed()} ms; indicating HELLO_A (mtu ${central.mtu})")
      sendIndication(central, BleGattProfile.helloA(psk, instanceName)) { ok ->
        if (!ok && !settled) fail("failed to send frame: HELLO_A indication not delivered")
      }
    }

    /** A reassembled message written by `device` to the FRAME characteristic. */
    fun onMessage(device: BluetoothDevice, message: ByteArray) {
      if (settled || message.isEmpty()) return
      val type = message[0].toInt() and 0xff
      val fromCandidate = device.address == candidate?.address
      when {
        message[0] == TYPE_HELLO_B && bound == null && fromCandidate -> {
          val proof = message.copyOfRange(1, message.size)
          if (!BleGattProfile.constantTimeEquals(proof, BleGattProfile.proof(psk, instanceName, TYPE_HELLO_B))) {
            // Not our payee: drop this central, forget the candidate, keep advertising for the real one.
            Log.d(TAG, "payer: HELLO_B proof failed from ${device.address}; dropping")
            candidate = null
            centrals.remove(device.address)
            gattServer?.cancelConnection(device)
            main.postDelayed(connectTimer, 0L.coerceAtLeast(0))
            return
          }
          bound = device
          stopAdvertising()
          val central = centrals[device.address] ?: return fail("peer disconnected before acking")
          val framed = BleGattProfile.frameMessage(sealed)
          val chunkCount = (framed.size + BleGattProfile.LENGTH_PREFIX_BYTES + BleGattProfile.chunkSize(central.mtu) - 1) / BleGattProfile.chunkSize(central.mtu)
          Log.d(TAG, "payer: HELLO_B verified at ${elapsed()} ms; indicating frame (${sealed.size} bytes, $chunkCount chunks at mtu ${central.mtu})")
          val tFrame = SystemClock.elapsedRealtime()
          sendIndication(central, framed) { ok ->
            if (settled) return@sendIndication
            if (!ok) {
              fail("failed to send frame: indication not delivered")
              return@sendIndication
            }
            frameOnWire = true
            Log.d(TAG, "payer: frame indicated in ${SystemClock.elapsedRealtime() - tFrame} ms; awaiting ack")
          }
        }
        message[0] == TYPE_ACK && device.address == bound?.address && (frameOnWire || indicationInFlight != null) -> {
          // The ACK write may land before the last chunk's onNotificationSent
          // walked us to frameOnWire (the payee had every chunk already).
          val json = BleGattProfile.verifyAck(psk, instanceName, message)
          if (json == null) {
            fail("peer failed the session proof")
            return
          }
          Log.d(TAG, "payer: ack verified; total ${elapsed()} ms")
          settle { promise.resolve(Base64.encodeToString(json, Base64.NO_WRAP)) }
        }
        frameOnWire -> Log.d(TAG, "payer: unexpected message ignored type=$type bytes=${message.size - 1}")
        else -> {
          Log.d(TAG, "payer: unexpected message type=$type from ${device.address} before the frame; dropping that central")
          centrals.remove(device.address)
          gattServer?.cancelConnection(device)
          if (fromCandidate) fail("peer failed the session proof")
        }
      }
    }
  }

  private var payer: PayerAdvertise? = null
```

Now route the server callbacks. In `serverCallback.onConnectionStateChange`, make the first lines of the `main.post` block:

```kotlin
        payer?.let { p ->
          when (newState) {
            BluetoothProfile.STATE_CONNECTED -> p.onConnected(device)
            BluetoothProfile.STATE_DISCONNECTED -> p.onDisconnected(device)
          }
          return@post
        }
```

In `onMtuChanged`'s `main.post`, first line: `payer?.let { it.onMtu(device, mtu); return@post }`.

In `onServiceAdded`'s `main.post`, replace `if (addedService.uuid != service?.uuid) return@post` with:

```kotlin
        if (addedService.uuid != service?.uuid) return@post
        if (status != BluetoothGatt.GATT_SUCCESS && payer != null) {
          payer?.fail("bluetooth unavailable: could not add GATT service (status $status)")
          return@post
        }
```

(the existing `failStart` branch below it stays for the payee).

In `onCharacteristicWriteRequest`'s `main.post`, after the `if (responseNeeded) { … GATT_SUCCESS … }` block and BEFORE `if (characteristic.uuid != FRAME_CHAR_UUID || !listening) return@post`, insert:

```kotlin
        payer?.let { p ->
          if (characteristic.uuid != FRAME_CHAR_UUID || value == null || value.isEmpty()) return@post
          val central = centrals[device.address] ?: Central(device).also { centrals[device.address] = it }
          val messages = try {
            central.reassembler.feed(value)
          } catch (e: RuntimeException) {
            Log.d(TAG, "payer: bad framing from ${device.address}: ${e.message}")
            central.reassembler.reset()
            return@post
          }
          for (message in messages) p.onMessage(device, message)
          return@post
        }
```

Also in the `preparedWrite` branch, change `if (characteristic.uuid == FRAME_CHAR_UUID && listening) refuse(device, "prepared write")` to `if (characteristic.uuid == FRAME_CHAR_UUID && listening && payer == null) refuse(device, "prepared write")`.

In `onDescriptorWriteRequest`'s `main.post`, after the `if (responseNeeded) …` block and BEFORE the `if (descriptor.uuid != CCCD_UUID …` line, insert:

```kotlin
        payer?.let { p ->
          if (descriptor.uuid != CCCD_UUID || descriptor.characteristic.uuid != ACK_CHAR_UUID) return@post
          p.onSubscribed(device, value != null && value.isNotEmpty() && (value[0].toInt() and 0x03) != 0)
          return@post
        }
```

In `advertiseCallback.onStartSuccess`'s `main.post`, change the log line so it reads for both roles: replace the `Log.d(TAG, "payee: advertising …")` line with

```kotlin
        Log.d(TAG, "${if (payer != null) "payer" else "payee"}: advertising ${service?.uuid} (${SystemClock.elapsedRealtime() - listenStartedAt} ms after start)")
```

and in `onStartFailure`, replace `failStart("advertising failed: code $errorCode")` with

```kotlin
        payer?.fail("advertising failed: code $errorCode") ?: failStart("advertising failed: code $errorCode")
```

In `startAdvertising(uuid)`, replace `failStart("bluetooth unavailable")` with `payer?.fail("bluetooth unavailable") ?: failStart("bluetooth unavailable")` and the catch's `failStart("advertising failed: ${e.message}")` with `payer?.fail("advertising failed: ${e.message}") ?: failStart("advertising failed: ${e.message}")`.

In `resetSession`, add as its first statement: `payer = null` is NOT set here (settle() already nulls it before calling resetSession); but add after `listening = false`: nothing else. The existing body already tears down `centrals`, indications, `service`, `ackCharacteristic`, advertising — which is exactly what the payer needs.

In `stopListening`, nothing changes (a payer never calls it). In `confirmFrame`, nothing changes.

- [ ] **Step 4: Replace the inert `sendFrameAdvertising` stub**

Replace the Task 3 stub with:

```kotlin
  override fun sendFrameAdvertising(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ): Promise<String> {
    val promise = Promise<String>()
    main.post {
      fun rejectEarly(message: String) {
        Log.d(TAG, "payer: send failed reason=$message")
        promise.reject(Error(message))
      }
      val psk = try { Base64.decode(pskBase64, Base64.DEFAULT) } catch (e: Exception) { null }
      val sealed = try { Base64.decode(frameBase64, Base64.DEFAULT) } catch (e: Exception) { null }
      if (psk == null || psk.isEmpty() || sealed == null || instanceName.isEmpty()) {
        rejectEarly("bad psk or frame")
        return@post
      }
      if (sealed.size + 1 > MAX_BLE_FRAME_BYTES) {
        rejectEarly("frame too large for a BLE payload")
        return@post
      }
      val a = adapter()
      if (a == null || !hasBleHardware() || !a.isEnabled || !canConnect() || !canAdvertise()) {
        rejectEarly("bluetooth unavailable")
        return@post
      }
      val server = ensureGattServer()
      if (server == null) {
        rejectEarly("bluetooth unavailable")
        return@post
      }
      // A payer never listens while it pays, and a newer send supersedes an older one.
      payer?.fail("superseded by a newer send")
      resetSession("superseded by a send")
      listenPsk = null; listenName = null; listenOnFrame = null; listenOnError = null

      val p = PayerAdvertise(instanceName, psk, sealed, promise, timeoutMs.toLong(), connectTimeoutMs.toLong())
      payer = p
      listenStartedAt = SystemClock.elapsedRealtime()
      val frame = BluetoothGattCharacteristic(
        FRAME_CHAR_UUID,
        BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
        BluetoothGattCharacteristic.PERMISSION_WRITE
      )
      val ack = BluetoothGattCharacteristic(
        ACK_CHAR_UUID,
        BluetoothGattCharacteristic.PROPERTY_INDICATE,
        BluetoothGattCharacteristic.PERMISSION_READ
      )
      ack.addDescriptor(
        BluetoothGattDescriptor(CCCD_UUID, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE)
      )
      val svc = BluetoothGattService(p.serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
      svc.addCharacteristic(frame)
      svc.addCharacteristic(ack)
      service = svc
      ackCharacteristic = ack
      Log.d(TAG, "payer: adding service ${p.serviceUuid} for $instanceName; advertising follows")
      if (!server.addService(svc)) p.fail("bluetooth unavailable: could not add GATT service")
    }
    return promise
  }
```

- [ ] **Step 5: Compile and run the JUnit tests**

Run the Kotlin compile check.
Expected: `BUILD SUCCESSFUL`, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/react-native-localpay-transport/android
git commit -m "feat(ble): Android payer advertises and serves GATT in the reversed role

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Kotlin payee as central — `startScanning` (symmetric implementation)

**Files:**
- Modify: `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport.kt`

**Interfaces:**
- Consumes: `sendFrame`'s central chain shape (scan → connect → MTU → discover → subscribe), `BleGattProfile.Reassembler`, `listenOnFrame`/`listenOnError`, `hasAccepted`.
- Produces: `startScanning` per the Nitro contract; `confirmFrame` writes the ACK over the scan link when `scan?.pendingAck` is set.

Not exercised by the hardware checklist (Android payees never mint `CAP_BLE_SCAN`), but it keeps the two backends symmetric as the spec requires.

- [ ] **Step 1: Add the scan-link state**

After `private var payer: PayerAdvertise? = null` add:

```kotlin
  // ── reversed role: payee as central (spec 2026-09-03 §5, Android twin) — main thread only ──

  private inner class InboundScan(
    val instanceName: String,
    val psk: ByteArray,
    val onFrame: (String) -> Unit,
    val onError: (String) -> Unit
  ) {
    val serviceUuid: UUID = BleGattProfile.serviceUuid(psk, instanceName)
    var scanning = false
    var gatt: BluetoothGatt? = null
    var mtu = DEFAULT_ATT_MTU
    var frameCharacteristic: BluetoothGattCharacteristic? = null
    val reassembler = BleGattProfile.Reassembler()
    var helloVerified = false
    /** Set when a FRAME from this link was handed to JS; confirmFrame writes the ACK here. */
    var pendingAck = false
    var writeQueue = ArrayDeque<ByteArray>()
    var onWriteQueueDrained: (() -> Unit)? = null
    var idleReaper: Runnable? = null
    lateinit var scanCallback: ScanCallback
    lateinit var gattCallback: BluetoothGattCallback

    fun disconnectAndRescan(reason: String) {
      Log.d(TAG, "payee(scan): $reason; rescanning")
      idleReaper?.let { main.removeCallbacks(it) }
      idleReaper = null
      gatt?.let { try { it.disconnect(); it.close() } catch (e: Exception) { /* gone */ } }
      gatt = null
      frameCharacteristic = null
      helloVerified = false
      pendingAck = false
      writeQueue = ArrayDeque()
      onWriteQueueDrained = null
      startScan()
    }

    fun startScan() {
      val scanner = adapter()?.bluetoothLeScanner ?: return onError("bluetooth unavailable")
      if (scanning) return
      val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(serviceUuid)).build()
      val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
      scanning = true
      try {
        scanner.startScan(listOf(filter), settings, scanCallback)
        Log.d(TAG, "payee(scan): scanning for $serviceUuid")
      } catch (e: Exception) {
        scanning = false
        onError("bluetooth unavailable")
      }
    }

    fun stopScan() {
      if (!scanning) return
      scanning = false
      try { adapter()?.bluetoothLeScanner?.stopScan(scanCallback) } catch (e: Exception) { /* adapter off */ }
    }

    fun tearDown() {
      stopScan()
      idleReaper?.let { main.removeCallbacks(it) }
      idleReaper = null
      gatt?.let { try { it.disconnect(); it.close() } catch (e: Exception) { /* gone */ } }
      gatt = null
    }

    fun writeMessage(message: ByteArray, onDrained: () -> Unit) {
      writeQueue = BleGattProfile.chunk(BleGattProfile.lengthPrefixed(message), mtu)
      onWriteQueueDrained = onDrained
      writeNextChunk()
    }

    fun writeNextChunk() {
      val g = gatt ?: return
      val characteristic = frameCharacteristic ?: return
      val chunk = writeQueue.firstOrNull()
      if (chunk == null) {
        val drained = onWriteQueueDrained
        onWriteQueueDrained = null
        drained?.invoke()
        return
      }
      val status = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          g.writeCharacteristic(characteristic, chunk, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
        } else {
          characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
          characteristic.value = chunk
          if (g.writeCharacteristic(characteristic)) BluetoothStatusCodes.SUCCESS else WRITE_REJECTED_LEGACY
        }
      } catch (e: Exception) {
        WRITE_REJECTED_LEGACY
      }
      if (status == BluetoothStatusCodes.SUCCESS) {
        writeQueue.removeFirst()
      } else if (status == BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY) {
        main.postDelayed({ writeNextChunk() }, WRITE_BUSY_RETRY_MS)
      } else {
        disconnectAndRescan("write rejected by the stack (status $status)")
      }
    }

    fun onIndication(value: ByteArray) {
      val messages = try {
        reassembler.feed(value)
      } catch (e: RuntimeException) {
        reassembler.reset()
        disconnectAndRescan("bad framing from peer: ${e.message}")
        return
      }
      for (message in messages) onMessage(message)
    }

    private fun onMessage(message: ByteArray) {
      if (message.isEmpty()) return
      when {
        message[0] == TYPE_HELLO_A && !helloVerified -> {
          val proof = message.copyOfRange(1, message.size)
          if (!BleGattProfile.constantTimeEquals(proof, BleGattProfile.proof(psk, instanceName, TYPE_HELLO_A))) {
            disconnectAndRescan("HELLO_A proof failed")
            return
          }
          helloVerified = true
          Log.d(TAG, "payee(scan): HELLO_A verified; writing HELLO_B (mtu $mtu)")
          writeMessage(BleGattProfile.helloB(psk, instanceName)) {}
        }
        message[0] == TYPE_FRAME && helloVerified && !pendingAck -> {
          val sealed = message.copyOfRange(1, message.size)
          if (sealed.isEmpty()) {
            disconnectAndRescan("empty frame")
            return
          }
          if (hasAccepted) {
            // The advertised link already delivered a frame: refuse silently, this payer times out to its fountain.
            disconnectAndRescan("already accepted on the other link")
            return
          }
          hasAccepted = true
          pendingAck = true
          idleReaper?.let { main.removeCallbacks(it) }
          idleReaper = null
          stopAdvertising()
          armAckReaperForScan()
          Log.d(TAG, "payee(scan): frame accepted (${sealed.size} bytes, mtu $mtu); advertising and scanning stopped")
          onFrame(Base64.encodeToString(sealed, Base64.NO_WRAP))
        }
        else -> Log.d(TAG, "payee(scan): unexpected message type=${message[0].toInt() and 0xff} ignored")
      }
    }

    private fun armAckReaperForScan() {
      cancelAckReaper()
      lateinit var reaper: Runnable
      reaper = Runnable {
        if (ackReaper !== reaper || !pendingAck) return@Runnable
        ackReaper = null
        pendingAck = false
        Log.d(TAG, "payee(scan): ack reaper fired; connection released")
        tearDown()
        onError("payee never confirmed the payment; connection released")
      }
      ackReaper = reaper
      main.postDelayed(reaper, PENDING_ACK_TIMEOUT_MS)
    }
  }

  private var scan: InboundScan? = null
```

- [ ] **Step 2: Replace the inert `startScanning` stub**

```kotlin
  override fun startScanning(
    instanceName: String,
    pskBase64: String,
    onFrame: (String) -> Unit,
    onError: (String) -> Unit
  ): Promise<Unit> {
    val promise = Promise<Unit>()
    main.post {
      val psk = try { Base64.decode(pskBase64, Base64.DEFAULT) } catch (e: Exception) { null }
      if (psk == null || psk.isEmpty() || instanceName.isEmpty()) {
        promise.reject(Error("bad psk or instance name"))
        return@post
      }
      val ctx = context()
      val a = adapter()
      if (ctx == null || a == null || !hasBleHardware() || !a.isEnabled || a.bluetoothLeScanner == null || !canScan() || !canConnect()) {
        promise.reject(Error("bluetooth unavailable"))
        return@post
      }
      scan?.tearDown()
      val s = InboundScan(instanceName, psk, onFrame, onError)
      scan = s
      s.gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
          main.post {
            if (scan !== s) return@post
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
              Log.d(TAG, "payee(scan): connected to ${g.device.address}; requesting mtu $REQUESTED_MTU")
              val reaper = Runnable { if (scan === s && !s.pendingAck) s.disconnectAndRescan("idle central reaper") }
              s.idleReaper = reaper
              main.postDelayed(reaper, IDLE_CONNECTION_TIMEOUT_MS)
              if (!g.requestMtu(REQUESTED_MTU)) g.discoverServices()
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
              if (s.pendingAck) {
                // The payer left before the ack: the hold goes with it so confirmFrame reports the failure.
                s.pendingAck = false
                cancelAckReaper()
                s.tearDown()
                s.onError("peer disconnected before acking")
              } else {
                s.disconnectAndRescan("central disconnected (status $status)")
              }
            }
          }
        }
        override fun onMtuChanged(g: BluetoothGatt, newMtu: Int, status: Int) {
          main.post {
            if (scan !== s) return@post
            if (status == BluetoothGatt.GATT_SUCCESS) s.mtu = newMtu
            if (!g.discoverServices()) s.disconnectAndRescan("service discovery could not start")
          }
        }
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
          main.post {
            if (scan !== s) return@post
            val svc = if (status == BluetoothGatt.GATT_SUCCESS) g.getService(s.serviceUuid) else null
            val frame = svc?.getCharacteristic(FRAME_CHAR_UUID)
            val ack = svc?.getCharacteristic(ACK_CHAR_UUID)
            val cccd = ack?.getDescriptor(CCCD_UUID)
            if (frame == null || ack == null || cccd == null) {
              s.disconnectAndRescan("session service not found on peer")
              return@post
            }
            s.frameCharacteristic = frame
            g.setCharacteristicNotification(ack, true)
            val ok = try {
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_INDICATION_VALUE) == BluetoothStatusCodes.SUCCESS
              } else {
                cccd.value = BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                g.writeDescriptor(cccd)
              }
            } catch (e: Exception) { false }
            if (!ok) s.disconnectAndRescan("could not subscribe to the peer's ACK characteristic")
          }
        }
        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
          main.post {
            if (scan !== s || descriptor.uuid != CCCD_UUID) return@post
            if (status != BluetoothGatt.GATT_SUCCESS) s.disconnectAndRescan("subscribe failed: status $status")
            else Log.d(TAG, "payee(scan): subscribed to ACK; awaiting HELLO_A")
          }
        }
        override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
          main.post {
            if (scan !== s || characteristic.uuid != FRAME_CHAR_UUID) return@post
            if (status != BluetoothGatt.GATT_SUCCESS) {
              if (s.pendingAck) {
                s.pendingAck = false
                cancelAckReaper()
                s.tearDown()
                s.onError("peer disconnected before acking")
              } else s.disconnectAndRescan("write failed: gatt status $status")
              return@post
            }
            s.writeNextChunk()
          }
        }
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
          if (characteristic.uuid != ACK_CHAR_UUID) return
          val copy = value.copyOf()
          main.post { if (scan === s) s.onIndication(copy) }
        }
        @Deprecated("Deprecated in Java")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
          if (characteristic.uuid != ACK_CHAR_UUID) return
          val copy = characteristic.value?.copyOf() ?: return
          main.post { if (scan === s) s.onIndication(copy) }
        }
      }
      s.scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
          main.post {
            if (scan !== s || s.gatt != null) return@post
            s.stopScan()
            Log.d(TAG, "payee(scan): found ${result.device.address} (rssi ${result.rssi}); connecting")
            val g = result.device.connectGatt(ctx, false, s.gattCallback, BluetoothDevice.TRANSPORT_LE)
            s.gatt = g
            if (g == null) s.startScan()
          }
        }
        override fun onScanFailed(errorCode: Int) {
          main.post {
            if (scan !== s) return@post
            s.scanning = false
            s.onError("scan failed: code $errorCode")
          }
        }
      }
      s.startScan()
      if (s.scanning) promise.resolve(Unit) else promise.reject(Error("bluetooth unavailable"))
    }
    return promise
  }
```

- [ ] **Step 3: Route `confirmFrame` and teardown through the scan link**

In `confirmFrame`, make the first statements of the `main.post` block:

```kotlin
      val s = scan
      if (s != null && s.pendingAck) {
        cancelAckReaper()
        s.pendingAck = false
        val json = BleGattProfile.ackJson(accepted, reason).toByteArray(Charsets.UTF_8)
        val t0 = SystemClock.elapsedRealtime()
        if (s.gatt == null || s.frameCharacteristic == null) {
          Log.d(TAG, "payee(scan): confirmFrame with no ack route; peer is gone")
          s.tearDown()
          promise.reject(Error("peer disconnected before acking"))
          return@post
        }
        s.writeMessage(BleGattProfile.ackMessage(s.psk, s.instanceName, json)) {
          Log.d(TAG, "payee(scan): ack ok=$accepted written in ${SystemClock.elapsedRealtime() - t0} ms")
          s.tearDown()
          promise.resolve(Unit)
        }
        return@post
      }
```

A write failure while the ACK is queued reaches `onCharacteristicWrite` with `pendingAck == false` already; so ALSO change that callback's failure branch to reject the confirm promise: store the promise on the scan object — add `var ackPromise: Promise<Unit>? = null` to `InboundScan`, set `s.ackPromise = promise` before `s.writeMessage(...)` above, resolve it in the drained callback (`s.ackPromise?.resolve(Unit); s.ackPromise = null` instead of `promise.resolve(Unit)`), and in `onCharacteristicWrite`'s failure branch add before `s.disconnectAndRescan(...)`: `s.ackPromise?.let { it.reject(Error("peer disconnected before acking")); s.ackPromise = null; s.tearDown(); return@post }`.

In `stopListening`'s `main.post`, add `scan?.tearDown(); scan = null` before `resetSession("listening stopped")`. In `startListening`, add `scan?.tearDown(); scan = null` right after the `resetSession("superseded by a new startListening")` line ONLY IF the caller is not about to call `startScanning` — JS calls `startListening` first and `startScanning` second (Task 8), so do NOT tear the scan down there; instead, in `startScanning` the existing `scan?.tearDown()` handles a stale scan. In `handleCentralMessage`'s `TYPE_FRAME` branch (advertised link accepts a frame), add after `stopAdvertising()`: `scan?.tearDown()` — the loser link is torn down the instant the other wins.

- [ ] **Step 4: Compile**

Run the Kotlin compile check.
Expected: `BUILD SUCCESSFUL`, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/react-native-localpay-transport/android
git commit -m "feat(ble): Android payee can scan and connect as the central (symmetric twin)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Swift payee as central — `InboundScan` + engine routing + `confirmFrame` over the scan link

**Files:**
- Modify: `packages/react-native-localpay-transport/ios/HybridLocalPayBleTransport.swift`

**Interfaces:**
- Consumes: `BleEngine.queue`, `centralManager`, `listening: ListenSession?`, `ListenSession.hasAccepted`, `armAckReaper` pattern, `OutboundSend` routing in `CBCentralManagerDelegate`.
- Produces: `startScanning` per the Nitro contract; `ListenSession.scanPendingAck: InboundScan?`; `confirmFrame` writes the ACK via `InboundScan.writeAck(_:completion:)`.

- [ ] **Step 1: Add the scan link class**

After `private struct PrepareWaiter { … }` add:

```swift
// MARK: - Reversed role: payee as central (spec 2026-09-03 §5)

/// Scan → connect → discover → subscribe → HELLO_A (indication) → HELLO_B
/// (write) → FRAME (indications) → hold → ACK (write with response).
/// Callbacks arrive on `engine.queue`. Owned by `BleEngine.activeScan`; the
/// first-success-wins latch is the ListenSession's, shared with the
/// advertised link.
private final class InboundScan: NSObject, CBPeripheralDelegate {
  private enum Stage { case scanning, connecting, discoveringServices, discoveringCharacteristics, subscribing, awaitingHelloA, writingHelloB, awaitingFrame, holding, writingAck, done }

  private weak var engine: BleEngine?
  private let queue: DispatchQueue
  let instanceName: String
  let psk: Data
  let serviceUuid: CBUUID
  let onFrame: (String) -> Void
  let onError: (String) -> Void

  private var stage: Stage = .scanning
  private(set) var isScanning = false
  private(set) var peripheral: CBPeripheral?
  private var frameChar: CBCharacteristic?
  private var reassembler = BleGattProfile.Reassembler()
  private var writeChunks: [Data] = []
  private var writeCompletion: ((Bool) -> Void)?
  private var idleReaper: DispatchWorkItem?
  private let startedAt = DispatchTime.now()

  init(engine: BleEngine, instanceName: String, psk: Data,
       onFrame: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
    self.engine = engine
    self.queue = engine.queue
    self.instanceName = instanceName
    self.psk = psk
    self.serviceUuid = BleGattProfile.serviceUuid(psk: psk, instanceName: instanceName)
    self.onFrame = onFrame
    self.onError = onError
    super.init()
  }

  private func elapsedMs() -> Int {
    Int((DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000)
  }

  private static func writeChunkSize(for p: CBPeripheral) -> Int {
    min(p.maximumWriteValueLength(for: .withoutResponse), p.maximumWriteValueLength(for: .withResponse))
  }

  /// Runs on `queue`. Starts scanning if the manager is powered on; otherwise waits for managerStateChanged.
  func start() -> Bool {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let cm = engine?.centralManager else { return false }
    switch cm.state {
    case .poweredOn:
      scan(cm)
      return true
    case .unknown, .resetting:
      return true
    case .unauthorized where CBManager.authorization == .notDetermined:
      return true
    default:
      return false
    }
  }

  private func scan(_ cm: CBCentralManager) {
    guard stage == .scanning, !isScanning else { return }
    isScanning = true
    cm.scanForPeripherals(withServices: [serviceUuid], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    os_log("payee(scan): scanning service=%{public}@", log: bleLog, type: .default, serviceUuid.uuidString)
  }

  /// Drop the current peripheral (a stranger, a bad proof, a mid-handshake disconnect) and scan again.
  private func rescan(_ reason: String) {
    dispatchPrecondition(condition: .onQueue(queue))
    os_log("payee(scan): %{public}@; rescanning", log: bleLog, type: .default, reason)
    idleReaper?.cancel(); idleReaper = nil
    if let p = peripheral, let cm = engine?.centralManager, p.state != .disconnected { cm.cancelPeripheralConnection(p) }
    peripheral = nil; frameChar = nil
    reassembler = BleGattProfile.Reassembler()
    writeChunks = []; writeCompletion = nil
    stage = .scanning
    if let cm = engine?.centralManager { scan(cm) }
  }

  /// Full stop: called by the engine when the advertised link won, on stopListening, or after the ack.
  func tearDown() {
    dispatchPrecondition(condition: .onQueue(queue))
    idleReaper?.cancel(); idleReaper = nil
    if let cm = engine?.centralManager {
      if isScanning { cm.stopScan() }
      if let p = peripheral, p.state != .disconnected { cm.cancelPeripheralConnection(p) }
    }
    isScanning = false
    peripheral = nil
    stage = .done
    writeCompletion?(false); writeCompletion = nil
  }

  var isHolding: Bool { stage == .holding }

  // MARK: central manager events (forwarded by BleEngine)

  func managerStateChanged(_ state: CBManagerState) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard stage == .scanning, let cm = engine?.centralManager else { return }
    switch state {
    case .poweredOn: scan(cm)
    case .unknown, .resetting: break
    case .unauthorized where CBManager.authorization == .notDetermined: break
    default:
      isScanning = false
      onError("bluetooth unavailable")
    }
  }

  func didDiscover(_ p: CBPeripheral, rssi: NSNumber) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard stage == .scanning, let cm = engine?.centralManager else { return }
    cm.stopScan(); isScanning = false
    stage = .connecting
    peripheral = p
    p.delegate = self
    os_log("payee(scan): scan hit rssi=%d id=%{public}@ ms=%ld", log: bleLog, type: .default, rssi.int32Value, p.identifier.uuidString, elapsedMs())
    let reaper = DispatchWorkItem { [weak self] in
      guard let self, self.stage != .holding, self.stage != .writingAck, self.stage != .done else { return }
      self.rescan("idle central reaper")
    }
    idleReaper = reaper
    queue.asyncAfter(deadline: .now() + .milliseconds(BleGattProfile.idleConnectionTimeoutMs), execute: reaper)
    cm.connect(p, options: nil)
  }

  func didConnect(_ p: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral, stage == .connecting else { return }
    stage = .discoveringServices
    os_log("payee(scan): connected id=%{public}@ chunk=%ld ms=%ld", log: bleLog, type: .default, p.identifier.uuidString, Self.writeChunkSize(for: p), elapsedMs())
    p.discoverServices([serviceUuid])
  }

  func didFailToConnect(_ p: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral else { return }
    rescan("connect failed: \(error?.localizedDescription ?? "unknown")")
  }

  func didDisconnect(_ p: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral else { return }
    switch stage {
    case .holding, .writingAck:
      // The payer left before the ack: release the hold so confirmFrame reports the failure (Swift hardening 2).
      engine?.scanLinkLost(self)
    case .done:
      break
    default:
      rescan("peer disconnected")
    }
  }

  // MARK: CBPeripheralDelegate

  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard stage == .discoveringServices else { return }
    if let error { return rescan(error.localizedDescription) }
    guard let service = p.services?.first(where: { $0.uuid == serviceUuid }) else { return rescan("session service not found on peer") }
    stage = .discoveringCharacteristics
    p.discoverCharacteristics([BleGattProfile.frameCharUuid, BleGattProfile.ackCharUuid], for: service)
  }

  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard stage == .discoveringCharacteristics, service.uuid == serviceUuid else { return }
    if let error { return rescan(error.localizedDescription) }
    let chars = service.characteristics ?? []
    guard let frame = chars.first(where: { $0.uuid == BleGattProfile.frameCharUuid }),
          let ack = chars.first(where: { $0.uuid == BleGattProfile.ackCharUuid }) else {
      return rescan("session characteristics not found on peer")
    }
    frameChar = frame
    stage = .subscribing
    p.setNotifyValue(true, for: ack)
  }

  func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard stage == .subscribing, characteristic.uuid == BleGattProfile.ackCharUuid else { return }
    if let error { return rescan(error.localizedDescription) }
    guard characteristic.isNotifying else { return rescan("peer refused the ack subscription") }
    stage = .awaitingHelloA
    os_log("payee(scan): subscribed ms=%ld; awaiting HELLO_A", log: bleLog, type: .default, elapsedMs())
  }

  func peripheral(_ p: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard characteristic.uuid == BleGattProfile.ackCharUuid else { return }
    if let error { return rescan(error.localizedDescription) }
    guard let value = characteristic.value, !value.isEmpty else { return }
    let messages: [Data]
    do { messages = try reassembler.feed(value) } catch { return rescan("bad framing from peer") }
    for message in messages { handle(message: message, on: p) }
  }

  private func handle(message: Data, on p: CBPeripheral) {
    guard !message.isEmpty else { return }
    let type = message[message.startIndex]
    let body = Data(message.dropFirst())
    switch (type, stage) {
    case (BleGattProfile.typeHelloA, .awaitingHelloA):
      let expected = BleGattProfile.proof(psk: psk, instanceName: instanceName, type: BleGattProfile.typeHelloA)
      guard BleGattProfile.constantTimeEquals(body, expected) else { return rescan("HELLO_A proof failed") }
      os_log("payee(scan): hello verified ms=%ld", log: bleLog, type: .default, elapsedMs())
      stage = .writingHelloB
      write(BleGattProfile.helloB(psk: psk, instanceName: instanceName), on: p) { [weak self] ok in
        guard let self else { return }
        if ok { self.stage = .awaitingFrame } else { self.rescan("HELLO_B write failed") }
      }
    case (BleGattProfile.typeFrame, .awaitingFrame), (BleGattProfile.typeFrame, .writingHelloB):
      guard !body.isEmpty else { return rescan("empty frame") }
      guard let engine, engine.acceptScannedFrame(self) else {
        // The advertised link already won: this payer gets nothing and times out to its fountain.
        return rescan("already accepted on the other link")
      }
      idleReaper?.cancel(); idleReaper = nil
      stage = .holding
      os_log("payee(scan): frame accepted bytes=%ld id=%{public}@", log: bleLog, type: .default, body.count, p.identifier.uuidString)
      onFrame(body.base64EncodedString())
    default:
      os_log("payee(scan): unexpected message ignored type=%d", log: bleLog, type: .default, Int32(type))
    }
  }

  private func write(_ message: Data, on p: CBPeripheral, completion: @escaping (Bool) -> Void) {
    guard let frame = frameChar else { return completion(false) }
    writeChunks = BleGattProfile.chunks(BleGattProfile.lengthPrefixed(message), size: Self.writeChunkSize(for: p))
    writeCompletion = completion
    writeNextChunk(p, frame)
  }

  private func writeNextChunk(_ p: CBPeripheral, _ frame: CBCharacteristic) {
    guard !writeChunks.isEmpty else {
      let done = writeCompletion; writeCompletion = nil
      done?(true)
      return
    }
    p.writeValue(writeChunks.removeFirst(), for: frame, type: .withResponse)
  }

  func peripheral(_ p: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard characteristic.uuid == BleGattProfile.frameCharUuid, let frame = frameChar else { return }
    if error != nil {
      let done = writeCompletion; writeCompletion = nil; writeChunks = []
      done?(false)
      return
    }
    writeNextChunk(p, frame)
  }

  /// The ACK, written with response. `completion(true)` only once the last chunk's write response arrived.
  func writeAck(_ message: Data, completion: @escaping (Bool) -> Void) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard stage == .holding, let p = peripheral else { return completion(false) }
    stage = .writingAck
    write(message, on: p) { [weak self] ok in
      guard let self else { return }
      os_log("payee(scan): ack written ok=%d", log: bleLog, type: .default, ok ? 1 : 0)
      completion(ok)
      self.tearDown()
    }
  }
}
```

- [ ] **Step 2: Engine state, acceptance latch, routing**

In `ListenSession` add after `var pendingAck: InboundCentral?`:

```swift
  /// The scan link whose FRAME went to JS and has not been acknowledged (reversed role). Mutually exclusive with `pendingAck`.
  var scanPendingAck: InboundScan?
```

In `BleEngine`, after `private var activeSend: OutboundSend?` add `private var activeScan: InboundScan?`.

Replace the Task 3 `startScanning` stub with:

```swift
  func startScanning(
    instanceName: String, pskBase64: String,
    onFrame: @escaping (String) -> Void, onError: @escaping (String) -> Void
  ) -> Promise<Void> {
    let promise = Promise<Void>()
    guard let psk = Data(base64Encoded: pskBase64), !instanceName.isEmpty else {
      promise.reject(withError: BleGattProfile.error("bad psk or instance name", code: 10))
      return promise
    }
    queue.sync {
      self.ensureManagers()
      self.activeScan?.tearDown()
      let scan = InboundScan(engine: self, instanceName: instanceName, psk: psk, onFrame: onFrame, onError: onError)
      self.activeScan = scan
      if scan.start() {
        promise.resolve(withResult: ())
      } else {
        self.activeScan = nil
        promise.reject(withError: BleGattProfile.error("bluetooth unavailable", code: 16))
      }
    }
    return promise
  }

  /// Called by InboundScan on `queue` when a FRAME is complete. Returns false if the advertised link already won.
  fileprivate func acceptScannedFrame(_ scan: InboundScan) -> Bool {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let session = listening, !session.hasAccepted, activeScan === scan else { return false }
    session.hasAccepted = true
    if let pm = peripheralManager, pm.isAdvertising { pm.stopAdvertising() }
    // The advertised link lost: forget every central it holds.
    for entry in Array(session.centrals.values) { forget(entry, in: session) }
    session.scanPendingAck = scan
    let item = DispatchWorkItem { [weak self] in
      guard let self, let session = self.listening, session.scanPendingAck === scan else { return }
      session.scanPendingAck = nil
      session.pendingAckTimeout = nil
      scan.tearDown()
      self.activeScan = nil
      os_log("ack reaper fired; connection released", log: bleLog, type: .default)
      session.onError("payee never confirmed the payment; connection released")
    }
    session.pendingAckTimeout = item
    queue.asyncAfter(deadline: .now() + .milliseconds(BleGattProfile.pendingAckTimeoutMs), execute: item)
    return true
  }

  /// Called by InboundScan when the held payer disconnected before the ack.
  fileprivate func scanLinkLost(_ scan: InboundScan) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let session = listening, session.scanPendingAck === scan else { return }
    session.scanPendingAck = nil
    session.pendingAckTimeout?.cancel(); session.pendingAckTimeout = nil
    scan.tearDown()
    activeScan = nil
  }
```

In `handle(message:from:in:)`'s `case (BleGattProfile.typeFrame, .bound)` branch, right after `if let pm = peripheralManager, pm.isAdvertising { pm.stopAdvertising() }`, add:

```swift
      // The advertised link won: the scan link (reversed role) is torn down now.
      activeScan?.tearDown()
      activeScan = nil
```

In `resetListening()`, after `indicationQueue.removeAll()`, add `activeScan?.tearDown(); activeScan = nil`. (`startListening` calls `resetListening()` first; JS calls `startListening` BEFORE `startScanning`, so the fresh scan survives.)

In `confirmFrame`, after `session.pendingAckTimeout = nil` and BEFORE `guard let target = session.pendingAck else {`, insert:

```swift
      if let scan = session.scanPendingAck {
        session.scanPendingAck = nil
        let json = accepted ? BleGattProfile.okJson : BleGattProfile.declineJson(reason: reason)
        let message = BleGattProfile.ackMessage(psk: session.psk, instanceName: session.instanceName, ackJson: Data(json.utf8))
        session.closing = true
        scan.writeAck(message) { [weak self] ok in
          guard let self else { return }
          self.activeScan = nil
          if ok {
            os_log("ack sent ok=%d bytes=%ld via scan link", log: bleLog, type: .default, accepted ? 1 : 0, message.count)
            promise.resolve(withResult: ())
          } else {
            promise.reject(withError: BleGattProfile.error("peer disconnected before acking", code: 21))
          }
          self.resetListening()
        }
        return
      }
```

Also in `confirmFrame`'s existing `guard let target = session.pendingAck else { promise.resolve…; return }` — keep as is; the scan branch returns before it.

In the `CBCentralManagerDelegate` extension, route to both objects:

```swift
  func centralManagerDidUpdateState(_ cm: CBCentralManager) {
    dispatchPrecondition(condition: .onQueue(queue))
    os_log("central manager state=%{public}@", log: bleLog, type: .default, Self.describe(cm.state))
    stateChanged(cm.state)
    activeSend?.managerStateChanged(cm.state)
    activeScan?.managerStateChanged(cm.state)
  }

  func centralManager(_ cm: CBCentralManager, didDiscover peripheral: CBPeripheral,
                      advertisementData: [String: Any], rssi RSSI: NSNumber) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didDiscover(peripheral, rssi: RSSI)
    activeScan?.didDiscover(peripheral, rssi: RSSI)
  }

  func centralManager(_ cm: CBCentralManager, didConnect peripheral: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didConnect(peripheral)
    activeScan?.didConnect(peripheral)
  }

  func centralManager(_ cm: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didFailToConnect(peripheral, error: error)
    activeScan?.didFailToConnect(peripheral, error: error)
  }

  func centralManager(_ cm: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didDisconnect(peripheral, error: error)
    activeScan?.didDisconnect(peripheral, error: error)
  }
```

(`OutboundSend` and `InboundScan` each guard `p === peripheral` / stage, so the double dispatch is harmless; a device never pays and receives at once.)

- [ ] **Step 3: Compile**

Run the Swift compile check.
Expected: `BUILD SUCCEEDED`.

- [ ] **Step 4: Commit**

```bash
git add packages/react-native-localpay-transport/ios/HybridLocalPayBleTransport.swift
git commit -m "feat(ble): iOS payee scans and connects as the central in the reversed role

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Swift payer as peripheral — `PayerAdvertise` + `sendFrameAdvertising` (symmetric implementation)

**Files:**
- Modify: `packages/react-native-localpay-transport/ios/HybridLocalPayBleTransport.swift`

**Interfaces:**
- Consumes: `peripheralManager`, `enqueueIndication`/`flushIndications`, `indicationQueue`, `CBPeripheralManagerDelegate` callbacks.
- Produces: `sendFrameAdvertising` per the Nitro contract; `BleEngine.activePayer: PayerAdvertise?` consulted first in every peripheral-manager callback.

Not on the hardware checklist (the ladder never puts an iOS payer in the peripheral role today), but required for backend symmetry.

- [ ] **Step 1: Add the class**

After `InboundScan` add:

```swift
// MARK: - Reversed role: payer as peripheral (spec 2026-09-03 §4, iOS twin)

private final class PayerAdvertise {
  let instanceName: String
  let psk: Data
  let sealed: Data
  let serviceUuid: CBUUID
  let promise: Promise<String>
  var service: CBMutableService?
  var ackChar: CBMutableCharacteristic?
  /** The central that subscribed first and received HELLO_A. */
  var candidate: CBCentral?
  /** Set once HELLO_B verified. */
  var bound: CBCentral?
  var frameOnWire = false
  var reassemblers: [UUID: BleGattProfile.Reassembler] = [:]
  var settled = false
  var connectTimeout: DispatchWorkItem?
  var wholeTimeout: DispatchWorkItem?
  let startedAt = DispatchTime.now()

  init(instanceName: String, psk: Data, sealed: Data, promise: Promise<String>) {
    self.instanceName = instanceName
    self.psk = psk
    self.sealed = sealed
    self.serviceUuid = BleGattProfile.serviceUuid(psk: psk, instanceName: instanceName)
    self.promise = promise
  }

  func elapsedMs() -> Int { Int((DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000) }
}
```

- [ ] **Step 2: Engine implementation**

In `BleEngine` add `private var activePayer: PayerAdvertise?` after `activeScan`, and replace the Task 3 `sendFrameAdvertising` stub with:

```swift
  func sendFrameAdvertising(
    instanceName: String, pskBase64: String, frameBase64: String,
    timeoutMs: Double, connectTimeoutMs: Double
  ) -> Promise<String> {
    let promise = Promise<String>()
    guard let psk = Data(base64Encoded: pskBase64), let sealed = Data(base64Encoded: frameBase64), !instanceName.isEmpty else {
      promise.reject(withError: BleGattProfile.error("bad psk or frame", code: 11))
      return promise
    }
    guard sealed.count + 1 <= BleGattProfile.maxBleFrameBytes else {
      promise.reject(withError: BleGattProfile.error("frame too large for a BLE payload", code: 30))
      return promise
    }
    queue.sync {
      self.ensureManagers()
      // A payer never listens while it pays; a newer send supersedes an older one.
      self.resetListening()
      if let previous = self.activePayer { self.settlePayer(previous, .failure(BleGattProfile.error("superseded by a newer send", code: 15))) }
      let payer = PayerAdvertise(instanceName: instanceName, psk: psk, sealed: sealed, promise: promise)
      self.activePayer = payer
      let whole = DispatchWorkItem { [weak self] in
        guard let self, let p = self.activePayer, p === payer else { return }
        self.settlePayer(p, .failure(BleGattProfile.error("timed out waiting for peer", code: 12)))
      }
      payer.wholeTimeout = whole
      self.queue.asyncAfter(deadline: .now() + .milliseconds(max(0, Int(timeoutMs))), execute: whole)
      let connect = DispatchWorkItem { [weak self] in
        guard let self, let p = self.activePayer, p === payer, p.candidate == nil else { return }
        self.settlePayer(p, .failure(BleGattProfile.error("connect timeout: no route to peer", code: 14)))
      }
      payer.connectTimeout = connect
      self.queue.asyncAfter(deadline: .now() + .milliseconds(max(0, Int(connectTimeoutMs))), execute: connect)
      self.advertisePayerIfPowered()
    }
    return promise
  }

  private func advertisePayerIfPowered() {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let payer = activePayer, payer.service == nil, let pm = peripheralManager else { return }
    switch pm.state {
    case .poweredOn: break
    case .unknown, .resetting: return
    case .unauthorized where CBManager.authorization == .notDetermined: return
    default:
      settlePayer(payer, .failure(BleGattProfile.error("bluetooth unavailable", code: 16)))
      return
    }
    let frame = CBMutableCharacteristic(type: BleGattProfile.frameCharUuid, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeable])
    let ack = CBMutableCharacteristic(type: BleGattProfile.ackCharUuid, properties: [.indicate], value: nil, permissions: [.readable])
    let service = CBMutableService(type: payer.serviceUuid, primary: true)
    service.characteristics = [frame, ack]
    payer.ackChar = ack
    payer.service = service
    pm.add(service)
  }

  fileprivate func settlePayer(_ payer: PayerAdvertise, _ result: Result<String, Error>) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !payer.settled else { return }
    payer.settled = true
    payer.connectTimeout?.cancel(); payer.wholeTimeout?.cancel()
    if activePayer === payer { activePayer = nil }
    indicationQueue.removeAll()
    if let pm = peripheralManager, pm.state == .poweredOn {
      if pm.isAdvertising { pm.stopAdvertising() }
      pm.removeAllServices()
    }
    switch result {
    case .success(let ack): payer.promise.resolve(withResult: ack)
    case .failure(let error):
      os_log("payer(adv): send failed reason=%{public}@", log: bleLog, type: .default, error.localizedDescription)
      payer.promise.reject(withError: error)
    }
  }

  /// Indication enqueue for the payer role: `flushIndications` needs an ACK characteristic, which it reads from `listening`; the payer keeps its own, so this variant takes it explicitly.
  private func enqueuePayerIndication(_ message: Data, to central: CBCentral, ack: CBMutableCharacteristic, completion: (() -> Void)?) {
    dispatchPrecondition(condition: .onQueue(queue))
    let parts = BleGattProfile.chunks(BleGattProfile.lengthPrefixed(message), size: central.maximumUpdateValueLength)
    for (i, part) in parts.enumerated() {
      indicationQueue.append(Indication(central: central, chunk: part, completion: i == parts.count - 1 ? completion : nil))
    }
    flushPayerIndications(ack)
  }

  private func flushPayerIndications(_ ack: CBMutableCharacteristic) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let pm = peripheralManager else { indicationQueue.removeAll(); return }
    while let next = indicationQueue.first {
      guard pm.updateValue(next.chunk, for: ack, onSubscribedCentrals: [next.central]) else { return }
      indicationQueue.removeFirst()
      next.completion?()
    }
  }

  private func payerHandle(message: Data, from central: CBCentral, payer: PayerAdvertise) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !message.isEmpty, let ack = payer.ackChar else { return }
    let type = message[message.startIndex]
    let body = Data(message.dropFirst())
    let fromCandidate = payer.candidate?.identifier == central.identifier
    if type == BleGattProfile.typeHelloB, payer.bound == nil, fromCandidate {
      let expected = BleGattProfile.proof(psk: payer.psk, instanceName: payer.instanceName, type: BleGattProfile.typeHelloB)
      guard BleGattProfile.constantTimeEquals(body, expected) else {
        os_log("payer(adv): HELLO_B proof failed id=%{public}@", log: bleLog, type: .default, central.identifier.uuidString)
        payer.candidate = nil
        return
      }
      payer.bound = central
      if let pm = peripheralManager, pm.isAdvertising { pm.stopAdvertising() }
      os_log("payer(adv): hello verified ms=%ld; indicating frame bytes=%ld", log: bleLog, type: .default, payer.elapsedMs(), payer.sealed.count)
      enqueuePayerIndication(BleGattProfile.frameMessage(sealed: payer.sealed), to: central, ack: ack) { [weak self, weak payer] in
        guard let payer, !payer.settled else { return }
        payer.frameOnWire = true
        os_log("payer(adv): frame indicated ms=%ld; awaiting ack", log: bleLog, type: .default, payer.elapsedMs())
        _ = self
      }
      return
    }
    if type == BleGattProfile.typeAck, payer.bound?.identifier == central.identifier, payer.bound != nil {
      guard body.count > BleGattProfile.macLength else { return settlePayer(payer, .failure(BleGattProfile.error("peer failed the session proof", code: 22))) }
      let json = Data(body.prefix(body.count - BleGattProfile.macLength))
      let mac = Data(body.suffix(BleGattProfile.macLength))
      guard BleGattProfile.constantTimeEquals(mac, BleGattProfile.ackMac(psk: payer.psk, instanceName: payer.instanceName, ackJson: json)) else {
        return settlePayer(payer, .failure(BleGattProfile.error("peer failed the session proof", code: 22)))
      }
      os_log("payer(adv): ack verified bytes=%ld ms=%ld", log: bleLog, type: .default, json.count, payer.elapsedMs())
      settlePayer(payer, .success(json.base64EncodedString()))
      return
    }
    if payer.frameOnWire {
      os_log("payer(adv): unexpected message ignored type=%d", log: bleLog, type: .default, Int32(type))
    } else if fromCandidate {
      settlePayer(payer, .failure(BleGattProfile.error("peer failed the session proof", code: 22)))
    }
  }
```

- [ ] **Step 3: Route the peripheral-manager callbacks**

In `peripheralManagerDidUpdateState`, after `stateChanged(pm.state)`, add:

```swift
    if let payer = activePayer {
      switch pm.state {
      case .poweredOn: advertisePayerIfPowered()
      case .unknown, .resetting: break
      case .unauthorized where CBManager.authorization == .notDetermined: break
      default: settlePayer(payer, .failure(BleGattProfile.error("bluetooth unavailable", code: 16)))
      }
      return
    }
```

In `peripheralManager(_:didAdd:error:)`, before `guard let session = listening, …`, add:

```swift
    if let payer = activePayer, payer.service?.uuid == service.uuid {
      if let error { return settlePayer(payer, .failure(error)) }
      pm.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [payer.serviceUuid], CBAdvertisementDataLocalNameKey: BleGattProfile.localName])
      return
    }
```

In `peripheralManagerDidStartAdvertising`, before `guard let session = listening else { return }`, add:

```swift
    if let payer = activePayer {
      if let error { return settlePayer(payer, .failure(error)) }
      os_log("payer(adv): advertising started service=%{public}@", log: bleLog, type: .default, payer.serviceUuid.uuidString)
      return
    }
```

In `peripheralManager(_:central:didSubscribeTo:)`, first lines:

```swift
    if let payer = activePayer, characteristic.uuid == BleGattProfile.ackCharUuid, let ack = payer.ackChar {
      guard payer.candidate == nil else { return }
      payer.candidate = central
      payer.connectTimeout?.cancel()
      os_log("payer(adv): central subscribed id=%{public}@ maxUpdate=%ld ms=%ld; indicating HELLO_A", log: bleLog, type: .default, central.identifier.uuidString, central.maximumUpdateValueLength, payer.elapsedMs())
      enqueuePayerIndication(BleGattProfile.helloA(psk: payer.psk, instanceName: payer.instanceName), to: central, ack: ack, completion: nil)
      return
    }
```

In `peripheralManager(_:central:didUnsubscribeFrom:)`, first lines:

```swift
    if let payer = activePayer {
      if payer.bound?.identifier == central.identifier || payer.candidate?.identifier == central.identifier {
        settlePayer(payer, .failure(BleGattProfile.error("peer disconnected before acking", code: 21)))
      }
      return
    }
```

In `peripheralManager(_:didReceiveWrite:)`, after `guard let first = requests.first else { return }`, add:

```swift
    if let payer = activePayer {
      var result: CBATTError.Code = .success
      for request in requests {
        guard request.characteristic.uuid == BleGattProfile.frameCharUuid, let value = request.value, !value.isEmpty else { continue }
        var reassembler = payer.reassemblers[request.central.identifier] ?? BleGattProfile.Reassembler()
        do {
          let messages = try reassembler.feed(value)
          payer.reassemblers[request.central.identifier] = reassembler
          for message in messages { payerHandle(message: message, from: request.central, payer: payer) }
        } catch {
          payer.reassemblers[request.central.identifier] = BleGattProfile.Reassembler()
          result = .invalidAttributeValueLength
        }
      }
      pm.respond(to: first, withResult: result)
      return
    }
```

In `peripheralManagerIsReady(toUpdateSubscribers:)`, replace the body with:

```swift
    if let payer = activePayer, let ack = payer.ackChar { flushPayerIndications(ack); return }
    flushIndications()
```

- [ ] **Step 4: Compile**

Run the Swift compile check.
Expected: `BUILD SUCCEEDED`.

- [ ] **Step 5: Commit**

```bash
git add packages/react-native-localpay-transport/ios/HybridLocalPayBleTransport.swift
git commit -m "feat(ble): iOS payer can advertise and serve GATT (symmetric twin)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: JS — `makeBleTransport` (dual listener, role dispatch) and the payee mint

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/localpay/transport/socket.ts` (exports only)
- Modify: `packages/expo-wallet-toolbox/core/localpay/transport/ble.ts`
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx` (mint args)
- Test: `packages/expo-wallet-toolbox/__tests__/localpay/transportBle.test.ts`

**Interfaces:**
- Consumes: `bleRole` (Task 2), `CAP_BLE_SCAN` (Task 1), Nitro methods (Task 3).
- Produces: `export function makeBleTransport(native: () => LocalPayBleTransport | null, connectTimeoutMs: number): LocalPaymentTransport`; `export const bleTransport = makeBleTransport(getLocalPayBleTransport, BLE_CONNECT_TIMEOUT_MS)`.

- [ ] **Step 1: Write the failing tests**

In `transportBle.test.ts`, extend `fakeNative` with the two new methods:

```ts
    sendFrame: jest.fn(),
    startScanning: jest.fn().mockResolvedValue(undefined),
    sendFrameAdvertising: jest.fn(),
    ...overrides,
```

Add `import { Platform } from 'react-native'` and `import { CAP_BLE_SCAN } from '../../core/localpay/session'`, and a new `describe` at the end:

```ts
describe('bleTransport reversed role', () => {
  afterEach(() => {
    Platform.OS = 'ios'
    jest.clearAllMocks()
  })

  const scanning = { ...session, caps: session.caps | CAP_BLE_SCAN }

  it('send() advertises on Android when the payee scans', async () => {
    Platform.OS = 'android'
    const native = fakeNative({
      sendFrameAdvertising: jest.fn().mockResolvedValue(toAckBase64({ ok: true })) as never,
    })
    getLocalPayBleTransport.mockReturnValue(native)
    await expect(bleTransport.send(scanning, frame, new AbortController().signal)).resolves.toEqual({ ok: true })
    expect(native.sendFrameAdvertising).toHaveBeenCalledTimes(1)
    expect(native.sendFrame).not.toHaveBeenCalled()
    expect((native.sendFrameAdvertising as jest.Mock).mock.calls[0].slice(3)).toEqual([30_000, 15_000])
  })

  it('send() stays central on iOS even when the payee scans', async () => {
    Platform.OS = 'ios'
    const native = fakeNative({ sendFrame: jest.fn().mockResolvedValue(toAckBase64({ ok: true })) as never })
    getLocalPayBleTransport.mockReturnValue(native)
    await bleTransport.send(scanning, frame, new AbortController().signal)
    expect(native.sendFrame).toHaveBeenCalledTimes(1)
    expect(native.sendFrameAdvertising).not.toHaveBeenCalled()
  })

  it('send() stays central on Android when the payee does not scan', async () => {
    Platform.OS = 'android'
    const native = fakeNative({ sendFrame: jest.fn().mockResolvedValue(toAckBase64({ ok: true })) as never })
    getLocalPayBleTransport.mockReturnValue(native)
    await bleTransport.send(session, frame, new AbortController().signal)
    expect(native.sendFrame).toHaveBeenCalledTimes(1)
    expect(native.sendFrameAdvertising).not.toHaveBeenCalled()
  })

  it('receive() starts the advertised listener and the scan on iOS, with the same session args', async () => {
    Platform.OS = 'ios'
    const startListening = jest.fn(() => Promise.resolve())
    const startScanning = jest.fn(() => Promise.resolve())
    const native = fakeNative({ startListening: startListening as never, startScanning: startScanning as never })
    getLocalPayBleTransport.mockReturnValue(native)
    const controller = new AbortController()
    const pending = bleTransport.receive(session, controller.signal)
    await Promise.resolve()
    expect(startListening).toHaveBeenCalledTimes(1)
    expect(startScanning).toHaveBeenCalledTimes(1)
    expect(startScanning.mock.calls[0][0]).toBe(instanceName(session.sessionId))
    expect(startScanning.mock.calls[0][1]).toBe(toBase64(session.psk))
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
  })

  it('receive() never scans on Android', async () => {
    Platform.OS = 'android'
    const startScanning = jest.fn(() => Promise.resolve())
    const native = fakeNative({ startListening: jest.fn(() => Promise.resolve()) as never, startScanning: startScanning as never })
    getLocalPayBleTransport.mockReturnValue(native)
    const controller = new AbortController()
    const pending = bleTransport.receive(session, controller.signal)
    await Promise.resolve()
    expect(startScanning).not.toHaveBeenCalled()
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
  })

  it('a failing scan start is logged, not terminal: the advertised listener still delivers', async () => {
    Platform.OS = 'ios'
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const startListening = jest.fn((_n: string, _p: string, onFrame: (f: string) => void) => {
      setTimeout(() => onFrame(toBase64(sealFrame(frame, session.psk))), 0)
      return Promise.resolve()
    })
    const native = fakeNative({
      startListening: startListening as never,
      startScanning: jest.fn().mockRejectedValue(new Error('bluetooth unavailable')) as never,
    })
    getLocalPayBleTransport.mockReturnValue(native)
    const received = await bleTransport.receive(session, new AbortController().signal)
    expect(received.frame.transaction).toEqual(frame.transaction)
    expect(warn).toHaveBeenCalledWith('[localpay] ble scan unavailable:', 'bluetooth unavailable')
    warn.mockRestore()
  })

  it('a frame from the scan link resolves receive() and shares the one confirm handle', async () => {
    Platform.OS = 'ios'
    const startScanning = jest.fn((_n: string, _p: string, onFrame: (f: string) => void) => {
      setTimeout(() => onFrame(toBase64(sealFrame(frame, session.psk))), 0)
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: jest.fn(() => Promise.resolve()) as never, startScanning: startScanning as never })
    getLocalPayBleTransport.mockReturnValue(native)
    const received = await bleTransport.receive(session, new AbortController().signal)
    await received.confirm(true)
    await received.confirm(false, 'save_failed')
    expect(native.confirmFrame).toHaveBeenCalledTimes(1)
    expect(native.confirmFrame).toHaveBeenCalledWith(true, '')
    expect(native.stopListening).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/transportBle.test.ts -t "reversed role"`
Expected: FAIL — `sendFrameAdvertising`/`startScanning` never called (the current wrapper only knows the four methods).

- [ ] **Step 3: Export the socket helpers**

In `socket.ts`, change `const SEND_TIMEOUT_MS = 30_000` to `export const SEND_TIMEOUT_MS = 30_000`, and prefix `function toBase64`, `function fromBase64`, `function parseAck`, `function makeConfirm`, `function declineQuietly` with `export`. No behaviour change.

- [ ] **Step 4: Rewrite `ble.ts`**

Replace the file's body below the `BLE_CONNECT_TIMEOUT_MS` doc comment and constant with:

```ts
import { Platform } from 'react-native'
import { getLocalPayBleTransport, type LocalPayBleTransport } from 'react-native-localpay-transport'
import { unsealFrame, sealFrame, type PaymentFrame } from '../codec'
import { instanceName, type Session } from '../session'
import type { Ack, LocalPaymentTransport, ReceivedFrame } from '../types'
import { bleRole } from './select'
import { SEND_TIMEOUT_MS, declineQuietly, fromBase64, makeConfirm, parseAck, toBase64 } from './socket'

/**
 * The BLE rung. Unlike the AWDL/Nearby wrapper this one knows two roles (spec
 * 2026-09-03): the payee listens on BOTH the advertised link (startListening)
 * and, on iOS, the scan link (startScanning); the payer advertises instead of
 * connecting when bleRole() says so. Frame decoding, the single-shot confirm
 * handle and the never-stop-on-success discipline are socket.ts's, reused.
 */
export function makeBleTransport(
  native: () => LocalPayBleTransport | null,
  connectTimeoutMs: number
): LocalPaymentTransport {
  return {
    kind: 'ble',

    receive(session: Session, signal: AbortSignal): Promise<ReceivedFrame> {
      const backend = native()
      if (!backend) return Promise.reject(new Error('ble transport unavailable'))
      if (signal.aborted) return Promise.reject(new Error('cancelled'))
      const name = instanceName(session.sessionId)
      const psk = toBase64(session.psk)

      return new Promise<ReceivedFrame>((resolve, reject) => {
        let settled = false
        // Same contract as socket.ts: teardown is FALSE on the success path,
        // because the native side already cancelled the loser and is holding
        // the winner's link open for confirmFrame().
        const finish = (teardown: boolean, fn: () => void) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          if (teardown) void backend.stopListening().catch(() => {})
          fn()
        }
        const onAbort = () => finish(true, () => reject(new Error('cancelled')))
        signal.addEventListener('abort', onAbort)

        // One frame handler for both links: the native latch guarantees only
        // one of them ever fires it.
        const onFrame = (frameBase64: string) => {
          let frame: PaymentFrame
          try {
            frame = unsealFrame(fromBase64(frameBase64), session.psk)
          } catch (e) {
            declineQuietly(backend, 'decode_failed')
            return finish(false, () => reject(e))
          }
          finish(false, () => resolve({ frame, confirm: makeConfirm(backend) }))
        }
        const onError = (message: string) => finish(true, () => reject(new Error(message)))

        backend
          .startListening(name, psk, onFrame, onError)
          .then(() => {
            // Reversed role: only where this device's central is trusted
            // against a peer that advertises. A scan that cannot start leaves
            // the advertised listener serving iOS payers, so it is logged, not
            // terminal. Started AFTER startListening resolves: the native
            // self-reset inside startListening would otherwise tear it down.
            if (Platform.OS !== 'ios' || settled) return
            return backend.startScanning(name, psk, onFrame, onError).catch((e: unknown) => {
              console.warn('[localpay] ble scan unavailable:', e instanceof Error ? e.message : String(e))
            })
          })
          .catch(e => finish(true, () => reject(e)))
      })
    },

    send(session: Session, frame: PaymentFrame, signal: AbortSignal): Promise<Ack> {
      const backend = native()
      if (!backend) return Promise.reject(new Error('ble transport unavailable'))
      if (signal.aborted) return Promise.reject(new Error('cancelled'))
      const args = [
        instanceName(session.sessionId),
        toBase64(session.psk),
        toBase64(sealFrame(frame, session.psk)),
        SEND_TIMEOUT_MS,
        connectTimeoutMs,
      ] as const

      return new Promise<Ack>((resolve, reject) => {
        let settled = false
        const cleanup = () => signal.removeEventListener('abort', onAbort)
        const onAbort = () => {
          if (settled) return
          settled = true
          cleanup()
          reject(new Error('cancelled'))
        }
        signal.addEventListener('abort', onAbort)
        const pending =
          bleRole(session) === 'peripheral' ? backend.sendFrameAdvertising(...args) : backend.sendFrame(...args)
        pending.then(
          ackBase64 => {
            if (settled) return
            settled = true
            cleanup()
            try {
              resolve(parseAck(ackBase64))
            } catch (e) {
              reject(e)
            }
          },
          e => {
            if (settled) return
            settled = true
            cleanup()
            reject(e)
          }
        )
      })
    },
  }
}

/**
 * A separate HybridObject from the AWDL/Nearby one. That is load-bearing for
 * the payee's multi-listener: aborting this rung runs ITS native
 * stopListening(), which can never touch the other radio's held ack
 * connection.
 */
export const bleTransport = makeBleTransport(getLocalPayBleTransport, BLE_CONNECT_TIMEOUT_MS)
```

Remove the now-unused `import { makeSocketTransport } from './socket'` line. Check `react-native-localpay-transport`'s `src/index.ts` already exports `type LocalPayBleTransport` (it does).

- [ ] **Step 5: Mint the scan bit in NearbyFlow**

In `NearbyFlow.tsx`'s `startRequest`, in the `mintSession({ … })` call, after `supportsBle: bleLive,` add:

```ts
        // Reversed role (spec 2026-09-03): an iOS payee also scans for a payer
        // that advertises, so an Android payer never has to be the central.
        // ble.ts starts that scan alongside the advertised listener.
        supportsBleScan: bleLive && Platform.OS === 'ios',
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay packages/expo-wallet-toolbox/__tests__/ui/payScreen.test.tsx packages/expo-wallet-toolbox/__tests__/pay/nearbyRail.test.ts` then the toolbox typecheck.
Expected: PASS (all, including the pre-existing `bleTransport.send`/`receive` suites); typecheck prints nothing.

- [ ] **Step 7: Commit**

```bash
git add packages/expo-wallet-toolbox/core/localpay/transport/socket.ts packages/expo-wallet-toolbox/core/localpay/transport/ble.ts packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx packages/expo-wallet-toolbox/__tests__/localpay/transportBle.test.ts
git commit -m "feat(localpay): BLE transport listens on both links and picks the payer role

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(The two `[localpay][diag]` lines in `NearbyFlow.tsx` are still present after this commit — stage only the hunk with `supportsBleScan` (`git add -p`), or remove the diag lines here and skip that part of Task 9.)

---

### Task 9: Housekeeping, docs, and the device run

**Files:**
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx` (remove the two `// TEMP DIAG` lines and their `console.log`)
- Modify: `docs/superpowers/2026-09-02-ble-hardware-log.md`
- Modify: `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md` (header pointer)

- [ ] **Step 1: Remove the diag lines**

Delete the two blocks in `NearbyFlow.tsx`:

```ts
      // TEMP DIAG (remove before commit)
      console.log(`[localpay][diag] payee minted caps=0x${session.caps.toString(16)} …`)
```

and

```ts
    // TEMP DIAG (remove before commit)
    console.log(`[localpay][diag] payer adopted caps=0x${session.caps.toString(16)} …`)
```

Run: `grep -n "diag" packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx` → expected no output. Run `npx jest packages/expo-wallet-toolbox/__tests__/ui/payScreen.test.tsx` → PASS.

- [ ] **Step 2: Record today's evidence and the new rows in the hardware log**

In `docs/superpowers/2026-09-02-ble-hardware-log.md`, in the Android (Task 9) table, replace the `Android B → iOS (payer B) — run first` row with these two rows and add the reversed-role rows:

```markdown
| Android TIGER 13 → iOS 15 Pro (payer Android, central) — 2026-09-03 13:29 | 517 on the link, app stayed at 23 (late `onMtuChanged` dropped) | n/a (iOS payee) | 5477 | 41 (HELLO_A only) | never confirmed | n/a | — | **fail**: `timed out waiting for peer` at 30 s. HELLO_A Write Request sent by the stack, never seen by iPhone `bluetoothd`; link-layer desync — iPhone applied Android's connection updates 4.4 s and 86 s late, PHY update `status 42` (Instant Passed). See spec 2026-09-03. |
| Android TIGER 13 → iOS 15 Pro (payer Android, central, late-MTU + 1M-PHY experiment) — 2026-09-03 14:21 | 23 (MTU response never arrived) | n/a | never | — | — | n/a | — | **fail**: `connect timeout: no route to peer` at 15 s; discovery stalled the whole run; iPhone applied the 7.5 ms update 10.5 s late; PHY `status 42` again. Experiment closed; reversed role adopted. |
| Android (payer, **peripheral**) → iOS (payee, **central**) — reversed role, run first | payer log `mtu N` | payee log `chunk=` | payee `subscribed ms=` | `frame indicated` bytes | `frame indicated in <t> ms` | `ack written ok=1` | payer `ack verified; total <T> ms` | pending — Tasks 4/6/8 build |
| Android (payer, peripheral) → iOS (payee, central), payee screen locked mid-wait | — | — | — | — | — | — | — | pending — record whether the iOS scan in background still hits the Android advert |
```

Under "### Negative cases" add:

```markdown
| Second payer, same QR, reversed role | second Android payer advertises; iOS payee (already accepted) refuses at FRAME, second payer times out to its fountain, JS answers `already_paid` | pending |
```

- [ ] **Step 3: Cross-reference the amending spec**

In `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md`, after the `**Amends:**` line, add:

```markdown
**Amended by:** `2026-09-03-ble-reversed-role-design.md` (§2 roles, §3 message carriers, §4 `CAP_BLE_SCAN 0x08`, §6 payee dual listener) — Android as central against an iOS peripheral fails below the app; iOS is always the central in cross-OS pairs.
```

- [ ] **Step 4: Commit**

```bash
git add packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx docs/superpowers/2026-09-02-ble-hardware-log.md docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md
git commit -m "docs(ble): record the Android→iOS desync evidence and the reversed-role rows; drop the temp diag logs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: Build both dev clients with the EAS keys**

Run: `cd /Users/personal/git/bsv-wallet && npm run android-dev-physical 2>&1 | tail -3` (≈15 min) and `npm run ios-dev-physical 2>&1 | tail -3`.
Expected: `Build successful` twice with `build-<ts>.apk` / `build-<ts>.ipa` paths.

Install Android (same EAS cert as the installed app, so data survives):

```bash
APK=$(ls -t build-*.apk | head -1); adb -s 192.168.9.95:38887 install -r "$APK"
```

Expected: `Success`. Install the IPA on the iPhone via Finder or `xcrun devicectl device install app --device 43EE228A-B496-5999-9932-E6235D99535B "<unzipped Payload/BSVWallet.app>"`.

- [ ] **Step 6: Device run and log capture**

Start captures (iPhone must be on USB): `adb -s 192.168.9.95:38887 logcat -c; adb -s 192.168.9.95:38887 logcat -v threadtime > /tmp/android-rev.log &` and `idevicesyslog -u 00008130-001E55A01A2A001C > /tmp/iphone-rev.log &`. Then: iPhone Receive → QR; Android scan → Send.

Expected Android (`grep HybridLocalPayBleTransportSpec /tmp/android-rev.log`), in order: `payer: adding service … advertising follows`, `payer: advertising <uuid>`, `payer: central connected`, `payer: mtu N`, `payer: central subscribed … indicating HELLO_A`, `payer: HELLO_B verified … indicating frame`, `payer: frame indicated in <t> ms; awaiting ack`, `payer: ack verified; total <T> ms`. Expected iPhone (`grep -E "BSVWallet\[[0-9]+\] <Notice>" /tmp/iphone-rev.log`): `advertising started`, `payee(scan): scanning service=`, `payee(scan): scan hit`, `payee(scan): connected`, `payee(scan): subscribed … awaiting HELLO_A`, `payee(scan): hello verified`, `payee(scan): frame accepted`, `ack sent ok=1 … via scan link`, `payee(scan): ack written ok=1`. Both screens: Done / Paid. Fill the reversed-role row in the hardware log with the `ms` values and commit it (`docs(ble): reversed-role hardware row`).

If the run fails, stop: capture both logs into `docs/superpowers/2026-09-02-ble-hardware-log.md` Notes and return to the spec — no fix without the new root cause.

---

## Self-review

**Spec coverage.** §1 bit + `bleRole` → Tasks 1, 2. §2 roles/carriers → Tasks 4–7 (message bytes untouched, `BleGattProfile` files unmodified except one added test). §3 Nitro surface → Task 3. §4 Android payer peripheral → Task 4. §5 iOS payee central (+ symmetric twins) → Tasks 5, 6, 7. §6 JS wrapper/NearbyFlow → Task 8. §7 invariants → Task 4 (`frameOnWire` gate, MAC-only rejection, respond-before-resolve), Task 6 (`confirmFrame` rejects on a failed ACK write; shared `hasAccepted`; loser torn down), Task 8 (single confirm handle, never stopListening on success). §8 housekeeping → Tasks 0, 9. Testing section → Tasks 1, 2, 4, 8, 9. Rollout order matches Tasks 1→9.

**Placeholders.** None: every code step carries the code. Task 9 Step 6's "if the run fails, stop" is a deliberate gate, not a placeholder.

**Type consistency.** `startScanning(instanceName, pskBase64, onFrame, onError): Promise<void>` and `sendFrameAdvertising(instanceName, pskBase64, frameBase64, timeoutMs, connectTimeoutMs): Promise<string>` are spelled identically in Tasks 3, 4, 5, 6, 7, 8. `bleRole`/`BleRole` (Task 2) is what Task 8 imports. `CAP_BLE_SCAN` (Task 1) is used by Tasks 2 and 8. Swift `InboundScan`/`activeScan` (Task 6) and `PayerAdvertise`/`activePayer` (Task 7) do not collide with `OutboundSend`/`activeSend`. Kotlin `PayerAdvertise`/`payer` (Task 4) and `InboundScan`/`scan` (Task 5) share `centrals`, `sendIndication`, `resetSession`, `cancelAckReaper`, `ackReaper`, `hasAccepted`, `stopAdvertising` exactly as those exist today. `console.warn('[localpay] ble scan unavailable:', message)` in Task 8's code matches its test.
