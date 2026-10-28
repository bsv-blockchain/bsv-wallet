/** @jest-environment node */
import { POPUP_STEPS, renderPopup } from '../../extension/src/lib/popupView'

function fakeDoc() {
  const els: Record<
    string,
    { textContent: string | null; children: Array<{ textContent: string | null }>; appendChild(n: any): void }
  > = {}
  for (const id of ['status', 'steps']) {
    els[id] = {
      textContent: null,
      children: [],
      appendChild(n) {
        this.children.push(n)
      }
    }
  }
  return {
    els,
    getElementById: (id: string) => els[id] ?? null,
    createElement: () => ({ textContent: null as string | null })
  }
}

describe('popup', () => {
  it('shows the steps and the ping status', async () => {
    const doc = fakeDoc()
    await renderPopup(doc, { sendMessage: async () => ({ pong: true, name: 'Bitcoin SV Wallet' }) })
    expect(doc.els.status.textContent).toBe('Bitcoin SV Wallet is on')
    expect(doc.els.steps.children.map(c => c.textContent)).toEqual([...POPUP_STEPS])
    expect(POPUP_STEPS.join(' ')).toMatch(/Always Allow/)
  })

  it('says so when the background does not answer', async () => {
    const doc = fakeDoc()
    await renderPopup(doc, {
      sendMessage: async () => {
        throw new Error('no background')
      }
    })
    expect(doc.els.status.textContent).toBe('No answer')
    const doc2 = fakeDoc()
    await renderPopup(doc2, { sendMessage: async () => undefined })
    expect(doc2.els.status.textContent).toBe('No answer')
  })

  it('asks for nothing: there is no approval step', () => {
    expect(POPUP_STEPS.join(' ')).not.toMatch(/approve|password|key/i)
  })
})
