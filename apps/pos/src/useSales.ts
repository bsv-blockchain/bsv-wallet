import { useCallback, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { usePos } from './context'
import { verifiedSales, type VerifiedSale } from './sales'
import type { Sale, Cashier } from '../service/controller'
export function useSales() {
  const { config, rpc } = usePos()
  const [sales, setSales] = useState<VerifiedSale[]>([]),
    [cashiers, setCashiers] = useState<Cashier[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false)
  const version = useRef(0)
  const merchant = config?.merchant,
    chain = config?.chain,
    role = config?.role,
    enrolling = !!config?.enrollment
  const refresh = useCallback(async () => {
    if (!merchant || !chain || !role || enrolling) return
    const current = ++version.current
    setBusy(true)
    setError('')
    try {
      const [rows, team] = await Promise.all([
        rpc<(Sale & { pending?: boolean })[]>('sales'),
        role === 'merchant' ? rpc<Cashier[]>('cashiers') : Promise.resolve([])
      ])
      const checked = await verifiedSales(rows, merchant, chain)
      if (current !== version.current) return
      setSales(checked.sort((a, b) => b.expires - a.expires))
      setCashiers(team)
      setLoaded(true)
    } catch {
      if (current === version.current)
        setError('Could not refresh verified sales. Check your connection and cashier access.')
    } finally {
      if (current === version.current) setBusy(false)
    }
  }, [merchant, chain, role, enrolling, rpc])
  useFocusEffect(
    useCallback(() => {
      void refresh()
      return () => {
        version.current++
      }
    }, [refresh])
  )
  return { sales, cashiers, busy, error, loaded, refresh }
}
