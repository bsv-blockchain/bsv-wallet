/**
 * Point lookups the external-wallet guard (core/services/vault/guard.ts) runs
 * before it lets a connected app name an existing output or release a held
 * transaction.
 *
 * Each query touches only the rows the caller named, reads basket names,
 * labels and tags, and stops at the first hit. None of them select a locking script,
 * so a Vault output's ~45 KB R1C script never leaves the database.
 *
 * No `userId` filter: a StorageExpoSQLite file belongs to one identity. If a
 * file ever held more than one user, a hit on another user's row would refuse
 * the call, which is the safe direction.
 */

/** BRC-100 reserves every basket and label that starts with this for the
 * wallet itself (WalletPermissionsManager's `isAdminBasket`/`isAdminLabel`). */
export const ADMIN_PREFIX = 'admin'

/** The label every Vault deposit, withdrawal and re-lock carries. */
export const VAULT_ACTION_LABEL = 'vault'

/** The tag every Vault output carries, from a deposit, re-lock or chain
 * recovery alike. Chain recovery internalizes without a `vault` label. */
export const VAULT_OUTPUT_TAG = 'vault'

/**
 * WalletPermissionsManager appends `admin originator <originator>` and
 * `admin month YYYY-MM` to every action it creates, the admin's included, and
 * sums them per site for monthly spending authorization. They are admin labels
 * a site cannot set, but they mark whose action it is, not Vault or admin
 * state. Counting them made every unbasketed output of a site's own action
 * admin state to that same site, which refused internalizing a payment it had
 * just funded and `sendWith` of its own no-send actions.
 *
 * So the admin-state rule ignores every month label and the caller's own
 * originator label. Another originator's label, the admin's included, still
 * counts.
 */
export const ORIGINATOR_LABEL_PREFIX = 'admin originator '
export const MONTH_LABEL_PREFIX = 'admin month '

/** The originator label WalletPermissionsManager writes for `originator`, as
 * storage keeps it (the SDK's label validation trims and lowercases). */
export function originatorLabel(originator: string): string {
  return `${ORIGINATOR_LABEL_PREFIX}${originator}`.trim().toLowerCase()
}

/**
 * The caller's own originator label for the admin-state rule to ignore, or
 * null to ignore none: no originator, no known admin originator, or a caller
 * whose label is the admin's (`Admin.example` stores the same label as
 * `admin.example`).
 */
export function ownOriginatorLabel(originator: unknown, adminOriginator: string | undefined): string | null {
  if (typeof originator !== 'string' || originator.trim() === '') return null
  if (typeof adminOriginator !== 'string' || adminOriginator.trim() === '') return null
  const own = originatorLabel(originator)
  return own === originatorLabel(adminOriginator) ? null : own
}

/** Placeholders per statement, kept under the lowest SQLITE_MAX_VARIABLE_NUMBER
 * a shipped SQLite still enforces (999). */
const MAX_BOUND_VARIABLES = 998

const IS_ADMIN_BASKET = `substr("b"."name", 1, ${ADMIN_PREFIX.length}) = '${ADMIN_PREFIX}'`

/** The transaction whose id is `transactionIdSql` carries the `vault` label or
 * an `admin*` label other than a month label or the caller's own originator
 * label. Takes one bound parameter: that label, or NULL to ignore none. */
function hasAdminLabel(transactionIdSql: string): string {
  return (
    'EXISTS (SELECT 1 FROM "tx_labels_map" "m" JOIN "tx_labels" "l" ON "l"."txLabelId" = "m"."txLabelId" ' +
    `WHERE "m"."transactionId" = ${transactionIdSql} AND ("l"."label" = '${VAULT_ACTION_LABEL}' ` +
    `OR (substr("l"."label", 1, ${ADMIN_PREFIX.length}) = '${ADMIN_PREFIX}' ` +
    `AND substr("l"."label", 1, ${MONTH_LABEL_PREFIX.length}) <> '${MONTH_LABEL_PREFIX}' ` +
    'AND "l"."label" IS NOT ?)))'
  )
}

/** The output `o` carries the Vault output tag. */
const HAS_VAULT_TAG =
  'EXISTS (SELECT 1 FROM "output_tags_map" "tm" JOIN "output_tags" "tg" ON "tg"."outputTagId" = "tm"."outputTagId" ' +
  `WHERE "tm"."outputId" = "o"."outputId" AND "tg"."tag" = '${VAULT_OUTPUT_TAG}')`

/**
 * An output row `o` (with its basket LEFT JOINed as `b`) is admin state when it
 * sits in an `admin`-prefixed basket, or when it has no basket (relinquished,
 * e.g. by "forget unreachable deposits") and is still recognisably a Vault or
 * admin output: tagged `vault`, or created by a transaction labelled `vault` or
 * with an admin label that is not a month label or the caller's own
 * originator label (see ORIGINATOR_LABEL_PREFIX). The label and tag count only
 * for an unbasketed row, so an app's own basketed outputs never collide with
 * them. Takes one bound parameter, the caller's own originator label or NULL.
 *
 * `default` is deliberately not included: an app retrying internalizeAction
 * for a payment the wallet already holds as change names a `default` output,
 * and the toolbox treats that retry as a no-op.
 */
const IS_ADMIN_OUTPUT =
  `((${IS_ADMIN_BASKET}) OR ` +
  `("o"."basketId" IS NULL AND (${HAS_VAULT_TAG} OR ${hasAdminLabel('"o"."transactionId"')})))`

const OUTPUT_WITH_BASKET = 'FROM "outputs" "o" LEFT JOIN "output_baskets" "b" ON "b"."basketId" = "o"."basketId" '

/**
 * Hit when any named outpoint is admin state (see IS_ADMIN_OUTPUT). Bound as
 * each `txid`, `vout` pair, then the caller's own originator label.
 *
 * One OR-group per outpoint rather than a row-value IN, so the query works on
 * any SQLite build (same shape as `spendingReferencesSql`).
 */
export function adminOutpointsSql(pairCount: number): string {
  const groups = Array.from({ length: pairCount }, () => '("o"."txid" = ? AND "o"."vout" = ?)').join(' OR ')
  return `SELECT 1 AS hit ${OUTPUT_WITH_BASKET}WHERE (${groups}) AND ${IS_ADMIN_OUTPUT} LIMIT 1`
}

/** Hit when the output with this `outputId` is admin state. Bound as the
 * `outputId`, then the caller's own originator label. */
export const ADMIN_OUTPUT_BY_ID_SQL = `SELECT 1 AS hit ${OUTPUT_WITH_BASKET}WHERE "o"."outputId" = ? AND ${IS_ADMIN_OUTPUT} LIMIT 1`

/**
 * Hit when any named txid is a Vault or admin transaction: labelled `vault`,
 * carrying an admin label other than a month label or the caller's own
 * originator label, or creating or spending an output in an admin-prefixed
 * basket. Bound as each txid, then the caller's own originator label.
 *
 * Spending is matched through `outputs.spentBy`, which the toolbox sets when
 * an action reserves its inputs, so a signed-but-held withdrawal is caught
 * before it is broadcast.
 */
export function adminTransactionsSql(txidCount: number): string {
  const placeholders = Array.from({ length: txidCount }, () => '?').join(', ')
  return (
    'SELECT 1 AS hit FROM "transactions" "t" ' +
    `WHERE "t"."txid" IN (${placeholders}) AND (` +
    `${hasAdminLabel('"t"."transactionId"')} ` +
    'OR EXISTS (SELECT 1 FROM "outputs" "o" JOIN "output_baskets" "b" ON "b"."basketId" = "o"."basketId" ' +
    `WHERE "o"."transactionId" = "t"."transactionId" AND ${IS_ADMIN_BASKET}) ` +
    'OR EXISTS (SELECT 1 FROM "outputs" "o" JOIN "output_baskets" "b" ON "b"."basketId" = "o"."basketId" ' +
    `WHERE "o"."spentBy" = "t"."transactionId" AND ${IS_ADMIN_BASKET})` +
    ') LIMIT 1'
  )
}

/** The slice of an expo-sqlite handle these lookups use. */
export interface GuardSqlDb {
  getFirstAsync(sql: string, params: (string | number | null)[]): Promise<unknown>
}

/**
 * `txid.vout` pairs, as the guard canonicalizes them (lowercase txid).
 * `ownLabel` is the caller's own originator label (see ownOriginatorLabel),
 * or null to treat every originator label as admin state.
 */
export async function anyAdminOutpoint(
  db: GuardSqlDb,
  outpoints: string[],
  ownLabel: string | null = null
): Promise<boolean> {
  const pairs = outpoints.map(outpoint => {
    const dot = outpoint.lastIndexOf('.')
    const txid = outpoint.slice(0, dot).toLowerCase()
    const vout = Number(outpoint.slice(dot + 1))
    if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0) {
      throw new Error(`Invalid outpoint ${outpoint}`)
    }
    return [txid, vout] as const
  })
  // One placeholder is the label.
  const perStatement = Math.floor((MAX_BOUND_VARIABLES - 1) / 2)
  for (let i = 0; i < pairs.length; i += perStatement) {
    const chunk = pairs.slice(i, i + perStatement)
    if (await db.getFirstAsync(adminOutpointsSql(chunk.length), [...chunk.flat(), ownLabel])) return true
  }
  return false
}

export async function anyAdminTransaction(
  db: GuardSqlDb,
  txids: string[],
  ownLabel: string | null = null
): Promise<boolean> {
  const normalized = txids.map(txid => {
    const lower = txid.toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(lower)) throw new Error(`Invalid txid ${txid}`)
    return lower
  })
  // One placeholder is the label.
  const perStatement = MAX_BOUND_VARIABLES - 1
  for (let i = 0; i < normalized.length; i += perStatement) {
    const chunk = normalized.slice(i, i + perStatement)
    if (await db.getFirstAsync(adminTransactionsSql(chunk.length), [...chunk, ownLabel])) return true
  }
  return false
}

export async function isAdminOutput(
  db: GuardSqlDb,
  outputId: number,
  ownLabel: string | null = null
): Promise<boolean> {
  return !!(await db.getFirstAsync(ADMIN_OUTPUT_BY_ID_SQL, [outputId, ownLabel]))
}
