// Manifest edit (spec 6.3): gives LaunchTrampolineActivity its one intent filter. The library manifest declares the
// activity itself (exported, NoDisplay, no filter); the manifest merger cannot know the host's scheme, so the filter
// is added to the app manifest as a `tools:node="merge"` entry. Pure functions over the xml2js manifest object.

const { PREFIX } = require('./validate')

const TRAMPOLINE = 'org.bsv.walletbridge.LaunchTrampolineActivity'
const TOOLS_NS = 'http://schemas.android.com/tools'

const nameOf = el => el && el.$ && el.$['android:name']

function filterSchemes(filter) {
  return (filter.data || []).map(d => d.$ && d.$['android:scheme']).filter(Boolean)
}

function hasLaunchFilter(activity, scheme) {
  return (activity['intent-filter'] || []).some(f =>
    (f.data || []).some(d => d.$ && d.$['android:scheme'] === scheme && d.$['android:host'] === 'launch')
  )
}

function launchFilter(scheme) {
  return {
    action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
    category: [
      { $: { 'android:name': 'android.intent.category.DEFAULT' } },
      { $: { 'android:name': 'android.intent.category.BROWSABLE' } }
    ],
    data: [{ $: { 'android:scheme': scheme, 'android:host': 'launch' } }]
  }
}

/** Throws when another activity (or alias) in the app manifest already handles `scheme`. Skips the trampoline. */
function assertNoSchemeCollision(application, scheme) {
  const others = [...(application.activity || []), ...(application['activity-alias'] || [])]
  for (const el of others) {
    if (nameOf(el) === TRAMPOLINE) continue
    for (const f of el['intent-filter'] || []) {
      if (filterSchemes(f).includes(scheme)) {
        throw new Error(`${PREFIX}: scheme "${scheme}" is already handled by ${nameOf(el)} in the app manifest`)
      }
    }
  }
}

/** Adds the one trampoline filter. Idempotent. Mutates and returns `androidManifest` (the `{ manifest }` object). */
function applyManifest(androidManifest, scheme) {
  const manifest = androidManifest.manifest
  manifest.$ = manifest.$ || {}
  manifest.$['xmlns:tools'] = TOOLS_NS
  const application = manifest.application && manifest.application[0]
  if (!application) throw new Error(`${PREFIX}: the app manifest has no <application>`)
  assertNoSchemeCollision(application, scheme)

  application.activity = application.activity || []
  let tramp = application.activity.find(a => nameOf(a) === TRAMPOLINE)
  if (!tramp) {
    tramp = { $: { 'android:name': TRAMPOLINE } }
    application.activity.push(tramp)
  }
  tramp.$['tools:node'] = 'merge'
  if (!hasLaunchFilter(tramp, scheme)) {
    // exactly one filter: replace any earlier bridge filter (an old scheme) rather than accumulate
    tramp['intent-filter'] = [launchFilter(scheme)]
  }
  return androidManifest
}

module.exports = { applyManifest, TRAMPOLINE, launchFilter }
