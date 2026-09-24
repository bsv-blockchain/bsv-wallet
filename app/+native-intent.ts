// Imported from the specific module rather than the package barrel
// ('@bsv/expo-wallet-toolbox'): this file must stay a pure, dependency-light
// adapter, and the barrel also re-exports UI/context modules that pull in
// native-only dependencies this early-startup file has no business loading.
import { resolveNativeIntent } from '@bsv/expo-wallet-toolbox/core/pay/rails/nativeIntent'
import appJson from '../app.json'

// This app's own custom URL schemes, read from app.json rather than
// hard-coded, so the toolbox's route resolution stays reusable by a second
// wallet app with different schemes. `resolveNativeIntent` passes an
// external `pair` link straight through to `/pair` (PairScreen's own
// Approve/Reject card) and redirects the two destructive recovery routes
// (`auth/scan-shares`, `auth/mnemonic?flow=import`) to `/`; see its doc
// comment for why.
const scheme = appJson.expo.scheme
const walletSchemes = Array.isArray(scheme) ? scheme : [scheme]

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return resolveNativeIntent(path, { walletSchemes })
}
