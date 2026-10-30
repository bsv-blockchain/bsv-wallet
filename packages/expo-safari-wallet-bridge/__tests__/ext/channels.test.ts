/** @jest-environment node */
// Two wallets' extensions share one page: each page-world script pairs only with its own content script.
import { createProviderMain } from '../../extension/src/lib/providerMain'
import { FakeWindow, tick } from './chain'

describe('script pairing across two wallets on one page', () => {
  it('answers only a content-ready of its own channel, once, and hellos on its own channel', async () => {
    const win = new FakeWindow('https://app.example/page')
    const seen: Array<{ type: string; ch: unknown }> = []
    win.addEventListener('message', (e: any) => seen.push({ type: e.data.type, ch: e.data.ch }))
    const a = createProviderMain(win as never, { channel: 'wallet.a' })
    const b = createProviderMain(win as never, { channel: 'wallet.b' })
    await tick()
    expect(seen.filter(m => m.type === 'bsv-bridge:main-ready').map(m => m.ch)).toEqual(['wallet.a', 'wallet.b'])

    seen.length = 0
    win.postMessage({ type: 'bsv-bridge:content-ready', ch: 'wallet.b' }, '*')
    await tick()
    // Only wallet b's page-world script answers wallet b's content script.
    expect(seen.filter(m => m.type === 'bsv-bridge:port')).toEqual([{ type: 'bsv-bridge:port', ch: 'wallet.b' }])

    seen.length = 0
    win.postMessage({ type: 'bsv-bridge:content-ready', ch: 'wallet.a' }, '*')
    win.postMessage({ type: 'bsv-bridge:content-ready' }, '*') // a hello without a channel pairs with nobody
    await tick()
    expect(seen.filter(m => m.type === 'bsv-bridge:port')).toEqual([{ type: 'bsv-bridge:port', ch: 'wallet.a' }])
    a.dispose()
    b.dispose()
  })
})
