import fs from 'fs'
import { Script, Transaction, Hash, PrivateKey, BigNumber } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn, N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n, A = P-3n, B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn
const Pt = p256.Point, G = Pt.BASE
const mod=(a,m)=>((a%m)+m)%m, pw=(b,e,m)=>{let r=1n;b=mod(b,m);while(e>0n){if(e&1n)r=r*b%m;b=b*b%m;e>>=1n}return r}, inv=(a,m)=>pw(a,m-2n,m)
const le = bytes => { let v=0n; for (let i=bytes.length-1;i>=0;i--) v=(v<<8n)|BigInt(bytes[i]); return v }
const scriptNum = bytes => { if(!bytes.length) return 0n; const neg=(bytes[bytes.length-1]&0x80)!==0; const b=[...bytes]; b[b.length-1]&=0x7f; const v=le(b); return neg?-v:v }
const lock = Script.fromHex(fs.readFileSync('docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex','utf8').trim())
const tx = Transaction.fromHex(fs.readFileSync('docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex','utf8').trim())
const u = tx.inputs[0].unlockingScript.chunks.map(c=>c.data)
const r = scriptNum(u[0]), s = scriptNum(u[1])
const cat=(...a)=>a.flat(); const le32=(n)=>[n&255,(n>>8)&255,(n>>16)&255,(n>>>24)&255]
const preimage = cat(le32(1), Hash.hash256(u[4]), Hash.hash256([255,255,255,255]), u[4], [0x01,0xac], [0xf8,0x11,0,0,0,0,0,0], [255,255,255,255], u[3], le32(0), le32(0x41))
const eBytes = Hash.hash256(preimage); const eLE = le(eBytes), eBE = BigInt('0x'+Buffer.from(eBytes).toString('hex'))
const rhs = mod(r*r*r + A*r + B, P); const y = pw(rhs,(P+1n)/4n,P)
const cands=[]
for (const [en,e] of [['LE',eLE],['BE',eBE]]) for (const yy of [y,P-y]) { const R=Pt.fromAffine({x:r,y:yy}); cands.push([en, R.multiply(s).subtract(G.multiply(mod(e,N))).multiply(inv(r,N))]) }
const consts=[]; for (let i=87;i<=214;i++) consts.push(scriptNum(lock.chunks[i].data))
const pts=[]; for (let i=0;i<consts.length;i+=2) pts.push(Pt.fromAffine({x:consts[i],y:consts[i+1]}))
const key = p=>p.toHex(true)
const ptIdx = new Map(pts.map((p,i)=>[key(p),i]))
// comb table: rows W=6, stride D=43. entry j (0..31): scalar = 2^(43*5) + sum_{k<5} (bit_k(j)?+1:-1) * 2^(43k)
function combTable(base, W=6, D=43) { const out=[]; for (let j=0;j<(1<<(W-1));j++){ let sc = 1n<<BigInt(D*(W-1)); for (let k=0;k<W-1;k++){ const d = ((j>>k)&1)? 1n : -1n; sc += d * (1n<<BigInt(D*k)) } out.push({j, sc, pt: base.multiply(mod(sc,N))}) } return out }
for (const [name,base] of [['G',G], ...cands.map(([en,Q],i)=>[`Q${i}(${en})`,Q])]) {
  const tab = combTable(base); let hits=0; const where=[]
  for (const t of tab){ const i=ptIdx.get(key(t.pt)); if (i!==undefined){hits++; where.push(`j${t.j}->pt${i}`)} }
  console.log(name, 'hits', hits, where.slice(0,40).join(' '))
  // also try negated y variants and alternative digit conventions (bit -> -1/+1 swapped)
  const tab2 = tab.map(t=>({...t, pt: t.pt.negate()})); let h2=0; for (const t of tab2){ if (ptIdx.has(key(t.pt))) h2++ } console.log('  negated hits', h2)
  const tab3 = combTable(base).map(t=>{ let sc = 1n<<BigInt(43*5); for (let k=0;k<5;k++){ const d = ((t.j>>k)&1)? -1n : 1n; sc += d*(1n<<BigInt(43*k)) } return base.multiply(mod(sc,N)) }); let h3=0; for (const p of tab3) if (ptIdx.has(key(p))) h3++; console.log('  swapped-digit hits', h3)
}
// OP_PUSH_TX key: d = 2^248 * Gx^-1 mod n_k1 ?
const NK = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
const GxK = BigInt('0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
const d = mod((1n<<248n) * inv(GxK, NK), NK)
const pk = new PrivateKey(d.toString(16), 16)
console.log('derived pushtx pubkey', pk.toPublicKey().toString(), ' script has 02b405d7f0322a89d0f9f3a98e6f938fdc1c969a8d1382a2bf66a71ae74a1e83b0')
// verify the actual sighash the SDK computes for this input with subscript OP_CHECKSIG
import { TransactionSignature, LockingScript } from '@bsv/sdk'
const src = new Transaction(); src.addOutput({satoshis:4600, lockingScript: LockingScript.fromHex(fs.readFileSync('docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex','utf8').trim())})
const pre = TransactionSignature.format({ sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: 0, sourceSatoshis: 4600, transactionVersion: 1, otherInputs: [], inputIndex: 0, outputs: tx.outputs, inputSequence: 0xffffffff, subscript: LockingScript.fromHex('ac'), lockTime: 0, scope: 0x41 })
console.log('sdk preimage == script preimage:', Buffer.from(pre).toString('hex') === Buffer.from(preimage).toString('hex'), 'len', pre.length)
