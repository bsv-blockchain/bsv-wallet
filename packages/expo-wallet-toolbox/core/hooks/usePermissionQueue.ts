import { useState, useCallback, useRef } from 'react'

interface UsePermissionQueueOptions<T = unknown> {
  /** Open/close the associated modal. Omit for queues without a modal (e.g. BTMS). */
  openModal?: (open: boolean) => void
  isFocused: () => Promise<boolean>
  onFocusRequested: () => void | Promise<void>
  onFocusRelinquished: () => void | Promise<void>
  /** Called synchronously for every item added, whether or not the queue was empty. */
  onEnqueue?: (item: T) => void
}

interface PermissionQueue<T> {
  requests: T[]
  /** Add an item to the queue. Handles focus request and modal open on first item. */
  enqueue: (item: T) => void
  /**
   * Remove the first item, or with `requestID` only the item carrying that ID
   * (and nothing at all if it is no longer queued). Closes modal and
   * relinquishes focus when empty.
   */
  advance: (onAdvance?: (removed: T) => void, requestID?: string) => void
  /** Remove the item with this `requestID`. Returns whether it was queued. */
  removeById: (requestID: string) => boolean
  /** Drop every item (handing each to `onEach`), close the modal and give focus back. */
  clear: (onEach?: (item: T) => void) => void
}

const idOf = (item: unknown): string | undefined => (item as { requestID?: string } | null)?.requestID

/**
 * Generic permission request queue with focus management.
 *
 * Deduplicates the identical queue logic used by basket, certificate,
 * protocol, spending, and BTMS permission systems.
 */
export function usePermissionQueue<T>(opts: UsePermissionQueueOptions<T>): PermissionQueue<T> {
  const { openModal, isFocused, onFocusRequested, onFocusRelinquished, onEnqueue } = opts
  const [requests, setRequests] = useState<T[]>([])
  // The queue's current contents, updated in the same step as the state, so a
  // caller (a withdrawal, an answer by ID) can tell synchronously whether an
  // item is still queued without waiting for a render.
  const itemsRef = useRef<T[]>([])
  const wasOriginallyFocusedRef = useRef(false)
  // Which "first item" the deferred focus/modal step belongs to. A clear or an advance to empty
  // moves it on, so a step that was scheduled for a queue that has since been emptied does nothing.
  const openGenRef = useRef(0)

  const replace = useCallback((next: T[]) => {
    itemsRef.current = next
    setRequests(next)
  }, [])

  const emptied = useCallback(() => {
    openGenRef.current += 1
    openModal?.(false)
    if (!wasOriginallyFocusedRef.current) onFocusRelinquished()
  }, [openModal, onFocusRelinquished])

  const enqueue = useCallback(
    (item: T) => {
      const wasEmpty = itemsRef.current.length === 0
      replace([...itemsRef.current, item])
      try {
        onEnqueue?.(item)
      } catch (e) {
        console.warn('[permissionQueue] onEnqueue failed', e)
      }
      if (wasEmpty) {
        // Schedule focus/modal on next microtask, after the state is set. Both steps re-check
        // that this queue is still the one that was filled: a withdrawal in between has already
        // closed the modal and given focus back, and must not be undone.
        const gen = ++openGenRef.current
        const stale = () => gen !== openGenRef.current || itemsRef.current.length === 0
        Promise.resolve().then(() => {
          if (stale()) return
          isFocused().then(currentlyFocused => {
            if (stale()) return
            wasOriginallyFocusedRef.current = currentlyFocused
            if (!currentlyFocused) onFocusRequested()
            openModal?.(true)
          })
        })
      }
    },
    [isFocused, onFocusRequested, openModal, replace, onEnqueue]
  )

  const advance = useCallback(
    (onAdvance?: (removed: T) => void, requestID?: string) => {
      const prev = itemsRef.current
      const index = requestID === undefined ? (prev.length > 0 ? 0 : -1) : prev.findIndex(i => idOf(i) === requestID)
      if (index < 0) return
      const removed = prev[index]
      onAdvance?.(removed)
      const next = prev.filter((_, i) => i !== index)
      replace(next)
      if (next.length === 0) emptied()
    },
    [emptied, replace]
  )

  const removeById = useCallback(
    (requestID: string): boolean => {
      if (!itemsRef.current.some(i => idOf(i) === requestID)) return false
      advance(undefined, requestID)
      return true
    },
    [advance]
  )

  const clear = useCallback(
    (onEach?: (item: T) => void) => {
      const prev = itemsRef.current
      if (prev.length === 0) return
      replace([])
      for (const item of prev) onEach?.(item)
      emptied()
    },
    [emptied, replace]
  )

  return { requests, enqueue, advance, removeById, clear }
}
