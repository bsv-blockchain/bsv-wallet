/**
 * DOM-free state machine behind the Conformance panel: runs vendored fast cards one at a time against the bridge
 * connection, keeps the results and builds the report. LOCAL file (not vendored).
 *
 * - `runAllSafe` runs the cards without a `spending` description, one at a time, continuing after failures.
 * - `runCard` runs exactly one card (the only way a spending card runs).
 * - `stop` lets the current card finish; matrices record their remaining cases as skipped, and no further card starts.
 * - The report holds ids, status, duration and error code only: never wallet payloads, keys or error messages.
 */
import type { Connection, PageClient } from '../../src/testing/pageClient'
import { executeSnippet, type SnippetResult, type SnippetRunner } from './lib/snippet-runner'
import { CARDS, type Card } from './registry'
import { setBridgeConnection } from './snippets/wallet'

export const FAST_SOURCE = 'fast-wallet-client-docs@63bd8c4'

export type RowStatus = 'pass' | 'fail' | 'skip'

export interface CaseRow {
  id: string
  status: RowStatus
  durationMs: number
  errorCode?: string | number
}

export interface CardRow extends CaseRow {
  cases: CaseRow[]
  /** Shown in the page only, never in the report. */
  message?: string
}

const STATUS: Record<SnippetResult['status'], RowStatus> = { passed: 'pass', failed: 'fail', skipped: 'skip' }

const caseRow = (id: string, r: SnippetResult): CaseRow => ({
  id,
  status: STATUS[r.status],
  durationMs: r.durationMs,
  ...(r.errorCode === undefined ? {} : { errorCode: r.errorCode })
})

export interface ControllerOptions {
  cards?: Card[]
  onChange?: () => void
  onLog?: (kind: 'ok' | 'err' | 'info', text: string) => void
  now?: () => Date
}

export function createController({ cards = CARDS, onChange, onLog, now = () => new Date() }: ControllerOptions = {}) {
  const results = new Map<string, CardRow>()
  let walletName: string | undefined
  let connected = false
  let running: string | undefined
  let stopRequested = false
  let stopping = false

  const changed = (): void => onChange?.()
  const byId = (id: string): Card | undefined => cards.find(c => c.id === id)

  function setConnection(client: PageClient | undefined, connection: Connection | undefined): void {
    setBridgeConnection(client, connection)
    connected = Boolean(client && connection)
    walletName = connection?.provider.descriptor.name
    changed()
  }

  async function execute(card: Card): Promise<void> {
    running = card.id
    const caseRows: CaseRow[] = []
    const runner: SnippetRunner = {
      log: () => {},
      case: (id, r) => {
        caseRows.push(caseRow(id, r))
        changed()
      },
      shouldStop: () => stopRequested
    }
    changed()
    const outcome = await executeSnippet(() => card.run(runner))
    results.set(card.id, { ...caseRow(card.id, outcome), cases: caseRows, message: outcome.message })
    running = undefined
    onLog?.(
      outcome.status === 'passed' ? 'ok' : outcome.status === 'failed' ? 'err' : 'info',
      `${card.id} ${STATUS[outcome.status]}${outcome.message ? ` (${outcome.message})` : ''}`
    )
    changed()
  }

  function ready(): boolean {
    if (running !== undefined) {
      onLog?.('err', `busy: ${running} is still running`)
      return false
    }
    if (!connected) {
      onLog?.('err', 'not connected: press connect first')
      return false
    }
    return true
  }

  /** One card, spending or not. */
  async function runCard(id: string): Promise<void> {
    const card = byId(id)
    if (!card || !ready()) return
    stopRequested = false
    stopping = false
    await execute(card)
    stopRequested = false
    stopping = false
    changed()
  }

  /** Every card without a spending description, in order, one at a time. */
  async function runAllSafe(): Promise<void> {
    if (!ready()) return
    stopRequested = false
    stopping = false
    for (const card of cards.filter(c => !c.spending)) {
      if (stopRequested) break
      await execute(card)
    }
    if (stopRequested) onLog?.('info', 'stopped after the current card')
    stopRequested = false
    stopping = false
    changed()
  }

  function stop(): void {
    if (running === undefined) return
    stopRequested = true
    stopping = true
    changed()
  }

  function report(meta: { walletBuild?: string; userAgent?: string } = {}) {
    const rows = [...results.values()]
    const count = (s: RowStatus): number => rows.filter(r => r.status === s).length
    return {
      source: FAST_SOURCE,
      generatedAt: now().toISOString(),
      ...(walletName ? { wallet: walletName } : {}),
      ...(meta.walletBuild ? { walletBuild: meta.walletBuild } : {}),
      ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
      summary: { cards: rows.length, pass: count('pass'), fail: count('fail'), skip: count('skip') },
      results: rows.map(({ id, status, durationMs, errorCode, cases }) => ({
        id,
        status,
        durationMs,
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(cases.length ? { cases } : {})
      }))
    }
  }

  return {
    cards,
    results,
    setConnection,
    runCard,
    runAllSafe,
    stop,
    report,
    get running() {
      return running
    },
    get stopping() {
      return stopping
    },
    get connected() {
      return connected
    }
  }
}

export type Controller = ReturnType<typeof createController>
