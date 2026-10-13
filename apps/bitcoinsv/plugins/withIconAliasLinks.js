// Android's alternate app icons (expo-alternate-app-icons) are activity
// aliases with only the launcher's intent filter. Choosing one disables
// MainActivity, and with it every link the app opens (bitcoinsv-wallet://,
// pay links, the dev client's own scheme): Android finds no activity for
// them. Each alias gets MainActivity's other intent filters too. Only one of
// MainActivity and the aliases is ever enabled, so a link still has exactly
// one place to go.
//
// Listed before expo-alternate-app-icons in app.config.js: manifest mods run
// in reverse, so this one sees the aliases it adds.
const { withAndroidManifest } = require('@expo/config-plugins')

const isLauncher = filter =>
  (filter.category ?? []).some(c => c.$['android:name'] === 'android.intent.category.LAUNCHER')

module.exports = function withIconAliasLinks(config) {
  return withAndroidManifest(config, cfg => {
    const app = cfg.modResults.manifest.application?.[0]
    if (!app) return cfg
    const main = (app.activity ?? []).find(a => a.$['android:name'] === '.MainActivity')
    const links = (main?.['intent-filter'] ?? []).filter(f => !isLauncher(f))
    for (const alias of app['activity-alias'] ?? []) {
      if (alias.$['android:targetActivity'] !== '.MainActivity') continue
      const own = (alias['intent-filter'] ?? []).filter(isLauncher)
      alias['intent-filter'] = [...own, ...links.map(f => JSON.parse(JSON.stringify(f)))]
    }
    return cfg
  })
}
