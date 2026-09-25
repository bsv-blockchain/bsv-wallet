import { makeAutoObservable, runInAction } from 'mobx'
import AsyncStorage from '@react-native-async-storage/async-storage'

export interface Connection {
  sessionId: string
  origin: string
  relay: string
  backendIdentityKey: string
  mobileIdentityKey: string
  protocolID: string  // JSON-stringified WalletProtocol
  connectedAt: number
  status: 'active' | 'disconnected'
  /** XR-027: HMAC over (origin, sessionId, protocolID, backendIdentityKey),
   * computed by an ADMIN-scoped wallet under the `connection authority`
   * namespace reserved in core/services/vault/guard.ts -- see
   * core/services/connectionAuthority.ts. Absent on a record saved before
   * this fix, or one that never got tagged; callers must treat that exactly
   * like a tag that fails verification (needs re-approval), never as
   * implicitly trusted. */
  authorityTag?: string
}

const STORAGE_KEY = 'connections'

class ConnectionStore {
  connections: Connection[] = []
  /** XR-027: a tag the pairing/reconnect screens compute with their own
   * admin-scoped wallet BEFORE calling connect() -- add() below (called from
   * deep inside connect()'s websocket-open callback, which never sees an
   * admin wallet) consumes it in the same synchronous step that creates the
   * record, so a freshly approved connection is never observably tagless in
   * between. Never persisted and never part of the observed connection
   * list; mobx wraps it as an ObservableMap, but nothing here relies on
   * that reactivity. */
  private pendingAuthorityTags = new Map<string, string>()

  constructor() {
    makeAutoObservable(this)
    void this.load()
  }

  stageAuthorityTag(sessionId: string, tag: string) {
    this.pendingAuthorityTags.set(sessionId, tag)
  }

  /** A staged tag that never gets consumed (approval abandoned, connect()
   * failed before its record was ever added) would otherwise sit in memory
   * forever. Screens call this from their own catch block; harmless to call
   * for a sessionId with nothing staged. */
  discardStagedAuthorityTag(sessionId: string) {
    this.pendingAuthorityTags.delete(sessionId)
  }

  add(connection: Connection) {
    const tag = this.pendingAuthorityTags.get(connection.sessionId)
    if (tag !== undefined) {
      this.pendingAuthorityTags.delete(connection.sessionId)
      connection = { ...connection, authorityTag: tag }
    }
    const idx = this.connections.findIndex(c => c.sessionId === connection.sessionId)
    if (idx >= 0) {
      this.connections[idx] = connection
    } else {
      this.connections.push(connection)
    }
    void this.save()
  }

  setStatus(sessionId: string, status: Connection['status']) {
    const conn = this.connections.find(c => c.sessionId === sessionId)
    if (conn) {
      conn.status = status
      void this.save()
    }
  }

  remove(sessionId: string) {
    this.connections = this.connections.filter(c => c.sessionId !== sessionId)
    void this.save()
  }

  private async save() {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.connections))
    } catch (e) {
      console.warn('[ConnectionStore] save failed', e)
    }
  }

  private async load() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY)
      if (raw) {
        runInAction(() => {
          this.connections = JSON.parse(raw) as Connection[]
        })
      }
    } catch (e) {
      console.warn('[ConnectionStore] load failed', e)
    }
  }
}

const connectionStore = new ConnectionStore()
export default connectionStore
