// Test harness: runs the plugin against a fake config and executes the manifest mods it registered.
jest.mock('expo/config-plugins', () => ({
  withAndroidManifest: (config, fn) => {
    config.__manifestMods = [...(config.__manifestMods || []), fn]
    return config
  }
}))
jest.mock('@expo/config-plugins', () => ({
  withAndroidManifest: (config, fn) => {
    config.__manifestMods = [...(config.__manifestMods || []), fn]
    return config
  }
}))

const withAndroidWalletBridge = require('../../plugin')

const hostConfig = (extra = {}) => ({
  name: 'Wallet',
  slug: 'wallet',
  scheme: ['bsv-wallet', 'bsv'],
  android: {
    package: 'org.bsvblockchain.wallet',
    allowBackup: false,
    blockedPermissions: ['android.permission.SYSTEM_ALERT_WINDOW']
  },
  ...extra
})

/** A host manifest like the prebuild output: MainActivity with host links and two icon aliases. */
const hostManifest = () => ({
  manifest: {
    $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
    application: [
      {
        $: { 'android:name': '.MainApplication', 'android:allowBackup': 'false' },
        activity: [
          {
            $: { 'android:name': '.MainActivity' },
            'intent-filter': [
              {
                action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
                category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }]
              },
              {
                action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
                category: [
                  { $: { 'android:name': 'android.intent.category.DEFAULT' } },
                  { $: { 'android:name': 'android.intent.category.BROWSABLE' } }
                ],
                data: [{ $: { 'android:scheme': 'bsv-wallet' } }]
              }
            ]
          }
        ],
        'activity-alias': [
          {
            $: { 'android:name': '.Alias', 'android:targetActivity': '.MainActivity' },
            'intent-filter': [
              {
                action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
                category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }]
              }
            ]
          }
        ]
      }
    ]
  }
})

function run({ config, options = { scheme: 'bsv-wallet-bridge' }, manifest = hostManifest() } = {}) {
  const out = withAndroidWalletBridge(config || hostConfig(), options)
  let modResults = manifest
  for (const mod of out.__manifestMods) modResults = mod({ modResults }).modResults
  return { config: out, manifest: modResults }
}

/** Applies another plugin's registered mods (here the host's withIconAliasLinks) on top of a manifest. */
function applyMods(plugin, manifest) {
  const cfg = plugin({})
  let modResults = manifest
  for (const mod of cfg.__manifestMods) modResults = mod({ modResults }).modResults
  return modResults
}

module.exports = { run, hostConfig, hostManifest, applyMods }
