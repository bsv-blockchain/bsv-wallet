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
- Foreground mode only (milestone 1). The overlay over Chrome (milestone 2) is gated on a spike and not built.
