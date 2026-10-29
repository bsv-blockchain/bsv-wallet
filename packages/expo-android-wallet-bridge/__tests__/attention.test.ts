import type { Binding } from '@bsv/expo-wallet-toolbox/core/bridge/bindings'
import { createAttention, LAUNCH_FRESH_MS } from '../src/controller/attention'
import { createFakeNative } from '../src/testing/fakeNative'

const binding = (epoch: string) => ({ epoch, applicationOrigin: 'https://secret-site.example' }) as unknown as Binding

function make() {
  const native = createFakeNative()
  const attention = createAttention({ native, clock: () => native.elapsedRealtime() })
  const posts = () => native.calls.filter(c => c.name === 'postAttention').map(c => c.args)
  return { native, attention, posts }
}

describe('attention', () => {
  it('no postAttention when the main app is in front', () => {
    const t = make()
    t.attention.setMainInFront(true)
    t.attention.requestAttention('consent', binding('e1'))
    t.attention.requestAttention('prompt', binding('e1'))
    expect(t.posts()).toEqual([])
  })

  it('postAttention generic kinds only', () => {
    const t = make()
    t.attention.requestAttention('consent', binding('e1'))
    t.attention.requestAttention('prompt', binding('e2'))
    expect(t.posts()).toEqual([['consent'], ['prompt']])
    // Nothing but the kind reaches native: no epoch, no origin.
    expect(JSON.stringify(t.native.calls)).not.toContain('secret-site')
    expect(JSON.stringify(t.native.calls)).not.toContain('e1')
  })

  it('wallet-not-ready after launch posts nothing, later posts', () => {
    const t = make()
    t.attention.noteLaunch()
    t.attention.requestAttention('wallet-not-ready', binding('e1'))
    expect(t.posts()).toEqual([])
    t.native.advance(LAUNCH_FRESH_MS + 1)
    t.attention.requestAttention('wallet-not-ready', binding('e1'))
    expect(t.posts()).toEqual([['wallet-not-ready']])
  })

  it('onPromptRaised updates the waiting count only', () => {
    const t = make()
    const counts: number[] = []
    t.attention.onWaitingChange(n => counts.push(n))
    t.attention.onPromptRaised(binding('e1'))
    t.attention.onPromptRaised(binding('e1'))
    t.attention.onPromptRaised(binding('e2'))
    expect(t.posts()).toEqual([])
    expect(counts).toEqual([1, 2])
    expect(t.attention.waitingCount()).toBe(2)
  })

  it('cancels the heads-up when the app comes to front and when the last pending item clears', () => {
    const t = make()
    const cancels = () => t.native.calls.filter(c => c.name === 'cancelAttention').length
    t.attention.requestAttention('consent', binding('e1'))
    t.attention.setMainInFront(true)
    expect(cancels()).toBe(1)
    t.attention.setMainInFront(false)
    t.attention.requestAttention('prompt', binding('e2'))
    t.attention.clear('e1')
    expect(cancels()).toBe(1)
    t.attention.clear('e2')
    expect(cancels()).toBe(2)
  })
})
