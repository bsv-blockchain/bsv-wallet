// Same adapter as the existing app's app/+native-intent.ts, with this app's
// own scheme. Imported from the specific module, not the toolbox barrel: this
// early-startup file must not pull in native-only UI dependencies.
import { resolveNativeIntent } from '@bsv/expo-wallet-toolbox/core/pay/rails/nativeIntent'
import { resolveWebLink } from '../src/links/webLinks'
import { LINK_DOMAIN } from '../src/links/linkDomain'

// Only this app's scheme. The existing app's bsv-wallet, bsv-browser and
// peerpay schemes are never registered here, so their links keep opening the
// existing app.
const walletSchemes = ['bitcoinsv-wallet']

// expo-dev-client opens a development build with
// `<scheme>://expo-development-client/?url=<metro>`. That link is for the dev
// launcher, not a wallet route; without this it lands on "Unmatched Route".
const DEV_CLIENT_LINK = /^[a-z][a-z0-9+.-]*:\/\/expo-development-client\b/i

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  if (DEV_CLIENT_LINK.test(path ?? '')) return '/'
  // a website link (https://bitcoinsv.com/pay/…, /@handle): Pay, filled in
  const web = resolveWebLink(path, LINK_DOMAIN)
  if (web) return web
  return resolveNativeIntent(path, { walletSchemes })
}
