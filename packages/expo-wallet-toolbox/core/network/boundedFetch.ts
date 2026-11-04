import { Utils } from '@bsv/sdk'

interface NativeReply {
  status: number
  headers: [string, string][]
  body: string
}

interface BoundedFetchNative {
  request(options: {
    id: string
    url: string
    method: string
    headers: [string, string][]
    body: string | null
    maxBytes: number
  }): Promise<NativeReply>
  cancel(id: string): Promise<void>
}

let nextRequest = 0

/**
 * Fetch-shaped transport with an actual native receive ceiling. Both native
 * implementations count decoded bytes before appending, never stream events
 * to an unbounded JS queue, and return at most maxBytes. Missing or dishonest
 * Content-Length cannot bypass the ceiling. Redirects are returned as 3xx:
 * signed backup credentials must never be forwarded to a different endpoint.
 * There is deliberately no fallback to React Native's buffering global fetch.
 */
export function createBoundedNativeFetch(maxBytes: number): typeof fetch {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024) {
    throw new RangeError('Invalid native response byte ceiling')
  }
  return async (input, init) => {
    const original = typeof Request !== 'undefined' && input instanceof Request ? input : undefined
    const signal = init?.signal ?? original?.signal
    if (signal?.aborted) throw signal.reason ?? new Error('Request aborted')
    // Loading lazily allows tests and unsupported platforms to import the
    // toolbox. A missing native module fails before any network request.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { requireNativeModule } = require('expo-modules-core') as typeof import('expo-modules-core')
    const native = requireNativeModule<BoundedFetchNative>('BsvBoundedFetch')
    const body = init?.body
    let bytes: Uint8Array | undefined
    if (typeof body === 'string') bytes = new TextEncoder().encode(body)
    else if (body instanceof Uint8Array) bytes = body
    else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body)
    else if (typeof Blob !== 'undefined' && body instanceof Blob) bytes = new Uint8Array(await body.arrayBuffer())
    else if (body != null || original?.body != null) throw new TypeError('Unsupported bounded request body')
    if (signal?.aborted) throw signal.reason ?? new Error('Request aborted')
    const id = String(++nextRequest)
    let rejectAborted!: (reason: unknown) => void
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject })
    const onAbort = () => {
      rejectAborted(signal?.reason ?? new Error('Request aborted'))
      void native.cancel(id).catch(() => {})
    }
    const headers: [string, string][] = []
    new Headers(init?.headers ?? original?.headers).forEach((value, key) => headers.push([key, value]))
    signal?.addEventListener('abort', onAbort)
    try {
      const reply = await Promise.race([
        native.request({
          id,
          url: original?.url ?? String(input),
          method: init?.method ?? original?.method ?? 'GET',
          headers,
          body: bytes ? encodeBody(bytes) : null,
          maxBytes
        }),
        aborted
      ])
      // The native receiver has already enforced the cap, before this decoding
      // or any JSON parsing. The Response readers cannot bypass that boundary.
      const responseBody = Uint8Array.from(atob(reply.body), value => value.charCodeAt(0))
      return new Response([204, 205, 304].includes(reply.status) ? null : responseBody, {
        status: reply.status,
        headers: reply.headers
      })
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

// Keep SDK number[] conversion bounded for large backup uploads. All complete
// base64 chunks are multiples of three bytes so concatenation preserves bytes.
function encodeBody(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 24_576) {
    chunks.push(Utils.toBase64(Array.from(bytes.subarray(offset, offset + 24_576))))
  }
  return chunks.join('')
}
