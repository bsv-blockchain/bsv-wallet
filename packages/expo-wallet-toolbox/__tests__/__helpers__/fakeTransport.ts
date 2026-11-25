export const OTHER = 'other.example'

export const wellKnown = (over: Record<string, unknown> = {}) => ({
  bsvalias: '1.0',
  capabilities: {
    '0ace65da5987': 'https://mb.other.example/api/handle/{query}',
    '43dcf83ddc5f': 'https://mb.other.example/api/identityKey/{pubkey}',
    ...over
  }
})

export const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
/** The body matters for the refusals: a failing host may still answer with JSON. */
export const notOk = (status: number, body: unknown = {}) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response

export const srv = (data: string, over: Record<string, unknown> = {}) => ({
  Status: 0,
  AD: true,
  Answer: [{ name: `_bsvalias._tcp.${OTHER}`, type: 33, data }],
  ...over
})

/** One scripted transport: a list of [urlSubstring, response] rules. */
export function transport(rules: [string, () => Promise<Response>][]) {
  const calls: string[] = []
  const inits: (RequestInit | undefined)[] = []
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    calls.push(String(input))
    inits.push(init)
    for (const [needle, make] of rules) if (String(input).includes(needle)) return await make()
    throw new Error(`unexpected request: ${String(input)}`)
  }) as unknown as typeof fetch
  return { fetchImpl, calls, inits }
}
