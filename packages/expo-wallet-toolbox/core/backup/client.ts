/**
 * App-side adapter over `@bsv/backup-cache-client`.
 *
 * The wire client lives in the npm package (published from
 * go-private-backup-cache/ts-client) and speaks the server's stateless
 * per-request auth-proof protocol: one signed header per request, no
 * handshake, no session, so uploads and downloads stream end to end and the
 * server's blob cap is what GET /v1/limits says (200 MiB after the
 * transaction-storage-capacity work) rather than a constant baked in here.
 *
 * This module keeps the two app-specific decisions out of the package:
 *
 *  - IDENTITY. Requests authenticate as the backup pseudonym derived from the
 *    wallet's m/0'/0' key, never the wallet's identity key. The constructor
 *    takes the primary key and derives the wallet itself so no call site can
 *    accidentally hand the client the real identity.
 *
 *  - TIMEOUTS. The monitor awaits its tasks, so a request that never answers
 *    holds the task pending indefinitely — observed on device as BackupPush
 *    passes running past 100 seconds. Every request is bounded here; a backup
 *    is never urgent, and giving up until the next pass is strictly better
 *    than occupying the monitor.
 */
import {
  BackupCacheClient,
  BackupHttpError,
  ERR_BLOB_TOO_LARGE,
  ERR_SEQ_CONFLICT,
  type DeviceSummary,
  type Limits,
  type LogEntry
} from '@bsv/backup-cache-client'
import type { BackupChain } from './constants'
import { deriveBackupWallet } from './derive'

export { BackupHttpError, ERR_BLOB_TOO_LARGE, ERR_SEQ_CONFLICT }
export type { DeviceSummary, Limits, LogEntry }

/**
 * Ceiling on any single backup request.
 *
 * Applies per HTTP request. The stateless proof protocol needs exactly one
 * request per operation (the old BRC-103 handshake needed two), so this now
 * bounds each operation outright.
 */
export const BACKUP_REQUEST_TIMEOUT_MS = 30_000

export class BackupClient extends BackupCacheClient {
  /**
   * @param baseUrl origin of the backup service, no trailing slash or path
   *   prefix — the request URI is signed into every proof, so a prefix the
   *   server does not see identically would fail all of them.
   * @param primaryKey the wallet's m/0'/0' key, from which the pseudonym is derived.
   * @param chain the network this client serves. Each chain derives a different
   *   pseudonym, so each network's log lives in its own server account.
   * @param fetchImpl injectable transport for tests; defaults to global fetch.
   */
  constructor(baseUrl: string, primaryKey: number[], chain: BackupChain, fetchImpl?: typeof fetch) {
    super({
      baseUrl,
      wallet: deriveBackupWallet(primaryKey, chain),
      fetch: withBackupRequestTimeout(fetchImpl ?? ((input, init) => fetch(input, init)))
    })
  }

  /**
   * Append a chunk. Accepts the codec's `number[]` ciphertext alongside the
   * package's own body shapes, so encodeChunk's output flows straight through.
   */
  override async append(
    deviceId: string,
    generation: number,
    seq: number,
    prevSha256: string | undefined,
    body: Uint8Array | Blob | number[]
  ): Promise<{ seq: number; sha256: string; size: number }> {
    const bytes = Array.isArray(body) ? new Uint8Array(body) : body
    return await super.append(deviceId, generation, seq, prevSha256, bytes)
  }
}

/**
 * Bound the request and the body readers used by BackupCacheClient with one
 * deadline. React Native's XHR fetch resolves after the download, but its
 * Blob/FileReader conversion is still asynchronous; browser fetch can resolve
 * before any body bytes arrive. Neither phase may strand the monitor.
 *
 * Wrap the existing readers instead of rebuilding/cloning the Response: a
 * large backup still allocates only the buffer the package itself requests.
 */
export function withBackupRequestTimeout(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController()
    const callerSignal =
      init?.signal ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null)
    const deadline = Date.now() + BACKUP_REQUEST_TIMEOUT_MS

    async function bounded<T>(operation: () => Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined
      let rejectStopped!: (reason: unknown) => void
      const stopped = new Promise<never>((_resolve, reject) => {
        rejectStopped = reject
      })
      const cancel = (reason: unknown) => {
        // Reject before aborting: a transport's synchronous AbortError must not
        // mask the more useful timeout or caller-supplied cancellation reason.
        rejectStopped(reason)
        controller.abort(reason)
      }
      const onAbort = () => {
        const error = new Error('Backup request aborted')
        error.name = 'AbortError'
        cancel(callerSignal?.reason ?? error)
      }
      try {
        const remaining = deadline - Date.now()
        if (callerSignal?.aborted) {
          onAbort()
          return await stopped
        }
        callerSignal?.addEventListener('abort', onAbort)
        const onTimeout = () =>
          cancel(new Error(`Backup request timed out after ${BACKUP_REQUEST_TIMEOUT_MS}ms: ${String(input)}`))
        if (remaining <= 0) {
          onTimeout()
          return await stopped
        }
        timer = setTimeout(onTimeout, remaining)
        ;(timer as { unref?: () => void }).unref?.()
        return await Promise.race([operation(), stopped])
      } finally {
        if (timer != null) clearTimeout(timer)
        callerSignal?.removeEventListener('abort', onAbort)
      }
    }

    const response = await bounded(() => transport(input, { ...init, signal: controller.signal }))
    const readJson = response.json.bind(response)
    const readArrayBuffer = response.arrayBuffer.bind(response)
    response.json = () => bounded(readJson)
    response.arrayBuffer = () => bounded(readArrayBuffer)
    return response
  }
}
