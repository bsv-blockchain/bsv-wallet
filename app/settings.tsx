import { useEffect } from 'react'
import { useRouter } from 'expo-router'

/** Orphaned pre-home settings route — send people to the wallet. */
export default function SettingsRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/')
  }, [router])
  return null
}
