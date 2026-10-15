import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { emptyState, type Store, type State } from './controller'
export function fileStore(path: string): Store {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as State
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
        throw e
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true })
      // The controller serializes all writes. fsync before atomic replacement.
      const { open } = await import('node:fs/promises')
      const file = await open(path + '.tmp', 'w', 0o600)
      try {
        await file.writeFile(JSON.stringify(state))
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(path + '.tmp', path)
      const dir = await open(dirname(path), 'r')
      try {
        await dir.sync()
      } finally {
        await dir.close()
      }
    }
  }
}
