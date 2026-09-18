import { useMemo } from 'react'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { createContactsStore, type ContactsDb, type ContactsStore } from '../../core/contacts/contactsStore'

/** The contacts store for the open wallet, or null before its database is ready. */
export function useContactsStore(): ContactsStore | null {
  const { storage } = useWallet()
  const db = storage?.sqliteDb
  return useMemo(() => (db ? createContactsStore(db as unknown as ContactsDb) : null), [db])
}
