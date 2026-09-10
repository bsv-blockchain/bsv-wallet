import fs from 'fs'
import { Script, Transaction, Hash } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn, N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n, A = P-3n, B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn
const Pt = p256.Point, G = Pt.BASE
const mod=(a,m)=>((a%m)+m)%m, pw=(b,e,m)=>{let r=1n;b=mod(b,m);while(e>0n){if(e&1n)r=r*b%m;b=b*b%m;e>>=1n}return r}, inv=(a,m)=>pw(a,m-2n,m)
const le = bytes => { let v=0n; for (let i=bytes.length-1;i>=0;i--) v=(v<<8n)|BigInt(bytes[i]); return v }
const scriptNum = bytes => { if(!bytes.length) return 0n; const neg=(bytes[bytes.length-1]&0x80)!==0; const b=[...bytes]; b[b.length-1]&=0x7f; const v=le(b); return neg?-v:v }
const lockHex = fs.readFileSync('docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex','utf8').trim()
const txHex = fs.readFileSync('docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex','utf8').trim()
const lock = Script.fromHex(lockHex); const tx = Transaction.fromHex(txHex)
const u = tx.inputs[0].unlockingScript.chunks.map(c=>c.data)
const r = scriptNum(u[0]), s = scriptNum(u[1]), sInv = scriptNum(u[2])
console.log('r', r.toString(16)); console.log('s', s.toString(16)); console.log('s*sInv mod n =', (s*sInv%N).toString())
// preimage as script builds it
const hashOutputs = u[3], outpoint = u[4]
const cat=(...a)=>a.flat()
const le32=(n)=>[n&255,(n>>8)&255,(n>>16)&255,(n>>>24)&255]
const preimage = cat(le32(1), Hash.hash256(outpoint), Hash.hash256([255,255,255,255]), outpoint, [0x01,0xac], [0xf8,0x11,0,0,0,0,0,0], [255,255,255,255], hashOutputs, le32(0), le32(0x41))
console.log('preimage len', preimage.length)
const eBytes = Hash.hash256(preimage); const e = le(eBytes)  // script: cat 00, bin2num => LE
console.log('e (LE interp)', e.toString(16))
// check against sdk sighash for this input
// recover Q: Q = r^-1 (s R - e G), R = (r, y)
const rhs = mod(r*r*r + A*r + B, P); let y = pw(rhs,(P+1n)/4n,P); if (y*y%P!==rhs) console.log('r not valid x!')
const cands=[]
for (const yy of [y, P-y]) { const R = Pt.fromAffine({x:r,y:yy}); const rInv=inv(r,N); const Q = R.multiply(s).subtract(G.multiply(mod(e,N))).multiply(rInv); cands.push(Q); console.log('Q cand', Q.toHex(true)) }
// also try e as BE interp
const eBE = BigInt('0x'+Buffer.from(eBytes).toString('hex'))
for (const yy of [y, P-y]) { const R = Pt.fromAffine({x:r,y:yy}); const Q = R.multiply(s).subtract(G.multiply(mod(eBE,N))).multiply(inv(r,N)); console.log('Q cand (BE e)', Q.toHex(true)) }
// collect constant points from script chunks 87..214
const consts=[]; for (let i=87;i<=214;i++) consts.push(scriptNum(lock.chunks[i].data))
const pts=[]; for (let i=0;i+1<consts.length;i+=2){ try{ const p=Pt.fromAffine({x:consts[i],y:consts[i+1]}); p.assertValidity(); pts.push({idx:87+i,p}) }catch{ pts.push({idx:87+i,p:null}) } }
console.log('points parsed', pts.filter(x=>x.p).length, 'of', pts.length)
// build lookup of candidate multiples
const table = new Map()
const add=(pt,name)=>{ table.set(pt.toHex(true), name) }
const bases = [['G',G]]; cands.forEach((Q,i)=>bases.push([`Q${i}`,Q]))
if (cands.length>=1) { bases.push(['G+Q0', G.add(cands[0])]); bases.push(['G-Q0', G.subtract(cands[0])]); bases.push(['G+Q1', G.add(cands[1])]); bases.push(['G-Q1', G.subtract(cands[1])]) }
for (const [name,Bp] of bases) { for (let j=0n;j<=260n;j++){ const base = Bp.multiply(mod(1n<<j, N)); for (let k=1n;k<=16n;k++){ add(base.multiply(k), `${k}*2^${j}*${name}`); add(base.multiply(k).negate(), `-${k}*2^${j}*${name}`) } } }
console.log('table size', table.size)
for (const {idx,p} of pts) { if(!p) { console.log(idx,'not a point'); continue } const h=p.toHex(true); console.log(idx, table.get(h) ?? 'UNKNOWN', h.slice(0,20)) }
// also check ratios between consecutive points: p[i+1] == 2^k p[i]?
console.log('--- consecutive ratios ---')
for (let i=0;i+1<pts.length;i++){ if(!pts[i].p||!pts[i+1].p) continue; let found='?'; let cur=pts[i].p; for (let k=1;k<=64;k++){ cur=cur.double(); if (cur.equals(pts[i+1].p)) { found=`2^${k}`; break } } console.log(`pt${i}->pt${i+1}: ${found}`) }
