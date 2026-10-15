/** Run behind an HTTPS reverse proxy. Single process, one merchant per instance. */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { PosService } from './controller'
import { fileStore } from './fileStore'
import { merchantAcceptor } from './merchantWallet'

async function main() {
  const modulePath = process.env.POS_WALLET_MODULE
  if (!modulePath || !process.env.POS_PUBLIC_URL || !process.env.POS_MERCHANT_NAME)
    throw new Error('Configure POS_WALLET_MODULE, POS_PUBLIC_URL and POS_MERCHANT_NAME')
  // Adapter exports createMerchantWallet() -> { wallet, chainTracker, chain }.
  // It loads credentials from the deployment secret store, never from a cashier.
  const { wallet, chainTracker, chain } = await (
    await import(pathToFileURL(resolve(modulePath)).href)
  ).createMerchantWallet()
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  const service = new PosService({
    wallet,
    merchant: publicKey,
    name: process.env.POS_MERCHANT_NAME,
    url: process.env.POS_PUBLIC_URL,
    chain,
    store: fileStore(process.env.POS_STATE_FILE ?? './pos-state.json'),
    accept: merchantAcceptor(wallet, chainTracker)
  })
  createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404)
      res.end('{}')
      return
    }
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 12000000) throw new Error('Request too large')
        chunks.push(chunk)
      }
      const result = await service.call(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.end(JSON.stringify({ result }))
    } catch {
      // Ambiguous settlement errors never tell the payer it is safe to free inputs.
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Request could not be completed. Check status before retrying payment.' }))
    }
  }).listen(Number(process.env.PORT ?? 8787), '127.0.0.1')
}
void main().catch(e => {
  console.error(e.message)
  process.exitCode = 1
})
