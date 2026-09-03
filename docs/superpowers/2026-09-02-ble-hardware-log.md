# BLE transport hardware log

Measurements for the `bsvpay-ble/1` rung (spec: `docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md` §3 "Expected performance"). One row per attempt; keep failed attempts, they are the point.

Console.app filter used on each iPhone: `subsystem:org.bsvblockchain.wallet category:LocalPayBle`.

| Date | Payee device / OS | Payer device / OS | Pairing | maxUpdate (payee) | maxWriteLen (payer) | scan hit ms | subscribed ms | frame bytes | frame written ms | ack verified ms (total) | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-02 | — | — | iOS→iOS | — | — | — | — | — | — | — | pending — requires two iPhones; not run in the implementation session | expect `ok` |
| 2026-09-02 | — | — | iOS→iOS (Wi-Fi off both) | — | — | — | — | — | — | — | pending — requires two iPhones; not run in the implementation session | expect `ok`; proves BLE carries the payment with no Wi-Fi at all |
| 2026-09-02 | — | — | iOS→iOS (payer BT off) | — | — | — | — | — | — | — | pending — requires two iPhones; not run in the implementation session | expect `bluetooth unavailable` then fountain |
| 2026-09-02 | — | — | iOS→iOS (payee locked mid-wait) | — | — | — | — | — | — | — | pending — requires two iPhones; not run in the implementation session | expect payer `connect timeout: no route to peer` within 6 s |
| 2026-09-02 | — | — | iOS→iOS (second payer, same QR) | — | — | — | — | — | — | — | pending — requires two iPhones; not run in the implementation session | expect second payer refused at FRAME (no ack, falls to fountain) |

Column sources: `maxUpdate` from the payee's `central connected ... maxUpdate=N` line; `maxWriteLen` from the payer's `connected ... maxWriteLen=N` line; the `ms` columns are the `ms=` field of the payer's `scan hit`, `subscribed`, `frame written` and `ack verified` lines (`frame written ms` is measured from the first frame write, the others from `sendFrame` entry).

## Status: not yet run

Every row above is `pending — requires two iPhones; not run in the implementation session`. The Swift backend (Task 8) is implemented and compiles; the behavioural gate below needs hardware that was not attached when it was written. Task 9 (Kotlin) appends its own cross-OS pairings to the same table.

## How to run it (Task 8 brief, Step 7)

Prerequisites (do not start without all four):

1. Two physical iPhones, both signed into the same Apple developer team as `eas.json` `appleTeamId` `SV8SWTHA2H`, both with Bluetooth on.
2. Task 10's NearbyFlow wiring (the payee starts `bleTransport.receive` alongside AWDL through `raceReceivers`; the payer's ladder can select `'ble'`) present in the branch being built. Until it is, the payee never advertises and this checklist cannot run.
3. **Temporary, uncommitted** edit so an iPhone pair lands on BLE rather than AWDL (the ladder is AWDL → Nearby → BLE → QR, spec §5, and `localSupportsAwdl()` is a parameter-stack probe that stays true even with Wi-Fi off). In `packages/expo-wallet-toolbox/core/localpay/transport/select.ts`, change the body of `localSupportsAwdl()` to a single `return false`. Both phones get the same build, so the payee stops advertising `CAP_AWDL` and listens on BLE only, and the payer selects `'ble'`. Revert with `git checkout -- packages/expo-wallet-toolbox/core/localpay/transport/select.ts` before committing. Cross-OS pairings in Task 9 need no such edit.
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

### Happy path

1. Payee (A): open the Pay → Receive nearby flow and enter an amount. When the QR appears, the first `prepare()` has run. **Expected UI:** the presence row shows `waiting` ("Waiting for the other device"-style copy from `local_pay_presence_waiting_payee`) with the Bluetooth icon (PresenceRow `medium='bluetooth'`, since BLE is the only live listener). **Expected A log, in order:**
   - `peripheral manager state=poweredOn`
   - `central manager state=poweredOn`
   - `prepare resolved state=poweredOn`
   - `advertising started service=<UUID> name=bsvpay-<base32>`

   The first launch also shows the iOS "BSV Wallet Would Like to Use Bluetooth" prompt at this moment; tap Allow. The prompt fires when the CoreBluetooth managers are first created, which on the payee is `prepare()` — the call Task 10 makes at minting, i.e. as the QR appears. Note that `startListening` also creates the managers defensively (a caller that skipped `prepare()` would otherwise hang instead of advertising), so on a build **without** Task 10's wiring the prompt appears at `startListening` instead — a moment later, as the listener starts, rather than at minting. Either way it is one prompt per install, on the payee side only, and nowhere else in the flow.
2. Payer (B): scan A's QR and confirm. **Expected UI:** `ready` with the Bluetooth icon on the confirm screen, `waiting` on send, then the done screen within 5 s. **Expected B log, in order:**
   - `central manager state=poweredOn` (first launch: the Bluetooth prompt appears here, when `sendFrame` creates the central manager; tap Allow. A payer that lands on QR instead of BLE is never prompted.)
   - `scanning service=<same UUID as A>`
   - `scan hit rssi=-NN id=<A's identifier> ms=<n>`
   - `connected id=... maxWriteLen=<N> withResponse=<W> chunk=<C> ms=<n>` (expect `maxWriteLen` 182 or 244 on modern iPhones; 20 means the MTU stayed at 23. `withResponse` is CoreBluetooth's separate with-response ceiling, 512 at any MTU that allows it, and `chunk=min(maxWriteLen, withResponse)` is the size every write on this connection is cut to — see the iOS→Android first check in the Android section.)
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
4. Record `maxUpdate`, `maxWriteLen`, and the four `ms` values in the first row above. Result column: `ok`.

### Failure rows, each on a fresh receive request

- **Wi-Fi off on both** (Settings → Wi-Fi → off, not Control Center): identical log sequence; fill row 2. This proves BLE carries the payment with no Wi-Fi at all.
- **Payer Bluetooth off** (Settings → Bluetooth → off on B only): B's log shows `central manager state=poweredOff` and no `scanning`; the flow falls to the fountain QR (payer presence `qr`). No `scan hit`. Row 3 result: `fallback`.
- **Payee locked mid-wait**: on A, lock the screen once `advertising started` appears, then scan on B. iOS moves a backgrounded peripheral's UUIDs to the overflow area (spec "Verified facts"); B logs `scanning ...` and then, within 6 s, no `scan hit` and JS reports `connect timeout: no route to peer`, falling to the fountain. Row 4 result: `fallback`. (With a third iPhone, this is a good place to confirm a foreground iPhone central *does* still find it — it is Android centrals that cannot.)
- **Second payer, same QR**: photograph A's QR with B, complete the payment, then scan the same photo with a third iPhone (or B again after the done screen if the session survived). A never logs a second `frame accepted`: the second central is refused at FRAME with no ack (`hasAccepted` latch) and the second payer falls to its fountain, where the payee's JS answers `already_paid`. Row 5 result: `refused`.

Every terminal failure logs its own line, so each failure row is a positive check rather than an inference from a missing line. On the payer: `send failed reason=<message>` (the message is the contract string JS receives — e.g. `connect timeout: no route to peer`, `bluetooth unavailable`, `peer disconnected before acking`). On the payee: `frame refused reason=<why> id=<central>` for a FRAME that was not bound, already accepted, empty, or oversize, and `ack reaper fired; connection released` if the 60 s hold expired. Record the exact line you saw in the Notes column.

Also confirm, in A's log after each completed payment, that no `payee never confirmed the payment` / `ack reaper fired` line ever appears on the happy path, and that `idle central forgotten` appears only in the lock/stranger cases.

Revert the temporary `select.ts` edit when done:

```bash
cd /Users/personal/git/bsv-wallet && git checkout -- packages/expo-wallet-toolbox/core/localpay/transport/select.ts && git status --short packages/expo-wallet-toolbox/core/localpay/transport/select.ts
```

Expected: empty output from `git status --short`.

---

## Android (Task 9) — not yet run, phones: A = _pending_ (payee), B = _pending_ (payer), iPhone = _pending_

Logcat filter used on each Android phone (Task 9 brief, Step 9):

```bash
adb -s <SERIAL> logcat -c && adb -s <SERIAL> logcat -s LocalPayBle:D ReactNativeJS:W
```

The first `D LocalPayBle:` line on each phone is `prepare: poweredOn` when its Receive flow mints. iPhone side keeps the same Console.app filter as the iOS section above (`subsystem:org.bsvblockchain.wallet category:LocalPayBle`).

**Run order.** `Android (payer) → iOS (payee)` is the FIRST row to run: that direction was never confirmed in the `5fc72a7` era (spec "Verified facts"), so it is the one with real discovery risk. `Android ↔ Android` and `iOS (payer) → Android (payee)` follow.

| Pairing | Negotiated MTU (`mtu <M>`) | Advertising latency (`advertising … (<n> ms`) | Subscribed at (`subscribed to ACK at <t5> ms`) | Frame bytes | Frame write (`frame written in <tf> ms`) | Ack indication (`ack … in <ta> ms`) | Total (`ack verified; total <T> ms`) | Result |
|---|---|---|---|---|---|---|---|---|
| Android TIGER 13 → iOS 15 Pro (payer Android, central) — 2026-09-03 13:29 | 517 on the link, app stayed at 23 (late `onMtuChanged` dropped) | n/a (iOS payee) | 5477 | 41 (HELLO_A only) | never confirmed | n/a | — | **fail**: `timed out waiting for peer` at 30 s. HELLO_A Write Request sent by the stack, never seen by iPhone `bluetoothd`; link-layer desync — iPhone applied Android's connection updates 4.4 s and 86 s late, PHY update `status 42` (Instant Passed). See spec 2026-09-03. |
| Android TIGER 13 → iOS 15 Pro (payer Android, central, late-MTU + 1M-PHY experiment) — 2026-09-03 14:21 | 23 (MTU response never arrived) | n/a | never | — | — | n/a | — | **fail**: `connect timeout: no route to peer` at 15 s; discovery stalled the whole run; iPhone applied the 7.5 ms update 10.5 s late; PHY `status 42` again. Experiment closed; reversed role adopted. |
| Android (payer, **peripheral**) → iOS (payee, **central**) — reversed role, run first | payer log `mtu N` | payee log `chunk=` | payee `subscribed ms=` | `frame indicated` bytes | `frame indicated in <t> ms` | `ack written ok=1` | payer `ack verified; total <T> ms` | pending — Tasks 4/6/8 build |
| Android (payer, peripheral) → iOS (payee, central), payee screen locked mid-wait | — | — | — | — | — | — | — | pending — record whether the iOS scan in background still hits the Android advert |
| Android A → Android B (payer B) | — | — | — | — | — | — | — | pending — requires devices; not run in the implementation session |
| iOS → Android A (payee A) | — | — | n/a (iOS payer) | — | n/a | — | n/a | pending — requires devices; not run in the implementation session |

### Negative cases

| Case | Expected | Observed (ms / log line) |
|---|---|---|
| Payee Bluetooth off (Step 10.3) | `connect timeout: no route to peer` at ~6000 ms, fountain shown | pending — requires devices; not run in the implementation session |
| Second device, same QR (Step 10.4) | second payer times out; payee logs one `frame accepted` only | pending — requires devices; not run in the implementation session |
| Wrong-PSK sender (Step 10.5) | `connect timeout: no route to peer` (UUID never matches) | pending — requires devices; not run in the implementation session |
| Garbage write to FRAME (Step 10.5, nRF Connect) | `bad framing from` or `HELLO_A proof failed from`; next real payment still succeeds | pending — requires devices; not run in the implementation session |
| Payee screen locked, iOS payer (Step 12) | payer falls to fountain; payee logs no `frame accepted` | pending — requires devices; not run in the implementation session |
| Second payer, same QR, reversed role | second Android payer advertises; iOS payee (already accepted) refuses at FRAME, second payer times out to its fountain, JS answers `already_paid` | pending |

### Findings

- MTU negotiation against iOS: pending — requires devices; not run in the implementation session
- Anything that deviated from spec §3 "Expected performance" (0.5–2.5 s connect, 1–3 s end to end for 3–8 KB): pending — requires devices; not run in the implementation session

## Status: Android rows not yet run

Every Android row above is `pending — requires devices; not run in the implementation session`. The Kotlin backend compiles (`:react-native-localpay-transport:compileDebugKotlin`) and the eleven `BleGattProfileTest` known-answer vectors pass on the plain JVM, which pins the wire format against `ios/BleGattProfile.swift`; nothing below can be checked without two Android phones and an iPhone, and none were attached when it was written.

## How to run the Android rows (Task 9 brief, Steps 9–12)

Prerequisites: two Android phones on API 31+ with Bluetooth on (A = payee, B = payer), the iPhone carrying Task 8's build, and Task 10's NearbyFlow wiring present in the branch being built (until it is, the payee never advertises on BLE and none of this is reachable).

Build and install one APK on both phones, from the repo root:

```bash
npm run android-dev-physical
adb devices
adb -s <SERIAL_A> install -r "$(ls -t build-*.apk | head -1)"
adb -s <SERIAL_B> install -r "$(ls -t build-*.apk | head -1)"
unzip -l "$(ls -t build-*.apk | head -1)" | grep -c libLocalPayTransport.so   # must print 4
npx expo start --dev-client
```

The `grep -c` guard is the historical silent-QR-fallback failure mode: without the native library in the APK the JS layer floors to QR and every row below would read as "BLE not selected" rather than a real result.

Grant the runtime permissions on first entry to the receive flow (Task 10's `requestBlePermissions`). If Task 10 is not merged, grant them by hand:

```bash
for p in BLUETOOTH_SCAN BLUETOOTH_CONNECT BLUETOOTH_ADVERTISE; do
  adb -s <SERIAL> shell pm grant org.bsvblockchain.wallet android.permission.$p
done
```

**Forcing the BLE rung between two Android phones.** The payer's ladder (§5) takes Nearby whenever the payee advertised `CAP_NEARBY`, so make the payee mint without it: `NearbyFlow`'s `nearbyReady` requires every Nearby permission, and on API 33+ one of them is `NEARBY_WIFI_DEVICES`, which BLE does not need.

```bash
adb -s <SERIAL_A> shell pm revoke org.bsvblockchain.wallet android.permission.NEARBY_WIFI_DEVICES
# API 31–32: revoke android.permission.ACCESS_FINE_LOCATION instead
```

Relaunch the app on A and deny Nearby permission when the receive flow asks. The proof that BLE is in play is in the logs: A must print `payee: advertising` and B must print `payer: scanning`. If B shows no `LocalPayBle` lines at all, Nearby won the ladder — check A's minted `c` bits in the Metro console (`decodeSession` from `core/localpay/session`) and repeat. Cross-OS pairings need no such edit.

### Expected line sequence — payee (phone A)

```
D LocalPayBle: prepare: poweredOn
D LocalPayBle: payee: adding service <uuid> for bsvpay-<base32>
D LocalPayBle: payee: service added <uuid>; starting advertising
D LocalPayBle: payee: advertising <uuid> (<n> ms after startListening)
D LocalPayBle: payee: central connected <B mac> (status 0)
D LocalPayBle: payee: mtu <M> for <B mac>
D LocalPayBle: payee: <B mac> subscribed to ACK
D LocalPayBle: payee: HELLO_A verified from <B mac> at <a1> ms; sending HELLO_B
D LocalPayBle: payee: frame accepted (<bytes> bytes, mtu <M>) from <B mac> at <a2> ms; advertising stopped
D LocalPayBle: payee: ack ok=true delivered=true to <B mac> in <ta> ms
D LocalPayBle: payee: central disconnected <B mac> (status 0)
```

### Expected line sequence — payer (phone B)

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

Pass criteria (Android ↔ Android, Step 10.2): `<M>` ≥ 185 on both sides and identical; `<t5>` < 6000 (inside `BLE_CONNECT_TIMEOUT_MS`); `<T>` < 20000; B's screen shows the sent state and A's shows the received payment; no `ReactNativeJS` warning containing `radio_fallback`.

### Cross-OS specifics

- **Android (payer B) → iOS (payee), Step 11 — run this first.** iPhone: Receive → Nearby (Task 8 build, Console.app filtered on `LocalPayBle`). Phone B: Pay → scan the iPhone's QR → confirm. B shows the same nine `payer:` lines; the iOS default MTU means `<M>` is typically 185 or 527 — record whichever appears. Also confirm on the iPhone: Task 8's `hello verified id=…`, `frame accepted bytes=… id=…` and `ack sent ok=1 bytes=44`. If B stalls at `connected … requesting mtu 517` for 2 s and then logs `mtu negotiation timed out; discovering with mtu 23`, the transfer must STILL complete (at ~2.5 KB/s) — record it as a finding, not a failure, and note the iPhone model / iOS version.
- **iOS (payer) → Android (payee A), Step 12.** Phone A: Receive → Nearby. iPhone: Pay → scan A's QR → confirm. A shows the same payee lines with the iPhone's MAC (a random resolvable address — it changes per connection, that is normal).

  **First check, before any timing — the with-response chunk ceiling.** Watch the FIRST FRAME write. The iPhone must log `frame first chunk bytes=<n>` with **n ≤ 512**, and A must **NOT** log `payee: frame refused reason=prepared write`. A refusal there means the with-response chunk exceeded 512 bytes (`maximumWriteValueLength(for: .withResponse)`), CoreBluetooth satisfied the write as a prepare/execute long write, and the Kotlin peripheral answered `GATT_REQUEST_NOT_SUPPORTED` and dropped the link — every iOS→Android payment with a framed FRAME over ~514 bytes would die at the first FRAME write and fall to the fountain. Cross-check the iPhone's `connected … maxWriteLen=<N> withResponse=<W> chunk=<C>` line: against an Android peripheral that granted MTU 517, expect `maxWriteLen=514 withResponse=512 chunk=512`, and `bytes=<n>` on the first chunk must equal `<C>` whenever the framed FRAME is larger than one chunk. Record `<C>` and `<n>` in the Notes column even when the row passes.

  Then the rest of the pass criteria: `payee: mtu <M> for <mac>` appears BEFORE `subscribed to ACK` (iOS initiates the MTU exchange itself), `<M>` ≥ 185, `ack ok=true delivered=true`, iPhone shows the sent state. Then the lock-screen case: A listening, lock A's screen, iPhone pays — expect the iPhone to fall to the fountain within its connect budget and A's logcat to show either nothing or `central connected` followed by `idle reaper dropped` 30 s later; no `frame accepted`.

### Negative-case procedures

3. **Radios off** — turn Bluetooth OFF on A, repeat the happy path. Expect B: `payer: scanning for <uuid>` then, at 6000 ± 100 ms, the JS radio-fallback path (fountain QR appears); no `found` line. Record the elapsed ms from the JS `[localpay]` warning.
4. **Second device, same QR** — with A listening, pay from B (succeeds), then immediately scan the same QR from a third phone or from B again. Expect the second payer to see `connect timeout: no route to peer` (A stopped advertising) and the fountain; A's logcat shows no second `frame accepted`.
5. **Stranger / garbage** — with A listening and B NOT paying, run in B's Metro console:

   ```js
   require('react-native-localpay-transport').getLocalPayBleTransport()
     .sendFrame('<A instanceName>', btoa(String.fromCharCode(...new Uint8Array(32))), btoa('xx'), 20000, 6000)
     .catch(e => console.warn('stranger:', e.message))
   ```

   The wrong PSK derives a different service UUID, so scanning simply times out: expect `stranger: connect timeout: no route to peer`. Then point an off-the-shelf BLE tool (nRF Connect) at A's service and write 37 arbitrary bytes to `B5A1E001-7374-4F6E-8E2D-425356504159`: expect A's logcat to show `payee: bad framing from <mac>` or `payee: HELLO_A proof failed from <mac>; dropping`, and A to keep advertising (a fresh payment from B still succeeds afterwards).

Every terminal failure logs its own line on Android too, so each failure row is a positive check rather than an inference from a missing line: payer `payer: send failed reason=<message>` (the message is the contract string JS receives), payee `payee: frame refused reason=<why> id=<mac>` for a FRAME that was not bound, already accepted, empty or oversize, and `payee: ack reaper fired; connection released (<mac>)` if the 60 s hold expired. Record the exact line seen in the Observed column.

---

## Flow wiring (Task 10) — not yet run

Tasks 8 and 9 above prove the two native backends. These rows prove the **JS wiring** on top of them: the payee's minting sequence (`prepareBle` before any listener starts), the multi-listener race, the per-radio advisories, the payer's floor copy, the lazy Android BLE grant, and the presence-row medium. No jest can cover this end to end — every row is a two-device path through the real radios.

Build and install a dev-client on each physical device from the repo root (`package.json:12,16`; both are EAS local builds, `.ipa`/`.apk` land in the repo root and are gitignored):

```bash
npm run ios-dev-physical
npm run android-dev-physical
# then, for the Metro tunnel:
npm run ios-dev-device
```

Watch native logs while running each row — the log strings below are the ones Task 8 (Swift, `os_log`) and Task 9 (Kotlin, `Log.d`) actually emit:

```bash
# iOS, phone attached (or Console.app: subsystem:org.bsvblockchain.wallet category:LocalPayBle)
log stream --predicate 'subsystem == "org.bsvblockchain.wallet" AND category == "LocalPayBle"' --level debug
# Android
adb logcat -s LocalPayBle:D ReactNativeJS:W
```

Record the measured numbers next to each row in the PR description.

| # | Setup | Do | Expect on screen | Expect in logs | Observed |
|---|---|---|---|---|---|
| 1 | Android payee, iPhone payer, Bluetooth on both, Wi-Fi off on both | Payee: Pay → Receive → Continue. Payer: scan. | Payee `receive_wait` presence shows the **bluetooth** glyph in the `waiting` state, breathing (the glyph itself pulses — there is no separate dot). Payer `send_confirm` shows the `ready` state with a steady bluetooth glyph and NO floor sentence. Send → `Payment sent`; payee `Payment received`. | Payee (logcat `LocalPayBle`): `prepare: poweredOn`, `payee: advertising <uuid>`, `payee: HELLO_A verified from <mac>`, `payee: frame accepted (<n> bytes, mtu <M>)`, `payee: ack ok=true delivered=true`. Payer (Console `LocalPayBle`): `scanning service=<uuid>`, `scan hit rssi=… ms=…`, `connected id=… maxWriteLen=…`, `subscribed ms=…`, `hello verified ms=…`, `frame written bytes=… ms=…`, `ack verified bytes=11 ms=…`. Note the `ms` values. | pending — requires devices; not run in the implementation session |
| 2 | Same as 1 but iPhone payee, Android payer | Same | Same, mirrored. | Payee (Console): `prepare resolved state=poweredOn`, `advertising started service=<uuid> name=bsvpay-…`, `central connected id=… maxUpdate=…`, `hello verified id=…`, `frame accepted bytes=… id=…`, `ack sent ok=1 bytes=44`. Payer (logcat): `payer: scanning for <uuid>`, `payer: found …`, `payer: connected … requesting mtu 517`, `payer: mtu <M>`, `payer: subscribed to ACK`, `payer: HELLO_B verified`, `payer: frame written in … ms`, `payer: ack verified; total … ms`. | pending — requires devices; not run in the implementation session |
| 3 | iPhone payee with Bluetooth OFF, Android payer | Payee mints; payer scans | Payee: presence in the `qr` state — the qr-code glyph, steady, never a radio one. Payer `send_confirm`: "Their Bluetooth is off, so this payment will go by code." (`peer_bt_off`), Send → fountain. | Payee (Console): `peripheral manager state=poweredOff`, `prepare resolved state=poweredOff` within 1.5 s; no `advertising started`. Payer (logcat): no `payer: scanning` line — the ladder never picked BLE. | pending — requires devices; not run in the implementation session |
| 4a | Android payee Bluetooth ON, iPhone payer Bluetooth OFF, payer app freshly launched | Payer scans, taps Send | First attempt: `send_confirm` shows `ready` (a radio that is merely off cannot be told from on without prompting — Task 8 `isSupported`), Send fails fast and falls to the fountain with "Wireless link unavailable — show this code…" (`local_pay_radio_fallback`); no failure screen. | Payer (Console): `central manager state=poweredOff` immediately after Send, no `scanning`. | pending — requires devices; not run in the implementation session |
| 4b | Same devices, payer rescans the same QR in the same app session (or an Android payer with Bluetooth off, first scan) | Payer scans | `send_confirm` shows "Your Bluetooth is off. Turn it on for a faster nearby link." (`local_bt_off`); Send → fountain directly. | iPhone: no new `LocalPayBle` lines (the manager already reported `poweredOff`, so the ladder floors). Android payer: no `LocalPayBle` lines at all (`isSupported` reads `isEnabled`). | pending — requires devices; not run in the implementation session |
| 5 | Android payee, iPhone payer with Bluetooth permission for BSV Wallet set to Off in Settings → Privacy & Security → Bluetooth | Payer scans | "Bluetooth access is off for BSV Wallet. Allow it in Settings…" (`local_ble_denied`) plus an **Open Settings** button that lands on the app's Settings page. | Payer: no `LocalPayBle` lines — `readBluetoothState()` answered `unauthorized` prompt-free and the ladder floored. | pending — requires devices; not run in the implementation session |
| 6 | iOS↔iOS, both Bluetooth on, Wi-Fi on | Payee mints, payer scans | Presence shows the **wifi** glyph on both, never bluetooth (AWDL outranks BLE, spec §5, and BLE is not the payee's only live listener): payee `waiting`, breathing; payer `send_confirm` `ready`, steady. Payment completes over AWDL. | Payee (Console): `advertising started …` from the BLE object AND the AWDL listener's own start; after the frame lands over AWDL, `listener stopped by JS` (raceReceivers aborted the BLE loser) and NO `frame accepted` / `ack sent` from the BLE object. | pending — requires devices; not run in the implementation session |
| 7 | iOS↔iOS, both Bluetooth on, Wi-Fi on; the payee switches Bluetooth OFF mid-wait (Settings, not Control Center) | Wait 5 s, then pay over AWDL | Payee: one advisory "Bluetooth is unavailable. The code above still works." (`local_pay_ble_unavailable`); presence still `waiting` with the **wifi** glyph, still breathing — BLE dropping out must not flip the glyph to bluetooth or stop the pulse while AWDL is alive; the AWDL payment completes. | Payee (Console): `peripheral manager state=poweredOff` then nothing more from the BLE object; AWDL lines untouched. (Android payee equivalent: `payee: bluetooth turned off under a live listener` from Task 9's adapter receiver.) | pending — requires devices; not run in the implementation session |
| 8 | Android payee, iPhone payer, payer backgrounds the app during `send_working` | Send, press Home within 1 s | Same as the AWDL/Nearby path today (the abort path is shared): no failure screen on the payer, the held build is released (Activity shows no stuck row), payee stays on `receive_wait` with its QR. | Payee (logcat): `payee: central disconnected <mac>` (or `payee: idle reaper dropped <mac>` 30 s later) and NO `frame accepted`; a fresh scan from the payer afterwards still succeeds — advertising never stopped. | pending — requires devices; not run in the implementation session |
| 9 | Row 1 but a second Android holds a photo of the same QR and pays second | Two payers, 10 s apart | Second payer: BLE connect times out within 6 s (the payee stopped advertising at the first accept) → fountain. If the payee then scans that fountain its screen shows `already_paid` and stays settled on the first payment; the first payer is unaffected. | Payee: exactly one `payee: frame accepted` for the session; second payer's logcat: `payer: scanning for <uuid>` and no `payer: found`, then JS `[localpay] radio send failed, falling back to QR: connect timeout: no route to peer`. | pending — requires devices; not run in the implementation session |
| 10 | Android payee, Android payer that has never granted Bluetooth to BSV Wallet, no GMS on the payer (or Nearby denied) | Payer scans, taps Send, denies the runtime prompt | Payer falls to the fountain with "Wireless link unavailable — show this code to the other device instead." (`local_pay_radio_fallback`); no failure screen. | Payer JS: `[localpay] radio send failed, falling back to QR: bluetooth permission not granted`; no `LocalPayBle` lines. | pending — requires devices; not run in the implementation session |

Any row that does not match is a bug in Task 10's wiring **unless** the missing log line is a native one, in which case it belongs to Task 8 (Swift) or Task 9 (Kotlin) — record which and stop rather than patching around it here.

## Status: flow rows not yet run

Every row above is `pending — requires devices; not run in the implementation session`. The JS wiring is implemented and typechecks, and the arbitration it rests on (`raceReceivers`) and the prompt boundary (`prepareBle`) are unit-tested in `packages/expo-wallet-toolbox/__tests__/localpay/race.test.ts` and `prepareBle.test.ts`; what those tests cannot prove is the ordering against real radios and the two permission prompts. No devices were attached when this section was written.
