/** @jest-environment jsdom */
import './jsdomPolyfills'

// The jsdom environment resolves the toolbox client's ESM browser build; the bundle uses this same shim.
jest.mock('@bsv/wallet-toolbox-client', () => require('../demo/conformance/shims/walletToolboxClient'))
import { createController } from '../demo/conformance/controller'
import { mountConformance } from '../demo/conformance/ui'
import type { Card } from '../demo/conformance/registry'
import type { Connection, PageClient } from '../src/testing/pageClient'

const cards: Card[] = [
  { id: 'safeOne', title: 'safeOne', group: 'conformance', explanation: 'x', run: async r => r.log('ok') },
  {
    id: 'safeFail',
    title: 'safeFail',
    group: 'conformance',
    explanation: 'x',
    run: async () => Promise.reject(Object.assign(new Error('bad'), { code: 6 }))
  },
  {
    id: 'spendOne',
    title: 'spendOne',
    group: 'funded',
    explanation: 'x',
    spending: 'Spends 16 satoshis plus fees.',
    run: async () => {}
  },
  {
    id: 'matrix',
    title: 'matrix',
    group: 'branch',
    explanation: 'x',
    run: async r => {
      r.case?.('matrix-a', { status: 'passed', durationMs: 1 })
      r.case?.('matrix-b', { status: 'failed', durationMs: 2, errorCode: 'E' })
      throw new Error('1 of 2 branch cases failed. See case results.') // what the vendored runCases does
    }
  }
]

const $ = (sel: string) => document.querySelector(sel) as HTMLElement
const flush = () => new Promise(r => setTimeout(r, 0))

function setup(confirmAnswer = true) {
  document.body.innerHTML = '<section id="conformance"></section>'
  let ui: ReturnType<typeof mountConformance>
  const ctl = createController({ cards, onChange: () => ui?.render() })
  let clipboard = ''
  const confirm = jest.fn((_message: string) => confirmAnswer)
  ui = mountConformance(document, ctl, {
    confirm,
    clipboard: { writeText: async t => void (clipboard = t) }
  })
  const connection = { epoch: 'e', provider: { descriptor: { name: 'W' } } } as unknown as Connection
  const client = { invoke: jest.fn() } as unknown as PageClient
  return { ctl, ui, confirm, connection, client, clipboard: () => clipboard }
}

describe('Conformance panel', () => {
  it('shows every card, the spending description beside a spending card, and asks to connect first', () => {
    setup()
    expect($('#cf-status').textContent).toMatch(/Not connected/)
    expect(document.querySelectorAll('.cf-card')).toHaveLength(4)
    expect($('[data-card="spendOne"] .cf-spend').textContent).toBe('Spends 16 satoshis plus fees.')
    expect($('[data-card="safeOne"] .cf-spend')).toBeNull()
  })

  it('Run all safe fills the results table, skips spending cards, and shows case rows', async () => {
    const { ctl, connection, client } = setup()
    ctl.setConnection(client, connection)
    $('#cf-run-all').click()
    await flush()
    expect($('[data-card="safeOne"] .cf-st').textContent).toBe('pass')
    expect($('[data-card="safeFail"] .cf-st').textContent).toBe('fail')
    expect($('[data-card="safeFail"] .cf-code').textContent).toBe('6')
    expect($('[data-card="spendOne"] .cf-st').textContent).toBe('-')
    expect($('[data-card="matrix"] .cf-st').textContent).toBe('fail')
    expect($('[data-card="matrix"] summary').textContent).toMatch(/2 cases \(1 pass, 1 fail, 0 skip\)/)
    expect($('[data-card="matrix"] details').textContent).toContain('matrix-b')
  })

  it('a spending card runs only from its own Run button and only after confirmation', async () => {
    const declined = setup(false)
    declined.ctl.setConnection(declined.client, declined.connection)
    ;($('[data-card="spendOne"] button') as HTMLElement).click()
    await flush()
    expect(declined.confirm).toHaveBeenCalledTimes(1)
    expect(declined.confirm.mock.calls[0][0] as string).toContain('Spends 16 satoshis plus fees.')
    expect(declined.ctl.results.has('spendOne')).toBe(false)

    const ok = setup(true)
    ok.ctl.setConnection(ok.client, ok.connection)
    ;($('[data-card="spendOne"] button') as HTMLElement).click()
    await flush()
    expect(ok.ctl.results.get('spendOne')?.status).toBe('pass')
  })

  it('Copy report puts the JSON on the clipboard, with the build note', async () => {
    const { ctl, connection, client, clipboard } = setup()
    ctl.setConnection(client, connection)
    await ctl.runCard('safeOne')
    ;($('#cf-build') as HTMLInputElement).value = 'wallet 9.9'
    $('#cf-copy').click()
    await flush()
    const report = JSON.parse(clipboard())
    expect(report.walletBuild).toBe('wallet 9.9')
    expect(report.summary).toMatchObject({ cards: 1, pass: 1 })
  })

  it('falls back to a text box when the clipboard is refused', async () => {
    document.body.innerHTML = '<section id="conformance"></section>'
    const ctl = createController({ cards })
    const ui = mountConformance(document, ctl, {
      clipboard: { writeText: async () => Promise.reject(new Error('denied')) }
    })!
    await ui.copyReport()
    const box = document.getElementById('cf-report') as HTMLTextAreaElement
    expect(box.hidden).toBe(false)
    expect(JSON.parse(box.value).source).toMatch(/fast-wallet-client-docs/)
  })
})
