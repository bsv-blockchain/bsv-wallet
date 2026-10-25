/**
 * Host consent policy for the BRC-207 color module (`requestTokenAccess`).
 * W2: the wallet's own screens (adminOriginator) are the consent surface, so
 * every known message type is approved for them without a prompt. External
 * originators prompt through the queue; a `color_access` approval leaves a
 * 30-minute read grant for that originator only, and a spend approval never
 * grants reads or the reverse (design C10).
 */
import { createColorAccessPolicy } from '../../core/mandala/accessPolicy'

const ADMIN = 'admin.wallet.local'
const TYPES = ['color_send', 'color_signature', 'color_access', 'color_relinquish'] as const

function msg(fields: Record<string, unknown>): string {
  return JSON.stringify({ seekPermission: true, ...fields })
}

let clock: number
let prompt: jest.Mock<Promise<boolean>, [string, string]>
let policy: ReturnType<typeof createColorAccessPolicy>

beforeEach(() => {
  clock = 1_000_000
  prompt = jest.fn<Promise<boolean>, [string, string]>().mockResolvedValue(false)
  policy = createColorAccessPolicy({ adminOriginator: ADMIN, prompt, now: () => clock })
})

describe('createColorAccessPolicy', () => {
  it('approves every type for the admin originator without prompting', async () => {
    for (const type of TYPES) expect(await policy(ADMIN, msg({ type }))).toBe(true)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('refuses the removed color_receive_offline type (B7) as unknown, for every originator', async () => {
    expect(await policy(ADMIN, msg({ type: 'color_receive_offline' }))).toBe(false)
    expect(await policy('app.example', msg({ type: 'color_receive_offline' }))).toBe(false)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('grants a color_access read for 30 minutes per originator only', async () => {
    prompt.mockResolvedValueOnce(true)
    expect(await policy('app.example', msg({ type: 'color_access', basket: 'p color assets' }))).toBe(true)
    expect(await policy('app.example', msg({ type: 'color_access', basket: 'p color assets' }))).toBe(true)
    expect(prompt).toHaveBeenCalledTimes(1)
    // Another originator does not ride on app.example's grant.
    expect(await policy('other.example', msg({ type: 'color_access', basket: 'p color assets' }))).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(2)
    clock += 1_800_001
    prompt.mockResolvedValueOnce(false)
    expect(await policy('app.example', msg({ type: 'color_access' }))).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(3)
  })

  it('never lets a send approval grant reads or a read grant cover a send', async () => {
    prompt.mockResolvedValueOnce(true)
    expect(await policy('app.example', msg({ type: 'color_send', assets: [] }))).toBe(true)
    prompt.mockResolvedValueOnce(false)
    expect(await policy('app.example', msg({ type: 'color_access', basket: 'p color assets' }))).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(2)

    prompt.mockResolvedValueOnce(true)
    expect(await policy('app.example', msg({ type: 'color_access', basket: 'p color assets' }))).toBe(true)
    prompt.mockResolvedValueOnce(false)
    expect(await policy('app.example', msg({ type: 'color_send', assets: [] }))).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(4)
    // And a send approval is not remembered either.
    prompt.mockResolvedValueOnce(true)
    expect(await policy('app.example', msg({ type: 'color_send', assets: [] }))).toBe(true)
    prompt.mockResolvedValueOnce(false)
    expect(await policy('app.example', msg({ type: 'color_send', assets: [] }))).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(6)
  })

  it('returns false without prompting when seekPermission is false and no grant exists', async () => {
    expect(await policy('app.example', msg({ type: 'color_access', seekPermission: false }))).toBe(false)
    for (const type of TYPES) {
      expect(await policy('app.example', msg({ type, seekPermission: false }))).toBe(false)
    }
    expect(prompt).not.toHaveBeenCalled()
  })

  it('answers seekPermission:false from a live read grant', async () => {
    prompt.mockResolvedValueOnce(true)
    expect(await policy('app.example', msg({ type: 'color_access' }))).toBe(true)
    expect(await policy('app.example', msg({ type: 'color_access', seekPermission: false }))).toBe(true)
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('refuses malformed JSON and unknown types', async () => {
    expect(await policy('app.example', '{')).toBe(false)
    expect(await policy('app.example', msg({ type: 'color_mint' }))).toBe(false)
    expect(await policy('app.example', 'null')).toBe(false)
    expect(await policy('app.example', '[]')).toBe(false)
    expect(await policy('app.example', '"color_access"')).toBe(false)
    // Fail closed for the admin originator too: an unreadable request is not a known type.
    expect(await policy(ADMIN, '{')).toBe(false)
    expect(await policy(ADMIN, msg({ type: 'color_mint' }))).toBe(false)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('refuses, and grants nothing, when the prompt rejects', async () => {
    prompt.mockRejectedValueOnce(new Error('sheet unmounted'))
    expect(await policy('app.example', msg({ type: 'color_access' }))).toBe(false)
    prompt.mockResolvedValueOnce(false)
    expect(await policy('app.example', msg({ type: 'color_access' }))).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('treats only a literal true from the prompt as approval', async () => {
    prompt.mockResolvedValueOnce('yes' as unknown as boolean)
    expect(await policy('app.example', msg({ type: 'color_access' }))).toBe(false)
    prompt.mockResolvedValueOnce(false)
    expect(await policy('app.example', msg({ type: 'color_access' }))).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent read prompts for one originator onto one prompt', async () => {
    let answer!: (v: boolean) => void
    prompt.mockImplementationOnce(() => new Promise<boolean>(resolve => (answer = resolve)))
    const first = policy('app.example', msg({ type: 'color_access', basket: 'p color assets' }))
    const second = policy('app.example', msg({ type: 'color_access', basket: 'p color assets' }))
    await Promise.resolve()
    answer(true)
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('does not trust a clock that went backwards', async () => {
    prompt.mockResolvedValueOnce(true)
    expect(await policy('app.example', msg({ type: 'color_access' }))).toBe(true)
    clock -= 60_000
    prompt.mockResolvedValueOnce(false)
    expect(await policy('app.example', msg({ type: 'color_access' }))).toBe(false)
  })

  it('clearGrants drops every read grant', async () => {
    prompt.mockResolvedValueOnce(true)
    expect(await policy('app.example', msg({ type: 'color_access' }))).toBe(true)
    policy.clearGrants()
    prompt.mockResolvedValueOnce(false)
    expect(await policy('app.example', msg({ type: 'color_access' }))).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('a read approved after clearGrants answers that read but leaves no grant', async () => {
    let answer!: (v: boolean) => void
    prompt.mockImplementationOnce(() => new Promise<boolean>(resolve => (answer = resolve)))
    const pending = policy('app.example', msg({ type: 'color_access' }))
    await Promise.resolve()
    policy.clearGrants()
    answer(true)
    expect(await pending).toBe(true)
    prompt.mockResolvedValueOnce(false)
    expect(await policy('app.example', msg({ type: 'color_access' }))).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('passes the originator and the exact message to the prompt', async () => {
    const message = msg({
      type: 'color_relinquish',
      assetId: 'a'.repeat(64) + '_0',
      role: 'value',
      outpoint: 'b'.repeat(64) + '.1'
    })
    await policy('app.example', message)
    expect(prompt).toHaveBeenCalledWith('app.example', message)
  })

  it('honours a custom read grant window', async () => {
    const short = createColorAccessPolicy({ adminOriginator: ADMIN, prompt, now: () => clock, readGrantMs: 1000 })
    prompt.mockResolvedValueOnce(true)
    expect(await short('app.example', msg({ type: 'color_access' }))).toBe(true)
    clock += 1000
    prompt.mockResolvedValueOnce(false)
    expect(await short('app.example', msg({ type: 'color_access' }))).toBe(false)
  })

  it('rejects bad options at construction', () => {
    expect(() => createColorAccessPolicy({ adminOriginator: '', prompt })).toThrow(TypeError)
    expect(() => createColorAccessPolicy({ adminOriginator: ADMIN, prompt: undefined as never })).toThrow(TypeError)
    expect(() => createColorAccessPolicy({ adminOriginator: ADMIN, prompt, readGrantMs: -1 })).toThrow(TypeError)
    expect(() => createColorAccessPolicy({ adminOriginator: ADMIN, prompt, readGrantMs: Number.NaN })).toThrow(
      TypeError
    )
  })
})
