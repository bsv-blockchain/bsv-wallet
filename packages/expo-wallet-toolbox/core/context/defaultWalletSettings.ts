import { DEFAULT_SETTINGS as LIB_DEFAULT_SETTINGS, WalletSettings } from '@bsv/wallet-toolbox-mobile'

// BRC-100 bounds certifierInfo.description to 5-50 UTF-8 bytes, and @bsv/sdk
// 2.8.8+ rejects a discovery result outside it. The wallet copies these
// descriptions into certifierInfo, and the library ships Metanet Trust Services
// and SocialCert at 55 and 56 bytes, so every identity lookup returning one of
// their certificates threw in the dApp. Same wording as ts-stack#665, which
// fixes the library; drop this once @bsv/wallet-toolbox-mobile ships it.
const LIB_CERTIFIER_DESCRIPTIONS: Record<string, string> = {
  '03daf815fe38f83da0ad83b5bedc520aa488aef5cbc93a93c67a7fe60406cbffe8': 'Registry of protocols, baskets, certificate types',
  '02cf6cdf466951d8dfc9e7c9367511d0007ed6fba35ed42d425cc412fd6cfd4a17': 'Certifies social media handles, phones and emails'
}

export const DEFAULT_SETTINGS: WalletSettings = {
  ...LIB_DEFAULT_SETTINGS,
  trustSettings: {
    ...LIB_DEFAULT_SETTINGS.trustSettings,
    trustedCertifiers: [
      ...LIB_DEFAULT_SETTINGS.trustSettings.trustedCertifiers.map(certifier => ({
        ...certifier,
        description: LIB_CERTIFIER_DESCRIPTIONS[certifier.identityKey] ?? certifier.description
      })),
      {
        name: 'Who I Am',
        description: 'Certifies email, phone, and X account ownership',
        iconUrl: 'https://whoiam.bsvblockchain.tech/whoiam.png',
        identityKey: '02e7eeb3986273db6843b790a1595ed0ff1b2ae8f43ae2e7f1a0c9db4dd3fb9441',
        trust: 5
      },
      // Values as published in https://auth.sigmaidentity.com/manifest.json
      // (babbage.trust). Lowest trust of the shipped set: it is the newest
      // certifier here and the list is ordered by trust on the Trust screen.
      // The icon is an SVG; the Trust screen draws those with react-native-svg
      // rather than the platform decoder, which mispositions its <text> glyph.
      {
        name: 'Sigma Identity',
        description: 'Certifies verified identity claims',
        iconUrl: 'https://auth.sigmaidentity.com/sigma-mark.svg',
        identityKey: '02250905f0383085b53409876aefbf01fc8e7fd841922dc4ce55ae035b31341e6d',
        trust: 2
      }
    ]
  }
}
