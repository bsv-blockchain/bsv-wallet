// Fails the prebuild loudly (spec 6.3 step 1). Every error starts with "SafariBridge:" and names the
// missing thing, in the style of the host's other plugins.

const SUPPORTED_SDK_MAJOR = 57

function requireAnchor(found, what) {
  if (!found) throw new Error(`SafariBridge: anchor ${what} not found`)
}

function defaultExpoVersion() {
  try {
    return require('expo/package.json').version
  } catch {
    return undefined
  }
}

function defaultResolve(request, projectRoot) {
  return require.resolve(request, { paths: [projectRoot || process.cwd(), __dirname] })
}

function validate(config, options = {}, deps = {}) {
  const ios = (config && config.ios) || {}
  if (!ios.bundleIdentifier) throw new Error('SafariBridge: ios.bundleIdentifier is required')

  const teamId = options.appleTeamId || ios.appleTeamId
  if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error('SafariBridge: appleTeamId is required (plugin option or ios.appleTeamId), ten characters')
  }

  const name = options.extensionName
  if (typeof name !== 'string' || Buffer.byteLength(name, 'utf8') < 1 || Buffer.byteLength(name, 'utf8') > 80) {
    throw new Error('SafariBridge: extensionName is required and must be 1 to 80 UTF-8 bytes')
  }

  if (options.profile !== undefined && options.profile !== 'development' && options.profile !== 'release') {
    throw new Error('SafariBridge: profile must be "development" or "release"')
  }

  const version = config.sdkVersion || (deps.expoVersion ? deps.expoVersion() : defaultExpoVersion())
  const major = Number.parseInt(String(version || '').split('.')[0], 10)
  if (major !== SUPPORTED_SDK_MAJOR) {
    throw new Error(`SafariBridge: Expo SDK ${SUPPORTED_SDK_MAJOR} is required (found ${version || 'unknown'})`)
  }

  const resolve = deps.resolve || defaultResolve
  try {
    resolve('@bacons/apple-targets/package.json', config._internal && config._internal.projectRoot)
  } catch {
    throw new Error('SafariBridge: @bacons/apple-targets 5.0.0 could not be resolved; install it in the host')
  }
  return { teamId }
}

module.exports = { validate, requireAnchor, SUPPORTED_SDK_MAJOR }
