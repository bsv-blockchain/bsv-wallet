/**
 * Strict JSON parsing and RFC 8785 (JCS) canonicalisation for BRC-185.
 *
 * `JSON.parse` silently keeps the last of two equal keys and accepts lone surrogates, either of which
 * lets two parties read the same bytes differently. The wire profile refuses both, plus non-finite
 * numbers, so a signed preimage has one meaning.
 */

export class StrictJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StrictJsonError'
  }
}

const MAX_DEPTH = 64

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff
}
function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff
}

/** True when `s` contains an unpaired surrogate code unit. */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (isHigh(c)) {
      if (i + 1 < s.length && isLow(s.charCodeAt(i + 1))) i++
      else return true
    } else if (isLow(c)) {
      return true
    }
  }
  return false
}

function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty so a "__proto__" key is data, never a prototype write.
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}

class Parser {
  private i = 0
  constructor(private readonly s: string) {}

  parse(): unknown {
    this.ws()
    const v = this.value(0)
    this.ws()
    if (this.i !== this.s.length) this.fail('unexpected trailing content')
    return v
  }

  private fail(msg: string): never {
    throw new StrictJsonError(`${msg} at offset ${this.i}`)
  }

  private ws(): void {
    while (this.i < this.s.length) {
      const c = this.s[this.i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i++
      else break
    }
  }

  private value(depth: number): unknown {
    if (depth > MAX_DEPTH) this.fail('nesting too deep')
    const c = this.s[this.i]
    if (c === '{') return this.object(depth)
    if (c === '[') return this.array(depth)
    if (c === '"') return this.string()
    if (c === 't') return this.literal('true', true)
    if (c === 'f') return this.literal('false', false)
    if (c === 'n') return this.literal('null', null)
    if (c === '-' || (c >= '0' && c <= '9')) return this.number()
    return this.fail('unexpected character')
  }

  private literal<T>(word: string, value: T): T {
    if (this.s.startsWith(word, this.i)) {
      this.i += word.length
      return value
    }
    return this.fail('invalid literal')
  }

  private number(): number {
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.s.slice(this.i, this.i + 400))
    if (!m) this.fail('invalid number')
    const n = Number(m[0])
    if (!Number.isFinite(n)) this.fail('non-finite number')
    this.i += m[0].length
    return n
  }

  private string(): string {
    this.i++ // opening quote
    let out = ''
    for (;;) {
      if (this.i >= this.s.length) this.fail('unterminated string')
      const c = this.s[this.i]
      const code = c.charCodeAt(0)
      if (c === '"') {
        this.i++
        break
      }
      if (code < 0x20) this.fail('control character in string')
      if (c === '\\') {
        const e = this.s[this.i + 1]
        this.i += 2
        switch (e) {
          case '"':
          case '\\':
          case '/':
            out += e
            break
          case 'b':
            out += '\b'
            break
          case 'f':
            out += '\f'
            break
          case 'n':
            out += '\n'
            break
          case 'r':
            out += '\r'
            break
          case 't':
            out += '\t'
            break
          case 'u': {
            const hex = this.s.slice(this.i, this.i + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid unicode escape')
            out += String.fromCharCode(parseInt(hex, 16))
            this.i += 4
            break
          }
          default:
            this.fail('invalid escape')
        }
      } else {
        out += c
        this.i++
      }
    }
    if (hasLoneSurrogate(out)) this.fail('lone surrogate in string')
    return out
  }

  private array(depth: number): unknown[] {
    this.i++
    const out: unknown[] = []
    this.ws()
    if (this.s[this.i] === ']') {
      this.i++
      return out
    }
    for (;;) {
      this.ws()
      out.push(this.value(depth + 1))
      this.ws()
      const c = this.s[this.i++]
      if (c === ',') continue
      if (c === ']') return out
      this.i--
      this.fail('expected , or ]')
    }
  }

  private object(depth: number): Record<string, unknown> {
    this.i++
    const out: Record<string, unknown> = {}
    const seen = new Set<string>()
    this.ws()
    if (this.s[this.i] === '}') {
      this.i++
      return out
    }
    for (;;) {
      this.ws()
      if (this.s[this.i] !== '"') this.fail('expected string key')
      const key = this.string()
      if (seen.has(key)) this.fail(`duplicate key "${key}"`)
      seen.add(key)
      this.ws()
      if (this.s[this.i++] !== ':') {
        this.i--
        this.fail('expected :')
      }
      this.ws()
      setOwn(out, key, this.value(depth + 1))
      this.ws()
      const c = this.s[this.i++]
      if (c === ',') continue
      if (c === '}') return out
      this.i--
      this.fail('expected , or }')
    }
  }
}

/** Parse JSON text, throwing {@link StrictJsonError} on duplicate keys, lone surrogates or non-finite numbers. */
export function parseStrictJson(text: string): unknown {
  if (typeof text !== 'string') throw new StrictJsonError('JSON input must be a string')
  if (hasLoneSurrogate(text)) throw new StrictJsonError('lone surrogate in input')
  return new Parser(text).parse()
}

/**
 * RFC 8785 JSON Canonicalization Scheme. Keys sort by UTF-16 code units, numbers use the ECMAScript
 * shortest form (which JCS adopts), strings use the minimal JSON escapes. Values JSON cannot carry
 * (undefined, functions, bigint, NaN, lone surrogates) throw rather than being dropped.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new StrictJsonError('cannot canonicalize a non-finite number')
      return JSON.stringify(value)
    case 'string':
      if (hasLoneSurrogate(value)) throw new StrictJsonError('cannot canonicalize a lone surrogate')
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
      const rec = value as Record<string, unknown>
      const keys = Object.keys(rec).sort()
      return `{${keys.map(k => `${canonicalize(k)}:${canonicalize(rec[k])}`).join(',')}}`
    }
    default:
      throw new StrictJsonError(`cannot canonicalize a ${typeof value}`)
  }
}
