import { homeBadges } from '../../ui/screens/homeBadges'

describe('homeBadges', () => {
  it('lists attention and offline counts, omitting zeros', () => {
    expect(homeBadges({ attention: 2, unsent: 0, offlineQueued: 1, offlineRejected: 0 })).toEqual([
      { kind: 'attention', count: 2 },
      { kind: 'offline', count: 1 }
    ])
  })

  it('includes unsent and sums queued plus rejected offline work', () => {
    expect(homeBadges({ attention: 0, unsent: 3, offlineQueued: 1, offlineRejected: 2 })).toEqual([
      { kind: 'unsent', count: 3 },
      { kind: 'offline', count: 3 }
    ])
  })

  it('returns nothing when there is no stuck work', () => {
    expect(homeBadges({ attention: 0, unsent: 0, offlineQueued: 0, offlineRejected: 0 })).toEqual([])
  })
})
