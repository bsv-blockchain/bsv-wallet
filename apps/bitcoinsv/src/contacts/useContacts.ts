// This wallet's address book: the shared core's contacts store over the
// wallet's own SQLite (core/contacts/contactsStore.ts), with favourites and
// soft remove (decision 10). Every change goes through here and tells every
// screen that shows contacts, so a star or a rename shows everywhere at once.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { createContactsStore, type ContactRow, type ContactSource, type ContactsDb } from '@bsv/expo-wallet-toolbox/core/contacts/contactsStore'

const listeners = new Set<() => void>()
const changed = () => listeners.forEach(fn => fn())

export type Contact = ContactRow

export function useContacts() {
  const { storage: open, walletUserId, switchingProfile } = useWallet()
  // no reads while the core switches wallets: it closes this wallet's database under them
  const storage = switchingProfile ? null : open
  const db = storage?.sqliteDb as unknown as ContactsDb | undefined
  const store = useMemo(() => (db ? createContactsStore(db) : null), [db])
  const userId = typeof walletUserId === 'number' ? walletUserId : null
  const [list, setList] = useState<Contact[] | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const bump = () => setVersion(v => v + 1)
    listeners.add(bump)
    return () => {
      listeners.delete(bump)
    }
  }, [])

  useEffect(() => {
    let live = true
    if (!store || userId === null) {
      setList(store ? [] : null)
      return
    }
    store
      .listContacts(userId)
      .then(rows => live && setList(rows))
      .catch(() => live && setList([]))
    return () => {
      live = false
    }
  }, [store, userId, version])

  const byKey = useMemo(() => new Map((list ?? []).map(c => [c.identityKey.toLowerCase(), c])), [list])

  const run = useCallback(
    async (fn: (s: NonNullable<typeof store>, u: number) => Promise<unknown>) => {
      if (!store || userId === null) throw new Error('contacts: no wallet open')
      await fn(store, userId)
      changed()
    },
    [store, userId]
  )

  return {
    ready: !!store && userId !== null,
    list,
    byKey,
    /** a contact by identity key, including a removed one */
    get: useCallback(async (key: string) => (store && userId !== null ? store.getContact(userId, key) : undefined), [store, userId]),
    /** add someone, or put back someone taken out */
    add: useCallback(
      (c: { identityKey: string; name: string; cachedHandle?: string; source: ContactSource }) =>
        run(async (s, u) => {
          const had = await s.getContact(u, c.identityKey)
          if (had?.removedAt) await s.restoreContact(u, c.identityKey)
          else if (!had) await s.createContact({ userId: u, ...c })
        }),
      [run]
    ),
    rename: useCallback((key: string, name: string) => run((s, u) => s.renameContact(u, key, name)), [run]),
    setFavourite: useCallback((key: string, on: boolean) => run((s, u) => s.setFavourite(u, key, on)), [run]),
    remove: useCallback((key: string) => run((s, u) => s.removeContact(u, key)), [run]),
    restore: useCallback((key: string) => run((s, u) => s.restoreContact(u, key)), [run])
  }
}
