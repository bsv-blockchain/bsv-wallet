// Podfile lines the shared native modules need. The existing app carries them
// by hand in its committed ios/Podfile; this app's Podfile is generated, so
// they are injected here. Keep the two in step.
//
// - YubiKit 4.4.1 (react-native-yubikey's YubiKeyPiv.podspec requires ~> 4.4.1)
//   was tagged upstream but never published to the CocoaPods trunk, so it is
//   pinned to the official Yubico tag.
// - react-native-firebase is autolinked whether or not this app has its own
//   Firebase registration; its SPM integration collides with static
//   use_frameworks, so opt out.
const { withPodfile } = require('@expo/config-plugins')

const YUBIKIT = "  pod 'YubiKit', :git => 'https://github.com/Yubico/yubikit-ios.git', :tag => '4.4.1'"
const FIREBASE_SPM = '$RNFirebaseDisableSPM = true'

// expo-constants embeds app.config in the build through a script phase that
// breaks when the checkout path contains a space: `bash -l -c "<path>"`
// word-splits the path, and the script's unquoted `basename $PROJECT_DIR`
// silently skips the embed. Run the same script with its path quoted and with
// PROJECT_DIR / PROJECT_ROOT given explicitly (they are only used for that
// check and the project root).
const CONSTANTS_PHASE_FIX = `
    installer.pods_project.targets.each do |target|
      next unless target.name == 'EXConstants'
      target.shell_script_build_phases.each do |phase|
        next unless phase.shell_script.include?('get-app-config-ios.sh')
        phase.shell_script = 'PROJECT_DIR=Pods PROJECT_ROOT="$PODS_ROOT/../.." bash -l "$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh"'
      end
    end
`

module.exports = config =>
  withPodfile(config, mod => {
    let podfile = mod.modResults.contents
    if (!podfile.includes(FIREBASE_SPM)) {
      podfile = podfile.replace(/^prepare_react_native_project!$/m, `${FIREBASE_SPM}\n\nprepare_react_native_project!`)
    }
    if (!podfile.includes("pod 'YubiKit'")) {
      podfile = podfile.replace(/^(\s*use_expo_modules!\s*)$/m, `$1\n${YUBIKIT}`)
    }
    if (!podfile.includes('get-app-config-ios.sh')) {
      podfile = podfile.replace(/^(\s*post_install do \|installer\|\s*)$/m, `$1${CONSTANTS_PHASE_FIX}`)
    }
    if (!podfile.includes(FIREBASE_SPM) || !podfile.includes("pod 'YubiKit'") || !podfile.includes('get-app-config-ios.sh')) {
      throw new Error('withSharedNativePods: generated Podfile no longer has the expected anchors')
    }
    mod.modResults.contents = podfile
    return mod
  })
