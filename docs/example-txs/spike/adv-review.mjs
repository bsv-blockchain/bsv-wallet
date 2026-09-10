// adv-review.mjs — adversarial review of gen2.mjs / unlock2.mjs against the @bsv/sdk Spend interpreter.
// Sections: A commitment coverage/canonicalisation, B aliasing, C malleability (v1 and v2), D sighash flags,
// E OP_PUSH_TX dummy key, F sequence/locktime/input-index independence, G resource limits, H post-spend privacy.
// PASS = observed behaviour matches the stated expectation. Lines tagged MALLEABLE are variants that VALIDATE.
import { Spend, Transaction, P2PKH, PrivateKey, MerklePath, UnlockingScript, LockingScript, Script, Hash, OP } from '@bsv/sdk'
import { performance } from 'perf_hooks'
import { p256 } from '@noble/curves/nist.js'
import { buildLock2, commitmentFor, canonicalTableBytes, bakedCommitments, recode, le33, layout2, encNum, pushData, scriptNum, combTable, P256_N, P256_P, SECP_N, SECP_GX } from './gen2.mjs'
import { combTableScalar } from './gen.mjs'
import { buildUnlock2, encodeUnlock2, decodeUnlock2, r1CombUnlock2Template } from './unlock2.mjs'
import { sighashPreimage, signerDigest, pushTxDerCheck, fullR } from './unlock.mjs'
import { readFileSync } from 'fs'

const hex = a => Buffer.from(a).toString('hex')
const bytesOf = h => [...Buffer.from(h, 'hex')]
const mod = (a, m) => ((a % m) + m) % m
const tmod = (a, m) => a % m                         // BSV OP_MOD: truncated, sign of dividend (SDK BigNumber._computeMod)
const tdiv = (a, b) => a / b                         // BSV OP_DIV: truncated toward zero
const modpow = (b, e, m) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n } return r }
const modinv = (a, m) => modpow(a, m - 2n, m)
const beToBig = b => BigInt('0x' + (hex(b) || '0'))
const RECODE_C = (1n << 258n) - 1n
const HALF_N = (P256_N - 1n) / 2n

let fails = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); if (!ok) fails++ }
const section = t => console.log(`\n── ${t} ──`)

// ───────── harness ─────────
function mkSpend ({ tx, inputIndex, sourceSatoshis, lockingScript, unlockingScript }) {
  const inp = tx.inputs[inputIndex]
  return new Spend({
    sourceTXID: inp.sourceTXID ?? inp.sourceTransaction.id('hex'), sourceOutputIndex: inp.sourceOutputIndex, sourceSatoshis: Number(sourceSatoshis),
    lockingScript, transactionVersion: tx.version, otherInputs: tx.inputs.filter((_, i) => i !== inputIndex), outputs: tx.outputs,
    unlockingScript, inputSequence: inp.sequence ?? 0xffffffff, inputIndex, lockTime: tx.lockTime
  })
}
function validate (args) {
  const sp = mkSpend(args)
  try { return { ok: sp.validate(), pc: sp.programCounter } } catch (e) { return { ok: false, pc: sp.programCounter, err: e.message.split('\n')[0] } }
}
function regionOf (lock, pc) { const r = layout2(lock).regions.find(r => pc >= r.chunks[0] && pc <= r.chunks[1]); return r ? r.name.split(' ')[0] : (pc >= lock.chunks.length ? 'END' : '?') }
const fmt = v => `${v.ok ? 'VALID' : 'invalid'} pc=${v.pc}${v.err ? ' ' + v.err.replace('Script evaluation error: ', '') : ''}`
function fundingTx (lock, sats, vout = 0) {
  const src = new Transaction()
  for (let k = 0; k < vout; k++) src.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
  src.addOutput({ satoshis: sats, lockingScript: lock })
  src.merklePath = MerklePath.fromCoinbaseTxidAndHeight(src.id('hex'), 1755177)
  return src
}
const P2PKH_OUT = () => new P2PKH().lock(PrivateKey.fromRandom().toAddress())
const randSalt = () => Uint8Array.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)))
/** one vault input, retries on the PUSH_TX screen by bumping the change */
function buildSpend ({ src, vout, sats, priv, salt, lock }, { version = 1, sequence = 0xffffffff, lockTime = 0, nOut = 1 } = {}) {
  for (let tries = 0, out0 = sats - 500; tries < 60; tries++, out0--) {
    const tx = new Transaction(version, [], [], lockTime)
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: vout, sequence })
    tx.addOutput({ satoshis: out0, lockingScript: P2PKH_OUT() })
    if (nOut >= 2) tx.addOutput({ satoshis: 100, lockingScript: Script.fromASM('OP_RETURN 6e6f6e6365') })
    try {
      const unlock = buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv, salt })
      tx.inputs[0].unlockingScript = unlock
      return { tx, unlock }
    } catch (e) { if (e.code !== 'PUSH_TX_PEEL_NONMINIMAL' && e.code !== 'PUSH_TX_S_ZERO') throw e }
  }
  throw new Error('PUSH_TX screen failed 60 times')
}
function stepTo (sp, pc) { let n = 0; while (!(sp.context === 'LockingScript' && sp.programCounter === pc)) { sp.step(); if (++n > 1e6) throw new Error('stepTo overflow') } return sp }

// script-exact scalar arithmetic (what H1/H2 compute for arbitrary pushed r, s, sInv — including negative / out-of-range values)
const scriptRecode = u => { let v = u; if (tmod(v, 2n) === 0n) v += P256_N; return tdiv(v + RECODE_C, 2n) }
function scriptScalars ({ r, s, sInv, e }) {
  if (tmod(s * sInv, P256_N) !== 1n) return null
  const u1 = tmod(e * sInv, P256_N), u2 = tmod(r * sInv, P256_N)
  return { u1p: scriptRecode(u1), u2p: scriptRecode(u2) }
}
// sanity: script-exact recode agrees with gen2.recode on honest (non-negative, < n) inputs
for (let i = 0; i < 1000; i++) { const u = beToBig(randSalt()) % P256_N; if (scriptRecode(u) !== recode(u)) throw new Error('scriptRecode != recode') }

/** re-encode an honest decoded unlock with substituted r/s/sInv (u1', u2' recomputed exactly as the script will) */
function variant (good, e, { r = good.r, s = good.s, sInv = good.sInv, table = good.table, salt = good.salt, preimage = good.preimage } = {}) {
  const sc = scriptScalars({ r, s, sInv, e })
  if (!sc) return null
  return encodeUnlock2({ r, u2p: sc.u2p, u1p: sc.u1p, table, salt, s, sInv, preimage })
}
/** hand-built unlock from an arbitrary preimage (any scope) signed by priv — for the sighash-flag tests */
function unlockForPreimage ({ preimage, priv, salt }) {
  const Q = p256.Point.fromBytes(p256.getPublicKey(priv, true))
  const digest = signerDigest(preimage), e = beToBig(digest)
  const sig = p256.Signature.fromBytes(p256.sign(digest, priv, { prehash: false }), 'compact')
  const { x: Rx, sInv } = fullR({ e, r: sig.r, s: sig.s, Q })
  return encodeUnlock2({ r: Rx, u2p: recode(mod(Rx * sInv, P256_N)), u1p: recode(mod(e * sInv, P256_N)), table: combTable(Q), salt, s: sig.s, sInv, preimage })
}

// ───────── fixture set: N=2 lock, member b spends ─────────
const A = { priv: p256.utils.randomSecretKey(), salt: randSalt() }; A.q = hex(p256.getPublicKey(A.priv, true))
const B = { priv: p256.utils.randomSecretKey(), salt: randSalt() }; B.q = hex(p256.getPublicKey(B.priv, true))
const LOCK = buildLock2({ commitments: [commitmentFor({ qCompressedHex: A.q, salt: A.salt }), commitmentFor({ qCompressedHex: B.q, salt: B.salt })] })
const SATS = 250_000
const SRC = fundingTx(LOCK, SATS, 1)
const L2 = layout2(LOCK)
const H160_PC = L2.regions.find(r => r.name.startsWith('H4 OP_HASH160')).chunks[0]
const TAIL_PC = L2.regions.find(r => r.name.startsWith('tail')).chunks[0]

const { tx: TX, unlock: UN } = buildSpend({ src: SRC, vout: 1, sats: SATS, priv: B.priv, salt: B.salt, lock: LOCK }, { nOut: 2 })
const GOOD = decodeUnlock2(UN)
const E = beToBig(signerDigest(GOOD.preimage))
const V0 = validate({ tx: TX, inputIndex: 0, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: UN })
check('control: honest v1 spend validates', V0.ok, fmt(V0))

// ═════════════ A. commitment coverage & canonical serialisation ═════════════
section('A. commitment covers salt + all 64 coordinates, canonical fixed-width serialisation')
{
  const sp = stepTo(mkSpend({ tx: TX, inputIndex: 0, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: UN }), H160_PC)
  const acc = sp.stack.at(-1)
  const expect = canonicalTableBytes({ qCompressedHex: B.q, salt: B.salt })
  check('A1 item hashed by OP_HASH160 == canonicalTableBytes(Q_b, salt_b) (byte-exact)', hex(acc) === hex(expect), `${acc.length} B`)
  check('A2 hashed item is 32 + 64*33 = 2144 bytes; first 32 bytes == salt', acc.length === 2144 && hex(acc.slice(0, 32)) === hex(B.salt))
  // decode the 64 fixed-width slots back to values and compare to the pushed table (injectivity of the serialisation)
  const dec = []; for (let i = 0; i < 64; i++) { const b = acc.slice(32 + 33 * i, 32 + 33 * (i + 1)); const neg = b[32] & 0x80; const m = [...b]; m[32] &= 0x7f; let v = 0n; for (let k = 32; k >= 0; k--) v = (v << 8n) | BigInt(m[k]); dec.push(neg ? -v : v) }
  const pushed = GOOD.table.flatMap(p => [p.x, p.y])
  check('A3 the 64 slots decode back to exactly the pushed coordinate VALUES (x0,y0,..,x31,y31 order)', dec.every((v, i) => v === pushed[i]))
  check('A4 the H160 input depends on every coordinate: 64 distinct stack items were PICKed (depths 64..1)', L2.regions.find(r => r.name.startsWith('H4 canonical')).chunks[1] - L2.regions.find(r => r.name.startsWith('H4 canonical')).chunks[0] + 1 === 64 * 5)
  // le33 vs interpreter NUM2BIN for edge widths: 0, 1, <2^248 (31B), [2^248,2^255) (32B), >=2^255 (33B)
  const edge = [0n, 1n, 255n, (1n << 247n) + 5n, (1n << 248n) - 1n, (1n << 248n), (1n << 255n) - 1n, (1n << 255n), P256_P - 1n]
  let allEq = true
  for (const v of edge) {
    const lk = LockingScript.fromBinary([1, 33, OP.OP_NUM2BIN])
    const un = UnlockingScript.fromBinary(encNum(v))
    const sp2 = new Spend({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, sourceSatoshis: 1, lockingScript: lk, transactionVersion: 1, otherInputs: [], outputs: [], unlockingScript: un, inputSequence: 0xffffffff, inputIndex: 0, lockTime: 0 })
    while (!(sp2.context === 'LockingScript' && sp2.programCounter >= 2)) sp2.step()
    if (hex(sp2.stack.at(-1)) !== hex(le33(v))) { allEq = false; console.log('   le33 mismatch for', v.toString(16), hex(sp2.stack.at(-1)), hex(le33(v))) }
  }
  check('A5 gen2.le33(v) == interpreter OP_NUM2BIN(v, 33) for 0, 1, 31/32/33-byte edge values', allEq)
  // salt length is NOT enforced in-script: a lock committed to a 5-byte salt spends with a 5-byte salt (informational)
  const salt5 = [1, 2, 3, 4, 5]
  const tab = combTable(p256.Point.fromHex(B.q))
  const c5 = hex(Hash.hash160([...salt5, ...tab.flatMap(p => [...le33(p.x), ...le33(p.y)])]))
  const lock5 = buildLock2({ commitments: [c5] })
  const src5 = fundingTx(lock5, SATS, 0)
  let ok5 = null
  for (let out0 = SATS - 500; ; out0--) {
    const tx5 = new Transaction(1, [], [], 0); tx5.addInput({ sourceTransaction: src5, sourceOutputIndex: 0, sequence: 0xffffffff }); tx5.addOutput({ satoshis: out0, lockingScript: P2PKH_OUT() })
    const pre = sighashPreimage({ tx: tx5, inputIndex: 0, sourceSatoshis: SATS, scope: 0x41 })
    if (!pushTxDerCheck(pre).ok) continue
    const digest = signerDigest(pre), e = beToBig(digest)
    const sig = p256.Signature.fromBytes(p256.sign(digest, B.priv, { prehash: false }), 'compact')
    const { x: Rx, sInv } = fullR({ e, r: sig.r, s: sig.s, Q: p256.Point.fromHex(B.q) })
    const b = [...encNum(Rx), ...encNum(recode(mod(Rx * sInv, P256_N))), ...encNum(recode(mod(e * sInv, P256_N)))]
    for (const { x, y } of tab) b.push(...encNum(x), ...encNum(y))
    b.push(...pushData(salt5), ...encNum(sig.s), ...encNum(sInv), ...pushData(pre))
    ok5 = validate({ tx: tx5, inputIndex: 0, sourceSatoshis: SATS, lockingScript: lock5, unlockingScript: UnlockingScript.fromBinary(b) })
    break
  }
  check('A6 (informational) salt length is not enforced in-script: 5-byte salt spends when committed as such', ok5.ok, fmt(ok5))
  // wrong-length salt against a 32-byte-salt commitment fails
  const bad =[...encNum(GOOD.r), ...encNum(GOOD.u2p), ...encNum(GOOD.u1p)]; for (const { x, y } of GOOD.table) bad.push(...encNum(x), ...encNum(y)); bad.push(...pushData([...GOOD.salt, 0]), ...encNum(GOOD.s), ...encNum(GOOD.sInv), ...pushData(GOOD.preimage))
  const vb = validate({ tx: TX, inputIndex: 0, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: UnlockingScript.fromBinary(bad) })
  check('A7 salt || 0x00 (33 bytes) against the 32-byte-salt commitment fails at H5', !vb.ok && regionOf(LOCK, vb.pc) === 'H5', fmt(vb))
}

// ═════════════ B. aliasing attempts on the table ═════════════
section('B. aliasing: can a different push sequence reproduce the committed hash?')
{
  // B1: coordinate value + p (same field element, same point) -> commitment is over INTEGERS, must fail at H5
  const tabP = GOOD.table.map((p, j) => j === 3 ? { x: p.x + P256_P, y: p.y } : p)
  const vB1 = validate({ tx: TX, inputIndex: 0, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: encodeUnlock2({ ...GOOD, table: tabP }) })
  check('B1 coordinate x3 -> x3 + p (same field element) fails at H5 (commitment is over integer values, not field elements)', !vB1.ok && regionOf(LOCK, vB1.pc) === 'H5', fmt(vB1))
  // B2: coordinate value - p (negative, same field element) -> fails at H5
  const tabN = GOOD.table.map((p, j) => j === 3 ? { x: p.x - P256_P, y: p.y } : p)
  const vB2 = validate({ tx: TX, inputIndex: 0, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: encodeUnlock2({ ...GOOD, table: tabN }) })
  check('B2 coordinate x3 -> x3 - p (negative) fails at H5', !vB2.ok && regionOf(LOCK, vB2.pc) === 'H5', fmt(vB2))
  // B3: non-minimal push of a coordinate (append 0x00 to a 32-byte value that has top bit clear -> 33 bytes, same value)
  const chunks = UN.chunks.map(c => ({ ...c, data: c.data ? [...c.data] : c.data }))
  const idx = chunks.findIndex((c, i) => i >= 3 && i <= 66 && c.data.length === 32)
  chunks[idx] = { op: 33, data: [...chunks[idx].data, 0x00] }
  const vB3 = validate({ tx: TX, inputIndex: 0, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: new UnlockingScript(chunks) })
  check(`B3 v1: non-minimal (zero-padded) coordinate push #${idx} rejected by MINIMALDATA — note it passes H4/H5 (NUM2BIN canonicalises the VALUE) and dies in the comb loop`, !vB3.ok && vB3.pc > H160_PC && /minimal/.test(vB3.err ?? ''), `${fmt(vB3)} [${regionOf(LOCK, vB3.pc)}]`)
  const sp = mkSpend({ tx: TX, inputIndex: 0, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: new UnlockingScript(chunks) })
  stepTo(sp, H160_PC)
  check('B3b the padded push hashes to the SAME canonical bytes (no aliasing: value semantics)', hex(sp.stack.at(-1)) === hex(canonicalTableBytes({ qCompressedHex: B.q, salt: B.salt })))
  // B4: split/merge attack on concatenation is impossible (fixed width) — demonstrate: shifting one byte between adjacent coords changes the hash
  // true raw-concat alias: move x_j's top magnitude byte to the front of y_j. scriptNum(x')||scriptNum(y') == scriptNum(x_j)||scriptNum(y_j)
  // whenever x_j's top two magnitude bytes have bit 7 clear and y_j < 2^255 (so y' stays < 2^263 and NUM2BIN 33 still works).
  const j4 = GOOD.table.findIndex(p => { const m = scriptNum(p.x); return m.length >= 2 && (m[m.length - 1] & 0x80) === 0 && (m[m.length - 2] & 0x80) === 0 && p.y < (1n << 255n) })
  if (j4 >= 0) {
    const xj = GOOD.table[j4].x, yj = GOOD.table[j4].y, L = scriptNum(xj).length
    const xp = xj % (1n << BigInt(8 * (L - 1))), yp = (yj << 8n) | (xj >> BigInt(8 * (L - 1)))
    const alias = hex([...scriptNum(xp), ...scriptNum(yp)]) === hex([...scriptNum(xj), ...scriptNum(yj)])
    const t4 = GOOD.table.map((p, j) => j === j4 ? { x: xp, y: yp } : p)
    const vB4 = validate({ tx: TX, inputIndex: 0, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: encodeUnlock2({ ...GOOD, table: t4 }) })
    check(`B4 entry ${j4}: (x',y') whose raw minimal-scriptnum concatenation is BYTE-IDENTICAL to (x,y) [alias=${alias}] fails at H5 under the fixed-width serialisation`, alias && !vB4.ok && regionOf(LOCK, vB4.pc) === 'H5', fmt(vB4))
  } else console.log('   (B4 skipped: no table entry with the required byte pattern)')
  // B5: a coordinate >= 2^263 (34-byte scriptnum) cannot be canonicalised -> NUM2BIN error (not a bypass)
  const t5 = GOOD.table.map((p, j) => j === 0 ? { x: p.x + (1n << 264n), y: p.y } : p)
  const vB5 = validate({ tx: TX, inputIndex: 0, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: encodeUnlock2({ ...GOOD, table: t5 }) })
  check('B5 coordinate >= 2^263 fails inside H4 (NUM2BIN 33 too small)', !vB5.ok && regionOf(LOCK, vB5.pc) === 'H4', fmt(vB5))
}

// ═════════════ C. malleability (third party rewrites the unlocking script of a valid spend) ═════════════
section('C. malleability, version-1 spend (SDK: MINIMALDATA/CLEANSTACK/SIGPUSHONLY enforced)')
const malleable = []
function tryVariant (name, unlock, { tx = TX, lock = LOCK, expectValid }) {
  if (!unlock) { check(`${name} -> not constructible: s*sInv mod n != 1 under truncated OP_MOD (expected ${expectValid ? 'VALID' : 'invalid'})`, !expectValid); return }
  const v = validate({ tx, inputIndex: 0, sourceSatoshis: SATS, lockingScript: lock, unlockingScript: unlock })
  const tag = v.ok ? 'MALLEABLE' : 'rejected'
  if (v.ok) malleable.push(name)
  check(`${name} -> ${tag} (expected ${expectValid ? 'VALID' : 'invalid'})`, v.ok === expectValid, `${fmt(v)} [${regionOf(lock, v.pc)}] unlock=${unlock.toBinary().length}B`)
  return v
}
{
  const { r, s, sInv } = GOOD
  const sF = P256_N - s
  tryVariant('C1 ECDSA flip s -> n-s (sInv, u1\', u2\' recomputed)', variant(GOOD, E, { s: sF, sInv: modinv(sF, P256_N) }), { expectValid: true })
  tryVariant('C2 s -> s + n', variant(GOOD, E, { s: s + P256_N }), { expectValid: true })
  tryVariant('C3 sInv -> sInv + n', variant(GOOD, E, { sInv: sInv + P256_N }), { expectValid: true })
  tryVariant('C4 (s, sInv) -> (-s, -sInv)', variant(GOOD, E, { s: -s, sInv: -sInv }), { expectValid: true })
  tryVariant('C5 r -> r + p*n (65-byte scriptnum; r only used mod n and mod p)', variant(GOOD, E, { r: r + P256_P * P256_N }), { expectValid: true })
  tryVariant('C6 r -> r + p', variant(GOOD, E, { r: r + P256_P }), { expectValid: false })
  tryVariant('C7 r -> r + n', variant(GOOD, E, { r: r + P256_N }), { expectValid: false })
  tryVariant('C8 r -> -r', variant(GOOD, E, { r: -r }), { expectValid: false })
  tryVariant('C9 (s, sInv) -> (s - n, sInv - n)', variant(GOOD, E, { s: s - P256_N, sInv: sInv - P256_N }), { expectValid: tmod((s - P256_N) * (sInv - P256_N), P256_N) === 1n && (s - P256_N) * (sInv - P256_N) > 0n })
  tryVariant('C10 sInv -> sInv - n (negative) with s unchanged', variant(GOOD, E, { sInv: sInv - P256_N }), { expectValid: false })
  // structural variants
  const raw = UN.toBinary()
  tryVariant('C11 extra push (OP_1) at the bottom of the unlock', UnlockingScript.fromBinary([OP.OP_1, ...raw]), { expectValid: false })
  const ch = UN.chunks.map(c => ({ ...c })); const i32 = ch.findIndex((c, i) => i >= 3 && c.data?.length === 32)
  ch[i32] = { op: OP.OP_PUSHDATA1, data: ch[i32].data }
  tryVariant('C12 PUSHDATA1 opcode for a 32-byte coordinate push (same bytes)', new UnlockingScript(ch), { expectValid: false })
  tryVariant('C13 trailing OP_NOP in the unlocking script', UnlockingScript.fromBinary([...raw, OP.OP_NOP]), { expectValid: false })
  const chP = UN.chunks.map(c => ({ ...c })); chP[i32] = { op: 33, data: [...chP[i32].data, 0] }
  tryVariant('C14 zero-padded (non-minimal) coordinate', new UnlockingScript(chP), { expectValid: false })
  const chU = UN.chunks.map(c => ({ ...c })); chU[1] = { op: 34, data: [...chU[1].data, 0] }
  tryVariant('C15 zero-padded (non-minimal) u2\' push', new UnlockingScript(chU), { expectValid: false })
}
section('C. malleability, version-2 spend (SDK isRelaxed(): Chronicle model drops MINIMALDATA/CLEANSTACK/SIGPUSHONLY/LOW_S)')
{
  const { tx: tx2, unlock: un2 } = buildSpend({ src: SRC, vout: 1, sats: SATS, priv: B.priv, salt: B.salt, lock: LOCK }, { version: 2, nOut: 1 })
  const g2 = decodeUnlock2(un2)
  const v2 = validate({ tx: tx2, inputIndex: 0, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: un2 })
  check('control: honest v2 spend validates', v2.ok, fmt(v2))
  const raw = un2.toBinary()
  tryVariant('C16 v2: extra push (OP_1) at the bottom of the unlock', UnlockingScript.fromBinary([OP.OP_1, ...raw]), { tx: tx2, expectValid: true })
  const ch = un2.chunks.map(c => ({ ...c })); const i32 = ch.findIndex((c, i) => i >= 3 && c.data?.length === 32)
  ch[i32] = { op: OP.OP_PUSHDATA1, data: ch[i32].data }
  tryVariant('C17 v2: PUSHDATA1 opcode for a 32-byte coordinate push', new UnlockingScript(ch), { tx: tx2, expectValid: true })
  tryVariant('C18 v2: trailing OP_NOP', UnlockingScript.fromBinary([...raw, OP.OP_NOP]), { tx: tx2, expectValid: true })
  const chP = un2.chunks.map(c => ({ ...c })); chP[i32] = { op: 33, data: [...chP[i32].data, 0] }
  tryVariant('C19 v2: zero-padded coordinate (still same commitment)', new UnlockingScript(chP), { tx: tx2, expectValid: true })
  const chU = un2.chunks.map(c => ({ ...c })); chU[1] = { op: 34, data: [...chU[1].data, 0] }
  tryVariant('C20 v2: zero-padded u2\'', new UnlockingScript(chU), { tx: tx2, expectValid: true })
  // v2 also removes the 2^-16 PUSH_TX peel screen (MINIMALDATA off) — demonstrate with a forced peel-nonminimal preimage if one turns up cheaply
  let found = null
  for (let out0 = SATS - 1000, tries = 0; tries < 400_000 && !found; tries++, out0--) {
    const t = new Transaction(2, [], [], 0); t.addInput({ sourceTransaction: SRC, sourceOutputIndex: 1, sequence: 0xffffffff }); t.addOutput({ satoshis: out0, lockingScript: Script.fromASM('OP_1') })
    const pre = sighashPreimage({ tx: t, inputIndex: 0, sourceSatoshis: SATS, scope: 0x41 })
    if (!pushTxDerCheck(pre).ok) found = { t, pre, tries }
  }
  if (found) {
    const u = unlockForPreimage({ preimage: found.pre, priv: B.priv, salt: B.salt })
    const vv2 = validate({ tx: found.t, inputIndex: 0, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: u })
    const t1 = new Transaction(1, [], [], 0); t1.addInput({ sourceTransaction: SRC, sourceOutputIndex: 1, sequence: 0xffffffff }); t1.addOutput({ satoshis: found.t.outputs[0].satoshis, lockingScript: found.t.outputs[0].lockingScript })
    const pre1 = sighashPreimage({ tx: t1, inputIndex: 0, sourceSatoshis: SATS, scope: 0x41 })
    console.log(`   (peel-nonminimal preimage found after ${found.tries} tries; v1 version of the same tx: screen ok=${pushTxDerCheck(pre1).ok})`)
    check('C21 v2: a PUSH_TX peel-nonminimal preimage (rejected under v1 MINIMALDATA) VALIDATES under v2', vv2.ok, fmt(vv2))
  } else console.log('   (no peel-nonminimal preimage found in 400k tries; skipping C21)')
}

// ═════════════ D. sighash flags ═════════════
section('D. can the signer choose other sighash flags via the pushed preimage?')
{
  for (const scope of [0x42, 0x43, 0xc1, 0xc2, 0x01]) {
    let pre
    try { pre = sighashPreimage({ tx: TX, inputIndex: 0, sourceSatoshis: SATS, scope }) } catch (e) { check(`D scope 0x${scope.toString(16)}: preimage`, false, e.message); continue }
    const u = unlockForPreimage({ preimage: pre, priv: B.priv, salt: B.salt })
    const v = validate({ tx: TX, inputIndex: 0, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: u })
    check(`D scope 0x${scope.toString(16)} preimage (valid P-256 sig over it) is rejected — P-256 leg passes, CHECKSIG(0x41) false`, !v.ok && v.pc >= LOCK.chunks.length - 1, `${fmt(v)} preimageLen=${pre.length}`)
  }
  const sighashChunk = LOCK.chunks[TAIL_PC + 28 + 68 + 1]
  check('D baked sighash byte appended to the OP_PUSH_TX signature is 0x41', hex(sighashChunk.data ?? []) === '41')
  let threw = null; try { buildLock2({ commitments: [commitmentFor({ qCompressedHex: A.q, salt: A.salt })], sighash: 0xc1 }) } catch (e) { threw = e.message }
  check('D buildLock2 refuses sighash != 0x41', !!threw, threw ?? 'no throw')
}

// ═════════════ E. OP_PUSH_TX dummy key ═════════════
section('E. OP_PUSH_TX dummy key gives no spending power')
{
  const d = mod((1n << 248n) * modinv(SECP_GX, SECP_N), SECP_N)
  const pub = new PrivateKey(d.toString(16).padStart(64, '0'), 16).toPublicKey().encode(true)
  const pubChunk = LOCK.chunks[LOCK.chunks.length - 3]
  check('E1 baked CHECKSIG pubkey == d*G with d = 2^248 * Gx^-1 mod n_k1 (private key is public by construction)', hex(pubChunk.data) === hex(pub) && LOCK.chunks.at(-2).op === OP.OP_CODESEPARATOR && LOCK.chunks.at(-1).op === OP.OP_CHECKSIG)
  // structural: every VERIFY-family op in the lock executes unconditionally (IF-nesting depth 0), so CHECKSIG is only reachable after the P-256 verification
  let depth = 0, maxDepth = 0; const verifyDepths = []; let branchedVerify = 0
  for (const c of LOCK.chunks) {
    if (c.op === OP.OP_IF || c.op === OP.OP_NOTIF) { depth++; maxDepth = Math.max(maxDepth, depth) } else if (c.op === OP.OP_ENDIF) depth--
    if ([OP.OP_VERIFY, OP.OP_EQUALVERIFY, OP.OP_NUMEQUALVERIFY, OP.OP_CHECKSIGVERIFY].includes(c.op)) { verifyDepths.push(depth); if (depth > 0) branchedVerify++ }
  }
  check(`E2 all ${verifyDepths.length} VERIFY-family ops sit at IF-depth 0 (unconditional); no branch skips a check; max IF nesting ${maxDepth}`, branchedVerify === 0 && depth === 0)
  // the PUSH_TX region reads nothing from the main stack below the preimage: count stack-addressing ops in it
  const pushTxChunks = LOCK.chunks.slice(TAIL_PC + 28 + 68)
  const addr = pushTxChunks.filter(c => [OP.OP_PICK, OP.OP_ROLL, OP.OP_DEPTH, OP.OP_2OVER, OP.OP_2ROT, OP.OP_2SWAP, OP.OP_ROT].includes(c.op)).length
  const fromAlt = pushTxChunks.filter(c => c.op === OP.OP_FROMALTSTACK).length
  check(`E3 PUSH_TX region (${pushTxChunks.length} chunks) has ${addr} deep-stack ops and ${fromAlt} FROMALTSTACK (preimage, sighash byte): the k=1 signature is a pure function of the pushed preimage`, addr === 0 && fromAlt === 2)
  // execution: correct preimage/table/salt, garbage P-256 fields -> dies in H1 long before CHECKSIG
  const garbage = encodeUnlock2({ ...GOOD, r: 12345n, s: 777n, sInv: 999n, u1p: 1n, u2p: 1n })
  const vg = validate({ tx: TX, inputIndex: 0, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: garbage })
  check('E4 correct preimage + garbage P-256 fields fails in H1 (s*sInv != 1), never reaching the tail', !vg.ok && regionOf(LOCK, vg.pc) === 'H1', fmt(vg))
  // consistent (s, sInv) but no knowledge of the key: random r -> u1', u2' consistent -> fails at the r check in the tail
  const sR = beToBig(randSalt()) % P256_N, rR = beToBig(randSalt()) % P256_P
  const vr = validate({ tx: TX, inputIndex: 0, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: variant(GOOD, E, { r: rR, s: sR, sInv: modinv(sR, P256_N) }) })
  check('E5 consistent (r, s, sInv, u1\', u2\') without the key fails at the tail r-check (X != r*Z^2), before CHECKSIG', !vr.ok && vr.pc >= TAIL_PC && vr.pc < TAIL_PC + 28, fmt(vr))
}

// ═════════════ F. sequence / locktime / input index ═════════════
section('F. nothing depends on input index, sequence or locktime (all live only in the signed preimage)')
{
  // mixed tx: input 0 = P2PKH (secp256k1), input 1 = vault with sequence 0 and a locktime
  const kp = PrivateKey.fromRandom()
  const srcP = new Transaction(); srcP.addOutput({ satoshis: 5000, lockingScript: new P2PKH().lock(kp.toAddress()) }); srcP.merklePath = MerklePath.fromCoinbaseTxidAndHeight(srcP.id('hex'), 1755177)
  let okMixed = false, err = null, txM
  for (let tries = 0, out0 = SATS + 5000 - 1500; tries < 40 && !okMixed; tries++, out0--) {
    txM = new Transaction(1, [], [], 500_000)
    txM.addInput({ sourceTransaction: srcP, sourceOutputIndex: 0, sequence: 0xfffffffe, unlockingScriptTemplate: new P2PKH().unlock(kp) })
    txM.addInput({ sourceTransaction: SRC, sourceOutputIndex: 1, sequence: 0, unlockingScriptTemplate: r1CombUnlock2Template({ sourceSatoshis: SATS, lockingScript: LOCK, p256PrivateKey: A.priv, salt: A.salt }) })
    txM.addOutput({ satoshis: out0, lockingScript: P2PKH_OUT() })
    try { await txM.sign(); okMixed = await txM.verify('scripts only') } catch (e) { err = e.message.split('\n')[0]; if (!/PUSH_TX/.test(err)) break }
  }
  check('F1 mixed tx (P2PKH input 0, vault input 1 with sequence 0, locktime 500000) signs and verifies', okMixed, err ?? `tx=${txM.toBinary().length}B`)
  if (okMixed) {
    // tamper the OTHER input's sequence after signing -> vault input fails (hashSequence is in the signed preimage)
    const txT = Transaction.fromHex(txM.toHex()); txT.inputs[0].sequence = 0xffffffff
    txT.inputs[1].sourceTransaction = SRC
    const vT = validate({ tx: txT, inputIndex: 1, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: txM.inputs[1].unlockingScript })
    check('F2 changing input 0\'s sequence invalidates the vault input (hashSequence bound via CHECKSIG)', !vT.ok, fmt(vT))
    const txL = Transaction.fromHex(txM.toHex()); txL.lockTime = 500_001; txL.inputs[1].sourceTransaction = SRC
    const vL = validate({ tx: txL, inputIndex: 1, sourceSatoshis: SATS, lockingScript: LOCK, unlockingScript: txM.inputs[1].unlockingScript })
    check('F3 changing locktime invalidates the vault input', !vL.ok, fmt(vL))
  }
  // the lock contains no sequence/locktime/version/amount constant at all
  const consts = LOCK.chunks.filter(c => c.data && (c.data.length === 4 || c.data.length === 8)).map(c => hex(c.data))
  check('F4 lock contains no 4- or 8-byte constants (no baked version/sequence/locktime/amount)', consts.length === 0, JSON.stringify(consts))
  const ops = new Set(LOCK.chunks.map(c => c.op))
  check('F5 lock uses no OP_CHECKLOCKTIMEVERIFY / OP_CHECKSEQUENCEVERIFY (nothing enforces a final sequence; the signer decides)', !ops.has(OP.OP_CHECKLOCKTIMEVERIFY) && !ops.has(OP.OP_CHECKSEQUENCEVERIFY))
}

// ═════════════ G. resource usage ═════════════
section('G. resource usage of a full validation (N=5 lock, honest v1 spend; and the r+p*n malleated variant)')
function measure ({ tx, lock, unlock, sats }) {
  const sp = mkSpend({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlock })
  let maxDepth = 0, maxMem = 0, maxItem = 0, maxNumeric = 0, steps = 0
  const loopStart = layout2(lock).regions.find(r => r.name.startsWith('comb')).chunks[0]
  while (!(sp.context === 'LockingScript' && sp.programCounter >= lock.chunks.length)) {
    sp.step(); steps++
    maxDepth = Math.max(maxDepth, sp.stack.length + sp.altStack.length)
    maxMem = Math.max(maxMem, sp.stackMem + sp.altStackMem)
    const top = sp.stack.at(-1)?.length ?? 0
    maxItem = Math.max(maxItem, top)
    if (sp.context === 'LockingScript' && sp.programCounter > loopStart) maxNumeric = Math.max(maxNumeric, top)
  }
  return { steps, maxDepth, maxMemBytes: maxMem, maxItemBytes: maxItem, maxNumericItemBytes: maxNumeric, executedOps: sp.executedOpCount, finalStack: sp.stack.map(hex), lockBytes: lock.toBinary().length, lockChunks: lock.chunks.length, unlockBytes: unlock.toBinary().length, txBytes: tx.toBinary().length }
}
{
  const members = [...Array(5)].map(() => { const priv = p256.utils.randomSecretKey(); return { priv, q: hex(p256.getPublicKey(priv, true)), salt: randSalt() } })
  const lock5 = buildLock2({ commitments: members.map(m => commitmentFor({ qCompressedHex: m.q, salt: m.salt })) })
  const src5 = fundingTx(lock5, SATS, 0)
  const { tx: t5, unlock: u5 } = buildSpend({ src: src5, vout: 0, sats: SATS, priv: members[4].priv, salt: members[4].salt, lock: lock5 }, { nOut: 2 })
  const m = measure({ tx: t5, lock: lock5, unlock: u5, sats: SATS })
  console.log('   honest N=5:', JSON.stringify(m))
  check('G1 honest N=5 validation ends with stack [01]', m.finalStack.length === 1 && m.finalStack[0] === '01')
  const g5 = decodeUnlock2(u5), e5 = beToBig(signerDigest(g5.preimage))
  const uM = variant(g5, e5, { r: g5.r + P256_P * P256_N, sInv: g5.sInv + 3n * P256_N })
  const mm = measure({ tx: t5, lock: lock5, unlock: uM, sats: SATS })
  console.log('   malleated r+p*n, sInv+3n:', JSON.stringify({ ...mm, finalStack: undefined }))
  check('G2 malleated variant also completes (r 65 B, products up to ~100 B)', mm.finalStack.length === 1 && mm.finalStack[0] === '01')
  // published policy numbers (repo doc docs/superpowers/specs/2026-08-15-r1k1-vault-design.md §0, arcade/teranode defaults)
  const limits = { MaxScriptSizePolicy_arcade: 500_000, MaxScriptSizePolicy_miners_per_doc: 100_000_000, MaxStackMemoryUsagePolicy: 104_857_600, MaxOpsPerScriptPolicy: 1_000_000, MaxScriptNumLengthPolicy_arcade_doc: 10_000, MaxTxSizePolicy: 10_485_760 }
  check(`G3 lock ${m.lockBytes} B and unlock ${m.unlockBytes} B are each < arcade MaxScriptSizePolicy ${limits.MaxScriptSizePolicy_arcade}`, m.lockBytes < limits.MaxScriptSizePolicy_arcade && m.unlockBytes < limits.MaxScriptSizePolicy_arcade)
  check(`G4 peak stack+alt memory ${m.maxMemBytes} B << MaxStackMemoryUsagePolicy ${limits.MaxStackMemoryUsagePolicy}`, m.maxMemBytes < limits.MaxStackMemoryUsagePolicy / 1000)
  check(`G5 executed non-push ops ${m.executedOps} < MaxOpsPerScriptPolicy ${limits.MaxOpsPerScriptPolicy}`, m.executedOps < limits.MaxOpsPerScriptPolicy)
  check(`G6 largest numeric operand ${m.maxNumericItemBytes} B (lazy products) and largest item ${m.maxItemBytes} B (H4 concat) << MaxScriptNumLengthPolicy ${limits.MaxScriptNumLengthPolicy_arcade_doc}`, m.maxNumericItemBytes < 1000 && m.maxItemBytes < limits.MaxScriptNumLengthPolicy_arcade_doc)
  check(`G7 peak stack depth (main+alt) ${m.maxDepth} items (pre-genesis limit was 1000; none post-genesis)`, m.maxDepth < 1000)
  check(`G8 spend tx ${m.txBytes} B << MaxTxSizePolicy ${limits.MaxTxSizePolicy}`, m.txBytes < limits.MaxTxSizePolicy)
  const t0 = performance.now(); for (let i = 0; i < 5; i++) validate({ tx: t5, inputIndex: 0, sourceSatoshis: SATS, lockingScript: lock5, unlockingScript: u5 }); const dt = (performance.now() - t0) / 5
  console.log(`   SDK JS interpreter: ${dt.toFixed(1)} ms per validation (node); SV Node maxnonstdtxvalidationduration default is 1000 ms — C++ will be faster than this JS figure (inferred)`)
}

// ═════════════ H. post-spend privacy ═════════════
section('H. after the first spend the table is public: Q is recoverable from it (privacy, not security)')
{
  const T0 = mod(combTableScalar(0), P256_N)
  const P0 = p256.Point.fromAffine({ x: GOOD.table[0].x, y: GOOD.table[0].y })
  const Qrec = P0.multiply(modinv(T0, P256_N))
  check('H1 Q = table[0] * T_0^-1 recovers the signer key from the revealed unlock', Qrec.toHex(true) === B.q)
  check('H2 hence anyone can recompute commitmentFor(Q, salt) and link every other output baking the same commitment', commitmentFor({ qCompressedHex: Qrec.toHex(true), salt: GOOD.salt }) === bakedCommitments(LOCK)[1])
}

console.log(`\nMALLEABLE variants that validated (v1 unless tagged v2): ${JSON.stringify(malleable)}`)
console.log(fails === 0 ? '\nALL EXPECTATIONS MET' : `\n${fails} UNEXPECTED RESULT(S)`)
process.exitCode = fails ? 1 : 0
