import { patp, u32FromHexTail } from '../../core/pay/patp'

// Independent copies of the Urbit @p syllable tables (hoon.hoon ++po), typed
// out here rather than imported so the test can catch a corrupted table in the
// implementation instead of agreeing with it.
const PREFIX_TABLE =
  'dozmarbinwansamlitsighidfidlissogdirwacsabwissib' +
  'rigsoldopmodfoglidhopdardorlorhodfolrintogsilmir' +
  'holpaslacrovlivdalsatlibtabhanticpidtorbolfosdot' +
  'losdilforpilramtirwintadbicdifrocwidbisdasmidlop' +
  'rilnardapmolsanlocnovsitnidtipsicropwitnatpanmin' +
  'ritpodmottamtolsavposnapnopsomfinfonbanmorworsip' +
  'ronnorbotwicsocwatdolmagpicdavbidbaltimtasmallig' +
  'sivtagpadsaldivdactansidfabtarmonranniswolmispal' +
  'lasdismaprabtobrollatlonnodnavfignomnibpagsopral' +
  'bilhaddocridmocpacravripfaltodtiltinhapmicfanpat' +
  'taclabmogsimsonpinlomrictapfirhasbosbatpochactid' +
  'havsaplindibhosdabbitbarracparloddosbortochilmac' +
  'tomdigfilfasmithobharmighinradmashalraglagfadtop' +
  'mophabnilnosmilfopfamdatnoldinhatnacrisfotribhoc' +
  'nimlarfitwalrapsarnalmoslandondanladdovrivbacpol' +
  'laptalpitnambonrostonfodponsovnocsorlavmatmipfip'

const SUFFIX_TABLE =
  'zodnecbudwessevpersutletfulpensytdurwepserwylsun' +
  'rypsyxdyrnuphebpeglupdepdysputlughecryttyvsydnex' +
  'lunmeplutseppesdelsulpedtemledtulmetwenbynhexfeb' +
  'pyldulhetmevruttylwydtepbesdexsefwycburderneppur' +
  'rysrebdennutsubpetrulsynregtydsupsemwynrecmegnet' +
  'secmulnymtevwebsummutnyxrextebfushepbenmuswyxsym' +
  'selrucdecwexsyrwetdylmynmesdetbetbeltuxtugmyrpel' +
  'syptermebsetdutdegtexsurfeltudnuxruxrenwytnubmed' +
  'lytdusnebrumtynseglyxpunresredfunrevrefmectedrus' +
  'bexlebduxrynnumpyxrygryxfeptyrtustyclegnemfermer' +
  'tenlusnussyltecmexpubrymtucfyllepdebbermughuttun' +
  'bylsudpemdevlurdefbusbeprunmelpexdytbyttyplevmyl' +
  'wedducfurfexnulluclennerlexrupnedlecrydlydfenwel' +
  'nydhusrelrudneshesfetdesretdunlernyrsebhulryllud' +
  'remlysfynwerrycsugnysnyllyndyndemluxfedsedbecmun' +
  'lyrtesmudnytbyrsenwegfyrmurtelreptegpecnelnevfes'

const PREFIXES = new Set(PREFIX_TABLE.match(/.{3}/g) as string[])
const SUFFIXES = new Set(SUFFIX_TABLE.match(/.{3}/g) as string[])

/** Deterministic LCG so the sample is the same on every run. */
function sampleU32s(count: number, seed: number): number[] {
  const out: number[] = []
  let x = seed >>> 0
  while (out.length < count) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    out.push(x)
  }
  return out
}

/** Split '~dapnep-ronmyl' into [['dap','nep'],['ron','myl']]. */
function syllablePairs(name: string): string[][] {
  return name
    .slice(1)
    .split('-')
    .map(word => word.match(/.{3}/g) as string[])
}

describe('patp', () => {
  it('matches the known Urbit @p vectors', () => {
    expect(PREFIXES.size).toBe(256)
    expect(SUFFIXES.size).toBe(256)
    expect(patp(0)).toBe('~zod')
    expect(patp(255)).toBe('~fes')
    expect(patp(256)).toBe('~marzod')
    expect(patp(65535)).toBe('~fipfes')
    expect(patp(65536)).toBe('~dapnep-ronmyl')
    expect(patp(15663360)).toBe('~nidsut-tomdun')
    expect(patp(0xdeadbeef)).toBe('~biltyc-mitfyl')
    expect(patp(0xffffffff)).toBe('~dostec-risfen')
  })

  it('emits only lowercase letters, hyphens and a leading tilde', () => {
    const inputs = [0, 1, 200, 256, 40000, 65535, ...sampleU32s(50, 7)]
    for (const n of inputs) {
      expect(patp(n)).toMatch(/^~[a-z-]+$/)
    }
  })

  it('gives galaxies one syllable, stars two and planets four', () => {
    expect(patp(17).replace(/[~-]/g, '')).toHaveLength(3)
    expect(patp(4000).replace(/[~-]/g, '')).toHaveLength(6)
    const planets = sampleU32s(20, 42).map(n => (n < 65536 ? n + 65536 : n))
    for (const n of planets) {
      const name = patp(n)
      expect(name).toMatch(/^~[a-z]{6}-[a-z]{6}$/)
      expect(name.replace(/[~-]/g, '')).toHaveLength(12)
    }
  })

  it('draws every syllable from the 512 table entries', () => {
    const inputs = [0, 3, 255, 256, 257, 65535, 65536, ...sampleU32s(40, 99)]
    for (const n of inputs) {
      const words = syllablePairs(patp(n))
      for (const word of words) {
        if (word.length === 1) {
          // A lone syllable is always a galaxy and galaxies are suffixes.
          expect(SUFFIXES.has(word[0])).toBe(true)
        } else {
          expect(word).toHaveLength(2)
          expect(PREFIXES.has(word[0])).toBe(true)
          expect(SUFFIXES.has(word[1])).toBe(true)
        }
      }
    }
  })

  it('is a bijection on a sample: distinct inputs give distinct names', () => {
    const inputs = [0, 1, 255, 256, 65535, 65536, 65537, ...sampleU32s(200, 5)]
    const names = new Set(inputs.map(patp))
    expect(names.size).toBe(new Set(inputs).size)
  })

  it('rejects values outside the 32-bit domain and non-integers', () => {
    expect(() => patp(-1)).toThrow(RangeError)
    expect(() => patp(2 ** 32)).toThrow(RangeError)
    expect(() => patp(1.5)).toThrow(RangeError)
    expect(() => patp(Number.NaN)).toThrow(RangeError)
  })
})

describe('u32FromHexTail', () => {
  it('reads the last eight hex digits as a big-endian unsigned 32-bit int', () => {
    expect(u32FromHexTail('deadbeef')).toBe(0xdeadbeef)
    expect(u32FromHexTail('0000000000000000deadbeef')).toBe(0xdeadbeef)
    expect(u32FromHexTail('02' + 'a'.repeat(56) + 'FFFFFFFF')).toBe(0xffffffff)
    expect(u32FromHexTail('00000000')).toBe(0)
  })

  it('is case-insensitive', () => {
    expect(u32FromHexTail('DEADBEEF')).toBe(u32FromHexTail('deadbeef'))
  })

  it('throws on fewer than eight hex digits', () => {
    expect(() => u32FromHexTail('')).toThrow()
    expect(() => u32FromHexTail('abcdef1')).toThrow()
  })

  it('throws on non-hex input', () => {
    expect(() => u32FromHexTail('zzzzzzzz')).toThrow()
    expect(() => u32FromHexTail('to:1BoatSLRHtKNngkdXEeobR76b53LETtpyT')).toThrow()
  })
})
