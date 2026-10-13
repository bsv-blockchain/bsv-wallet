// Expo's iOS template ends the app target's "Bundle React Native code and
// images" phase with
//
//   `"$NODE_BINARY" --print "...react-native-xcode.sh"`
//
// which executes the printed path unquoted, so it word-splits when the
// checkout path contains a space (this repository lives under
// ".../BitcoinSV Wallet/..."). Capture the path and run it quoted instead.
const { withXcodeProject } = require('@expo/config-plugins')

const PHASE_NAME = 'Bundle React Native code and images'
const BACKTICK_CALL = /`([^`]*react-native-xcode\.sh[^`]*)`/

module.exports = config =>
  withXcodeProject(config, mod => {
    const phases = mod.modResults.hash.project.objects.PBXShellScriptBuildPhase ?? {}
    let patched = false
    for (const phase of Object.values(phases)) {
      if (typeof phase !== 'object' || !String(phase.name).includes(PHASE_NAME)) continue
      if (BACKTICK_CALL.test(phase.shellScript)) {
        // shellScript is the pbxproj's quoted string: quotes are \" and newlines \n.
        phase.shellScript = phase.shellScript.replace(
          BACKTICK_CALL,
          (_, call) => `RN_XCODE_SCRIPT=\\"$(${call})\\"\\n\\"$RN_XCODE_SCRIPT\\"`
        )
      }
      patched = phase.shellScript.includes('$RN_XCODE_SCRIPT')
    }
    if (!patched) throw new Error(`withSpaceSafeBundlePhase: "${PHASE_NAME}" phase not found or not patchable`)
    return mod
  })
