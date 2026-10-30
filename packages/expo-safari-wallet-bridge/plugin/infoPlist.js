// Host Info.plist changes (spec 6.3 step 3): a second URL type for the handoff scheme, named
// `<B>.bridge` so the host's existing schemes are untouched, and the three BSVBridge* keys.

function bridgeKeys(ids) {
  return {
    BSVBridgeAppGroup: ids.appGroup,
    BSVBridgeKeychainGroup: ids.bridgeKeychainGroup,
    BSVBridgeScheme: ids.scheme
  }
}

function applyInfoPlist(plist, ids, bundleId) {
  const name = bundleId + '.bridge'
  const types = Array.isArray(plist.CFBundleURLTypes) ? plist.CFBundleURLTypes : []
  const kept = types.filter(type => type.CFBundleURLName !== name)
  plist.CFBundleURLTypes = [...kept, { CFBundleURLName: name, CFBundleURLSchemes: [ids.scheme] }]
  Object.assign(plist, bridgeKeys(ids))
  return plist
}

module.exports = { applyInfoPlist, bridgeKeys }
