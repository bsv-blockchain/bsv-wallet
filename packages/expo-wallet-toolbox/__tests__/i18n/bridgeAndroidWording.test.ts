import { resources } from '../../core/i18n/translations'

// Android loopback bridge copy (spec 6.13). A key missing from a locale would render as a raw key.
const KEYS = ['bridge_notifications_off', 'bridge_ports_exhausted', 'bridge_not_ready_android']
const LOCALES = ['en', 'es', 'zh', 'hi', 'fr', 'ar', 'pt', 'bn', 'ru', 'id', 'ja', 'pl']
const tr = (code: string) => (resources as Record<string, { translation: Record<string, string> }>)[code].translation

describe('bridge Android wording', () => {
  it('covers exactly the 12 locales', () => {
    expect(Object.keys(resources).sort()).toEqual([...LOCALES].sort())
  })

  it.each(LOCALES)('%s has every key', code => {
    const t = tr(code)
    expect(KEYS.filter(k => typeof t[k] !== 'string' || t[k].trim().length === 0)).toEqual([])
  })

  it.each(LOCALES)('%s keeps placeholders identical to English', code => {
    const en = tr('en')
    const t = tr(code)
    const ph = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort()
    for (const k of KEYS) expect(ph(t[k])).toEqual(ph(en[k]))
  })

  it('English copy', () => {
    const en = tr('en')
    expect(en.bridge_notifications_off).toBe('Turn on notifications so BSV Wallet can tell you about later requests')
    expect(en.bridge_ports_exhausted).toBe('Another program is using the ports BSV Wallet needs')
    expect(en.bridge_not_ready_android).toBe('Create or restore a wallet in BSV Wallet first')
  })

  it.each(LOCALES.filter(c => c !== 'en'))('%s is translated, not English', code => {
    const en = tr('en')
    const t = tr(code)
    for (const k of KEYS) expect(t[k]).not.toBe(en[k])
  })
})
