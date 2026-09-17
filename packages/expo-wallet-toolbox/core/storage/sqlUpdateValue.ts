import { BLOB_COLUMNS } from './methods/findSql'

export type SqlBindResult = { omit: true } | { omit: false; value: unknown }

/** Every column the schema declares BLOB, by name; no two tables disagree about one. */
export const BYTE_COLUMNS: ReadonlySet<string> = new Set(Object.values(BLOB_COLUMNS).flat())

/**
 * The bind for a byte column: bytes, or nothing.
 *
 * expo-sqlite binds only a `Uint8Array` as a BLOB. Anything else reaches the
 * native layer as a primitive, which Android stringifies into TEXT and iOS
 * refuses — how a JSON-rehydrated payload (an index-keyed object) became an
 * unreadable `token_linkage_payloads` row on 2026-09-16. Refused here, while
 * the column is still named, rather than stored in the wrong storage class.
 */
export function bytesForColumn(column: string, value: unknown): Uint8Array | undefined {
  if (value === undefined || value === null) return undefined
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value) && value.every(b => Number.isInteger(b))) return Uint8Array.from(value as number[])
  throw new Error(
    `${column} must be bytes (Uint8Array or number[]), got ${Array.isArray(value) ? 'a non-integer array' : typeof value}`
  )
}

/** Map an update field to a SQL bind, or omit it from the SET clause. */
export function sqlBindValue(table: string, column: string, value: unknown): SqlBindResult {
  if (value === undefined) {
    if (table === 'outputs' && column === 'spentBy') {
      return { omit: false, value: null }
    }
    return { omit: true }
  }
  return { omit: false, value }
}
