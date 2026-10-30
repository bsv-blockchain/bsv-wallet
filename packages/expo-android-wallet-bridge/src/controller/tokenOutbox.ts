/**
 * Reconnect-token outbox (spec 7.6). The core hands a token over once, on Approve; it rides on the next response
 * written for that epoch. `take` does not consume: the controller calls `confirmWritten` once the response head has
 * reached the socket, so a failed write keeps the token for the next response. Memory only; never logged.
 */
import type { TokenOutboxPort } from '@bsv/expo-wallet-toolbox/core/bridge/loopback/routerTypes'

export function createTokenOutbox(): TokenOutboxPort & { put(epoch: string, token: string): void } {
  const tokens = new Map<string, string>()
  return {
    put(epoch, token) {
      tokens.set(epoch, token)
    },
    take: epoch => tokens.get(epoch),
    confirmWritten(epoch) {
      tokens.delete(epoch)
    },
    drop(epoch) {
      tokens.delete(epoch)
    }
  }
}
