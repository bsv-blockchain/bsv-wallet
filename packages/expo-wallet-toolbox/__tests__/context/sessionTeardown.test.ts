import { registerSessionTeardown, runSessionTeardown } from '../../core/context/sessionTeardown'

describe('sessionTeardown', () => {
  const cleanups: Array<() => void> = []
  const reg = (...args: Parameters<typeof registerSessionTeardown>) => {
    const off = registerSessionTeardown(...args)
    cleanups.push(off)
    return off
  }
  afterEach(() => {
    cleanups.splice(0).forEach(off => off())
    jest.restoreAllMocks()
  })

  it('runs registered fns for matching reasons only', () => {
    const a = jest.fn()
    const b = jest.fn()
    reg(['logout', 'profile'], a)
    reg(['network'], b)
    runSessionTeardown('profile')
    expect(a).toHaveBeenCalledWith('profile')
    expect(b).not.toHaveBeenCalled()
    runSessionTeardown('network')
    expect(b).toHaveBeenCalledWith('network')
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('a throwing fn does not stop the others', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const after = jest.fn()
    reg(['logout'], () => {
      throw new Error('boom')
    })
    reg(['logout'], after)
    expect(() => runSessionTeardown('logout')).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('unregister removes it', () => {
    const fn = jest.fn()
    const off = reg(['rebuild'], fn)
    off()
    runSessionTeardown('rebuild')
    expect(fn).not.toHaveBeenCalled()
  })

  it('a fn may unregister itself while running', () => {
    const other = jest.fn()
    const off = reg(['logout'], () => off())
    reg(['logout'], other)
    runSessionTeardown('logout')
    runSessionTeardown('logout')
    expect(other).toHaveBeenCalledTimes(2)
  })
})
