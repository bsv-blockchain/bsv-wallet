/**
 * Mock broadcaster for the E2E harness.
 *
 * It never forwards a transaction. POST /e2e/broadcast accepts a testnet
 * payment description and returns a fake txid. Every other request gets a
 * short 200 so header sync and ARC probes finish instead of hanging. A
 * present-height of 0 tells the wallet there are no headers to download.
 *
 *   node e2e/mock/server.mjs
 *   E2E_BROADCASTER_PORT=8787 node e2e/mock/server.mjs
 */
import http from 'node:http'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const LOG_PATH = process.env.E2E_MOCK_LOG ?? path.join(process.cwd(), 'e2e', 'mock', 'requests.log')

function send(res, status, body, type = 'application/json') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function logLine(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    fs.appendFileSync(LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  } catch {
    // Logging is for CI artifacts. A failure to write must not fail the request.
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ requests?: object[] }} [sink]
 */
export async function handleRequest(req, res, sink = {}) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const method = req.method ?? 'GET'
  const record = { method, path: url.pathname }

  try {
    if (method === 'GET' && url.pathname === '/health') {
      send(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && url.pathname === '/e2e/broadcast') {
      const raw = await readBody(req)
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        send(res, 400, { error: 'invalid json' })
        return
      }
      if (body?.chain !== 'test') {
        send(res, 400, { error: 'E2E broadcaster refuses any chain other than test' })
        return
      }
      const satoshis = Number(body.satoshis)
      if (!Number.isInteger(satoshis) || satoshis <= 0) {
        send(res, 400, { error: 'satoshis must be a positive integer' })
        return
      }
      const to = typeof body.to === 'string' ? body.to : ''
      // Mainnet P2PKH addresses start with 1. The harness must not describe one.
      if (!to || to.startsWith('1')) {
        send(res, 400, { error: 'recipient must be a testnet address' })
        return
      }
      const txid = `e2e${createHash('sha256').update(raw).digest('hex').slice(0, 61)}`
      record.txid = txid
      record.to = to
      record.satoshis = satoshis
      sink.requests?.push(record)
      send(res, 200, { txid, txStatus: 'SEEN_ON_NETWORK', chain: 'test' })
      return
    }

    // A real ARC submit that escaped the send hook. Accept and drop it.
    if (method === 'POST' && (url.pathname === '/v1/tx' || url.pathname === '/tx')) {
      const txid = `e2e${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 61)}`
      record.dropped = true
      sink.requests?.push(record)
      send(res, 200, { txid, txStatus: 'SEEN_ON_NETWORK' })
      return
    }

    if (method === 'GET' && /height|present/i.test(url.pathname)) {
      send(res, 200, '0', 'text/plain')
      return
    }

    const accept = req.headers.accept ?? ''
    if (accept.includes('text/event-stream')) {
      send(res, 200, ': e2e\n\n', 'text/event-stream')
      return
    }

    send(res, 200, { ok: true, e2e: true })
  } finally {
    logLine(record)
  }
}

export function createMockServer() {
  const requests = []
  const server = http.createServer((req, res) => {
    handleRequest(req, res, { requests }).catch(error => {
      send(res, 500, { error: error instanceof Error ? error.message : 'mock failed' })
    })
  })
  return {
    requests,
    listen(port = 0) {
      return new Promise(resolve => {
        server.listen(port, '0.0.0.0', () => {
          const address = server.address()
          resolve(typeof address === 'object' && address ? address.port : port)
        })
      })
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()))
      })
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const port = Number(process.env.E2E_BROADCASTER_PORT ?? 8787)
  const mock = createMockServer()
  mock.listen(port).then(actual => {
    console.log(`E2E mock broadcaster listening on ${actual}`)
  })
}
