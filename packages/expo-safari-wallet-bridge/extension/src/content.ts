// SPIKE ONLY (Task 13): relays probe commands from the page to the background and logs lifecycle facts.
const isTop = window === window.top

window.addEventListener('message', (event: MessageEvent) => {
  const d = event.data
  if (!d || d.source !== 'bsv-probe') return
  browser.runtime
    .sendMessage({ type: 'probe', cmd: d.cmd, args: d.args || d, frame: !isTop })
    .then((reply: unknown) => window.postMessage({ source: 'bsv-probe-reply', cmd: d.cmd, reply }, '*'))
    .catch((e: any) => window.postMessage({ source: 'bsv-probe-reply', cmd: d.cmd, reply: { error: String(e) } }, '*'))
})

if (!isTop) {
  // S5: a subframe asks the background to hand off.
  browser.runtime.sendMessage({ type: 'probe', cmd: 'frame-hello', args: {}, frame: true }).catch(() => {})
}

if (isTop) browser.runtime.sendMessage({ type: 'probe', cmd: 'meta', args: {} }).catch(() => {})

if (isTop && location.search.indexOf('noport') < 0) {
  // S4: a port from the top frame; report when it disconnects.
  try {
    const port = browser.runtime.connect({ name: 'probe' })
    port.onDisconnect.addListener(() => browser.runtime.sendMessage({ type: 'probe', cmd: 'log', args: { tag: 's4-port-disconnect' } }).catch(() => {}))
    port.onMessage.addListener((m: unknown) => browser.runtime.sendMessage({ type: 'probe', cmd: 'log', args: { tag: 's4-port-msg', m } }).catch(() => {}))
  } catch (e) {
    browser.runtime.sendMessage({ type: 'probe', cmd: 'log', args: { tag: 's4-port-error', e: String(e) } }).catch(() => {})
  }
}
