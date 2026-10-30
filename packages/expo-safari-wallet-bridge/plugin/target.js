// Generates the Safari extension target into a git-ignored scratch directory and points
// @bacons/apple-targets at it with `root` (spike S1.root), so the host's `targets/` stays clean.

const fs = require('fs')
const path = require('path')

const { appexEntitlements } = require('./entitlements')
const { buildExtension } = require('./buildExtension')

const TARGET_NAME = 'SafariBridge'
const ROOT = '.expo/safari-bridge'
const TEMPLATES = path.resolve(__dirname, '..', 'extension', 'templates')
const DEFAULT_DEPLOYMENT_TARGET = '16.0'

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderInfoPlist(template, { extensionName, ids }) {
  return template
    .replaceAll('{{DISPLAY_NAME}}', escapeXml(extensionName))
    .replaceAll('{{APP_GROUP}}', escapeXml(ids.appGroup))
    .replaceAll('{{KEYCHAIN_GROUP}}', escapeXml(ids.bridgeKeychainGroup))
    .replaceAll('{{SCHEME}}', escapeXml(ids.scheme))
}

/** The extension's deployment target follows the app's: an explicit option, else expo-build-properties, else 16.0. */
function deploymentTargetFor(config, options) {
  if (options.deploymentTarget) return options.deploymentTarget
  for (const entry of config.plugins || []) {
    if (Array.isArray(entry) && entry[0] === 'expo-build-properties') {
      const value = entry[1] && entry[1].ios && entry[1].ios.deploymentTarget
      if (value) return value
    }
  }
  return DEFAULT_DEPLOYMENT_TARGET
}

/** What apple-targets reads (through expo-target.config.js): the part of the plugin's output a snapshot pins. */
function targetSettings({ config, options, ids }) {
  return {
    name: TARGET_NAME,
    displayName: options.extensionName,
    bundleIdentifier: ids.extensionBundleId,
    deploymentTarget: deploymentTargetFor(config, options),
    entitlements: appexEntitlements(ids)
  }
}

function writeTarget({ config, options, ids, projectRoot }) {
  const dir = path.join(projectRoot, ROOT, TARGET_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const settings = targetSettings({ config, options, ids })
  fs.writeFileSync(path.join(dir, 'bridge-target.json'), JSON.stringify(settings, null, 2) + '\n')
  fs.copyFileSync(path.join(TEMPLATES, 'expo-target.config.js'), path.join(dir, 'expo-target.config.js'))
  fs.copyFileSync(
    path.join(TEMPLATES, 'SafariWebExtensionHandler.swift'),
    path.join(dir, 'SafariWebExtensionHandler.swift')
  )
  fs.writeFileSync(
    path.join(dir, 'Info.plist'),
    renderInfoPlist(fs.readFileSync(path.join(TEMPLATES, 'Info.plist'), 'utf8'), {
      extensionName: options.extensionName,
      ids
    })
  )
  const build = buildExtension({
    outDir: path.join(dir, 'Resources'),
    profile: options.profile || 'release',
    ids,
    bundleId: config.ios.bundleIdentifier,
    extensionName: options.extensionName,
    version: config.version || '1.0'
  })
  return { dir, settings, build }
}

module.exports = { writeTarget, targetSettings, renderInfoPlist, deploymentTargetFor, TARGET_NAME, ROOT }
