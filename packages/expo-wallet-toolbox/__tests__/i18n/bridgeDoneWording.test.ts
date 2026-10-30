import { resources } from '../../core/i18n/translations'

// The Safari bridge's done screen, toast and setup guide (spec 6.12). A key missing from a locale would
// render as a raw key on the screen the user sees right after approving a payment.
const KEYS = [
  'bridge_done_sent_to',
  'bridge_done_payment',
  'bridge_done_action',
  'bridge_done_signed',
  'bridge_done_encrypted',
  'bridge_done_certificate',
  'bridge_done_approved',
  'bridge_done_n_requests',
  'bridge_done_n_sites',
  'bridge_done_back_hint',
  'bridge_toast_done',
  'bridge_toast_failed',
  'bridge_setup_title',
  'bridge_setup_step_extension',
  'bridge_setup_step_allow',
  'bridge_setup_why'
]
const PLACEHOLDERS: Record<string, string[]> = {
  bridge_done_sent_to: ['{{site}}'],
  bridge_done_payment: ['{{amount}}'],
  bridge_done_n_requests: ['{{n}}'],
  bridge_done_n_sites: ['{{n}}']
}
const GLYPH = '◀ Safari'
const LOCALES = ['en', 'es', 'zh', 'hi', 'fr', 'ar', 'pt', 'bn', 'ru', 'id', 'ja', 'pl']
const tr = (code: string) => (resources as Record<string, { translation: Record<string, string> }>)[code].translation

describe('bridge done screen wording', () => {
  it('covers exactly the 12 locales', () => {
    expect(Object.keys(resources).sort()).toEqual([...LOCALES].sort())
  })

  it.each(LOCALES)('%s has every key', code => {
    const t = tr(code)
    expect(KEYS.filter(k => typeof t[k] !== 'string' || t[k].length === 0)).toEqual([])
  })

  it.each(LOCALES)('%s keeps the {{site}}/{{amount}}/{{n}} placeholders', code => {
    const t = tr(code)
    for (const [key, ph] of Object.entries(PLACEHOLDERS)) for (const p of ph) expect(t[key]).toContain(p)
  })

  it.each(LOCALES)('%s leaves the ◀ Safari chip untranslated', code => {
    const t = tr(code)
    for (const k of ['bridge_done_back_hint', 'bridge_toast_done', 'bridge_toast_failed']) expect(t[k]).toContain(GLYPH)
  })

  it('bridge_done_back_hint names the top-left chip', () => {
    expect(tr('en').bridge_done_back_hint).toBe(`Tap ${GLYPH} in the top left to go back`)
  })

  it('English toast copy', () => {
    expect(tr('en').bridge_toast_done).toBe(`Done · ${GLYPH}`)
    expect(tr('en').bridge_toast_failed).toBe(`Not completed · ${GLYPH}`)
  })
})
