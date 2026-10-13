// Signing a paired site out (Connections in the existing app, Settings →
// Sign-ins in the BitcoinSV app): this phone stops serving it at once, then
// tells it so over the relay (session_revoke), best effort. Moved out of
// ui/screens/ConnectionsScreen.tsx unchanged, so both screens revoke alike.
import { WalletClient } from '@bsv/sdk'
import * as SecureStore from 'expo-secure-store'
import { ADMIN_ORIGINATOR } from '../config'
import { capWalletArgs } from './capWalletArgs'
import { guardVaultAccess } from './vault/guard'
import { lastSeqKey } from '../context/WalletConnectionContext'
import connectionStore, { type Connection } from '../stores/ConnectionStore'
import {
  buildRelayWebSocketUrl,
  validateMobileIdentityKey,
  validateRelayUrl,
  validateStoredConnectionFields,
  validateStoredConnectionSequence
} from './walletConnectionValidation'

/** What a caller may hand in instead (its own imports, so its tests' mocks apply). */
export interface RevokeDeps {
  store: Pick<typeof connectionStore, 'setStatus'>
  guard: typeof guardVaultAccess
  cap: typeof capWalletArgs
  adminOriginator: string
  seqKey: typeof lastSeqKey
}

const DEFAULTS: RevokeDeps = {
  store: connectionStore,
  guard: guardVaultAccess,
  cap: capWalletArgs,
  adminOriginator: ADMIN_ORIGINATOR,
  seqKey: lastSeqKey
}

export async function revokeConnection(
  conn: Connection,
  permissionsManager: unknown,
  live: { liveTopic?: string; disconnect: () => void },
  deps: RevokeDeps = DEFAULTS
): Promise<void> {
  // XR-018: local revocation must not depend on the peer's cooperation, or
  // on the best-effort session_revoke send below succeeding. If this is
  // the provider's own live socket for this session, tear it down FIRST —
  // that's the only thing that actually stops wireSocket's onmessage from
  // continuing to dispatch privileged RPC methods to it.
  if (live.liveTopic === conn.sessionId) live.disconnect()
  deps.store.setStatus(conn.sessionId, 'disconnected')

  if (!permissionsManager) return
  try {
    const validated = validateStoredConnectionFields(conn)
    const relay = validateRelayUrl(conn.relay)
    const storedSeq = await SecureStore.getItemAsync(deps.seqKey(validated.topic))
    const initialSeq = validateStoredConnectionSequence(storedSeq)
    const wallet = new WalletClient(
      deps.cap(deps.guard(permissionsManager as any, deps.adminOriginator)),
      validated.external.originator
    )
    const identityResult = await wallet.getPublicKey({ identityKey: true })
    const currentMobileIdentityKey = validateMobileIdentityKey(identityResult.publicKey)
    if (currentMobileIdentityKey !== validated.mobileIdentityKey) {
      throw new Error('Stored connection belongs to a different wallet identity')
    }
    const ws = new WebSocket(buildRelayWebSocketUrl(relay, validated.topic))

    ws.onopen = async () => {
      try {
        const seq = initialSeq + 1
        const payload = JSON.stringify({
          id: crypto.randomUUID(),
          seq,
          method: 'session_revoke',
          params: {}
        })
        const plaintext = Array.from(new TextEncoder().encode(payload))
        const { ciphertext } = await wallet.encrypt({
          protocolID: validated.protocolID,
          keyID: validated.topic,
          counterparty: validated.backendIdentityKey,
          plaintext
        })
        ws.send(
          JSON.stringify({
            topic: validated.topic,
            ciphertext: Buffer.from(ciphertext).toString('base64url')
          })
        )
      } finally {
        ws.close()
      }
    }
    ws.onerror = () => ws.close()
  } catch (e) {
    console.warn('[connections] session_revoke failed:', e)
  }
}
