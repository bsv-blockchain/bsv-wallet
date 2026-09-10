// review4-rgen.mjs — the R.x >= n case (author: INFERRED only). Construct a genuine P-256 signature whose R has
// x in [n, p): fix the tx (=> e), pick R with x >= n, pick s, derive Q = (R - u1*G) * u2^-1. The signature
// (r = x mod n, s) is valid for Q (noble verifies it). Then: the unlocker must push the FULL affine x (>= n) and the
// interpreter must accept; pushing x mod n must be rejected.
import { Transaction, Spend, P2PKH, PrivateKey } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { buildLock, P256_N, P256_P, scriptNum } from './gen.mjs'
import { buildUnlockAsync, sighashPreimage, signerDigest, pushTxDerCheck, decodeUnlock, encodeUnlock, fullR } from './unlock.mjs'
const hex = a => Buffer.from(a).toString('hex')
const mod = (a, m) => ((a % m) + m) % m
const modpow = (b, e, m) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n } return r }
const modinv = (a, m) => modpow(a, m - 2n, m)
const be32 = v => Uint8Array.from(Buffer.from(v.toString(16).padStart(64, '0'), 'hex'))
const compact = (r, s) => Uint8Array.from([...be32(r), ...be32(s)])
let fails = 0
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' :: ' + d : ''}`); if (!ok) fails++ }
const n = P256_N, p = P256_P, B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn
console.log(`p - n = 0x${(p - n).toString(16)} (~2^${(p - n).toString(2).length})`)
const sats = 31337
const dest = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
let tx, preimage
for (let out = 31000; ; out--) {
  tx = new Transaction(1, [], [], 0)
  tx.addInput({ sourceTXID: hex(crypto.getRandomValues(new Uint8Array(32))), sourceOutputIndex: 2, sequence: 0xffffffff })
  tx.addOutput({ satoshis: out, lockingScript: dest })
  preimage = sighashPreimage({ tx, inputIndex: 0, sourceSatoshis: sats })
  if (pushTxDerCheck(preimage).ok) break
}
const digest = signerDigest(preimage); const e = BigInt('0x' + hex(digest))
const validate = (lock, unlock) => {
  const sp = new Spend({ sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: 2, sourceSatoshis: sats, lockingScript: lock, transactionVersion: 1, otherInputs: [], outputs: tx.outputs, unlockingScript: unlock, inputSequence: 0xffffffff, inputIndex: 0, lockTime: 0 })
  try { return { ok: sp.validate(), pc: sp.programCounter } } catch (er) { return { ok: false, pc: sp.programCounter, err: er.message.split('\n')[0] } }
}
for (let round = 0; round < 3; round++) {
  console.log(`\n--- round ${round} ---`)
  let x, y, tries = 0
  for (;;) {
    tries++
    x = n + BigInt('0x' + hex(crypto.getRandomValues(new Uint8Array(15))))   // < n + 2^120 < p
    const rhs = mod(x ** 3n - 3n * x + B, p)
    y = modpow(rhs, (p + 1n) / 4n, p)
    if (mod(y * y, p) === rhs) break
  }
  const R = p256.Point.fromAffine({ x, y }); R.assertValidity()
  const rsig = x % n
  check(`R on curve with x >= n (x - n = 0x${(x - n).toString(16)}); r_sig = x mod n = x - n`, x >= n && x < p && rsig === x - n, `${tries} x candidates tried`)
  const s = BigInt('0x' + hex(p256.utils.randomSecretKey())) % n
  const sInv = modinv(s, n), u1 = mod(e * sInv, n), u2 = mod(rsig * sInv, n)
  const Q = R.subtract(p256.Point.BASE.multiply(u1)).multiply(modinv(u2, n)); Q.assertValidity()
  const qHex = hex(Q.toBytes(true))
  check(`noble p256.verify((r_sig, s), digest, Q, lowS:false) == true (genuine signature for Q)`, p256.verify(compact(rsig, s), digest, Q.toBytes(true), { prehash: false, lowS: false }))
  check(`fullR({e, r: r_sig, s, Q}).x == x (full affine x, >= n)`, fullR({ e, r: rsig, s, Q }).x === x)
  const lock = buildLock({ qCompressedHex: qHex, satoshis: sats })
  let unlockA, err
  try { unlockA = await buildUnlockAsync({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, Q: qHex, signDigest: () => compact(rsig, s) }) } catch (er) { err = er.message }
  if (!unlockA) { check('buildUnlockAsync', false, err); continue }
  const f = decodeUnlock(unlockA)
  check(`buildUnlockAsync pushes r == full x (>= n), ${unlockA.chunks[0].data.length}-byte push`, f.r === x && f.r >= n && hex(unlockA.chunks[0].data) === hex(scriptNum(x)))
  const vA = validate(lock, unlockA)
  check(`Spend.validate(lock, unlock with r = full x >= n) === true`, vA.ok, `pc=${vA.pc}${vA.err ? ' ' + vA.err : ''}`)
  const unlockB = encodeUnlock({ r: rsig, s, sInv, hashOutputs: preimage.slice(118, 150), outpoint: preimage.slice(68, 104) })
  const vB = validate(lock, unlockB)
  check(`Spend.validate(lock, unlock with r = x mod n) === false (full x is REQUIRED)`, !vB.ok, `pc=${vB.pc} ${vB.err ?? ''}`)
}
console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS')
process.exitCode = fails ? 1 : 0
