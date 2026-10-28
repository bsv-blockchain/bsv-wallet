// SPIKE ONLY (Task 13): answers `ping` and runs the S2 to S7 probes, logging to the probe server.
import { MAX_BRIDGE_REQUEST_BYTES } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/limits'

const LOG_URL = 'http://localhost:3000/log'
const bootId = Math.random().toString(36).slice(2, 8)
const bootAt = Date.now()
function plog(tag: string, data?: unknown) {
  return fetch(LOG_URL, { method: 'POST', body: JSON.stringify({ tag, t: Date.now(), bootId, data: data ?? null }) }).catch(() => {})
}
plog('bg-start', { bootId })

function b64(n: number) {
  // n characters of base64 text (the wire size)
  const chunk = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='
  return chunk.repeat(Math.ceil(n / chunk.length)).slice(0, n - (n % 4))
}

function native(msg: Record<string, unknown>, timeoutMs = 20000): Promise<any> {
  return Promise.race([
    browser.runtime.sendNativeMessage('application.id', msg),
    new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), timeoutMs))
  ])
}

async function s2(args: any) {
  const raw = (args.sizes ? String(args.sizes).split(',') : ['1024', '16384', '32768', '49152', '65536', '98304', '131072', '262144', '524288', '1048576', '2097152', '5242880']).map(Number)
  const runs = Number(args.runs || 10)
  const out: any[] = []
  for (const size of raw) {
    const wire = Math.floor((size * 4) / 3 / 4) * 4
    const data = b64(wire)
    let ok = 0
    const ms: number[] = []
    const errors: string[] = []
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      try {
        const r = await native({ op: 'echo', data })
        if (r && r.ok && r.data === data) ok++
        else errors.push(JSON.stringify(r).slice(0, 120))
      } catch (e) {
        errors.push(String(e))
      }
      ms.push(Math.round(performance.now() - t0))
    }
    const row = { rawBytes: size, wireChars: wire, ok, runs, ms, errors: errors.slice(0, 3) }
    out.push(row)
    await plog('s2-size', row)
  }
  return out
}

async function sign() {
  const pre = btoa('BRC-185 descriptor v1\nprobe')
  const t0 = performance.now()
  try {
    const r = await native({ op: 'sign', context: 'safari', preimage: pre })
    return { ms: Math.round(performance.now() - t0), ok: r && r.ok, code: r && r.code, sigLen: r && r.signature && r.signature.length }
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), error: String(e) }
  }
}

let handoffSeq = 0
async function handoff(tabId: number, tag: string) {
  const url = `${BRIDGE_SCHEME}://bridge?v=1&n=probe${++handoffSeq}`
  const t0 = Date.now()
  try {
    await browser.tabs.update(tabId, { url })
    await plog('s5-handoff', { tag, url, ms: Date.now() - t0 })
  } catch (e) {
    await plog('s5-handoff-error', { tag, e: String(e) })
  }
}

browser.tabs.onRemoved.addListener((tabId: number) => plog('s4-tab-removed', { tabId }))
browser.runtime.onConnect.addListener((port: any) => {
  plog('s4-port-connect', { name: port.name, tabId: port.sender && port.sender.tab && port.sender.tab.id })
})

browser.runtime.onMessage.addListener((message: any, sender: any, sendResponse: (reply: unknown) => void) => {
  if (message && message.type === 'ping') {
    sendResponse({
      pong: true,
      name: BRIDGE_NAME,
      scheme: BRIDGE_SCHEME,
      vendor: BRIDGE_VENDOR,
      maxRequestBytes: MAX_BRIDGE_REQUEST_BYTES,
      localhostHttp: allowLocalhostHttp
    })
    return false
  }
  if (!message || message.type !== 'probe') return false
  const args = message.args || {}
  const meta = {
    origin: sender.origin,
    url: sender.url,
    frameId: sender.frameId,
    incognito: sender.tab && sender.tab.incognito,
    incognitoType: typeof (sender.tab && sender.tab.incognito),
    tabId: sender.tab && sender.tab.id
  }
  const run = async () => {
    switch (message.cmd) {
      case 'log':
        await plog(args.tag, args)
        return { logged: true }
      case 'meta':
        await plog('s7-meta', meta)
        return meta
      case 's2':
        return await s2(args)
      case 'sign': {
        const r = await sign()
        await plog('sign', { ...r, sinceBootMs: Date.now() - bootAt })
        return r
      }
      case 's4-set': {
        await browser.storage.session.set({ s4marker: { bootId, at: Date.now() } })
        await plog('s4-set', { bootId })
        return { bootId }
      }
      case 's4-check': {
        const got = await browser.storage.session.get('s4marker')
        const r = { bootId, bootAt, marker: got.s4marker || null, sinceBootMs: Date.now() - bootAt }
        await plog('s4-check', r)
        return r
      }
      case 's4-slow': {
        // a native request that outlives the background's idle timeout
        const t0 = Date.now()
        try {
          const r = await native({ op: 'echo', data: 'AAAA', delayMs: Number(args.delayMs || 40000) }, 90000)
          await plog('s4-slow-done', { ms: Date.now() - t0, ok: r && r.ok, bootId })
          return { ms: Date.now() - t0, ok: r && r.ok }
        } catch (e) {
          await plog('s4-slow-error', { ms: Date.now() - t0, e: String(e), bootId })
          return { error: String(e) }
        }
      }
      case 's5-double': {
        // two tabs.update calls while the app prompt is up
        await handoff(sender.tab.id, 'first')
        await new Promise(r => setTimeout(r, Number(args.gap || 500)))
        await handoff(sender.tab.id, 'second')
        return { done: true }
      }
      case 's5-one':
        await handoff(sender.tab.id, 'one')
        return { done: true }
      case 'frame-hello':
        await plog('s5-frame-hello', meta)
        if (args.handoff || (message.frame && false)) await handoff(sender.tab.id, 'from-frame')
        return { done: true }
      case 's5-frame': {
        // ask: can a subframe's sender drive tabs.update on its tab?
        await handoff(sender.tab.id, `frame-sender frameId=${sender.frameId}`)
        return { done: true }
      }
      default:
        return { unknown: message.cmd }
    }
  }
  run().then(sendResponse, e => sendResponse({ error: String(e) }))
  return true
})
