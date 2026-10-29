import { createTokenOutbox } from '../../src/controller/tokenOutbox'
import { redact } from '../../src/controller/redact'

describe('token outbox', () => {
  it('delivered once on the first response', () => {
    const o = createTokenOutbox()
    o.put('e1', 'tok')
    expect(o.take('e1')).toBe('tok')
    o.confirmWritten('e1')
    expect(o.take('e1')).toBeUndefined()
  })

  it('kept after a failed write', () => {
    const o = createTokenOutbox()
    o.put('e1', 'tok')
    expect(o.take('e1')).toBe('tok')
    // The write failed, so confirmWritten is never called.
    expect(o.take('e1')).toBe('tok')
  })

  it('dropped on close', () => {
    const o = createTokenOutbox()
    o.put('e1', 'tok')
    o.drop('e1')
    expect(o.take('e1')).toBeUndefined()
  })

  it('never in logs', () => {
    const o = createTokenOutbox()
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m =>
      jest.spyOn(console, m).mockImplementation(() => {})
    )
    o.put('e1', 'SECRET-TOKEN')
    o.take('e1')
    o.confirmWritten('e1')
    o.drop('e1')
    for (const s of spies) expect(s).not.toHaveBeenCalled()
    jest.restoreAllMocks()
  })
})

describe('redact', () => {
  it('removes launch URIs, epochs, binding headers and base64url runs', () => {
    const text =
      'fail bsv-wallet-bridge://launch?v=1&e=00000000-0000-4000-8000-000000000001&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&n=BBBBBBBBBBBBBBBBBBBBBB ' +
      'epoch 00000000-0000-4000-8000-000000000002 BRC-185-Android-Binding: abcDEF123 token QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'
    const out = redact(text)
    expect(out).not.toMatch(/00000000-0000/)
    expect(out).not.toMatch(/AAAAAAAAAA/)
    expect(out).not.toMatch(/abcDEF123/)
    expect(out).not.toMatch(/QUJDREVG/)
    expect(out).toContain('fail')
  })
})
