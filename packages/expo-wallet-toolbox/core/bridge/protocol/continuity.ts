/**
 * Per-application-context provider continuity (BRC-185 section 3).
 *
 * The continuity key is an Ed25519 key generated independently of wallet spending and identity keys.
 * Its private half never leaves the store: callers only get `sign`. `getOrCreate` has to work while
 * the wallet is locked because describe is non-interactive and answers inside one second.
 */
export interface ContinuityHandle {
  /** Lowercase UUIDv4, stable for this provider and application context. */
  instanceId: string
  /** Base64url of the 32-byte Ed25519 public key. */
  continuityKey: string
  /** Pure Ed25519 (RFC 8032) over the given preimage. */
  sign(preimage: Uint8Array): Promise<Uint8Array>
}

export interface ContinuityStore {
  getOrCreate(ctx: string): Promise<ContinuityHandle>
  /** Rotate one context, or every context. A reset makes this a new provider for remembered-choice purposes. */
  reset(ctx: string | 'all'): Promise<void>
}
