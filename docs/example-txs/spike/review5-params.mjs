// review5-params.mjs — non-default parameters: sequence/lockTime baked & enforced; DER external-signer path
// (low-S and high-S DER, as a YubiKey would return); sighash with ANYONECANPAY (structurally unsupported —
// does buildLock reject it?); version != 1 rejection.
import { Transaction, Spend, P2PKH, PrivateKey, Script } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { buildLock, P256_N } from './gen.mjs'
import { buildUnlock, buildUnlockAsync, bakedParams, sighashPreimage, signerDigest, pushTxDerCheck, decodeUnlock } from './unlock.mjs'
const hex = a => Buffer.from(a).toString('hex')
let fails = 0
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' :: ' + d : ''}`); if (!ok) fails++ }
const validate = ({ tx, sats, lock, unlock, lockTimeOverride }) => {
  const sp = new Spend({ sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: tx.inputs[0].sourceOutputIndex, sourceSatoshis: sats, lockingScript: lock, transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs, unlockingScript: unlock, inputSequence: tx.inputs[0].sequence, inputIndex: 0, lockTime: lockTimeOverride ?? tx.lockTime })
  try { return { ok: sp.validate(), pc: sp.programCounter } } catch (e) { return { ok: false, pc: sp.programCounter, err: e.message.split('\n')[0] } }
}
const mkTx = ({ sats, seq = 0xffffffff, lockTime = 0, nonce = 0 }) => {
  const tx = new Transaction(1, [], [], lockTime)
  tx.addInput({ sourceTXID: hex(crypto.getRandomValues(new Uint8Array(32))), sourceOutputIndex: 0, sequence: seq })
  tx.addOutput({ satoshis: sats - 500, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
  if (nonce) tx.addOutput({ satoshis: 0, lockingScript: Script.fromASM('OP_RETURN ' + hex([nonce])) })
  return tx
}
const signWithRetry = (args, mk) => { for (let t = 0; t < 30; t++) { const tx = mk(t); try { return { tx, unlock: buildUnlock({ ...args, tx }) } } catch (e) { if (!e.code) throw e } } throw new Error('screen never passed') }
// (a) non-default sequence + lockTime
{
  const priv = p256.utils.randomSecretKey(), qHex = hex(p256.getPublicKey(priv, true)), sats = 8000
  const lock = buildLock({ qCompressedHex: qHex, satoshis: sats, sequence: 0xfffffffe, lockTime: 700000 })
  const b = bakedParams(lock)
  check('bakedParams reads back sequence=fffffffe lockTime=700000', b.sequence === 0xfffffffe && b.lockTime === 700000 && b.satoshis === sats, JSON.stringify(b))
  const { tx, unlock } = signWithRetry({ inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv }, t => mkTx({ sats, seq: 0xfffffffe, lockTime: 700000, nonce: t }))
  const v = validate({ tx, sats, lock, unlock })
  check('spend with matching seq/lockTime validates', v.ok, `pc=${v.pc} ${v.err ?? ''}`)
  const v2 = validate({ tx, sats, lock, unlock, lockTimeOverride: 700001 })
  check('same unlock evaluated with lockTime 700001 fails (baked lockTime enforced by OP_PUSH_TX)', !v2.ok, `pc=${v2.pc} ${v2.err ?? ''}`)
  let threw = ''
  try { buildUnlock({ tx: mkTx({ sats, seq: 0xffffffff, lockTime: 700000 }), inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv }) } catch (e) { threw = e.message }
  check('buildUnlock rejects a tx whose input sequence != baked', /sequence/.test(threw), threw)
  threw = ''
  try { buildUnlock({ tx: mkTx({ sats, seq: 0xfffffffe, lockTime: 0 }), inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv }) } catch (e) { threw = e.message }
  check('buildUnlock rejects a tx whose lockTime != baked', /lockTime/.test(threw), threw)
}
// (b) DER external-signer path (YubiKey shape): low-S DER and high-S DER
{
  const priv = p256.utils.randomSecretKey(), qHex = hex(p256.getPublicKey(priv, true)), sats = 9000
  const lock = buildLock({ qCompressedHex: qHex, satoshis: sats })
  let tx; for (let t = 0; ; t++) { tx = mkTx({ sats, nonce: t }); if (pushTxDerCheck(sighashPreimage({ tx, inputIndex: 0, sourceSatoshis: sats })).ok) break }
  const digest = signerDigest(sighashPreimage({ tx, inputIndex: 0, sourceSatoshis: sats }))
  const sig = p256.Signature.fromBytes(p256.sign(digest, priv, { prehash: false }), 'compact')
  const derLow = sig.toBytes('der'), derHigh = new p256.Signature(sig.r, P256_N - sig.s).toBytes('der')
  for (const [label, der, sExp] of [['low-S DER', derLow, sig.s], ['high-S DER', derHigh, P256_N - sig.s]]) {
    let unlock, err
    try { unlock = await buildUnlockAsync({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, Q: qHex, signDigest: () => der }) } catch (e) { err = e.message }
    if (!unlock) { check(`${label} (${der.length} B) via buildUnlockAsync`, false, err); continue }
    const v = validate({ tx, sats, lock, unlock }), f = decodeUnlock(unlock)
    check(`${label} (${der.length} B) via buildUnlockAsync: s decoded == expected, validate`, v.ok && f.s === sExp, `s push ${unlock.chunks[1].data.length}B pc=${v.pc} ${v.err ?? ''}`)
  }
}
// (c) sighash 0xc1 (ALL|FORKID|ANYONECANPAY): hashPrevouts/hashSequence would be zeros, but the script bakes hash256(outpoint)/hash256(seq)
{
  const priv = p256.utils.randomSecretKey(), qHex = hex(p256.getPublicKey(priv, true)), sats = 6000
  let lock, rejected = ''
  try { lock = buildLock({ qCompressedHex: qHex, satoshis: sats, sighash: 0xc1 }) } catch (e) { rejected = e.message }
  if (!lock) console.log(`INFO buildLock rejects sighash 0xc1: ${rejected}`)
  else {
    const b = bakedParams(lock)
    const { tx, unlock } = signWithRetry({ inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv }, t => mkTx({ sats, nonce: t }))
    const v = validate({ tx, sats, lock, unlock })
    console.log(`INFO sighash 0xc1: buildLock accepted (baked sighash 0x${b.sighash.toString(16)}), buildUnlock produced a script, Spend.validate = ${v.ok} pc=${v.pc} ${v.err ?? ''}  <- structurally unsupported flag is not rejected up front`)
  }
}
// (d) version != 1 rejected
{
  let threw = ''
  try { buildLock({ qCompressedHex: hex(p256.getPublicKey(p256.utils.randomSecretKey(), true)), satoshis: 1000, version: 2 }) } catch (e) { threw = e.message }
  check('buildLock rejects version 2', /version/.test(threw), threw.slice(0, 80))
}
console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS')
process.exitCode = fails ? 1 : 0
