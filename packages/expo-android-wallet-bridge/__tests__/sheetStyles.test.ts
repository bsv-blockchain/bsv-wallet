import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { parseStringPromise } from 'xml2js'

const res = join(__dirname, '..', 'android', 'src', 'main', 'res')

type Style = { name: string; parent?: string; items: Record<string, string> }

async function styles(file: string): Promise<Record<string, Style>> {
  const doc = await parseStringPromise(readFileSync(join(res, file), 'utf8'))
  const out: Record<string, Style> = {}
  for (const s of doc.resources.style ?? []) {
    const items: Record<string, string> = {}
    for (const it of s.item ?? []) items[it.$.name] = typeof it === 'string' ? it : (it._ ?? '').trim()
    out[s.$.name] = { name: s.$.name, parent: s.$.parent, items }
  }
  return out
}

describe('sheet theme (spec 6.3, 7.4)', () => {
  it('is a translucent no-title DayNight theme that ignores outside taps', async () => {
    const t = (await styles('values/styles.xml'))['Theme.BsvBridgeSheet']
    expect(t).toBeDefined()
    expect(t.parent).toBe('Theme.AppCompat.DayNight.NoActionBar')
    expect(t.items['android:windowIsTranslucent']).toBe('true')
    expect(t.items['android:windowBackground']).toBe('@android:color/transparent')
    expect(t.items['android:windowNoTitle']).toBe('true')
    expect(t.items['android:windowCloseOnTouchOutside']).toBe('false')
    expect(t.items['android:windowAnimationStyle']).toBe('@style/Animation.BsvBridgeSheet')
  })

  it('has no status or navigation bar colour', async () => {
    for (const f of ['values/styles.xml', 'values-v29/styles.xml']) {
      for (const s of Object.values(await styles(f))) {
        expect(Object.keys(s.items)).not.toContain('android:statusBarColor')
        expect(Object.keys(s.items)).not.toContain('android:navigationBarColor')
      }
    }
  })

  it('names an animation style whose enter and exit anims exist', async () => {
    const a = (await styles('values/styles.xml'))['Animation.BsvBridgeSheet']
    expect(a).toBeDefined()
    expect(a.items['android:windowEnterAnimation']).toBe('@anim/bridge_sheet_enter')
    expect(a.items['android:windowExitAnimation']).toBe('@anim/bridge_sheet_exit')
    expect(existsSync(join(res, 'anim', 'bridge_sheet_enter.xml'))).toBe(true)
    expect(existsSync(join(res, 'anim', 'bridge_sheet_exit.xml'))).toBe(true)
  })

  it('sets enforceNavigationBarContrast false only in values-v29 (API 29 attribute, minSdk 24)', async () => {
    const base = (await styles('values/styles.xml'))['Theme.BsvBridgeSheet']
    expect(Object.keys(base.items)).not.toContain('android:enforceNavigationBarContrast')
    const v29 = (await styles('values-v29/styles.xml'))['Theme.BsvBridgeSheet']
    expect(v29).toBeDefined()
    expect(v29.items['android:enforceNavigationBarContrast']).toBe('false')
  })
})
