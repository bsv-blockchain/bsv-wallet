/** @jest-environment node */
import { createContentRelay } from '../../extension/src/lib/contentRelay'
import { createProviderMain } from '../../extension/src/lib/providerMain'
import { FakeWindow, manualTimers, tick } from './chain'

const REQ = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const EPOCH = '22222222-2222-4222-8222-222222222222'
const INSTANCE = '33333333-3333-4333-8333-333333333333'

const stubRuntime = (log: unknown[] = []) => ({
  async sendMessage(m: any) {
    log.push(m)
    if (m.bsv === 'describe') return { ok: true, value: { described: m.origin } }
    if (m.bsv === 'connect') return { ok: true, value: { instanceId: INSTANCE } }
    if (m.bsv === 'poll') return { ok: true, value: { items: [], closed: [] } }
    return { ok: false, error: { domain: 'brc185', code: 'PROTOCOL_ERROR', message: 'x', delivery: 'not-sent' } }
  },
  connect(): BrowserPort {
    return {
      name: 'p',
      postMessage() {},
      disconnect() {},
      onMessage: { addListener() {}, removeListener() {} },
      onDisconnect: { addListener() {}, removeListener() {} }
    }
  }
})

const handleOf = (win: FakeWindow) =>
  new Promise<any>(resolve => {
    win.addEventListener('brc185:announce-provider', e => resolve(e.detail.handle))
    win.dispatchEvent(new CustomEvent('brc185:request-provider', { detail: { version: 1, requestId: REQ } }))
  })

describe('page-world handshake', () => {
  it.each([
    ['page-world script first', true],
    ['content script first', false]
  ])('the port is established whichever script starts first (%s)', async (_name, providerFirst) => {
    const win = new FakeWindow('https://app.example/')
    const log: unknown[] = []
    const timers = manualTimers()
    let provider!: ReturnType<typeof createProviderMain>
    let relay!: ReturnType<typeof createContentRelay>
    if (providerFirst) {
      provider = createProviderMain(win as never)
      await tick(5)
      relay = createContentRelay({ win: win as never, runtime: stubRuntime(log), timers })
    } else {
      relay = createContentRelay({ win: win as never, runtime: stubRuntime(log), timers })
      await tick(5)
      provider = createProviderMain(win as never)
    }
    const handle = await handleOf(win)
    await expect(handle.describe('https://app.example', 'x')).resolves.toEqual({ described: 'https://app.example' })
    provider.dispose()
    relay.dispose()
  })

  it('a second hello does not replace the port', async () => {
    const win = new FakeWindow('https://app.example/')
    const provider = createProviderMain(win as never)
    const relay = createContentRelay({ win: win as never, runtime: stubRuntime(), timers: manualTimers() })
    const handle = await handleOf(win)
    await handle.describe('https://app.example', 'x')
    win.postMessage({ type: 'bsv-bridge:content-ready' }, '*') // a forged hello
    win.postMessage({ type: 'bsv-bridge:main-ready' }, '*')
    await tick(10)
    await expect(handle.describe('https://app.example', 'y')).resolves.toBeDefined()
    provider.dispose()
    relay.dispose()
  })

  it('without a content script a call fails CONFIGURATION_ERROR not-sent instead of hanging', async () => {
    const win = new FakeWindow('https://app.example/')
    const provider = createProviderMain(win as never, { portWaitMs: 20 })
    const handle = await handleOf(win)
    await expect(handle.describe('https://app.example', 'x')).rejects.toMatchObject({
      domain: 'brc185',
      code: 'CONFIGURATION_ERROR',
      delivery: 'not-sent'
    })
    provider.dispose()
  })

  it('connect validates its arguments locally and an epoch cannot be reused', async () => {
    const win = new FakeWindow('https://app.example/')
    const provider = createProviderMain(win as never)
    const relay = createContentRelay({ win: win as never, runtime: stubRuntime(), timers: manualTimers() })
    const handle = await handleOf(win)
    await expect(handle.connect('https://app.example', 'nope', () => undefined)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      delivery: 'not-sent'
    })
    await expect(handle.connect('https://app.example', EPOCH, undefined as never)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR'
    })
    const wallet = await handle.connect('https://app.example', EPOCH, () => undefined)
    expect(Object.isFrozen(wallet)).toBe(true)
    expect(Object.keys(wallet)).toHaveLength(28)
    await expect(handle.connect('https://app.example', EPOCH, () => undefined)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR'
    })
    provider.dispose()
    relay.dispose()
  })

  it('an unserialisable argument is PROTOCOL_ERROR not-sent', async () => {
    const win = new FakeWindow('https://app.example/')
    const provider = createProviderMain(win as never)
    const relay = createContentRelay({ win: win as never, runtime: stubRuntime(), timers: manualTimers() })
    const handle = await handleOf(win)
    const wallet: any = await handle.connect('https://app.example', EPOCH, () => undefined)
    await expect(wallet.createAction({ fn: () => 1 })).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      delivery: 'not-sent'
    })
    provider.dispose()
    relay.dispose()
  })
})
