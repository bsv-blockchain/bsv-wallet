// Keeps the YubiKit pin that `expo prebuild` otherwise drops.
//
// YubiKit 4.4.1 is tagged on github.com/Yubico/yubikit-ios but was never
// published to the CocoaPods trunk (trunk stops at 4.4.0). The checked-in
// ios/Podfile pins that tag. A prebuild rewrites the Podfile from the Expo
// template, the pin disappears, and `pod install` cannot resolve the
// dependency YubiKeyPiv.podspec declares.
const { withPodfile } = require('@expo/config-plugins')

const YUBI_POD = "  pod 'YubiKit', :git => 'https://github.com/Yubico/yubikit-ios.git', :tag => '4.4.1'\n"

function withIosPodfileFixes(config) {
  return withPodfile(config, mod => {
    const contents = mod.modResults.contents
    if (contents.includes("pod 'YubiKit'")) return mod
    const anchor = 'use_expo_modules!\n'
    if (!contents.includes(anchor)) {
      throw new Error('withIosPodfileFixes: Podfile has no use_expo_modules! anchor')
    }
    mod.modResults.contents = contents.replace(anchor, `${anchor}\n${YUBI_POD}`)
    return mod
  })
}

module.exports = withIosPodfileFixes
