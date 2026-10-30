import React, { useContext, useLayoutEffect, useSyncExternalStore } from 'react'
import { RELAYED_CONTEXTS } from './relayedContexts'

/**
 * Feeds a second React root the contexts of the first (spec 7.4, 10). `ContextRelayPublisher` is rendered inside
 * the first root's providers and writes each relayed context's current value into a module-level store;
 * `ContextRelaySubscriber` is the second root's top and re-provides those values to its children. Both roots live
 * in one JS runtime, so the store is shared by module identity and a value change (a theme switch, a wallet state
 * update) reaches the subscriber without remounting it.
 *
 * The subscriber renders nothing until every entry has been published once: a child must never read a context
 * default (the default of `WalletContext` is a wallet that is not there).
 */

type Snapshot = { readonly values: ReadonlyArray<unknown>; readonly published: ReadonlyArray<boolean> }

const EMPTY: Snapshot = {
  values: RELAYED_CONTEXTS.map(() => undefined),
  published: RELAYED_CONTEXTS.map(() => false)
}

let snapshot: Snapshot = EMPTY
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of [...listeners]) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function getSnapshot(): Snapshot {
  return snapshot
}

function publish(values: ReadonlyArray<unknown>): void {
  const changed = values.some((v, i) => !snapshot.published[i] || !Object.is(v, snapshot.values[i]))
  if (!changed) return
  snapshot = { values: [...values], published: values.map(() => true) }
  emit()
}

/** Publishes one entry only; tests use it to prove the subscriber waits for every entry. Not exported from the barrel. */
export function publishRelayedContextForTest(name: string, value: unknown): void {
  const i = RELAYED_CONTEXTS.findIndex(e => e.name === name)
  if (i < 0) throw new Error(`not a relayed context: ${name}`)
  const values = [...snapshot.values]
  const published = [...snapshot.published]
  values[i] = value
  published[i] = true
  snapshot = { values, published }
  emit()
}

/** Clears the store: tests, and sign-out (a later sheet must not render a signed-out wallet's values). */
export function resetContextRelay(): void {
  snapshot = EMPTY
  emit()
}

/** Rendered once inside the first root's providers. Renders nothing. */
export const ContextRelayPublisher: React.FC = () => {
  // The list is a module constant, so the number of hooks never changes between renders.
  const values = RELAYED_CONTEXTS.map(entry => useContext(entry.context)) // eslint-disable-line react-hooks/rules-of-hooks
  // Layout effect: the second root learns the value before the next paint, so a theme switch never shows one frame
  // of mixed colours across the two roots.
  useLayoutEffect(() => {
    publish(values)
  })
  return null
}

/** The second root's top: re-provides each relayed context with the live value. */
export const ContextRelaySubscriber: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (!snap.published.every(Boolean)) return null
  // The nesting is stable (same order, same types), so a value change updates providers in place and never remounts.
  return RELAYED_CONTEXTS.reduceRight<React.ReactNode>(
    (inner, entry, i) => <entry.context.Provider value={snap.values[i]}>{inner}</entry.context.Provider>,
    children
  ) as React.ReactElement
}
