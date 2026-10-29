// Squatter for case 11 (bundled by esbuild at run time, run with node on the host, reached through `adb reverse`):
// a valid, signed descriptor under its OWN key with the real wallet's name and vendor, CORS correct, and no launch key
// `k`, so never a describe acknowledgement (the fixture of __tests__/loopbackSupport.ts `createSquatter`, on real HTTP).
// Prints one JSON line per request (method and path only) so the run can assert the squatter never saw an epoch,
// proof, token or binding header.
import http from 'node:http'
import { signDescribe, type Descriptor } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/descriptor'
import { createSecureStoreContinuity } from '../../src/continuity/secureStoreContinuity'

const port = Number(process.argv[2] ?? 3321)
const origin = process.argv[3] ?? 'http://localhost:3001'
const data = new Map<string, string>()
const identity = await createSecureStoreContinuity({
  secureStore: {
    getItemAsync: async k => data.get(k) ?? null,
    setItemAsync: async (k, v) => void data.set(k, v)
  }
}).getOrCreate(`android:${origin}`)

const cors = {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Expose-Headers': 'BRC-185-Android-Ack',
  'Cache-Control': 'no-store',
  Vary: 'Origin'
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const bad = Object.keys(req.headers).filter(h => /^brc-185-(epoch|key|android-binding|instance)$/i.test(h))
  console.log(JSON.stringify({ method: req.method, path: url.pathname, secretHeaders: bad }))
  if (req.method === 'GET' && url.pathname === '/.well-known/brc-wallet') {
    const challenge = url.searchParams.get('challenge')!
    const descriptor: Descriptor = {
      version: 1,
      instanceId: identity.instanceId,
      name: 'Bitcoin SV Wallet',
      instanceLabel: 'Bitcoin SV Wallet',
      vendor: 'org.bsvblockchain.wallet',
      continuityKey: identity.continuityKey,
      endpoints: [{ id: 'json-ipv4', type: 'http-json', address: `http://127.0.0.1:${port}` }]
    }
    const signed = await signDescribe(identity, { origin, challenge, descriptor })
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
    res.end(JSON.stringify(signed))
    return
  }
  res.writeHead(404, cors)
  res.end()
})
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: port })))
