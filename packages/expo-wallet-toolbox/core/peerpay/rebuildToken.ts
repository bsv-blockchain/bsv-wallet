import type { OutboxEntry } from './outbox'

export function instructionsFromOutput(customInstructions: unknown): {
  derivationPrefix: string
  derivationSuffix: string
} | undefined {
  let parsed: unknown = customInstructions
  if (typeof customInstructions === 'string') {
    try {
      parsed = JSON.parse(customInstructions)
    } catch {
      return undefined
    }
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const { derivationPrefix, derivationSuffix } = parsed as Record<string, unknown>
  if (typeof derivationPrefix !== 'string' || typeof derivationSuffix !== 'string') return undefined
  return { derivationPrefix, derivationSuffix }
}

export async function rebuildPeerPayToken(args: {
  action: { txid?: string; outputs?: { customInstructions?: string | object; satoshis?: number }[] }
  recipient: string
  refetch: (txid: string) => Promise<number[] | undefined>
}): Promise<{ token: OutboxEntry['token']; recipient: string } | undefined> {
  const { action, recipient, refetch } = args
  if (!action.txid) return undefined

  const outputs = action.outputs ?? []
  let instructions: { derivationPrefix: string; derivationSuffix: string } | undefined
  let amount = 0
  for (const out of outputs) {
    const parsed = instructionsFromOutput(out.customInstructions)
    if (parsed) {
      instructions = parsed
      if (typeof out.satoshis === 'number') amount = out.satoshis
      break
    }
  }
  if (!instructions) return undefined

  const beef = await refetch(action.txid)
  if (!beef) return undefined

  return {
    token: {
      customInstructions: instructions,
      transaction: beef,
      amount
    },
    recipient
  }
}
