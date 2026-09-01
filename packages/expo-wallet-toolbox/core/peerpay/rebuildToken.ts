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

type RebuildOutput = {
  customInstructions?: string | object
  satoshis?: number
  outputIndex?: number
  basket?: string
}

/**
 * The output that paid the recipient, not the one that paid us back.
 *
 * Change carries derivation data too, so "first output with customInstructions"
 * could rebuild a token describing the sender's own change — wrong amount, and
 * keys the recipient cannot derive. Change lands in one of this wallet's
 * baskets; an output paying someone else belongs to no basket of ours, so that
 * is the one to take. If nothing is marked either way, fall back to the first
 * output that carries derivation data — the previous behaviour.
 */
function paymentOutput(outputs: RebuildOutput[]):
  | { instructions: { derivationPrefix: string; derivationSuffix: string }; out: RebuildOutput }
  | undefined {
  const parsed = outputs
    .map(out => ({ out, instructions: instructionsFromOutput(out.customInstructions) }))
    .filter((x): x is { out: RebuildOutput; instructions: { derivationPrefix: string; derivationSuffix: string } } =>
      x.instructions !== undefined
    )
  if (parsed.length === 0) return undefined
  return parsed.find(x => !x.out.basket) ?? parsed[0]
}

export async function rebuildPeerPayToken(args: {
  action: { txid?: string; outputs?: RebuildOutput[] }
  recipient: string
  refetch: (txid: string) => Promise<number[] | undefined>
}): Promise<{ token: OutboxEntry['token']; recipient: string } | undefined> {
  const { action, recipient, refetch } = args
  if (!action.txid) return undefined

  const chosen = paymentOutput(action.outputs ?? [])
  if (!chosen) return undefined

  const beef = await refetch(action.txid)
  if (!beef) return undefined

  return {
    token: {
      customInstructions: chosen.instructions,
      transaction: beef,
      amount: typeof chosen.out.satoshis === 'number' ? chosen.out.satoshis : 0,
      // The recipient internalizes `outputIndex ?? 0`. Both rails pin the
      // payment to output 0 today, but the index is known here and guessing it
      // would credit the wrong output the moment that stops being true.
      ...(typeof chosen.out.outputIndex === 'number' ? { outputIndex: chosen.out.outputIndex } : {})
    },
    recipient
  }
}
