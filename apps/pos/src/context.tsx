import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Transaction } from '@bsv/sdk'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import {
  randomId,
  sign,
  verify,
  key,
  serviceUrl,
  type Signer,
  type Receipt,
  type Signed,
  type Rpc,
  type Invite
} from '../../../packages/expo-wallet-toolbox/core/pos/protocol'
import type { SerializedFrame } from '../service/controller'
export interface Config {
  role: 'merchant' | 'cashier'
  merchant: string
  name: string
  service: string
  chain: string
  enrollment?: Invite
}
export interface Pending {
  invoice: string
  frame: SerializedFrame
  amount: number
}
const STORE = 'bsv-pos-v1'
interface PosContextValue {
  loaded: boolean
  config: Config | null
  pending: Pending | null
  configure(c: Config): Promise<void>
  savePending(p: Pending | null): Promise<void>
  rpc<T>(method: string, body?: Record<string, unknown>, target?: string): Promise<T>
  accept(p: Pending): Promise<Receipt>
}
const Context = createContext<PosContextValue | null>(null)
export function PosProvider({ children }: { children: React.ReactNode }) {
  const { managers, adminOriginator } = useWallet()
  const [loaded, setLoaded] = useState(false),
    [config, setConfig] = useState<Config | null>(null),
    [pending, setPending] = useState<Pending | null>(null)
  const pendingRef = useRef<Pending | null>(null)
  useEffect(() => {
    void AsyncStorage.getItem(STORE)
      .then(raw => {
        if (raw) {
          const state = JSON.parse(raw)
          setConfig(state.config)
          pendingRef.current = state.pending
          setPending(state.pending)
        }
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])
  const configure = async (next: Config) => {
    await AsyncStorage.setItem(STORE, JSON.stringify({ config: next, pending }))
    setConfig(next)
  }
  const savePending = async (next: Pending | null) => {
    const previous = pendingRef.current
    if (next && previous && next.invoice !== previous.invoice) throw new Error('Resolve the previous sale first')
    // Reserve the lane synchronously, before navigation can start another sale.
    // This is only a pending state; acceptance still requires a durable write.
    pendingRef.current = next
    setPending(next)
    try {
      await AsyncStorage.setItem(STORE, JSON.stringify({ config, pending: next }))
    } catch (error) {
      pendingRef.current = previous
      setPending(previous)
      throw error
    }
  }
  const rpc = useCallback(
    async <T,>(method: string, body: Record<string, unknown> = {}, target?: string): Promise<T> => {
      const wallet = managers.permissionsManager as Signer | undefined
      if (!wallet) throw new Error('Unlock your wallet first')
      const url = serviceUrl(target ?? config?.service)
      const request = await sign(
        wallet,
        { version: 1, method, nonce: randomId(), time: Date.now(), body } as Rpc,
        adminOriginator
      )
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 15000)
      try {
        const response = await fetch(url + '/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
          redirect: 'error'
        })
        const text = await response.text()
        if (text.length > 12000000) throw new Error('Merchant response too large')
        const result = JSON.parse(text)
        if (!response.ok || result.error) throw new Error('Merchant service could not complete this request')
        return result.result as T
      } finally {
        clearTimeout(timer)
      }
    },
    [managers.permissionsManager, adminOriginator, config?.service]
  )
  const accept = async (p: Pending): Promise<Receipt> => {
    if (!config) throw new Error('Merchant setup required')
    const envelope = await rpc<Signed<Receipt>>('settle', { invoice: p.invoice, frame: p.frame })
    const receipt = await verify(envelope, config.merchant)
    const txid = Transaction.fromAtomicBEEF(Uint8Array.from(p.frame.transaction)).id('hex')
    if (
      receipt.status !== 'accepted' ||
      receipt.invoice !== p.invoice ||
      receipt.amount !== p.amount ||
      receipt.txid !== txid
    )
      throw new Error('Merchant receipt does not match this sale')
    await savePending(null)
    return receipt
  }
  return (
    <Context.Provider value={{ loaded, config, pending, configure, savePending, rpc, accept }}>
      {children}
    </Context.Provider>
  )
}
export function usePos() {
  const c = useContext(Context)
  if (!c) throw new Error('Point of sale context missing')
  return c
}
