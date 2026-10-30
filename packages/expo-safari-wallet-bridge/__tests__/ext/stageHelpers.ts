/** Shared setup for the staging, limits, pickup and tabs tests. */
import { bindingKey, saveBindings, type EpochBinding } from '../../extension/src/lib/bindings'
import type { AttestedFrame } from '../../extension/src/lib/attest'
import type { StageDeps } from '../../extension/src/lib/stage'
import { createFakeAppex, createFakeBrowser, fakeDeps, INSTANCE, makeMirror, type FakeAppex } from './fakeBrowser'

export const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
export const ORIGIN = 'https://app.example'

export function setup(appexInit: Partial<FakeAppex> = {}) {
  const browser = createFakeBrowser()
  const appex = createFakeAppex({ mirrorState: 'ok', mirror: makeMirror(), ...appexInit })
  const clock = { t: 1_000_000 }
  let next = 1000
  const deps: StageDeps & { closedLog: unknown[] } = {
    ...fakeDeps(appex, browser, { clock }),
    newId: () => uuid(next++)
  }
  return { browser, appex, clock, deps }
}

export type Setup = ReturnType<typeof setup>

/** Binds epoch `n` in tab `n` (frame 0) and returns what a call from it carries. */
export async function bind(
  s: Setup,
  n: number,
  over: Partial<EpochBinding> = {}
): Promise<{ binding: EpochBinding; frame: AttestedFrame }> {
  const binding: EpochBinding = {
    instanceId: INSTANCE,
    epoch: uuid(n),
    tabId: n,
    frameId: 0,
    origin: ORIGIN,
    continuityKey: 'k',
    accountContext: 'ctx-a',
    walletRevision: '5',
    boundAt: s.clock.t - 1000,
    ...over
  }
  const held = ((await s.browser.session.get('bsv.bindings'))['bsv.bindings'] ?? {}) as Record<string, EpochBinding>
  held[bindingKey(binding.instanceId, binding.epoch)] = binding
  await saveBindings(s.browser.session, held)
  s.browser.tabs.open.add(binding.tabId)
  return {
    binding,
    frame: { origin: binding.origin, tabId: binding.tabId, frameId: binding.frameId, context: 'safari' }
  }
}
