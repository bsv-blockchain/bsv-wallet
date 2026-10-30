import i18n, { resources } from '../../core/i18n/translations'
import { SEEK_FLAG_DISCLOSURE, SEEK_FLAG_KEYS } from '../../core/bridge/permissionPolicy'

// The connection sheet describes what a site may do from the effective policy flags. A flag added
// without wording in every locale would render a raw key to the user.
describe('connection sheet wording', () => {
  const bridgeKeys = [
    'bridge_badge_unverified',
    'bridge_verified_by',
    'bridge_browser_generic',
    'bridge_unverified_channel',
    'bridge_allows_header',
    'bridge_asks_header',
    'bridge_allows_sign_in',
    'bridge_payments_verified',
    'bridge_payments_unverified',
    'bridge_remember_verified',
    'bridge_remember_unverified',
    'bridge_connected_before',
    'bridge_site_says',
    'bridge_connect',
    'bridge_dont_connect'
  ]

  it.each(Object.keys(resources))('%s words every policy flag in both states, and every sheet line', code => {
    const t = (resources as Record<string, { translation: Record<string, string> }>)[code].translation
    const missing: string[] = [...bridgeKeys]
    for (const key of SEEK_FLAG_KEYS) missing.push(SEEK_FLAG_DISCLOSURE[key].off, SEEK_FLAG_DISCLOSURE[key].on)
    expect(missing.filter(k => typeof t[k] !== 'string' || t[k].length === 0)).toEqual([])
  })

  it('resolves the dotted policy keys through i18next', () => {
    expect(i18n.getFixedT('en')('bridge.policy.seekSpendingPermissions.off')).toBe('spend from your balance')
  })
})
