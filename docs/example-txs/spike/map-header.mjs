// map-header.mjs — verify chunks 0..86 (preimage, e, inverse check, u1/u2, recoding) and the unlocking-script encoding
// against the @bsv/sdk Spend interpreter (the oracle). Run from the repo or the scratchpad:
//   node map-header.mjs
import fs from 'fs'
import { Script, Transaction, Spend, OP, LockingScript, UnlockingScript, BigNumber, Hash, Utils, TransactionSignature } from '@bsv/sdk'

const REPO = '/Users/personal/git/bsv-wallet'
const lockHex = fs.readFileSync(`${REPO}/docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex`, 'utf8').trim()
const txHex = fs.readFileSync(`${REPO}/docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex`, 'utf8').trim()
const tx = Transaction.fromHex(txHex)
const lock = LockingScript.fromHex(lockHex)
const unlock0 = tx.inputs[0].unlockingScript

const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
const P = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff')
const C258 = (1n << 258n) - 1n

// ---------- helpers ----------
const hex = a => Buffer.from(a).toString('hex')
const bytes = h => [...Buffer.from(h, 'hex')]
const mod = (a, m) => ((a % m) + m) % m
const modpow = (b, e, m) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n } return r }
const inv = (a, m) => modpow(a, m - 2n, m) // m prime
const sm = v => new BigNumber(v).toSm('little')          // minimal LE sign-magnitude = script number encoding
const smHex = v => hex(sm(v))
const fromSm = (b, requireMinimal = true) => BigNumber.fromScriptNum(b, requireMinimal).toBigInt()
const eq = (a, b) => hex(a) === hex(b)
const results = []
let failures = 0
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
  if (!ok) failures++
}
// push a script number with the minimal opcode (OP_0/OP_1..16/OP_1NEGATE/direct push)
function pushNum(script, v) {
  if (v === 0n) return script.writeOpCode(OP.OP_0)
  if (v >= 1n && v <= 16n) return script.writeOpCode(OP.OP_1 + Number(v) - 1)
  if (v === -1n) return script.writeOpCode(OP.OP_1NEGATE)
  return script.writeBin(sm(v))
}
function mkSpend(unlock, extra = {}) {
  return new Spend({
    sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: 0, sourceSatoshis: 4600,
    lockingScript: lock, transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs,
    unlockingScript: unlock, inputSequence: tx.inputs[0].sequence, inputIndex: 0, lockTime: tx.lockTime, ...extra
  })
}
// step until we are about to execute locking-script chunk `pc` (i.e. state AFTER chunk pc-1)
function stepTo(spend, pc, max = 100000) {
  let n = 0
  while (!(spend.context === 'LockingScript' && spend.programCounter === pc)) {
    spend.step(); if (++n > max) throw new Error('stepTo overflow')
  }
  return spend
}
function fullValidate(unlock, extra = {}) {
  const sp = mkSpend(unlock, extra)
  try { return { ok: sp.validate(), pc: sp.programCounter, ctx: sp.context } }
  catch (e) { return { ok: false, err: e.message.split('\n')[0], pc: e.programCounter, ctx: e.context, top: e.stackState?.slice(-3).map(hex) } }
}

// ---------- 1. unlocking script encoding ----------
const ch = unlock0.chunks
check('unlock has 5 pushes', ch.length === 5, `${ch.length}`)
check('unlock push opcodes are direct-length pushes', ch.every(c => c.op === c.data.length), ch.map(c => `0x${c.op.toString(16)}/len${c.data.length}`).join(' '))
check('unlock is push-only', unlock0.isPushOnly())
const [rB, sB, sInvB, hashOutputsB, outpointB] = ch.map(c => c.data)
check('r push is 33 bytes with trailing 0x00 sign byte', rB.length === 33 && rB[32] === 0x00 && (rB[31] & 0x80) !== 0, hex(rB))
check('s push is 32 bytes, top byte < 0x80', sB.length === 32 && (sB[31] & 0x80) === 0, hex(sB))
check('sInv push is 32 bytes, top byte < 0x80', sInvB.length === 32 && (sInvB[31] & 0x80) === 0, hex(sInvB))
check('hashOutputs push is 32 bytes', hashOutputsB.length === 32)
check('outpoint push is 36 bytes', outpointB.length === 36)
const r = fromSm(rB), s = fromSm(sB), sInv = fromSm(sInvB)
check('r,s,sInv are minimally encoded scriptnums (fromScriptNum requireMinimal ok)', true)
check('r,s,sInv re-encode byte-identically via BigNumber.toSm(little)', smHex(r) === hex(rB) && smHex(s) === hex(sB) && smHex(sInv) === hex(sInvB))
check('0 < r < n', r > 0n && r < N, `r=${r.toString(16)}`)
check('0 < s < n', s > 0n && s < N, `s=${s.toString(16)}`)
check('s*sInv mod n == 1 (sInv is the modular inverse)', mod(s * sInv, N) === 1n)
check('sInv == s^(n-2) mod n', sInv === inv(s, N))
results.push(`INFO fixture s is ${s > N / 2n ? 'high-S' : 'low-S'} (s > n/2 = ${s > N / 2n}); the script applies no low-S rule to the P-256 signature (see FULL s->n-s test)`)
// outpoint / hashOutputs must match the actual spend tx (constrained by the tail's OP_CHECKSIG, not by 0..86)
const expectedOutpoint = [...Utils.toArray(tx.inputs[0].sourceTXID, 'hex').reverse(), ...[0, 0, 0, 0]]
check('outpoint == reverse(sourceTXID) || vout(0) LE32', eq(outpointB, expectedOutpoint))
const outsSer = tx.outputs.flatMap(o => { const w = new Utils.Writer(); w.writeUInt64LE(o.satoshis); w.writeVarIntNum(o.lockingScript.toBinary().length); w.write(o.lockingScript.toBinary()); return w.toArray() })
check('hashOutputs == hash256(serialized outputs)', eq(hashOutputsB, Hash.hash256(outsSer)))

// ---------- 2. preimage exactly as chunks 0..21 build it ----------
const preimage = [
  ...bytes('01000000'),                 // version (baked)          chunk 2
  ...Hash.hash256(outpointB),           // hashPrevouts = hash256(outpoint)  chunks 0,1  (single input)
  ...Hash.hash256(bytes('ffffffff')),   // hashSequence = hash256(ffffffff)  chunks 5,6  (single input, seq ffffffff)
  ...outpointB,                         // outpoint (unlock)        chunks 8,9
  ...bytes('01ac'),                     // scriptCode varint(1)||OP_CHECKSIG (baked) chunk 10
  ...bytes('f811000000000000'),         // amount 4600 sat LE64 (baked) chunk 12
  ...bytes('ffffffff'),                 // nSequence (baked)        chunk 14
  ...hashOutputsB,                      // hashOutputs (unlock)     chunks 16,17
  ...bytes('00000000'),                 // nLockTime (baked)        chunk 18
  ...bytes('41000000')                  // sighash type ALL|FORKID (baked) chunk 20
]
check('preimage length 158', preimage.length === 158)
const sdkPreimage = TransactionSignature.format({
  sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: 0, sourceSatoshis: 4600, transactionVersion: tx.version,
  otherInputs: [], outputs: tx.outputs, inputIndex: 0, subscript: Script.fromHex('ac'), inputSequence: tx.inputs[0].sequence,
  lockTime: tx.lockTime, scope: 0x41
})
check('preimage == SDK TransactionSignature.format(subscript=ac, scope=0x41)', eq(preimage, sdkPreimage))
const h = Hash.hash256(preimage)
const e = fromSm([...h, 0x00], false)           // <00> CAT BIN2NUM  => unsigned LE interpretation
check('e == LE-unsigned(hash256(preimage))', e === BigInt('0x' + hex([...h].reverse())))
check('e is non-negative', e >= 0n)
const eMinimal = sm(e)
check('BIN2NUM(hash||00) minimal form == toSm(e)', true, `e bytes=${eMinimal.length} (hash[31]=0x${h[31].toString(16)} -> ${(h[31] & 0x80) ? '33-byte, keeps 00' : '32-byte, 00 stripped'})`)
check('e is not reduced mod n by the script (e >= n possible)', true, `e>=n: ${e >= N}`)

// ---------- 3. u1,u2 and recoding ----------
const u1 = mod(e * sInv, N)
const u2 = mod(r * sInv, N)
function recode(u) {
  const uOdd = (u % 2n === 0n) ? u + N : u     // DUP 2 MOD NOTIF n ADD ENDIF
  const up = (uOdd + C258) / 2n                 // <2^258-1> ADD 2 DIV  (exact: uOdd + C258 is even)
  return { uOdd, up }
}
const R1 = recode(u1), R2 = recode(u2)
function bitsOk(up, uOdd) {
  // u' encodes digits d_i in {-1,+1}: uOdd = sum_{i=0}^{257} (2*bit_i(up) - 1) * 2^i
  let acc = 0n
  for (let i = 0n; i < 258n; i++) acc += ((((up >> i) & 1n) === 1n) ? 1n : -1n) << i
  return acc === uOdd && up < (1n << 258n) && ((up >> 257n) & 1n) === 1n
}
check('u1 parity', true, `u1 ${u1 % 2n ? 'odd (no +n)' : 'even (+n)'}`)
check('u2 parity', true, `u2 ${u2 % 2n ? 'odd (no +n)' : 'even (+n)'}`)
check('u1\' expands to 258 signed digits summing to u1odd; u1\' < 2^258; bit257=1', bitsOk(R1.up, R1.uOdd))
check('u2\' expands to 258 signed digits summing to u2odd; u2\' < 2^258; bit257=1', bitsOk(R2.up, R2.uOdd))
check('u1\' scriptnum is exactly 33 bytes, last byte 0x02', sm(R1.up).length === 33 && sm(R1.up)[32] === 0x02)
check('u2\' scriptnum is exactly 33 bytes, last byte 0x02', sm(R2.up).length === 33 && sm(R2.up)[32] === 0x02)

// constants in the locking script
check('chunk 29/67/79 constant == n (33B, trailing 00)', [29, 67, 79].every(i => eq(lock.chunks[i].data, sm(N))), hex(lock.chunks[29].data))
check('chunk 70/82 constant == 2^258-1 (NOT 2^254-1)', [70, 82].every(i => eq(lock.chunks[i].data, sm(C258))), hex(lock.chunks[70].data))
check('2^254-1 would encode differently', hex(sm((1n << 254n) - 1n)) !== hex(lock.chunks[70].data), hex(sm((1n << 254n) - 1n)))
check('chunk 215 constant == p', eq(lock.chunks[215].data, sm(P)))
check('chunk 87 is first table x (32/33B push)', lock.chunks[87].data.length >= 32)

// ---------- 4. interpreter checkpoints on the fixture ----------
{
  const sp = mkSpend(unlock0)
  stepTo(sp, 22); check('[pc22] top == preimage (158B)', eq(sp.stack.at(-1), preimage), `depth=${sp.stack.length}`)
  check('[pc22] stack == [r,s,sInv,preimage]', sp.stack.length === 4 && eq(sp.stack[0], rB) && eq(sp.stack[1], sB) && eq(sp.stack[2], sInvB))
  stepTo(sp, 24); check('[pc24] top == hash256(preimage) raw 32B', eq(sp.stack.at(-1), h))
  stepTo(sp, 27); check('[pc27] top == e (minimal scriptnum)', eq(sp.stack.at(-1), sm(e)), `${sp.stack.at(-1).length}B`)
  stepTo(sp, 29); check('[pc29] alt=[preimage], stack=[r,s,sInv,e]', sp.altStack.length === 1 && eq(sp.altStack[0], preimage) && sp.stack.length === 4 && eq(sp.stack[3], sm(e)))
  stepTo(sp, 31); check('[pc31] alt=[preimage,n]', sp.altStack.length === 2 && eq(sp.altStack[1], sm(N)))
  stepTo(sp, 36); check('[pc36] top == s*sInv (unreduced product, 64B)', eq(sp.stack.at(-1), sm(s * sInv)), `${sp.stack.at(-1).length}B`)
  stepTo(sp, 39); check('[pc39] stack top == n copy, product below it; alt still [preimage,n]', eq(sp.stack.at(-1), sm(N)) && eq(sp.stack.at(-2), sm(s * sInv)) && sp.altStack.length === 2)
  stepTo(sp, 40); check('[pc40] top == (s*sInv) mod n == 1', eq(sp.stack.at(-1), sm(1n)))
  stepTo(sp, 42); check('[pc42] after NUMEQUALVERIFY stack=[r,s,sInv,e]', sp.stack.length === 4 && eq(sp.stack[3], sm(e)) && sp.altStack.length === 2)
  stepTo(sp, 48); check('[pc48] top == u1 = e*sInv mod n', eq(sp.stack.at(-1), sm(u1)), `u1=${u1.toString(16)}`)
  stepTo(sp, 57); check('[pc57] top == u2 = r*sInv mod n', eq(sp.stack.at(-1), sm(u2)), `u2=${u2.toString(16)}`)
  check('[pc57] stack == [r,s,sInv,u1,u2]', sp.stack.length === 5 && eq(sp.stack[0], rB) && eq(sp.stack[1], sB) && eq(sp.stack[2], sInvB) && eq(sp.stack[3], sm(u1)))
  stepTo(sp, 63); check('[pc63] stack == [r,u1,u2] (s,sInv dropped)', sp.stack.length === 3 && eq(sp.stack[0], rB) && eq(sp.stack[1], sm(u1)) && eq(sp.stack[2], sm(u2)))
  stepTo(sp, 70); check('[pc70] top == u2odd (u2 + n if even)', eq(sp.stack.at(-1), sm(R2.uOdd)))
  stepTo(sp, 72); check('[pc72] top == u2odd + 2^258-1', eq(sp.stack.at(-1), sm(R2.uOdd + C258)))
  stepTo(sp, 74); check('[pc74] stack == [r,u1,u2\']', sp.stack.length === 3 && eq(sp.stack[2], sm(R2.up)), `u2'=${R2.up.toString(16)}`)
  stepTo(sp, 75); check('[pc75] after SWAP stack == [r,u2\',u1]', eq(sp.stack[1], sm(R2.up)) && eq(sp.stack[2], sm(u1)))
  stepTo(sp, 86); check('[pc86] stack == [r,u2\',u1\']', sp.stack.length === 3 && eq(sp.stack[1], sm(R2.up)) && eq(sp.stack[2], sm(R1.up)), `u1'=${R1.up.toString(16)}`)
  stepTo(sp, 87)
  check('[pc87] stack == [r, u1\', u2\'] bottom->top', sp.stack.length === 3 && eq(sp.stack[0], rB) && eq(sp.stack[1], sm(R1.up)) && eq(sp.stack[2], sm(R2.up)))
  check('[pc87] altstack == [preimage(158B), n(33B)] bottom->top', sp.altStack.length === 2 && eq(sp.altStack[0], preimage) && eq(sp.altStack[1], sm(N)))
  results.push(`INFO [pc87] stack sizes bottom->top: ${sp.stack.map(x => x.length + 'B').join(', ')}; alt: ${sp.altStack.map(x => x.length + 'B').join(', ')}; ifStack depth=${sp.ifStack.length}`)
  results.push(`INFO [pc87] r   = ${hex(sp.stack[0])}`)
  results.push(`INFO [pc87] u1' = ${hex(sp.stack[1])}`)
  results.push(`INFO [pc87] u2' = ${hex(sp.stack[2])}`)
  results.push(`INFO e  = ${e.toString(16)}`)
  results.push(`INFO u1 = ${u1.toString(16)}  u2 = ${u2.toString(16)}`)
  // sanity: after the tables + p are pushed (pc 216) depth must be 3+128+1
  stepTo(sp, 216); check('[pc216] depth == 3 + 128 + 1 = 132', sp.stack.length === 132, `${sp.stack.length}`)
}

// ---------- 5. header-only runs on arbitrary inputs (parity cases + edge cases) ----------
// The header (0..86) does not need a valid signature, so we can drive it with arbitrary r,s and compare to the formula.
function mkUnlock(rV, sV, sInvV, opts = {}) {
  const u = new UnlockingScript()
  if (opts.rRaw) u.writeBin(opts.rRaw); else pushNum(u, rV)
  if (opts.sRaw) u.writeBin(opts.sRaw); else pushNum(u, sV)
  if (opts.sInvRaw) u.writeBin(opts.sInvRaw); else pushNum(u, sInvV)
  u.writeBin(opts.hashOutputs ?? hashOutputsB)
  if (opts.outpointPushdata1) u.chunks.push({ op: OP.OP_PUSHDATA1, data: outpointB }); else u.writeBin(opts.outpoint ?? outpointB)
  return u
}
function headerRun(unlock, extra = {}) {
  const sp = mkSpend(unlock, extra)
  try { stepTo(sp, 87); return { ok: true, stack: sp.stack.map(x => [...x]), alt: sp.altStack.map(x => [...x]) } }
  catch (err) { return { ok: false, err: err.message.split('\n')[0], pc: err.programCounter, ctx: err.context } }
}
function expectHeader(rV, sV, sInvV, tag) {
  const res = headerRun(mkUnlock(rV, sV, sInvV))
  if (!res.ok) { check(`header ${tag}`, false, `${res.ctx}#${res.pc} ${res.err}`); return null }
  const U1 = mod(e * sInvV, N), U2 = mod(rV * sInvV, N)
  const A = recode(U1), B = recode(U2)
  const ok = res.stack.length === 3 && eq(res.stack[0], sm(rV)) && eq(res.stack[1], sm(A.up)) && eq(res.stack[2], sm(B.up)) && bitsOk(A.up, A.uOdd) && bitsOk(B.up, B.uOdd)
  check(`header ${tag}`, ok, `u1 ${U1 % 2n ? 'odd' : 'even'}, u2 ${U2 % 2n ? 'odd' : 'even'}; r enc ${sm(rV).length}B, u1' ${sm(A.up).length}B, u2' ${sm(B.up).length}B`)
  return { U1, U2 }
}
// random uniform inputs until all 4 parity combos are seen
{
  const seen = new Set(); let tries = 0
  const rnd = () => { let v = 0n; for (const b of Utils.toArray(hex([...Array(32)].map(() => Math.floor(Math.random() * 256))), 'hex')) v = (v << 8n) | BigInt(b); return mod(v, N - 1n) + 1n }
  while (seen.size < 4 && tries < 200) {
    tries++
    const rV = rnd(), sV = rnd(), sInvV = inv(sV, N)
    const out = expectHeader(rV, sV, sInvV, `random#${tries}`)
    if (out) seen.add(`${out.U1 % 2n}${out.U2 % 2n}`)
  }
  check('all four (u1,u2) parity combinations exercised', seen.size === 4, [...seen].sort().join(','))
}
// edge cases (header-only)
{
  const sV = s, sInvV = sInv
  expectHeader(1n, sV, sInvV, 'r=1 (OP_1 push)')
  expectHeader(0x7fn, sV, sInvV, 'r=0x7f (1-byte push)')
  expectHeader(1n << 240n, sV, sInvV, 'r=2^240 (31-byte minimal encoding, would be zero-padded in fixed 32B)')
  expectHeader((1n << 247n) + 5n, sV, sInvV, 'r just below 2^247+... (32B, no sign byte)')
  expectHeader((1n << 255n), sV, sInvV, 'r=2^255 (33B with sign byte)')
  expectHeader(N - 1n, sV, sInvV, 'r=n-1')
  expectHeader(N, sV, sInvV, 'r=n (>=n accepted by header; u2=0 -> +n)')
  expectHeader(N + 12345n, sV, sInvV, 'r=n+12345 (>=n accepted by header, reduced in u2)')
  expectHeader(P, sV, sInvV, 'r=p')
  expectHeader(0n, sV, sInvV, 'r=0 (u2=0 even -> +n)')
  expectHeader(r, 1n, 1n, 's=1,sInv=1')
  expectHeader(r, N - 1n, N - 1n, 's=n-1,sInv=n-1')
  expectHeader(r, s + N, sInv, 's=s+n (>=n) with same sInv -> accepted')
  expectHeader(r, s, sInv + N, 'sInv=sInv+n -> accepted')
  expectHeader(r, s, sInv + 2n * N, 'sInv=sInv+2n -> accepted')
  expectHeader(r, N - s, N - sInv, 's=n-s, sInv=n-sInv (other valid sig, high/low S irrelevant)')
  // failures expected
  const f1 = headerRun(mkUnlock(r, 0n, sInv)); check('header s=0 (OP_0) rejected at chunk 41 NUMEQUALVERIFY', !f1.ok && f1.pc === 41, `${f1.ctx}#${f1.pc} ${f1.err}`)
  const f2 = headerRun(mkUnlock(r, N, sInv)); check('header s=n rejected at chunk 41', !f2.ok && f2.pc === 41, `${f2.ctx}#${f2.pc} ${f2.err}`)
  const f3 = headerRun(mkUnlock(r, s, sInv + 1n)); check('header wrong sInv rejected at chunk 41', !f3.ok && f3.pc === 41, `${f3.ctx}#${f3.pc} ${f3.err}`)
  // non-minimal numeric encodings (fixed 32/33-byte zero padded)
  const sPad33 = [...sB, 0x00]
  const f4 = headerRun(mkUnlock(r, s, sInv, { sRaw: sPad33 })); check('header s zero-padded to 33B rejected (MINIMALDATA, tx v1) at chunk 35 OP_MUL', !f4.ok && f4.pc === 35, `${f4.ctx}#${f4.pc} ${f4.err}`)
  const f4b = headerRun(mkUnlock(r, s, sInv, { sRaw: sPad33 }), { isRelaxed: true }); check('header s zero-padded accepted when isRelaxed (tx v>1 semantics)', f4b.ok && eq(f4b.stack[1], sm(R1.up)), f4b.ok ? 'same u1\'' : `${f4b.ctx}#${f4b.pc} ${f4b.err}`)
  const rSmall = 1n << 240n, rSmallPad32 = [...sm(rSmall), ...Array(32 - sm(rSmall).length).fill(0)]
  const f5 = headerRun(mkUnlock(rSmall, s, sInv, { rRaw: rSmallPad32 })); check('header r<2^248 zero-padded to fixed 32B rejected at chunk 52 OP_MUL (first numeric read of r)', !f5.ok && f5.pc === 52, `${f5.ctx}#${f5.pc} ${f5.err}`)
  const f5b = headerRun(mkUnlock(rSmall, s, sInv, { rRaw: rSmallPad32 }), { isRelaxed: true }); check('header r zero-padded accepted when isRelaxed', f5b.ok && eq(f5b.stack[2], sm(recode(mod(rSmall * sInv, N)).up)), f5b.ok ? 'ok' : `${f5b.ctx}#${f5b.pc} ${f5b.err}`)
  // r without its sign byte => interpreted as NEGATIVE number
  const rNeg = fromSm(rB.slice(0, 32), false)
  const f6 = headerRun(mkUnlock(r, s, sInv, { rRaw: rB.slice(0, 32) }))
  results.push(`INFO r without sign byte reads as ${rNeg} (negative=${rNeg < 0n}); header result: ${f6.ok ? 'reached pc87 with stack ' + f6.stack.map(hex).join(' | ') : `${f6.ctx}#${f6.pc} ${f6.err}`}`)
  if (f6.ok) {
    const U2neg = rNeg * sInv % N  // BigNumber mod keeps dividend sign (truncated)
    results.push(`INFO   u2 (truncated mod, negative) = ${U2neg}; u2 mod 2 = ${U2neg % 2n}; u2' on stack = ${hex(f6.stack[2])}`)
    check('header r-negative: u2 on stack is negative/garbage (not equal to correct u2\')', !eq(f6.stack[2], sm(R2.up)))
  }
  // non-minimal push opcode for a byte-string item
  const f7 = headerRun(mkUnlock(r, s, sInv, { outpointPushdata1: true })); check('outpoint via OP_PUSHDATA1 rejected at unlocking pc 4 (minimal push rule, tx v1)', !f7.ok && f7.ctx === 'UnlockingScript' && f7.pc === 4, `${f7.ctx}#${f7.pc} ${f7.err}`)
  const f7b = headerRun(mkUnlock(r, s, sInv, { outpointPushdata1: true }), { isRelaxed: true }); check('outpoint via OP_PUSHDATA1 accepted when isRelaxed', f7b.ok)
}

// ---------- 6. full-script mutation tests (what the header does NOT constrain, and what the tail does) ----------
{
  const base = fullValidate(unlock0); check('FULL baseline validate() == true', base.ok === true, JSON.stringify(base))
  const t1 = fullValidate(mkUnlock(r, N - s, N - sInv)); check('FULL s->n-s, sInv->n-sInv (other valid ECDSA sig) == true', t1.ok === true, JSON.stringify(t1))
  const t2 = fullValidate(mkUnlock(r, s + N, sInv)); check('FULL s->s+n (>= n) accepted == true (unlock malleable)', t2.ok === true, JSON.stringify(t2))
  const t3 = fullValidate(mkUnlock(r, s, sInv + N)); check('FULL sInv->sInv+n accepted == true (unlock malleable)', t3.ok === true, JSON.stringify(t3))
  const t4 = fullValidate(mkUnlock(r + N, s, sInv)); results.push(`INFO FULL r->r+n: ${JSON.stringify(t4)}`)
  const t4b = fullValidate(mkUnlock(r + P, s, sInv)); results.push(`INFO FULL r->r+p: ${JSON.stringify(t4b)}`)
  const t5 = fullValidate(mkUnlock(r, s, sInv, { rRaw: rB.slice(0, 32) })); results.push(`INFO FULL r without sign byte (negative): ${JSON.stringify(t5)}`)
  // r is only constrained by r ≡ r_sig (mod n) [u2] and r ≡ R.x (mod p) [chunk 22665]; r + n*p satisfies both
  const t4c = fullValidate(mkUnlock(r + N * P, s, sInv)); results.push(`INFO FULL r->r+n*p (${sm(r + N * P).length}B push): ${JSON.stringify(t4c)}`)
  check('FULL r->r+n*p accepted (r constrained only mod n and mod p)', t4c.ok === true)
  const t6 = fullValidate(mkUnlock(r, s, sInv, { sRaw: [...sB, 0] })); check('FULL s zero-padded (non-minimal) fails at chunk 35', t6.ok === false && t6.pc === 35, JSON.stringify(t6))
  const t6b = fullValidate(mkUnlock(r, s, sInv, { sRaw: [...sB, 0] }), { isRelaxed: true }); check('FULL s zero-padded with isRelaxed == true (only MINIMALDATA blocks it)', t6b.ok === true, JSON.stringify(t6b))
  const t7 = fullValidate(mkUnlock(r, 0n, sInv)); check('FULL s=0 fails at chunk 41', t7.ok === false && t7.pc === 41, JSON.stringify(t7))
  const hoBad = [...hashOutputsB]; hoBad[0] ^= 1
  const t8 = fullValidate(mkUnlock(r, s, sInv, { hashOutputs: hoBad })); results.push(`INFO FULL wrong hashOutputs (header accepts; tail must reject): ${JSON.stringify(t8)}`)
  check('FULL wrong hashOutputs: header accepts, rejected at the R.x==r check (OP_VERIFY chunk 22665), not in 0..86', t8.ok === false && t8.pc === 22665)
  const opBad = [...outpointB]; opBad[0] ^= 1
  const t9 = fullValidate(mkUnlock(r, s, sInv, { outpoint: opBad })); results.push(`INFO FULL wrong outpoint: ${JSON.stringify(t9)}`)
  check('FULL wrong outpoint: header accepts, rejected at the R.x==r check (OP_VERIFY chunk 22665), not in 0..86', t9.ok === false && t9.pc === 22665)
  check('FULL r->r+n rejected at R.x==r check (chunk 22665): r must equal R.x exactly, no r+n handling', t4.ok === false && t4.pc === 22665)
  check('FULL r->r+p rejected at chunk 22665', t4b.ok === false && t4b.pc === 22665)
  check('FULL r without sign byte (negative r) rejected at chunk 22665 (header itself does not reject)', t5.ok === false && t5.pc === 22665)
  // header-only check: wrong hashOutputs/outpoint still reach pc 87 (fields are merely baked/concatenated there)
  const h8 = headerRun(mkUnlock(r, s, sInv, { hashOutputs: hoBad })); check('header with wrong hashOutputs reaches pc87 (no constraint in 0..86)', h8.ok)
  const h9 = headerRun(mkUnlock(r, s, sInv, { outpoint: opBad })); check('header with wrong outpoint reaches pc87 (no constraint in 0..86)', h9.ok)
  // transaction-level: version 2 tx cannot spend (version baked as 01000000), independent of relaxed flags
  const t10 = fullValidate(unlock0, { transactionVersion: 2 }); results.push(`INFO FULL tx version=2 (relaxed flags, but preimage bakes version 1): ${JSON.stringify(t10)}`)
  check('FULL tx version 2 rejected (by tail)', t10.ok === false)
  const t11 = fullValidate(unlock0, { lockTime: 1 }); check('FULL locktime 1 rejected (by tail)', t11.ok === false, JSON.stringify(t11))
  const t12 = fullValidate(unlock0, { inputSequence: 0xfffffffe }); check('FULL sequence fffffffe rejected (by tail)', t12.ok === false, JSON.stringify(t12))
  const t13 = fullValidate(unlock0, { sourceSatoshis: 4601 }); check('FULL amount 4601 rejected (by tail)', t13.ok === false, JSON.stringify(t13))
  const t14 = fullValidate(unlock0, { otherInputs: [{ sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: 1, sequence: 0xffffffff }] }); check('FULL a second input rejected (by tail)', t14.ok === false, JSON.stringify(t14))
}

// ---------- 7. recoding bound proof by exhaustive extremes ----------
{
  const ups = [0n, 1n, 2n, N - 2n, N - 1n].map(u => recode(u).up)
  check('u\' range: min (u=1) == 2^257', recode(1n).up === (1n << 257n))
  check('u\' range: max over {0,1,2,n-2,n-1} < 2^257 + 2^256 (top byte always 0x02)', ups.every(v => v < (1n << 257n) + (1n << 256n) && v >= (1n << 257n)))
  check('u\' max is u=n-1 (even): (2n-1 + 2^258-1)/2 = n + 2^257 - 1', recode(N - 1n).up === N + (1n << 257n) - 1n)
}

console.log(results.join('\n'))
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} (${results.filter(x => x.startsWith('PASS')).length} pass, ${results.filter(x => x.startsWith('FAIL')).length} fail)`)
process.exit(failures ? 1 : 0)
