import { useCallback, useEffect, useRef } from 'react'
import connectionStore from '../stores/ConnectionStore'
import { registerSessionTeardown } from './sessionTeardown'

/** Cancels screen-side authority checks that run before connect/reconnect begins. */
export function usePairingAttempt() {
  const generation = useRef(0)
  const mounted = useRef(true)
  const cancel = useCallback(() => {
    generation.current++
  }, [])

  useEffect(() => {
    mounted.current = true
    const unregister = registerSessionTeardown(['logout', 'profile'], cancel)
    return () => {
      mounted.current = false
      cancel()
      unregister()
    }
  }, [cancel])

  const begin = useCallback((topic?: string) => {
    const attempt = ++generation.current
    const revocation = topic === undefined ? undefined : connectionStore.revocationVersion(topic)
    return () =>
      mounted.current &&
      generation.current === attempt &&
      (topic === undefined || connectionStore.revocationVersion(topic) === revocation)
  }, [])

  return { begin, cancel }
}
