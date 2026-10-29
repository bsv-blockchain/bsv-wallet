// @ts-nocheck
export type SnippetStatus = 'passed' | 'failed' | 'skipped'

export interface SnippetResult {
  status: SnippetStatus
  durationMs: number
  message?: string
  errorCode?: string | number
  cases?: (SnippetResult & { id: string })[]
}

export interface SnippetRunner {
  log: (...args: unknown[]) => void
  case?: (id: string, result: SnippetResult) => void
  shouldStop?: () => boolean
}

export class ProbeSkipped extends Error {}

export async function executeSnippet(run: () => Promise<void>): Promise<SnippetResult> {
  const started = performance.now()
  try {
    await run()
    return { status: 'passed', durationMs: Math.round(performance.now() - started) }
  } catch (error) {
    const code = error != null && typeof error === 'object' && 'code' in error ? error.code : undefined
    return {
      status: error instanceof ProbeSkipped ? 'skipped' : 'failed',
      durationMs: Math.round(performance.now() - started),
      message: error instanceof Error ? error.message : String(error),
      ...(typeof code === 'string' || typeof code === 'number' ? { errorCode: code } : {}),
    }
  }
}

const runs = new Map<string, Promise<SnippetResult>>()

// Multiple effect subscribers can share execution, including React StrictMode remounts.
export function runSnippetOnce(key: string, run: () => Promise<SnippetResult>): Promise<SnippetResult> {
  const existing = runs.get(key)
  if (existing) return existing
  const promise = Promise.resolve().then(run).finally(() => {
    if (runs.get(key) === promise) runs.delete(key)
  })
  runs.set(key, promise)
  return promise
}
