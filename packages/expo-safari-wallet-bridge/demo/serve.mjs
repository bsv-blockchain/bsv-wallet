// Serves the built demo page on http://localhost:3000 (also reachable through the ngrok tunnel).
// `?csp=strict` adds `Content-Security-Policy: script-src 'self'`. Run: node demo/serve.mjs [port]
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDemo, OUT_DIR } from './build.mjs'

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }

export function createDemoServer(dir = OUT_DIR) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname)
    const file = path.join(dir, name)
    if (!TYPES[path.extname(name)] || !fs.existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    const headers = { 'content-type': TYPES[path.extname(name)], 'cache-control': 'no-store' }
    if (url.searchParams.get('csp') === 'strict') {
      headers['content-security-policy'] = "script-src 'self'"
    }
    res.writeHead(200, headers)
    fs.createReadStream(file).pipe(res)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 3000)
  buildDemo()
  createDemoServer().listen(port, () => console.log(`demo on http://localhost:${port}`))
}
