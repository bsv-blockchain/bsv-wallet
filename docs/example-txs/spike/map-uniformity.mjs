// map-uniformity.mjs — structural diff of the R1 comb-verifier locking script.
// Establishes byte-exact generator rules: column template, shift(c,k), col0 identity guard,
// constants encoding, big pushes, and writes skeleton.json; then REGENERATES the whole script
// from the skeleton and asserts byte equality with the fixture + Spend.validate()===true.
import fs from 'fs'
import { OP, BigNumber, Spend, Transaction, LockingScript } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'

const S = process.env.S || '/private/tmp/claude-502/-Users-personal-git-bsv-wallet/a954ef08-e7c5-49e3-8a72-1cd73ad1d771/scratchpad'
const REPO = '/Users/personal/git/bsv-wallet'
const lockHex = fs.readFileSync(REPO + '/docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex', 'utf8').trim()
const bytes = Buffer.from(lockHex, 'hex')
const hex = b => Buffer.from(b).toString('hex')
const out = []
const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s) }
const assert = (cond, msg) => { if (!cond) { log('ASSERT FAILED: ' + msg); process.exitCode = 1 } else log('OK: ' + msg) }

// ---------- 1. parse raw chunks (with exact raw bytes) ----------
const chunks = []
{
  let off = 0
  while (off < bytes.length) {
    const op = bytes[off]; let len = 1; let data = null
    if (op >= 1 && op <= 75) { data = bytes.subarray(off + 1, off + 1 + op); len = 1 + op }
    else if (op === 76) { const n = bytes[off + 1]; data = bytes.subarray(off + 2, off + 2 + n); len = 2 + n }
    else if (op === 77) { const n = bytes.readUInt16LE(off + 1); data = bytes.subarray(off + 3, off + 3 + n); len = 3 + n }
    else if (op === 78) { const n = bytes.readUInt32LE(off + 1); data = bytes.subarray(off + 5, off + 5 + n); len = 5 + n }
    chunks.push({ i: chunks.length, off, len, op, data, raw: bytes.subarray(off, off + len) })
    off += len
  }
}
assert(bytes.length === 29584, `script is 29584 bytes (got ${bytes.length})`)
assert(chunks.length === 23067, `23067 chunks (got ${chunks.length})`)
const name = c => c.data ? `<${hex(c.data)}>` : (OP[c.op] ?? '0x' + c.op.toString(16))
const rawHex = c => hex(c.raw)

// ---------- helpers: minimal script-number encoding ----------
// encNum(v: bigint) -> Buffer of the full push (opcode + data) using the minimal-encoding rule
function encNum (v) {
  v = BigInt(v)
  if (v === 0n) return Buffer.from([0x00])
  if (v >= 1n && v <= 16n) return Buffer.from([0x50 + Number(v)])
  if (v === -1n) return Buffer.from([0x4f])
  const neg = v < 0n; let m = neg ? -v : v
  const b = []
  while (m > 0n) { b.push(Number(m & 0xffn)); m >>= 8n }
  if (b[b.length - 1] & 0x80) b.push(neg ? 0x80 : 0x00)
  else if (neg) b[b.length - 1] |= 0x80
  return pushData(Buffer.from(b))
}
function pushData (d) {
  if (d.length <= 75) return Buffer.concat([Buffer.from([d.length]), d])
  if (d.length <= 255) return Buffer.concat([Buffer.from([76, d.length]), d])
  const h = Buffer.alloc(3); h[0] = 77; h.writeUInt16LE(d.length, 1); return Buffer.concat([h, d])
}
// decNum(chunk) -> bigint (script number semantics)
function decNum (c) {
  if (!c.data) {
    if (c.op === 0) return 0n
    if (c.op >= 0x51 && c.op <= 0x60) return BigInt(c.op - 0x50)
    if (c.op === 0x4f) return -1n
    throw new Error('not a number chunk: ' + name(c))
  }
  const d = Buffer.from(c.data); if (d.length === 0) return 0n
  const neg = (d[d.length - 1] & 0x80) !== 0
  const m = Buffer.from(d); m[m.length - 1] &= 0x7f
  let v = 0n; for (let i = m.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(m[i])
  return neg ? -v : v
}
const bigToHex = (v, w = 64) => v.toString(16).padStart(w, '0')

// ---------- 2. column segmentation ----------
const RSHIFTNUM = 0xb7
// A = task's segmentation: col0=333..868, col c = 869+521(c-1) .. +520  ([add][add][double])
// B = semantic segmentation: col0=222..757, col c = 758+521(c-1) .. +520 ([double][add][add])
const segA = c => c === 0 ? [333, 536] : [869 + 521 * (c - 1), 521]
const segB = c => c === 0 ? [222, 536] : [758 + 521 * (c - 1), 521]
function normalized (start, len) {
  const t = []
  for (let i = start; i < start + len; i++) {
    const c = chunks[i]
    if (i + 1 < chunks.length && chunks[i + 1].op === RSHIFTNUM && !chunks[i + 1].data) t.push({ kind: 'SHIFT', value: decNum(c), raw: rawHex(c), i })
    else t.push({ kind: 'RAW', raw: rawHex(c), i })
  }
  return t
}
function compareTemplates (segFn, label) {
  log(`\n=== Template comparison, segmentation ${label} ===`)
  const t1 = normalized(...segFn(1))
  let allSame = true; const diffs = []
  for (let c = 2; c <= 42; c++) {
    const tc = normalized(...segFn(c))
    for (let k = 0; k < t1.length; k++) {
      const a = t1[k], b = tc[k]
      if (a.kind !== b.kind) { diffs.push({ c, k, chunk: b.i, a: a.kind === 'SHIFT' ? 'SHIFT' : name(chunks[a.i]), b: b.kind === 'SHIFT' ? 'SHIFT' : name(chunks[b.i]) }); allSame = false; continue }
      if (a.kind === 'RAW' && a.raw !== b.raw) { diffs.push({ c, k, chunk: b.i, a: name(chunks[a.i]), b: name(chunks[b.i]) }); allSame = false }
    }
  }
  log(`cols 2..42 normalized-template identical to col1: ${allSame}; kind/raw mismatches: ${diffs.length}`)
  for (const d of diffs.slice(0, 40)) log(`  MISMATCH col${d.c} pos${d.k} chunk${d.chunk}: col1=${d.a} vs ${d.b}`)
  return { t1, allSame, diffs }
}
const resA = compareTemplates(segA, 'A (task: col c = 869+521(c-1), [add][add][double])')
const resB = compareTemplates(segB, 'B (col c = 758+521(c-1), [double][addG][addQ])')

// Raw (un-normalized) diff positions: which positions differ at all between columns (should be only SHIFT positions)
function rawDiffPositions (segFn) {
  const t1 = normalized(...segFn(1)); const pos = new Set()
  for (let c = 2; c <= 42; c++) { const tc = normalized(...segFn(c)); for (let k = 0; k < t1.length; k++) if (t1[k].raw !== tc[k].raw) pos.add(k) }
  return { pos: [...pos].sort((a, b) => a - b), shiftPos: t1.map((x, k) => x.kind === 'SHIFT' ? k : -1).filter(k => k >= 0) }
}
{
  const { pos, shiftPos } = rawDiffPositions(segB)
  log(`\nRaw-byte differing positions within column template (seg B): [${pos.join(',')}]`)
  log(`SHIFT placeholder positions in template (seg B): [${shiftPos.join(',')}]`)
  assert(pos.every(p => shiftPos.includes(p)), 'every raw-differing position across cols 1..42 is a SHIFT constant position')
}

// ---------- 3. shift(c,k) and its encoding ----------
log('\n=== shift constants ===')
const shiftTable = [] // {c, half(0=G/u1,1=Q/u2), k, value, encHex}
let formulaOK = true, encodingOK = true
for (let c = 0; c <= 42; c++) {
  const [start, len] = segB(c)
  const t = normalized(start, len)
  const shifts = t.filter(x => x.kind === 'SHIFT')
  if (shifts.length !== 12) { log(`col${c}: ${shifts.length} shift constants (expected 12)`); formulaOK = false }
  shifts.forEach((s, idx) => {
    const half = idx < 6 ? 0 : 1, k = idx % 6
    const expect = BigInt(257 - c - 43 * k)
    if (s.value !== expect) { formulaOK = false; log(`  col${c} half${half} k${k}: value ${s.value} != 257-c-43k=${expect}`) }
    const enc = hex(encNum(s.value))
    if (enc !== s.raw) { encodingOK = false; log(`  col${c} half${half} k${k}: raw ${s.raw} != minimal ${enc}`) }
    shiftTable.push({ c, half, k, value: Number(s.value), raw: s.raw })
  })
}
assert(formulaOK, 'shift(c,k) = 257 - c - 43*k for k=0..5, identical for both halves (u1/G then u2/Q), all 43 columns')
assert(encodingOK, 'every shift constant is minimally encoded (0->OP_0, 1..16->OP_N, 17..127 -> 1-byte push, 128..255 -> 2-byte push with 0x00 sign byte, >=256 -> 2-byte push)')
// Encoding class census
{
  const cls = {}
  for (const s of shiftTable) { const k = s.raw.length === 2 ? (s.raw === '00' ? 'OP_0' : 'OP_N') : s.raw.length === 4 ? 'PUSH1' : 'PUSH2'; cls[k] = (cls[k] || 0) + 1 }
  log('shift encoding census (all 516 constants): ' + JSON.stringify(cls))
  const opn = shiftTable.filter(s => s.raw.length === 2)
  log('OP_0/OP_N-encoded shifts (c,k,value): ' + opn.filter(s => s.half === 0).map(s => `(${s.c},${s.k},${s.value})`).join(' '))
  const push2 = shiftTable.filter(s => s.raw.length === 6 && s.half === 0)
  log('2-byte-encoded shifts (c,k,value) half0: ' + push2.map(s => `(${s.c},${s.k},${s.value})`).join(' '))
}
// Explicit list of template positions that are NOT identical across cols 1..42 (seg B), with explanation
{
  const t1 = normalized(...segB(1))
  log('\nPositions where cols 1..42 are not byte-identical (seg B), with per-column encodings:')
  for (const k of rawDiffPositions(segB).pos) {
    const encs = {}
    for (let c = 1; c <= 42; c++) { const tc = normalized(...segB(c)); const r = tc[k].raw; encs[r] = (encs[r] || 0) + 1 }
    const idx = t1.filter((x, j) => x.kind === 'SHIFT' && j <= k).length - 1
    const classes = Object.entries(encs).reduce((a, [r, n]) => { const cls = r.length === 2 ? (r === '00' ? 'OP_0' : 'OP_N') : r.length === 4 ? 'PUSH1' : 'PUSH2'; a[cls] = (a[cls] || 0) + n; return a }, {})
    log(`  pos ${k} (chunk ${t1[k].i} in col1) = SHIFT half${idx < 6 ? 0 : 1} k=${idx % 6}: ${Object.keys(encs).length} distinct encodings across 42 cols; column counts per encoding class: ${JSON.stringify(classes)}`)
  }
}

// ---------- 4. column internal structure: DOUBLE / ADD_G / ADD_Q ----------
log('\n=== column internals (seg B) ===')
const DOUBLE_LEN = 111, ADD_LEN = 205, GUARD_EXTRA = 15
// doubling: 222..332 (pre-loop) must equal 758..868, 1279..1389, ... (all 43 occurrences raw-identical)
const dbl0 = chunks.slice(222, 222 + DOUBLE_LEN).map(rawHex).join(' ')
let dblSame = true
for (let c = 1; c <= 42; c++) { const [s] = segB(c); if (chunks.slice(s, s + DOUBLE_LEN).map(rawHex).join(' ') !== dbl0) { dblSame = false; log(`doubling differs in col${c}`) } }
assert(dblSame, 'DOUBLE block (111 chunks, no parameters) is raw-identical in all 43 columns')
// ADD_G template (col1: 869..1073), ADD_Q (1074..1278) — check ADD_Q == ADD_G with depth substitutions
const addG = chunks.slice(869, 869 + ADD_LEN), addQ = chunks.slice(1074, 1074 + ADD_LEN)
{
  let ok = true; const subs = []
  for (let k = 0; k < ADD_LEN; k++) {
    const a = addG[k], b = addQ[k]
    if (rawHex(a) === rawHex(b)) continue
    if (chunks[a.i + 1].op === RSHIFTNUM) { ok = false; log(`ADD_Q shift differs at k=${k}?!`); continue }
    subs.push(`k${k}: ${name(a)}(${decNum(a)}) -> ${name(b)}(${decNum(b)})`)
  }
  log('ADD_G -> ADD_Q substitutions (non-shift): ' + subs.join('; '))
  // verify: every non-shift diff is a depth constant: 132->131, 133->132, 134->133 (scalar pick), 132->68 (table base)
  const okSubs = subs.every(s => /\(132\) -> .*\(131\)|\(133\) -> .*\(132\)|\(134\) -> .*\(133\)|\(132\) -> .*\(68\)/.test(s))
  assert(ok && okSubs, 'ADD_Q == ADD_G with only depth-constant substitutions (scalar depth 132/133/134 -> 131/132/133; table base 132 -> 68)')
}
// Parametrized ADD template: positions of parameters within the 205-chunk block
const addParams = [] // {k, role}
for (let k = 0; k < ADD_LEN; k++) {
  const a = addG[k]
  if (chunks[a.i + 1].op === RSHIFTNUM && !chunks[a.i + 1].data) { addParams.push({ k, role: 'SHIFT', rowK: addParams.filter(p => p.role === 'SHIFT').length }); continue }
  if (rawHex(a) !== rawHex(addQ[k])) addParams.push({ k, role: decNum(a) === 132n && decNum(addQ[k]) === 68n ? 'BASE' : 'DEPTH', valG: Number(decNum(a)), valQ: Number(decNum(addQ[k])) })
}
log('ADD template parameter slots: ' + addParams.map(p => `${p.k}:${p.role}${p.role === 'SHIFT' ? p.rowK : '(' + p.valG + '/' + p.valQ + ')'}`).join(' '))
// Depth constants across ALL columns and both halves (PICK operand pushes = chunk before OP_PICK)
{
  const depthByHalf = { 0: new Set(), 1: new Set() }
  for (let c = 0; c <= 42; c++) {
    const [s] = segB(c); const guard = c === 0 ? GUARD_EXTRA : 0
    const addStarts = [s + DOUBLE_LEN, s + DOUBLE_LEN + ADD_LEN + guard]
    addStarts.forEach((as, half) => {
      const len = ADD_LEN + (half === 0 ? guard : 0)
      for (let i = as; i < as + len; i++) if (chunks[i + 1] && chunks[i + 1].op === OP.OP_PICK && !chunks[i + 1].data && chunks[i].data) depthByHalf[half].add(Number(decNum(chunks[i])))
    })
  }
  log(`multi-byte OP_PICK depth operands, half0 (u1/G): {${[...depthByHalf[0]].sort((a, b) => a - b).join(',')}} half1 (u2/Q): {${[...depthByHalf[1]].sort((a, b) => a - b).join(',')}}`)
  // table-base constants: the push preceding "OP_SWAP OP_SUB OP_PICK"
  const baseByHalf = { 0: new Set(), 1: new Set() }
  for (let c = 0; c <= 42; c++) {
    const [s, l] = segB(c); const guard = c === 0 ? GUARD_EXTRA : 0; const splitQ = s + DOUBLE_LEN + ADD_LEN + guard
    for (let i = s; i < s + l - 3; i++) if (chunks[i].data && chunks[i + 1].op === OP.OP_SWAP && chunks[i + 2].op === OP.OP_SUB && chunks[i + 3].op === OP.OP_PICK) baseByHalf[i < splitQ ? 0 : 1].add(Number(decNum(chunks[i])))
  }
  log(`table-base constants (push before SWAP SUB PICK), half0: {${[...baseByHalf[0]].join(',')}} half1: {${[...baseByHalf[1]].join(',')}}`)
  const eq = (set, arr) => [...set].sort((a, b) => a - b).join() === arr.join()
  assert(eq(depthByHalf[0], [132, 133, 134]) && eq(depthByHalf[1], [131, 132, 133]) && eq(baseByHalf[0], [132]) && eq(baseByHalf[1], [68]),
    'PICK depth constants are column-invariant: half0 scalar picks 0x84,0x85,0x86 + table base 0x84; half1 scalar picks 0x83,0x84,0x85 + table base 0x44 (68)')
}

// ---------- 5. col0 vs template diff (LCS) ----------
log('\n=== col0 diff vs template ===')
function lcsDiff (a, b) { // a,b arrays of strings; returns ops [{type:'=', ai, bi}|{type:'+', ai}|{type:'-', bi}]
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const ops = []; let i = 0, j = 0
  while (i < n && j < m) { if (a[i] === b[j]) { ops.push({ type: '=', ai: i, bi: j }); i++; j++ } else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: '+', ai: i }); i++ } else { ops.push({ type: '-', bi: j }); j++ } }
  while (i < n) ops.push({ type: '+', ai: i++ }); while (j < m) ops.push({ type: '-', bi: j++ })
  return ops
}
{
  const key = x => x.kind === 'SHIFT' ? 'SHIFT' : x.raw
  const col0 = normalized(...segB(0)), tpl = normalized(...segB(1))
  const ops = lcsDiff(col0.map(key), tpl.map(key))
  const extra = ops.filter(o => o.type === '+'), missing = ops.filter(o => o.type === '-')
  log(`col0 (536) vs template col1 (521): ${extra.length} chunks only in col0, ${missing.length} chunks only in template`)
  for (const o of extra) { const c = chunks[col0[o.ai].i]; log(`  col0-only chunk ${c.i} @${c.off} (template pos before insert ${ops.filter(p => p.type === '=' && p.ai < o.ai).length}): ${name(c)}`) }
  for (const o of missing) log(`  template-only pos ${o.bi} chunk ${tpl[o.bi].i}: ${name(chunks[tpl[o.bi].i])}`)
  assert(extra.length === GUARD_EXTRA && missing.length === 0, 'col0 = template + 15 inserted chunks (identity guard), nothing removed/changed')
  // structural: guard prefix (14) inserted after the y-negation ENDIF of ADD_G, ENDIF (1) inserted at end of ADD_G body
  const guardPrefix = extra.slice(0, 14).map(o => name(chunks[col0[o.ai].i])).join(' ')
  const guardSuffix = extra.slice(14).map(o => name(chunks[col0[o.ai].i])).join(' ')
  log('guard prefix: ' + guardPrefix); log('guard suffix: ' + guardSuffix)
  const prefixAt = extra[0].ai, suffixAt = extra[14].ai
  log(`guard prefix inserted at col0 offset ${prefixAt} (chunk ${222 + prefixAt}), i.e. ADD_G offset ${prefixAt - DOUBLE_LEN}; previous chunk = ${name(chunks[222 + prefixAt - 1])}; suffix at col0 offset ${suffixAt} (chunk ${222 + suffixAt}), ADD_G offset ${suffixAt - 14 - DOUBLE_LEN} of 205; next chunk = ${name(chunks[222 + suffixAt + 1])}`)
}

// ---------- 6. constants region 87..214 ----------
log('\n=== constants 87..214 ===')
const Qhex = '03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d'
const G = p256.Point.BASE, Q = p256.Point.fromBytes(Buffer.from(Qhex, 'hex')), N = p256.Point.CURVE ? p256.Point.CURVE().n : p256.CURVE.n
const nP256 = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const pP256 = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
function tableScalar (j) { let s = 1n << 215n; for (let k = 0; k < 5; k++) s += ((j >> k) & 1) ? (1n << BigInt(43 * k)) : -(1n << BigInt(43 * k)); return ((s % nP256) + nP256) % nP256 }
{
  let ok = true, encOK = true, signByte = 0, lt248 = 0, orderOK = true
  const coords = []
  for (let j = 0; j < 64; j++) {
    const base = j < 32 ? G : Q, pt = base.multiply(tableScalar(j & 31))
    const cx = chunks[87 + 2 * j], cy = chunks[88 + 2 * j]
    const x = decNum(cx), y = decNum(cy)
    if (x !== pt.x || y !== pt.y) { ok = false; log(`  point ${j} mismatch`) }
    for (const [c, v] of [[cx, x], [cy, y]]) {
      if (hex(encNum(v)) !== rawHex(c)) { encOK = false; log(`  chunk ${c.i} not minimal encoding`) }
      if (c.data.length === 33) signByte++
      if (v < (1n << 248n)) lt248++
      coords.push({ chunk: c.i, len: c.data.length, topByte: c.data[c.data.length - 1] })
    }
  }
  assert(ok, 'chunks 87..214 = x,y of table entry j for j=0..31 of G (pts 0..31) then Q (pts 32..63), scalar_j = 2^215 + sum_k (bit_k(j)?+1:-1)*2^(43k)  [noble p256]')
  assert(encOK, 'every coordinate push equals BigNumber-minimal LE sign-magnitude (toSm little): 32 bytes if top byte < 0x80, 33 bytes (trailing 0x00) if top byte >= 0x80')
  log(`coordinates with sign byte (33B): ${signByte}/128; coordinates < 2^248 (would be <32B under minimal rule): ${lt248}`)
  const minTop = Math.min(...coords.filter(c => c.len === 32).map(c => c.topByte))
  log(`smallest top byte among 32-byte coordinates: 0x${minTop.toString(16)} (chunk ${coords.find(c => c.topByte === minTop && c.len === 32).chunk}) -> no fixture evidence for the <2^248 case; generator must decide (minimal rule recommended, see notes)`)
}

// ---------- 7. big pushes p, n, recode constant ----------
log('\n=== big pushes ===')
assert(decNum(chunks[215]) === pP256 && rawHex(chunks[215]) === hex(encNum(pP256)), 'chunk 215 = p (P-256), 33-byte push with trailing 0x00 sign byte (top byte 0xff)')
for (const i of [29, 67, 79]) assert(decNum(chunks[i]) === nP256 && rawHex(chunks[i]) === hex(encNum(nP256)), `chunk ${i} = n (P-256), 33-byte push with trailing 0x00 sign byte`)
for (const i of [70, 82]) {
  const v = decNum(chunks[i])
  log(`chunk ${i}: value = 2^${v.toString(2).length} - 1? ${(v + 1n).toString(2).length - 1 === v.toString(2).length && ((v + 1n) & v) === 0n} bits=${v.toString(2).length} raw=${rawHex(chunks[i]).slice(0, 8)}..${rawHex(chunks[i]).slice(-4)} len=${chunks[i].data.length}`)
  assert(v === (1n << 258n) - 1n && rawHex(chunks[i]) === hex(encNum(v)), `chunk ${i} = 2^258 - 1 (NOT 2^254-1): 33-byte push ff*32 || 03`)
}
// all other numeric pushes in 0..86 and tail: check minimal encoding of every data push in the whole script that is used as a number? (report only non-minimal pushes by push-opcode rule)
{
  let nonMinimalPush = 0
  // MINIMALDATA push-form rule: empty -> OP_0; single byte 1..16 -> OP_N; single byte 0x81 -> OP_1NEGATE; <=75 -> direct; <=255 -> PUSHDATA1; else PUSHDATA2.
  // NOTE a single 0x00 byte can only be pushed as `01 00` (OP_0 pushes the EMPTY array) — used at chunks 24 and 22864 as a byte string for CAT.
  for (const c of chunks) if (c.data) { const d = Buffer.from(c.data); if (d.length === 0 || (d.length === 1 && ((d[0] >= 1 && d[0] <= 16) || d[0] === 0x81))) nonMinimalPush++; if (c.op === 76 && d.length <= 75) nonMinimalPush++; if (c.op === 77 && d.length <= 255) nonMinimalPush++ }
  assert(nonMinimalPush === 0, 'no push in the script violates the minimal-push-opcode rule (MINIMALDATA push form)')
  const nonMinimalNum = chunks.filter(c => c.data && c.data.length >= 2 && ((c.data[c.data.length - 1] & 0x7f) === 0) && ((c.data[c.data.length - 2] & 0x80) === 0))
  log(`data pushes that are non-minimal AS NUMBERS (trailing 0x00/0x80 with clear high bit before): ${nonMinimalNum.length} -> [${nonMinimalNum.map(c => c.i + ':' + name(c).slice(0, 20)).join(', ')}]  (these are byte strings, not numbers: preimage fields)`)
}

// ---------- 8. region 0..86 & tail listing (pushes) ----------
log('\n=== pushes in 0..86 (preimage build + scalar math) ===')
for (const c of chunks.slice(0, 87)) if (c.data) log(`  chunk ${c.i} @${c.off} len${c.data.length}: ${hex(c.data).slice(0, 70)}`)
log('=== pushes in tail 22640..23066 ===')
for (const c of chunks.slice(22640)) if (c.data) log(`  chunk ${c.i} @${c.off} len${c.data.length}: ${hex(c.data).slice(0, 70)}`)
log('tail first 20 ops: ' + chunks.slice(22640, 22660).map(name).join(' '))

// ---------- 9. skeleton.json + regenerate ----------
log('\n=== skeleton + regeneration ===')
const litHex = (a, b) => hex(Buffer.concat(chunks.slice(a, b + 1).map(c => c.raw)))
const addTemplate = addG.map((c, k) => { const p = addParams.find(p => p.k === k); return p ? { param: p.role === 'SHIFT' ? `SHIFT${p.rowK}` : p.role === 'BASE' ? 'BASE' : `DEPTH${p.valG - 132}` } : rawHex(c) })
const doubleTemplate = chunks.slice(222, 222 + DOUBLE_LEN).map(rawHex)
const guardPrefixHex = chunks.slice(415, 429).map(rawHex) // 14 chunks: OP_2 OP_PICK OP_0 OP_NUMEQUAL OP_IF TOALT TOALT DROP DROP DROP FROMALT FROMALT OP_1 OP_ELSE
// guard suffix: col0 ADD_G = 333..(333+205+15-1)=552 -> last chunk 552 must be the closing OP_ENDIF of the identity guard
assert(chunks[552].op === OP.OP_ENDIF && !chunks[552].data && chunks[415].op === OP.OP_2 && chunks[428].op === OP.OP_ELSE, 'col0 guard: OP_2 at 415, OP_ELSE at 428, closing OP_ENDIF at 552 (ADD_Q then starts at 553, col1 at 758)')
const guardSuffixHex = [rawHex(chunks[552])]

function emitAdd (c, half, guard) {
  const bufs = []
  const d0 = half === 0 ? 132 : 131, base = half === 0 ? 132 : 68
  const guardAt = 82 // ADD offset where the y-negation ENDIF has just been emitted (index of first chunk after ENDIF) — asserted below
  for (let k = 0; k < addTemplate.length; k++) {
    if (guard && k === guardAt) for (const g of guardPrefixHex) bufs.push(Buffer.from(g, 'hex'))
    const t = addTemplate[k]
    if (typeof t === 'string') bufs.push(Buffer.from(t, 'hex'))
    else if (t.param.startsWith('SHIFT')) bufs.push(encNum(257 - c - 43 * Number(t.param.slice(5))))
    else if (t.param === 'BASE') bufs.push(encNum(base))
    else bufs.push(encNum(d0 + Number(t.param.slice(5))))
  }
  if (guard) for (const g of guardSuffixHex) bufs.push(Buffer.from(g, 'hex'))
  return Buffer.concat(bufs)
}
function emitColumn (c) { return Buffer.concat([Buffer.from(doubleTemplate.join(''), 'hex'), emitAdd(c, 0, c === 0), emitAdd(c, 1, false)]) }
function emitConstants (Qpt) {
  const bufs = []
  for (let j = 0; j < 64; j++) { const pt = (j < 32 ? G : Qpt).multiply(tableScalar(j & 31)); bufs.push(encNum(pt.x), encNum(pt.y)) }
  return Buffer.concat(bufs)
}
const regions = [
  { id: 'preimage_build', chunks: [0, 28], note: 'rebuild sighash preimage from unlock pushes + baked constants; DUP HASH256 <00> CAT BIN2NUM -> e; preimage -> altstack. Per-instance parameter: amount push (8 bytes LE satoshis) — see pushes listing.', kind: 'literal' },
  { id: 'scalar_math', chunks: [29, 62], note: 'push n; s*sInv mod n == 1 verify; u1=e*sInv mod n; u2=r*sInv mod n. n pushed at 29 as 33-byte minimal scriptnum.', kind: 'literal' },
  { id: 'recode', chunks: [63, 86], note: 'per scalar: DUP 2 MOD NOTIF <n> ADD ENDIF <2^258-1> ADD 2 DIV; SWAP; twice. Constants: n (33B), 2^258-1 (33B: ff*32||03).', kind: 'literal' },
  { id: 'comb_tables', chunks: [87, 214], kind: 'template', template: 'for j in 0..31: encNum(x(G_j)),encNum(y(G_j)); then for j in 0..31: encNum(x(Q_j)),encNum(y(Q_j)); T_j = (2^215 + sum_{k<5}(bit_k(j)?+1:-1)*2^(43k)) * Base. encNum = minimal LE sign-magnitude (32B, or 33B with 0x00 if top bit set; would be <32B if coordinate < 2^248).', params: { Q: Qhex } },
  { id: 'push_p', chunks: [215, 215], kind: 'literal', note: '33-byte push of p (0xff top byte -> 0x00 sign byte)' },
  { id: 'preloop_init', chunks: [216, 221], kind: 'literal', note: 'FROMALTSTACK DROP TOALTSTACK (p -> altstack) then OP_1 OP_1 OP_0 (projective identity X=1,Y=1,Z=0)' },
  { id: 'comb_loop', chunks: [222, 22639], kind: 'template', template: 'for c in 0..42: DOUBLE(111 chunks, fixed) || ADD(half=0: depth0=132, base=132, shifts 257-c-43k, identityGuard iff c==0) || ADD(half=1: depth0=131, base=68, same shifts). Column c starts at chunk 222 + (c==0?0:536+521*(c-1)); col0 = 536 chunks, others 521.', params: { DOUBLE: doubleTemplate, ADD: addTemplate, GUARD_PREFIX: guardPrefixHex, GUARD_PREFIX_AT_ADD_OFFSET: 82, GUARD_SUFFIX: guardSuffixHex, shift: '257 - c - 43*k, k=0..5 (row), same for both halves', encNum: '0->0x00 ; 1..16->0x51..0x60 ; else PUSH(minimal LE sign-magnitude bytes)' } },
  { id: 'tail', chunks: [22640, 23066], kind: 'literal', note: 'Z==0 guard + projective r check + OP_PUSH_TX (k=1 signature, DER, pubkey, CODESEPARATOR CHECKSIG). Contains fixed constants only (secp256k1 n, Gx, PUSH_TX pubkey) — per-instance-independent.' }
]
for (const r of regions) { r.byteRange = [chunks[r.chunks[0]].off, chunks[r.chunks[1]].off + chunks[r.chunks[1]].len - 1]; r.chunkCount = r.chunks[1] - r.chunks[0] + 1; r.byteCount = r.byteRange[1] - r.byteRange[0] + 1; if (r.kind === 'literal') r.hex = litHex(r.chunks[0], r.chunks[1]) }
// regenerate
const gen = Buffer.concat([
  Buffer.from(regions[0].hex, 'hex'), Buffer.from(regions[1].hex, 'hex'), Buffer.from(regions[2].hex, 'hex'),
  emitConstants(Q), Buffer.from(regions[4].hex, 'hex'), Buffer.from(regions[5].hex, 'hex'),
  ...Array.from({ length: 43 }, (_, c) => emitColumn(c)),
  Buffer.from(regions[7].hex, 'hex')
])
assert(gen.length === bytes.length, `regenerated length ${gen.length} == ${bytes.length}`)
{
  let firstDiff = -1; for (let i = 0; i < Math.min(gen.length, bytes.length); i++) if (gen[i] !== bytes[i]) { firstDiff = i; break }
  assert(firstDiff === -1 && gen.length === bytes.length, 'REGENERATED SCRIPT IS BYTE-IDENTICAL TO THE FIXTURE (all 29,584 bytes)')
  if (firstDiff >= 0) log(`first differing byte offset ${firstDiff}: fixture ${bytes[firstDiff].toString(16)} gen ${gen[firstDiff].toString(16)}; chunk ${chunks.findIndex(c => c.off <= firstDiff && firstDiff < c.off + c.len)}`)
}
// per-column byte ranges for the skeleton
regions[6].columns = Array.from({ length: 43 }, (_, c) => { const [s, l] = segB(c); return { c, chunks: [s, s + l - 1], bytes: [chunks[s].off, chunks[s + l - 1].off + chunks[s + l - 1].len - 1], double: [s, s + DOUBLE_LEN - 1], addG: [s + DOUBLE_LEN, s + DOUBLE_LEN + ADD_LEN - 1 + (c === 0 ? GUARD_EXTRA : 0)], addQ: [s + DOUBLE_LEN + ADD_LEN + (c === 0 ? GUARD_EXTRA : 0), s + l - 1], shifts: [0, 1, 2, 3, 4, 5].map(k => 257 - c - 43 * k) } })
regions[6].taskSegmentationNote = 'The task described col c (c>=1) as 869+521(c-1)..+520 ending at 22750 ([add][add][double]). That is byte-equivalent for cols 0..41 but WRONG for col 42: chunks 22640..22750 are not a DOUBLE (they begin OP_DUP OP_0 OP_NUMEQUAL OP_NOTIF ...) — they are the tail. The loop body is DOUBLE, ADD_G, ADD_Q; the pre-loop 222..332 doubling is col0\'s DOUBLE.'
fs.writeFileSync(S + '/skeleton.json', JSON.stringify({ totalBytes: bytes.length, totalChunks: chunks.length, regions, shiftTable, addParams }, null, 1))
log('wrote skeleton.json')

// Spend.validate on regenerated script (identical bytes -> should be true; run as oracle sanity)
{
  const txHex = fs.readFileSync(REPO + '/docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex', 'utf8').trim()
  const tx = Transaction.fromHex(txHex)
  const mk = lockBuf => new Spend({ sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: 0, sourceSatoshis: 4600, lockingScript: LockingScript.fromHex(hex(lockBuf)), transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs, unlockingScript: tx.inputs[0].unlockingScript, inputSequence: tx.inputs[0].sequence, inputIndex: 0, lockTime: tx.lockTime })
  const t0 = Date.now(); let v; try { v = mk(gen).validate() } catch (e) { v = 'threw: ' + e.message }
  assert(v === true, `Spend.validate() on regenerated script === true (${Date.now() - t0} ms)`)
  // Negative control: flip one shift constant encoding to a non-minimal form (0x01 0x00 instead of OP_0 for c=42,k=5) and confirm the interpreter rejects it (MINIMALDATA)
  const bad = Buffer.from(gen); const c42 = segB(42); const t = normalized(c42[0], c42[1]); const z = t.filter(x => x.kind === 'SHIFT' && x.value === 0n)[0]
  const zc = chunks[z.i]
  const bad2 = Buffer.concat([bad.subarray(0, zc.off), Buffer.from([0x01, 0x00]), bad.subarray(zc.off + 1)])
  let v2; try { v2 = mk(bad2).validate() } catch (e) { v2 = 'threw: ' + e.message.slice(0, 90) }
  log(`negative control (OP_0 -> non-minimal <00> push at chunk ${z.i}): validate -> ${v2}`)
  // Micro-test of the interpreter rule for arithmetic operands (what a 32-byte coordinate with top byte 0x00 would hit in OP_MUL/OP_SUB):
  //   A: <11> OP_1 OP_MUL <11> OP_NUMEQUAL          (17 minimally encoded)      -> expect true
  //   B: <1100> OP_1 OP_MUL <11> OP_NUMEQUAL        (17 with a redundant 0x00)  -> expect 'non-minimally encoded script number'
  const micro = lockHexS => { try { return new Spend({ sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: 0, sourceSatoshis: 4600, lockingScript: LockingScript.fromHex(lockHexS), transactionVersion: 1, otherInputs: [], outputs: tx.outputs, unlockingScript: LockingScript.fromHex(''), inputSequence: 0xffffffff, inputIndex: 0, lockTime: 0 }).validate() } catch (e) { return 'threw: ' + e.message.slice(0, 80) } }
  const mA = micro('0111' + '51' + '95' + '0111' + '9c'), mB = micro('021100' + '51' + '95' + '0111' + '9c')
  log(`micro-test A (minimal 17 * 1 == 17): ${mA}; micro-test B (non-minimal <1100> * 1): ${mB}`)
  assert(mA === true && String(mB).includes('non-minimally'), 'SDK interpreter (default flags) REJECTS non-minimal script numbers as arithmetic operands -> generator MUST emit minimal encodings (a coordinate < 2^248 must be pushed with < 32 bytes)')
}
// readable asm for the templates (for the Reproduce phase)
{
  const asmOf = arr => arr.map(t => typeof t === 'string' ? (() => { const b = Buffer.from(t, 'hex'); return b.length === 1 ? (OP[b[0]] ?? '0x' + t) : '<' + t.slice(2) + '>' })() : '{' + t.param + '}').join(' ')
  const sk = JSON.parse(fs.readFileSync(S + '/skeleton.json', 'utf8'))
  sk.regions[6].params.ADD_asm = asmOf(addTemplate)
  sk.regions[6].params.DOUBLE_asm = asmOf(doubleTemplate)
  sk.regions[6].params.GUARD_PREFIX_asm = asmOf(guardPrefixHex)
  sk.regions[6].params.GUARD_SUFFIX_asm = asmOf(guardSuffixHex)
  sk.regions[6].params.ADD_param_semantics = { DEPTH0: 'scalar pick depth for row0 = 132 (half0, u1) / 131 (half1, u2)', DEPTH1: 'DEPTH0+1 (row1 pick, after 1 extra item)', DEPTH2: 'DEPTH0+2 (rows 2..5, after 2 extra items)', BASE: 'table base depth 132 (G table, half0) / 68 (Q table, half1); x = PICK(BASE-2j), y = PICK(BASE-2j) after one more push', SHIFTk: 'encNum(257 - c - 43k)' }
  sk.regions[6].params.ADD_layout = 'offsets 0..81: six digit extractions (row0 sign; rows1..5 XNOR sign, accumulate j) [0..49], table pick x,y [50..68], drop j / bring sign / negate y if sign==0 (NOTIF FROMALTSTACK DUP TOALTSTACK SWAP SUB ENDIF) [69..81]; offsets 82..204: mixed addition (X,Y,Z)+(x,y) -> (X,Y,Z) mod p (lazy reduction, 3 OP_MOD p), ending OP_2 OP_ROLL x3'
  sk.regions[6].params.GUARD_rule = 'iff c==0 (half0 only): insert GUARD_PREFIX (14 chunks) before ADD offset 82 and GUARD_SUFFIX (OP_ENDIF) after ADD offset 204. Semantics: if acc.Z==0 (identity) replace acc by (x,y,1) else do the addition.'
  sk.regions[6].params.DOUBLE_identity_note = 'DOUBLE of (1,1,0) yields (1,1,0) (trace chunk 332), so the first doubling needs no special case; only the first ADD does.'
  sk.notes = [
    'Column c (0..42) = DOUBLE(111) + ADD_G(205 + (c==0?15:0)) + ADD_Q(205). Column c starts at chunk 222 + (c==0 ? 0 : 536 + 521*(c-1)). Col 42 = 22119..22639. Tail = 22640..23066 (427 chunks).',
    'encNum (minimal script number): 0 -> 0x00 (OP_0), 1..16 -> 0x51..0x60, -1 -> 0x4f, else push of minimal little-endian magnitude with a trailing 0x00 sign byte iff top bit of last magnitude byte is set (push opcode = length for <=75 bytes).',
    'All 128 table coordinates, p, n (x3), 2^258-1 (x2) follow encNum exactly. Fixture has 0 coordinates < 2^248, so short-coordinate behaviour is unobserved; the SDK interpreter rejects non-minimal numbers, so encNum (short push) is required.',
    'Recode constant is 2^258-1 (33 bytes: ff*32 || 03), not 2^254-1.',
    'Per-instance parameters: amount push (chunk 12, 8 bytes LE) in preimage_build; Q table (chunks 151..214) in comb_tables. Everything else is fixed for the construction (G table, p, n, PUSH_TX constants).'
  ]
  fs.writeFileSync(S + '/skeleton.json', JSON.stringify(sk, null, 1))
  log('skeleton.json regions: ' + sk.regions.map(r => `${r.id}[${r.chunks}] bytes[${r.byteRange}] ${r.kind}`).join(' | '))
}
fs.writeFileSync(S + '/map-uniformity.out.txt', out.join('\n'))
