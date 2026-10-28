// withSafariBridge (spec 6.3). Order: validate, app entitlements, Info.plist, target (with its
// entitlements and bundled extension), podfile wiring. Nothing here edits the host's app.config.js.

const path = require('path')
const { withEntitlementsPlist, withInfoPlist, withPodfile } = require('expo/config-plugins')
const withAppleTargets = require('@bacons/apple-targets/app.plugin')
// apple-targets 5.0.0 (pinned exactly) edits the project through its own mod; ours must use the same one.
const { withXcodeProjectBeta } = require('@bacons/apple-targets/build/with-bacons-xcode')

const { deriveIds } = require('./ids')
const { validate, requireAnchor } = require('./validate')
const { applyAppEntitlements } = require('./entitlements')
const { applyInfoPlist } = require('./infoPlist')
const { writeTarget, TARGET_NAME, ROOT } = require('./target')

const QUEUE_POD = path.resolve(__dirname, '..', 'swift', 'BsvBridgeQueue')

function podLine(podPath) {
  return `pod 'BsvBridgeQueue', :path => '${podPath}'`
}

/**
 * The Expo module pod (BsvBridge) depends on BsvBridgeQueue, but CocoaPods cannot find that pod from
 * the dependency alone, so the app target gets an explicit `:path`. The extension target links the
 * same pod from a top-level block (spike S1: apple-targets' own pods.rb loader never sees a custom
 * `root`). `use_frameworks!` must match the app's or `pod install` refuses. Idempotent.
 */
function wirePodfile(contents, { projectName, podPath }) {
  if (contents.includes('BsvBridgeQueue')) return contents
  const anchor = new RegExp(`^(target ['"]${projectName}['"] do\\n)`, 'm')
  requireAnchor(anchor.test(contents), `"target '${projectName}' do" in the Podfile`)
  let next = contents.replace(anchor, `$1  ${podLine(podPath)}\n`)
  next +=
    `\ntarget '${TARGET_NAME}' do\n` +
    `  use_frameworks! :linkage => podfile_properties['ios.useFrameworks'].to_sym if podfile_properties['ios.useFrameworks']\n` +
    `  ${podLine(podPath)}\n` +
    `end\n`
  return next
}

/**
 * apple-targets writes the extension's own `OTHER_LDFLAGS = (-framework, SafariServices)` without
 * `$(inherited)`, which replaces the flags CocoaPods puts in `Pods-SafariBridge.*.xcconfig`
 * (`-ObjC -framework BsvBridgeQueue`). The static pod is then never linked into the appex and the link
 * fails with undefined `BsvBridgeQueue` symbols. Puts `$(inherited)` first in every configuration of the
 * extension target. Works on the project model apple-targets uses (`@bacons/xcode`). Idempotent; returns
 * the number of configurations changed.
 */
function inheritPodLinkerFlags(project, targetName) {
  let changed = 0
  for (const target of project.rootObject.props.targets) {
    if (target.props.name !== targetName) continue
    for (const cfg of target.props.buildConfigurationList.props.buildConfigurations) {
      const settings = cfg.props.buildSettings
      const flags = settings.OTHER_LDFLAGS
      const list = flags === undefined ? [] : Array.isArray(flags) ? flags : [flags]
      if (list.includes('$(inherited)')) continue
      settings.OTHER_LDFLAGS = ['$(inherited)', ...list]
      changed++
    }
  }
  return changed
}

function withSafariBridge(config, options = {}) {
  const { teamId } = validate(config, options)
  const bundleId = config.ios.bundleIdentifier
  const ids = deriveIds(bundleId, { overrides: options.overrides })
  const projectRoot = (config._internal && config._internal.projectRoot) || process.cwd()

  config = withEntitlementsPlist(config, c => {
    c.modResults = applyAppEntitlements(c.modResults, ids)
    return c
  })
  config = withInfoPlist(config, c => {
    c.modResults = applyInfoPlist(c.modResults, ids, bundleId)
    return c
  })

  // Target files (and the bundled extension) exist before apple-targets globs the root.
  writeTarget({ config, options, ids, projectRoot })
  // Registered before apple-targets: Expo runs the last-registered mod first, so this one sees the target
  // apple-targets has created.
  config = withXcodeProjectBeta(config, c => {
    inheritPodLinkerFlags(c.modResults, TARGET_NAME)
    return c
  })
  config = withAppleTargets(config, { root: ROOT, appleTeamId: teamId })

  config = withPodfile(config, c => {
    const podPath = path.relative(c.modRequest.platformProjectRoot, QUEUE_POD) || QUEUE_POD
    c.modResults.contents = wirePodfile(c.modResults.contents, { projectName: c.modRequest.projectName, podPath })
    return c
  })
  return config
}

module.exports = withSafariBridge
module.exports.withSafariBridge = withSafariBridge
module.exports.wirePodfile = wirePodfile
module.exports.inheritPodLinkerFlags = inheritPodLinkerFlags
module.exports.deriveIds = deriveIds
module.exports.validate = validate
