// map-column.mjs — verify the pre-loop (216–332) and comb-column structure of the R1 comb-verifier script.
// Run from /Users/personal/git/bsv-wallet:  node $S/map-column.mjs
import fs from 'fs'
import { Script, Transaction, Spend, OP, LockingScript, Hash } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const mod = (a, m) => ((a % m) + m) % m
const Pt = p256.Point, G = Pt.BASE

const lockHex = fs.readFileSync('docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex', 'utf8').trim()
const txHex = fs.readFileSync('docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex', 'utf8').trim()
const tx = Transaction.fromHex(txHex)
const lock = LockingScript.fromHex(lockHex)
const unlock = tx.inputs[0].unlockingScript
const ch = lock.chunks

// ---------- script-number helpers ----------
const snum = bytes => { if (!bytes.length) return 0n; const neg = (bytes[bytes.length - 1] & 0x80) !== 0; let v = 0n; for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(i === bytes.length - 1 ? bytes[i] & 0x7f : bytes[i]); return neg ? -v : v }
const hexOf = a => Buffer.from(a).toString('hex')

// ---------- interpreter driver ----------
function mkSpend () {
  return new Spend({
    sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: 0, sourceSatoshis: 4600,
    lockingScript: lock, transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs,
    unlockingScript: unlock, inputSequence: tx.inputs[0].sequence, inputIndex: 0, lockTime: tx.lockTime
  })
}
const spend = mkSpend()
let ifStats = { normIfTotal: 0, normIfTaken: 0, signNotifTotal: 0, signNotifTaken: 0, maxItemLen: 0, maxItemAt: -1, modDividendLens: {} }
function stepOnce () {
  if (spend.context === 'LockingScript') {
    const pc = spend.programCounter, c = ch[pc]
    if (c && !c.data && pc >= 216 && pc < 22640) {
      const top = spend.stack[spend.stack.length - 1]
      if (c.op === OP.OP_IF && ch[pc - 1].op === OP.OP_LESSTHAN) { ifStats.normIfTotal++; if (top.length) ifStats.normIfTaken++ }
      if (c.op === OP.OP_NOTIF && ch[pc + 1].op === OP.OP_FROMALTSTACK) { ifStats.signNotifTotal++; if (!top.length) ifStats.signNotifTaken++ }
      if (c.op === OP.OP_MOD && ch[pc - 1].op === OP.OP_TOALTSTACK) { const d = spend.stack[spend.stack.length - 2].length; ifStats.modDividendLens[d] = (ifStats.modDividendLens[d] || 0) + 1 }
    }
  }
  spend.step()
  if (spend.context === 'LockingScript') for (const it of spend.stack) if (it.length > ifStats.maxItemLen) { ifStats.maxItemLen = it.length; ifStats.maxItemAt = spend.programCounter - 1 }
}
function runTo (pc) { // run until the locking-script chunk `pc` is the NEXT chunk to execute
  let guard = 0
  while (!(spend.context === 'LockingScript' && spend.programCounter === pc)) { stepOnce(); if (++guard > 40000) throw new Error('runTo overrun ' + pc) }
}
const top = (k) => snum(spend.stack[spend.stack.length - 1 - k])   // k=0 top
const results = []
const ok = (label, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' ' + extra : ''}`); if (!cond) process.exitCode = 1 }

// ---------- 1. state at column-0 entry (chunk 333) ----------
runTo(333)
const depth333 = spend.stack.length
ok('depth at 333 == 134 (r,u1p,u2p,128 consts,X,Y,Z)', depth333 === 134, `depth=${depth333} alt=${spend.altStack.length}`)
const [Z0, Y0, X0] = [top(0), top(1), top(2)]
ok('accumulator init == (1,1,0)', X0 === 1n && Y0 === 1n && Z0 === 0n)
const u2p = top(131), u1p = top(132), r = top(133)
const consts = []; for (let i = 0; i < 128; i++) consts.push(top(130 - i))  // consts[i] == chunk 87+i
ok('consts[i] == chunk 87+i', consts.every((v, i) => v === snum(ch[87 + i].data)))
const TG = [], TQ = []
for (let j = 0; j < 32; j++) { TG.push(Pt.fromAffine({ x: consts[2 * j], y: consts[2 * j + 1] })); TQ.push(Pt.fromAffine({ x: consts[64 + 2 * j], y: consts[64 + 2 * j + 1] })) }
ok('altstack top == p at 333', snum(spend.altStack[spend.altStack.length - 1]) === P, `alt=${spend.altStack.length}`)

// recoding check: u' == (u + [n if u even] + 2^258 - 1) / 2  (NOT 2^254 - 1)
const u = unlock.chunks.map(c => c.data)
const rU = snum(u[0]), sInv = snum(u[2])
const le32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
const preimage = [].concat(le32(1), Hash.hash256(u[4]), Hash.hash256([255, 255, 255, 255]), u[4], [0x01, 0xac], [0xf8, 0x11, 0, 0, 0, 0, 0, 0], [255, 255, 255, 255], u[3], le32(0), le32(0x41))
const eLE = snum([...Hash.hash256(preimage), 0])
const u1 = mod(eLE * sInv, N), u2 = mod(rU * sInv, N)
const recode = (uu, K) => { let v = uu; if (v % 2n === 0n) v += N; return (v + (1n << K) - 1n) / 2n }
ok('u1p == recode(u1, 2^258-1)', u1p === recode(u1, 258n), `u1p bits=${u1p.toString(2).length}`)
ok('u2p == recode(u2, 2^258-1)', u2p === recode(u2, 258n), `u2p bits=${u2p.toString(2).length}`)
ok('u1p != recode(u1, 2^254-1) (CONTEXT typo)', u1p !== recode(u1, 254n))
ok('chunk 70 constant == 2^258-1', snum(ch[70].data) === (1n << 258n) - 1n)
ok('r (idx 133) == unlock r', r === rU)

// ---------- 2. digit extraction model ----------
const bit = (v, i) => Number((v >> BigInt(i)) & 1n)
function digit (up, c) { // returns {b5, j, sign}
  const pos = [42 - c, 85 - c, 128 - c, 171 - c, 214 - c, 257 - c] // k = 0..5
  const b = pos.map(i => bit(up, i)); const b5 = b[5]
  let j = 0; for (let k = 0; k < 5; k++) j |= (b[k] === b5 ? 1 : 0) << k
  return { b5, j, sign: b5 ? 1n : -1n }
}
const colPoint = (T, up, c) => { const d = digit(up, c); const pt = T[d.j]; return { ...d, pt: d.b5 ? pt : pt.negate() } }
// expected accumulators (Horner: acc = 2*acc + PG + PQ)
const expAfterAdds = [], expAfterDbl = []
let acc = Pt.ZERO
for (let c = 0; c <= 42; c++) { acc = acc.double(); acc = acc.add(colPoint(TG, u1p, c).pt).add(colPoint(TQ, u2p, c).pt); expAfterAdds.push(acc); expAfterDbl.push(acc.double()) }
const R = G.multiply(u1).add(Pt.fromHex('03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d').multiply(u2))
ok('comb model total == u1*G + u2*Q', expAfterAdds[42].equals(R))
ok('comb model total x == r mod p', mod(R.x, P) === mod(r, P))

// ---------- 3. compare stack accumulator at boundaries ----------
const start = c => c === 0 ? 333 : 333 + 536 + 521 * (c - 1)
const endAdds = c => start(c) + (c === 0 ? 536 : 521) - 111   // first chunk of the trailing DOUBLE block (or tail start for c=42)
function checkAcc (label, pt) {
  const Z = top(0), Y = top(1), X = top(2)
  const jac = mod(pt.x * Z * Z, P) === X && mod(pt.y * Z * Z * Z, P) === Y
  const proj = mod(pt.x * Z, P) === X && mod(pt.y * Z, P) === Y
  ok(`${label} Jacobian X==x*Z^2,Y==y*Z^3`, jac, `(projective X==xZ,Y==yZ: ${proj}) X,Y,Z reduced: ${X < P && X >= 0n && Y < P && Y >= 0n && Z < P && Z >= 0n}`)
}
const colsToCheck = [0, 1, 2, 3, 10, 25, 26, 41, 42]
for (const c of colsToCheck) {
  runTo(endAdds(c)); checkAcc(`col${c} after both adds (pc ${endAdds(c)})`, expAfterAdds[c])
  if (c < 42) { runTo(start(c + 1)); checkAcc(`col${c} after DOUBLE (pc ${start(c + 1)})`, expAfterDbl[c]) }
}
// col 42 ends at 22640 = tail start: accumulator == R
ok('endAdds(42) == 22640', endAdds(42) === 22640)
// tail check X == r*Z^2 mod p
{ const Z = top(0), X = top(2); ok('tail relation X == r*Z^2 mod p holds at 22640', mod(r * Z * Z, P) === X) }

// ---------- 4. field-op sequence verification inside column 1 ----------
const s2 = mkSpend(); const sp = { spend: s2 }
function runTo2 (pc) { let g = 0; while (!(s2.context === 'LockingScript' && s2.programCounter === pc)) { s2.step(); if (++g > 40000) throw new Error('overrun') } }
const top2 = k => snum(s2.stack[s2.stack.length - 1 - k])
// (a) digit + table lookup + sign for the G add of col 1: after ENDIF at 950 → next pc 951, stack top = x, y'
runTo2(944) // at NOTIF: top = b5, below y_j, x_j
{ const b5 = top2(0), yj = top2(1), xj = top2(2); const d = digit(u1p, 1)
  ok('col1 G digit: b5 on stack == model', b5 === BigInt(d.b5), `b5=${b5} j=${d.j}`)
  ok('col1 G lookup: (x_j,y_j) == TG[j] (before sign)', xj === TG[d.j].x && yj === TG[d.j].y) }
runTo2(951)
{ const y = top2(0), x = top2(1), Z = top2(2), Y = top2(3), X = top2(4); const cp = colPoint(TG, u1p, 1)
  ok('col1 G add operand == sign*TG[j] (y = p-y when b5==0)', x === cp.pt.x && y === cp.pt.y, `b5=${cp.b5}`)
  // now check each intermediate of MADD
  const Z2 = Z * Z, U2 = x * Z2, Z3 = Z * Z2, S2 = y * Z3, H = U2 - X, Rr = S2 - Y, H2 = H * H, H3 = H * H2, I = X * H2
  const X3u = Rr * Rr - H3 - 2n * I; let X3 = X3u % P; if (X3 < 0n) X3 += P
  const Y3u = Rr * (I - X3) - Y * H3; let Y3 = Y3u % P; if (Y3 < 0n) Y3 += P
  const Z3u = Z * H; let Zn = Z3u % P; if (Zn < 0n) Zn += P
  runTo2(955); ok('madd 954: top == Z^2 (unreduced)', top2(0) === Z2)
  runTo2(959); ok('madd 958: top == U2 = x*Z^2', top2(0) === U2)
  runTo2(964); ok('madd 963: top == Z^3', top2(0) === Z3)
  runTo2(969); ok('madd 968: top == S2 = y*Z^3', top2(0) === S2, `len ${s2.stack[s2.stack.length - 1].length}B`)
  runTo2(974); ok('madd 973: top == H = U2 - X', top2(0) === H)
  runTo2(979); ok('madd 978: top == R = S2 - Y', top2(0) === Rr)
  runTo2(982); ok('madd 981: top == H^2', top2(0) === H2)
  runTo2(986); ok('madd 985: top == H^3', top2(0) === H3, `len ${s2.stack[s2.stack.length - 1].length}B`)
  runTo2(991); ok('madd 990: top == I = X*H^2', top2(0) === I)
  runTo2(1005); ok('madd 1004: top == R^2 - H^3 - 2I (unreduced, before MOD)', top2(0) === X3u, `len ${s2.stack[s2.stack.length - 1].length}B neg=${X3u < 0n}`)
  runTo2(1018); ok('madd 1017: top == X3 reduced to [0,p)', top2(0) === X3)
  runTo2(1037); ok('madd 1036: top == R*(I-X3) - Y*H^3 (unreduced)', top2(0) === Y3u, `neg=${Y3u < 0n}`)
  runTo2(1050); ok('madd 1049: top == Y3 reduced', top2(0) === Y3)
  runTo2(1055); ok('madd 1054: top == Z*H (unreduced)', top2(0) === Z3u)
  runTo2(1074); ok('madd exit 1073: stack top == X3,Y3,Z3 (Z on top)', top2(0) === Zn && top2(1) === Y3 && top2(2) === X3)
  ok('madd exit depth back to 134', s2.stack.length === 134)
}
// (c) Q add of col 1 operand check
runTo2(1156)
{ const y = top2(0), x = top2(1); const cp = colPoint(TQ, u2p, 1); ok('col1 Q add operand == sign*TQ[j]', x === cp.pt.x && y === cp.pt.y, `b5=${cp.b5} j=${cp.j}`) }
// (b) the DOUBLE block at 1279..1389
runTo2(1279)
{ const Z = top2(0), Y = top2(1), X = top2(2)
  const Z2 = Z * Z, M = 3n * (X - Z2) * (X + Z2), Y2 = Y * Y, S = 4n * X * Y2, X3u = M * M - 2n * S
  let X3 = X3u % P; if (X3 < 0n) X3 += P
  const Y4 = Y2 * Y2, Y3u = M * (S - X3) - 8n * Y4; let Y3 = Y3u % P; if (Y3 < 0n) Y3 += P
  const Z3u = 2n * Y * Z; let Z3 = Z3u % P; if (Z3 < 0n) Z3 += P
  runTo2(1282); ok('dbl 1281: top == Z^2', top2(0) === Z2)
  runTo2(1286); ok('dbl 1285: top == X - Z^2', top2(0) === X - Z2)
  runTo2(1291); ok('dbl 1290: top == X + Z^2', top2(0) === X + Z2)
  runTo2(1298); ok('dbl 1297: top == M = 3(X-Z^2)(X+Z^2) (unreduced)', top2(0) === M)
  runTo2(1302); ok('dbl 1301: top == Y^2', top2(0) === Y2)
  runTo2(1308); ok('dbl 1307: top == S = 4*X*Y^2', top2(0) === S)
  runTo2(1312); ok('dbl 1311: top == M^2', top2(0) === M * M, `len ${s2.stack[s2.stack.length - 1].length}B`)
  runTo2(1319); ok('dbl 1318: top == M^2 - 2S (unreduced)', top2(0) === X3u)
  runTo2(1332); ok('dbl 1331: top == X3 reduced', top2(0) === X3)
  runTo2(1347); ok('dbl 1346: top == 8*Y^4', top2(0) === 8n * Y4, `len ${s2.stack[s2.stack.length - 1].length}B`)
  runTo2(1352); ok('dbl 1351: top == M(S-X3) - 8Y^4 (unreduced)', top2(0) === Y3u)
  runTo2(1365); ok('dbl 1364: top == Y3 reduced', top2(0) === Y3)
  runTo2(1371); ok('dbl 1370: top == 2*Y*Z', top2(0) === Z3u)
  runTo2(1390); ok('dbl exit 1389: (X3,Y3,Z3)', top2(0) === Z3 && top2(1) === Y3 && top2(2) === X3)
  ok('dbl result == 2*acc (noble)', mod(expAfterDbl[1].x * Z3 * Z3, P) === X3 && mod(expAfterDbl[1].y * Z3 * Z3 * Z3, P) === Y3)
}
// (d) col 0 guard: Z==0 branch taken; after it acc == (x,y,1)
{ // fresh interpreter: state right after col-0's guarded first add (ENDIF at 552 is the next chunk)
  const s3 = mkSpend(); let g = 0
  while (!(s3.context === 'LockingScript' && s3.programCounter === 419)) { s3.step(); if (++g > 40000) throw new Error('overrun3') }
  const cond = s3.stack[s3.stack.length - 1]; ok('col0 guard: IF condition (Z==0) is TRUE at 419', cond.length === 1 && cond[0] === 1)
  while (!(s3.context === 'LockingScript' && s3.programCounter === 552)) { s3.step(); if (++g > 40000) throw new Error('overrun3') }
  const t3 = k => snum(s3.stack[s3.stack.length - 1 - k]); const Z = t3(0), Y = t3(1), X = t3(2); const cp = colPoint(TG, u1p, 0)
  ok('col0 guard: after first G add acc == (x, y, 1) affine-as-Jacobian', X === cp.pt.x && Y === cp.pt.y && Z === 1n)
  ok('col0 guard: depth 134 at 552', s3.stack.length === 134) }

// ---------- 5. generator: re-emit chunks 216..22639 from the template and byte-compare ----------
const B = new Script()
const op = (...names) => { for (const nm of names) { if (typeof nm === 'number') B.writeNumber(nm); else B.writeOpCode(OP['OP_' + nm]) } }
const MODP = () => op('FROMALTSTACK', 'DUP', 'TOALTSTACK', 'MOD')
const NORM = () => op('DUP', 0, 'LESSTHAN', 'IF', 'FROMALTSTACK', 'DUP', 'TOALTSTACK', 'ADD', 'ENDIF')
function DOUBLE () {
  op('DUP', 'DUP', 'MUL')                       // Z^2
  op(3, 'PICK', 'OVER', 'SUB')                  // X - Z^2
  op(4, 'PICK', 2, 'ROLL', 'ADD')               // X + Z^2
  op(1, 'ROLL', 1, 'ROLL')                      // (no-op swap pair)
  op('MUL', 3, 'MUL')                           // M = 3(X-Z^2)(X+Z^2)
  op(2, 'PICK', 'DUP', 'MUL')                   // Y^2
  op(4, 'ROLL', 'OVER', 'MUL', 4, 'MUL')        // S = 4*X*Y^2
  op(2, 'PICK', 'DUP', 'MUL')                   // M^2
  op('OVER', '2MUL')                            // 2S
  op(1, 'ROLL', 1, 'ROLL')                      // (no-op)
  op('SUB'); MODP(); NORM()                     // X3 = M^2 - 2S mod p
  op(1, 'ROLL', 'OVER', 'SUB')                  // S - X3
  op(3, 'ROLL', 1, 'ROLL', 'MUL')               // M(S - X3)
  op(2, 'ROLL', 'DUP', 'MUL', 8, 'MUL')         // 8Y^4
  op(1, 'ROLL', 1, 'ROLL', 'SUB'); MODP(); NORM() // Y3 = M(S-X3) - 8Y^4 mod p
  op(3, 'ROLL', 3, 'ROLL', 'MUL', '2MUL'); MODP(); NORM() // Z3 = 2YZ mod p
  op(2, 'ROLL', 2, 'ROLL', 2, 'ROLL')           // (no-op rotation)
}
function MADD () {
  op(2, 'PICK', 'DUP', 'MUL')                   // Z^2
  op(2, 'ROLL', 'OVER', 'MUL')                  // U2 = x*Z^2
  op(3, 'PICK', 2, 'ROLL', 'MUL')               // Z^3
  op(2, 'ROLL', 1, 'ROLL', 'MUL')               // S2 = y*Z^3
  op(1, 'ROLL', 4, 'PICK', 'SUB')               // H = U2 - X
  op(1, 'ROLL', 3, 'PICK', 'SUB')               // R = S2 - Y
  op('OVER', 'DUP', 'MUL')                      // H^2
  op(2, 'PICK', 'OVER', 'MUL')                  // H^3
  op(6, 'ROLL', 2, 'ROLL', 'MUL')               // I = X*H^2
  op(2, 'PICK', 'DUP', 'MUL')                   // R^2
  op('OVER', '2MUL')                            // 2I
  op(1, 'ROLL', 3, 'PICK', 'SUB')               // R^2 - H^3
  op(1, 'ROLL', 'SUB'); MODP(); NORM()          // X3 = R^2 - H^3 - 2I mod p
  op(1, 'ROLL', 'OVER', 'SUB')                  // I - X3
  op(3, 'ROLL', 1, 'ROLL', 'MUL')               // R(I - X3)
  op(5, 'ROLL', 3, 'ROLL', 'MUL')               // Y*H^3
  op(1, 'ROLL', 1, 'ROLL', 'SUB'); MODP(); NORM() // Y3 = R(I-X3) - Y*H^3 mod p
  op(3, 'ROLL', 3, 'ROLL', 'MUL'); MODP(); NORM() // Z3 = Z*H mod p
  op(2, 'ROLL', 2, 'ROLL', 2, 'ROLL')
}
function ADD (s, c, guarded) { // s = 0 (u1', G table) or 1 (u2', Q table)
  const sd = 132 - s, tb = 132 - 64 * s
  op(sd, 'PICK', 257 - c, 'RSHIFTNUM', 2, 'MOD')                              // b5 (sign)
  op(sd + 1, 'PICK', 214 - c, 'RSHIFTNUM', 2, 'MOD', 'OVER', 'NUMEQUAL', '2MUL') // j = 2*(b4==b5)
  for (const pos of [171 - c, 128 - c, 85 - c]) op(sd + 2, 'PICK', pos, 'RSHIFTNUM', 2, 'MOD', 2, 'PICK', 'NUMEQUAL', 'ADD', '2MUL')
  op(sd + 2, 'PICK', 42 - c, 'RSHIFTNUM', 2, 'MOD', 2, 'PICK', 'NUMEQUAL', 'ADD') // j complete (bit0)
  op('DUP', '2MUL', tb, 'SWAP', 'SUB', 'PICK')                                 // x_j
  op('OVER', '2MUL', tb, 'SWAP', 'SUB', 'PICK')                                // y_j
  op(2, 'ROLL', 'DROP', 2, 'ROLL')                                             // drop j; b5 to top
  op('NOTIF', 'FROMALTSTACK', 'DUP', 'TOALTSTACK', 'SWAP', 'SUB', 'ENDIF')     // y = p - y if b5 == 0
  if (guarded) op(2, 'PICK', 0, 'NUMEQUAL', 'IF', 'TOALTSTACK', 'TOALTSTACK', 'DROP', 'DROP', 'DROP', 'FROMALTSTACK', 'FROMALTSTACK', 1, 'ELSE')
  MADD()
  if (guarded) op('ENDIF')
}
// pre-loop
op('FROMALTSTACK', 'DROP', 'TOALTSTACK', 1, 1, 0)
for (let c = 0; c <= 42; c++) { DOUBLE(); ADD(0, c, c === 0); ADD(1, c, false) }
const genHex = B.toHex()
const actHex = new Script(ch.slice(216, 22640)).toHex()
ok('generated chunks 216..22639 byte-identical to script', genHex === actHex, `gen ${genHex.length / 2}B act ${actHex.length / 2}B`)
if (genHex !== actHex) { let i = 0; while (genHex[i] === actHex[i]) i++; results.push(`  first byte diff at gen offset ${i >> 1}: gen ${genHex.slice(i - 8, i + 16)} act ${actHex.slice(i - 8, i + 16)}`) }
ok('generated chunk count == 22640-216', B.chunks.length === 22640 - 216, `gen ${B.chunks.length}`)
// encoding rule: every varying constant is the SDK minimal number push
const encOK = []
for (const n of [0, 1, 16, 17, 41, 42, 68, 127, 128, 131, 132, 133, 134, 213, 214, 255, 256, 257]) encOK.push(`${n}:${new Script().writeNumber(n).toHex()}`)
results.push('encoding samples: ' + encOK.join(' '))

// ---------- 6. stats from the full run ----------
runTo(22640)
results.push(`stats: normalization IFs (after LESSTHAN) total=${ifStats.normIfTotal} taken(neg)=${ifStats.normIfTaken}; sign NOTIFs total=${ifStats.signNotifTotal} taken(b5==0 → y=p-y)=${ifStats.signNotifTaken}`)
results.push(`stats: max stack item ${ifStats.maxItemLen}B produced by chunk ${ifStats.maxItemAt} (${OP[ch[ifStats.maxItemAt].op]}); OP_MOD dividend byte-lengths: ${Object.entries(ifStats.modDividendLens).sort((a, b) => a[0] - b[0]).map(([k, v]) => k + 'B×' + v).join(' ')}`)
// digits table for cols 0..2 and 42
for (const c of [0, 1, 2, 42]) { const g = digit(u1p, c), q = digit(u2p, c); results.push(`digits col${c}: u1' b5=${g.b5} j=${g.j} (${g.b5 ? '+' : '-'}TG[${g.j}]) | u2' b5=${q.b5} j=${q.j} (${q.b5 ? '+' : '-'}TQ[${q.j}])`) }
console.log(results.join('\n'))
fs.writeFileSync(process.env.S + '/map-column.out.txt', results.join('\n'))
