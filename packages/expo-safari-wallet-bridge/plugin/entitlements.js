// App and extension entitlements (spec 6.3 steps 2, 5, 6).

const APP_GROUPS = 'com.apple.security.application-groups'
const KEYCHAIN_GROUPS = 'keychain-access-groups'

function unique(list) {
  return list.filter((value, index) => list.indexOf(value) === index)
}

/**
 * Merges into the host's entitlements and never replaces. The host's own keychain group is first:
 * once the entitlement exists, items written without an explicit group go to the first entry, and old
 * items stay readable only while their group is still listed.
 */
function applyAppEntitlements(entitlements, ids) {
  const existingGroups = Array.isArray(entitlements[APP_GROUPS]) ? entitlements[APP_GROUPS] : []
  entitlements[APP_GROUPS] = unique([...existingGroups, ids.appGroup])
  const existingKeychain = Array.isArray(entitlements[KEYCHAIN_GROUPS]) ? entitlements[KEYCHAIN_GROUPS] : []
  entitlements[KEYCHAIN_GROUPS] = unique([ids.hostKeychainGroup, ids.bridgeKeychainGroup, ...existingKeychain])
  return entitlements
}

/**
 * The extension sees only the bridge group, never the host's own (spec 6.3 step 5). No
 * default-data-protection key: it needs the Data Protection capability on the extension's App ID, and
 * BsvBridgeQueue sets the class on the queue directory and every file itself (spec 6.3 step 6).
 */
function appexEntitlements(ids) {
  return {
    [APP_GROUPS]: [ids.appGroup],
    [KEYCHAIN_GROUPS]: [ids.bridgeKeychainGroup]
  }
}

module.exports = { applyAppEntitlements, appexEntitlements, APP_GROUPS, KEYCHAIN_GROUPS }
