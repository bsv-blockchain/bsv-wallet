// Keeps the YubiKit pin that `expo prebuild` otherwise drops.
//
// YubiKit 4.4.1 is tagged on github.com/Yubico/yubikit-ios but was never
// published to the CocoaPods trunk (trunk stops at 4.4.0). The checked-in
// ios/Podfile pins that tag. A prebuild rewrites the Podfile from the Expo
// template, the pin disappears, and `pod install` cannot resolve the
// dependency YubiKeyPiv.podspec declares.
const { withPodfile } = require('@expo/config-plugins')

const YUBI_POD = "  pod 'YubiKit', :git => 'https://github.com/Yubico/yubikit-ios.git', :tag => '4.4.1'\n"
const FIREBASE_SPM =
  '# react-native-firebase: opt out of SPM; SPM + use_frameworks static collides.\n$RNFirebaseDisableSPM = true\n'

function withIosPodfileFixes(config) {
  return withPodfile(config, mod => {
    let contents = mod.modResults.contents
    if (!contents.includes('$RNFirebaseDisableSPM')) {
      const anchor = 'prepare_react_native_project!\n'
      if (!contents.includes(anchor)) {
        throw new Error('withIosPodfileFixes: Podfile has no prepare_react_native_project! anchor')
      }
      contents = contents.replace(anchor, `${FIREBASE_SPM}\n${anchor}`)
    }
    if (!contents.includes("pod 'YubiKit'")) {
      const anchor = 'use_expo_modules!\n'
      if (!contents.includes(anchor)) {
        throw new Error('withIosPodfileFixes: Podfile has no use_expo_modules! anchor')
      }
      contents = contents.replace(anchor, `${anchor}\n${YUBI_POD}`)
    }
    mod.modResults.contents = contents
    return mod
  })
}

module.exports = withIosPodfileFixes
