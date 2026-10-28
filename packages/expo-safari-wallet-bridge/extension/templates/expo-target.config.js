// Read by @bacons/apple-targets. The plugin writes bridge-target.json next to this file.
const t = require('./bridge-target.json')

module.exports = {
  type: 'safari',
  name: t.name,
  displayName: t.displayName,
  bundleIdentifier: t.bundleIdentifier,
  frameworks: ['SafariServices'],
  deploymentTarget: t.deploymentTarget,
  entitlements: t.entitlements
}
