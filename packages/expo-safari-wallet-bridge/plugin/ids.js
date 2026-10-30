// Identifiers derived from the host's bundle id (spec 6.2). Nothing here is typed by the host, so two
// wallets cannot collide. An override is allowed for a host that must, and is checked against the
// same constraints as the derived value.

const BUNDLE_ID = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/
const SCHEME = /^[a-z][a-z0-9+.-]*$/
const PREFIX = '$(AppIdentifierPrefix)'
const TRANSPORT_ID = 'safari-extension'

function deriveIds(bundleId, opts = {}) {
  if (typeof bundleId !== 'string' || !BUNDLE_ID.test(bundleId)) {
    throw new Error(`SafariBridge: ios.bundleIdentifier "${bundleId}" is not a valid reverse-domain bundle id`)
  }
  const overrides = opts.overrides || {}
  const ids = {
    scheme: bundleId.toLowerCase(),
    extensionBundleId: bundleId + '.safari',
    appGroup: 'group.' + bundleId,
    bridgeKeychainGroup: PREFIX + bundleId + '.bridge',
    hostKeychainGroup: PREFIX + bundleId,
    transportId: TRANSPORT_ID,
    ...overrides
  }
  checkIds(bundleId, ids)
  return ids
}

function checkIds(bundleId, ids) {
  const fail = (what, why) => {
    throw new Error(`SafariBridge: ${what} "${ids[what]}" ${why}`)
  }
  if (typeof ids.scheme !== 'string' || !SCHEME.test(ids.scheme)) fail('scheme', 'is not a valid URL scheme')
  if (ids.scheme === 'http' || ids.scheme === 'https') fail('scheme', 'must not be a web scheme')
  if (typeof ids.extensionBundleId !== 'string' || !ids.extensionBundleId.startsWith(bundleId + '.')) {
    fail('extensionBundleId', `must start with "${bundleId}."`)
  }
  if (!BUNDLE_ID.test(ids.extensionBundleId)) fail('extensionBundleId', 'is not a valid bundle id')
  if (typeof ids.appGroup !== 'string' || !/^group\.[A-Za-z0-9.-]+$/.test(ids.appGroup)) {
    fail('appGroup', 'must start with "group."')
  }
  if (typeof ids.hostKeychainGroup !== 'string' || !ids.hostKeychainGroup.startsWith(PREFIX)) {
    fail('hostKeychainGroup', `must start with ${PREFIX}`)
  }
  if (typeof ids.bridgeKeychainGroup !== 'string' || !ids.bridgeKeychainGroup.startsWith(PREFIX)) {
    fail('bridgeKeychainGroup', `must start with ${PREFIX}`)
  }
  if (ids.bridgeKeychainGroup === ids.hostKeychainGroup) {
    fail('bridgeKeychainGroup', "must differ from the host's own keychain group")
  }
  if (typeof ids.transportId !== 'string' || !ids.transportId.startsWith('safari')) {
    fail('transportId', 'must start with "safari"')
  }
}

module.exports = { deriveIds, checkIds, TRANSPORT_ID, PREFIX }
