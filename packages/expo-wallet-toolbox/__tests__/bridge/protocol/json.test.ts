import { canonicalize, parseStrictJson, StrictJsonError } from '../../../core/bridge/protocol/json'

function f64(hex: string): number {
  const v = new DataView(new ArrayBuffer(8))
  v.setBigUint64(0, BigInt('0x' + hex))
  return v.getFloat64(0)
}

describe('canonicalize (RFC 8785)', () => {
  it('matches the Appendix B number serialisation table', () => {
    const table: Array<[string, string]> = [
      ['0000000000000000', '0'],
      ['8000000000000000', '0'],
      ['0000000000000001', '5e-324'],
      ['7fefffffffffffff', '1.7976931348623157e+308'],
      ['4340000000000000', '9007199254740992'],
      ['4430000000000000', '295147905179352830000'],
      ['444b1ae4d6e2ef50', '1e+21'],
      ['3eb0c6f7a0b5ed8d', '0.000001'],
      ['41b3de4355555553', '333333333.3333332'],
      ['41b3de4355555555', '333333333.3333333'],
      ['41b3de4355555557', '333333333.33333343'],
      ['43143ff3c1cb0959', '1424953923781206.2']
    ]
    for (const [hex, expected] of table) expect(canonicalize(f64(hex))).toBe(expected)
  })

  it('canonicalises the Appendix A style document', () => {
    const input = parseStrictJson(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"/","literals":[null,true,false]}'
    )
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}'
    )
  })

  it('sorts keys by UTF-16 code units', () => {
    const o = parseStrictJson('{"\\u20ac":1,"\\r":2,"\\ufb33":3,"1":4,"\\ud83d\\ude00":5,"\\u0080":6,"\\u00f6":7}')
    expect(canonicalize(o)).toBe('{"\\r":2,"1":4,"\u0080":6,"\u00f6":7,"\u20ac":1,"\ud83d\ude00":5,"\ufb33":3}')
  })

  it('refuses values JSON cannot carry', () => {
    expect(() => canonicalize({ a: undefined })).toThrow(StrictJsonError)
    expect(() => canonicalize(NaN)).toThrow(StrictJsonError)
    expect(() => canonicalize('\ud800')).toThrow(StrictJsonError)
    expect(() => canonicalize(BigInt(1))).toThrow(StrictJsonError)
  })
})

describe('parseStrictJson', () => {
  it('parses ordinary documents', () => {
    expect(parseStrictJson(' {"a":[1,2.5,-0,true,null,"x"],"b":{}} ')).toEqual({
      a: [1, 2.5, -0, true, null, 'x'],
      b: {}
    })
  })

  it('rejects duplicate keys, also after unescaping', () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(StrictJsonError)
    expect(() => parseStrictJson('{"a":1,"\\u0061":2}')).toThrow(StrictJsonError)
  })

  it('rejects lone surrogates in escapes and raw text', () => {
    expect(() => parseStrictJson('"\\ud800"')).toThrow(StrictJsonError)
    expect(() => parseStrictJson('"\\udc00\\ud800"')).toThrow(StrictJsonError)
    expect(() => parseStrictJson('"\ud800"')).toThrow(StrictJsonError)
    expect(parseStrictJson('"\\ud83d\\ude00"')).toBe('\ud83d\ude00')
  })

  it('rejects non-finite numbers', () => {
    expect(() => parseStrictJson('1e999')).toThrow(StrictJsonError)
    expect(() => parseStrictJson('NaN')).toThrow(StrictJsonError)
  })

  it('rejects malformed JSON', () => {
    for (const bad of ['', '{', '[1,]', '{"a":1,}', "{'a':1}", '01', '1.', '"\t"', '{"a":1} x', 'tru', '"\\x"']) {
      expect(() => parseStrictJson(bad)).toThrow(StrictJsonError)
    }
  })

  it('treats __proto__ as plain data', () => {
    const v = parseStrictJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>
    expect(Object.keys(v)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype)
  })

  it('limits nesting depth', () => {
    expect(() => parseStrictJson('['.repeat(200) + ']'.repeat(200))).toThrow(StrictJsonError)
  })
})
