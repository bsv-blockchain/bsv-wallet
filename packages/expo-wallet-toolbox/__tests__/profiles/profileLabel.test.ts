import { profileLabel } from '../../core/profiles/profileLabel'

// The real catalogue interpolates {{number}}; this stand-in does the same so the
// test sees which key and values the helper asked for.
const t = jest.fn((key: string, opts?: Record<string, unknown>) =>
  key === 'profile_label' ? `profile${opts?.number}` : `?${key}`
)

beforeEach(() => t.mockClear())

describe('profileLabel', () => {
  test('uses the private name when there is one', () => {
    expect(profileLabel({ index: 2, name: 'Savings' }, t)).toBe('Savings')
    expect(t).not.toHaveBeenCalled()
  })

  test('falls back to profile<index + 1>', () => {
    expect(profileLabel({ index: 0 }, t)).toBe('profile1')
    expect(profileLabel({ index: 4 }, t)).toBe('profile5')
    expect(t).toHaveBeenCalledWith('profile_label', { number: 5 })
  })

  test('a name on profile 0 wins too, and an empty name is no name', () => {
    expect(profileLabel({ index: 0, name: 'Main' }, t)).toBe('Main')
    expect(profileLabel({ index: 1, name: '' }, t)).toBe('profile2')
  })

  test('a gap left by a removed profile keeps its number', () => {
    // profile2 was removed: the next live one is still profile3, never renumbered.
    expect(profileLabel({ index: 2 }, t)).toBe('profile3')
  })
})
