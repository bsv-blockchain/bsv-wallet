// Page-world script (the manifest's second content entry, "world": "MAIN"). It carries no authority.
import { createProviderMain } from './lib/providerMain'

createProviderMain(window as unknown as Parameters<typeof createProviderMain>[0])
