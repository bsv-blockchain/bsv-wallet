import { runInboxStoreContract } from '../../expo-wallet-toolbox/__tests__/bridge/inboxContract'
import { createNativeInboxStore } from '../src/nativeStore'
import { createFakeNative } from '../src/testing/fakeNative'

runInboxStoreContract('native adapter over fake native', clock => {
  const fake = createFakeNative({ now: clock.now })
  const { bootId } = fake.initSync()
  return {
    store: createNativeInboxStore(fake, { now: clock.now, bootId }),
    restart: () => {
      fake.restart()
      return createNativeInboxStore(fake, { now: clock.now, bootId: fake.bootId() })
    },
    rawBytes: () => fake.rawBytesSync()
  }
})
