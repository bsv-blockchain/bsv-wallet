// hardened-test.mjs — does the gen2-hardened.mjs header kill the v1 malleability variants found by adv-review.mjs?
import { Spend, Transaction, P2PKH, PrivateKey, MerklePath, UnlockingScript, Script } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { buildLock2, commitmentFor, encNum, P256_N, P256_P } from './gen2.mjs'
import { buildUnlock2, encodeUnlock2, decodeUnlock2 } from './unlock2.mjs'
import { signerDigest } from './unlock.mjs'
import { buildLock2Hardened, lowSNormalize, HALF_N } from './gen2-hardened.mjs'

const hex = a => Buffer.from(a).toString('hex')
const mod = (a, m) => ((a % m) + m) % m
const tmod = (a, m) => a % m
const tdiv = (a, b) => a / b
const modpow = (b, e, m) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n } return r }
const modinv = (a, m) => modpow(a, m - 2n, m)
const beToBig = b => BigInt('0x' + (hex(b) || '0'))
const C = (1n << 258n) - 1n
const scriptRecode = u => { let v = u; if (tmod(v, 2n) === 0n) v += P256_N; return tdiv(v + C, 2n) }
function variant (good, e, { r = good.r, s = good.s, sInv = good.sInv } = {}) {
  if (tmod(s * sInv, P256_N) !== 1n) return null
  return encodeUnlock2({ ...good, r, s, sInv, u1p: scriptRecode(tmod(e * sInv, P256_N)), u2p: scriptRecode(tmod(r * sInv, P256_N)) })
}
let fails = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); if (!ok) fails++ }
function validate ({ tx, lock, unlock, sats }) {
  const inp = tx.inputs[0]
  const sp = new Spend({ sourceTXID: inp.sourceTransaction.id('hex'), sourceOutputIndex: inp.sourceOutputIndex, sourceSatoshis: sats, lockingScript: lock, transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs, unlockingScript: unlock, inputSequence: inp.sequence, inputIndex: 0, lockTime: tx.lockTime })
  try { return { ok: sp.validate(), pc: sp.programCounter } } catch (e) { return { ok: false, pc: sp.programCounter, err: e.message.split('\n')[0].replace('Script evaluation error: ', '') } }
}
const fmt = v => `${v.ok ? 'VALID' : 'invalid'} pc=${v.pc}${v.err ? ' ' + v.err : ''}`

const members = [0, 1].map(() => { const priv = p256.utils.randomSecretKey(); return { priv, q: hex(p256.getPublicKey(priv, true)), salt: Uint8Array.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))) } })
const commitments = members.map(m => commitmentFor({ qCompressedHex: m.q, salt: m.salt }))
const lockH = buildLock2Hardened({ commitments }), lock0 = buildLock2({ commitments })
console.log(`hardened lock ${lockH.toBinary().length} B / ${lockH.chunks.length} chunks (gen2: ${lock0.toBinary().length} B / ${lock0.chunks.length} chunks; +${lockH.toBinary().length - lock0.toBinary().length} B)`)
const sats = 120_000
const src = new Transaction(); src.addOutput({ satoshis: sats, lockingScript: lockH }); src.merklePath = MerklePath.fromCoinbaseTxidAndHeight(src.id('hex'), 1755177)

// hardened lock has extra chunks: bakedCommitments() (used by buildUnlock2's guard) still finds the commitments after OP_HASH160
let highSSeen = 0, rounds = 0
for (let i = 0; i < 12; i++) {
  let tx, unlock
  for (let out0 = sats - 700; ; out0--) {
    tx = new Transaction(1, [], [], 0); tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence: 0xffffffff }); tx.addOutput({ satoshis: out0, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
    try { unlock = buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lockH, p256PrivateKey: members[i % 2].priv, salt: members[i % 2].salt }); break } catch (e) { if (!e.code) throw e }
  }
  const g = decodeUnlock2(unlock), e = beToBig(signerDigest(g.preimage))
  // force a high-S signature half of the time to exercise the normaliser (noble emits low-S by default)
  let raw = unlock
  if (i % 2 === 1) { const sH = P256_N - g.s; raw = variant(g, e, { s: sH, sInv: modinv(sH, P256_N) }); highSSeen++ }
  const vRaw = validate({ tx, lock: lockH, unlock: raw, sats })
  const un = lowSNormalize(raw, e)
  const good = decodeUnlock2(un)
  const v = validate({ tx, lock: lockH, unlock: un, sats })
  rounds++
  if (i % 2 === 1) check(`round ${i}: HIGH-S unlock is rejected by the hardened lock; low-S normalised unlock validates`, !vRaw.ok && v.ok, `${fmt(vRaw)} | ${fmt(v)}`)
  else check(`round ${i}: honest low-S unlock validates against the hardened lock`, v.ok, fmt(v))
  if (i === 0) {
    const cases = [
      ['s -> n-s', g => ({ s: P256_N - g.s, sInv: modinv(P256_N - g.s, P256_N) })],
      ['s -> s+n', g => ({ s: g.s + P256_N })],
      ['sInv -> sInv+n', g => ({ sInv: g.sInv + P256_N })],
      ['(s,sInv) -> (-s,-sInv)', g => ({ s: -g.s, sInv: -g.sInv })],
      ['r -> r+p*n', g => ({ r: g.r + P256_P * P256_N })],
      ['(s,sInv) -> (s-n, sInv-n)', g => ({ s: g.s - P256_N, sInv: g.sInv - P256_N })],
      ['r -> r+p', g => ({ r: g.r + P256_P })]
    ]
    for (const [name, mk] of cases) {
      const u = variant(good, e, mk(good))
      if (!u) { console.log(`   ${name}: not constructible (s*sInv mod n != 1)`); continue }
      const vv = validate({ tx, lock: lockH, unlock: u, sats })
      check(`hardened rejects ${name}`, !vv.ok, fmt(vv))
    }
    // the same variants against the ORIGINAL gen2 lock (funding it separately) for side-by-side
    const src0 = new Transaction(); src0.addOutput({ satoshis: sats, lockingScript: lock0 }); src0.merklePath = MerklePath.fromCoinbaseTxidAndHeight(src0.id('hex'), 1755177)
    let tx0, u0
    for (let out0 = sats - 700; ; out0--) {
      tx0 = new Transaction(1, [], [], 0); tx0.addInput({ sourceTransaction: src0, sourceOutputIndex: 0, sequence: 0xffffffff }); tx0.addOutput({ satoshis: out0, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
      try { u0 = buildUnlock2({ tx: tx0, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock0, p256PrivateKey: members[0].priv, salt: members[0].salt }); break } catch (e) { if (!e.code) throw e }
    }
    const g0 = decodeUnlock2(u0), e0 = beToBig(signerDigest(g0.preimage))
    const acc = cases.map(([name, mk]) => { const u = variant(g0, e0, mk(g0)); return `${name}: ${u ? (validate({ tx: tx0, lock: lock0, unlock: u, sats }).ok ? 'VALID' : 'invalid') : 'n/a'}` })
    console.log('   same variants vs ORIGINAL gen2 lock ->', acc.join('; '))
    // canonical-unlock claim: two independent honest builds of the same (tx, key, salt) produce byte-identical unlocks (RFC6979 + low-S)
    const again = lowSNormalize(buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lockH, p256PrivateKey: members[0].priv, salt: members[0].salt }), e)
    check('deterministic: rebuilding the same spend yields a byte-identical unlocking script', again.toHex() === un.toHex())
  }
}
console.log(`rounds=${rounds} (high-S exercised ${highSSeen}x)`)
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`)
process.exitCode = fails ? 1 : 0
