// withAndroidWalletBridge (spec 6.3). Does only what depends on the host: validates the launch scheme, gives the
// trampoline its one intent filter, and warns about host settings that weaken the kit. The Activities, service and
// permissions live in the library manifest. Nothing here edits the host's app.config.js or reads the environment.

const { withAndroidManifest } = require('expo/config-plugins')

const { resolveScheme, hostWarnings, PREFIX } = require('./validate')
const { applyManifest } = require('./manifest')

function withAndroidWalletBridge(config, options = {}) {
  const scheme = resolveScheme(config, options)
  for (const w of hostWarnings(config)) console.warn(`${PREFIX}: ${w}`)
  return withAndroidManifest(config, c => {
    c.modResults = applyManifest(c.modResults, scheme)
    const app = c.modResults.manifest.application && c.modResults.manifest.application[0]
    if (app && app.$ && app.$['android:allowBackup'] === 'true') {
      console.warn(
        `${PREFIX}: android:allowBackup is "true" in the app manifest; the continuity seed would be backed up`
      )
    }
    return c
  })
}

module.exports = withAndroidWalletBridge
module.exports.withAndroidWalletBridge = withAndroidWalletBridge
module.exports.resolveScheme = resolveScheme
