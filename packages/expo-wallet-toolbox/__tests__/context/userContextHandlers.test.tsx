import React, { useContext } from 'react'
import { render, act } from '@testing-library/react-native'
import { UserContext, UserContextProvider, mergeNativeHandlers } from '../../core/context/UserContext'
import type { UserContextValue } from '../../core/context/UserContext'

async function renderUserContext(nativeHandlers?: Parameters<typeof UserContextProvider>[0]['nativeHandlers']) {
  let context!: UserContextValue
  function Observe() {
    context = useContext(UserContext)
    return null
  }
  const renderer = render(
    <UserContextProvider nativeHandlers={nativeHandlers}>
      <Observe />
    </UserContextProvider>
  )
  await act(async () => {})
  return {
    get context() {
      return context
    },
    renderer
  }
}

describe('mergeNativeHandlers', () => {
  it('fills in defaults for every field when nothing is provided', () => {
    const handlers = mergeNativeHandlers()
    expect(typeof handlers.isFocused).toBe('function')
    expect(typeof handlers.onFocusRequested).toBe('function')
    expect(typeof handlers.onFocusRelinquished).toBe('function')
    expect(typeof handlers.onDownloadFile).toBe('function')
  })

  it('fills in only the missing field when onDownloadFile is omitted', () => {
    const customIsFocused = async () => true
    const handlers = mergeNativeHandlers({
      isFocused: customIsFocused,
      onFocusRequested: async () => {},
      onFocusRelinquished: async () => {}
    })
    expect(handlers.isFocused).toBe(customIsFocused)
    expect(typeof handlers.onDownloadFile).toBe('function')
  })

  it('keeps a caller-supplied onDownloadFile instead of the default', () => {
    const customDownload = async () => true
    const handlers = mergeNativeHandlers({ onDownloadFile: customDownload })
    expect(handlers.onDownloadFile).toBe(customDownload)
  })
})

describe('UserContextProvider', () => {
  it('exposes a default onDownloadFile function when nativeHandlers omits it', async () => {
    const { context } = await renderUserContext({
      isFocused: async () => false,
      onFocusRequested: async () => {},
      onFocusRelinquished: async () => {}
    })

    expect(typeof context.onDownloadFile).toBe('function')
  })

  it('exposes a default onDownloadFile function when nativeHandlers is omitted entirely', async () => {
    const { context } = await renderUserContext()

    expect(typeof context.onDownloadFile).toBe('function')
  })
})
