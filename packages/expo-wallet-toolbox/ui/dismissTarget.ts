/**
 * Route target for the `dismissTo` props on this package's payment screens.
 *
 * expo-router's `router.dismissTo` takes `Href`, which is not a fixed type: a
 * host app with `experiments.typedRoutes` on generates a `declare module
 * 'expo-router'` augmentation narrowing `Href` to that app's literal route
 * union. Because that augmentation is global and this package ships raw `.ts`
 * that the host compiles itself, a `dismissTo?: string` prop stops being
 * assignable to `dismissTo()` inside our own files (TS2345). Typing the prop
 * as `Href` resolves against whatever the host's `Href` is: a typed-routes
 * host gets its routes checked, a host without it sees `Href` ~ `string`.
 *
 * `import type` is fully erased at compile time and emits no `require`, so
 * this does not reintroduce the untransformed-JSX problem that the lazy
 * `loadExpoRouter()` pattern exists to avoid.
 */
import type { Href } from 'expo-router'

export type DismissTarget = Href
