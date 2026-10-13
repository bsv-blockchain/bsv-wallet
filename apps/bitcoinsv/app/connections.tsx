// The shared core's screens send people to /connections for paired sites;
// here they're Settings → Sign-ins (app/sign-ins.tsx).
import { Redirect } from 'expo-router'

export default function Connections() {
  return <Redirect href="/sign-ins" />
}
