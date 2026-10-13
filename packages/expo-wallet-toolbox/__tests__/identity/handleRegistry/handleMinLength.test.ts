import { configureToolbox, getHandleMinLength } from '../../../core/toolboxConfig'
import { isValidHandleFormat, parsePaymail } from '../../../core/identity/handleRegistry/rules'

const base = { backupUrl: null }

describe('handleMinLength', () => {
  afterEach(() => configureToolbox(base))

  test('defaults to 3: the existing rule is unchanged', () => {
    configureToolbox(base)
    expect(getHandleMinLength()).toBe(3)
    expect(isValidHandleFormat('ab')).toBe(false)
    expect(isValidHandleFormat('abc')).toBe(true)
    expect(isValidHandleFormat('a'.repeat(32))).toBe(true)
    expect(isValidHandleFormat('a'.repeat(33))).toBe(false)
    expect(parsePaymail('ab@example.com')).toBeNull()
  })

  test('a host can lower it to 1 or 2', () => {
    configureToolbox({ ...base, handleMinLength: 1 })
    expect(isValidHandleFormat('a')).toBe(true)
    expect(isValidHandleFormat('a1')).toBe(true)
    expect(parsePaymail('a@bitcoinsv.com')).toEqual({ handle: 'a', domain: 'bitcoinsv.com' })
    configureToolbox({ ...base, handleMinLength: 2 })
    expect(isValidHandleFormat('a')).toBe(false)
    expect(isValidHandleFormat('ab')).toBe(true)
  })

  test('the character rules hold at every length', () => {
    configureToolbox({ ...base, handleMinLength: 1 })
    for (const bad of ['.', '_', '-', 'a.', '.a', 'a-', 'A', 'a b', 'é']) expect(isValidHandleFormat(bad)).toBe(false)
    for (const good of ['a.b', 'a_b', 'a-b', '0', 'z9']) expect(isValidHandleFormat(good)).toBe(true)
  })

  test('anything else falls back to 3', () => {
    configureToolbox({ ...base, handleMinLength: 0 as never })
    expect(getHandleMinLength()).toBe(3)
  })
})
