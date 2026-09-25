import type { SQLiteDatabase } from 'expo-sqlite'
import type { BindValue } from '../methods/offlineActions'
import { devLog } from '../../logging'

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

  await createMandalaSettlementTables(db)
}

/**
 * The four Mandala settlement tables (offline-settlement spec §4.1).
 *
 * Additive only: nothing in `offline_actions`, `proven_tx_reqs` or the
 * toolbox's own schema changes shape. `CREATE TABLE IF NOT EXISTS` is the whole
 * migration — a device upgrading into this feature gets the tables empty on its
 * next boot, and every row in them is re-derivable from frame bytes that are
 * already durable elsewhere (FIX G), so there is nothing to backfill.
 *
 * Split into its own exported function so the settlement store's tests can
 * stand the schema up without the rest of the wallet, and so a future migration
 * runner has one named unit to call.
 */
export async function createMandalaSettlementTables(
  db: Pick<SQLiteDatabase, 'execAsync' | 'getAllAsync'>
): Promise<void> {
  // One row per token transaction this wallet has ever built, received, or
  // forwarded evidence for — THE single owner of "what state is this token
  // payment in" (spec §5). The `state` CHECK is deliberately the whole state
  // machine: a state this file does not list is a bug that must fail at the
  // write, not survive as an unreachable row nothing drains.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS token_settlements (
      txid                  TEXT PRIMARY KEY,
      role                  TEXT NOT NULL CHECK (role IN ('sent','received')),
      assetId               TEXT NOT NULL,
      state                 TEXT NOT NULL CHECK (state IN (
                              'built','parked','handed_over','held',
                              'submitting','admitted','broadcast','refused','orphaned')),
      counterpartyKey       TEXT,
      amountBaseUnits       INTEGER,
      overlayUrl            TEXT NOT NULL,
      overlayIdentityKey    TEXT NOT NULL,
      admissionOutputsJson  TEXT,
      admissionSignatureHex TEXT,
      relevantVout          INTEGER,
      refusedCode           TEXT,
      refusedPayloadHash    TEXT,
      poisonedByTxid        TEXT,
      reference             TEXT,
      createdAt             TEXT NOT NULL,
      updatedAt             TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_settlements_state ON token_settlements(state);
    CREATE INDEX IF NOT EXISTS idx_token_settlements_role ON token_settlements(role);
    CREATE INDEX IF NOT EXISTS idx_token_settlements_createdAt ON token_settlements(createdAt);
  `)

  // A device that created these tables before `reference` existed keeps them;
  // CREATE TABLE IF NOT EXISTS cannot add the column, so the guarded ALTER does.
  await ensureTokenSettlementColumns(db)
  await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_token_settlements_reference ON token_settlements(reference);`)
  // Drives a contact's activity pane (core/contacts/contactActivity.ts):
  // every token transfer with this counterparty, in one indexed lookup.
  await db.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_token_settlements_counterpartyKey ON token_settlements(counterpartyKey);`
  )

  // Cached mirror of the AdmissionEntry values this device has SEEN. Purely a
  // derivable cache (FIX G) — never a precondition for anything.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS token_admissions (
      txid               TEXT PRIMARY KEY,
      outputsToAdmitJson TEXT NOT NULL,
      signatureHex       TEXT NOT NULL,
      signerKey          TEXT NOT NULL,
      source             TEXT NOT NULL CHECK (source IN ('minted','bundle','submitted','fetched')),
      obtainedAt         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_admissions_signerKey ON token_admissions(signerKey);
  `)

  // Edge index for the recursive COVER walk, so coverage is a local SQL query
  // rather than a re-parse of a whole BEEF on every pass. Token inputs only
  // (FIX K): a plain BSV change input funding the fee is not a token ancestor.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS token_admission_edges (
      childTxid  TEXT NOT NULL,
      parentTxid TEXT NOT NULL,
      parentVout INTEGER NOT NULL,
      PRIMARY KEY (childTxid, parentTxid, parentVout)
    );
    CREATE INDEX IF NOT EXISTS idx_token_admission_edges_child ON token_admission_edges(childTxid);
    CREATE INDEX IF NOT EXISTS idx_token_admission_edges_parent ON token_admission_edges(parentTxid);
  `)

  // Off-chain linkage payloads for UNADMITTED chain transactions: the exact
  // bytes a downstream submitter needs to build the /submit body for a txid
  // nobody has σ_I for yet. Carried verbatim hop by hop — this device can never
  // decrypt one, only forward it.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS token_linkage_payloads (
      txid               TEXT PRIMARY KEY,
      payloadBytes       BLOB NOT NULL,
      overlayUrl         TEXT NOT NULL,
      overlayIdentityKey TEXT NOT NULL,
      source             TEXT NOT NULL CHECK (source IN ('minted','forwarded')),
      createdAt          TEXT NOT NULL
    );
  `)
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
 * The same doctrine for `token_settlements`, which shipped before it had a
 * `reference` column and cannot be re-created over live rows.
 *
 * A nullable column with no default: every existing row reads back
 * `reference === undefined`, which the abort guard treats as "unknown
 * reference" and therefore never blocks on. The wallet re-derives these rows
 * every drain tick (FIX G) but only from frame bytes, which do not carry a
 * wallet action reference — so the backfill is simply the next hand-over.
 */
const TOKEN_SETTLEMENT_COLUMNS: { name: string; ddl: string }[] = [
  { name: 'reference', ddl: 'ALTER TABLE token_settlements ADD COLUMN reference TEXT' },
  // XR-038: the wallet-relevant output index, so a cached admission for some
  // OTHER output of the same txid can never stand in for this one. Nullable,
  // no default — an existing row reads back `relevantVout === undefined`,
  // which `postTokenStep` reads as 0 (the payee's-output convention), exactly
  // as it always has for every row written before this column existed.
  { name: 'relevantVout', ddl: 'ALTER TABLE token_settlements ADD COLUMN relevantVout INTEGER' }
]

export async function ensureTokenSettlementColumns(db: {
  getAllAsync(sql: string, params: BindValue[]): Promise<unknown[]>
  execAsync(sql: string): Promise<unknown>
}): Promise<void> {
  const info = (await db.getAllAsync('PRAGMA table_info(token_settlements)', [])) as { name: string }[]
  const have = new Set(info.map(c => c.name))
  for (const col of TOKEN_SETTLEMENT_COLUMNS) {
    if (have.has(col.name)) continue
    await db.execAsync(col.ddl)
    // XR-033: this ALTER just gave every existing row a NULL `reference`, and
    // the abort guard's primary check (`getSettlementByReference`) can never
    // match a NULL one against any reference — so backfill it now, in the
    // same migration step, rather than leaving it to "the next hand-over"
    // (which never comes for a row already stuck in a blocked state).
    if (col.name === 'reference') await backfillLegacyTokenSettlementReferences(db)
  }
}

/**
 * XR-033: resolves each pre-migration row's `reference` from `transactions`,
 * the SAME table `abortAction({reference})` itself matches a reference
 * against (`findTransactions({partial:{reference}})`) — so this backfills
 * from the one mapping that is already authoritative, rather than guessing.
 *
 * Scoped to rows that both need it and can be resolved: still blocked (the
 * same states `abortGuard.ts`'s `ABORT_BLOCKED_SETTLEMENT_STATES` lists —
 * duplicated here, not imported, for the reason `settlementStore.ts` gives:
 * this schema file is statements, not cross-module logic) and whose
 * transaction row still exists to resolve from. A row that cannot be
 * resolved (its transaction is gone) is left NULL; the abort guard's own
 * second, coarser check (`hasUnresolvedLegacyBlockedRows`) covers that case
 * without this migration needing to.
 *
 * Never throws: this runs inside the ADD COLUMN step of the wallet's whole
 * migration ladder, and `transactions` — always present in the real app,
 * created earlier in this same `createTables` — is not guaranteed by this
 * function's own narrow signature. A device where the backfill itself cannot
 * run is exactly what `hasUnresolvedLegacyBlockedRows` exists to catch at
 * `abortAction` time instead, so a failure here costs that coarser refusal,
 * never a broken migration.
 */
async function backfillLegacyTokenSettlementReferences(db: {
  execAsync(sql: string): Promise<unknown>
}): Promise<void> {
  try {
    await db.execAsync(`
      UPDATE token_settlements
         SET reference = (
           SELECT reference FROM transactions WHERE transactions.txid = token_settlements.txid
         )
       WHERE reference IS NULL
         AND state IN ('held','handed_over','submitting','admitted','broadcast')
         AND EXISTS (SELECT 1 FROM transactions WHERE transactions.txid = token_settlements.txid)
    `)
  } catch (e) {
    devLog('[createTables] could not backfill legacy token_settlements references:', e)
  }
}
