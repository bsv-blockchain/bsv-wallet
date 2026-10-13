// Handles as the prototype writes and finds them (its lib/handles.ts). A
// contact's handle is stored as a paymail, "rosa@bitcoinsv.com"; it's shown
// as "@rosa" when it's in this wallet's own handle space (where a bare @rosa
// means them), and with its wallet's domain otherwise ("@rosa@handcash"), so
// two Rosas are never mistaken for each other. A search finds them by any
// form, with or without the @. Pure, so it can be tested anywhere.
import { ecosystemOf } from './ecosystems'

/** This app's own handle domain in production; a build's registry domain counts too. */
export const HOME_DOMAIN = 'bitcoinsv.com'

/** "rosa" from "@rosa", "rosa@bitcoinsv.com" or "@rosa@bitcoinsv.com". */
export const bareHandle = (handle: string) => handle.trim().replace(/^@/, '').split('@')[0] ?? ''

/** "bitcoinsv.com" from "rosa@bitcoinsv.com"; null for a bare handle. */
export function domainOf(handle: string): string | null {
  const parts = handle.trim().replace(/^@/, '').split('@')
  return parts.length > 1 && parts[1] ? parts[1].toLowerCase() : null
}

/** The domains whose handles are this wallet's own: production's, and the build's registry. */
export const ownDomains = (registryDomain?: string | null) => [HOME_DOMAIN, ...(registryDomain ? [registryDomain.toLowerCase()] : [])]

/** In this wallet's own handle space: no domain, or one of its own. */
export function isOwnSpace(handle: string, own: string[]): boolean {
  const d = domainOf(handle)
  return d === null || own.includes(d)
}

/**
 * The short form of another wallet's domain: its alias for a wallet we know
 * ("handcash" for handcash.io), the domain itself for one we don't.
 */
export const shortDomain = (domain: string) => ecosystemOf(domain)?.alias ?? domain

/**
 * The handle as text: "@rosa" in this wallet's own space, "@rosa@handcash"
 * elsewhere ("@rosa@handcash.io" when `qualified`).
 */
export function handleLabel(handle: string, own: string[], { qualified = false }: { qualified?: boolean } = {}): string {
  const bare = bareHandle(handle)
  if (isOwnSpace(handle, own)) return `@${bare}`
  const d = domainOf(handle) as string
  return `@${bare}@${qualified ? d : shortDomain(d)}`
}

/** A handle ("@rosa", "rosa@bitcoinsv.com"), not some other line of detail. */
export const isHandle = (text: string) => /^@[^\s@]+(@[^\s@]+\.[^\s@]+)?$|^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim())

/** A line of detail with any handle in it written as handles are. */
export const detailLabel = (text: string, own: string[]) => (isHandle(text) ? handleLabel(text, own) : text)

/** Every form a search should find a handle by. */
export function handleForms(handle: string): string[] {
  const bare = bareHandle(handle).toLowerCase()
  const d = domainOf(handle)
  return d ? [bare, `${bare}@${d}`, `${bare}@${shortDomain(d)}`] : [bare]
}

/** Does someone match a search: their name, or their handle in any form, "@" or not. */
export function matchesSearch(person: { name: string; handle?: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (person.name.toLowerCase().includes(q)) return true
  if (!person.handle) return false
  const needle = q.replace(/^@/, '')
  return !!needle && handleForms(person.handle).some(form => form.includes(needle))
}
