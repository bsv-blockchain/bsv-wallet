export type SqlBindResult = { omit: true } | { omit: false; value: unknown }

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
