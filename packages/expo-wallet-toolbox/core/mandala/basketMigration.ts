/**
 * One-time migration: rename the Mandala token basket from the old,
 * un-gated `'mandala-tokens'` to the P-routed `MANDALA_BASKET`
 * (`'p mandala'`), per offline-settlement-final.md §8.3.
 *
 * The basket name is persisted per-output (`outputs.basketId` ->
 * `output_baskets.name`), so renaming the constant in code does nothing for
 * a device that already holds tokens under the old name — this migration
 * moves those rows. Guarded by a `key_value_store` marker (the app's
 * existing one-time-migration doctrine, see `ensureOfflineActionsColumns`
 * for the DDL-migration precedent this mirrors for a data migration):
 *
 *  - idempotent: once the marker is set, the full (every-user) scan is a
 *    no-op read.
 *  - a no-op when zero rows carry the old basket name (marks done, moves
 *    nothing).
 *  - running it twice never double-moves: the marker short-circuits the
 *    second full scan entirely, and even without the marker a second pass
 *    would find zero outputs left under the old basket id (the UPDATE's own
 *    WHERE clause naturally re-converges).
 *
 * "No live builds exist" today (design-v3's Compatibility section), so this
 * has zero live rows to move at ship time — it exists so a later device that
 * *does* hold old-named rows is never left behind.
 *
 * Adversarial-review finding (6): the marker alone is not enough. It marks
 * "the full, every-user scan has run on this device", but a BACKUP RESTORE
 * can reintroduce old-named rows for the device's CURRENT user well after
 * that scan already ran and set the marker (e.g. restoring an older
 * snapshot, or a snapshot from before this rename shipped) — the early
 * return on a set marker would then skip that user's rows forever. Callers
 * that know the current user id should therefore also pass it as
 * `currentUserId`: a cheap, single-user WHERE-based move runs EVERY call
 * regardless of the marker, bounded to just that user's old-basket rows (not
 * a full-table scan), so it is safe to call on every boot. Passing no
 * `currentUserId` reproduces the exact pre-finding-6 behavior (full scan,
 * marker-guarded, nothing else) — every existing caller/test is unaffected.
 */
import { MANDALA_BASKET } from './types'

/** Old, un-gated basket name this migration moves outputs off of. */
export const OLD_MANDALA_BASKET_NAME = 'mandala-tokens'

/** key_value_store marker key — presence with value 'done' means "never run again". */
const MIGRATION_MARKER_KEY = 'mandala_basket_migration_v1'
const MIGRATION_DONE_VALUE = 'done'

/** The slice of TableOutputBasket this migration reads. */
export interface MigrationOutputBasket {
  basketId: number
  userId: number
  isDeleted?: boolean
}

/** The slice of TableOutput this migration reads. */
export interface MigrationOutput {
  outputId: number
}

/**
 * The slice of `StorageExpoSQLite` this migration needs. Structural, so the
 * real provider and a lightweight test double both satisfy it — same pattern
 * as `core/storage/methods/walletBalanceSql.ts`'s `BalanceStorage`.
 */
export interface BasketMigrationStorage {
  getKeyValue(key: string): Promise<string | undefined>
  setKeyValue(key: string, value: string): Promise<void>
  findOutputBaskets(args: { partial: { name: string; userId?: number } }): Promise<MigrationOutputBasket[]>
  /** Finds-or-creates (and un-deletes) the destination basket for one user. */
  findOrInsertOutputBasket(userId: number, name: string): Promise<{ basketId: number }>
  findOutputs(args: { partial: { basketId: number } }): Promise<MigrationOutput[]>
  updateOutput(id: number, update: { basketId: number }): Promise<number>
}

export interface BasketMigrationResult {
  /** false when the full scan's marker already showed it had run AND the
   * (optional) single-user pass moved nothing — i.e. nothing was touched. */
  ran: boolean
  /** Baskets (i.e. distinct userIds) that had at least one output moved. */
  basketsMigrated: number
  /** Total output rows moved from the old basket to MANDALA_BASKET. */
  movedOutputs: number
}

/**
 * Moves every output out of one old-named basket into (a find-or-inserted)
 * `MANDALA_BASKET` for that basket's owner. Shared by both the full,
 * every-user scan and the cheap, single-user pass below — the only
 * difference between them is which old baskets they are given to move.
 */
async function moveBasketOutputs(
  storage: BasketMigrationStorage,
  oldBasket: MigrationOutputBasket
): Promise<{ movedOutputs: number }> {
  if (oldBasket.isDeleted) return { movedOutputs: 0 }

  const outputs = await storage.findOutputs({ partial: { basketId: oldBasket.basketId } })
  if (outputs.length === 0) return { movedOutputs: 0 }

  const newBasket = await storage.findOrInsertOutputBasket(oldBasket.userId, MANDALA_BASKET)
  for (const output of outputs) {
    await storage.updateOutput(output.outputId, { basketId: newBasket.basketId })
  }

  return { movedOutputs: outputs.length }
}

/**
 * Runs the migration. Safe to call on every boot — see the idempotency notes
 * above.
 *
 * `currentUserId`, when given, additionally runs the cheap single-user pass
 * (finding 6) on EVERY call, independent of the marker — pass the device's
 * currently-authenticated user id here so a restored backup's old-named rows
 * for that user are always caught, not just on the one device/boot where the
 * full scan happened to run. Omit it to get exactly the original,
 * marker-only behavior.
 */
export async function migrateMandalaBasketName(
  storage: BasketMigrationStorage,
  currentUserId?: number
): Promise<BasketMigrationResult> {
  const marker = await storage.getKeyValue(MIGRATION_MARKER_KEY)
  const fullScanAlreadyRan = marker === MIGRATION_DONE_VALUE

  let basketsMigrated = 0
  let movedOutputs = 0

  if (!fullScanAlreadyRan) {
    const oldBaskets = await storage.findOutputBaskets({ partial: { name: OLD_MANDALA_BASKET_NAME } })
    for (const oldBasket of oldBaskets) {
      const moved = await moveBasketOutputs(storage, oldBasket)
      if (moved.movedOutputs > 0) {
        basketsMigrated += 1
        movedOutputs += moved.movedOutputs
      }
    }

    // Marked done even when zero rows moved: the point of the marker is
    // "never run the FULL scan again on this device", not "ran and found
    // work" — see the no-op contract in the file doc above. The cheap
    // single-user pass below is unaffected by this marker either way.
    await storage.setKeyValue(MIGRATION_MARKER_KEY, MIGRATION_DONE_VALUE)
  }

  if (typeof currentUserId === 'number') {
    // Cheap, single-user WHERE-based move — bounded to this one user's
    // old-basket rows (never a full-table scan), so it is safe to run every
    // boot regardless of the marker above. If the full scan above already
    // covered this same user in this same call, this finds zero rows left
    // and is a harmless no-op (the same re-convergence property the file
    // doc describes for a marker-less rerun).
    const oldBaskets = await storage.findOutputBaskets({
      partial: { name: OLD_MANDALA_BASKET_NAME, userId: currentUserId }
    })
    for (const oldBasket of oldBaskets) {
      const moved = await moveBasketOutputs(storage, oldBasket)
      if (moved.movedOutputs > 0) {
        basketsMigrated += 1
        movedOutputs += moved.movedOutputs
      }
    }
  }

  return { ran: !fullScanAlreadyRan || movedOutputs > 0, basketsMigrated, movedOutputs }
}
