import type { SQLiteDatabase } from 'expo-sqlite'
import type { BindValue } from '../methods/offlineActions'
import { COLOR_TRANSFERS_DDL, migrateMandalaToColor } from '../../mandala/transferJournal'

/**
 * SQL statements to create all wallet storage tables
 * Schema aligned with @bsv/wallet-toolbox-mobile Table type definitions
 */
export async function createTables(db: SQLiteDatabase): Promise<void> {
  // Users table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS users (
      userId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      identityKey TEXT NOT NULL UNIQUE,
      activeStorage TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_identityKey ON users(identityKey);
  `)

  // Proven transactions table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS proven_txs (
      provenTxId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      txid TEXT NOT NULL UNIQUE,
      height INTEGER NOT NULL,
      "index" INTEGER NOT NULL,
      merklePath BLOB NOT NULL,
      rawTx BLOB NOT NULL,
      blockHash TEXT NOT NULL,
      merkleRoot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_proven_txs_txid ON proven_txs(txid);
  `)

  // Proven transaction requests table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS proven_tx_reqs (
      provenTxReqId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      txid TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0,
      history TEXT,
      notify TEXT,
      rawTx BLOB,
      inputBEEF BLOB,
      batch TEXT,
      provenTxId INTEGER,
      wasBroadcast INTEGER NOT NULL DEFAULT 0,
      rebroadcastAttempts INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (provenTxId) REFERENCES proven_txs(provenTxId)
    );
    CREATE INDEX IF NOT EXISTS idx_proven_tx_reqs_txid ON proven_tx_reqs(txid);
    CREATE INDEX IF NOT EXISTS idx_proven_tx_reqs_status ON proven_tx_reqs(status);
    CREATE INDEX IF NOT EXISTS idx_proven_tx_reqs_batch ON proven_tx_reqs(batch);
    CREATE INDEX IF NOT EXISTS idx_proven_tx_reqs_provenTxId ON proven_tx_reqs(provenTxId);
  `)

  // Migration 2026-04-30-001: add wasBroadcast/rebroadcastAttempts to existing DBs.
  // SQLite has no IF NOT EXISTS for ADD COLUMN; rely on PRAGMA table_info.
  const cols = (await db.getAllAsync(`PRAGMA table_info(proven_tx_reqs)`)) as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  if (!names.has('wasBroadcast')) {
    await db.execAsync(`ALTER TABLE proven_tx_reqs ADD COLUMN wasBroadcast INTEGER NOT NULL DEFAULT 0`)
  }
  if (!names.has('rebroadcastAttempts')) {
    await db.execAsync(`ALTER TABLE proven_tx_reqs ADD COLUMN rebroadcastAttempts INTEGER NOT NULL DEFAULT 0`)
  }

  // Certificates table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS certificates (
      certificateId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      type TEXT NOT NULL,
      subject TEXT NOT NULL,
      serialNumber TEXT NOT NULL,
      certifier TEXT NOT NULL,
      verifier TEXT,
      revocationOutpoint TEXT NOT NULL,
      signature TEXT NOT NULL,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE INDEX IF NOT EXISTS idx_certificates_userId ON certificates(userId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_certificates_unique ON certificates(userId, type, certifier, serialNumber);
  `)

  // Certificate fields table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS certificate_fields (
      certificateId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      fieldName TEXT NOT NULL,
      fieldValue TEXT NOT NULL,
      masterKey TEXT NOT NULL,
      PRIMARY KEY (certificateId, fieldName),
      FOREIGN KEY (certificateId) REFERENCES certificates(certificateId),
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE INDEX IF NOT EXISTS idx_certificate_fields_userId ON certificate_fields(userId);
    CREATE INDEX IF NOT EXISTS idx_certificate_fields_certificateId ON certificate_fields(certificateId);
  `)

  // Output baskets table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS output_baskets (
      basketId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      name TEXT NOT NULL,
      numberOfDesiredUTXOs INTEGER NOT NULL DEFAULT 144,
      minimumDesiredUTXOValue INTEGER NOT NULL DEFAULT 32,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE INDEX IF NOT EXISTS idx_output_baskets_userId ON output_baskets(userId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_output_baskets_name_userId ON output_baskets(name, userId);
  `)

  // Transactions table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS transactions (
      transactionId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      status TEXT NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      isOutgoing INTEGER NOT NULL DEFAULT 0,
      satoshis INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      version INTEGER,
      lockTime INTEGER,
      txid TEXT,
      inputBEEF BLOB,
      rawTx BLOB,
      provenTxId INTEGER,
      FOREIGN KEY (userId) REFERENCES users(userId),
      FOREIGN KEY (provenTxId) REFERENCES proven_txs(provenTxId)
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_userId ON transactions(userId);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);
    CREATE INDEX IF NOT EXISTS idx_transactions_provenTxId ON transactions(provenTxId);
    CREATE INDEX IF NOT EXISTS idx_transactions_txid ON transactions(txid);
  `)

  // NEW-01: a device that created this table before this migration existed
  // keeps it; CREATE TABLE IF NOT EXISTS cannot add the column, so the guarded
  // ALTER does (ensureTransactionsColumns, defined below — hoisted). Called
  // here, inside createTables, rather than only from StorageExpoSQLite.migrate,
  // so every direct createTables() caller (this schema file's own tests
  // included) gets these columns too, exactly like ensureContactsColumns
  // below.
  await ensureTransactionsColumns(db)

  // Commissions table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS commissions (
      commissionId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      transactionId INTEGER NOT NULL UNIQUE,
      satoshis INTEGER NOT NULL,
      keyOffset TEXT,
      isRedeemed INTEGER NOT NULL DEFAULT 0,
      lockingScript BLOB,
      FOREIGN KEY (userId) REFERENCES users(userId),
      FOREIGN KEY (transactionId) REFERENCES transactions(transactionId)
    );
    CREATE INDEX IF NOT EXISTS idx_commissions_userId ON commissions(userId);
    CREATE INDEX IF NOT EXISTS idx_commissions_transactionId ON commissions(transactionId);
  `)

  // Outputs table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS outputs (
      outputId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      transactionId INTEGER NOT NULL,
      basketId INTEGER,
      spendable INTEGER NOT NULL DEFAULT 1,
      change INTEGER NOT NULL DEFAULT 0,
      outputDescription TEXT,
      vout INTEGER NOT NULL,
      satoshis INTEGER NOT NULL,
      providedBy TEXT NOT NULL,
      purpose TEXT,
      type TEXT,
      txid TEXT,
      senderIdentityKey TEXT,
      derivationPrefix TEXT,
      derivationSuffix TEXT,
      customInstructions TEXT,
      spentBy INTEGER,
      sequenceNumber INTEGER,
      spendingDescription TEXT,
      scriptLength INTEGER,
      scriptOffset INTEGER,
      lockingScript BLOB,
      FOREIGN KEY (userId) REFERENCES users(userId),
      FOREIGN KEY (transactionId) REFERENCES transactions(transactionId),
      FOREIGN KEY (basketId) REFERENCES output_baskets(basketId)
    );
    CREATE INDEX IF NOT EXISTS idx_outputs_userId ON outputs(userId);
    CREATE INDEX IF NOT EXISTS idx_outputs_transactionId ON outputs(transactionId);
    CREATE INDEX IF NOT EXISTS idx_outputs_basketId ON outputs(basketId);
    CREATE INDEX IF NOT EXISTS idx_outputs_spentBy ON outputs(spentBy);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outputs_unique ON outputs(transactionId, vout, userId);
  `)

  // Output tags table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS output_tags (
      outputTagId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      tag TEXT NOT NULL,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE INDEX IF NOT EXISTS idx_output_tags_userId ON output_tags(userId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_output_tags_tag_userId ON output_tags(tag, userId);
  `)

  // Output tags map table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS output_tags_map (
      outputTagId INTEGER NOT NULL,
      outputId INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (outputTagId, outputId),
      FOREIGN KEY (outputTagId) REFERENCES output_tags(outputTagId),
      FOREIGN KEY (outputId) REFERENCES outputs(outputId)
    );
    CREATE INDEX IF NOT EXISTS idx_output_tags_map_outputTagId ON output_tags_map(outputTagId);
    CREATE INDEX IF NOT EXISTS idx_output_tags_map_outputId ON output_tags_map(outputId);
  `)

  // Transaction labels table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS tx_labels (
      txLabelId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      label TEXT NOT NULL,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE INDEX IF NOT EXISTS idx_tx_labels_userId ON tx_labels(userId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_labels_label_userId ON tx_labels(label, userId);
  `)

  // Transaction labels map table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS tx_labels_map (
      txLabelId INTEGER NOT NULL,
      transactionId INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (txLabelId, transactionId),
      FOREIGN KEY (txLabelId) REFERENCES tx_labels(txLabelId),
      FOREIGN KEY (transactionId) REFERENCES transactions(transactionId)
    );
    CREATE INDEX IF NOT EXISTS idx_tx_labels_map_txLabelId ON tx_labels_map(txLabelId);
    CREATE INDEX IF NOT EXISTS idx_tx_labels_map_transactionId ON tx_labels_map(transactionId);
  `)

  // Monitor events table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS monitor_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      event TEXT NOT NULL,
      details TEXT
    );
  `)

  // Sync states table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS sync_states (
      syncStateId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      storageIdentityKey TEXT NOT NULL,
      storageName TEXT NOT NULL,
      status TEXT NOT NULL,
      init INTEGER NOT NULL DEFAULT 0,
      refNum TEXT NOT NULL UNIQUE,
      syncMap TEXT,
      "when" TEXT,
      satoshis INTEGER,
      errorLocal TEXT,
      errorOther TEXT,
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_states_userId ON sync_states(userId);
    CREATE INDEX IF NOT EXISTS idx_sync_states_status ON sync_states(status);
    CREATE INDEX IF NOT EXISTS idx_sync_states_refNum ON sync_states(refNum);
  `)

  // Settings table (singleton)
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS settings (
      storageIdentityKey TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      storageName TEXT NOT NULL,
      chain TEXT NOT NULL,
      dbtype TEXT NOT NULL,
      maxOutputScript INTEGER NOT NULL
    );
  `)

  // Key-value store for app-level state (e.g. SSE lastEventId)
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS key_value_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

  // Offline actions — the broadcast queue and provenance record for
  // transactions accepted with no network. The money itself lives in the normal
  // transactions/outputs tables the whole time (that is what keeps it
  // spendable); this table records what still needs sending, in what order it
  // arrived, and who handed it to us.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS offline_actions (
      offlineActionId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      txid TEXT NOT NULL UNIQUE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      senderIdentityKey TEXT,
      receivedVia TEXT,
      status TEXT NOT NULL,
      rejectedReason TEXT,
      poisonedByTxid TEXT,
      framePayload TEXT,
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE INDEX IF NOT EXISTS idx_offline_actions_status ON offline_actions(status);
    CREATE INDEX IF NOT EXISTS idx_offline_actions_userId ON offline_actions(userId);
    CREATE INDEX IF NOT EXISTS idx_offline_actions_seq ON offline_actions(seq);
    CREATE INDEX IF NOT EXISTS idx_offline_actions_txid ON offline_actions(txid);
  `)

  // Contacts — local, userId-scoped naming of counterparty identity keys.
  // `name` is the user's own label and is never overwritten by a background
  // refresh; `cachedHandle`/`cachedAvatarUrl`/`cachedCertifier` mirror what
  // resolveIdentity last saw and are read-only in the UI. @bsv/sdk's
  // ContactsManager and @bsv/mandala's contactsStore were rejected for v1:
  // each write there is a signed on-chain action.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS contacts (
      contactId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      identityKey TEXT NOT NULL,
      name TEXT NOT NULL,
      cachedHandle TEXT,
      cachedAvatarUrl TEXT,
      cachedCertifier TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_unique ON contacts(userId, identityKey);
    CREATE INDEX IF NOT EXISTS idx_contacts_userId ON contacts(userId);
  `)
  // Favourites and soft remove (Bitcoin SV Wallet, decision 10): additive,
  // with defaults, so an existing row reads back not-favourite and present.
  await ensureContactsColumns(db)

  // 1Color: the one-time, marker-guarded drop of the four Mandala settlement
  // tables and the old lib's KV journals, then the `color_transfers` journal.
  // Runs on every boot before the runtime or `@bsv/mandala` exist, so no new
  // lib journal can be written before the wipe and none is wiped after it.
  // The table is created again unconditionally, so a re-run is harmless.
  await migrateMandalaToColor(db)
  await db.execAsync(COLOR_TRANSFERS_DDL)
}

/**
 * Post-ship column additions to offline_actions. CREATE TABLE IF NOT EXISTS
 * cannot alter an existing table, so upgrades go through a PRAGMA check + a
 * guarded ALTER. Add future columns to the COLUMNS list; never remove or
 * retype one here — SQLite ALTER cannot do either, and this table is live
 * money bookkeeping on shipped devices.
 */
const OFFLINE_ACTIONS_COLUMNS: { name: string; ddl: string }[] = [
  { name: 'framePayload', ddl: 'ALTER TABLE offline_actions ADD COLUMN framePayload TEXT' }
]

export async function ensureOfflineActionsColumns(db: {
  getAllAsync(sql: string, params: BindValue[]): Promise<unknown[]>
  execAsync(sql: string): Promise<unknown>
}): Promise<void> {
  const info = (await db.getAllAsync('PRAGMA table_info(offline_actions)', [])) as { name: string }[]
  const have = new Set(info.map(c => c.name))
  for (const col of OFFLINE_ACTIONS_COLUMNS) {
    if (!have.has(col.name)) await db.execAsync(col.ddl)
  }
}

/**
 * NEW-01: `@bsv/wallet-toolbox-mobile`'s BRC-177 `noSendExpiry` lifecycle
 * (early-reclaim actions, `armNoSendExpiry`, `abortAction`,
 * `updateTransactionStatus`) reads and writes these `transactions` columns
 * unconditionally — not only when a BRC-177 action is actually used.
 * `protectNoSendExpiryReclaimInputOnFailure`, the guard every 'failed'
 * transition runs through, filters on `noSendExpiryReclaimTxid`: without this
 * column that WHERE clause throws "no such column", not "no match", so NO
 * failed-transition of a transaction with a txid can complete — `abortAction`
 * of any signed action, a failed broadcast, a proof-check timeout, and
 * `reviewStatus`'s own `failInvalidReqTxs` sweep all reach it. This app never
 * creates a BRC-177 protected action itself (`supportsNoSendExpiryPersistence`
 * is not overridden and defaults to `false`, so `armNoSendExpiry` always
 * throws `WERR_NOT_IMPLEMENTED`), but the vendor's generic failure path does
 * not gate on that — every row still needs these columns to exist, forever
 * NULL in practice here.
 *
 * Types and names taken from `TableTransaction` in
 * `@bsv/wallet-toolbox-mobile`'s `out/index.mobile.d.cts`. All nullable, no
 * defaults: an existing row reads back every one of these as `undefined`,
 * which is exactly what "this transaction never touched BRC-177" already
 * means to every caller.
 */
const TRANSACTIONS_COLUMNS: { name: string; ddl: string }[] = [
  { name: 'noSendExpiryMode', ddl: 'ALTER TABLE transactions ADD COLUMN noSendExpiryMode TEXT' },
  { name: 'noSendExpiryValue', ddl: 'ALTER TABLE transactions ADD COLUMN noSendExpiryValue INTEGER' },
  { name: 'noSendExpiryDeadline', ddl: 'ALTER TABLE transactions ADD COLUMN noSendExpiryDeadline INTEGER' },
  { name: 'noSendExpiryState', ddl: 'ALTER TABLE transactions ADD COLUMN noSendExpiryState TEXT' },
  { name: 'noSendExpiryAnchorTxid', ddl: 'ALTER TABLE transactions ADD COLUMN noSendExpiryAnchorTxid TEXT' },
  { name: 'noSendExpiryAnchorVout', ddl: 'ALTER TABLE transactions ADD COLUMN noSendExpiryAnchorVout INTEGER' },
  { name: 'noSendExpiryReleasedAt', ddl: 'ALTER TABLE transactions ADD COLUMN noSendExpiryReleasedAt INTEGER' },
  { name: 'noSendExpiryObservedAt', ddl: 'ALTER TABLE transactions ADD COLUMN noSendExpiryObservedAt INTEGER' },
  { name: 'noSendExpiryReclaimTxid', ddl: 'ALTER TABLE transactions ADD COLUMN noSendExpiryReclaimTxid TEXT' },
  { name: 'noSendExpiryReclaimRawTx', ddl: 'ALTER TABLE transactions ADD COLUMN noSendExpiryReclaimRawTx BLOB' },
  {
    name: 'noSendExpiryReclaimDerivationPrefix',
    ddl: 'ALTER TABLE transactions ADD COLUMN noSendExpiryReclaimDerivationPrefix TEXT'
  },
  {
    name: 'noSendExpiryReclaimDerivationSuffix',
    ddl: 'ALTER TABLE transactions ADD COLUMN noSendExpiryReclaimDerivationSuffix TEXT'
  },
  {
    name: 'noSendExpiryReclaimSatoshis',
    ddl: 'ALTER TABLE transactions ADD COLUMN noSendExpiryReclaimSatoshis INTEGER'
  }
]

/**
 * The same doctrine for `contacts`: columns added after it shipped, each
 * with a default that means "as before" (not a favourite, not removed), so
 * the existing app, which never sets them, sees its address book unchanged.
 */
const CONTACTS_COLUMNS: { name: string; ddl: string }[] = [
  { name: 'favourite', ddl: 'ALTER TABLE contacts ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0' },
  { name: 'removedAt', ddl: 'ALTER TABLE contacts ADD COLUMN removedAt TEXT' }
]

export async function ensureContactsColumns(db: {
  getAllAsync(sql: string, params: BindValue[]): Promise<unknown[]>
  execAsync(sql: string): Promise<unknown>
}): Promise<void> {
  const info = (await db.getAllAsync('PRAGMA table_info(contacts)', [])) as { name: string }[]
  const have = new Set(info.map(c => c.name))
  for (const col of CONTACTS_COLUMNS) {
    if (!have.has(col.name)) await db.execAsync(col.ddl)
  }
}

export async function ensureTransactionsColumns(db: {
  getAllAsync(sql: string, params: BindValue[]): Promise<unknown[]>
  execAsync(sql: string): Promise<unknown>
}): Promise<void> {
  const info = (await db.getAllAsync('PRAGMA table_info(transactions)', [])) as { name: string }[]
  const have = new Set(info.map(c => c.name))
  for (const col of TRANSACTIONS_COLUMNS) {
    if (!have.has(col.name)) await db.execAsync(col.ddl)
  }
}
