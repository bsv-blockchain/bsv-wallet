import { createBoundedNativeFetch } from '../../core/network/boundedFetch'

const mockRequest = jest.fn()
const mockCancel = jest.fn()
jest.mock('expo-modules-core', () => ({ requireNativeModule: () => ({ request: mockRequest, cancel: mockCancel }) }), {
  virtual: true
})

beforeEach(() => {
  mockRequest.mockReset()
  mockCancel.mockReset()
  mockCancel.mockResolvedValue(undefined)
})

it('passes the byte ceiling to the native receiver for both binary and JSON responses', async () => {
  mockRequest.mockResolvedValue({
    status: 200,
    headers: [['Content-Type', 'application/json']],
    body: 'eyJvayI6dHJ1ZX0='
  })
  const response = await createBoundedNativeFetch(256)('https://example.test')
  expect(mockRequest.mock.calls[0][0]).toMatchObject({ url: 'https://example.test', maxBytes: 256 })
  expect(await response.json()).toEqual({ ok: true })
})

it('forwards a binary upload and headers without changing signed request bytes', async () => {
  mockRequest.mockResolvedValue({ status: 201, headers: [], body: '' })
  await createBoundedNativeFetch(256)('https://example.test', {
    method: 'POST',
    headers: { 'X-Bsv-Auth': 'proof' },
    body: new Uint8Array([0, 255, 1])
  })
  expect(mockRequest.mock.calls[0][0]).toMatchObject({
    method: 'POST',
    headers: [['x-bsv-auth', 'proof']],
    body: 'AP8B'
  })
})

it('cancels the native receiver when the caller aborts', async () => {
  mockRequest.mockImplementation(() => new Promise(() => {}))
  const controller = new AbortController()
  const pending = createBoundedNativeFetch(256)('https://example.test', { signal: controller.signal })
  const assertion = expect(pending).rejects.toThrow('stop')
  await Promise.resolve()
  controller.abort(new Error('stop'))
  await assertion
  expect(mockCancel).toHaveBeenCalledWith(mockRequest.mock.calls[0][0].id)
})

it('does not start a native request when already cancelled', async () => {
  const controller = new AbortController()
  controller.abort(new Error('stop'))
  await expect(createBoundedNativeFetch(256)('https://example.test', { signal: controller.signal })).rejects.toThrow(
    'stop'
  )
  expect(mockRequest).not.toHaveBeenCalled()
})

it('fails closed on native receiver errors instead of retrying with global fetch', async () => {
  mockRequest.mockRejectedValue(new Error('ERR_RESPONSE_TOO_LARGE'))
  await expect(createBoundedNativeFetch(256)('https://example.test')).rejects.toThrow('ERR_RESPONSE_TOO_LARGE')
})

it('decodes JSON as UTF-8 even when the React Native Response treats buffer text as Latin-1', async () => {
  const OriginalResponse = global.Response
  // whatwg-fetch 3.6.20's readArrayBufferAsText maps bytes to codepoints.
  global.Response = class extends OriginalResponse {
    async text() {
      return String.fromCharCode(...new Uint8Array(await this.arrayBuffer()))
    }
    async json() {
      return JSON.parse(await this.text())
    }
  }
  const value = { name: 'Zoë 李', description: 'café' }
  mockRequest.mockResolvedValue({
    status: 200,
    headers: [],
    body: Buffer.from(JSON.stringify(value)).toString('base64')
  })
  try {
    const response = await createBoundedNativeFetch(256)('https://example.test')
    expect(await response.json()).toEqual(value)
    const binary = await createBoundedNativeFetch(256)('https://example.test')
    expect(Array.from(new Uint8Array(await binary.arrayBuffer()))).toEqual(
      Array.from(Buffer.from(JSON.stringify(value)))
    )
  } finally {
    global.Response = OriginalResponse
  }
})

it.each([-1, 1.5, NaN, Number.MAX_SAFE_INTEGER, 64 * 1024 * 1024 + 1])('rejects invalid response ceiling %s', cap => {
  expect(() => createBoundedNativeFetch(cap)).toThrow(RangeError)
  expect(mockRequest).not.toHaveBeenCalled()
})

it('preserves Request metadata and permits explicit option overrides', async () => {
  mockRequest.mockResolvedValue({ status: 204, headers: [], body: '' })
  const request = new Request('https://example.test/path', { method: 'HEAD', headers: { 'X-Source': 'request' } })
  const response = await createBoundedNativeFetch(0)(request)
  expect(mockRequest.mock.calls[0][0]).toMatchObject({
    url: request.url,
    method: 'HEAD',
    headers: [['x-source', 'request']],
    body: null,
    maxBytes: 0
  })
  expect(await response.text()).toBe('')
  await createBoundedNativeFetch(0)(request, { method: 'OPTIONS', headers: { 'X-Source': 'override' } })
  expect(mockRequest.mock.calls[1][0]).toMatchObject({ method: 'OPTIONS', headers: [['x-source', 'override']] })
})

it.each([205, 304])('returns an empty body for native status %s', async status => {
  mockRequest.mockResolvedValue({ status, headers: [], body: '' })
  const response = await createBoundedNativeFetch(0)('https://example.test')
  expect(response.status).toBe(status)
  expect(await response.text()).toBe('')
})

it('supports string, ArrayBuffer and Blob uploads without changing bytes', async () => {
  mockRequest.mockResolvedValue({ status: 200, headers: [], body: '' })
  const fetch = createBoundedNativeFetch(64)
  for (const body of ['Zoë', new Uint8Array([0, 255, 1]).buffer, new Blob([new Uint8Array([0, 255, 1])])]) {
    await fetch('https://example.test', { method: 'POST', body })
  }
  expect(mockRequest.mock.calls.map(([options]) => options.body)).toEqual(['Wm/Dqw==', 'AP8B', 'AP8B'])
})

it('rejects unsupported request bodies before starting native work', async () => {
  const fetch = createBoundedNativeFetch(64)
  await expect(fetch('https://example.test', { method: 'POST', body: new URLSearchParams('x=1') })).rejects.toThrow(
    /Unsupported bounded request body/
  )
  await expect(fetch(new Request('https://example.test', { method: 'POST', body: 'streamed' }))).rejects.toThrow(
    /Unsupported bounded request body/
  )
  expect(mockRequest).not.toHaveBeenCalled()
})

it('rechecks cancellation after asynchronous Blob conversion', async () => {
  const controller = new AbortController()
  const body = new Blob(['bytes'])
  const arrayBuffer = body.arrayBuffer.bind(body)
  jest.spyOn(body, 'arrayBuffer').mockImplementation(async () => {
    controller.abort(new Error('cancelled while converting'))
    return arrayBuffer()
  })
  await expect(
    createBoundedNativeFetch(64)('https://example.test', { body, signal: controller.signal })
  ).rejects.toThrow(/cancelled while converting/)
  expect(mockRequest).not.toHaveBeenCalled()
})

it('reports cancellation during Blob conversion without a platform-provided reason', async () => {
  const controller = new AbortController()
  Object.defineProperty(controller.signal, 'reason', { value: undefined })
  const body = new Blob(['bytes'])
  jest.spyOn(body, 'arrayBuffer').mockImplementation(async () => {
    controller.abort()
    return new ArrayBuffer(0)
  })
  await expect(
    createBoundedNativeFetch(64)('https://example.test', { body, signal: controller.signal })
  ).rejects.toThrow('Request aborted')
  expect(mockRequest).not.toHaveBeenCalled()
})

it('uses a stable abort error on runtimes without AbortSignal.reason and tolerates native cancellation failure', async () => {
  mockRequest.mockImplementation(() => new Promise(() => {}))
  mockCancel.mockRejectedValue(new Error('already closed'))
  const controller = new AbortController()
  Object.defineProperty(controller.signal, 'reason', { value: undefined })
  const pending = createBoundedNativeFetch(64)('https://example.test', { signal: controller.signal })
  const rejection = expect(pending).rejects.toThrow('Request aborted')
  controller.abort()
  await rejection
  await expect(createBoundedNativeFetch(64)('https://example.test', { signal: controller.signal })).rejects.toThrow(
    'Request aborted'
  )
  expect(mockRequest).toHaveBeenCalledTimes(1)
})

it('encodes large uploads across complete base64 chunk boundaries', async () => {
  mockRequest.mockResolvedValue({ status: 200, headers: [], body: '' })
  const bytes = new Uint8Array(24_577).map((_, index) => index % 256)
  await createBoundedNativeFetch(64)('https://example.test', { method: 'POST', body: bytes })
  expect(Buffer.from(mockRequest.mock.calls[0][0].body, 'base64')).toEqual(Buffer.from(bytes))
})
