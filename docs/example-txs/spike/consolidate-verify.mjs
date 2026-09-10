// consolidate-verify.mjs — re-establishes, by execution, every number quoted in ANALYSIS.md.
// Run from the scratchpad:  node consolidate-verify.mjs   (writes consolidate-verify.out.txt next to it)
import fs from 'fs'
import { createHash } from 'crypto'
import { Transaction, LockingScript, UnlockingScript, Script, Spend, OP, Hash, BigNumber, PrivateKey, TransactionSignature, P2PKH } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { buildLock, encNum, scriptNum, combTable, P256_N, P256_P, SECP_N, SECP_GX } from './gen.mjs'
import { buildUnlockAsync, decodeUnlock, pushTxSignature, pushTxDerCheck, peelLoopNonMinimalAt, sighashPreimage, signerDigest } from './unlock.mjs'
import { buildLock2, commitmentFor, layout2, recode } from './gen2.mjs'
import { buildUnlock2, buildUnlock2Async } from './unlock2.mjs'
import { buildLock2Hardened } from './gen2-hardened.mjs'

const S = process.env.S ?? '/private/tmp/claude-502/-Users-personal-git-bsv-wallet/a954ef08-e7c5-49e3-8a72-1cd73ad1d771/scratchpad'
const REPO = '/Users/personal/git/bsv-wallet'
const out = []
const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s) }
let fails = 0
const check = (name, ok, detail = '') => { log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); if (!ok) fails++ }
const hex = a => Buffer.from(a).toString('hex')
const sha256hex = a => createHash('sha256').update(Buffer.from(a)).digest('hex')
const leToBig = b => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v }
const beToBig = b => { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v }
const mod = (a, m) => ((a % m) + m) % m
const modpow = (b, e, m) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n } return r }
const modinv = (a, m) => modpow(a, m - 2n, m)
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const fmtms = a => `n=${a.length} mean=${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2)} median=${median(a).toFixed(2)} min=${Math.min(...a).toFixed(2)} max=${Math.max(...a).toFixed(2)}`

// ───────── 1. fixtures ─────────
const lockHex = fs.readFileSync(`${REPO}/docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex`, 'utf8').trim()
const txHex = fs.readFileSync(`${REPO}/docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex`, 'utf8').trim()
const lock = LockingScript.fromHex(lockHex)
const tx = Transaction.fromHex(txHex)
const unlock = tx.inputs[0].unlockingScript
const lockBytes = lock.toBinary()
log('== 1. fixture facts')
log(`lock: ${lockBytes.length} bytes, ${lock.chunks.length} chunks, sha256=${sha256hex(lockBytes)}`)
log(`spend tx: ${txHex.length / 2} bytes, txid=${tx.id('hex')}, version=${tx.version}, lockTime=${tx.lockTime}, inputs=${tx.inputs.length}, outputs=${tx.outputs.length}`)
log(`input0: sourceTXID=${tx.inputs[0].sourceTXID} vout=${tx.inputs[0].sourceOutputIndex} sequence=${tx.inputs[0].sequence.toString(16)}`)
log(`output0: ${tx.outputs[0].satoshis} sat, script=${tx.outputs[0].lockingScript.toHex()} (${tx.outputs[0].lockingScript.toASM()})`)
log(`unlock: ${unlock.toBinary().length} bytes, ${unlock.chunks.length} pushes, sizes=[${unlock.chunks.map(c => c.data.length).join(',')}], hex=${unlock.toHex()}`)
const U = decodeUnlock(unlock)
log(`r=${U.r.toString(16)}\ns=${U.s.toString(16)}\nsInv=${U.sInv.toString(16)}\nhashOutputs=${hex(U.hashOutputs)}\noutpoint=${hex(U.outpoint)}`)
check('s*sInv == 1 mod n', mod(U.s * U.sInv, P256_N) === 1n)
check('sInv == s^(n-2) mod n (canonical)', U.sInv === modinv(U.s, P256_N))
check('s is low-S', U.s <= (P256_N - 1n) / 2n)
check('r >= 2^255 (hence 33-byte push)', U.r >= (1n << 255n))

const mkSpend = ({ lockingScript = lock, unlockingScript = unlock, sourceSatoshis = 4600, transactionVersion = tx.version } = {}) => new Spend({
  sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: 0, sourceSatoshis, lockingScript, transactionVersion,
  otherInputs: [], outputs: tx.outputs, unlockingScript, inputSequence: tx.inputs[0].sequence, inputIndex: 0, lockTime: tx.lockTime
})
{
  const times = []
  let ok = false, pc = -1
  for (let i = 0; i < 15; i++) { const sp = mkSpend(); const t0 = performance.now(); ok = sp.validate(); times.push(performance.now() - t0); pc = sp.programCounter }
  check('Spend.validate(fixture) === true', ok === true, `pc=${pc}`)
  log(`validate timing ms: ${fmtms(times)}  (first call ${times[0].toFixed(2)})`)
}

// ───────── 2. interpreter stepping: preimage, e, altstack, max item, checkpoints ─────────
log('\n== 2. interpreter checkpoints (Spend.step)')
{
  const sp = mkSpend()
  const preimage = sighashPreimage({ tx, inputIndex: 0, sourceSatoshis: 4600 })
  const h = Hash.hash256(preimage)
  const eLE = leToBig(h), eBE = beToBig(h)
  let maxItem = { len: 0, pc: -1 }, maxDepth = 0, maxAlt = 0, steps = 0, execOps = 0
  const want = new Set([22, 27, 87, 216, 222, 333, 22640, 22666, 22668, 22736, 23066])
  const snap = {}
  const opCount = {}
  try {
    while (true) {
      const ctx = sp.context, pc = sp.programCounter
      const script = ctx === 'UnlockingScript' ? unlock : lock
      if (pc >= script.chunks.length) { if (ctx === 'UnlockingScript') { sp.step(); continue } else break }
      if (ctx === 'LockingScript' && want.has(pc)) snap[pc] = { depth: sp.stack.length, alt: sp.altStack.map(a => hex(a)), top: sp.stack.slice(-3).map(a => hex(a)), stack0: hex(sp.stack[0] ?? []) }
      const c = script.chunks[pc]
      if (ctx === 'LockingScript' && !c.data && c.op > OP.OP_16) { execOps++; opCount[OP[c.op]] = (opCount[OP[c.op]] ?? 0) + 1 }
      sp.step(); steps++
      for (const it of sp.stack) if (it.length > maxItem.len) maxItem = { len: it.length, pc }
      if (sp.stack.length > maxDepth) maxDepth = sp.stack.length
      if (sp.altStack.length > maxAlt) maxAlt = sp.altStack.length
    }
  } catch (e) { log('STEP ERROR ' + e.message) }
  log(`steps=${steps} (lock chunks executed incl. skipped-branch pushes), executed non-push lock ops (all reached, incl. non-taken branch ops)=${execOps}`)
  log(`final stack: [${sp.stack.map(a => hex(a)).join(',')}]`)
  check('preimage on stack at pc 22 == TransactionSignature.format(subscript ac, scope 0x41)', snap[22].top.at(-1) === hex(preimage), `${preimage.length} B`)
  check('e at pc 27 == unsigned-LE(hash256(preimage))', snap[27].top.at(-1) === hex(scriptNum(eLE)), `e=${eLE.toString(16)}`)
  log(`hash256(preimage)=${hex(h)}  e_p256 (LE view)=${eLE.toString(16)}  e_k1 (BE view)=${eBE.toString(16)}`)
  check('altstack at pc 87 == [preimage, n]', snap[87].alt.length === 2 && snap[87].alt[0] === hex(preimage) && snap[87].alt[1] === hex(scriptNum(P256_N)))
  check('main stack depth at pc 87 == 3 [r,u1\',u2\']', snap[87].depth === 3)
  const u1 = mod(eLE * U.sInv, P256_N), u2 = mod(U.r * U.sInv, P256_N)
  check('u1\' at pc 87 == recode(e*sInv mod n) with 2^258-1', snap[87].top[1] === hex(scriptNum(recode(u1))), `u1=${u1.toString(16)} (${u1 % 2n === 0n ? 'even' : 'odd'})`)
  check('u2\' at pc 87 == recode(r*sInv mod n)', snap[87].top[2] === hex(scriptNum(recode(u2))), `u2=${u2.toString(16)} (${u2 % 2n === 0n ? 'even' : 'odd'})`)
  check('depth at pc 216 == 132 (3 + 128 table + p)', snap[216].depth === 132, `alt=[preimage,n]? ${snap[216].alt[1] === hex(scriptNum(P256_N))}`)
  check('at pc 222 (loop entry): depth 134, alt == [preimage, p], acc (1,1,0)', snap[222].depth === 134 && snap[222].alt[1] === hex(scriptNum(P256_P)) && snap[222].top.join(',') === '01,01,', `top=[${snap[222].top}]`)
  check('at pc 22640 (tail entry): depth 134, stack[0] == r, alt == [preimage, p]', snap[22640].depth === 134 && snap[22640].stack0 === hex(scriptNum(U.r)) && snap[22640].alt.length === 2 && snap[22640].alt[1] === hex(scriptNum(P256_P)))
  check('at pc 22666 (after VERIFY): depth 135', snap[22666].depth === 135)
  check('at pc 22736 (after clear): depth 0, alt == [preimage]', snap[22736].depth === 0 && snap[22736].alt.length === 1 && snap[22736].alt[0] === hex(preimage))
  const sigModel = pushTxSignature(preimage).sig
  check('CHECKSIG signature (stack[-2] at pc 23066) == pushTxSignature(preimage) model', snap[23066].depth === 2 && snap[23066].top.at(-2) === hex(sigModel), `${hex(sigModel)} (${sigModel.length} B)`)
  check('CHECKSIG pubkey == chunk 23064', snap[23066].top.at(-1) === hex(lock.chunks[23064].data))
  log(`max stack item ${maxItem.len} B (first reached at pc ${maxItem.pc}); peak main depth ${maxDepth}; peak alt depth ${maxAlt}`)
  log('reached-op census (top 25): ' + Object.entries(opCount).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}=${v}`).join(' '))
}

// ───────── 3. region map with byte offsets ─────────
log('\n== 3. region map (byte offsets from chunk serialisation)')
const offs = []; { let o = 0; for (const c of lock.chunks) { offs.push(o); o += 1 + (c.data ? (c.op <= 75 ? c.data.length : c.op === 76 ? 1 + c.data.length : c.op === 77 ? 2 + c.data.length : 4 + c.data.length) : 0) } offs.push(o) }
check('sum of chunk sizes == 29584', offs.at(-1) === 29584)
const regions = [
  ['A preimage rebuild', 0, 21], ['B e = LE(hash256)', 22, 28], ['C n, s*sInv==1', 29, 41], ['D u1, u2', 42, 56], ['E drop s,sInv', 57, 62],
  ['F recode u2', 63, 74], ['G recode u1 + SWAP', 75, 86], ['H G comb table', 87, 150], ['I Q comb table', 151, 214], ['J push p', 215, 215],
  ['K pre-loop (alt swap, acc init)', 216, 221], ['L col0 DOUBLE', 222, 332], ['M col0 ADD_G (guarded)', 333, 552], ['N col0 ADD_Q', 553, 757],
  ['O col1 (DOUBLE,ADD_G,ADD_Q)', 758, 1278], ['P cols 2..41', 1279, 22118], ['Q col42 DOUBLE', 22119, 22229], ['R col42 ADD_G', 22230, 22434], ['S col42 ADD_Q', 22435, 22639],
  ['T tail: Z!=0 && X==r*Z^2', 22640, 22665], ['U drop p', 22666, 22667], ['V clear 135 items', 22668, 22735], ['W PUSH_TX: preimage->alt sighash, hash, reverse', 22736, 22863],
  ['X PUSH_TX: e_k1, +2^248, mod n, low-S', 22864, 22894], ['Y PUSH_TX: s -> minimal BE bytes', 22895, 23049], ['Z PUSH_TX: DER assembly + sighash', 23050, 23063], ['AA pubkey, CODESEPARATOR, CHECKSIG', 23064, 23066]
]
for (const [name, a, b] of regions) log(`| ${name} | ${a}–${b} (${b - a + 1}) | ${offs[a]}–${offs[b + 1] - 1} (${offs[b + 1] - offs[a]} B) | first op ${lock.chunks[a].data ? '<' + hex(lock.chunks[a].data).slice(0, 16) + (lock.chunks[a].data.length > 8 ? '..' : '') + '>' : OP[lock.chunks[a].op]}`)
check('tail begins OP_DUP OP_0 OP_NUMEQUAL OP_NOTIF at 22640', [22640, 22641, 22642, 22643].map(i => OP[lock.chunks[i].op]).join(' ') === 'OP_DUP OP_0 OP_NUMEQUAL OP_NOTIF')
check('chunks 22668..22734 are 67x OP_2DROP and 22735 is OP_DROP', lock.chunks.slice(22668, 22735).every(c => c.op === OP.OP_2DROP) && lock.chunks[22735].op === OP.OP_DROP)
check('column-42 ADD_Q ends at 22639 with OP_2 OP_ROLL x3', [22634, 22635, 22636, 22637, 22638, 22639].map(i => OP[lock.chunks[i].op]).join(' ') === 'OP_2 OP_ROLL OP_2 OP_ROLL OP_2 OP_ROLL')
{ // per-column byte sizes
  const colStart = c => 222 + (c === 0 ? 0 : 536 + 521 * (c - 1))
  const sizes = {}
  for (let c = 0; c <= 42; c++) { const a = colStart(c), b = (c === 42 ? 22640 : colStart(c + 1)); const sz = offs[b] - offs[a]; sizes[sz] = (sizes[sz] ?? []).concat(c) }
  log('column byte sizes -> columns: ' + Object.entries(sizes).map(([sz, cs]) => `${sz} B: ${cs.length > 4 ? cs[0] + '..' + cs.at(-1) : cs.join(',')}`).join('; '))
  check('col0 = 536 chunks, cols 1..42 = 521 chunks, col42 ends at 22639', colStart(42) + 521 - 1 === 22639)
}

// ───────── 4. op census / constants ─────────
log('\n== 4. static census and baked constants')
{
  const cnt = {}
  let maxPush = 0, pushes = 0, pushdata = 0
  const pushSizes = {}
  for (const c of lock.chunks) { if (c.data) { pushes++; maxPush = Math.max(maxPush, c.data.length); pushSizes[c.data.length] = (pushSizes[c.data.length] ?? 0) + 1; if (c.op >= 76 && c.op <= 78) pushdata++ } else cnt[OP[c.op]] = (cnt[OP[c.op]] ?? 0) + 1 }
  log(`data pushes=${pushes} (largest ${maxPush} B, PUSHDATA1/2/4 used: ${pushdata}); push-size histogram: ${Object.entries(pushSizes).map(([k, v]) => k + 'B×' + v).join(' ')}`)
  log('static opcode counts: ' + Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '))
  const divs = lock.chunks.map((c, i) => c.op === OP.OP_DIV && !c.data ? i : -1).filter(i => i >= 0)
  check('OP_DIV at exactly chunks 73, 85, 22876, 22884', divs.join(',') === '73,85,22876,22884', divs.join(','))
  check('OP_RSHIFTNUM count == 516 (43 cols × 12)', cnt.OP_RSHIFTNUM === 516, String(cnt.OP_RSHIFTNUM))
  check('OP_HASH256 count == 4 (hashPrevouts, hashSequence, e, PUSH_TX)', cnt.OP_HASH256 === 4, String(cnt.OP_HASH256))
  check('OP_CHECKSIG count == 1, OP_CODESEPARATOR == 1', cnt.OP_CHECKSIG === 1 && cnt.OP_CODESEPARATOR === 1)
  const nSm = hex(scriptNum(P256_N)), pSm = hex(scriptNum(P256_P)), rc = hex(scriptNum((1n << 258n) - 1n))
  check('chunks 29, 67, 79 == P-256 n (33 B)', [29, 67, 79].every(i => hex(lock.chunks[i].data) === nSm), nSm)
  check('chunks 70, 82 == 2^258-1 (ff×32 03), NOT 2^254-1', [70, 82].every(i => hex(lock.chunks[i].data) === rc), rc)
  check('chunk 215 == P-256 p (33 B)', hex(lock.chunks[215].data) === pSm, pSm)
  check('chunk 22873 == secp256k1 n (33 B)', hex(lock.chunks[22873].data) === hex(scriptNum(SECP_N)))
  check('chunk 23053 == 02 20 Gx_secp256k1 02 (35 B)', hex(lock.chunks[23053].data) === '0220' + SECP_GX.toString(16).padStart(64, '0') + '02')
  const d = mod((1n << 248n) * modinv(SECP_GX, SECP_N), SECP_N)
  const pub = new PrivateKey(d.toString(16), 16).toPublicKey().toDER()
  check('chunk 23064 pubkey == (2^248 * Gx^-1 mod n_k1) * G', hex(lock.chunks[23064].data) === (typeof pub === 'string' ? pub : hex(pub)), `d=${d.toString(16)}`)
  check('chunk 12 amount == f811000000000000 (4600 sat LE64)', hex(lock.chunks[12].data) === 'f811000000000000')
  check('chunk 2 version 01000000, chunk 5/14 ffffffff, chunk 18 locktime 00000000, chunk 20 sighash 41000000, chunk 10 scriptCode 01ac', hex(lock.chunks[2].data) === '01000000' && hex(lock.chunks[5].data) === 'ffffffff' && hex(lock.chunks[14].data) === 'ffffffff' && hex(lock.chunks[18].data) === '00000000' && hex(lock.chunks[20].data) === '41000000' && hex(lock.chunks[10].data) === '01ac')
  // comb tables
  const Q = p256.Point.fromHex('03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d')
  const TG = combTable(p256.Point.BASE), TQ = combTable(Q)
  let okG = true, okQ = true
  for (let j = 0; j < 32; j++) {
    okG &&= hex(lock.chunks[87 + 2 * j].data) === hex(scriptNum(TG[j].x)) && hex(lock.chunks[88 + 2 * j].data) === hex(scriptNum(TG[j].y))
    okQ &&= hex(lock.chunks[151 + 2 * j].data) === hex(scriptNum(TQ[j].x)) && hex(lock.chunks[152 + 2 * j].data) === hex(scriptNum(TQ[j].y))
  }
  check('chunks 87..150 == comb table of G (x,y per entry j)', okG)
  check('chunks 151..214 == comb table of Q = 03f4d6..5a7d', okQ)
  const tsz = {}; for (let i = 87; i <= 214; i++) tsz[lock.chunks[i].data.length] = (tsz[lock.chunks[i].data.length] ?? 0) + 1
  log(`table coordinate push sizes: ${JSON.stringify(tsz)}; G table bytes ${offs[151] - offs[87]}, Q table bytes ${offs[215] - offs[151]}`)
}

// ───────── 5. gen.mjs byte-exact ─────────
log('\n== 5. gen.mjs regeneration')
{
  const t0 = performance.now()
  const g = buildLock({ qCompressedHex: '03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d', satoshis: 4600 })
  const ms = performance.now() - t0
  check('buildLock(fixture Q, 4600) byte-identical to fixture', g.toHex() === lockHex, `${g.toBinary().length} B / ${g.chunks.length} chunks in ${ms.toFixed(0)} ms, sha256=${sha256hex(g.toBinary())}`)
  const sp = mkSpend({ lockingScript: g }); check('fixture unlock validates against generated lock', sp.validate() === true, `pc=${sp.programCounter}`)
  const sp2 = mkSpend({ lockingScript: g, sourceSatoshis: 4601 }); let ok2 = null, err2 = ''; try { ok2 = sp2.validate() } catch (e) { err2 = e.message.split('\n')[0] }
  check('sourceSatoshis 4601 (real preimage differs from in-script) fails at final CHECKSIG', ok2 !== true && sp2.programCounter === 23067, `pc=${sp2.programCounter} ${err2}`)
}

// ───────── 6. PUSH_TX predicate boundary table ─────────
log('\n== 6. PUSH_TX peel-loop predicate (pure JS model; interpreter agreement established in edge.mjs / edge_sweep.mjs)')
{
  const preimage = sighashPreimage({ tx, inputIndex: 0, sourceSatoshis: 4600 })
  const chk = pushTxDerCheck(preimage)
  const { s, sDer } = pushTxSignature(preimage)
  log(`fixture: s_k1=${s.toString(16)} sDer len=${sDer.length} ok=${chk.ok} reason=${chk.reason}`)
  const rows = []
  for (const [label, v] of [['2^255-1', (1n << 255n) - 1n], ['(n_k1-1)/2', (SECP_N - 1n) / 2n], ['2^248', 1n << 248n], ['2^248-1', (1n << 248n) - 1n], ['2^247', 1n << 247n], ['2^247-1', (1n << 247n) - 1n], ['2^240', 1n << 240n], ['2^240-1', (1n << 240n) - 1n], ['2^239', 1n << 239n], ['2^239-1', (1n << 239n) - 1n], ['2^232', 1n << 232n], ['2^231', 1n << 231n], ['2^8-1', 255n], ['2^7', 128n], ['2^7-1', 127n], ['1', 1n]]) {
    const sm = scriptNum(v); const k = peelLoopNonMinimalAt(sm)
    rows.push(`| ${label} | scriptnum ${sm.length} B (sign byte ${sm.length && (sm.at(-1) === 0) ? 'yes' : 'no'}) | DER INTEGER ${sm.length} B | peel fail at k=${k} -> ${k >= 0 ? 'REJECT' : 'ok'} |`)
  }
  log(rows.join('\n'))
}

// ───────── 7. gen2 sizes, layout, end-to-end spend, hardened ─────────
log('\n== 7. gen2 (1-of-N commit-to-table) sizes and one end-to-end spend')
{
  const randSalt = () => Uint8Array.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)))
  const members = [...Array(5)].map(() => { const priv = p256.utils.randomSecretKey(); return { priv, q: hex(p256.getPublicKey(priv, true)), salt: randSalt() } })
  const comms = members.map(m => commitmentFor({ qCompressedHex: m.q, salt: m.salt }))
  const locks = []
  for (let N = 1; N <= 5; N++) { const t0 = performance.now(); const l = buildLock2({ commitments: comms.slice(0, N) }); locks.push(l); log(`N=${N}: lock ${l.toBinary().length} B / ${l.chunks.length} chunks (build ${(performance.now() - t0).toFixed(1)} ms)`) }
  check('lock bytes: N=1 27855 (H5 = <C> EQUALVERIFY 22 B); N>=2: 27831 + 25N (H5 = 25N-2 B); chunks N=1 23310, N>=2 23306 + 5N', locks.every((l, i) => { const N = i + 1; return l.toBinary().length === (N === 1 ? 27855 : 27831 + 25 * N) && l.chunks.length === (N === 1 ? 23310 : 23306 + 5 * N) }))
  const L = layout2(locks[0]); log('layout2(N=1):'); for (const r of L.regions) log(`| ${r.name} | ${r.chunks[0]}–${r.chunks[1]} (${r.chunks[1] - r.chunks[0] + 1}) | ${r.bytes[0]}–${r.bytes[1]} (${r.size} B) |`)
  const gTail = hex(lock.toBinary().slice(offs[87], offs[151])) + hex(lock.toBinary().slice(offs[215]))
  const gStart = L.regions.find(r => r.name.startsWith('G table')).chunks[0]
  const l1 = locks[0].toBinary(); const l1offs = []; { let o = 0; for (const c of locks[0].chunks) { l1offs.push(o); o += 1 + (c.data ? c.data.length + (c.op <= 75 ? 0 : c.op === 76 ? 1 : c.op === 77 ? 2 : 4) : 0) } }
  check('gen2 [G table .. end] byte-identical to fixture chunks [87..150] ++ [215..end]', hex(l1.slice(l1offs[gStart])) === gTail, `${l1.length - l1offs[gStart]} B`)
  // end-to-end spend at N=2, signer = member 1
  const lockN2 = locks[1]
  const src = new Transaction(); src.addOutput({ satoshis: 50_000, lockingScript: lockN2 })
  const t = new Transaction(1, [], [], 0)
  t.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence: 0xfffffffe })
  t.addOutput({ satoshis: 49_000, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
  const m = members[1]
  const tu0 = performance.now()
  const u2 = buildUnlock2({ tx: t, inputIndex: 0, sourceSatoshis: 50_000, lockingScript: lockN2, p256PrivateKey: m.priv, salt: m.salt })
  const tu1 = performance.now()
  t.inputs[0].unlockingScript = u2
  const sp = new Spend({ sourceTXID: src.id('hex'), sourceOutputIndex: 0, sourceSatoshis: 50_000, lockingScript: lockN2, transactionVersion: 1, otherInputs: [], outputs: t.outputs, unlockingScript: u2, inputSequence: 0xfffffffe, inputIndex: 0, lockTime: 0 })
  const tv0 = performance.now(); const okv = sp.validate(); const tv1 = performance.now()
  check('gen2 N=2 spend by member 1 (sequence fffffffe, 50000 sat, not baked) validates', okv === true, `pc=${sp.programCounter} unlock ${u2.toBinary().length} B / ${u2.chunks.length} pushes, tx ${t.toBinary().length} B, buildUnlock2 ${(tu1 - tu0).toFixed(0)} ms, validate ${(tv1 - tv0).toFixed(1)} ms`)
  const sizes = u2.chunks.map(c => c.data?.length ?? 0); log(`unlock2 push sizes: r=${sizes[0]} u2'=${sizes[1]} u1'=${sizes[2]} table[64]=${JSON.stringify(sizes.slice(3, 67).reduce((a, s) => (a[s] = (a[s] ?? 0) + 1, a), {}))} salt=${sizes[67]} s=${sizes[68]} sInv=${sizes[69]} preimage=${sizes[70]}`)
  let refused = null; try { buildUnlock2({ tx: t, inputIndex: 0, sourceSatoshis: 50_000, lockingScript: lockN2, p256PrivateKey: members[3].priv, salt: members[3].salt }) } catch (e) { refused = e.code }
  check('uncommitted member refused before signing (NOT_COMMITTED)', refused === 'NOT_COMMITTED')
  const hl = buildLock2Hardened({ commitments: comms.slice(0, 2) })
  check('hardened N=2 lock == gen2 N=2 + 116 B / +17 chunks', hl.toBinary().length === lockN2.toBinary().length + 116 && hl.chunks.length === lockN2.chunks.length + 17, `${hl.toBinary().length} B / ${hl.chunks.length} chunks`)
}

// ───────── 8. async signer ordering ─────────
log('\n== 8. external-signer ordering (does the signer get called before the guards / PUSH_TX screen?)')
{
  const order = []
  const wrongKeyLock = buildLock({ qCompressedHex: hex(p256.getPublicKey(p256.utils.randomSecretKey(), true)), satoshis: 4600 })
  let err = null
  try { await buildUnlockAsync({ tx, inputIndex: 0, sourceSatoshis: 4600, lockingScript: wrongKeyLock, Q: '03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d', signDigest: d => { order.push('signDigest'); return p256.sign(d, p256.utils.randomSecretKey(), { prehash: false }) } }) } catch (e) { order.push('throw:' + e.message.slice(0, 60)); err = e }
  check('unlock.mjs buildUnlockAsync calls signDigest BEFORE any guard (defect still present)', order[0] === 'signDigest' && err, order.join(' -> '))
  const order2 = []
  const l2 = buildLock2({ commitments: [commitmentFor({ qCompressedHex: hex(p256.getPublicKey(p256.utils.randomSecretKey(), true)), salt: new Uint8Array(32) })] })
  const src = new Transaction(); src.addOutput({ satoshis: 5000, lockingScript: l2 })
  const t = new Transaction(1, [], [], 0); t.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence: 0xffffffff }); t.addOutput({ satoshis: 4000, lockingScript: Script.fromASM('OP_1') })
  const other = p256.utils.randomSecretKey()
  try { await buildUnlock2Async({ tx: t, inputIndex: 0, sourceSatoshis: 5000, lockingScript: l2, qCompressedHex: hex(p256.getPublicKey(other, true)), salt: new Uint8Array(32), signDigest: d => { order2.push('signDigest'); return p256.sign(d, other, { prehash: false }) } }) } catch (e) { order2.push('throw:' + (e.code ?? e.message.slice(0, 40))) }
  check('unlock2.mjs buildUnlock2Async also calls signDigest BEFORE the commitment guard and PUSH_TX screen', order2[0] === 'signDigest' && order2[1]?.startsWith('throw:NOT_COMMITTED'), order2.join(' -> '))
}

// ───────── 9. version gating in the SDK ─────────
log('\n== 9. SDK flag gating (source read + probe)')
{
  const src = fs.readFileSync(`${REPO}/node_modules/@bsv/sdk/dist/esm/src/script/Spend.js`, 'utf8')
  const relaxed = src.match(/isRelaxed\s*\([^)]*\)\s*{[^}]*}/)?.[0]?.replace(/\s+/g, ' ')
  const minimal = src.match(/shouldEnforceMinimalData\s*\([^)]*\)\s*{[^}]*}/)?.[0]?.replace(/\s+/g, ' ')
  log(`Spend.js isRelaxed: ${relaxed}`); log(`Spend.js shouldEnforceMinimalData: ${minimal}`)
  // probe: a non-minimal number operand under v1 vs v2
  const mk = (v) => new Spend({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, sourceSatoshis: 1, lockingScript: LockingScript.fromASM('OP_1 OP_MUL 11 OP_NUMEQUAL'), transactionVersion: v, otherInputs: [], outputs: [], unlockingScript: UnlockingScript.fromHex('021100'), inputSequence: 0xffffffff, inputIndex: 0, lockTime: 0 })
  let r1 = null, e1 = ''; try { r1 = mk(1).validate() } catch (e) { e1 = e.message.split('\n')[0] }
  let r2 = null, e2 = ''; try { r2 = mk(2).validate() } catch (e) { e2 = e.message.split('\n')[0] }
  check('non-minimal number <1100> rejected under tx version 1, accepted under version 2', r1 !== true && /non-minimally/.test(e1) && r2 === true, `v1: ${e1} | v2: ${r2}`)
  const spv2 = mkSpend({ transactionVersion: 2 }); let okv2 = null, ev2 = ''; try { okv2 = spv2.validate() } catch (e) { ev2 = e.message.split('\n')[0] }
  check('fixture evaluated as a version-2 tx fails only at the final CHECKSIG (version baked as 1)', okv2 !== true && spv2.programCounter === 23067, `pc=${spv2.programCounter} ${ev2}`)
}

log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`)
fs.writeFileSync(`${S}/consolidate-verify.out.txt`, out.join('\n') + '\n')
process.exitCode = fails ? 1 : 0
