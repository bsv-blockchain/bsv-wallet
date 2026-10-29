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

describe('library manifest (spec 6.3, M1)', () => {
  it('declares exactly the M1 permissions and no SYSTEM_ALERT_WINDOW', async () => {
    const { manifest } = await load()
    const names = ((manifest['uses-permission'] as any[]) ?? []).map(p => a(p, 'name')).sort()
    expect(names).toEqual(
      [
        'android.permission.FOREGROUND_SERVICE',
        'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
        'android.permission.INTERNET',
        'android.permission.POST_NOTIFICATIONS'
      ].sort()
    )
    expect(names).not.toContain('android.permission.SYSTEM_ALERT_WINDOW')
  })

  it('has exactly one exported component, the trampoline, with no intent filter', async () => {
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

  it('has no receiver, no sheet activity (M2) and no overlay', async () => {
    const { manifest, raw } = await load()
    const app = manifest.application[0]
    expect(app.receiver).toBeUndefined()
    expect(raw).not.toContain('BridgeSheetActivity')
    expect(raw).not.toContain('SYSTEM_ALERT_WINDOW')
    const activities: any[] = app.activity ?? []
    expect(activities.map(x => a(x, 'name'))).toEqual(['org.bsv.walletbridge.LaunchTrampolineActivity'])
  })
})
