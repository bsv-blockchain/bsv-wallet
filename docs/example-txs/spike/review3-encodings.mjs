// review3-encodings.mjs — r / s / sInv script-number encoding classes. Generates many genuine signatures for one
// (lock, tx) by walking k -> k+1 (R += G), buckets r, s, sInv by minimal-encoding class, then runs each collected
// example through buildUnlockAsync (external-signer path, compact r||s) and the interpreter. Negative controls
// show that non-minimal encodings of the same values are rejected.
import { Transaction, Spend, P2PKH, PrivateKey, BigNumber, UnlockingScript } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { buildLock, scriptNum, encNum, pushData, P256_N } from './gen.mjs'
import { buildUnlockAsync, sighashPreimage, signerDigest, pushTxDerCheck, decodeUnlock } from './unlock.mjs'
const hex = a => Buffer.from(a).toString('hex')
const mod = (a, m) => ((a % m) + m) % m
const modpow = (b, e, m) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n } return r }
const modinv = (a, m) => modpow(a, m - 2n, m)
const be32 = v => Uint8Array.from(Buffer.from(v.toString(16).padStart(64, '0'), 'hex'))
const compact = (r, s) => Uint8Array.from([...be32(r), ...be32(s)])
let fails = 0
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' :: ' + d : ''}`); if (!ok) fails++ }
const n = P256_N
const priv = p256.utils.randomSecretKey(); const qHex = hex(p256.getPublicKey(priv, true)); const Q = p256.Point.fromHex(qHex)
const d = BigInt('0x' + hex(priv))
const sats = 50000
const lock = buildLock({ qCompressedHex: qHex, satoshis: sats })
const dest = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
let tx, preimage
for (let out = 49000; ; out--) {
  tx = new Transaction(1, [], [], 0)
  tx.addInput({ sourceTXID: hex(crypto.getRandomValues(new Uint8Array(32))), sourceOutputIndex: 0, sequence: 0xffffffff })
  tx.addOutput({ satoshis: out, lockingScript: dest })
  preimage = sighashPreimage({ tx, inputIndex: 0, sourceSatoshis: sats })
  if (pushTxDerCheck(preimage).ok) break
}
const digest = signerDigest(preimage); const e = BigInt('0x' + hex(digest))
const validate = unlock => {
  const sp = new Spend({ sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: 0, sourceSatoshis: sats, lockingScript: lock, transactionVersion: 1, otherInputs: [], outputs: tx.outputs, unlockingScript: unlock, inputSequence: 0xffffffff, inputIndex: 0, lockTime: 0 })
  try { return { ok: sp.validate(), pc: sp.programCounter } } catch (er) { return { ok: false, pc: sp.programCounter, err: er.message.split('\n')[0] } }
}
const cls = v => v >= (1n << 255n) ? 'A:33B(>=2^255, trailing 00 sign byte)' : v >= (1n << 248n) ? 'B:32B([2^248,2^255))' : v >= (1n << 247n) ? 'C:31B+00([2^247,2^248): BE leading 00, LE sign byte)' : v >= (1n << 240n) ? 'D:31B([2^240,2^247))' : 'E:<=30B(<2^240)'
const PER = 2
const buckets = { r: {}, s: {}, sInv: {}, sHigh: {}, sHighInv: {} }
const add = (field, v, ex) => { const c = cls(v); (buckets[field][c] ??= []).length < PER && buckets[field][c].push(ex) }
const N = Number(process.env.SIGS ?? 20000)
let k = BigInt('0x' + hex(p256.utils.randomSecretKey())); if (k > n - BigInt(N) - 10n) k -= BigInt(N) + 10n
let R = p256.Point.BASE.multiply(k)
const t0 = Date.now(); let made = 0
for (let i = 0; i < N; i++, k += 1n, R = R.add(p256.Point.BASE)) {
  const x = R.toAffine().x, rsig = x % n
  if (rsig === 0n) continue
  const s0 = mod(modinv(k, n) * (e + rsig * d), n); if (s0 === 0n) continue
  const sLow = s0 > n / 2n ? n - s0 : s0, sHigh = n - sLow
  const ex = { x, rsig, sLow, sHigh, sInvLow: modinv(sLow, n), sInvHigh: modinv(sHigh, n) }
  if (made < 3) check(`walked-k signature #${made} verifies with noble (lowS)`, p256.verify(compact(rsig, sLow), digest, Q.toBytes(true), { prehash: false, lowS: false }))
  made++
  add('r', x, ex); add('s', sLow, ex); add('sInv', ex.sInvLow, ex); add('sHigh', sHigh, ex); add('sHighInv', ex.sInvHigh, ex)
}
console.log(`generated ${made} signatures in ${Date.now() - t0} ms; class coverage:`)
for (const f of Object.keys(buckets)) console.log(`  ${f}: ${Object.keys(buckets[f]).sort().map(c => c + ' x' + buckets[f][c].length).join(' | ')}`)
// validate each collected example via the real external-signer path
const seen = new Set()
async function runCase (label, ex, high) {
  const key = `${ex.rsig}:${high}`; if (seen.has(key)) return; seen.add(key)
  const s = high ? ex.sHigh : ex.sLow
  let unlock, err
  try { unlock = await buildUnlockAsync({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, Q: qHex, signDigest: () => compact(ex.rsig, s) }) } catch (er) { err = er.message }
  if (!unlock) { check(`${label}: buildUnlockAsync`, false, err); return }
  const f = decodeUnlock(unlock), ch = unlock.chunks
  const sdkEnc = v => hex(new BigNumber(v.toString(16), 16).toSm('little'))
  const encOk = hex(ch[0].data) === sdkEnc(ex.x) && hex(ch[1].data) === sdkEnc(s) && hex(ch[2].data) === sdkEnc(modinv(s, n)) && ch.slice(0, 3).every(c => c.op === c.data.length)
  const v = validate(unlock)
  check(`${label}: validate=${v.ok}; pushes r:${ch[0].data.length}B s:${ch[1].data.length}B sInv:${ch[2].data.length}B; bytes == BigNumber.toSm('little')`, v.ok && encOk && f.r === ex.x && f.s === s, `r∈${cls(ex.x)} s∈${cls(s)} sInv∈${cls(modinv(s, n))} pc=${v.pc}${v.err ? ' ' + v.err : ''}`)
  return { unlock, ex, s }
}
const kept = {}
for (const field of ['r', 's', 'sInv']) for (const c of Object.keys(buckets[field]).sort()) for (const ex of buckets[field][c]) { const res = await runCase(`${field} class ${c}`, ex, false); if (res) kept[`${field}:${c}`] ??= res }
for (const field of ['sHigh', 'sHighInv']) for (const c of Object.keys(buckets[field]).sort()) for (const ex of buckets[field][c]) { const res = await runCase(`${field} (high-S) class ${c}`, ex, true); if (res) kept[`${field}:${c}`] ??= res }
// noble software-signer path with fresh nonces (extraEntropy) x5
{
  const sigs = new Set(); let allOk = true
  for (let i = 0; i < 5; i++) {
    const sig = p256.sign(digest, priv, { prehash: false, extraEntropy: true }); sigs.add(hex(sig))
    const unlock = await buildUnlockAsync({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, Q: qHex, signDigest: () => sig })
    if (!validate(unlock).ok) allOk = false
  }
  check('5 noble p256.sign(extraEntropy) signatures (distinct) all validate', allOk && sigs.size === 5, `${sigs.size} distinct`)
}
// negative controls: non-minimal encodings of the SAME values
const rebuild = (u, i, data, opOverride) => { const ch = u.chunks.map(c => c.data ? pushData(c.data) : [c.op]); ch[i] = opOverride ? [76, data.length, ...data] : pushData(data); return UnlockingScript.fromBinary(ch.flat()) }
const neg = (label, res, i, data, opOverride = false) => { if (!res) { console.log(`SKIP ${label} (no example)`); return } const v = validate(rebuild(res.unlock, i, data, opOverride)); check(`${label} -> rejected`, !v.ok, `pc=${v.pc} ${v.err ?? ''}`) }
const pick = pref => Object.entries(kept).find(([k]) => k.startsWith(pref))?.[1]
const rShort = pick('r:D') ?? pick('r:C'), rLong = pick('r:A'), sAny = pick('s:B'), rPlain = pick('r:B')
if (rShort) neg(`r<2^248 padded to 32 LE bytes with 0x00 (non-minimal number)`, rShort, 0, [...scriptNum(rShort.ex.x), 0])
if (rLong) neg(`r>=2^255 with the trailing 0x00 sign byte stripped (reads as negative)`, rLong, 0, scriptNum(rLong.ex.x).slice(0, 32))
if (sAny) neg(`s padded with 0x00 (non-minimal number)`, sAny, 1, [...scriptNum(sAny.s), 0])
if (rPlain) neg(`r pushed via PUSHDATA1 instead of direct push (non-minimal push opcode)`, rPlain, 0, scriptNum(rPlain.ex.x), true)
if (rShort) neg(`r<2^248 as 32 BE-style bytes (i.e. LE reversed; wrong number)`, rShort, 0, [...scriptNum(rShort.ex.x)].reverse())
console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS')
process.exitCode = fails ? 1 : 0
