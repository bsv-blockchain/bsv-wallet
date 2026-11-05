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
import { parseHeader } from './headerConsensus'

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

/** Bytes in one serialized block header. */
const HEADER_BYTES = 80

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
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 100000)
    throw new Error('Invalid header chunk size')
  const presentHeight = await client.getPresentHeight()
  let added = 0
  if (!Number.isSafeInteger(presentHeight) || presentHeight < store.anchor.height || presentHeight > 0x7fffffff) {
    throw new Error('Chain source returned an invalid present height')
  }
  if (store.needsContext) {
    const hex = await client.getHeaders(store.contextStartHeight, store.contextCount)
    if (hex.length !== store.contextCount * HEADER_BYTES * 2 || !/^[0-9a-f]+$/i.test(hex)) {
      throw new Error('Header bootstrap context unavailable or malformed')
    }
    await store.initializeContext(new Uint8Array(Utils.toArray(hex, 'hex')))
  }
  // A same-height or shorter competing chain can still have more work. Do not
  // use advertised height as a substitute for comparing locally computed work.
  if (store.count > 0 && presentHeight <= store.tipHeight) {
    const at = Math.min(presentHeight, store.tipHeight)
    const hex = await client.getHeaders(at, 1)
    if (hex.length !== HEADER_BYTES * 2) throw new Error('Chain tip header unavailable')
    if (parseHeader(new Uint8Array(Utils.toArray(hex, 'hex'))).hash !== store.hashForHeight(at)) {
      added += await reconcileBranch(store, client, presentHeight, chunkSize, shouldStop)
    }
  }

  while (store.tipHeight < presentHeight) {
    if (shouldStop?.()) break
    const from = store.tipHeight + 1
    const want = Math.min(chunkSize, presentHeight - store.tipHeight)
    const hex = await client.getHeaders(from, want)
    if (!hex) break
    let bytes = new Uint8Array(Utils.toArray(hex, 'hex'))
    if (bytes.length === 0) break
    // XR-060: each header still has to pass real PoW and chain-linkage
    // validation below, so a compromised/misbehaving chaintracks endpoint
    // cannot inject fabricated headers this way — but it could still hand
    // back a far larger batch of genuine headers than `want`, forcing
    // unbounded validation work and disk persistence in one call. Never
    // accept more than was actually requested.
    const maxBytes = want * HEADER_BYTES
    if (bytes.length > maxBytes) bytes = bytes.subarray(0, maxBytes)
    try {
      added += await store.append(bytes, from)
      onProgress?.(store.tipHeight, presentHeight)
    } catch (err) {
      if (!isFirstHeaderPrevHashError(err, from) || store.count === 0) throw err
      added += await reconcileBranch(store, client, presentHeight, chunkSize, shouldStop)
      onProgress?.(store.tipHeight, presentHeight)
    }
  }

  return { added, tipHeight: store.tipHeight, presentHeight }
}

/** Find a locally authenticated ancestor, stage/validate, then compare work. */
async function reconcileBranch(
  store: HeaderStore,
  client: HeaderSource,
  presentHeight: number,
  chunkSize: number,
  shouldStop?: () => boolean
): Promise<number> {
  let ancestor: number | undefined
  for (
    let height = Math.min(store.tipHeight, presentHeight);
    height >= store.anchor.height && height >= store.tipHeight - REWIND_CAP;
    height--
  ) {
    if (shouldStop?.()) return 0
    const hex = await client.getHeaders(height, 1)
    if (hex.length !== HEADER_BYTES * 2 || !/^[0-9a-f]+$/i.test(hex))
      throw new Error('Reorg ancestor header unavailable')
    const header = parseHeader(new Uint8Array(Utils.toArray(hex, 'hex')))
    if (header.hash === store.hashForHeight(height)) {
      ancestor = height
      break
    }
  }
  if (ancestor === undefined) throw new Error('No authenticated reorg ancestor within rewind limit')
  let staged = new Uint8Array(0)
  for (let from = ancestor + 1; from <= presentHeight;) {
    if (shouldStop?.()) return 0
    const want = Math.min(chunkSize, presentHeight - from + 1)
    const hex = await client.getHeaders(from, want)
    if (!hex || !/^[0-9a-f]+$/i.test(hex)) throw new Error('Replacement header branch unavailable')
    const bytes = new Uint8Array(Utils.toArray(hex.slice(0, want * HEADER_BYTES * 2), 'hex'))
    if (bytes.length === 0 || bytes.length % HEADER_BYTES !== 0) throw new Error('Malformed replacement header branch')
    const merged = new Uint8Array(staged.length + bytes.length)
    merged.set(staged)
    merged.set(bytes, staged.length)
    staged = merged
    from += bytes.length / HEADER_BYTES
    try {
      return await store.replaceBranch(ancestor + 1, staged)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith('Replacement header branch does not have greater accumulated work')
      )
        throw error
      if (from > presentHeight) throw error
    }
  }
  throw new Error('Replacement header branch does not have greater accumulated work')
}
