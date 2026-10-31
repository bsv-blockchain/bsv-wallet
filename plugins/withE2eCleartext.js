// Cleartext HTTP for the E2E mock broadcaster only.
//
// A production prebuild does not set EXPO_PUBLIC_E2E, and this plugin returns
// the config untouched. The harness binary needs plain HTTP to 10.0.2.2
// (Android emulator) and 127.0.0.1 (iOS simulator). That exception is not
// applied to any other build.
const { withAndroidManifest, withInfoPlist } = require('@expo/config-plugins')

function withE2eCleartext(config) {
  if (process.env.EXPO_PUBLIC_E2E !== 'true') return config

  config = withAndroidManifest(config, mod => {
    const application = mod.modResults.manifest.application?.[0]
    if (application) {
      application.$['android:usesCleartextTraffic'] = 'true'
    }
    return mod
  })

  config = withInfoPlist(config, mod => {
    const existing = mod.modResults.NSAppTransportSecurity ?? {}
    mod.modResults.NSAppTransportSecurity = {
      ...existing,
      NSAllowsLocalNetworking: true,
      // The simulator uses loopback. A physical device pointed at a LAN mock
      // (EXPO_PUBLIC_E2E_BROADCASTER_URL) needs the wider exception. This
      // Info.plist is produced only for the harness prebuild.
      NSAllowsArbitraryLoads: true
    }
    return mod
  })

  return config
}

module.exports = withE2eCleartext
