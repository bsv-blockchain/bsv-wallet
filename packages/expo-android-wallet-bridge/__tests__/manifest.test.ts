import { readFileSync } from 'fs'
import { join } from 'path'
import { parseStringPromise } from 'xml2js'

const ANDROID = 'http://schemas.android.com/apk/res/android'
const manifestPath = join(__dirname, '..', 'android', 'src', 'main', 'AndroidManifest.xml')

type Attrs = Record<string, string>
const attrsOf = (node: any): Attrs => (node && node.$) || {}
const a = (node: any, name: string): string | undefined => attrsOf(node)[`android:${name}`]

async function load() {
  const raw = readFileSync(manifestPath, 'utf8')
  expect(raw).toContain(ANDROID)
  const doc = await parseStringPromise(raw)
  return { raw, manifest: doc.manifest }
}

describe('library manifest (spec 6.3, M2)', () => {
  it('declares exactly the M1 permissions plus HIDE_OVERLAY_WINDOWS and no SYSTEM_ALERT_WINDOW', async () => {
    const { manifest } = await load()
    const names = ((manifest['uses-permission'] as any[]) ?? []).map(p => a(p, 'name')).sort()
    expect(names).toEqual(
      [
        'android.permission.FOREGROUND_SERVICE',
        'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
        'android.permission.HIDE_OVERLAY_WINDOWS',
        'android.permission.INTERNET',
        'android.permission.POST_NOTIFICATIONS'
      ].sort()
    )
    expect(names).not.toContain('android.permission.SYSTEM_ALERT_WINDOW')
  })

  it('has exactly one exported component plus the unexported sheet', async () => {
    const { manifest } = await load()
    const app = manifest.application[0]
    const comps: any[] = [
      ...(app.activity ?? []),
      ...(app['activity-alias'] ?? []),
      ...(app.service ?? []),
      ...(app.receiver ?? []),
      ...(app.provider ?? [])
    ]
    const exported = comps.filter(c => a(c, 'exported') === 'true')
    expect(exported).toHaveLength(1)
    const t = exported[0]
    expect(a(t, 'name')).toBe('org.bsv.walletbridge.LaunchTrampolineActivity')
    expect(a(t, 'theme')).toBe('@android:style/Theme.NoDisplay')
    expect(a(t, 'excludeFromRecents')).toBe('true')
    expect(a(t, 'noHistory')).toBe('true')
    expect(a(t, 'taskAffinity')).toBe('')
    // the config plugin (Task 14) adds the one intent filter, with the host's scheme
    expect(t['intent-filter']).toBeUndefined()
    for (const c of comps) if (c !== t) expect(a(c, 'exported')).toBe('false')
  })

  it('declares the service non-exported, specialUse, with the subtype property', async () => {
    const { manifest } = await load()
    const services: any[] = manifest.application[0].service ?? []
    expect(services).toHaveLength(1)
    const s = services[0]
    expect(a(s, 'name')).toBe('org.bsv.walletbridge.BridgeService')
    expect(a(s, 'exported')).toBe('false')
    expect(a(s, 'foregroundServiceType')).toBe('specialUse')
    const props: any[] = s.property ?? []
    const subtype = props.find(p => a(p, 'name') === 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE')
    expect(subtype).toBeDefined()
    expect((a(subtype, 'value') ?? '').length).toBeGreaterThan(20)
  })

  it('declares the sheet activity non-exported with the spec 7.4 attributes and no intent filter', async () => {
    const { manifest } = await load()
    const sheet = ((manifest.application[0].activity ?? []) as any[]).find(
      x => a(x, 'name') === 'org.bsv.walletbridge.BridgeSheetActivity'
    )
    expect(sheet).toBeDefined()
    expect(a(sheet, 'exported')).toBe('false')
    expect(a(sheet, 'launchMode')).toBe('singleTask')
    expect(a(sheet, 'taskAffinity')).toBe('${applicationId}.bridge')
    expect(a(sheet, 'excludeFromRecents')).toBe('true')
    expect(a(sheet, 'windowSoftInputMode')).toBe('adjustResize')
    expect(a(sheet, 'theme')).toBe('@style/Theme.BsvBridgeSheet')
    // the configChanges list of the S4 diff plus the review additions
    expect((a(sheet, 'configChanges') ?? '').split('|').sort()).toEqual(
      [
        'keyboard',
        'keyboardHidden',
        'orientation',
        'screenSize',
        'screenLayout',
        'uiMode',
        'smallestScreenSize',
        'locale',
        'layoutDirection',
        // added by the whole-branch review: a font or display-size change must not recreate the sheet
        'fontScale',
        'density',
        'colorMode',
        'navigation',
        'touchscreen'
      ].sort()
    )
    expect(a(sheet, 'noHistory')).toBeUndefined()
    expect(sheet['intent-filter']).toBeUndefined()
  })

  it('has no receiver and no overlay permission; the activities are the trampoline and the sheet', async () => {
    const { manifest, raw } = await load()
    const app = manifest.application[0]
    expect(app.receiver).toBeUndefined()
    expect(raw).not.toContain('SYSTEM_ALERT_WINDOW')
    const activities: any[] = app.activity ?? []
    expect(activities.map(x => a(x, 'name')).sort()).toEqual([
      'org.bsv.walletbridge.BridgeSheetActivity',
      'org.bsv.walletbridge.LaunchTrampolineActivity'
    ])
  })
  describe('notification tap target (M2 Task 11, variant 11-N)', () => {
    const kt = (n: string) =>
      readFileSync(join(__dirname, '..', 'android', 'src', 'main', 'kotlin', 'org', 'bsv', 'walletbridge', n), 'utf8')

    it('the notification PendingIntents target the sheet Activity explicitly, built with NotificationSpec.pendingFlags()', async () => {
      const src = kt('AttentionPoster.kt')
      const { manifest } = await load()
      const sheet = ((manifest.application[0].activity ?? []) as any[]).find(
        x => a(x, 'name') === 'org.bsv.walletbridge.BridgeSheetActivity'
      )
      expect(sheet).toBeDefined()
      // explicit component, never the host launch intent
      expect(src).toContain('BridgeSheetActivity::class.java')
      expect(src).not.toContain('getLaunchIntentForPackage')
      expect(src).toContain('NotificationSpec.pendingFlags()')
      // no hard-coded immutable-only flags left on a content intent
      const contentIntent = src.slice(src.indexOf('private fun openSheet'), src.indexOf('private fun disconnect'))
      expect(contentIntent).not.toMatch(/FLAG_ACTIVITY_SINGLE_TOP/)
      // no sequence number and no URI on the tap intent
      expect(contentIntent).not.toMatch(/putExtra|\.data\s*=|setData|EXTRA_SEQ/)
    })

    it('the sheet is still the only non-trampoline activity and not exported', async () => {
      const { manifest } = await load()
      const sheet = ((manifest.application[0].activity ?? []) as any[]).find(
        x => a(x, 'name') === 'org.bsv.walletbridge.BridgeSheetActivity'
      )
      expect(a(sheet, 'exported')).toBe('false')
    })

    it('showSheet stays a no-op declaration (11-W is not implemented: no owner decision recorded)', () => {
      const mod = kt('BsvAndroidBridgeModule.kt')
      expect(mod).not.toContain('mayShowInBackground')
    })

    it('notification text is generic and names no site', () => {
      const src = kt('NotificationSpec.kt')
      expect(src).toContain('"A website wants to continue. Tap to review."')
    })
  })
})
