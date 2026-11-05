import { prewarmOwnRoots } from '../../core/headers/prewarm'
import { HeaderStore } from '../../core/headers/headerStore'
import { memoryHeaderFs } from '../../core/headers/fs'

const ANCHOR = { height: 100, hash: '00'.repeat(32) }

describe('prewarmOwnRoots', () => {
  it('does not authenticate unanchored proven-tx roots', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
    const added = await prewarmOwnRoots({
      rows: [
        { height: 7, merkleRoot: 'aa'.repeat(32) },
        { height: 9, merkleRoot: 'bb'.repeat(32) }
      ],
      store
    })
    expect(added).toBe(0)
    expect(store.rootForHeight(7)).toBeUndefined()
    expect(store.rootForHeight(9)).toBeUndefined()
  })

  it('skips rows already covered and malformed rows', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
    await store.putExtraRoot(7, 'aa'.repeat(32))
    const added = await prewarmOwnRoots({
      rows: [
        { height: 7, merkleRoot: 'aa'.repeat(32) },
        { height: 0, merkleRoot: '' },
        { height: 8, merkleRoot: 'cc'.repeat(32) }
      ],
      store
    })
    expect(added).toBe(0)
    expect(store.rootForHeight(8)).toBeUndefined()
  })

  it('does not authenticate either root when a height appears twice', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
    const added = await prewarmOwnRoots({
      rows: [
        { height: 7, merkleRoot: 'aa'.repeat(32) },
        { height: 7, merkleRoot: 'bb'.repeat(32) } // same height, different root — should be ignored
      ],
      store
    })
    expect(added).toBe(0)
    expect(store.rootForHeight(7)).toBeUndefined()
  })
})
