import { BRIDGE_METHODS } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/methods'
import type { EpochBinding } from '../../extension/src/lib/bindings'
import { localAnswer } from '../../extension/src/lib/localAnswers'
import { connectedHash } from '../../shared/mirror'
import { INSTANCE, makeMirror } from './fakeBrowser'

const ORIGIN = 'https://app.example'
const KEY = '02' + 'ab'.repeat(32)
const binding: EpochBinding = {
  instanceId: INSTANCE,
  epoch: '22222222-2222-4222-8222-222222222222',
  tabId: 1,
  frameId: 0,
  origin: ORIGIN,
  continuityKey: 'k',
  accountContext: 'ctx-a',
  walletRevision: '5',
  boundAt: 1
}
const good = () => makeMirror({ connected: [connectedHash(ORIGIN)], identityKey: KEY })
const ARGS = { identityKey: true }
const ask = (
  args: unknown = ARGS,
  b: EpochBinding | undefined = binding,
  m = good() as ReturnType<typeof good> | undefined
) => localAnswer('getPublicKey', args, b, m, ORIGIN)

describe('localAnswer getPublicKey', () => {
  it('passes when all six conditions hold', () => {
    expect(ask()).toEqual({ answer: { publicKey: KEY } })
  })

  it('1: counterparty present (or any other argument) goes to the app', () => {
    for (const args of [
      { identityKey: true, counterparty: 'self' },
      { identityKey: true, forSelf: true },
      { identityKey: true, privileged: false },
      { identityKey: true, seekPermission: false },
      { identityKey: true, protocolID: [1, 'x'], keyID: '1' },
      { identityKey: true, originator: 'x' },
      { identityKey: false },
      { identityKey: 'true' },
      {},
      null,
      [],
      { protocolID: [1, 'x'], keyID: '1' }
    ]) {
      expect(ask(args)).toBeUndefined()
    }
  })

  it('1: missing arguments go to the app', () => {
    expect(localAnswer('getPublicKey', undefined, binding, good(), ORIGIN)).toBeUndefined()
  })

  it('2: epoch closed (not bound here) goes to the app', () => {
    expect(localAnswer('getPublicKey', ARGS, undefined, good(), ORIGIN)).toBeUndefined()
    expect(
      localAnswer('getPublicKey', ARGS, { ...binding, origin: 'https://other.example' }, good(), ORIGIN)
    ).toBeUndefined()
  })

  it('3: revision differs, account context differs, or not ready', () => {
    expect(ask(ARGS, binding, makeMirror({ connected: good().connected, revision: '6' }))).toBeUndefined()
    expect(ask(ARGS, binding, makeMirror({ connected: good().connected, accountContext: 'ctx-b' }))).toBeUndefined()
    for (const readiness of ['building', 'blocked', 'none'] as const) {
      const m = makeMirror({ connected: good().connected, readiness, identityKey: KEY })
      expect(ask(ARGS, binding, m)).toBeUndefined()
    }
  })

  it('4: site not in connected', () => {
    expect(ask(ARGS, binding, makeMirror({ connected: [connectedHash('https://other.example')] }))).toBeUndefined()
    expect(ask(ARGS, binding, makeMirror({ connected: [] }))).toBeUndefined()
  })

  it('5: identityKeyPrompts true', () => {
    expect(ask(ARGS, binding, makeMirror({ connected: good().connected, prompts: true }))).toBeUndefined()
  })

  it('6: identityKey null or malformed', () => {
    for (const identityKey of [null, '', '02ab', KEY + '00', 'zz'.repeat(33)]) {
      expect(ask(ARGS, binding, makeMirror({ connected: good().connected, identityKey }))).toBeUndefined()
    }
  })

  it('absent mirror always stages', () => {
    expect(localAnswer('getPublicKey', ARGS, binding, undefined, ORIGIN)).toBeUndefined()
  })
})

describe('localAnswer probes', () => {
  it('getVersion and isAuthenticated answer only when mirror present and not none', () => {
    const m = makeMirror({ baseVersion: 'vendor-1.0.0' })
    expect(localAnswer('getVersion', {}, binding, m, ORIGIN)).toEqual({ answer: { version: 'vendor-1.0.0' } })
    expect(localAnswer('isAuthenticated', {}, binding, m, ORIGIN)).toEqual({ answer: { authenticated: true } })
    const building = makeMirror({ readiness: 'building' })
    expect(localAnswer('isAuthenticated', {}, binding, building, ORIGIN)).toEqual({ answer: { authenticated: false } })
    expect(localAnswer('getVersion', {}, binding, building, ORIGIN)).toEqual({ answer: { version: 'vendor-1.0.0' } })

    const none = makeMirror({ readiness: 'none' })
    for (const method of ['getVersion', 'isAuthenticated']) {
      expect(localAnswer(method, {}, binding, none, ORIGIN)).toBeUndefined()
      expect(localAnswer(method, {}, binding, undefined, ORIGIN)).toBeUndefined()
      expect(localAnswer(method, {}, undefined, m, ORIGIN)).toBeUndefined()
    }
  })

  it('every other of the 28 methods returns undefined', () => {
    const others = Object.keys(BRIDGE_METHODS).filter(
      m => !['getVersion', 'isAuthenticated', 'getPublicKey'].includes(m)
    )
    expect(others).toHaveLength(25)
    for (const method of others) expect(localAnswer(method, {}, binding, good(), ORIGIN)).toBeUndefined()
    expect(localAnswer('notAMethod', {}, binding, good(), ORIGIN)).toBeUndefined()
  })
})
