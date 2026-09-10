import fs from 'fs'
import { Script, Transaction, Spend, OP, LockingScript, UnlockingScript, BigNumber } from '@bsv/sdk'
const lockHex = fs.readFileSync('docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex','utf8').trim()
const txHex = fs.readFileSync('docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex','utf8').trim()
const tx = Transaction.fromHex(txHex)
const lock = LockingScript.fromHex(lockHex)
const unlock = tx.inputs[0].unlockingScript
const spend = new Spend({
  sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: 0, sourceSatoshis: 4600,
  lockingScript: lock, transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs,
  unlockingScript: unlock, inputSequence: tx.inputs[0].sequence, inputIndex: 0, lockTime: tx.lockTime
})
const hex = a => Buffer.from(a).toString('hex')
const num = a => { try { return a.length? BigNumber.fromScriptNum(a,false,a.length).toString(16) : '0' } catch { return '?' } }
const fmt = a => a.length<=8 ? `[${hex(a)}|${num(a)}]` : `[${hex(a).slice(0,8)}..${hex(a).slice(-8)} len${a.length} n=${num(a).slice(0,10)}..]`
const out = []
let steps = 0
const T0 = Date.now()
const full = process.env.FULL === '1'
try {
  while (true) {
    const ctx = spend.context, pc = spend.programCounter
    const script = ctx === 'UnlockingScript' ? unlock : lock
    if (pc >= script.chunks.length) { if (ctx === 'UnlockingScript') { spend.step(); continue } else break }
    const c = script.chunks[pc]
    const opName = c.data ? `<${c.data.length}B ${hex(c.data).slice(0,16)}${c.data.length>8?'..':''}>` : (OP[c.op] ?? '0x'+c.op.toString(16))
    spend.step(); steps++
    if (full || steps < 400 || steps % 500 === 0) {
      const st = spend.stack.slice(-6).map(fmt).join(' ')
      out.push(`${ctx[0]} #${String(pc).padStart(5)} ${opName.padEnd(30)} depth=${spend.stack.length} alt=${spend.altStack.length} top: ${st}`)
    }
    if (steps > 30000) break
  }
} catch (e) { out.push('ERROR ' + e.message) }
out.push(`steps=${steps} ms=${Date.now()-T0} final stack: ${spend.stack.map(fmt).join(' ')}`)
fs.writeFileSync(process.env.S + (full?'/trace.full.txt':'/trace.txt'), out.join('\n'))
console.log(out.slice(0,120).join('\n')); console.log('...'); console.log(out.slice(-5).join('\n'))
// also validate whole
const spend2 = new Spend({ sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: 0, sourceSatoshis: 4600, lockingScript: lock, transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs, unlockingScript: unlock, inputSequence: tx.inputs[0].sequence, inputIndex: 0, lockTime: tx.lockTime })
try { console.log('validate():', spend2.validate()) } catch (e) { console.log('validate threw:', e.message) }
