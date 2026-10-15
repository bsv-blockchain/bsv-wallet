const root = require('../../app.json').expo
module.exports = {
  name: 'BSV Merchant',
  slug: 'bsv-merchant',
  version: '0.1.0',
  icon: '../bitcoinsv/assets/images/icon.png',
  extra: { eas: { projectId: '9cc7b574-5d36-464c-964a-6d532eff1c53' } },
  scheme: 'bsv-pos',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: 'org.bsvblockchain.merchant',
    appleTeamId: 'SV8SWTHA2H',
    supportsTablet: true,
    infoPlist: {
      NSCameraUsageDescription: 'Scan cashier enrollment and payment codes.',
      NSBluetoothAlwaysUsageDescription: 'Receive nearby payments from customer wallets.',
      NSLocalNetworkUsageDescription: 'Receive payments over nearby Wi-Fi.',
      NSBonjourServices: root.ios.infoPlist.NSBonjourServices,
      ITSAppUsesNonExemptEncryption: false,
      NSFaceIDUsageDescription: 'Protect your point of sale wallet identity.',
      NSBluetoothPeripheralUsageDescription: 'Receive nearby payments.',
      NSLocationWhenInUseUsageDescription: 'Discover nearby payment devices.'
    }
  },
  android: { package: 'org.bsvblockchain.pos', allowBackup: false, permissions: root.android.permissions },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-sqlite',
    'expo-localization',
    'expo-camera',
    [
      'expo-build-properties',
      {
        android: root.plugins.find(p => Array.isArray(p) && p[0] === 'expo-build-properties')[1].android,
        ios: { deploymentTarget: '16.4' }
      }
    ]
  ],
  experiments: { typedRoutes: false }
}
