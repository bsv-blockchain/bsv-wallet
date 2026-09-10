// map-tail.mjs — reproduce the tail (chunks 22736..23066) in plain JS from the
// fixture preimage, assert the produced CHECKSIG-format signature equals what the
// SDK interpreter pushes to CHECKSIG, and empirically measure DER-rejection
// probability over random e. Also verifies the P-256 r-comparison (projective X == r*Z^2).
import fs from 'fs'
import { Script, Transaction, Spend, OP, LockingScript, BigNumber, Hash } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
const R = '/Users/personal/git/bsv-wallet/'
const lockHex = fs.readFileSync(R+'docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex','utf8').trim()
const txHex  = fs.readFileSync(R+'docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex','utf8').trim()
const tx = Transaction.fromHex(txHex)
const lock = LockingScript.fromHex(lockHex)
const unlock = tx.inputs[0].unlockingScript
const hex = a => Buffer.from(a).toString('hex')
const toBE = (buf) => BigInt('0x'+(hex(buf)||'0'))            // big-endian bytes -> bigint
const toLE = (buf) => BigInt('0x'+(hex([...buf].reverse())||'0'))

// ---- curve constants ----
const NK = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n // secp256k1 n
const GXK = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'   // secp256k1 Gx
const HALF = (NK-1n)/2n
const P   = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn // P-256 p
const NP  = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n // P-256 n

// ---- 1) get the fixture preimage by stepping SDK to the FROMALTSTACK at chunk 22736 ----
function newSpend(){ return new Spend({ sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex:0, sourceSatoshis:4600,
  lockingScript: lock, transactionVersion: tx.version, otherInputs:[], outputs: tx.outputs,
  unlockingScript: unlock, inputSequence: tx.inputs[0].sequence, inputIndex:0, lockTime: tx.lockTime }) }
let sp = newSpend()
// step until lock pc == 22736 has just executed (stack[0] = preimage)
let preimage=null, onStackR=null
while(true){ const ctx=sp.context, pc=sp.programCounter, script=ctx==='UnlockingScript'?unlock:lock
  if(pc>=script.chunks.length){ if(ctx==='UnlockingScript'){sp.step();continue} else break }
  const wasLock = ctx==='LockingScript'
  sp.step()
  if(wasLock && pc===22736){ preimage = sp.stack[0].slice(); break }
}
console.log('preimage len', preimage.length, 'hash256=', hex(Hash.hash256(preimage)))

// ---- tail-in-JS: from preimage -> CHECKSIG-format signature ----
function minimalBE(x){ // minimal big-endian bytes of a nonneg bigint, [] for 0
  if(x===0n) return []
  let h=x.toString(16); if(h.length%2) h='0'+h
  return [...Buffer.from(h,'hex')]
}
function tailSig(preimageBytes){
  const h = Hash.hash256(preimageBytes)          // hash256, natural (BE) bytes
  const e = toBE(h)                              // script reverses LE->BE then BIN2NUM == BE numeric value
  const m = e + (1n<<248n)                       // + 2^248
  const t = m % NK                               // reduce mod n  (script: only when m>half, but m<=half => m<n => t=m)
  const s = (t > HALF) ? (NK - t) : t            // low-S: min(t, n-t)
  const sBE = minimalBE(s)                       // minimal big-endian, NO leading-zero pad
  const rInt = [0x02,0x20,...Buffer.from(GXK,'hex')]
  const sInt = [0x02, sBE.length, ...sBE]
  const body = [...rInt,...sInt]
  const der  = [0x30, body.length, ...body]
  const sig  = [...der, 0x41]
  return { e,m,t,s,sBE,sig }
}
// DER-rejection predicate (matches SDK isChecksigFormatHelper + Signature.fromDER strict rules)
function derRejected({s,sBE}){
  if(s===0n) return 'S_len_zero'                 // 02 00 -> zero length S
  if(sBE.length>=1 && (sBE[0]&0x80)!==0) return 'S_negative_needs_pad' // high bit set, no 0x00 pad
  return null
}

const R0 = tailSig(preimage)
const sigHex = hex(R0.sig)
console.log('JS tail sig =', sigHex)
console.log('JS s (BE)   =', hex(R0.sBE), 'len', R0.sBE.length, 's<=half:', R0.s<=HALF)

// ---- assert against SDK: capture the exact bytes pushed to CHECKSIG (chunk 23063 result) ----
sp = newSpend(); let checksigSigHex=null, checksigPubHex=null
while(true){ const ctx=sp.context, pc=sp.programCounter, script=ctx==='UnlockingScript'?unlock:lock
  if(pc>=script.chunks.length){ if(ctx==='UnlockingScript'){sp.step();continue} else break }
  const wasLock=ctx==='LockingScript'
  sp.step()
  if(wasLock && pc===23063){ checksigSigHex = hex(sp.stack[sp.stack.length-1]) }
  if(wasLock && pc===23064){ checksigPubHex = hex(sp.stack[sp.stack.length-1]) }
}
console.log('SDK CHECKSIG sig =', checksigSigHex)
console.log('SDK CHECKSIG pub =', checksigPubHex)
console.log('ASSERT sig match :', sigHex===checksigSigHex)

// full validate
console.log('ASSERT validate():', newSpend().validate())

// ---- verify d*G == pubkey (k=1 OP_PUSH_TX private key is public) ----
const d = (1n<<248n) * modinv(BigInt('0x'+GXK), NK) % NK
function modinv(a,mod){ let [g,x]=egcd(((a%mod)+mod)%mod,mod); return ((x%mod)+mod)%mod }
function egcd(a,b){ if(b===0n) return [a,1n,0n]; const [g,x,y]=egcd(b,a%b); return [g,y,x-(a/b)*y] }
// use @bsv/sdk PrivateKey/PublicKey (secp256k1)
import { PrivateKey } from '@bsv/sdk'
const dHex = d.toString(16).padStart(64,'0')
const pk = new PrivateKey(dHex,16)
console.log('d =', dHex)
console.log('d*G pub =', pk.toPublicKey().toDER('hex'))
console.log('ASSERT pubkey match:', pk.toPublicKey().toDER('hex')==='02b405d7f0322a89d0f9f3a98e6f938fdc1c969a8d1382a2bf66a71ae74a1e83b0')

// ---- verify P-256 r-comparison: r == affine x of (u1*G + u2*Q) mod p, NOT reduced mod n ----
// unlock pushes bottom->top: r(33), s(32), sInv(32), hashOutputs(32), outpoint(36)
const uc = unlock.chunks.filter(c=>c.data).map(c=>c.data)
const rP = toLE(uc[0]), sP = toLE(uc[1]), sInvP = toLE(uc[2])
const eP256 = toLE(Hash.hash256(preimage))       // P-256 digest convention: LE(hash256)
const u1 = (eP256 * sInvP) % NP
const u2 = (rP   * sInvP) % NP
const Q = p256.Point.fromHex('03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d')
const Rpt = p256.Point.BASE.multiply(u1===0n?NP:u1).add(Q.multiply(u2===0n?NP:u2))
const xaff = Rpt.toAffine().x
console.log('P-256 r (unlock)   =', rP.toString(16))
console.log('P-256 affine x(R)  =', xaff.toString(16))
console.log('ASSERT r==x(R) modp:', xaff===rP, ' r<n_p256:', rP<NP, ' x(R)>=n_p256:', xaff>=NP)
console.log('s*sInv mod n == 1  :', (sP*sInvP)%NP===1n)

// ---- 2) empirical DER-rejection probability over random e (JS-only tail logic) ----
import crypto from 'crypto'
const N = 200000
let neg=0, zero=0, len31=0, len32=0, lenLt31=0, negByLen={}
function tailFromE(eBig){
  const m=eBig+(1n<<248n); const t=m%NK; const s=(t>HALF)?(NK-t):t; const sBE=minimalBE(s); return {s,sBE}
}
for(let i=0;i<N;i++){
  const eBig = toBE(crypto.randomBytes(32))
  const {s,sBE}=tailFromE(eBig)
  const rej=derRejected({s,sBE})
  if(rej==='S_negative_needs_pad') neg++
  else if(rej==='S_len_zero') zero++
  if(sBE.length===32) len32++; else if(sBE.length===31) len31++; else lenLt31++
  if(rej==='S_negative_needs_pad'){ negByLen[sBE.length]=(negByLen[sBE.length]||0)+1 }
}
console.log('\n=== empirical over',N,'random e ===')
console.log('DER rejected (neg S):', neg, '=>', (neg/N*100).toFixed(3)+'%', ' ~1/'+Math.round(N/neg))
console.log('DER rejected (s==0) :', zero)
console.log('s byte-length: 32 =>',(len32/N*100).toFixed(2)+'%  31 =>',(len31/N*100).toFixed(2)+'%  <=30 =>',(lenLt31/N*100).toFixed(3)+'%')
console.log('neg rejections by sBE length:', JSON.stringify(negByLen))
console.log('theory P(neg) ~ 2^-8 =', (1/256*100).toFixed(3)+'%')
