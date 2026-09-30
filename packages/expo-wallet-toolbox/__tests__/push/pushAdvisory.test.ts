import AsyncStorage from '@react-native-async-storage/async-storage'
import { pushAdvisory } from '../../core/push/pushAdvisory'

describe('pushAdvisory', () => {
  beforeEach(() => AsyncStorage.clear())
  it('is false until set', async () => {
    expect(await pushAdvisory.get()).toBe(false)
    await pushAdvisory.set()
    expect(await pushAdvisory.get()).toBe(true)
  })
  it('reads false when storage throws', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('boom'))
    expect(await pushAdvisory.get()).toBe(false)
  })
})
