import { act, renderHook } from '@testing-library/react-native'
import { usePermissionQueue } from '../../core/hooks/usePermissionQueue'

type Item = { requestID: string }

function setup(focused = false) {
  const openModal = jest.fn()
  const onFocusRequested = jest.fn()
  const onFocusRelinquished = jest.fn()
  const hook = renderHook(() =>
    usePermissionQueue<Item>({
      openModal,
      isFocused: async () => focused,
      onFocusRequested,
      onFocusRelinquished
    })
  )
  return { hook, openModal, onFocusRequested, onFocusRelinquished }
}

const ids = (hook: ReturnType<typeof setup>['hook']) => hook.result.current.requests.map(r => r.requestID)

describe('usePermissionQueue', () => {
  it('opens the modal and takes focus on the first item', async () => {
    const { hook, openModal, onFocusRequested } = setup()
    await act(async () => hook.result.current.enqueue({ requestID: 'a' }))
    expect(openModal).toHaveBeenCalledWith(true)
    expect(onFocusRequested).toHaveBeenCalledTimes(1)
    await act(async () => hook.result.current.enqueue({ requestID: 'b' }))
    expect(onFocusRequested).toHaveBeenCalledTimes(1)
    expect(ids(hook)).toEqual(['a', 'b'])
  })

  it('advance() without an id still drops the head', async () => {
    const { hook, openModal, onFocusRelinquished } = setup()
    await act(async () => {
      hook.result.current.enqueue({ requestID: 'a' })
      hook.result.current.enqueue({ requestID: 'b' })
    })
    const seen: string[] = []
    await act(async () => hook.result.current.advance(head => void seen.push(head.requestID)))
    expect(seen).toEqual(['a'])
    expect(ids(hook)).toEqual(['b'])
    await act(async () => hook.result.current.advance())
    expect(ids(hook)).toEqual([])
    expect(openModal).toHaveBeenLastCalledWith(false)
    expect(onFocusRelinquished).toHaveBeenCalledTimes(1)
  })

  it('advance(_, id) removes only that item, and nothing when it is gone', async () => {
    const { hook, openModal } = setup()
    await act(async () => {
      hook.result.current.enqueue({ requestID: 'a' })
      hook.result.current.enqueue({ requestID: 'b' })
    })
    await act(async () => hook.result.current.advance(undefined, 'b'))
    expect(ids(hook)).toEqual(['a'])
    openModal.mockClear()
    await act(async () => hook.result.current.advance(undefined, 'zzz'))
    expect(ids(hook)).toEqual(['a'])
    expect(openModal).not.toHaveBeenCalled()
  })

  it('removeById reports whether the item was queued', async () => {
    const { hook, openModal, onFocusRelinquished } = setup()
    await act(async () => hook.result.current.enqueue({ requestID: 'a' }))
    let removed: boolean[] = []
    await act(async () => {
      removed = [
        hook.result.current.removeById('nope'),
        hook.result.current.removeById('a'),
        hook.result.current.removeById('a')
      ]
    })
    expect(removed).toEqual([false, true, false])
    expect(ids(hook)).toEqual([])
    expect(openModal).toHaveBeenLastCalledWith(false)
    expect(onFocusRelinquished).toHaveBeenCalledTimes(1)
  })

  it('does not take focus back from a user who already had it', async () => {
    const { hook, onFocusRequested, onFocusRelinquished } = setup(true)
    await act(async () => hook.result.current.enqueue({ requestID: 'a' }))
    await act(async () => hook.result.current.clear())
    expect(onFocusRequested).not.toHaveBeenCalled()
    expect(onFocusRelinquished).not.toHaveBeenCalled()
  })

  it('clear empties the queue, hands every item to the callback, closes the modal and gives focus back', async () => {
    const { hook, openModal, onFocusRelinquished } = setup()
    await act(async () => {
      hook.result.current.enqueue({ requestID: 'a' })
      hook.result.current.enqueue({ requestID: 'b' })
    })
    const seen: string[] = []
    await act(async () => hook.result.current.clear(item => void seen.push(item.requestID)))
    expect(seen).toEqual(['a', 'b'])
    expect(ids(hook)).toEqual([])
    expect(openModal).toHaveBeenLastCalledWith(false)
    expect(onFocusRelinquished).toHaveBeenCalledTimes(1)
  })

  it('clear on an empty queue does nothing', async () => {
    const { hook, openModal, onFocusRelinquished } = setup()
    await act(async () => hook.result.current.clear())
    expect(openModal).not.toHaveBeenCalled()
    expect(onFocusRelinquished).not.toHaveBeenCalled()
  })
})
