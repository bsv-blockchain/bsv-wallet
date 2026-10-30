import { b64uDecode, b64uEncode, Base64urlError } from '../../../core/bridge/protocol/base64url'

describe('base64url', () => {
  it('round-trips every length', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n * 11) & 255)
      const s = b64uEncode(bytes)
      expect(Array.from(b64uDecode(s))).toEqual(Array.from(bytes))
      expect(s).toBe(Buffer.from(bytes).toString('base64url'))
    }
  })

  it('uses the url-safe alphabet', () => {
    expect(b64uEncode(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-')
  })

  it('rejects non-canonical forms', () => {
    const bad = ['Zg==', 'Zg=', 'Zm9v ', ' Zm9v', 'Zm9v\n', 'Zm+v', 'Zm/v', 'Z', 'Zh', 'Zm9', 'ZW5', '=']
    for (const s of bad) expect(() => b64uDecode(s)).toThrow(Base64urlError)
  })

  it('rejects non-zero trailing bits', () => {
    expect(b64uDecode('Zg')).toEqual(new Uint8Array([0x66]))
    expect(() => b64uDecode('Zh')).toThrow(Base64urlError)
    expect(b64uDecode('Zm8')).toEqual(new Uint8Array([0x66, 0x6f]))
    expect(() => b64uDecode('Zm9')).toThrow(Base64urlError)
  })
})
