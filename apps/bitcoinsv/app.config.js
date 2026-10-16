// Expo config for the Bitcoin SV Wallet app (Now mode).
//
// This app takes over the existing BSV Wallet's installed identity (repo root
// app.json): same bundle ID / package, EAS project, Firebase registrations and
// URL schemes, so it ships as an update to the same App Store / Play listing.
// Installed over the existing app, it inherits that app's keychain, SQLite,
// AsyncStorage and secure store. Both shells still share one wallet
// implementation (packages/expo-wallet-toolbox). __tests__/isolation.test.js
// fails if this identity drifts from the root app's.
//
// Never add ios.entitlements keychain-access-groups or
// com.apple.security.application-groups, or an Android sharedUserId: those
// would expose wallet storage to other apps.
const fs = require('fs')
const path = require('path')

const rootApp = require('../../app.json').expo

// The native build settings (deployment target, static frameworks, ProGuard
// keep rules for Nitro / quick-crypto / expo-sqlite) are about the shared
// native modules, not about either app, so they are read from the existing app
// instead of copied: a fix there applies to both builds.
const rootPlugin = name => {
  const entry = rootApp.plugins.find(p => (Array.isArray(p) ? p[0] : p) === name)
  if (!entry) throw new Error(`app.config.js: root app.json has no ${name} plugin entry`)
  return entry
}

// The existing app's identity, read from its app.json rather than copied, so
// the two cannot drift. The URL schemes are the existing app's: bsv-wallet,
// bsv-browser, and peerpay through CFBundleURLTypes / intentFilters.
const rootSchemes = Array.isArray(rootApp.scheme) ? rootApp.scheme : [rootApp.scheme]
const IDENTITY = {
  name: 'Bitcoin SV Wallet',
  slug: rootApp.slug,
  owner: rootApp.owner,
  scheme: rootSchemes,
  bundleIdentifier: rootApp.ios.bundleIdentifier,
  package: rootApp.android.package,
  easProjectId: rootApp.extra.eas.projectId
}

// Firebase (payment push): the existing app's registrations for the shared
// bundle ID / package, at the repository root.
const iosFirebase = path.join(__dirname, '../..', rootApp.ios.googleServicesFile)
const androidFirebase = path.join(__dirname, '../..', rootApp.android.googleServicesFile)
const hasFirebase = fs.existsSync(iosFirebase) && fs.existsSync(androidFirebase)
const iosFirebaseFile = path.relative(__dirname, iosFirebase)
const androidFirebaseFile = path.relative(__dirname, androidFirebase)

// Website links (src/links/webLinks.ts): with EXPO_PUBLIC_LINK_DOMAIN set (e.g.
// bitcoinsv.com), the phone hands https://<domain>/pay/… and /@… links to the
// app once BSVA hosts web/.well-known/ there (iOS universal links, Android
// verified app links). Unset, builds are as before.
// read off a plain object: babel-preset-expo rewrites `process.env.EXPO_PUBLIC_*`
// into an ES import, which Jest can't load when the tests read this config
const buildEnv = process.env
const linkDomain = (buildEnv.EXPO_PUBLIC_LINK_DOMAIN || '').trim().toLowerCase()
const linkHosts = linkDomain ? [linkDomain, `www.${linkDomain}`] : []

// Release builds set APS_ENVIRONMENT=production; everything else registers
// against the APNs sandbox.
const apsEnvironment = process.env.APS_ENVIRONMENT === 'production' ? 'production' : 'development'

// Brand colours from the prototype's tokens (src/theme/tokens.ts is generated
// from the same source). Native config cannot import the TS module.
const BRAND_GOLD = '#ffaf00'
const PAPER = '#f4f3f0'
const NIGHT = '#0b0b0d'

// The prototype's typefaces, embedded at build time (no runtime loading, so
// text never flashes in a fallback face): Nunito for everything, Caveat for
// the Home tour's handwriting. Static instances, one file per weight the
// prototype uses, because Android does not apply variable-font weights.
const fontFile = (pkg, file) =>
  path.relative(__dirname, path.join(path.dirname(require.resolve(`${pkg}/package.json`)), file))
const FONT_FAMILIES = [
  {
    fontFamily: 'Nunito',
    pkg: '@expo-google-fonts/nunito',
    weights: { 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' }
  },
  { fontFamily: 'Caveat', pkg: '@expo-google-fonts/caveat', weights: { 600: 'SemiBold', 700: 'Bold' } }
].map(({ fontFamily, pkg, weights }) => ({
  fontFamily,
  fontDefinitions: Object.entries(weights).map(([weight, name]) => ({
    path: fontFile(pkg, `${weight}${name}/${fontFamily}_${weight}${name}.ttf`),
    weight: Number(weight)
  }))
}))
const FONT_PLUGIN = [
  'expo-font',
  {
    ios: { fonts: FONT_FAMILIES.flatMap(f => f.fontDefinitions.map(d => d.path)) },
    android: { fonts: FONT_FAMILIES }
  }
]

module.exports = () => ({
  name: IDENTITY.name,
  slug: IDENTITY.slug,
  owner: IDENTITY.owner,
  scheme: IDENTITY.scheme,
  // continues the existing app's store version line
  version: rootApp.version,
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  userInterfaceStyle: 'automatic',
  plugins: [
    // the icon aliases open the app's links too (before the icons: mods run in reverse)
    './plugins/withIconAliasLinks',
    './plugins/withLaunchWindowBackground',
    './plugins/withHomeLaunchScreen',
    './plugins/withSceneLifecycle',
    // Settings → App icon (the prototype's): the default is BSV Wallet's icon
    // (lifted from the root app); these are the others, iOS's alternate icons
    // and Android's activity aliases. Classic is the earlier Bitcoin SV mark.
    [
      'expo-alternate-app-icons',
      ['Classic', 'Dragon', 'Original', 'Satoshi'].map(name => ({
        name,
        ios: `./assets/images/app-icons/${name.toLowerCase()}.png`,
        android: {
          foregroundImage: `./assets/images/app-icons/${name.toLowerCase()}-foreground.png`,
          backgroundColor: '#FFFFFF'
        }
      }))
    ],
    '../../plugins/withNfcReaderEntitlement',
    ['../../plugins/withXcodeLastUpgradeVersion', { version: '2640' }],
    './plugins/withSharedNativePods',
    './plugins/withSpaceSafeBundlePhase',
    'expo-router',
    [
      'expo-splash-screen',
      {
        // The ground only. iOS's launch screen is Home's top as it first draws
        // (plugins/withHomeLaunchScreen.js replaces this storyboard); Android
        // 12+ crops splash images to a circle, so it's the plain ground, then
        // Home (app/index.tsx).
        image: './assets/images/splash-blank.png',
        imageWidth: 8,
        resizeMode: 'contain',
        backgroundColor: PAPER,
        dark: { image: './assets/images/splash-blank.png', backgroundColor: NIGHT }
      }
    ],
    'expo-secure-store',
    rootPlugin('expo-build-properties'),
    'expo-sqlite',
    'expo-localization',
    ['expo-camera', { microphonePermission: false, recordAudioAndroid: false }],
    FONT_PLUGIN,
    'expo-image',
    'expo-sharing',
    rootPlugin('expo-audio'),
    'expo-asset',
    ...(hasFirebase
      ? [
          '@react-native-firebase/app',
          [
            '@react-native-firebase/messaging',
            {
              android: {
                notificationIcon: './assets/images/notification-icon/notification_icon-xxxhdpi.png',
                notificationColor: BRAND_GOLD
              }
            }
          ],
          ['../../plugins/withAndroidNotificationIcon', { color: BRAND_GOLD }]
        ]
      : [])
  ],
  // Typed routes stay off: the shared toolbox screens navigate by string to the
  // existing app's routes (/pay, /vault, /auth/mnemonic, ...), which this app
  // does not have yet, so they cannot type-check against this app's route list.
  // Any toolbox screen reused here must have its routes provided or replaced.
  experiments: { typedRoutes: false },
  extra: {
    router: {},
    eas: { projectId: IDENTITY.easProjectId },
    pushConfigured: hasFirebase
  },
  android: {
    package: IDENTITY.package,
    ...(hasFirebase ? { googleServicesFile: androidFirebaseFile } : {}),
    // Same as the existing app: no OS cloud backup of wallet storage.
    allowBackup: false,
    adaptiveIcon: { foregroundImage: './assets/images/adaptive-icon.png', backgroundColor: '#e5af35' },
    permissions: [
      'android.permission.INTERNET',
      'android.permission.CAMERA',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.BLUETOOTH_ADVERTISE',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.BLUETOOTH_SCAN',
      'android.permission.NEARBY_WIFI_DEVICES',
      'android.permission.ACCESS_WIFI_STATE',
      'android.permission.CHANGE_WIFI_STATE',
      'android.permission.POST_NOTIFICATIONS'
    ],
    blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.SYSTEM_ALERT_WINDOW'],
    intentFilters: [
      ...rootApp.android.intentFilters,
      ...(linkDomain
        ? [
            {
              action: 'VIEW',
              autoVerify: true,
              data: linkHosts.flatMap(host => [
                { scheme: 'https', host, pathPrefix: '/pay/' },
                { scheme: 'https', host, pathPattern: '/@.*' }
              ]),
              category: ['BROWSABLE', 'DEFAULT']
            }
          ]
        : [])
    ]
  },
  ios: {
    supportsTablet: false,
    bundleIdentifier: IDENTITY.bundleIdentifier,
    ...(hasFirebase ? { googleServicesFile: iosFirebaseFile } : {}),
    entitlements: {
      ...(hasFirebase ? { 'aps-environment': apsEnvironment } : {}),
      ...(linkDomain ? { 'com.apple.developer.associated-domains': linkHosts.map(h => `applinks:${h}`) } : {})
    },
    infoPlist: {
      ...(hasFirebase ? { UIBackgroundModes: ['remote-notification'] } : {}),
      // peerpay plus the existing app's own schemes (with CFBundleURLTypes set,
      // Expo ignores `scheme` on iOS)
      CFBundleURLTypes: rootApp.ios.infoPlist.CFBundleURLTypes,
      NSCameraUsageDescription: 'Bitcoin SV Wallet uses the camera to scan payment and recovery QR codes.',
      NSPhotoLibraryAddUsageDescription:
        'Bitcoin SV Wallet saves QR codes and receipts to your photo library when you ask it to.',
      NSFaceIDUsageDescription: 'Bitcoin SV Wallet uses Face ID to protect your wallet and recovery phrase.',
      ITSAppUsesNonExemptEncryption: false,
      NSLocationWhenInUseUsageDescription:
        'Bitcoin SV Wallet may use your location to find nearby phones when you pay or get paid in person. It is only used while the app is open.',
      // Wire-protocol constant shared with the existing app so the two can pay each other.
      NSBonjourServices: rootApp.ios.infoPlist.NSBonjourServices,
      NSLocalNetworkUsageDescription: 'Bitcoin SV Wallet uses the local network to pay and get paid by nearby phones.',
      NSBluetoothAlwaysUsageDescription: 'Bitcoin SV Wallet uses Bluetooth to pay and get paid by nearby phones.',
      NSBluetoothPeripheralUsageDescription: 'Bitcoin SV Wallet uses Bluetooth to pay and get paid by nearby phones.',
      NFCReaderUsageDescription:
        'Bitcoin SV Wallet uses NFC to unlock your vault with your YubiKey. Hold the key to the top of your phone when asked.',
      // The YubiKey PIV applet AIDs, as the shared react-native-yubikey module needs them.
      'com.apple.developer.nfc.readersession.iso7816.select-identifiers':
        rootApp.ios.infoPlist['com.apple.developer.nfc.readersession.iso7816.select-identifiers']
    }
  }
})
