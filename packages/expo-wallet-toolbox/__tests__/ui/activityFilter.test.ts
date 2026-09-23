import {
  ACTIVITY_KIND_FILTERS,
  contactNamesByKey,
  isActivityFilterActive,
  kindFilterLabelKey,
  matchesActivity,
  searchTerms,
  type ActivityFilter
} from '../../ui/activityFilter'
import type { ActivityAction } from '../../ui/components/wallet/ActivityRow'

const ALICE = '02' + 'a'.repeat(64)
const BOB = '03' + 'b'.repeat(64)
const SENTINEL = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

const action = (over: Partial<ActivityAction> = {}): ActivityAction =>
  ({
    txid: 'f'.repeat(64),
    satoshis: -1000,
    status: 'completed',
    isOutgoing: true,
    description: '',
    labels: [],
    version: 1,
    lockTime: 0,
    ...over
  }) as ActivityAction

const filter = (over: Partial<ActivityFilter> = {}): ActivityFilter => ({ kind: 'all', terms: [], ...over })
const search = (query: string, over: Partial<ActivityFilter> = {}) => filter({ terms: searchTerms(query), ...over })
const none = new Map()

describe('searchTerms', () => {
  it('splits on whitespace, folds case and accents, and drops a leading @', () => {
    expect(searchTerms('  Lunch   CAFÉ @sam ')).toEqual(['lunch', 'cafe', 'sam'])
  })

  it('keeps an @ that is not leading, so a paymail still reads as typed', () => {
    expect(searchTerms('sam@handcash.io')).toEqual(['sam@handcash.io'])
  })

  it('treats blank input and a lone @ as no search at all', () => {
    expect(searchTerms('')).toEqual([])
    expect(searchTerms('   ')).toEqual([])
    expect(searchTerms('@')).toEqual([])
  })
})

describe('isActivityFilterActive', () => {
  it('is off for All with no search, on for a type or a term', () => {
    expect(isActivityFilterActive(filter())).toBe(false)
    expect(isActivityFilterActive(filter({ kind: 'sent' }))).toBe(true)
    expect(isActivityFilterActive(filter({ terms: ['x'] }))).toBe(true)
  })
})

describe('kind filter chips', () => {
  it('offers All first, then the four words a row can say', () => {
    expect(ACTIVITY_KIND_FILTERS).toEqual(['all', 'sent', 'received', 'spent', 'transferred'])
  })

  it('labels each chip with the exact key the row itself prints', () => {
    expect(kindFilterLabelKey('all')).toBe('activity_filter_all')
    expect(kindFilterLabelKey('sent')).toBe('tx_status_sent')
    expect(kindFilterLabelKey('received')).toBe('tx_status_received')
    expect(kindFilterLabelKey('spent')).toBe('tx_status_spent')
    expect(kindFilterLabelKey('transferred')).toBe('tx_status_transferred')
  })
})

describe('matchesActivity: note search', () => {
  const lunch = action({ description: 'Lunch with Sam' })

  it('matches every row when nothing is filtered', () => {
    expect(matchesActivity(lunch, undefined, filter(), none)).toBe(true)
  })

  it('matches a part of a word, whatever the case', () => {
    expect(matchesActivity(lunch, undefined, search('lunch'), none)).toBe(true)
    expect(matchesActivity(lunch, undefined, search('LUN'), none)).toBe(true)
    expect(matchesActivity(lunch, undefined, search('dinner'), none)).toBe(false)
  })

  it('needs every word, in any order', () => {
    expect(matchesActivity(lunch, undefined, search('sam lunch'), none)).toBe(true)
    expect(matchesActivity(lunch, undefined, search('lunch dinner'), none)).toBe(false)
  })

  it('ignores accents on either side', () => {
    expect(matchesActivity(action({ description: 'Café' }), undefined, search('cafe'), none)).toBe(true)
    expect(matchesActivity(action({ description: 'Cafe' }), undefined, search('café'), none)).toBe(true)
  })

  it('never lets one word run across two fields', () => {
    const contacts = contactNamesByKey([{ identityKey: ALICE, name: 'cd' }])
    const row = action({ description: 'ab', labels: ['peerpay', ALICE] })
    expect(matchesActivity(row, undefined, search('ab'), contacts)).toBe(true)
    expect(matchesActivity(row, undefined, search('cd'), contacts)).toBe(true)
    expect(matchesActivity(row, undefined, search('bc'), contacts)).toBe(false)
  })
})

describe('matchesActivity: counterparty name and handle', () => {
  const contacts = contactNamesByKey([
    { identityKey: ALICE, name: 'Alice Martin', cachedHandle: 'ally' },
    { identityKey: BOB.toUpperCase(), name: 'Bob' }
  ])

  it('finds an outbound payment by the saved contact name or handle, with or without @', () => {
    const row = action({ description: 'rent', labels: ['peerpay', ALICE] })
    expect(matchesActivity(row, undefined, search('alice'), contacts)).toBe(true)
    expect(matchesActivity(row, undefined, search('@ally'), contacts)).toBe(true)
    expect(matchesActivity(row, undefined, search('ally rent'), contacts)).toBe(true)
  })

  it('finds an inbound payment by who sent it', () => {
    const row = action({ satoshis: 500, isOutgoing: false, senderIdentityKey: ALICE })
    expect(matchesActivity(row, undefined, search('martin'), contacts)).toBe(true)
  })

  it('matches keys regardless of how either side spelled their case', () => {
    const row = action({ labels: ['peerpay', BOB] })
    expect(matchesActivity(row, undefined, search('bob'), contacts)).toBe(true)
  })

  it('does not attribute the address sweep sentinel to anyone', () => {
    const withSentinel = contactNamesByKey([{ identityKey: SENTINEL, name: 'Nobody' }])
    const row = action({ satoshis: 500, senderIdentityKey: SENTINEL })
    expect(matchesActivity(row, undefined, search('nobody'), withSentinel)).toBe(false)
  })

  it('finds a counterparty who is not a contact only by what the row already says', () => {
    const row = action({ description: 'Carol', labels: ['peerpay', BOB.replace('b', 'c')] })
    expect(matchesActivity(row, undefined, search('carol'), contacts)).toBe(true)
    expect(matchesActivity(row, undefined, search('bob'), contacts)).toBe(false)
  })
})

describe('matchesActivity: token rows', () => {
  const tokenAction = action({
    labels: ['mandala', 'transfer'],
    description: 'Send 100 of ' + 'e'.repeat(72)
  })

  it('searches the title the row shows, never the raw library description', () => {
    const token = { title: 'Coffee beans', incoming: false }
    expect(matchesActivity(tokenAction, token, search('coffee'), none)).toBe(true)
    expect(matchesActivity(tokenAction, token, search('send'), none)).toBe(false)
    expect(matchesActivity(tokenAction, token, search('eeee'), none)).toBe(false)
  })

  it("names the counterparty from the token row's own key", () => {
    const contacts = contactNamesByKey([{ identityKey: ALICE, name: 'Alice' }])
    const token = { title: 'Sent USDX', incoming: false, counterpartyKey: ALICE }
    expect(matchesActivity(tokenAction, token, search('alice'), contacts)).toBe(true)
  })
})

describe('matchesActivity: type filter', () => {
  const received = action({ satoshis: 500, isOutgoing: false })
  const sent = action({ labels: ['peerpay', ALICE] })
  const failedSent = action({ labels: ['localpay'], status: 'failed' })
  const spent = action({ labels: ['some-app'] })
  const vaultIn = action({ satoshis: 500, labels: ['vault', 'vault-withdraw'] })
  const vaultOut = action({ labels: ['vault', 'vault-deposit'] })
  const rows = { received, sent, failedSent, spent, vaultIn, vaultOut }
  const kept = (kind: ActivityFilter['kind']) =>
    Object.entries(rows)
      .filter(([, row]) => matchesActivity(row, undefined, filter({ kind }), none))
      .map(([name]) => name)

  it('keeps only rows that say that word', () => {
    expect(kept('received')).toEqual(['received'])
    expect(kept('sent')).toEqual(['sent', 'failedSent'])
    expect(kept('spent')).toEqual(['spent'])
    expect(kept('transferred')).toEqual(['vaultIn', 'vaultOut'])
    expect(kept('all')).toEqual(Object.keys(rows))
  })

  it('reads a token row by its own direction, not the BSV it cost', () => {
    const tokenIn = action({ satoshis: -2, labels: ['mandala'] })
    expect(matchesActivity(tokenIn, { title: 'x', incoming: true }, filter({ kind: 'received' }), none)).toBe(true)
    expect(matchesActivity(tokenIn, { title: 'x', incoming: true }, filter({ kind: 'sent' }), none)).toBe(false)
  })

  it('needs both the type and the search to match', () => {
    const lunchIn = action({ satoshis: 500, description: 'lunch' })
    expect(matchesActivity(lunchIn, undefined, search('lunch', { kind: 'received' }), none)).toBe(true)
    expect(matchesActivity(lunchIn, undefined, search('lunch', { kind: 'sent' }), none)).toBe(false)
  })
})
