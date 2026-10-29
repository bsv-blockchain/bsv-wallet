// Hold loopback ports on the device (squatters) with `toybox nc -l` listeners, for the port-window cases.
import { spawn } from 'node:child_process'
import { ADB, adbArgs, shell } from './adb.mjs'

const holders = []
/** Families that could not be held, for SPIKES.md (e.g. `nc` cannot bind ::1). */
export const gates = []

/**
 * Hold each port on `family` ('ipv4' -> 127.0.0.1, 'ipv6' -> ::1, 'both' -> both). Resolves with the list of
 * `{port, addr, held}`; a family whose `nc` bind fails is recorded in `gates` and the other family is still held.
 */
export async function hold(ports, family = 'both') {
  const addrs = family === 'ipv4' ? ['127.0.0.1'] : family === 'ipv6' ? ['::1'] : ['127.0.0.1', '::1']
  const results = []
  for (const port of ports) {
    for (const addr of addrs) {
      const child = spawn(ADB, adbArgs(['shell', `toybox nc -l -s ${addr} -p ${port}`]), { stdio: 'ignore' })
      let dead = false
      child.on('exit', () => {
        dead = true
      })
      await new Promise(r => setTimeout(r, 600))
      const held = !dead
      if (held) holders.push(child)
      else gates.push(`could not hold ${addr}:${port}`)
      results.push({ port, addr, held })
    }
  }
  return results
}

/** Stop every holder, on the host and on the device. */
export async function release() {
  for (const c of holders.splice(0)) c.kill()
  await shell('pkill -f "toybox nc -l" || pkill nc || true').catch(() => {})
}
