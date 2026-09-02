# BLE Transport Rung and Session QR Capability Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add BLE as the third radio rung of the local-payment ladder — the only radio that crosses iOS↔Android — and carry device-hint bits in the payee's session QR so a payer left on the fountain is told why.

**Architecture:** A second Nitro HybridObject, `LocalPayBleTransport`, lives beside `LocalPayTransport` in `packages/react-native-localpay-transport` with the same four transport methods, so the one JS socket wrapper (`makeSocketTransport(kind, native, connectTimeoutMs)`) drives both objects through one structural type. The QR is the BLE pairing step: the GATT service UUID is `HMAC-SHA256(psk, "bsvpay-ble-svc" ‖ utf8(instanceName))[0..16]` with the RFC-4122 bits forced, and the bare GATT link is authenticated at the message layer with the Nearby-style `HELLO_A 0x01 / HELLO_B 0x02 / FRAME 0x03 / ACK 0x04` type-byte protocol plus an HMAC on the ACK. The session's integer `c` keeps the rungs in its low byte and gains hint bits (`HINT_ONLINE … HINT_NFC`) above `RUNG_MASK`; the payer's ladder is AWDL → Nearby → BLE → QR and `describeFloor()` turns the hints into one sentence of confirm-screen copy.

**Tech Stack:** Expo 55 / React Native new architecture, react-native-nitro-modules ^0.35.x + nitrogen 0.35.10, CoreBluetooth + CryptoKit (Swift), android.bluetooth + javax.crypto (Kotlin), @bsv/sdk SymmetricKey sealing (`core/localpay/codec.ts`), @react-native-community/netinfo 11.5.2, Jest (jest-expo).

**Spec:** docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md

## Global Constraints

- react-native-nitro-modules stays `^0.35.x`; nitrogen is run from inside the package — `cd packages/react-native-localpay-transport && npx nitrogen` — because nitrogen 0.35.10 parses `--config` but always reads `./nitro.json` from the cwd (`node_modules/nitrogen/lib/config/NitroConfig.js:16-19`); NEVER `nitro-codegen`.
- No `UIBackgroundModes`, no new entitlement, `plugins/` unchanged; BLE is foreground only.
- `NSBluetoothAlwaysUsageDescription` (and `NSBluetoothPeripheralUsageDescription`) are REQUIRED in `app.json` `ios.infoPlist` once CoreBluetooth is linked; Task 2's TestFlight upload proves ITMS-90683 is clear before any native behaviour lands.
- `MAX_BLE_FRAME_BYTES = 32768` (type byte + body); the payer rejects a larger sealed frame with `"frame too large for a BLE payload"` so JS falls to the fountain.
- Connect budgets: AWDL 4 s / Nearby 10 s / BLE 6 s; whole-send stays 20 s (`SEND_TIMEOUT_MS`).
- Reapers: 30 s idle per central, 60 s pending-ack; expiry is silent and never synthesises an ack.
- A positive ack only after `savePending` resolves; a negative ack only where provably nothing was queued (`decode_failed`, `session_mismatch`, `already_paid`, `save_failed`).
- The session stays `v:1`; `decodeSession` is not modified.
- Every i18n key is added to all 12 language blocks (en zh hi es fr ar pt bn ru id ja pl) of `packages/expo-wallet-toolbox/core/i18n/translations.tsx`.
- `ios/` is committed and EAS uses the generic workflow: after any `app.json` plist or podspec change run `npx expo prebuild --clean --platform ios` and commit `ios/`. `android/` is gitignored (regenerated on demand) and is never committed.
- Test runner: `npx jest <path>` from the repo root (jest-expo preset). Toolbox typecheck: `npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep "error TS" | grep -v "core/pay/rails/handle.ts\|ui/components/pay/HandleReceive.tsx"` → expected no output (HEAD carries four pre-existing, unrelated `TS2345` errors in those two files; nothing in this plan may add a line). The native package typechecks with `npx tsc --noEmit -p packages/react-native-localpay-transport/tsconfig.json` (created in Task 1).
- Commits: conventional commits with scope `localpay|transport|ble|pay|docs`, each carrying the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Shared names every task uses verbatim: HybridObject `LocalPayBleTransport`; accessor `getLocalPayBleTransport()`; Swift `HybridLocalPayBleTransport: HybridLocalPayBleTransportSpec` + `enum BleGattProfile`; Kotlin `HybridLocalPayBleTransport : HybridLocalPayBleTransportSpec()` + `object BleGattProfile`; JS `bleTransport`, `BLE_CONNECT_TIMEOUT_MS = 6_000`, `localSupportsBle`, `describeFloor`/`FloorReason`, `probeDeviceCaps`/`capsFromProbe`/`DeviceProbe`/`BluetoothState`/`readBluetoothState`/`prepareBle`, `requestBlePermissions`, `raceReceivers`; caps `CAP_BLE 0x04`, `HINT_ONLINE 0x0100 … HINT_NFC 0x2000`, `RUNG_MASK 0x00ff`; native error strings `"connect timeout: no route to peer"`, `"timed out waiting for peer"`, `"peer failed the session proof"`, `"frame too large for a BLE payload"`, `"bluetooth unavailable"`, `"bad psk or frame"`, `"bad psk or instance name"`, `"payee never confirmed the payment; connection released"`, `"peer disconnected before acking"`; native log tag/category `LocalPayBle` (iOS subsystem `org.bsvblockchain.wallet`).

## File Structure

Paths: `RNLT` = `packages/react-native-localpay-transport`, `L` = `packages/expo-wallet-toolbox/core/localpay`, `T` = `packages/expo-wallet-toolbox/__tests__/localpay`, `UI` = `packages/expo-wallet-toolbox/ui`.

| Path | Action | Task(s) | Responsibility |
|---|---|---|---|
| `RNLT/src/specs/LocalPayBleTransport.nitro.ts` | Create | 1 | Nitro spec: `isSupported`, `bluetoothState`, `nfcAvailable`, `prepare` + the four transport methods, same signatures as `LocalPayTransport` |
| `RNLT/src/index.ts` | Modify | 1 | `getLocalPayBleTransport()` cached, never-throwing accessor that warns once in `__DEV__`; `export type LocalPayBleTransport` |
| `RNLT/tsconfig.json` | Create | 1 | Typecheck for the native package's TS (copy of `react-native-yubikey/tsconfig.json`) |
| `RNLT/nitro.json` | Modify | 1 | Autolinks `LocalPayBleTransport` → `HybridLocalPayBleTransport` on both platforms |
| `RNLT/nitrogen/generated/**` | Regenerate | 1 | nitrogen glue for both HybridObjects (committed) |
| `RNLT/ios/HybridLocalPayBleTransport.swift` | Create → Replace | 1 → 8 | Task 1: prompt-free probes + inert transport methods (links CoreBluetooth). Task 8: CoreBluetooth peripheral (payee) and central (payer) state machines on one serial queue |
| `RNLT/ios/BleGattProfile.swift` | Create | 8 | `bsvpay-ble/1` constants, service-UUID derivation, HELLO/ACK HMACs, ack JSON, u32-BE framing, reassembler |
| `RNLT/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport.kt` | Create → Replace | 1 → 9 | Task 1: probes + inert transport. Task 9: `BluetoothGattServer` payee and `BluetoothGatt` payer, main-`Handler` confinement, adapter-off receiver |
| `RNLT/android/src/main/java/com/margelo/nitro/localpaytransport/BleGattProfile.kt` | Create | 9 | Byte-identical Kotlin twin of `BleGattProfile.swift` (pure JVM) |
| `RNLT/android/src/test/java/com/margelo/nitro/localpaytransport/BleGattProfileTest.kt` | Create | 9 | JUnit known-answer vectors for the profile helpers |
| `RNLT/android/build.gradle` | Modify | 9 | `testImplementation 'junit:junit:4.13.2'` |
| `RNLT/LocalPayTransport.podspec` | Modify | 1, 8 | Source files + `CoreBluetooth`/`CoreNFC` frameworks |
| `RNLT/android/src/main/AndroidManifest.xml` | Modify | 1 | `<uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />` |
| `app.json` | Modify | 1 | `NSBluetoothAlwaysUsageDescription`, `NSBluetoothPeripheralUsageDescription` |
| `ios/` | Regenerate | 1, 8 | `expo prebuild --clean` output (Info.plist, Podfile.lock, Pods project) |
| `T/bleAccessor.test.ts` | Create | 1 | Accessor never throws, caches, warns once |
| `docs/superpowers/2026-09-02-ble-preflight.md` | Create | 2 | ITMS-90683 TestFlight record (go/no-go gate) |
| `L/session.ts` | Modify | 3 | `HINT_*`, `RUNG_MASK`; `mintSession({ supportsBle?, hints? })` |
| `T/session.test.ts` | Modify | 3 | Bit layout, masking, round-trip, realistic-nonce QR size class |
| `L/types.ts` | Modify | 4 | `LocalPaymentTransport.kind` gains `'ble'` |
| `L/pending.ts` | Modify | 4 | `receivedVia` comment lists `'ble'` |
| `L/transport/select.ts` | Modify | 4 | `TransportKind`, `localSupportsBle`, AWDL → Nearby → BLE → QR ladder, `describeFloor`/`FloorReason` |
| `L/deviceCaps.ts` | Create → Fill → Extend | 4 → 6 → 10 | Task 4: `BluetoothState` only. Task 6: `DeviceProbe`, `capsFromProbe`, `probeDeviceCaps`, `readBluetoothState`, budgets. Task 10: `prepareBle` |
| `T/transportSelect.test.ts` | Modify | 4 | New CASES rows, `localSupportsBle` |
| `T/describeFloor.test.ts` | Create | 4 | The spec §5 table |
| `L/transport/socket.ts` | Modify | 5 | `makeSocketTransport(kind, native, connectTimeoutMs)`, `LocalPayNative` |
| `L/transport/awdl.ts`, `L/transport/nearby.ts` | Modify | 5 | Pass their accessor and named connect budget |
| `L/transport/ble.ts` | Create | 5 | `BLE_CONNECT_TIMEOUT_MS`, `bleTransport` |
| `T/transportAwdl.test.ts` | Modify | 5 | Pins the 4 s / 20 s budgets through the refactor |
| `T/transportBle.test.ts` | Create | 5 | BLE rung over a mocked native object, incl. connect-timeout and oversize propagation |
| `T/deviceCaps.test.ts` | Create | 6 | `capsFromProbe` truth table, `readBluetoothState`, budgeted probe |
| `L/blePermissions.ts` | Create | 7 | `requestBlePermissions()` (Android BLE grant sets by API level) |
| `T/blePermissions.test.ts` | Create | 7 | Permission sets per API level |
| `packages/expo-wallet-toolbox/core/pay/rails/nearby.ts` | Modify | 7, 10 | Pass-through barrel gains the BLE rung and device-caps names (10: `prepareBle`, `raceReceivers`) |
| `packages/expo-wallet-toolbox/core/index.ts` | Modify | 7, 10 | Hand-written nearby block mirrors the barrel; exports `LocalPaymentTransport`, `ReceivedFrame`, `QrHandoffRequired`, `AckError` |
| `packages/expo-wallet-toolbox/__tests__/pay/nearbyRail.test.ts` | Modify | 7 | Identity pins for both barrels |
| `docs/superpowers/2026-09-02-ble-hardware-log.md` | Create → Append | 8 → 9 | Measured MTU / connect / transfer / ack numbers for all four pairings |
| `UI/components/ui/PresenceRow.tsx` | Modify | 10 | `medium?: 'wifi' \| 'bluetooth'` prop |
| `packages/expo-wallet-toolbox/__tests__/ui/PresenceRow.test.tsx` | Modify | 10 | Glyph per medium |
| `T/prepareBle.test.ts` | Create | 10 | `prepareBle` never rejects, coerces, passes the budget |
| `L/transport/race.ts` | Create | 10 | `raceReceivers`: first frame wins, losers aborted before settle, per-radio non-terminal errors |
| `T/race.test.ts` | Create | 10 | Multi-listener arbitration |
| `packages/expo-wallet-toolbox/core/i18n/translations.tsx` | Modify | 10 | Six keys × 12 languages (`local_pay_floor_*`, `local_pay_ble_unavailable`) |
| `UI/components/pay/NearbyFlow.tsx` | Modify | 10 | Multi-listener payee, probe + `prepareBle` at minting, BLE in `executeSend`, floor copy, presence medium |
| `docs/superpowers/plans/2026-07-27-local-payments-awdl.md`, `docs/superpowers/specs/2026-07-27-local-payments-awdl-design.md`, `docs/superpowers/specs/2026-07-29-offline-transport-fixes-design.md`, `docs/superpowers/2026-08-20-morning-handoff.md`, `docs/superpowers/specs/2026-07-31-token-payment-frame-v3-design.md`, `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md` | Modify | 11 | Dated `Superseded 2026-09-02` notes on the CoreBluetooth prohibitions; spec Status → Implemented |

Task order and the spec's rollout order: the spec lists the TestFlight pre-flight as step 0, but a pre-flight binary has to link CoreBluetooth first, so Task 1 (spec, accessor, inert native stubs, plist, podspec) comes before Task 2 (the upload). Tasks 3–7 are pure JS with jest coverage and no native behaviour; Tasks 8–9 are the Swift and Kotlin backends with hardware checklists; Task 10 wires the screen; Task 11 amends the superseded docs.

---

### Task 1: Nitro spec, accessor, native stubs, and build config (links CoreBluetooth)

Deliverable: the app LINKS CoreBluetooth and CoreNFC, declares the Bluetooth usage strings, and exposes a callable but inert `LocalPayBleTransport` HybridObject on both platforms. No UI change. No JS outside `react-native-localpay-transport` references the new object yet (Task 4 owns `select.ts`, Task 5 owns `ble.ts`). Spec: `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md` §1 (placement, spec shape, accessor), §7 (prompt discipline), §8 (native configuration), "Why now" (ITMS-90683 gate is why linking CoreBluetooth is its own task).

Repo facts this task relies on (verified at `0ad5521`; HEAD is now `1568bb9`, the spec commit, which touched only `docs/`):
- `nitrogen@0.35.10` is installed. Its `--config` flag is parsed but IGNORED — `NitroConfig.current` always reads `./nitro.json` from the cwd and writes to `./nitrogen/generated` (node_modules/nitrogen/lib/config/NitroConfig.js:16-19, lib/index.js:38-50). So nitrogen MUST be run from inside the package directory. Never run `nitro-codegen` (wrong, abandoned package).
- `ios/` is committed (Info.plist, Podfile.lock, pbxproj); `ios/Pods/` and `ios/build/` are gitignored. `android/` is NOT committed (root `.gitignore` line `android`), so the Android compile check is the EAS local build.
- The committed `ios/Podfile.lock` was produced with the default prebuilt React core (`React-Core-prebuilt (0.83.6)` is in it), so plain `npx expo prebuild` reproduces it; do not set `RCT_USE_PREBUILT_RNCORE`.
- Jest runs from the repo root with the `jest-expo` preset; `react-native-localpay-transport` resolves through the `node_modules/react-native-localpay-transport -> ../packages/react-native-localpay-transport` symlink to `src/index.ts` (babel-transformed, not in `transformIgnorePatterns`). `__DEV__` is `true` under jest-expo.
- `packages/react-native-localpay-transport` has no `tsconfig.json`; `packages/react-native-yubikey/tsconfig.json` is the template and `npx tsc --noEmit -p packages/react-native-yubikey/tsconfig.json` passes today (exit 0). A file including `typeof import('react-native-nitro-modules')` typechecks `__DEV__` under that tsconfig shape (verified).

**Files:**
- Create: `packages/react-native-localpay-transport/src/specs/LocalPayBleTransport.nitro.ts`
- Modify: `packages/react-native-localpay-transport/src/index.ts` (whole file, currently 27 lines)
- Create: `packages/react-native-localpay-transport/tsconfig.json` (copy of `packages/react-native-yubikey/tsconfig.json`)
- Modify: `packages/react-native-localpay-transport/nitro.json` (lines 8-13, the `autolinking` block)
- Regenerate: `packages/react-native-localpay-transport/nitrogen/generated/**` (nitrogen output; committed)
- Create: `packages/react-native-localpay-transport/ios/HybridLocalPayBleTransport.swift` (Task 1 stub; Task 8 replaces it and adds `ios/BleGattProfile.swift`)
- Create: `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport.kt` (Task 1 stub; Task 9 replaces it and adds `BleGattProfile.kt`)
- Modify: `packages/react-native-localpay-transport/LocalPayTransport.podspec` (lines 14-15: `source_files`, `frameworks`)
- Modify: `packages/react-native-localpay-transport/android/src/main/AndroidManifest.xml` (insert after line 15, before `</manifest>` on line 16)
- Modify: `app.json` (lines 114-139 `ios.infoPlist`; insert two keys after line 138 `NSLocalNetworkUsageDescription`)
- Regenerate + commit: `ios/` (via `npx expo prebuild --clean --platform ios`)
- Test: `packages/expo-wallet-toolbox/__tests__/localpay/bleAccessor.test.ts`

**Interfaces:**
- Consumes:
  - `react-native-nitro-modules`: `NitroModules.createHybridObject<T>(name: string): T`, `HybridObject<{ ios: 'swift'; android: 'kotlin' }>` (TS); Swift `Promise<T>.rejected(withError: Error) -> Promise<T>`; Kotlin `Promise<T>()` + `.reject(error: Throwable)` (`com.margelo.nitro.core.Promise` has no static `rejected`; a rejected promise is `Promise<T>().apply { reject(e) }`), `NitroModules.applicationContext: ReactApplicationContext?`.
  - Existing `getLocalPayTransport(): LocalPayTransport | null` in `RNLT/src/index.ts` (pattern to mirror; unchanged).
- Produces:
  - `export interface LocalPayBleTransport extends HybridObject<{ ios: 'swift'; android: 'kotlin' }>` with `isSupported(): boolean`, `bluetoothState(): string`, `nfcAvailable(): boolean`, `prepare(timeoutMs: number): Promise<string>`, `startListening(instanceName: string, pskBase64: string, onFrame: (frameBase64: string) => void, onError: (message: string) => void): Promise<void>`, `stopListening(): Promise<void>`, `confirmFrame(accepted: boolean, reason: string): Promise<void>`, `sendFrame(instanceName: string, pskBase64: string, frameBase64: string, timeoutMs: number, connectTimeoutMs: number): Promise<string>`.
  - `export function getLocalPayBleTransport(): LocalPayBleTransport | null` and `export type { LocalPayBleTransport }` from `react-native-localpay-transport`.
  - Nitrogen-generated: Swift `HybridLocalPayBleTransportSpec` (protocol+base typealias), Kotlin `abstract class HybridLocalPayBleTransportSpec` in `com.margelo.nitro.localpaytransport`, C++ `HybridLocalPayBleTransportSpec`, JNI `JHybridLocalPayBleTransportSpec`, Swift↔C++ `HybridLocalPayBleTransportSpecSwift`; registry name `"LocalPayBleTransport"` on both platforms.
  - Swift `final class HybridLocalPayBleTransport: HybridLocalPayBleTransportSpec`; Kotlin `class HybridLocalPayBleTransport : HybridLocalPayBleTransportSpec()`.
  - Native error string `"bluetooth unavailable"` (NSError domain `"LocalPayBleTransport"` on iOS; `Error("bluetooth unavailable")` on Android) from every transport method of the stub.
  - Info.plist keys `NSBluetoothAlwaysUsageDescription`, `NSBluetoothPeripheralUsageDescription` = "BSV Wallet uses Bluetooth to send and receive payments directly between nearby devices."

- [ ] **Step 1: Create the Nitro spec file**

Create `packages/react-native-localpay-transport/src/specs/LocalPayBleTransport.nitro.ts` with exactly this content (method shape is the shared naming contract; doc comments are spec §1 verbatim). `bluetoothState()` returns plain `string`, not a literal union — nitrogen would otherwise emit a native enum and the JS side coerces anyway (`deviceCaps.ts`, Task 6).

```ts
import type { HybridObject } from 'react-native-nitro-modules'

/**
 * BLE rung of the local-payment transport (GATT profile bsvpay-ble/1, spec
 * docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md §2-§3).
 *
 * The four transport methods have signatures identical to LocalPayTransport so
 * core/localpay/transport/socket.ts drives both HybridObjects through one
 * structural type (`LocalPayNative`). The three probes are prompt-free by
 * contract: reading them at any time never shows the iOS Bluetooth dialog.
 * `prepare()` is the ONE method that may.
 */
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
  startListening(
    instanceName: string,
    pskBase64: string,
    onFrame: (frameBase64: string) => void,
    onError: (message: string) => void
  ): Promise<void>
  stopListening(): Promise<void>
  /**
   * Same contract as LocalPayTransport.confirmFrame (see that spec's doc
   * comment: an ack is a money-safety statement JS makes after its durable
   * write). On BLE the ack additionally carries an HMAC over the wire; the
   * payer's native side verifies and strips it, so JS sees identical bytes.
   */
  confirmFrame(accepted: boolean, reason: string): Promise<void>
  sendFrame(
    instanceName: string,
    pskBase64: string,
    frameBase64: string,
    /** Whole-exchange budget: scan + connect + transfer + the payee's save + ack. */
    timeoutMs: number,
    /**
     * Connect-phase budget (scan, connect, MTU, discovery, subscribe). Rejects
     * with "connect timeout: no route to peer" — the string the JS layer
     * already treats as radios-off/peer-gone so the UI falls to the QR fast.
     */
    connectTimeoutMs: number
  ): Promise<string>
}
```

- [ ] **Step 2: Write the failing accessor test**

Create `packages/expo-wallet-toolbox/__tests__/localpay/bleAccessor.test.ts`:

```ts
/**
 * getLocalPayBleTransport() is the second never-throwing Nitro accessor in
 * react-native-localpay-transport (spec §1). A `null` from it silently floors
 * the payment flow to QR — the same masking that hid two shipped native bugs
 * (84cd96e, 0c75467) — so the accessor must (a) never throw, (b) cache its
 * answer, and (c) warn exactly once in __DEV__ when it swallows the error.
 *
 * The real module is loaded fresh per test (resetModules) with
 * react-native-nitro-modules replaced, because the accessor's cache is a
 * module-level variable.
 */
type Accessors = typeof import('react-native-localpay-transport')

function loadWithNitro(createHybridObject: jest.Mock): Accessors {
  jest.doMock('react-native-nitro-modules', () => ({ NitroModules: { createHybridObject } }))
  return jest.requireActual<Accessors>('react-native-localpay-transport')
}

describe('getLocalPayBleTransport', () => {
  let warn: jest.SpyInstance

  beforeEach(() => {
    jest.resetModules()
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    jest.dontMock('react-native-nitro-modules')
  })

  it('returns null, never throws, and warns once when the native object cannot be created', () => {
    const create = jest.fn((): unknown => {
      throw new Error('HybridObject "LocalPayBleTransport" is not registered')
    })
    const { getLocalPayBleTransport } = loadWithNitro(create)

    expect(() => getLocalPayBleTransport()).not.toThrow()
    expect(getLocalPayBleTransport()).toBeNull()
    expect(getLocalPayBleTransport()).toBeNull()

    expect(create).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[localpay] LocalPayBleTransport unavailable:',
      'HybridObject "LocalPayBleTransport" is not registered'
    )
  })

  it('returns the hybrid object and caches it when creation succeeds', () => {
    const ble = { isSupported: () => true, bluetoothState: () => 'unknown', nfcAvailable: () => false }
    const create = jest.fn((): unknown => ble)
    const { getLocalPayBleTransport } = loadWithNitro(create)

    expect(getLocalPayBleTransport()).toBe(ble)
    expect(getLocalPayBleTransport()).toBe(ble)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('LocalPayBleTransport')
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps its cache separate from getLocalPayTransport', () => {
    const ble = { isSupported: () => true }
    const create = jest.fn((name: string): unknown => {
      if (name === 'LocalPayBleTransport') return ble
      throw new Error(`no ${name}`)
    })
    const { getLocalPayBleTransport, getLocalPayTransport } = loadWithNitro(create)

    expect(getLocalPayTransport()).toBeNull()
    expect(getLocalPayBleTransport()).toBe(ble)
    // The AWDL/Nearby accessor swallows silently by design; only the BLE one warns.
    expect(warn).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the test and watch it fail**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/localpay/bleAccessor.test.ts
```

Expected: `Tests: 3 failed, 3 total`. Each failure contains `TypeError: getLocalPayBleTransport is not a function` (the first as "Expected the function not to throw an error. Instead, it threw: TypeError: getLocalPayBleTransport is not a function").

- [ ] **Step 4: Implement the accessor**

Replace the whole of `packages/react-native-localpay-transport/src/index.ts` with:

```ts
import type { LocalPayBleTransport } from './specs/LocalPayBleTransport.nitro'
import type { LocalPayTransport } from './specs/LocalPayTransport.nitro'

export type { LocalPayBleTransport, LocalPayTransport }

let cached: LocalPayTransport | null | undefined

/**
 * Returns the LocalPayTransport hybrid object, or null when the native module
 * is unavailable (web, jest, Expo Go, or any build without the native lib —
 * iOS registers via the podspec's generated Autolinking.mm, Android via
 * LocalPayTransportPackage's companion init → JNI_OnLoad). Never throws.
 *
 * Null here is why a broken native install NEVER errors visibly: every
 * capability probe (localSupportsAwdl/localSupportsNearby) reads it as
 * "unsupported device" and the payment flow quietly floors to QR.
 */
export function getLocalPayTransport(): LocalPayTransport | null {
  if (cached !== undefined) return cached
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nitro = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules')
    cached = nitro.NitroModules.createHybridObject<LocalPayTransport>('LocalPayTransport')
  } catch {
    cached = null
  }
  return cached ?? null
}

let cachedBle: LocalPayBleTransport | null | undefined

/**
 * Returns the LocalPayBleTransport hybrid object (the BLE rung, a second
 * HybridObject registered by the same native module), or null when it is
 * unavailable. Never throws. Cached separately from getLocalPayTransport():
 * one object being registered says nothing about the other.
 *
 * Unlike the AWDL/Nearby accessor this one warns ONCE in __DEV__ when it
 * swallows the error. A null here floors the flow to QR with no visible
 * error — the same masking that hid two shipped native-registration bugs
 * (84cd96e, 0c75467) — so a dev build should at least say so in the console.
 */
export function getLocalPayBleTransport(): LocalPayBleTransport | null {
  if (cachedBle !== undefined) return cachedBle
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nitro = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules')
    cachedBle = nitro.NitroModules.createHybridObject<LocalPayBleTransport>('LocalPayBleTransport')
  } catch (error) {
    cachedBle = null
    if (__DEV__) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[localpay] LocalPayBleTransport unavailable:', message)
    }
  }
  return cachedBle ?? null
}
```

- [ ] **Step 5: Run the test and watch it pass, then typecheck the package**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/localpay/bleAccessor.test.ts
```

Expected: `Tests: 3 passed, 3 total`.

The package has no tsconfig, so create one by copying the YubiKey module's (identical content: extends `expo/tsconfig.base`, strict, includes `src/**/*.ts`, excludes `node_modules` and `nitrogen`):

```bash
cd /Users/personal/git/bsv-wallet && cp packages/react-native-yubikey/tsconfig.json packages/react-native-localpay-transport/tsconfig.json && cat packages/react-native-localpay-transport/tsconfig.json
```

Expected file content:

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "nitrogen"]
}
```

```bash
cd /Users/personal/git/bsv-wallet && npx tsc --noEmit -p packages/react-native-localpay-transport/tsconfig.json; echo "exit=$?"
```

Expected: no diagnostics, `exit=0`. Also confirm the existing localpay suite is untouched:

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/localpay
```

Expected: every suite passes (`Test Suites: 11 passed, 11 total` — the 10 existing plus `bleAccessor`).

- [ ] **Step 6: Commit the spec, accessor, tsconfig and test**

```bash
cd /Users/personal/git/bsv-wallet && git add packages/react-native-localpay-transport/src/specs/LocalPayBleTransport.nitro.ts packages/react-native-localpay-transport/src/index.ts packages/react-native-localpay-transport/tsconfig.json packages/expo-wallet-toolbox/__tests__/localpay/bleAccessor.test.ts && git commit -m "feat(transport): declare the LocalPayBleTransport Nitro spec and accessor

Second HybridObject for the BLE rung (spec 2026-09-02 §1): same four
transport methods as LocalPayTransport plus three prompt-free probes and
prepare(). getLocalPayBleTransport() mirrors getLocalPayTransport() but
warns once in __DEV__ when it swallows the native error, since a null
here floors the flow to QR with no visible failure.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: one commit; `git log -1 --format=%s` prints `feat(transport): declare the LocalPayBleTransport Nitro spec and accessor`, and `git status --short` no longer lists the four paths.

- [ ] **Step 7: Register the object in nitro.json and run nitrogen**

Edit `packages/react-native-localpay-transport/nitro.json` so the `autolinking` block (currently lines 8-13) reads:

```json
  "autolinking": {
    "LocalPayTransport": {
      "ios": { "language": "swift", "implementationClassName": "HybridLocalPayTransport" },
      "android": { "language": "kotlin", "implementationClassName": "HybridLocalPayTransport" }
    },
    "LocalPayBleTransport": {
      "ios": { "language": "swift", "implementationClassName": "HybridLocalPayBleTransport" },
      "android": { "language": "kotlin", "implementationClassName": "HybridLocalPayBleTransport" }
    }
  }
```

The full file must then be:

```json
{
  "cxxNamespace": ["localpaytransport"],
  "ios": { "iosModuleName": "LocalPayTransport" },
  "android": {
    "androidNamespace": ["localpaytransport"],
    "androidCxxLibName": "LocalPayTransport"
  },
  "autolinking": {
    "LocalPayTransport": {
      "ios": { "language": "swift", "implementationClassName": "HybridLocalPayTransport" },
      "android": { "language": "kotlin", "implementationClassName": "HybridLocalPayTransport" }
    },
    "LocalPayBleTransport": {
      "ios": { "language": "swift", "implementationClassName": "HybridLocalPayBleTransport" },
      "android": { "language": "kotlin", "implementationClassName": "HybridLocalPayBleTransport" }
    }
  }
}
```

Run nitrogen FROM THE PACKAGE DIRECTORY (nitrogen 0.35.10 reads `./nitro.json` from the cwd and ignores `--config`; from the repo root it would abort with "nitro.json not found"). Never `nitro-codegen`.

```bash
cd /Users/personal/git/bsv-wallet/packages/react-native-localpay-transport && npx nitrogen
```

Expected output includes `Nitrogen 0.35.10 runs at ./`, `Nitrogen found 2 specs in ./src/specs`, `Generating specs for HybridObject "LocalPayTransport"...`, `Generating specs for HybridObject "LocalPayBleTransport"...`, and a final line reporting 2 HybridObject specs generated. Then verify the tree:

```bash
cd /Users/personal/git/bsv-wallet && git status --short packages/react-native-localpay-transport/nitrogen && find packages/react-native-localpay-transport/nitrogen/generated -name "*Ble*" | sort
```

Expected NEW files (exactly these nine):

```
packages/react-native-localpay-transport/nitrogen/generated/android/c++/JHybridLocalPayBleTransportSpec.cpp
packages/react-native-localpay-transport/nitrogen/generated/android/c++/JHybridLocalPayBleTransportSpec.hpp
packages/react-native-localpay-transport/nitrogen/generated/android/kotlin/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransportSpec.kt
packages/react-native-localpay-transport/nitrogen/generated/ios/c++/HybridLocalPayBleTransportSpecSwift.cpp
packages/react-native-localpay-transport/nitrogen/generated/ios/c++/HybridLocalPayBleTransportSpecSwift.hpp
packages/react-native-localpay-transport/nitrogen/generated/ios/swift/HybridLocalPayBleTransportSpec.swift
packages/react-native-localpay-transport/nitrogen/generated/ios/swift/HybridLocalPayBleTransportSpec_cxx.swift
packages/react-native-localpay-transport/nitrogen/generated/shared/c++/HybridLocalPayBleTransportSpec.cpp
packages/react-native-localpay-transport/nitrogen/generated/shared/c++/HybridLocalPayBleTransportSpec.hpp
```

Expected MODIFIED files (registration glue now covers both objects): `ios/LocalPayTransportAutolinking.swift`, `ios/LocalPayTransportAutolinking.mm`, `ios/LocalPayTransport-Swift-Cxx-Bridge.hpp`, `ios/LocalPayTransport-Swift-Cxx-Bridge.cpp`, `ios/LocalPayTransport-Swift-Cxx-Umbrella.hpp`, `android/LocalPayTransportOnLoad.cpp`, `android/LocalPayTransport+autolinking.cmake`. No new `Func_*` files are expected: `Promise<String>`/`Promise<Void>`/`(String) -> Void` callbacks were already generated for the AWDL spec. `cpp-adapter.cpp`, `CMakeLists.txt`, `LocalPayTransportPackage.kt` need no change (spec §1).

```bash
cd /Users/personal/git/bsv-wallet/packages/react-native-localpay-transport && grep -n '"LocalPayBleTransport"' nitrogen/generated/ios/LocalPayTransportAutolinking.mm nitrogen/generated/android/LocalPayTransportOnLoad.cpp && grep -n "createLocalPayBleTransport\|HybridLocalPayBleTransport()" nitrogen/generated/ios/LocalPayTransportAutolinking.swift && grep -n "JHybridLocalPayBleTransportSpec.cpp\|HybridLocalPayBleTransportSpec.cpp" nitrogen/generated/android/LocalPayTransport+autolinking.cmake && grep -n "func " nitrogen/generated/ios/swift/HybridLocalPayBleTransportSpec.swift
```

Expected: one `registerHybridObjectConstructor("LocalPayBleTransport", ...)` hit in each of the `.mm` and `.cpp`; `createLocalPayBleTransport()` constructing `HybridLocalPayBleTransport()` in the Swift autolinking; both new `.cpp` sources in the cmake; and these eight protocol methods in the Swift spec:

```
  func isSupported() throws -> Bool
  func bluetoothState() throws -> String
  func nfcAvailable() throws -> Bool
  func prepare(timeoutMs: Double) throws -> Promise<String>
  func startListening(instanceName: String, pskBase64: String, onFrame: @escaping (_ frameBase64: String) -> Void, onError: @escaping (_ message: String) -> Void) throws -> Promise<Void>
  func stopListening() throws -> Promise<Void>
  func confirmFrame(accepted: Bool, reason: String) throws -> Promise<Void>
  func sendFrame(instanceName: String, pskBase64: String, frameBase64: String, timeoutMs: Double, connectTimeoutMs: Double) throws -> Promise<String>
```

(The generated Swift Autolinking now references `HybridLocalPayBleTransport()`, and the generated Kotlin OnLoad references `com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport`; neither class exists until Steps 8-9, so do not build yet.)

- [ ] **Step 8: Create the Swift stub (links CoreBluetooth + CoreNFC)**

Create `packages/react-native-localpay-transport/ios/HybridLocalPayBleTransport.swift`. Only the three probes are real; every transport method rejects with `"bluetooth unavailable"`. Nothing here instantiates a `CB*Manager` — doing so while authorization is `.notDetermined` shows the system prompt (spec "Verified facts", §7), and `prepare()` is the only method allowed to (Task 8). `CBManager.authorization` is a class property available from iOS 13.1; the deployment target is 15.1, so no availability guard is needed.

```swift
import CoreBluetooth
import CoreNFC
import Foundation
import os

/// BLE rung of the local-payment transport: the second HybridObject in this
/// package, registered beside `HybridLocalPayTransport` (spec
/// docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md §1).
///
/// TASK 1 STUB. This file exists so the app LINKS CoreBluetooth (the ITMS-90683
/// store gate, spec "Why now") and so JS can already construct the object and
/// read its three prompt-free probes. Every transport method rejects with
/// "bluetooth unavailable", which the JS socket wrapper treats as a radio
/// failure, so any caller that reaches it floors to QR exactly as today. Task 8
/// replaces this whole file with the CoreBluetooth peripheral/central state
/// machines and adds ios/BleGattProfile.swift.
///
/// Prompt discipline (spec §7): instantiating ANY CB*Manager while
/// authorization is `.notDetermined` shows the system Bluetooth dialog.
/// Nothing in this file instantiates one; `prepare()` is the single method
/// allowed to, and only in Task 8.
final class HybridLocalPayBleTransport: HybridLocalPayBleTransportSpec {
  /// `log stream --predicate 'category == "LocalPayBle"'` shows every line.
  private static let logger = Logger(subsystem: "org.bsvblockchain.wallet", category: "LocalPayBle")

  /// Manager state as last reported to `prepare()`. Task 8 writes it from the
  /// CBPeripheralManager/CBCentralManager delegates; nothing writes it in this
  /// stub, so `bluetoothState()` answers "unknown" (never a guess) until the
  /// managers have actually been created. Spec §1: prompt-free by contract.
  private var lastKnownState: String?

  /// Every transport method of the stub fails the same way. Domain and message
  /// are part of the shared naming contract: the JS layer matches the text.
  private static func unavailable(_ method: String, code: Int) -> NSError {
    logger.info("\(method, privacy: .public): Task 1 stub, rejecting \"bluetooth unavailable\"")
    return NSError(domain: "LocalPayBleTransport", code: code,
                   userInfo: [NSLocalizedDescriptionKey: "bluetooth unavailable"])
  }

  // MARK: - Prompt-free probes (real)

  /// Hardware present and not denied. `.notDetermined` counts as supported so
  /// the payer's ladder can pick BLE and let the prompt follow (spec §7);
  /// `.denied`/`.restricted` is unsupported, which floors to QR with the
  /// `local_ble_denied` copy.
  func isSupported() throws -> Bool {
    switch CBManager.authorization {
    case .denied, .restricted:
      return false
    default:
      return true
    }
  }

  /// 'unauthorized' is knowable without a manager; everything else is not,
  /// so until `prepare()` has run the honest answer is 'unknown'.
  func bluetoothState() throws -> String {
    switch CBManager.authorization {
    case .denied, .restricted:
      return "unauthorized"
    default:
      return lastKnownState ?? "unknown"
    }
  }

  /// NFC reader hardware available and enabled (HINT_NFC, spec §4). The same
  /// call the YubiKey module uses; false on iPad and in the simulator.
  func nfcAvailable() throws -> Bool {
    return NFCReaderSession.readingAvailable
  }

  // MARK: - Transport (inert until Task 8)

  func prepare(timeoutMs: Double) throws -> Promise<String> {
    return Promise<String>.rejected(withError: Self.unavailable("prepare", code: 20))
  }

  func startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: @escaping (String) -> Void,
    onError: @escaping (String) -> Void
  ) throws -> Promise<Void> {
    return Promise<Void>.rejected(withError: Self.unavailable("startListening", code: 21))
  }

  func stopListening() throws -> Promise<Void> {
    return Promise<Void>.rejected(withError: Self.unavailable("stopListening", code: 22))
  }

  func confirmFrame(accepted: Bool, reason: String) throws -> Promise<Void> {
    return Promise<Void>.rejected(withError: Self.unavailable("confirmFrame", code: 23))
  }

  func sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ) throws -> Promise<String> {
    return Promise<String>.rejected(withError: Self.unavailable("sendFrame", code: 24))
  }
}
```

- [ ] **Step 9: Create the Kotlin stub**

Create `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport.kt`. Probes are real and prompt-free: `BluetoothAdapter.isEnabled` needs no runtime permission on API 31+ and only the normal `BLUETOOTH` permission (already declared with `maxSdkVersion="30"` in this module's manifest) below that. The companion constant is named `LOG_TAG`, not `TAG`, so it cannot shadow the `protected const val TAG` in the generated superclass companion.

```kotlin
package com.margelo.nitro.localpaytransport

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.nfc.NfcAdapter
import android.util.Log
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise

/**
 * BLE rung of the local-payment transport: the second HybridObject in this
 * module, registered beside HybridLocalPayTransport by the regenerated
 * LocalPayTransportOnLoad.cpp (spec 2026-09-02 §1).
 *
 * TASK 1 STUB. Only the three prompt-free probes are real. Every transport
 * method rejects with "bluetooth unavailable", which the JS socket wrapper
 * treats as a radio failure, so any caller that reaches it floors to QR
 * exactly as today. Task 9 replaces this file with the BluetoothGattServer /
 * BluetoothGatt state machines and adds BleGattProfile.kt.
 *
 * Log with `adb logcat -s LocalPayBle` to see every line from this class.
 */
@Suppress("UNUSED_PARAMETER")
class HybridLocalPayBleTransport : HybridLocalPayBleTransportSpec() {
  private companion object {
    const val LOG_TAG = "LocalPayBle"
    const val UNAVAILABLE = "bluetooth unavailable"
  }

  private fun context(): Context? = NitroModules.applicationContext

  private fun adapter(): BluetoothAdapter? {
    val ctx = context() ?: return null
    val manager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    return manager?.adapter
  }

  // ── prompt-free probes (real) ──

  /**
   * BLE hardware present AND the radio switched on. isEnabled is prompt-free,
   * and a payer whose radio is off must floor to QR (describeFloor's
   * local_bt_off) rather than attempt a connect that cannot succeed. Task 9
   * keeps exactly this semantics.
   */
  override fun isSupported(): Boolean {
    val ctx = context() ?: return false
    val a = adapter() ?: return false
    return ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) && a.isEnabled
  }

  /**
   * 'unsupported' without an adapter; otherwise the radio's power state.
   * Android has no per-app Bluetooth authorization, so 'unauthorized' is
   * never returned here: a missing runtime permission surfaces later, from
   * requestBlePermissions() in JS (spec §7), not from this probe.
   */
  override fun bluetoothState(): String {
    val adapter = adapter() ?: return "unsupported"
    return if (adapter.isEnabled) "poweredOn" else "poweredOff"
  }

  /** NFC reader present and switched on (HINT_NFC, spec §4). */
  override fun nfcAvailable(): Boolean {
    val ctx = context() ?: return false
    return NfcAdapter.getDefaultAdapter(ctx)?.isEnabled == true
  }

  // ── transport (inert until Task 9) ──

  private fun <T> unavailable(method: String): Promise<T> {
    Log.d(LOG_TAG, "$method: Task 1 stub, rejecting \"$UNAVAILABLE\"")
    return Promise<T>().apply { reject(Error(UNAVAILABLE)) }
  }

  override fun prepare(timeoutMs: Double): Promise<String> = unavailable("prepare")

  override fun startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: (String) -> Unit,
    onError: (String) -> Unit
  ): Promise<Unit> = unavailable("startListening")

  override fun stopListening(): Promise<Unit> = unavailable("stopListening")

  override fun confirmFrame(accepted: Boolean, reason: String): Promise<Unit> = unavailable("confirmFrame")

  override fun sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ): Promise<String> = unavailable("sendFrame")
}
```

- [ ] **Step 10: Podspec frameworks/sources and the Android BLE feature flag**

Edit `packages/react-native-localpay-transport/LocalPayTransport.podspec` lines 14-15 from

```ruby
  s.source_files = ['ios/HybridLocalPayTransport.swift', 'ios/AwdlSession.swift']
  s.frameworks   = 'Network', 'Security'
```

to

```ruby
  # BleGattProfile.swift joins this list in Task 8 (BLE backend).
  s.source_files = ['ios/HybridLocalPayTransport.swift', 'ios/AwdlSession.swift', 'ios/HybridLocalPayBleTransport.swift']
  # CoreBluetooth: the BLE rung. CoreNFC: the prompt-free nfcAvailable() probe
  # (HINT_NFC). Linking CoreBluetooth is what makes ITMS-90683 demand
  # NSBluetoothAlwaysUsageDescription — set in app.json ios.infoPlist.
  s.frameworks   = 'Network', 'Security', 'CoreBluetooth', 'CoreNFC'
```

Edit `packages/react-native-localpay-transport/android/src/main/AndroidManifest.xml`: insert after line 15 (the `NEARBY_WIFI_DEVICES` line), before `</manifest>`:

```xml
  <!-- BLE is one rung of several; a phone without it still pays by QR
       (spec 2026-09-02 §8). required="false" keeps the Play listing open
       to BLE-less devices. -->
  <uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />
```

Verify both edits:

```bash
cd /Users/personal/git/bsv-wallet && grep -n "s.source_files\|s.frameworks" packages/react-native-localpay-transport/LocalPayTransport.podspec && grep -n "uses-feature" packages/react-native-localpay-transport/android/src/main/AndroidManifest.xml && ruby -e "require 'json'; load 'packages/react-native-localpay-transport/LocalPayTransport.podspec'" 2>&1 | head -3
```

Expected: the `source_files` line lists three Swift files, `frameworks` lists four, one `uses-feature` line at line 19. The `ruby -e` load will fail only at `Pod::Spec` (`uninitialized constant Pod`) — that is fine; a Ruby SyntaxError would not be.

- [ ] **Step 11: Commit the native registration**

```bash
cd /Users/personal/git/bsv-wallet && git add packages/react-native-localpay-transport/nitro.json packages/react-native-localpay-transport/nitrogen/generated packages/react-native-localpay-transport/ios/HybridLocalPayBleTransport.swift packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport.kt packages/react-native-localpay-transport/LocalPayTransport.podspec packages/react-native-localpay-transport/android/src/main/AndroidManifest.xml && git commit -m "feat(ble): register LocalPayBleTransport natively with inert stubs

nitro.json autolinks the second HybridObject on both platforms and the
nitrogen glue is regenerated (nitrogen 0.35.10, run from the package
dir). The Swift and Kotlin classes implement only the prompt-free probes
(isSupported / bluetoothState / nfcAvailable); every transport method
rejects with \"bluetooth unavailable\" until Tasks 8-9 land the GATT
backends. The podspec links CoreBluetooth and CoreNFC; the Android
manifest declares bluetooth_le as an optional feature (spec §8).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: one commit; `git log -1 --format=%s` prints `feat(ble): register LocalPayBleTransport natively with inert stubs`; `git status --short` shows nothing under `packages/react-native-localpay-transport`.

- [ ] **Step 12: Add the Bluetooth usage strings to app.json**

In `app.json`, inside `expo.ios.infoPlist` (lines 114-139), insert two keys directly after line 138 (`"NSLocalNetworkUsageDescription": ...,`) and before `"NFCReaderUsageDescription"`. Both strings are spec §8 verbatim; `NSBluetoothPeripheralUsageDescription` is only read below iOS 13 and is harmless.

```json
        "NSLocalNetworkUsageDescription": "BSV Wallet uses the local network to send and receive payments directly between nearby devices.",
        "NSBluetoothAlwaysUsageDescription": "BSV Wallet uses Bluetooth to send and receive payments directly between nearby devices.",
        "NSBluetoothPeripheralUsageDescription": "BSV Wallet uses Bluetooth to send and receive payments directly between nearby devices.",
        "NFCReaderUsageDescription": "BSV Wallet uses NFC to unlock your vault with your YubiKey. Hold the key to the top of your phone when asked.",
```

Verify the JSON still parses and nothing else moved:

```bash
cd /Users/personal/git/bsv-wallet && node -e "const a=require('./app.json').expo.ios.infoPlist; console.log(a.NSBluetoothAlwaysUsageDescription); console.log(a.NSBluetoothPeripheralUsageDescription)" && git diff --stat app.json
```

Expected: the sentence printed twice, and `app.json | 2 ++`.

- [ ] **Step 13: Regenerate ios/ with prebuild and verify the plist, lockfile and framework linkage**

`ios/` is committed and EAS uses the generic workflow (spec §8), so the plist and Podfile.lock must be regenerated and committed. `CI=1` suppresses the interactive "delete ios/?" confirmation. This runs `pod install` and takes a few minutes.

```bash
cd /Users/personal/git/bsv-wallet && CI=1 npx expo prebuild --clean --platform ios 2>&1 | tail -15
```

Expected: ends with `✔ Installed CocoaPods` (or `Installed pods and initialized Xcode workspace`) and `✔ Finished prebuild`, with no `error` lines. The `[NitroModules] 🔥 LocalPayTransport is boosted by nitro!` line appears during pod install. Then:

```bash
cd /Users/personal/git/bsv-wallet && grep -n -A1 "NSBluetoothAlwaysUsageDescription\|NSBluetoothPeripheralUsageDescription" ios/BSVWallet/Info.plist && grep -n "LocalPayTransport" ios/Podfile.lock && grep -o '\-framework "CoreBluetooth"\|-framework "CoreNFC"\|-framework "Network"' "ios/Pods/Target Support Files/Pods-BSVWallet/Pods-BSVWallet.debug.xcconfig" | sort -u && git status --short
```

Expected:
- Info.plist shows both keys, each followed by `<string>BSV Wallet uses Bluetooth to send and receive payments directly between nearby devices.</string>`.
- Podfile.lock still lists `- LocalPayTransport (0.1.0):` under PODS, `LocalPayTransport (from \`../packages/react-native-localpay-transport\`)` under DEPENDENCIES/EXTERNAL SOURCES, and a changed `LocalPayTransport:` checksum under SPEC CHECKSUMS (the podspec changed).
- The app target's aggregate xcconfig (`Pods-BSVWallet.debug.xcconfig` — with static frameworks, a pod's `s.frameworks` are emitted into the APP target's `OTHER_LDFLAGS`, not the pod's own xcconfig) prints three lines: `-framework "CoreBluetooth"`, `-framework "CoreNFC"`, `-framework "Network"`. Today it prints only `Network` (and `Security`), so the two new lines are the proof the podspec change reached CocoaPods.
- `git status --short` shows ` M app.json`, ` M ios/BSVWallet/Info.plist`, ` M ios/Podfile.lock` (possibly ` M ios/BSVWallet.xcodeproj/project.pbxproj`) and nothing under `ios/Pods` (gitignored). If `ios/.xcode.env.local` appears it is gitignored too; nothing else should be untracked.

- [ ] **Step 14: iOS build check (simulator, no signing) and CoreBluetooth linkage proof**

A full RN build from a cold `Pods/` takes 10-20 minutes; run it in the background and poll, or accept the wait. This proves the Swift stub compiles against the generated `HybridLocalPayBleTransportSpec` and that the app links.

```bash
cd /Users/personal/git/bsv-wallet/ios && xcodebuild -workspace BSVWallet.xcworkspace -scheme BSVWallet -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -20
```

Expected: last lines include `** BUILD SUCCEEDED **`. If it prints `error: cannot find type 'HybridLocalPayBleTransportSpec' in scope`, Step 7 was skipped or ran from the wrong directory; if it prints `Undefined symbol: _OBJC_CLASS_$_CBManager`, the podspec `frameworks` edit in Step 10 did not reach `pod install` (re-run Step 13).

Then prove CoreBluetooth is actually linked into the app binary (the ITMS-90683 precondition, spec "Why now"):

```bash
APP=$(find ~/Library/Developer/Xcode/DerivedData -path "*Debug-iphonesimulator/BSVWallet.app/BSVWallet" -newer /Users/personal/git/bsv-wallet/ios/Podfile.lock | head -1); echo "$APP"; otool -L "$APP" | grep -i "CoreBluetooth\|CoreNFC"
```

Expected: two lines, `/System/Library/Frameworks/CoreBluetooth.framework/CoreBluetooth` and `/System/Library/Frameworks/CoreNFC.framework/CoreNFC`.

- [ ] **Step 15: Commit app.json and the regenerated ios/**

```bash
cd /Users/personal/git/bsv-wallet && git add app.json ios && git commit -m "chore(ble): link CoreBluetooth and declare the Bluetooth usage strings

app.json gains NSBluetoothAlwaysUsageDescription and
NSBluetoothPeripheralUsageDescription (spec 2026-09-02 §8); ios/ is
regenerated with expo prebuild so Info.plist carries them and
Podfile.lock picks up the LocalPayTransport podspec that now links
CoreBluetooth and CoreNFC. The web-browser entitlement that made this
key impossible was removed in de13669/1dc1d92; Task 2's TestFlight
upload is the ITMS-90683 proof.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 16: Android compile check (EAS local dev build)**

`android/` is not committed in this repo (root `.gitignore` ignores the top-level `android` dir), so there is no gradle wrapper to invoke directly; the Android compile check is the EAS local development build, which runs `expo prebuild --platform android` and gradle in a temp dir. It compiles `HybridLocalPayBleTransport.kt` against the regenerated `HybridLocalPayBleTransportSpec.kt` and builds `libLocalPayTransport.so` with the regenerated OnLoad/JNI sources. Needs a local Android SDK + NDK 27.1.12297006 + JDK 17; takes 10-30 minutes.

```bash
cd /Users/personal/git/bsv-wallet && npm run android-dev-build 2>&1 | tail -25
```

Expected: the tail contains `BUILD SUCCESSFUL` from gradle followed by EAS's `Build successful` and a line naming the artifact (`build-<timestamp>.apk` written to the repo root; `*.apk` is gitignored, do not commit it). A Kotlin failure would appear as `e: file:///.../HybridLocalPayBleTransport.kt:<line>:<col> ...` — the most likely cause is a mismatch with the generated abstract signatures in `nitrogen/generated/android/kotlin/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransportSpec.kt`, which Step 7 must have produced (`abstract fun prepare(timeoutMs: Double): Promise<String>`, `abstract fun bluetoothState(): String`, `abstract fun nfcAvailable(): Boolean`, plus the four AWDL-shaped methods).

Optional device smoke (either platform, dev client installed): in the Metro console run `require('react-native-localpay-transport').getLocalPayBleTransport()?.bluetoothState()`. Expected: iOS `'unknown'` (or `'unauthorized'` if Bluetooth is denied for the app); Android `'poweredOn'` / `'poweredOff'`. Then `.prepare(1000).catch(e => e.message)` → `'bluetooth unavailable'`, with `LocalPayBle` logging `prepare: Task 1 stub, rejecting "bluetooth unavailable"` (iOS: `log stream --predicate 'category == "LocalPayBle"'`; Android: `adb logcat -s LocalPayBle`). No Bluetooth permission prompt may appear at any point in this task — if one does, something instantiated a `CBManager`, which this stub must not.

- [ ] **Step 17: Final state check**

```bash
cd /Users/personal/git/bsv-wallet && git status --short && git log --oneline -3 && npx jest packages/expo-wallet-toolbox/__tests__/localpay && npx tsc --noEmit -p packages/react-native-localpay-transport/tsconfig.json && echo TSC_OK
```

Expected: clean working tree (only the pre-existing untracked `docs/1.0.0/` and any `build-*.apk`), the three commits from Steps 6, 11 and 15 on top of `1568bb9`, `Test Suites: 11 passed, 11 total`, and `TSC_OK`. Nothing in `packages/expo-wallet-toolbox/core` or `ui` changed in this task; `localSupportsBle`, `bleTransport` and the session bits are Tasks 3-5.


---

### Task 2: TestFlight pre-flight for ITMS-90683

**HUMAN-IN-THE-LOOP TASK.** This task uploads a real binary to App Store Connect. It needs the Apple ASC API key at `/Users/personal/Certificates/AuthKey_23GZFDBWMS.p8` (the path in `eas.json` → `submit.production.ios.ascApiKeyPath`), an Expo login with access to the `bsvb` owner (`app.json` → `expo.owner`), and a Mac with Xcode. It cannot run in a sandbox. If Step 3 shows that any credential is missing, do not improvise: stop and hand Steps 4–9 verbatim to the product owner (Deggen), then resume the plan at Task 3 only after the record file from Step 9 exists in `HEAD`.

**Why this task exists (spec "Why now", "Testing → Store gate", "Rollout order 0").** On 2026-07-27 App Store Connect rejected this project's binary with ITMS-90683 because CoreBluetooth was linked and `NSBluetoothAlwaysUsageDescription` was forbidden by the `com.apple.developer.web-browser` entitlement. That entitlement was removed on 2026-08-26 (`de13669`/`1dc1d92`). The spec's premise is that the plist key can now be set and the upload accepted. ITMS-90683 fires at Deliver (the actual upload), not at Transporter's Verify, so the only proof is a real upload. Everything in Tasks 3+ (Swift/Kotlin backends, UI) is wasted if this fails, hence the gate sits here.

**Files:**
- Create: `docs/superpowers/2026-09-02-ble-preflight.md`
- Modify: none (no source changes in this task)
- Test: none (store gate; verification is command output and the App Store Connect result)

**Interfaces:**
- Consumes (must already be in `HEAD` from Task 1):
  - `app.json` → `expo.ios.infoPlist.NSBluetoothAlwaysUsageDescription` = `"BSV Wallet uses Bluetooth to send and receive payments directly between nearby devices."` and `NSBluetoothPeripheralUsageDescription` with the same text (spec §8)
  - `packages/react-native-localpay-transport/LocalPayTransport.podspec` → `s.frameworks = 'Network', 'Security', 'CoreBluetooth', 'CoreNFC'` and `ios/HybridLocalPayBleTransport.swift` in `s.source_files` (spec §8; `ios/BleGattProfile.swift` joins the list in Task 8)
  - `packages/react-native-localpay-transport/nitro.json` → autolinking key `LocalPayBleTransport` with `implementationClassName: "HybridLocalPayBleTransport"` on both platforms
  - Regenerated `ios/` (`ios/BSVWallet/Info.plist` carries the two `NSBluetooth*` keys)
  - `package.json` script `ios-build-for-app-store` = `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 eas build --profile production --platform ios --local --verbose-logs --build-logger-level trace`
  - `eas.json` → `build.production` (`autoIncrement: true`, `ios.credentialsSource: "remote"`, `cli.appVersionSource: "remote"`) and `submit.production.ios` (`ascApiKeyPath: /Users/personal/Certificates/AuthKey_23GZFDBWMS.p8`, `ascApiKeyId: 23GZFDBWMS`, `ascApiKeyIssuerId: 296a2a8a-ed8d-466f-967c-6c8e59100f5e`, `ascAppId: 6805775325`, `appleTeamId: SV8SWTHA2H`)
- Produces:
  - One TestFlight build of `org.bsvblockchain.wallet` that links CoreBluetooth and declares `NSBluetoothAlwaysUsageDescription`
  - `docs/superpowers/2026-09-02-ble-preflight.md` recording date, version, build number, and the ITMS-90683 outcome
  - A go/no-go decision: Tasks 3+ proceed only on "ITMS-90683 not raised"

All commands run from the repo root `/Users/personal/git/bsv-wallet`. Scratch directory for this task: `/private/tmp/claude-502/-Users-personal-git-bsv-wallet/26583f48-1da5-440b-accc-13f01e7486d0/scratchpad` (referred to below as `$SCRATCH`; export it first, see Step 1).

- [ ] **Step 1: Confirm the working tree is clean and Task 1 is committed**

  Run:
  ```bash
  cd /Users/personal/git/bsv-wallet
  export SCRATCH=/private/tmp/claude-502/-Users-personal-git-bsv-wallet/26583f48-1da5-440b-accc-13f01e7486d0/scratchpad
  git status --porcelain
  git log --oneline -3
  git grep -n NSBluetoothAlwaysUsageDescription HEAD -- app.json ios/BSVWallet/Info.plist
  git grep -n CoreBluetooth HEAD -- packages/react-native-localpay-transport/LocalPayTransport.podspec
  git grep -n '"LocalPayBleTransport"' HEAD -- packages/react-native-localpay-transport/nitro.json
  ```
  Expected:
  - `git status --porcelain` prints nothing (an untracked `docs/1.0.0/` directory pre-dates this plan and is acceptable; anything else is not).
  - `git log --oneline -3` shows Task 1's commit(s) on top (scope `transport` or `localpay`, e.g. `feat(transport): add LocalPayBleTransport nitro spec, config and JS accessor`), above `1568bb9 docs(spec): BLE transport rung and session QR capability flags design`.
  - The first `git grep` prints two lines: one from `app.json`, one from `ios/BSVWallet/Info.plist` (the prebuilt plist is committed; if only `app.json` matches, Task 1 skipped `npx expo prebuild --clean --platform ios` — go back and finish Task 1).
  - The second `git grep` prints one line: `HEAD:packages/react-native-localpay-transport/LocalPayTransport.podspec:...  s.frameworks   = 'Network', 'Security', 'CoreBluetooth', 'CoreNFC'`.
  - The third `git grep` prints at least one line from `nitro.json`.

  If any expectation fails, stop: this task must run on exactly the committed tree that the later native tasks build on.

- [ ] **Step 2: Confirm the web-browser entitlement is gone**

  Rationale: the entitlement is what made the plist key illegal in July (spec "Why now"). Run:
  ```bash
  cd /Users/personal/git/bsv-wallet
  git grep -n web-browser -- ios app.json plugins eas.json package.json; echo "exit=$?"
  ls plugins
  ```
  Expected: the `git grep` prints no lines and `exit=1` (no match). `ls plugins` lists `withNfcReaderEntitlement.js` and `withXcodeLastUpgradeVersion.js` (or their `.ts`/`.cjs` equivalents) and nothing whose name contains `WebBrowser` or `web-browser`. If there is any match, stop — the spec's premise is not met and re-adding the plist key will reproduce the July rejection.

- [ ] **Step 3: Confirm credentials and tooling (hand-off gate)**

  Run:
  ```bash
  test -r /Users/personal/Certificates/AuthKey_23GZFDBWMS.p8 && echo "asc key: present" || echo "asc key: MISSING"
  npx eas --version
  npx eas whoami
  xcodebuild -version
  npx eas build:version:get --platform ios --profile production --non-interactive
  ```
  Expected:
  - `asc key: present`
  - `eas-cli/23.2.0 darwin-arm64 node-v24.15.0` (or newer `eas-cli/23.x`; `eas.json` requires `>=16.28.0`)
  - `npx eas whoami` prints an Expo username that belongs to the `bsvb` organisation (not `Not logged in`)
  - `xcodebuild -version` prints `Xcode 26.x` (26.6 on this Mac)
  - `build:version:get` prints the current remote iOS build number, e.g. `iOS buildNumber - 166`. Note it as `PREV_BUILD`; `autoIncrement: true` will bump it by one for this build.

  If `asc key: MISSING` or `Not logged in`: STOP. Do not attempt `eas login` or place a key anywhere. Hand this task to the product owner with the text of Steps 4–9, and resume at Task 3 only when `docs/superpowers/2026-09-02-ble-preflight.md` is in `HEAD` with the line `ITMS-90683 not raised`.

- [ ] **Step 4: Build the App Store binary locally**

  This is the `production` profile with `credentialsSource: remote` (distribution certificate and provisioning profile are pulled from EAS) and `autoIncrement: true` (build number is bumped on EAS servers first). It takes 15–40 minutes on this machine. Run:
  ```bash
  cd /Users/personal/git/bsv-wallet
  npm run ios-build-for-app-store 2>&1 | tee "$SCRATCH/ios-build.log"
  echo "build exit=${PIPESTATUS[0]}"
  ls -t build-*.ipa | head -1
  ```
  Expected:
  - The log contains `Incrementing iOS build number` (or `Using remote iOS build number`) followed by the number `PREV_BUILD + 1`.
  - The log ends with the local build summary; the final lines print the absolute path of a new `build-<epoch-ms>.ipa` in the repo root (the same naming as the existing `build-1788316442620.ipa`). `build exit=0`.
  - `ls -t build-*.ipa | head -1` prints that new file. Set it for the following steps:
    ```bash
    export IPA="$(cd /Users/personal/git/bsv-wallet && ls -t build-*.ipa | head -1)"
    echo "$IPA"
    ```
  - `*.ipa` is in `.gitignore` (line 31), so `git status --porcelain` still prints nothing.

  If the build fails on pods: the Task 1 podspec must list `CoreBluetooth` in `s.frameworks` and `ios/HybridLocalPayBleTransport.swift` must exist (the inert Task 1 stub); do not "fix" by removing CoreBluetooth — linking it is the whole point of this task.

- [ ] **Step 5: Verify CoreBluetooth linkage and the plist key inside the .ipa**

  On this project a build has "succeeded" before while silently missing a native module (see `docs/superpowers/2026-08-20-morning-handoff.md`), so inspect the binary rather than trusting the log. Run:
  ```bash
  rm -rf "$SCRATCH/ipa" && mkdir -p "$SCRATCH/ipa"
  unzip -o -q "/Users/personal/git/bsv-wallet/$IPA" -d "$SCRATCH/ipa"
  ls "$SCRATCH/ipa/Payload"
  otool -L "$SCRATCH/ipa/Payload/BSVWallet.app/BSVWallet" | grep -i bluetooth
  plutil -p "$SCRATCH/ipa/Payload/BSVWallet.app/Info.plist" | grep NSBluetooth
  plutil -p "$SCRATCH/ipa/Payload/BSVWallet.app/Info.plist" | grep -E 'CFBundleShortVersionString|CFBundleVersion|CFBundleIdentifier'
  strings "$SCRATCH/ipa/Payload/BSVWallet.app/BSVWallet" | grep -c HybridLocalPayBleTransport
  codesign -d --entitlements :- "$SCRATCH/ipa/Payload/BSVWallet.app" 2>/dev/null | grep -c web-browser
  codesign -d --entitlements :- "$SCRATCH/ipa/Payload/BSVWallet.app" 2>/dev/null | grep -A1 get-task-allow
  ```
  Expected:
  - `ls` shows `BSVWallet.app` (product name from `ios/BSVWallet.xcodeproj/project.pbxproj` `PRODUCT_NAME = "BSVWallet"`).
  - `otool -L … | grep -i bluetooth` prints exactly one line: `/System/Library/Frameworks/CoreBluetooth.framework/CoreBluetooth (compatibility version 1.0.0, current version 1.0.0)`. `app.json` sets `useFrameworks: "static"`, so the `LocalPayTransport` pod is linked into the main executable and its framework dependency appears here, not in a nested `Frameworks/` dylib. No line = CoreBluetooth is not linked and this pre-flight proves nothing; go back to Task 1.
  - `grep NSBluetooth` prints two lines:
    `"NSBluetoothAlwaysUsageDescription" => "BSV Wallet uses Bluetooth to send and receive payments directly between nearby devices."`
    `"NSBluetoothPeripheralUsageDescription" => "BSV Wallet uses Bluetooth to send and receive payments directly between nearby devices."`
  - The version grep prints `"CFBundleIdentifier" => "org.bsvblockchain.wallet"`, `"CFBundleShortVersionString" => "<version>"`, `"CFBundleVersion" => "<PREV_BUILD + 1>"`. Record both values:
    ```bash
    export APP_VERSION="$(plutil -extract CFBundleShortVersionString raw "$SCRATCH/ipa/Payload/BSVWallet.app/Info.plist")"
    export BUILD_NUMBER="$(plutil -extract CFBundleVersion raw "$SCRATCH/ipa/Payload/BSVWallet.app/Info.plist")"
    echo "version=$APP_VERSION build=$BUILD_NUMBER"
    ```
  - `grep -c HybridLocalPayBleTransport` prints a number `>= 1` (the Task 1 Swift class is compiled in).
  - `grep -c web-browser` prints `0`.
  - `get-task-allow` is followed by `<false/>` (distribution-signed).

- [ ] **Step 6: Submit the .ipa to App Store Connect (Deliver)**

  This is the actual gate. `eas submit` uploads through EAS using the submit profile from `eas.json`: `ascAppId 6805775325`, `appleTeamId SV8SWTHA2H`, API key `23GZFDBWMS` / issuer `296a2a8a-ed8d-466f-967c-6c8e59100f5e`, key file `/Users/personal/Certificates/AuthKey_23GZFDBWMS.p8`. Run:
  ```bash
  cd /Users/personal/git/bsv-wallet
  npx eas submit --platform ios --profile production --path "$IPA" --wait --verbose --non-interactive 2>&1 | tee "$SCRATCH/ios-submit.log"
  echo "submit exit=${PIPESTATUS[0]}"
  ```
  Expected:
  - The log shows the submission being created for `org.bsvblockchain.wallet` (ASC app `6805775325`) and, because of `--wait`, its progress until it finishes; the final status line reports the submission as finished (eas-cli prints `Submitted` / "successfully uploaded to App Store Connect" wording in its summary) and `submit exit=0`.
  - No line in the log begins with `ERROR ITMS-` and no `Transporter` / `Deliver` error block is printed.

  A non-zero exit with an `ITMS-` error is the failure case handled in Step 7. A non-zero exit for any other reason (network, expired API key, "You are not authorized") is a credentials/tooling problem — hand it to the product owner; it is not evidence either way about ITMS-90683.

- [ ] **Step 7: Check for ITMS-90683 in the submit log and in Apple's processing result**

  ITMS-90683 ("Missing Purpose String in Info.plist") is raised by Deliver at upload time and also emailed by App Store Connect to the account holder after processing. Check both. Run:
  ```bash
  grep -n "ITMS-" "$SCRATCH/ios-submit.log"; echo "grep exit=$?"
  grep -n -i "purpose string\|NSBluetooth" "$SCRATCH/ios-submit.log"; echo "grep exit=$?"
  ```
  Expected: both greps print nothing and `grep exit=1`.

  Then, as the product owner (this needs the ASC account, not the CLI):
  1. Open App Store Connect → Apps → BSV Wallet (`6805775325`) → TestFlight → iOS builds. Within about 5–30 minutes the build with `CFBundleVersion = $BUILD_NUMBER` must move from `Processing` to `Ready to Submit` (or `Ready to Test` once assigned to a group). `ITSAppUsesNonExemptEncryption` is `false` in `app.json`, so no export-compliance prompt blocks it.
  2. Check the inbox of the ASC account holder for a message from App Store Connect about build `$APP_VERSION ($BUILD_NUMBER)`. Expected: no email whose subject or body contains `ITMS-90683`. An email saying the build has completed processing is fine.

  Record the outcome as one word before continuing: `ABSENT` (no ITMS-90683 in the log, no rejection email, build reached Ready to Submit) or `PRESENT` (ITMS-90683 in the log or in an email).

- [ ] **Step 8: If ITMS-90683 is PRESENT — record the rejection, commit, and STOP the plan**

  The spec's premise (spec "Why now": removing the web-browser entitlement is sufficient) is wrong. No further BLE task may proceed. Copy the exact Apple wording from `$SCRATCH/ios-submit.log` (or the email) and write the record:
  ```bash
  cd /Users/personal/git/bsv-wallet
  APPLE_WORDING="$(grep -n "ITMS-90683" "$SCRATCH/ios-submit.log" | head -5)"
  cat > docs/superpowers/2026-09-02-ble-preflight.md <<EOF
  # BLE TestFlight pre-flight — ITMS-90683 check

  **Date:** $(date +%Y-%m-%d)
  **Build:** BSV Wallet $APP_VERSION ($BUILD_NUMBER), \`org.bsvblockchain.wallet\`, team SV8SWTHA2H, ASC app 6805775325
  **Artifact:** \`$IPA\` (local EAS \`production\` build, gitignored)
  **Linkage verified before upload:** \`otool -L\` shows \`CoreBluetooth.framework\`; Info.plist carries \`NSBluetoothAlwaysUsageDescription\` and \`NSBluetoothPeripheralUsageDescription\`; no \`web-browser\` entitlement.
  **Result: ITMS-90683 RAISED. BLE plan halted at Task 2.**

  Exact Apple wording (from \`eas submit\` output / App Store Connect email):

  \`\`\`
  $APPLE_WORDING
  \`\`\`

  ## Consequence

  The premise of \`docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md\` ("Why now") does not hold: App Store Connect still rejects a CoreBluetooth-linked binary from this app even with the purpose string set and without the web-browser entitlement. Tasks 3 onward of the BLE plan are not to be executed. Task 1's config (plist keys, podspec framework, nitro spec) must be reverted before the next store submission so the shipping binary does not link CoreBluetooth. The July 2026 note in \`docs/superpowers/2026-08-20-morning-handoff.md\` stands.
  EOF
  git add docs/superpowers/2026-09-02-ble-preflight.md
  git commit -m "docs(ble): record ITMS-90683 rejection at TestFlight pre-flight

  Uploading build $APP_VERSION ($BUILD_NUMBER) with CoreBluetooth linked and
  NSBluetoothAlwaysUsageDescription set was rejected by App Store Connect.
  The BLE transport plan stops here; Task 1 config must be reverted before
  the next store build.

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
  ```
  Expected: `git log --oneline -1` shows the commit above. Then end the plan and report to the product owner. (Skip Step 9.)

- [ ] **Step 9: If ITMS-90683 is ABSENT — record the pass and commit**

  Also capture what EAS knows about the latest build for cross-reference. Note: `eas build --local` builds are not registered as EAS builds, so `eas build:list` may show an older remote build; the authoritative build number is `CFBundleVersion` from Step 5, and `build:version:get` shows the counter EAS incremented for it. Run:
  ```bash
  cd /Users/personal/git/bsv-wallet
  npx eas build:version:get --platform ios --profile production --non-interactive
  npx eas build:list --platform ios --limit 1 --json --non-interactive > "$SCRATCH/build-list.json"; echo "list exit=$?"
  echo "version=$APP_VERSION build=$BUILD_NUMBER ipa=$IPA"
  ```
  Expected: `build:version:get` prints `iOS buildNumber - $BUILD_NUMBER` (equal to the `CFBundleVersion` in the ipa). `list exit=0` (the JSON is informational only).

  Write the record:
  ```bash
  cd /Users/personal/git/bsv-wallet
  cat > docs/superpowers/2026-09-02-ble-preflight.md <<EOF
  # BLE TestFlight pre-flight — ITMS-90683 check

  **Date:** $(date +%Y-%m-%d)
  **Build:** BSV Wallet $APP_VERSION ($BUILD_NUMBER), \`org.bsvblockchain.wallet\`, team SV8SWTHA2H, ASC app 6805775325
  **Artifact:** \`$IPA\` (local EAS \`production\` build via \`npm run ios-build-for-app-store\`, gitignored)
  **Submitted with:** \`eas submit --platform ios --profile production\` (ASC API key 23GZFDBWMS)
  **Result: ITMS-90683 not raised.**

  ## What was verified before upload

  | Check | Result |
  |---|---|
  | \`otool -L Payload/BSVWallet.app/BSVWallet\` | links \`/System/Library/Frameworks/CoreBluetooth.framework/CoreBluetooth\` |
  | Info.plist | \`NSBluetoothAlwaysUsageDescription\` and \`NSBluetoothPeripheralUsageDescription\` present |
  | \`HybridLocalPayBleTransport\` symbol in the binary | present |
  | \`com.apple.developer.web-browser\` entitlement | absent |
  | \`get-task-allow\` | false (distribution-signed) |

  ## What happened at App Store Connect

  - \`eas submit\` finished with exit 0; no \`ITMS-\` line in its output.
  - The build reached **Ready to Submit** in TestFlight.
  - No App Store Connect email referencing ITMS-90683 was received for this build.

  ## Consequence

  The premise of \`docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md\` ("Why now") holds: with the \`com.apple.developer.web-browser\` entitlement removed (\`de13669\`/\`1dc1d92\`), a CoreBluetooth-linked BSV Wallet binary with the Bluetooth purpose string is accepted. Tasks 3+ of the BLE plan may proceed. The "must NOT be added" note about \`NSBluetoothAlwaysUsageDescription\` in \`docs/superpowers/2026-08-20-morning-handoff.md\` is superseded by this record; the docs-amendment task at the end of the plan updates it.
  EOF
  git add docs/superpowers/2026-09-02-ble-preflight.md
  git status --porcelain
  ```
  Expected: `git status --porcelain` prints exactly `A  docs/superpowers/2026-09-02-ble-preflight.md` (plus the pre-existing untracked `?? docs/1.0.0/`). The `.ipa`, `$SCRATCH/ipa`, and the logs are not in the repo.

  Commit:
  ```bash
  cd /Users/personal/git/bsv-wallet
  git commit -m "docs(ble): record TestFlight pre-flight for CoreBluetooth linkage

  Build $APP_VERSION ($BUILD_NUMBER) links CoreBluetooth and declares
  NSBluetoothAlwaysUsageDescription; App Store Connect accepted it without
  ITMS-90683 now that the web-browser entitlement is gone. Gate for the
  BLE transport rung is open.

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
  git log --oneline -1
  rm -rf "$SCRATCH/ipa"
  ```
  Expected: `git log --oneline -1` prints `<sha> docs(ble): record TestFlight pre-flight for CoreBluetooth linkage`. Proceed to Task 3.


---

### Task 3: Session capability bits and mintSession hints

Spec: `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md` §4 ("Session QR capability bits"). The low byte of `c` is the rungs the payee is listening on right now; the high bits are device hints; `selectTransport` never reads the hints. Nothing else in this task touches native code, `select.ts`, `NearbyFlow`, or i18n — `supportsBle` and `hints` are both optional, so the existing `mintSession` caller at `packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx:976-986` compiles unchanged and keeps producing the same caps until Task 10 wires `probeDeviceCaps` in.

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/localpay/session.ts` — lines 4-7 (constants block) and lines 58-68, 81 (`mintSession` signature and `caps` expression). `decodeSession` (lines 145-208) is deliberately NOT modified: line 172 already accepts any number for `c` and line 198 stores it verbatim, so every new bit already round-trips (spec §4: "`decodeSession` is unchanged: it already accepts any number"; the existing test 'a payload with unknown extra keys and unknown cap bits still decodes' at `session.test.ts:244-252` proves it with `0xff`).
- Test: `packages/expo-wallet-toolbox/__tests__/localpay/session.test.ts` — lines 1-3 (imports), lines 40-43 (extend the AWDL test block with new tests after it), lines 57-59 (REPLACE 'stays small enough for one static QR').
- Read-only context: `package.json:101` (`"qrcode": "^1.5.4"` is a root dependency; `node_modules/@types/qrcode/index.d.ts:314` declares `create(text, options): QRCode` with `.version: number`), `packages/expo-wallet-toolbox/ui/backupShares.ts:26` (existing `import QRCode from 'qrcode'` style), `node_modules/@bsv/sdk/dist/esm/src/auth/utils/createNonce.js` (`toBase64([...16 random, ...32 hmac])` — 48 bytes → 64 base64 chars, which is why the fixture nonce below is 48 bytes).

**Interfaces:**
- Consumes (unchanged): `Random` from `@bsv/sdk`, `CodecError` from `./codec`, `encodeSession(s: Session): string`, `decodeSession(text: string): Session`.
- Produces (new exports from `core/localpay/session.ts`; `core/index.ts:53` `export * from './localpay/session'` re-exports them automatically):
  ```ts
  export const HINT_ONLINE = 0x0100
  export const HINT_ONLINE_KNOWN = 0x0200
  export const HINT_NET = 0x0400
  export const HINT_WIFI = 0x0800
  export const HINT_BT = 0x1000
  export const HINT_NFC = 0x2000
  export const RUNG_MASK = 0x00ff
  export function mintSession(args: {
    identityKey: string
    amount?: number
    asset?: SessionAsset
    derivationPrefix: string
    derivationSuffix: string
    supportsAwdl: boolean
    supportsNearby?: boolean
    supportsBle?: boolean
    hints?: number
    os?: SessionOs
  }): Session
  ```
  `CAP_AWDL`, `CAP_NEARBY`, `CAP_BLE` keep their values (0x01, 0x02, 0x04). Later tasks consume: Task 4 (`select.ts` ladder reads `CAP_BLE`, `describeFloor` reads `RUNG_MASK`, `HINT_BT`), Task 6 (`deviceCaps.ts` `capsFromProbe` returns `HINT_*` bits), Task 10 (`NearbyFlow` passes `supportsBle` and `hints`).

Commands (run from repo root `/Users/personal/git/bsv-wallet`):
- Test: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/session.test.ts`
- Typecheck: `npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep "error TS" | grep -v "core/pay/rails/handle.ts\|ui/components/pay/HandleReceive.tsx"` (that tsconfig includes `core/**/*` and `ui/**/*` only, so the test file is not typechecked — jest-expo transforms it with Babel; this is why an unknown `supportsBle` argument fails at the assertion, not at compile time).

Baseline before you start: the suite is green at 38 tests (`Tests: 38 passed, 38 total`).

- [ ] **Step 1: Write the failing tests for the new bits**

Open `packages/expo-wallet-toolbox/__tests__/localpay/session.test.ts`. Replace lines 1-4 (the import block) with:

```ts
import QRCode from 'qrcode'
import {
  mintSession, encodeSession, decodeSession, instanceName, CAP_AWDL, CAP_NEARBY, SESSION_VERSION, CAP_BLE,
  HINT_ONLINE, HINT_ONLINE_KNOWN, HINT_NET, HINT_WIFI, HINT_BT, HINT_NFC, RUNG_MASK, type SessionAsset,
} from '../../core/localpay/session'
import { CodecError } from '../../core/localpay/codec'
```

Then, directly after the existing test `'sets the AWDL capability bit'` (lines 40-43, ending `  })`), insert these four tests:

```ts
  // ── Capability word layout (spec §4) ──
  //
  // Low byte: rungs the payee is LISTENING ON right now; the payer's ladder
  // reads only these. High bits: device hints for copy and future rungs. A
  // clear bit means "false or unknown"; only ONLINE gets a companion KNOWN bit
  // because it is the one probe that can time out.

  it('defines the rung and hint bits from spec §4', () => {
    expect(CAP_AWDL).toBe(0x01)
    expect(CAP_NEARBY).toBe(0x02)
    expect(CAP_BLE).toBe(0x04)
    expect(HINT_ONLINE).toBe(0x0100)
    expect(HINT_ONLINE_KNOWN).toBe(0x0200)
    expect(HINT_NET).toBe(0x0400)
    expect(HINT_WIFI).toBe(0x0800)
    expect(HINT_BT).toBe(0x1000)
    expect(HINT_NFC).toBe(0x2000)
    expect(RUNG_MASK).toBe(0x00ff)
    // Every hint lives above the rung byte; no hint can be mistaken for a rung.
    for (const hint of [HINT_ONLINE, HINT_ONLINE_KNOWN, HINT_NET, HINT_WIFI, HINT_BT, HINT_NFC]) {
      expect(hint & RUNG_MASK).toBe(0)
    }
  })

  it('sets the BLE capability bit only when advertised', () => {
    expect(mintSession({ ...args, supportsBle: true }).caps & CAP_BLE).toBe(CAP_BLE)
    expect(mintSession({ ...args, supportsBle: false }).caps & CAP_BLE).toBe(0)
    // Omitted means not advertised: the existing caller in NearbyFlow does not
    // pass it yet and must keep minting exactly what it mints today.
    expect(mintSession(args).caps & CAP_BLE).toBe(0)
    // The BLE rung does not disturb the other rungs.
    expect(mintSession({ ...args, supportsBle: true }).caps & CAP_AWDL).toBe(CAP_AWDL)
  })

  it('masks hints to the non-rung bits and ORs them into caps', () => {
    // A caller that smuggles a rung bit inside `hints` must not be able to
    // advertise a listener it never started: rungs come from supports* only.
    const hints = HINT_ONLINE | HINT_BT | CAP_AWDL
    const withAwdl = mintSession({ ...args, supportsAwdl: true, hints })
    expect(withAwdl.caps & HINT_ONLINE).toBe(HINT_ONLINE)
    expect(withAwdl.caps & HINT_BT).toBe(HINT_BT)
    expect(withAwdl.caps & CAP_AWDL).toBe(CAP_AWDL)
    expect(withAwdl.caps & HINT_NET).toBe(0)
    const withoutAwdl = mintSession({ ...args, supportsAwdl: false, hints })
    expect(withoutAwdl.caps & HINT_ONLINE).toBe(HINT_ONLINE)
    expect(withoutAwdl.caps & HINT_BT).toBe(HINT_BT)
    expect(withoutAwdl.caps & CAP_AWDL).toBe(0)
    expect(withoutAwdl.caps & RUNG_MASK).toBe(0)
    // No hints at all is the same word as today.
    expect(mintSession(args).caps).toBe(CAP_AWDL)
    expect(mintSession({ ...args, hints: 0 }).caps).toBe(CAP_AWDL)
  })

  it('round-trips every defined bit through the QR', () => {
    const s = mintSession({
      ...args,
      supportsAwdl: true,
      supportsNearby: true,
      supportsBle: true,
      hints: HINT_ONLINE | HINT_ONLINE_KNOWN | HINT_NET | HINT_WIFI | HINT_BT | HINT_NFC,
    })
    expect(s.caps).toBe(0x3f07)
    // decodeSession is untouched by this change: `c` was already "any number",
    // so the new bits survive the wire with no decoder work (spec §4).
    const back = decodeSession(encodeSession(s))
    expect(back.caps).toBe(s.caps)
    expect(back.caps & RUNG_MASK).toBe(CAP_AWDL | CAP_NEARBY | CAP_BLE)
    expect(back.caps & ~RUNG_MASK).toBe(0x3f00)
  })
```

- [ ] **Step 2: Run the suite and confirm the four new tests fail for the right reason**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/session.test.ts`

Expected: `Tests: 4 failed, 38 passed, 42 total`. The failures, in order:
- `defines the rung and hint bits from spec §4` — `expect(HINT_ONLINE).toBe(0x0100)` → `Expected: 256` / `Received: undefined` (the constants do not exist yet, so the named imports resolve to `undefined`).
- `sets the BLE capability bit only when advertised` — first assertion `Expected: 4` / `Received: 0` (`supportsBle` is ignored by the current `caps` expression on `session.ts:81`).
- `masks hints to the non-rung bits and ORs them into caps` — `expect(withAwdl.caps & HINT_ONLINE).toBe(HINT_ONLINE)` → `Expected: undefined` / `Received: 0`.
- `round-trips every defined bit through the QR` — `expect(s.caps).toBe(0x3f07)` → `Expected: 16135` / `Received: 3` (only AWDL and Nearby are set today).

If instead you see a `SyntaxError` on the import line, you have a typo in the import list — jest-expo does not typecheck, so the import of a non-existent name is `undefined`, never a module error.

- [ ] **Step 3: Implement the constants and the mintSession change**

Open `packages/expo-wallet-toolbox/core/localpay/session.ts`. Replace lines 4-7:

```ts
export const SESSION_VERSION = 1
export const CAP_AWDL = 0x01
export const CAP_NEARBY = 0x02
export const CAP_BLE = 0x04 // allocated for BLE transports (e.g. Blitz); this app never advertises it
```

with:

```ts
export const SESSION_VERSION = 1

/**
 * The capability word `c` in the session QR.
 *
 * LOW BYTE — rungs the payee is LISTENING ON right now. The payer's ladder
 * (transport/select.ts) reads only these bits: a set rung is a promise that a
 * listener for it is live behind this QR.
 */
export const CAP_AWDL = 0x01
export const CAP_NEARBY = 0x02
/** Payee is advertising bsvpay-ble/1 — now advertised by this app, and the profile Blitz adopts. */
export const CAP_BLE = 0x04
// 0x08..0x80 reserved for future rungs (L2CAP, NFC, Wi-Fi Aware).

/**
 * HIGH BITS — device hints. Never read for transport selection; they feed one
 * line of copy on the payer's confirm screen (why this pair is on the QR
 * floor) and are available to future rungs.
 *
 * A CLEAR bit means "false OR unknown". Only ONLINE gets a companion KNOWN
 * bit, because reachability is the one probe that can time out inside the
 * minting budget; every other hint is a synchronous, prompt-free read.
 */
export const HINT_ONLINE = 0x0100 // internet reachable
export const HINT_ONLINE_KNOWN = 0x0200 // HINT_ONLINE is meaningful (the probe answered within budget)
export const HINT_NET = 0x0400 // any connectivity
export const HINT_WIFI = 0x0800 // Android: Wi-Fi radio on. iOS: associated with a Wi-Fi network (no radio API)
export const HINT_BT = 0x1000 // Bluetooth authorized and powered on
export const HINT_NFC = 0x2000 // NFC reader available
/** Selects the rung byte; `~RUNG_MASK` selects the hints. */
export const RUNG_MASK = 0x00ff
```

Then change the `mintSession` signature (lines 58-68 in the original file) from:

```ts
export function mintSession(args: {
  identityKey: string
  /** Omit for an open request — the payer enters the amount. */
  amount?: number
  asset?: SessionAsset
  derivationPrefix: string
  derivationSuffix: string
  supportsAwdl: boolean
  supportsNearby?: boolean
  os?: SessionOs
}): Session {
```

to:

```ts
export function mintSession(args: {
  identityKey: string
  /** Omit for an open request — the payer enters the amount. */
  amount?: number
  asset?: SessionAsset
  derivationPrefix: string
  derivationSuffix: string
  supportsAwdl: boolean
  supportsNearby?: boolean
  /** True only while a bsvpay-ble/1 listener is actually advertising for this session. */
  supportsBle?: boolean
  /**
   * HINT_* bits from deviceCaps.capsFromProbe. Masked to `~RUNG_MASK` here, so
   * a hint word can never advertise a listener that was not started.
   */
  hints?: number
  os?: SessionOs
}): Session {
```

and the `caps:` line in the returned object (line 81 in the original file) from:

```ts
    caps: (args.supportsAwdl ? CAP_AWDL : 0) | (args.supportsNearby ? CAP_NEARBY : 0),
```

to:

```ts
    caps:
      (args.supportsAwdl ? CAP_AWDL : 0) |
      (args.supportsNearby ? CAP_NEARBY : 0) |
      (args.supportsBle ? CAP_BLE : 0) |
      ((args.hints ?? 0) & ~RUNG_MASK),
```

Rationale: the rung bits come exclusively from the three `supports*` flags and the hint word is masked with `~RUNG_MASK`, so `caps = rungs | (hints & ~RUNG_MASK)` exactly as spec §4 states. `~RUNG_MASK` is `-256` in JS; `&` with any non-negative hint word below 2^31 yields a non-negative number, so `c` stays a plain positive JSON integer. `decodeSession` is not touched: `session.ts:172` accepts any `number` for `c` and `:198` stores it verbatim, and the existing test at `session.test.ts:244-252` already proves unknown bits survive.

- [ ] **Step 4: Run the suite and the typecheck; confirm green**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/session.test.ts`

Expected: `Tests: 42 passed, 42 total`.

Run: `npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep "error TS" | grep -v "core/pay/rails/handle.ts\|ui/components/pay/HandleReceive.tsx"`

Expected: no output. (The four pre-existing, unrelated `TS2345` errors in `core/pay/rails/handle.ts` and `ui/components/pay/HandleReceive.tsx` are filtered away; nothing this task touches may add a line.) The only `mintSession` caller, `NearbyFlow.tsx:976-986`, passes neither new argument and both are optional.

- [ ] **Step 5: Replace the QR size test with realistic nonces and a QR-version assertion**

The fixture `args` uses 8-char nonces (`'cHJlZml4'`, `'c3VmZml4'`). Real sessions carry two `createNonce` values — `toBase64` of 16 random + 32 HMAC bytes = 64 chars each — so the existing `< 300` assertion at `session.test.ts:57-59` understates the real QR by roughly 150 chars (spec §4 "Size"; research note: open 428 / amount 447 chars measured). Replace exactly this block:

```ts
  it('stays small enough for one static QR', () => {
    expect(encodeSession(mintSession(args)).length).toBeLessThan(300)
  })
```

with:

```ts
  it('stays small enough for one static QR', () => {
    // A real createNonce is base64 of 48 bytes (16 random ‖ 32-byte HMAC) =
    // 64 chars; the short fixture nonces above understate the QR by ~150
    // chars. Mint what the payee actually mints: two 64-char nonces, an OS
    // hint, an amount, and every hint bit lit (`c` = 0x3f01, 5 JSON chars).
    const nonce = () => Buffer.alloc(48, 7).toString('base64')
    expect(nonce().length).toBe(64)
    const s = mintSession({
      ...args,
      derivationPrefix: nonce(),
      derivationSuffix: nonce(),
      os: 'ios',
      hints: 0x3f00,
    })
    expect(s.caps).toBe(0x3f01)
    const text = encodeSession(s)
    // Measured 446 chars (spec §4 cites 428-450 for open/amount requests).
    // base64url of fixed-length random bytes has a fixed length, so this is
    // deterministic; the band leaves room for a 1-2 digit amount change.
    expect(text.length).toBeGreaterThanOrEqual(400)
    expect(text.length).toBeLessThanOrEqual(470)
    // The size class that matters is the QR version at error level M: v16-M
    // is what the 288 px session QR renders today and must not regress.
    expect(QRCode.create(text, { errorCorrectionLevel: 'M' }).version).toBeLessThanOrEqual(16)
  })
```

Leave the open-request size test at `session.test.ts:205-207` ('keeps an open session small enough for one static QR') as it is: it documents the open/amount distinction, not the size class, and the corrected size class is asserted once, here.

Note for the reader: `Buffer.alloc(48, 7)` is a constant fill, not random. That is deliberate: base64 length depends only on byte count, so a fixed fill gives a stable 64-char nonce without pulling `Random` into a size test.

- [ ] **Step 6: Run the suite; confirm the replaced test passes with the measured numbers**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/session.test.ts`

Expected: `Tests: 42 passed, 42 total` (the test count is unchanged because this step replaces a test rather than adding one).

To see the measured figures yourself, temporarily add `console.log(text.length, QRCode.create(text, { errorCorrectionLevel: 'M' }).version)` inside the test and rerun: expected `446 16`. Remove the log before committing.

- [ ] **Step 7: Commit**

```bash
git add packages/expo-wallet-toolbox/core/localpay/session.ts packages/expo-wallet-toolbox/__tests__/localpay/session.test.ts
git commit -m "feat(localpay): session capability hint bits and BLE rung flag

The session QR's integer c now carries device hints above the rung byte:
HINT_ONLINE, HINT_ONLINE_KNOWN, HINT_NET, HINT_WIFI, HINT_BT, HINT_NFC
(0x0100..0x2000), with RUNG_MASK = 0x00ff separating them from the rungs
the payee is actually listening on. mintSession gains supportsBle (sets
CAP_BLE, which this app now advertises) and hints (masked to ~RUNG_MASK
so a hint word can never claim a listener that was not started).
decodeSession is unchanged: c was already accepted as any number.

The QR size test now mints with realistic 64-char createNonce values and
asserts the real size class (446 chars, QR v16 at level M) instead of a
< 300 bound that only short fixture nonces could satisfy.

Spec: docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md §4

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: one commit touching two files; `git show --stat HEAD` lists `core/localpay/session.ts` and `__tests__/localpay/session.test.ts`.


---

### Task 4: Selection ladder, localSupportsBle, describeFloor, kind widening

Adds the BLE rung to the payer's transport ladder (spec §5: AWDL → Nearby → BLE → QR), the prompt-free `localSupportsBle()` probe, and the pure `describeFloor()` that tells the payer's confirm screen *why* a pair landed on the QR fountain. Also widens the `'awdl' | 'nearby' | 'qr'` kind unions to include `'ble'`. No native code, no UI: everything here is jest-testable.

**Depends on earlier tasks in this plan** (verify in Step 1 before touching anything):
- `packages/react-native-localpay-transport/src/index.ts` exports `getLocalPayBleTransport()` and `type LocalPayBleTransport` (the Nitro spec / JS accessor task).
- `packages/expo-wallet-toolbox/core/localpay/session.ts` exports `CAP_BLE`, `HINT_BT`, `HINT_WIFI`, `RUNG_MASK` (the session caps task).

**Files:**
- Create: `packages/expo-wallet-toolbox/core/localpay/deviceCaps.ts` (ONLY the `BluetoothState` type; Task 6 fills in the probe)
- Create: `packages/expo-wallet-toolbox/__tests__/localpay/describeFloor.test.ts`
- Modify: `packages/expo-wallet-toolbox/core/localpay/types.ts:64` (the `kind` union)
- Modify: `packages/expo-wallet-toolbox/core/localpay/pending.ts:26` (the `receivedVia` comment)
- Modify: `packages/expo-wallet-toolbox/core/localpay/transport/select.ts:1-42` (whole file is replaced)
- Modify: `packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts:1-65` (the mock, imports, CASES, and the `transport selection` describe; the `requestNearbyPermissions` describe at `:67-110` is untouched)
- Test: `packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts`, `packages/expo-wallet-toolbox/__tests__/localpay/describeFloor.test.ts`

**Interfaces:**
- Consumes:
  - `getLocalPayTransport(): LocalPayTransport | null` and `getLocalPayBleTransport(): LocalPayBleTransport | null` from `'react-native-localpay-transport'` (`LocalPayBleTransport.isSupported(): boolean`, `.bluetoothState(): string`, `.nfcAvailable(): boolean`)
  - `CAP_AWDL = 0x01`, `CAP_NEARBY = 0x02`, `CAP_BLE = 0x04`, `HINT_BT = 0x1000`, `RUNG_MASK = 0x00ff`, `type Session` (fields used: `caps: number`, `os?: 'ios' | 'android'`) from `packages/expo-wallet-toolbox/core/localpay/session.ts`
  - `Platform.OS` from `'react-native'`
- Produces (all from `packages/expo-wallet-toolbox/core/localpay/transport/select.ts` unless stated):
  - `export type TransportKind = 'awdl' | 'nearby' | 'ble' | 'qr'`
  - `export function localSupportsBle(): boolean`
  - `export function selectTransport(session: Session): TransportKind` (existing, gains the BLE rung)
  - `export type FloorReason = 'none' | 'peer_no_radio' | 'peer_bt_off' | 'local_ble_denied' | 'local_bt_off' | 'cross_os_no_ble'`
  - `export function describeFloor(session: Session, local: { os: 'ios' | 'android'; bluetooth: BluetoothState }): FloorReason`
  - `export type BluetoothState = 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown'` from `packages/expo-wallet-toolbox/core/localpay/deviceCaps.ts`
  - `LocalPaymentTransport.kind: 'awdl' | 'nearby' | 'ble' | 'qr'` in `packages/expo-wallet-toolbox/core/localpay/types.ts`
  - Consumed later by: Task 5's `transport/ble.ts` (`kind: 'ble'` must be assignable), Task 6's `deviceCaps.ts` (adds `DeviceProbe`, `capsFromProbe`, `probeDeviceCaps`, `readBluetoothState` beside the type created here), Task 7's barrels (`core/pay/rails/nearby.ts`, `core/index.ts` re-export `localSupportsBle`, `describeFloor`, `type FloorReason`, `type BluetoothState`), and Task 10's NearbyFlow wiring (`floorReason` memo, `bleState: BluetoothState`).

- [ ] **Step 1: Confirm the prerequisites from earlier tasks are in the tree**

Run from the repo root:

```bash
grep -n "export function getLocalPayBleTransport" packages/react-native-localpay-transport/src/index.ts
grep -n "export const CAP_BLE\|export const HINT_BT\|export const HINT_WIFI\|export const RUNG_MASK" packages/expo-wallet-toolbox/core/localpay/session.ts
```

Expected: the first prints one line (`export function getLocalPayBleTransport(): LocalPayBleTransport | null {`), the second prints four lines (`CAP_BLE = 0x04`, `HINT_BT = 0x1000`, `HINT_WIFI = 0x0800`, `RUNG_MASK = 0x00ff`). If either grep prints nothing, STOP: the accessor task and the session caps task must be finished first — this task imports those names and its typecheck step will fail without them.

Also record the typecheck baseline, because the toolbox `tsc` does not currently pass on `master` for reasons unrelated to this work:

```bash
npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep -o '^packages/[^(]*' | sort | uniq -c
```

Expected at `1568bb9` (before any of this plan's tasks): exactly two files, `1 packages/expo-wallet-toolbox/core/pay/rails/handle.ts` and `3 packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx` (an `AtomicBEEF` vs `number[]` mismatch). Write down whatever this prints now; Step 12 requires that no NEW file appears in the list.

- [ ] **Step 2: Create `deviceCaps.ts` with only the `BluetoothState` type**

The contract places `BluetoothState` in `core/localpay/deviceCaps.ts` (Task 6 adds the probe there). `select.ts` needs the type now for `describeFloor`'s `local.bluetooth` parameter, so this task creates the module with the type alone rather than defining it in `select.ts` and moving it later.

Create `packages/expo-wallet-toolbox/core/localpay/deviceCaps.ts` with exactly this content:

```ts
/**
 * Device capability probing for the payee's session QR hint bits (spec §4).
 *
 * This file is populated in Task 6 (DeviceProbe, capsFromProbe,
 * probeDeviceCaps). Only the BluetoothState type lives here for now, because
 * transport/select.ts's describeFloor() needs it for the payer's floor copy
 * and the type belongs beside the probe that produces it.
 */

/**
 * The five states LocalPayBleTransport.bluetoothState() can report. Prompt-free
 * on both platforms: iOS reads CBManager.authorization without instantiating a
 * manager, Android reads BluetoothAdapter.isEnabled(). Anything the native
 * string does not match is coerced to 'unsupported' by the probe.
 */
export type BluetoothState = 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown'
```

- [ ] **Step 3: Widen the `kind` union in `types.ts` and the `receivedVia` comment in `pending.ts`**

Open `packages/expo-wallet-toolbox/core/localpay/types.ts`. Line 64 currently reads:

```ts
  readonly kind: 'awdl' | 'nearby' | 'qr'
```

Change it to:

```ts
  readonly kind: 'awdl' | 'nearby' | 'ble' | 'qr'
```

Open `packages/expo-wallet-toolbox/core/localpay/pending.ts`. Lines 25-29 currently read:

```ts
  /**
   * Which transport this frame arrived over ('awdl' | 'qr'), when the caller
   * knows it. Threaded through so `processPending` can back-attribute the
   * `offline_actions` row this internalize may create — see `attribute`.
   */
```

Change line 26 so the block reads:

```ts
  /**
   * Which transport this frame arrived over ('awdl' | 'nearby' | 'ble' | 'qr'),
   * when the caller knows it. Threaded through so `processPending` can
   * back-attribute the `offline_actions` row this internalize may create —
   * see `attribute`.
   */
```

`receivedVia` itself stays `string`; only the comment was stale. Nothing else in the file changes. `socket.ts:99` (`makeSocketTransport(kind: 'awdl' | 'nearby')`) still compiles because `'awdl' | 'nearby'` is assignable to the widened union; Task 5 widens that parameter when it adds `'ble'`.

Verify both edits landed:

```bash
grep -n "readonly kind" packages/expo-wallet-toolbox/core/localpay/types.ts
sed -n '25,30p' packages/expo-wallet-toolbox/core/localpay/pending.ts
```

Expected: `64:  readonly kind: 'awdl' | 'nearby' | 'ble' | 'qr'` and the five-line comment above.

- [ ] **Step 4: Rewrite the `transport selection` half of `transportSelect.test.ts` (failing)**

Open `packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts`. Replace lines 1-65 (everything from the first import through the closing `})` of `describe('transport selection', ...)`) with the block below. Leave lines 67-110 (`describe('requestNearbyPermissions', ...)`) exactly as they are.

The mock factory may only reference variables whose names start with `mock` (babel-plugin-jest-hoist rule; the existing `mockIsSupported` follows it), so every switch is `mock*`.

```ts
import { PermissionsAndroid, Platform } from 'react-native'
import type { Permission, PermissionStatus } from 'react-native'
import { localSupportsBle, selectTransport } from '../../core/localpay/transport/select'
import { mintSession, CAP_AWDL, CAP_BLE, CAP_NEARBY, type Session } from '../../core/localpay/session'
import { requestNearbyPermissions } from '../../core/localpay/nearbyPermissions'

let mockIsSupported = true
let mockBleSupported = true
let mockBleState = 'poweredOn'
let mockBleAccessorNull = false
let mockBleThrows = false

jest.mock('react-native-localpay-transport', () => ({
  getLocalPayTransport: () => ({ isSupported: () => mockIsSupported }),
  getLocalPayBleTransport: () =>
    mockBleAccessorNull
      ? null
      : {
          isSupported: () => {
            if (mockBleThrows) throw new Error('nitro boom')
            return mockBleSupported
          },
          bluetoothState: () => mockBleState,
          nfcAvailable: () => false
        }
}))

const base = {
  identityKey: '02'.padEnd(66, 'd'),
  amount: 1,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw'
}

describe('transport selection', () => {
  afterEach(() => {
    Platform.OS = 'ios'
    mockIsSupported = true
    mockBleSupported = true
    mockBleState = 'poweredOn'
    mockBleAccessorNull = false
    mockBleThrows = false
  })

  it('uses AWDL when both sides support it', () => {
    Platform.OS = 'ios'
    expect(selectTransport(mintSession({ ...base, supportsAwdl: true }))).toBe('awdl')
  })

  it('falls back to QR when the payee cannot do AWDL', () => {
    Platform.OS = 'ios'
    expect(selectTransport(mintSession({ ...base, supportsAwdl: false }))).toBe('qr')
  })

  it('falls back to QR when the local device is Android', () => {
    Platform.OS = 'android'
    expect(selectTransport(mintSession({ ...base, supportsAwdl: true }))).toBe('qr')
  })

  it('leaves the AWDL capability bit set only when advertised', () => {
    expect(mintSession({ ...base, supportsAwdl: false }).caps & CAP_AWDL).toBe(0)
  })

  // caps × platform × socket-native support × BLE-native support → transport
  const CASES: [
    caps: number,
    platform: 'ios' | 'android',
    nativeSocket: boolean,
    nativeBle: boolean,
    expected: string
  ][] = [
    [CAP_AWDL, 'ios', true, true, 'awdl'],
    [CAP_AWDL, 'ios', false, true, 'qr'],
    [CAP_AWDL, 'android', true, true, 'qr'], // AWDL cap useless off-iOS
    [CAP_NEARBY, 'android', true, true, 'nearby'],
    [CAP_NEARBY, 'android', false, true, 'qr'],
    [CAP_NEARBY, 'ios', true, true, 'qr'], // Nearby cap useless on iOS
    [CAP_AWDL | CAP_NEARBY, 'ios', true, true, 'awdl'], // AWDL outranks Nearby
    [CAP_AWDL | CAP_NEARBY, 'android', true, true, 'nearby'],
    [0, 'ios', true, true, 'qr'],
    [0, 'android', true, true, 'qr'],
    // BLE rung (spec §5): the one radio that exists on both platforms
    [CAP_BLE, 'ios', true, true, 'ble'],
    [CAP_BLE, 'android', true, true, 'ble'],
    [CAP_AWDL | CAP_BLE, 'android', true, true, 'ble'], // iOS payee, Android payer → BLE
    [CAP_NEARBY | CAP_BLE, 'ios', true, true, 'ble'], // Android payee, iOS payer → BLE
    [CAP_AWDL | CAP_NEARBY | CAP_BLE, 'ios', true, true, 'awdl'], // same-OS keeps the faster radio
    [CAP_AWDL | CAP_NEARBY | CAP_BLE, 'android', true, true, 'nearby'],
    [CAP_BLE, 'ios', true, false, 'qr'], // peer advertises BLE but this device cannot
    [CAP_AWDL | CAP_BLE, 'ios', false, true, 'ble'] // AWDL native unsupported → falls to BLE
  ]

  it.each(CASES)(
    'caps=%p platform=%s socket=%p ble=%p -> %s',
    (caps, platform, nativeSocket, nativeBle, expected) => {
      Platform.OS = platform
      mockIsSupported = nativeSocket
      mockBleSupported = nativeBle
      const session: Session = { ...mintSession({ ...base, supportsAwdl: false }), caps }
      expect(selectTransport(session)).toBe(expected)
    }
  )
})

describe('localSupportsBle', () => {
  afterEach(() => {
    Platform.OS = 'ios'
    mockBleSupported = true
    mockBleAccessorNull = false
    mockBleThrows = false
  })

  it('is true on either OS when the native object reports support', () => {
    Platform.OS = 'android'
    expect(localSupportsBle()).toBe(true)
    Platform.OS = 'ios'
    expect(localSupportsBle()).toBe(true)
  })

  it('is false when the accessor returns null (no native module)', () => {
    mockBleAccessorNull = true
    expect(localSupportsBle()).toBe(false)
  })

  it('is false when the native probe throws', () => {
    mockBleThrows = true
    expect(localSupportsBle()).toBe(false)
  })
})
```

- [ ] **Step 5: Run the rewritten test and watch the new expectations fail**

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts
```

Expected: `Tests: 8 failed, 20 passed, 28 total`. The five CASES rows whose expected value is `'ble'` fail with

```
Expected: "ble"
Received: "qr"
```

and the three `localSupportsBle` tests fail with

```
TypeError: (0 , _select.localSupportsBle) is not a function
```

(`select.ts` has no such export yet, so the named import is `undefined`). The `[CAP_BLE, 'ios', true, false, 'qr']` row and the two `CAP_AWDL | CAP_NEARBY | CAP_BLE` rows already pass because the current ladder never returns `'ble'`. If instead the whole file fails to compile, re-check Step 1: `CAP_BLE` must be exported from `session.ts`.

- [ ] **Step 6: Implement `localSupportsBle` and the BLE rung in `select.ts`**

Replace the entire contents of `packages/expo-wallet-toolbox/core/localpay/transport/select.ts` with:

```ts
import { Platform } from 'react-native'
import { getLocalPayBleTransport, getLocalPayTransport } from 'react-native-localpay-transport'
import { CAP_AWDL, CAP_BLE, CAP_NEARBY, type Session } from '../session'

export type TransportKind = 'awdl' | 'nearby' | 'ble' | 'qr'

/** True when this device can act as an AWDL peer. */
export function localSupportsAwdl(): boolean {
  if (Platform.OS !== 'ios') return false
  try {
    return getLocalPayTransport()?.isSupported() ?? false
  } catch {
    return false
  }
}

/**
 * True when this device can act as a Nearby Connections peer. The same native
 * surface as AWDL, from the Kotlin backend: isSupported() there means Google
 * Play services is present. Runtime permissions are requested at flow entry,
 * not here — a denial degrades the mint/ladder to QR at that point.
 */
export function localSupportsNearby(): boolean {
  if (Platform.OS !== 'android') return false
  try {
    return getLocalPayTransport()?.isSupported() ?? false
  } catch {
    return false
  }
}

/**
 * True when this device can act as a BLE peer. No Platform.OS gate: BLE is the
 * one radio that exists on both platforms, which is the whole reason it is on
 * the ladder (spec §5). Prompt-free — the native isSupported() reads hardware
 * presence plus CBManager.authorization / BluetoothAdapter without creating a
 * manager, and `notDetermined` counts as supported so the ladder can pick BLE
 * and let the iOS prompt appear inside sendFrame()/prepare() (spec §7).
 * denied/restricted report unsupported and floor the pair to QR, and so does a
 * radio the native side already knows is powered off (Android always, via
 * BluetoothAdapter.isEnabled; iOS once a manager has existed in this process)
 * — that is what makes describeFloor's local_bt_off row reachable.
 */
export function localSupportsBle(): boolean {
  try {
    return getLocalPayBleTransport()?.isSupported() ?? false
  } catch {
    return false
  }
}

/**
 * The rung both sides can climb to. Caps say what the PEER advertised at mint
 * time; the local check says what THIS device can do. Same-OS pairs keep the
 * higher-throughput radio they have today; cross-OS pairs land on BLE because
 * the peer's AWDL/Nearby bits can never match local ability. `session.os` is
 * metadata and is deliberately not read here (see Session.os). QR is the
 * floor every pair can reach — and the automatic fallback when a chosen radio
 * fails at send time (see NearbyFlow's executeSend).
 */
export function selectTransport(session: Session): TransportKind {
  if ((session.caps & CAP_AWDL) !== 0 && localSupportsAwdl()) return 'awdl'
  if ((session.caps & CAP_NEARBY) !== 0 && localSupportsNearby()) return 'nearby'
  if ((session.caps & CAP_BLE) !== 0 && localSupportsBle()) return 'ble'
  return 'qr'
}
```

- [ ] **Step 7: Run the test again and see the ladder pass**

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts
```

Expected: `Tests: 28 passed, 28 total`, with lines such as `✓ caps=4 platform=android socket=true ble=true -> ble` and `✓ caps=5 platform=ios socket=false ble=true -> ble` in the output.

- [ ] **Step 8: Write `describeFloor.test.ts` (failing)**

`describeFloor` runs `selectTransport` first, so each test sets up `Platform.OS` and the two native switches to make the ladder land on `'qr'` for the reason under test. The two `local_*` cases model a payer whose BLE stack reports unsupported (spec §7: `denied`/`restricted` → unsupported; a powered-off adapter is likewise not a peer the ladder should choose), so `mockBleSupported = false` there.

Create `packages/expo-wallet-toolbox/__tests__/localpay/describeFloor.test.ts`:

```ts
import { Platform } from 'react-native'
import { describeFloor, type FloorReason } from '../../core/localpay/transport/select'
import { mintSession, CAP_AWDL, CAP_BLE, CAP_NEARBY, HINT_BT, HINT_WIFI, type Session } from '../../core/localpay/session'

let mockIsSupported = true
let mockBleSupported = true

jest.mock('react-native-localpay-transport', () => ({
  getLocalPayTransport: () => ({ isSupported: () => mockIsSupported }),
  getLocalPayBleTransport: () => ({
    isSupported: () => mockBleSupported,
    bluetoothState: () => 'poweredOn',
    nfcAvailable: () => false
  })
}))

const base = {
  identityKey: '02'.padEnd(66, 'd'),
  amount: 1,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  supportsAwdl: false
}

function session(caps: number, os?: 'ios' | 'android'): Session {
  return { ...mintSession(base), caps, ...(os === undefined ? {} : { os }) }
}

describe('describeFloor', () => {
  afterEach(() => {
    Platform.OS = 'ios'
    mockIsSupported = true
    mockBleSupported = true
  })

  it('returns none when a radio rung is selected', () => {
    Platform.OS = 'ios'
    const reason: FloorReason = describeFloor(session(CAP_AWDL, 'ios'), { os: 'ios', bluetooth: 'poweredOn' })
    expect(reason).toBe('none')
  })

  it('peer_no_radio when the peer advertised hints but no rung at all', () => {
    Platform.OS = 'ios'
    expect(describeFloor(session(HINT_BT | HINT_WIFI, 'android'), { os: 'ios', bluetooth: 'poweredOn' })).toBe(
      'peer_no_radio'
    )
  })

  it('local_ble_denied when the peer advertises BLE and this app is unauthorized', () => {
    Platform.OS = 'ios'
    mockBleSupported = false
    expect(describeFloor(session(CAP_BLE | HINT_BT, 'android'), { os: 'ios', bluetooth: 'unauthorized' })).toBe(
      'local_ble_denied'
    )
  })

  it('local_bt_off when the peer advertises BLE and this radio is powered off', () => {
    Platform.OS = 'android'
    mockBleSupported = false
    expect(describeFloor(session(CAP_BLE | HINT_BT, 'ios'), { os: 'android', bluetooth: 'poweredOff' })).toBe(
      'local_bt_off'
    )
  })

  it('cross_os_no_ble when the peer is on the other OS with Bluetooth on but could not advertise BLE', () => {
    Platform.OS = 'ios'
    expect(describeFloor(session(CAP_NEARBY | HINT_BT, 'android'), { os: 'ios', bluetooth: 'poweredOn' })).toBe(
      'cross_os_no_ble'
    )
  })

  it('peer_bt_off when the peer has no BLE rung and its Bluetooth hint is clear', () => {
    Platform.OS = 'ios'
    expect(describeFloor(session(CAP_NEARBY, 'android'), { os: 'ios', bluetooth: 'poweredOn' })).toBe('peer_bt_off')
  })

  it('none when the peer has Bluetooth on, no BLE rung, and the OS is unknown or the same', () => {
    Platform.OS = 'ios'
    // OS unknown: cannot claim cross-OS
    expect(describeFloor(session(CAP_NEARBY | HINT_BT), { os: 'ios', bluetooth: 'poweredOn' })).toBe('none')
    // same OS, AWDL advertised but unusable locally: nothing on the table matches
    mockIsSupported = false
    expect(describeFloor(session(CAP_AWDL | HINT_BT, 'ios'), { os: 'ios', bluetooth: 'poweredOn' })).toBe('none')
  })
})
```

- [ ] **Step 9: Run it and watch every case fail on the missing export**

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay/describeFloor.test.ts
```

Expected: `Tests: 7 failed, 7 total`, each with

```
TypeError: (0 , _select.describeFloor) is not a function
```

- [ ] **Step 10: Implement `FloorReason` and `describeFloor` in `select.ts`**

Open `packages/expo-wallet-toolbox/core/localpay/transport/select.ts` (as written in Step 6). Make two edits.

First, replace the two import lines at the top:

```ts
import { CAP_AWDL, CAP_BLE, CAP_NEARBY, type Session } from '../session'
```

with

```ts
import { CAP_AWDL, CAP_BLE, CAP_NEARBY, HINT_BT, RUNG_MASK, type Session } from '../session'
import type { BluetoothState } from '../deviceCaps'
```

Second, append this after the closing `}` of `selectTransport` at the end of the file:

```ts

/**
 * Why a payer is on the QR fountain. 'none' when a radio was selected, or
 * when nothing in the table applies.
 */
export type FloorReason =
  | 'none'
  /** The peer is not listening on any radio rung at all. */
  | 'peer_no_radio'
  /** The peer has no BLE rung and its Bluetooth is off (or unknown). */
  | 'peer_bt_off'
  /** The peer advertises BLE but this app's Bluetooth permission is denied. */
  | 'local_ble_denied'
  /** The peer advertises BLE but this device's Bluetooth radio is off. */
  | 'local_bt_off'
  /** Other OS, peer Bluetooth on, but the peer's app could not advertise BLE. */
  | 'cross_os_no_ble'

/**
 * The one line of copy the payer's confirm screen shows when the pair is on
 * the fountain floor (spec §5). Pure: reads the caps the peer minted into the
 * QR (rung bits + hint bits) and what the caller already knows about this
 * device. Evaluated only when selectTransport() returned 'qr'; every other
 * outcome is 'none' so the copy never contradicts a live radio.
 *
 * Order matters: the local_* rows fire before the peer rows because a peer
 * that advertised BLE has done its part — the fix is on this side. session.os
 * is read here (it is copy, exactly what Session.os is for) but never for
 * dispatch.
 */
export function describeFloor(
  session: Session,
  local: { os: 'ios' | 'android'; bluetooth: BluetoothState }
): FloorReason {
  if (selectTransport(session) !== 'qr') return 'none'
  const caps = session.caps
  if ((caps & RUNG_MASK) === 0) return 'peer_no_radio'
  const peerBle = (caps & CAP_BLE) !== 0
  const peerBtOn = (caps & HINT_BT) !== 0
  if (peerBle && local.bluetooth === 'unauthorized') return 'local_ble_denied'
  if (peerBle && local.bluetooth === 'poweredOff') return 'local_bt_off'
  if (!peerBle && session.os !== undefined && session.os !== local.os && peerBtOn) return 'cross_os_no_ble'
  if (!peerBle && !peerBtOn) return 'peer_bt_off'
  return 'none'
}
```

Rationale for the `session.os !== undefined` guard (spec §5 `cross_os_no_ble`, "peer OS hint differs from local"): `o` is advisory and may be absent from older or foreign minters; an absent hint must not be read as "differs".

- [ ] **Step 11: Run both new suites plus the neighbours that touch `select.ts`**

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay/describeFloor.test.ts packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts
```

Expected: `Test Suites: 2 passed, 2 total` and `Tests: 35 passed, 35 total`.

Then the rest of the localpay suite and the rail identity test (it asserts `nearby.selectTransport === selectTransport` and imports the real, unmocked `react-native-localpay-transport`, so this proves `getLocalPayBleTransport` being `null` under jest floors safely):

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay packages/expo-wallet-toolbox/__tests__/pay/nearbyRail.test.ts
```

Expected: every suite listed passes (`Test Suites: 13 passed, 13 total` — the 10 pre-existing localpay suites, Task 1's `bleAccessor.test.ts`, `describeFloor.test.ts`, and `nearbyRail.test.ts`), `Tests: ... passed`, 0 failed.

- [ ] **Step 12: Typecheck against the Step 1 baseline**

```bash
npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep -o '^packages/[^(]*' | sort | uniq -c
```

Expected: the same file list you recorded in Step 1 (at `1568bb9`: only `core/pay/rails/handle.ts` and `ui/components/pay/HandleReceive.tsx`). None of `core/localpay/transport/select.ts`, `core/localpay/deviceCaps.ts`, `core/localpay/types.ts`, `core/localpay/pending.ts` may appear. If `select.ts` reports `TS2305: Module 'react-native-localpay-transport' has no exported member 'getLocalPayBleTransport'` or `TS2305 ... '../session' has no exported member 'HINT_BT'`, go back to Step 1 — the earlier task is missing.

- [ ] **Step 13: Commit**

```bash
git add packages/expo-wallet-toolbox/core/localpay/deviceCaps.ts \
        packages/expo-wallet-toolbox/core/localpay/types.ts \
        packages/expo-wallet-toolbox/core/localpay/pending.ts \
        packages/expo-wallet-toolbox/core/localpay/transport/select.ts \
        packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts \
        packages/expo-wallet-toolbox/__tests__/localpay/describeFloor.test.ts
git commit -m "$(cat <<'EOF'
feat(localpay): BLE rung in the transport ladder and describeFloor

selectTransport now climbs AWDL -> Nearby -> BLE -> QR: same-OS pairs keep
the radio they have today, cross-OS pairs land on BLE instead of the
one-way QR fountain. localSupportsBle() is prompt-free and has no
Platform.OS gate. describeFloor() is the pure table from the design's
section 5 that tells the payer why a pair is on QR; BluetoothState lives
in the new deviceCaps.ts that Task 6 fills in. LocalPaymentTransport.kind
and the receivedVia comment gain 'ble'.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

Expected: `git status --short` afterwards shows none of the six paths as modified; `git log -1 --format=%s` prints `feat(localpay): BLE rung in the transport ladder and describeFloor`.


---

### Task 5: Socket wrapper takes its native accessor; bleTransport

The JS wrapper in `socket.ts` today hard-wires `getLocalPayTransport()` and derives the connect budget from `kind` with a ternary. This task makes both injectable (spec §1, "The four transport methods have signatures identical to the AWDL spec so that JS treats both objects through one structural type"), pins the existing 4 s / 10 s budgets behind named constants, adds the third rung `bleTransport` over `getLocalPayBleTransport` with a 6 s connect budget. The two barrels are extended in Task 7, once `deviceCaps.ts` (Task 6) and `blePermissions.ts` (Task 7) exist to be re-exported — the draft of this task re-exported names that did not exist yet. No native code is touched; everything here is jest-verifiable.

**Depends on (already merged by earlier tasks in this plan — verified in Step 0):** `getLocalPayBleTransport()` + `type LocalPayBleTransport` exported from `RNLT/src/index.ts`; `kind: 'awdl' | 'nearby' | 'ble' | 'qr'` in `L/types.ts`; `supportsBle` on `mintSession` and `CAP_BLE` in `L/session.ts`; `localSupportsBle`, `describeFloor`, `type FloorReason` in `L/transport/select.ts`.

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/localpay/transport/socket.ts` (whole file, lines 1-221 — rewritten with the accessor and `connectTimeoutMs` parameters; every money-safety comment kept verbatim)
- Modify: `packages/expo-wallet-toolbox/core/localpay/transport/awdl.ts` (whole file, lines 1-3)
- Modify: `packages/expo-wallet-toolbox/core/localpay/transport/nearby.ts` (whole file, lines 1-3)
- Create: `packages/expo-wallet-toolbox/core/localpay/transport/ble.ts`
- Test (modify): `packages/expo-wallet-toolbox/__tests__/localpay/transportAwdl.test.ts` (insert one test after line 100)
- Test (create): `packages/expo-wallet-toolbox/__tests__/localpay/transportBle.test.ts`

**Interfaces:**
- Consumes:
  - `getLocalPayTransport(): LocalPayTransport | null` and `getLocalPayBleTransport(): LocalPayBleTransport | null`, `type LocalPayTransport`, `type LocalPayBleTransport` — from `react-native-localpay-transport` (`packages/react-native-localpay-transport/src/index.ts`)
  - `sealFrame`, `unsealFrame`, `type PaymentFrame` from `L/codec.ts`; `instanceName`, `type Session` from `L/session.ts`; `AckError`, `type Ack`, `type ConfirmDelivery`, `type DeclineReason`, `type LocalPaymentTransport`, `type ReceivedFrame` from `L/types.ts`
- Produces:
  - `L/transport/socket.ts`: `export type LocalPayNative = Pick<LocalPayTransport, 'startListening' | 'stopListening' | 'confirmFrame' | 'sendFrame'>`; `export function makeSocketTransport(kind: 'awdl' | 'nearby' | 'ble', native: () => LocalPayNative | null, connectTimeoutMs: number): LocalPaymentTransport`. `SEND_TIMEOUT_MS` stays a module-private `20_000`.
  - `L/transport/awdl.ts`: `export const AWDL_CONNECT_TIMEOUT_MS = 4_000`; `export const awdlTransport: LocalPaymentTransport`
  - `L/transport/nearby.ts`: `export const NEARBY_CONNECT_TIMEOUT_MS = 10_000`; `export const nearbyTransport: LocalPaymentTransport`
  - `L/transport/ble.ts`: `export const BLE_CONNECT_TIMEOUT_MS = 6_000`; `export const bleTransport: LocalPaymentTransport`

---

- [ ] **Step 0: Preflight — confirm the upstream deliverables this task builds on are in the tree**

Run from the repo root:

```bash
grep -n "export function getLocalPayBleTransport\|LocalPayBleTransport }" packages/react-native-localpay-transport/src/index.ts
grep -n "readonly kind" packages/expo-wallet-toolbox/core/localpay/types.ts
grep -n "supportsBle\|export const CAP_BLE" packages/expo-wallet-toolbox/core/localpay/session.ts
grep -n "export function localSupportsBle\|export function describeFloor\|export type FloorReason" packages/expo-wallet-toolbox/core/localpay/transport/select.ts
```

Expected: every grep prints at least one line, and the `types.ts` line reads `readonly kind: 'awdl' | 'nearby' | 'ble' | 'qr'`. If any command prints nothing (or `No such file or directory`), stop: the task that produces that deliverable has not been executed yet — run it first, then return here. Also confirm the baseline is green before touching anything:

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay/transportAwdl.test.ts packages/expo-wallet-toolbox/__tests__/pay/nearbyRail.test.ts
```

Expected tail:

```
PASS packages/expo-wallet-toolbox/__tests__/localpay/transportAwdl.test.ts
PASS packages/expo-wallet-toolbox/__tests__/pay/nearbyRail.test.ts

Test Suites: 2 passed, 2 total
Tests:       19 passed, 19 total
```

- [ ] **Step 1: Pin the AWDL connect budget in the existing AWDL test (passes before and after the refactor — it exists to catch a regression in Step 4)**

Open `packages/expo-wallet-toolbox/__tests__/localpay/transportAwdl.test.ts`. Line 100 is the end of the test `'seals outgoing frames: sendFrame carries ciphertext the session PSK opens'` and line 101 is the `})` that closes `describe('awdlTransport.send', ...)`. Insert the following between them (after line 100, before the `})`):

```ts

  // Pins the connect budget through the makeSocketTransport(kind, native,
  // connectTimeoutMs) refactor: AWDL's Bonjour discovery over an existing
  // Wi-Fi link resolves inside ~4s, and the whole-send budget stays 20s.
  it('passes the 4 s AWDL connect budget and the 20 s send budget to sendFrame', async () => {
    const native = fakeNative({ sendFrame: jest.fn().mockResolvedValue(toAckBase64({ ok: true })) })
    getLocalPayTransport.mockReturnValue(native)

    await awdlTransport.send(session, frame, new AbortController().signal)
    const call = (native.sendFrame as jest.Mock).mock.calls[0]
    expect(call[3]).toBe(20_000)
    expect(call[4]).toBe(4_000)
  })
```

Run:

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay/transportAwdl.test.ts
```

Expected: `Tests: 19 passed, 19 total` (18 existing + this pin). This test is green already because `socket.ts:108` currently resolves `4_000` for `'awdl'`; it is here so Step 4 cannot silently change it.

- [ ] **Step 2: Write the failing BLE transport test**

Create `packages/expo-wallet-toolbox/__tests__/localpay/transportBle.test.ts` with exactly this content. It mirrors `transportAwdl.test.ts` (same fixtures, same money-safety assertions) but mocks `getLocalPayBleTransport`, and adds the BLE-specific cases the spec lists under Testing ("connect-timeout rejection string, oversize rejection propagates as a radio failure", plus the two budget/timeout tests named in the task brief).

```ts
import { BLE_CONNECT_TIMEOUT_MS, bleTransport } from '../../core/localpay/transport/ble'
import { AckError } from '../../core/localpay/types'
import { mintSession, instanceName } from '../../core/localpay/session'
import { CodecError, FRAME_VERSION, SEAL_VERSION, encodeFrame, sealFrame, unsealFrame, type PaymentFrame } from '../../core/localpay/codec'
import type { LocalPayBleTransport } from 'react-native-localpay-transport'

jest.mock('react-native-localpay-transport', () => ({
  getLocalPayBleTransport: jest.fn(),
}))

const { getLocalPayBleTransport } = jest.requireMock('react-native-localpay-transport') as {
  getLocalPayBleTransport: jest.Mock
}

function fakeNative(overrides: Partial<LocalPayBleTransport> = {}) {
  return {
    isSupported: () => true,
    bluetoothState: () => 'poweredOn',
    nfcAvailable: () => false,
    prepare: jest.fn().mockResolvedValue('poweredOn'),
    startListening: jest.fn(),
    stopListening: jest.fn().mockResolvedValue(undefined),
    confirmFrame: jest.fn().mockResolvedValue(undefined),
    sendFrame: jest.fn(),
    ...overrides,
  }
}

const session = mintSession({
  identityKey: '02'.padEnd(66, 'd'),
  amount: 1,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  supportsAwdl: false,
  supportsBle: true,
})

const frame: PaymentFrame = {
  version: FRAME_VERSION,
  kind: 'bsv' as const,
  senderIdentityKey: '02'.padEnd(66, 'e'),
  outputIndex: 0,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  transaction: new Uint8Array([1, 2, 3]),
}

function toAckBase64(payload: unknown): string {
  return globalThis.btoa(JSON.stringify(payload))
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return globalThis.btoa(s)
}

describe('bleTransport', () => {
  it('is attributed as the ble rung', () => {
    expect(bleTransport.kind).toBe('ble')
  })

  it('exposes the 6 s connect budget as a named constant', () => {
    expect(BLE_CONNECT_TIMEOUT_MS).toBe(6_000)
  })
})

describe('bleTransport.send', () => {
  afterEach(() => jest.clearAllMocks())

  // A null accessor is how a missing native lib floors to QR; it must be a
  // rejection the flow can attribute, never a throw out of send().
  it('rejects when the BLE HybridObject is unavailable', async () => {
    getLocalPayBleTransport.mockReturnValue(null)

    await expect(bleTransport.send(session, frame, new AbortController().signal)).rejects.toThrow(
      'ble transport unavailable'
    )
  })

  it('rejects immediately on an already-aborted signal without calling sendFrame', async () => {
    const native = fakeNative()
    getLocalPayBleTransport.mockReturnValue(native)
    const controller = new AbortController()
    controller.abort()

    await expect(bleTransport.send(session, frame, controller.signal)).rejects.toThrow('cancelled')
    expect(native.sendFrame).not.toHaveBeenCalled()
  })

  it('passes the 6 s connect budget and 20 s send budget to sendFrame', async () => {
    const native = fakeNative({ sendFrame: jest.fn().mockResolvedValue(toAckBase64({ ok: true })) })
    getLocalPayBleTransport.mockReturnValue(native)

    await bleTransport.send(session, frame, new AbortController().signal)
    const call = (native.sendFrame as jest.Mock).mock.calls[0]
    expect(call[0]).toBe(instanceName(session.sessionId))
    expect(call[1]).toBe(toBase64(session.psk))
    expect(call[3]).toBe(20000)
    expect(call[4]).toBe(6000)
  })

  // Spec §3 step 8: the native central rejects with this exact string when
  // scan + connect + discovery do not finish inside connectTimeoutMs. It is
  // the string NearbyFlow's executeSend already treats as radios-off /
  // peer-gone, so the payer drops to the fountain without aborting the built
  // action. The wrapper must forward it untouched.
  it('rejects with the native connect-timeout message so NearbyFlow falls back to the QR', async () => {
    const native = fakeNative({
      sendFrame: jest.fn().mockRejectedValue(new Error('connect timeout: no route to peer')),
    })
    getLocalPayBleTransport.mockReturnValue(native)

    await expect(bleTransport.send(session, frame, new AbortController().signal)).rejects.toThrow(
      'connect timeout: no route to peer'
    )
  })

  // Spec §3 (framing): the payer's native side refuses a sealed frame over
  // MAX_BLE_FRAME_BYTES. That is a radio failure (fountain next), not an
  // AckError — an AckError would suggest the payee answered.
  it('propagates the oversize rejection as a plain radio failure, not an AckError', async () => {
    const native = fakeNative({
      sendFrame: jest.fn().mockRejectedValue(new Error('frame too large for a BLE payload')),
    })
    getLocalPayBleTransport.mockReturnValue(native)

    const outcome = bleTransport.send(session, frame, new AbortController().signal)
    await expect(outcome).rejects.toThrow('frame too large for a BLE payload')
    await expect(outcome).rejects.not.toBeInstanceOf(AckError)
  })

  it.each([null, 42, [], {}])('throws AckError for a malformed ack payload %p', async bad => {
    const native = fakeNative({ sendFrame: jest.fn().mockResolvedValue(toAckBase64(bad)) })
    getLocalPayBleTransport.mockReturnValue(native)

    await expect(bleTransport.send(session, frame, new AbortController().signal)).rejects.toThrow(AckError)
  })

  it('resolves a well-formed success ack', async () => {
    const native = fakeNative({ sendFrame: jest.fn().mockResolvedValue(toAckBase64({ ok: true })) })
    getLocalPayBleTransport.mockReturnValue(native)

    await expect(bleTransport.send(session, frame, new AbortController().signal)).resolves.toEqual({ ok: true })
  })

  it('resolves a genuine peer decline rather than throwing', async () => {
    const native = fakeNative({
      sendFrame: jest.fn().mockResolvedValue(toAckBase64({ ok: false, error: 'declined' })),
    })
    getLocalPayBleTransport.mockReturnValue(native)

    await expect(bleTransport.send(session, frame, new AbortController().signal))
      .resolves.toEqual({ ok: false, error: 'declined' })
  })

  it('seals outgoing frames: sendFrame carries ciphertext the session PSK opens', async () => {
    const native = fakeNative({ sendFrame: jest.fn().mockResolvedValue(toAckBase64({ ok: true })) })
    getLocalPayBleTransport.mockReturnValue(native)

    await bleTransport.send(session, frame, new AbortController().signal)
    const sentBase64 = (native.sendFrame as jest.Mock).mock.calls[0][2] as string
    const sentBytes = Uint8Array.from(globalThis.atob(sentBase64), c => c.charCodeAt(0))
    expect(sentBytes[0]).toBe(SEAL_VERSION)
    expect(unsealFrame(sentBytes, session.psk)).toEqual(frame)
  })
})

describe('bleTransport.receive', () => {
  afterEach(() => jest.clearAllMocks())

  it('rejects when the BLE HybridObject is unavailable', async () => {
    getLocalPayBleTransport.mockReturnValue(null)

    await expect(bleTransport.receive(session, new AbortController().signal)).rejects.toThrow(
      'ble transport unavailable'
    )
  })

  it('rejects immediately on an already-aborted signal without calling startListening', async () => {
    const native = fakeNative()
    getLocalPayBleTransport.mockReturnValue(native)
    const controller = new AbortController()
    controller.abort()

    await expect(bleTransport.receive(session, controller.signal)).rejects.toThrow('cancelled')
    expect(native.startListening).not.toHaveBeenCalled()
  })

  // Spec §6: the payee runs this listener alongside the platform radio and
  // aborts the loser. Aborting BEFORE any frame arrived must tear the BLE
  // advertiser down (native stopListening) — the loser holds no ack connection.
  it('stops the listener when aborted while still waiting for a frame', async () => {
    const startListening = jest.fn(() => Promise.resolve())
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)
    const controller = new AbortController()

    const pending = bleTransport.receive(session, controller.signal)
    expect(startListening).toHaveBeenCalledTimes(1)
    controller.abort()

    await expect(pending).rejects.toThrow('cancelled')
    expect(native.stopListening).toHaveBeenCalledTimes(1)
  })

  it('resolves the decoded frame with a confirm handle', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(sealFrame(frame, session.psk)))
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    const received = await bleTransport.receive(session, new AbortController().signal)
    expect(received.frame).toEqual(frame)
    expect(typeof received.confirm).toBe('function')
    expect(startListening).toHaveBeenCalledTimes(1)
    expect(startListening.mock.calls[0][0]).toBe(instanceName(session.sessionId))
    expect(startListening.mock.calls[0][1]).toBe(toBase64(session.psk))
  })

  // Money-safety: the native side is HOLDING the payer's connection open for
  // the ack when onFrame fires, and stopListening() cancels held connections.
  // Tearing down on the success path would destroy the socket the ack has to
  // travel back over — the payer would time out on a payment the payee saved.
  it('does NOT stop the listener on the success path', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(sealFrame(frame, session.psk)))
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    await bleTransport.receive(session, new AbortController().signal)
    expect(native.stopListening).not.toHaveBeenCalled()
  })

  it('acks positively through the native confirmFrame, exactly once', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(sealFrame(frame, session.psk)))
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    const { confirm } = await bleTransport.receive(session, new AbortController().signal)
    await confirm(true)
    await confirm(true)
    expect(native.confirmFrame).toHaveBeenCalledTimes(1)
    expect(native.confirmFrame).toHaveBeenCalledWith(true, '')
  })

  it('forwards a decline reason verbatim so the payer can localize it', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(sealFrame(frame, session.psk)))
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    const { confirm } = await bleTransport.receive(session, new AbortController().signal)
    await confirm(false, 'already_paid')
    expect(native.confirmFrame).toHaveBeenCalledWith(false, 'already_paid')
  })

  // A failed ack is not a failed payment on the payee's side: the frame is
  // already durable by then, so this must never surface as a rejection that
  // could flip a settled screen.
  it('never rejects when the native ack fails', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(sealFrame(frame, session.psk)))
      return Promise.resolve()
    })
    const native = fakeNative({
      startListening: startListening as never,
      confirmFrame: jest.fn().mockRejectedValue(new Error('peer disconnected before acking')) as never,
    })
    getLocalPayBleTransport.mockReturnValue(native)

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { confirm } = await bleTransport.receive(session, new AbortController().signal)
    await expect(confirm(true)).resolves.toBeUndefined()
    warn.mockRestore()
  })

  it('rejects rather than hanging when the delivered frame cannot be decoded', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(new Uint8Array([0xff, 0xff, 0xff])))
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      bleTransport
        .receive(session, new AbortController().signal)
        .then(() => 'resolved' as const, () => 'rejected' as const),
      new Promise<'hung'>(resolve => {
        timer = setTimeout(() => resolve('hung'), 500)
      })
    ])
    clearTimeout(timer)

    expect(outcome).toBe('rejected')
  })

  it('rejects with the CodecError raised by the decoder', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(new Uint8Array([0xff, 0xff, 0xff])))
      return Promise.resolve()
    })
    getLocalPayBleTransport.mockReturnValue(fakeNative({ startListening: startListening as never }))

    await expect(bleTransport.receive(session, new AbortController().signal)).rejects.toThrow(CodecError)
  })

  // receive() rejects on a decode failure, so no confirm handle ever reaches
  // the screen. Without the transport declining here the payer would sit on a
  // green "Sent" until its own timeout, having queued nothing at the payee.
  it('declines to the payer when the delivered frame cannot be decoded', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(new Uint8Array([0xff, 0xff, 0xff])))
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    await expect(bleTransport.receive(session, new AbortController().signal)).rejects.toThrow(CodecError)
    expect(native.confirmFrame).toHaveBeenCalledWith(false, 'decode_failed')
    // Same reason as the success path: stopListening would cancel the very
    // connection the decline has to go out on.
    expect(native.stopListening).not.toHaveBeenCalled()
  })

  it('declines decode_failed on an UNSEALED frame: raw v3 bytes are not accepted on the wire', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(encodeFrame(frame))) // raw, not sealed
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    await expect(bleTransport.receive(session, new AbortController().signal)).rejects.toThrow(CodecError)
    expect(native.confirmFrame).toHaveBeenCalledWith(false, 'decode_failed')
  })

  // The native listener's onError path (e.g. the 60 s ack reaper expiring
  // with "payee never confirmed the payment; connection released") is a
  // terminal failure for THIS receive(): reject with the message and tear
  // down, so the flow can restart the listener under a fresh epoch.
  it('rejects with the native onError message and tears the listener down', async () => {
    const startListening = jest.fn(
      (_name: string, _psk: string, _onFrame: (f: string) => void, onError: (m: string) => void) => {
        onError('bluetooth unavailable')
        return Promise.resolve()
      }
    )
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    await expect(bleTransport.receive(session, new AbortController().signal)).rejects.toThrow('bluetooth unavailable')
    expect(native.stopListening).toHaveBeenCalledTimes(1)
  })
})
```

Run:

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay/transportBle.test.ts
```

Expected failure (the module does not exist yet):

```
FAIL packages/expo-wallet-toolbox/__tests__/localpay/transportBle.test.ts
  ● Test suite failed to run

    Cannot find module '../../core/localpay/transport/ble' from 'packages/expo-wallet-toolbox/__tests__/localpay/transportBle.test.ts'
```

- [ ] **Step 3: Rewrite `socket.ts` so the wrapper takes its native accessor and connect budget**

Replace the whole of `packages/expo-wallet-toolbox/core/localpay/transport/socket.ts` (221 lines) with the following. Changes relative to the current file: the import of `getLocalPayTransport` becomes type-only (`import type { LocalPayTransport }`), the new exported `LocalPayNative` type, `makeConfirm`/`declineQuietly` take `LocalPayNative`, `makeSocketTransport` gains the `native` and `connectTimeoutMs` parameters (the `kind === 'awdl' ? 4_000 : 10_000` ternary at old line 108 is gone), and the local HybridObject variable inside `receive`/`send` is called `backend` because the accessor parameter now owns the name `native`. Every money-safety comment is byte-for-byte the current text.

```ts
import type { LocalPayTransport } from 'react-native-localpay-transport'
import { sealFrame, unsealFrame, type PaymentFrame } from '../codec'
import { instanceName, type Session } from '../session'
import {
  AckError,
  type Ack,
  type ConfirmDelivery,
  type DeclineReason,
  type LocalPaymentTransport,
  type ReceivedFrame
} from '../types'

/**
 * Whole-exchange budget: connect + transfer + the payee's save + ack. Shared
 * by every socketed rung — only the connect-phase budget is radio-specific,
 * and that one is the caller's `connectTimeoutMs`.
 */
const SEND_TIMEOUT_MS = 20_000

/**
 * The four methods this wrapper drives. `LocalPayTransport` (AWDL on iOS,
 * Nearby Connections on Android) and `LocalPayBleTransport` (GATT on both)
 * are separate Nitro HybridObjects with no common base in the specs; they
 * share these four signatures exactly, and that structural overlap is what
 * lets one wrapper serve both. A Pick, so the BLE object's extra prompt-free
 * probes (bluetoothState, nfcAvailable, prepare) never leak into the wrapper.
 */
export type LocalPayNative = Pick<LocalPayTransport, 'startListening' | 'stopListening' | 'confirmFrame' | 'sendFrame'>

function toBase64(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += String.fromCharCode(byte)
  return globalThis.btoa(s)
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(globalThis.atob(s), c => c.charCodeAt(0))
}

/**
 * Decode and validate an ack payload. Throws AckError for anything that
 * isn't a well-formed { ok: boolean, error?: string } object — a genuine
 * peer decline (ok: false) is not an error and must be returned normally.
 */
function parseAck(ackBase64: string): Ack {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64(ackBase64)))
  } catch {
    throw new AckError('malformed ack: invalid base64 or JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AckError('malformed ack: expected an object')
  }
  const { ok, error } = parsed as Record<string, unknown>
  if (typeof ok !== 'boolean') {
    throw new AckError('malformed ack: missing boolean "ok"')
  }
  if (error !== undefined && typeof error !== 'string') {
    throw new AckError('malformed ack: "error" must be a string')
  }
  return error === undefined ? { ok } : { ok, error }
}

/**
 * Wraps the native `confirmFrame` in the contract ConfirmDelivery promises:
 * at most one ack per delivery, and never a rejection.
 *
 * The latch is defence in depth against a second ack contradicting the first:
 * `settleReceived` has many exits and each one confirms, so a missed `return`
 * would otherwise let a decline follow an acceptance for the same payment. The
 * swallow matters because the payee's copy is already durable by the time a
 * positive ack is sent — a socket error here is a payer-side retry problem,
 * not a reason to tell the payee its payment failed.
 */
function makeConfirm(native: LocalPayNative): ConfirmDelivery {
  let acked = false
  return (accepted, reason) => {
    if (acked) return Promise.resolve()
    acked = true
    try {
      return native.confirmFrame(accepted, reason ?? '').catch(warnAckFailure)
    } catch (e) {
      warnAckFailure(e)
      return Promise.resolve()
    }
  }
}

function warnAckFailure(e: unknown): void {
  console.warn('[localpay] confirmFrame failed:', e instanceof Error ? e.message : String(e))
}

/**
 * Decline without a handle, from inside a native callback. Cannot throw: a
 * throw here would unwind into Swift's `onFrame` invocation rather than into
 * any JS caller.
 */
function declineQuietly(native: LocalPayNative, reason: DeclineReason): void {
  try {
    void native.confirmFrame(false, reason).catch(warnAckFailure)
  } catch (e) {
    warnAckFailure(e)
  }
}

/**
 * The socketed transport wrapper, shared by every radio backend. The native
 * surface is identical across them (two Nitro specs, same four transport
 * methods): iOS implements LocalPayTransport over AWDL/Network.framework,
 * Android over Google Nearby Connections, and both implement
 * LocalPayBleTransport over GATT. `native` is the cached accessor for the
 * HybridObject this rung drives (getLocalPayTransport or
 * getLocalPayBleTransport); which backend it returns is decided by the
 * platform at build time, so `kind` here is attribution, not dispatch.
 *
 * `connectTimeoutMs` is the connect-phase budget before the payer gives up and
 * falls back to the QR. Radio-specific, so each rung owns its constant: AWDL's
 * Bonjour discovery over an already-established Wi-Fi link resolves (or
 * doesn't) inside ~4s, but Nearby has to do BLE discovery and then a
 * Wi-Fi/hotspot upgrade before a connection even exists — 4s there would
 * false-positive "no route to peer" on a link that just needed more time to
 * come up. BLE sits between the two: scan + connect + MTU + discovery in ~6s.
 */
export function makeSocketTransport(
  kind: 'awdl' | 'nearby' | 'ble',
  native: () => LocalPayNative | null,
  connectTimeoutMs: number
): LocalPaymentTransport {
  return {
    kind,

    receive(session: Session, signal: AbortSignal): Promise<ReceivedFrame> {
      const backend = native()
      if (!backend) return Promise.reject(new Error(`${kind} transport unavailable`))
      if (signal.aborted) return Promise.reject(new Error('cancelled'))
      const name = instanceName(session.sessionId)

      return new Promise<ReceivedFrame>((resolve, reject) => {
        let settled = false
        /**
         * `teardown` says whether settling should also tear the native listener
         * down. It must be FALSE on the success path: the native side already
         * cancelled the listener itself the instant it accepted (first-success-
         * wins), and it is now holding the payer's connection open waiting for
         * confirmFrame(). stopListening() cancels held connections, so calling
         * it here would destroy the very socket the ack has to travel back over
         * — the payer would time out on a payment the payee successfully saved.
         */
        const finish = (teardown: boolean, fn: () => void) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          if (teardown) void backend.stopListening().catch(() => {})
          fn()
        }
        const onAbort = () => finish(true, () => reject(new Error('cancelled')))
        signal.addEventListener('abort', onAbort)

        backend
          .startListening(
            name,
            toBase64(session.psk),
            frameBase64 => {
              // Decode BEFORE finish(). `finish` latches `settled` and tears the
              // listener down before it invokes its callback, so a throw from
              // inside that callback can never be recovered by a second finish() —
              // the guard returns early and the promise never settles at all,
              // leaving the payee spinning against a listener that is already gone.
              // Any version skew, truncation or trailing bytes reaches this path.
              let frame: PaymentFrame
              try {
                frame = unsealFrame(fromBase64(frameBase64), session.psk)
              } catch (e) {
                // The only decline the caller can never issue itself: receive()
                // rejects here, so no ReceivedFrame — and therefore no confirm
                // handle — ever reaches the screen. Declining from inside the
                // transport is what stops the payer sitting on a green "Sent"
                // until its own timeout. Nothing was persisted, so this is a
                // provable "queued nothing" and the payer may release its inputs.
                //
                // teardown is false here for the same reason as on success:
                // stopListening() would cancel the connection the decline has
                // to go out on. confirmFrame does the full teardown itself, and
                // the native listener was already cancelled at accept time.
                declineQuietly(backend, 'decode_failed')
                return finish(false, () => reject(e))
              }
              finish(false, () => resolve({ frame, confirm: makeConfirm(backend) }))
            },
            message => finish(true, () => reject(new Error(message)))
          )
          .catch(e => finish(true, () => reject(e)))
      })
    },

    send(session: Session, frame: PaymentFrame, signal: AbortSignal): Promise<Ack> {
      const backend = native()
      if (!backend) return Promise.reject(new Error(`${kind} transport unavailable`))
      if (signal.aborted) return Promise.reject(new Error('cancelled'))

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

        backend
          .sendFrame(
            instanceName(session.sessionId),
            toBase64(session.psk),
            toBase64(sealFrame(frame, session.psk)),
            SEND_TIMEOUT_MS,
            connectTimeoutMs
          )
          .then(
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
```

Confirm the wrapper no longer reaches for the AWDL accessor itself (this is what keeps `transportAwdl.test.ts`'s mock — which provides only `getLocalPayTransport` — and `transportBle.test.ts`'s mock — only `getLocalPayBleTransport` — both sufficient):

```bash
grep -n "getLocalPayTransport\|getLocalPayBleTransport" packages/expo-wallet-toolbox/core/localpay/transport/socket.ts
```

Expected: exactly two hits, both inside the `makeSocketTransport` doc comment (the line containing `HybridObject this rung drives (getLocalPayTransport or` and the line `getLocalPayBleTransport); which backend it returns...`). No `import { getLocalPayTransport ...` line.

- [ ] **Step 4: Update `awdl.ts` and `nearby.ts` to pass their accessor and named budget**

Replace the whole of `packages/expo-wallet-toolbox/core/localpay/transport/awdl.ts` with:

```ts
import { getLocalPayTransport } from 'react-native-localpay-transport'
import { makeSocketTransport } from './socket'

/**
 * Connect-phase budget before the payer gives up and falls back to the QR.
 * AWDL's Bonjour discovery over an already-established Wi-Fi link resolves
 * (or doesn't) inside ~4s; a longer wait only delays the fountain.
 */
export const AWDL_CONNECT_TIMEOUT_MS = 4_000

export const awdlTransport = makeSocketTransport('awdl', getLocalPayTransport, AWDL_CONNECT_TIMEOUT_MS)
```

Replace the whole of `packages/expo-wallet-toolbox/core/localpay/transport/nearby.ts` with:

```ts
import { getLocalPayTransport } from 'react-native-localpay-transport'
import { makeSocketTransport } from './socket'

/**
 * Connect-phase budget before the payer gives up and falls back to the QR.
 * Nearby has to do BLE discovery and then a Wi-Fi/hotspot upgrade before a
 * connection even exists — AWDL's 4s would false-positive "no route to peer"
 * on a link that just needed more time to come up.
 */
export const NEARBY_CONNECT_TIMEOUT_MS = 10_000

export const nearbyTransport = makeSocketTransport('nearby', getLocalPayTransport, NEARBY_CONNECT_TIMEOUT_MS)
```

Run the AWDL suite (unchanged apart from Step 1's pin) to prove the refactor is behaviour-preserving:

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay/transportAwdl.test.ts
```

Expected: `PASS ... transportAwdl.test.ts`, `Tests: 19 passed, 19 total`. If the pin from Step 1 fails with `Expected: 4000 Received: 10000` (or vice versa) the accessor/budget arguments in `awdl.ts`/`nearby.ts` are swapped.

- [ ] **Step 5: Create `ble.ts` — the third rung over the BLE HybridObject**

Create `packages/expo-wallet-toolbox/core/localpay/transport/ble.ts`:

```ts
import { getLocalPayBleTransport } from 'react-native-localpay-transport'
import { makeSocketTransport } from './socket'

/**
 * Connect-phase budget before the payer gives up and falls back to the QR:
 * scan for the session's service UUID + connect + MTU negotiation (≤ 2 s on
 * Android) + service discovery + ACK subscription. The native central rejects
 * "connect timeout: no route to peer" if that has not completed inside this
 * budget — the string NearbyFlow already treats as radios-off / peer-gone —
 * so the payer drops to the fountain instead of waiting out the 20 s
 * whole-send budget.
 */
export const BLE_CONNECT_TIMEOUT_MS = 6_000

/**
 * A separate HybridObject from the AWDL/Nearby one. That is load-bearing for
 * the payee's multi-listener: aborting this rung runs ITS native
 * stopListening(), which can never touch the other radio's held ack
 * connection.
 */
export const bleTransport = makeSocketTransport('ble', getLocalPayBleTransport, BLE_CONNECT_TIMEOUT_MS)
```

Rationale: spec §1 fixes `BLE_CONNECT_TIMEOUT_MS = 6_000` ("scan + connect + MTU + discovery"); spec §3 step 8 names the connect-timeout string; spec §6 relies on the separate HybridObject so a losing listener's teardown cannot reach the winner's ack connection.

Run both transport suites:

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay/transportBle.test.ts packages/expo-wallet-toolbox/__tests__/localpay/transportAwdl.test.ts
```

Expected:

```
PASS packages/expo-wallet-toolbox/__tests__/localpay/transportBle.test.ts
PASS packages/expo-wallet-toolbox/__tests__/localpay/transportAwdl.test.ts

Test Suites: 2 passed, 2 total
Tests:       46 passed, 46 total
```

(27 in the BLE suite: 2 + 12 send [the `it.each` counts as 4] + 13 receive; 19 in the AWDL suite.)

- [ ] **Step 6: Typecheck the toolbox package**

```bash
npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep "error TS" | grep -v "core/pay/rails/handle.ts\|ui/components/pay/HandleReceive.tsx"
```

Expected: no output. (The four pre-existing, unrelated `TS2345` errors in `core/pay/rails/handle.ts` and `ui/components/pay/HandleReceive.tsx` are filtered away; nothing this task touches may add a line.) No line may mention `core/localpay/`. If you see `TS2345 ... 'LocalPayBleTransport | null' is not assignable to ... 'LocalPayNative | null'`, the BLE Nitro spec's four transport methods have drifted from `LocalPayTransport`'s — fix the spec file to the contract signatures, not the wrapper.

- [ ] **Step 7: Commit the wrapper refactor and the BLE transport**

```bash
git add packages/expo-wallet-toolbox/core/localpay/transport/socket.ts \
        packages/expo-wallet-toolbox/core/localpay/transport/awdl.ts \
        packages/expo-wallet-toolbox/core/localpay/transport/nearby.ts \
        packages/expo-wallet-toolbox/core/localpay/transport/ble.ts \
        packages/expo-wallet-toolbox/__tests__/localpay/transportAwdl.test.ts \
        packages/expo-wallet-toolbox/__tests__/localpay/transportBle.test.ts
git commit -m "$(cat <<'EOF'
feat(transport): parameterise the socket wrapper and add the BLE transport

makeSocketTransport(kind) hard-wired getLocalPayTransport() and derived the
connect budget from kind. It now takes the HybridObject accessor and the
connect-phase budget: makeSocketTransport(kind, native, connectTimeoutMs),
with LocalPayNative = Pick<LocalPayTransport, the four transport methods>
so the AWDL/Nearby object and the new BLE object are served by one wrapper
through their shared structural shape. The 4 s / 10 s budgets become
AWDL_CONNECT_TIMEOUT_MS / NEARBY_CONNECT_TIMEOUT_MS; the whole-send 20 s is
unchanged. Every money-safety comment in socket.ts is kept verbatim.

transport/ble.ts is the third rung: makeSocketTransport('ble',
getLocalPayBleTransport, BLE_CONNECT_TIMEOUT_MS = 6_000) — scan + connect +
MTU + discovery. Its test mirrors transportAwdl.test.ts against a mocked
getLocalPayBleTransport and adds the BLE-specific cases: the budgets
reaching sendFrame, the native "connect timeout: no route to peer" string
forwarded untouched so NearbyFlow falls to the fountain, and the oversize
rejection propagating as a plain radio failure rather than an AckError.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

Expected: one commit touching six files; `git log -1 --format=%s` prints `feat(transport): parameterise the socket wrapper and add the BLE transport`.


---

### Task 6: deviceCaps: probe and capsFromProbe

Spec §4 "Probing (`core/localpay/deviceCaps.ts`)". The payee's `receive_minting` step (Task 10, NearbyFlow) will call `probeDeviceCaps()` and feed `capsFromProbe(probe)` into `mintSession({ hints })` so the session QR's `c` integer carries the device-hint bits (`HINT_ONLINE`, `HINT_ONLINE_KNOWN`, `HINT_NET`, `HINT_WIFI`, `HINT_BT`, `HINT_NFC`). This task delivers the pure hint mapper and the budgeted probe, fully unit-tested. No UI, no native code.

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/localpay/deviceCaps.ts` — entire file. Task 4 created it containing only `export type BluetoothState = 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown'`. Replace the whole file with the contents in Step 3; the `BluetoothState` type stays byte-identical because `select.ts` (`describeFloor`, Task 4) and `NearbyFlow.tsx` (Task 10) import it from here.
- Test: `packages/expo-wallet-toolbox/__tests__/localpay/deviceCaps.test.ts` (new)
- Read only (open these before writing anything):
  - `packages/expo-wallet-toolbox/core/localpay/session.ts` lines 1-20 — `HINT_ONLINE 0x0100`, `HINT_ONLINE_KNOWN 0x0200`, `HINT_NET 0x0400`, `HINT_WIFI 0x0800`, `HINT_BT 0x1000`, `HINT_NFC 0x2000`, `RUNG_MASK 0x00ff` (added by Task 3), and `mintSession`'s `hints?: number` argument.
  - `packages/expo-wallet-toolbox/core/net/online.ts` — the app-wide `getOnline()` that this file must NOT use (explanation below).
  - `packages/expo-wallet-toolbox/core/localpay/nearbyPermissions.ts` — the house style for a small `Platform`-aware helper (2-space indent, single quotes, no semicolons, `try { … } catch { return false }`).
  - `packages/expo-wallet-toolbox/__tests__/localpay/transportAwdl.test.ts` lines 1-13 — how `react-native-localpay-transport` is mocked (`jest.mock` + `jest.requireMock` cast to `{ …: jest.Mock }`).
  - `packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts` lines 22-25, 39-42 — tests set `Platform.OS = 'android'` directly and restore `'ios'` in `afterEach`.
  - `packages/react-native-localpay-transport/src/index.ts` — `getLocalPayBleTransport(): LocalPayBleTransport | null` (Task 1) and the `bluetoothState(): string` / `nfcAvailable(): boolean` methods on the spec.

**Interfaces:**
- Consumes:
  - `HINT_ONLINE, HINT_ONLINE_KNOWN, HINT_NET, HINT_WIFI, HINT_BT, HINT_NFC, RUNG_MASK: number` from `./session` (Task 3).
  - `getLocalPayBleTransport(): LocalPayBleTransport | null` from `react-native-localpay-transport` (Task 1); on it `bluetoothState(): string` and `nfcAvailable(): boolean`, both prompt-free (spec §1).
  - `NetInfo.fetch(): Promise<NetInfoState>` from `@react-native-community/netinfo` 11.5.2 (`isConnected: boolean | null`, `isInternetReachable: boolean | null`, `type: NetInfoStateType`, `isWifiEnabled?: boolean`).
  - `Platform.OS` from `react-native`, read at call time (tests mutate it).
- Produces (all exported from `packages/expo-wallet-toolbox/core/localpay/deviceCaps.ts`):
  - `export type BluetoothState = 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown'`
  - `export interface DeviceProbe { online: boolean | null; connected: boolean | null; wifi: boolean; bluetooth: BluetoothState; nfc: boolean }`
  - `export const DEFAULT_NET_BUDGET_MS = 800`
  - `export const BLE_PREPARE_TIMEOUT_MS = 1500` (consumed by Task 10's `prepareBle()` at minting, spec §4)
  - `export function readBluetoothState(): BluetoothState` — sync, prompt-free, never throws: the native `bluetoothState()` string coerced to the five known values (`'unsupported'` with no HybridObject, `'unknown'` for anything unrecognised or a throw). Task 10's `prepareBle()` reuses the same module-private `asBluetoothState` coercion.
  - `export function capsFromProbe(p: DeviceProbe): number` — hint bits only, never a `RUNG_MASK` bit
  - `export async function probeDeviceCaps(opts?: { netBudgetMs?: number }): Promise<DeviceProbe>`
  - Barrel exports (`core/pay/rails/nearby.ts`, `core/index.ts`) are wired in Task 7, not here.

**Why not `getOnline()`** (spec §4, last paragraph): `core/net/online.ts` implements `isOnlineState` as `isConnected !== false && isInternetReachable !== false`, i.e. it deliberately reads an undetermined `null` as online. That optimism is correct for the home-screen banner (a wrong "offline" hides the online rails) and wrong for a wire flag another device will act on: the QR must say "unknown" when the probe did not answer, which is exactly what the `HINT_ONLINE_KNOWN` companion bit encodes. So `probeDeviceCaps` calls `NetInfo.fetch()` itself and preserves the tri-state.

- [ ] **Step 1: Confirm the prerequisites from Tasks 1, 3 and 4 are on disk**

Run from the repo root:

```bash
grep -n "HINT_ONLINE\|HINT_ONLINE_KNOWN\|HINT_NET\|HINT_WIFI\|HINT_BT\|HINT_NFC\|RUNG_MASK\|hints?: number" packages/expo-wallet-toolbox/core/localpay/session.ts
grep -n "getLocalPayBleTransport\|bluetoothState\|nfcAvailable" packages/react-native-localpay-transport/src/index.ts packages/react-native-localpay-transport/src/specs/LocalPayBleTransport.nitro.ts
cat packages/expo-wallet-toolbox/core/localpay/deviceCaps.ts
```

Expected: the first grep prints seven `export const HINT_…`/`RUNG_MASK` lines plus the `hints?: number` line inside `mintSession`'s args; the second prints the accessor in `index.ts` and the two method signatures in the spec; the `cat` prints a file whose only export is `BluetoothState`. If any grep is empty, stop: Task 1, 3 or 4 has not landed and this task cannot compile against them.

- [ ] **Step 2: Write the failing test**

Create `packages/expo-wallet-toolbox/__tests__/localpay/deviceCaps.test.ts` with exactly this content:

```ts
import { Platform } from 'react-native'
import {
  BLE_PREPARE_TIMEOUT_MS,
  DEFAULT_NET_BUDGET_MS,
  capsFromProbe,
  probeDeviceCaps,
  readBluetoothState,
  type DeviceProbe,
} from '../../core/localpay/deviceCaps'
import {
  CAP_AWDL,
  HINT_BT,
  HINT_NET,
  HINT_NFC,
  HINT_ONLINE,
  HINT_ONLINE_KNOWN,
  HINT_WIFI,
  RUNG_MASK,
  mintSession,
} from '../../core/localpay/session'

jest.mock('react-native-localpay-transport', () => ({
  getLocalPayTransport: jest.fn(),
  getLocalPayBleTransport: jest.fn(),
}))

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { fetch: jest.fn() },
}))

const { getLocalPayBleTransport } = jest.requireMock('react-native-localpay-transport') as {
  getLocalPayBleTransport: jest.Mock
}

const netFetch = (jest.requireMock('@react-native-community/netinfo') as { default: { fetch: jest.Mock } })
  .default.fetch

/** Every field in its "false or unknown" position: the probe that must map to 0. */
const clear: DeviceProbe = {
  online: null,
  connected: null,
  wifi: false,
  bluetooth: 'unknown',
  nfc: false,
}

const allSet: DeviceProbe = {
  online: true,
  connected: true,
  wifi: true,
  bluetooth: 'poweredOn',
  nfc: true,
}

const ALL_HINTS = HINT_ONLINE | HINT_ONLINE_KNOWN | HINT_NET | HINT_WIFI | HINT_BT | HINT_NFC

const wifiState = {
  isInternetReachable: true,
  isConnected: true,
  type: 'wifi',
  isWifiEnabled: true,
}

describe('capsFromProbe', () => {
  // One field flipped away from `clear` at a time, then the two extremes.
  // A reachable internet implies the probe answered, so HINT_ONLINE never
  // appears without HINT_ONLINE_KNOWN — that pair is the "bit alone" case.
  const TABLE: [name: string, probe: DeviceProbe, expected: number][] = [
    ['online true', { ...clear, online: true }, HINT_ONLINE | HINT_ONLINE_KNOWN],
    ['online false', { ...clear, online: false }, HINT_ONLINE_KNOWN],
    ['online null', { ...clear, online: null }, 0],
    ['connected true', { ...clear, connected: true }, HINT_NET],
    ['connected false', { ...clear, connected: false }, 0],
    ['wifi', { ...clear, wifi: true }, HINT_WIFI],
    ['bluetooth poweredOn', { ...clear, bluetooth: 'poweredOn' }, HINT_BT],
    ['bluetooth poweredOff', { ...clear, bluetooth: 'poweredOff' }, 0],
    ['bluetooth unauthorized', { ...clear, bluetooth: 'unauthorized' }, 0],
    ['bluetooth unsupported', { ...clear, bluetooth: 'unsupported' }, 0],
    ['bluetooth unknown', { ...clear, bluetooth: 'unknown' }, 0],
    ['nfc', { ...clear, nfc: true }, HINT_NFC],
    ['all set', allSet, ALL_HINTS],
    ['all clear', clear, 0],
  ]

  it.each(TABLE)('%s', (_name, probe, expected) => {
    expect(capsFromProbe(probe)).toBe(expected)
  })

  it.each(TABLE)('%s never touches a rung bit', (_name, probe) => {
    expect(capsFromProbe(probe) & RUNG_MASK).toBe(0)
  })

  it('all six hints fit in the high bits the session codec reserves', () => {
    expect(ALL_HINTS).toBe(0x3f00)
    expect(ALL_HINTS & RUNG_MASK).toBe(0)
  })

  it('rides along in mintSession as hints without disturbing the rungs', () => {
    const s = mintSession({
      identityKey: '02'.padEnd(66, 'd'),
      amount: 1,
      derivationPrefix: 'cA',
      derivationSuffix: 'cw',
      supportsAwdl: true,
      hints: capsFromProbe(allSet),
    })
    expect(s.caps & RUNG_MASK).toBe(CAP_AWDL)
    expect(s.caps & ~RUNG_MASK).toBe(ALL_HINTS)
  })
})

describe('readBluetoothState', () => {
  afterEach(() => jest.clearAllMocks())

  it('returns the native state verbatim when it is one of the five known strings', () => {
    getLocalPayBleTransport.mockReturnValue({ bluetoothState: () => 'poweredOff', nfcAvailable: () => false })
    expect(readBluetoothState()).toBe('poweredOff')
  })

  it('reads a device with no BLE HybridObject as unsupported', () => {
    getLocalPayBleTransport.mockReturnValue(null)
    expect(readBluetoothState()).toBe('unsupported')
  })

  it('coerces an unrecognised native string to unknown', () => {
    getLocalPayBleTransport.mockReturnValue({ bluetoothState: () => 'resetting', nfcAvailable: () => false })
    expect(readBluetoothState()).toBe('unknown')
  })

  it('never throws: a native throw reads as unknown', () => {
    getLocalPayBleTransport.mockReturnValue({
      bluetoothState: () => {
        throw new Error('bridge gone')
      },
      nfcAvailable: () => false,
    })
    expect(readBluetoothState()).toBe('unknown')
  })
})

describe('probeDeviceCaps', () => {
  afterEach(() => {
    Platform.OS = 'ios'
    jest.clearAllMocks()
  })

  it('exposes the budgets NearbyFlow mints against', () => {
    expect(DEFAULT_NET_BUDGET_MS).toBe(800)
    expect(BLE_PREPARE_TIMEOUT_MS).toBe(1500)
  })

  it('reads wifi from the radio flag on android', async () => {
    Platform.OS = 'android'
    netFetch.mockResolvedValue(wifiState)
    getLocalPayBleTransport.mockReturnValue(null)

    await expect(probeDeviceCaps()).resolves.toEqual({
      online: true,
      connected: true,
      wifi: true,
      bluetooth: 'unsupported',
      nfc: false,
    })
  })

  it('reads wifi from the association type on ios, so cellular is not wifi', async () => {
    Platform.OS = 'ios'
    netFetch.mockResolvedValue({ ...wifiState, type: 'cellular' })
    getLocalPayBleTransport.mockReturnValue(null)

    const probe = await probeDeviceCaps()
    expect(probe.wifi).toBe(false)
    expect(probe.online).toBe(true)
    expect(probe.connected).toBe(true)
  })

  it('ignores the android radio flag on ios', async () => {
    Platform.OS = 'ios'
    netFetch.mockResolvedValue({ ...wifiState, type: 'wifi', isWifiEnabled: false })
    getLocalPayBleTransport.mockReturnValue(null)

    await expect(probeDeviceCaps()).resolves.toMatchObject({ wifi: true })
  })

  it('reports online and connected as unknown when NetInfo does not answer in budget', async () => {
    Platform.OS = 'android'
    netFetch.mockReturnValue(new Promise(() => {}))
    getLocalPayBleTransport.mockReturnValue(null)

    const probe = await probeDeviceCaps({ netBudgetMs: 20 })
    expect(probe.online).toBeNull()
    expect(probe.connected).toBeNull()
    expect(probe.wifi).toBe(false)
    // Unknown must reach the wire as "not known", never as "online".
    expect(capsFromProbe(probe) & (HINT_ONLINE | HINT_ONLINE_KNOWN)).toBe(0)
  })

  it('reports unknown, not offline, when NetInfo rejects', async () => {
    netFetch.mockRejectedValue(new Error('NetInfo native module unavailable'))
    getLocalPayBleTransport.mockReturnValue(null)

    const probe = await probeDeviceCaps()
    expect(probe.online).toBeNull()
    expect(probe.connected).toBeNull()
    expect(probe.wifi).toBe(false)
  })

  it('keeps a null isInternetReachable as unknown even though the probe answered', async () => {
    netFetch.mockResolvedValue({ ...wifiState, isInternetReachable: null })
    getLocalPayBleTransport.mockReturnValue(null)

    const probe = await probeDeviceCaps()
    expect(probe.online).toBeNull()
    expect(probe.connected).toBe(true)
  })

  it('treats a missing BLE hybrid object as unsupported with no NFC', async () => {
    netFetch.mockResolvedValue(wifiState)
    getLocalPayBleTransport.mockReturnValue(null)

    await expect(probeDeviceCaps()).resolves.toMatchObject({ bluetooth: 'unsupported', nfc: false })
  })

  it('passes a well-formed bluetoothState through and reads nfcAvailable', async () => {
    netFetch.mockResolvedValue(wifiState)
    getLocalPayBleTransport.mockReturnValue({
      bluetoothState: () => 'poweredOn',
      nfcAvailable: () => true,
    })

    await expect(probeDeviceCaps()).resolves.toMatchObject({ bluetooth: 'poweredOn', nfc: true })
  })

  it('coerces a bluetoothState string it does not recognise to unknown', async () => {
    netFetch.mockResolvedValue(wifiState)
    getLocalPayBleTransport.mockReturnValue({
      bluetoothState: () => 'resetting',
      nfcAvailable: () => false,
    })

    await expect(probeDeviceCaps()).resolves.toMatchObject({ bluetooth: 'unknown', nfc: false })
  })

  it('survives a native method that throws', async () => {
    netFetch.mockResolvedValue(wifiState)
    getLocalPayBleTransport.mockReturnValue({
      bluetoothState: () => {
        throw new Error('CBManager not ready')
      },
      nfcAvailable: () => {
        throw new Error('NFCNDEFReaderSession unavailable')
      },
    })

    await expect(probeDeviceCaps()).resolves.toMatchObject({ bluetooth: 'unknown', nfc: false })
  })
})
```

Run:

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay/deviceCaps.test.ts
```

Expected: the suite fails. Because Task 4's `deviceCaps.ts` exports only a type, every `capsFromProbe` row fails with `TypeError: (0 , _deviceCaps.capsFromProbe) is not a function`, the `readBluetoothState` cases with `TypeError: (0 , _deviceCaps.readBluetoothState) is not a function`, the `probeDeviceCaps` cases with `TypeError: (0 , _deviceCaps.probeDeviceCaps) is not a function`, and the budgets test fails with `Expected: 800 / Received: undefined`. The summary line reads `Tests: 45 failed, 45 total` (14 truth-table rows × 2 `it.each` blocks + 2 standalone capsFromProbe tests + 4 readBluetoothState tests + 11 probeDeviceCaps tests).

- [ ] **Step 3: Implement `deviceCaps.ts`**

Replace the entire contents of `packages/expo-wallet-toolbox/core/localpay/deviceCaps.ts` with:

```ts
/**
 * What THIS device can do right now, as the hint bits the payee's session QR
 * carries above the rung byte (session.ts HINT_*). The payer's ladder never
 * reads these; they drive one line of copy on the payer's confirm screen
 * (describeFloor) and are available to future rungs.
 *
 * A clear bit means "false OR unknown". Only the one asynchronous probe —
 * internet reachability — gets a companion KNOWN bit, because it is the one
 * that routinely cannot answer inside a minting budget.
 *
 * This file deliberately does NOT use getOnline() from core/net/online.ts.
 * That helper collapses a `null` (not yet probed) NetInfo answer to "online",
 * which is right for the home-screen banner — a wrong "offline" there hides
 * the online rails from someone with signal — and wrong for a flag another
 * device will act on. Here `null` must stay `null` so the QR says "unknown"
 * (HINT_ONLINE_KNOWN clear) rather than asserting a reachability nobody
 * established.
 */
import { Platform } from 'react-native'
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo'
import { getLocalPayBleTransport } from 'react-native-localpay-transport'
import {
  HINT_BT,
  HINT_NET,
  HINT_NFC,
  HINT_ONLINE,
  HINT_ONLINE_KNOWN,
  HINT_WIFI,
  RUNG_MASK,
} from './session'

/** Mirrors LocalPayBleTransport.bluetoothState(); anything else coerces to 'unknown'. */
export type BluetoothState = 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown'

export interface DeviceProbe {
  /** NetInfo isInternetReachable; null when unknown, including "did not answer in budget". */
  online: boolean | null
  /** NetInfo isConnected; null when unknown. */
  connected: boolean | null
  /**
   * Android: the Wi-Fi radio is on (isWifiEnabled). iOS has no radio-power
   * API, so this is "associated with a Wi-Fi network" (type === 'wifi').
   */
  wifi: boolean
  bluetooth: BluetoothState
  /** NFC reader hardware available. Advisory only — NFC is not a transport. */
  nfc: boolean
}

/** How long minting waits for NetInfo before writing "unknown" into the QR. */
export const DEFAULT_NET_BUDGET_MS = 800

/** How long minting waits for the BLE managers to settle (LocalPayBleTransport.prepare). */
export const BLE_PREPARE_TIMEOUT_MS = 1500

const BLUETOOTH_STATES: readonly BluetoothState[] = [
  'poweredOn',
  'poweredOff',
  'unauthorized',
  'unsupported',
  'unknown',
]

/**
 * Native reports Bluetooth as a plain string over Nitro. Anything outside the
 * five documented values — a future CoreBluetooth case, a bridge hiccup —
 * becomes 'unknown', which every caller already treats as "do not advertise".
 * Shared by readBluetoothState() below and prepareBle() (added in Task 10).
 */
function asBluetoothState(raw: unknown): BluetoothState {
  return typeof raw === 'string' && (BLUETOOTH_STATES as readonly string[]).includes(raw)
    ? (raw as BluetoothState)
    : 'unknown'
}

/**
 * Pure. Hint bits only: the rung byte belongs to mintSession, which ORs the
 * rungs it is actually listening on with `hints & ~RUNG_MASK`. Masking here
 * too keeps the invariant local, so a future hint constant that strays into
 * the low byte cannot make a payer believe a radio is listening.
 */
export function capsFromProbe(p: DeviceProbe): number {
  let caps = 0
  if (p.online === true) caps |= HINT_ONLINE
  if (p.online !== null) caps |= HINT_ONLINE_KNOWN
  if (p.connected === true) caps |= HINT_NET
  if (p.wifi) caps |= HINT_WIFI
  if (p.bluetooth === 'poweredOn') caps |= HINT_BT
  if (p.nfc) caps |= HINT_NFC
  return caps & ~RUNG_MASK
}

/**
 * Race NetInfo against the budget. A timeout or a rejection both yield null:
 * "we do not know" is the honest answer to write into the QR, and the caller
 * must not be able to tell the two apart, or it would be tempted to guess.
 * The timer is always cleared so a fast answer leaves nothing pending.
 */
async function fetchNetWithinBudget(budgetMs: number): Promise<NetInfoState | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), budgetMs)
  })
  const answer = Promise.resolve()
    .then(() => NetInfo.fetch())
    .catch(() => null)
  try {
    return await Promise.race([answer, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The prompt-free Bluetooth answer, right now. Sync, never throws. The payee's
 * probe reads it for HINT_BT; the payer reads it on scanning a session so
 * describeFloor can say "your Bluetooth is off" without ever raising the iOS
 * privacy prompt for someone who is about to pay by code anyway (spec §7).
 * 'unsupported' when there is no BLE HybridObject at all (web, jest, a build
 * without the native lib).
 */
export function readBluetoothState(): BluetoothState {
  try {
    const ble = getLocalPayBleTransport()
    return ble ? asBluetoothState(ble.bluetoothState()) : 'unsupported'
  } catch {
    return 'unknown'
  }
}

function readNfcAvailable(): boolean {
  try {
    return getLocalPayBleTransport()?.nfcAvailable() === true
  } catch {
    return false
  }
}

/**
 * Prompt-free. bluetoothState() and nfcAvailable() are sync class-property /
 * adapter reads on both platforms (spec §"Verified facts"); the one call that
 * may show the iOS Bluetooth prompt is prepare(), which NearbyFlow issues
 * separately (prepareBle, Task 10) and only when the user has asked to
 * receive a nearby payment.
 */
export async function probeDeviceCaps(opts?: { netBudgetMs?: number }): Promise<DeviceProbe> {
  const net = await fetchNetWithinBudget(opts?.netBudgetMs ?? DEFAULT_NET_BUDGET_MS)
  const wifi =
    net !== null &&
    (Platform.OS === 'android' ? net.isWifiEnabled === true : net.type === 'wifi')
  return {
    online: net === null ? null : net.isInternetReachable,
    connected: net === null ? null : net.isConnected,
    wifi,
    bluetooth: readBluetoothState(),
    nfc: readNfcAvailable(),
  }
}
```

Notes for the executor:
- `net.type === 'wifi'` compiles under `strict` against NetInfo 11.5.2's string enum `NetInfoStateType` (TS allows comparing a string enum to a matching literal; a non-member literal such as `'nonsense'` is a TS2367 error, which is the check you want).
- `net.isInternetReachable` is itself `boolean | null` in NetInfo's types, so the tri-state passes through untouched — a probe that answered but had not yet resolved reachability leaves `HINT_ONLINE_KNOWN` clear on purpose.
- `Platform.OS` is read inside the function, not at module load, so the tests' `Platform.OS = 'android'` takes effect.

Run:

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay/deviceCaps.test.ts
```

Expected: `Tests: 45 passed, 45 total`, `Test Suites: 1 passed, 1 total`. The 20 ms budget test completes in well under a second; if the suite hangs, the `finally { clearTimeout }` in `fetchNetWithinBudget` is missing.

- [ ] **Step 4: Typecheck and run the rest of the localpay suite**

```bash
npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep "error TS" | grep -v "core/pay/rails/handle.ts\|ui/components/pay/HandleReceive.tsx"
npx jest packages/expo-wallet-toolbox/__tests__/localpay
```

Expected: no output. (The four pre-existing, unrelated `TS2345` errors in `core/pay/rails/handle.ts` and `ui/components/pay/HandleReceive.tsx` are filtered away; nothing this task touches may add a line.) The toolbox tsconfig includes `core/**/*`, so `deviceCaps.ts` is checked; the test file is under `__tests__/` and is transpiled by Babel only. Jest reports every suite under `__tests__/localpay` passing, including the new one — the two `jest.mock` calls are file-local, so `transportSelect.test.ts` and `transportAwdl.test.ts` are unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/localpay/deviceCaps.ts packages/expo-wallet-toolbox/__tests__/localpay/deviceCaps.test.ts
git commit -m "$(cat <<'EOF'
feat(localpay): device capability probe for the session QR

The payee's session QR is about to carry device hints above the rung
byte — internet reachable, any connectivity, Wi-Fi, Bluetooth, NFC — so
a payer left on the fountain can be told what to ask the other person to
switch on. capsFromProbe maps a DeviceProbe to those hint bits and never
sets a rung bit; probeDeviceCaps fills the probe from NetInfo, raced
against an 800 ms budget, and from the BLE hybrid object's prompt-free
bluetoothState()/nfcAvailable(). readBluetoothState is exported on its
own for the payer's floor copy.

It does not use getOnline(): that helper reads an undetermined NetInfo
answer as online, which is right for a banner and wrong for a flag
another device acts on. Here unknown stays unknown and the QR says so
through HINT_ONLINE_KNOWN.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

Expected: one commit touching two files; `git log --oneline -1` shows `feat(localpay): device capability probe for the session QR`.


---

### Task 7: requestBlePermissions; barrels export the BLE rung and device-caps helpers

BLE-only Android runtime permission request (spec §7 "Permissions and prompts"). Mirrors `requestNearbyPermissions` exactly in shape, but asks for the three Bluetooth grants only — never `NEARBY_WIFI_DEVICES`, which is a Nearby Connections (Wi-Fi) need, not a GATT one. On API ≤ 30 the legacy location grant is what gates BLE scanning. iOS has no runtime permission API for Bluetooth (the prompt fires inside `prepare()` / `sendFrame`, spec §7 "iOS"), so the function resolves `false` there without touching `PermissionsAndroid`, exactly like the Nearby helper.

Second half: with `deviceCaps.ts` (Task 6) and this helper in place, every BLE-rung name the screen needs now exists, so the two barrels — `core/pay/rails/nearby.ts` (a pure pass-through) and the hand-written nearby block in `core/index.ts` — are extended here in one pass and pinned by identity in `nearbyRail.test.ts` (spec §1 lists the `core/index.ts` additions). Task 5 deliberately left the barrels alone because two of the names did not exist yet.

**Files:**
- Create: `packages/expo-wallet-toolbox/core/localpay/blePermissions.ts`
- Create: `packages/expo-wallet-toolbox/__tests__/localpay/blePermissions.test.ts`
- Modify: `packages/expo-wallet-toolbox/core/pay/rails/nearby.ts` (whole file, 65 lines: header comment line 2, new re-export lines after 56 and 63, `CAP_BLE` on line 65)
- Modify: `packages/expo-wallet-toolbox/core/index.ts` (line 61 `export type { Ack }`; hand-written nearby block lines 114-133)
- Test (modify): `packages/expo-wallet-toolbox/__tests__/pay/nearbyRail.test.ts` (imports lines 9-16; add two `it` blocks before the closing `})` at line 38)
- Reference (read, do not edit): `packages/expo-wallet-toolbox/core/localpay/nearbyPermissions.ts`, `packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts:67-110`

**Interfaces:**
- Consumes: `PermissionsAndroid`, `Platform` from `react-native` (`Platform.OS`, `Platform.Version`, `PermissionsAndroid.PERMISSIONS.{BLUETOOTH_SCAN,BLUETOOTH_CONNECT,BLUETOOTH_ADVERTISE,ACCESS_FINE_LOCATION}`, `PermissionsAndroid.requestMultiple`, `PermissionsAndroid.RESULTS.GRANTED`).
- Consumes (for the barrels): `bleTransport` from `L/transport/ble.ts` (Task 5); `localSupportsBle`, `describeFloor`, `type FloorReason` from `L/transport/select.ts` (Task 4); `probeDeviceCaps`, `capsFromProbe`, `readBluetoothState`, `type DeviceProbe`, `type BluetoothState` from `L/deviceCaps.ts` (Task 6); `CAP_BLE` from `L/session.ts` (Task 3); `AckError`, `QrHandoffRequired`, `type LocalPaymentTransport`, `type ReceivedFrame` from `L/types.ts`.
- Produces: `export async function requestBlePermissions(): Promise<boolean>` in `core/localpay/blePermissions.ts`. `core/pay/rails/nearby.ts` additionally re-exports `bleTransport`, `localSupportsBle`, `describeFloor`, `type FloorReason`, `requestBlePermissions`, `probeDeviceCaps`, `capsFromProbe`, `readBluetoothState`, `type DeviceProbe`, `type BluetoothState`, `CAP_BLE`. `core/index.ts` exports the same names by hand in its nearby block, plus `QrHandoffRequired`, `AckError`, `type LocalPaymentTransport`, `type ReceivedFrame` (keeping `type Ack`) from `./localpay/types`. Consumed later by `NearbyFlow.tsx` (Task 10: payee at flow entry when GMS is absent; payer lazily inside `executeSend` when `sendKind === 'ble'`), and Task 10 adds `prepareBle` / `raceReceivers` to the same two blocks.

- [ ] **Step 1: Write the failing test file**

Create `packages/expo-wallet-toolbox/__tests__/localpay/blePermissions.test.ts` with this exact content. It follows the `requestNearbyPermissions` describe block in `transportSelect.test.ts:67-110` (same `Platform.Version` getter spy, same `requestMultiple` spy, same `afterEach` reset), and additionally asserts the exact permission list passed to `requestMultiple` for each API level, since the whole point of this module is which grants it does and does not ask for.

```ts
import { PermissionsAndroid, Platform } from 'react-native'
import type { Permission, PermissionStatus } from 'react-native'
import { requestBlePermissions } from '../../core/localpay/blePermissions'

describe('requestBlePermissions', () => {
  // API >= 31: the three Bluetooth grants, in this order, and nothing else —
  // NEARBY_WIFI_DEVICES belongs to Nearby Connections, not to GATT.
  const BLE_31: Permission[] = [
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE
  ]
  // API <= 30: BLE scanning is gated by fine location.
  const BLE_30: Permission[] = [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]

  const grantedResult = (permissions: Permission[]): Partial<Record<Permission, PermissionStatus>> =>
    Object.fromEntries(permissions.map(p => [p, PermissionsAndroid.RESULTS.GRANTED]))

  afterEach(() => {
    Platform.OS = 'ios'
    jest.restoreAllMocks()
  })

  it('on API 33 requests exactly SCAN, CONNECT, ADVERTISE and resolves true when all granted', async () => {
    Platform.OS = 'android'
    jest.spyOn(Platform, 'Version', 'get').mockReturnValue(33)
    const spy = jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue(grantedResult(BLE_31) as never)

    await expect(requestBlePermissions()).resolves.toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toEqual(BLE_31)
    expect(spy.mock.calls[0][0]).not.toContain(PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES)
  })

  it('on API 31 requests the same three Bluetooth grants', async () => {
    Platform.OS = 'android'
    jest.spyOn(Platform, 'Version', 'get').mockReturnValue(31)
    const spy = jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue(grantedResult(BLE_31) as never)

    await expect(requestBlePermissions()).resolves.toBe(true)
    expect(spy.mock.calls[0][0]).toEqual(BLE_31)
  })

  it('on API 30 requests only ACCESS_FINE_LOCATION', async () => {
    Platform.OS = 'android'
    jest.spyOn(Platform, 'Version', 'get').mockReturnValue(30)
    const spy = jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue(grantedResult(BLE_30) as never)

    await expect(requestBlePermissions()).resolves.toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toEqual(BLE_30)
  })

  it('resolves false when one requested permission is denied', async () => {
    Platform.OS = 'android'
    jest.spyOn(Platform, 'Version', 'get').mockReturnValue(33)
    jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({
      ...grantedResult(BLE_31),
      [PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]: PermissionsAndroid.RESULTS.DENIED
    } as never)

    await expect(requestBlePermissions()).resolves.toBe(false)
  })

  it('resolves false when requestMultiple throws', async () => {
    Platform.OS = 'android'
    jest.spyOn(Platform, 'Version', 'get').mockReturnValue(33)
    jest.spyOn(PermissionsAndroid, 'requestMultiple').mockRejectedValue(new Error('activity gone'))

    await expect(requestBlePermissions()).resolves.toBe(false)
  })

  it('resolves false on non-android platforms without requesting anything', async () => {
    Platform.OS = 'ios'
    const spy = jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({} as never)

    await expect(requestBlePermissions()).resolves.toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test and watch it fail on the missing module**

From the repo root `/Users/personal/git/bsv-wallet`:

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay/blePermissions.test.ts
```

Expected: the suite fails to run with

```
Cannot find module '../../core/localpay/blePermissions' from 'packages/expo-wallet-toolbox/__tests__/localpay/blePermissions.test.ts'
```

and `Test Suites: 1 failed, 1 total`.

- [ ] **Step 3: Implement `blePermissions.ts`**

Create `packages/expo-wallet-toolbox/core/localpay/blePermissions.ts` with this exact content. Same `Platform.Version` coercion and same `try/catch → false` soft-degrade as `nearbyPermissions.ts:9-34`; only the permission sets differ (spec §7: "API ≥ 31 `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `BLUETOOTH_ADVERTISE`; API ≤ 30 `ACCESS_FINE_LOCATION`").

```ts
/**
 * The runtime grants the BLE rung needs, by API level. This is the Bluetooth-
 * only subset of what Nearby Connections asks for: no NEARBY_WIFI_DEVICES,
 * because bsvpay-ble/1 is plain GATT and never touches Wi-Fi. Requested
 * lazily — the payee on entering the nearby flow when Google Play services is
 * absent, the payer inside executeSend only when BLE was selected — never at
 * app start. A denial is a soft degrade to the QR fountain, not an error.
 *
 * iOS has no runtime request API for Bluetooth: the system prompt fires the
 * first time a CB*Manager is instantiated (prepare() / sendFrame), so this
 * resolves false there without asking anything, exactly like the Nearby helper.
 */
import { PermissionsAndroid, Platform } from 'react-native'

export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return false
  const api = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10)
  const wanted: string[] =
    api >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]
  try {
    const results = await PermissionsAndroid.requestMultiple(wanted as never)
    return wanted.every(p => results[p as keyof typeof results] === PermissionsAndroid.RESULTS.GRANTED)
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay/blePermissions.test.ts
```

Expected: `Tests: 6 passed, 6 total` and `Test Suites: 1 passed, 1 total`.

Also confirm the Nearby helper's own tests are untouched:

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts
```

Expected: `Test Suites: 1 passed, 1 total` (the count of tests in that file is whatever it is at this point in the plan; none should fail).

- [ ] **Step 5: Commit the permission helper**

```bash
git add packages/expo-wallet-toolbox/core/localpay/blePermissions.ts \
        packages/expo-wallet-toolbox/__tests__/localpay/blePermissions.test.ts
git commit -m "$(cat <<'EOF'
feat(localpay): BLE-only runtime permission request

requestBlePermissions() asks Android for the Bluetooth subset of what the
Nearby helper requests: BLUETOOTH_SCAN, BLUETOOTH_CONNECT and
BLUETOOTH_ADVERTISE on API 31+, ACCESS_FINE_LOCATION on API 30 and below,
and never NEARBY_WIFI_DEVICES, which is a Nearby Connections need rather
than a GATT one. Non-Android resolves false without prompting, because the
iOS Bluetooth prompt fires inside CoreBluetooth itself. A denial is a soft
degrade to the QR fountain, mirroring requestNearbyPermissions.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

Expected: one commit touching 2 new files; `git log -1 --format=%s` prints `feat(localpay): BLE-only runtime permission request`.

- [ ] **Step 6: Write the failing barrel test**

Open `packages/expo-wallet-toolbox/__tests__/pay/nearbyRail.test.ts`. Replace the import block at lines 9-16:

```ts
import * as nearby from '../../core/pay/rails/nearby'
import * as session from '../../core/localpay/session'
import * as verify from '../../core/localpay/verify'
import * as codec from '../../core/localpay/codec'
import * as pending from '../../core/localpay/pending'
import * as build from '../../core/localpay/build'
import { awdlTransport } from '../../core/localpay/transport/awdl'
import { localSupportsAwdl, selectTransport } from '../../core/localpay/transport/select'
```

with:

```ts
import * as root from '@bsv/expo-wallet-toolbox'
import * as nearby from '../../core/pay/rails/nearby'
import * as session from '../../core/localpay/session'
import * as verify from '../../core/localpay/verify'
import * as codec from '../../core/localpay/codec'
import * as pending from '../../core/localpay/pending'
import * as build from '../../core/localpay/build'
import * as types from '../../core/localpay/types'
import { awdlTransport } from '../../core/localpay/transport/awdl'
import { bleTransport } from '../../core/localpay/transport/ble'
import { describeFloor, localSupportsAwdl, localSupportsBle, selectTransport } from '../../core/localpay/transport/select'
import { requestBlePermissions } from '../../core/localpay/blePermissions'
import { capsFromProbe, probeDeviceCaps, readBluetoothState } from '../../core/localpay/deviceCaps'
```

Then insert these two tests after the closing `})` of the existing `it('re-exports the localpay functions by identity, ...')` test (currently line 37) and before the `})` that closes the `describe` (currently line 38):

```ts

  it('re-exports the BLE rung and the device-caps helpers by identity', () => {
    expect(nearby.bleTransport).toBe(bleTransport)
    expect(nearby.localSupportsBle).toBe(localSupportsBle)
    expect(nearby.describeFloor).toBe(describeFloor)
    expect(nearby.requestBlePermissions).toBe(requestBlePermissions)
    expect(nearby.probeDeviceCaps).toBe(probeDeviceCaps)
    expect(nearby.capsFromProbe).toBe(capsFromProbe)
    expect(nearby.readBluetoothState).toBe(readBluetoothState)
    expect(nearby.CAP_BLE).toBe(session.CAP_BLE)
  })

  // core/index.ts cannot `export *` from nearby.ts (TS2308 collisions), so its
  // hand-written block has to be extended by hand too — pin it.
  it('surfaces the same names, and the transport types, from the package root', () => {
    expect(root.bleTransport).toBe(bleTransport)
    expect(root.localSupportsBle).toBe(localSupportsBle)
    expect(root.describeFloor).toBe(describeFloor)
    expect(root.requestBlePermissions).toBe(requestBlePermissions)
    expect(root.probeDeviceCaps).toBe(probeDeviceCaps)
    expect(root.capsFromProbe).toBe(capsFromProbe)
    expect(root.readBluetoothState).toBe(readBluetoothState)
    expect(root.QrHandoffRequired).toBe(types.QrHandoffRequired)
    expect(root.AckError).toBe(types.AckError)
  })
```

(The file's existing `jest.mock('expo-secure-store', …)` / `jest.mock('expo-local-authentication', …)` lines at 6-7 are what make the `@bsv/expo-wallet-toolbox` root import loadable under jest, exactly as `__tests__/packageResolution.test.ts` does; `@react-native-community/netinfo`, which `deviceCaps.ts` imports, is already loaded by `core/net/online.ts` through that same root.)

Run:

```bash
npx jest packages/expo-wallet-toolbox/__tests__/pay/nearbyRail.test.ts
```

Expected failure:

```
  ● nearby rail adapter › re-exports the BLE rung and the device-caps helpers by identity

    expect(received).toBe(expected) // Object.is equality

    Expected: {"kind": "ble", "receive": [Function receive], "send": [Function send]}
    Received: undefined
```

and the same shape for `surfaces the same names, and the transport types, from the package root`. `Tests: 2 failed, 1 passed, 3 total`.

- [ ] **Step 7: Extend the nearby rail barrel**

Replace the whole of `packages/expo-wallet-toolbox/core/pay/rails/nearby.ts` (65 lines) with the following. The only changes are the header's "over AWDL or QR" → "over AWDL, Nearby, BLE or QR", the new `bleTransport` line after `nearbyTransport`, three new names in the `select` block, the two new re-export statements after `requestNearbyPermissions`, and `CAP_BLE` joining `CAP_NEARBY` on the last line. Everything else is byte-identical.

```ts
/**
 * The nearby rail — in-person, device-to-device over AWDL, Nearby, BLE or QR.
 *
 * A pass-through, on purpose. localpay/* is device-proven with 210 tests
 * behind it and its money-safety invariants were verified line by line, so this
 * rail adds NOTHING: no wrappers, no defaults, no convenience. Its only job is
 * to be the single import site for nearby, so a future change cannot quietly
 * grow a second implementation between the screen and the transport.
 *
 * If you find yourself wanting to add a function here, add it to the caller
 * instead.
 */
export { decodeSession, encodeSession, mintSession, type Session } from '../../localpay/session'
export {
  FRAME_BLOCK_BYTES,
  SEAL_VERSION,
  frameBytesFromQr,
  frameToQr,
  sealedToQr,
  sealFrame,
  unsealFrame,
  type PaymentFrame
} from '../../localpay/codec'
/**
 * The animated-QR transport is `@bsv/air-gap` (BRC-141), not app code. It was
 * grown here first and upstreamed; the published library adds what a local
 * copy could not justify carrying — a wire version byte, per-stream session
 * ids with switch hysteresis so one stray frame cannot erase a scan in
 * progress, and explicit decoder resource budgets. Display cadence stays with
 * the renderer, because the library deliberately has no opinion on it.
 */
export {
  AIR_GAP_PREFIX,
  AirGapDecoder,
  AirGapEncoder,
  MAX_MESSAGE_BYTES,
  estimatePartCharLength,
  isAirGapPart
} from '@bsv/air-gap'
export {
  isSessionSpent,
  markSessionSpent,
  processPending,
  savePending,
  type PendingPayment
} from '../../localpay/pending'
export { buildPaymentFrame, finalizeDelivery } from '../../localpay/build'
export {
  FrameVerifyError,
  verifyFramePayment,
  type DerivingWallet,
  type FrameVerifyKind
} from '../../localpay/verify'
export { holdSentPaymentOffline } from '../../offline/payerHold'
export { awdlTransport } from '../../localpay/transport/awdl'
export { nearbyTransport } from '../../localpay/transport/nearby'
export { bleTransport } from '../../localpay/transport/ble'
export {
  describeFloor,
  localSupportsAwdl,
  localSupportsBle,
  localSupportsNearby,
  selectTransport,
  type FloorReason,
  type TransportKind
} from '../../localpay/transport/select'
export { requestNearbyPermissions } from '../../localpay/nearbyPermissions'
export { requestBlePermissions } from '../../localpay/blePermissions'
export {
  capsFromProbe,
  probeDeviceCaps,
  readBluetoothState,
  type BluetoothState,
  type DeviceProbe
} from '../../localpay/deviceCaps'
export { isDeclineReason, type Ack, type ConfirmDelivery, type DeclineReason } from '../../localpay/types'
export { CAP_BLE, CAP_NEARBY } from '../../localpay/session'
```

Run:

```bash
npx jest packages/expo-wallet-toolbox/__tests__/pay/nearbyRail.test.ts
```

Expected: the first new test now passes; the root test still fails on its first line, `expect(root.bleTransport).toBe(bleTransport)` with `Received: undefined`. `Tests: 1 failed, 2 passed, 3 total`.

- [ ] **Step 8: Extend the package root barrel**

Open `packages/expo-wallet-toolbox/core/index.ts`. Two edits (Task 7 is the first task to touch this file; the "before" text below is HEAD's).

(a) Replace line 61:

```ts
export type { Ack } from './localpay/types'
```

with:

```ts
// The transport interface and its two error classes are part of the public
// surface now that the screen holds LocalPaymentTransport[] (spec §6) and
// callers need to tell an AckError (radio failure → fountain) from a decline.
export { AckError, QrHandoffRequired, type Ack, type LocalPaymentTransport, type ReceivedFrame } from './localpay/types'
```

(b) Replace the hand-written nearby block at lines 114-133:

```ts
// nearby.ts is a pure re-export barrel over localpay/* (already exported above)
// and @bsv/air-gap; only its genuinely new names are re-exported here by hand —
// a blanket `export *` would collide (TS2308) with the localpay/offline exports
// above, since most of nearby.ts's surface is itself a re-export of those.
export {
  AIR_GAP_PREFIX,
  AirGapDecoder,
  AirGapEncoder,
  MAX_MESSAGE_BYTES,
  estimatePartCharLength,
  isAirGapPart,
  awdlTransport,
  nearbyTransport,
  localSupportsAwdl,
  localSupportsNearby,
  isDeclineReason,
  type TransportKind,
  type ConfirmDelivery,
  type DeclineReason
} from './pay/rails/nearby'
```

with:

```ts
// nearby.ts is a pure re-export barrel over localpay/* (already exported above)
// and @bsv/air-gap; only its genuinely new names are re-exported here by hand —
// a blanket `export *` would collide (TS2308) with the localpay/offline exports
// above, since most of nearby.ts's surface is itself a re-export of those.
// CAP_BLE is listed although `export * from './localpay/session'` already
// carries it: an explicit re-export takes precedence over a star export, so
// this is legal, and it keeps the block a faithful mirror of nearby.ts.
export {
  AIR_GAP_PREFIX,
  AirGapDecoder,
  AirGapEncoder,
  MAX_MESSAGE_BYTES,
  estimatePartCharLength,
  isAirGapPart,
  awdlTransport,
  nearbyTransport,
  bleTransport,
  localSupportsAwdl,
  localSupportsNearby,
  localSupportsBle,
  describeFloor,
  requestBlePermissions,
  probeDeviceCaps,
  capsFromProbe,
  readBluetoothState,
  CAP_BLE,
  isDeclineReason,
  type TransportKind,
  type FloorReason,
  type DeviceProbe,
  type BluetoothState,
  type ConfirmDelivery,
  type DeclineReason
} from './pay/rails/nearby'
```

Note `requestNearbyPermissions` reaches the root today through `export * from './localpay/nearbyPermissions'` (line 60); `requestBlePermissions`, `probeDeviceCaps` and `capsFromProbe` deliberately go through the nearby block instead, so the root gains no new `export *` line whose surface could later collide. If an earlier task already placed one of these names in this block (or added an `export * from './localpay/deviceCaps'` / `'./localpay/blePermissions'` line), merge — a name listed twice in one export list is `TS2300: Duplicate identifier`, while an explicit name shadowing a star export is fine.

Identity through the root holds under jest because `node_modules/@bsv/expo-wallet-toolbox` is a symlink to `packages/expo-wallet-toolbox` and jest-resolve realpaths it (`jest-resolve/build/fileWalkers.js` `realpathSync`), so `root.bleTransport` and the relatively imported `bleTransport` are the same module instance.

Run:

```bash
npx jest packages/expo-wallet-toolbox/__tests__/pay/nearbyRail.test.ts packages/expo-wallet-toolbox/__tests__/packageResolution.test.ts
```

Expected:

```
PASS packages/expo-wallet-toolbox/__tests__/pay/nearbyRail.test.ts
PASS packages/expo-wallet-toolbox/__tests__/packageResolution.test.ts

Test Suites: 2 passed, 2 total
Tests:       5 passed, 5 total
```

- [ ] **Step 9: Typecheck and run the whole localpay + pay test set**

```bash
npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep "error TS" | grep -v "core/pay/rails/handle.ts\|ui/components/pay/HandleReceive.tsx"
```

Expected: no output. (The four pre-existing, unrelated `TS2345` errors in `core/pay/rails/handle.ts` and `ui/components/pay/HandleReceive.tsx` are filtered away; nothing this task touches may add a line.) Nothing may mention `core/index.ts`, `core/pay/rails/nearby.ts` or `core/localpay/`. A `TS2308: Module './localpay/session' has already exported a member named 'CAP_BLE'` here would mean a second `export *` (not an explicit export) is also carrying `CAP_BLE` — check that nothing other than `export * from './localpay/session'` at line 53 exports it, and that the name appears in the explicit block, which is what resolves the ambiguity.

```bash
npx jest packages/expo-wallet-toolbox/__tests__/localpay packages/expo-wallet-toolbox/__tests__/pay
```

Expected: every suite `PASS` (`__tests__/localpay` now holds 14 suites: the 10 pre-existing ones plus `bleAccessor`, `describeFloor`, `transportBle`, `deviceCaps` and `blePermissions` — 15 with this task's); in particular `transportSelect.test.ts` (whose mock of `react-native-localpay-transport` provides `getLocalPayTransport` and, since Task 4, `getLocalPayBleTransport`) is unaffected, because `select.ts` was not touched here.

- [ ] **Step 10: Commit the barrels**

```bash
git add packages/expo-wallet-toolbox/core/pay/rails/nearby.ts \
        packages/expo-wallet-toolbox/core/index.ts \
        packages/expo-wallet-toolbox/__tests__/pay/nearbyRail.test.ts
git commit -m "$(cat <<'EOF'
feat(localpay): export the BLE rung and device-caps helpers from the barrels

core/pay/rails/nearby.ts stays a pure pass-through and gains bleTransport,
localSupportsBle, describeFloor (+ FloorReason), requestBlePermissions,
probeDeviceCaps, capsFromProbe, readBluetoothState (+ DeviceProbe,
BluetoothState) and CAP_BLE.
core/index.ts mirrors them in its hand-written nearby block (a star export
would collide, TS2308) and now also exports LocalPaymentTransport,
ReceivedFrame, QrHandoffRequired and AckError from localpay/types alongside
Ack, since the screen is about to hold LocalPaymentTransport[] and must tell
an AckError from a decline. nearbyRail.test.ts pins both barrels by identity.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

Expected: one commit touching three files; `git log -1 --format=%s` prints `feat(localpay): export the BLE rung and device-caps helpers from the barrels`.


---

### Task 8: Swift BLE backend (CoreBluetooth central + peripheral)

Implements spec §2 (GATT profile `bsvpay-ble/1`), §3 (message layer, peripheral and central state machines) and §7 (iOS prompt placement) for iOS. Replaces the Task 1 stub `HybridLocalPayBleTransport.swift` (whose three probes are real and whose five transport methods reject `"bluetooth unavailable"`) with the real CoreBluetooth backend, and adds the pure profile helper `BleGattProfile.swift`. Nothing in JS changes in this task; the JS wrapper (`makeSocketTransport('ble', getLocalPayBleTransport, BLE_CONNECT_TIMEOUT_MS)`, Task 5) already talks to this object through the generated `HybridLocalPayBleTransportSpec`.

Read these before starting, in this order, so the discipline you are mirroring is fresh:
1. `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md` §2, §3, §7, §9 (the whole file is ~300 lines; read all of it).
2. `packages/react-native-localpay-transport/ios/HybridLocalPayTransport.swift` (441 lines) — the AWDL backend. Every rule below (one serial queue, `queue.sync` from bridge-thread entry points, `dispatchPrecondition` in callbacks, `hasAccepted` latch before the ack, `pendingAck` held until `confirmFrame`, silent reapers, `settle` latch in `sendFrame`) is lifted from it, and its comments explain *why*; do not paraphrase them away.
3. `packages/react-native-localpay-transport/ios/AwdlSession.swift` (72 lines) — `lengthPrefixed` / `readFrame`; the BLE framing is the same u32-BE prefix.
4. `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayTransport.kt:81-91,213-266` — the HELLO_A/HELLO_B/FRAME/ACK type-byte protocol the BLE profile extends with an ack MAC.
5. `packages/react-native-localpay-transport/nitrogen/generated/ios/swift/HybridLocalPayBleTransportSpec.swift` (generated in Task 1) — the exact Swift signatures you must implement. They are: `isSupported() throws -> Bool`, `bluetoothState() throws -> String`, `nfcAvailable() throws -> Bool`, `prepare(timeoutMs: Double) throws -> Promise<String>`, `startListening(instanceName: String, pskBase64: String, onFrame: @escaping (_ frameBase64: String) -> Void, onError: @escaping (_ message: String) -> Void) throws -> Promise<Void>`, `stopListening() throws -> Promise<Void>`, `confirmFrame(accepted: Bool, reason: String) throws -> Promise<Void>`, `sendFrame(instanceName: String, pskBase64: String, frameBase64: String, timeoutMs: Double, connectTimeoutMs: Double) throws -> Promise<String>`. If the file is missing, run `cd packages/react-native-localpay-transport && npx nitrogen` first (Task 1 Step 7: nitrogen 0.35.10 parses `--config` but reads `./nitro.json` from the cwd).

**Files:**
- Create: `packages/react-native-localpay-transport/ios/BleGattProfile.swift` (new, ~200 lines)
- Modify (replace entire contents): `packages/react-native-localpay-transport/ios/HybridLocalPayBleTransport.swift` (Task 1 stub → full backend, ~900 lines)
- Modify: `packages/react-native-localpay-transport/LocalPayTransport.podspec` lines 14-19 (the `s.source_files` / `s.frameworks` block Task 1 left, comments included)
- Modify (regenerated, committed): `ios/` (Podfile.lock and Pods manifest pick up the new source file via `npx expo prebuild --clean --platform ios`)
- Create: `docs/superpowers/2026-09-02-ble-hardware-log.md` (hardware measurements table; filled in by the hardware step)
- Test: no jest coverage is possible for CoreBluetooth; the compile gate is `xcodebuild` (Step 4) and the behavioural gate is the two-iPhone hardware checklist (Step 7). The JS-side behaviour of this object is covered by `packages/expo-wallet-toolbox/__tests__/localpay/transportBle.test.ts` (Task 5) against a mock.

**Interfaces:**
- Consumes (generated, Task 1): `HybridLocalPayBleTransportSpec` typealias (protocol `HybridLocalPayBleTransportSpec_protocol` & base class `HybridLocalPayBleTransportSpec_base`) from `nitrogen/generated/ios/swift/HybridLocalPayBleTransportSpec.swift`; `Promise<T>` from `NitroModules` with `Promise<Void>()`, `.resolve(withResult:)`, `.reject(withError:)` exactly as `HybridLocalPayTransport.swift` uses them.
- Consumes (system): `CoreBluetooth` (`CBPeripheralManager`, `CBCentralManager`, `CBPeripheral`, `CBCentral`, `CBMutableService`, `CBMutableCharacteristic`, `CBATTRequest`, `CBUUID`, `CBManager.authorization`), `CryptoKit` (`HMAC<SHA256>`, `SymmetricKey`), `CoreNFC` (`NFCNDEFReaderSession.readingAvailable`; the app already links CoreNFC and carries `NFCReaderUsageDescription` for the K1 vault — `grep -n NFCReaderUsageDescription app.json` → line 139), `os.log`.
- Produces: `final class HybridLocalPayBleTransport: HybridLocalPayBleTransportSpec` — the class name `nitro.json` autolinking instantiates (`"implementationClassName": "HybridLocalPayBleTransport"`). Behaviour contract for JS (`core/localpay/transport/socket.ts`, Task 2):
  - `isSupported()` — prompt-free; `false` only when `CBManager.authorization` is `.denied`/`.restricted`, or a manager already created in this process has reported `.unsupported` or `.poweredOff`. `notDetermined` counts as supported (spec §7). A radio that is merely off with no manager yet reads as supported (unknowable without prompting): the ladder then tries BLE, `sendFrame` fails fast with "bluetooth unavailable", the flow falls to the fountain, and the next scan in this process floors to QR with the `local_bt_off` copy.
  - `bluetoothState()` — prompt-free; one of `'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown'`.
  - `prepare(timeoutMs)` — lazily creates both managers (THE call that may show the iOS Bluetooth prompt), resolves the state string once both managers have settled or `timeoutMs` elapses. Idempotent.
  - `startListening` rejects `"bad psk or instance name"` / `"bluetooth unavailable"`; `onError` receives `"payee never confirmed the payment; connection released"` on ack-reaper expiry and `"bluetooth unavailable"` if the radio goes off mid-listen.
  - `confirmFrame` resolves after the ACK indication chunks are queued; rejects `"peer disconnected before acking"` if the bound central unsubscribed first; idempotent when nothing is pending.
  - `sendFrame` rejects `"bad psk or frame"`, `"frame too large for a BLE payload"`, `"bluetooth unavailable"`, `"connect timeout: no route to peer"`, `"timed out waiting for peer"`, `"peer failed the session proof"`, `"peer disconnected before acking"`; resolves `base64(ackJson)` with the 32-byte MAC already stripped, so `parseAck` in `socket.ts:30-48` is unchanged.
- Produces (for Task 9, Kotlin): `BleGattProfile` is the byte-exact reference for `object BleGattProfile` — same UUID derivation, same proof/MAC inputs, same framing, same constants.

- [ ] **Step 1: Write `BleGattProfile.swift` (pure helpers and constants)**

Create `packages/react-native-localpay-transport/ios/BleGattProfile.swift` with exactly this content. It has no state and touches no CoreBluetooth object, so it needs no queue confinement. Rationale for the RFC-4122 bit forcing: Android's `ScanFilter.setServiceUuid` needs an exact 128-bit match and both ends must derive the identical UUID (spec §2).

```swift
import CoreBluetooth
import CryptoKit
import Foundation

/// The `bsvpay-ble/1` GATT profile: constants, key derivation, message
/// construction and stream framing shared by the peripheral (payee) and
/// central (payer) roles in HybridLocalPayBleTransport.swift.
///
/// This file is the byte-exact reference for the Kotlin `object BleGattProfile`
/// (android/src/main/java/com/margelo/nitro/localpaytransport/BleGattProfile.kt)
/// and for any third-party build that wants to interoperate on the CAP_BLE
/// session bit. Change both platforms or neither.
///
/// Security model (design spec §3): bare GATT has no link security and
/// cross-platform bonding prompts are a UX dead end, so the link is
/// authenticated at the message layer. HELLO_A/HELLO_B prove each side holds
/// the QR's PSK before any payload moves; the FRAME body is AES-256-GCM
/// sealed by JS under the same PSK; the ACK carries an HMAC so an attacker who
/// sniffed the advertisement and re-advertised the same UUID cannot forge a
/// `{"ok":true}` to a payer whose real payee queued nothing.
enum BleGattProfile {
  // MARK: - Fixed identifiers

  /// central → peripheral. Properties: write, writeWithoutResponse.
  static let frameCharUuid = CBUUID(string: "B5A1E001-7374-4F6E-8E2D-425356504159")
  /// peripheral → central. Properties: indicate.
  static let ackCharUuid = CBUUID(string: "B5A1E002-7374-4F6E-8E2D-425356504159")
  /// Advisory only; iOS may drop it from the advertisement to fit 31 bytes.
  static let localName = "BSV Pay"
  private static let serviceUuidLabel = Data("bsvpay-ble-svc".utf8)

  // MARK: - Message types (first byte of every message)

  static let typeHelloA: UInt8 = 0x01
  static let typeHelloB: UInt8 = 0x02
  static let typeFrame: UInt8 = 0x03
  static let typeAck: UInt8 = 0x04

  // MARK: - Limits and timers (identical on Android)

  /// `type ‖ body` of one message must be <= this. Same ceiling as the Nearby
  /// backend's MAX_BYTES_PAYLOAD; the payer rejects a larger sealed frame so JS
  /// falls back to the fountain, which has no ceiling below 64 KiB.
  static let maxBleFrameBytes = 32768
  /// Hard cap on a reassembly buffer: one maximal message plus its prefix.
  static let maxReassemblyBytes = maxBleFrameBytes + 4
  static let idleConnectionTimeoutMs = 30_000
  static let pendingAckTimeoutMs = 60_000
  /// Android only (iOS negotiates MTU in the OS); kept here so the two
  /// platforms' constant tables read identically.
  static let mtuNegotiationTimeoutMs = 2_000
  static let requestedMtu = 517
  static let defaultAttMtu = 23
  static let macLength = 32

  // MARK: - Errors

  static let errorDomain = "LocalPayBleTransport"

  static func error(_ message: String, code: Int) -> NSError {
    NSError(domain: errorDomain, code: code, userInfo: [NSLocalizedDescriptionKey: message])
  }

  // MARK: - Key derivation and proofs

  private static func hmac(key: Data, message: Data) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key)))
  }

  /// Per-session service UUID: HMAC-SHA256(psk, "bsvpay-ble-svc" ‖ utf8(instanceName))[0..<16]
  /// with the RFC-4122 version nibble forced to 4 and the variant bits to 10.
  /// Only a device that read the QR (and therefore holds the PSK) can compute
  /// it, so the payer's scan filter matches exactly one advertiser and a
  /// sniffed advertisement reveals nothing about the QR.
  static func serviceUuid(psk: Data, instanceName: String) -> CBUUID {
    var message = serviceUuidLabel
    message.append(Data(instanceName.utf8))
    var bytes = [UInt8](hmac(key: psk, message: message).prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x40
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    let uuid = UUID(uuid: (
      bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
      bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    ))
    return CBUUID(nsuuid: uuid)
  }

  /// HMAC-SHA256(psk, utf8(instanceName) ‖ [type]) — the HELLO_A / HELLO_B body.
  static func proof(psk: Data, instanceName: String, type: UInt8) -> Data {
    var message = Data(instanceName.utf8)
    message.append(type)
    return hmac(key: psk, message: message)
  }

  /// HMAC-SHA256(psk, utf8(instanceName) ‖ [0x04] ‖ ackJson) — appended to the ACK.
  static func ackMac(psk: Data, instanceName: String, ackJson: Data) -> Data {
    var message = Data(instanceName.utf8)
    message.append(typeAck)
    message.append(ackJson)
    return hmac(key: psk, message: message)
  }

  /// Constant-time equality: no early exit on the first differing byte, so a
  /// remote peer cannot learn how many leading bytes of its forged proof were
  /// right from the response latency.
  static func constantTimeEquals(_ a: Data, _ b: Data) -> Bool {
    guard a.count == b.count else { return false }
    var acc: UInt8 = 0
    for (x, y) in zip(a, b) { acc |= x ^ y }
    return acc == 0
  }

  // MARK: - Messages

  static func helloA(psk: Data, instanceName: String) -> Data {
    var m = Data([typeHelloA])
    m.append(proof(psk: psk, instanceName: instanceName, type: typeHelloA))
    return m
  }

  static func helloB(psk: Data, instanceName: String) -> Data {
    var m = Data([typeHelloB])
    m.append(proof(psk: psk, instanceName: instanceName, type: typeHelloB))
    return m
  }

  static func frameMessage(sealed: Data) -> Data {
    var m = Data([typeFrame])
    m.append(sealed)
    return m
  }

  static func ackMessage(psk: Data, instanceName: String, ackJson: Data) -> Data {
    var m = Data([typeAck])
    m.append(ackJson)
    m.append(ackMac(psk: psk, instanceName: instanceName, ackJson: ackJson))
    return m
  }

  static let okJson = "{\"ok\":true}"

  /// `{"ok":false,"error":<reason>}` with `reason` correctly escaped. Same
  /// reasoning as `HybridLocalPayTransport.declineJson`: `reason` comes from JS
  /// and is serialized, never interpolated, because an unparseable ack is an
  /// AckError on the payer (inputs stay locked) rather than a clean decline.
  static func declineJson(reason: String) -> String {
    let fallback = "{\"ok\":false,\"error\":\"declined\"}"
    let text = reason.isEmpty ? "declined" : reason
    guard let data = try? JSONSerialization.data(withJSONObject: ["ok": false, "error": text]),
          let json = String(data: data, encoding: .utf8) else {
      return fallback
    }
    return json
  }

  // MARK: - Stream framing

  /// `[u32 big-endian length][message]`. Same encoding as AwdlSession.lengthPrefixed.
  static func lengthPrefixed(_ message: Data) -> Data {
    var out = Data(count: 4)
    let n = UInt32(message.count).bigEndian
    withUnsafeBytes(of: n) { out.replaceSubrange(0..<4, with: $0) }
    out.append(message)
    return out
  }

  /// Split into ATT-sized pieces. `size` is `ATT_MTU - 3`, which CoreBluetooth
  /// exposes as `CBCentral.maximumUpdateValueLength` (indications) and
  /// `CBPeripheral.maximumWriteValueLength(for: .withoutResponse)` (writes).
  static func chunks(_ data: Data, size: Int) -> [Data] {
    let n = max(1, size)
    var out: [Data] = []
    var i = 0
    while i < data.count {
      let end = min(i + n, data.count)
      out.append(data.subdata(in: i..<end))
      i = end
    }
    return out
  }

  /// Reassembles `[u32 BE length][message]` records from an ordered stream of
  /// chunks. Writes on one GATT connection and indications on one
  /// characteristic are both ordered and reliable, so no sequence numbers or
  /// checksums are needed (spec §3). Throws once the buffer or a declared
  /// length exceeds the profile ceiling; the caller drops the peer.
  struct Reassembler {
    private var buffer = Data()

    mutating func feed(_ chunk: Data) throws -> [Data] {
      buffer.append(chunk)
      guard buffer.count <= BleGattProfile.maxReassemblyBytes else {
        buffer.removeAll()
        throw BleGattProfile.error("frame too large for a BLE payload", code: 30)
      }
      var messages: [Data] = []
      while buffer.count >= 4 {
        let b = [UInt8](buffer.prefix(4))
        let length = (Int(b[0]) << 24) | (Int(b[1]) << 16) | (Int(b[2]) << 8) | Int(b[3])
        guard length >= 1 else {
          buffer.removeAll()
          throw BleGattProfile.error("bad frame length", code: 31)
        }
        guard length <= BleGattProfile.maxBleFrameBytes else {
          buffer.removeAll()
          throw BleGattProfile.error("frame too large for a BLE payload", code: 30)
        }
        guard buffer.count >= 4 + length else { break }
        messages.append(buffer.subdata(in: 4..<(4 + length)))
        // `Data(...)` re-bases the slice to startIndex 0 so the `prefix(4)` /
        // `subdata(in:)` arithmetic above stays valid on the next pass.
        buffer = Data(buffer.suffix(from: 4 + length))
      }
      return messages
    }
  }
}
```

- [ ] **Step 2: Replace `HybridLocalPayBleTransport.swift` with the CoreBluetooth backend**

Open `packages/react-native-localpay-transport/ios/HybridLocalPayBleTransport.swift` (the Task 1 stub) and replace its entire contents with the file below. Structure: `HybridLocalPayBleTransport` is a thin Nitro-facing shell because `HybridLocalPayBleTransportSpec_base` is not an `NSObject` and every CoreBluetooth delegate protocol requires `NSObjectProtocol`; all state and both delegate roles live in `BleEngine`, and each payer-side send is its own `OutboundSend` object that is also the `CBPeripheralDelegate` for the peripheral it connected to.

Non-obvious decisions, each cited to the spec:
- One serial `DispatchQueue("org.bsvassociation.localpay.ble")` is the delegate queue for both managers, and every bridge-thread entry point mutates state inside `queue.sync` (spec §3 "All peripheral state is confined to one serial DispatchQueue"; identical to `HybridLocalPayTransport.swift:5-21`).
- Managers are created lazily in `prepare()` (payee) or `sendFrame()` (payer), never at construction, because instantiating any `CB*Manager` while authorization is `notDetermined` shows the privacy prompt (spec §7, "Verified facts").
- `CBPeripheralManager` cannot disconnect a central. "Disconnect that central" in spec §3 steps 3-4 is therefore implemented as *forgetting* it: its state is dropped, further writes are answered `insufficientAuthorization`, and it never receives HELLO_B or an ACK. The link itself dies when the central gives up or when the service is removed.
- `hasAccepted` is set and advertising is stopped in the same queue-confined statement block that delivers `onFrame`, before the ack can exist (spec §9 invariant 4).
- After the ACK's last chunk is queued the service is removed only after the payer unsubscribes or a 2 s grace elapses, because `removeAllServices()` immediately after `updateValue` can drop a queued indication; the payer cancels its connection as soon as it verifies the ack, so the grace rarely runs to completion.
- `CBManagerState.unauthorized` while `CBManager.authorization == .notDetermined` means "the prompt is on screen", not a decision, so `prepare()` keeps waiting in that state.
- `ShowPowerAlert` is disabled on both managers: the floor copy in the payer's confirm screen (spec §5) is where the user is told to turn Bluetooth on, not a system alert mid-flow.
- HELLO_A is also chunked at `maximumWriteValueLength(for: .withoutResponse)` (it is 37 bytes framed, which exceeds the 20-byte default) and written `.withResponse` chunk by chunk, so the Kotlin peripheral never has to handle GATT prepared/long writes (spec §3 "Framing on both characteristics").

```swift
import CoreBluetooth
import Foundation
import os.log
#if canImport(CoreNFC)
import CoreNFC
#endif

/// One subsystem/category so Console.app can filter the whole rung with
/// `subsystem:org.bsvblockchain.wallet category:LocalPayBle` — the category the
/// Task 1 stub already logged under, and the same tag the Kotlin backend uses
/// for logcat, so every hardware checklist greps for one string.
private let bleLog = OSLog(subsystem: "org.bsvblockchain.wallet", category: "LocalPayBle")

/// LocalPayBleTransport over CoreBluetooth (design spec §2-§3, §7).
///
/// This class is only the Nitro-facing shell. `HybridLocalPayBleTransportSpec_base`
/// is a plain Swift class, not an `NSObject`, and every CoreBluetooth delegate
/// protocol requires `NSObjectProtocol`, so the state machine lives in
/// `BleEngine` below and this type forwards to it one-to-one.
final class HybridLocalPayBleTransport: HybridLocalPayBleTransportSpec {
  private let engine = BleEngine()

  func isSupported() throws -> Bool {
    engine.isSupported()
  }

  func bluetoothState() throws -> String {
    engine.bluetoothState()
  }

  func nfcAvailable() throws -> Bool {
    BleEngine.nfcAvailable()
  }

  func prepare(timeoutMs: Double) throws -> Promise<String> {
    engine.prepare(timeoutMs: timeoutMs)
  }

  func startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: @escaping (String) -> Void,
    onError: @escaping (String) -> Void
  ) throws -> Promise<Void> {
    engine.startListening(instanceName: instanceName, pskBase64: pskBase64, onFrame: onFrame, onError: onError)
  }

  func stopListening() throws -> Promise<Void> {
    engine.stopListening()
  }

  func confirmFrame(accepted: Bool, reason: String) throws -> Promise<Void> {
    engine.confirmFrame(accepted: accepted, reason: reason)
  }

  func sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ) throws -> Promise<String> {
    engine.sendFrame(
      instanceName: instanceName, pskBase64: pskBase64, frameBase64: frameBase64,
      timeoutMs: timeoutMs, connectTimeoutMs: connectTimeoutMs
    )
  }
}

// MARK: - Peripheral-side bookkeeping

/// Everything the payee holds between `startListening` and the ack. Confined
/// to `BleEngine.queue`.
private final class ListenSession {
  let instanceName: String
  let psk: Data
  let serviceUuid: CBUUID
  let onFrame: (String) -> Void
  let onError: (String) -> Void
  /// Outstanding until `peripheralManagerDidStartAdvertising` (or a failure).
  var startPromise: Promise<Void>?
  var service: CBMutableService?
  var frameChar: CBMutableCharacteristic?
  var ackChar: CBMutableCharacteristic?
  var centrals: [UUID: InboundCentral] = [:]
  /// First-success-wins latch, mirroring `HybridLocalPayTransport.hasAccepted`
  /// and the Kotlin backend's field of the same name: set the instant a FRAME
  /// from a bound central is validated, before `onFrame` and before any ack.
  var hasAccepted = false
  /// The central whose FRAME went to JS and has not been acknowledged. Held
  /// -- deliberately un-acked -- until JS calls `confirmFrame`.
  var pendingAck: InboundCentral?
  var pendingAckTimeout: DispatchWorkItem?
  /// Set by `confirmFrame` until the last ACK chunk has been queued.
  var ackPromise: Promise<Void>?
  var ackTarget: InboundCentral?
  /// True once the ack is queued: writes are refused and the service goes
  /// away when the payer leaves or the grace period ends.
  var closing = false
  var closeTimeout: DispatchWorkItem?

  init(instanceName: String, psk: Data, serviceUuid: CBUUID,
       onFrame: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
    self.instanceName = instanceName
    self.psk = psk
    self.serviceUuid = serviceUuid
    self.onFrame = onFrame
    self.onError = onError
  }
}

/// One connected central as the peripheral sees it.
private final class InboundCentral {
  enum Stage { case awaitingHello, bound }
  let central: CBCentral
  var stage: Stage = .awaitingHello
  /// Subscribed to the ACK characteristic. Without this HELLO_B/ACK have no
  /// route back, so HELLO_A from an unsubscribed central is refused.
  var subscribed = false
  var reassembler = BleGattProfile.Reassembler()
  var idleReaper: DispatchWorkItem?

  init(central: CBCentral) { self.central = central }
}

/// A queued indication chunk. `completion` fires when CoreBluetooth accepts
/// the chunk into its own transmit queue (`updateValue` returned true).
private struct Indication {
  let central: CBCentral
  let chunk: Data
  let completion: (() -> Void)?
}

private struct PrepareWaiter {
  let promise: Promise<String>
  let timeout: DispatchWorkItem
}

// MARK: - Engine

/// Owns both CoreBluetooth managers and every piece of mutable state.
///
/// Threading, verbatim from the AWDL backend's discipline: both managers are
/// created with `queue` as their delegate queue, so every delegate callback in
/// this file (and every `OutboundSend` peripheral-delegate callback) already
/// runs on `queue` and touches state directly. The public entry points are
/// called from the JS-bridge thread, never from `queue`, and wrap their
/// mutations in `queue.sync`. `dispatchPrecondition` makes the confinement an
/// enforced invariant rather than an accident of wiring.
final class BleEngine: NSObject {
  fileprivate let queue = DispatchQueue(label: "org.bsvassociation.localpay.ble")

  fileprivate var peripheralManager: CBPeripheralManager?
  fileprivate var centralManager: CBCentralManager?
  /// Latest state either manager reported. Read by the prompt-free probes.
  private var lastKnownState: CBManagerState = .unknown
  private var prepareWaiters: [PrepareWaiter] = []

  private var listening: ListenSession?
  /// Indication chunks waiting for `updateValue` to accept them. Drained by
  /// `flushIndications`, resumed by `peripheralManagerIsReady(toUpdateSubscribers:)`.
  private var indicationQueue: [Indication] = []

  private var activeSend: OutboundSend?

  /// How long the service stays registered after the ACK's last chunk was
  /// queued, in case the payer has not yet read it and disconnected. iOS only:
  /// Android's `BluetoothGattServer.notifyCharacteristicChanged` is
  /// synchronous with respect to `onNotificationSent`.
  private static let ackFlushGraceMs = 2_000

  // MARK: Probes (prompt-free)

  fileprivate static func describe(_ state: CBManagerState) -> String {
    switch state {
    case .poweredOn: return "poweredOn"
    case .poweredOff: return "poweredOff"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    case .unknown, .resetting: return "unknown"
    @unknown default: return "unknown"
    }
  }

  /// `.unknown`/`.resetting` are transient. So is `.unauthorized` while the
  /// system prompt is still on screen (authorization `.notDetermined`).
  private static func isSettled(_ state: CBManagerState) -> Bool {
    switch state {
    case .unknown, .resetting: return false
    case .unauthorized: return CBManager.authorization != .notDetermined
    default: return true
    }
  }

  /// Hardware present, not denied, and — where a manager has already reported
  /// it in this process — not powered off. Prompt-free: nothing here creates a
  /// manager. `notDetermined` counts as supported so the ladder can pick BLE
  /// and let the prompt follow (spec §7). A radio that is merely off with no
  /// manager yet is indistinguishable from on without prompting; the ladder
  /// then tries BLE, sendFrame's fast "bluetooth unavailable" falls to the
  /// fountain, and the next scan in this process floors to QR with the
  /// local_bt_off copy (spec §5).
  func isSupported() -> Bool {
    switch CBManager.authorization {
    case .denied, .restricted: return false
    default: break
    }
    return queue.sync {
      switch self.lastKnownState {
      case .unsupported, .poweredOff: return false
      default: return true
      }
    }
  }

  func bluetoothState() -> String {
    queue.sync { self.stateString() }
  }

  static func nfcAvailable() -> Bool {
    #if canImport(CoreNFC)
    return NFCNDEFReaderSession.readingAvailable
    #else
    return false
    #endif
  }

  /// Runs on `queue`. Prefers a live manager's settled state; before any
  /// manager exists, all that can be known without prompting is authorization.
  private func stateString() -> String {
    dispatchPrecondition(condition: .onQueue(queue))
    if let cm = centralManager, Self.isSettled(cm.state) { return Self.describe(cm.state) }
    if let pm = peripheralManager, Self.isSettled(pm.state) { return Self.describe(pm.state) }
    if Self.isSettled(lastKnownState) { return Self.describe(lastKnownState) }
    switch CBManager.authorization {
    case .denied, .restricted: return "unauthorized"
    default: return "unknown"
    }
  }

  // MARK: Managers and prepare()

  /// The one place a `CB*Manager` is constructed -- and therefore the one
  /// place the iOS Bluetooth privacy prompt can appear. Runs on `queue`.
  private func ensureManagers() {
    dispatchPrecondition(condition: .onQueue(queue))
    if peripheralManager == nil {
      peripheralManager = CBPeripheralManager(
        delegate: self, queue: queue,
        options: [CBPeripheralManagerOptionShowPowerAlertKey: false]
      )
    }
    if centralManager == nil {
      centralManager = CBCentralManager(
        delegate: self, queue: queue,
        options: [CBCentralManagerOptionShowPowerAlertKey: false]
      )
    }
  }

  private var managersSettled: Bool {
    guard let pm = peripheralManager, let cm = centralManager else { return false }
    return Self.isSettled(pm.state) && Self.isSettled(cm.state)
  }

  func prepare(timeoutMs: Double) -> Promise<String> {
    let promise = Promise<String>()
    // Called from the JS-bridge thread, never from `queue` itself.
    queue.sync {
      self.ensureManagers()
      if self.managersSettled {
        let state = self.stateString()
        os_log("prepare resolved state=%{public}@", log: bleLog, type: .default, state)
        promise.resolve(withResult: state)
        return
      }
      let timeout = DispatchWorkItem { [weak self] in
        guard let self else { return }
        dispatchPrecondition(condition: .onQueue(self.queue))
        guard let idx = self.prepareWaiters.firstIndex(where: { $0.promise === promise }) else { return }
        self.prepareWaiters.remove(at: idx)
        let state = self.stateString()
        os_log("prepare timed out state=%{public}@", log: bleLog, type: .default, state)
        promise.resolve(withResult: state)
      }
      self.prepareWaiters.append(PrepareWaiter(promise: promise, timeout: timeout))
      self.queue.asyncAfter(deadline: .now() + .milliseconds(max(0, Int(timeoutMs))), execute: timeout)
    }
    return promise
  }

  private func stateChanged(_ state: CBManagerState) {
    dispatchPrecondition(condition: .onQueue(queue))
    lastKnownState = state
    guard managersSettled, !prepareWaiters.isEmpty else { return }
    let waiters = prepareWaiters
    prepareWaiters.removeAll()
    let result = stateString()
    os_log("prepare resolved state=%{public}@", log: bleLog, type: .default, result)
    for w in waiters {
      w.timeout.cancel()
      w.promise.resolve(withResult: result)
    }
  }

  // MARK: Payee: startListening / stopListening / confirmFrame

  func startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: @escaping (String) -> Void,
    onError: @escaping (String) -> Void
  ) -> Promise<Void> {
    let promise = Promise<Void>()
    guard let psk = Data(base64Encoded: pskBase64), !instanceName.isEmpty else {
      promise.reject(withError: BleGattProfile.error("bad psk or instance name", code: 10))
      return promise
    }
    // Called from the JS-bridge thread, never from `queue` itself.
    queue.sync {
      // Self-reset (spec §3 step 2): a previous session that was never
      // explicitly stopped must not leak its latch, centrals or reapers.
      self.resetListening()
      self.ensureManagers()
      let session = ListenSession(
        instanceName: instanceName, psk: psk,
        serviceUuid: BleGattProfile.serviceUuid(psk: psk, instanceName: instanceName),
        onFrame: onFrame, onError: onError
      )
      session.startPromise = promise
      self.listening = session
      self.advertiseIfPowered()
    }
    return promise
  }

  /// Adds the session service once the peripheral manager is powered on.
  /// Called from `startListening` and again from `peripheralManagerDidUpdateState`
  /// when the manager was still settling at that point.
  private func advertiseIfPowered() {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let session = listening, session.service == nil, let pm = peripheralManager else { return }
    switch pm.state {
    case .poweredOn:
      break
    case .unknown, .resetting:
      return
    case .unauthorized where CBManager.authorization == .notDetermined:
      return
    default:
      failStart(session, message: "bluetooth unavailable")
      return
    }
    let frame = CBMutableCharacteristic(
      type: BleGattProfile.frameCharUuid,
      properties: [.write, .writeWithoutResponse],
      value: nil,
      permissions: [.writeable]
    )
    let ack = CBMutableCharacteristic(
      type: BleGattProfile.ackCharUuid,
      properties: [.indicate],
      value: nil,
      permissions: [.readable]
    )
    let service = CBMutableService(type: session.serviceUuid, primary: true)
    service.characteristics = [frame, ack]
    session.frameChar = frame
    session.ackChar = ack
    session.service = service
    pm.add(service)
  }

  private func failStart(_ session: ListenSession, message: String) {
    dispatchPrecondition(condition: .onQueue(queue))
    if let promise = session.startPromise {
      session.startPromise = nil
      promise.reject(withError: BleGattProfile.error(message, code: 16))
    }
    resetListening()
  }

  /// Tears the current listen session down: advertising, service, every
  /// central's state, every reaper, every queued indication. Runs on `queue`.
  private func resetListening() {
    dispatchPrecondition(condition: .onQueue(queue))
    indicationQueue.removeAll()
    if let session = listening {
      session.centrals.values.forEach { $0.idleReaper?.cancel() }
      session.pendingAckTimeout?.cancel()
      session.closeTimeout?.cancel()
      if let promise = session.startPromise {
        session.startPromise = nil
        promise.reject(withError: BleGattProfile.error("listener reset", code: 17))
      }
      if let promise = session.ackPromise {
        session.ackPromise = nil
        promise.reject(withError: BleGattProfile.error("listener reset", code: 17))
      }
    }
    listening = nil
    if let pm = peripheralManager, pm.state == .poweredOn {
      if pm.isAdvertising { pm.stopAdvertising() }
      pm.removeAllServices()
    }
  }

  func stopListening() -> Promise<Void> {
    let promise = Promise<Void>()
    // Called from the JS-bridge thread, never from `queue` itself. JS must not
    // call this on the success path (it drops the central the ack has to go
    // to) -- see the `teardown` flag in core/localpay/transport/socket.ts.
    queue.sync {
      os_log("listener stopped by JS", log: bleLog, type: .default)
      self.resetListening()
    }
    promise.resolve(withResult: ())
    return promise
  }

  /// Sends the ACK to the central held since `onFrame`, then closes the
  /// session. `accepted: true` only after JS has durably queued the payment;
  /// `accepted: false` only where nothing was queued (spec §9). Idempotent
  /// with nothing pending. Rejects only if the ack cannot reach the central.
  func confirmFrame(accepted: Bool, reason: String) -> Promise<Void> {
    let promise = Promise<Void>()
    // Called from the JS-bridge thread, never from `queue` itself.
    queue.sync {
      guard let session = self.listening else {
        promise.resolve(withResult: ())
        return
      }
      session.pendingAckTimeout?.cancel()
      session.pendingAckTimeout = nil
      guard let target = session.pendingAck else {
        promise.resolve(withResult: ())
        return
      }
      session.pendingAck = nil
      guard target.subscribed, let pm = self.peripheralManager, pm.state == .poweredOn else {
        promise.reject(withError: BleGattProfile.error("peer disconnected before acking", code: 21))
        self.resetListening()
        return
      }
      // The session is over either way: nobody else gets HELLO_B or a FRAME in.
      for other in session.centrals.values where other !== target {
        self.forget(other, in: session)
      }
      let json = accepted ? BleGattProfile.okJson : BleGattProfile.declineJson(reason: reason)
      let message = BleGattProfile.ackMessage(
        psk: session.psk, instanceName: session.instanceName, ackJson: Data(json.utf8)
      )
      session.ackPromise = promise
      session.ackTarget = target
      session.closing = true
      self.enqueueIndication(message, to: target.central) { [weak self] in
        guard let self, let session = self.listening, session.ackPromise === promise else { return }
        session.ackPromise = nil
        os_log("ack sent ok=%d bytes=%ld", log: bleLog, type: .default, accepted ? 1 : 0, message.count)
        promise.resolve(withResult: ())
        self.scheduleClose(session)
      }
    }
    return promise
  }

  private func scheduleClose(_ session: ListenSession) {
    dispatchPrecondition(condition: .onQueue(queue))
    let item = DispatchWorkItem { [weak self] in
      guard let self, self.listening === session else { return }
      dispatchPrecondition(condition: .onQueue(self.queue))
      self.resetListening()
    }
    session.closeTimeout = item
    queue.asyncAfter(deadline: .now() + .milliseconds(Self.ackFlushGraceMs), execute: item)
  }

  // MARK: Payee: per-central state

  private func inbound(for central: CBCentral, in session: ListenSession) -> InboundCentral {
    dispatchPrecondition(condition: .onQueue(queue))
    if let existing = session.centrals[central.identifier] { return existing }
    let entry = InboundCentral(central: central)
    session.centrals[central.identifier] = entry
    armIdleReaper(entry, in: session)
    return entry
  }

  /// 30 s idle reaper per central (spec §3 step 3). Silent: a stranger that
  /// connected to the advertisement and never completed HELLO is not a failed
  /// payment, and `onError` is scoped to the one accepted payment per session.
  private func armIdleReaper(_ entry: InboundCentral, in session: ListenSession) {
    let item = DispatchWorkItem { [weak self] in
      guard let self else { return }
      dispatchPrecondition(condition: .onQueue(self.queue))
      guard let session = self.listening,
            let current = session.centrals[entry.central.identifier], current === entry else { return }
      os_log("idle central forgotten id=%{public}@", log: bleLog, type: .default, entry.central.identifier.uuidString)
      self.forget(current, in: session)
    }
    entry.idleReaper = item
    queue.asyncAfter(deadline: .now() + .milliseconds(BleGattProfile.idleConnectionTimeoutMs), execute: item)
  }

  /// CoreBluetooth offers no peripheral-side disconnect. Forgetting a central
  /// means: its state is gone, its queued indications are dropped, and its
  /// further writes are answered `insufficientAuthorization`.
  private func forget(_ entry: InboundCentral, in session: ListenSession) {
    dispatchPrecondition(condition: .onQueue(queue))
    entry.idleReaper?.cancel()
    entry.idleReaper = nil
    session.centrals.removeValue(forKey: entry.central.identifier)
    let id = entry.central.identifier
    indicationQueue.removeAll { $0.central.identifier == id }
  }

  /// 60 s ack reaper (spec §3 step 7). Tears down SILENTLY -- never a
  /// synthesised negative ack -- for the reasons spelled out at
  /// HybridLocalPayTransport.pendingAckConfirmTimeout: a negative ack releases
  /// the payer's inputs, and a payee that is merely slow may still succeed.
  private func armAckReaper(_ entry: InboundCentral, in session: ListenSession) {
    let item = DispatchWorkItem { [weak self] in
      guard let self else { return }
      dispatchPrecondition(condition: .onQueue(self.queue))
      guard let session = self.listening, session.pendingAck === entry else { return }
      session.pendingAck = nil
      session.pendingAckTimeout = nil
      self.forget(entry, in: session)
      session.onError("payee never confirmed the payment; connection released")
    }
    session.pendingAckTimeout = item
    queue.asyncAfter(deadline: .now() + .milliseconds(BleGattProfile.pendingAckTimeoutMs), execute: item)
  }

  /// Dispatches one reassembled message from one central (spec §3 steps 4-5).
  private func handle(message: Data, from entry: InboundCentral, in session: ListenSession) {
    dispatchPrecondition(condition: .onQueue(queue))
    // An earlier message in the same write batch may already have forgotten it.
    guard session.centrals[entry.central.identifier] === entry, !message.isEmpty else { return }
    let type = message[message.startIndex]
    let body = Data(message.dropFirst())
    let id = entry.central.identifier.uuidString

    switch (type, entry.stage) {
    case (BleGattProfile.typeHelloA, .awaitingHello):
      let expected = BleGattProfile.proof(psk: session.psk, instanceName: session.instanceName, type: BleGattProfile.typeHelloA)
      guard entry.subscribed, BleGattProfile.constantTimeEquals(body, expected) else {
        // Wrong PSK, or no route back for HELLO_B: forget it, keep advertising.
        os_log("hello rejected id=%{public}@", log: bleLog, type: .default, id)
        forget(entry, in: session)
        return
      }
      entry.stage = .bound
      os_log("hello verified id=%{public}@", log: bleLog, type: .default, id)
      enqueueIndication(
        BleGattProfile.helloB(psk: session.psk, instanceName: session.instanceName),
        to: entry.central, completion: nil
      )

    case (BleGattProfile.typeFrame, .bound):
      // First-success-wins as a native invariant: a second PSK-holder reaching
      // FRAME after we accepted one is refused outright, never raced.
      guard !session.hasAccepted, !body.isEmpty else {
        forget(entry, in: session)
        return
      }
      session.hasAccepted = true
      entry.idleReaper?.cancel()
      entry.idleReaper = nil
      // Stop advertising immediately so nothing else can connect, rather than
      // waiting for JS to round-trip stopListening().
      if let pm = peripheralManager, pm.isAdvertising { pm.stopAdvertising() }
      // Arm the hold BEFORE handing the frame over (see
      // HybridLocalPayTransport.acceptConnection for why the order matters).
      session.pendingAck = entry
      armAckReaper(entry, in: session)
      os_log("frame accepted bytes=%ld id=%{public}@", log: bleLog, type: .default, body.count, id)
      session.onFrame(body.base64EncodedString())

    default:
      // FRAME before HELLO, a second HELLO, or an unknown type: protocol violation.
      forget(entry, in: session)
    }
  }

  // MARK: Payee: indications with backpressure

  private func enqueueIndication(_ message: Data, to central: CBCentral, completion: (() -> Void)?) {
    dispatchPrecondition(condition: .onQueue(queue))
    let parts = BleGattProfile.chunks(BleGattProfile.lengthPrefixed(message), size: central.maximumUpdateValueLength)
    for (i, part) in parts.enumerated() {
      indicationQueue.append(Indication(central: central, chunk: part, completion: i == parts.count - 1 ? completion : nil))
    }
    flushIndications()
  }

  /// `updateValue` returns false when CoreBluetooth's transmit queue is full;
  /// the remainder waits for `peripheralManagerIsReady(toUpdateSubscribers:)`.
  private func flushIndications() {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let pm = peripheralManager, let session = listening, let ack = session.ackChar else {
      indicationQueue.removeAll()
      return
    }
    while let next = indicationQueue.first {
      guard pm.updateValue(next.chunk, for: ack, onSubscribedCentrals: [next.central]) else { return }
      indicationQueue.removeFirst()
      next.completion?()
    }
  }

  // MARK: Payer: sendFrame

  func sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ) -> Promise<String> {
    let promise = Promise<String>()
    guard let psk = Data(base64Encoded: pskBase64),
          let sealed = Data(base64Encoded: frameBase64),
          !instanceName.isEmpty else {
      promise.reject(withError: BleGattProfile.error("bad psk or frame", code: 11))
      return promise
    }
    // Type byte + sealed body must fit one profile message (spec §3).
    guard sealed.count + 1 <= BleGattProfile.maxBleFrameBytes else {
      promise.reject(withError: BleGattProfile.error("frame too large for a BLE payload", code: 30))
      return promise
    }
    // Called from the JS-bridge thread, never from `queue` itself.
    queue.sync {
      self.ensureManagers()
      // JS may have abandoned an earlier send (its own abort) and retried
      // before our timeouts fired; the newer send wins.
      if let previous = self.activeSend {
        previous.settle(.failure(BleGattProfile.error("superseded by a newer send", code: 15)))
      }
      let send = OutboundSend(
        engine: self, instanceName: instanceName, psk: psk, sealed: sealed, promise: promise
      )
      self.activeSend = send
      send.start(timeoutMs: timeoutMs, connectTimeoutMs: connectTimeoutMs)
    }
    return promise
  }

  /// Called by `OutboundSend.settle` on `queue`: releases the radio.
  fileprivate func finishSend(_ send: OutboundSend) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard activeSend === send else { return }
    activeSend = nil
    guard let cm = centralManager else { return }
    if send.isScanning { cm.stopScan() }
    if let p = send.peripheral, p.state != .disconnected { cm.cancelPeripheralConnection(p) }
  }
}

// MARK: - CBPeripheralManagerDelegate (payee)

extension BleEngine: CBPeripheralManagerDelegate {
  func peripheralManagerDidUpdateState(_ pm: CBPeripheralManager) {
    dispatchPrecondition(condition: .onQueue(queue))
    os_log("peripheral manager state=%{public}@", log: bleLog, type: .default, Self.describe(pm.state))
    stateChanged(pm.state)
    guard let session = listening else { return }
    switch pm.state {
    case .poweredOn:
      advertiseIfPowered()
    case .unknown, .resetting:
      break
    case .unauthorized where CBManager.authorization == .notDetermined:
      break
    default:
      if session.startPromise != nil {
        failStart(session, message: "bluetooth unavailable")
      } else if !session.closing {
        let onError = session.onError
        resetListening()
        onError("bluetooth unavailable")
      } else {
        resetListening()
      }
    }
  }

  func peripheralManager(_ pm: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let session = listening, session.service?.uuid == service.uuid else { return }
    if let error {
      failStart(session, message: error.localizedDescription)
      return
    }
    pm.startAdvertising([
      CBAdvertisementDataServiceUUIDsKey: [session.serviceUuid],
      CBAdvertisementDataLocalNameKey: BleGattProfile.localName
    ])
  }

  func peripheralManagerDidStartAdvertising(_ pm: CBPeripheralManager, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let session = listening else { return }
    if let error {
      failStart(session, message: error.localizedDescription)
      return
    }
    os_log("advertising started service=%{public}@ name=%{public}@", log: bleLog, type: .default,
           session.serviceUuid.uuidString, session.instanceName)
    if let promise = session.startPromise {
      session.startPromise = nil
      promise.resolve(withResult: ())
    }
  }

  func peripheralManager(_ pm: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let session = listening, characteristic.uuid == BleGattProfile.ackCharUuid, !session.closing else { return }
    // A subscriber after acceptance can never be bound (advertising stopped
    // before it could have discovered us); do not track it.
    guard !session.hasAccepted || session.centrals[central.identifier] != nil else { return }
    let entry = inbound(for: central, in: session)
    entry.subscribed = true
    os_log("central connected id=%{public}@ maxUpdate=%ld", log: bleLog, type: .default,
           central.identifier.uuidString, central.maximumUpdateValueLength)
  }

  func peripheralManager(_ pm: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let session = listening, let entry = session.centrals[central.identifier] else { return }
    entry.subscribed = false
    let id = central.identifier
    indicationQueue.removeAll { $0.central.identifier == id }
    if let promise = session.ackPromise, session.ackTarget === entry {
      // Mid-ack disconnect: the ack did not fully leave this device.
      session.ackPromise = nil
      promise.reject(withError: BleGattProfile.error("peer disconnected before acking", code: 21))
      resetListening()
      return
    }
    if session.closing, session.ackTarget === entry {
      // The payer read its ack and left: no need to wait out the grace period.
      resetListening()
      return
    }
    if session.pendingAck !== entry {
      // Not the held central: an idle or refused stranger leaving.
      forget(entry, in: session)
    }
    // If it IS the held central (payer gave up before JS confirmed), keep the
    // entry with subscribed == false so confirmFrame reports the failure
    // instead of silently succeeding into nowhere.
  }

  func peripheralManager(_ pm: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let first = requests.first else { return }
    guard let session = listening, !session.closing else {
      pm.respond(to: first, withResult: .insufficientAuthorization)
      return
    }
    var result: CBATTError.Code = .success
    for request in requests {
      guard request.characteristic.uuid == BleGattProfile.frameCharUuid else {
        result = .attributeNotFound
        continue
      }
      let entry: InboundCentral
      if let existing = session.centrals[request.central.identifier] {
        entry = existing
      } else if session.hasAccepted {
        result = .insufficientAuthorization
        continue
      } else {
        entry = inbound(for: request.central, in: session)
      }
      guard let value = request.value, !value.isEmpty else { continue }
      do {
        // Long (prepared) writes arrive as several requests with offsets, in
        // order; appending in array order is correct for a byte stream.
        let messages = try entry.reassembler.feed(value)
        for message in messages {
          handle(message: message, from: entry, in: session)
        }
      } catch {
        forget(entry, in: session)
        result = .invalidAttributeValueLength
      }
    }
    // One response per batch, on the first request (CBPeripheralManager
    // contract). CoreBluetooth ignores it for write-without-response requests,
    // which it cannot distinguish for us on CBATTRequest.
    pm.respond(to: first, withResult: result)
  }

  func peripheralManagerIsReady(toUpdateSubscribers pm: CBPeripheralManager) {
    dispatchPrecondition(condition: .onQueue(queue))
    flushIndications()
  }
}

// MARK: - CBCentralManagerDelegate (payer) -- forwards to the active send

extension BleEngine: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ cm: CBCentralManager) {
    dispatchPrecondition(condition: .onQueue(queue))
    os_log("central manager state=%{public}@", log: bleLog, type: .default, Self.describe(cm.state))
    stateChanged(cm.state)
    activeSend?.managerStateChanged(cm.state)
  }

  func centralManager(_ cm: CBCentralManager, didDiscover peripheral: CBPeripheral,
                      advertisementData: [String: Any], rssi RSSI: NSNumber) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didDiscover(peripheral, rssi: RSSI)
  }

  func centralManager(_ cm: CBCentralManager, didConnect peripheral: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didConnect(peripheral)
  }

  func centralManager(_ cm: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didFailToConnect(peripheral, error: error)
  }

  func centralManager(_ cm: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didDisconnect(peripheral, error: error)
  }
}

// MARK: - One payer-side send (spec §3, central state machine)

/// Scan → connect → discover → subscribe → HELLO_A → HELLO_B → FRAME → ACK.
/// Owns its own `settled` latch, both timers and the peripheral delegate for
/// the one peripheral it connects to. All callbacks arrive on `engine.queue`
/// because that is the central manager's delegate queue and CBPeripheral
/// delegates inherit it.
private final class OutboundSend: NSObject, CBPeripheralDelegate {
  private enum Stage {
    case scanning, connecting, discoveringServices, discoveringCharacteristics,
         subscribing, sendingHello, awaitingHelloB, writingFrame, awaitingAck
  }

  private weak var engine: BleEngine?
  private let queue: DispatchQueue
  private let instanceName: String
  private let psk: Data
  private let sealed: Data
  private let serviceUuid: CBUUID
  private let promise: Promise<String>

  private var stage: Stage = .scanning
  private(set) var isScanning = false
  private(set) var peripheral: CBPeripheral?
  private var frameChar: CBCharacteristic?
  private var ackChar: CBCharacteristic?
  private var reassembler = BleGattProfile.Reassembler()
  private var helloChunks: [Data] = []
  private var frameChunks: [Data] = []
  private var frameBytes = 0
  private var settled = false
  /// True once the ACK subscription is confirmed: the connect budget is met.
  private var connectPhaseDone = false
  private var wholeTimeout: DispatchWorkItem?
  private var connectTimeout: DispatchWorkItem?
  private let startedAt = DispatchTime.now()
  private var frameStartedAt: DispatchTime?

  init(engine: BleEngine, instanceName: String, psk: Data, sealed: Data, promise: Promise<String>) {
    self.engine = engine
    self.queue = engine.queue
    self.instanceName = instanceName
    self.psk = psk
    self.sealed = sealed
    self.serviceUuid = BleGattProfile.serviceUuid(psk: psk, instanceName: instanceName)
    self.promise = promise
    super.init()
  }

  private func elapsedMs(since start: DispatchTime) -> Int {
    Int((DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000)
  }

  /// Runs on `queue`. `connectTimeoutMs` covers scan + connect + discovery +
  /// subscribe (spec §3 step 8); `timeoutMs` covers the whole exchange.
  func start(timeoutMs: Double, connectTimeoutMs: Double) {
    dispatchPrecondition(condition: .onQueue(queue))
    let whole = DispatchWorkItem { [weak self] in
      self?.settle(.failure(BleGattProfile.error("timed out waiting for peer", code: 12)))
    }
    wholeTimeout = whole
    queue.asyncAfter(deadline: .now() + .milliseconds(max(0, Int(timeoutMs))), execute: whole)

    let connect = DispatchWorkItem { [weak self] in
      guard let self, !self.connectPhaseDone else { return }
      self.settle(.failure(BleGattProfile.error("connect timeout: no route to peer", code: 14)))
    }
    connectTimeout = connect
    queue.asyncAfter(deadline: .now() + .milliseconds(max(0, Int(connectTimeoutMs))), execute: connect)

    if let cm = engine?.centralManager {
      managerStateChanged(cm.state)
    }
  }

  /// Settle latch, as in `HybridLocalPayTransport.sendFrame`: every caller is
  /// on `queue`, so a plain Bool is safe and the precondition enforces it.
  func settle(_ result: Result<String, Error>) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled else { return }
    settled = true
    wholeTimeout?.cancel()
    connectTimeout?.cancel()
    engine?.finishSend(self)
    isScanning = false
    switch result {
    case .success(let ack): promise.resolve(withResult: ack)
    case .failure(let error): promise.reject(withError: error)
    }
  }

  // MARK: Central manager events (forwarded by BleEngine)

  func managerStateChanged(_ state: CBManagerState) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .scanning, !isScanning, let cm = engine?.centralManager else { return }
    switch state {
    case .poweredOn:
      isScanning = true
      cm.scanForPeripherals(withServices: [serviceUuid],
                            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
      os_log("scanning service=%{public}@", log: bleLog, type: .default, serviceUuid.uuidString)
    case .unknown, .resetting:
      break
    case .unauthorized where CBManager.authorization == .notDetermined:
      break
    default:
      settle(.failure(BleGattProfile.error("bluetooth unavailable", code: 16)))
    }
  }

  func didDiscover(_ p: CBPeripheral, rssi: NSNumber) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .scanning, let cm = engine?.centralManager else { return }
    // The filter already matched the per-session UUID: first hit is the payee.
    cm.stopScan()
    isScanning = false
    stage = .connecting
    peripheral = p
    p.delegate = self
    os_log("scan hit rssi=%d id=%{public}@ ms=%ld", log: bleLog, type: .default,
           rssi.int32Value, p.identifier.uuidString, elapsedMs(since: startedAt))
    cm.connect(p, options: nil)
  }

  func didConnect(_ p: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, p === peripheral, stage == .connecting else { return }
    stage = .discoveringServices
    os_log("connected id=%{public}@ maxWriteLen=%ld ms=%ld", log: bleLog, type: .default,
           p.identifier.uuidString, p.maximumWriteValueLength(for: .withoutResponse), elapsedMs(since: startedAt))
    p.discoverServices([serviceUuid])
  }

  func didFailToConnect(_ p: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral else { return }
    settle(.failure(error ?? BleGattProfile.error("connect failed", code: 18)))
  }

  func didDisconnect(_ p: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral, !settled else { return }
    switch stage {
    case .sendingHello, .awaitingHelloB, .writingFrame, .awaitingAck:
      settle(.failure(BleGattProfile.error("peer disconnected before acking", code: 21)))
    default:
      settle(.failure(error ?? BleGattProfile.error("peer disconnected", code: 19)))
    }
  }

  // MARK: CBPeripheralDelegate

  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .discoveringServices else { return }
    if let error { return settle(.failure(error)) }
    guard let service = p.services?.first(where: { $0.uuid == serviceUuid }) else {
      return settle(.failure(BleGattProfile.error("session service not found on peer", code: 20)))
    }
    stage = .discoveringCharacteristics
    p.discoverCharacteristics([BleGattProfile.frameCharUuid, BleGattProfile.ackCharUuid], for: service)
  }

  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .discoveringCharacteristics, service.uuid == serviceUuid else { return }
    if let error { return settle(.failure(error)) }
    let chars = service.characteristics ?? []
    guard let frame = chars.first(where: { $0.uuid == BleGattProfile.frameCharUuid }),
          let ack = chars.first(where: { $0.uuid == BleGattProfile.ackCharUuid }) else {
      return settle(.failure(BleGattProfile.error("session characteristics not found on peer", code: 20)))
    }
    frameChar = frame
    ackChar = ack
    stage = .subscribing
    p.setNotifyValue(true, for: ack)
  }

  func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .subscribing, characteristic.uuid == BleGattProfile.ackCharUuid else { return }
    if let error { return settle(.failure(error)) }
    guard characteristic.isNotifying, let frame = frameChar else {
      return settle(.failure(BleGattProfile.error("peer refused the ack subscription", code: 20)))
    }
    // Connect phase complete (spec §3 step 8): the connect budget no longer applies.
    connectPhaseDone = true
    connectTimeout?.cancel()
    os_log("subscribed ms=%ld", log: bleLog, type: .default, elapsedMs(since: startedAt))

    // HELLO_A, chunked like everything else and written WITH response so the
    // peripheral's reply to the last chunk doubles as delivery confirmation.
    let framed = BleGattProfile.lengthPrefixed(BleGattProfile.helloA(psk: psk, instanceName: instanceName))
    helloChunks = BleGattProfile.chunks(framed, size: p.maximumWriteValueLength(for: .withoutResponse))
    stage = .sendingHello
    writeNextHelloChunk(p, frame)
  }

  private func writeNextHelloChunk(_ p: CBPeripheral, _ frame: CBCharacteristic) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !helloChunks.isEmpty else { return }
    let chunk = helloChunks.removeFirst()
    if helloChunks.isEmpty {
      // HELLO_B may arrive before the write response to this final chunk.
      stage = .awaitingHelloB
    }
    p.writeValue(chunk, for: frame, type: .withResponse)
  }

  func peripheral(_ p: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, characteristic.uuid == BleGattProfile.frameCharUuid else { return }
    if let error { return settle(.failure(error)) }
    if stage == .sendingHello, let frame = frameChar {
      writeNextHelloChunk(p, frame)
    }
  }

  func peripheral(_ p: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, characteristic.uuid == BleGattProfile.ackCharUuid else { return }
    if let error { return settle(.failure(error)) }
    guard let value = characteristic.value, !value.isEmpty else { return }
    let messages: [Data]
    do {
      messages = try reassembler.feed(value)
    } catch {
      return settle(.failure(error))
    }
    for message in messages where !settled {
      handle(message: message, on: p)
    }
  }

  private func handle(message: Data, on p: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !message.isEmpty else { return }
    let type = message[message.startIndex]
    let body = Data(message.dropFirst())

    switch (type, stage) {
    case (BleGattProfile.typeHelloB, .awaitingHelloB), (BleGattProfile.typeHelloB, .sendingHello):
      let expected = BleGattProfile.proof(psk: psk, instanceName: instanceName, type: BleGattProfile.typeHelloB)
      guard BleGattProfile.constantTimeEquals(body, expected) else {
        return settle(.failure(BleGattProfile.error("peer failed the session proof", code: 22)))
      }
      os_log("hello verified ms=%ld", log: bleLog, type: .default, elapsedMs(since: startedAt))
      let framed = BleGattProfile.lengthPrefixed(BleGattProfile.frameMessage(sealed: sealed))
      frameBytes = framed.count
      frameChunks = BleGattProfile.chunks(framed, size: p.maximumWriteValueLength(for: .withoutResponse))
      frameStartedAt = DispatchTime.now()
      stage = .writingFrame
      pumpWrites()

    case (BleGattProfile.typeAck, .awaitingAck):
      guard body.count > BleGattProfile.macLength else {
        return settle(.failure(BleGattProfile.error("peer failed the session proof", code: 22)))
      }
      let json = Data(body.prefix(body.count - BleGattProfile.macLength))
      let mac = Data(body.suffix(BleGattProfile.macLength))
      let expected = BleGattProfile.ackMac(psk: psk, instanceName: instanceName, ackJson: json)
      guard BleGattProfile.constantTimeEquals(mac, expected) else {
        return settle(.failure(BleGattProfile.error("peer failed the session proof", code: 22)))
      }
      os_log("ack verified bytes=%ld ms=%ld", log: bleLog, type: .default, json.count, elapsedMs(since: startedAt))
      // MAC stripped: JS's parseAck sees exactly the AWDL/Nearby ack JSON.
      settle(.success(json.base64EncodedString()))

    default:
      settle(.failure(BleGattProfile.error("peer failed the session proof", code: 22)))
    }
  }

  /// Write-without-response with real backpressure (spec §3 step 6): stop
  /// when CoreBluetooth's buffer is full, resume from
  /// `peripheralIsReady(toSendWriteWithoutResponse:)`. No pacing sleeps.
  private func pumpWrites() {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .writingFrame, let p = peripheral, let frame = frameChar else { return }
    while !frameChunks.isEmpty {
      guard p.canSendWriteWithoutResponse else { return }
      let chunk = frameChunks.removeFirst()
      p.writeValue(chunk, for: frame, type: .withoutResponse)
    }
    stage = .awaitingAck
    let ms = frameStartedAt.map { elapsedMs(since: $0) } ?? 0
    os_log("frame written bytes=%ld ms=%ld", log: bleLog, type: .default, frameBytes, ms)
  }

  func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    pumpWrites()
  }
}
```

- [ ] **Step 3: Podspec — add the profile file and confirm CoreBluetooth is linked**

Open `packages/react-native-localpay-transport/LocalPayTransport.podspec`. Lines 14-19 are what Task 1 Step 10 left:

```ruby
  # BleGattProfile.swift joins this list in Task 8 (BLE backend).
  s.source_files = ['ios/HybridLocalPayTransport.swift', 'ios/AwdlSession.swift', 'ios/HybridLocalPayBleTransport.swift']
  # CoreBluetooth: the BLE rung. CoreNFC: the prompt-free nfcAvailable() probe
  # (HINT_NFC). Linking CoreBluetooth is what makes ITMS-90683 demand
  # NSBluetoothAlwaysUsageDescription — set in app.json ios.infoPlist.
  s.frameworks   = 'Network', 'Security', 'CoreBluetooth', 'CoreNFC'
```

Replace those six lines so they read exactly:

```ruby
  # BleGattProfile.swift is the pure bsvpay-ble/1 profile (UUID derivation,
  # proofs, framing); HybridLocalPayBleTransport.swift is the CoreBluetooth
  # peripheral/central state machine behind the Nitro spec.
  s.source_files = [
    'ios/HybridLocalPayTransport.swift',
    'ios/AwdlSession.swift',
    'ios/HybridLocalPayBleTransport.swift',
    'ios/BleGattProfile.swift'
  ]
  # CoreBluetooth: the BLE rung. CoreNFC: the prompt-free nfcAvailable() probe
  # (HINT_NFC). Linking CoreBluetooth is what makes ITMS-90683 demand
  # NSBluetoothAlwaysUsageDescription — set in app.json ios.infoPlist.
  s.frameworks   = 'Network', 'Security', 'CoreBluetooth', 'CoreNFC'
```

`s.frameworks` is unchanged from Task 1 (CoreNFC stays explicit even though the Swift `import CoreNFC` would autolink it — Task 1 Step 14's `otool -L` check depends on it). Verify with:

```bash
cd /Users/personal/git/bsv-wallet && ruby -e 'load "packages/react-native-localpay-transport/LocalPayTransport.podspec"' 2>&1 | head -3; grep -c "'ios/BleGattProfile.swift'" packages/react-native-localpay-transport/LocalPayTransport.podspec
```

Expected: the `ruby -e` load fails only at `Pod::Spec` (`uninitialized constant Pod`) — a Ruby `SyntaxError` would not be acceptable — and `1` from the grep (the quoted source entry; the comment mentions the file without quotes).

- [ ] **Step 4: Regenerate `ios/` and compile the pod target**

The podspec's `source_files` changed, so the Pods project must be regenerated. From the repo root:

```bash
cd /Users/personal/git/bsv-wallet && npx expo prebuild --clean --platform ios 2>&1 | tail -5
```

Expected last lines include `✔ Installed CocoaPods` (or `Installing CocoaPods...` then a success line) and no `[!]` CocoaPods error. Confirm the new file is in the Pods project:

```bash
cd /Users/personal/git/bsv-wallet && grep -c "BleGattProfile.swift" ios/Pods/Pods.xcodeproj/project.pbxproj
```

Expected: a number `>= 2` (file reference + build file). Now compile only the `LocalPayTransport` pod target — this is the Swift compile gate for this task and takes 2-6 minutes (it also builds NitroModules and the React-Core headers it depends on) instead of the 15+ minutes a full app build takes:

```bash
cd /Users/personal/git/bsv-wallet/ios && xcodebuild -project Pods/Pods.xcodeproj -target LocalPayTransport -sdk iphoneos -configuration Debug CODE_SIGNING_ALLOWED=NO ONLY_ACTIVE_ARCH=NO build 2>&1 | tee /private/tmp/claude-502/-Users-personal-git-bsv-wallet/26583f48-1da5-440b-accc-13f01e7486d0/scratchpad/xcodebuild-task8.log | grep -E "error:|warning:.*(BleGattProfile|HybridLocalPayBleTransport)|BUILD (SUCCEEDED|FAILED)"
```

Expected output: exactly one line `** BUILD SUCCEEDED **` and no `error:` lines. If you see `error: cannot find type 'HybridLocalPayBleTransportSpec' in scope`, Task 1's nitrogen output is missing: run `cd packages/react-native-localpay-transport && npx nitrogen` and repeat this step. If you see `error: cannot find type 'Promise' in scope`, add `import NitroModules` at the top of `HybridLocalPayBleTransport.swift` and rebuild (not expected: `HybridLocalPayTransport.swift` uses `Promise` without the import).

Then run the JS suites that exercise this object through the mock, to be sure nothing in the packages moved (they do not touch Swift, so this is a regression check only):

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/localpay 2>&1 | tail -6
```

Expected: `Tests: ... passed` with `0 failed`.

- [ ] **Step 5: Commit the backend**

```bash
cd /Users/personal/git/bsv-wallet && git add packages/react-native-localpay-transport/ios/BleGattProfile.swift packages/react-native-localpay-transport/ios/HybridLocalPayBleTransport.swift packages/react-native-localpay-transport/LocalPayTransport.podspec ios/ && git commit -m "$(cat <<'EOF'
feat(ble): CoreBluetooth backend for LocalPayBleTransport

Implements the bsvpay-ble/1 GATT profile on iOS behind the Nitro spec
that Task 1 registered: BleGattProfile holds the per-session service
UUID derivation (HMAC-SHA256 over psk and instance name with RFC-4122
bits forced), the HELLO_A/HELLO_B/FRAME/ACK messages, the ack MAC, and
the u32-BE stream framing; HybridLocalPayBleTransport runs the payee
peripheral (advertise, verify HELLO_A, bind, first-success-wins latch
before onFrame, hold the central until confirmFrame, 30 s idle and 60 s
silent ack reapers) and the payer central (scan-filtered connect,
subscribe, HELLO round trip, write-without-response with
peripheralIsReady backpressure, constant-time ack MAC check) on one
serial queue, mirroring the AWDL backend's discipline.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

Expected: one commit; `git status --short` shows nothing under `packages/react-native-localpay-transport/ios` or `ios/`.

- [ ] **Step 6: Create the hardware log document (template)**

Create `docs/superpowers/2026-09-02-ble-hardware-log.md` with the table the hardware step fills in. Leave the measurement cells as `—` until measured; Task 9 (Kotlin) appends its own pairings to the same table.

```markdown
# BLE transport hardware log

Measurements for the `bsvpay-ble/1` rung (spec: `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md` §3 "Expected performance"). One row per attempt; keep failed attempts, they are the point.

Console.app filter used on each iPhone: `subsystem:org.bsvblockchain.wallet category:LocalPayBle`.

| Date | Payee device / OS | Payer device / OS | Pairing | maxUpdate (payee) | maxWriteLen (payer) | scan hit ms | subscribed ms | frame bytes | frame written ms | ack verified ms (total) | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-02 | — | — | iOS→iOS | — | — | — | — | — | — | — | — | — |
| 2026-09-02 | — | — | iOS→iOS (Wi-Fi off both) | — | — | — | — | — | — | — | — | — |
| 2026-09-02 | — | — | iOS→iOS (payer BT off) | — | — | — | — | — | — | — | — | expect `bluetooth unavailable` then fountain |
| 2026-09-02 | — | — | iOS→iOS (payee locked mid-wait) | — | — | — | — | — | — | — | — | expect payer `connect timeout: no route to peer` within 6 s |
| 2026-09-02 | — | — | iOS→iOS (second payer, same QR) | — | — | — | — | — | — | — | — | expect second payer refused at FRAME (no ack, falls to fountain) |

Column sources: `maxUpdate` from the payee's `central connected ... maxUpdate=N` line; `maxWriteLen` from the payer's `connected ... maxWriteLen=N` line; the `ms` columns are the `ms=` field of the payer's `scan hit`, `subscribed`, `frame written` and `ack verified` lines (`frame written ms` is measured from the first frame write, the others from `sendFrame` entry).
```

- [ ] **Step 7: Hardware checklist — iOS → iOS with two iPhones**

Prerequisites (do not start without all four):
1. Two physical iPhones, both signed into the same Apple developer team as `eas.json` `appleTeamId` `SV8SWTHA2H`, both with Bluetooth on.
2. Task 10's NearbyFlow wiring (the payee starts `bleTransport.receive` alongside AWDL through `raceReceivers`; the payer's ladder can select `'ble'`) is present in the branch you build. Until it is, the payee never advertises and this checklist cannot run; do Steps 1-6 now and return to this step after Task 10, or run it once at the end of the plan.
3. **Temporary, uncommitted** edit so an iPhone pair lands on BLE rather than AWDL (the ladder is AWDL → Nearby → BLE → QR, spec §5, and `localSupportsAwdl()` is a parameter-stack probe that stays true even with Wi-Fi off). In `packages/expo-wallet-toolbox/core/localpay/transport/select.ts`, change the body of `localSupportsAwdl()` (lines 8-15) to a single `return false`. Both phones get the same build, so the payee stops advertising `CAP_AWDL` and listens on BLE only, and the payer selects `'ble'`. Revert with `git checkout -- packages/expo-wallet-toolbox/core/localpay/transport/select.ts` before Step 8. Cross-OS pairings in Task 9 need no such edit.
4. A Mac with Console.app, each iPhone connected by cable at least once so it appears in Console's sidebar.

Build and install (one build, installed on both phones):

```bash
cd /Users/personal/git/bsv-wallet && npm run ios-dev-physical 2>&1 | tail -20
```

Expected: `Build successful` and a path to `build-*.ipa`. Install it on both iPhones (drag the `.ipa` onto each device in Finder, or use Apple Configurator). Then start the dev server and open the app on both phones:

```bash
cd /Users/personal/git/bsv-wallet && npx expo start --dev-client
```

Open Console.app, select iPhone A (payee), set the filter to `subsystem:org.bsvblockchain.wallet category:LocalPayBle`, click Start. Repeat in a second Console window for iPhone B (payer).

Run the happy path:
1. Payee (A): open the Pay → Receive nearby flow and enter an amount. When the QR appears, the first prepare() has run. **Expected UI:** the presence row shows `waiting` ("Waiting for the other device"-style copy from `local_pay_presence_waiting_payee`) with the Bluetooth icon (PresenceRow `medium='bluetooth'`, since BLE is the only live listener). **Expected A log, in order:**
   - `peripheral manager state=poweredOn`
   - `central manager state=poweredOn`
   - `prepare resolved state=poweredOn`
   - `advertising started service=<UUID> name=bsvpay-<base32>`
   The first launch also shows the iOS "BSV Wallet Would Like to Use Bluetooth" prompt at this moment and nowhere else; tap Allow.
2. Payer (B): scan A's QR and confirm. **Expected UI:** `ready` with the Bluetooth icon on the confirm screen, `waiting` on send, then the done screen within 5 s. **Expected B log, in order:**
   - `central manager state=poweredOn` (first launch: the Bluetooth prompt appears here; tap Allow)
   - `scanning service=<same UUID as A>`
   - `scan hit rssi=-NN id=<A's identifier> ms=<n>`
   - `connected id=... maxWriteLen=<N> ms=<n>` (expect `maxWriteLen` 182 or 244 on modern iPhones; 20 means the MTU stayed at 23)
   - `subscribed ms=<n>` (must be < 6000, the connect budget)
   - `hello verified ms=<n>`
   - `frame written bytes=<N> ms=<n>`
   - `ack verified bytes=11 ms=<n>` (11 = `{"ok":true}`)
3. **Expected A log** continuing:
   - `central connected id=<B's identifier> maxUpdate=<N>`
   - `hello verified id=...`
   - `frame accepted bytes=<N> id=...`
   - `ack sent ok=1 bytes=44` (type 1 + ack json 11 + MAC 32)
   **Expected A UI:** `linked` when the frame arrives, then `paid`.
4. Record `maxUpdate`, `maxWriteLen`, and the four `ms` values in the first row of `docs/superpowers/2026-09-02-ble-hardware-log.md`. Result column: `ok`.

Then the four failure rows, each on a fresh receive request:
- **Wi-Fi off on both** (Settings → Wi-Fi → off, not Control Center): identical log sequence; fill row 2. This proves BLE carries the payment with no Wi-Fi at all.
- **Payer Bluetooth off** (Settings → Bluetooth → off on B only): B's log shows `central manager state=poweredOff` and no `scanning`; the flow falls to the fountain QR (payer presence `qr`). No `scan hit`. Row 3 result: `fallback`.
- **Payee locked mid-wait**: on A, lock the screen once `advertising started` appears, then scan on B. iOS moves a backgrounded peripheral's UUIDs to the overflow area (spec "Verified facts"); B logs `scanning ...` and then, within 6 s, no `scan hit` and JS reports `connect timeout: no route to peer`, falling to the fountain. Row 4 result: `fallback`. (If you own a third iPhone, this is a good place to confirm a foreground iPhone central *does* still find it — it is Android centrals that cannot.)
- **Second payer, same QR**: photograph A's QR with B, complete the payment, then scan the same photo with a third iPhone (or B again after the done screen if the session survived). A never logs a second `frame accepted`: the second central is refused at FRAME with no ack (`hasAccepted` latch) and the second payer falls to its fountain, where the payee's JS answers `already_paid`. Row 5 result: `refused`.

Also confirm, in A's log after each completed payment, that no `payee never confirmed the payment` line ever appears on the happy path, and that `idle central forgotten` appears only in the lock/stranger cases.

Revert the temporary `select.ts` edit now:

```bash
cd /Users/personal/git/bsv-wallet && git checkout -- packages/expo-wallet-toolbox/core/localpay/transport/select.ts && git status --short packages/expo-wallet-toolbox/core/localpay/transport/select.ts
```

Expected: empty output from `git status --short`.

- [ ] **Step 8: Commit the hardware log**

```bash
cd /Users/personal/git/bsv-wallet && git add docs/superpowers/2026-09-02-ble-hardware-log.md && git commit -m "$(cat <<'EOF'
docs(ble): iOS to iOS hardware log for the BLE rung

Measured MTU, connect, transfer and ack times for the CoreBluetooth
backend on two iPhones, plus the radios-off, locked-payee and
second-payer failure cases the design's Testing section calls for.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

Expected: one commit containing only `docs/superpowers/2026-09-02-ble-hardware-log.md`. If the hardware step had to be deferred (prerequisite 2), commit the template as-is with the same message and fill the rows in when the checklist runs; the table's `—` cells make the gap visible rather than hidden.


---

### Task 9: Kotlin BLE backend (BluetoothGattServer + BluetoothGatt)

Replaces the Task 1 Kotlin stub with the real `bsvpay-ble/1` peripheral (payee) and central (payer) over `android.bluetooth`, mirroring `HybridLocalPayTransport.kt` (Nearby) structurally: main-`Handler` confinement, `javax.crypto.Mac` HMACs, `MessageDigest.isEqual` for constant time, `hasAccepted` first-success-wins latch, `boundDevice` / `pendingAckDevice`, identity-checked idle and ack reapers, `settle()` in `sendFrame`, and the exact error strings from the shared contract. Spec sections implemented: §2 (profile), §3 (messages, framing, both state machines), §7 Android permissions, §8 manifest feature flag.

**Files:**
- Create: `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/BleGattProfile.kt`
- Create: `packages/react-native-localpay-transport/android/src/test/java/com/margelo/nitro/localpaytransport/BleGattProfileTest.kt`
- Modify (replace whole file): `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport.kt` (the Task 1 stub)
- Modify: `packages/react-native-localpay-transport/android/build.gradle` lines 55-64 (`dependencies { ... }` block: add the JUnit test dependency)
- Verify only: `packages/react-native-localpay-transport/android/src/main/AndroidManifest.xml` already carries `<uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />` from Task 1 Step 10 (spec §8) — nothing to add
- Create or append: `docs/superpowers/2026-09-02-ble-hardware-log.md` (Task 8 creates it for iOS↔iOS; this task adds the three Android sections)
- Read first (do not modify): `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayTransport.kt` (the Nearby backend you are mirroring, all 578 lines), `packages/react-native-localpay-transport/nitrogen/generated/android/kotlin/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransportSpec.kt` (generated by Task 1's nitrogen run — confirm the abstract signatures below match it before writing a line), `packages/react-native-localpay-transport/ios/BleGattProfile.swift` (Task 8; the wire constants must be byte-identical), `packages/expo-wallet-toolbox/core/localpay/transport/socket.ts` (the JS caller; `parseAck` expects base64 of the bare ack JSON), spec §2–§3 and §7–§8.

**Interfaces:**
- Consumes (generated by Task 1, package `com.margelo.nitro.localpaytransport`):
  ```kotlin
  abstract class HybridLocalPayBleTransportSpec : HybridObject() {
    abstract fun isSupported(): Boolean
    abstract fun bluetoothState(): String
    abstract fun nfcAvailable(): Boolean
    abstract fun prepare(timeoutMs: Double): Promise<String>
    abstract fun startListening(instanceName: String, pskBase64: String, onFrame: (frameBase64: String) -> Unit, onError: (message: String) -> Unit): Promise<Unit>
    abstract fun stopListening(): Promise<Unit>
    abstract fun confirmFrame(accepted: Boolean, reason: String): Promise<Unit>
    abstract fun sendFrame(instanceName: String, pskBase64: String, frameBase64: String, timeoutMs: Double, connectTimeoutMs: Double): Promise<String>
  }
  ```
  plus `com.margelo.nitro.NitroModules.applicationContext: Context?` and `com.margelo.nitro.core.Promise<T>` (`Promise<T>()`, `.resolve(value)`, `.reject(Throwable)`), exactly as `HybridLocalPayTransport.kt` uses them.
- Produces:
  ```kotlin
  object BleGattProfile {
    const val TAG = "LocalPayBle"
    val FRAME_CHAR_UUID: UUID; val ACK_CHAR_UUID: UUID; val CCCD_UUID: UUID
    const val TYPE_HELLO_A: Byte = 0x01; TYPE_HELLO_B = 0x02; TYPE_FRAME = 0x03; TYPE_ACK = 0x04
    const val MAX_BLE_FRAME_BYTES = 32768; LENGTH_PREFIX_BYTES = 4; MAC_BYTES = 32
    const val IDLE_CONNECTION_TIMEOUT_MS = 30_000L; PENDING_ACK_TIMEOUT_MS = 60_000L; MTU_NEGOTIATION_TIMEOUT_MS = 2_000L
    const val REQUESTED_MTU = 517; DEFAULT_ATT_MTU = 23; ATT_HEADER_BYTES = 3
    fun hmac(psk: ByteArray, vararg parts: ByteArray): ByteArray
    fun serviceUuid(psk: ByteArray, instanceName: String): UUID
    fun proof(psk: ByteArray, instanceName: String, type: Byte): ByteArray
    fun ackMac(psk: ByteArray, instanceName: String, ackJson: ByteArray): ByteArray
    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean
    fun helloA(psk: ByteArray, instanceName: String): ByteArray
    fun helloB(psk: ByteArray, instanceName: String): ByteArray
    fun frameMessage(sealed: ByteArray): ByteArray
    fun ackMessage(psk: ByteArray, instanceName: String, ackJson: ByteArray): ByteArray
    fun verifyAck(psk: ByteArray, instanceName: String, message: ByteArray): ByteArray?   // bare ackJson, or null
    fun ackJson(accepted: Boolean, reason: String): String
    fun jsonString(s: String): String
    fun lengthPrefixed(message: ByteArray): ByteArray
    fun chunkSize(mtu: Int): Int
    fun chunk(bytes: ByteArray, mtu: Int): ArrayDeque<ByteArray>
    class Reassembler { fun feed(chunk: ByteArray): List<ByteArray> /* throws IllegalArgumentException */ }
  }
  class HybridLocalPayBleTransport : HybridLocalPayBleTransportSpec()   // all eight methods above
  ```
- Known-answer vector shared with Task 8 (Swift) and any future JS test — psk = bytes `00 01 … 1f`, instanceName `"bsvpay-test"`:
  `serviceUuid = 7becac61-7070-45cf-95a5-314d9399c021`, `proof(HELLO_A) = 522519c14d7bec479e05717e68a3a4776c76b03dc88cda933272c6d7183a2089`, `proof(HELLO_B) = a635eb3a5ad34e27a525a7698627bdf01e1981da7f55d8868f7dcd4901530852`, `ackMac({"ok":true}) = abfa75aca5117e8f499ee2751e75afee50e4a0ace0510d96fabeadbc117559d3` (computed with Node `crypto.createHmac('sha256')` on 2026-09-02).

- [ ] **Step 1: Orient — confirm the generated spec and the Task 1 stub**

Run from the repo root:

```bash
cat packages/react-native-localpay-transport/nitrogen/generated/android/kotlin/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransportSpec.kt | grep -n 'abstract fun'
cat packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport.kt
sed -n 1,120p packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayTransport.kt
```

Expected: eight `abstract fun` lines with the signatures listed under **Interfaces** (`timeoutMs: Double`, callbacks typed `(frameBase64: String) -> Unit`). If `prepare` or `bluetoothState` is missing, Task 1's nitrogen run did not happen — stop and run `cd packages/react-native-localpay-transport && npx nitrogen` first. The stub's three probes are real (BLE hardware present / adapter power state / NFC enabled) and its five transport methods reject `"bluetooth unavailable"`; you will overwrite it whole in Step 6.

- [ ] **Step 2: Add the JUnit dependency; confirm the BLE feature flag**

Open `packages/react-native-localpay-transport/android/build.gradle`. In the `dependencies { ... }` block, immediately after the line `implementation 'com.google.android.gms:play-services-nearby:19.3.0'`, add:

```gradle
  // Plain-JVM unit tests for BleGattProfile (no android.* imports there on purpose).
  testImplementation 'junit:junit:4.13.2'
```

The `<uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />` line spec §8 asks for is already in `packages/react-native-localpay-transport/android/src/main/AndroidManifest.xml` — Task 1 Step 10 inserted it before `</manifest>`. Do not add a second one.

Verify: `grep -n 'bluetooth_le\|junit' packages/react-native-localpay-transport/android/src/main/AndroidManifest.xml packages/react-native-localpay-transport/android/build.gradle` prints exactly one line from each file.

- [ ] **Step 3: Write the failing JUnit test for the profile helpers**

Create `packages/react-native-localpay-transport/android/src/test/java/com/margelo/nitro/localpaytransport/BleGattProfileTest.kt`:

```kotlin
package com.margelo.nitro.localpaytransport

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.UUID

/**
 * Known-answer vectors for the bsvpay-ble/1 wire helpers. The same vectors
 * are the cross-platform check against ios/BleGattProfile.swift: psk is the
 * bytes 0x00..0x1f, instanceName "bsvpay-test".
 */
class BleGattProfileTest {
  private val psk = ByteArray(32) { it.toByte() }
  private val name = "bsvpay-test"

  private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

  @Test
  fun serviceUuidMatchesVectorWithRfc4122Bits() {
    assertEquals(
      UUID.fromString("7becac61-7070-45cf-95a5-314d9399c021"),
      BleGattProfile.serviceUuid(psk, name)
    )
  }

  @Test
  fun serviceUuidIsAlwaysVersion4Variant10() {
    for (i in 0 until 64) {
      val u = BleGattProfile.serviceUuid(ByteArray(32) { (i * 7 + it).toByte() }, "bsvpay-$i")
      assertEquals("version nibble for $i", 4, u.version())
      assertEquals("variant bits for $i", 2, u.variant())
    }
  }

  @Test
  fun proofsMatchVectors() {
    assertEquals(
      "522519c14d7bec479e05717e68a3a4776c76b03dc88cda933272c6d7183a2089",
      hex(BleGattProfile.proof(psk, name, BleGattProfile.TYPE_HELLO_A))
    )
    assertEquals(
      "a635eb3a5ad34e27a525a7698627bdf01e1981da7f55d8868f7dcd4901530852",
      hex(BleGattProfile.proof(psk, name, BleGattProfile.TYPE_HELLO_B))
    )
  }

  @Test
  fun helloMessagesAreTypeByteThenProof() {
    val a = BleGattProfile.helloA(psk, name)
    val b = BleGattProfile.helloB(psk, name)
    assertEquals(33, a.size)
    assertEquals(33, b.size)
    assertEquals(BleGattProfile.TYPE_HELLO_A, a[0])
    assertEquals(BleGattProfile.TYPE_HELLO_B, b[0])
    assertArrayEquals(BleGattProfile.proof(psk, name, BleGattProfile.TYPE_HELLO_A), a.copyOfRange(1, 33))
  }

  @Test
  fun frameMessageIsTypeByteThenSealedBytes() {
    val sealed = byteArrayOf(9, 8, 7)
    assertArrayEquals(byteArrayOf(BleGattProfile.TYPE_FRAME, 9, 8, 7), BleGattProfile.frameMessage(sealed))
  }

  @Test
  fun ackMessageRoundTripsAndDetectsTampering() {
    val json = BleGattProfile.ackJson(true, "").toByteArray(Charsets.UTF_8)
    val msg = BleGattProfile.ackMessage(psk, name, json)
    assertEquals(1 + json.size + BleGattProfile.MAC_BYTES, msg.size)
    assertEquals(BleGattProfile.TYPE_ACK, msg[0])
    assertEquals(
      "abfa75aca5117e8f499ee2751e75afee50e4a0ace0510d96fabeadbc117559d3",
      hex(msg.copyOfRange(msg.size - BleGattProfile.MAC_BYTES, msg.size))
    )
    assertArrayEquals(json, BleGattProfile.verifyAck(psk, name, msg))

    val flippedJson = msg.copyOf()
    flippedJson[3] = (flippedJson[3].toInt() xor 1).toByte()
    assertNull("tampered json must fail", BleGattProfile.verifyAck(psk, name, flippedJson))

    val flippedMac = msg.copyOf()
    flippedMac[msg.size - 1] = (flippedMac[msg.size - 1].toInt() xor 1).toByte()
    assertNull("tampered mac must fail", BleGattProfile.verifyAck(psk, name, flippedMac))

    assertNull("truncated message must fail", BleGattProfile.verifyAck(psk, name, msg.copyOfRange(0, 20)))
    assertNull("wrong psk must fail", BleGattProfile.verifyAck(ByteArray(32) { 0x7f }, name, msg))
    assertNull("wrong type byte must fail", BleGattProfile.verifyAck(psk, name, byteArrayOf(BleGattProfile.TYPE_FRAME) + msg.copyOfRange(1, msg.size)))
  }

  @Test
  fun ackJsonMatchesTheOtherBackendsByteForByte() {
    assertEquals("{\"ok\":true}", BleGattProfile.ackJson(true, "ignored"))
    assertEquals("{\"ok\":false,\"error\":\"declined\"}", BleGattProfile.ackJson(false, ""))
    assertEquals("{\"ok\":false,\"error\":\"already_paid\"}", BleGattProfile.ackJson(false, "already_paid"))
    assertEquals(
      "{\"ok\":false,\"error\":\"a \\\"b\\\"\\\\\\n\"}",
      BleGattProfile.ackJson(false, "a \"b\"\\\n")
    )
    assertEquals("\"\\u0001\"", BleGattProfile.jsonString("\u0001"))
  }

  @Test
  fun lengthPrefixIsBigEndianU32() {
    val body = ByteArray(0x010203) { 1 }
    val framed = BleGattProfile.lengthPrefixed(body)
    assertEquals(4 + 0x010203, framed.size)
    assertEquals(0, framed[0].toInt())
    assertEquals(1, framed[1].toInt())
    assertEquals(2, framed[2].toInt())
    assertEquals(3, framed[3].toInt())
    assertEquals(1, framed[4].toInt())
  }

  @Test
  fun chunksNeverExceedMtuMinusThree() {
    assertEquals(20, BleGattProfile.chunkSize(23))
    assertEquals(514, BleGattProfile.chunkSize(517))
    assertEquals(1, BleGattProfile.chunkSize(0))
    val framed = BleGattProfile.lengthPrefixed(ByteArray(1000) { it.toByte() })
    val small = BleGattProfile.chunk(framed, 23)
    assertTrue(small.all { it.size <= 20 })
    assertEquals(20, small.first().size)
    assertEquals(1004, small.sumOf { it.size })
    val large = BleGattProfile.chunk(framed, 517)
    assertEquals(2, large.size)
    assertEquals(514, large.first().size)
    assertEquals(490, large.last().size)
  }

  @Test
  fun reassemblerRebuildsAcrossChunkBoundaries() {
    val message = ByteArray(5000) { (it * 3).toByte() }
    val r = BleGattProfile.Reassembler()
    val out = mutableListOf<ByteArray>()
    for (c in BleGattProfile.chunk(BleGattProfile.lengthPrefixed(message), 23)) out += r.feed(c)
    assertEquals(1, out.size)
    assertArrayEquals(message, out[0])

    val a = byteArrayOf(1, 2, 3)
    val b = byteArrayOf(4)
    val both = r.feed(BleGattProfile.lengthPrefixed(a) + BleGattProfile.lengthPrefixed(b))
    assertEquals(2, both.size)
    assertArrayEquals(a, both[0])
    assertArrayEquals(b, both[1])
  }

  @Test
  fun reassemblerRejectsOversizeAndZeroLength() {
    try {
      BleGattProfile.Reassembler().feed(BleGattProfile.lengthPrefixed(ByteArray(BleGattProfile.MAX_BLE_FRAME_BYTES + 1)))
      fail("expected IllegalArgumentException for 32769 bytes")
    } catch (e: IllegalArgumentException) {
      assertTrue(e.message!!.contains("32769"))
    }
    try {
      BleGattProfile.Reassembler().feed(byteArrayOf(0, 0, 0, 0))
      fail("expected IllegalArgumentException for a zero-length message")
    } catch (e: IllegalArgumentException) {
      // expected
    }
    // Exactly the ceiling is accepted: only the header is fed, so nothing completes and nothing throws.
    val atCap = BleGattProfile.Reassembler().feed(byteArrayOf(0, 0, 0x80.toByte(), 0))
    assertEquals(0, atCap.size)
  }
}
```

- [ ] **Step 4: Run the test and watch it fail on the missing object**

Task 1 established that Android compiles only through a prebuilt app project (`android/` is gitignored at the repo root and regenerated on demand, so nothing under it ever shows in `git status` or gets committed). From the repo root:

```bash
npx expo prebuild --platform android
cd android && ./gradlew :react-native-localpay-transport:testDebugUnitTest --console=plain 2>&1 | tail -40
```

Expected output contains

```
e: file:///.../packages/react-native-localpay-transport/android/src/test/java/com/margelo/nitro/localpaytransport/BleGattProfileTest.kt:... Unresolved reference 'BleGattProfile'.
...
BUILD FAILED
```

(If Gradle instead reports `Project 'react-native-localpay-transport' not found`, run `./gradlew projects --console=plain | grep -i localpay` and use the name it prints — Expo autolinking names the module after its npm package name, the same way `project(':react-native-nitro-modules')` is referenced in the module's own `build.gradle`.)

- [ ] **Step 5: Create `BleGattProfile.kt`**

Create `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/BleGattProfile.kt`. It is deliberately free of `android.*` imports so Step 4's JUnit run exercises it on the plain JVM; `org.json` is avoided for the same reason (its Android stub returns null under unit tests).

```kotlin
package com.margelo.nitro.localpaytransport

import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Wire constants and pure helpers for the `bsvpay-ble/1` GATT profile
 * (design §2 profile, §3 messages and framing).
 *
 * Byte-for-byte identical to ios/BleGattProfile.swift. A change here without
 * the same change there breaks Android↔iOS, which is the whole reason this
 * rung exists. Pure JVM on purpose — no android.* imports — so
 * BleGattProfileTest runs under plain JUnit without an emulator.
 */
object BleGattProfile {
  /** Logcat tag; the hardware checklist greps for it. Same tag as the Swift os_log category. */
  const val TAG = "LocalPayBle"

  /** Fixed characteristic UUIDs; only the service UUID is per-session (§2). Suffix 425356504159 = ASCII "BSVPAY". */
  val FRAME_CHAR_UUID: UUID = UUID.fromString("B5A1E001-7374-4F6E-8E2D-425356504159")
  val ACK_CHAR_UUID: UUID = UUID.fromString("B5A1E002-7374-4F6E-8E2D-425356504159")
  /** Client Characteristic Configuration descriptor — Bluetooth SIG assigned number 0x2902. */
  val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

  const val TYPE_HELLO_A: Byte = 0x01
  const val TYPE_HELLO_B: Byte = 0x02
  const val TYPE_FRAME: Byte = 0x03
  const val TYPE_ACK: Byte = 0x04

  /** `type ‖ body` ceiling, same as Nearby's MAX_BYTES_PAYLOAD (§3). */
  const val MAX_BLE_FRAME_BYTES = 32768
  const val LENGTH_PREFIX_BYTES = 4
  const val MAC_BYTES = 32
  const val IDLE_CONNECTION_TIMEOUT_MS = 30_000L
  const val PENDING_ACK_TIMEOUT_MS = 60_000L
  const val MTU_NEGOTIATION_TIMEOUT_MS = 2_000L
  const val REQUESTED_MTU = 517
  const val DEFAULT_ATT_MTU = 23
  /** ATT opcode (1 byte) + attribute handle (2 bytes) precede every write / indication payload. */
  const val ATT_HEADER_BYTES = 3

  private const val SERVICE_LABEL = "bsvpay-ble-svc"
  private val UTF8 = Charsets.UTF_8

  // ── crypto ──

  fun hmac(psk: ByteArray, vararg parts: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(psk, "HmacSHA256"))
    for (part in parts) mac.update(part)
    return mac.doFinal()
  }

  /**
   * HMAC-SHA256(psk, "bsvpay-ble-svc" ‖ utf8(instanceName)) truncated to 16
   * bytes, then forced to RFC-4122 version 4 / variant 10 so both platforms
   * (and Android's exact-match ScanFilter) agree on every bit (§2).
   */
  fun serviceUuid(psk: ByteArray, instanceName: String): UUID {
    val digest = hmac(psk, SERVICE_LABEL.toByteArray(UTF8), instanceName.toByteArray(UTF8))
    val b = digest.copyOfRange(0, 16)
    b[6] = ((b[6].toInt() and 0x0F) or 0x40).toByte()
    b[8] = ((b[8].toInt() and 0x3F) or 0x80).toByte()
    val bb = ByteBuffer.wrap(b)
    return UUID(bb.long, bb.long)
  }

  /** HMAC-SHA256(psk, utf8(instanceName) ‖ [type]) — the HELLO proof each way (§3 table). */
  fun proof(psk: ByteArray, instanceName: String, type: Byte): ByteArray =
    hmac(psk, instanceName.toByteArray(UTF8), byteArrayOf(type))

  /** HMAC-SHA256(psk, utf8(instanceName) ‖ [0x04] ‖ ackJson) — what makes a forged ack impossible without the PSK (§3). */
  fun ackMac(psk: ByteArray, instanceName: String, ackJson: ByteArray): ByteArray =
    hmac(psk, instanceName.toByteArray(UTF8), byteArrayOf(TYPE_ACK), ackJson)

  fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

  // ── messages (type byte ‖ body) ──

  fun helloA(psk: ByteArray, instanceName: String): ByteArray =
    byteArrayOf(TYPE_HELLO_A) + proof(psk, instanceName, TYPE_HELLO_A)

  fun helloB(psk: ByteArray, instanceName: String): ByteArray =
    byteArrayOf(TYPE_HELLO_B) + proof(psk, instanceName, TYPE_HELLO_B)

  fun frameMessage(sealed: ByteArray): ByteArray = byteArrayOf(TYPE_FRAME) + sealed

  fun ackMessage(psk: ByteArray, instanceName: String, ackJson: ByteArray): ByteArray =
    byteArrayOf(TYPE_ACK) + ackJson + ackMac(psk, instanceName, ackJson)

  /**
   * Payer side: checks the type byte, splits off the trailing 32-byte MAC,
   * verifies it in constant time and returns the bare ackJson (which JS's
   * parseAck expects), or null when anything is off.
   */
  fun verifyAck(psk: ByteArray, instanceName: String, message: ByteArray): ByteArray? {
    if (message.isEmpty() || message[0] != TYPE_ACK) return null
    if (message.size < 1 + MAC_BYTES) return null
    val json = message.copyOfRange(1, message.size - MAC_BYTES)
    val mac = message.copyOfRange(message.size - MAC_BYTES, message.size)
    return if (constantTimeEquals(mac, ackMac(psk, instanceName, json))) json else null
  }

  /**
   * Byte-identical to the AWDL/Nearby acks: {"ok":true} or
   * {"ok":false,"error":<reason>} with the reason JSON-serialized, never
   * interpolated (a raw quote would make the payer's JSON.parse throw and
   * turn a clean decline into an AckError). Empty reason → "declined",
   * matching Swift's declineJson fallback.
   */
  fun ackJson(accepted: Boolean, reason: String): String =
    if (accepted) "{\"ok\":true}"
    else "{\"ok\":false,\"error\":${jsonString(if (reason.isEmpty()) "declined" else reason)}}"

  /** Minimal, complete JSON string serializer (RFC 8259 §7): quotes, backslash and all control characters escaped. */
  fun jsonString(s: String): String {
    val sb = StringBuilder(s.length + 2)
    sb.append('"')
    for (ch in s) {
      when (ch) {
        '"' -> sb.append("\\\"")
        '\\' -> sb.append("\\\\")
        '\n' -> sb.append("\\n")
        '\r' -> sb.append("\\r")
        '\t' -> sb.append("\\t")
        '\b' -> sb.append("\\b")
        '\u000C' -> sb.append("\\f")
        else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
      }
    }
    sb.append('"')
    return sb.toString()
  }

  // ── framing: [u32 BE length][message], chunked to ATT_MTU − 3 (§3) ──

  fun lengthPrefixed(message: ByteArray): ByteArray {
    val n = message.size
    val out = ByteArray(LENGTH_PREFIX_BYTES + n)
    out[0] = (n ushr 24).toByte()
    out[1] = (n ushr 16).toByte()
    out[2] = (n ushr 8).toByte()
    out[3] = n.toByte()
    System.arraycopy(message, 0, out, LENGTH_PREFIX_BYTES, n)
    return out
  }

  fun chunkSize(mtu: Int): Int = maxOf(1, mtu - ATT_HEADER_BYTES)

  fun chunk(bytes: ByteArray, mtu: Int): ArrayDeque<ByteArray> {
    val size = chunkSize(mtu)
    val out = ArrayDeque<ByteArray>()
    var i = 0
    while (i < bytes.size) {
      val end = minOf(bytes.size, i + size)
      out.addLast(bytes.copyOfRange(i, end))
      i = end
    }
    return out
  }

  /**
   * Rebuilds `[u32 BE length][message]` streams from arbitrary chunking.
   * One instance per connection per direction. The buffer is allocated at
   * the declared length, so it can never hold more than
   * MAX_BLE_FRAME_BYTES + 4 bytes: an oversize or zero declared length
   * throws IllegalArgumentException and the caller drops the connection.
   */
  class Reassembler {
    private val header = ByteArray(LENGTH_PREFIX_BYTES)
    private var headerFilled = 0
    private var body: ByteArray? = null
    private var bodyFilled = 0

    fun feed(chunk: ByteArray): List<ByteArray> {
      val done = mutableListOf<ByteArray>()
      var i = 0
      while (i < chunk.size) {
        val current = body
        if (current == null) {
          header[headerFilled++] = chunk[i++]
          if (headerFilled == LENGTH_PREFIX_BYTES) {
            val declared = ((header[0].toInt() and 0xff) shl 24) or
              ((header[1].toInt() and 0xff) shl 16) or
              ((header[2].toInt() and 0xff) shl 8) or
              (header[3].toInt() and 0xff)
            if (declared <= 0 || declared > MAX_BLE_FRAME_BYTES) {
              throw IllegalArgumentException("declared message length $declared outside 1..$MAX_BLE_FRAME_BYTES")
            }
            body = ByteArray(declared)
            bodyFilled = 0
          }
        } else {
          val n = minOf(chunk.size - i, current.size - bodyFilled)
          System.arraycopy(chunk, i, current, bodyFilled, n)
          bodyFilled += n
          i += n
          if (bodyFilled == current.size) {
            done += current
            body = null
            headerFilled = 0
          }
        }
      }
      return done
    }
  }
}
```

Run the tests again:

```bash
cd android && ./gradlew :react-native-localpay-transport:testDebugUnitTest --console=plain 2>&1 | tail -15
```

Expected: `BUILD SUCCESSFUL`. Confirm all eleven tests ran: `grep -o 'tests="[0-9]*"' packages/react-native-localpay-transport/android/build/test-results/testDebugUnitTest/TEST-com.margelo.nitro.localpaytransport.BleGattProfileTest.xml` prints `tests="11"` and the same file contains `failures="0"`.

- [ ] **Step 6: Replace the stub with the full `HybridLocalPayBleTransport.kt`**

Overwrite `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport.kt` with the complete file below. Non-obvious choices, with spec references, are in the comments; the ones worth knowing before reading: every GATT callback arrives on a binder thread and is `main.post`ed (§3 "confined to … the main Handler"); MTU negotiation completes (or times out at 2 s) *before* `discoverServices()` (§3 central step 3, the March `mDeviceBusy` deadlock); the next FRAME chunk is written only after `onCharacteristicWrite` (§3 step 6); `Context.checkSelfPermission` is the framework method `ContextCompat` wraps on API ≥ 23 and minSdk is 24, so no new Gradle dependency is needed; Android cannot set a per-app advertised local name without renaming the adapter, and the profile marks `localName` advisory (§2), so Android advertises the service UUID alone.

```kotlin
package com.margelo.nitro.localpaytransport

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.nfc.NfcAdapter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import com.margelo.nitro.localpaytransport.BleGattProfile.ACK_CHAR_UUID
import com.margelo.nitro.localpaytransport.BleGattProfile.CCCD_UUID
import com.margelo.nitro.localpaytransport.BleGattProfile.DEFAULT_ATT_MTU
import com.margelo.nitro.localpaytransport.BleGattProfile.FRAME_CHAR_UUID
import com.margelo.nitro.localpaytransport.BleGattProfile.IDLE_CONNECTION_TIMEOUT_MS
import com.margelo.nitro.localpaytransport.BleGattProfile.MAX_BLE_FRAME_BYTES
import com.margelo.nitro.localpaytransport.BleGattProfile.MTU_NEGOTIATION_TIMEOUT_MS
import com.margelo.nitro.localpaytransport.BleGattProfile.PENDING_ACK_TIMEOUT_MS
import com.margelo.nitro.localpaytransport.BleGattProfile.REQUESTED_MTU
import com.margelo.nitro.localpaytransport.BleGattProfile.TAG
import com.margelo.nitro.localpaytransport.BleGattProfile.TYPE_ACK
import com.margelo.nitro.localpaytransport.BleGattProfile.TYPE_FRAME
import com.margelo.nitro.localpaytransport.BleGattProfile.TYPE_HELLO_A
import com.margelo.nitro.localpaytransport.BleGattProfile.TYPE_HELLO_B
import java.util.UUID

/**
 * LocalPayBleTransport over android.bluetooth GATT — the `bsvpay-ble/1`
 * profile (design §2–§3). Payee = GATT peripheral (advertises the
 * session-derived service UUID, receives HELLO_A/FRAME on the FRAME
 * characteristic, answers HELLO_B/ACK as indications). Payer = GATT central
 * (scan-filters to exactly that UUID, connects, negotiates MTU, subscribes,
 * writes HELLO_A then FRAME, waits for the HMAC'd ACK).
 *
 * Structurally a mirror of HybridLocalPayTransport (Nearby): all mutable
 * state is confined to the main-thread Handler — every BluetoothGatt*Callback
 * arrives on a binder thread and is hopped onto `main` — `hasAccepted` is the
 * payee's first-success-wins latch, `boundDevice` is set only after a
 * verified HELLO_A, `pendingAckDevice` is the one link held open for
 * confirmFrame, and the idle/ack reapers check their own identity before
 * acting. Trust is entirely in the message-layer HMACs: GATT without bonding
 * has no link security, and the ACK carries its own MAC so a UUID-sniffing
 * impostor cannot forge {"ok":true} (§3).
 *
 * The same structurally-unclosable stopListening-vs-in-flight-ack race the
 * Nearby class documents applies here (an indication in flight when JS calls
 * stopListening), and the same JS discipline in core/localpay/transport/
 * socket.ts (never stopListening on a path that still holds a confirm handle)
 * is what keeps it unreachable.
 */
@Suppress("DEPRECATION")
@SuppressLint("MissingPermission") // every android.bluetooth call sits behind canConnect()/canScan()/canAdvertise()
class HybridLocalPayBleTransport : HybridLocalPayBleTransportSpec() {
  private val main = Handler(Looper.getMainLooper())

  private fun context(): Context? = NitroModules.applicationContext

  private fun manager(): BluetoothManager? =
    context()?.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

  private fun adapter(): BluetoothAdapter? = manager()?.adapter

  private fun hasBleHardware(): Boolean =
    context()?.packageManager?.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) == true

  // ── permissions (§7: JS requests them first; native only refuses) ──

  private fun granted(permission: String): Boolean =
    context()?.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  private fun canConnect(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.S || granted(Manifest.permission.BLUETOOTH_CONNECT)

  private fun canScan(): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) granted(Manifest.permission.BLUETOOTH_SCAN) && canConnect()
    else granted(Manifest.permission.ACCESS_FINE_LOCATION)

  private fun canAdvertise(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
      (granted(Manifest.permission.BLUETOOTH_ADVERTISE) && canConnect())

  // ── prompt-free probes ──

  /**
   * BLE hardware present and the radio switched on. Deliberately permission-
   * independent: the ladder must be able to pick BLE before the first grant
   * (§7). Power IS included — BluetoothAdapter.isEnabled is prompt-free — so a
   * payer whose radio is off floors to QR with the local_bt_off copy (§5)
   * instead of burning a 6 s connect budget that cannot succeed. The Swift
   * backend does the same once a manager has reported poweredOff.
   */
  override fun isSupported(): Boolean {
    val a = adapter() ?: return false
    return hasBleHardware() && a.isEnabled
  }

  override fun bluetoothState(): String {
    val a = adapter() ?: return "unsupported"
    if (!hasBleHardware()) return "unsupported"
    if (!(canScan() && canConnect() && canAdvertise())) return "unauthorized"
    return when (a.state) {
      BluetoothAdapter.STATE_ON -> "poweredOn"
      BluetoothAdapter.STATE_OFF -> "poweredOff"
      else -> "unknown" // STATE_TURNING_ON / STATE_TURNING_OFF
    }
  }

  override fun nfcAvailable(): Boolean {
    val ctx = context() ?: return false
    return try {
      NfcAdapter.getDefaultAdapter(ctx)?.isEnabled == true
    } catch (e: Exception) {
      false
    }
  }

  /**
   * Android has no async manager bring-up to wait for, so this resolves as
   * soon as the adapter is in a settled state (polling through
   * TURNING_ON/OFF until timeoutMs), opening the GATT server when powered on
   * so startListening has one fewer thing to fail on. Idempotent.
   */
  override fun prepare(timeoutMs: Double): Promise<String> {
    val promise = Promise<String>()
    main.post {
      val deadline = SystemClock.elapsedRealtime() + timeoutMs.toLong()
      lateinit var poll: Runnable
      poll = Runnable {
        val state = bluetoothState()
        if (state != "unknown" || SystemClock.elapsedRealtime() >= deadline) {
          if (state == "poweredOn") ensureGattServer()
          Log.d(TAG, "prepare: $state")
          promise.resolve(state)
        } else {
          main.postDelayed(poll, PREPARE_POLL_MS)
        }
      }
      poll.run()
    }
    return promise
  }

  // ── payee (peripheral) state — main thread only ──

  private class Central(val device: BluetoothDevice) {
    val reassembler = BleGattProfile.Reassembler()
    var subscribed = false
    var mtu = DEFAULT_ATT_MTU
  }

  private class IndicationJob(
    val device: BluetoothDevice,
    val chunks: ArrayDeque<ByteArray>,
    val onDone: (Boolean) -> Unit
  )

  private var gattServer: BluetoothGattServer? = null
  private var service: BluetoothGattService? = null
  private var ackCharacteristic: BluetoothGattCharacteristic? = null
  private var advertising = false
  private var listening = false
  private var listenPsk: ByteArray? = null
  private var listenName: String? = null
  private var listenOnFrame: ((String) -> Unit)? = null
  private var listenOnError: ((String) -> Unit)? = null
  /** Resolved by AdvertiseCallback.onStartSuccess, rejected by any failure before it. */
  private var startPromise: Promise<Unit>? = null
  private var listenStartedAt = 0L
  /** Every connected central, keyed by MAC address. */
  private val centrals = mutableMapOf<String, Central>()
  /** Central whose HELLO_A verified. Only its FRAME is deliverable. */
  private var boundDevice: BluetoothDevice? = null
  /** Central holding an undelivered ack — the one confirmFrame answers. */
  private var pendingAckDevice: BluetoothDevice? = null
  /** First-success-wins latch; see HybridLocalPayTransport.hasAccepted. */
  private var hasAccepted = false
  private val idleReapers = mutableMapOf<String, Runnable>()
  private var ackReaper: Runnable? = null
  /** Indications are serialized: one chunk in flight per server, next chunk only after onNotificationSent (§3 framing). */
  private val indicationJobs = ArrayDeque<IndicationJob>()
  private var indicationInFlight: IndicationJob? = null

  private fun ensureGattServer(): BluetoothGattServer? {
    gattServer?.let { return it }
    val ctx = context() ?: return null
    if (!canConnect()) return null
    val server = manager()?.openGattServer(ctx, serverCallback) ?: return null
    gattServer = server
    watchAdapter()
    return server
  }

  /**
   * Bluetooth switched off under a live listener. Android delivers no GATT
   * callback for that, so without this the BLE rung would sit dead until the
   * screen's own abort while JS still showed it as listening. Mirrors the
   * Swift backend's peripheralManagerDidUpdateState → onError("bluetooth
   * unavailable"). A BluetoothGattServer opened before the adapter went off is
   * stale afterwards, so it is closed here and reopened lazily by the next
   * prepare()/startListening().
   */
  private var adapterReceiver: BroadcastReceiver? = null

  private fun watchAdapter() {
    if (adapterReceiver != null) return
    val ctx = context() ?: return
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(c: Context?, intent: Intent?) {
        if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
        val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
        if (state != BluetoothAdapter.STATE_OFF && state != BluetoothAdapter.STATE_TURNING_OFF) return
        main.post { onAdapterOff() }
      }
    }
    // ACTION_STATE_CHANGED is a protected system broadcast, so the API 33+
    // RECEIVER_EXPORTED / RECEIVER_NOT_EXPORTED flag requirement does not apply.
    ctx.registerReceiver(receiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED))
    adapterReceiver = receiver
  }

  /** Runs on main. */
  private fun onAdapterOff() {
    val wasListening = listening
    val onError = listenOnError
    val pendingStart = startPromise
    startPromise = null
    resetSession(null)
    try {
      gattServer?.close()
    } catch (e: Exception) {
      // Already gone with the adapter.
    }
    gattServer = null
    if (!wasListening) return
    Log.d(TAG, "payee: bluetooth turned off under a live listener")
    if (pendingStart != null) pendingStart.reject(Error("bluetooth unavailable")) else onError?.invoke("bluetooth unavailable")
  }

  /** Same shape and identity check as HybridLocalPayTransport.armIdleReaper, but silent for EVERY central (spec §3 step 3; the Swift BLE backend is silent here too). */
  private fun armIdleReaper(device: BluetoothDevice) {
    val address = device.address
    cancelIdleReaper(address)
    lateinit var reaper: Runnable
    reaper = Runnable {
      if (idleReapers[address] !== reaper) return@Runnable
      idleReapers.remove(address)
      Log.d(TAG, "payee: idle reaper dropped $address")
      dropCentral(device)
      // Silent on the wire and to JS (spec §3 step 3): a central that never
      // finished — stranger or PSK-holder — is not a failed payment, and
      // reporting it would kill a BLE listener another payer can still use.
      // Unbind so a fresh HELLO_A can bind.
      if (address == boundDevice?.address && !hasAccepted) boundDevice = null
    }
    idleReapers[address] = reaper
    main.postDelayed(reaper, IDLE_CONNECTION_TIMEOUT_MS)
  }

  private fun cancelIdleReaper(address: String) {
    idleReapers.remove(address)?.let { main.removeCallbacks(it) }
  }

  /** Expiry is silent on the wire — never a synthesised ack (spec §3 peripheral step 7, §9 invariant 3). */
  private fun armAckReaper(device: BluetoothDevice) {
    ackReaper?.let { main.removeCallbacks(it) }
    val reaper = Runnable {
      ackReaper = null
      pendingAckDevice = null
      Log.d(TAG, "payee: ack reaper fired; releasing ${device.address}")
      dropCentral(device)
      listenOnError?.invoke("payee never confirmed the payment; connection released")
    }
    ackReaper = reaper
    main.postDelayed(reaper, PENDING_ACK_TIMEOUT_MS)
  }

  private fun cancelAckReaper() {
    ackReaper?.let { main.removeCallbacks(it) }
    ackReaper = null
  }

  /** Forget a central and cut its link. Any indication queued for it fails (onDone(false)). */
  private fun dropCentral(device: BluetoothDevice) {
    cancelIdleReaper(device.address)
    centrals.remove(device.address)
    failIndicationsFor(device)
    gattServer?.cancelConnection(device)
  }

  private fun failIndicationsFor(device: BluetoothDevice) {
    val orphaned = indicationJobs.filter { it.device.address == device.address }
    indicationJobs.removeAll(orphaned)
    orphaned.forEach { it.onDone(false) }
    val inFlight = indicationInFlight
    if (inFlight != null && inFlight.device.address == device.address) {
      indicationInFlight = null
      inFlight.onDone(false)
      pumpIndications()
    }
  }

  private fun sendIndication(central: Central, message: ByteArray, onDone: (Boolean) -> Unit) {
    val chunks = BleGattProfile.chunk(BleGattProfile.lengthPrefixed(message), central.mtu)
    indicationJobs.addLast(IndicationJob(central.device, chunks, onDone))
    pumpIndications()
  }

  private fun pumpIndications() {
    if (indicationInFlight != null) return
    val job = indicationJobs.removeFirstOrNull() ?: return
    val first = job.chunks.removeFirstOrNull()
    if (first == null) {
      job.onDone(true)
      pumpIndications()
      return
    }
    indicationInFlight = job
    if (!notifyChunk(job.device, first)) {
      indicationInFlight = null
      job.onDone(false)
      pumpIndications()
    }
  }

  /** Runs on main from onNotificationSent: advance the in-flight job by one chunk. */
  private fun onIndicationResult(device: BluetoothDevice, status: Int) {
    val job = indicationInFlight ?: return
    if (job.device.address != device.address) return
    if (status != BluetoothGatt.GATT_SUCCESS) {
      indicationInFlight = null
      job.onDone(false)
      pumpIndications()
      return
    }
    val next = job.chunks.removeFirstOrNull()
    if (next == null) {
      indicationInFlight = null
      job.onDone(true)
      pumpIndications()
      return
    }
    if (!notifyChunk(job.device, next)) {
      indicationInFlight = null
      job.onDone(false)
      pumpIndications()
    }
  }

  /** confirm = true → indication (ATT-acknowledged), which is what the ACK characteristic declares (§2). */
  private fun notifyChunk(device: BluetoothDevice, chunk: ByteArray): Boolean {
    val server = gattServer ?: return false
    val characteristic = ackCharacteristic ?: return false
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        server.notifyCharacteristicChanged(device, characteristic, true, chunk) == BluetoothStatusCodes.SUCCESS
      } else {
        characteristic.value = chunk
        server.notifyCharacteristicChanged(device, characteristic, true)
      }
    } catch (e: Exception) {
      Log.d(TAG, "payee: notifyCharacteristicChanged threw: ${e.message}")
      false
    }
  }

  /** Runs on main. Mirrors HybridLocalPayTransport.payeePayloads.onPayloadReceived one type byte at a time (§3 peripheral steps 4–5). */
  private fun handleCentralMessage(central: Central, message: ByteArray) {
    val psk = listenPsk ?: return
    val name = listenName ?: return
    val device = central.device
    if (message.isEmpty()) {
      dropCentral(device)
      return
    }
    when (message[0]) {
      TYPE_HELLO_A -> {
        val proof = message.copyOfRange(1, message.size)
        if (!BleGattProfile.constantTimeEquals(proof, BleGattProfile.proof(psk, name, TYPE_HELLO_A))) {
          // Silent: a stranger must not be able to kill a live request. Advertising continues.
          Log.d(TAG, "payee: HELLO_A proof failed from ${device.address}; dropping")
          dropCentral(device)
          return
        }
        if (!central.subscribed) {
          // Indications cannot be delivered without a CCCD subscription; the profile subscribes before HELLO_A (§3 central step 4).
          Log.d(TAG, "payee: HELLO_A verified but ${device.address} never subscribed to ACK; dropping")
          dropCentral(device)
          return
        }
        boundDevice = device
        Log.d(TAG, "payee: HELLO_A verified from ${device.address} at ${SystemClock.elapsedRealtime() - listenStartedAt} ms; sending HELLO_B")
        sendIndication(central, BleGattProfile.helloB(psk, name)) { ok ->
          if (!ok) {
            Log.d(TAG, "payee: HELLO_B indication failed to ${device.address}")
            dropCentral(device)
            if (boundDevice?.address == device.address) boundDevice = null
            listenOnError?.invoke("failed to reply to peer: indication not delivered")
          }
        }
      }
      TYPE_FRAME -> {
        if (device.address != boundDevice?.address) {
          dropCentral(device)
          return
        }
        if (hasAccepted) {
          // First-success-wins: a second PSK-holder reaching FRAME is refused outright, not raced (§9 invariant 4).
          dropCentral(device)
          return
        }
        cancelIdleReaper(device.address)
        hasAccepted = true
        pendingAckDevice = device
        stopAdvertising()
        armAckReaper(device)
        val sealed = message.copyOfRange(1, message.size)
        Log.d(TAG, "payee: frame accepted (${sealed.size} bytes, mtu ${central.mtu}) from ${device.address} at ${SystemClock.elapsedRealtime() - listenStartedAt} ms; advertising stopped")
        listenOnFrame?.invoke(Base64.encodeToString(sealed, Base64.NO_WRAP))
      }
      else -> dropCentral(device)
    }
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      main.post {
        when (newState) {
          BluetoothProfile.STATE_CONNECTED -> {
            if (!listening) return@post
            Log.d(TAG, "payee: central connected ${device.address} (status $status)")
            centrals[device.address] = Central(device)
            armIdleReaper(device)
          }
          BluetoothProfile.STATE_DISCONNECTED -> {
            Log.d(TAG, "payee: central disconnected ${device.address} (status $status)")
            cancelIdleReaper(device.address)
            centrals.remove(device.address)
            failIndicationsFor(device)
            if (device.address == boundDevice?.address && pendingAckDevice == null && !hasAccepted) {
              boundDevice = null
            }
          }
        }
      }
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      main.post {
        centrals[device.address]?.mtu = mtu
        Log.d(TAG, "payee: mtu $mtu for ${device.address}")
      }
    }

    override fun onServiceAdded(status: Int, addedService: BluetoothGattService) {
      main.post {
        if (addedService.uuid != service?.uuid) return@post
        if (status != BluetoothGatt.GATT_SUCCESS) {
          failStart("bluetooth unavailable: could not add GATT service (status $status)")
          return@post
        }
        Log.d(TAG, "payee: service added ${addedService.uuid}; starting advertising")
        startAdvertising(addedService.uuid)
      }
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?
    ) {
      main.post {
        if (responseNeeded) {
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
        }
        if (characteristic.uuid != FRAME_CHAR_UUID || !listening) return@post
        // A write can outrun our main-thread bookkeeping of the CONNECTED event; register the central lazily.
        val central = centrals.getOrPut(device.address) {
          armIdleReaper(device)
          Central(device)
        }
        if (preparedWrite || value == null) {
          // The profile never uses long (prepared) writes: chunks are ≤ MTU − 3 by construction (§3).
          dropCentral(device)
          return@post
        }
        val messages = try {
          central.reassembler.feed(value)
        } catch (e: IllegalArgumentException) {
          Log.d(TAG, "payee: bad framing from ${device.address}: ${e.message}; dropping")
          dropCentral(device)
          return@post
        }
        for (message in messages) handleCentralMessage(central, message)
      }
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?
    ) {
      main.post {
        if (responseNeeded) {
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
        }
        if (descriptor.uuid != CCCD_UUID || descriptor.characteristic.uuid != ACK_CHAR_UUID || !listening) return@post
        val central = centrals.getOrPut(device.address) {
          armIdleReaper(device)
          Central(device)
        }
        // 0x01 = notifications, 0x02 = indications; iOS setNotifyValue(true) writes 0x02 for an indicate-only characteristic.
        central.subscribed = value != null && value.isNotEmpty() && (value[0].toInt() and 0x03) != 0
        Log.d(TAG, "payee: ${device.address} ${if (central.subscribed) "subscribed to" else "unsubscribed from"} ACK")
      }
    }

    override fun onDescriptorReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      descriptor: BluetoothGattDescriptor
    ) {
      main.post {
        val subscribed = centrals[device.address]?.subscribed == true
        val current = if (subscribed) BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
        else BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, current)
      }
    }

    override fun onCharacteristicReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      characteristic: BluetoothGattCharacteristic
    ) {
      // ACK is indicate-only; a read (iOS does one occasionally after subscribing) gets an empty value.
      main.post {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, ByteArray(0))
      }
    }

    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      main.post { onIndicationResult(device, status) }
    }
  }

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
      main.post {
        advertising = true
        Log.d(TAG, "payee: advertising ${service?.uuid} (${SystemClock.elapsedRealtime() - listenStartedAt} ms after startListening)")
        startPromise?.resolve(Unit)
        startPromise = null
      }
    }

    override fun onStartFailure(errorCode: Int) {
      main.post {
        advertising = false
        failStart("advertising failed: code $errorCode")
      }
    }
  }

  private fun startAdvertising(uuid: UUID) {
    val advertiser = adapter()?.bluetoothLeAdvertiser
    if (advertiser == null || !canAdvertise()) {
      failStart("bluetooth unavailable")
      return
    }
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(true)
      .setTimeout(0)
      .build()
    // A 128-bit UUID takes 18 of the 31 legacy-advertisement bytes; the device
    // name would overflow it (ADVERTISE_FAILED_DATA_TOO_LARGE). localName is
    // advisory in the profile (§2) and Android cannot set a per-app name
    // without renaming the adapter, so the UUID goes alone.
    val data = AdvertiseData.Builder()
      .addServiceUuid(ParcelUuid(uuid))
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .build()
    try {
      advertiser.startAdvertising(settings, data, advertiseCallback)
    } catch (e: Exception) {
      failStart("advertising failed: ${e.message}")
    }
  }

  private fun stopAdvertising() {
    advertising = false
    try {
      adapter()?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback)
    } catch (e: Exception) {
      // Adapter already off: nothing left to stop.
    }
  }

  private fun failStart(message: String) {
    Log.d(TAG, "payee: start failed: $message")
    val promise = startPromise
    resetSession(null)
    promise?.reject(Error(message))
  }

  /**
   * Tears down everything except the GATT server object itself: advertising,
   * every central, every reaper, every queued indication, the service, the
   * latches. Used by the startListening self-reset (mirrors Swift lines
   * 126-134 and Nearby's stopAdvertising/disconnect block), by stopListening,
   * and after the ack has left. `pendingStartError` rejects a start still
   * waiting on AdvertiseCallback so no promise is left hanging.
   */
  private fun resetSession(pendingStartError: String?) {
    stopAdvertising()
    idleReapers.values.forEach { main.removeCallbacks(it) }
    idleReapers.clear()
    cancelAckReaper()
    val server = gattServer
    val stale = (centrals.values.map { it.device } + listOfNotNull(boundDevice, pendingAckDevice))
      .distinctBy { it.address }
    centrals.clear()
    stale.forEach { server?.cancelConnection(it) }
    val orphaned = indicationJobs.toList() + listOfNotNull(indicationInFlight)
    indicationJobs.clear()
    indicationInFlight = null
    orphaned.forEach { it.onDone(false) }
    service?.let { server?.removeService(it) }
    service = null
    ackCharacteristic = null
    hasAccepted = false
    boundDevice = null
    pendingAckDevice = null
    listening = false
    val pending = startPromise
    startPromise = null
    if (pendingStartError != null) pending?.reject(Error(pendingStartError))
  }

  override fun startListening(
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
      val a = adapter()
      if (a == null || !hasBleHardware() || !a.isEnabled || !canConnect() || !canAdvertise()) {
        promise.reject(Error("bluetooth unavailable"))
        return@post
      }
      val server = ensureGattServer()
      if (server == null) {
        promise.reject(Error("bluetooth unavailable"))
        return@post
      }

      // Self-reset: a fresh session never inherits a previous one's bookkeeping (§3 peripheral step 2).
      resetSession("superseded by a new startListening")

      val uuid = BleGattProfile.serviceUuid(psk, instanceName)
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
        BluetoothGattDescriptor(
          CCCD_UUID,
          BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
        )
      )
      val svc = BluetoothGattService(uuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
      svc.addCharacteristic(frame)
      svc.addCharacteristic(ack)

      listening = true
      listenPsk = psk
      listenName = instanceName
      listenOnFrame = onFrame
      listenOnError = onError
      listenStartedAt = SystemClock.elapsedRealtime()
      service = svc
      ackCharacteristic = ack
      startPromise = promise
      Log.d(TAG, "payee: adding service $uuid for $instanceName")
      // addService is asynchronous; advertising starts from onServiceAdded.
      if (!server.addService(svc)) failStart("bluetooth unavailable: could not add GATT service")
    }
    return promise
  }

  override fun stopListening(): Promise<Unit> {
    val promise = Promise<Unit>()
    main.post {
      // Cancels a link still held for confirmFrame, so JS must never call
      // this on the success path — see the `teardown` flag in socket.ts.
      resetSession("listening stopped")
      listenPsk = null
      listenName = null
      listenOnFrame = null
      listenOnError = null
      promise.resolve(Unit)
    }
    return promise
  }

  override fun confirmFrame(accepted: Boolean, reason: String): Promise<Unit> {
    val promise = Promise<Unit>()
    main.post {
      cancelAckReaper()
      val device = pendingAckDevice
      val psk = listenPsk
      val name = listenName
      if (device == null || psk == null || name == null || gattServer == null) {
        // Idempotent and safe to call late, per the spec contract.
        promise.resolve(Unit)
        return@post
      }
      pendingAckDevice = null
      boundDevice = null
      // Full-session teardown of everything EXCEPT this link and the service
      // (an indication on a removed service never leaves the stack): drop the
      // other centrals and their reapers now, finish after the ack is through.
      idleReapers.values.forEach { main.removeCallbacks(it) }
      idleReapers.clear()
      centrals.values.filter { it.device.address != device.address }.toList().forEach { dropCentral(it.device) }
      val central = centrals[device.address]
      if (central == null) {
        resetSession(null)
        promise.reject(Error("peer disconnected before acking"))
        return@post
      }
      val json = BleGattProfile.ackJson(accepted, reason).toByteArray(Charsets.UTF_8)
      val t0 = SystemClock.elapsedRealtime()
      sendIndication(central, BleGattProfile.ackMessage(psk, name, json)) { ok ->
        Log.d(TAG, "payee: ack ok=$accepted delivered=$ok to ${device.address} in ${SystemClock.elapsedRealtime() - t0} ms")
        gattServer?.cancelConnection(device)
        resetSession(null)
        if (ok) promise.resolve(Unit) else promise.reject(Error("peer disconnected before acking"))
      }
    }
    return promise
  }

  // ── payer (central) ──

  override fun sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ): Promise<String> {
    val promise = Promise<String>()
    main.post {
      val ctx = context()
      val a = adapter()
      val psk = try { Base64.decode(pskBase64, Base64.DEFAULT) } catch (e: Exception) { null }
      val sealed = try { Base64.decode(frameBase64, Base64.DEFAULT) } catch (e: Exception) { null }
      if (psk == null || psk.isEmpty() || sealed == null || instanceName.isEmpty()) {
        promise.reject(Error("bad psk or frame"))
        return@post
      }
      if (sealed.size + 1 > MAX_BLE_FRAME_BYTES) {
        // The profile's ceiling, not a GATT limit: JS falls back to the fountain, which has none below 64 KiB (§3).
        promise.reject(Error("frame too large for a BLE payload"))
        return@post
      }
      val scanner = a?.bluetoothLeScanner
      if (ctx == null || a == null || !hasBleHardware() || !a.isEnabled || scanner == null || !canScan() || !canConnect()) {
        promise.reject(Error("bluetooth unavailable"))
        return@post
      }

      val uuid = BleGattProfile.serviceUuid(psk, instanceName)
      val t0 = SystemClock.elapsedRealtime()
      fun elapsed(): Long = SystemClock.elapsedRealtime() - t0

      var settled = false
      /** Step 4 (subscribed to ACK) reached: the connect budget no longer applies (§3 central step 8). */
      var ready = false
      var scanning = false
      var gatt: BluetoothGatt? = null
      var mtu = DEFAULT_ATT_MTU
      var discoveryStarted = false
      var mtuTimer: Runnable? = null
      val reassembler = BleGattProfile.Reassembler()
      var frameCharacteristic: BluetoothGattCharacteristic? = null
      var writeQueue = ArrayDeque<ByteArray>()
      var writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
      var onWriteQueueDrained: (() -> Unit)? = null
      lateinit var scanCallback: ScanCallback

      fun settle(block: () -> Unit) {
        if (settled) return
        settled = true
        if (scanning) {
          scanning = false
          try { scanner.stopScan(scanCallback) } catch (e: Exception) { /* adapter off */ }
        }
        mtuTimer?.let { main.removeCallbacks(it) }
        gatt?.let {
          try {
            it.disconnect()
            it.close()
          } catch (e: Exception) {
            // Already gone.
          }
        }
        gatt = null
        block()
      }

      main.postDelayed({
        if (!ready) settle { promise.reject(Error("connect timeout: no route to peer")) }
      }, connectTimeoutMs.toLong())
      main.postDelayed({
        settle { promise.reject(Error("timed out waiting for peer")) }
      }, timeoutMs.toLong())

      /** Next chunk only after the previous onCharacteristicWrite — Android delivers it for WRITE_TYPE_NO_RESPONSE too (§3 step 6). */
      fun writeNextChunk(g: BluetoothGatt) {
        val characteristic = frameCharacteristic
        if (characteristic == null) {
          settle { promise.reject(Error("session service not found on peer")) }
          return
        }
        val chunk = writeQueue.removeFirstOrNull()
        if (chunk == null) {
          val drained = onWriteQueueDrained
          onWriteQueueDrained = null
          drained?.invoke()
          return
        }
        val ok = try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            g.writeCharacteristic(characteristic, chunk, writeType) == BluetoothStatusCodes.SUCCESS
          } else {
            characteristic.writeType = writeType
            characteristic.value = chunk
            g.writeCharacteristic(characteristic)
          }
        } catch (e: Exception) {
          false
        }
        if (!ok) settle { promise.reject(Error("failed to send frame: write rejected by the stack")) }
      }

      fun writeMessage(g: BluetoothGatt, message: ByteArray, type: Int, onDrained: () -> Unit) {
        writeQueue = BleGattProfile.chunk(BleGattProfile.lengthPrefixed(message), mtu)
        writeType = type
        onWriteQueueDrained = onDrained
        writeNextChunk(g)
      }

      fun startDiscovery(g: BluetoothGatt) {
        if (settled || discoveryStarted) return
        discoveryStarted = true
        mtuTimer?.let { main.removeCallbacks(it) }
        mtuTimer = null
        if (!g.discoverServices()) settle { promise.reject(Error("service discovery could not start")) }
      }

      fun handleIndication(g: BluetoothGatt, value: ByteArray) {
        if (settled) return
        val messages = try {
          reassembler.feed(value)
        } catch (e: IllegalArgumentException) {
          settle { promise.reject(Error("bad frame from peer: ${e.message}")) }
          return
        }
        for (message in messages) {
          if (settled) return
          if (message.isEmpty()) {
            settle { promise.reject(Error("unexpected payload from peer")) }
            return
          }
          when (message[0]) {
            TYPE_HELLO_B -> {
              val proof = message.copyOfRange(1, message.size)
              if (!BleGattProfile.constantTimeEquals(proof, BleGattProfile.proof(psk, instanceName, TYPE_HELLO_B))) {
                settle { promise.reject(Error("peer failed the session proof")) }
                return
              }
              val chunkCount = (sealed.size + 1 + BleGattProfile.LENGTH_PREFIX_BYTES + BleGattProfile.chunkSize(mtu) - 1) / BleGattProfile.chunkSize(mtu)
              Log.d(TAG, "payer: HELLO_B verified at ${elapsed()} ms; sending frame (${sealed.size} bytes, $chunkCount chunks at mtu $mtu)")
              val tFrame = SystemClock.elapsedRealtime()
              writeMessage(g, BleGattProfile.frameMessage(sealed), BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) {
                Log.d(TAG, "payer: frame written in ${SystemClock.elapsedRealtime() - tFrame} ms; awaiting ack")
              }
            }
            TYPE_ACK -> {
              val json = BleGattProfile.verifyAck(psk, instanceName, message)
              if (json == null) {
                settle { promise.reject(Error("peer failed the session proof")) }
                return
              }
              Log.d(TAG, "payer: ack verified; total ${elapsed()} ms")
              settle { promise.resolve(Base64.encodeToString(json, Base64.NO_WRAP)) }
            }
            else -> settle { promise.reject(Error("unexpected payload from peer")) }
          }
        }
      }

      val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
          main.post {
            if (settled) return@post
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
              Log.d(TAG, "payer: connected to ${g.device.address} at ${elapsed()} ms; requesting mtu $REQUESTED_MTU")
              // MTU first, discovery strictly after onMtuChanged or the 2 s
              // timer — interleaving the two is the March mDeviceBusy deadlock (§3 step 3).
              val timer = Runnable {
                if (!settled && !discoveryStarted) {
                  Log.d(TAG, "payer: mtu negotiation timed out; discovering with mtu $mtu")
                  startDiscovery(g)
                }
              }
              mtuTimer = timer
              main.postDelayed(timer, MTU_NEGOTIATION_TIMEOUT_MS)
              if (!g.requestMtu(REQUESTED_MTU)) {
                Log.d(TAG, "payer: requestMtu refused; discovering with mtu $mtu")
                startDiscovery(g)
              }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
              settle {
                promise.reject(Error(if (ready) "peer disconnected before acking" else "connect failed: gatt status $status"))
              }
            }
          }
        }

        override fun onMtuChanged(g: BluetoothGatt, newMtu: Int, status: Int) {
          main.post {
            if (settled || discoveryStarted) return@post
            if (status == BluetoothGatt.GATT_SUCCESS) mtu = newMtu
            Log.d(TAG, "payer: mtu $mtu (status $status) at ${elapsed()} ms; discovering services")
            startDiscovery(g)
          }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
          main.post {
            if (settled) return@post
            val svc = if (status == BluetoothGatt.GATT_SUCCESS) g.getService(uuid) else null
            val frame = svc?.getCharacteristic(FRAME_CHAR_UUID)
            val ack = svc?.getCharacteristic(ACK_CHAR_UUID)
            val cccd = ack?.getDescriptor(CCCD_UUID)
            if (frame == null || ack == null || cccd == null) {
              settle { promise.reject(Error("session service not found on peer")) }
              return@post
            }
            frameCharacteristic = frame
            g.setCharacteristicNotification(ack, true)
            Log.d(TAG, "payer: services discovered at ${elapsed()} ms; subscribing to ACK")
            val ok = try {
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_INDICATION_VALUE) == BluetoothStatusCodes.SUCCESS
              } else {
                cccd.value = BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                g.writeDescriptor(cccd)
              }
            } catch (e: Exception) {
              false
            }
            if (!ok) settle { promise.reject(Error("could not subscribe to the peer's ACK characteristic")) }
          }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
          main.post {
            if (settled || descriptor.uuid != CCCD_UUID) return@post
            if (status != BluetoothGatt.GATT_SUCCESS) {
              settle { promise.reject(Error("could not subscribe to the peer's ACK characteristic: status $status")) }
              return@post
            }
            ready = true
            Log.d(TAG, "payer: subscribed to ACK at ${elapsed()} ms; sending HELLO_A")
            writeMessage(g, BleGattProfile.helloA(psk, instanceName), BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) {}
          }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
          main.post {
            if (settled || characteristic.uuid != FRAME_CHAR_UUID) return@post
            if (status != BluetoothGatt.GATT_SUCCESS) {
              settle { promise.reject(Error("failed to send frame: gatt status $status")) }
              return@post
            }
            writeNextChunk(g)
          }
        }

        // API 33+ delivers the value directly. Android 13 calls BOTH overloads,
        // so the legacy one bails there to avoid feeding every chunk twice.
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
          if (characteristic.uuid != ACK_CHAR_UUID) return
          val copy = value.copyOf()
          main.post { handleIndication(g, copy) }
        }

        @Deprecated("Deprecated in Java")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
          if (characteristic.uuid != ACK_CHAR_UUID) return
          // Copy now: the framework reuses the characteristic's value buffer.
          val copy = characteristic.value?.copyOf() ?: return
          main.post { handleIndication(g, copy) }
        }
      }

      scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
          main.post {
            if (settled || gatt != null) return@post
            scanning = false
            try { scanner.stopScan(scanCallback) } catch (e: Exception) { /* adapter off */ }
            Log.d(TAG, "payer: found ${result.device.address} (rssi ${result.rssi}) at ${elapsed()} ms; connecting")
            val g = result.device.connectGatt(ctx, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
            gatt = g
            if (g == null) settle { promise.reject(Error("bluetooth unavailable")) }
          }
        }

        override fun onScanFailed(errorCode: Int) {
          main.post {
            scanning = false
            settle { promise.reject(Error("scan failed: code $errorCode")) }
          }
        }
      }

      // Exact 128-bit match on the session UUID: only the PSK holder that read this QR is advertising it (§2).
      val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(uuid)).build()
      val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
      Log.d(TAG, "payer: scanning for $uuid")
      scanning = true
      try {
        scanner.startScan(listOf(filter), settings, scanCallback)
      } catch (e: Exception) {
        scanning = false
        settle { promise.reject(Error("bluetooth unavailable")) }
      }
    }
    return promise
  }

  companion object {
    private const val PREPARE_POLL_MS = 100L
  }
}
```

- [ ] **Step 7: Compile the module and re-run the profile tests**

```bash
cd android && ./gradlew :react-native-localpay-transport:compileDebugKotlin :react-native-localpay-transport:testDebugUnitTest --console=plain 2>&1 | grep -E '^(e:|w: .*HybridLocalPayBle|BUILD|> Task .*localpay)' | head -40
```

Expected: no `e:` lines, `BUILD SUCCESSFUL`. Deprecation warnings (`w:`) on the legacy `setValue` / `writeCharacteristic` paths are expected on API-33 overloads and are suppressed at class level; anything else printed as `w:` for `HybridLocalPayBleTransport.kt` should be read but is not a blocker. Then cross-check the wire constants against Task 8's Swift file:

```bash
cd /Users/personal/git/bsv-wallet
for s in 'bsvpay-ble-svc' 'B5A1E001-7374-4F6E-8E2D-425356504159' 'B5A1E002-7374-4F6E-8E2D-425356504159' '32768' '0x0F) or 0x40\|0x0F) | 0x40' '0x3F) or 0x80\|0x3F) | 0x80'; do
  printf '%-45s kotlin=%s swift=%s\n' "$s" \
    "$(grep -c -- "$s" packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/BleGattProfile.kt)" \
    "$(grep -c -- "$s" packages/react-native-localpay-transport/ios/BleGattProfile.swift)"
done
```

Expected: every row prints `kotlin=1 swift=1` (the two RFC-4122 rows match either language's spelling). A `0` on the Swift side means Task 8 diverged from the contract — stop and reconcile before any hardware run.

- [ ] **Step 8: Commit the profile, its tests and the backend**

```bash
cd /Users/personal/git/bsv-wallet
git add packages/react-native-localpay-transport/android/build.gradle \
  packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/BleGattProfile.kt \
  packages/react-native-localpay-transport/android/src/test/java/com/margelo/nitro/localpaytransport/BleGattProfileTest.kt
git commit -m "feat(ble): Android bsvpay-ble/1 profile helpers with JUnit known-answer vectors

Session service UUID (HMAC, RFC-4122 bits), HELLO/ACK proofs, ack JSON
serializer byte-identical to AWDL/Nearby, u32 length framing, MTU chunking
and a bounded reassembler. Pure JVM so it runs under plain JUnit; the same
vectors check ios/BleGattProfile.swift.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git add packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayBleTransport.kt
git commit -m "feat(ble): Android GATT backend for LocalPayBleTransport

Payee: BluetoothGattServer with the session-UUID service, FRAME (write)
and ACK (indicate + CCCD) characteristics, LOW_LATENCY connectable advert,
per-central reassembly, HELLO_A verify -> HELLO_B indication, first-
success-wins latch, 30 s idle and 60 s ack reapers, HMAC'd ack on
confirmFrame. Payer: scan-filter to the UUID, connectGatt(TRANSPORT_LE),
requestMtu(517) then discoverServices, subscribe, HELLO_A, FRAME chunks
gated on onCharacteristicWrite, constant-time ack verification. Main-
Handler confinement and error strings mirror HybridLocalPayTransport.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: two commits on top of Task 8's; `git log --oneline -2` prints `feat(ble): Android GATT backend for LocalPayBleTransport` above `feat(ble): Android bsvpay-ble/1 profile helpers with JUnit known-answer vectors`; `git status --short` shows nothing under `packages/react-native-localpay-transport` (the prebuilt `android/` is gitignored).

- [ ] **Step 9: Build and install the Android dev client, prepare the log capture**

Two Android phones (A = payee, B = payer) on API 31+ with Bluetooth on, plus the iPhone carrying Task 8's build for Steps 11–12. From the repo root:

```bash
npm run android-dev-physical
ls -t build-*.apk | head -1
adb devices
adb -s <SERIAL_A> install -r "$(ls -t build-*.apk | head -1)"
adb -s <SERIAL_B> install -r "$(ls -t build-*.apk | head -1)"
```

Expected: `Success` from each `adb install`. Confirm the native library is actually in the APK (the historical silent-QR-fallback failure mode): `unzip -l "$(ls -t build-*.apk | head -1)" | grep -c libLocalPayTransport.so` prints `4`. Start Metro with `npx expo start --dev-client` and open the app on both phones. In two terminals:

```bash
adb -s <SERIAL_A> logcat -c && adb -s <SERIAL_A> logcat -s LocalPayBle:D ReactNativeJS:W
adb -s <SERIAL_B> logcat -c && adb -s <SERIAL_B> logcat -s LocalPayBle:D ReactNativeJS:W
```

Expected: both streams stay open and print nothing until a flow is entered; the first `D LocalPayBle:` line on each phone is `prepare: poweredOn` when its Receive flow mints.

The first time the receive flow is entered on each phone Android shows the "Nearby devices" permission prompt (Task 10's `requestBlePermissions`); grant it. If Task 10 is not merged yet, grant the permission manually so the native layer is testable: `adb -s <SERIAL> shell pm grant org.bsvblockchain.wallet android.permission.BLUETOOTH_SCAN` and the same for `BLUETOOTH_CONNECT` and `BLUETOOTH_ADVERTISE`.

- [ ] **Step 10: Hardware checklist — Android (payee A) ↔ Android (payer B)**

Force the BLE rung between two Android phones. The payer's ladder (§5) takes Nearby whenever the payee advertised `CAP_NEARBY`, so make the payee mint without it: NearbyFlow's `nearbyReady` requires every Nearby permission, and on API 33+ one of them is `NEARBY_WIFI_DEVICES`, which BLE does not need. On phone A: `adb -s <SERIAL_A> shell pm revoke org.bsvblockchain.wallet android.permission.NEARBY_WIFI_DEVICES` (on API 31–32 revoke `android.permission.ACCESS_FINE_LOCATION` instead) and relaunch the app; then, when the receive flow asks for Nearby permission, deny it. The proof that BLE is in play is in the logs themselves: A must print `payee: advertising` and B must print `payer: scanning` in the steps below — if B shows no `LocalPayBle` lines at all, Nearby won the ladder; check A's minted `c` bits in the Metro console (`decodeSession` from `core/localpay/session`) and repeat.

1. Phone A: Receive → Nearby. Expect in A's logcat, in order:
   ```
   D LocalPayBle: prepare: poweredOn
   D LocalPayBle: payee: adding service <uuid> for bsvpay-<base32>
   D LocalPayBle: payee: service added <uuid>; starting advertising
   D LocalPayBle: payee: advertising <uuid> (<n> ms after startListening)
   ```
   Record `<n>` (advertising latency).
2. Phone B: Pay → scan A's QR → confirm. Expect in B's logcat:
   ```
   D LocalPayBle: payer: scanning for <uuid>              ← same uuid as A printed
   D LocalPayBle: payer: found <A mac> (rssi -NN) at <t1> ms; connecting
   D LocalPayBle: payer: connected to <A mac> at <t2> ms; requesting mtu 517
   D LocalPayBle: payer: mtu <M> (status 0) at <t3> ms; discovering services
   D LocalPayBle: payer: services discovered at <t4> ms; subscribing to ACK
   D LocalPayBle: payer: subscribed to ACK at <t5> ms; sending HELLO_A
   D LocalPayBle: payer: HELLO_B verified at <t6> ms; sending frame (<bytes> bytes, <k> chunks at mtu <M>)
   D LocalPayBle: payer: frame written in <tf> ms; awaiting ack
   D LocalPayBle: payer: ack verified; total <T> ms
   ```
   And in A's logcat:
   ```
   D LocalPayBle: payee: central connected <B mac> (status 0)
   D LocalPayBle: payee: mtu <M> for <B mac>
   D LocalPayBle: payee: <B mac> subscribed to ACK
   D LocalPayBle: payee: HELLO_A verified from <B mac> at <a1> ms; sending HELLO_B
   D LocalPayBle: payee: frame accepted (<bytes> bytes, mtu <M>) from <B mac> at <a2> ms; advertising stopped
   D LocalPayBle: payee: ack ok=true delivered=true to <B mac> in <ta> ms
   D LocalPayBle: payee: central disconnected <B mac> (status 0)
   ```
   Pass criteria: `<M>` ≥ 185 on both sides and identical; `<t5>` < 6000 (inside `BLE_CONNECT_TIMEOUT_MS`); `<T>` < 20000; B's screen shows the sent state and A's shows the received payment; no `ReactNativeJS` warning containing `radio_fallback`. Record `<M>`, `<t5>`, `<tf>`, `<ta>`, `<T>`, `<bytes>`.
3. Negative — radios off: turn Bluetooth OFF on A, repeat step 2. Expect B: `payer: scanning for <uuid>` then, at 6000 ± 100 ms, the JS radio-fallback path (fountain QR appears). B's logcat shows no `found` line. Record the elapsed ms from the JS warning `[localpay]` line.
4. Negative — second device with the same QR: with A listening, pay from B (succeeds), then immediately scan the same QR from a third phone or from B again. Expect B (second attempt) to see `connect timeout: no route to peer` (A stopped advertising) and the fountain; A's logcat shows no second `frame accepted`.
5. Negative — stranger: with A listening and B NOT paying, on B run in Metro console `require('react-native-localpay-transport').getLocalPayBleTransport().sendFrame('<A instanceName>', btoa(String.fromCharCode(...new Uint8Array(32))), btoa('xx'), 20000, 6000).catch(e => console.warn('stranger:', e.message))`. This holds the wrong PSK, so its UUID differs and scanning simply times out: expect `stranger: connect timeout: no route to peer`. Then repeat with the RIGHT psk but a corrupted frame is not possible from JS without the session; instead confirm the payee-side proof guard by pointing an off-the-shelf BLE tool (nRF Connect) at A's service and writing 37 arbitrary bytes to `B5A1E001-…`: expect A's logcat `payee: bad framing from <mac>` or `payee: HELLO_A proof failed from <mac>; dropping`, A keeps advertising (`advertising` is never re-logged, but a fresh B payment still succeeds afterwards).

- [ ] **Step 11: Hardware checklist — Android (payer) → iOS (payee) FIRST**

This direction was never confirmed in the `5fc72a7` era (spec "Verified facts"), so it runs before iOS→Android. iPhone: Receive → Nearby (Task 8 build; Console.app filtered on `LocalPayBle`). Phone B: Pay → scan the iPhone's QR → confirm. Expect B's logcat to show the same nine `payer:` lines as Step 10.2; the iOS default MTU means `<M>` will typically be 185 or 527 — record whichever appears. Pass criteria identical to Step 10.2 plus: the iPhone Console (filter `subsystem:org.bsvblockchain.wallet category:LocalPayBle`) shows Task 8's `hello verified id=…`, `frame accepted bytes=… id=…` and `ack sent ok=1 bytes=44`. If B stalls at `connected … requesting mtu 517` for 2 s and then logs `mtu negotiation timed out; discovering with mtu 23`, the transfer must STILL complete (at ~2.5 KB/s) — record it as a finding, not a failure, and note the iPhone model/iOS version.

- [ ] **Step 12: Hardware checklist — iOS (payer) → Android (payee)**

Phone A: Receive → Nearby. iPhone: Pay → scan A's QR → confirm. Expect A's logcat to show the same seven `payee:` lines as Step 10.2 with the iPhone's MAC (a random resolvable address — it changes per connection, that is normal). Pass criteria: `payee: mtu <M> for <mac>` appears BEFORE `subscribed to ACK` (iOS initiates the MTU exchange itself), `<M>` ≥ 185, `ack ok=true delivered=true`, iPhone shows the sent state. Then the lock-screen case from the spec's testing list: A listening, lock A's screen, iPhone pays — expect the iPhone to fall to the fountain within its connect budget and A's logcat to show either nothing or `central connected` followed by `idle reaper dropped` 30 s later; no `frame accepted`.

- [ ] **Step 13: Record the measurements and commit the log**

Task 8 Step 6 created `docs/superpowers/2026-09-02-ble-hardware-log.md`; append the block below (from `## Android` onward) to the end of that file. Replace each `…` with the value read from the log line named in the column header — every cell is a number from Steps 10–12, none is left blank.

```markdown
## Android (Task 9) — <date>, phones: A = <make/model, Android version>, B = <make/model, Android version>, iPhone = <model, iOS version>

| Pairing | Negotiated MTU (`mtu <M>`) | Advertising latency (`advertising … (<n> ms`) | Subscribed at (`subscribed to ACK at <t5> ms`) | Frame bytes | Frame write (`frame written in <tf> ms`) | Ack indication (`ack … in <ta> ms`) | Total (`ack verified; total <T> ms`) | Result |
|---|---|---|---|---|---|---|---|---|
| Android A → Android B (payer B) | … | … | … | … | … | … | … | pass/fail |
| Android B → iOS (payer B) | … | n/a (iOS payee) | … | … | … | n/a | … | pass/fail |
| iOS → Android A (payee A) | … | … | n/a (iOS payer) | … | n/a | … | n/a | pass/fail |

### Negative cases

| Case | Expected | Observed (ms / log line) |
|---|---|---|
| Payee Bluetooth off (Step 10.3) | `connect timeout: no route to peer` at ~6000 ms, fountain shown | … |
| Second device, same QR (Step 10.4) | second payer times out; payee logs one `frame accepted` only | … |
| Wrong-PSK sender (Step 10.5) | `connect timeout: no route to peer` (UUID never matches) | … |
| Garbage write to FRAME (Step 10.5, nRF Connect) | `bad framing from` or `HELLO_A proof failed from`; next real payment still succeeds | … |
| Payee screen locked, iOS payer (Step 12) | payer falls to fountain; payee logs no `frame accepted` | … |

### Findings

- MTU negotiation against iOS: <"completed in N ms" or "timed out after 2000 ms, transfer completed at mtu 23 in T ms">
- Anything that deviated from spec §3 "Expected performance" (0.5–2.5 s connect, 1–3 s end to end for 3–8 KB): <none, or describe>
```

Commit:

```bash
cd /Users/personal/git/bsv-wallet
git add docs/superpowers/2026-09-02-ble-hardware-log.md
git commit -m "docs(ble): Android hardware log — Android<->Android, Android->iOS, iOS->Android

Negotiated MTU, connect/subscribe latency, frame write and ack round-trip
for all three Android pairings, plus the radios-off, duplicate-QR,
wrong-PSK, garbage-write and locked-screen negative cases.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```


---

### Task 10: NearbyFlow wiring, PresenceRow medium, i18n

Wires the BLE rung into the user-facing flow (spec §4 payee minting sequence, §5 payer floor copy, §6 payee multi-listener + presence medium, §7 permissions), adds two tiny prompt-aware helpers to `deviceCaps.ts` so `NearbyFlow` never imports the native package, extracts the multi-listener arbitration into a pure, tested `raceReceivers`, and adds the six new copy keys to all twelve language blocks.

Everything here builds on the names Tasks 1–9 created (see **Consumes**). Run the plan's filtered typecheck first (`npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep "error TS" | grep -v "core/pay/rails/handle.ts\|ui/components/pay/HandleReceive.tsx"`); if it prints anything before you start, stop and fix the earlier task — nothing in this task should be debugged against a broken baseline.

**Files:**
- Modify: `packages/expo-wallet-toolbox/ui/components/ui/PresenceRow.tsx` (:81-96 props + `ICONS`; :100 signature; :167 icon call site)
- Modify: `packages/expo-wallet-toolbox/__tests__/ui/PresenceRow.test.tsx` (append a `describe`)
- Modify: `packages/expo-wallet-toolbox/core/localpay/deviceCaps.ts` (append `prepareBle`; `readBluetoothState` already exists from Task 6)
- Create: `packages/expo-wallet-toolbox/__tests__/localpay/prepareBle.test.ts`
- Create: `packages/expo-wallet-toolbox/core/localpay/transport/race.ts`
- Create: `packages/expo-wallet-toolbox/__tests__/localpay/race.test.ts`
- Modify: `packages/expo-wallet-toolbox/core/pay/rails/nearby.ts` (the BLE export lines Task 7 added)
- Modify: `packages/expo-wallet-toolbox/core/index.ts` (:118-133 hand-written nearby block)
- Modify: `packages/expo-wallet-toolbox/core/i18n/translations.tsx` (12 insertion anchors, one per language block: en :714, zh :1230, hi :1749, es :2271, fr :2787, ar :3299, pt :3814, bn :4328, ru :4844, id :5359, ja :5889, pl :6419 — every one is the `local_pay_radio_fallback:` line of its block)
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx` (:1-22 header; :99-153 imports; :311-316 `DECLINE_KEYS`; :441-447 `nearbyError`; :499-523 capability state + `radioTransport`; :605 `reset`; :644-645 `settleReceived` signature; :780-790 `savePending`; :896 deps; :906-947 listener effect; :951-993 `startRequest`; :1044-1061 `onSessionScanned`; :1074 `sendKind`; :1198-1204 `executeSend` radio pick; :1497 `radioActive`; :1509-1550 `presence`; :1586-1590 `presenceBlock`; :1807-1835 receive_wait notices; :1875 send_confirm presence slot)
- Test: `npx jest packages/expo-wallet-toolbox/__tests__/ui/PresenceRow.test.tsx packages/expo-wallet-toolbox/__tests__/localpay/prepareBle.test.ts packages/expo-wallet-toolbox/__tests__/localpay/race.test.ts`

**Interfaces:**

Consumes (all must already exist from Tasks 1–9; grep each before starting):
- `react-native-localpay-transport`: `getLocalPayBleTransport(): LocalPayBleTransport | null` with `bluetoothState(): string`, `prepare(timeoutMs: number): Promise<string>`
- `core/localpay/types.ts`: `LocalPaymentTransport.kind: 'awdl' | 'nearby' | 'ble' | 'qr'`, `ReceivedFrame`, `ConfirmDelivery`
- `core/localpay/session.ts`: `mintSession({ …, supportsBle?: boolean, hints?: number })`
- `core/localpay/deviceCaps.ts`: `type BluetoothState`, `interface DeviceProbe`, `BLE_PREPARE_TIMEOUT_MS`, `capsFromProbe(p: DeviceProbe): number`, `probeDeviceCaps(opts?): Promise<DeviceProbe>`, `readBluetoothState(): BluetoothState`
- `core/localpay/blePermissions.ts`: `requestBlePermissions(): Promise<boolean>`
- `core/localpay/transport/ble.ts`: `bleTransport`
- `core/localpay/transport/select.ts`: `localSupportsBle()`, `describeFloor(session, { os, bluetooth }): FloorReason`, `type FloorReason`
- Barrels `core/pay/rails/nearby.ts` and `core/index.ts` already re-export the above (Task 7). `NearbyFlow` imports from `@bsv/expo-wallet-toolbox`, which resolves to `core/index.ts` (`packages/expo-wallet-toolbox/package.json` `"main": "core/index.ts"`).

Produces:
- `PresenceRow` prop `medium?: 'wifi' | 'bluetooth'` (default `'wifi'`); `ready`/`waiting` glyph is `'bluetooth'` when `medium === 'bluetooth'`, else `'wifi'`. (`waiting` still draws the breathing dot, not the glyph — unchanged.)
- `core/localpay/deviceCaps.ts`: `export async function prepareBle(timeoutMs: number = BLE_PREPARE_TIMEOUT_MS): Promise<BluetoothState>` (the one call that may show the iOS prompt; never rejects; `'unsupported'` when the accessor is null; reuses Task 6's module-private `asBluetoothState`).
- `core/localpay/transport/race.ts`: `export type RadioKind = 'awdl' | 'nearby' | 'ble'`; `export interface RaceWinner extends ReceivedFrame { kind: RadioKind }`; `export function raceReceivers(transports: readonly LocalPaymentTransport[], session: Session, signal: AbortSignal, onError: (kind: RadioKind, error: unknown) => void): Promise<RaceWinner>`.
- Barrels additionally re-export `prepareBle`, `raceReceivers`, `type RaceWinner`, `type RadioKind` (`readBluetoothState` is already there from Task 7).
- i18n keys in all 12 blocks: `local_pay_floor_peer_bt_off`, `local_pay_floor_local_bt_off`, `local_pay_floor_local_ble_denied`, `local_pay_floor_cross_os`, `local_pay_floor_peer_no_radio`, `local_pay_ble_unavailable`.
- `NearbyFlow`: `bleState`, `blePermitted`, `bleReady`, `radioTransports`, `radioErrors`, `floorReason`, `presenceMedium`; `settleReceived(frame, session, confirm?, via?)`.

---

- [ ] **Step 1: Write the failing PresenceRow medium test**

Open `packages/expo-wallet-toolbox/__tests__/ui/PresenceRow.test.tsx`. The `@expo/vector-icons` mock at the top of that file spreads every Ionicons prop onto a `View`, so the chosen glyph survives into `toJSON()` as a `name` prop — that is what these assertions read. Append the following at the very end of the file (after the closing `})` of the existing `describe('PresenceRow', …)`):

```tsx

// The rendered tree, flattened to the Ionicons glyph names in it. The mock at
// the top of this file spreads `name` onto a plain View, so no host node other
// than a mocked icon carries that prop.
function iconNames(node: unknown): string[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(iconNames)
  const { props, children } = node as { props?: { name?: unknown }; children?: unknown }
  const own = typeof props?.name === 'string' ? [props.name] : []
  return own.concat(iconNames(children))
}

const drawWith = (props: { state: PresenceState; medium?: 'wifi' | 'bluetooth' }) =>
  render(
    <ThemeProvider>
      <PresenceRow state={props.state} label="x" medium={props.medium} />
    </ThemeProvider>
  )

// BLE is the cross-OS rung. A Bluetooth link wearing a Wi-Fi glyph would tell
// the person paying to look at the wrong radio when it fails.
describe('PresenceRow medium', () => {
  it('defaults the ready glyph to wi-fi', () => {
    expect(iconNames(drawWith({ state: 'ready' }).toJSON())).toEqual(['wifi'])
  })

  it('shows the bluetooth glyph when the ready link is BLE', () => {
    expect(iconNames(drawWith({ state: 'ready', medium: 'bluetooth' }).toJSON())).toEqual(['bluetooth'])
  })

  it('leaves the non-radio states untouched by the medium', () => {
    expect(iconNames(drawWith({ state: 'qr', medium: 'bluetooth' }).toJSON())).toEqual(['qr-code-outline'])
    expect(iconNames(drawWith({ state: 'linked', medium: 'bluetooth' }).toJSON())).toEqual(['lock-closed'])
    expect(iconNames(drawWith({ state: 'paid', medium: 'bluetooth' }).toJSON())).toEqual(['checkmark-circle'])
  })

  it('keeps the breathing dot, not a glyph, while waiting on either medium', () => {
    expect(iconNames(drawWith({ state: 'waiting' }).toJSON())).toEqual([])
    expect(iconNames(drawWith({ state: 'waiting', medium: 'bluetooth' }).toJSON())).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch the bluetooth case fail**

```
npx jest packages/expo-wallet-toolbox/__tests__/ui/PresenceRow.test.tsx
```

Expected: the existing tests pass; `shows the bluetooth glyph when the ready link is BLE` fails with `Expected: ["bluetooth"]` / `Received: ["wifi"]` (the unknown `medium` prop is ignored by the current component). The other three new tests pass already.

- [ ] **Step 3: Add the `medium` prop to PresenceRow**

Open `packages/expo-wallet-toolbox/ui/components/ui/PresenceRow.tsx`. Replace lines 81-96 (from `interface PresenceRowProps {` through the closing `}` of `const ICONS = …`) with:

```tsx
interface PresenceRowProps {
  state: PresenceState
  /** Localized, role-appropriate sentence. The screen owns the wording. */
  label: string
  /** The peer's resolved display name, when identity lookup found one. */
  peer?: string | null
  /**
   * Which radio the `ready`/`waiting` states are about. BLE is the only rung
   * that crosses iOS↔Android, so a Bluetooth link must not wear a Wi-Fi glyph:
   * the glyph is what tells the person paying which radio to look at when the
   * link does not come up. Every other state ignores this — `qr` has no radio,
   * and `linked`/`paid` are claims about the payment, not the pipe.
   */
  medium?: 'wifi' | 'bluetooth'
}

type IconName = keyof IoniconsComponent['glyphMap']

function iconFor(state: PresenceState, medium: 'wifi' | 'bluetooth'): IconName {
  switch (state) {
    case 'qr':
      return 'qr-code-outline'
    case 'ready':
    case 'waiting':
      return medium === 'bluetooth' ? 'bluetooth' : 'wifi'
    case 'linked':
      return 'lock-closed'
    case 'paid':
      return 'checkmark-circle'
  }
}
```

Then change the component signature (line 100 before this edit; now a few lines lower) from

```tsx
export default function PresenceRow({ state, label, peer }: PresenceRowProps) {
```

to

```tsx
export default function PresenceRow({ state, label, peer, medium = 'wifi' }: PresenceRowProps) {
```

and the icon call site (was line 167) from

```tsx
          <Ionicons name={ICONS[state]} size={13} color={dotColor} />
```

to

```tsx
          <Ionicons name={iconFor(state, medium)} size={13} color={dotColor} />
```

`ICONS` has no other reader in the file (`grep -n ICONS packages/expo-wallet-toolbox/ui/components/ui/PresenceRow.tsx` must now return nothing).

- [ ] **Step 4: Run the PresenceRow tests**

```
npx jest packages/expo-wallet-toolbox/__tests__/ui/PresenceRow.test.tsx
```

Expected: `Tests: 11 passed, 11 total` (7 existing + 4 new).

- [ ] **Step 5: Commit PresenceRow**

```
git add packages/expo-wallet-toolbox/ui/components/ui/PresenceRow.tsx packages/expo-wallet-toolbox/__tests__/ui/PresenceRow.test.tsx
git commit -m "feat(pay): let PresenceRow name the radio it is waiting on

BLE is the cross-OS rung, so the ready/waiting glyph must be able to say
Bluetooth instead of Wi-Fi. New optional medium prop, default wifi; the
non-radio states ignore it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: one commit touching two files; `git log -1 --format=%s` prints `feat(pay): let PresenceRow name the radio it is waiting on`.

- [ ] **Step 6: Write the failing test for `prepareBle`**

Create `packages/expo-wallet-toolbox/__tests__/localpay/prepareBle.test.ts`:

```ts
// deviceCaps.ts imports NetInfo at module scope for probeDeviceCaps; this file
// never calls it, but the module must still load. Both import shapes are
// covered so the mock survives a default OR a named import in deviceCaps.ts.
jest.mock('@react-native-community/netinfo', () => {
  const netinfo = {
    fetch: jest.fn(async () => ({ isConnected: true, isInternetReachable: true, type: 'wifi', isWifiEnabled: true }))
  }
  return { __esModule: true, default: netinfo, fetch: netinfo.fetch }
})

jest.mock('react-native-localpay-transport', () => ({
  getLocalPayTransport: jest.fn(() => null),
  getLocalPayBleTransport: jest.fn(() => null)
}))

import { BLE_PREPARE_TIMEOUT_MS, prepareBle } from '../../core/localpay/deviceCaps'

const { getLocalPayBleTransport } = jest.requireMock('react-native-localpay-transport') as {
  getLocalPayBleTransport: jest.Mock
}

function fakeBle(overrides: { bluetoothState?: () => string; prepare?: (timeoutMs: number) => Promise<string> } = {}) {
  return {
    isSupported: () => true,
    nfcAvailable: () => false,
    bluetoothState: overrides.bluetoothState ?? (() => 'poweredOn'),
    prepare: jest.fn(overrides.prepare ?? (async () => 'poweredOn')),
    startListening: jest.fn(),
    stopListening: jest.fn(),
    confirmFrame: jest.fn(),
    sendFrame: jest.fn()
  }
}

describe('prepareBle', () => {
  afterEach(() => jest.clearAllMocks())

  it('resolves the settled state and passes the default budget to native', async () => {
    const ble = fakeBle()
    getLocalPayBleTransport.mockReturnValue(ble)
    await expect(prepareBle()).resolves.toBe('poweredOn')
    expect(ble.prepare).toHaveBeenCalledWith(BLE_PREPARE_TIMEOUT_MS)
  })

  it('passes an explicit budget through', async () => {
    const ble = fakeBle({ prepare: async () => 'unauthorized' })
    getLocalPayBleTransport.mockReturnValue(ble)
    await expect(prepareBle(250)).resolves.toBe('unauthorized')
    expect(ble.prepare).toHaveBeenCalledWith(250)
  })

  it('resolves unsupported without touching native when there is no BLE HybridObject', async () => {
    getLocalPayBleTransport.mockReturnValue(null)
    await expect(prepareBle()).resolves.toBe('unsupported')
  })

  it('coerces an unrecognised native string to unknown', async () => {
    getLocalPayBleTransport.mockReturnValue(fakeBle({ prepare: async () => 'resetting' }))
    await expect(prepareBle()).resolves.toBe('unknown')
  })

  it('never rejects: a native rejection reads as unknown', async () => {
    getLocalPayBleTransport.mockReturnValue(
      fakeBle({
        prepare: async () => {
          throw new Error('managers never settled')
        }
      })
    )
    await expect(prepareBle()).resolves.toBe('unknown')
  })
})
```

- [ ] **Step 7: Run it and watch it fail on the missing export**

```
npx jest packages/expo-wallet-toolbox/__tests__/localpay/prepareBle.test.ts
```

Expected: `Tests: 5 failed, 5 total`, each with `TypeError: (0 , _deviceCaps.prepareBle) is not a function` — the module loads (Task 6's exports are there) but does not export `prepareBle` yet.

- [ ] **Step 8: Add `prepareBle` to deviceCaps.ts**

Open `packages/expo-wallet-toolbox/core/localpay/deviceCaps.ts` (Task 6's file). Confirm it already has `import { getLocalPayBleTransport } from 'react-native-localpay-transport'`, the module-private `asBluetoothState(raw: unknown): BluetoothState` coercion, and the exported `readBluetoothState()` (all from Task 6). Append the following at the end of the file — it reuses `asBluetoothState`; do NOT add a second coercion helper or states array:

```ts

/**
 * Instantiate the BLE managers and wait for them to settle. THE ONE CALL THAT
 * MAY SHOW THE iOS BLUETOOTH PROMPT, so the payee's minting step is the only
 * caller (spec §4). Never rejects: minting must not fail because a radio did
 * not answer — the request simply advertises without CAP_BLE. 'unsupported'
 * when there is no BLE HybridObject at all.
 */
export async function prepareBle(timeoutMs: number = BLE_PREPARE_TIMEOUT_MS): Promise<BluetoothState> {
  const ble = getLocalPayBleTransport()
  if (!ble) return 'unsupported'
  try {
    return asBluetoothState(await ble.prepare(timeoutMs))
  } catch {
    return 'unknown'
  }
}
```

- [ ] **Step 9: Run the helper tests**

```
npx jest packages/expo-wallet-toolbox/__tests__/localpay/prepareBle.test.ts
```

Expected: `Tests: 5 passed, 5 total`.

- [ ] **Step 10: Write the failing `raceReceivers` test**

Create `packages/expo-wallet-toolbox/__tests__/localpay/race.test.ts`:

```ts
import { raceReceivers, type RadioKind } from '../../core/localpay/transport/race'
import { mintSession } from '../../core/localpay/session'
import { FRAME_VERSION, type PaymentFrame } from '../../core/localpay/codec'
import type { LocalPaymentTransport, ReceivedFrame } from '../../core/localpay/types'

const session = mintSession({
  identityKey: '02'.padEnd(66, 'd'),
  amount: 1,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  supportsAwdl: true
})

const frame: PaymentFrame = {
  version: FRAME_VERSION,
  kind: 'bsv' as const,
  senderIdentityKey: '02'.padEnd(66, 'e'),
  outputIndex: 0,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  transaction: new Uint8Array([1, 2, 3])
}

/**
 * A transport whose receive() is settled by the test, and which records the
 * signal it was given so the test can see whether the race aborted it.
 */
function fakeRadio(kind: RadioKind) {
  let resolveFn: ((r: ReceivedFrame) => void) | undefined
  let rejectFn: ((e: unknown) => void) | undefined
  let signal: AbortSignal | undefined
  const confirm = jest.fn(async () => {})
  const transport: LocalPaymentTransport = {
    kind,
    receive: jest.fn((_session, s: AbortSignal) => {
      signal = s
      return new Promise<ReceivedFrame>((resolve, reject) => {
        resolveFn = resolve
        rejectFn = reject
        // Mirror socket.ts: an aborted listener rejects 'cancelled'.
        s.addEventListener('abort', () => reject(new Error('cancelled')))
      })
    }),
    send: jest.fn(() => Promise.reject(new Error('not under test')))
  }
  return {
    transport,
    confirm,
    deliver: () => resolveFn?.({ frame, confirm }),
    fail: (e: Error) => rejectFn?.(e),
    aborted: () => signal?.aborted ?? false,
    started: () => (transport.receive as jest.Mock).mock.calls.length
  }
}

/** Resolves 'pending' if `p` has not settled within a macrotask. */
async function settledOrPending<T>(p: Promise<T>): Promise<'settled' | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    p.then(
      () => 'settled' as const,
      () => 'settled' as const
    ),
    new Promise<'pending'>(resolve => {
      timer = setTimeout(() => resolve('pending'), 20)
    })
  ])
  clearTimeout(timer)
  return outcome
}

describe('raceReceivers', () => {
  it('starts every radio and returns the first frame with its kind, aborting the others', async () => {
    const awdl = fakeRadio('awdl')
    const ble = fakeRadio('ble')
    const onError = jest.fn()
    const race = raceReceivers([awdl.transport, ble.transport], session, new AbortController().signal, onError)

    expect(awdl.started()).toBe(1)
    expect(ble.started()).toBe(1)
    ble.deliver()

    const winner = await race
    expect(winner.kind).toBe('ble')
    expect(winner.frame).toEqual(frame)
    expect(winner.confirm).toBe(ble.confirm)
    expect(awdl.aborted()).toBe(true)
    expect(ble.aborted()).toBe(false)
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports one radio failing without settling, then resolves when the other delivers', async () => {
    const nearby = fakeRadio('nearby')
    const ble = fakeRadio('ble')
    const onError = jest.fn()
    const race = raceReceivers([nearby.transport, ble.transport], session, new AbortController().signal, onError)

    nearby.fail(new Error('connect timeout: no route to peer'))
    await expect(settledOrPending(race)).resolves.toBe('pending')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('nearby', expect.objectContaining({ message: 'connect timeout: no route to peer' }))
    expect(ble.aborted()).toBe(false)

    ble.deliver()
    await expect(race).resolves.toEqual(expect.objectContaining({ kind: 'ble' }))
  })

  it('rejects with the last error only once every radio has failed', async () => {
    const awdl = fakeRadio('awdl')
    const ble = fakeRadio('ble')
    const onError = jest.fn()
    const race = raceReceivers([awdl.transport, ble.transport], session, new AbortController().signal, onError)
    // Attach the rejection handler before failing anything so Jest never sees an unhandled rejection.
    const outcome = race.then(
      () => 'resolved' as const,
      (e: Error) => e.message
    )

    awdl.fail(new Error('bluetooth unavailable'))
    ble.fail(new Error('peer failed the session proof'))

    await expect(outcome).resolves.toBe('peer failed the session proof')
    expect(onError).toHaveBeenCalledTimes(2)
    expect(onError.mock.calls.map(([kind]) => kind)).toEqual(['awdl', 'ble'])
  })

  it('aborts every radio and rejects cancelled when the outer signal aborts', async () => {
    const awdl = fakeRadio('awdl')
    const ble = fakeRadio('ble')
    const onError = jest.fn()
    const controller = new AbortController()
    const race = raceReceivers([awdl.transport, ble.transport], session, controller.signal, onError)

    controller.abort()

    await expect(race).rejects.toThrow('cancelled')
    expect(awdl.aborted()).toBe(true)
    expect(ble.aborted()).toBe(true)
    // The listeners' own 'cancelled' rejections are consequences of the abort, not radio failures.
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not report a loser that rejects after being aborted', async () => {
    const awdl = fakeRadio('awdl')
    const ble = fakeRadio('ble')
    const onError = jest.fn()
    const race = raceReceivers([awdl.transport, ble.transport], session, new AbortController().signal, onError)

    awdl.deliver()
    await race
    // The fake rejects 'cancelled' synchronously inside abort(); give the microtask queue a turn.
    await Promise.resolve()
    expect(onError).not.toHaveBeenCalled()
  })

  it('declines a frame a second radio delivers after the race is already decided', async () => {
    const awdl = fakeRadio('awdl')
    const ble = fakeRadio('ble')
    const race = raceReceivers([awdl.transport, ble.transport], session, new AbortController().signal, jest.fn())

    awdl.deliver()
    await race
    // A resolve after abort cannot happen through socket.ts, but the arbitration
    // must still tell such a payer that nothing was written for its frame.
    ble.deliver()
    await Promise.resolve()
    expect(ble.confirm).toHaveBeenCalledWith(false, 'save_failed')
    expect(awdl.confirm).not.toHaveBeenCalled()
  })

  it('rejects immediately with nothing to listen on', async () => {
    await expect(raceReceivers([], session, new AbortController().signal, jest.fn())).rejects.toThrow(
      'no radio transports to listen on'
    )
  })

  it('rejects immediately on an already-aborted signal without starting a radio', async () => {
    const ble = fakeRadio('ble')
    const controller = new AbortController()
    controller.abort()
    await expect(raceReceivers([ble.transport], session, controller.signal, jest.fn())).rejects.toThrow('cancelled')
    expect(ble.started()).toBe(0)
  })
})
```

- [ ] **Step 11: Run it and watch it fail on the missing module**

```
npx jest packages/expo-wallet-toolbox/__tests__/localpay/race.test.ts
```

Expected: `Cannot find module '../../core/localpay/transport/race' from '__tests__/localpay/race.test.ts'`.

- [ ] **Step 12: Implement `raceReceivers`**

Create `packages/expo-wallet-toolbox/core/localpay/transport/race.ts`:

```ts
import type { Session } from '../session'
import type { LocalPaymentTransport, ReceivedFrame } from '../types'

export type RadioKind = 'awdl' | 'nearby' | 'ble'

/** The frame that won, and which radio carried it — `savePending` records the kind. */
export interface RaceWinner extends ReceivedFrame {
  kind: RadioKind
}

/**
 * Listen on every radio at once; the first delivered frame wins.
 *
 * Pure over the LocalPaymentTransport interface so the arbitration is testable
 * without a screen. One AbortController per transport; on the first
 * resolution the losers are aborted BEFORE the winner is handed back, so each
 * loser's own native stopListening() runs while the winner's held ack
 * connection — a different HybridObject on a different radio — is untouched
 * (spec §6).
 *
 * A rejection is non-terminal: it is reported through `onError` (so the screen
 * can show "Bluetooth is unavailable" while Wi-Fi keeps listening) and only
 * when EVERY radio has failed does the promise reject, with the last error.
 * Rejections that follow an abort — the losers' 'cancelled', or everything
 * after the outer signal fires — are consequences, not failures, and are not
 * reported.
 *
 * `qr` transports are skipped: the QR rung is driven by the UI, not by
 * receive() (core/localpay/qr.ts).
 */
export function raceReceivers(
  transports: readonly LocalPaymentTransport[],
  session: Session,
  signal: AbortSignal,
  onError: (kind: RadioKind, error: unknown) => void
): Promise<RaceWinner> {
  const radios = transports.filter(t => t.kind !== 'qr')
  if (radios.length === 0) return Promise.reject(new Error('no radio transports to listen on'))
  if (signal.aborted) return Promise.reject(new Error('cancelled'))

  return new Promise<RaceWinner>((resolve, reject) => {
    let settled = false
    let failures = 0
    let lastError: unknown = new Error('every radio listener failed')
    const controllers = radios.map(() => new AbortController())

    const abortAll = (except?: AbortController) => {
      for (const c of controllers) if (c !== except && !c.signal.aborted) c.abort()
    }
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () =>
      finish(() => {
        abortAll()
        reject(new Error('cancelled'))
      })
    signal.addEventListener('abort', onAbort)

    radios.forEach((transport, i) => {
      const controller = controllers[i]
      const kind = transport.kind as RadioKind
      transport.receive(session, controller.signal).then(
        received => {
          if (settled) {
            // The race was already decided (or aborted) when this frame landed.
            // Nothing will ever be written for it, so it is a provable decline —
            // the payer must release its inputs rather than rest on a green
            // "Sent" until its own timeout.
            void received.confirm(false, 'save_failed')
            return
          }
          finish(() => {
            abortAll(controller)
            resolve({ kind, frame: received.frame, confirm: received.confirm })
          })
        },
        error => {
          if (settled || controller.signal.aborted) return
          failures += 1
          lastError = error
          onError(kind, error)
          if (failures === radios.length) finish(() => reject(lastError))
        }
      )
    })
  })
}
```

- [ ] **Step 13: Run the race tests**

```
npx jest packages/expo-wallet-toolbox/__tests__/localpay/race.test.ts
```

Expected: `Tests: 8 passed, 8 total`.

- [ ] **Step 14: Export the new helpers through both barrels and typecheck**

Open `packages/expo-wallet-toolbox/core/pay/rails/nearby.ts`. Task 7 added `export { capsFromProbe, probeDeviceCaps, readBluetoothState, type BluetoothState, type DeviceProbe } from '../../localpay/deviceCaps'` — add `prepareBle,` to that export list (after `capsFromProbe,`). Then add, directly after the `export { bleTransport } from '../../localpay/transport/ble'` line:

```ts
export { raceReceivers, type RaceWinner, type RadioKind } from '../../localpay/transport/race'
```

Open `packages/expo-wallet-toolbox/core/index.ts`. In the hand-written `export { … } from './pay/rails/nearby'` block (Task 7 already added `bleTransport`, `localSupportsBle`, `describeFloor`, `requestBlePermissions`, `probeDeviceCaps`, `capsFromProbe`, `readBluetoothState`, `CAP_BLE` and the types there), add these four names to the same list (the values after `readBluetoothState,`, the types after `type BluetoothState,`):

```ts
  prepareBle,
  raceReceivers,
  type RaceWinner,
  type RadioKind,
```

Typecheck:

```
npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep "error TS" | grep -v "core/pay/rails/handle.ts\|ui/components/pay/HandleReceive.tsx"
```

Expected: no output. (The four pre-existing, unrelated `TS2345` errors in `core/pay/rails/handle.ts` and `ui/components/pay/HandleReceive.tsx` are filtered away; nothing this task touches may add a line.) A `TS2308` here means a name is exported twice — `core/index.ts` also has `export * from './localpay/…'` lines near :57-62; the new names live only in files that are NOT star-exported (`deviceCaps.ts`, `transport/race.ts`), so if you hit TS2308, remove whichever duplicate you added, never the existing lines.

- [ ] **Step 15: Commit the core helpers**

```
git add packages/expo-wallet-toolbox/core/localpay/deviceCaps.ts packages/expo-wallet-toolbox/core/localpay/transport/race.ts packages/expo-wallet-toolbox/core/pay/rails/nearby.ts packages/expo-wallet-toolbox/core/index.ts packages/expo-wallet-toolbox/__tests__/localpay/prepareBle.test.ts packages/expo-wallet-toolbox/__tests__/localpay/race.test.ts
git commit -m "feat(localpay): prepareBle and the multi-listener race

prepareBle wraps the one native call that may show the iOS Bluetooth
prompt so NearbyFlow never imports the native package (its prompt-free
sibling readBluetoothState landed with deviceCaps). raceReceivers is
the payee's first-frame-wins arbitration over any set of radio
transports, pure over LocalPaymentTransport so it is tested without a
screen: losers are aborted before the winner is handed back, and a
single radio failing is reported but never terminal.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: one commit touching six files (two new tests, `race.ts`, `deviceCaps.ts`, both barrels); `git log -1 --format=%s` prints `feat(localpay): prepareBle and the multi-listener race`.

- [ ] **Step 16: Add the six copy keys to all twelve language blocks**

Open `packages/expo-wallet-toolbox/core/i18n/translations.tsx`. Each language block has exactly one line beginning `      local_pay_radio_fallback:` — `grep -n local_pay_radio_fallback packages/expo-wallet-toolbox/core/i18n/translations.tsx` lists the twelve anchors in block order (en, zh, hi, es, fr, ar, pt, bn, ru, id, ja, pl). Insert the six lines for that language IMMEDIATELY AFTER its anchor line. Work from the bottom (pl) upwards so the earlier line numbers stay valid, or re-run the grep after each insertion.

`en` (after :714):
```ts
      local_pay_floor_peer_bt_off: 'Their Bluetooth is off, so this payment will go by code.',
      local_pay_floor_local_bt_off: 'Your Bluetooth is off. Turn it on for a faster nearby link.',
      local_pay_floor_local_ble_denied: 'Bluetooth access is off for BSV Wallet. Allow it in Settings for a faster nearby link.',
      local_pay_floor_cross_os: 'The other device cannot use Bluetooth right now, so this payment will go by code.',
      local_pay_floor_peer_no_radio: 'The other device is not listening for a wireless link, so this payment will go by code.',
      local_pay_ble_unavailable: 'Bluetooth is unavailable. The code above still works.',
```

`zh` (after :1230):
```ts
      local_pay_floor_peer_bt_off: '对方的蓝牙已关闭，此付款将通过二维码完成。',
      local_pay_floor_local_bt_off: '你的蓝牙已关闭。开启后可获得更快的近距离连接。',
      local_pay_floor_local_ble_denied: 'BSV Wallet 的蓝牙访问权限已关闭。请在“设置”中允许，以获得更快的近距离连接。',
      local_pay_floor_cross_os: '对方设备目前无法使用蓝牙，此付款将通过二维码完成。',
      local_pay_floor_peer_no_radio: '对方设备未在监听无线连接，此付款将通过二维码完成。',
      local_pay_ble_unavailable: '蓝牙不可用。上方的二维码仍然有效。',
```

`hi` (after :1749):
```ts
      local_pay_floor_peer_bt_off: 'उनका ब्लूटूथ बंद है, इसलिए यह भुगतान कोड से होगा।',
      local_pay_floor_local_bt_off: 'आपका ब्लूटूथ बंद है। तेज़ नज़दीकी लिंक के लिए इसे चालू करें।',
      local_pay_floor_local_ble_denied: 'BSV Wallet के लिए ब्लूटूथ एक्सेस बंद है। तेज़ नज़दीकी लिंक के लिए इसे सेटिंग्स में अनुमति दें।',
      local_pay_floor_cross_os: 'दूसरा डिवाइस अभी ब्लूटूथ का उपयोग नहीं कर सकता, इसलिए यह भुगतान कोड से होगा।',
      local_pay_floor_peer_no_radio: 'दूसरा डिवाइस वायरलेस लिंक के लिए सुन नहीं रहा है, इसलिए यह भुगतान कोड से होगा।',
      local_pay_ble_unavailable: 'ब्लूटूथ उपलब्ध नहीं है। ऊपर दिया गया कोड अब भी काम करता है।',
```

`es` (after :2271):
```ts
      local_pay_floor_peer_bt_off: 'Su Bluetooth está apagado, así que este pago se hará por código.',
      local_pay_floor_local_bt_off: 'Tu Bluetooth está apagado. Actívalo para un enlace cercano más rápido.',
      local_pay_floor_local_ble_denied: 'El acceso a Bluetooth está desactivado para BSV Wallet. Permítelo en Configuración para un enlace cercano más rápido.',
      local_pay_floor_cross_os: 'El otro dispositivo no puede usar Bluetooth ahora mismo, así que este pago se hará por código.',
      local_pay_floor_peer_no_radio: 'El otro dispositivo no está a la escucha de un enlace inalámbrico, así que este pago se hará por código.',
      local_pay_ble_unavailable: 'Bluetooth no está disponible. El código de arriba sigue funcionando.',
```

`fr` (after :2787):
```ts
      local_pay_floor_peer_bt_off: 'Leur Bluetooth est désactivé, ce paiement passera donc par le code.',
      local_pay_floor_local_bt_off: 'Votre Bluetooth est désactivé. Activez-le pour une liaison de proximité plus rapide.',
      local_pay_floor_local_ble_denied: 'L’accès au Bluetooth est désactivé pour BSV Wallet. Autorisez-le dans Réglages pour une liaison de proximité plus rapide.',
      local_pay_floor_cross_os: 'L’autre appareil ne peut pas utiliser le Bluetooth pour le moment, ce paiement passera donc par le code.',
      local_pay_floor_peer_no_radio: 'L’autre appareil n’attend pas de liaison sans fil, ce paiement passera donc par le code.',
      local_pay_ble_unavailable: 'Le Bluetooth est indisponible. Le code ci-dessus fonctionne toujours.',
```

`ar` (after :3299):
```ts
      local_pay_floor_peer_bt_off: 'بلوتوث الجهاز الآخر مُغلق، لذا ستتم هذه الدفعة عبر الرمز.',
      local_pay_floor_local_bt_off: 'بلوتوث جهازك مُغلق. شغّله للحصول على اتصال قريب أسرع.',
      local_pay_floor_local_ble_denied: 'الوصول إلى البلوتوث مُعطَّل لتطبيق BSV Wallet. اسمح به من الإعدادات للحصول على اتصال قريب أسرع.',
      local_pay_floor_cross_os: 'لا يمكن للجهاز الآخر استخدام البلوتوث الآن، لذا ستتم هذه الدفعة عبر الرمز.',
      local_pay_floor_peer_no_radio: 'الجهاز الآخر لا يستمع لاتصال لاسلكي، لذا ستتم هذه الدفعة عبر الرمز.',
      local_pay_ble_unavailable: 'البلوتوث غير متاح. الرمز أعلاه ما زال يعمل.',
```

`pt` (after :3814):
```ts
      local_pay_floor_peer_bt_off: 'O Bluetooth deles está desligado, então este pagamento será feito por código.',
      local_pay_floor_local_bt_off: 'Seu Bluetooth está desligado. Ligue-o para um link por perto mais rápido.',
      local_pay_floor_local_ble_denied: 'O acesso ao Bluetooth está desativado para o BSV Wallet. Permita-o em Ajustes para um link por perto mais rápido.',
      local_pay_floor_cross_os: 'O outro aparelho não pode usar Bluetooth agora, então este pagamento será feito por código.',
      local_pay_floor_peer_no_radio: 'O outro aparelho não está aguardando um link sem fio, então este pagamento será feito por código.',
      local_pay_ble_unavailable: 'O Bluetooth está indisponível. O código acima continua funcionando.',
```

`bn` (after :4328):
```ts
      local_pay_floor_peer_bt_off: 'তাদের ব্লুটুথ বন্ধ, তাই এই পেমেন্ট কোডের মাধ্যমে হবে।',
      local_pay_floor_local_bt_off: 'আপনার ব্লুটুথ বন্ধ। দ্রুততর কাছাকাছি লিঙ্কের জন্য এটি চালু করুন।',
      local_pay_floor_local_ble_denied: 'BSV Wallet-এর জন্য ব্লুটুথ অ্যাক্সেস বন্ধ। দ্রুততর কাছাকাছি লিঙ্কের জন্য সেটিংসে এটি অনুমোদন করুন।',
      local_pay_floor_cross_os: 'অন্য ডিভাইসটি এখন ব্লুটুথ ব্যবহার করতে পারছে না, তাই এই পেমেন্ট কোডের মাধ্যমে হবে।',
      local_pay_floor_peer_no_radio: 'অন্য ডিভাইসটি ওয়্যারলেস লিঙ্কের জন্য শুনছে না, তাই এই পেমেন্ট কোডের মাধ্যমে হবে।',
      local_pay_ble_unavailable: 'ব্লুটুথ পাওয়া যাচ্ছে না। উপরের কোডটি এখনও কাজ করে।',
```

`ru` (after :4844):
```ts
      local_pay_floor_peer_bt_off: 'У них выключен Bluetooth, поэтому этот платёж пройдёт по коду.',
      local_pay_floor_local_bt_off: 'У вас выключен Bluetooth. Включите его для более быстрой связи поблизости.',
      local_pay_floor_local_ble_denied: 'Доступ к Bluetooth для BSV Wallet выключен. Разрешите его в «Настройках» для более быстрой связи поблизости.',
      local_pay_floor_cross_os: 'Другое устройство сейчас не может использовать Bluetooth, поэтому этот платёж пройдёт по коду.',
      local_pay_floor_peer_no_radio: 'Другое устройство не ожидает беспроводного соединения, поэтому этот платёж пройдёт по коду.',
      local_pay_ble_unavailable: 'Bluetooth недоступен. Код выше всё ещё работает.',
```

`id` (after :5359):
```ts
      local_pay_floor_peer_bt_off: 'Bluetooth mereka mati, jadi pembayaran ini akan dilakukan lewat kode.',
      local_pay_floor_local_bt_off: 'Bluetooth Anda mati. Nyalakan untuk tautan terdekat yang lebih cepat.',
      local_pay_floor_local_ble_denied: 'Akses Bluetooth untuk BSV Wallet nonaktif. Izinkan di Pengaturan untuk tautan terdekat yang lebih cepat.',
      local_pay_floor_cross_os: 'Perangkat lain tidak dapat menggunakan Bluetooth saat ini, jadi pembayaran ini akan dilakukan lewat kode.',
      local_pay_floor_peer_no_radio: 'Perangkat lain tidak menunggu tautan nirkabel, jadi pembayaran ini akan dilakukan lewat kode.',
      local_pay_ble_unavailable: 'Bluetooth tidak tersedia. Kode di atas tetap berfungsi.',
```

`ja` (after :5889):
```ts
      local_pay_floor_peer_bt_off: '相手のBluetoothがオフのため、この支払いはコードで行います。',
      local_pay_floor_local_bt_off: 'Bluetoothがオフです。オンにすると、より速い近距離リンクが使えます。',
      local_pay_floor_local_ble_denied: 'BSV WalletのBluetoothアクセスがオフです。「設定」で許可すると、より速い近距離リンクが使えます。',
      local_pay_floor_cross_os: '相手の端末は現在Bluetoothを使えないため、この支払いはコードで行います。',
      local_pay_floor_peer_no_radio: '相手の端末は無線リンクを待ち受けていないため、この支払いはコードで行います。',
      local_pay_ble_unavailable: 'Bluetoothを利用できません。上のコードは引き続き使えます。',
```

`pl` (after :6419):
```ts
      local_pay_floor_peer_bt_off: 'Ich Bluetooth jest wyłączony, więc ta płatność przejdzie przez kod.',
      local_pay_floor_local_bt_off: 'Twój Bluetooth jest wyłączony. Włącz go, aby uzyskać szybsze połączenie w pobliżu.',
      local_pay_floor_local_ble_denied: 'Dostęp do Bluetooth dla BSV Wallet jest wyłączony. Zezwól na niego w Ustawieniach, aby uzyskać szybsze połączenie w pobliżu.',
      local_pay_floor_cross_os: 'Drugie urządzenie nie może teraz używać Bluetooth, więc ta płatność przejdzie przez kod.',
      local_pay_floor_peer_no_radio: 'Drugie urządzenie nie oczekuje połączenia bezprzewodowego, więc ta płatność przejdzie przez kod.',
      local_pay_ble_unavailable: 'Bluetooth jest niedostępny. Kod powyżej nadal działa.',
```

Verify parity — each of the six keys must appear exactly 12 times:

```
for k in local_pay_floor_peer_bt_off local_pay_floor_local_bt_off local_pay_floor_local_ble_denied local_pay_floor_cross_os local_pay_floor_peer_no_radio local_pay_ble_unavailable; do printf '%s ' "$k"; grep -c "^      $k:" packages/expo-wallet-toolbox/core/i18n/translations.tsx; done
```

Expected: six lines, each ending in `12`. Then `npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep "error TS" | grep -v "core/pay/rails/handle.ts\|ui/components/pay/HandleReceive.tsx"` — expected no output (`TranslationKey` is derived from the `en` block, so a typo in a non-English block does not fail tsc; the grep is what catches that).

- [ ] **Step 17: Commit the copy**

```
git add packages/expo-wallet-toolbox/core/i18n/translations.tsx
git commit -m "feat(pay): floor-reason and Bluetooth-unavailable copy in twelve languages

Five sentences for the payer's confirm screen saying why a pair landed
on the fountain (peer Bluetooth off, local Bluetooth off, local access
denied, cross-OS without BLE, peer not listening) and one advisory for
the payee when the BLE listener gives up.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: one commit touching only `translations.tsx`; `git log -1 --format=%s` prints `feat(pay): floor-reason and Bluetooth-unavailable copy in twelve languages`.

- [ ] **Step 18: NearbyFlow — header, imports, and the floor-copy key table**

Open `packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx`.

(a) Header. Replace lines 8-10:

```
 *   AWDL    iOS↔iOS peer-to-peer Wi-Fi, TLS-PSK. Fast path.
 *   Nearby  Android↔Android over Google Nearby Connections, same Nitro surface.
 *   QR      any platform pair. The payer renders the signed frame; the payee scans it.
```

with

```
 *   AWDL    iOS↔iOS peer-to-peer Wi-Fi, TLS-PSK. Fast path.
 *   Nearby  Android↔Android over Google Nearby Connections, same Nitro surface.
 *   BLE     any platform pair, over a second Nitro object (bsvpay-ble/1). The only
 *           radio that crosses iOS↔Android; the session QR is its pairing step.
 *   QR      any platform pair. The payer renders the signed frame; the payee scans it.
```

and lines 15-17:

```
 *    │      receive_wait always renders the pairing QR, and additionally runs a
 *    │      radio listener (AWDL or Nearby) when this device supports one. Either
 *    │      arrival lands in:
```

with

```
 *    │      receive_wait always renders the pairing QR, and additionally runs one
 *    │      listener per radio this device can offer (AWDL or Nearby, plus BLE);
 *    │      the first frame to arrive wins and the other listeners are aborted
 *    │      (raceReceivers). Either arrival lands in:
```

and line 21:

```
 *           ├─ selectTransport() === 'awdl' | 'nearby' → radio.send → done
```

with

```
 *           ├─ selectTransport() === 'awdl' | 'nearby' | 'ble' → radio.send → done
```

(b) Imports. In the `import { … } from '@bsv/expo-wallet-toolbox'` block (lines 99-153 before the header edit; it starts `useTheme,` and ends `type VerifiedPayment`), add these names, keeping the list's rough alphabetical order (insert each next to its neighbours as shown):

```ts
  awdlTransport,
  bleTransport,
  buildPaymentFrame,
  capsFromProbe,
  decodeSession,
  describeFloor,
  encodeSession,
```
```ts
  localSupportsAwdl,
  localSupportsBle,
  localSupportsNearby,
```
```ts
  nextPhaseAfterUnsealFailure,
  prepareBle,
  probeDeviceCaps,
  processPending,
  raceReceivers,
  readBluetoothState,
  requestBlePermissions,
  requestNearbyPermissions,
```
```ts
  type Ack,
  type BluetoothState,
  type ConfirmDelivery,
  type DeclineReason,
  type FloorReason,
  type LocalPaymentTransport,
  type PaymentFrame,
  type RadioKind,
  type Session,
```

`NearbyFlow` must NOT import `react-native-localpay-transport` — `grep -n "localpay-transport" packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx` must stay empty.

(c) Floor copy table. Directly after the `DECLINE_KEYS` const (lines 311-316; ends with `}` just before `const NOTICE_ICONS`), add:

```ts

/**
 * Why the payer is on the fountain, as one sentence they can act on. Only ever
 * rendered when selectTransport() chose QR (spec §5) — this is what the hint
 * bits in the payee's code buy: the person paying is told what to switch on
 * instead of watching a slow fountain in silence.
 */
const FLOOR_KEYS: Record<Exclude<FloorReason, 'none'>, string> = {
  peer_no_radio: 'local_pay_floor_peer_no_radio',
  peer_bt_off: 'local_pay_floor_peer_bt_off',
  local_ble_denied: 'local_pay_floor_local_ble_denied',
  local_bt_off: 'local_pay_floor_local_bt_off',
  cross_os_no_ble: 'local_pay_floor_cross_os'
}
```

- [ ] **Step 19: NearbyFlow — per-radio errors, Bluetooth state, permissions, `radioTransports`**

(a) Replace the `nearbyError` state (lines 441-447 before the edits above, i.e. the JSDoc beginning `The AWDL fast path gave up.` through `useState<{ networkDenied: boolean } | null>(null)`) with:

```ts
  /**
   * A radio listener gave up, per radio. Non-fatal by design — the pairing QR
   * is still on screen and a QR-path payer can still complete, and any OTHER
   * radio still listening keeps the request live on that rung. Keyed by kind so
   * the presence row can say "waiting" while one radio is alive and the notice
   * can name the one that is not.
   */
  const [radioErrors, setRadioErrors] = useState<Partial<Record<RadioKind, { networkDenied: boolean }>>>({})

  /**
   * What this device's Bluetooth radio reported. The payee learns it from
   * prepareBle() at minting (the one call that may show the iOS prompt); the
   * payer reads it prompt-free on scanning a session, so describeFloor can say
   * "your Bluetooth is off" without ever prompting someone about to pay by code.
   */
  const [bleState, setBleState] = useState<BluetoothState>('unknown')
  /**
   * Android's runtime grants for BLE landed (or are not needed: iOS gates BLE
   * through prepare() instead). Nearby's grant set is a superset of BLE's on
   * every API level, so on a GMS device the one Nearby prompt answers both.
   */
  const [blePermitted, setBlePermitted] = useState(Platform.OS !== 'android')
```

(b) Replace the Nearby permission block and `radioTransport` memo (lines 501-523: the JSDoc beginning `Nearby is usable only once BOTH hold` through the closing `)` of `const radioTransport = useMemo(`) with:

```ts
  /**
   * Nearby is usable only once BOTH hold: GMS is present (localSupportsNearby)
   * and the runtime grants landed. Resolved async on mount, Android only; a
   * denial leaves this false and the flow QR-only, silently — same posture as
   * a GMS-less device.
   *
   * Spec §7: at flow entry the payee asks for Nearby's grants where GMS is
   * present (that set covers BLE too), and otherwise for BLE's alone. The payer
   * is never prompted for BLE here — executeSend asks lazily, only once BLE has
   * actually been selected, so a payer landing on QR sees no prompt.
   */
  const [nearbyReady, setNearbyReady] = useState(false)
  useEffect(() => {
    if (Platform.OS !== 'android') return
    let live = true
    if (localSupportsNearby()) {
      void requestNearbyPermissions().then(granted => {
        if (!live) return
        setNearbyReady(granted)
        setBlePermitted(granted)
      })
    } else if (initialRole === 'payee' && localSupportsBle()) {
      // localSupportsBle() is false while the radio is off (Task 9's isSupported
      // reads BluetoothAdapter.isEnabled), so a GMS-less payee who enters with
      // Bluetooth off stays QR-only until the screen is re-entered — the same
      // posture as a Nearby denial.
      void requestBlePermissions().then(granted => {
        if (live) setBlePermitted(granted)
      })
    }
    return () => {
      live = false
    }
  }, [initialRole])

  /** BLE can be listened on: radio powered on and (on Android) the grants landed. */
  const bleReady = bleState === 'poweredOn' && blePermitted

  /**
   * Every radio this device listens on as payee. The platform socket radio
   * (AWDL on iOS, Nearby on Android — they share one native object, so never
   * both) plus BLE when it is ready. Empty means QR-only. Order is irrelevant:
   * raceReceivers starts all of them and the first frame wins (spec §6).
   */
  const radioTransports = useMemo<LocalPaymentTransport[]>(() => {
    const list: LocalPaymentTransport[] = []
    if (supportsAwdl) list.push(awdlTransport)
    else if (nearbyReady) list.push(nearbyTransport)
    if (bleReady) list.push(bleTransport)
    return list
  }, [supportsAwdl, nearbyReady, bleReady])
```

(c) In `reset` (was line 605), replace `    setNearbyError(null)` with `    setRadioErrors({})`. `bleState` is deliberately NOT reset: it is a fact about this device, not about a request.

- [ ] **Step 20: NearbyFlow — thread the winning radio into `settleReceived`**

(a) Change the `settleReceived` signature (was lines 644-645):

```ts
  const settleReceived = useCallback(
    async (frame: PaymentFrame, session: Session, confirm?: ConfirmDelivery) => {
```

to

```ts
  const settleReceived = useCallback(
    async (frame: PaymentFrame, session: Session, confirm?: ConfirmDelivery, via?: RadioKind) => {
```

(b) Replace the `savePending` comment and call (was lines 780-790, from `//     `confirm` is only ever supplied by a radio receive path` through the `await savePending(...)` line) with:

```ts
        //     `confirm` is only ever supplied by a radio receive path (the
        //     listener effect above; the QR/retry callers below omit it) — the
        //     same signal `Unsettled` already keys off of, reused here to
        //     attribute the queue row to a transport. `via` is the radio
        //     raceReceivers reported as the winner; the 'awdl' fallback covers
        //     only the (unreachable in practice) case of a confirm handle with
        //     no winner attached.
        await savePending(storage, frame, confirm ? (via ?? 'awdl') : 'qr')
```

(c) In the dependency array of `settleReceived` (was line 896), replace

```ts
    [storage, wallet, adminOriginator, radioTransport, fail, t]
```

with

```ts
    [storage, wallet, adminOriginator, fail, t]
```

- [ ] **Step 21: NearbyFlow — the multi-listener effect**

Replace the whole listener effect (was lines 906-947: from the comment block `// ── Receive: AWDL listener ──` through `}, [hostedSession, focused, radioTransport, listenerEpoch])`) with:

```ts
  // ── Receive: radio listeners ──
  //
  // One listener per radio this device offers, all started together; the first
  // frame wins and the rest are aborted before settle (raceReceivers, spec §6).
  // The pairing QR is rendered regardless, so a QR-path payer can always
  // complete against the same session.

  useEffect(() => {
    if (!hostedSession || !focused) return
    if (radioTransports.length === 0) return

    // The Set identity is stable for the component's lifetime, but capture it so
    // the cleanup never reaches through a ref that may have been reassigned.
    const registry = abortsRef.current
    const controller = new AbortController()
    registry.add(controller)
    setRadioErrors({})

    raceReceivers(radioTransports, hostedSession, controller.signal, (kind, e) => {
      if (controller.signal.aborted) return
      // Never terminal. Every radio is an optional fast path; one failing must
      // not unmount the pairing QR a QR-path payer is relying on, nor stop the
      // other radios. One native error site also fires on a failed ack AFTER
      // the frame reached JS, so flipping to a failure screen here could
      // contradict a settle already in flight. The Local Network heuristic is
      // about Wi-Fi radios only — a BLE failure never offers that Settings route.
      setRadioErrors(prev => ({
        ...prev,
        [kind]: { networkDenied: kind !== 'ble' && looksLikeLocalNetworkDenial(messageOf(e)) }
      }))
    })
      .then(({ kind, frame, confirm }) => {
        if (controller.signal.aborted) {
          // The screen went away between delivery and here. The payer is
          // holding an un-acked connection and nothing was written, so tell it
          // rather than leaving it to time out on a green "Sent".
          void confirm(false, 'save_failed')
          return
        }
        void settleRef.current(frame, hostedSession, confirm, kind)
      })
      .catch(() => {
        // Every radio has already been reported through onError above (or the
        // effect was torn down). Nothing further to show.
      })

    return () => {
      controller.abort()
      registry.delete(controller)
    }
  }, [hostedSession, focused, radioTransports, listenerEpoch])
```

- [ ] **Step 22: NearbyFlow — mint with the device probe and BLE prepare**

Replace the body of `startRequest` (was lines 951-993) with:

```ts
  const startRequest = useCallback(async () => {
    // Zero (or blank) is the user asking the payer to choose, so it becomes an
    // open session rather than a rejected input. Undefined, never 0 — the codec
    // refuses a non-positive amount precisely so a corrupt zero can never be
    // read back as "any amount".
    const requested = satsFrom(requestAmount)
    const sats = requested > 0 ? requested : undefined
    // Gate on storage too, not just the wallet. Advertising with storage null
    // means a payer can deliver a frame the payee then cannot persist, after the
    // transport has already acked it as accepted.
    if (!wallet || !storage) {
      fail('generic', t('wallet_not_ready'))
      return
    }
    setPhase('receive_minting')
    setRadioErrors({})
    setSessionQrBroken(false)
    setSessionMismatch(false)
    try {
      // Prompt-free and re-read on every mint, unlike supportsAwdl (whose probe
      // can raise the Local Network prompt): a radio switched on since the last
      // request must be picked up without leaving the screen. `notDetermined`
      // on iOS counts as supported so the prompt can follow inside prepareBle.
      const bleHere = localSupportsBle()
      // Everything the request needs, in parallel (spec §4): the identity key,
      // the two wallet nonces, the prompt-free device probe and — only where
      // this device has a BLE radio — the one call that may show the iOS
      // Bluetooth prompt. It appears here, at the moment the user has asked to
      // receive a nearby payment, the same moment the Local Network prompt
      // already can. Minting is never slower than the slowest of these, and
      // both probes are bounded (BLE_PREPARE_TIMEOUT_MS, DEFAULT_NET_BUDGET_MS).
      const [{ publicKey: identityKey }, derivationPrefix, derivationSuffix, probe, bleNow] = await Promise.all([
        wallet.getPublicKey({ identityKey: true }, adminOriginator),
        createNonce(wallet, 'self', adminOriginator),
        createNonce(wallet, 'self', adminOriginator),
        probeDeviceCaps(),
        bleHere ? prepareBle() : Promise.resolve<BluetoothState>('unsupported')
      ])
      setBleState(bleNow)
      // Advertise BLE only where this device will actually listen on it: radio
      // powered on AND (Android) the runtime grants landed. A CAP_BLE bit with
      // no advertiser behind it would walk every cross-OS payer into a 6 s
      // connect timeout before the fountain.
      const bleLive = bleNow === 'poweredOn' && blePermitted
      const session = mintSession({
        identityKey,
        amount: sats,
        derivationPrefix,
        derivationSuffix,
        // Caps advertise what this payee can DO; the payer's ladder picks the
        // highest rung both sides share, QR being the floor.
        supportsAwdl,
        supportsNearby: nearbyReady,
        supportsBle: bleLive,
        // prepare() settles the Bluetooth answer the prompt-free probe may have
        // read as 'unknown' a moment earlier, so where it ran it overrides the
        // probe's field. The hint bits are copy for the payer, not dispatch.
        hints: capsFromProbe({ ...probe, bluetooth: bleHere ? bleNow : probe.bluetooth }),
        os: Platform.OS === 'ios' ? 'ios' : 'android'
      })
      setRole('payee')
      setHostedSession(session)
      setPhase('receive_wait')
    } catch (e) {
      fail('generic', messageOf(e))
    }
  }, [requestAmount, wallet, storage, adminOriginator, supportsAwdl, nearbyReady, blePermitted, fail, t])
```

(`setBleState` and `setHostedSession` are issued in the same continuation; React 18 batches them, so `radioTransports` and `hostedSession` change together and the listener effect starts every radio in one pass. If they ever did not, the effect would simply restart once — aborting a listener that had not yet received anything, which is harmless.)

- [ ] **Step 23: NearbyFlow — payer: Bluetooth state at scan, floor reason, lazy BLE grant, radio pick**

(a) In `onSessionScanned` (was lines 1044-1061), directly after `setScannedSession(session)` add:

```ts
      // Prompt-free read of this device's Bluetooth state for describeFloor.
      // Never prepare() here: a payer who lands on QR must never be prompted.
      setBleState(readBluetoothState())
```

(b) Directly after the `sendKind` memo (was line 1074, `const sendKind = useMemo(...)`), add:

```ts

  /**
   * Why this payer is on the fountain, if it is. Evaluated only once
   * selectTransport() chose QR (spec §5); 'none' otherwise, and 'none' when the
   * hint bits explain nothing — the confirm screen then says nothing extra.
   */
  const floorReason = useMemo<FloorReason>(
    () =>
      sendKind === 'qr' && scannedSession
        ? describeFloor(scannedSession, { os: Platform.OS === 'ios' ? 'ios' : 'android', bluetooth: bleState })
        : 'none',
    [sendKind, scannedSession, bleState]
  )
```

(c) In `executeSend`, replace (was lines 1198-1204):

```ts
      // sendKind is neither 'qr' (returned above) nor null (guarded at the top
      // of this callback), so it names one of the two radios here.
      const radio = sendKind === 'awdl' ? awdlTransport : nearbyTransport

      let ack: Ack
      try {
        ack = await radio.send(session, built.frame, controller.signal)
```

with

```ts
      // sendKind is neither 'qr' (returned above) nor null (guarded at the top
      // of this callback), so it names one of the three radios here.
      const radio = sendKind === 'awdl' ? awdlTransport : sendKind === 'nearby' ? nearbyTransport : bleTransport

      let ack: Ack
      try {
        // Android asks for the BLE runtime grants lazily, here, so a payer who
        // lands on QR is never prompted (spec §7). A refusal is treated exactly
        // like a radio failure — the catch below falls to the fountain with
        // local_pay_radio_fallback — so its wording deliberately avoids every
        // word looksLikeLocalNetworkDenial matches (no "denied").
        if (sendKind === 'ble' && Platform.OS === 'android' && !(await requestBlePermissions())) {
          throw new Error('bluetooth permission not granted')
        }
        ack = await radio.send(session, built.frame, controller.signal)
```

The `executeSend` dependency array is unchanged: `requestBlePermissions`, `bleTransport` and `Platform` are module-level imports.

- [ ] **Step 24: NearbyFlow — `radioActive`, presence, and the medium**

(a) Replace (was line 1497):

```ts
  const radioActive = hostedSession !== null && radioTransport !== null && nearbyError === null
```

with

```ts
  /** Radios that have given up, in a render-friendly shape. */
  const radioFailures = useMemo(
    () =>
      (Object.entries(radioErrors) as [RadioKind, { networkDenied: boolean } | undefined][]).filter(
        (entry): entry is [RadioKind, { networkDenied: boolean }] => entry[1] !== undefined
      ),
    [radioErrors]
  )
  /** Listening over at least one radio link right now. Goes false once every fast path gives up. */
  const radioActive = hostedSession !== null && radioTransports.some(tr => !radioErrors[tr.kind as RadioKind])
```

(b) In the `presence` memo (was lines 1509-1550), replace

```ts
      // Every payer branch degrades to `qr` when the QR transport was selected,
      // because on that path the two devices genuinely never speak. `awdl` and
      // `nearby` are both live radio links (iOS and Android respectively), so
      // either counts here.
      const onRadio = sendKind === 'awdl' || sendKind === 'nearby'
```

with

```ts
      // Every payer branch degrades to `qr` when the QR transport was selected,
      // because on that path the two devices genuinely never speak. `awdl`,
      // `nearby` and `ble` are all live radio links, so any of them counts here.
      const onRadio = sendKind === 'awdl' || sendKind === 'nearby' || sendKind === 'ble'
```

(c) Directly after the `presence` memo's closing `}, [phase, role, linked, radioActive, sendKind, t])`, add:

```ts

  /**
   * Which radio the presence row's glyph names. The payee shows Bluetooth only
   * when BLE is the ONLY radio still listening — while Wi-Fi is alive it is the
   * faster rung and the one a same-OS payer will land on. The payer shows the
   * rung the ladder actually picked (spec §6).
   */
  const presenceMedium = useMemo<'wifi' | 'bluetooth'>(() => {
    if (role === 'payer') return sendKind === 'ble' ? 'bluetooth' : 'wifi'
    const live = radioTransports.filter(tr => !radioErrors[tr.kind as RadioKind])
    return live.length > 0 && live.every(tr => tr.kind === 'ble') ? 'bluetooth' : 'wifi'
  }, [role, sendKind, radioTransports, radioErrors])
```

(d) Replace `presenceBlock` (was lines 1586-1590):

```tsx
  const presenceBlock = presence ? (
    <View style={styles.presenceSlot}>
      <PresenceRow state={presence.state} label={presence.label} peer={peerName} medium={presenceMedium} />
    </View>
  ) : null
```

- [ ] **Step 25: NearbyFlow — the two render sites**

(a) receive_wait. Replace (was lines 1807-1835, from the comment `{/* The fast path gave up.` through the `)}` that closes `{nearbyError?.networkDenied && (`) with:

```tsx
            {/* A radio gave up. The request is still live over QR — and over
                any other radio still listening — so each of these is an
                advisory, not a failure: the pairing QR above still works. */}
            {radioFailures.map(([kind, err]) => (
              <React.Fragment key={kind}>
                <View style={styles.gapLg} />
                <Animated.View
                  entering={fadeIn}
                  style={[styles.notice, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}
                >
                  <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
                  <Text style={[styles.noticeText, { color: colors.textSecondary }]}>
                    {err.networkDenied
                      ? t('local_pay_network_denied')
                      : kind === 'ble'
                        ? t('local_pay_ble_unavailable')
                        : t('local_pay_nearby_unavailable')}
                  </Text>
                </Animated.View>
              </React.Fragment>
            ))}

            <View style={styles.gapXl} />
            {radioFailures.some(([, err]) => err.networkDenied) && (
              <>
                <SecondaryButton
                  styles={styles}
                  colors={colors}
                  icon="settings-outline"
                  label={t('open_settings')}
                  onPress={() => void Linking.openSettings()}
                />
                <View style={styles.gapMd} />
              </>
            )}
```

(b) send_confirm. Inside `{phase === 'send_confirm' && scannedSession && (`, the presence slot reads (was lines 1874-1875):

```tsx
            <View style={styles.gapLg} />
            {presenceBlock}
```

Directly after that `{presenceBlock}` line add:

```tsx
            {floorReason !== 'none' && (
              <>
                <View style={styles.gapLg} />
                {supportText(t(FLOOR_KEYS[floorReason]))}
                {floorReason === 'local_ble_denied' && (
                  <>
                    <View style={styles.gapMd} />
                    <SecondaryButton
                      styles={styles}
                      colors={colors}
                      icon="settings-outline"
                      label={t('open_settings')}
                      onPress={() => void Linking.openSettings()}
                    />
                  </>
                )}
              </>
            )}
```

(c) Confirm nothing stale remains:

```
grep -n "nearbyError\|radioTransport\b\|ICONS\[" packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx
```

Expected: no output. (`radioTransports` with the plural is fine; the `\b` excludes it.)

- [ ] **Step 26: Typecheck and run the touched suites**

```
npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep "error TS" | grep -v "core/pay/rails/handle.ts\|ui/components/pay/HandleReceive.tsx"
```

Expected: no output. (The four pre-existing, unrelated `TS2345` errors in `core/pay/rails/handle.ts` and `ui/components/pay/HandleReceive.tsx` are filtered away; nothing this task touches may add a line.) Typical slips and their fixes: `savePending`'s third parameter is `receivedVia?: string` (`core/localpay/pending.ts:151-154`), so `via ?? 'awdl'` compiles — a `TS2322` there means you passed something else. `TS2339 Property 'medium' does not exist` means Step 3 was skipped. `TS2305 … has no exported member 'prepareBle'` means Step 14's `core/index.ts` edit was missed.

```
npx jest packages/expo-wallet-toolbox/__tests__/ui packages/expo-wallet-toolbox/__tests__/localpay
```

Expected: every suite passes, including `payScreen.test.tsx` (it mocks `NearbyFlow` to a string, so it only proves the `ui` barrel still loads) and the earlier tasks' `transportSelect`, `deviceCaps`, `transportBle`, `session` suites.

- [ ] **Step 27: Commit the flow**

```
git add packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx
git commit -m "feat(pay): BLE rung in NearbyFlow, capability hints at mint, floor copy

Payee: minting now runs the wallet calls, the device probe and — where a
BLE radio exists — prepareBle() in parallel, then advertises CAP_BLE
only when the radio is powered on and permitted, with the hint bits
alongside. receive_wait listens on every radio this device offers via
raceReceivers; the first frame wins, the losers are aborted before
settle, and savePending records the winning kind. Radio failures are
per-radio advisories, so BLE giving up leaves Wi-Fi listening.

Payer: the ladder can land on BLE, Android asks for the BLE grants only
at that point, and a refusal falls to the fountain like any radio
failure. On the QR floor, describeFloor turns the payee's hint bits into
one sentence saying what to switch on, with Open Settings when it is
this device's Bluetooth permission. The presence row names the radio.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: one commit touching only `NearbyFlow.tsx`; `git log -1 --format=%s` prints `feat(pay): BLE rung in NearbyFlow, capability hints at mint, floor copy`.

- [ ] **Step 28: Hardware checklist (no jest can cover the wiring end to end)**

Build and install a dev-client on each physical device from the repo root:

```
npm run ios-dev-physical
npm run android-dev-physical
```

Expected: each ends with EAS's `Build successful` and the path of a new `build-<epoch-ms>.ipa` / `.apk` in the repo root (both gitignored).

(Both are EAS local builds: `eas build --profile dev-physical --platform <ios|android> --local`, see `package.json:12,16`. Install the resulting `.ipa`/`.apk` on the phones, then `npm run ios-dev-device` for the Metro tunnel.)

Watch native logs while running each row — iOS: `log stream --predicate 'subsystem == "org.bsvblockchain.wallet" AND category == "LocalPayBle"' --level debug` in Terminal with the phone attached (Console.app filter `subsystem:org.bsvblockchain.wallet category:LocalPayBle`); Android: `adb logcat -s LocalPayBle:D ReactNativeJS:W`. The log strings below are the ones Task 8 (Swift, `os_log`) and Task 9 (Kotlin, `Log.d`) actually emit. Record the measured numbers next to each row in the PR description.

| # | Setup | Do | Expect on screen | Expect in logs |
|---|---|---|---|---|
| 1 | Android payee, iPhone payer, Bluetooth on both, Wi-Fi off on both | Payee: Pay → Receive → Continue. Payer: scan. | Payee `receive_wait` presence shows the **bluetooth** glyph in the `waiting` state. Payer `send_confirm` shows the `ready` state with the bluetooth glyph and NO floor sentence. Send → `Payment sent`; payee `Payment received`. | Payee (logcat `LocalPayBle`): `prepare: poweredOn`, `payee: advertising <uuid>`, `payee: HELLO_A verified from <mac>`, `payee: frame accepted (<n> bytes, mtu <M>)`, `payee: ack ok=true delivered=true`. Payer (Console `LocalPayBle`): `scanning service=<uuid>`, `scan hit rssi=… ms=…`, `connected id=… maxWriteLen=…`, `subscribed ms=…`, `hello verified ms=…`, `frame written bytes=… ms=…`, `ack verified bytes=11 ms=…`. Note the `ms` values. |
| 2 | Same as 1 but iPhone payee, Android payer | Same | Same, mirrored. | Payee (Console): `prepare resolved state=poweredOn`, `advertising started service=<uuid> name=bsvpay-…`, `central connected id=… maxUpdate=…`, `hello verified id=…`, `frame accepted bytes=… id=…`, `ack sent ok=1 bytes=44`. Payer (logcat): `payer: scanning for <uuid>`, `payer: found …`, `payer: connected … requesting mtu 517`, `payer: mtu <M>`, `payer: subscribed to ACK`, `payer: HELLO_B verified`, `payer: frame written in … ms`, `payer: ack verified; total … ms`. |
| 3 | iPhone payee with Bluetooth OFF, Android payer | Payee mints; payer scans | Payee: presence in the `qr` state (no radio glyph). Payer `send_confirm`: "Their Bluetooth is off, so this payment will go by code." (`peer_bt_off`), Send → fountain. | Payee (Console): `peripheral manager state=poweredOff`, `prepare resolved state=poweredOff` within 1.5 s; no `advertising started`. Payer (logcat): no `payer: scanning` line — the ladder never picked BLE. |
| 4a | Android payee Bluetooth ON, iPhone payer Bluetooth OFF, payer app freshly launched | Payer scans, taps Send | First attempt: `send_confirm` shows `ready` (a radio that is merely off cannot be told from on without prompting — Task 8 `isSupported`), Send fails fast and falls to the fountain with "Wireless link unavailable — show this code…" (`local_pay_radio_fallback`); no failure screen. | Payer (Console): `central manager state=poweredOff` immediately after Send, no `scanning`. |
| 4b | Same devices, payer rescans the same QR in the same app session (or an Android payer with Bluetooth off, first scan) | Payer scans | `send_confirm` shows "Your Bluetooth is off. Turn it on for a faster nearby link." (`local_bt_off`); Send → fountain directly. | iPhone: no new `LocalPayBle` lines (the manager already reported `poweredOff`, so the ladder floors). Android payer: no `LocalPayBle` lines at all (`isSupported` reads `isEnabled`). |
| 5 | Android payee, iPhone payer with Bluetooth permission for BSV Wallet set to Off in Settings → Privacy & Security → Bluetooth | Payer scans | "Bluetooth access is off for BSV Wallet. Allow it in Settings…" (`local_ble_denied`) plus an **Open Settings** button that lands on the app's Settings page. | Payer: no `LocalPayBle` lines — `readBluetoothState()` answered `unauthorized` prompt-free and the ladder floored. |
| 6 | iOS↔iOS, both Bluetooth on, Wi-Fi on | Payee mints, payer scans | Presence shows the **wifi** glyph on both (AWDL outranks BLE, spec §5); payment completes over AWDL. | Payee (Console): `advertising started …` from the BLE object AND the AWDL listener's own start; after the frame lands over AWDL, `listener stopped by JS` (raceReceivers aborted the BLE loser) and NO `frame accepted` / `ack sent` from the BLE object. |
| 7 | iOS↔iOS, both Bluetooth on, Wi-Fi on; the payee switches Bluetooth OFF mid-wait (Settings, not Control Center) | Wait 5 s, then pay over AWDL | Payee: one advisory "Bluetooth is unavailable. The code above still works." (`local_pay_ble_unavailable`); presence still `waiting` with the **wifi** glyph; the AWDL payment completes. | Payee (Console): `peripheral manager state=poweredOff` then nothing more from the BLE object; AWDL lines untouched. (Android payee equivalent: `payee: bluetooth turned off under a live listener` from Task 9's adapter receiver.) |
| 8 | Android payee, iPhone payer, payer backgrounds the app during `send_working` | Send, press Home within 1 s | Same as the AWDL/Nearby path today (the abort path is shared): no failure screen on the payer, the held build is released (Activity shows no stuck row), payee stays on `receive_wait` with its QR. | Payee (logcat): `payee: central disconnected <mac>` (or `payee: idle reaper dropped <mac>` 30 s later) and NO `frame accepted`; a fresh scan from the payer afterwards still succeeds — advertising never stopped. |
| 9 | Row 1 but a second Android holds a photo of the same QR and pays second | Two payers, 10 s apart | Second payer: BLE connect times out within 6 s (the payee stopped advertising at the first accept) → fountain. If the payee then scans that fountain its screen shows `already_paid` and stays settled on the first payment; the first payer is unaffected. | Payee: exactly one `payee: frame accepted` for the session; second payer's logcat: `payer: scanning for <uuid>` and no `payer: found`, then JS `[localpay] radio send failed, falling back to QR: connect timeout: no route to peer`. |
| 10 | Android payee, Android payer that has never granted Bluetooth to BSV Wallet, no GMS on the payer (or Nearby denied) | Payer scans, taps Send, denies the runtime prompt | Payer falls to the fountain with "Wireless link unavailable — show this code to the other device instead." (`local_pay_radio_fallback`); no failure screen. | Payer JS: `[localpay] radio send failed, falling back to QR: bluetooth permission not granted`; no `LocalPayBle` lines. |

Any row that does not match is a bug in Task 10's wiring unless the log line missing is a native one, in which case it belongs to Task 8 (Swift) or Task 9 (Kotlin) — record which and stop rather than patching around it here.


---

### Task 11: Amend stale CoreBluetooth prohibitions in docs; mark spec implemented

Docs-only task. Five earlier documents state, as a standing rule, that CoreBluetooth must never be linked and `NSBluetoothAlwaysUsageDescription` must never be added. Those rules were true while the app carried `com.apple.developer.web-browser`; that entitlement was removed on 2026-08-26 (`de13669`/`1dc1d92`), and the 2026-09-02 spec (§"Why now", §8) makes the plist key REQUIRED. Leave history in place — strike through or append a dated "Superseded" note — so a future reader sees both what was believed then and what changed. Then flip the new spec's Status line. Rationale for keeping rather than deleting: spec 2026-09-02 "**Amends:**" header lists these exact locations and the repo convention (see `docs/superpowers/specs/2026-08-19-tx-size-limits-and-blob-compression-design.md:1` and `2026-07-27-local-payments-awdl-design.md:222`) is strike-through / `SUPERSEDED` markers, never deletion.

Every amended line contains the literal marker `Superseded 2026-09-02` so the verification grep in Step 8 can mechanically prove that no un-annotated prohibition remains.

Use the Edit tool for every change (exact-string replacement; it fails loudly if the "before" text has drifted). Do not use `sed -i` — the lines contain backticks, pipes and `~~` that are easy to mangle.

**Files:**
- Modify: `docs/superpowers/plans/2026-07-27-local-payments-awdl.md:16-17` (two Global Constraints bullets)
- Modify: `docs/superpowers/specs/2026-07-27-local-payments-awdl-design.md:18-24` (§"Why not BLE") and `:30` ("Bluetooth, in any form" non-goal)
- Modify: `docs/superpowers/specs/2026-07-29-offline-transport-fixes-design.md:427` (Non-goals bullet)
- Modify: `docs/superpowers/2026-08-20-morning-handoff.md:16` (table row) and `:21` (Transporter paragraph)
- Modify: `docs/superpowers/specs/2026-07-31-token-payment-frame-v3-design.md:214-217` (§3 `CAP_BLE` paragraph)
- Modify: `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md:4` (Status line)
- Test: none (jest does not cover markdown); verification is the grep in Step 8.

**Interfaces:**
- Consumes: nothing from code. Facts cited in the notes come from spec `2026-09-02-ble-transport-and-qr-caps-design.md` §"Why now" (entitlement removed in `de13669`/`1dc1d92`; `git grep web-browser HEAD -- ios app.json plugins eas.json package.json` is empty), §8 (`NSBluetoothAlwaysUsageDescription` + `NSBluetoothPeripheralUsageDescription` in `app.json`; podspec links `CoreBluetooth`), §2 (`bsvpay-ble/1` profile), §"Compatibility" (a Blitz session setting `0x04` is now selected for BLE).
- Produces: six amended markdown files, one commit `docs(ble): supersede the CoreBluetooth prohibitions`.

- [ ] **Step 1: Confirm the "before" text is still exactly as this task expects**

Run from the repo root:

```bash
sed -n '16,17p' docs/superpowers/plans/2026-07-27-local-payments-awdl.md
sed -n '18,24p;30p' docs/superpowers/specs/2026-07-27-local-payments-awdl-design.md
sed -n '427p' docs/superpowers/specs/2026-07-29-offline-transport-fixes-design.md
sed -n '16p;21p' docs/superpowers/2026-08-20-morning-handoff.md
sed -n '214,217p' docs/superpowers/specs/2026-07-31-token-payment-frame-v3-design.md
sed -n '4p' docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md
grep -rn 'Never link CoreBluetooth\|banned from BSVBrowser\|must NOT be added' docs/
```

Expected: the seven blocks print the "Before" text quoted in Steps 2–7 verbatim, and the final grep prints exactly three hits — `docs/superpowers/2026-08-20-morning-handoff.md:21`, `docs/superpowers/plans/2026-07-27-local-payments-awdl.md:16`, `docs/superpowers/specs/2026-07-29-offline-transport-fixes-design.md:427` — none of which yet contain `Superseded 2026-09-02`. If any block differs, stop and re-read that file around the quoted line before editing; the Edit tool will refuse a stale `old_string` anyway.

- [ ] **Step 2: Strike through the two Global Constraints bullets in the AWDL plan**

Open `docs/superpowers/plans/2026-07-27-local-payments-awdl.md`. Lines 16–17 currently read:

Before (line 16):

```markdown
- **Never link CoreBluetooth.** Not directly, not transitively, not via any new dependency. It is incompatible with `com.apple.developer.web-browser` — see `memory/project_web_browser_entitlement.md`. Any dependency added by this plan must be checked with `otool -L` before a build is delivered.
```

After (line 16, one line):

```markdown
- ~~**Never link CoreBluetooth.** Not directly, not transitively, not via any new dependency. It is incompatible with `com.apple.developer.web-browser` — see `memory/project_web_browser_entitlement.md`. Any dependency added by this plan must be checked with `otool -L` before a build is delivered.~~ **Superseded 2026-09-02.** `com.apple.developer.web-browser` was removed in `de13669`/`1dc1d92` (2026-08-26, wallet-first pivot), so nothing prohibits the Bluetooth plist key any more. `packages/react-native-localpay-transport` now links `CoreBluetooth` on purpose for the `LocalPayBleTransport` rung — see `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md` §"Why now" and §8. The `otool -L … grep -ci corebluetooth` checks later in this plan (Task steps that expect a count of **0**) are historical; a non-zero count is now expected.
```

Before (line 17):

```markdown
- **Never add any of these Info.plist keys:** `NSPhotoLibraryUsageDescription`, `NSLocationAlwaysUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription`, `NSHomeKitUsageDescription`, `NSBluetoothAlwaysUsageDescription`, `NSHealthShareUsageDescription`, `NSHealthUpdateUsageDescription`.
```

After (line 17, one line):

```markdown
- ~~**Never add any of these Info.plist keys:** `NSPhotoLibraryUsageDescription`, `NSLocationAlwaysUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription`, `NSHomeKitUsageDescription`, `NSBluetoothAlwaysUsageDescription`, `NSHealthShareUsageDescription`, `NSHealthUpdateUsageDescription`.~~ **Superseded 2026-09-02.** This list was the `com.apple.developer.web-browser` prohibited-key list; the entitlement is gone (see the bullet above). `NSBluetoothAlwaysUsageDescription` (and `NSBluetoothPeripheralUsageDescription`) are now **required** and set in `app.json` `ios.infoPlist` per `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md` §8. None of the other keys is set or needed by any current feature.
```

Apply both with the Edit tool (two calls, `old_string` = the full Before line, `new_string` = the full After line). Then verify:

```bash
sed -n '16,17p' docs/superpowers/plans/2026-07-27-local-payments-awdl.md | grep -c 'Superseded 2026-09-02'
```

Expected output: `2`.

- [ ] **Step 3: Add a dated Superseded paragraph to §"Why not BLE" and the non-goal in the AWDL design spec**

Open `docs/superpowers/specs/2026-07-27-local-payments-awdl-design.md`. Do not delete any existing sentence in §"Why not BLE"; append one paragraph after line 24 (the "AWDL carries no such exposure…" paragraph), before the `## Non-goals` heading.

Before (lines 18–26):

```markdown
## Why not BLE

BLE was the previous implementation and is now unavailable. `com.apple.developer.web-browser` prohibits `NSBluetoothAlwaysUsageDescription`, while ITMS-90683 demands that exact key whenever CoreBluetooth appears in the binary — linkage-triggered, not usage-triggered. Confirmed empirically at both gates on 2026-07-27, with an appeal to Developer Relations already exhausted. The minimum surface (central-only, no `CBPeripheralManager`) was tested and still rejected. AccessorySetupKit does not escape it: its own API is typed in `CBUUID`, and it has no advertising role.

See `memory/project_web_browser_entitlement.md` for the full record.

AWDL carries no such exposure. `NSLocalNetworkUsageDescription` and `NSBonjourServices` are not on the prohibited list, and no entitlement is required.

## Non-goals
```

After (lines 18–28):

```markdown
## Why not BLE

BLE was the previous implementation and is now unavailable. `com.apple.developer.web-browser` prohibits `NSBluetoothAlwaysUsageDescription`, while ITMS-90683 demands that exact key whenever CoreBluetooth appears in the binary — linkage-triggered, not usage-triggered. Confirmed empirically at both gates on 2026-07-27, with an appeal to Developer Relations already exhausted. The minimum surface (central-only, no `CBPeripheralManager`) was tested and still rejected. AccessorySetupKit does not escape it: its own API is typed in `CBUUID`, and it has no advertising role.

See `memory/project_web_browser_entitlement.md` for the full record.

AWDL carries no such exposure. `NSLocalNetworkUsageDescription` and `NSBonjourServices` are not on the prohibited list, and no entitlement is required.

**Superseded 2026-09-02.** The analysis above was correct for the app as it stood on 2026-07-27. The blocker was the entitlement, not Bluetooth: `com.apple.developer.web-browser`, its config plugin and the http/https URL types were removed in `de13669`/`1dc1d92` (2026-08-26, wallet-first pivot), so `NSBluetoothAlwaysUsageDescription` can now be set and ITMS-90683 is satisfied rather than avoided. BLE has returned as the **third** rung of the ladder (AWDL → Nearby → BLE → QR), implemented as a second Nitro HybridObject `LocalPayBleTransport` behind the same `LocalPaymentTransport` interface this document defines, using the same per-session PSK from the QR to derive the GATT service UUID. AWDL and the QR fallback are unchanged. Design: `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md` (§"Why now", §2 `bsvpay-ble/1`, §5 ladder).

## Non-goals
```

Use the Edit tool with `old_string` = the single line `AWDL carries no such exposure. `NSLocalNetworkUsageDescription` and `NSBonjourServices` are not on the prohibited list, and no entitlement is required.` and `new_string` = that same line followed by a blank line and the new `**Superseded 2026-09-02.** …` paragraph.

Then the non-goal bullet. Before (originally line 30, now line 32 after the insertion above):

```markdown
- **Bluetooth, in any form.**
```

After (one line):

```markdown
- ~~**Bluetooth, in any form.**~~ **Superseded 2026-09-02:** BLE is now the third rung — see the note under "Why not BLE" and `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md`.
```

Apply with the Edit tool (`old_string` = `- **Bluetooth, in any form.**`; it is unique in the file). Verify:

```bash
grep -n 'Superseded 2026-09-02' docs/superpowers/specs/2026-07-27-local-payments-awdl-design.md
```

Expected: exactly two lines, one starting `26:**Superseded 2026-09-02.**` and one starting `32:- ~~**Bluetooth, in any form.**~~`.

- [ ] **Step 4: Annotate the "BLE anywhere" non-goal in the offline-transport-fixes spec**

Open `docs/superpowers/specs/2026-07-29-offline-transport-fixes-design.md`.

Before (line 427):

```markdown
- BLE anywhere: CoreBluetooth is banned from BSVBrowser.app (ITMS-90683).
```

After (line 427, one line):

```markdown
- ~~BLE anywhere: CoreBluetooth is banned from BSVBrowser.app (ITMS-90683).~~ **Superseded 2026-09-02:** the ban came from `com.apple.developer.web-browser`, removed 2026-08-26; BLE is now the third rung of this spec's ladder (AWDL → Nearby → BLE → fountain QR). See `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md`.
```

Apply with the Edit tool. Verify:

```bash
sed -n '427p' docs/superpowers/specs/2026-07-29-offline-transport-fixes-design.md | grep -c 'Superseded 2026-09-02'
```

Expected output: `1`.

- [ ] **Step 5: Rewrite the Bluetooth row and the Transporter paragraph in the morning handoff**

Open `docs/superpowers/2026-08-20-morning-handoff.md`. This document describes builds 165 (iOS) / 91 (Android) which genuinely had no Bluetooth key, so the row keeps the historical observation and states the new rule beside it; the paragraph is rewritten because its instruction ("the answer is still not to add the key") is now actively wrong and would mislead whoever ships the next build.

Before (line 16):

```markdown
| No banned Bluetooth key | no `NSBluetooth*` key at all | n/a |
```

After (line 16, one line):

```markdown
| Bluetooth usage key | build 165: no `NSBluetooth*` key at all (correct at the time). **Superseded 2026-09-02:** `NSBluetoothAlwaysUsageDescription` is now REQUIRED and expected in every build — `LocalPayTransport.podspec` links `CoreBluetooth`; check the key is **present** | n/a |
```

Before (line 21):

```markdown
**Transporter, not Deliver.** Past experience on this project: `ITMS-90683` appears at Deliver and demands a `NSBluetoothAlwaysUsageDescription` key that must NOT be added, and Transporter's own Verify step does not catch it. If it appears again, the answer is still not to add the key.
```

After (line 21, one line):

```markdown
**Transporter, not Deliver.** ~~Past experience on this project: `ITMS-90683` appears at Deliver and demands a `NSBluetoothAlwaysUsageDescription` key that must NOT be added, and Transporter's own Verify step does not catch it. If it appears again, the answer is still not to add the key.~~ **Superseded 2026-09-02.** `ITMS-90683` fires at Deliver (not at Transporter's Verify) whenever CoreBluetooth is linked without `NSBluetoothAlwaysUsageDescription`. The key could not be added while the app carried `com.apple.developer.web-browser`; that entitlement was removed on 2026-08-26, and the key is now set in `app.json` `ios.infoPlist` and REQUIRED — `packages/react-native-localpay-transport` links `CoreBluetooth` for the BLE rung. If `ITMS-90683` appears again, the key has gone missing from the built `Info.plist`: re-run `npx expo prebuild --clean --platform ios`, confirm the key with `plutil -p ios/*/Info.plist | grep NSBluetooth`, and rebuild. See `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md` §"Why now" and §8.
```

Apply both with the Edit tool. Verify:

```bash
sed -n '16p;21p' docs/superpowers/2026-08-20-morning-handoff.md | grep -c 'Superseded 2026-09-02'
```

Expected output: `2`.

- [ ] **Step 6: Annotate the `CAP_BLE` paragraph in the v3 frame spec**

Open `docs/superpowers/specs/2026-07-31-token-payment-frame-v3-design.md`. The paragraph is hard-wrapped across lines 214–217; the Edit `old_string` must include the line breaks exactly.

Before (lines 214–217):

```markdown
Capability bits (`session.ts:5-6`): add `CAP_BLE = 0x04`. Wire format
already accommodates it (caps is a plain number; `selectTransport` masks
specific bits). No local BLE support — the bit exists so a Blitz session
can advertise it and so our builds ignore it cleanly.
```

After (lines 214–219):

```markdown
Capability bits (`session.ts:5-6`): add `CAP_BLE = 0x04`. Wire format
already accommodates it (caps is a plain number; `selectTransport` masks
specific bits). ~~No local BLE support — the bit exists so a Blitz session
can advertise it and so our builds ignore it cleanly.~~ **Superseded
2026-09-02:** this app now advertises and honours `CAP_BLE` itself, and a
Blitz session that sets `0x04` will be selected for BLE by a new payer and must therefore implement the `bsvpay-ble/1` GATT profile — `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md` §2–§3 and §"Compatibility". The same spec adds device-hint bits above `RUNG_MASK = 0x00ff` (`HINT_ONLINE` … `HINT_NFC`) to `c`, still under `v:1`.
```

Note the marker deliberately spans a hard wrap as `**Superseded\n2026-09-02:**` to keep the existing ~72-column wrapping of the first lines; the grep in Step 8 does not need to match this file (none of its three patterns occur here). Apply with the Edit tool (`old_string` = the four Before lines including their two internal newlines). Verify:

```bash
sed -n '214,219p' docs/superpowers/specs/2026-07-31-token-payment-frame-v3-design.md | grep -c 'Superseded'
```

Expected output: `1`.

- [ ] **Step 7: Flip the new spec's Status line**

Open `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md`. This is the last content edit because the Status line claims the whole plan (Tasks 1–10) has landed; run it only once every earlier task of this plan is committed.

Before (line 4):

```markdown
**Status:** Approved (product owner, 2026-09-02); ready for planning
```

After (line 4):

```markdown
**Status:** Implemented (plan 2026-09-02-ble-transport-and-qr-caps.md)
```

Apply with the Edit tool. Verify:

```bash
sed -n '4p' docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md
ls docs/superpowers/plans/2026-09-02-ble-transport-and-qr-caps.md
```

Expected: the first command prints `**Status:** Implemented (plan 2026-09-02-ble-transport-and-qr-caps.md)`; the second prints the plan path (the file this task belongs to must exist at that path — if it does not, the reference is wrong; fix the filename in the Status line to match the real plan file rather than proceeding).

- [ ] **Step 8: Verify no un-annotated prohibition remains anywhere under docs/**

```bash
grep -rn 'Never link CoreBluetooth\|banned from BSVBrowser\|must NOT be added' docs/
echo "---"
grep -rn 'Never link CoreBluetooth\|banned from BSVBrowser\|must NOT be added' docs/ | grep -v 'Superseded 2026-09-02'; echo "unannotated-exit=$?"
echo "---"
git diff --stat -- docs/
```

Expected:
- The first grep prints exactly three lines — `docs/superpowers/2026-08-20-morning-handoff.md:21`, `docs/superpowers/plans/2026-07-27-local-payments-awdl.md:16`, `docs/superpowers/specs/2026-07-29-offline-transport-fixes-design.md:427` — every one of them containing both `~~` and `Superseded 2026-09-02`.
- The second grep prints nothing and `unannotated-exit=1`.
- `git diff --stat` lists exactly six files: `docs/superpowers/2026-08-20-morning-handoff.md`, `docs/superpowers/plans/2026-07-27-local-payments-awdl.md`, `docs/superpowers/specs/2026-07-27-local-payments-awdl-design.md`, `docs/superpowers/specs/2026-07-29-offline-transport-fixes-design.md`, `docs/superpowers/specs/2026-07-31-token-payment-frame-v3-design.md`, `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md`. (`docs/1.0.0/` is pre-existing untracked content unrelated to this task; do not stage it.)

If the second grep prints anything, a prohibition line was edited without the marker or a new one exists — go back to the step that owns that file.

- [ ] **Step 9: Commit**

```bash
git add docs/superpowers/plans/2026-07-27-local-payments-awdl.md \
        docs/superpowers/specs/2026-07-27-local-payments-awdl-design.md \
        docs/superpowers/specs/2026-07-29-offline-transport-fixes-design.md \
        docs/superpowers/2026-08-20-morning-handoff.md \
        docs/superpowers/specs/2026-07-31-token-payment-frame-v3-design.md \
        docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md
git commit -m "$(cat <<'EOF'
docs(ble): supersede the CoreBluetooth prohibitions

The "never link CoreBluetooth" / "never add NSBluetoothAlwaysUsageDescription"
rules in the AWDL plan, the AWDL and offline-transport design specs, the v3
frame spec's CAP_BLE note and the 2026-08-20 handoff all derived from
com.apple.developer.web-browser, which was removed on 2026-08-26. Strike
each one through with a dated Superseded note pointing at the 2026-09-02
BLE transport spec, rewrite the handoff so the plist key is documented as
required and expected, and mark the new spec Implemented.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
git log --oneline -1
```

Expected: `git log --oneline -1` prints a new hash followed by `docs(ble): supersede the CoreBluetooth prohibitions`, and `git status --short docs/` afterwards shows only `?? docs/1.0.0/`.

---

## Spec coverage

| Spec section | Implemented by |
|---|---|
| §1 Placement: second HybridObject behind the same wrapper | Task 1 (Nitro spec, `nitro.json`, generated glue, `getLocalPayBleTransport()` warning once in `__DEV__`), Task 5 (`LocalPayNative`, `makeSocketTransport(kind, native, connectTimeoutMs)`, `transport/ble.ts`, 4 s / 10 s / 6 s budgets), Task 4 (`kind`/`TransportKind`/`receivedVia` gain `'ble'`), Task 7 (`core/index.ts` exports `bleTransport`, `localSupportsBle`, `requestBlePermissions`, `probeDeviceCaps`, `capsFromProbe`, `describeFloor` and the four types) |
| §2 GATT profile `bsvpay-ble/1` | Task 8 (`BleGattProfile.swift`), Task 9 (`BleGattProfile.kt` + JUnit vectors, cross-checked byte for byte in Step 7) |
| §3 Messages, framing, peripheral and central state machines | Task 8 (Swift `BleEngine`/`OutboundSend`), Task 9 (Kotlin server/client), Task 5 (JS forwards `"connect timeout: no route to peer"` and the oversize rejection untouched, `parseAck` unchanged) |
| §4 Session QR capability bits, probing, minting sequence, size | Task 3 (`HINT_*`, `RUNG_MASK`, `mintSession` masking, realistic-nonce QR size test), Task 6 (`deviceCaps.ts`: `capsFromProbe`, `probeDeviceCaps` never uses `getOnline()`, `readBluetoothState`), Task 10 (`prepareBle`; `receive_minting` runs wallet calls + probe + prepare in parallel; `supportsBle`/`hints` passed to `mintSession`) |
| §5 Selection ladder and the payer's copy | Task 4 (`localSupportsBle`, AWDL → Nearby → BLE → QR, `describeFloor` table, new CASES rows), Task 8/9 (`isSupported` semantics that make `local_bt_off`/`local_ble_denied` reachable), Task 10 (`FLOOR_KEYS`, six i18n keys × 12 languages, `floorReason` on `send_confirm` with Open Settings for `local_ble_denied`) |
| §6 Payee multi-listener, presence medium | Task 10 (`raceReceivers` + tests, `radioTransports`, per-kind `radioErrors`, `radioActive`, `PresenceRow medium`, `presenceMedium`) |
| §7 Permissions and prompts | Task 1 (prompt-free probes; nothing instantiates a `CB*Manager`), Task 7 (`requestBlePermissions` sets by API level), Task 8 (prompt only inside `prepare()`/`sendFrame`, `notDetermined` counts as supported), Task 9 (permission checks before every `android.bluetooth` call), Task 10 (payee asks Nearby or BLE grants at flow entry; payer asks lazily in `executeSend` and a denial falls to the fountain) |
| §8 Native configuration | Task 1 (`app.json` plist keys, podspec frameworks, `nitro.json`, manifest `uses-feature`, `expo prebuild` + commit `ios/`), Task 8 (podspec source files, prebuild), Task 2 (proves the configuration passes App Store Connect) |
| §9 Money-safety invariants | Task 5 (wrapper's money-safety comments and tests kept verbatim; ack after `savePending` unchanged), Task 8/9 (`hasAccepted` latch before `onFrame`, held pending-ack connection, silent reapers, HMAC'd ack, stranger refused before HELLO), Task 10 (`raceReceivers` declines `save_failed` for a frame that arrives after the race is decided; radio failure falls to the fountain without aborting the built action) |
| Compatibility (old decoders, Blitz `0x04`) | Task 3 (decodeSession untouched; existing unknown-bits test), Task 11 (v3 frame spec note: a Blitz session setting `0x04` must implement `bsvpay-ble/1`) |
| Testing — Jest | Task 1 (`bleAccessor`), Task 3 (`session`), Task 4 (`transportSelect`, `describeFloor`), Task 5 (`transportBle`, `transportAwdl` pin), Task 6 (`deviceCaps`), Task 7 (`blePermissions`, `nearbyRail`), Task 10 (`PresenceRow`, `prepareBle`, `race`) |
| Testing — native / hardware | Task 8 Step 7 (iOS↔iOS + failure rows), Task 9 Steps 10–12 (Android↔Android, Android→iOS first, iOS→Android, negative cases), Task 10 Step 28 (end-to-end rows incl. floor copy, permission denial, second payer) |
| Testing — store gate | Task 2 |
| Rollout order 0–5 | 0: Task 2 (after Task 1 links CoreBluetooth); 1: Tasks 1, 3, 4, 5; 2: Task 8; 3: Task 9; 4: Tasks 6, 7, 10; 5: Task 11 |
