/**
 * Pulls headers from a chaintracks deployment into the local window.
 *
 * `getHeaders(height, count)` returns hex of concatenated 80-byte headers and is
 * the only header source that works on every chain we ship — there is no bulk
 * header CDN for teratest. Verified against both deployments on 2026-07-28.
 *
 * The default chunk of 2,000 headers is 320 KB of response body: about 26
 * requests per year of mainnet headers, small enough that a dropped connection
 * costs almost nothing and progress moves visibly.
 */
import { Utils } from '@bsv/sdk'
import type { HeaderStore } from './headerStore'

export interface HeaderSource {
  getHeaders(height: number, count: number): Promise<string>
  getPresentHeight(): Promise<number>
}

export interface SyncHeadersResult {
  added: number
  tipHeight: number
  presentHeight: number
}

/** Walk back at most this many headers before giving up and resetting. */
const REWIND_CAP = 144

function isFirstHeaderPrevHashError(err: unknown, firstHeight: number): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /previous hash/i.test(msg) && msg.includes(`header at height ${firstHeight} `)
}

export async function syncHeaders(args: {
  store: HeaderStore
  client: HeaderSource
  chunkSize?: number
  onProgress?: (tipHeight: number, presentHeight: number) => void
  shouldStop?: () => boolean
}): Promise<SyncHeadersResult> {
  const { store, client, chunkSize = 2000, onProgress, shouldStop } = args
  const presentHeight = await client.getPresentHeight()
  let added = 0
  let rewinds = 0

  while (store.tipHeight < presentHeight) {
    if (shouldStop?.()) break
    const from = store.tipHeight + 1
    const want = Math.min(chunkSize, presentHeight - store.tipHeight)
    const hex = await client.getHeaders(from, want)
    if (!hex) break
    const bytes = new Uint8Array(Utils.toArray(hex, 'hex'))
    if (bytes.length === 0) break
    try {
      added += await store.append(bytes, from)
      onProgress?.(store.tipHeight, presentHeight)
    } catch (err) {
      // First-header previous-hash miss is a tip reorg: drop the orphan and
      // refetch. A later header in the chunk, or any other validation failure,
      // still propagates — a silent truncated window would look complete.
      if (!isFirstHeaderPrevHashError(err, from)) throw err
      if (store.count > 0 && rewinds < REWIND_CAP) {
        await store.truncateToCount(store.count - 1)
        rewinds++
        continue
      }
      await store.reset()
      throw err
    }
  }

  return { added, tipHeight: store.tipHeight, presentHeight }
}
