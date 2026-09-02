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
