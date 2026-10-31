# Device flows

These Maestro flows drive a compiled BSV Wallet dev-client. They are not part of `pnpm test` or the required CI gate: they need a booted Android emulator or iOS simulator and an installed binary.

```bash
# Android emulator or device, dev-client already installed
maestro test e2e/maestro
```

iOS needs macOS, Xcode, and a dev-client built with `npm run ios-dev-build`. GitHub-hosted runners for this repository's required checks are Ubuntu, so the browser journeys (`pnpm test:e2e`) are what CI runs instead. `.github/workflows/e2e-device.yml` is manual and expects a `wallet-apk` artifact.

The flows use the English labels from `app/auth/mnemonic.tsx` and the home screen. A wallet that is already on the device will not show "Create New Wallet"; clear app data first.
