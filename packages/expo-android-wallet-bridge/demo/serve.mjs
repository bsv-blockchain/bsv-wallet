// Serves the built demo page on http://localhost:3000 (the emulator reaches it through `adb reverse`; pass another
// port when the iOS demo already holds 3000). `?csp=strict` adds `Content-Security-Policy: script-src 'self'`.
// Run: node demo/serve.mjs [port]
import { fileURLToPath } from 'node:url'
import { createDemoServer } from '../../expo-safari-wallet-bridge/demo/serve.mjs'
import { buildDemo, OUT_DIR } from './build.mjs'

export { createDemoServer }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 3000)
  buildDemo()
  createDemoServer(OUT_DIR).listen(port, () => console.log(`demo on http://localhost:${port}`))
}
