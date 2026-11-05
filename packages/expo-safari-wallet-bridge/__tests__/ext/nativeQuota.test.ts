import { createNativeClient } from '../../extension/src/lib/nativeClient'

test('native retained-queue quota refuses staging as RESOURCE_LIMIT without retry', async () => {
  const send = jest.fn(async () => ({ ok: false as const, code: 'RESOURCE_LIMIT' as const, message: 'queue full' }))
  const native = createNativeClient(send, { timeoutMs: 100, retries: 3 })
  await expect(native.stage('new-id', 'eA==')).rejects.toMatchObject({
    code: 'RESOURCE_LIMIT', delivery: 'not-sent', cause: 'RESOURCE_LIMIT'
  })
  expect(send).toHaveBeenCalledTimes(1)
})
