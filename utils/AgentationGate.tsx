import React, { type ReactNode } from 'react'

type GateProps = { children?: ReactNode }

function PassThrough({ children }: GateProps) {
  return <>{children}</>
}

/**
 * Designer feedback overlay (react-native-agentation): tap an element, get its
 * component name and source file:line plus a note, copied as markdown for an
 * agent. Off by default. It mounts only in a dev bundle started with
 * EXPO_PUBLIC_AGENTATION=1, e.g. `EXPO_PUBLIC_AGENTATION=1 npm start`.
 *
 * Release bundles inline __DEV__ as false, so the require below and the package
 * fold out of the bundle entirely. The flag is inlined at bundle time, so
 * restart Metro with -c after changing it.
 */
export const AgentationGate: React.ComponentType<GateProps> =
  __DEV__ && process.env.EXPO_PUBLIC_AGENTATION === '1'
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('react-native-agentation').Agentation
    : PassThrough
