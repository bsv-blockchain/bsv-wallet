import type { Binding } from '@bsv/expo-wallet-toolbox/core/bridge/bindings'
import { AppState } from 'react-native'
import { createAttention, LAUNCH_FRESH_MS, OWNER_NONE_MS } from '../src/controller/attention'
import { createFakeNative } from '../src/testing/fakeNative'
import { ownerFromNative } from '../src/ui/sheetOwner'

const binding = (epoch: string) => ({ epoch, applicationOrigin: 'https://secret-site.example' }) as unknown as Binding

type Place = 'main' | 'overlay' | 'none'

/** The owner is read from the fake tracker; `AppState` is forced `active` in every row, so it must never matter. */
function make() {
  const native = createFakeNative()
  native.setHostLifecycle({ registered: true, mainAlive: true })
  const attention = createAttention({
    native,
    clock: () => native.elapsedRealtime(),
    owner: () => ownerFromNative(native)
  })
  const at = (place: Place) =>
    native.setHostLifecycle({ mainResumed: place === 'main', sheetResumed: place === 'overlay' })
  const named = (n: string) => native.calls.filter(c => c.name === n).map(c => c.args)
  const posts = () => named('postAttention')
  return { native, attention, posts, at, named }
}

beforeEach(() => {
  ;(AppState as any).currentState = 'active'
})

describe('attention', () => {
  it('owner main: no heads-up', () => {
    const t = make()
    t.at('main')
    t.attention.requestAttention('consent', binding('e1'))
    t.attention.requestAttention('prompt', binding('e1'))
    t.native.advance(5000)
    expect(t.posts()).toEqual([])
    expect(t.named('showSheet')).toEqual([])
  })

  it('owner overlay: no heads-up (the sheet itself renders the prompt)', () => {
    const t = make()
    t.at('overlay')
    t.attention.requestAttention('consent', binding('e1'))
    t.attention.requestAttention('prompt', binding('e1'))
    t.native.advance(5000)
    expect(t.posts()).toEqual([])
    expect(t.attention.isWalletInFront()).toBe(true)
  })

  it('owner none for a while: generic kinds only, showSheet first then postAttention', () => {
    const t = make()
    t.at('none')
    t.native.advance(OWNER_NONE_MS + 1)
    t.attention.requestAttention('consent', binding('e1'))
    t.attention.requestAttention('prompt', binding('e2'))
    expect(t.posts()).toEqual([['consent'], ['prompt']])
    expect(t.named('showSheet')).toEqual([['consent'], ['prompt']])
    const names = t.native.calls.map(c => c.name)
    expect(names.indexOf('showSheet')).toBeLessThan(names.indexOf('postAttention'))
    // Nothing but the kind reaches native: no epoch, no origin.
    expect(JSON.stringify(t.native.calls)).not.toContain('secret-site')
    expect(JSON.stringify(t.native.calls)).not.toContain('e1')
  })

  it('owner none for 500 ms with a pending prompt posts the heads-up (Home or Back with a prompt up)', () => {
    const t = make()
    t.at('overlay')
    t.attention.requestAttention('prompt', binding('e1'))
    expect(t.posts()).toEqual([])
    t.at('none')
    t.attention.refreshFront()
    t.native.advance(OWNER_NONE_MS - 1)
    expect(t.posts()).toEqual([])
    t.native.advance(1)
    expect(t.posts()).toEqual([['prompt']])
    expect(t.named('showSheet')).toEqual([['prompt']])
    // Once only, however long it stays away.
    t.native.advance(60_000)
    expect(t.posts()).toHaveLength(1)
  })

  it('a prompt that arrives inside the handover blip waits for the blip to end', () => {
    const t = make()
    t.at('main')
    t.attention.refreshFront()
    t.at('none')
    t.attention.refreshFront()
    t.native.advance(50)
    t.attention.requestAttention('prompt', binding('e1'))
    expect(t.posts()).toEqual([])
    t.native.advance(OWNER_NONE_MS)
    expect(t.posts()).toEqual([['prompt']])
  })

  it.each([
    ['main', 'overlay'],
    ['overlay', 'main']
  ] as const)('owner none for 50 ms between %s and %s posts nothing and shows nothing', (from, to) => {
    const t = make()
    t.at(from)
    t.attention.requestAttention('prompt', binding('e1'))
    t.at('none')
    t.attention.refreshFront()
    t.native.advance(50)
    t.at(to)
    t.attention.refreshFront()
    t.native.advance(10_000)
    expect(t.posts()).toEqual([])
    expect(t.named('showSheet')).toEqual([])
  })

  it('owner none then main before the 500 ms re-read posts nothing', () => {
    const t = make()
    t.at('overlay')
    t.attention.requestAttention('consent', binding('e1'))
    t.at('none')
    t.native.advance(OWNER_NONE_MS - 10)
    // No lifecycle event reached JS (it was stopped), but the owner has changed by the time the timer is read.
    t.native.setHostLifecycle({ mainResumed: true })
    t.native.advance(10)
    expect(t.posts()).toEqual([])
  })

  it('owner turns overlay cancels a posted heads-up', () => {
    const t = make()
    t.at('none')
    t.native.advance(OWNER_NONE_MS + 1)
    t.attention.requestAttention('consent', binding('e1'))
    const before = t.named('cancelAttention').length
    t.at('overlay')
    t.attention.refreshFront()
    expect(t.named('cancelAttention').length).toBe(before + 1)
  })

  it('owner turns main cancels a posted heads-up', () => {
    const t = make()
    t.at('none')
    t.native.advance(OWNER_NONE_MS + 1)
    t.attention.requestAttention('prompt', binding('e1'))
    const before = t.named('cancelAttention').length
    t.at('main')
    t.attention.refreshFront()
    expect(t.named('cancelAttention').length).toBe(before + 1)
  })

  it('AppState never decides once the tracker is registered', () => {
    const t = make()
    t.at('none')
    t.native.advance(OWNER_NONE_MS + 1)
    t.attention.requestAttention('prompt', binding('e1'))
    expect(t.posts()).toEqual([['prompt']])
  })

  it('unregistered tracker falls back to AppState (M1 semantics)', () => {
    const native = createFakeNative()
    const attention = createAttention({ native, owner: () => ownerFromNative(native) })
    attention.requestAttention('consent', binding('e1'))
    expect(native.calls.filter(c => c.name === 'postAttention')).toEqual([])
    expect(attention.isWalletInFront()).toBe(true)
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

  it('cancels the heads-up when the wallet comes to front and when the last pending item clears', () => {
    const t = make()
    t.at('none')
    t.native.advance(OWNER_NONE_MS + 1)
    const cancels = () => t.named('cancelAttention').length
    t.attention.requestAttention('consent', binding('e1'))
    t.at('main')
    t.attention.refreshFront()
    expect(cancels()).toBe(1)
    t.at('none')
    t.native.advance(OWNER_NONE_MS + 1)
    t.attention.requestAttention('prompt', binding('e2'))
    t.attention.clear('e1')
    expect(cancels()).toBe(1)
    t.attention.clear('e2')
    expect(cancels()).toBe(2)
  })

  it('clearing the last pending item before the wait ends posts nothing', () => {
    const t = make()
    t.at('overlay')
    t.attention.requestAttention('prompt', binding('e1'))
    t.at('none')
    t.attention.refreshFront()
    t.native.advance(100)
    t.attention.clear('e1')
    t.native.advance(10_000)
    expect(t.posts()).toEqual([])
  })
})
