/**
 * Urbit `@p` names for 32-bit integers, e.g. 15663360 -> '~nidsut-tomdun'.
 *
 * Faithful port of urbit-ob 5.0.1 (src/internal/co.js, ob.js, muk.js),
 * restricted to the 32-bit domain we need: one syllable for n < 256 (galaxy),
 * two for n < 65536 (star), four for everything else (planet). Planets are
 * Feistel-scrambled exactly as in Urbit so that neighbouring seeds do not get
 * neighbouring names, and so the output matches what any other @p tooling
 * (sigil-js, urbit-ob, Landscape) would show for the same number.
 *
 * urbit-ob is not a dependency: it pulls in bn.js and lodash for arithmetic
 * that fits comfortably in a JS double once the domain is 2^32. Everything
 * here is plain numbers; `Math.imul` and `>>> 0` supply the 32-bit wrap the
 * hash needs.
 */

// ++po in hoon.hoon: 256 prefix and 256 suffix syllables, 3 chars each.
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

const PREFIXES = PREFIX_TABLE.match(/.{3}/g) as string[]
const SUFFIXES = SUFFIX_TABLE.match(/.{3}/g) as string[]

/** Per-round hash seeds ("raku") from ++ob in hoon.hoon. */
const RAKU = [0xb76d5eed, 0xee281300, 0x85bcae01, 0x4b387af7]

// Feistel parameters: 4 rounds over the domain 65535 x 65536, which is exactly
// the 0xffff0000 planet numbers between 0x10000 and 0xffffffff.
const ROUNDS = 4
const A = 65535
const B = 65536
const K = 0xffffffff

/**
 * MurmurHash3 (32-bit, Austin Appleby's x86 variant) over a short byte array.
 * urbit-ob's `muk` feeds it a 2-byte string; the general loop is kept so the
 * function reads as the well-known algorithm rather than a special case.
 */
function murmur3(bytes: number[], seed: number): number {
  const c1 = 0xcc9e2d51
  const c2 = 0x1b873593
  let h1 = seed | 0
  const blockEnd = bytes.length & ~3
  let i = 0
  for (; i < blockEnd; i += 4) {
    let k1 = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)
    k1 = Math.imul(k1, c1)
    k1 = (k1 << 15) | (k1 >>> 17)
    k1 = Math.imul(k1, c2)
    h1 ^= k1
    h1 = (h1 << 13) | (h1 >>> 19)
    h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0
  }
  const rem = bytes.length & 3
  if (rem > 0) {
    let k1 = 0
    if (rem === 3) k1 ^= bytes[i + 2] << 16
    if (rem >= 2) k1 ^= bytes[i + 1] << 8
    k1 ^= bytes[i]
    k1 = Math.imul(k1, c1)
    k1 = (k1 << 15) | (k1 >>> 17)
    k1 = Math.imul(k1, c2)
    h1 ^= k1
  }
  h1 ^= bytes.length
  h1 ^= h1 >>> 16
  h1 = Math.imul(h1, 0x85ebca6b)
  h1 ^= h1 >>> 13
  h1 = Math.imul(h1, 0xc2b2ae35)
  h1 ^= h1 >>> 16
  return h1 >>> 0
}

/** ++muk: murmur3 of the key's low two bytes, little-endian, with the given seed. */
function muk(seed: number, key: number): number {
  return murmur3([key & 0xff, (key >>> 8) & 0xff], seed)
}

/** The round function: a PRF indexed by round number. */
function F(round: number, arg: number): number {
  return muk(RAKU[round], arg)
}

/**
 * One pass of the generalised Feistel cipher (Black and Rogaway 2002, as
 * adjusted in hoon.hoon). The final recombination is asymmetric when the
 * round count is even: that quirk is what makes urbit-ob's `feis` agree with
 * the ship names Urbit has already handed out, so it is kept verbatim.
 */
function fe(m: number): number {
  let ell = m % A
  let arr = Math.floor(m / A)
  for (let j = 1; j <= ROUNDS; j++) {
    const eff = F(j - 1, arr)
    const tmp = j % 2 !== 0 ? (ell + eff) % A : (ell + eff) % B
    ell = arr
    arr = tmp
  }
  if (ROUNDS % 2 !== 0) return A * arr + ell
  return arr === A ? A * arr + ell : A * ell + arr
}

/** `Fe`: cycle-walk once more if the first pass lands outside the domain. */
function feis(m: number): number {
  const c = fe(m)
  return c < K ? c : fe(c)
}

/** ++fein: scramble planets only; galaxies and stars keep their raw number. */
function fein(n: number): number {
  return n >= 0x10000 && n <= 0xffffffff ? 0x10000 + feis(n - 0x10000) : n
}

/**
 * Canonical Urbit @p for an unsigned 32-bit integer, '~'-prefixed.
 * Throws a RangeError for anything outside that domain: moons and comets
 * need 64 and 128 bits and are deliberately out of scope here.
 */
export function patp(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new RangeError(`patp: expected an integer in [0, 2^32), got ${String(n)}`)
  }
  const sxz = fein(n)
  if (sxz < 256) return '~' + SUFFIXES[sxz]
  // Each 16-bit chunk becomes prefix+suffix; the high chunk is spoken first.
  const words: string[] = []
  let rest = sxz
  while (rest > 0) {
    const chunk = rest % 65536
    words.unshift(PREFIXES[chunk >>> 8] + SUFFIXES[chunk & 0xff])
    rest = Math.floor(rest / 65536)
  }
  return '~' + words.join('-')
}

/**
 * The last eight hex digits of a hex string as an unsigned 32-bit integer.
 * Meant for txids and compressed public keys, whose tails are already
 * uniformly distributed, so no further mixing is needed before `patp`.
 * Throws when the input is not hex or is shorter than eight digits, so a
 * caller that hands over the wrong field finds out immediately.
 */
export function u32FromHexTail(hex: string): number {
  if (!/^[0-9a-fA-F]{8,}$/.test(hex)) {
    throw new Error(`u32FromHexTail: expected at least 8 hex digits, got ${hex.length} chars`)
  }
  return Number.parseInt(hex.slice(-8), 16)
}
