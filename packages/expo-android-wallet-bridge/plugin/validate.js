// Option and host validation for withAndroidWalletBridge (spec 6.3). Every error starts with
// "AndroidWalletBridge:" and names the offending value, in the style of the host's other plugins.

const PREFIX = 'AndroidWalletBridge'
// RFC 3986 scheme syntax, restricted to lowercase (Android matches schemes case-sensitively).
const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/
// Schemes that a launch filter must never claim: they would make the trampoline a web, file or intent handler.
const RESERVED = new Set(['http', 'https', 'intent', 'file', 'content', 'javascript', 'data'])

function fail(message) {
  throw new Error(`${PREFIX}: ${message}`)
}

function androidPackage(config) {
  const pkg = config && config.android && config.android.package
  if (typeof pkg !== 'string' || pkg.length === 0) fail('android.package is required')
  return pkg
}

/** Schemes the host config declares: the Expo `scheme` (string or array) and `android.intentFilters` data entries. */
function hostSchemes(config) {
  const found = new Set()
  const top = config && config.scheme
  for (const s of Array.isArray(top) ? top : top ? [top] : []) if (typeof s === 'string') found.add(s.toLowerCase())
  const filters = (config && config.android && config.android.intentFilters) || []
  for (const f of filters) {
    const data = Array.isArray(f && f.data) ? f.data : f && f.data ? [f.data] : []
    for (const d of data) if (d && typeof d.scheme === 'string') found.add(d.scheme.toLowerCase())
  }
  return found
}

function checkSyntax(scheme) {
  if (typeof scheme !== 'string' || scheme.length === 0) fail('scheme must be a non-empty string')
  if (scheme !== scheme.toLowerCase()) fail(`scheme "${scheme}" must be lowercase`)
  if (!SCHEME_RE.test(scheme)) {
    fail(`scheme "${scheme}" is not a valid scheme (lowercase letter first, then lowercase letters, digits, + - .)`)
  }
  if (RESERVED.has(scheme)) fail(`scheme "${scheme}" is reserved`)
}

/** The launch scheme: `options.scheme`, or `<android.package>.bridge`. Throws a named error when invalid or colliding. */
function resolveScheme(config, options = {}) {
  const pkg = androidPackage(config)
  const scheme = options.scheme === undefined ? `${pkg}.bridge` : options.scheme
  checkSyntax(scheme)
  if (hostSchemes(config).has(scheme)) {
    fail(`scheme "${scheme}" is already declared by the host; two activities on one scheme can raise a chooser`)
  }
  return scheme
}

/** Warnings (never errors) about host settings that weaken the kit. Returns an array of messages. */
function hostWarnings(config) {
  const android = (config && config.android) || {}
  const warnings = []
  if ((android.permissions || []).some(p => /(^|\.)SYSTEM_ALERT_WINDOW$/.test(p))) {
    warnings.push(
      'the host declares SYSTEM_ALERT_WINDOW; the bridge draws no overlay and the host should block that permission'
    )
  }
  if (android.allowBackup === true) {
    warnings.push('android.allowBackup is true; the continuity seed would be included in device backups')
  }
  return warnings
}

module.exports = { resolveScheme, hostSchemes, hostWarnings, PREFIX }
