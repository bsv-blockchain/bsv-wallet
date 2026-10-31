/// <reference lib="dom" />
/**
 * Page side of the E2E driver. Runs in Chromium.
 *
 * Wallet buttons talk to the test server (real mnemonic, storage address and
 * settings modules). Bridge buttons are the Android loopback page client —
 * the same client bsv-browser / the Android kit use — speaking HTTP to the
 * real loopback router on 127.0.0.1.
 */
import { createLoopbackPageClient } from '../../packages/expo-android-wallet-bridge/src/testing/loopbackPageClient'
import type { Connection } from '../../packages/expo-wallet-toolbox/core/bridge/testing/pageClient'

const port = Number(new URLSearchParams(location.search).get('port'))
const status = document.getElementById('status')!

function show(id: string, text: string) {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!res.ok) throw new Error(text || res.statusText)
  return text ? JSON.parse(text) : {}
}

function fail(e: unknown) {
  const message = e instanceof Error ? e.message : String(e)
  status.textContent = message
  throw e
}

const loc = {
  origin: location.origin,
  get href() {
    return location.href
  },
  set href(value: string) {
    ;(window as unknown as { __intent?: string }).__intent = value
  }
}

const tokens = new Map<string, string>()
const client = createLoopbackPageClient(
  { location: loc, crypto: window.crypto as { getRandomValues<T extends ArrayBufferView>(a: T): T } },
  {
    scheme: 'bsv-browser',
    packageId: 'org.bsvblockchain.wallet',
    basePort: port,
    window: 1,
    attemptTimeoutMs: 4000,
    roundMs: 100,
    totalMs: 12000,
    parallel: 1,
    fetch: async (url, init) => {
      const res = await fetch(url, {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
        redirect: 'manual',
        signal: init?.signal
      })
      return {
        status: res.status,
        ok: res.ok,
        headers: { get: (name: string) => res.headers.get(name) },
        text: () => res.text()
      }
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: t => window.clearTimeout(t as number),
    tokenStore: {
      getItem: key => tokens.get(key) ?? null,
      setItem: (key, value) => tokens.set(key, value)
    }
  }
)

let connection: Connection | undefined

document.getElementById('create')!.addEventListener('click', () => {
  void (async () => {
    try {
      const body = (await readJson(await fetch('/__test/create-wallet', { method: 'POST' }))) as {
        words: string[]
        identityKey: string
      }
      show('mnemonic', body.words.join(' '))
      show('identity', body.identityKey)
      show('status', '')
    } catch (e) {
      fail(e)
    }
  })()
})

document.getElementById('restore')!.addEventListener('click', () => {
  void (async () => {
    try {
      const mnemonic = document.getElementById('mnemonic')!.textContent ?? ''
      const body = (await readJson(
        await fetch('/__test/restore', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mnemonic })
        })
      )) as { identityKey: string }
      show('restored', body.identityKey)
      show('status', '')
    } catch (e) {
      fail(e)
    }
  })()
})

document.getElementById('receive')!.addEventListener('click', () => {
  void (async () => {
    try {
      const body = (await readJson(await fetch('/__test/receive'))) as { address: string; network: string }
      show('address', body.address)
      show('address-network', body.network)
      show('status', '')
    } catch (e) {
      fail(e)
    }
  })()
})

document.getElementById('settings')!.addEventListener('click', () => {
  void (async () => {
    try {
      const body = (await readJson(await fetch('/__test/settings'))) as { network: string; broadcasts: boolean }
      show('settings-out', `${body.network} broadcasts ${body.broadcasts ? 'on' : 'off'}`)
      show('status', '')
    } catch (e) {
      fail(e)
    }
  })()
})

document.getElementById('connect')!.addEventListener('click', () => {
  void (async () => {
    try {
      client.launch()
      const intent = (window as unknown as { __intent?: string }).__intent
      if (!intent) throw new Error('launch did not produce an intent')
      await readJson(
        await fetch('/__test/launch', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: intent
        })
      )
      const discovered = await client.discover()
      const provider = discovered.providers[0]
      if (!provider) {
        throw new Error(discovered.rejected.map(r => r.reason).join('; ') || 'wallet did not open')
      }
      connection = await client.connect(provider)
      show('connected', 'connected')
      show('status', '')
    } catch (e) {
      fail(e)
    }
  })()
})

document.getElementById('whoami')!.addEventListener('click', () => {
  void (async () => {
    try {
      if (!connection) throw new Error('not connected')
      const result = (await connection.wallet.getPublicKey({ identityKey: true })) as { publicKey: string }
      show('bridge-identity', result.publicKey)
      show('status', '')
    } catch (e) {
      fail(e)
    }
  })()
})

document.getElementById('pay')!.addEventListener('click', () => {
  void (async () => {
    try {
      if (!connection) throw new Error('not connected')
      const result = (await connection.wallet.createAction({
        description: 'E2E pay',
        outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'E2E output' }],
        options: { noSend: true, returnTXIDOnly: true }
      })) as { txid: string }
      show('txid', result.txid)
      const recorded = (await readJson(await fetch('/__test/calls'))) as { noSend: boolean }
      show('nosend', recorded.noSend ? 'noSend' : 'would broadcast')
      show('status', '')
    } catch (e) {
      fail(e)
    }
  })()
})

window.setInterval(() => {
  void (async () => {
    try {
      const pending = (await readJson(await fetch('/__test/pending'))) as { requestId: string; origin: string }[]
      const box = document.getElementById('pending')!
      box.replaceChildren()
      for (const item of pending) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = 'Approve'
        button.addEventListener('click', () => {
          void (async () => {
            try {
              await readJson(
                await fetch('/__test/approve', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ requestId: item.requestId })
                })
              )
            } catch (e) {
              fail(e)
            }
          })()
        })
        box.appendChild(button)
      }
    } catch {
      /* the bridge server is still coming up */
    }
  })()
}, 200)
