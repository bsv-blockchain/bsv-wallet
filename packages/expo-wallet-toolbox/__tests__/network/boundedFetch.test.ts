import { createBoundedNativeFetch } from '../../core/network/boundedFetch'

const mockRequest = jest.fn()
const mockCancel = jest.fn()
jest.mock('expo-modules-core', () => ({ requireNativeModule: () => ({ request: mockRequest, cancel: mockCancel }) }), { virtual: true })

beforeEach(() => { mockRequest.mockReset(); mockCancel.mockReset(); mockCancel.mockResolvedValue(undefined) })

it('passes the byte ceiling to the native receiver for both binary and JSON responses', async () => {
  mockRequest.mockResolvedValue({ status: 200, headers: [['Content-Type', 'application/json']], body: 'eyJvayI6dHJ1ZX0=' })
  const response = await createBoundedNativeFetch(256)('https://example.test')
  expect(mockRequest.mock.calls[0][0]).toMatchObject({ url: 'https://example.test', maxBytes: 256 })
  expect(await response.json()).toEqual({ ok: true })
})

it('forwards a binary upload and headers without changing signed request bytes', async () => {
  mockRequest.mockResolvedValue({ status: 201, headers: [], body: '' })
  await createBoundedNativeFetch(256)('https://example.test', {
    method: 'POST', headers: { 'X-Bsv-Auth': 'proof' }, body: new Uint8Array([0, 255, 1])
  })
  expect(mockRequest.mock.calls[0][0]).toMatchObject({ method: 'POST', headers: [['x-bsv-auth', 'proof']], body: 'AP8B' })
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
  await expect(createBoundedNativeFetch(256)('https://example.test', { signal: controller.signal })).rejects.toThrow('stop')
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
    async text() { return String.fromCharCode(...new Uint8Array(await this.arrayBuffer())) }
    async json() { return JSON.parse(await this.text()) }
  }
  const value = { name: 'Zoë 李', description: 'café' }
  mockRequest.mockResolvedValue({ status: 200, headers: [], body: Buffer.from(JSON.stringify(value)).toString('base64') })
  try {
    const response = await createBoundedNativeFetch(256)('https://example.test')
    expect(await response.json()).toEqual(value)
    const binary = await createBoundedNativeFetch(256)('https://example.test')
    expect(Array.from(new Uint8Array(await binary.arrayBuffer()))).toEqual(Array.from(Buffer.from(JSON.stringify(value))))
  } finally { global.Response = OriginalResponse }
})
