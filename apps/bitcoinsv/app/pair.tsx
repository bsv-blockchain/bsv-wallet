// A website's sign-in link opened from outside the app (bsv-wallet://pair,
// the existing app's PairScreen route): handed to Scan to sign in
// (app/sign-in.tsx), which reads and checks it and shows who's asking and
// what they'll get before anything connects.
import { Redirect, useLocalSearchParams } from 'expo-router'
import { pairLinkFromParams } from '../src/signin/code'

export default function Pair() {
  const params = useLocalSearchParams()
  return <Redirect href={{ pathname: '/sign-in', params: { code: pairLinkFromParams(params) } }} />
}
