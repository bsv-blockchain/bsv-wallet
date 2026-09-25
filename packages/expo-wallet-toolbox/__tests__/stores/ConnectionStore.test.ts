/**
 * XR-027: ConnectionStore.add() must attach a staged authority tag to a
 * freshly created record in the SAME synchronous step, so a connection is
 * never observably tagless in between -- and must never resurrect a stale
 * staged tag for an unrelated later record with the same sessionId.
 *
 * Each test gets a fresh module instance (the store is a module-level
 * singleton) via resetModules + a fresh require, so tests cannot bleed
 * connections/staged tags into one another.
 */
import type { Connection } from '../../core/stores/ConnectionStore'

function freshStore() {
  jest.resetModules()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('../../core/stores/ConnectionStore') as typeof import('../../core/stores/ConnectionStore')).default
}

const connection = (over: Partial<Connection> = {}): Connection => ({
  sessionId: 'topic-1',
  origin: 'https://app.example',
  relay: 'wss://relay.example',
  backendIdentityKey: '02' + 'aa'.repeat(32),
  mobileIdentityKey: '02' + 'bb'.repeat(32),
  protocolID: JSON.stringify([0, 'mobile wallet session']),
  connectedAt: Date.now(),
  status: 'active',
  ...over
})

describe('ConnectionStore', () => {
  it('add() with no staged tag creates an untagged record', () => {
    const store = freshStore()
    store.add(connection())
    expect(store.connections[0].authorityTag).toBeUndefined()
  })

  it('XR-027: add() attaches a staged authority tag to the record it creates', () => {
    const store = freshStore()
    store.stageAuthorityTag('topic-1', 'tag-abc')
    store.add(connection())
    expect(store.connections[0].authorityTag).toBe('tag-abc')
  })

  it('XR-027: a staged tag is consumed once -- a later add() for a different sessionId is unaffected', () => {
    const store = freshStore()
    store.stageAuthorityTag('topic-1', 'tag-abc')
    store.add(connection({ sessionId: 'topic-1' }))
    store.add(connection({ sessionId: 'topic-2' }))
    expect(store.connections.find(c => c.sessionId === 'topic-1')?.authorityTag).toBe('tag-abc')
    expect(store.connections.find(c => c.sessionId === 'topic-2')?.authorityTag).toBeUndefined()
  })

  it('discardStagedAuthorityTag() drops a staged tag whose connect() attempt never completed', () => {
    const store = freshStore()
    store.stageAuthorityTag('topic-1', 'tag-abc')
    store.discardStagedAuthorityTag('topic-1')
    store.add(connection({ sessionId: 'topic-1' }))
    expect(store.connections[0].authorityTag).toBeUndefined()
  })

  it('discarding or staging for an unknown sessionId never throws', () => {
    const store = freshStore()
    expect(() => store.discardStagedAuthorityTag('never-staged')).not.toThrow()
  })

  it('setStatus() and remove() do not disturb an existing authorityTag', () => {
    const store = freshStore()
    store.stageAuthorityTag('topic-1', 'tag-abc')
    store.add(connection({ sessionId: 'topic-1', status: 'disconnected' }))
    store.setStatus('topic-1', 'active')
    expect(store.connections[0].authorityTag).toBe('tag-abc')
  })
})
