// fuzz2.mjs — randomized end-to-end fuzz of gen2.mjs (buildLock2) + unlock2.mjs (buildUnlock2) against the
// @bsv/sdk Spend interpreter, followed by the negative battery requested by the orchestrator.
//
//   CASES=200 node fuzz2.mjs          (writes fuzz2-report.json + fuzz2-failures.json next to this file)
//
// Positive fuzz, per case: N ~ U{1..5} commitments per lock, random signer index, 1..3 inputs where EVERY input is an
// independent gen2 vault output (own lock, own keys, own salts, own N, own satoshis, own vout, own sequence),
// 1..3 outputs of random script kinds / amounts, random locktime, version in {1,2}. Every input must Spend.validate().
// Every buildLock2 / buildUnlock2 / Spend.validate() call is timed with performance.now().
import fs from 'fs'
import { performance } from 'perf_hooks'
import { Transaction, P2PKH, PrivateKey, Spend, Script, UnlockingScript, OP } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { buildLock2, commitmentFor, bakedCommitments, recode, layout2, pushData, combTable, P256_N, P256_P } from './gen2.mjs'
import { buildUnlock2, encodeUnlock2, decodeUnlock2, r1CombUnlock2Template } from './unlock2.mjs'
import { sighashPreimage, signerDigest, fullR } from './unlock.mjs'

const S = process.env.S ?? '/private/tmp/claude-502/-Users-personal-git-bsv-wallet/a954ef08-e7c5-49e3-8a72-1cd73ad1d771/scratchpad'
const CASES = Number(process.env.CASES ?? 200)
const hex = a => Buffer.from(a).toString('hex')
const mod = (a, m) => ((a % m) + m) % m
const beToBig = b => BigInt('0x' + (hex(b) || '0'))
const randBytes = n => [...crypto.getRandomValues(new Uint8Array(n))]
const randBig = (lo, hi) => { const range = hi - lo + 1n; const nbytes = Math.ceil(range.toString(2).length / 8) + 8; return lo + beToBig(randBytes(nbytes)) % range }
const randInt = (lo, hi) => Number(randBig(BigInt(lo), BigInt(hi)))
const pick = arr => arr[randInt(0, arr.length - 1)]
const qOf = priv => hex(p256.getPublicKey(priv, true))

// ───────────────────────────── bookkeeping ─────────────────────────────
const results = []            // { name, ok, detail }
const failures = []
let fails = 0
function check (name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
  if (!ok) { fails++; failures.push({ name, detail }) }
}
const T = { buildLock2: [], buildUnlock2: [], validateOk: [], validateNeg: [] }
function timed (bucket, fn) { const t0 = performance.now(); try { return fn() } finally { T[bucket].push(performance.now() - t0) } }
function stats (arr) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  const r = x => Math.round(x * 100) / 100
  return { n: s.length, mean: r(s.reduce((a, b) => a + b, 0) / s.length), median: r(q(0.5)), min: r(s[0]), p95: r(q(0.95)), max: r(s[s.length - 1]) }
}

// ───────────────────────────── interpreter harness ─────────────────────────────
function mkSpend ({ tx, inputIndex, sourceSatoshis, lockingScript, unlockingScript }) {
  const inp = tx.inputs[inputIndex]
  return new Spend({
    sourceTXID: inp.sourceTXID ?? inp.sourceTransaction.id('hex'), sourceOutputIndex: inp.sourceOutputIndex, sourceSatoshis: Number(sourceSatoshis),
    lockingScript, transactionVersion: tx.version, otherInputs: tx.inputs.filter((_, i) => i !== inputIndex), outputs: tx.outputs,
    unlockingScript, inputSequence: inp.sequence ?? 0xffffffff, inputIndex, lockTime: tx.lockTime
  })
}
/** Run validate(); returns { ok, pc, err, ms, mode } (mode: 'returned true' | 'returned false' | 'threw'). */
function validate (args, bucket = 'validateOk') {
  const sp = mkSpend(args)
  const t0 = performance.now()
  let out
  try { const ok = sp.validate(); out = { ok: ok === true, pc: sp.programCounter, err: null, mode: ok === true ? 'returned true' : 'returned false' } } catch (e) { out = { ok: false, pc: sp.programCounter, err: e.message.split('\n')[0], mode: 'threw' } }
  out.ms = performance.now() - t0
  T[bucket].push(out.ms)
  return out
}
function regionOf (lock, pc) {
  if (pc >= lock.chunks.length) return 'END (after OP_CHECKSIG: top not truthy)'
  const r = layout2(lock).regions.find(r => pc >= r.chunks[0] && pc <= r.chunks[1])
  return r ? r.name : '?'
}
const where = (lock, v) => `pc=${v.pc} [${regionOf(lock, v.pc)}] ${v.mode}${v.err ? ': ' + v.err : ''}`

// ───────────────────────────── random material ─────────────────────────────
const SCRIPT_KINDS = ['p2pkh', 'op_return', 'op_1', 'push_drop_1', 'pushdata2_drop_1', 'op_false_return']
function randomOutputScript () {
  switch (pick(SCRIPT_KINDS)) {
    case 'p2pkh': return new P2PKH().lock(PrivateKey.fromRandom().toAddress())
    case 'op_return': return Script.fromBinary([OP.OP_RETURN, ...pushData(randBytes(randInt(0, 80)))])
    case 'op_false_return': return Script.fromBinary([OP.OP_FALSE, OP.OP_RETURN, ...pushData(randBytes(randInt(1, 120)))])
    case 'op_1': return Script.fromBinary([OP.OP_1])
    case 'push_drop_1': return Script.fromBinary([...pushData(randBytes(randInt(1, 75))), OP.OP_DROP, OP.OP_1])
    case 'pushdata2_drop_1': return Script.fromBinary([...pushData(randBytes(randInt(256, 600))), OP.OP_DROP, OP.OP_1])
  }
}
const randSalt = () => Uint8Array.from(randBytes(32))
function randomMember () { const priv = p256.utils.randomSecretKey(); return { priv, q: qOf(priv), salt: randSalt() } }
/** An independent vault output: lock with N random members, a random signer, random satoshis/vout/outpoint/sequence. */
function randomVault ({ N = randInt(1, 5), final } = {}) {
  const members = [...Array(N)].map(randomMember)
  const commitments = members.map(m => commitmentFor({ qCompressedHex: m.q, salt: m.salt }))
  const lock = timed('buildLock2', () => buildLock2({ commitments }))
  const signerIdx = randInt(0, N - 1)
  return {
    N, members, commitments, lock, signerIdx, signer: members[signerIdx],
    sats: Number(randBig(1n, 1n << 40n)), sourceTXID: hex(randBytes(32)), vout: randInt(0, 2),
    sequence: final ? 0xffffffff : pick([0xffffffff, 0xfffffffe, randInt(0, 0xfffffffd)])
  }
}
function mkTx ({ vaults, outputs, lockTime, version }) {
  const tx = new Transaction(version, [], [], lockTime)
  for (const v of vaults) tx.addInput({ sourceTXID: v.sourceTXID, sourceOutputIndex: v.vout, sequence: v.sequence, unlockingScript: new UnlockingScript() })
  for (const o of outputs) tx.addOutput({ satoshis: o.satoshis, lockingScript: o.lockingScript })
  return tx
}
function randomOutputs (n) { return [...Array(n)].map(() => ({ satoshis: Number(randBig(0n, 1n << 40n)), lockingScript: randomOutputScript() })) }

let screenHits = 0
/** Build tx + all unlocks; on a PUSH_TX screen failure (~2^-16 per input) perturb output 0's amount and rebuild everything. */
function buildSpend ({ vaults, nOut, lockTime, version, extra = {} }) {
  const outputs = randomOutputs(nOut)
  for (let tries = 0; tries < 40; tries++) {
    const tx = mkTx({ vaults, outputs, lockTime, version })
    const unlocks = []
    try {
      for (let k = 0; k < vaults.length; k++) {
        const v = vaults[k]
        unlocks.push(timed('buildUnlock2', () => buildUnlock2({ tx, inputIndex: k, sourceSatoshis: v.sats, lockingScript: v.lock, p256PrivateKey: v.signer.priv, salt: v.signer.salt, ...extra })))
      }
    } catch (e) {
      if (e.code === 'PUSH_TX_PEEL_NONMINIMAL' || e.code === 'PUSH_TX_S_ZERO') { screenHits++; outputs[0].satoshis = (outputs[0].satoshis + 1) % 2 ** 40; continue }
      throw e
    }
    unlocks.forEach((u, k) => { tx.inputs[k].unlockingScript = u })
    return { tx, unlocks }
  }
  throw new Error('PUSH_TX screen failed 40 times in a row (expected ~2^-16 each)')
}

/** Hand-rolled unlock (bypasses every builder guard): sign `preimage` with `signPriv`; compute r via `QforR`; push table of `tableQ` (or `tableOverride`) + `salt`. */
function manualUnlock2 ({ preimage, signPriv, QforR, tableQ, tableOverride, salt, patch = {} }) {
  const digest = signerDigest(preimage)
  const e = beToBig(digest)
  const sig = p256.Signature.fromBytes(p256.sign(digest, signPriv, { prehash: false }), 'compact')
  const { x: Rx, sInv } = fullR({ e, r: sig.r, s: sig.s, Q: QforR })
  const u1 = mod(e * sInv, P256_N), u2 = mod(Rx * sInv, P256_N)
  return encodeUnlock2({ r: Rx, u2p: recode(u2), u1p: recode(u1), table: tableOverride ?? combTable(tableQ), salt, s: sig.s, sInv, preimage, ...patch })
}

// ───────────────────────────── (A) positive fuzz ─────────────────────────────
const coverage = { N: {}, inputs: {}, outputs: {}, lockTimeNonZero: 0, version2: 0, nonFinalSeq: 0, signerIdx: {} }
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1 }
async function positiveFuzz () {
  console.log(`── (A) positive fuzz x${CASES}: N∈{1..5} per input, 1..3 vault inputs, 1..3 outputs, random locktime/sequence/version ──`)
  let okCases = 0
  const t0 = performance.now()
  for (let i = 0; i < CASES; i++) {
    const nIn = randInt(1, 3), nOut = randInt(1, 3)
    const final = Math.random() < 0.4
    const lockTime = final ? 0 : pick([randInt(1, 499_999_999), randInt(500_000_000, 0xffffffff)])
    const version = Math.random() < 0.8 ? 1 : 2
    const vaults = [...Array(nIn)].map(() => randomVault({ final }))
    let built
    try { built = buildSpend({ vaults, nOut, lockTime, version }) } catch (e) { check(`fuzz ${i}: build`, false, e.message); continue }
    const { tx, unlocks } = built
    let all = true; const det = []
    for (let k = 0; k < nIn; k++) {
      const v = validate({ tx, inputIndex: k, sourceSatoshis: vaults[k].sats, lockingScript: vaults[k].lock, unlockingScript: unlocks[k] })
      all &&= v.ok
      det.push(`in${k}[N=${vaults[k].N} signer#${vaults[k].signerIdx} vout=${vaults[k].vout} seq=${vaults[k].sequence.toString(16)}]: ${v.ok ? 'ok' : where(vaults[k].lock, v)} ${v.ms.toFixed(0)}ms u=${unlocks[k].toBinary().length}B`)
    }
    for (const v of vaults) { bump(coverage.N, v.N); bump(coverage.signerIdx, v.signerIdx); if (v.sequence !== 0xffffffff) coverage.nonFinalSeq++ }
    bump(coverage.inputs, nIn); bump(coverage.outputs, nOut); if (lockTime) coverage.lockTimeNonZero++; if (version === 2) coverage.version2++
    if (all) okCases++
    else check(`fuzz ${i}`, false, det.join(' | '))
    if (i % 25 === 0 || !all) console.log(`  fuzz ${i}: ok=${all} v=${version} lt=${lockTime} nIn=${nIn} nOut=${nOut} tx=${tx.toBinary().length}B  ${det.join(' | ')}`)
  }
  const dt = performance.now() - t0
  check(`(A) positive fuzz: ${okCases}/${CASES} cases validate on every input`, okCases === CASES, `${(dt / 1000).toFixed(1)} s total, ${T.validateOk.length} validations, PUSH_TX screen hits ${screenHits}`)
  console.log('  coverage: ' + JSON.stringify(coverage))
}

// ───────────────────────────── (B) negative battery ─────────────────────────────
async function negatives () {
  console.log('── (B) negative battery (each MUST fail) ──')
  // Fixture: lock L with N=3 members {A, B, C}; signer A; 2 outputs; plus an uncommitted key X.
  const A = randomMember(), B = randomMember(), C = randomMember(), X = randomMember()
  const lock = buildLock2({ commitments: [A, B, C].map(m => commitmentFor({ qCompressedHex: m.q, salt: m.salt })) })
  const vault = { N: 3, members: [A, B, C], lock, signerIdx: 0, signer: A, sats: 123_456, sourceTXID: hex(randBytes(32)), vout: 1, sequence: 0xffffffff }
  const { tx, unlocks } = buildSpend({ vaults: [vault], nOut: 2, lockTime: 0, version: 1 })
  const good = decodeUnlock2(unlocks[0])
  const args = u => ({ tx, inputIndex: 0, sourceSatoshis: vault.sats, lockingScript: lock, unlockingScript: u })
  const v0 = validate(args(unlocks[0]))
  check('B0 positive control: A of {A,B,C} spends', v0.ok, `pc=${v0.pc} ${v0.ms.toFixed(1)}ms`)
  const pre = good.preimage
  const QA = p256.Point.fromHex(A.q), QB = p256.Point.fromHex(B.q), QX = p256.Point.fromHex(X.q)
  const neg = (name, u, expectRegion) => {
    const v = validate(args(u), 'validateNeg')
    const region = regionOf(lock, v.pc)
    const regionOk = expectRegion ? region.startsWith(expectRegion) : true
    check(`${name} -> fails${expectRegion ? ` in [${expectRegion}]` : ''}`, !v.ok && regionOk, where(lock, v))
  }

  // B1 wrong key: uncommitted key X, its own table, A's salt. (a) builder refuses; (b) forced -> H5
  let code = null
  try { buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: vault.sats, lockingScript: lock, p256PrivateKey: X.priv, salt: A.salt }) } catch (e) { code = e.code }
  check('B1a wrong key (uncommitted X): buildUnlock2 refuses before signing', code === 'NOT_COMMITTED', code ?? 'no throw')
  neg('B1b wrong key (uncommitted X, own table, A\'s salt, forced)', buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: vault.sats, lockingScript: lock, p256PrivateKey: X.priv, salt: A.salt, skipCommitmentCheck: true }), 'H5')
  neg('B1c wrong key (uncommitted X, own table, fresh salt, forced)', buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: vault.sats, lockingScript: lock, p256PrivateKey: X.priv, salt: randSalt(), skipCommitmentCheck: true }), 'H5')

  // B2 wrong salt: A's key and table, salt of B / random
  code = null
  try { buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: vault.sats, lockingScript: lock, p256PrivateKey: A.priv, salt: B.salt }) } catch (e) { code = e.code }
  check('B2a wrong salt (A with B\'s salt): buildUnlock2 refuses before signing', code === 'NOT_COMMITTED', code ?? 'no throw')
  neg('B2b wrong salt (A\'s key+table, B\'s salt, forced)', buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: vault.sats, lockingScript: lock, p256PrivateKey: A.priv, salt: B.salt, skipCommitmentCheck: true }), 'H5')
  neg('B2c wrong salt (A\'s key+table, random salt, forced)', buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: vault.sats, lockingScript: lock, p256PrivateKey: A.priv, salt: randSalt(), skipCommitmentCheck: true }), 'H5')
  neg('B2d salt byte flipped in an otherwise valid unlock', encodeUnlock2({ ...good, salt: good.salt.map((x, i) => i === 31 ? x ^ 0x80 : x) }), 'H5')

  // B3 table for key A (committed, with A's salt) but signature from key B (committed member) and from X (uncommitted)
  //     (i) r computed honestly for the signer (R = u1 G + u2 Q_B): header passes, comb computes u1 G + u2 Q_A != R -> r check fails in the tail
  neg('B3a table+salt of A, signature by B (r from Q_B)', manualUnlock2({ preimage: pre, signPriv: B.priv, QforR: QB, tableQ: QA, salt: A.salt }), 'tail')
  neg('B3b table+salt of A, signature by X (r from Q_X)', manualUnlock2({ preimage: pre, signPriv: X.priv, QforR: QX, tableQ: QA, salt: A.salt }), 'tail')
  //     (ii) r "re-derived" against Q_A, i.e. r := x(u1 G + (sig.r*sInv) Q_A), everything else recomputed self-consistently from that r
  //          (u2 := r*sInv): header passes, but the comb now evaluates u1 G + (r*sInv) Q_A whose x != r -> tail r check
  neg('B3c table+salt of A, signature by B, r re-derived via Q_A (u2\' recomputed from it)', manualUnlock2({ preimage: pre, signPriv: B.priv, QforR: QA, tableQ: QA, salt: A.salt }), 'tail')
  //     (iii) the naive forgery: push r := x(comb result) but keep u2' = recode(sig.r*sInv) so the comb really lands on r ->
  //          the header's u2 = r*sInv consistency check (H3) is what rejects it
  {
    const digest = signerDigest(pre); const e = beToBig(digest)
    const sig = p256.Signature.fromBytes(p256.sign(digest, B.priv, { prehash: false }), 'compact')
    const { x: RxA, sInv } = fullR({ e, r: sig.r, s: sig.s, Q: QA })                 // x(u1 G + (sig.r sInv) Q_A) = what the comb will output
    const u1 = mod(e * sInv, P256_N), u2 = mod(sig.r * sInv, P256_N)
    neg('B3c\' table+salt of A, signature by B, r := comb output, u2\' kept from sig.r', encodeUnlock2({ r: RxA, u2p: recode(u2), u1p: recode(u1), table: combTable(QA), salt: A.salt, s: sig.s, sInv, preimage: pre }), 'H3')
  }
  //     (iii) sanity: B with B's own table+salt is a legitimate spend (positive control for the member set)
  const vB = validate(args(manualUnlock2({ preimage: pre, signPriv: B.priv, QforR: QB, tableQ: QB, salt: B.salt })))
  check('B3d control: B with B\'s table+salt spends', vB.ok, `pc=${vB.pc}`)

  // B4 swapped coordinates
  neg('B4a entry 7: x<->y swapped', encodeUnlock2({ ...good, table: good.table.map((p, j) => j === 7 ? { x: p.y, y: p.x } : p) }), 'H5')
  neg('B4b entries 3 and 29 swapped (both coordinates)', encodeUnlock2({ ...good, table: good.table.map((p, j) => j === 3 ? good.table[29] : j === 29 ? good.table[3] : p) }), 'H5')
  neg('B4c whole table reversed', encodeUnlock2({ ...good, table: [...good.table].reverse() }), 'H5')
  neg('B4d entry 0 y negated (-y mod p, a valid point)', encodeUnlock2({ ...good, table: good.table.map((p, j) => j === 0 ? { x: p.x, y: mod(-p.y, P256_P) } : p) }), 'H5')

  // B5 a table entry replaced by a DIFFERENT valid curve point
  const tab = combTable(QA)
  const plusG = j => { const P = p256.Point.fromAffine(tab[j]).add(p256.Point.BASE).toAffine(); return { x: P.x, y: P.y } }
  neg('B5a entry 12 := T_12*Q_A + G (valid point)', encodeUnlock2({ ...good, table: tab.map((p, j) => j === 12 ? plusG(12) : p) }), 'H5')
  const tabB = combTable(QB)
  neg('B5b entry 31 := T_31*Q_B (valid point from another member\'s table)', encodeUnlock2({ ...good, table: tab.map((p, j) => j === 31 ? tabB[31] : p) }), 'H5')
  const R = p256.Point.BASE.multiply(beToBig(p256.utils.randomSecretKey())).toAffine()
  neg('B5c entry 0 := random point', encodeUnlock2({ ...good, table: tab.map((p, j) => j === 0 ? { x: R.x, y: R.y } : p) }), 'H5')
  neg('B5d whole table := table of Q_A + G (all valid points, A\'s salt)', encodeUnlock2({ ...good, table: combTable(QA.add(p256.Point.BASE)) }), 'H5')
  // B5e: table where entry 12 is off-curve (x+1) — the commitment catches it before any arithmetic
  neg('B5e entry 12 x+1 (off-curve)', encodeUnlock2({ ...good, table: tab.map((p, j) => j === 12 ? { x: p.x + 1n, y: p.y } : p) }), 'H5')

  // B6 preimage from a different tx (valid P-256 signature over that other preimage; commitment ok) -> only CHECKSIG can reject
  const { tx: tx2, unlocks: un2 } = buildSpend({ vaults: [vault], nOut: 3, lockTime: 0, version: 1 })
  const c2 = validate({ tx: tx2, inputIndex: 0, sourceSatoshis: vault.sats, lockingScript: lock, unlockingScript: un2[0] })
  check('B6a control: tx2\'s unlock validates against tx2', c2.ok, `pc=${c2.pc}`)
  neg('B6b tx2\'s unlock (preimage of a different tx) evaluated against tx', un2[0], 'END')
  const pre2 = decodeUnlock2(un2[0]).preimage
  check('B6c the two preimages differ only in hashOutputs (bytes 118..150)', hex(pre.slice(0, 118)) === hex(pre2.slice(0, 118)) && hex(pre.slice(118, 150)) !== hex(pre2.slice(118, 150)) && hex(pre.slice(150)) === hex(pre2.slice(150)))
  //     also: same tx, but sourceSatoshis differs at validation time (amount lives only in the pushed preimage)
  const vAmt = validate({ ...args(unlocks[0]), sourceSatoshis: vault.sats + 1 }, 'validateNeg')
  check('B6d sourceSatoshis+1 at validation -> fails at END (CHECKSIG)', !vAmt.ok && vAmt.pc >= lock.chunks.length, where(lock, vAmt))
  //     and: same unlock, tx with locktime bumped
  const txLt = Transaction.fromHex(tx.toHex()); txLt.lockTime = 1
  const vLt = validate({ tx: txLt, inputIndex: 0, sourceSatoshis: vault.sats, lockingScript: lock, unlockingScript: unlocks[0] }, 'validateNeg')
  check('B6e same unlock, lockTime 0 -> 1 at validation -> fails at END (CHECKSIG)', !vLt.ok && vLt.pc >= lock.chunks.length, where(lock, vLt))

  // B7 sighash type byte changed in the pushed preimage (last 4 bytes 41000000)
  check('B7 precondition: pushed preimage ends with sighash 41000000', hex(pre.slice(154)) === '41000000')
  for (const [label, sh] of [['01 (ALL, no FORKID)', 0x01], ['43 (SINGLE|FORKID)', 0x43], ['c1 (ALL|ANYONECANPAY|FORKID)', 0xc1], ['42 (NONE|FORKID)', 0x42]]) {
    const preX = [...pre.slice(0, 154), sh, 0, 0, 0]
    //  (i) attacker re-signs the modified preimage: P-256 leg + commitment pass; CHECKSIG (which appends the baked 0x41 and hashes the REAL preimage) must reject
    neg(`B7a sighash byte -> ${label} in pushed preimage, re-signed`, manualUnlock2({ preimage: preX, signPriv: A.priv, QforR: QA, tableQ: QA, salt: A.salt }), 'END')
    //  (ii) not re-signed: e changes -> pushed u1' mismatches -> H3
    neg(`B7b sighash byte -> ${label} in pushed preimage, original signature`, encodeUnlock2({ ...good, preimage: preX }), 'H3')
  }
  // B7c: sighash bytes also as 4-byte LE variation of the same low byte (41 00 00 01) -> CHECKSIG must reject
  neg('B7c sighash dword 41000001 (upper bytes non-zero), re-signed', manualUnlock2({ preimage: [...pre.slice(0, 154), 0x41, 0, 0, 1], signPriv: A.priv, QforR: QA, tableQ: QA, salt: A.salt }), 'END')

  // B8 signature over input 0's preimage used for input 1 (2-input tx). Two flavours.
  //   (i) same lock, same signer, same salt on both inputs (commitment + P-256 legs pass for the swapped unlock) -> END
  const vault2 = { ...vault, sourceTXID: hex(randBytes(32)), vout: 0, sats: vault.sats + 999 }
  const { tx: txS, unlocks: uS } = buildSpend({ vaults: [vault, vault2], nOut: 1, lockTime: 0, version: 1 })
  const s0 = validate({ tx: txS, inputIndex: 0, sourceSatoshis: vault.sats, lockingScript: lock, unlockingScript: uS[0] })
  const s1 = validate({ tx: txS, inputIndex: 1, sourceSatoshis: vault2.sats, lockingScript: lock, unlockingScript: uS[1] })
  check('B8a control: 2-input same-lock same-key tx, both inputs validate', s0.ok && s1.ok, `pc=${s0.pc}/${s1.pc}`)
  const x1 = validate({ tx: txS, inputIndex: 1, sourceSatoshis: vault2.sats, lockingScript: lock, unlockingScript: uS[0] }, 'validateNeg')
  check('B8b input 1 evaluated with input 0\'s unlock (same lock/key/salt) -> fails at END (CHECKSIG)', !x1.ok && x1.pc >= lock.chunks.length, where(lock, x1))
  const x0 = validate({ tx: txS, inputIndex: 0, sourceSatoshis: vault.sats, lockingScript: lock, unlockingScript: uS[1] }, 'validateNeg')
  check('B8c input 0 evaluated with input 1\'s unlock (same lock/key/salt) -> fails at END (CHECKSIG)', !x0.ok && x0.pc >= lock.chunks.length, where(lock, x0))
  const d0 = decodeUnlock2(uS[0]), d1 = decodeUnlock2(uS[1])
  check('B8d the two pushed preimages differ exactly in outpoint (68..104) and amount (106..114)', hex(d0.preimage) !== hex(d1.preimage) && hex(d0.preimage.slice(0, 68)) === hex(d1.preimage.slice(0, 68)) && hex(d0.preimage.slice(104, 106)) === hex(d1.preimage.slice(104, 106)) && hex(d0.preimage.slice(114)) === hex(d1.preimage.slice(114)))
  //   (ii) re-signed for input 1's slot but carrying input 0's preimage bytes (identical to (i) in effect; explicit) -> END
  const pre0 = sighashPreimage({ tx: txS, inputIndex: 0, sourceSatoshis: vault.sats, scope: 0x41 })
  const x1b = validate({ tx: txS, inputIndex: 1, sourceSatoshis: vault2.sats, lockingScript: lock, unlockingScript: manualUnlock2({ preimage: pre0, signPriv: A.priv, QforR: QA, tableQ: QA, salt: A.salt }) }, 'validateNeg')
  check('B8e fresh signature over input 0\'s preimage, evaluated as input 1 -> fails at END (CHECKSIG)', !x1b.ok && x1b.pc >= lock.chunks.length, where(lock, x1b))
  //   (iii) different locks on the two inputs (lock L for input 0, N=1 lock of X for input 1): input 1 with input 0's unlock -> commitment mismatch (H5)
  const vaultX = { N: 1, members: [X], lock: buildLock2({ commitments: [commitmentFor({ qCompressedHex: X.q, salt: X.salt })] }), signerIdx: 0, signer: X, sats: 777, sourceTXID: hex(randBytes(32)), vout: 2, sequence: 0xffffffff }
  const { tx: txD, unlocks: uD } = buildSpend({ vaults: [vault, vaultX], nOut: 2, lockTime: 0, version: 1 })
  const d0ok = validate({ tx: txD, inputIndex: 0, sourceSatoshis: vault.sats, lockingScript: lock, unlockingScript: uD[0] })
  const d1ok = validate({ tx: txD, inputIndex: 1, sourceSatoshis: vaultX.sats, lockingScript: vaultX.lock, unlockingScript: uD[1] })
  check('B8f control: 2-input tx with different locks (N=3 and N=1), both validate', d0ok.ok && d1ok.ok, `pc=${d0ok.pc}/${d1ok.pc}`)
  const xd = validate({ tx: txD, inputIndex: 1, sourceSatoshis: vaultX.sats, lockingScript: vaultX.lock, unlockingScript: uD[0] }, 'validateNeg')
  check('B8g input 1 (lock of X) evaluated with input 0\'s unlock (A\'s table) -> fails in [H5]', !xd.ok && regionOf(vaultX.lock, xd.pc).startsWith('H5'), where(vaultX.lock, xd))

  // B9 misc tampers (r, u', s) for completeness
  neg('B9a r+1', encodeUnlock2({ ...good, r: good.r + 1n }), 'H3')
  neg('B9b r+n (same residue mod n; comb result x != pushed r)', encodeUnlock2({ ...good, r: good.r + P256_N }), null)
  neg('B9c u1\'+1', encodeUnlock2({ ...good, u1p: good.u1p + 1n }), 'H3')
  neg('B9d u2\'-1', encodeUnlock2({ ...good, u2p: good.u2p - 1n }), 'H3')
  neg('B9e s+1 (sInv stale)', encodeUnlock2({ ...good, s: good.s + 1n }), 'H1')
  neg('B9f s := n - s (high-S twin; sInv stale)', encodeUnlock2({ ...good, s: P256_N - good.s }), 'H1')
}

// ───────────────────────────── (C) SDK end-to-end (templates, tx.sign, tx.verify) ─────────────────────────────
async function sdkEndToEnd () {
  console.log('── (C) SDK end-to-end: 3 vault inputs via r1CombUnlock2Template + tx.sign() + tx.verify(\'scripts only\') ──')
  const { MerklePath } = await import('@bsv/sdk')
  const vaults = [randomVault({ N: 2, final: true }), randomVault({ N: 5, final: true }), randomVault({ N: 1, final: true })]
  const tx = new Transaction(1, [], [], 0)
  for (const v of vaults) {
    const src = new Transaction()
    for (let k = 0; k < v.vout; k++) src.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
    src.addOutput({ satoshis: v.sats, lockingScript: v.lock })
    src.merklePath = MerklePath.fromCoinbaseTxidAndHeight(src.id('hex'), 1755177)
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: v.vout, sequence: 0xffffffff, unlockingScriptTemplate: r1CombUnlock2Template({ sourceSatoshis: v.sats, lockingScript: v.lock, p256PrivateKey: v.signer.priv, salt: v.signer.salt }) })
  }
  tx.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
  let verified = false, err = null
  for (let tries = 0; tries < 5 && !verified; tries++) {
    try { await tx.sign(); verified = await tx.verify('scripts only') } catch (e) { err = e.message.split('\n')[0]; if (/PUSH_TX/.test(err)) { tx.outputs[0].satoshis++; continue } break }
  }
  check('(C) 3-input tx (N=2,5,1 vaults) signs via templates and tx.verify(\'scripts only\') is true', verified, err ?? `tx=${tx.toBinary().length}B`)
  return tx.toBinary().length
}

// ───────────────────────────── main ─────────────────────────────
const tAll = performance.now()
await positiveFuzz()
await negatives()
const e2eBytes = await sdkEndToEnd()
const total = (performance.now() - tAll) / 1000
const report = {
  cases: CASES, fails, screenHits, coverage, e2eTxBytes: e2eBytes,
  timingsMs: { buildLock2: stats(T.buildLock2), buildUnlock2: stats(T.buildUnlock2), validatePositive: stats(T.validateOk), validateNegative: stats(T.validateNeg) },
  totalSeconds: Math.round(total * 10) / 10,
  results
}
fs.writeFileSync(`${S}/fuzz2-report.json`, JSON.stringify(report, null, 2))
fs.writeFileSync(`${S}/fuzz2-failures.json`, JSON.stringify(failures, null, 2))
console.log('── timings (ms) ──')
for (const [k, v] of Object.entries(report.timingsMs)) console.log(`  ${k.padEnd(18)} ${JSON.stringify(v)}`)
console.log(`── total ${report.totalSeconds}s; ${results.length} checks; ${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`)
process.exitCode = fails ? 1 : 0
