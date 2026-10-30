# Changelog

## 0.0.0 (unreleased, `private: true` until release)

- Kotlin loopback HTTP server (strict HTTP/1.1 parser, dual-family exclusive bind on 3321 to 3384, hold-open responses,
  Kotlin deadline timers), exported launch trampoline (`bsv-wallet-bridge://launch`), foreground service (`specialUse`,
  `START_NOT_STICKY`) and the `BsvAndroidBridge` Expo module. Pure-JVM Kotlin sources are tested under `android/jvmtest`.
- Config plugin `withAndroidWalletBridge`: the trampoline's single intent filter, scheme validation and collision checks,
  warnings for `SYSTEM_ALERT_WINDOW` and `allowBackup`.
- TypeScript controller: launch registry, binding ledger, session machine, unsettled-binding gate, reconnect-token outbox,
  attention notifications, `setupAndroidBridge`, `AndroidBridgeHost`, `AndroidBridgeNotices`, SecureStore continuity store.
- Stand-in loopback page client, demo page with the shared BRC-100 conformance panel, and the emulator end-to-end driver.
- Foreground mode (milestone 1).
- Overlay mode (milestone 2, experimental, not shippable until the owner device gates pass): `BridgeSheetActivity` raises the
  permission sheets over Chrome on a second React root when the wallet is warm and unlocked, with a guarded delegate, native
  Back, the Home rule, `FLAG_SECURE`, hidden overlay windows, dropped obscured touches with a fallback to the wallet screen, an
  idle non-touchable window, `LifecycleTracker`, `sheetOwner()`, `AndroidBridgeSheetGate`, the overlay `returnToBrowser` and a
  notification tap that targets the sheet Activity. Background prompts stay notification-only (`showSheet` is not built).
