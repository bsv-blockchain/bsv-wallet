// What to ask the handle registry for (decision 8): a bare "@name" or
// "name" means name on this build's handle domain, "@name@domain" drops its
// leading "@", anything shorter than a handle asks nothing.

export function registryQuery(input: string, domain?: string | null): string | null {
  const raw = input.trim().toLowerCase().replace(/^@/, '')
  if (!raw) return null
  if (raw.includes('@')) return raw
  if (!domain) return raw
  return `${raw}@${domain}`
}
