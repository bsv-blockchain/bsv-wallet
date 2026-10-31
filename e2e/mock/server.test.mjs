import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.E2E_MOCK_LOG = path.join(mkdtempSync(path.join(tmpdir(), 'e2e-mock-')), 'requests.log')
const { createMockServer } = await import('./server.mjs')

const ADDRESS = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'

async function withServer(fn) {
  const mock = createMockServer()
  const port = await mock.listen(0)
  try {
    await fn(`http://127.0.0.1:${port}`, mock)
  } finally {
    await mock.close()
  }
}

test('health and a testnet broadcast', async () => {
  await withServer(async base => {
    const health = await fetch(`${base}/health`)
    assert.equal(health.status, 200)
    const res = await fetch(`${base}/e2e/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'test', to: ADDRESS, satoshis: 1 })
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.chain, 'test')
    assert.match(body.txid, /^e2e[0-9a-f]{61}$/)
  })
})

test('refuses mainnet and a mainnet-shaped address', async () => {
  await withServer(async base => {
    const chain = await fetch(`${base}/e2e/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'main', to: ADDRESS, satoshis: 1 })
    })
    assert.equal(chain.status, 400)
    const address = await fetch(`${base}/e2e/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'test', to: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', satoshis: 1 })
    })
    assert.equal(address.status, 400)
  })
})

test('present height is zero and an ARC post is dropped', async () => {
  await withServer(async base => {
    const height = await fetch(`${base}/chaintracks/v1/presentHeight`)
    assert.equal(await height.text(), '0')
    const arc = await fetch(`${base}/v1/tx`, { method: 'POST', body: 'raw' })
    assert.equal(arc.status, 200)
    const body = await arc.json()
    assert.match(body.txid, /^e2e/)
  })
})
