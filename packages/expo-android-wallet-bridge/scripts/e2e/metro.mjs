// Pre-flight for the Metro that serves the host's JS (port 8082). Dev tooling, not part of the shipped kit.
//
// Why this exists (SPIKES.md, "O8 and M1 15/16: the Metro project path"): when Metro's project root sits under a directory that has
// its own node_modules (a host worktree under `<main checkout>/.claude/worktrees/`), the lazy `import('@bsv/sdk')` chunk
// (toolbox listOutputsSql.ts / listActionsSql.ts) is fetched from Metro at request time with a `/../../../node_modules/...` path, and
// the permission prompts of O8 and M1 cases 15/16 (and sometimes the Connect prompt) never arrive. The same host copied to a flat
// path, with Metro started there, passes. The runner checks this before the first case.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** The first ancestor directory of `root` (excluding `root` itself) that has a node_modules, or undefined. */
export function nestedNodeModulesAncestor(root, exists = p => fs.existsSync(p)) {
  let dir = path.dirname(path.resolve(root))
  for (;;) {
    if (dir === path.dirname(dir)) return undefined // the filesystem root is not a project ancestor
    if (exists(path.join(dir, 'node_modules'))) return dir
    dir = path.dirname(dir)
  }
}

/** The working directory of the process listening on `port` (Metro's project root), or undefined when it cannot be read. */
export async function metroProjectRoot(port = 8082) {
  try {
    const pids = (await execFileP('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'])).stdout.trim().split('\n').filter(Boolean)
    for (const pid of pids) {
      const out = (await execFileP('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'])).stdout
      const n = out.split('\n').find(l => l.startsWith('n'))
      if (n) return n.slice(1)
    }
  } catch {
    // lsof missing or nothing listening: the caller degrades to a warning
  }
  return undefined
}

/** Throws when Metro's project root is nested under a node_modules ancestor; warns (returns a note) when it cannot tell. */
export async function checkMetroRoot(port = 8082, { allow = false } = {}) {
  const root = await metroProjectRoot(port)
  if (!root) return `warning: could not find the Metro project root on port ${port} (lsof); not checked`
  const anc = nestedNodeModulesAncestor(root)
  if (!anc) return `Metro project root ${root} (flat: no node_modules in any ancestor)`
  const msg =
    `Metro on ${port} runs from ${root}, which sits under ${anc} (that has its own node_modules). A lazy @bsv/sdk chunk is then fetched at request time and ` +
    `the permission prompts (O8, M1 15/16) can fail to arrive. Copy the host somewhere flat (rsync minus android, ios, .git, .expo) and ` +
    `start Metro there (SPIKES.md, "O8 and M1 15/16"), or pass --allow-nested-metro to run anyway.`
  if (allow) return `warning: ${msg}`
  throw new Error(msg)
}
