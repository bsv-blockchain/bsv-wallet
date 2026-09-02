import { makeBuildGeneration } from '../../core/context/buildGeneration'

it('lets an uninterrupted build publish', () => {
  const gen = makeBuildGeneration()
  const token = gen.current()
  expect(gen.isCurrent(token)).toBe(true)
})

// The old chain's build must not publish its managers over the new chain's.
it('invalidates a build that a teardown overtook', () => {
  const gen = makeBuildGeneration()
  const stale = gen.current()
  gen.bump()
  expect(gen.isCurrent(stale)).toBe(false)
})

it('keeps the build started after the teardown', () => {
  const gen = makeBuildGeneration()
  gen.bump()
  const fresh = gen.current()
  expect(gen.isCurrent(fresh)).toBe(true)
})

it('counts every teardown, so two fast switches do not cancel out', () => {
  const gen = makeBuildGeneration()
  const first = gen.current()
  gen.bump()
  const second = gen.current()
  gen.bump()
  expect(gen.isCurrent(first)).toBe(false)
  expect(gen.isCurrent(second)).toBe(false)
  expect(gen.isCurrent(gen.current())).toBe(true)
})
